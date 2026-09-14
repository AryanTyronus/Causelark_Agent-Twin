//
// The environment registry: one list, one lookup, one dispatch.
//
// Before this module there was one environment, so "the environment" and
// "resource routing" were the same thing and the run loop, the scenario engine,
// the counterfactual analyser and the persistence layer all called its functions
// by name. There are two now, and the pipeline above them must not have to know
// which one it is driving.
//
// So this is the seam, and it is deliberately the ONLY one. Everything the
// pipeline needs that differs between worlds goes through here:
//
//   `simulationEnvironment(key)`       — the world a run names
//   `simulationEnvironmentFor(state)`  — the world a persisted run belongs to
//   `createInitialSimulationState`     — dispatch on the requested key
//   `evaluateSimulationAction`         — dispatch on the state's own key
//   `getSimulationStatus`              — dispatch on the state's own key
//
// The three dispatching functions keep the names they have always had, so every
// call site in the codebase reads exactly as it did before — only its import
// line changes, from the environment module to this one. That is what makes this
// an extension rather than a rewrite: there is still one function called
// `evaluateSimulationAction`, and it is still the only thing that may move a
// simulation's state.
//
// WHY DISPATCH READS THE STATE, NOT THE REQUEST
//
// A validator is handed a state and an untrusted action. It must decide the
// action under the rules of whichever world that state belongs to, and the state
// is the only trustworthy witness to which world that is — a caller that passed
// a conflicting key alongside the state would be inventing a world rather than
// describing one. So `evaluateSimulationAction` and `getSimulationStatus` take
// the state's own `environmentKey` as the truth, and refuse a state naming a
// world this deployment does not ship rather than guessing.
//
// Nothing here reads a clock, a random source, a database, a provider or the
// network. The registry is a frozen record built at module load, and every
// lookup in it is a pure function of its argument.

import {
  type SimulationConfiguration,
  type SimulationEnvironmentKey,
  type SimulationObjectiveKey,
  SimulationState,
  type SimulationState as SimulationStateType,
} from '@/lib/contracts/simulation';
import { TRADING_ENVIRONMENT } from '@/lib/trading/environment';
import { RESOURCE_ROUTING_ENVIRONMENT } from './resource-routing';
import {
  type EnvironmentActionEvaluation,
  EnvironmentError,
  type EnvironmentStatus,
  type SimulationEnvironment,
} from './types';

/**
 * Every world this deployment publishes, in catalogue order.
 *
 * Frozen, and built from the shipped definitions rather than discovered: an
 * environment key arriving from a request can only ever match a world compiled
 * into this module.
 */
export const SIMULATION_ENVIRONMENTS: readonly SimulationEnvironment[] = Object.freeze([
  RESOURCE_ROUTING_ENVIRONMENT,
  TRADING_ENVIRONMENT,
]);

const BY_KEY: ReadonlyMap<string, SimulationEnvironment> = new Map(
  SIMULATION_ENVIRONMENTS.map((environment) => [environment.key, environment]),
);

/** Whether a key names a world this deployment publishes. */
export function isKnownEnvironmentKey(key: string): key is SimulationEnvironmentKey {
  return BY_KEY.has(key);
}

/**
 * The world a key names, or a thrown `EnvironmentError`.
 *
 * Thrown rather than defaulted. Falling back to the first environment would turn
 * a typo in a request into a run of a benchmark nobody asked for, which is worse
 * than a refusal: the refusal is visible and the run would not be.
 */
export function simulationEnvironment(key: string): SimulationEnvironment {
  const environment = BY_KEY.get(key);
  if (!environment)
    throw new EnvironmentError('UNKNOWN_ENVIRONMENT', `Unknown simulation environment: ${key}.`);
  return environment;
}

/**
 * The world a state belongs to.
 *
 * The state is parsed first, so an object that is not a simulation state is
 * refused as such rather than being reported as naming an unknown environment.
 */
export function simulationEnvironmentFor(state: SimulationStateType): SimulationEnvironment {
  const parsed = SimulationState.safeParse(state);
  if (!parsed.success)
    throw new EnvironmentError(
      'ENVIRONMENT_MISMATCH',
      'The state is not a valid simulation state, so its environment cannot be resolved.',
    );
  return simulationEnvironment(parsed.data.environmentKey);
}

/**
 * Build the starting state of a run.
 *
 * The only one of the dispatchers that reads the request rather than a state:
 * there is no state yet, so the environment key is the whole of the evidence and
 * an unknown one is refused here instead of producing a world that does not
 * exist.
 */
export function createInitialSimulationState(
  environmentKey: SimulationEnvironmentKey,
  objectiveKey: SimulationObjectiveKey,
  seed: number,
  configuration?: SimulationConfiguration,
): SimulationStateType {
  const environment = simulationEnvironment(environmentKey);
  return environment.createInitialState(
    objectiveKey,
    seed,
    configuration ?? environment.defaultConfiguration,
  );
}

/**
 * The configuration a run of one world starts from when the caller names none.
 *
 * A second dispatcher on the same seam, added because the default is a fact
 * about a world rather than about the deployment: the resource-routing world
 * funds its objective with 24 budget units and the trading world funds a $500
 * target with 40, and seeding one world's run from the other's numbers would
 * silently run the benchmark at a calibration nobody published. Callers merge
 * their own overrides over this.
 *
 * For `resource-routing` this returns the very object the resource world already
 * published, so every existing call site is unchanged by construction.
 */
export function defaultConfigurationFor(
  environmentKey: SimulationEnvironmentKey,
): SimulationConfiguration {
  return simulationEnvironment(environmentKey).defaultConfiguration;
}

/**
 * Validate and apply one action under the rules of the state's own world.
 *
 * The single point at which a simulation's state may move in response to a
 * request. A refused action returns the input state untouched.
 */
export function evaluateSimulationAction(
  state: SimulationStateType,
  action: unknown,
): EnvironmentActionEvaluation {
  return simulationEnvironmentFor(state).evaluateAction(state, action);
}

/** How a run has ended, under the rules of its own world. */
export function getSimulationStatus(state: SimulationStateType): EnvironmentStatus {
  return simulationEnvironmentFor(state).getStatus(state);
}
