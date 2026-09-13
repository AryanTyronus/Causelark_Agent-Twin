// @polsia:user-owned — pure deterministic resource-management environment.

import {
  SimulationActionInput,
  type SimulationActionInput as SimulationActionInputType,
  SimulationConfiguration,
  type SimulationConfiguration as SimulationConfigurationType,
  SimulationEnvironmentKey,
  type SimulationEnvironmentKey as SimulationEnvironmentKeyType,
  SimulationObjectiveKey,
  type SimulationObjectiveKey as SimulationObjectiveKeyType,
  type SimulationOptions as SimulationOptionsType,
  SimulationState,
  type SimulationState as SimulationStateType,
} from '@/lib/contracts/simulation';

export interface SimulationCatalogueOption {
  key: string;
  title: string;
  description: string;
}
export interface SimulationCatalogue {
  title: string;
  description: string;
  environments: SimulationCatalogueOption[];
  objectives: SimulationCatalogueOption[];
  actions: SimulationCatalogueOption[];
  seeds: { value: number; label: string }[];
  configuration: SimulationConfigurationType;
  resources: SimulationOptionsType['resources'];
  tasks: SimulationOptionsType['tasks'];
  constraints: string[];
  tools: SimulationOptionsType['tools'];
}
export interface ActionEvaluation {
  accepted: boolean;
  state: SimulationStateType;
  observation: string;
  rejectionReason: string | null;
  validationCode?: string;
  stateDiff?: Record<string, unknown>;
}

export const DEFAULT_CONFIGURATION: SimulationConfigurationType = {
  budget: 24,
  maxSteps: 12,
  maxTurns: 12,
  // Wall-clock budget for one bounded agent turn. A single turn now performs
  // several model calls plus tool calls against Amazon Bedrock, so the budget
  // has to cover the whole observe → act → observe cycle, not one round trip.
  toolTimeoutMs: 30000,
};
const ENVIRONMENT_KEY: SimulationEnvironmentKeyType = 'resource-routing';
const SUPPORTED_SEEDS = [1042, 2048, 4242, 9182];
const OBJECTIVE_TARGETS: Record<SimulationObjectiveKeyType, number> = {
  'complete-delivery': 8,
  'preserve-reserve': 10,
  'stabilise-grid': 9,
};
const CONSTRAINTS = [
  'Every non-energy harvest costs one energy.',
  'Allocations consume stored resources and budget.',
  'Rest recovers energy but increases network risk.',
  'Actions after termination are rejected without a state change.',
];

const RESOURCE_DEFINITIONS = [
  {
    key: 'energy' as const,
    label: 'Energy',
    description: 'Operational charge used to harvest and recover the network.',
    startingRange: [6, 9] as [number, number],
    capacity: 12,
    harvestEnergyCost: 0,
    allocationValue: 1,
  },
  {
    key: 'materials' as const,
    label: 'Materials',
    description: 'Build inventory that can be routed into delivery progress.',
    startingRange: [4, 7] as [number, number],
    capacity: 12,
    harvestEnergyCost: 1,
    allocationValue: 1,
  },
  {
    key: 'water' as const,
    label: 'Water',
    description: 'Reserve stock that supports grid stability and delivery.',
    startingRange: [5, 8] as [number, number],
    capacity: 12,
    harvestEnergyCost: 1,
    allocationValue: 1,
  },
];

export function getSimulationOptions(): SimulationCatalogue {
  return {
    title: 'Agent Twin simulation lab',
    description:
      'Configure a reproducible resource world, then inspect every observable agent decision, tool result, validated transition, and replay frame.',
    environments: [
      {
        key: ENVIRONMENT_KEY,
        title: 'Resource routing',
        description: 'Balance energy, materials, and water against budget, permissions, and risk.',
      },
    ],
    objectives: [
      {
        key: 'complete-delivery',
        title: 'Complete the delivery',
        description: 'Route enough material and water into the delivery objective before limits.',
      },
      {
        key: 'preserve-reserve',
        title: 'Preserve the reserve',
        description: 'Build progress while keeping the network risk below its failure threshold.',
      },
      {
        key: 'stabilise-grid',
        title: 'Stabilise the grid',
        description:
          'Use measured allocations and recovery actions to reach a stable operating state.',
      },
    ],
    actions: [
      {
        key: 'harvest',
        title: 'Harvest resources',
        description: 'Add inventory; non-energy harvest costs one energy.',
      },
      {
        key: 'allocate',
        title: 'Allocate resources',
        description: 'Spend inventory to move objective and task progress.',
      },
      {
        key: 'rest',
        title: 'Recover energy',
        description: 'Recover energy while accepting a small risk increase.',
      },
    ],
    seeds: SUPPORTED_SEEDS.map((value) => ({
      value,
      label: `${value} · ${value === 9182 ? 'reference trace' : 'replayable episode'}`,
    })),
    configuration: DEFAULT_CONFIGURATION,
    resources: RESOURCE_DEFINITIONS,
    tasks: [
      {
        id: 'delivery-stock',
        title: 'Delivery stock',
        description: 'Allocate materials into the delivery queue.',
        resource: 'materials',
        requiredAmount: 4,
      },
      {
        id: 'reserve-check',
        title: 'Reserve check',
        description: 'Keep at least two water units available for the final handoff.',
        resource: 'water',
        requiredAmount: 2,
      },
    ],
    constraints: CONSTRAINTS,
    tools: [
      {
        name: 'observe_resources',
        description: 'Read the latest observable state, objective, tasks, and constraints.',
        input: {},
      },
      {
        name: 'request_action',
        description: 'Request one validated harvest, allocate, or rest action.',
        input: {
          type: 'harvest | allocate | rest',
          resource: 'energy | materials | water',
          amount: '1..5',
        },
      },
    ],
  };
}

export function isSupportedSeed(seed: number): boolean {
  return SUPPORTED_SEEDS.includes(seed);
}

function seededValue(seed: number, salt: number): number {
  let value = (seed ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 2246822519) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 3266489917) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}
function seededBetween(seed: number, salt: number, min: number, max: number): number {
  return min + (seededValue(seed, salt) % (max - min + 1));
}

export function createInitialSimulationState(
  environmentKey: SimulationEnvironmentKeyType,
  objectiveKey: SimulationObjectiveKeyType,
  seed: number,
  configuration: SimulationConfigurationType = DEFAULT_CONFIGURATION,
): SimulationStateType {
  SimulationEnvironmentKey.parse(environmentKey);
  SimulationObjectiveKey.parse(objectiveKey);
  const config = SimulationConfiguration.parse(configuration);
  if (!isSupportedSeed(seed)) throw new Error('Unsupported simulation seed');
  const tasks = getSimulationOptions().tasks.map((task) => ({
    ...task,
    progress: 0,
    complete: false,
  }));
  return SimulationState.parse({
    environmentKey,
    objectiveKey,
    seed,
    step: 0,
    maxSteps: config.maxSteps,
    resources: {
      energy: seededBetween(seed, 11, 6, 9),
      materials: seededBetween(seed, 23, 4, 7),
      water: seededBetween(seed, 37, 5, 8),
    },
    capacity: 12,
    progress: 0,
    target: OBJECTIVE_TARGETS[objectiveKey],
    risk: seededBetween(seed, 41, 1, 3),
    maxRisk: 8,
    budgetRemaining: config.budget,
    budgetSpent: 0,
    tasks,
    permissions: ['harvest', 'allocate', 'rest'],
    constraints: CONSTRAINTS,
    lastAction: null,
    lastObservation: 'Initial observable state ready.',
  });
}

export function getSimulationStatus(state: SimulationStateType): {
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'LIMIT_REACHED';
  terminationReason: string | null;
} {
  if (state.progress >= state.target)
    return { status: 'COMPLETED', terminationReason: 'Objective reached.' };
  if (state.risk >= state.maxRisk)
    return { status: 'FAILED', terminationReason: 'Risk threshold exceeded.' };
  if (state.step >= state.maxSteps)
    return { status: 'LIMIT_REACHED', terminationReason: 'Step budget exhausted.' };
  if (state.budgetRemaining <= 0)
    return { status: 'LIMIT_REACHED', terminationReason: 'Resource budget exhausted.' };
  return { status: 'RUNNING', terminationReason: null };
}

function rejected(
  state: SimulationStateType,
  reason: string,
  code = 'INVALID_ACTION',
): ActionEvaluation {
  return {
    accepted: false,
    state,
    observation: 'No state change recorded.',
    rejectionReason: reason,
    validationCode: code,
  };
}

function diff(before: SimulationStateType, after: SimulationStateType): Record<string, unknown> {
  return {
    step: { before: before.step, after: after.step },
    resources: { before: before.resources, after: after.resources },
    progress: { before: before.progress, after: after.progress },
    budgetRemaining: { before: before.budgetRemaining, after: after.budgetRemaining },
    risk: { before: before.risk, after: after.risk },
  };
}

export function evaluateSimulationAction(
  state: SimulationStateType,
  action: SimulationActionInputType,
): ActionEvaluation {
  const parsedAction = SimulationActionInput.safeParse(action);
  if (!parsedAction.success) return rejected(state, 'Action shape is invalid.', 'MALFORMED_ACTION');
  if (getSimulationStatus(state).status !== 'RUNNING')
    return rejected(state, 'This run has already terminated.', 'TERMINAL_RUN');
  const { type, resource, amount } = parsedAction.data;
  if (!state.permissions.includes(type))
    return rejected(state, `The ${type} action is not permitted.`, 'PERMISSION_DENIED');
  if ((type === 'harvest' || type === 'allocate') && !resource) {
    return rejected(
      state,
      `${type === 'harvest' ? 'Harvest' : 'Allocation'} needs a resource.`,
      'RESOURCE_REQUIRED',
    );
  }

  const nextResources = { ...state.resources };
  let nextProgress = state.progress;
  let nextRisk = state.risk;
  let cost = type === 'rest' ? 1 : amount;
  let observation = '';
  if (type === 'harvest' && resource) {
    const definition = RESOURCE_DEFINITIONS.find((item) => item.key === resource);
    const energyCost = definition?.harvestEnergyCost ?? 0;
    cost = amount;
    if (nextResources[resource] + amount > state.capacity)
      return rejected(state, `${resource} would exceed the storage capacity.`, 'CAPACITY_EXCEEDED');
    if (nextResources.energy < energyCost)
      return rejected(
        state,
        `Harvesting ${resource} needs ${energyCost} energy.`,
        'INSUFFICIENT_ENERGY',
      );
    nextResources[resource] += amount;
    nextResources.energy -= energyCost;
    observation = `Harvested ${amount} ${resource}; consumed ${energyCost} energy.`;
  }
  if (type === 'allocate' && resource) {
    cost = amount;
    if (nextResources[resource] < amount)
      return rejected(
        state,
        `Not enough ${resource} to allocate ${amount}.`,
        'INSUFFICIENT_RESOURCE',
      );
    nextResources[resource] -= amount;
    nextProgress += amount;
    nextRisk = Math.max(0, nextRisk - 1);
    observation = `Allocated ${amount} ${resource} toward the objective.`;
  }
  if (type === 'rest') {
    nextResources.energy = Math.min(state.capacity, state.resources.energy + amount);
    nextRisk += 1;
    observation = `Recovered ${amount} energy; network risk increased by one.`;
  }
  if (state.budgetRemaining < cost)
    return rejected(
      state,
      `This action needs ${cost} budget units; only ${state.budgetRemaining} remain.`,
      'BUDGET_EXCEEDED',
    );
  const nextTasks = state.tasks.map((task) => {
    if (type !== 'allocate' || task.resource !== resource) return task;
    const progress = Math.min(task.requiredAmount, task.progress + amount);
    return { ...task, progress, complete: progress >= task.requiredAmount };
  });
  const nextState = SimulationState.parse({
    ...state,
    step: state.step + 1,
    resources: nextResources,
    progress: nextProgress,
    risk: nextRisk,
    budgetRemaining: state.budgetRemaining - cost,
    budgetSpent: state.budgetSpent + cost,
    tasks: nextTasks,
    lastAction: type,
    lastObservation: observation,
  });
  return {
    accepted: true,
    state: nextState,
    observation,
    rejectionReason: null,
    validationCode: 'ACCEPTED',
    stateDiff: diff(state, nextState),
  };
}
