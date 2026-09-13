// @vitest-environment node
// @polsia:user-owned — allow-listed Agent Twin tools and deterministic validation.
//
// These exercise the real Strands tool objects through their public `invoke`
// entry point. No model is involved: the point is that the tool surface alone
// can move the environment, and only through the deterministic validator.

import type { Tool } from '@strands-agents/sdk';
import { describe, expect, it } from 'vitest';
import { createResourceTools, DEFAULT_MAX_ACTIONS_PER_TURN } from '@/lib/agent/resource-tools';
import { createInitialSimulationState, getSimulationStatus } from '@/lib/business/simulation';
import {
  SimulationState,
  type SimulationState as SimulationStateType,
} from '@/lib/contracts/simulation';

const OBJECTIVE = 'Route enough material into the delivery objective before limits.';

/** Minimal structural view of the SDK's `InvokableTool` we rely on in tests. */
interface InvokableTool {
  invoke(input?: unknown, context?: unknown): Promise<unknown>;
}

function initial(): SimulationStateType {
  return createInitialSimulationState('resource-routing', 'complete-delivery', 9182);
}

function toolboxWith(state: SimulationStateType = initial(), maxActions?: number) {
  return createResourceTools(state, OBJECTIVE, maxActions === undefined ? {} : { maxActions });
}

function call(toolbox: { tools: Tool[] }, name: string, input?: unknown): Promise<unknown> {
  const tool = toolbox.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool ${name} is not in the allow-list.`);
  return (tool as unknown as InvokableTool).invoke(input);
}

/** Snapshot so a later comparison cannot pass by reference identity. */
function snapshot(state: SimulationStateType): SimulationStateType {
  return JSON.parse(JSON.stringify(state)) as SimulationStateType;
}

function withResources(
  state: SimulationStateType,
  patch: Partial<SimulationStateType['resources']>,
): SimulationStateType {
  return SimulationState.parse({ ...state, resources: { ...state.resources, ...patch } });
}

describe('allow-listed tool surface', () => {
  it('exposes exactly the two documented tools and nothing that bypasses validation', () => {
    const toolbox = toolboxWith();
    const names = toolbox.tools.map((tool) => tool.name);

    expect(names).toEqual(['observe_resources', 'request_action']);
  });

  it('describes both tools so the model can discover the action contract', () => {
    const toolbox = toolboxWith();
    for (const tool of toolbox.tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.toolSpec).toBeTruthy();
    }
  });
});

describe('observe_resources', () => {
  it('returns observable facts only', async () => {
    const state = initial();
    const output = (await call(toolboxWith(state), 'observe_resources', {})) as Record<
      string,
      unknown
    >;

    expect(Object.keys(output).sort()).toEqual([
      'actionsRemaining',
      'availableActions',
      'constraints',
      'objective',
      'state',
      'stepsRemaining',
      'terminal',
    ]);
    expect(output.objective).toBe(OBJECTIVE);
    expect(output.state).toEqual(state);
    expect(output.availableActions).toEqual(['harvest', 'allocate', 'rest']);
    expect(output.terminal).toBe(false);
    expect(output.stepsRemaining).toBe(state.maxSteps - state.step);
    // No chain-of-thought, plan, or reasoning channel is exposed to the caller.
    expect(JSON.stringify(output)).not.toMatch(/reason|thought|thinking|plan/i);
  });

  it('never advances the environment', async () => {
    const state = initial();
    const toolbox = toolboxWith(state);

    await call(toolbox, 'observe_resources', {});

    expect(toolbox.getState()).toEqual(state);
    expect(toolbox.getState().step).toBe(0);
    expect(toolbox.getState().budgetRemaining).toBe(state.budgetRemaining);
  });

  it('reports the remaining action allowance', async () => {
    const toolbox = toolboxWith(initial(), 2);

    const before = (await call(toolbox, 'observe_resources', {})) as { actionsRemaining: number };
    await call(toolbox, 'request_action', { type: 'rest', amount: 1 });
    const after = (await call(toolbox, 'observe_resources', {})) as { actionsRemaining: number };

    expect(before.actionsRemaining).toBe(2);
    expect(after.actionsRemaining).toBe(1);
  });
});

describe('request_action', () => {
  it('moves the local state only through the deterministic validator', async () => {
    const state = initial();
    const toolbox = toolboxWith(state);

    const output = (await call(toolbox, 'request_action', {
      type: 'allocate',
      resource: 'materials',
      amount: 2,
    })) as Record<string, unknown>;

    expect(output.accepted).toBe(true);
    const next = toolbox.getState();
    expect(next.step).toBe(state.step + 1);
    expect(next.resources.materials).toBe(state.resources.materials - 2);
    expect(next.progress).toBe(state.progress + 2);
    expect(next.budgetRemaining).toBe(state.budgetRemaining - 2);
    expect(next.budgetSpent).toBe(state.budgetSpent + 2);
    expect(next.lastAction).toBe('allocate');
    // The diff is reported, so no hidden state is needed to explain the change.
    expect(output.stateDiff).toMatchObject({ step: { before: 0, after: 1 } });
  });

  it('leaves state completely untouched when the validator rejects the action', async () => {
    const state = withResources(initial(), { materials: 1 });
    const toolbox = toolboxWith(state);
    const before = snapshot(state);

    const output = (await call(toolbox, 'request_action', {
      type: 'allocate',
      resource: 'materials',
      amount: 2,
    })) as Record<string, unknown>;

    expect(output.accepted).toBe(false);
    expect(output.stateDiff).toEqual({});
    expect(toolbox.getState()).toEqual(before);
    expect(toolbox.getState().step).toBe(state.step);
  });

  it('rejects every action once the environment has terminated', async () => {
    const state = initial();
    const terminal = SimulationState.parse({ ...state, progress: state.target });
    expect(getSimulationStatus(terminal).status).toBe('COMPLETED');
    const toolbox = toolboxWith(terminal);
    const before = snapshot(terminal);

    const output = (await call(toolbox, 'request_action', {
      type: 'rest',
      amount: 1,
    })) as Record<string, unknown>;

    expect(output.accepted).toBe(false);
    expect(output.terminal).toBe(true);
    expect(toolbox.getState()).toEqual(before);
  });

  it('runs several observe → act → observe cycles inside one bounded turn', async () => {
    const state = initial();
    const toolbox = toolboxWith(state);

    await call(toolbox, 'observe_resources', {});
    await call(toolbox, 'request_action', { type: 'allocate', resource: 'materials', amount: 2 });
    const mid = (await call(toolbox, 'observe_resources', {})) as { state: SimulationStateType };
    await call(toolbox, 'request_action', { type: 'allocate', resource: 'water', amount: 1 });

    // The second observation already reflects the first action.
    expect(mid.state.progress).toBe(state.progress + 2);
    expect(mid.state.resources.materials).toBe(state.resources.materials - 2);
    expect(toolbox.getState().step).toBe(state.step + 2);
    expect(toolbox.getState().progress).toBe(state.progress + 3);
    expect(toolbox.getState().resources.water).toBe(state.resources.water - 1);
  });

  it('records the validator rejection reason on the outcome', async () => {
    const toolbox = toolboxWith(withResources(initial(), { materials: 1 }));

    await call(toolbox, 'request_action', { type: 'allocate', resource: 'materials', amount: 3 });

    const [outcome] = toolbox.getOutcomes();
    expect(outcome?.status).toBe('REJECTED');
    expect(outcome?.validationReason).toBe('Not enough materials to allocate 3.');
  });
});

describe('per-turn action allowance', () => {
  it('refuses actions past the allowance without touching state', async () => {
    const state = initial();
    const toolbox = toolboxWith(state, 2);
    await call(toolbox, 'request_action', { type: 'allocate', resource: 'materials', amount: 1 });
    await call(toolbox, 'request_action', { type: 'allocate', resource: 'materials', amount: 1 });
    const afterAllowance = snapshot(toolbox.getState());

    const refused = (await call(toolbox, 'request_action', {
      type: 'allocate',
      resource: 'materials',
      amount: 2,
    })) as Record<string, unknown>;

    expect(refused.accepted).toBe(false);
    expect(refused.actionsRemaining).toBe(0);
    expect(toolbox.getState()).toEqual(afterAllowance);
    expect(toolbox.getState().step).toBe(state.step + 2);
  });

  it('still persists the refused attempt so the turn record is complete', async () => {
    const toolbox = toolboxWith(initial(), 2);

    await call(toolbox, 'request_action', { type: 'allocate', resource: 'materials', amount: 1 });
    await call(toolbox, 'request_action', { type: 'allocate', resource: 'materials', amount: 1 });
    await call(toolbox, 'request_action', { type: 'allocate', resource: 'materials', amount: 1 });

    const outcomes = toolbox.getOutcomes();
    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'SUCCEEDED',
      'SUCCEEDED',
      'REJECTED',
    ]);
    expect(outcomes[2]?.validationReason).toBe('The per-turn action allowance is spent.');
    expect(outcomes[2]?.stateBefore).toEqual(outcomes[2]?.stateAfter);
  });

  it('defaults to a small, explicit allowance and never allows zero actions', async () => {
    expect(DEFAULT_MAX_ACTIONS_PER_TURN).toBeGreaterThan(0);
    const toolbox = toolboxWith(initial(), 0);

    const output = (await call(toolbox, 'request_action', {
      type: 'allocate',
      resource: 'materials',
      amount: 1,
    })) as { accepted: boolean };

    expect(output.accepted).toBe(true);
  });

  it('allows exactly the default allowance before refusing', async () => {
    const toolbox = toolboxWith(initial());
    const allocate = { type: 'allocate', resource: 'materials', amount: 1 } as const;

    for (let index = 0; index < DEFAULT_MAX_ACTIONS_PER_TURN; index += 1)
      await call(toolbox, 'request_action', allocate);
    const refused = (await call(toolbox, 'request_action', allocate)) as { accepted: boolean };

    expect(refused.accepted).toBe(false);
    expect(toolbox.getOutcomes()).toHaveLength(DEFAULT_MAX_ACTIONS_PER_TURN + 1);
  });
});

describe('turn outcome ledger', () => {
  it('records outcomes in invocation order with a wall-clock latency each', async () => {
    const toolbox = toolboxWith(initial());

    await call(toolbox, 'observe_resources', {});
    await call(toolbox, 'request_action', { type: 'rest', amount: 1 });
    await call(toolbox, 'observe_resources', {});

    const outcomes = toolbox.getOutcomes();
    expect(outcomes.map((outcome) => outcome.toolName)).toEqual([
      'observe_resources',
      'request_action',
      'observe_resources',
    ]);
    for (const outcome of outcomes) {
      expect(typeof outcome.latencyMs).toBe('number');
      expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('hands out a defensive copy so a reader cannot corrupt the turn record', async () => {
    const toolbox = toolboxWith(initial());
    await call(toolbox, 'observe_resources', {});

    toolbox.getOutcomes().pop();

    expect(toolbox.getOutcomes()).toHaveLength(1);
  });
});
