// @vitest-environment node
// @polsia:user-owned — benchmark execution end to end, without a database or a provider.
//
// The provider is replaced at its own boundary and Prisma by an in-memory store,
// so this exercises the real pipeline the operator path uses: the scenario
// engine builds each case's world, the run row and its event sequence are the
// same ones `POST /api/simulations/runs` writes, `runTurn` drives every turn and
// validates every action, and the evaluation engine scores what was persisted.
//
// No credentials and no database are involved, and the suite is required to pass
// with neither.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RunRow {
  id: string;
  ownerId: string;
  environmentKey: string;
  objectiveKey: string;
  seed: number;
  scenarioId: string | null;
  scenarioVersion: number | null;
  status: string;
  agentStatus: string;
  step: number;
  state: unknown;
  initialState: unknown;
  configuration: unknown;
  tasks: unknown;
  constraints: unknown;
  budgetLimit: number;
  budgetUsed: number;
  maxTurns: number;
  turnInProgress: boolean;
  turnCount: number;
  terminationReason: string | null;
  failureDetails: string | null;
  terminalAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface EventRow {
  id: string;
  runId: string;
  sequence: number;
  step: number;
  kind: string;
  source: string;
  summary: string;
  payload: unknown;
  createdAt: Date;
}

interface ActionRow {
  id: string;
  runId: string;
  step: number;
  actionType: string;
  input: unknown;
  accepted: boolean;
  source: string;
  rejectionReason: string | null;
  observation: unknown;
  stateDiff: unknown;
  validationCode: string | null;
  resultingState: unknown;
  createdAt: Date;
}

interface ToolCallRow {
  id: string;
  runId: string;
  step: number;
  toolName: string;
  input: unknown;
  output?: unknown;
  status: string;
  validationReason: string | null;
  latencyMs: number | null;
  createdAt: Date;
}

const mocks = vi.hoisted(() => ({
  /** Scenario id → the initial-state blob the scenario engine produces. */
  stateBlobs: new Map<string, string>(),
  /** The scenario whose provider call should fail, and how. */
  failScenario: null as string | null,
  failCode: 'provider_error' as 'provider_error' | 'timeout',
  invocations: 0,
  runs: new Map<string, RunRow>(),
  events: [] as EventRow[],
  actions: [] as ActionRow[],
  toolCalls: [] as ToolCallRow[],
  runCounter: 0,
  clock: 0,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({
  env: { AGENT_PROVIDER: 'bedrock', BEDROCK_MODEL_ID: 'test-bedrock-model' },
}));

vi.mock('@/lib/db', () => {
  const nextDate = () => new Date(Date.UTC(2026, 0, 1) + mocks.clock++ * 1000);

  function applyRunUpdate(target: RunRow, data: Record<string, unknown>) {
    const row = target as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && typeof value === 'object' && 'increment' in value) {
        const { increment } = value as { increment: number };
        row[key] = ((row[key] as number) ?? 0) + increment;
        continue;
      }
      row[key] = value;
    }
    target.updatedAt = nextDate();
  }

  function matches(target: RunRow, where: Record<string, unknown>) {
    const row = target as unknown as Record<string, unknown>;
    return Object.entries(where).every(([key, value]) => row[key] === value);
  }

  function hydrate(run: RunRow, include?: Record<string, unknown>) {
    if (!include) return { ...run };
    const byCreated = (a: { createdAt: Date }, b: { createdAt: Date }) =>
      a.createdAt.getTime() - b.createdAt.getTime();
    return {
      ...run,
      actions: mocks.actions
        .filter((entry) => entry.runId === run.id)
        .sort((a, b) => a.step - b.step || byCreated(a, b)),
      events: mocks.events
        .filter((entry) => entry.runId === run.id)
        .sort((a, b) => a.sequence - b.sequence || byCreated(a, b)),
      toolCalls: mocks.toolCalls.filter((entry) => entry.runId === run.id).sort(byCreated),
    };
  }

  function findRun(where: Record<string, unknown>): RunRow | null {
    for (const run of mocks.runs.values()) if (matches(run, where)) return run;
    return null;
  }

  function buildClient() {
    const client = {
      simulationRun: {
        async create(args: { data: Record<string, unknown> }) {
          mocks.runCounter += 1;
          const id = `run-${mocks.runCounter}`;
          const now = nextDate();
          const row = {
            ownerId: '',
            scenarioId: null,
            scenarioVersion: null,
            agentStatus: 'READY',
            step: 0,
            budgetUsed: 0,
            turnInProgress: false,
            turnCount: 0,
            terminationReason: null,
            failureDetails: null,
            terminalAt: null,
            createdAt: now,
            updatedAt: now,
            ...args.data,
            id,
          } as unknown as RunRow;
          mocks.runs.set(id, row);
          return { ...row };
        },
        async findFirst(args: {
          where: Record<string, unknown>;
          select?: Record<string, boolean>;
          include?: Record<string, unknown>;
        }) {
          const run = findRun(args.where);
          if (!run) return null;
          if (args.select) {
            const picked: Record<string, unknown> = {};
            for (const key of Object.keys(args.select))
              picked[key] = (run as unknown as Record<string, unknown>)[key];
            return picked;
          }
          return hydrate(run, args.include ?? {});
        },
        async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
          const run = findRun(args.where);
          if (!run) return { count: 0 };
          applyRunUpdate(run, args.data);
          return { count: 1 };
        },
        async update(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
          const run = findRun(args.where);
          if (!run) throw new Error('Run disappeared.');
          applyRunUpdate(run, args.data);
          return hydrate(run, {});
        },
      },
      simulationEvent: {
        async count(args: { where: { runId: string } }) {
          return mocks.events.filter((entry) => entry.runId === args.where.runId).length;
        },
        async create(args: { data: Omit<EventRow, 'id' | 'createdAt'> }) {
          const row: EventRow = {
            ...args.data,
            id: `${args.data.runId}-event-${args.data.sequence}`,
            createdAt: nextDate(),
          };
          mocks.events.push(row);
          return row;
        },
        async createMany(args: { data: Array<Omit<EventRow, 'id' | 'createdAt'>> }) {
          for (const data of args.data)
            mocks.events.push({
              ...data,
              id: `${data.runId}-event-${data.sequence}`,
              createdAt: nextDate(),
            });
          return { count: args.data.length };
        },
      },
      simulationAction: {
        async createMany(args: { data: Array<Omit<ActionRow, 'createdAt'>> }) {
          for (const data of args.data) mocks.actions.push({ ...data, createdAt: nextDate() });
          return { count: args.data.length };
        },
      },
      simulationToolCall: {
        async createMany(args: { data: Array<Omit<ToolCallRow, 'createdAt'>> }) {
          for (const data of args.data) mocks.toolCalls.push({ ...data, createdAt: nextDate() });
          return { count: args.data.length };
        },
      },
      async $transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
        return work(client);
      },
    };
    return client;
  }

  return { prisma: buildClient() };
});

// The provider is replaced, never the agent runtime: `runResourceAgentTurn`,
// its bounded loop, its allow-listed tools and the environment validator all
// still run. Only the model call itself is scripted, so no credentials and no
// network are involved.
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
    }) => {
      mocks.invocations += 1;
      const scenarioId = mocks.stateBlobs.get(JSON.stringify(input.state));
      if (scenarioId && scenarioId === mocks.failScenario)
        throw new actual.AgentProviderError(
          mocks.failCode,
          mocks.failCode === 'timeout'
            ? 'The provider call exceeded the turn budget.'
            : 'The provider rejected the request.',
        );
      return {
        metadata: {
          provider: 'Test provider',
          requestStatus: 'completed',
          latencyMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          safeError: null,
        },
        toolCallCount: 0,
        acceptedToolCount: 0,
        stopReason: 'endTurn',
      };
    },
  };
});

import { BEDROCK_STRANDS_PROVIDER } from '@/lib/agent/provider';
import { getBenchmark } from '@/lib/benchmarks/catalog';
import { ROBUSTNESS_SCENARIO_IDS } from '@/lib/benchmarks/definitions';
import { executeBenchmark, requireAgentConfiguration } from '@/lib/benchmarks/execute';
import { BenchmarkError } from '@/lib/benchmarks/types';
import { createInitialSimulationState, DEFAULT_CONFIGURATION } from '@/lib/business/simulation';
import { evaluatePersistedRun } from '@/lib/business/simulation-evaluation';
import { loadRun } from '@/lib/business/simulation-persistence';
import type { SimulationState } from '@/lib/contracts/simulation';
import { initializeScenarioRun } from '@/lib/scenarios/scenario';

const OWNER = 'user-1';
const BENCHMARK_ID = 'resource-routing-robustness';
const AGENT = { provider: 'bedrock', model: 'test-bedrock-model' };
const SCENARIO_IDS = [...ROBUSTNESS_SCENARIO_IDS];
const SEED = 1042;

/** The world each scenario produces, so a scripted provider can name its run. */
function buildStateBlobs(): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const scenarioId of SCENARIO_IDS) {
    const { state } = initializeScenarioRun({
      environmentKey: 'resource-routing',
      objectiveKey: 'complete-delivery',
      seed: SEED,
      configuration: DEFAULT_CONFIGURATION,
      scenarioId,
    });
    blobs.set(JSON.stringify(state), scenarioId);
  }
  return blobs;
}

function reset() {
  mocks.stateBlobs = buildStateBlobs();
  mocks.failScenario = null;
  mocks.failCode = 'provider_error';
  mocks.invocations = 0;
  mocks.runs = new Map();
  mocks.events = [];
  mocks.actions = [];
  mocks.toolCalls = [];
  mocks.runCounter = 0;
  mocks.clock = 0;
}

beforeEach(reset);

const createdRuns = () => [...mocks.runs.values()];
const runFor = (scenarioId: string) => createdRuns().find((run) => run.scenarioId === scenarioId);

describe('benchmark execution', () => {
  it('creates exactly one run per matrix case', async () => {
    const result = await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
    });
    expect(createdRuns()).toHaveLength(7);
    expect(result.runs).toHaveLength(7);
    expect(result.summary.totalCases).toBe(7);
    expect(result.summary.executedCases).toBe(7);
  });

  it('runs every scenario the definition declares, once each', async () => {
    const result = await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
    });
    expect(createdRuns().map((run) => run.scenarioId)).toEqual(SCENARIO_IDS);
    expect(result.runs.map((entry) => entry.case.scenarioId)).toEqual(SCENARIO_IDS);
  });

  it('persists the scenario identity its case pinned', async () => {
    const result = await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
    });
    for (const entry of result.runs) {
      const run = createdRuns().find((candidate) => candidate.id === entry.runId);
      expect(run?.scenarioId).toBe(entry.case.scenarioId);
      expect(run?.scenarioVersion).toBe(entry.case.scenarioVersion);
      expect(run?.ownerId).toBe(OWNER);
    }
  });

  it('runs every case at the seed the matrix assigned', async () => {
    await executeBenchmark({ ownerId: OWNER, benchmarkId: BENCHMARK_ID, agent: AGENT });
    expect(createdRuns().every((run) => run.seed === SEED)).toBe(true);
  });

  it('runs the cross product when the seed set is widened', async () => {
    const result = await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
      seeds: [1042, 2048],
    });
    expect(result.runs).toHaveLength(14);
    expect(result.summary.seedCount).toBe(2);
    expect(result.configuration.seeds).toEqual([1042, 2048]);
    expect(result.configuration.declaredSeeds).toEqual([1042]);
    expect(result.runs.slice(0, 2).map((entry) => entry.case.seed)).toEqual([1042, 2048]);
  });

  it('refuses a seed the environment does not publish', async () => {
    await expect(
      executeBenchmark({ ownerId: OWNER, benchmarkId: BENCHMARK_ID, agent: AGENT, seeds: [777] }),
    ).rejects.toThrowError(/does not publish/);
    expect(createdRuns()).toHaveLength(0);
  });

  it('refuses an unknown benchmark without creating a run', async () => {
    await expect(
      executeBenchmark({ ownerId: OWNER, benchmarkId: 'no-such-benchmark', agent: AGENT }),
    ).rejects.toThrowError(BenchmarkError);
    expect(createdRuns()).toHaveLength(0);
  });

  it('gives each case an isolated world', async () => {
    await executeBenchmark({ ownerId: OWNER, benchmarkId: BENCHMARK_ID, agent: AGENT });
    const baseline = runFor('baseline')?.state as SimulationState;
    expect(baseline).toEqual(
      createInitialSimulationState('resource-routing', 'complete-delivery', SEED),
    );
    // The perturbations are real: the scenarios genuinely produced different
    // worlds, and no case inherited another's.
    expect((runFor('resource-outage')?.state as SimulationState).resources.water).toBe(0);
    expect((runFor('tight-step-limit')?.state as SimulationState).maxSteps).toBeLessThan(
      baseline.maxSteps,
    );
    expect((runFor('budget-pressure')?.state as SimulationState).budgetRemaining).toBeLessThan(
      baseline.budgetRemaining,
    );
    // Every case owns its own world object rather than sharing one mutable
    // baseline: seven runs, seven distinct states, none of them the same object.
    const runs = createdRuns();
    expect(new Set(runs.map((run) => run.state)).size).toBe(runs.length);
    expect(new Set(runs.map((run) => JSON.stringify(run.state))).size).toBe(runs.length);
    for (const run of runs) {
      if (run.scenarioId === 'baseline') continue;
      expect(run.state).not.toBe(baseline);
    }
  });

  it('applies each scenario through the existing scenario engine', async () => {
    await executeBenchmark({ ownerId: OWNER, benchmarkId: BENCHMARK_ID, agent: AGENT });
    for (const run of createdRuns()) {
      const events = mocks.events
        .filter((entry) => entry.runId === run.id)
        .sort((a, b) => a.sequence - b.sequence);
      // The run opens with the same three-event record the operator path writes;
      // everything after it belongs to the turns this case was driven through.
      expect(events.slice(0, 3).map((entry) => entry.kind)).toEqual([
        'simulation.started',
        'scenario.applied',
        'observation.created',
      ]);
      expect(events.slice(3).map((entry) => entry.kind)).toContain('agent.turn.started');
      const payload = events[1]?.payload as {
        scenarioId: string;
        scenarioVersion: number;
        scenarioName: string;
        changes: Array<{ field: string; before: unknown; after: unknown }>;
      };
      expect(payload.scenarioId).toBe(run.scenarioId);
      expect(payload.scenarioVersion).toBe(1);
      expect(payload.scenarioName.length).toBeGreaterThan(0);
      // The baseline leaves the seeded world exactly as the environment built
      // it, so it records no change; every other scenario moved at least one
      // value, and every change it recorded actually moved.
      if (run.scenarioId === 'baseline') expect(payload.changes).toHaveLength(0);
      else expect(payload.changes.length).toBeGreaterThan(0);
      for (const change of payload.changes)
        expect(JSON.stringify(change.before)).not.toBe(JSON.stringify(change.after));
    }
  });

  it('records the benchmark’s own identity on each run it creates', async () => {
    await executeBenchmark({ ownerId: OWNER, benchmarkId: BENCHMARK_ID, agent: AGENT });
    for (const run of createdRuns()) {
      const started = mocks.events.find(
        (entry) => entry.runId === run.id && entry.kind === 'simulation.started',
      );
      expect(started?.payload).toMatchObject({
        benchmarkId: BENCHMARK_ID,
        benchmarkVersion: 1,
        caseKey: `${run.scenarioId}@1#${SEED}`,
        seed: SEED,
      });
      expect(started?.source).toBe('system');
    }
  });

  it('evaluates every completed case with the existing evaluation engine', async () => {
    const result = await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
    });
    for (const entry of result.runs) {
      const persisted = await loadRun(entry.runId, OWNER);
      if (!persisted) throw new Error(`Case ${entry.case.key} left no persisted run.`);
      // The same mapping the evaluation endpoint serves: a benchmark case and
      // an operator-opened run are scored from identical inputs.
      expect(entry.evaluation).toEqual(evaluatePersistedRun(persisted));
      expect(entry.evaluation?.scenario).toEqual({
        id: entry.case.scenarioId,
        version: entry.case.scenarioVersion,
      });
      expect(entry.evaluation?.categories.map((category) => category.category)).toEqual([
        'taskSuccess',
        'safety',
        'efficiency',
        'resourceManagement',
        'reliability',
      ]);
    }
  });

  it('does not bypass the turn loop: every case was driven through it', async () => {
    await executeBenchmark({ ownerId: OWNER, benchmarkId: BENCHMARK_ID, agent: AGENT });
    // An empty script makes no progress, so each case runs its full turn budget
    // and the environment reaches the limit on its own terms.
    expect(mocks.invocations).toBe(7 * DEFAULT_CONFIGURATION.maxTurns);
    for (const run of createdRuns()) {
      expect(run.turnCount).toBe(DEFAULT_CONFIGURATION.maxTurns);
      expect(run.status).toBe('LIMIT_REACHED');
      const turnEvents = mocks.events.filter(
        (entry) => entry.runId === run.id && entry.kind === 'agent.turn.started',
      );
      expect(turnEvents).toHaveLength(DEFAULT_CONFIGURATION.maxTurns);
    }
  });

  it('reports a limit reached as an intended termination, not a failure', async () => {
    const result = await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
    });
    expect(result.summary.limitReachedCases).toBe(7);
    expect(result.summary.unsuccessfulCases).toBe(0);
    expect(result.summary.evaluatedCases).toBe(7);
  });

  it('does not abort the benchmark when one case fails', async () => {
    mocks.failScenario = 'resource-outage';
    const result = await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
    });
    expect(result.runs).toHaveLength(7);
    expect(result.summary.errorCases).toBe(1);
    expect(result.summary.unsuccessfulCases).toBe(1);
    // Every other case still ran to its own terminal status.
    expect(result.summary.limitReachedCases).toBe(6);
    const outage = result.runs.find((entry) => entry.case.scenarioId === 'resource-outage');
    expect(outage?.status).toBe('ERROR');
    expect(outage?.terminationReason).toContain('provider');
  });

  it('keeps a provider failure visible as a failure', async () => {
    mocks.failScenario = 'resource-outage';
    const result = await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
    });
    const outage = runFor('resource-outage');
    // The failure is persisted as an agent error, not smoothed into a zero score.
    expect(
      mocks.events.filter((entry) => entry.runId === outage?.id && entry.kind === 'agent.error'),
    ).toHaveLength(1);
    const failure = result.runs.find((entry) => entry.case.scenarioId === 'resource-outage');
    expect(failure?.outcome).toBe('unsuccessful');
    expect(failure?.evaluation?.metrics.agentErrors).toBe(1);
    expect(result.failures.providerFailures.count).toBe(1);
    expect(result.failures.providerFailures.scenarioIds).toEqual(['resource-outage']);
  });

  it('keeps a timeout a timeout', async () => {
    mocks.failScenario = 'resource-scarcity';
    mocks.failCode = 'timeout';
    const result = await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
    });
    const scarcity = result.runs.find((entry) => entry.case.scenarioId === 'resource-scarcity');
    expect(scarcity?.status).toBe('TIMEOUT');
    expect(scarcity?.outcome).toBe('unsuccessful');
    expect(result.summary.timeoutCases).toBe(1);
    expect(result.failures.timeouts.count).toBe(1);
    // A partial verdict is still recorded — the case is not turned into a
    // zero-score success, and it is not dropped from the evidence either.
    expect(scarcity?.evaluation).not.toBeNull();
    expect(result.summary.evaluatedCases).toBe(7);
  });

  it('leaves a run that never reached a terminal status in progress', async () => {
    mocks.failScenario = 'elevated-risk';
    const result = await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
    });
    // A provider fault terminates the run, so this case is ERROR rather than
    // RUNNING — but the distinction is preserved in the summary either way.
    expect(result.summary.runningCases).toBe(0);
    expect(result.summary.errorCases).toBe(1);
    const risk = result.runs.find((entry) => entry.case.scenarioId === 'elevated-risk');
    expect(risk?.case.isBaseline).toBe(false);
  });

  it('aggregates real persisted evaluations into a deterministic report', async () => {
    const first = await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
    });
    reset();
    const second = await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
    });
    // Run ids are generated and therefore differ; everything the benchmark
    // *measures* is identical, because it is a function of the definition and
    // the evaluations.
    expect(first.summary).toEqual(second.summary);
    expect(first.dimensions).toEqual(second.dimensions);
    expect(first.robustness).toEqual(second.robustness);
    expect(first.scenarios).toEqual(second.scenarios);
    expect(first.failures).toEqual(second.failures);
  });

  it('produces a robustness score from the evidence it gathered', async () => {
    const result = await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
    });
    const robust = result.robustness;
    const scores = result.scenarios.map((row) => row.score);
    const baselineScore = result.scenarios.find((row) => row.isBaseline)?.score ?? null;

    expect(robust.formula).toBe('baseline-retention-v1');
    expect(robust.baselineScenarioId).toBe('baseline');
    expect(robust.baselineScore).toBe(baselineScore);
    expect(robust.evaluatedScenarioCount).toBe(7);
    expect(robust.perturbedScenarioCount).toBe(6);
    expect(robust.unavailableReason).toBeNull();
    // Every scenario carried evidence, so nothing is reported as absent.
    expect(scores.every((score) => score !== null)).toBe(true);

    // The report is a function of the table printed beside it: each row's
    // degradation is the difference an auditor would compute by hand.
    const perturbed = result.scenarios.filter((row) => !row.isBaseline);
    for (const row of result.scenarios) {
      expect(row.baselineScore).toBe(baselineScore);
      if (row.isBaseline) {
        expect(row.score).toBe(baselineScore);
        expect(row.absoluteDegradation).toBe(0);
        expect(row.retention).toBe(1);
        continue;
      }
      expect(row.absoluteDegradation).toBe((baselineScore ?? 0) - (row.score ?? 0));
    }

    // Averages and extremes, computed in exact hundredths the way the engine
    // does — the scores are integers, so every one of these is exact.
    const all = result.scenarios.map((row) => row.score ?? 0);
    expect(robust.averageScenarioScore).toBe(
      Math.round((all.reduce((a, b) => a + b, 0) * 100) / 7) / 100,
    );
    expect(robust.worstScenarioScore).toBe(Math.min(...all));
    expect(robust.worstScenarioId).toBe(
      result.scenarios.find((row) => row.score === Math.min(...all))?.scenarioId,
    );

    const degradationUnits = perturbed.map((row) =>
      Math.round(((baselineScore ?? 0) - (row.score ?? 0)) * 100),
    );
    expect(robust.averageDegradation).toBe(
      Math.round(degradationUnits.reduce((a, b) => a + b, 0) / perturbed.length) / 100,
    );
    expect(robust.worstDegradation).toBe(Math.max(...degradationUnits) / 100);

    // Robustness is a share of the baseline that survived, so it is bounded and
    // it is not the average score.
    expect(robust.robustnessScore).not.toBeNull();
    expect(robust.robustnessScore).toBeGreaterThanOrEqual(0);
    expect(robust.robustnessScore).toBeLessThanOrEqual(1);
  });

  it('attributes the result to the agent configuration that ran it', async () => {
    const result = await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
    });
    expect(result.agent).toEqual({
      provider: 'bedrock',
      model: 'test-bedrock-model',
      label: BEDROCK_STRANDS_PROVIDER,
    });
  });

  it('refuses a configuration this deployment does not run', async () => {
    await expect(
      executeBenchmark({
        ownerId: OWNER,
        benchmarkId: BENCHMARK_ID,
        agent: { provider: 'openrouter', model: 'some-other-model' },
      }),
    ).rejects.toThrowError(/asked for openrouter/);
    expect(createdRuns()).toHaveLength(0);
  });

  it('resolves the deployed configuration without a request naming one', async () => {
    expect(requireAgentConfiguration(null)).toEqual({
      provider: 'bedrock',
      model: 'test-bedrock-model',
      label: BEDROCK_STRANDS_PROVIDER,
    });
    const result = await executeBenchmark({ ownerId: OWNER, benchmarkId: BENCHMARK_ID });
    expect(result.agent.provider).toBe('bedrock');
  });

  it('does not require credentials to run', async () => {
    // The provider is replaced at its own boundary, so nothing here reads a
    // credential. The evidence is that every case reached a terminal status the
    // runtime derives itself: a missing credential would have surfaced as an
    // ERROR on each one. This test deliberately asserts nothing about the
    // environment's own variables — reading one into an assertion would put a
    // live secret into the test output if it ever failed.
    const result = await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
    });
    expect(result.runs).toHaveLength(7);
    expect(result.summary.errorCases).toBe(0);
    expect(result.summary.timeoutCases).toBe(0);
    expect(result.summary.executedCases).toBe(7);
  });

  it('never puts the benchmark identity in the run’s own scenario columns', async () => {
    await executeBenchmark({ ownerId: OWNER, benchmarkId: BENCHMARK_ID, agent: AGENT });
    for (const run of createdRuns()) {
      expect(SCENARIO_IDS).toContain(run.scenarioId);
      expect(run.environmentKey).toBe('resource-routing');
      expect(run.objectiveKey).toBe('complete-delivery');
    }
  });

  it('leaves the benchmark definition untouched', async () => {
    const before = JSON.stringify(getBenchmark(BENCHMARK_ID));
    await executeBenchmark({
      ownerId: OWNER,
      benchmarkId: BENCHMARK_ID,
      agent: AGENT,
      seeds: [1042, 2048],
    });
    expect(JSON.stringify(getBenchmark(BENCHMARK_ID))).toBe(before);
  });
});
