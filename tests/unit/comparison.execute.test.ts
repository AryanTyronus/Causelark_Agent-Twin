// @vitest-environment node
//
// This is the comparison pipeline end to end with no database and no provider:
// Prisma is an in-memory store and the model call is scripted, while everything
// that matters still runs for real — the scenario engine builds each case's
// world, the run row and its events are the ones `POST /api/simulations/runs`
// writes, `runTurn` drives every turn and validates every action, and the
// evaluation engine scores what was persisted.
//
// The provider is replaced *at its own boundary*, which is the point: the
// comparison resolves each agent to a selection and hands it to the same
// execution path, so what these tests observe is the real controlled-conditions
// claim rather than a mock of it. No credentials and no database are involved,
// and the suite is required to pass with neither.
//
// `Date.now()` appears once below, in the mocked database's clock, which is a
// counter rather than a clock. Nothing in the comparison engine reads a clock.

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
  /** `modelId|scenarioId` pairs whose model call should fail. */
  faults: new Map<string, { code: 'provider_error' | 'timeout'; message: string }>(),
  /** Model ids whose every case should fail. */
  failedAgents: new Set<string>(),
  /** Every model id the runtime was asked for, in invocation order. */
  invokedModels: [] as string[],
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

// The provider is replaced, never the agent runtime. The scripted call reads the
// *selection* the comparison resolved, which is how a test says "this model
// behaves this way" without any part of the comparison engine knowing a model
// name — the same seam a live provider would arrive through.
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
    }) => {
      const modelId = input.selection?.modelId ?? 'deployed';
      mocks.invokedModels.push(modelId);
      const scenarioId = mocks.stateBlobs.get(JSON.stringify(input.state));
      const fault =
        mocks.faults.get(`${modelId}|${scenarioId}`) ??
        (mocks.failedAgents.has(modelId)
          ? { code: 'provider_error' as const, message: 'The provider rejected the request.' }
          : undefined);
      if (fault) throw new actual.AgentProviderError(fault.code, fault.message);
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

import { getBenchmark } from '@/lib/benchmarks/catalog';
import { ROBUSTNESS_SCENARIO_IDS } from '@/lib/benchmarks/definitions';
import { DEFAULT_CONFIGURATION } from '@/lib/business/simulation';
import { agentConfigurationKey } from '@/lib/comparison/agents';
import { executeComparison } from '@/lib/comparison/execute';
import { ComparisonError } from '@/lib/comparison/types';
import { initializeScenarioRun } from '@/lib/scenarios/scenario';

const OWNER = 'user-1';
const EXPERIMENT_ID = 'resource-routing-agent-comparison';
const BENCHMARK_ID = 'resource-routing-robustness';
const SCENARIO_IDS = [...ROBUSTNESS_SCENARIO_IDS];
const SEED = 1042;

const AGENT_A = {
  agentId: 'agent-a',
  agentVersion: '1',
  provider: 'bedrock',
  model: 'model-a',
};
const AGENT_B = {
  agentId: 'agent-b',
  agentVersion: '1',
  provider: 'bedrock',
  model: 'model-b',
};
const AGENT_C = {
  agentId: 'agent-c',
  agentVersion: '1',
  provider: 'bedrock',
  model: 'model-c',
};

const KEY_A = agentConfigurationKey(AGENT_A);
const KEY_B = agentConfigurationKey(AGENT_B);
const KEY_C = agentConfigurationKey(AGENT_C);

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
  mocks.faults = new Map();
  mocks.failedAgents = new Set();
  mocks.invokedModels = [];
  mocks.runs = new Map();
  mocks.events = [];
  mocks.actions = [];
  mocks.toolCalls = [];
  mocks.runCounter = 0;
  mocks.clock = 0;
}

beforeEach(reset);

const createdRuns = () => [...mocks.runs.values()];

/** The agent a run was attributed to, from its own start event. */
function agentOf(run: RunRow): string {
  const started = mocks.events.find(
    (entry) => entry.runId === run.id && entry.kind === 'simulation.started',
  );
  return (started?.payload as { agentId?: string } | undefined)?.agentId ?? '';
}

function runsOf(agentId: string): RunRow[] {
  return createdRuns().filter((run) => agentOf(run) === agentId);
}

function runOf(agentId: string, scenarioId: string): RunRow | undefined {
  return runsOf(agentId).find((run) => run.scenarioId === scenarioId);
}

/** Run a comparison of agent-a against agent-b, with no faults scripted. */
function compareTwo(agents = [AGENT_A, AGENT_B]) {
  return executeComparison({ ownerId: OWNER, comparisonId: EXPERIMENT_ID, agents });
}

describe('one world per agent, per case', () => {
  it('runs the whole matrix once for every agent', async () => {
    const report = await compareTwo();
    expect(createdRuns()).toHaveLength(14);
    expect(runsOf('agent-a')).toHaveLength(7);
    expect(runsOf('agent-b')).toHaveLength(7);
    expect(report.execution.plannedCaseCount).toBe(14);
    expect(report.execution.executedCaseCount).toBe(14);
    expect(report.execution.comparedAgentCount).toBe(2);
    expect(report.execution.unavailableAgentCount).toBe(0);
  });

  it('gives every agent the same scenarios, at the same seed and version', async () => {
    await compareTwo();
    for (const agentId of ['agent-a', 'agent-b']) {
      expect(runsOf(agentId).map((run) => run.scenarioId)).toEqual(SCENARIO_IDS);
      for (const run of runsOf(agentId)) {
        expect(run.seed).toBe(SEED);
        expect(run.scenarioVersion).toBe(1);
      }
    }
  });

  it('gives every agent the same environment, objective, budget and turn budget for a case', async () => {
    await compareTwo();
    // Compared per *scenario*, because a scenario's own perturbation legitimately
    // changes the world it presents — budget-pressure lowers the budget. The
    // controlled-conditions claim is that the agents receive the same world as
    // each other, not that every scenario is identical to every other.
    for (const scenarioId of SCENARIO_IDS) {
      const left = runOf('agent-a', scenarioId);
      const right = runOf('agent-b', scenarioId);
      expect(right?.environmentKey).toBe(left?.environmentKey);
      expect(right?.objectiveKey).toBe(left?.objectiveKey);
      expect(right?.budgetLimit).toBe(left?.budgetLimit);
      expect(right?.maxTurns).toBe(left?.maxTurns);
      expect(JSON.stringify(right?.configuration)).toBe(JSON.stringify(left?.configuration));
      expect(JSON.stringify(right?.tasks)).toBe(JSON.stringify(left?.tasks));
      expect(JSON.stringify(right?.constraints)).toBe(JSON.stringify(left?.constraints));
    }
  });

  it('does vary the world between scenarios, so the perturbations are real', async () => {
    await compareTwo();
    const budgets = new Set(runsOf('agent-a').map((run) => run.budgetLimit));
    const risks = new Set(runsOf('agent-a').map((run) => JSON.stringify(run.state)));
    expect(budgets.size).toBeGreaterThan(1);
    expect(risks.size).toBeGreaterThan(1);
  });

  it('starts each agent in a world built from the same seed and scenario', async () => {
    await compareTwo();
    for (const scenarioId of SCENARIO_IDS) {
      const left = runOf('agent-a', scenarioId);
      const right = runOf('agent-b', scenarioId);
      // The empty script moves nothing, so each run's world is still its start.
      expect(right?.state).toEqual(left?.state);
      expect(right?.initialState).toEqual(left?.initialState);
    }
  });

  it('never lets two agents share a run, a world object or a run id', async () => {
    await compareTwo();
    const runs = createdRuns();
    expect(new Set(runs.map((run) => run.id)).size).toBe(runs.length);
    expect(new Set(runs.map((run) => run.state)).size).toBe(runs.length);
    expect(new Set(runs.map((run) => run.initialState)).size).toBe(runs.length);
  });

  it('attributes every run to the agent that produced it, in its own record', async () => {
    await compareTwo();
    for (const run of createdRuns()) {
      const started = mocks.events.find(
        (entry) => entry.runId === run.id && entry.kind === 'simulation.started',
      );
      expect(started?.payload).toMatchObject({
        benchmarkId: BENCHMARK_ID,
        benchmarkVersion: 1,
        caseKey: `${run.scenarioId}@1#${SEED}`,
        agentId: agentOf(run),
        agentVersion: '1',
      });
    }
    expect(new Set(createdRuns().map(agentOf))).toEqual(new Set(['agent-a', 'agent-b']));
  });

  it('gives the two agents the same benchmark case, not the same run', async () => {
    await compareTwo();
    const baselineA = runOf('agent-a', 'baseline');
    const baselineB = runOf('agent-b', 'baseline');
    expect(baselineA?.id).not.toBe(baselineB?.id);
    const caseKeyOf = (run: RunRow | undefined) =>
      (
        mocks.events.find((entry) => entry.runId === run?.id && entry.kind === 'simulation.started')
          ?.payload as { caseKey?: string } | undefined
      )?.caseKey;
    expect(caseKeyOf(baselineB)).toBe(caseKeyOf(baselineA));
  });

  it('drives every run through the same scenario seam the benchmark uses', async () => {
    await compareTwo();
    for (const run of createdRuns()) {
      const events = mocks.events
        .filter((entry) => entry.runId === run.id)
        .sort((a, b) => a.sequence - b.sequence);
      expect(events.slice(0, 3).map((entry) => entry.kind)).toEqual([
        'simulation.started',
        'scenario.applied',
        'observation.created',
      ]);
      expect(events.slice(3).map((entry) => entry.kind)).toContain('agent.turn.started');
    }
  });

  it('does not touch the benchmark definition it runs', async () => {
    const before = JSON.stringify(getBenchmark(BENCHMARK_ID));
    await compareTwo();
    expect(JSON.stringify(getBenchmark(BENCHMARK_ID))).toBe(before);
  });

  it('does not bypass the turn loop or the action validator', async () => {
    await compareTwo();
    // Every case ran its whole turn budget, exactly as the operator path would.
    for (const run of createdRuns()) {
      expect(run.turnCount).toBe(DEFAULT_CONFIGURATION.maxTurns);
      expect(run.status).toBe('LIMIT_REACHED');
    }
    expect(mocks.invokedModels).toHaveLength(14 * DEFAULT_CONFIGURATION.maxTurns);
    // One invocation named each agent's own model, and only ever the two the
    // request declared.
    expect(new Set(mocks.invokedModels)).toEqual(new Set(['model-a', 'model-b']));
  });
});

describe('agent configurations', () => {
  it('resolves each agent through the provider boundary rather than by name', async () => {
    await compareTwo();
    // The model the runtime was actually asked for came from the selection the
    // comparison resolved, never from a string in the comparison engine.
    const perAgent = new Map<string, Set<string>>();
    const seen = new Map<string, number>();
    for (let index = 0; index < mocks.invokedModels.length; index += 1) {
      const model = mocks.invokedModels[index] ?? '';
      const runIndex = Math.floor(index / DEFAULT_CONFIGURATION.maxTurns);
      // Runs are created agent by agent, in canonical order.
      const agentId = runIndex < 7 ? 'agent-a' : 'agent-b';
      seen.set(agentId, (seen.get(agentId) ?? 0) + 1);
      if (!perAgent.has(agentId)) perAgent.set(agentId, new Set());
      perAgent.get(agentId)?.add(model);
    }
    expect(perAgent.get('agent-a')).toEqual(new Set(['model-a']));
    expect(perAgent.get('agent-b')).toEqual(new Set(['model-b']));
    expect(seen.get('agent-a')).toBe(7 * DEFAULT_CONFIGURATION.maxTurns);
    expect(seen.get('agent-b')).toBe(7 * DEFAULT_CONFIGURATION.maxTurns);
  });

  it('refuses an experiment of one agent before creating any run', async () => {
    await expect(compareTwo([AGENT_A])).rejects.toThrowError(/needs at least 2 agents/);
    expect(createdRuns()).toHaveLength(0);
  });

  it('refuses an unknown experiment before creating any run', async () => {
    await expect(
      executeComparison({
        ownerId: OWNER,
        comparisonId: 'no-such-experiment',
        agents: [AGENT_A, AGENT_B],
      }),
    ).rejects.toThrowError(ComparisonError);
    expect(createdRuns()).toHaveLength(0);
  });

  it('refuses a seed the environment does not publish, without creating a run', async () => {
    await expect(
      executeComparison({
        ownerId: OWNER,
        comparisonId: EXPERIMENT_ID,
        agents: [AGENT_A, AGENT_B],
        seeds: [777],
      }),
    ).rejects.toThrowError(/does not publish/);
    expect(createdRuns()).toHaveLength(0);
  });

  it('refuses an oversized matrix before creating any run', async () => {
    await expect(
      compareTwo([
        AGENT_A,
        AGENT_B,
        AGENT_C,
        { agentId: 'agent-d', agentVersion: '1', provider: 'bedrock', model: 'model-d' },
        { agentId: 'agent-e', agentVersion: '1', provider: 'bedrock', model: 'model-e' },
      ]),
    ).rejects.toThrowError(/above the 28/);
    expect(createdRuns()).toHaveLength(0);
  });

  it('refuses the same agent twice before creating any run', async () => {
    await expect(compareTwo([AGENT_A, { ...AGENT_A }])).rejects.toThrowError(/appears twice/);
    expect(createdRuns()).toHaveLength(0);
  });
});

describe('failure isolation', () => {
  it('does not abort the experiment when one agent cannot run at all', async () => {
    mocks.failedAgents.add('model-b');
    const report = await compareTwo();

    // agent-b's cases all faulted, but the experiment still ran both agents and
    // still produced a report about both.
    expect(runsOf('agent-a')).toHaveLength(7);
    expect(runsOf('agent-b')).toHaveLength(7);
    expect(report.execution.comparedAgentCount).toBe(2);
    expect(report.execution.unavailableAgentCount).toBe(0);

    const a = report.agents.find((agent) => agent.key === KEY_A);
    const b = report.agents.find((agent) => agent.key === KEY_B);
    expect(a?.metrics.providerFailureCount).toBe(0);
    expect(b?.metrics.providerFailureCount).toBe(7);
    // The failure is reported as a failure — seven cases, seven faults — and the
    // agent is still scored on the partial verdicts the evaluation engine
    // recorded for them. That is the existing evaluation philosophy, reused
    // unchanged; the fault is not written into the score and not written out of
    // it either. What is refused is *inventing* a score where no verdict exists,
    // which is what the unavailable-agent case below covers.
    expect(b?.report?.summary.errorCases).toBe(7);
    const providerRow = report.failures.find((row) => row.category === 'providerFailures');
    expect(providerRow?.counts).toEqual([0, 7]);
    expect(providerRow?.agents).toEqual([KEY_B]);
    expect(b?.metrics.averageOverallScore).toBeLessThan(
      a?.metrics.averageOverallScore ?? Number.POSITIVE_INFINITY,
    );
  });

  it('keeps the two agents’ evidence separate when only one faults', async () => {
    mocks.faults.set('model-b|resource-outage', {
      code: 'timeout',
      message: 'The provider call exceeded the turn budget.',
    });
    const report = await compareTwo();
    const a = report.agents.find((agent) => agent.key === KEY_A);
    const b = report.agents.find((agent) => agent.key === KEY_B);
    expect(a?.report?.summary.timeoutCases).toBe(0);
    expect(a?.metrics.timeoutCount).toBe(0);
    expect(b?.report?.summary.timeoutCases).toBe(1);
    expect(b?.metrics.timeoutCount).toBe(1);
    // The other six cases of the faulting agent are untouched.
    expect(b?.report?.summary.limitReachedCases).toBe(6);
  });

  it('reports an agent this deployment cannot run as unavailable, and carries on', async () => {
    const report = await executeComparison({
      ownerId: OWNER,
      comparisonId: EXPERIMENT_ID,
      agents: [AGENT_A, AGENT_B, { ...AGENT_C, provider: 'not-a-provider' }],
    });

    // The two runnable agents ran a full matrix; the third produced no run at
    // all and did not stop the experiment.
    expect(runsOf('agent-a')).toHaveLength(7);
    expect(runsOf('agent-b')).toHaveLength(7);
    expect(createdRuns()).toHaveLength(14);
    expect(report.execution.unavailableAgentCount).toBe(1);
    expect(report.execution.comparedAgentCount).toBe(2);

    const unavailable = report.agents.find((agent) => agent.identity === 'agent-c@1');
    expect(unavailable?.status).toBe('UNAVAILABLE');
    expect(unavailable?.unavailableReason?.code).toBe('INVALID_AGENT_CONFIGURATION');
    expect(unavailable?.report).toBeNull();
    // Its metrics are absent, and its missing cases are counted, not scored.
    expect(unavailable?.metrics.evaluatedCaseCount).toBe(0);
    expect(unavailable?.metrics.averageOverallScore).toBeNull();
    // A comparison is still produced between the agents that could run: the two
    // whose behaviour was identical tie, and the agent that never ran is not
    // dragged into the verdict as a contender.
    expect(report.verdict.outcome).toBe('TIE');
    expect(report.verdict.winner).toBeNull();
    for (const level of report.verdict.levels) expect(level.contenders).not.toContain(KEY_C);
    expect(report.verdict.reason).not.toMatch(/agent-c/);
  });

  it('says the evidence is insufficient when no agent in the fleet can run', async () => {
    const report = await executeComparison({
      ownerId: OWNER,
      comparisonId: EXPERIMENT_ID,
      agents: [
        { ...AGENT_A, provider: 'not-a-provider' },
        { ...AGENT_B, provider: 'also-not-a-provider' },
      ],
    });
    expect(createdRuns()).toHaveLength(0);
    expect(report.execution.unavailableAgentCount).toBe(2);
    expect(report.verdict.outcome).toBe('INSUFFICIENT_EVIDENCE');
    expect(report.verdict.winner).toBeNull();
  });

  it('never turns a failure into a fabricated score', async () => {
    mocks.failedAgents.add('model-b');
    const report = await compareTwo();
    const b = report.agents.find((agent) => agent.key === KEY_B);
    // Every case faulted, so every case still carries a partial verdict — the
    // evaluation engine scored what the run reached. The comparison reuses those
    // verdicts and adds the failure counts beside them; it neither invents a
    // score nor discards one.
    expect(b?.metrics.evaluatedCaseCount).toBe(7);
    expect(b?.metrics.averageOverallScore).not.toBeNull();
    expect(b?.metrics.providerFailureCount).toBe(7);
    expect(b?.metrics.taskSuccessRate).toBe(0);
    // What it never does is score an agent that produced no verdict at all.
    const noEvidence = await executeComparison({
      ownerId: OWNER,
      comparisonId: EXPERIMENT_ID,
      agents: [AGENT_A, { ...AGENT_B, provider: 'not-a-provider' }],
    });
    const unavailable = noEvidence.agents.find((agent) => agent.identity === 'agent-b@1');
    expect(unavailable?.metrics.evaluatedCaseCount).toBe(0);
    expect(unavailable?.metrics.averageOverallScore).toBeNull();
    // And the lone survivor is not handed a win: one agent with evidence is not
    // a comparison, however badly the agent beside it failed.
    expect(noEvidence.verdict.outcome).toBe('INSUFFICIENT_EVIDENCE');
    expect(noEvidence.verdict.winner).toBeNull();
  });
});

describe('the comparison returns a function of the agents, not of the request order', () => {
  it('produces the same report whichever order the agents were named in', async () => {
    const forward = await compareTwo([AGENT_A, AGENT_B]);
    reset();
    const backward = await compareTwo([AGENT_B, AGENT_A]);
    expect(backward.experiment.key).toBe(forward.experiment.key);
    expect(backward.agents.map((agent) => agent.key)).toEqual(
      forward.agents.map((agent) => agent.key),
    );
    expect(backward.metrics).toEqual(forward.metrics);
    expect(backward.scenarios).toEqual(forward.scenarios);
    expect(backward.robustness).toEqual(forward.robustness);
    expect(backward.failures).toEqual(forward.failures);
    expect(backward.headToHead).toEqual(forward.headToHead);
    expect(backward.verdict).toEqual(forward.verdict);
  });

  it('records the experiment it ran, so the run can be reconstructed', async () => {
    const report = await compareTwo();
    expect(report.experiment.id).toBe(EXPERIMENT_ID);
    expect(report.experiment.benchmarkId).toBe(BENCHMARK_ID);
    expect(report.experiment.benchmarkVersion).toBe(1);
    expect(report.experiment.seeds).toEqual([SEED]);
    expect(report.experiment.declaredSeeds).toEqual([SEED]);
    expect(report.experiment.caseCountPerAgent).toBe(7);
    expect(report.experiment.agentCount).toBe(2);
    expect(report.experiment.totalCaseCount).toBe(14);
    expect(report.methodology.robustnessFormula).toBe('baseline-retention-v1');
    expect(report.experiment.scenarios.map((row) => row.id)).toEqual(SCENARIO_IDS);
  });

  it('does not require credentials to run', async () => {
    // The provider is replaced at its own boundary, so nothing here reads a
    // credential. The evidence is that every case reached the terminal status
    // the runtime derives itself: a missing credential would have surfaced as an
    // ERROR on each one. This test deliberately asserts nothing about the
    // environment's own variables — reading one into an assertion would put a
    // live secret into the test output if it ever failed.
    const report = await compareTwo();
    expect(report.agents.every((agent) => agent.report?.summary.errorCases === 0)).toBe(true);
    expect(report.agents.every((agent) => agent.report?.summary.timeoutCases === 0)).toBe(true);
  });

  it('runs the whole comparison twice with identical evidence', async () => {
    const first = await compareTwo();
    reset();
    const second = await compareTwo();
    // Run ids are generated and therefore differ; everything the comparison
    // *measures* is identical, because it is a function of the definitions and
    // the evaluations.
    expect(second.metrics).toEqual(first.metrics);
    expect(second.scenarios).toEqual(first.scenarios);
    expect(second.robustness).toEqual(first.robustness);
    expect(second.failures).toEqual(first.failures);
    expect(second.verdict).toEqual(first.verdict);
    expect(second.experiment.key).toBe(first.experiment.key);
  });

  it('lets a caller drill from the report to a run and its counterfactual', async () => {
    const report = await compareTwo();
    const agent = report.agents.find((candidate) => candidate.key === KEY_A);
    const run = agent?.report?.runs.find((entry) => entry.case.scenarioId === 'resource-outage');
    expect(run).toBeDefined();
    // The run id the report carries is the id the simulation routes serve, so a
    // counterfactual analysis can be opened on it without this layer knowing how.
    expect(createdRuns().map((row) => row.id)).toContain(run?.runId);
  });
});
