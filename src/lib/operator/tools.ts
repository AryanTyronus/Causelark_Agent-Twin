//
// This is the whole of what the Operator can do. Every tool here is an adapter:
// it validates its arguments, calls one function that already exists in this
// codebase, reduces the answer to something a model can read and a person can
// scan, and records what happened. Not one of them re-derives a score, re-runs a
// scenario, or decides what a result means — the evaluation, benchmark,
// counterfactual and replay engines own all of that, and this file is only the
// door they are reached through.
//
// What the Operator deliberately does *not* have, and will not:
//
//   * no shell, no filesystem, no arbitrary HTTP, no SQL, no query builder
//   * no environment inspection — a tool cannot read a credential, and the
//     catalogue reports that a provider is configured without ever touching the
//     value that configures it
//   * no owner parameter. Identity is captured in these closures from the
//     authenticated session. There is no tool input that names a user, because a
//     model that could name one could name someone else's.
//   * no way to read a run the session did not just create. `inspect_case`,
//     `replay_case` and `analyze_counterfactual` resolve a run id against the
//     result *this* execution produced before they touch the database, and the
//     read they then perform is owner-scoped again. A run id the model invents
//     is refused before any query is issued.
//
// The tools are split by what they can change:
//
//   READ   list_agents, list_benchmarks, get_benchmark, inspect_results,
//          inspect_case, replay_case, analyze_counterfactual
//   ACTION create_test_plan, run_benchmark, generate_trust_report
//
// `run_benchmark` is the only tool that spends money, it exists only in execute
// mode, and it refuses unless a plan was committed to *and* the caller presented
// the fingerprint of that plan. `create_test_plan` writes nothing anywhere.

import 'server-only';

import { AfterToolCallEvent, type Agent, type Tool, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { resolveAgentSelection } from '@/lib/agent/provider';
import { getBenchmark, listBenchmarkSummaries } from '@/lib/benchmarks/catalog';
import { configurationForSelection, executeBenchmark } from '@/lib/benchmarks/execute';
import { BenchmarkError, BenchmarkResult } from '@/lib/benchmarks/types';
import { type DeploymentAgentCatalog, deploymentAgentCatalog } from '@/lib/business/agent-catalog';
import { toEvaluationInput } from '@/lib/business/simulation-evaluation';
import { loadRun } from '@/lib/business/simulation-persistence';
import { buildSimulationReplay } from '@/lib/business/simulation-replay';
import { analyzePersistedCounterfactual } from '@/lib/counterfactual/execute';
import { evaluateRun } from '@/lib/evaluation/evaluation';
import {
  MAX_OPERATOR_BENCHMARK_RUNS,
  MAX_OPERATOR_CASE_EVIDENCE,
  MAX_OPERATOR_COUNTERFACTUAL_ANALYSES,
  MAX_OPERATOR_REJECTED_ACTIONS,
  MAX_OPERATOR_TOOL_CALLS,
  MAX_OPERATOR_TRACE_DETAIL_BYTES,
  MAX_OPERATOR_TRACE_STEPS,
  operatorBounds,
} from './config';
import { buildOperatorPlan, OperatorPlanRefusal } from './plan';
import { buildTrustReport } from './report';
import {
  type OperatorCaseEvidence,
  type OperatorCounterfactualFinding,
  type OperatorMode,
  type OperatorPhase,
  type OperatorResultSlice,
  OperatorResultSlice as OperatorResultSliceSchema,
  type OperatorTestPlan,
  type OperatorToolStatus,
  type OperatorTraceStep,
  type OperatorUsage,
  type TrustReport,
} from './types';

/**
 * The phase a tool call belongs to. Assigned here, from a declared table, so the
 * trace a reader sees is a record of which tools ran rather than a story the
 * model tells about its own process.
 */
const TOOL_PHASES: Record<string, OperatorPhase> = {
  list_agents: 'discover',
  list_benchmarks: 'discover',
  get_benchmark: 'discover',
  create_test_plan: 'plan',
  run_benchmark: 'execute',
  inspect_results: 'inspect',
  inspect_case: 'inspect',
  replay_case: 'inspect',
  analyze_counterfactual: 'analyze',
  generate_trust_report: 'report',
};

function phaseFor(toolName: string): OperatorPhase {
  return TOOL_PHASES[toolName] ?? 'understand';
}

/** What one tool call produced, before it is written to the trace. */
interface ToolOutcome {
  status: OperatorToolStatus;
  summary: string;
  detail: Record<string, unknown>;
  /** What the model receives. */
  data: unknown;
}

function completed(
  summary: string,
  data: unknown,
  detail: Record<string, unknown> = {},
): ToolOutcome {
  return { status: 'completed', summary, detail, data };
}

function refused(summary: string, reason: string): ToolOutcome {
  return { status: 'refused', summary, detail: { reason }, data: { refused: true, reason } };
}

function failed(
  summary: string,
  reason: string,
  detail: Record<string, unknown> = {},
): ToolOutcome {
  return {
    status: 'failed',
    summary,
    detail: { ...detail, reason },
    data: { error: true, reason },
  };
}

/** Keep a trace step small enough that the trace is not a second evidence store. */
function boundDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(detail);
  if (encoded.length <= MAX_OPERATOR_TRACE_DETAIL_BYTES) return detail;
  return { truncated: true, originalBytes: encoded.length };
}

/**
 * The state one operator request accumulates.
 *
 * Ephemeral by design. Nothing here is persisted: the evidence layer is the
 * `SimulationRun` rows a benchmark execution creates, and this object is the
 * scratch space a single request reads them through. When the request ends, so
 * does it.
 */
export interface OperatorExecution {
  tools: Tool[];
  /** Registers the trace recorder. See the note on the hook below. */
  attachTraceHook: (agent: Agent) => void;
  readonly catalogue: DeploymentAgentCatalog;
  readonly trace: OperatorTraceStep[];
  readonly caseEvidence: OperatorCaseEvidence[];
  readonly counterfactuals: OperatorCounterfactualFinding[];
  readonly notices: string[];
  readonly usage: OperatorUsage;
  plan: OperatorTestPlan | null;
  result: BenchmarkResult | null;
  resultSlice: OperatorResultSlice | null;
  /** The report the reporting tool assembled, if it was reached. */
  report: TrustReport | null;
  /** True once an execution was authorised against the committed plan. */
  authorized: boolean;
  recordTurns: (turns: number) => void;
  recordDuration: (durationMs: number) => void;
}

export interface OperatorToolboxOptions {
  /** The authenticated owner. Captured here; never a tool input. */
  ownerId: string;
  mode: OperatorMode;
  objective: string;
  /** The agent the caller named, if any. Validated against the catalogue at plan time. */
  requestedAgentKey: string | null;
  /** The plan digest the caller presented. Only consulted in execute mode. */
  authorizedPlanFingerprint: string | null;
  /** Injected so a test can produce a deterministic trace. */
  now?: () => Date;
}

/**
 * Build the tool surface for one operator request.
 *
 * The returned `tools` array is the complete allow-list handed to the Strands
 * `Agent`. It is built per request because everything in it is bound to one
 * owner and one execution: there is no global registry a model could reach past.
 */
export function createOperatorToolbox(options: OperatorToolboxOptions): OperatorExecution {
  const now = options.now ?? (() => new Date());
  const catalogue = deploymentAgentCatalog();
  const trace: OperatorTraceStep[] = [];
  const caseEvidence: OperatorCaseEvidence[] = [];
  const counterfactuals: OperatorCounterfactualFinding[] = [];
  const notices: string[] = [];
  const usage: OperatorUsage = {
    turns: 0,
    toolCalls: 0,
    refusedToolCalls: 0,
    failedToolCalls: 0,
    benchmarkRuns: 0,
    counterfactualAnalyses: 0,
    durationMs: 0,
  };

  const execution: OperatorExecution = {
    tools: [],
    attachTraceHook: () => {},
    catalogue,
    trace,
    caseEvidence,
    counterfactuals,
    notices,
    usage,
    plan: null,
    result: null,
    resultSlice: null,
    report: null,
    authorized: false,
    recordTurns: (turns) => {
      usage.turns = Math.max(0, Math.floor(turns));
    },
    recordDuration: (durationMs) => {
      usage.durationMs = Math.max(0, Math.floor(durationMs));
    },
  };

  let traceTruncated = false;

  function recordStep(toolName: string, outcome: ToolOutcome): void {
    if (trace.length >= MAX_OPERATOR_TRACE_STEPS) {
      if (!traceTruncated) {
        traceTruncated = true;
        notices.push(
          `The operator made more tool calls than the trace retains (${MAX_OPERATOR_TRACE_STEPS}); further calls were refused and are counted but not listed.`,
        );
      }
      return;
    }
    trace.push({
      index: trace.length,
      phase: phaseFor(toolName),
      tool: toolName,
      status: outcome.status,
      summary: outcome.summary,
      detail: boundDetail(outcome.detail),
      at: now().toISOString(),
    });
  }

  /**
   * Correlates a tool call's structured outcome with the SDK's own tool-call id,
   * so the after-tool-call hook can write the trace step.
   *
   * The hook is what makes the trace complete rather than merely tidy: it fires
   * for a call whose arguments failed validation and for a call to a tool that
   * does not exist, neither of which reaches a callback. Those calls are recorded
   * as failures with the SDK's own error text, because a model that repeatedly
   * malforms its arguments is a fact about the run and a reader is entitled to
   * see it.
   */
  const pending = new Map<string, ToolOutcome>();

  /**
   * The budget gate and the error boundary, in one place.
   *
   * Every tool goes through it, so there is no path by which a call can escape
   * the call budget or turn an engine exception into a crash: an exception
   * becomes a recorded `failed` step with a reason the model can read, and the
   * run continues.
   */
  async function guard(fn: () => Promise<ToolOutcome> | ToolOutcome): Promise<ToolOutcome> {
    if (usage.toolCalls >= MAX_OPERATOR_TOOL_CALLS) {
      usage.refusedToolCalls += 1;
      return refused(
        `The tool-call budget for this request (${MAX_OPERATOR_TOOL_CALLS}) is spent.`,
        'The operator may not make further tool calls. Finish by reporting what it already has, or stop.',
      );
    }
    usage.toolCalls += 1;
    try {
      const outcome = await fn();
      if (outcome.status === 'refused') usage.refusedToolCalls += 1;
      if (outcome.status === 'failed') usage.failedToolCalls += 1;
      return outcome;
    } catch (error) {
      usage.failedToolCalls += 1;
      const reason = error instanceof Error ? error.message : 'the tool raised an unknown error';
      return failed(`${error instanceof Error ? error.name : 'A tool call'} failed.`, reason);
    }
  }

  /**
   * Wrap a callback so every call is budgeted, recorded, and returns its data.
   *
   * The tool's *input* is generic — each tool declares its own schema and the
   * callback receives the parsed result. The output is not: every tool in this
   * surface returns a `ToolOutcome`, whose `data` field is what the SDK hands
   * back to the model. Constraining it that way is what lets the recorder read a
   * status off every call without knowing which tool produced it.
   */
  function defineTool<I extends z.ZodType>(config: {
    name: string;
    description: string;
    inputSchema: I;
    run: (input: z.infer<I>) => Promise<ToolOutcome> | ToolOutcome;
  }): Tool {
    return tool({
      name: config.name,
      description: config.description,
      inputSchema: config.inputSchema,
      callback: async (input: z.infer<I>, context) => {
        const outcome = await guard(() => config.run(input));
        const toolUseId = context?.toolUse?.toolUseId;
        // Direct invocation (a test, or a future server-side caller) has no SDK
        // event, so the step is written here instead of waiting for the hook.
        if (toolUseId) pending.set(toolUseId, outcome);
        else recordStep(config.name, outcome);
        return outcome.data;
      },
    }) as Tool;
  }

  execution.attachTraceHook = (agent: Agent) => {
    agent.addHook(AfterToolCallEvent, (event) => {
      const toolUseId = event.toolUse.toolUseId;
      const outcome = pending.get(toolUseId);
      pending.delete(toolUseId);
      if (outcome) {
        recordStep(event.toolUse.name, outcome);
        return;
      }
      // The call never reached a callback: either the arguments failed the
      // tool's own schema, or the model named a tool that does not exist. Both
      // are recorded as failures with the SDK's own error text — a model that
      // repeatedly malforms its arguments is a fact about the run, and a reader
      // is entitled to see it rather than a trace that quietly skips it.
      usage.failedToolCalls += 1;
      recordStep(event.toolUse.name, {
        status: 'failed',
        summary: `The call to "${event.toolUse.name}" did not reach a tool.`,
        detail: {
          reason:
            event.error?.message ??
            'No tool with that name is available to the operator, or the arguments did not match its schema.',
        },
        data: null,
      });
    });
  };

  // ── Read tools ────────────────────────────────────────────────────────────

  const listAgents = defineTool({
    name: 'list_agents',
    description:
      'List the agent configurations this deployment can actually run, as reported by the provider boundary. Each entry carries the key to name in a test plan. A provider that cannot be resolved is listed with the reason. No credential is ever included.',
    inputSchema: z.object({}),
    run: () => {
      const agents = catalogue.agents.map((agent) => ({
        key: agent.key,
        identity: agent.identity,
        provider: agent.configuration.provider,
        model: agent.configuration.model,
        providerLabel: agent.providerLabel,
        isDeploymentDefault: agent.isDeploymentDefault,
      }));
      const summary =
        agents.length === 0
          ? 'No agent configuration resolves on this deployment, so nothing can be tested.'
          : `${agents.length} agent configuration(s) available: ${agents.map((agent) => agent.key).join(', ')}.`;
      if (agents.length === 0 && catalogue.configurationNotice)
        notices.push(catalogue.configurationNotice);
      return completed(
        summary,
        { agents, configurationNotice: catalogue.configurationNotice },
        {
          agentKeys: agents.map((agent) => agent.key),
        },
      );
    },
  });

  const listBenchmarks = defineTool({
    name: 'list_benchmarks',
    description:
      'List the standardised tests registered in this build, with their environments, objectives and sizes. These are the only benchmarks that exist; a benchmark id not in this list cannot be run and must not be described.',
    inputSchema: z.object({}),
    run: () => {
      const benchmarks = listBenchmarkSummaries();
      return completed(
        `${benchmarks.length} benchmark(s) registered: ${benchmarks.map((benchmark) => `${benchmark.id}@${benchmark.version}`).join(', ')}.`,
        { benchmarks },
        { benchmarkIds: benchmarks.map((benchmark) => benchmark.id) },
      );
    },
  });

  const getBenchmarkTool = defineTool({
    name: 'get_benchmark',
    description:
      'Read one registered benchmark in full: its pinned scenario versions, its declared seeds, the objective it measures, and the formula its robustness figure is computed by. Resolves against the compiled registry, so an id or version that does not exist is refused rather than invented.',
    inputSchema: z.object({
      benchmarkId: z.string().min(1).max(64).describe('The benchmark id, from list_benchmarks.'),
      version: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Pin an exact version. Omit for the newest shipped version.'),
    }),
    run: (input) => {
      try {
        const definition = getBenchmark(input.benchmarkId, input.version ?? null);
        return completed(
          `${definition.name} (${definition.id}@${definition.version}) runs ${definition.scenarios.length} condition(s) over ${definition.seeds.length} seed(s) = ${definition.scenarios.length * definition.seeds.length} case(s).`,
          {
            id: definition.id,
            version: definition.version,
            name: definition.name,
            description: definition.description,
            environmentKey: definition.environmentKey,
            objectiveKey: definition.objectiveKey,
            scenarios: definition.scenarios.map((scenario) => ({
              ...scenario,
              isBaseline: scenario.id === definition.baselineScenarioId,
            })),
            seeds: definition.seeds,
            caseCount: definition.scenarios.length * definition.seeds.length,
            baselineScenarioId: definition.baselineScenarioId,
          },
          { benchmarkId: definition.id, version: definition.version },
        );
      } catch (error) {
        if (error instanceof BenchmarkError) return refused('Unknown benchmark.', error.message);
        throw error;
      }
    },
  });

  const inspectResults = defineTool({
    name: 'inspect_results',
    description:
      'Read the aggregate of the benchmark execution this run performed: the case counts, the scored dimensions, the robustness report, every scenario row, and the failure classification. Available only after run_benchmark. Carries run ids so a single case can be looked at next.',
    inputSchema: z.object({}),
    run: () => {
      if (!execution.resultSlice)
        return refused(
          'No benchmark has been executed.',
          'There are no results to inspect. In preview mode no benchmark runs; in execute mode, run_benchmark must complete first.',
        );
      const slice = execution.resultSlice;
      const evaluated = slice.caseSummary.evaluatedCases ?? 0;
      const total = slice.caseSummary.totalCases ?? 0;
      return completed(
        `${evaluated} of ${total} case(s) evaluated; mean overall ${slice.dimensions.averageOverallScore ?? 'not recorded'}; robustness ${slice.robustness.robustnessScore ?? 'not recorded'}.`,
        slice,
        {
          evaluatedCases: evaluated,
          totalCases: total,
          averageOverallScore: slice.dimensions.averageOverallScore ?? null,
        },
      );
    },
  });

  /** The run a session may look at, or `null`. The whole ownership boundary. */
  function knownRun(runId: string) {
    return execution.resultSlice?.runs.find((run) => run.runId === runId) ?? null;
  }

  const inspectCase = defineTool({
    name: 'inspect_case',
    description:
      'Read one case in detail: the evaluation the engine produced for its run, a summary of the actions it attempted with the rejected ones quoted, its tool-call failures, and its recorded faults. The run id must be one this execution produced.',
    inputSchema: z.object({
      runId: z.string().min(1).max(64).describe('A run id from inspect_results.'),
    }),
    run: async (input) => {
      const known = knownRun(input.runId);
      if (!known)
        return refused(
          'That run id is not part of this execution.',
          `Only the runs this execution produced may be inspected. Available run ids: ${(execution.resultSlice?.runs ?? []).map((run) => run.runId).join(', ') || 'none'}.`,
        );
      if (caseEvidence.length >= MAX_OPERATOR_CASE_EVIDENCE)
        return refused(
          'The case-evidence allowance is spent.',
          `At most ${MAX_OPERATOR_CASE_EVIDENCE} cases may be pulled in full for one request. Choose the cases that matter most from inspect_results.`,
        );
      if (caseEvidence.some((entry) => entry.runId === input.runId))
        return refused(
          'That case has already been inspected.',
          'The evidence for this run is already recorded in this execution; inspecting it again would add nothing.',
        );

      // The second ownership check. The first is `knownRun`, which bounds this to
      // the runs this execution created; this one is the same owner-scoped read
      // every run endpoint in the product performs.
      const persisted = await loadRun(input.runId, options.ownerId);
      if (!persisted)
        return refused(
          'That run could not be read.',
          'The run is not recorded for this account. Nothing about it can be reported.',
        );

      // `toEvaluationInput` is the same mapping the evaluation endpoint scores a
      // run through, so what is quoted here and what was scored cannot diverge.
      const source = toEvaluationInput(persisted);
      const evaluation = evaluateRun(source);
      const rejected = source.actions
        .filter((action) => !action.accepted)
        .slice(0, MAX_OPERATOR_REJECTED_ACTIONS)
        .map((action) => ({
          step: action.step,
          type: action.type,
          reason: action.rejectionReason,
        }));
      const failedCalls = source.toolCalls.filter((call) => call.status !== 'SUCCEEDED');
      const faults = source.events
        .filter((event) => event.kind === 'agent.error')
        .map((event) => event.summary);

      const evidence: OperatorCaseEvidence = {
        runId: persisted.id,
        caseKey: known.caseKey,
        scenario: source.scenario ?? null,
        seed: persisted.seed,
        status: source.status,
        terminationReason: source.terminationReason,
        evaluation,
        actions: {
          total: source.actions.length,
          accepted: source.actions.filter((action) => action.accepted).length,
          rejected: source.actions.filter((action) => !action.accepted).length,
          rejectedActions: rejected,
        },
        toolCalls: {
          total: source.toolCalls.length,
          failed: failedCalls.length,
          failedNames: [...new Set(failedCalls.map((call) => call.toolName))],
        },
        faults,
      };
      caseEvidence.push(evidence);

      return completed(
        `${known.scenarioId}@${known.scenarioVersion} seed ${known.seed}: overall ${evaluation.overallScore}, status ${source.status}, ${evidence.actions.rejected} rejected action(s), ${failedCalls.length} failed tool call(s).`,
        evidence,
        {
          runId: persisted.id,
          overallScore: evaluation.overallScore,
          status: source.status,
        },
      );
    },
  });

  const replayCase = defineTool({
    name: 'replay_case',
    description:
      'Reconstruct the state trajectory of one case from its persisted records: how many steps it took, which steps the replay marks as important, and the state changes at those steps. Use this when a case failed and the question is what changed, not what was scored.',
    inputSchema: z.object({
      runId: z.string().min(1).max(64).describe('A run id from inspect_results.'),
    }),
    run: async (input) => {
      const known = knownRun(input.runId);
      if (!known)
        return refused(
          'That run id is not part of this execution.',
          `Only the runs this execution produced may be replayed. Available run ids: ${(execution.resultSlice?.runs ?? []).map((run) => run.runId).join(', ') || 'none'}.`,
        );
      const persisted = await loadRun(input.runId, options.ownerId);
      if (!persisted)
        return refused(
          'That run could not be read.',
          'The run is not recorded for this account. Nothing about it can be reported.',
        );

      const source = toEvaluationInput(persisted);
      const replay = buildSimulationReplay({
        initialState: source.initialState,
        actions: source.actions,
        events: source.events,
      });

      // Only the frames the replay itself marks as important, capped — the point
      // is the shape of the run, not a transcript of it.
      const important = replay.importantFrameIndexes
        .slice(0, 6)
        .flatMap((index) => {
          const frame = replay.frames[index];
          return frame ? [frame] : [];
        })
        .map((frame) => ({
          index: frame.index,
          step: frame.step,
          label: frame.label,
          state: {
            step: frame.state.step,
            progress: frame.state.progress,
            target: frame.state.target,
            risk: frame.state.risk,
            budgetRemaining: frame.state.budgetRemaining,
          },
          diffs: frame.diffs.map((diff) => ({
            field: diff.field,
            before: diff.before,
            after: diff.after,
          })),
        }));

      return completed(
        `${known.scenarioId}@${known.scenarioVersion} seed ${known.seed}: ${replay.frames.length} replay frame(s), ${replay.importantFrameIndexes.length} marked important; the first ${important.length} are included.`,
        {
          runId: persisted.id,
          frameCount: replay.frames.length,
          importantFrameCount: replay.importantFrameIndexes.length,
          finalState: replay.frames[replay.frames.length - 1]?.state ?? null,
          importantFrames: important,
        },
        { runId: persisted.id, frameCount: replay.frames.length },
      );
    },
  });

  const analyzeCounterfactual = defineTool({
    name: 'analyze_counterfactual',
    description:
      "Ask the counterfactual engine what else the agent could have done at each decision point of one run, and which decision cost it most. Deciding which runs are worth this is the operator's judgement — the engine declares its own policies and ranks the decisions; the operator only chooses where to look. Bounded per request.",
    inputSchema: z.object({
      runId: z.string().min(1).max(64).describe('A run id from inspect_results.'),
    }),
    run: async (input) => {
      const known = knownRun(input.runId);
      if (!known)
        return refused(
          'That run id is not part of this execution.',
          `Only runs this execution produced may be analysed. Available run ids: ${(execution.resultSlice?.runs ?? []).map((run) => run.runId).join(', ') || 'none'}.`,
        );
      if (usage.counterfactualAnalyses >= MAX_OPERATOR_COUNTERFACTUAL_ANALYSES)
        return refused(
          'The counterfactual allowance is spent.',
          `At most ${MAX_OPERATOR_COUNTERFACTUAL_ANALYSES} runs may be analysed for one request. Analyse the case that matters most rather than every case.`,
        );
      if (counterfactuals.some((finding) => finding.runId === input.runId))
        return refused(
          'That run has already been analysed.',
          'The counterfactual finding for this run is already recorded in this execution.',
        );

      usage.counterfactualAnalyses += 1;
      const outcome = await analyzePersistedCounterfactual({
        runId: input.runId,
        ownerId: options.ownerId,
      });
      if (!outcome)
        return refused(
          'That run could not be analysed.',
          'The run is not recorded for this account. Nothing about it can be reported.',
        );
      if (outcome.kind !== 'report')
        return failed(
          'The counterfactual engine returned an unexpected shape.',
          'A decision-level analysis was returned where a run-level report was requested.',
        );

      const { report } = outcome;
      const critical = report.causal.criticalDecision;
      const finding: OperatorCounterfactualFinding = {
        runId: input.runId,
        caseKey: known.caseKey,
        scenarioId: report.run.scenario?.id ?? null,
        policies: {
          actionSpace: report.policies.actionSpace,
          continuation: report.policies.continuation,
          comparison: report.policies.comparison,
        },
        baselineOverallScore: report.baseline.overallScore,
        decisionsAnalysed: report.summary.decisionPoints,
        improvingDecisions: report.summary.improvingDecisions,
        worseningDecisions: report.summary.worseningDecisions,
        uncontestedDecisions: report.summary.uncontestedDecisions,
        outcomeFlipDecisions: report.summary.outcomeFlipDecisions,
        maxRegret: report.summary.maxRegret,
        meanRegret: report.summary.meanRegret,
        criticalDecision: critical
          ? {
              index: critical.index,
              step: critical.step,
              actionId: critical.actionId,
              actionType: critical.action.type,
              regret: critical.regret,
              recordedOverall: critical.recordedOverall,
              bestAlternativeOverall: critical.bestAlternativeOverall,
              statement: critical.statement,
            }
          : null,
      };
      counterfactuals.push(finding);

      return completed(
        critical
          ? `${report.summary.decisionPoints} decision point(s) analysed; the most costly was decision ${critical.index} at step ${critical.step} (${critical.action.type}), regret ${critical.regret}.`
          : `${report.summary.decisionPoints} decision point(s) analysed; no decision had a higher-scoring alternative.`,
        finding,
        {
          runId: input.runId,
          decisionPoints: report.summary.decisionPoints,
          maxRegret: report.summary.maxRegret,
        },
      );
    },
  });

  // ── Action tools ──────────────────────────────────────────────────────────

  const createTestPlan = defineTool({
    name: 'create_test_plan',
    description:
      'Commit to exactly what will be executed, before anything is. Every field is taken from the benchmark registry and the agent catalogue — the operator chooses which benchmark and which agent, and cannot invent either. Returns the plan and the fingerprint a live execution must present back. Writes nothing and runs nothing.',
    inputSchema: z.object({
      benchmarkId: z.string().min(1).max(64).describe('A benchmark id from list_benchmarks.'),
      benchmarkVersion: z.number().int().positive().optional(),
      agentKey: z
        .string()
        .min(1)
        .max(200)
        .describe('An agent key from list_agents. There is no default: name the agent under test.'),
      seeds: z
        .array(z.number().int().min(0).max(999999))
        .min(1)
        .max(4)
        .optional()
        .describe(
          "Optional subset of the benchmark's declared seeds. A seed the definition does not declare would be a different experiment.",
        ),
    }),
    run: (input) => {
      try {
        const plan = buildOperatorPlan({
          objective: options.objective,
          benchmarkId: input.benchmarkId,
          benchmarkVersion: input.benchmarkVersion ?? null,
          agentKey: input.agentKey,
          seeds: input.seeds ?? null,
        });
        execution.plan = plan;
        return completed(
          `Plan committed: ${plan.benchmark.name} (${plan.benchmark.id}@${plan.benchmark.version}) against ${plan.agent.identity} — ${plan.caseCount} case(s), ${plan.seeds.length} seed(s), ${plan.providerDrivenSimulations} provider-driven simulation(s). Fingerprint ${plan.fingerprint}.`,
          plan,
          {
            benchmarkId: plan.benchmark.id,
            agentKey: plan.agent.key,
            caseCount: plan.caseCount,
            fingerprint: plan.fingerprint,
          },
        );
      } catch (error) {
        if (error instanceof OperatorPlanRefusal)
          return refused('The plan was refused.', error.message);
        throw error;
      }
    },
  });

  const runBenchmarkTool = defineTool({
    name: 'run_benchmark',
    description:
      'Execute the benchmark exactly as the committed plan describes, through the existing benchmark engine. This drives a real agent turn loop once per case and is the only tool in this surface that spends provider capacity. Requires a committed plan and, in an authorised execution, the plan fingerprint the caller presented.',
    inputSchema: z.object({
      benchmarkId: z
        .string()
        .min(1)
        .max(64)
        .describe('The benchmark id from the committed plan. A mismatch is refused.'),
    }),
    run: async (input) => {
      if (options.mode !== 'execute')
        return refused(
          'This run is a preview.',
          'The execution tool is not available in preview mode. A preview produces a plan and stops; a live execution is a separate, explicitly authorised request.',
        );
      const plan = execution.plan;
      if (!plan)
        return refused(
          'No plan has been committed.',
          'Call create_test_plan first. The operator may not execute a benchmark it has not described.',
        );
      if (plan.benchmark.id !== input.benchmarkId)
        return refused(
          'That benchmark is not the one that was planned.',
          `The committed plan is for ${plan.benchmark.id}@${plan.benchmark.version}. A different benchmark would need a new plan and a new authorisation.`,
        );
      if (usage.benchmarkRuns >= MAX_OPERATOR_BENCHMARK_RUNS)
        return refused(
          'The benchmark-execution allowance is spent.',
          `At most ${MAX_OPERATOR_BENCHMARK_RUNS} benchmark execution(s) may be started for one request.`,
        );

      // The authorisation check. It happens here rather than in the route because
      // the plan does not exist until the operator has committed to one, and it
      // happens before any run is created so a mismatch costs nothing.
      if (options.authorizedPlanFingerprint !== plan.fingerprint) {
        notices.push(
          'An execution was refused because the authorised plan fingerprint did not match the plan the operator committed to.',
        );
        return refused(
          'The execution is not authorised for this plan.',
          options.authorizedPlanFingerprint
            ? 'The fingerprint presented does not match the plan the operator committed to. The plan a person approved and the plan about to run are not the same, so the execution was refused.'
            : 'This execution was requested without an authorised plan fingerprint. Running a benchmark that drives real agent turns requires explicit authorisation against a specific plan.',
        );
      }

      usage.benchmarkRuns += 1;
      execution.authorized = true;
      const selection = resolveAgentSelection({
        provider: plan.agent.provider,
        model: plan.agent.model,
      });
      const configuration = configurationForSelection(selection);

      const result = await executeBenchmark({
        ownerId: options.ownerId,
        benchmarkId: plan.benchmark.id,
        benchmarkVersion: plan.benchmark.version,
        agent: configuration,
        selection,
        attribution: {
          agentId: configuration.provider,
          agentVersion: plan.agent.key,
        },
        seeds: plan.seeds,
      });

      const parsed = BenchmarkResult.parse(result);
      execution.result = parsed;
      execution.resultSlice = toResultSlice(parsed);

      const evaluated = parsed.summary.evaluatedCases;
      const unavailable = parsed.summary.unavailableCases + parsed.summary.errorCases;
      if (unavailable > 0)
        notices.push(
          `${unavailable} case(s) produced no readable evidence. The report says which, and the verdict describes the ${evaluated} case(s) that did.`,
        );

      return completed(
        `${parsed.benchmark.id}@${parsed.benchmark.version} executed against ${plan.agent.identity}: ${parsed.summary.executedCases} of ${parsed.summary.totalCases} case(s) ran, ${evaluated} evaluated, mean overall ${parsed.dimensions.averageOverallScore ?? 'not recorded'}, robustness ${parsed.robustness.robustnessScore ?? 'not recorded'}.`,
        execution.resultSlice,
        {
          benchmarkId: parsed.benchmark.id,
          executedCases: parsed.summary.executedCases,
          evaluatedCases: evaluated,
          runIds: parsed.runs.map((run) => run.runId),
        },
      );
    },
  });

  const generateTrustReport = defineTool({
    name: 'generate_trust_report',
    description:
      "Assemble the Agent Trust Report from what this execution actually recorded. Every measurement, threshold and evidence reference is computed here from the engines' own output; the operator supplies only its reading of them, which is labelled as interpretation. Requires an executed benchmark.",
    inputSchema: z.object({
      interpretation: z
        .string()
        .max(1200)
        .optional()
        .describe(
          "The operator's reading of the evidence, in its own words. Rendered apart from every measurement and never as one.",
        ),
      recommendation: z
        .string()
        .max(1200)
        .optional()
        .describe(
          "What the operator suggests the reader do next. Marked as the operator's suggestion, not as a finding.",
        ),
    }),
    run: (input) => {
      const plan = execution.plan;
      const slice = execution.resultSlice;
      if (!plan || !slice)
        return refused(
          'There is nothing to report on.',
          'A trust report is assembled from an executed benchmark. No benchmark has been executed in this run, so no readiness claim can be made.',
        );

      const report = buildTrustReport({
        objective: options.objective,
        plan,
        result: slice,
        counterfactuals,
        interpretation: input.interpretation ?? null,
        recommendation: input.recommendation ?? null,
        planFingerprint: execution.authorized ? plan.fingerprint : null,
        toolCalls: usage.toolCalls,
        turns: usage.turns,
        stopReason: 'endTurn',
        benchmarkRuns: usage.benchmarkRuns,
        counterfactualAnalyses: usage.counterfactualAnalyses,
        generatedAt: now().toISOString(),
      });

      // Held on the execution rather than in the trace: the report is larger
      // than a trace step is allowed to be, and the trace's job is to record
      // *that* the report was produced, with a line a reader can scan.
      execution.report = report;

      return completed(
        `Trust report assembled: verdict ${report.verdict.verdict}. ${report.verdict.headline}`,
        report,
        {
          verdict: report.verdict.verdict,
          methodology: report.verdict.methodology,
          runIds: report.evidence.runIds,
        },
      );
    },
  });

  const readTools: Tool[] = [
    listAgents,
    listBenchmarks,
    getBenchmarkTool,
    inspectResults,
    inspectCase,
    replayCase,
    analyzeCounterfactual,
  ];
  const actionTools: Tool[] = [createTestPlan, generateTrustReport];
  // The execution tool is absent — not merely refused — outside execute mode, so
  // no amount of argument can reach it.
  const executionTools: Tool[] = options.mode === 'execute' ? [runBenchmarkTool] : [];

  execution.tools = [...readTools, ...actionTools, ...executionTools];
  return execution;
}

/**
 * Reduce a benchmark result to the slice the operator works from.
 *
 * A projection and nothing more: every field is copied from the engine's own
 * output, and the bulk — full per-case evaluations — is left out on purpose, so
 * that inspecting a case is a decision the operator makes rather than something
 * that arrives whether it was wanted or not.
 */
export function toResultSlice(result: BenchmarkResult): OperatorResultSlice {
  return OperatorResultSliceSchema.parse({
    benchmark: {
      id: result.benchmark.id,
      version: result.benchmark.version,
      name: result.benchmark.name,
    },
    agent: {
      provider: result.agent.provider,
      model: result.agent.model,
      label: result.agent.label ?? null,
    },
    caseSummary: { ...result.summary },
    dimensions: { ...result.dimensions },
    robustness: { ...result.robustness },
    scenarios: result.scenarios.map((scenario) => ({ ...scenario })),
    failures: { ...result.failures },
    runs: result.runs.map((run) => ({
      caseKey: run.case.key,
      scenarioId: run.case.scenarioId,
      scenarioVersion: run.case.scenarioVersion,
      seed: run.case.seed,
      isBaseline: run.case.isBaseline,
      runId: run.runId,
      status: run.status,
      outcome: run.outcome,
      terminationReason: run.terminationReason,
      overallScore: run.evaluation?.overallScore ?? null,
    })),
  });
}

/** The bounds a run state publishes. Re-exported so `operator.ts` has one import. */
export { operatorBounds };
