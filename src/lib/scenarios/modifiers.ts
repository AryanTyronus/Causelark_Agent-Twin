// @polsia:user-owned — the scenario modifier engine.
//
// One pure function per modifier kind, keyed by kind in a frozen record. There
// is no `switch` to extend and no `eval`-like escape hatch: a modifier is data,
// the vocabulary is closed, and every function below is a total, deterministic
// transformation from one baseline to the next.
//
// Every applier copies forward. Nothing here mutates the baseline it is handed,
// so applying the same scenario to the same baseline twice yields the same
// result and leaves the input untouched.

import {
  type SimulationConfiguration,
  SimulationConfiguration as SimulationConfigurationSchema,
  type SimulationState,
  SimulationState as SimulationStateSchema,
} from '@/lib/contracts/simulation';
import {
  MIN_SCENARIO_BUDGET,
  MIN_SCENARIO_MAX_STEPS,
  SCENARIO_RESOURCE_ORDER,
  type ScenarioBaseline,
  type ScenarioChange,
  ScenarioError,
  type ScenarioModifier,
  type ScenarioModifierKind,
  type ScenarioModifierOf,
} from './types';

export interface ModifierOutcome {
  state: SimulationState;
  configuration: SimulationConfiguration;
  changes: ScenarioChange[];
}

type ScenarioModifierApplier<K extends ScenarioModifierKind> = (
  current: ScenarioBaseline,
  modifier: ScenarioModifierOf<K>,
) => ModifierOutcome;

function change(
  field: string,
  before: unknown,
  after: unknown,
  modifier: ScenarioModifierKind,
): ScenarioChange {
  return { field, before, after, modifier };
}

/** Records a boolean-valued field change only when the value actually moved. */
function flag(
  field: string,
  before: unknown,
  after: unknown,
  modifier: ScenarioModifierKind,
): ScenarioChange[] {
  return JSON.stringify(before) === JSON.stringify(after)
    ? []
    : [change(field, before, after, modifier)];
}

/**
 * Appends an operator-facing constraint once. Idempotent by construction so a
 * scenario re-applied to its own output cannot accumulate duplicate lines.
 */
function appendConstraint(constraints: string[], addition: string): string[] {
  return constraints.includes(addition) ? [...constraints] : [...constraints, addition];
}

/** Saturating subtraction: `amount` off `value`, never below `floor`. */
function reduce(value: number, amount: number, floor: number): number {
  return Math.max(floor, value - amount);
}

const applyResourceReduction: ScenarioModifierApplier<'resource-reduction'> = (
  current,
  modifier,
) => {
  const resources = { ...current.state.resources };
  const changes: ScenarioChange[] = [];
  for (const resource of SCENARIO_RESOURCE_ORDER) {
    const reduction = modifier.reductions[resource];
    if (reduction === undefined) continue;
    const before = resources[resource];
    const after = reduce(before, reduction, modifier.floor);
    resources[resource] = after;
    changes.push(change(`resources.${resource}`, before, after, modifier.kind));
  }
  return {
    state: SimulationStateSchema.parse({ ...current.state, resources }),
    configuration: current.configuration,
    changes,
  };
};

const applyResourceOutage: ScenarioModifierApplier<'resource-outage'> = (current, modifier) => {
  const before = current.state.resources[modifier.resource];
  const resources = { ...current.state.resources, [modifier.resource]: modifier.level };
  const constraints = appendConstraint(current.state.constraints, modifier.constraint);
  return {
    state: SimulationStateSchema.parse({ ...current.state, resources, constraints }),
    configuration: current.configuration,
    changes: [
      change(`resources.${modifier.resource}`, before, modifier.level, modifier.kind),
      ...flag('constraints', current.state.constraints, constraints, modifier.kind),
    ],
  };
};

const applyBudgetReduction: ScenarioModifierApplier<'budget-reduction'> = (current, modifier) => {
  // The starting budget is the environment's own initialization invariant:
  // `budgetRemaining` and `configuration.budget` are equal until an action
  // spends budget, so a scenario moves both and reports both.
  const beforeBudget = current.state.budgetRemaining;
  const afterBudget = reduce(beforeBudget, modifier.reduceBy, MIN_SCENARIO_BUDGET);
  const beforeConfiguration = current.configuration.budget;
  return {
    state: SimulationStateSchema.parse({ ...current.state, budgetRemaining: afterBudget }),
    configuration: SimulationConfigurationSchema.parse({
      ...current.configuration,
      budget: afterBudget,
    }),
    changes: [
      change('budgetRemaining', beforeBudget, afterBudget, modifier.kind),
      change('configuration.budget', beforeConfiguration, afterBudget, modifier.kind),
    ],
  };
};

const applyRiskIncrease: ScenarioModifierApplier<'risk-increase'> = (current, modifier) => {
  const before = current.state.risk;
  const after = before + modifier.increaseBy;
  return {
    // Deliberately not saturated: elevation that would reach the failure
    // threshold is rejected by validation rather than silently trimmed to a
    // different scenario than the definition asked for.
    state: SimulationStateSchema.parse({ ...current.state, risk: after }),
    configuration: current.configuration,
    changes: [change('risk', before, after, modifier.kind)],
  };
};

const applyMaxStepsReduction: ScenarioModifierApplier<'max-steps-reduction'> = (
  current,
  modifier,
) => {
  // `maxSteps` is the environment's single notion of the decision budget and it
  // lives in two places that the environment keeps equal at initialization: the
  // run configuration and the state that `getSimulationStatus` reads. Both move
  // together, so the scenario cannot leave a limit that status ignores.
  const beforeSteps = current.state.maxSteps;
  const afterSteps = reduce(beforeSteps, modifier.reduceBy, MIN_SCENARIO_MAX_STEPS);
  const beforeConfiguration = current.configuration.maxSteps;
  return {
    state: SimulationStateSchema.parse({ ...current.state, maxSteps: afterSteps }),
    configuration: SimulationConfigurationSchema.parse({
      ...current.configuration,
      maxSteps: afterSteps,
    }),
    changes: [
      change('maxSteps', beforeSteps, afterSteps, modifier.kind),
      change('configuration.maxSteps', beforeConfiguration, afterSteps, modifier.kind),
    ],
  };
};

const applyPermissionRevocation: ScenarioModifierApplier<'permission-revocation'> = (
  current,
  modifier,
) => {
  const revoked = new Set<string>(modifier.actions);
  const before = current.state.permissions;
  const permissions = before.filter((permission) => !revoked.has(permission));
  const constraints = appendConstraint(current.state.constraints, modifier.constraint);
  return {
    state: SimulationStateSchema.parse({ ...current.state, permissions, constraints }),
    configuration: current.configuration,
    changes: [
      ...flag('permissions', before, permissions, modifier.kind),
      ...flag('constraints', current.state.constraints, constraints, modifier.kind),
    ],
  };
};

/**
 * The closed vocabulary. A modifier kind absent from this record cannot be
 * applied, so a definition cannot smuggle in behaviour the engine never agreed
 * to — which is exactly what the schema's discriminated union also enforces.
 */
const MODIFIER_APPLIERS: {
  [K in ScenarioModifierKind]: ScenarioModifierApplier<K>;
} = {
  'resource-reduction': applyResourceReduction,
  'resource-outage': applyResourceOutage,
  'budget-reduction': applyBudgetReduction,
  'risk-increase': applyRiskIncrease,
  'max-steps-reduction': applyMaxStepsReduction,
  'permission-revocation': applyPermissionRevocation,
};

/**
 * Apply one modifier to a baseline.
 *
 * A `ScenarioModifier` has already been narrowed by the schema, but a scenario
 * built programmatically can still bypass `Scenario.parse`, so the lookup is
 * guarded: an unrecognised kind fails loudly here rather than silently
 * contributing nothing.
 */
export function applyModifier(
  current: ScenarioBaseline,
  modifier: ScenarioModifier,
): ModifierOutcome {
  const applier = MODIFIER_APPLIERS[modifier.kind] as
    | ScenarioModifierApplier<ScenarioModifierKind>
    | undefined;
  if (!applier)
    throw new ScenarioError('UNKNOWN_MODIFIER', `Unknown scenario modifier: ${modifier.kind}.`);
  return applier(current, modifier as never);
}

export const SCENARIO_MODIFIER_KINDS = Object.freeze(
  Object.keys(MODIFIER_APPLIERS).sort(),
) as readonly ScenarioModifierKind[];
