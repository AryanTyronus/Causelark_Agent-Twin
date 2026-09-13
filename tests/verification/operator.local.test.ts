//
// This harness is NOT part of the unit suite (`npm test` includes only
// `tests/unit/**`). It is the integration the phase asks for, in one file:
//
//   fake Operator model  → a scripted Strands `Model`, injection-free
//   real tool adapters   → `createOperatorToolbox`, reached through the route
//   real engines         → benchmarks, scenarios, evaluation, replay,
//                          counterfactuals — untouched
//   real PostgreSQL      → every run, action, event and tool call is a row
//
// Nothing else is stubbed. The operator is driven through `POST /api/operator`,
// so the authenticated session, the request contract, the composition root and
// the readiness methodology are the deployment's own. The one substitution is
// the model, and it is made at the provider boundary — `createAgentModelFor`
// returns a `ScriptedOperatorModel` — because a test that needed a live LLM
// would be a test that could not run, and because the phase requires the suite
// to pass without credentials.
//
// The simulation agent that runs each benchmark case is stubbed the same way the
// benchmark harness stubs it: `invokeResourceAgent` is replaced, but it is
// handed the *real* environment tools and invokes them through the real
// validator, so every action, rejection and event below is the environment's own
// verdict rather than a fixture's.
//
// Run with:
//   npx vitest run --config vitest.verification.config.ts
//
// It expects a DISPOSABLE database — it creates real runs and does not remove
// them. See the report accompanying this phase for the exact procedure (create a
// sibling database, `prisma migrate deploy`, run this, drop it).

import { describe, expect, it, vi } from 'vitest';

/** The identity the auth gate resolves. Swapped to prove the boundary holds. */
const state = vi.hoisted(() => ({
  owner: 'operator-local-verification',
  /** When true, `requireAuth` refuses the way the real one does. */
  unauthenticated: false,
  /** The script the operator's model will answer from, set per request. */
  script: [] as unknown[],
  /** A scenario whose agent turn should fail, or `null`. Consumed once. */
  failScenario: null as string | null,
}));

const OWNER = 'operator-local-verification';
const FOREIGN_OWNER = 'operator-local-foreign';

/** Pinned so the harness does not depend on which provider `.env.local` selects. */
const OPENROUTER_MODEL = 'verification-stub-model';
const BEDROCK_MODEL = 'verification-stub-bedrock-model';
/** Text that must never reach a response body. Asserted against, never printed. */
const STUB_CREDENTIAL = 'unused-by-the-verification-stub';

vi.mock('server-only', () => ({}));

vi.mock('@/lib/require-auth', () => ({
  requireAuth: async () => {
    if (state.unauthenticated) throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    return { id: state.owner, email: `${state.owner}@example.test` };
  },
}));

vi.mock('@/lib/agent/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/provider')>();
  const { ScriptedOperatorModel } = await import('../unit/agent-twin/operator-model');
  /** The script this fake answers from. The array is held by reference. */
  type Script = ConstructorParameters<typeof ScriptedOperatorModel>[0];
  return {
    ...actual,
    // The deployment this harness verifies is pinned: two providers resolve, so
    // the catalogue has an agent to choose and a second to be distinct from.
    resolveAgentProvider: () => 'openrouter' as const,
    resolveOpenRouterConfiguration: () => ({
      baseUrl: 'http://localhost/unused',
      apiKey: STUB_CREDENTIAL,
      modelId: OPENROUTER_MODEL,
    }),
    resolveBedrockConfiguration: () => ({ modelId: BEDROCK_MODEL, region: 'us-east-1' }),
    // The operator's own model. This is the seam the whole harness rests on: the
    // real `runOperator` asks the real provider boundary for a model and is
    // handed a script, so the real Strands loop, the real tool surface and the
    // real engines all run exactly as they do in a deployment.
    createAgentModelFor: (selection: { provider: 'bedrock' | 'openrouter'; modelId: string }) => ({
      model: new ScriptedOperatorModel(state.script as Script),
      providerLabel: actual.agentProviderLabel(selection.provider),
    }),
    // The agent that runs each benchmark case. It is handed the real toolbox and
    // calls the real tools; only the decision of *what* to attempt is scripted.
    invokeResourceAgent: async (input: {
      state: unknown;
      tools: Array<{ name: string }>;
    }): Promise<unknown> => {
      const scenarioId = scenarioOfState.get(JSON.stringify(input.state));
      if (state.failScenario !== null && scenarioId === state.failScenario) {
        state.failScenario = null;
        throw new actual.AgentProviderError('provider_error', 'The provider rejected the request.');
      }
      // A short, deterministic plan the environment genuinely judges: harvest one
      // material, then route two into the objective. Every call goes through the
      // same validator the operator path uses — nothing here is a shortcut.
      const plan = [
        { tool: 'observe_resources', input: {} },
        { tool: 'request_action', input: { type: 'harvest', resource: 'materials', amount: 1 } },
        { tool: 'request_action', input: { type: 'allocate', resource: 'materials', amount: 2 } },
      ];
      for (const step of plan) {
        const tool = input.tools.find((candidate) => candidate.name === step.tool);
        if (!tool) throw new Error(`Tool ${step.tool} is not available to the agent.`);
        await (tool as unknown as { invoke(i?: unknown): Promise<unknown> }).invoke(step.input);
      }
      return {
        metadata: {
          provider: 'verification stub',
          requestStatus: 'completed',
          latencyMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          safeError: null,
        },
        toolCallCount: plan.length,
        acceptedToolCount: plan.length,
        stopReason: 'endTurn',
      };
    },
  };
});

import { POST as operatorRoute } from '@/app/api/operator/route';
import { getBenchmark } from '@/lib/benchmarks/catalog';
import { buildRunMatrix } from '@/lib/benchmarks/matrix';
import { BenchmarkFailureAnalysis } from '@/lib/benchmarks/types';
import { deploymentAgentCatalog } from '@/lib/business/agent-catalog';
import { evaluatePersistedRun, toEvaluationInput } from '@/lib/business/simulation-evaluation';
import { loadRun } from '@/lib/business/simulation-persistence';
import { buildSimulationReplay } from '@/lib/business/simulation-replay';
import { analyzePersistedCounterfactual } from '@/lib/counterfactual/execute';
// biome-ignore lint/style/noRestrictedImports: this harness counts rows to prove what a run wrote and that a read wrote nothing; it is a verification script, not app code.
import { prisma } from '@/lib/db';
import { MAX_OPERATOR_BENCHMARK_RUNS, MAX_OPERATOR_TOOL_CALLS } from '@/lib/operator/config';
import { OperatorRunState } from '@/lib/operator/types';
import { initializeScenarioRun } from '@/lib/scenarios/scenario';
import { calls, type ScriptedStep, say } from '../unit/agent-twin/operator-model';

const OBJECTIVE = 'Test this agent and tell me whether it is ready to deploy.';
const BENCHMARK_ID = 'resource-routing-robustness';
const BASELINE_SCENARIO_ID = 'baseline';
const FAILING_SCENARIO_ID = 'resource-outage';
const EXPECTED_CASES = 7;

const CATALOGUE = deploymentAgentCatalog();
const AGENT_KEY = CATALOGUE.agents.find((agent) => agent.isDeploymentDefault)?.key ?? '';
const DEFINITION = getBenchmark(BENCHMARK_ID, 1);
const MATRIX = buildRunMatrix(DEFINITION);

/** Initial world per scenario, so the agent stub can tell which run it is driving. */
const scenarioOfState = new Map<string, string>();
for (const cell of MATRIX) {
  const { state: initial } = initializeScenarioRun({
    environmentKey: DEFINITION.environmentKey,
    objectiveKey: DEFINITION.objectiveKey,
    seed: cell.seed,
    scenarioId: cell.scenarioId,
  });
  scenarioOfState.set(JSON.stringify(initial), cell.scenarioId);
}

/** When the request in flight started, so a run id is resolved to *this* request. */
let requestStartedAt = new Date();

/**
 * A run id for one scenario of the request in flight.
 *
 * The scripted model calls this from inside its own turn. A real model reads the
 * run id out of the tool result it was just handed; this reads the same fact from
 * the row that result was built from, which is the only place it exists *before*
 * `run_benchmark` has returned. Scoping to `createdAt >= requestStartedAt` is
 * what makes it this request's run rather than one from an earlier test, and
 * `orderBy` reproduces the matrix order the benchmark executes in.
 */
async function runIdFor(scenarioId: string, ownerId = OWNER): Promise<string> {
  const run = await prisma.simulationRun.findFirst({
    where: { ownerId, scenarioId, createdAt: { gte: requestStartedAt } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!run) throw new Error(`No run for scenario ${scenarioId} was created during this request.`);
  return run.id;
}

/** The most recent run for a scenario, whoever it belongs to. */
async function anyRunIdFor(ownerId: string, scenarioId: string): Promise<string> {
  const run = await prisma.simulationRun.findFirst({
    where: { ownerId, scenarioId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!run) throw new Error(`No run for scenario ${scenarioId} belongs to ${ownerId}.`);
  return run.id;
}

/** Post a request to the operator route with the model answering from `script`. */
async function invokeOperator(
  script: ScriptedStep[],
  body: Record<string, unknown>,
  ownerId = OWNER,
): Promise<Response> {
  state.owner = ownerId;
  state.script = script;
  requestStartedAt = new Date();
  try {
    return await operatorRoute(
      new Request('http://localhost/api/operator', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  } finally {
    state.owner = OWNER;
  }
}

/** A preview: discover, then commit to a plan, then stop. */
function previewScript(): ScriptedStep[] {
  return [
    calls({ tool: 'list_agents' }),
    calls({ tool: 'list_benchmarks' }),
    calls({ tool: 'get_benchmark', input: { benchmarkId: BENCHMARK_ID } }),
    calls({ tool: 'create_test_plan', input: { benchmarkId: BENCHMARK_ID, agentKey: AGENT_KEY } }),
    say('The test is planned. Nothing has been executed.'),
  ];
}

/** The same plan, then the whole investigation, against the run it just made. */
function executeScript(): ScriptedStep[] {
  return [
    ...previewScript().slice(0, 4),
    calls({ tool: 'run_benchmark', input: { benchmarkId: BENCHMARK_ID } }),
    calls({ tool: 'inspect_results' }),
    calls({
      tool: 'inspect_case',
      input: () => runIdFor(BASELINE_SCENARIO_ID).then((runId) => ({ runId })),
    }),
    calls({
      tool: 'replay_case',
      input: () => runIdFor(BASELINE_SCENARIO_ID).then((runId) => ({ runId })),
    }),
    calls({
      tool: 'analyze_counterfactual',
      input: () => runIdFor(BASELINE_SCENARIO_ID).then((runId) => ({ runId })),
    }),
    calls({
      tool: 'generate_trust_report',
      input: {
        interpretation:
          'The baseline condition scores best; every perturbation costs it something.',
        recommendation: 'Investigate the worst-scoring condition before deploying.',
      },
    }),
    say('Report assembled from the executed benchmark.'),
  ];
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** The run state a response carries, parsed by the contract the UI parses it with. */
async function runStateOf(response: Response): Promise<ReturnType<typeof OperatorRunState.parse>> {
  const body = await readJson<{ run: unknown }>(response);
  return OperatorRunState.parse(body.run);
}

/** The fingerprint a preview produces, so an execution can present it. */
async function plannedFingerprint(): Promise<string> {
  const response = await invokeOperator(previewScript(), {
    objective: OBJECTIVE,
    agentKey: AGENT_KEY,
  });
  const run = await runStateOf(response);
  const fingerprint = run.plan?.fingerprint;
  if (!fingerprint) throw new Error('The preview produced no plan fingerprint.');
  return fingerprint;
}

// ── The harness verifies the shipped product, not a stand-in ────────────────

describe('0. the benchmark, the matrix and the catalogue under test', () => {
  it('runs the registered benchmark over its own matrix and catalogue', () => {
    expect(DEFINITION.id).toBe(BENCHMARK_ID);
    expect(DEFINITION.version).toBe(1);
    expect(MATRIX).toHaveLength(EXPECTED_CASES);
    expect(MATRIX[0]?.scenarioId).toBe(BASELINE_SCENARIO_ID);
    expect(MATRIX.map((cell) => cell.scenarioId)).toContain(FAILING_SCENARIO_ID);
    expect(CATALOGUE.agents.length).toBeGreaterThan(0);
    expect(AGENT_KEY).not.toBe('');
    // Two providers resolve, so the catalogue holds more than the default agent
    // — which is what makes "the plan named a specific one" worth asserting.
    expect(CATALOGUE.agents.length).toBeGreaterThan(1);
  });
});

// ── The route's own refusals, none of which costs a model call ──────────────

describe('1. the request is authenticated and validated before anything runs', () => {
  it('refuses an unauthenticated caller with the auth gate’s own 401', async () => {
    const rowsBefore = await prisma.simulationRun.count();
    state.unauthenticated = true;
    try {
      const response = await invokeOperator(previewScript(), { objective: OBJECTIVE });
      expect(response.status).toBe(401);
      // Served by the auth gate, which is outside the operator's own error
      // contract: the body is the gate's, not one this API wrote words for.
      expect(await readJson<Record<string, unknown>>(response)).toEqual({
        error: 'Unauthorized',
      });
    } finally {
      state.unauthenticated = false;
    }
    expect(await prisma.simulationRun.count()).toBe(rowsBefore);
  });

  it('refuses a body that is not JSON, with a declared error code', async () => {
    const response = await operatorRoute(
      new Request('http://localhost/api/operator', { method: 'POST', body: 'not json' }),
    );
    expect(response.status).toBe(400);
    expect((await readJson<{ code: string }>(response)).code).toBe('INVALID_REQUEST');
  });

  it('refuses an objective too short to be one, with a declared error code', async () => {
    const response = await invokeOperator(previewScript(), { objective: 'short' });
    expect(response.status).toBe(400);
    const body = await readJson<{ code: string; errors: Array<{ path: string }> }>(response);
    expect(body.code).toBe('INVALID_REQUEST');
    expect(body.errors.map((issue) => issue.path)).toContain('objective');
  });

  it('refuses an agent this deployment cannot run, naming the ones it can', async () => {
    const response = await invokeOperator(previewScript(), {
      objective: OBJECTIVE,
      agentKey: 'an-agent-from-another-deployment',
    });
    expect(response.status).toBe(400);
    const body = await readJson<{ code: string; error: string }>(response);
    expect(body.code).toBe('UNKNOWN_AGENT');
    expect(body.error).toContain('an-agent-from-another-deployment');
    expect(body.error).toContain(AGENT_KEY);
  });

  it('refuses an execution that presents no authorisation', async () => {
    const response = await invokeOperator(executeScript(), {
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'execute',
    });
    expect(response.status).toBe(400);
    expect((await readJson<{ code: string }>(response)).code).toBe('UNAUTHORIZED_MODE');
  });

  it('refuses an execution whose fingerprint is not the plan’s', async () => {
    const rowsBefore = await prisma.simulationRun.count();
    const response = await invokeOperator(executeScript(), {
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'execute',
      authorizedPlanFingerprint: 'a-fingerprint-that-was-never-shown-to-anyone',
    });
    // The run completes — a refused tool call is a finding, not an error — but
    // nothing was executed and no row was written.
    expect(response.status).toBe(200);
    const run = await runStateOf(response);
    expect(run.authorized).toBe(false);
    expect(run.result).toBeNull();
    expect(run.report).toBeNull();
    expect(run.trace.find((step) => step.tool === 'run_benchmark')?.status).toBe('refused');
    expect(await prisma.simulationRun.count()).toBe(rowsBefore);
  });
});

// ── A preview over the real registry ────────────────────────────────────────

describe('2. a preview plans against the real registry and executes nothing', () => {
  let preview: Awaited<ReturnType<typeof OperatorRunState.parse>>;
  let rowsBefore: number[] = [];

  it('builds a plan whose every field came from the registry and the catalogue', async () => {
    rowsBefore = await Promise.all([
      prisma.simulationRun.count(),
      prisma.simulationAction.count(),
      prisma.simulationEvent.count(),
    ]);
    const response = await invokeOperator(previewScript(), {
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
    });
    expect(response.status).toBe(200);
    preview = await runStateOf(response);

    expect(preview.status).toBe('completed');
    expect(preview.mode).toBe('preview');
    const plan = preview.plan;
    if (!plan) throw new Error('The preview produced no plan.');
    expect(plan.benchmark.id).toBe(DEFINITION.id);
    expect(plan.benchmark.version).toBe(DEFINITION.version);
    expect(plan.benchmark.name).toBe(DEFINITION.name);
    expect(plan.benchmark.environmentKey).toBe(DEFINITION.environmentKey);
    expect(plan.benchmark.objectiveKey).toBe(DEFINITION.objectiveKey);
    expect(plan.scenarios.map((s) => `${s.id}@${s.version}`)).toEqual(
      DEFINITION.scenarios.map((s) => `${s.id}@${s.version}`),
    );
    expect(plan.seeds).toEqual(DEFINITION.seeds);
    expect(plan.caseCount).toBe(EXPECTED_CASES);
    expect(plan.providerDrivenSimulations).toBe(EXPECTED_CASES);
    expect(plan.agent.key).toBe(AGENT_KEY);
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('reports the catalogue this deployment actually resolves, credential-free', async () => {
    const listed = preview.trace.find((step) => step.tool === 'list_agents');
    expect(listed?.status).toBe('completed');
    expect(preview.agents.map((agent) => agent.key)).toEqual(CATALOGUE.agents.map((a) => a.key));
    expect(JSON.stringify(preview)).not.toContain(STUB_CREDENTIAL);
  });

  it('writes nothing at all — a plan is not an experiment', async () => {
    expect(
      await Promise.all([
        prisma.simulationRun.count(),
        prisma.simulationAction.count(),
        prisma.simulationEvent.count(),
      ]),
    ).toEqual(rowsBefore);
  });

  it('records the discovery, plan phases in the order the model asked for them', async () => {
    expect(preview.trace.map((step) => [step.tool, step.phase, step.status])).toEqual([
      ['list_agents', 'discover', 'completed'],
      ['list_benchmarks', 'discover', 'completed'],
      ['get_benchmark', 'discover', 'completed'],
      ['create_test_plan', 'plan', 'completed'],
    ]);
    expect(preview.trace.map((step) => step.index)).toEqual([0, 1, 2, 3]);
  });

  it('stops at the plan: no result, no report, no counterfactual', async () => {
    expect(preview.result).toBeNull();
    expect(preview.report).toBeNull();
    expect(preview.counterfactuals).toEqual([]);
    expect(preview.usage.benchmarkRuns).toBe(0);
    expect(preview.usage.toolCalls).toBe(preview.trace.length);
  });
});

// ── An authorised execution, over the real engines and a real database ──────

describe('3. an authorised execution runs the real benchmark into real rows', () => {
  let executed: Awaited<ReturnType<typeof OperatorRunState.parse>>;
  let fingerprint = '';
  let runsBefore = 0;

  it('executes the benchmark the plan described, and only that one', async () => {
    // The fingerprint is not known until a plan exists, so the sequence is the
    // console's: plan, show the digest to a person, execute under it.
    const preview = await invokeOperator(previewScript(), {
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
    });
    const planned = await runStateOf(preview);
    fingerprint = planned.plan?.fingerprint ?? '';
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/);

    runsBefore = await prisma.simulationRun.count();
    const response = await invokeOperator(executeScript(), {
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'execute',
      authorizedPlanFingerprint: fingerprint,
    });
    expect(response.status).toBe(200);
    executed = await runStateOf(response);

    expect(executed.status).toBe('completed');
    expect(executed.authorized).toBe(true);
    expect(executed.usage.benchmarkRuns).toBe(1);
    expect(executed.usage.toolCalls).toBeLessThanOrEqual(MAX_OPERATOR_TOOL_CALLS);
    expect(executed.usage.benchmarkRuns).toBeLessThanOrEqual(MAX_OPERATOR_BENCHMARK_RUNS);
    // Every case the plan promised ran, and each one is its own row.
    expect(executed.result?.caseSummary.totalCases).toBe(EXPECTED_CASES);
    expect(executed.result?.runs).toHaveLength(EXPECTED_CASES);
    expect(await prisma.simulationRun.count()).toBe(runsBefore + EXPECTED_CASES);
  });

  it('leaves every case owned by the session that asked for it, and readable', async () => {
    const runIds = executed.result?.runs.map((run) => run.runId) ?? [];
    expect(new Set(runIds).size).toBe(EXPECTED_CASES);
    for (const runId of runIds) {
      const persisted = await loadRun(runId, OWNER);
      if (!persisted) throw new Error(`Run ${runId} was reported but is not readable.`);
      expect(persisted.ownerId).toBe(OWNER);
      expect(persisted.seed).toBe(DEFINITION.seeds[0]);
      expect(persisted.environmentKey).toBe(DEFINITION.environmentKey);
    }
    // And they carry the benchmark identity on their start events, so the
    // evidence can be traced back to the experiment that produced it.
    const first = runIds[0];
    if (!first) throw new Error('No run was reported.');
    const persisted = await loadRun(first, OWNER);
    const started = persisted?.events.find((event) => event.kind === 'simulation.started');
    expect((started?.payload as Record<string, unknown>).benchmarkId).toBe(BENCHMARK_ID);
    expect((started?.payload as Record<string, unknown>).benchmarkVersion).toBe(1);
  });

  it('scores every case through the evaluation engine, not through a copy of it', async () => {
    for (const run of executed.result?.runs ?? []) {
      const persisted = await loadRun(run.runId, OWNER);
      if (!persisted) throw new Error(`Run ${run.runId} could not be read back.`);
      const verdict = evaluatePersistedRun(persisted);
      expect(run.overallScore, run.caseKey).toBe(verdict?.overallScore ?? null);
      expect(run.status, run.caseKey).toBe(persisted.status);
      expect(run.scenarioId, run.caseKey).toBe(persisted.scenarioId);
    }
  });

  it('ran the benchmark the plan named, and the result says so', async () => {
    expect(executed.result?.benchmark.id).toBe(BENCHMARK_ID);
    expect(executed.result?.benchmark.version).toBe(1);
    expect(executed.result?.benchmark.name).toBe(DEFINITION.name);
    expect(executed.result?.agent.model).toBe(OPENROUTER_MODEL);
    // The robustness figure is the benchmark engine's own named formula.
    expect(executed.result?.robustness.formula).toBe('baseline-retention-v1');
    expect(executed.result?.scenarios).toHaveLength(EXPECTED_CASES);
  });

  it('records the whole flow in the trace, with each phase assigned by the server', async () => {
    expect(executed.trace.map((step) => [step.tool, step.phase])).toEqual([
      ['list_agents', 'discover'],
      ['list_benchmarks', 'discover'],
      ['get_benchmark', 'discover'],
      ['create_test_plan', 'plan'],
      ['run_benchmark', 'execute'],
      ['inspect_results', 'inspect'],
      ['inspect_case', 'inspect'],
      ['replay_case', 'inspect'],
      ['analyze_counterfactual', 'analyze'],
      ['generate_trust_report', 'report'],
    ]);
    expect(executed.trace.every((step) => step.status === 'completed')).toBe(true);
    expect(executed.usage.failedToolCalls).toBe(0);
    expect(executed.usage.refusedToolCalls).toBe(0);
  });

  it('exposes no hidden chain-of-thought, only the model’s own closing narration', async () => {
    expect(executed.narration).toBe('Report assembled from the executed benchmark.');
    // The narration is held apart from the trace, which carries action summaries
    // written by the tools themselves.
    for (const step of executed.trace)
      expect(step.summary).not.toContain('Report assembled from the executed benchmark.');
  });
});

// ── The drill-down, checked against the database ────────────────────────────

describe('4. the evidence the operator shows is the evidence the database holds', () => {
  it('quotes the persisted run’s evaluation, actions, tool calls and faults', async () => {
    const response = await invokeOperator(executeScript(), {
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'execute',
      authorizedPlanFingerprint: await plannedFingerprint(),
    });
    const run = await runStateOf(response);
    const evidence = run.caseEvidence[0];
    if (!evidence) throw new Error('The operator inspected no case.');

    const persisted = await loadRun(evidence.runId, OWNER);
    if (!persisted) throw new Error('The inspected run could not be read back.');
    const source = toEvaluationInput(persisted);

    expect(persisted.scenarioId).toBe(BASELINE_SCENARIO_ID);
    expect(evidence.scenario).toEqual({
      id: persisted.scenarioId,
      version: persisted.scenarioVersion,
    });
    expect(evidence.seed).toBe(persisted.seed);
    expect(evidence.status).toBe(source.status);
    expect(evidence.evaluation).toEqual(evaluatePersistedRun(persisted));
    expect(evidence.actions.total).toBe(source.actions.length);
    expect(evidence.actions.accepted).toBe(source.actions.filter((a) => a.accepted).length);
    expect(evidence.actions.rejected).toBe(source.actions.filter((a) => !a.accepted).length);
    expect(evidence.toolCalls.total).toBe(source.toolCalls.length);
    expect(evidence.toolCalls.failed).toBe(
      source.toolCalls.filter((call) => call.status !== 'SUCCEEDED').length,
    );
    // Only the runs this execution produced may be inspected — and this is one.
    expect(run.result?.runs.map((entry) => entry.runId)).toContain(evidence.runId);
  });

  it('replays the run through the replay engine, frame for frame', async () => {
    const response = await invokeOperator(executeScript(), {
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'execute',
      authorizedPlanFingerprint: await plannedFingerprint(),
    });
    const run = await runStateOf(response);
    const replayStep = run.trace.find((step) => step.tool === 'replay_case');
    const evidence = run.caseEvidence[0];
    if (!evidence || !replayStep) throw new Error('The operator replayed nothing.');

    const persisted = await loadRun(evidence.runId, OWNER);
    if (!persisted) throw new Error('The replayed run could not be read back.');
    const source = toEvaluationInput(persisted);
    const replay = buildSimulationReplay({
      initialState: source.initialState,
      actions: source.actions,
      events: source.events,
    });

    expect(replayStep.detail.frameCount).toBe(replay.frames.length);
    expect(replayStep.status).toBe('completed');
    expect(replay.frames.length).toBeGreaterThan(0);
    // The frames are the persisted trace, reconstructed — not a summary of it.
    expect(replay.frames.at(-1)?.state).toEqual(source.state);
  });

  it('analyses counterfactuals with the engine’s own policies and figures', async () => {
    const response = await invokeOperator(executeScript(), {
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'execute',
      authorizedPlanFingerprint: await plannedFingerprint(),
    });
    const run = await runStateOf(response);
    const finding = run.counterfactuals[0];
    if (!finding) throw new Error('The operator analysed no counterfactual.');

    const outcome = await analyzePersistedCounterfactual({ runId: finding.runId, ownerId: OWNER });
    if (outcome?.kind !== 'report') throw new Error('The engine returned no report.');
    const { report } = outcome;

    expect(finding.policies).toEqual({
      actionSpace: report.policies.actionSpace,
      continuation: report.policies.continuation,
      comparison: report.policies.comparison,
    });
    expect(finding.baselineOverallScore).toBe(report.baseline.overallScore);
    expect(finding.decisionsAnalysed).toBe(report.summary.decisionPoints);
    expect(finding.maxRegret).toBe(report.summary.maxRegret);
    expect(finding.outcomeFlipDecisions).toBe(report.summary.outcomeFlipDecisions);
    // The critical decision, when the engine named one, is the engine's own.
    if (report.causal.criticalDecision)
      expect(finding.criticalDecision?.index).toBe(report.causal.criticalDecision.index);
    else expect(finding.criticalDecision).toBeNull();
    // It is a statement about an existing run — it created no second one.
    const persisted = await loadRun(finding.runId, OWNER);
    expect(persisted?.id).toBe(finding.runId);
  });

  it('cannot reach a run that is not part of the execution that asked', async () => {
    const foreignRunId = await anyRunIdFor(OWNER, BASELINE_SCENARIO_ID);
    const response = await invokeOperator(
      [
        calls({ tool: 'list_agents' }),
        calls({ tool: 'inspect_case', input: { runId: foreignRunId } }),
        calls({ tool: 'analyze_counterfactual', input: { runId: foreignRunId } }),
        say('That run is not mine.'),
      ],
      { objective: OBJECTIVE, agentKey: AGENT_KEY },
      FOREIGN_OWNER,
    );
    expect(response.status).toBe(200);
    const run = await runStateOf(response);
    // Both calls were refused by the ownership boundary, before any query.
    expect(run.trace.filter((step) => step.status === 'refused')).toHaveLength(2);
    expect(run.caseEvidence.some((entry) => entry.runId === foreignRunId)).toBe(false);
    expect(run.counterfactuals.some((entry) => entry.runId === foreignRunId)).toBe(false);
    // Nothing about someone else's run is anywhere in the state.
    expect(JSON.stringify(run)).not.toContain(foreignRunId);
  });

  it('takes the owner from the session, never from the request body', async () => {
    // A body that names an owner is a body that is trying to. The request schema
    // has no such field, and the runs prove which identity was used.
    const response = await invokeOperator(
      [
        calls({ tool: 'list_agents' }),
        calls({ tool: 'list_benchmarks' }),
        calls({ tool: 'get_benchmark', input: { benchmarkId: BENCHMARK_ID } }),
        calls({
          tool: 'create_test_plan',
          input: { benchmarkId: BENCHMARK_ID, agentKey: AGENT_KEY },
        }),
        say('done'),
      ],
      { objective: OBJECTIVE, agentKey: AGENT_KEY, ownerId: OWNER, userId: OWNER },
      FOREIGN_OWNER,
    );
    expect(response.status).toBe(200);
    const run = await runStateOf(response);
    expect(run.plan?.benchmark.id).toBe(BENCHMARK_ID);
    // The plan the foreign session committed to is a plan for a foreign run; the
    // first owner's rows are untouched and none of them is new.
    const newest = await prisma.simulationRun.findFirst({
      where: { ownerId: OWNER },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    expect(newest?.createdAt.getTime() ?? 0).toBeLessThan(requestStartedAt.getTime());
  });
});

// ── The trust report ────────────────────────────────────────────────────────

describe('5. the trust report is assembled from the engines’ own output', () => {
  it('carries the observed figures the benchmark engine produced', async () => {
    const response = await invokeOperator(executeScript(), {
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'execute',
      authorizedPlanFingerprint: await plannedFingerprint(),
    });
    const run = await runStateOf(response);
    const report = run.report;
    const slice = run.result;
    if (!report || !slice) throw new Error('The operator produced no report.');

    expect(report.objective).toBe(OBJECTIVE);
    expect(report.benchmark.id).toBe(BENCHMARK_ID);
    expect(report.benchmark.version).toBe(1);
    expect(report.target.key).toBe(AGENT_KEY);
    expect(report.observed.overall).toBe(slice.dimensions.averageOverallScore);
    expect(report.observed.minimum).toBe(slice.dimensions.minimumOverallScore);
    expect(report.observed.maximum).toBe(slice.dimensions.maximumOverallScore);
    expect(report.observed.robustness.score).toBe(slice.robustness.robustnessScore);
    expect(report.observed.robustness.formula).toBe('baseline-retention-v1');
    for (const [key, value] of Object.entries(report.observed.caseSummary))
      expect(value, key).toBe((slice.caseSummary as Record<string, number>)[key]);
    expect(report.observed.scenarioPerformance.map((row) => row.scenarioId)).toEqual(
      slice.scenarios.map((row) => row.scenarioId),
    );
  });

  it('references the runs that actually exist, not ids it made up', async () => {
    const response = await invokeOperator(executeScript(), {
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'execute',
      authorizedPlanFingerprint: await plannedFingerprint(),
    });
    const run = await runStateOf(response);
    const report = run.report;
    if (!report) throw new Error('The operator produced no report.');

    expect(report.evidence.runIds.length).toBeGreaterThan(0);
    for (const runId of report.evidence.runIds) {
      const persisted = await loadRun(runId, OWNER);
      expect(persisted?.id, runId).toBe(runId);
    }
    // The evidence names scenarios and the policies the figures came from — the
    // methodology the verdict used, the retention formula, and the counterfactual
    // engine's own declared policies.
    expect(report.evidence.scenarioIds).toEqual(MATRIX.map((cell) => cell.scenarioId));
    expect(report.evidence.policies.map((policy) => policy.name)).toEqual(
      expect.arrayContaining(['readiness method', 'robustness formula']),
    );
    for (const policy of report.evidence.policies) expect(policy.value.length).toBeGreaterThan(0);
    // Every decision id names a run the report also references.
    for (const decisionId of report.evidence.decisionIds)
      expect(report.evidence.runIds.some((runId) => decisionId.startsWith(`${runId}#`))).toBe(true);
    // The provenance is the run that produced it, plan digest included.
    expect(report.provenance.planFingerprint).toBe(run.plan?.fingerprint);
    expect(report.provenance.benchmarkRuns).toBe(1);
    expect(report.provenance.toolCalls).toBe(run.usage.toolCalls);
  });

  it('publishes every rule of a named methodology, with what each one saw', async () => {
    const response = await invokeOperator(executeScript(), {
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'execute',
      authorizedPlanFingerprint: await plannedFingerprint(),
    });
    const run = await runStateOf(response);
    const verdict = run.report?.verdict;
    if (!verdict) throw new Error('The operator produced no verdict.');

    expect(verdict.methodology).toBe('observed-evidence-thresholds-v1');
    expect(['READY', 'CAUTION', 'NOT_READY', 'INSUFFICIENT_EVIDENCE']).toContain(verdict.verdict);
    expect(verdict.headline.length).toBeGreaterThan(10);
    for (const rule of verdict.rules) {
      expect(rule.threshold.length, rule.id).toBeGreaterThan(0);
      expect(rule.detail.length, rule.id).toBeGreaterThan(0);
      // A rule that could not be measured says so rather than reporting a zero.
      if (rule.outcome === 'insufficient') expect(rule.observed).toBeNull();
    }
    // A READY verdict is only reachable when no rule raised a caution.
    if (verdict.verdict === 'READY')
      expect(verdict.rules.some((rule) => rule.outcome !== 'pass')).toBe(false);
  });

  it('keeps the model’s reading apart from every measurement', async () => {
    const response = await invokeOperator(executeScript(), {
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'execute',
      authorizedPlanFingerprint: await plannedFingerprint(),
    });
    const run = await runStateOf(response);
    const report = run.report;
    if (!report) throw new Error('The operator produced no report.');

    expect(report.interpretation).toBe(
      'The baseline condition scores best; every perturbation costs it something.',
    );
    expect(report.recommendation).toBe('Investigate the worst-scoring condition before deploying.');
    // Nothing the model wrote is presented as a measurement.
    expect(report.observed.overall).toBe(run.result?.dimensions.averageOverallScore);
    expect(JSON.stringify(report.observed)).not.toContain('every perturbation costs it something');
    expect(JSON.stringify(report.verdict)).not.toContain('before deploying');
  });
});

// ── A failure is reported, never converted into a number ────────────────────

describe('6. a case that produced no evidence is reported as such', () => {
  it('names the failure and holds the verdict below READY', async () => {
    const fingerprint = await plannedFingerprint();
    state.failScenario = FAILING_SCENARIO_ID;
    const response = await invokeOperator(executeScript(), {
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'execute',
      authorizedPlanFingerprint: fingerprint,
    });
    expect(response.status).toBe(200);
    const run = await runStateOf(response);
    const slice = run.result;
    const report = run.report;
    if (!slice || !report) throw new Error('The faulted run produced no report.');

    // The failure really happened, and the engine counted it rather than the
    // harness having failed to inject it. The slice projects the engine's
    // taxonomy as a loose record — the benchmark engine owns that shape — so it
    // is read back through the engine's own schema rather than field by field,
    // and a count the slice does not carry fails here instead of arriving as a
    // missing value that compares equal to nothing.
    const failures = BenchmarkFailureAnalysis.safeParse(slice.failures);
    if (!failures.success)
      throw new Error(`The result slice carries no failure analysis: ${failures.error.message}`);
    expect(failures.data.providerFailures.count).toBeGreaterThan(0);
    expect(failures.data.providerFailures.scenarioIds).toContain(FAILING_SCENARIO_ID);

    const errored = slice.caseSummary.errorCases;
    const unavailable = slice.caseSummary.unavailableCases;
    if (errored === undefined || unavailable === undefined)
      throw new Error('The result slice carries no case-summary counts.');
    expect(errored + unavailable).toBeGreaterThan(0);

    // The operator says so, in its notices and in its report.
    expect(run.notices.join(' ')).toContain('no readable evidence');
    expect(report.observed.failures.some((entry) => entry.count > 0)).toBe(true);
    const coverage = report.verdict.rules.find((rule) => rule.id === 'coverage');
    expect(coverage?.outcome).toBe('caution');
    expect(coverage?.evidence.length).toBeGreaterThan(0);
    for (const runId of coverage?.evidence ?? []) {
      const persisted = await loadRun(runId, OWNER);
      expect(persisted).not.toBeNull();
    }

    // The verdict cannot be READY while a case died.
    expect(report.verdict.verdict).not.toBe('READY');

    // The failing case is reported as the failure it is. The evaluation engine
    // still scores an errored run — that is the engine's own documented
    // treatment, not the operator's — so what matters is that the score shown is
    // the engine's and that the *failure* is named rather than averaged away.
    const faulted = slice.runs.find((entry) => entry.scenarioId === FAILING_SCENARIO_ID);
    if (!faulted) throw new Error('The failing scenario produced no run row.');
    expect(faulted.status).toBe('ERROR');
    expect(faulted.outcome).toBe('unsuccessful');
    const persistedFaulted = await loadRun(faulted.runId, OWNER);
    if (!persistedFaulted) throw new Error('The failing case’s run could not be read back.');
    expect(faulted.overallScore).toBe(evaluatePersistedRun(persistedFaulted)?.overallScore ?? null);
    expect(faulted.terminationReason).toBe(persistedFaulted.terminationReason);
    // The provider failure is recorded on the run itself, so the operator is
    // quoting a fact the database holds rather than a category it assigned.
    expect(persistedFaulted.events.some((event) => event.kind === 'agent.error')).toBe(true);
    expect(persistedFaulted.terminationReason ?? '').toMatch(/provider/i);
  });
});

// ── Bounds and confidentiality, on the state a person is served ─────────────

describe('7. the run state is bounded and carries no secret', () => {
  it('holds every call inside the published budget and stops at one execution', async () => {
    const response = await invokeOperator(executeScript(), {
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'execute',
      authorizedPlanFingerprint: await plannedFingerprint(),
    });
    const run = await runStateOf(response);
    expect(run.usage.toolCalls).toBeLessThanOrEqual(MAX_OPERATOR_TOOL_CALLS);
    expect(run.usage.benchmarkRuns).toBeLessThanOrEqual(MAX_OPERATOR_BENCHMARK_RUNS);
    expect(run.limits.maxToolCalls).toBe(MAX_OPERATOR_TOOL_CALLS);
    expect(run.limits.maxBenchmarkRuns).toBe(MAX_OPERATOR_BENCHMARK_RUNS);
    expect(run.usage.durationMs).toBeLessThan(run.limits.maxDurationMs);
    // The trace is the calls that happened — not one step more, not one fewer.
    expect(run.usage.toolCalls).toBe(run.trace.length);
  });

  it('never carries the credential the deployment resolved', async () => {
    const response = await invokeOperator(executeScript(), {
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'execute',
      authorizedPlanFingerprint: await plannedFingerprint(),
    });
    const body = await response.text();
    expect(body).not.toContain(STUB_CREDENTIAL);
    expect(body).not.toMatch(/sk-[a-zA-Z0-9]{8}|bearer\s|api[_-]?key\s*[:=]|client[_-]?secret/i);
    // And the response is a `run`, nothing else — no envelope carrying internals.
    expect(Object.keys(JSON.parse(body) as Record<string, unknown>)).toEqual(['run']);
  });
});
