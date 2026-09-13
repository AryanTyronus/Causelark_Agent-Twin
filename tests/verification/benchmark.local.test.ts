//
// This harness is NOT part of the unit suite (`npm test` includes only
// `tests/unit/**`). It exists to run the twelve-step local verification against
// a real PostgreSQL database, through the real Prisma client, the real scenario
// engine, the real persistence layer and the real evaluation engine.
//
// Exactly one thing is stubbed: the model provider. No live model call is made,
// which is the same discipline the unit suite follows — the difference is that
// everything below the provider here is real, including the database.
//
// Run with:
//   npx vitest run --config vitest.verification.config.ts
//
// It expects a DISPOSABLE database — it creates real runs and does not remove
// them. See the report accompanying this phase for the exact procedure (create a
// sibling database, `prisma migrate deploy`, run this, drop it).

import { describe, expect, it, vi } from 'vitest';

const OWNER = 'benchmark-local-verification';

vi.mock('server-only', () => ({}));

vi.mock('@/lib/require-auth', () => ({
  requireAuth: async () => ({ id: 'benchmark-local-verification', email: 'verify@example.test' }),
}));

vi.mock('@/lib/agent/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/provider')>();
  return {
    ...actual,
    // The deployed configuration is pinned here so the verification does not
    // depend on which provider the operator's `.env.local` happens to select.
    resolveAgentProvider: () => 'openrouter' as const,
    resolveOpenRouterConfiguration: () => ({
      baseUrl: 'http://localhost/unused',
      apiKey: 'unused-by-the-verification-stub',
      modelId: 'verification-stub-model',
    }),
    agentProviderLabel: () => 'verification stub',
    invokeResourceAgent: async (input: {
      state: unknown;
      tools: Array<{ name: string }>;
    }): Promise<unknown> => {
      const scenarioId = scenarioOfState.get(JSON.stringify(input.state));
      if (scenarioId !== undefined && scenarioId === failScenario) {
        failScenario = null;
        throw new actual.AgentProviderError('provider_error', 'The provider rejected the request.');
      }
      // A short, deterministic plan the environment genuinely accepts: harvest
      // one material, then route two into the objective. Every call goes through
      // the same validator the operator path uses — nothing here is a shortcut.
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

import { GET as getReplay } from '@/app/api/simulations/runs/[runId]/replay/route';
import { POST as rerunSimulation } from '@/app/api/simulations/runs/[runId]/rerun/route';
import { getBenchmark } from '@/lib/benchmarks/catalog';
import { ROBUSTNESS_SCENARIO_IDS } from '@/lib/benchmarks/definitions';
import { executeBenchmark } from '@/lib/benchmarks/execute';
import { buildRunMatrix } from '@/lib/benchmarks/matrix';
import type { BenchmarkResult } from '@/lib/benchmarks/types';
import { evaluatePersistedRun } from '@/lib/business/simulation-evaluation';
import { loadRun } from '@/lib/business/simulation-persistence';
import { SimulationReplay, SimulationRerunResult } from '@/lib/contracts/simulation';
import { initializeScenarioRun } from '@/lib/scenarios/scenario';

const BENCHMARK_ID = 'resource-routing-robustness';
const SEED = 1042;
const SCENARIO_IDS = [...ROBUSTNESS_SCENARIO_IDS];

let failScenario: string | null = null;

/** Initial world per scenario, so the stub can tell which run it is driving. */
const scenarioOfState = new Map<string, string>();
for (const id of SCENARIO_IDS) {
  const { state } = initializeScenarioRun({
    environmentKey: 'resource-routing',
    objectiveKey: 'complete-delivery',
    seed: SEED,
    scenarioId: id,
  });
  scenarioOfState.set(JSON.stringify(state), id);
}

const scenarioIds = SCENARIO_IDS;

/** A projection of a result that excludes run ids, so two executions compare. */ function deterministicProjection(
  result: BenchmarkResult,
): string {
  return JSON.stringify({
    benchmark: result.benchmark,
    configuration: result.configuration,
    summary: result.summary,
    dimensions: result.dimensions,
    robustness: result.robustness,
    scenarios: result.scenarios,
    cases: result.runs.map((run) => [run.case.key, run.status, run.outcome]),
    failureCounts: [
      result.failures.taskFailure.count,
      result.failures.safetyViolation.count,
      result.failures.invalidActions.count,
      result.failures.providerFailures.count,
      result.failures.toolFailures.count,
      result.failures.timeouts.count,
    ],
  });
}

describe('1–3. resolution and the run matrix', () => {
  const definition = getBenchmark(BENCHMARK_ID, 1);
  const matrix = buildRunMatrix(definition);

  it('resolves resource-routing-robustness@1 from the server-side registry', () => {
    expect(definition.id).toBe(BENCHMARK_ID);
    expect(definition.version).toBe(1);
    expect(definition.name).toBe('Resource Routing Robustness');
    expect(definition.environmentKey).toBe('resource-routing');
    expect(definition.objectiveKey).toBe('complete-delivery');
    expect(definition.scenarios).toHaveLength(7);
    expect(definition.seeds).toEqual([SEED]);
  });

  it('constructs a deterministic matrix: scenarios outer, seeds inner', () => {
    expect(matrix).toHaveLength(7);
    expect(matrix.map((cell) => cell.scenarioId)).toEqual(scenarioIds);
    expect(matrix.every((cell) => cell.seed === SEED)).toBe(true);
    expect(matrix.map((cell) => cell.key)).toEqual(scenarioIds.map((id) => `${id}@1#${SEED}`));
    // Two builds are deep-equal: the matrix is a function of the definition.
    expect(buildRunMatrix(definition)).toEqual(matrix);
  });

  it('represents all seven shipped scenarios exactly once, baseline first', () => {
    const ids = matrix.map((cell) => cell.scenarioId);
    expect(new Set(ids).size).toBe(7);
    expect(ids[0]).toBe('baseline');
    for (const id of scenarioIds) expect(ids).toContain(id);
  });
});

describe('4–8. execution against the real database', () => {
  let result: BenchmarkResult;

  it('executes the benchmark and reports a parseable result', async () => {
    result = await executeBenchmark({ ownerId: OWNER, benchmarkId: BENCHMARK_ID });
    expect(result.runs).toHaveLength(7);
    expect(result.benchmark.id).toBe(BENCHMARK_ID);
    expect(result.configuration.seeds).toEqual([SEED]);
    expect(result.configuration.scenarios).toHaveLength(7);
  });

  it('creates one isolated, owner-scoped run per case', async () => {
    const runIds = result.runs.map((run) => run.runId);
    expect(new Set(runIds).size).toBe(7);

    const persisted = [];
    for (const runId of runIds) {
      const run = await loadRun(runId, OWNER);
      if (!run) throw new Error(`Run ${runId} could not be read back.`);
      persisted.push(run);
    }
    expect(persisted.every((run) => run.ownerId === OWNER)).toBe(true);
    expect(persisted.every((run) => run.seed === SEED)).toBe(true);
    // No two cases share a world object: each was initialised independently.
    expect(new Set(persisted.map((run) => JSON.stringify(run.state))).size).toBe(7);

    // The perturbations really are in force in the persisted worlds.
    const worldOf = async (scenarioId: string) => {
      const entry = result.runs.find((run) => run.case.scenarioId === scenarioId);
      if (!entry) throw new Error(`No case ran ${scenarioId}.`);
      const run = await loadRun(entry.runId, OWNER);
      if (!run) throw new Error(`Run ${entry.runId} could not be read back.`);
      return run.state as unknown as {
        resources: { water: number };
        budgetRemaining: number;
      };
    };
    expect((await worldOf('resource-outage')).resources.water).toBe(0);
    const baseline = await worldOf('baseline');
    expect((await worldOf('budget-pressure')).budgetRemaining).toBeLessThan(
      baseline.budgetRemaining,
    );
  });

  it('preserves each case’s scenario identity and version on its run', async () => {
    for (const entry of result.runs) {
      const run = await loadRun(entry.runId, OWNER);
      if (!run) throw new Error(`Run ${entry.runId} could not be read back.`);
      expect(run.scenarioId).toBe(entry.case.scenarioId);
      expect(run.scenarioVersion).toBe(entry.case.scenarioVersion);
      expect(run.environmentKey).toBe('resource-routing');
      // Scenario identity never holds benchmark identity.
      expect(run.scenarioId).not.toContain(BENCHMARK_ID);
    }
  });

  it('records the benchmark identity on each run’s start event', async () => {
    for (const entry of result.runs) {
      const run = await loadRun(entry.runId, OWNER);
      if (!run) throw new Error(`Run ${entry.runId} could not be read back.`);
      const started = run.events.filter((event) => event.kind === 'simulation.started');
      expect(started).toHaveLength(1);
      const payload = started[0]?.payload as Record<string, unknown>;
      expect(payload.benchmarkId).toBe(BENCHMARK_ID);
      expect(payload.benchmarkVersion).toBe(1);
      expect(payload.caseKey).toBe(entry.case.key);
      expect(payload.seed).toBe(SEED);
    }
  });

  it('scores every completed case through the existing evaluation engine', async () => {
    for (const entry of result.runs) {
      const persisted = await loadRun(entry.runId, OWNER);
      if (!persisted) throw new Error(`Case ${entry.case.key} left no persisted run.`);
      expect(entry.evaluation).toEqual(evaluatePersistedRun(persisted));
      expect(entry.evaluation?.categories).toHaveLength(5);
      expect(entry.evaluation?.scenario).toEqual({
        id: entry.case.scenarioId,
        version: entry.case.scenarioVersion,
      });
    }
  });

  it('keeps every case’s terminal status visible in the aggregate', () => {
    const summary = result.summary;
    expect(summary.totalCases).toBe(7);
    expect(summary.scenarioCount).toBe(7);
    expect(summary.seedCount).toBe(1);
    expect(summary.completedCases).toBeGreaterThan(0);
    // The outcome partition accounts for every case that ran, and nothing is
    // claimed as a success that did not reach an intended termination.
    expect(summary.succeededCases + summary.unsuccessfulCases + summary.inProgressCases).toBe(
      summary.executedCases,
    );
    expect(summary.completedCases + summary.limitReachedCases).toBe(summary.succeededCases);
    expect(result.runs.filter((run) => run.outcome === 'succeeded').length).toBe(
      summary.succeededCases,
    );
  });

  it('keeps a provider failure visible without aborting the other cases', async () => {
    failScenario = 'resource-outage';
    const failed = await executeBenchmark({ ownerId: OWNER, benchmarkId: BENCHMARK_ID });

    expect(failed.runs).toHaveLength(7);
    const outage = failed.runs.find((run) => run.case.scenarioId === 'resource-outage');
    expect(outage?.status).toBe('ERROR');
    expect(outage?.outcome).toBe('unsuccessful');
    expect(failed.summary.errorCases).toBe(1);
    expect(failed.failures.providerFailures.count).toBe(1);
    expect(failed.failures.providerFailures.scenarioIds).toEqual(['resource-outage']);
    // The other six still produced real evidence, and were still counted.
    expect(failed.summary.evaluatedCases).toBe(7);
    expect(failed.summary.totalCases).toBe(7);

    // The failure is recorded in the run's own trace, not invented by the engine.
    const outageRun = outage ? await loadRun(outage.runId, OWNER) : null;
    expect(
      outageRun?.events.filter((event) => event.kind === 'agent.error').length,
    ).toBeGreaterThan(0);
  });

  it('produces a byte-identical aggregate on a second execution', async () => {
    const first = deterministicProjection(result);
    const second = await executeBenchmark({ ownerId: OWNER, benchmarkId: BENCHMARK_ID });
    expect(deterministicProjection(second)).toBe(first);
    // Different runs, same answer.
    expect(second.runs.map((run) => run.runId)).not.toEqual(result.runs.map((run) => run.runId));
  });
});

describe('9–10. aggregation and robustness arithmetic', () => {
  it('recomputes the robustness figures from the reported scenario table', async () => {
    const result = await executeBenchmark({ ownerId: OWNER, benchmarkId: BENCHMARK_ID });

    // Recomputed here from the report's own printed numbers, in exact integer
    // hundredths — an independent check of the documented formula, not a call
    // back into the code under verification.
    const toUnits = (value: number) => Math.round(value * 100);
    const halfAwayFromZero = (numerator: number, denominator: number) =>
      Math.floor((numerator * 2 + denominator) / (denominator * 2));
    const meanOf = (units: number[]) =>
      units.length === 0 ? null : Math.round(units.reduce((a, b) => a + b, 0) / units.length);

    const baselineRow = result.scenarios.find((row) => row.isBaseline);
    expect(baselineRow?.score).not.toBeNull();
    const baselineUnits = toUnits(baselineRow?.score ?? 0);
    const evaluated = result.scenarios.filter((row) => row.score !== null);
    const perturbed = result.scenarios.filter((row) => !row.isBaseline && row.score !== null);

    expect(result.robustness.formula).toBe('baseline-retention-v1');
    expect(result.robustness.baselineScenarioId).toBe('baseline');
    expect(result.robustness.baselineScore).toBe(baselineRow?.score);
    expect(result.robustness.unavailableReason).toBeNull();
    expect(result.robustness.evaluatedScenarioCount).toBe(evaluated.length);
    expect(result.robustness.perturbedScenarioCount).toBe(perturbed.length);

    const retentionUnits = perturbed.map((row) =>
      Math.min(halfAwayFromZero(toUnits(row.score ?? 0) * 100, baselineUnits), 100),
    );
    expect(toUnits(result.robustness.robustnessScore ?? 0)).toBe(meanOf(retentionUnits));
    expect(result.robustness.robustnessScore).toBeGreaterThanOrEqual(0);
    expect(result.robustness.robustnessScore).toBeLessThanOrEqual(1);

    const scoreUnits = evaluated.map((row) => toUnits(row.score ?? 0));
    expect(toUnits(result.robustness.averageScenarioScore ?? 0)).toBe(meanOf(scoreUnits));
    expect(toUnits(result.robustness.worstScenarioScore ?? 0)).toBe(Math.min(...scoreUnits));

    const degradationUnits = perturbed.map((row) => baselineUnits - toUnits(row.score ?? 0));
    expect(toUnits(result.robustness.averageDegradation ?? 0)).toBe(meanOf(degradationUnits));
    expect(toUnits(result.robustness.worstDegradation ?? 0)).toBe(Math.max(...degradationUnits));

    // Every reported degradation is the drop from the baseline, to the hundredth.
    for (const row of result.scenarios) {
      if (row.score === null) continue;
      expect(toUnits(row.absoluteDegradation ?? 0)).toBe(baselineUnits - toUnits(row.score));
      expect(row.baselineScore).toBe(baselineRow?.score);
    }

    // The named scenarios are the ones the numbers imply.
    const lowest = evaluated.reduce((min, row) =>
      (row.score ?? 0) < (min.score ?? 0) ? row : min,
    );
    expect(result.robustness.worstScenarioId).toBe(lowest.scenarioId);
  });
});

describe('11–12. the runs are ordinary runs', () => {
  it('replays a benchmark-created run from its scenario’s perturbed world', async () => {
    const result = await executeBenchmark({ ownerId: OWNER, benchmarkId: BENCHMARK_ID });
    const entry = result.runs.find((run) => run.case.scenarioId === 'resource-outage');
    if (!entry) throw new Error('No resource-outage case was produced.');

    const response = await getReplay(
      new Request(`http://localhost/api/simulations/runs/${entry.runId}/replay`),
      { params: Promise.resolve({ runId: entry.runId }) },
    );
    expect(response.status).toBe(200);
    const replay = SimulationReplay.parse(await response.json());
    const persisted = await loadRun(entry.runId, OWNER);
    const expectedInitial = initializeScenarioRun({
      environmentKey: 'resource-routing',
      objectiveKey: 'complete-delivery',
      seed: SEED,
      scenarioId: 'resource-outage',
    }).state;
    expect(replay.frames[0]?.state).toEqual(expectedInitial);
    expect(replay.frames.at(-1)?.state).toEqual(persisted?.state);
  });

  it('reruns a benchmark-created run at the scenario version it recorded', async () => {
    const result = await executeBenchmark({ ownerId: OWNER, benchmarkId: BENCHMARK_ID });
    const entry = result.runs.find((run) => run.case.scenarioId === 'elevated-risk');
    if (!entry) throw new Error('No elevated-risk case was produced.');
    const original = await loadRun(entry.runId, OWNER);

    const response = await rerunSimulation(
      new Request(`http://localhost/api/simulations/runs/${entry.runId}/rerun`, { method: 'POST' }),
      { params: Promise.resolve({ runId: entry.runId }) },
    );
    expect(response.status).toBe(201);
    const body = SimulationRerunResult.parse(await response.json());
    expect(body.run.scenario).toEqual({
      id: 'elevated-risk',
      version: entry.case.scenarioVersion,
    });
    expect(body.run.seed).toBe(SEED);
    expect(body.run.state).toEqual(original?.initialState);
    expect(body.determinism.environmentInitialStateMatches).toBe(true);
  });
});
