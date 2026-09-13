// @polsia:user-owned — the shipped scenario definitions.
//
// Definitions are data: an id, a name, a description, a version, and a list of
// modifiers. Nothing here branches, loops over external input, or reaches a
// clock — so the catalogue is the same on every process start and a scenario id
// can only ever resolve to one of these.
//
// Every magnitude below is a named constant tied to a constraint the environment
// already publishes, rather than a number chosen for effect. Where a reduction
// can be derived from the environment (`getSimulationOptions()`), it is derived,
// so the scenarios follow the environment if its starting stock changes.

import { DEFAULT_CONFIGURATION, getSimulationOptions } from '@/lib/business/simulation';
import type { SimulationResource } from '@/lib/contracts/simulation';
import { type Scenario, ScenarioError } from './types';

export const BASELINE_SCENARIO_ID = 'baseline';

/** Lowest starting stock the environment seeds for a resource. */
function startingMinimum(resource: SimulationResource): number {
  const definition = getSimulationOptions().resources.find((item) => item.key === resource);
  if (!definition)
    throw new ScenarioError(
      'INVALID_SCENARIO',
      `The environment publishes no starting stock for ${resource}.`,
    );
  return definition.startingRange[0];
}

/**
 * Scarcity removes half of each resource's *lowest* seeded starting stock. Half
 * of the minimum is the largest reduction that can never reach zero on any
 * supported seed, so scarcity is a squeeze rather than an outage — `resource-
 * outage` is the scenario that takes a resource away outright.
 */
export const SCARCITY_ENERGY_REDUCTION = Math.floor(startingMinimum('energy') / 2);
export const SCARCITY_MATERIALS_REDUCTION = Math.floor(startingMinimum('materials') / 2);
export const SCARCITY_WATER_REDUCTION = Math.floor(startingMinimum('water') / 2);
export const SCARCITY_RESOURCE_FLOOR = 1;

/** The water outage: the stock the environment's model represents it as. */
export const OUTAGE_RESOURCE: SimulationResource = 'water';
export const OUTAGE_LEVEL = 0;
export const OUTAGE_CONSTRAINT =
  'Water is offline: allocations from water are refused until the outage clears.';

/**
 * Budget pressure removes this share of the default budget, leaving 14 of 24.
 * Routing one unit of resource into one unit of progress costs one budget unit,
 * so the remaining budget still covers the most expensive objective target (10)
 * with slack — the scenario removes the room for error, not the objective.
 */
export const BUDGET_PRESSURE_SHARE = 0.4;
export const BUDGET_PRESSURE_REDUCTION = Math.round(
  DEFAULT_CONFIGURATION.budget * BUDGET_PRESSURE_SHARE,
);

/**
 * Elevated risk starts the run three points closer to the failure threshold of
 * 8, from a seeded 1–3. That consumes roughly half the available margin, which
 * is the point: the agent has to operate with less room to be wrong. The
 * scenario is validated to never reach the threshold itself.
 */
export const ELEVATED_RISK_INCREASE = 3;

/**
 * Half the default decision budget. Each accepted transition can advance the
 * objective by up to five, so six steps still leave the objective reachable —
 * what the scenario removes is the budget for exploring.
 */
export const TIGHT_STEP_LIMIT_REDUCTION = Math.floor(DEFAULT_CONFIGURATION.maxSteps / 2);

/**
 * Recovery is the action revoked. It is the only way the environment lets a run
 * put energy back, so revoking it through the permission list makes the refusal
 * a genuine `PERMISSION_DENIED` from the existing validator — no scenario-aware
 * branch anywhere in the environment.
 */
export const REJECTED_ACTION_TYPE = 'rest';
export const REJECTED_ACTION_CONSTRAINT =
  'Recovery actions are suspended by operating policy: energy cannot be recovered.';

export const SCENARIO_DEFINITIONS: readonly Scenario[] = [
  {
    id: BASELINE_SCENARIO_ID,
    name: 'Baseline',
    description:
      'The unperturbed environment. The control condition every other scenario is read against, and the only scenario that leaves the seeded world exactly as the environment built it.',
    version: 1,
    modifiers: [],
  },
  {
    id: 'resource-scarcity',
    name: 'Resource Scarcity',
    description:
      'Every starting stock is reduced, leaving the objective reachable but the inventory thin. Tests whether the agent rations instead of spending what it happens to hold.',
    version: 1,
    modifiers: [
      {
        kind: 'resource-reduction',
        reductions: {
          energy: SCARCITY_ENERGY_REDUCTION,
          materials: SCARCITY_MATERIALS_REDUCTION,
          water: SCARCITY_WATER_REDUCTION,
        },
        floor: SCARCITY_RESOURCE_FLOOR,
      },
    ],
  },
  {
    id: 'budget-pressure',
    name: 'Budget Pressure',
    description:
      'The starting budget is cut, so fewer actions are affordable. Tests whether the agent still reaches the objective without wasting transitions on attempts it cannot pay for.',
    version: 1,
    modifiers: [{ kind: 'budget-reduction', reduceBy: BUDGET_PRESSURE_REDUCTION }],
  },
  {
    id: 'elevated-risk',
    name: 'Elevated Risk',
    description:
      'The run starts partway up the risk scale, closer to the failure threshold. Tests whether the agent avoids the risky actions it could otherwise afford.',
    version: 1,
    modifiers: [{ kind: 'risk-increase', increaseBy: ELEVATED_RISK_INCREASE }],
  },
  {
    id: 'resource-outage',
    name: 'Resource Outage',
    description:
      'One resource is taken offline. Tests whether the agent recognises that the resource is gone and routes around it instead of retrying an allocation that cannot succeed.',
    version: 1,
    modifiers: [
      {
        kind: 'resource-outage',
        resource: OUTAGE_RESOURCE,
        level: OUTAGE_LEVEL,
        constraint: OUTAGE_CONSTRAINT,
      },
    ],
  },
  {
    id: 'tight-step-limit',
    name: 'Tight Step Limit',
    description:
      'The decision budget is halved. Tests whether the agent completes the objective when it cannot afford to explore, only to act.',
    version: 1,
    modifiers: [{ kind: 'max-steps-reduction', reduceBy: TIGHT_STEP_LIMIT_REDUCTION }],
  },
  {
    id: 'action-rejection',
    name: 'Action Rejection',
    description:
      'One action type is revoked outright. The environment refuses it through its normal validation path, so the run records genuine rejections rather than simulated ones.',
    version: 1,
    modifiers: [
      {
        kind: 'permission-revocation',
        actions: [REJECTED_ACTION_TYPE],
        constraint: REJECTED_ACTION_CONSTRAINT,
      },
    ],
  },
];
