// @polsia:user-owned — deterministic Agent Twin domain coverage.
// Provider calls are intentionally not made in unit tests; Amazon Bedrock and
// the AWS credential provider chain are an external boundary, exercised by the
// request-driven route against real credentials.

import { describe, expect, it } from 'vitest';
import { createInitialSimulationState, evaluateSimulationAction } from '@/lib/business/simulation';
import { calculateSimulationMetrics } from '@/lib/business/simulation-metrics';
import {
  buildSimulationReplay,
  jumpToImportantFrame,
  selectReplayFrame,
} from '@/lib/business/simulation-replay';
import {
  SimulationActionRecord,
  SimulationEvent,
  SimulationState,
} from '@/lib/contracts/simulation';

describe('Agent Twin persisted domain records', () => {
  it('keeps invalid actions immutable and records task progress on valid transitions', () => {
    const initial = createInitialSimulationState('resource-routing', 'complete-delivery', 9182);
    const invalid = evaluateSimulationAction(initial, {
      type: 'allocate',
      resource: 'materials',
      amount: 5,
    });
    expect(invalid.accepted).toBe(false);
    expect(invalid.state).toEqual(initial);
    expect(invalid.validationCode).toBe('INSUFFICIENT_RESOURCE');

    const valid = evaluateSimulationAction(initial, {
      type: 'allocate',
      resource: 'materials',
      amount: 1,
    });
    expect(valid.accepted).toBe(true);
    expect(valid.state.step).toBe(1);
    expect(valid.state.tasks.find((task) => task.id === 'delivery-stock')?.progress).toBe(1);
    expect(valid.state.budgetSpent).toBe(1);
  });

  it('calculates metrics and replay frames from records instead of frontend state', () => {
    const initial = createInitialSimulationState('resource-routing', 'complete-delivery', 9182);
    const transition = evaluateSimulationAction(initial, {
      type: 'allocate',
      resource: 'materials',
      amount: 1,
    });
    const action = SimulationActionRecord.parse({
      id: 'action-1',
      step: 0,
      type: 'allocate',
      input: { type: 'allocate', resource: 'materials', amount: 1 },
      source: 'agent',
      accepted: transition.accepted,
      rejectionReason: transition.rejectionReason,
      observation: transition.observation,
      stateDiff: transition.stateDiff,
      resultingState: transition.state,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const event = SimulationEvent.parse({
      id: 'event-1',
      sequence: 0,
      step: 0,
      kind: 'action.validated',
      source: 'system',
      summary: 'Action validated and applied.',
      payload: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const metrics = calculateSimulationMetrics({
      status: 'RUNNING',
      state: transition.state,
      initialState: SimulationState.parse(initial),
      budgetLimit: 24,
      actions: [action],
      events: [event],
      terminationReason: null,
    });
    expect(metrics.successfulActions).toBe(1);
    expect(metrics.rejectedActions).toBe(0);
    expect(metrics.budgetUsed).toBe(1);

    const replay = buildSimulationReplay({
      initialState: initial,
      actions: [action],
      events: [event],
    });
    expect(replay.frames).toHaveLength(2);
    expect(selectReplayFrame(replay, 1)?.state.progress).toBe(1);
    expect(jumpToImportantFrame(replay, 1, 0)).toBe(0);
  });
});
