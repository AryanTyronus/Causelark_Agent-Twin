// @vitest-environment node
//
// The scenario engine is only useful if the rest of the system accepts a
// scenario-modified world without knowing it is one. These tests drive the real
// create-run route against an in-memory store, then hand the resulting world to
// the real tools, replay reconstruction and evaluation engine — the same
// pipeline an unperturbed run goes through.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RunRow {
  id: string;
  scenarioId?: string | null;
  scenarioVersion?: number | null;
  [key: string]: unknown;
}

const mocks = vi.hoisted(() => ({
  runs: [] as RunRow[],
  events: [] as Array<Record<string, unknown>>,
  actions: [] as Array<Record<string, unknown>>,
  toolCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({
  requireAuth: async () => ({ id: 'user-1', email: 'owner@example.test' }),
}));

vi.mock('@/lib/db', () => {
  let clock = 0;
  const nextDate = () => new Date(Date.UTC(2026, 0, 1) + clock++ * 1000);
  const bySequence = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    (a.sequence as number) - (b.sequence as number);
  const client = {
    simulationRun: {
      async create({ data }: { data: Record<string, unknown> }) {
        const row: RunRow = {
          id: `run-${mocks.runs.length + 1}`,
          ...data,
          budgetUsed: 0,
          turnInProgress: false,
          turnCount: 0,
          terminationReason: null,
          failureDetails: null,
          terminalAt: null,
          createdAt: nextDate(),
          updatedAt: nextDate(),
        };
        mocks.runs.push(row);
        return row;
      },
      async findFirst({ where }: { where: { id: string } }) {
        const run = mocks.runs.find((candidate) => candidate.id === where.id);
        if (!run) return null;
        return {
          ...run,
          actions: mocks.actions.filter((row) => row.runId === run.id),
          events: mocks.events.filter((row) => row.runId === run.id).sort(bySequence),
          toolCalls: mocks.toolCalls.filter((row) => row.runId === run.id),
        };
      },
    },
    simulationEvent: {
      async createMany({ data }: { data: Array<Record<string, unknown>> }) {
        for (const row of data)
          mocks.events.push({ ...row, id: `${row.runId}-e${row.sequence}`, createdAt: nextDate() });
        return { count: data.length };
      },
    },
    simulationAction: {
      async createMany({ data }: { data: Array<Record<string, unknown>> }) {
        for (const row of data) mocks.actions.push({ ...row, createdAt: nextDate() });
        return { count: data.length };
      },
    },
    simulationToolCall: {
      async createMany({ data }: { data: Array<Record<string, unknown>> }) {
        for (const row of data) mocks.toolCalls.push({ ...row, createdAt: nextDate() });
        return { count: data.length };
      },
    },
    async $transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      return work(client);
    },
  };
  return { prisma: client };
});

import type { Tool } from '@strands-agents/sdk';
import { GET as listScenarios } from '@/app/api/scenarios/route';
import { POST as createRun } from '@/app/api/simulations/runs/route';
import { createResourceTools } from '@/lib/agent/resource-tools';
import {
  createInitialSimulationState,
  DEFAULT_CONFIGURATION,
  evaluateSimulationAction,
  getSimulationStatus,
} from '@/lib/business/simulation';
import { toScenarioIdentity } from '@/lib/business/simulation-persistence';
import { buildSimulationReplay } from '@/lib/business/simulation-replay';
import {
  type SimulationActionInput,
  SimulationActionRecord,
  SimulationRunDetail,
  type SimulationScenarioIdentity,
  SimulationStartInput,
  SimulationState,
  type SimulationState as SimulationStateType,
} from '@/lib/contracts/simulation';
import { evaluateRun } from '@/lib/evaluation/evaluation';
import type { EvaluationInput } from '@/lib/evaluation/types';
import { getScenario, initializeScenarioRun } from '@/lib/scenarios/scenario';

const OBJECTIVE = 'complete-delivery';
const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

interface InvokableTool {
  invoke(input?: unknown, context?: unknown): Promise<unknown>;
}

function callTool(toolbox: { tools: Tool[] }, name: string, input?: unknown): Promise<unknown> {
  const tool = toolbox.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool ${name} is not in the allow-list.`);
  return (tool as unknown as InvokableTool).invoke(input);
}

async function startRun(body: Record<string, unknown>) {
  const response = await createRun(
    new Request('http://localhost/api/simulations/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The initial world of a scenario without going through HTTP. */
function world(scenarioId: string, seed = 9182): SimulationStateType {
  return initializeScenarioRun({
    environmentKey: 'resource-routing',
    objectiveKey: OBJECTIVE,
    seed,
    scenarioId,
  }).state;
}

/**
 * Plays the given actions against a real environment world and records them the
 * way the persistence layer would, so replay and evaluation see real evidence.
 */
function playThrough(
  initialState: SimulationStateType,
  steps: SimulationActionInput[],
): { actions: SimulationActionRecord[]; state: SimulationStateType } {
  let state = initialState;
  const actions: SimulationActionRecord[] = [];
  steps.forEach((input, index) => {
    const outcome = evaluateSimulationAction(state, input);
    actions.push(
      SimulationActionRecord.parse({
        id: `action-${index}`,
        step: state.step,
        type: input.type,
        input,
        source: 'agent',
        accepted: outcome.accepted,
        rejectionReason: outcome.rejectionReason,
        observation: outcome.observation,
        stateDiff: outcome.stateDiff ?? {},
        resultingState: outcome.state,
        createdAt: new Date(EPOCH + index * 1000).toISOString(),
      }),
    );
    state = outcome.state;
  });
  return { actions, state };
}

function evidence(
  initialState: SimulationStateType,
  steps: SimulationActionInput[],
  scenario: SimulationScenarioIdentity | null,
): EvaluationInput {
  const { actions, state } = playThrough(initialState, steps);
  return {
    runId: 'run-under-test',
    status: getSimulationStatus(state).status,
    state,
    initialState,
    actions,
    events: [],
    toolCalls: [],
    budgetLimit: initialState.budgetRemaining,
    turnCount: 1,
    maxTurns: 12,
    terminationReason: getSimulationStatus(state).terminationReason,
    scenario,
  };
}

beforeEach(() => {
  mocks.runs.length = 0;
  mocks.events.length = 0;
  mocks.actions.length = 0;
  mocks.toolCalls.length = 0;
});

describe('run creation under a scenario', () => {
  it('persists the scenario identity alongside the run it shaped', async () => {
    const { status, body } = await startRun({
      environmentKey: 'resource-routing',
      objectiveKey: OBJECTIVE,
      seed: 9182,
      scenarioId: 'resource-scarcity',
    });
    expect(status).toBe(201);
    const detail = SimulationRunDetail.parse(body);
    expect(detail.scenario).toEqual({ id: 'resource-scarcity', version: 1 });
    expect(mocks.runs[0]?.scenarioId).toBe('resource-scarcity');
    expect(mocks.runs[0]?.scenarioVersion).toBe(1);
    // The run starts in the perturbed world, not the world its seed alone implies.
    expect(detail.state).toEqual(world('resource-scarcity'));
    expect(detail.state).not.toEqual(
      createInitialSimulationState('resource-routing', OBJECTIVE, 9182, DEFAULT_CONFIGURATION),
    );
  });

  it('records the application in the trace, as a system event between start and observation', async () => {
    await startRun({
      environmentKey: 'resource-routing',
      objectiveKey: OBJECTIVE,
      seed: 9182,
      scenarioId: 'budget-pressure',
    });
    const events = mocks.events.filter((row) => row.runId === 'run-1');
    expect(events.map((row) => [row.sequence, row.kind])).toEqual([
      [0, 'simulation.started'],
      [1, 'scenario.applied'],
      [2, 'observation.created'],
    ]);
    const applied = events.find((row) => row.kind === 'scenario.applied');
    expect(applied?.source).toBe('system');
    expect(applied?.summary).toBe('Scenario applied: Budget Pressure v1.');
    const payload = applied?.payload as Record<string, unknown>;
    expect(payload.scenarioId).toBe('budget-pressure');
    expect(payload.scenarioVersion).toBe(1);
    // The pre-scenario values survive only here: the run stores the world it
    // started in, not the world it would have started in.
    const changes = payload.changes as Array<{ field: string; before: number; after: number }>;
    expect(changes.find((entry) => entry.field === 'budgetRemaining')?.before).toBe(24);
    expect(changes.find((entry) => entry.field === 'budgetRemaining')?.after).toBe(14);
    // Applying a scenario is not something the agent did.
    expect(mocks.actions).toHaveLength(0);
    expect(events.some((row) => row.kind === 'action.requested')).toBe(false);
  });

  it('leaves an unscenarioed run byte-for-byte as it was', async () => {
    const { status, body } = await startRun({
      environmentKey: 'resource-routing',
      objectiveKey: OBJECTIVE,
      seed: 9182,
    });
    expect(status).toBe(201);
    const detail = SimulationRunDetail.parse(body);
    expect(detail.scenario).toBeNull();
    expect(detail.state).toEqual(
      createInitialSimulationState('resource-routing', OBJECTIVE, 9182, DEFAULT_CONFIGURATION),
    );
    expect(mocks.events.filter((row) => row.runId === 'run-1').map((row) => row.kind)).toEqual([
      'simulation.started',
      'observation.created',
    ]);
    expect(mocks.runs[0]?.scenarioId).toBeNull();
    expect(mocks.runs[0]?.scenarioVersion).toBeNull();
  });

  it('records baseline as an explicit control condition without perturbing the world', async () => {
    const { body } = await startRun({
      environmentKey: 'resource-routing',
      objectiveKey: OBJECTIVE,
      seed: 9182,
      scenarioId: 'baseline',
    });
    const detail = SimulationRunDetail.parse(body);
    expect(detail.scenario).toEqual({ id: 'baseline', version: 1 });
    expect(detail.state).toEqual(
      createInitialSimulationState('resource-routing', OBJECTIVE, 9182, DEFAULT_CONFIGURATION),
    );
    const applied = mocks.events.find((row) => row.kind === 'scenario.applied');
    expect((applied?.payload as Record<string, unknown>).changes).toEqual([]);
  });

  it('rejects an unknown scenario id without creating a run', async () => {
    const { status, body } = await startRun({
      environmentKey: 'resource-routing',
      objectiveKey: OBJECTIVE,
      seed: 9182,
      scenarioId: 'no-such-scenario',
    });
    expect(status).toBe(400);
    expect((body.errors as Record<string, string>).scenarioId).toMatch(/Unknown scenario/);
    expect(mocks.runs).toHaveLength(0);
    expect(mocks.events).toHaveLength(0);
  });

  it('rejects a malformed scenario id at the contract boundary', async () => {
    for (const scenarioId of ['', 42, {}]) {
      const { status } = await startRun({
        environmentKey: 'resource-routing',
        objectiveKey: OBJECTIVE,
        seed: 9182,
        scenarioId,
      });
      expect(status, JSON.stringify(scenarioId)).toBe(400);
    }
    expect(mocks.runs).toHaveLength(0);
  });

  it('accepts a scenario id through the start contract without requiring one', () => {
    const base = { environmentKey: 'resource-routing', objectiveKey: OBJECTIVE, seed: 9182 };
    expect(SimulationStartInput.safeParse(base).success).toBe(true);
    expect(SimulationStartInput.safeParse({ ...base, scenarioId: 'elevated-risk' }).success).toBe(
      true,
    );
    expect(SimulationStartInput.safeParse({ ...base, scenarioId: '' }).success).toBe(false);
  });

  it('starts the run in the same world a second time, for the same seed and scenario', async () => {
    const first = await startRun({
      environmentKey: 'resource-routing',
      objectiveKey: OBJECTIVE,
      seed: 4242,
      scenarioId: 'resource-outage',
    });
    const second = await startRun({
      environmentKey: 'resource-routing',
      objectiveKey: OBJECTIVE,
      seed: 4242,
      scenarioId: 'resource-outage',
    });
    expect(SimulationRunDetail.parse(second.body).state).toEqual(
      SimulationRunDetail.parse(first.body).state,
    );
  });

  it('reports scenario identity for a run that has one and null for a run that does not', () => {
    expect(toScenarioIdentity({ scenarioId: 'resource-scarcity', scenarioVersion: 1 })).toEqual({
      id: 'resource-scarcity',
      version: 1,
    });
    expect(toScenarioIdentity({ scenarioId: null, scenarioVersion: null })).toBeNull();
    // Both columns are written together, so a half-written row reads as none.
    expect(
      toScenarioIdentity({ scenarioId: 'resource-scarcity', scenarioVersion: null }),
    ).toBeNull();
    expect(toScenarioIdentity({ scenarioId: null, scenarioVersion: 1 })).toBeNull();
  });
});

describe('scenario catalogue endpoint', () => {
  it('serves the catalogue the create endpoint resolves against', async () => {
    const response = await listScenarios(
      new Request('http://localhost/api/scenarios', { method: 'GET' }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { scenarios: Array<Record<string, unknown>> };
    expect(body.scenarios.map((entry) => entry.id)).toEqual([
      'baseline',
      'resource-scarcity',
      'budget-pressure',
      'elevated-risk',
      'resource-outage',
      'tight-step-limit',
      'action-rejection',
    ]);
    for (const entry of body.scenarios)
      expect(Object.keys(entry).sort()).toEqual(['description', 'id', 'name', 'version']);
    // Nothing about how a scenario is implemented leaks through the listing.
    expect(JSON.stringify(body)).not.toMatch(/modifier/);
  });
});

describe('the agent inside a scenario', () => {
  it('is told which actions the scenario revoked instead of discovering it by rejection', async () => {
    const state = world('action-rejection');
    const toolbox = createResourceTools(state, OBJECTIVE);
    const output = (await callTool(toolbox, 'observe_resources', {})) as Record<string, unknown>;
    expect(output.availableActions).toEqual(state.permissions);
    expect(output.availableActions).not.toContain('rest');
    expect(output.state).toEqual(state);
  });

  it('has its revoked action refused by the environment while the others still work', async () => {
    const state = world('action-rejection');
    const toolbox = createResourceTools(state, OBJECTIVE);
    const refused = (await callTool(toolbox, 'request_action', {
      type: 'rest',
      amount: 1,
    })) as Record<string, unknown>;
    expect(refused.accepted).toBe(false);
    expect(toolbox.getOutcomes().at(-1)?.validationReason).toBe(
      'The rest action is not permitted.',
    );
    const allowed = (await callTool(toolbox, 'request_action', {
      type: 'allocate',
      resource: 'materials',
      amount: 2,
    })) as Record<string, unknown>;
    expect(allowed.accepted).toBe(true);
  });

  it('cannot reach past a scenario through the tool surface', async () => {
    const state = world('resource-outage');
    const toolbox = createResourceTools(state, OBJECTIVE);
    const refused = (await callTool(toolbox, 'request_action', {
      type: 'allocate',
      resource: 'water',
      amount: 5,
    })) as Record<string, unknown>;
    expect(refused.accepted).toBe(false);
    // The validator that refused it is the environment's own, unchanged.
    expect(toolbox.getOutcomes().at(-1)?.validationReason).toBe('Not enough water to allocate 5.');
  });
});

describe('the existing evaluator on a scenario run', () => {
  const steps: SimulationActionInput[] = [
    { type: 'allocate', resource: 'materials', amount: 2 },
    { type: 'allocate', resource: 'water', amount: 2 },
    { type: 'harvest', resource: 'materials', amount: 1 },
  ];

  it('evaluates a scenario world with no change to the scoring semantics', () => {
    const initialState = world('resource-scarcity');
    const withScenario = evaluateRun(
      evidence(initialState, steps, { id: 'resource-scarcity', version: 1 }),
    );
    const withoutScenario = evaluateRun(evidence(initialState, steps, null));
    expect(withScenario.categories).toEqual(withoutScenario.categories);
    expect(withScenario.overallScore).toBe(withoutScenario.overallScore);
    expect(withScenario.metrics).toEqual(withoutScenario.metrics);
    // Only the attribution differs.
    expect(withScenario.scenario).toEqual({ id: 'resource-scarcity', version: 1 });
    expect(withoutScenario.scenario).toBeNull();
  });

  it('defaults the attribution to null for evidence that predates scenarios', () => {
    const legacy = evidence(world('baseline'), steps, null);
    const input = { ...legacy } as Partial<EvaluationInput>;
    delete input.scenario;
    expect(evaluateRun(input as EvaluationInput).scenario).toBeNull();
  });

  it('still produces a full verdict for a run that was squeezed by a scenario', () => {
    const result = evaluateRun(
      evidence(world('budget-pressure'), steps, { id: 'budget-pressure', version: 1 }),
    );
    expect(result.categories).toHaveLength(5);
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.overallScore).toBeLessThanOrEqual(100);
    expect(result.scenario?.id).toBe('budget-pressure');
  });
});

describe('the existing replay on a scenario run', () => {
  it('reconstructs from the perturbed world the run actually started in', () => {
    const initialState = world('resource-outage');
    const { actions, state } = playThrough(initialState, [
      { type: 'allocate', resource: 'water', amount: 1 },
      { type: 'harvest', resource: 'water', amount: 2 },
      { type: 'allocate', resource: 'water', amount: 2 },
    ]);
    const replay = buildSimulationReplay({ initialState, actions, events: [] });
    expect(replay.frames).toHaveLength(actions.length + 1);
    expect(replay.frames[0]?.state).toEqual(initialState);
    expect(replay.frames[0]?.state.resources.water).toBe(0);
    // The first attempt is refused by the outage; the harvest genuinely reopens it.
    expect(actions[0]?.accepted).toBe(false);
    expect(replay.frames[1]?.label).toBe('Rejected allocate');
    expect(actions[1]?.accepted).toBe(true);
    expect(replay.frames[2]?.state.resources.water).toBe(2);
    // Allocations consume stored resources, so the reopened water is spent again.
    expect(actions[2]?.accepted).toBe(true);
    expect(replay.frames.at(-1)?.state).toEqual(state);
    expect(replay.frames.at(-1)?.state.resources.water).toBe(0);
  });

  it('replays a scenario world to the same final state twice', () => {
    const initialState = world('tight-step-limit');
    const steps: SimulationActionInput[] = [
      { type: 'allocate', resource: 'materials', amount: 3 },
      { type: 'rest', amount: 2 },
    ];
    const first = playThrough(initialState, steps);
    const second = playThrough(initialState, steps);
    expect(buildSimulationReplay({ initialState, actions: second.actions, events: [] })).toEqual(
      buildSimulationReplay({ initialState, actions: first.actions, events: [] }),
    );
    expect(SimulationState.parse(first.state)).toEqual(second.state);
  });

  it('terminates at the scenario limit rather than the default one', () => {
    const state = world('tight-step-limit');
    expect(state.maxSteps).toBe(6);
    const atLimit = SimulationState.parse({ ...state, step: state.maxSteps });
    expect(getSimulationStatus(atLimit).status).toBe('LIMIT_REACHED');
  });
});

describe('scenario identity is reproducible from the run alone', () => {
  it('resolves a recorded version to the exact definition that produced the world', () => {
    const recorded: SimulationScenarioIdentity = { id: 'elevated-risk', version: 1 };
    const scenario = getScenario(recorded.id, recorded.version);
    const replayed = initializeScenarioRun({
      environmentKey: 'resource-routing',
      objectiveKey: OBJECTIVE,
      seed: 1042,
      scenarioId: recorded.id,
      scenarioVersion: recorded.version,
    });
    const expected = initializeScenarioRun({
      environmentKey: 'resource-routing',
      objectiveKey: OBJECTIVE,
      seed: 1042,
      scenarioId: scenario.id,
    });
    expect(replayed).toEqual(expected);
  });
});
