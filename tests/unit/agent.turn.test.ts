// @vitest-environment node
// @polsia:user-owned — one bounded Agent Twin turn end to end, without a database.
//
// The provider is replaced at its own boundary and Prisma by an in-memory store,
// so this exercises the real pipeline: allow-listed tools → deterministic
// validation → ordered persistence → replay reconstruction → metrics. No AWS
// credentials and no database are involved.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RunRow {
  id: string;
  ownerId: string;
  environmentKey: string;
  objectiveKey: string;
  seed: number;
  status: string;
  agentStatus: string;
  step: number;
  state: unknown;
  configuration: unknown;
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

interface ScriptedCall {
  tool: string;
  input?: unknown;
}

const mocks = vi.hoisted(() => ({
  script: [] as ScriptedCall[],
  invocations: [] as Array<{ timeoutMs: number; maxTurns?: number; maxActions?: number }>,
  providerError: undefined as unknown,
  store: {
    run: {} as RunRow,
    events: [] as EventRow[],
    actions: [] as ActionRow[],
    toolCalls: [] as ToolCallRow[],
  },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ env: {} }));

vi.mock('@/lib/db', () => {
  const { store } = mocks;
  let clock = 0;
  const nextDate = () => new Date(Date.UTC(2026, 0, 1) + clock++ * 1000);

  const applyRunUpdate = (data: Record<string, unknown>) => {
    const target = store.run as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && typeof value === 'object' && 'increment' in value) {
        const { increment } = value as { increment: number };
        target[key] = ((target[key] as number) ?? 0) + increment;
        continue;
      }
      target[key] = value;
    }
    store.run.updatedAt = nextDate();
  };

  const matchesRun = (where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([key, value]) => (store.run as unknown as Record<string, unknown>)[key] === value,
    );

  const byCreatedAt = (a: { createdAt: Date }, b: { createdAt: Date }) =>
    a.createdAt.getTime() - b.createdAt.getTime();

  const hydrateRun = (args: { select?: Record<string, boolean> } = {}) => {
    if (args.select) {
      const picked: Record<string, unknown> = {};
      for (const key of Object.keys(args.select))
        picked[key] = (store.run as unknown as Record<string, unknown>)[key];
      return picked;
    }
    return {
      ...store.run,
      actions: [...store.actions].sort((a, b) => a.step - b.step || byCreatedAt(a, b)),
      events: [...store.events].sort((a, b) => a.sequence - b.sequence || byCreatedAt(a, b)),
      toolCalls: [...store.toolCalls].sort(byCreatedAt),
    };
  };

  const client = {
    simulationRun: {
      async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        if (!matchesRun(args.where)) return { count: 0 };
        applyRunUpdate(args.data);
        return { count: 1 };
      },
      async update(args: { data: Record<string, unknown> }) {
        applyRunUpdate(args.data);
        return hydrateRun();
      },
      async findFirst(args: { select?: Record<string, boolean> } = {}) {
        return hydrateRun(args);
      },
    },
    simulationEvent: {
      async count() {
        return store.events.length;
      },
      async create(args: { data: Omit<EventRow, 'id' | 'createdAt'> }) {
        // Prisma generates the id for a createMany row that omits one.
        const row: EventRow = {
          ...args.data,
          id: `${args.data.runId}-event-${args.data.sequence}`,
          createdAt: nextDate(),
        };
        store.events.push(row);
        return row;
      },
      async createMany(args: { data: Array<Omit<EventRow, 'id' | 'createdAt'>> }) {
        for (const data of args.data)
          store.events.push({
            ...data,
            id: `${data.runId}-event-${data.sequence}`,
            createdAt: nextDate(),
          });
        return { count: args.data.length };
      },
    },
    simulationAction: {
      async createMany(args: { data: Array<Omit<ActionRow, 'createdAt'>> }) {
        for (const data of args.data) store.actions.push({ ...data, createdAt: nextDate() });
        return { count: args.data.length };
      },
    },
    simulationToolCall: {
      async createMany(args: { data: Array<Omit<ToolCallRow, 'createdAt'>> }) {
        for (const data of args.data) store.toolCalls.push({ ...data, createdAt: nextDate() });
        return { count: args.data.length };
      },
    },
    async $transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      return work(client);
    },
  };
  return { prisma: client };
});

vi.mock('@/lib/agent/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/provider')>();
  return {
    ...actual,
    invokeResourceAgent: async (input: {
      tools: Array<{ name: string }>;
      timeoutMs: number;
      maxTurns?: number;
      maxActions?: number;
    }) => {
      mocks.invocations.push({
        timeoutMs: input.timeoutMs,
        maxTurns: input.maxTurns,
        maxActions: input.maxActions,
      });
      if (mocks.providerError) throw mocks.providerError;
      for (const step of mocks.script) {
        const tool = input.tools.find((candidate) => candidate.name === step.tool);
        if (!tool) throw new Error(`Tool ${step.tool} is not available to the agent.`);
        await (tool as unknown as { invoke(i?: unknown): Promise<unknown> }).invoke(step.input);
      }
      return {
        metadata: {
          provider: 'Amazon Bedrock · Strands Agents SDK',
          requestStatus: 'completed',
          latencyMs: 42,
          inputTokens: 512,
          outputTokens: 64,
          safeError: null,
        },
        toolCallCount: mocks.script.length,
        acceptedToolCount: mocks.script.length,
        stopReason: 'endTurn',
      };
    },
  };
});

import {
  AGENT_PROVIDER_SAFE_MESSAGES,
  AgentProviderError,
  BEDROCK_STRANDS_PROVIDER,
} from '@/lib/agent/provider';
import { resolveAgentLoopTurns } from '@/lib/agent/resource-agent';
import { DEFAULT_MAX_ACTIONS_PER_TURN } from '@/lib/agent/resource-tools';
import { runTurn, TurnConflictError } from '@/lib/agent/run-turn';
import {
  createInitialSimulationState,
  DEFAULT_CONFIGURATION,
  evaluateSimulationAction,
} from '@/lib/business/simulation';
import { calculateSimulationMetrics } from '@/lib/business/simulation-metrics';
import { buildSimulationReplay } from '@/lib/business/simulation-replay';
import type { SimulationState as SimulationStateType } from '@/lib/contracts/simulation';

const RUN_ID = 'run-1';
const OWNER_ID = 'user-1';

function seededState(): SimulationStateType {
  return createInitialSimulationState('resource-routing', 'complete-delivery', 9182);
}

function seedRun(overrides: Partial<RunRow> = {}) {
  const run: RunRow = {
    id: RUN_ID,
    ownerId: OWNER_ID,
    environmentKey: 'resource-routing',
    objectiveKey: 'complete-delivery',
    seed: 9182,
    status: 'RUNNING',
    agentStatus: 'READY',
    step: 0,
    state: seededState(),
    configuration: { ...DEFAULT_CONFIGURATION },
    budgetLimit: DEFAULT_CONFIGURATION.budget,
    budgetUsed: 0,
    maxTurns: DEFAULT_CONFIGURATION.maxTurns,
    turnInProgress: false,
    turnCount: 0,
    terminationReason: null,
    failureDetails: null,
    terminalAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    updatedAt: new Date(Date.UTC(2026, 0, 1)),
    ...overrides,
  };
  mocks.store.run = run;
  mocks.store.events = [];
  mocks.store.actions = [];
  mocks.store.toolCalls = [];
  return run;
}

function setState(patch: Partial<SimulationStateType>): SimulationStateType {
  return { ...seededState(), ...patch };
}

function initialStateOf(run: RunRow): SimulationStateType {
  return run.state as SimulationStateType;
}

beforeEach(() => {
  mocks.script = [];
  mocks.invocations = [];
  mocks.providerError = undefined;
  seedRun();
});

describe('one bounded agent turn', () => {
  beforeEach(() => {
    mocks.script = [
      { tool: 'observe_resources', input: {} },
      { tool: 'request_action', input: { type: 'allocate', resource: 'materials', amount: 2 } },
      { tool: 'observe_resources', input: {} },
      { tool: 'request_action', input: { type: 'allocate', resource: 'water', amount: 1 } },
    ];
  });

  it('reports the observable turn summary', async () => {
    const state = seededState();

    const result = await runTurn(RUN_ID, OWNER_ID);

    expect(result.turn).toEqual({
      status: 'COMPLETED',
      provider: BEDROCK_STRANDS_PROVIDER,
      toolCalls: 4,
      acceptedActions: 2,
      safeError: null,
    });
    expect(result.run.step).toBe(2);
    expect(result.run.state.progress).toBe(state.progress + 3);
    expect(result.run.state.resources.materials).toBe(state.resources.materials - 2);
    expect(result.run.state.resources.water).toBe(state.resources.water - 1);
    expect(result.run.state.budgetRemaining).toBe(state.budgetRemaining - 3);
  });

  it('persists every tool call in invocation order with a latency each', async () => {
    const result = await runTurn(RUN_ID, OWNER_ID);

    expect(result.run.toolCalls.map((call) => call.toolName)).toEqual([
      'observe_resources',
      'request_action',
      'observe_resources',
      'request_action',
    ]);
    expect(result.run.toolCalls.map((call) => call.status)).toEqual([
      'SUCCEEDED',
      'SUCCEEDED',
      'SUCCEEDED',
      'SUCCEEDED',
    ]);
    for (const call of result.run.toolCalls) {
      expect(typeof call.latencyMs).toBe('number');
      expect(call.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('persists the agent actions with the state they produced', async () => {
    const result = await runTurn(RUN_ID, OWNER_ID);

    expect(result.run.actions).toHaveLength(2);
    expect(result.run.actions.map((action) => action.type)).toEqual(['allocate', 'allocate']);
    expect(result.run.actions.map((action) => action.step)).toEqual([0, 1]);
    expect(result.run.actions.map((action) => action.accepted)).toEqual([true, true]);
    expect(result.run.actions.map((action) => action.source)).toEqual(['agent', 'agent']);
    expect(result.run.actions[1]?.input).toEqual({
      type: 'allocate',
      resource: 'water',
      amount: 1,
    });
  });

  it('persists one ordered, gap-free event timeline per turn', async () => {
    const result = await runTurn(RUN_ID, OWNER_ID);
    const events = result.run.events;

    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
    expect(events[0]?.kind).toBe('agent.turn.started');
    expect(events[1]?.kind).toBe('observation.created');
    expect(events.at(-1)?.kind).toBe('agent.turn.completed');
    // Every state change is explained by a validated action immediately before it.
    expect(events.filter((event) => event.kind === 'state.changed')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'action.validated')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'action.rejected')).toHaveLength(0);
    for (const event of events) expect(event.step).toBeLessThanOrEqual(2);
  });

  it('records only safe metadata and never private reasoning', async () => {
    const result = await runTurn(RUN_ID, OWNER_ID);
    const completed = result.run.events.find((event) => event.kind === 'agent.turn.completed');

    expect(Object.keys(completed?.payload ?? {}).sort()).toEqual([
      'inputTokens',
      'latencyMs',
      'outputTokens',
      'provider',
      'stopReason',
      'toolCalls',
    ]);
    expect(JSON.stringify(result.run.events)).not.toMatch(
      /reasoning|chain.?of.?thought|thinking|scratchpad/i,
    );
  });

  it('owns the run again so the next turn can be claimed', async () => {
    await runTurn(RUN_ID, OWNER_ID);

    expect(mocks.store.run.turnInProgress).toBe(false);
    expect(mocks.store.run.turnCount).toBe(1);
    expect(mocks.store.run.status).toBe('RUNNING');
    expect(mocks.store.run.agentStatus).toBe('WAITING');
    expect(mocks.store.run.budgetUsed).toBe(3);
  });

  it('gives the provider a bounded turn taken from the run configuration', async () => {
    seedRun({
      configuration: { ...DEFAULT_CONFIGURATION, toolTimeoutMs: 12345 },
      state: seededState(),
    });

    await runTurn(RUN_ID, OWNER_ID);

    const expectedTurns = resolveAgentLoopTurns(DEFAULT_MAX_ACTIONS_PER_TURN);
    expect(mocks.invocations).toHaveLength(1);
    expect(mocks.invocations[0]?.timeoutMs).toBe(12345);
    expect(mocks.invocations[0]?.maxActions).toBe(DEFAULT_MAX_ACTIONS_PER_TURN);
    expect(mocks.invocations[0]?.maxTurns).toBe(expectedTurns);
  });
});

describe('replay and metrics rebuilt from persisted records', () => {
  beforeEach(() => {
    mocks.script = [
      { tool: 'request_action', input: { type: 'allocate', resource: 'materials', amount: 2 } },
      { tool: 'request_action', input: { type: 'allocate', resource: 'water', amount: 1 } },
    ];
  });

  it('reconstructs the multi-action trajectory from the persisted actions', async () => {
    const run = seedRun();
    const initialState = initialStateOf(run);

    const result = await runTurn(RUN_ID, OWNER_ID);
    const replay = buildSimulationReplay({
      initialState,
      actions: result.run.actions,
      events: result.run.events,
    });

    expect(replay.frames).toHaveLength(3);
    expect(replay.frames.map((frame) => frame.step)).toEqual([0, 1, 2]);
    expect(replay.frames.map((frame) => frame.label)).toEqual([
      'Initial observable state',
      'Validated allocate',
      'Validated allocate',
    ]);
    // The last replay frame is exactly the persisted run state.
    expect(replay.frames.at(-1)?.state).toEqual(result.run.state);
    expect(replay.selectedFrame).toBe(2);
  });

  it('reproduces the same trajectory from the seed and the action sequence alone', async () => {
    const initialState = seededState();

    const result = await runTurn(RUN_ID, OWNER_ID);
    let reproduced = initialState;
    for (const action of result.run.actions)
      reproduced = evaluateSimulationAction(reproduced, action.input).state;

    // Environment determinism: same seed + same validated actions ⇒ same state.
    // The agent's choice of actions is not deterministic and is not claimed to be.
    expect(reproduced).toEqual(result.run.state);
  });

  it('derives metrics from the persisted actions and state, not from the turn result', async () => {
    const initialState = seededState();

    const result = await runTurn(RUN_ID, OWNER_ID);
    const metrics = calculateSimulationMetrics({
      status: 'RUNNING',
      state: result.run.state,
      initialState,
      budgetLimit: mocks.store.run.budgetLimit,
      actions: result.run.actions,
      events: result.run.events,
      terminationReason: result.run.terminationReason,
    });

    expect(metrics.successfulActions).toBe(2);
    expect(metrics.rejectedActions).toBe(0);
    expect(metrics.successRate).toBe(1);
    expect(metrics.invalidActionRate).toBe(0);
    expect(metrics.steps).toBe(2);
    expect(metrics.budgetUsed).toBe(3);
    expect(metrics.resourcesUsed).toEqual({ energy: 0, materials: 2, water: 1 });
    expect(metrics.failures).toEqual([]);
    expect(metrics.taskSuccess).toBe(false);
  });
});

describe('rejected actions through a full turn', () => {
  it('leaves the persisted run state untouched and reports the rejection', async () => {
    const initial = setState({ resources: { energy: 6, materials: 1, water: 6 } });
    const run = seedRun({ state: initial });
    // Captured before the turn: the store mutates in place afterwards.
    const before = initialStateOf(run);
    mocks.script = [
      { tool: 'observe_resources', input: {} },
      { tool: 'request_action', input: { type: 'allocate', resource: 'materials', amount: 3 } },
    ];

    const result = await runTurn(RUN_ID, OWNER_ID);

    expect(result.turn.status).toBe('COMPLETED');
    expect(result.turn.acceptedActions).toBe(0);
    // The environment is exactly where it started.
    expect(result.run.state).toEqual(before);
    expect(result.run.step).toBe(0);
    expect(result.run.actions[0]?.accepted).toBe(false);
    expect(result.run.actions[0]?.rejectionReason).toBe('Not enough materials to allocate 3.');
    expect(result.run.toolCalls[1]?.status).toBe('REJECTED');
    expect(result.run.toolCalls[1]?.validationReason).toBe('Not enough materials to allocate 3.');
    expect(result.run.events.some((event) => event.kind === 'action.rejected')).toBe(true);
    expect(result.run.events.some((event) => event.kind === 'state.changed')).toBe(false);
    expect(mocks.store.run.budgetUsed).toBe(0);
  });
});

describe('turn failures', () => {
  it('records the failure at the step the run actually reached', async () => {
    const reached = setState({ step: 3 });
    seedRun({ state: reached, step: 3 });
    const throttled = new AgentProviderError('throttled', AGENT_PROVIDER_SAFE_MESSAGES.throttled);
    mocks.providerError = throttled;

    const result = await runTurn(RUN_ID, OWNER_ID);
    const failure = result.run.events.at(-1);

    expect(failure?.kind).toBe('agent.error');
    expect(failure?.step).toBe(3);
    expect(failure?.payload).toMatchObject({ code: 'throttled', recoverable: false });
    expect(result.turn.status).toBe('FAILED');
    expect(result.turn.provider).toBe(BEDROCK_STRANDS_PROVIDER);
    expect(result.run.status).toBe('ERROR');
    expect(result.run.agentStatus).toBe('FAILED');
    expect(result.run.failureDetails).toBe(AGENT_PROVIDER_SAFE_MESSAGES.throttled);
    expect(mocks.store.run.turnInProgress).toBe(false);
  });

  it('distinguishes a timeout from an error and leaks nothing from the SDK', async () => {
    const leaky = new AgentProviderError('timeout', 'Request timed out after 30000ms');

    mocks.providerError = leaky;

    const result = await runTurn(RUN_ID, OWNER_ID);
    const failure = result.run.events.at(-1);

    expect(result.run.status).toBe('TIMEOUT');
    expect(failure?.payload).toMatchObject({ code: 'timeout' });
    expect(result.turn.safeError).toBe('Request timed out after 30000ms');
    // Secrets and provider payloads never reach the client payload.
    expect(JSON.stringify(result.run)).not.toMatch(/AKIA|secret|credential/i);
  });

  it('refuses a turn when another turn already holds the run', async () => {
    seedRun({ turnInProgress: true, agentStatus: 'THINKING' });

    await expect(runTurn(RUN_ID, OWNER_ID)).rejects.toBeInstanceOf(TurnConflictError);
    expect(mocks.invocations).toHaveLength(0);
    expect(mocks.store.events).toHaveLength(0);
  });

  it('refuses a turn for a run that is no longer running', async () => {
    seedRun({ status: 'COMPLETED' });

    await expect(runTurn(RUN_ID, OWNER_ID)).rejects.toBeInstanceOf(TurnConflictError);
  });
});
