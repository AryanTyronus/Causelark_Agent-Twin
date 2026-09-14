//
// `applyScenario` is the single entry point that turns a baseline world plus a
// scenario definition into the world a run will actually start in. It is a pure
// fold: validate the definition, copy the baseline, apply the modifiers in
// declared order, prove the result is a world the environment would accept.
//
// The environment owns the definition of a valid world, so the final check asks
// the environment itself (`getSimulationStatus`) rather than re-deriving its
// rules here. Nothing in this module reads a clock, draws a random number, or
// touches a database or a provider, so applying `seed = 1042` under
// `resource-scarcity@1` twice produces the same state both times.

import { SimulationConfiguration, SimulationState } from '@/lib/contracts/simulation';
import { getSimulationStatus } from '@/lib/environments/registry';
import { applyModifier } from './modifiers';
import {
  MIN_SCENARIO_RISK_HEADROOM,
  Scenario,
  ScenarioApplicationResult,
  type ScenarioBaseline,
  type ScenarioChange,
  ScenarioError,
  type ScenarioModifier,
} from './types';

/**
 * Prove the result is a world a run can actually start in.
 *
 * Each check names a way a scenario could produce an environment the agent
 * would be unable to act in — a limit that has already elapsed, a budget with
 * nothing left, risk already at the failure threshold, no permitted action.
 * Failing here means the run is never created, rather than created broken.
 */
export function validateScenarioBaseline(baseline: ScenarioBaseline): void {
  const { state, configuration } = baseline;
  if (state.maxSteps !== configuration.maxSteps)
    throw new ScenarioError(
      'INVALID_RESULT',
      'The scenario left the decision budget disagreeing between the run configuration and the state.',
    );
  if (state.risk > state.maxRisk - MIN_SCENARIO_RISK_HEADROOM)
    throw new ScenarioError(
      'INVALID_RESULT',
      `Risk ${state.risk} leaves no headroom below the failure threshold ${state.maxRisk}.`,
    );
  if (state.permissions.length === 0)
    throw new ScenarioError('INVALID_RESULT', 'The scenario left no action permitted.');
  const status = getSimulationStatus(state);
  if (status.status !== 'RUNNING')
    throw new ScenarioError(
      'INVALID_RESULT',
      `The scenario produced a run that is already ${status.status}: ${
        status.terminationReason ?? 'terminated'
      }`,
    );
}

/**
 * Copy and validate the baseline before anything is applied to it, so the
 * caller's object is never mutated and a modifier only ever reads pristine
 * values. `SimulationState.parse` both proves the shape and returns new objects,
 * which is what makes the copy a copy.
 */
function frozenBaseline(baseline: ScenarioBaseline): ScenarioBaseline {
  try {
    return {
      state: SimulationState.parse(baseline.state),
      configuration: SimulationConfiguration.parse(baseline.configuration),
    };
  } catch {
    throw new ScenarioError(
      'INVALID_BASELINE',
      'The baseline world is not a valid simulation state.',
    );
  }
}

/**
 * Apply a scenario to a baseline world.
 *
 * Modifiers are folded in the order the definition declares them — an array,
 * not an object, so the order is a property of the data rather than of property
 * iteration, and two runs of the same scenario apply the same sequence.
 */
export function applyScenario(
  baseline: ScenarioBaseline,
  scenario: Scenario,
): ScenarioApplicationResult {
  const parsed = Scenario.safeParse(scenario);
  if (!parsed.success)
    throw new ScenarioError('INVALID_SCENARIO', 'The scenario definition is not valid.');

  let current = frozenBaseline(baseline);

  // A condition perturbs one world's own rules, so applying it to the other world
  // is an authoring mistake rather than a no-op: the resource conditions would
  // shave stocks the trading world never reads, and the trading conditions would
  // rewrite a market the resource world does not have. Refused here, before any
  // modifier runs, so the mistake cannot reach a run as a "conditioned" world
  // that is in fact unperturbed.
  if (parsed.data.environmentKey !== current.state.environmentKey)
    throw new ScenarioError(
      'INVALID_BASELINE',
      `Scenario ${parsed.data.id} conditions the ${parsed.data.environmentKey} environment, but this baseline is a ${current.state.environmentKey} world.`,
    );

  const seed = current.state.seed;
  const changes: ScenarioChange[] = [];
  for (const modifier of parsed.data.modifiers as ScenarioModifier[]) {
    const outcome = applyModifier(current, modifier);
    current = { state: outcome.state, configuration: outcome.configuration };
    changes.push(...outcome.changes);
  }

  if (current.state.seed !== seed)
    throw new ScenarioError('INVALID_RESULT', 'A scenario must not change the simulation seed.');
  validateScenarioBaseline(current);

  return ScenarioApplicationResult.parse({
    scenario: { id: parsed.data.id, version: parsed.data.version },
    name: parsed.data.name,
    description: parsed.data.description,
    state: current.state,
    configuration: current.configuration,
    changes,
  });
}
