// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createInitialSimulationState,
  evaluateSimulationAction,
  getSimulationStatus,
} from '@/lib/business/simulation';
import { SimulationState } from '@/lib/contracts/simulation';

describe('deterministic simulation business logic', () => {
  const input = {
    environmentKey: 'resource-routing' as const,
    objectiveKey: 'complete-delivery' as const,
    seed: 9182,
  };

  it('creates identical initial states for identical inputs', () => {
    expect(
      createInitialSimulationState(input.environmentKey, input.objectiveKey, input.seed),
    ).toEqual(createInitialSimulationState(input.environmentKey, input.objectiveKey, input.seed));
  });

  it('keeps rejected actions from mutating state', () => {
    const state = createInitialSimulationState(
      input.environmentKey,
      input.objectiveKey,
      input.seed,
    );
    const constrained = SimulationState.parse({
      ...state,
      resources: { energy: 0, materials: state.resources.materials, water: state.resources.water },
    });
    const result = evaluateSimulationAction(constrained, {
      type: 'harvest',
      resource: 'materials',
      amount: 1,
    });
    expect(result.accepted).toBe(false);
    expect(result.state).toEqual(constrained);
    expect(result.rejectionReason).toContain('energy');
  });

  it('advances the step for accepted actions and stays deterministic', () => {
    const first = createInitialSimulationState(
      input.environmentKey,
      input.objectiveKey,
      input.seed,
    );
    const second = createInitialSimulationState(
      input.environmentKey,
      input.objectiveKey,
      input.seed,
    );
    const firstTransition = evaluateSimulationAction(first, { type: 'rest', amount: 2 });
    const secondTransition = evaluateSimulationAction(second, { type: 'rest', amount: 2 });
    expect(firstTransition.accepted).toBe(true);
    expect(firstTransition.state.step).toBe(1);
    expect(firstTransition).toEqual(secondTransition);
  });

  it('derives the same terminal status from the same completed transition', () => {
    const state = SimulationState.parse({
      ...createInitialSimulationState(input.environmentKey, input.objectiveKey, input.seed),
      target: 1,
      resources: { energy: 3, materials: 1, water: 3 },
    });
    const result = evaluateSimulationAction(state, {
      type: 'allocate',
      resource: 'materials',
      amount: 1,
    });
    expect(getSimulationStatus(result.state)).toEqual({
      status: 'COMPLETED',
      terminationReason: 'Objective reached.',
    });
  });
});
