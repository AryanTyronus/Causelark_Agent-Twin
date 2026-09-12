// @polsia:user-owned — server-side metrics derived only from persisted records.

import {
  type SimulationActionRecord,
  type SimulationEvent,
  SimulationMetrics,
  type SimulationResources,
  type SimulationRunStatus,
  type SimulationState,
} from '@/lib/contracts/simulation';

export function calculateSimulationMetrics(input: {
  status: SimulationRunStatus;
  state: SimulationState;
  initialState: SimulationState;
  budgetLimit: number;
  actions: SimulationActionRecord[];
  events: SimulationEvent[];
  terminationReason: string | null;
}) {
  const successfulActions = input.actions.filter((action) => action.accepted).length;
  const rejectedActions = input.actions.filter((action) => !action.accepted).length;
  const totalActions = successfulActions + rejectedActions;
  const failures = input.events
    .filter((event) => event.kind === 'agent.error' || event.kind === 'simulation.failed')
    .map((event) => event.summary);
  const resourcesUsed: SimulationResources = {
    energy: Math.max(0, input.initialState.resources.energy - input.state.resources.energy),
    materials: Math.max(
      0,
      input.initialState.resources.materials - input.state.resources.materials,
    ),
    water: Math.max(0, input.initialState.resources.water - input.state.resources.water),
  };
  return SimulationMetrics.parse({
    outcome: input.status,
    taskSuccess: input.state.progress >= input.state.target,
    steps: input.state.step,
    successfulActions,
    rejectedActions,
    successRate: totalActions === 0 ? 0 : successfulActions / totalActions,
    invalidActionRate: totalActions === 0 ? 0 : rejectedActions / totalActions,
    budgetUsed: input.state.budgetSpent,
    budgetLimit: input.budgetLimit,
    resourcesUsed,
    failures,
    terminationReason: input.terminationReason,
  });
}
