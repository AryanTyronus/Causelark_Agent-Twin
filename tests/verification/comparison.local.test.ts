//
// This harness is NOT part of the unit suite (`npm test` includes only
// `tests/unit/**`). It runs a real agent comparison against a real PostgreSQL
// database, through the real comparison engine, the real benchmark engine, the
// real scenario engine, the real persistence layer and the real evaluation
// engine — and it checks the comparison against the rows the database actually
// holds, rather than against a fixture.
//
// Exactly one thing is stubbed: the model provider. The stub is not a fake
// simulation — it invokes the same allow-listed tools the real agent would, so
// every step still passes through the environment's own validator and is
// persisted the same way. What it replaces is only the choice of which tool to
// call, which is the one thing a language model decides. No credential is read,
// no network call is made, and no environment variable is asserted on.
//
// Run with:
//   npx vitest run --config vitest.verification.config.ts
//
// It expects a DISPOSABLE database — it creates real runs and does not remove
// them. See the report accompanying this phase for the exact procedure (create a
// sibling database, `prisma migrate deploy`, run this, drop it).

import { describe, expect, it, vi } from 'vitest';

/** One owner per phase, so a row count means something. */
const OWNER = 'comparison-local-verification';
const FOREIGN_OWNER = 'comparison-local-foreign';
const ROUTE_OWNER = 'comparison-local-route';
const UNRUNNABLE_OWNER = 'comparison-local-unrunnable';

/** The identity the auth gate resolves. Swapped, never a second session. */
let currentOwner = OWNER;

vi.mock('server-only', () => ({}));

vi.mock('@/lib/require-auth', () => ({
  requireAuth: async () => ({ id: currentOwner, email: `${currentOwner}@example.test` }),
}));

/** Every model invocation the stub served, as `model|scenario` or `model|later`. */
const invocations: string[] = [];

/**
 * A provider fault, keyed `model|scenario`.
 *
 * The second agent's provider refuses exactly one scenario, so the experiment
 * has to carry a real failure through the whole pipeline — recorded against one
 * agent, without touching the other.
 */
const faults = new Map<string, string>([
  [
    'verification-model-b|resource-outage',
    'The provider rejected the request during verification.',
  ],
]);

vi.mock('@/lib/agent/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/provider')>();
  return {
    ...actual,
    invokeResourceAgent: async (input: {
      state: unknown;
      tools: Array<{ name: string }>;
      timeoutMs: number;
      maxTurns?: number;
      maxActions?: number;
      selection?: { provider: string; modelId: string } | null;
    }): Promise<unknown> => {
      const modelId = input.selection?.modelId;
      if (!modelId)
        throw new Error('A comparison must name the agent each turn runs on; none was supplied.');
      const scenarioId = scenarioOfState.get(JSON.stringify(input.state));
      invocations.push(`${modelId}|${scenarioId ?? 'later'}`);
      const fault = scenarioId ? faults.get(`${modelId}|${scenarioId}`) : undefined;
      if (fault) throw new actual.AgentProviderError('provider_error', fault);

      const plan = PLANS[modelId];
      if (!plan) throw new Error(`No verification plan is defined for ${modelId}.`);
      let accepted = 0;
      for (const step of plan) {
        const tool = input.tools.find((candidate) => candidate.name === step.tool);
        if (!tool) throw new Error(`Tool ${step.tool} is not available to the agent.`);
        const outcome = (await (
          tool as unknown as { invoke(i?: unknown): Promise<unknown> }
        ).invoke(step.input)) as { accepted?: boolean } | undefined;
        if (outcome?.accepted === true) accepted += 1;
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
        acceptedToolCount: accepted,
        stopReason: 'endTurn',
      };
    },
  };
});

import { POST as runComparison } from '@/app/api/agent-comparisons/[comparisonId]/run/route';
import { evaluatePersistedRun } from '@/lib/business/simulation-evaluation';
import { loadRun } from '@/lib/business/simulation-persistence';
import { getExperiment } from '@/lib/comparison/catalog';
import { executeComparison } from '@/lib/comparison/execute';
import { buildComparisonMatrix, maximumAgentsFor } from '@/lib/comparison/matrix';
import { compareValues } from '@/lib/comparison/metrics';
import type { ComparisonReport } from '@/lib/comparison/types';
// biome-ignore lint/style/noRestrictedImports: this harness counts rows either side of an experiment to prove an unrunnable agent creates none; it is a verification script, not app code.
import { prisma } from '@/lib/db';
import { initializeScenarioRun } from '@/lib/scenarios/scenario';

const EXPERIMENT_ID = 'resource-routing-agent-comparison';
const BENCHMARK_ID = 'resource-routing-robustness';
const SEED = 1042;
const SCENARIO_IDS = [
  'baseline',
  'resource-scarcity',
  'budget-pressure',
  'elevated-risk',
  'resource-outage',
  'tight-step-limit',
  'action-rejection',
] as const;

/** Two agents differing in exactly one thing: which build of it is running. */
const AGENT_A = {
  agentId: 'verify-agent-a',
  agentVersion: '1',
  provider: 'bedrock',
  model: 'verification-model-a',
} as const;
const AGENT_B = {
  agentId: 'verify-agent-b',
  agentVersion: '1',
  provider: 'openrouter',
  model: 'verification-model-b',
} as const;
/** A configuration this build cannot construct a provider client for. */
const AGENT_UNRUNNABLE = {
  agentId: 'verify-agent-c',
  agentVersion: '1',
  provider: 'not-a-provider',
  model: 'verification-model-c',
} as const;

interface Step {
  tool: string;
  input: unknown;
}

const OBSERVE: Step = { tool: 'observe_resources', input: {} };
const HARVEST_ONE: Step = {
  tool: 'request_action',
  input: { type: 'harvest', resource: 'materials', amount: 1 },
};
const ALLOCATE_TWO: Step = {
  tool: 'request_action',
  input: { type: 'allocate', resource: 'materials', amount: 2 },
};
/**
 * An action the environment genuinely refuses: only one material has been
 * harvested, so the validator rejects it without changing state. It is a real
 * validation rejection through the same validator the operator path uses, and it
 * is what makes the two agents differ on something other than their provider.
 *
 * The amount is within the action schema's own bounds on purpose. An amount
 * outside them is refused by the tool's input schema before the environment ever
 * sees it, which the runtime records as a failed invocation rather than as a
 * rejected action — a different fact about a different layer.
 */
const ALLOCATE_TOO_MUCH: Step = {
  tool: 'request_action',
  input: { type: 'allocate', resource: 'materials', amount: 5 },
};

const PLANS: Record<string, Step[]> = {
  'verification-model-a': [OBSERVE, HARVEST_ONE, ALLOCATE_TWO],
  'verification-model-b': [OBSERVE, HARVEST_ONE, ALLOCATE_TOO_MUCH, ALLOCATE_TWO],
};

/** Initial world per scenario, so the stub can tell which case it is driving. */
const scenarioOfState = new Map<string, string>();
for (const scenarioId of SCENARIO_IDS) {
  const { state } = initializeScenarioRun({
    environmentKey: 'resource-routing',
    objectiveKey: 'complete-delivery',
    seed: SEED,
    scenarioId,
  });
  scenarioOfState.set(JSON.stringify(state), scenarioId);
}

/** Everything in a report that must not depend on the run ids it references. */
function reproducibleProjection(report: ComparisonReport): string {
  return JSON.stringify({
    experiment: report.experiment,
    methodology: report.methodology,
    agents: report.agents.map((agent) => ({
      identity: agent.identity,
      key: agent.key,
      status: agent.status,
      metrics: agent.metrics,
      strongest: agent.strongestScenarioId,
      weakest: agent.weakestScenarioId,
      summary: agent.report?.summary,
      dimensions: agent.report?.dimensions,
      robustness: agent.report?.robustness,
      cases: agent.report?.runs.map((run) => [run.case.key, run.status, run.outcome]),
    })),
    metrics: report.metrics,
    scenarios: report.scenarios,
    robustness: report.robustness,
    failures: report.failures,
    headToHead: report.headToHead,
    verdict: report.verdict,
  });
}

describe('1–2. the experiment and its matrix', () => {
  const { template, definition } = getExperiment(EXPERIMENT_ID);
  const matrix = buildComparisonMatrix(definition, [AGENT_A, AGENT_B]);

  it('resolves resource-routing-agent-comparison@1 from the server-side registry', () => {
    expect(template.id).toBe(EXPERIMENT_ID);
    expect(template.version).toBe(1);
    expect(definition.id).toBe(BENCHMARK_ID);
    expect(definition.version).toBe(1);
    expect(definition.scenarios).toHaveLength(7);
    expect(definition.seeds).toEqual([SEED]);
    // A template names no agent, no provider and no model.
    expect(JSON.stringify(template)).not.toMatch(/bedrock|openrouter|anthropic|openai|model/i);
  });

  it('expands to one cell per agent per benchmark case', () => {
    expect(matrix).toHaveLength(14);
    expect(new Set(matrix.map((cell) => cell.key)).size).toBe(14);
    expect(matrix.map((cell) => cell.index)).toEqual([...matrix.keys()]);
    for (const cell of matrix) {
      expect(cell.key).toContain(cell.agent);
      expect(cell.key).toContain(`${cell.scenarioId}@${cell.scenarioVersion}#${cell.seed}`);
    }
    // The matrix is a function of the *set* of agents, not of the order they
    // were listed in.
    expect(buildComparisonMatrix(definition, [AGENT_B, AGENT_A])).toEqual(matrix);
  });

  it('caps the agent count at what the benchmark’s own size allows', () => {
    expect(maximumAgentsFor(definition)).toBe(4);
  });
});

describe('3–6. execution against the real database', () => {
  const agents = [AGENT_A, AGENT_B];
  let report: ComparisonReport;

  it('runs one benchmark per agent and reports on both', async () => {
    report = await executeComparison({ ownerId: OWNER, comparisonId: EXPERIMENT_ID, agents });
    expect(report.execution.plannedCaseCount).toBe(14);
    expect(report.execution.executedCaseCount).toBe(14);
    expect(report.execution.comparedAgentCount).toBe(2);
    expect(report.execution.unavailableAgentCount).toBe(0);
    expect(report.agents).toHaveLength(2);
    expect(report.agents.map((agent) => agent.identity)).toEqual([
      'verify-agent-a@1',
      'verify-agent-b@1',
    ]);
    // Each agent's runs are attributed to the agent that produced them.
    expect(report.agents[0]?.report?.agent).toMatchObject({
      provider: 'bedrock',
      model: 'verification-model-a',
    });
    expect(report.agents[1]?.report?.agent).toMatchObject({
      provider: 'openrouter',
      model: 'verification-model-b',
    });
    // One benchmark, run twice: the definition half of both reports is identical.
    expect(report.agents[1]?.report?.benchmark).toEqual(report.agents[0]?.report?.benchmark);
    expect(report.agents[1]?.report?.configuration).toEqual(
      report.agents[0]?.report?.configuration,
    );
  });

  it('creates an isolated, owner-scoped run for every cell', async () => {
    const runIds = report.agents.flatMap(
      (agent) => agent.report?.runs.map((run) => run.runId) ?? [],
    );
    expect(runIds).toHaveLength(14);
    expect(new Set(runIds).size).toBe(14);
    for (const runId of runIds) {
      const run = await loadRun(runId, OWNER);
      if (!run) throw new Error(`Run ${runId} could not be read back.`);
      expect(run.ownerId).toBe(OWNER);
      expect(run.seed).toBe(SEED);
      // A different owner cannot see another owner's runs.
      expect(await loadRun(runId, FOREIGN_OWNER)).toBeNull();
    }
  });

  it('gives every agent the same world, and each case a fresh one', async () => {
    const worldOf = async (agentIndex: number, scenarioId: string) => {
      const entry = report.agents[agentIndex]?.report?.runs.find(
        (run) => run.case.scenarioId === scenarioId,
      );
      if (!entry) throw new Error(`Agent ${agentIndex} ran no ${scenarioId} case.`);
      const run = await loadRun(entry.runId, OWNER);
      if (!run) throw new Error(`Run ${entry.runId} could not be read back.`);
      return run;
    };

    const worlds: Array<[string, unknown]> = [];
    for (const scenarioId of SCENARIO_IDS) {
      const [a, b] = [await worldOf(0, scenarioId), await worldOf(1, scenarioId)];
      // Identical conditions: the same starting world, the same configuration,
      // the same tasks, the same constraints, the same budget and turn budget.
      expect(b.initialState).toEqual(a.initialState);
      expect(b.configuration).toEqual(a.configuration);
      expect(b.tasks).toEqual(a.tasks);
      expect(b.constraints).toEqual(a.constraints);
      expect(b.budgetLimit).toBe(a.budgetLimit);
      expect(b.maxTurns).toBe(a.maxTurns);
      expect(b.scenarioId).toBe(a.scenarioId);
      expect(b.scenarioVersion).toBe(a.scenarioVersion);
      // ...and they are genuinely different rows, not one row read twice.
      expect(b.id).not.toBe(a.id);
      worlds.push([scenarioId, a.initialState]);
    }

    // The world each case started from is the scenario engine's own, built for
    // that scenario at that seed — not a world the comparison layer assembled.
    for (const [scenarioId, state] of worlds) {
      expect(state).toEqual(
        initializeScenarioRun({
          environmentKey: 'resource-routing',
          objectiveKey: 'complete-delivery',
          seed: SEED,
          scenarioId,
        }).state,
      );
    }
  });

  it('records the agent and the case on each run’s start event', async () => {
    for (const [index, agent] of report.agents.entries()) {
      for (const entry of agent.report?.runs ?? []) {
        const run = await loadRun(entry.runId, OWNER);
        if (!run) throw new Error(`Run ${entry.runId} could not be read back.`);
        const started = run.events.filter((event) => event.kind === 'simulation.started');
        expect(started).toHaveLength(1);
        const payload = started[0]?.payload as Record<string, unknown>;
        expect(payload.benchmarkId).toBe(BENCHMARK_ID);
        expect(payload.caseKey).toBe(entry.case.key);
        expect(payload.agentId).toBe(index === 0 ? AGENT_A.agentId : AGENT_B.agentId);
        expect(payload.agentVersion).toBe('1');
      }
    }
  });

  it('scores each agent through the existing evaluation engine, unchanged', async () => {
    for (const agent of report.agents) {
      for (const entry of agent.report?.runs ?? []) {
        const persisted = await loadRun(entry.runId, OWNER);
        if (!persisted) throw new Error(`Case ${entry.case.key} left no persisted run.`);
        expect(entry.evaluation).toEqual(evaluatePersistedRun(persisted));
      }
    }
  });

  it('is reproducible: the same experiment reports the same result twice', async () => {
    const second = await executeComparison({ ownerId: OWNER, comparisonId: EXPERIMENT_ID, agents });
    expect(reproducibleProjection(second)).toBe(reproducibleProjection(report));
    // Different runs, same answer.
    const firstIds = report.agents.flatMap((a) => a.report?.runs.map((r) => r.runId) ?? []);
    const secondIds = second.agents.flatMap((a) => a.report?.runs.map((r) => r.runId) ?? []);
    expect(secondIds).not.toEqual(firstIds);
    expect(second.experiment.key).toBe(report.experiment.key);
  });
});

describe('7–10. aggregation, robustness and the verdict', () => {
  let report: ComparisonReport;

  it('re-expresses the benchmark engine’s own numbers rather than inventing any', async () => {
    report = await executeComparison({
      ownerId: OWNER,
      comparisonId: EXPERIMENT_ID,
      agents: [AGENT_A, AGENT_B],
    });
    for (const agent of report.agents) {
      const dimensions = agent.report?.dimensions;
      if (!dimensions) throw new Error(`${agent.identity} produced no dimensions.`);
      expect(agent.metrics.evaluatedCaseCount).toBe(dimensions.evaluatedCaseCount);
      expect(agent.metrics.averageOverallScore).toBe(dimensions.averageOverallScore);
      expect(agent.metrics.averageTaskScore).toBe(dimensions.averageTaskScore);
      expect(agent.metrics.averageSafetyScore).toBe(dimensions.averageSafetyScore);
      expect(agent.metrics.averageEfficiencyScore).toBe(dimensions.averageEfficiencyScore);
      expect(agent.metrics.averageResourceScore).toBe(dimensions.averageResourceScore);
      expect(agent.metrics.averageReliabilityScore).toBe(dimensions.averageReliabilityScore);
      // Robustness is the benchmark engine’s, under its own named formula.
      expect(agent.metrics.robustnessScore).toBe(agent.report?.robustness.robustnessScore);
      // Failure counts are the benchmark engine’s classifications.
      expect(agent.metrics.providerFailureCount).toBe(
        agent.report?.failures.providerFailures.count,
      );
      expect(agent.metrics.toolFailureCount).toBe(agent.report?.failures.toolFailures.count);
      expect(agent.metrics.timeoutCount).toBe(agent.report?.failures.timeouts.count);
    }
    expect(report.robustness.formula).toBe('baseline-retention-v1');
    expect(report.robustness.scores).toEqual(
      report.agents.map((agent) => agent.report?.robustness.robustnessScore ?? null),
    );
    expect(report.robustness.unavailableReasons).toEqual(
      report.agents.map((agent) => agent.report?.robustness.unavailableReason ?? null),
    );
  });

  it('keeps the provider fault against the agent that produced it', () => {
    const [a, b] = report.agents;
    if (!a || !b) throw new Error('The experiment did not compare two agents.');
    expect(a?.metrics.providerFailureCount).toBe(0);
    expect(b?.metrics.providerFailureCount).toBe(1);
    // The failure is visible as a row, with the agents it belongs to.
    const row = report.failures.find((entry) => entry.category === 'providerFailures');
    expect(row?.counts).toEqual([0, 1]);
    expect(row?.agents).toEqual([b?.key]);
    expect(a?.unavailableReason).toBeNull();
    // It did not stop the faulting agent from being compared, and it did not
    // touch the other agent.
    expect(b?.status).toBe('COMPARED');
    // The two agents miss *different* cases, and the difference is the whole
    // point of reporting failures per agent rather than as one experiment total.
    // A is a careful agent that runs out of steps in the one scenario with a
    // halved budget; B is an aggressive agent that over-allocates, is refused by
    // the environment, and loses the case where its provider faults.
    const missed = (agent: (typeof report.agents)[number]) =>
      (agent.report?.runs ?? [])
        .filter((run) => run.evaluation?.metrics.objectiveReached === false)
        .map((run) => run.case.scenarioId);
    expect(missed(a)).toEqual(['tight-step-limit']);
    expect(missed(b)).toEqual(['resource-outage']);
    // Each agent's own failure class is recorded against it, and only against it.
    expect(a?.report?.failures.providerFailures.count).toBe(0);
    expect(b?.report?.failures.providerFailures.count).toBe(1);
    expect(a?.metrics.timeoutCount).toBe(0);
    expect(b?.metrics.timeoutCount).toBe(0);
    // The rejected-action rate separates them on the evidence the environment
    // itself produced: B is refused repeatedly, A is never refused.
    expect(a?.metrics.rejectedActionRate).toBe(0);
    expect(b?.metrics.rejectedActionRate).toBeGreaterThan(0);
    // A succeeds in one fewer case each way, so the *rate* ties — which is
    // exactly why a verdict that could only read task success would have to
    // report a tie here. The overall score is what separates them.
    expect(a?.metrics.taskSuccessRate).toBe(b?.metrics.taskSuccessRate);
    expect(a?.metrics.completionRate).toBe(b?.metrics.completionRate);
    expect(a?.metrics.averageOverallScore).toBeGreaterThan(
      b?.metrics.averageOverallScore ?? Number.POSITIVE_INFINITY,
    );
  });

  it('names the better agent by a declared rule, not by judgement', () => {
    const [a, b] = report.agents;
    if (!a || !b) throw new Error('The experiment did not compare two agents.');
    // The direction the rule used is the metric table's own, and the winner has
    // the better value under it.
    expect(
      compareValues(
        'averageOverallScore',
        a.metrics.averageOverallScore ?? 0,
        b.metrics.averageOverallScore ?? 0,
      ),
    ).toBeGreaterThan(0);

    expect(report.verdict.rule).toBe('declared-discriminator-order-v1');
    expect(report.verdict.outcome).toBe('WINNER');
    expect(report.verdict.winner).toBe(a.key);
    expect(report.verdict.winnerIdentity).toBe('verify-agent-a@1');
    expect(report.verdict.decidedBy).toBe('averageOverallScore');
    // The deciding rung is recorded, and it agrees with the metrics beside it.
    const first = report.verdict.levels[0];
    expect(first?.metric).toBe('averageOverallScore');
    expect(first?.contenders).toEqual([a.key, b.key]);
    expect(first?.leaders).toEqual([a.key]);
    expect(first?.value).toBe(a.metrics.averageOverallScore);
    expect(first?.decided).toBe(true);
    // The verdict names no vendor and no model: it names a configuration.
    expect(report.verdict.reason).not.toMatch(/bedrock|openrouter|verification-model/i);
  });

  it('compares every scenario from the evidence, and every pair head to head', () => {
    expect(report.scenarios.map((row) => row.scenarioId)).toEqual([...SCENARIO_IDS]);
    for (const row of report.scenarios) {
      expect(row.scores).toHaveLength(2);
      for (const agent of report.agents) {
        const expected =
          agent.report?.scenarios.find((entry) => entry.scenarioId === row.scenarioId)?.score ??
          null;
        expect(row.scores[report.agents.indexOf(agent)]).toBe(expected);
      }
    }
    expect(report.headToHead).toHaveLength(1);
    expect(report.headToHead[0]?.left).toBe(report.agents[0]?.key);
    expect(report.headToHead[0]?.right).toBe(report.agents[1]?.key);
  });

  it('leaves drill-down open: agent → case → run → evaluation', async () => {
    const winner = report.agents.find((agent) => agent.key === report.verdict.winner);
    if (!winner) throw new Error('The verdict named an agent the report does not carry.');
    const entry = winner.report?.runs.find((run) => run.case.scenarioId === 'baseline');
    if (!entry) throw new Error('The winning agent ran no baseline case.');
    const persisted = await loadRun(entry.runId, OWNER);
    if (!persisted) throw new Error(`Run ${entry.runId} was not persisted for ${OWNER}.`);
    expect(evaluatePersistedRun(persisted)).toEqual(entry.evaluation);
  });
});

describe('11–12. failure isolation and the API seam', () => {
  it('reports an agent this deployment cannot run, without losing the other', async () => {
    const before = await prisma.simulationRun.count({ where: { ownerId: UNRUNNABLE_OWNER } });

    const report = await executeComparison({
      ownerId: UNRUNNABLE_OWNER,
      comparisonId: EXPERIMENT_ID,
      agents: [AGENT_A, AGENT_UNRUNNABLE],
    });

    const [runnable, unrunnable] = report.agents;
    expect(report.execution.unavailableAgentCount).toBe(1);
    expect(report.execution.comparedAgentCount).toBe(1);
    expect(runnable?.status).toBe('COMPARED');
    expect(runnable?.report?.runs).toHaveLength(7);
    expect(unrunnable?.status).toBe('UNAVAILABLE');
    expect(unrunnable?.unavailableReason?.code).toBe('INVALID_AGENT_CONFIGURATION');
    expect(unrunnable?.report).toBeNull();
    // An agent that produced no evidence is not scored as zero anywhere.
    expect(unrunnable?.metrics.evaluatedCaseCount).toBe(0);
    expect(unrunnable?.metrics.averageOverallScore).toBeNull();
    expect(unrunnable?.metrics.taskSuccessRate).toBeNull();
    // One agent with evidence is not a comparison, so the rule declines to name
    // a winner rather than awarding it to the only survivor.
    expect(report.verdict.outcome).toBe('INSUFFICIENT_EVIDENCE');
    expect(report.verdict.winner).toBeNull();

    // The experiment created exactly the runnable agent's seven runs: the agent
    // that could not run created none, and left no half-written case behind.
    const after = await prisma.simulationRun.count({ where: { ownerId: UNRUNNABLE_OWNER } });
    expect(after - before).toBe(7);
  });

  it('serves the same experiment through the API, scoped to the caller', async () => {
    currentOwner = ROUTE_OWNER;
    try {
      const response = await runComparison(
        new Request(`http://localhost/api/agent-comparisons/${EXPERIMENT_ID}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agents: [AGENT_A, AGENT_B] }),
        }),
        { params: Promise.resolve({ comparisonId: EXPERIMENT_ID }) },
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as ComparisonReport;
      expect(body.agents).toHaveLength(2);
      expect(body.execution.executedCaseCount).toBe(14);
      // Every run the endpoint created belongs to the caller, and to nobody else.
      const runIds = body.agents.flatMap(
        (agent) => agent.report?.runs.map((run) => run.runId) ?? [],
      );
      expect(runIds).toHaveLength(14);
      for (const runId of runIds) {
        expect(await loadRun(runId, ROUTE_OWNER)).not.toBeNull();
        expect(await loadRun(runId, FOREIGN_OWNER)).toBeNull();
      }
      // The report the endpoint served names no credential.
      expect(JSON.stringify(body)).not.toMatch(/sk-or-v1|api[_-]?key|authorization|bearer/i);
    } finally {
      currentOwner = OWNER;
    }
  });
});
