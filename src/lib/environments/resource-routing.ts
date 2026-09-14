//
// Resource routing, expressed as an environment.
//
// This file adds one thing and changes nothing: it states the rules the
// resource-routing world already had in the shape the pipeline now asks for.
// Every member delegates to the module that has always owned that rule —
// `createInitialSimulationState`, `evaluateSimulationAction`,
// `getSimulationStatus`, `getSimulationOptions` — so there is still exactly one
// implementation of each, and Resource Routing behaves precisely as it did
// before a second environment existed.
//
// Three members deserve a note, because they are where a careless adapter would
// have quietly changed the benchmark:
//
//   `objectiveDescription` returns the objective's catalogue description
//   VERBATIM. The agent prompt is built from it, so returning anything richer
//   here — a longer brief, a restatement of the constraints — would change what
//   every Resource Routing agent is told, and with it the Resource Routing
//   scores. The fuller brief the trading world gives its agent is that world's
//   own choice, not a platform-wide improvement.
//
//   `scoring` publishes the two constants the evaluation engine normalises this
//   world against, cited from the engine's own exports rather than restated. The
//   engine's defaults are unchanged, so this world scores exactly as it did.
//
//   `actionSpace` reproduces the enumeration the counterfactual analyser used to
//   build for itself, including its order and including its refusal to consult
//   the state: the analyser enumerates the whole vocabulary and lets the
//   validator refuse what a scenario revoked, which is what makes a revoked
//   action show up in a counterfactual report as a refusal rather than as an
//   absence. Narrowing this list to the state's permissions would silently
//   change every Resource Routing counterfactual.

import {
  createInitialSimulationState,
  DEFAULT_CONFIGURATION,
  evaluateSimulationAction,
  getSimulationOptions,
  getSimulationStatus,
} from '@/lib/business/simulation';
import {
  RESOURCE_OBJECTIVE_KEYS,
  ResourceActionInput,
  ResourceObjectiveKey,
  type ResourceObjectiveKey as ResourceObjectiveKeyType,
  type SimulationActionInput,
  type SimulationActionType,
  type SimulationResource,
  type SimulationState,
} from '@/lib/contracts/simulation';
import {
  MAX_PROGRESS_PER_TRANSITION,
  OPTIMAL_BUDGET_PER_PROGRESS_UNIT,
} from '@/lib/evaluation/scoring';
import { ACTION_SPACE_PROBE_LIMIT, type SimulationEnvironment } from './types';

/**
 * The action sizes this world accepts, discovered by asking its own validator.
 *
 * Derived rather than declared, so the ladder cannot outlive the rule that
 * produced it: `ResourceActionInput` is the schema this world validates with,
 * and if it ever accepted a different range this list would move with it.
 */
function supportedAmounts(): number[] {
  const amounts: number[] = [];
  for (let amount = 1; amount <= ACTION_SPACE_PROBE_LIMIT; amount += 1)
    if (ResourceActionInput.safeParse({ type: 'rest', amount }).success) amounts.push(amount);
  return amounts;
}

/** The sizes, in ascending order. Frozen so a caller cannot reorder the space. */
export const RESOURCE_ACTION_AMOUNTS: readonly number[] = Object.freeze(supportedAmounts());

const CATALOGUE = getSimulationOptions();

/**
 * This world's own catalogue entry.
 *
 * Resolved by key rather than taken as the first element, and thrown for if it
 * is absent: a missing entry means the catalogue and this adapter disagree about
 * what this world is called, which is a build-time fault that should stop the
 * deployment rather than serve a picker labelled with someone else's title.
 */
function environmentOption() {
  const option = CATALOGUE.environments.find((entry) => entry.key === 'resource-routing');
  if (!option)
    throw new Error('The simulation catalogue does not publish the resource-routing environment.');
  return option;
}

/**
 * The verbs and resources, in the world's own declared order.
 *
 * Read back out of the catalogue the world already publishes rather than written
 * again here, so the enumeration and the options endpoint cannot disagree about
 * what this environment offers.
 */
const ACTION_TYPE_ORDER = CATALOGUE.actions.map((action) => action.key) as SimulationActionType[];
const ACTION_RESOURCE_ORDER = CATALOGUE.resources.map(
  (resource) => resource.key,
) as SimulationResource[];

/**
 * Every action resource routing admits, in the analyser's historical order:
 * type, then resource, then amount.
 *
 * `rest` takes no resource — the world recovers energy and raises risk whatever
 * is named — so it contributes one amount axis rather than three.
 */
function resourceActionSpace(_state: SimulationState): SimulationActionInput[] {
  const space: SimulationActionInput[] = [];
  for (const type of ACTION_TYPE_ORDER) {
    if (type === 'rest') {
      for (const amount of RESOURCE_ACTION_AMOUNTS) space.push({ type, amount });
      continue;
    }
    for (const resource of ACTION_RESOURCE_ORDER)
      for (const amount of RESOURCE_ACTION_AMOUNTS) space.push({ type, resource, amount });
  }
  return space;
}

/**
 * The profile the evaluation engine normalises this world's scores against.
 *
 * Read from the evaluation engine's own exported constants rather than restated,
 * so the world cannot advertise a ceiling the evaluator does not use. That is
 * the whole point of publishing it: the numbers are the world's, and the
 * evaluator is told them rather than assuming them.
 */
export const RESOURCE_SCORING_PROFILE = {
  maxProgressPerTransition: MAX_PROGRESS_PER_TRANSITION,
  optimalBudgetPerProgressUnit: OPTIMAL_BUDGET_PER_PROGRESS_UNIT,
} as const;

export const RESOURCE_ROUTING_ENVIRONMENT: SimulationEnvironment = {
  key: 'resource-routing',
  option: environmentOption(),
  // Narrowed to this world's own objectives. The catalogue lists every objective
  // the deployment publishes, which after the trading benchmark exists is more
  // than this world answers to.
  objectives: CATALOGUE.objectives
    .filter((objective) => (RESOURCE_OBJECTIVE_KEYS as readonly string[]).includes(objective.key))
    .map((objective) => ({
      ...objective,
      key: ResourceObjectiveKey.parse(objective.key) as ResourceObjectiveKeyType,
    })),
  actionTypes: ['harvest', 'allocate', 'rest'],
  defaultConfiguration: DEFAULT_CONFIGURATION,
  constraints: CATALOGUE.constraints,
  tools: CATALOGUE.tools,
  /**
   * The tool surface the resource-routing agent has always been given.
   *
   * Both strings are reproduced exactly as `resource-tools.ts` held them before
   * the tool surface moved here. This is the wording that shapes an agent's
   * behaviour, so a reworded description is a changed benchmark; read them out of
   * the catalogue's display surface instead and the prompt would change.
   */
  agentTools: {
    observations: [
      {
        name: 'observe_resources',
        description:
          'Read observable resources, budget, tasks, constraints, objective progress, and remaining action allowance.',
      },
    ],
    action: {
      name: 'request_action',
      description:
        'Request one action. The deterministic environment validates it before changing state. You may request a limited number of actions per turn.',
    },
  },
  // This world's own action schema, not the shared record schema. `request_action`
  // is shown to the model, and the record schema accepts sizes this world refuses;
  // advertising it would offer the agent an amount range that does not exist.
  actionInputSchema: ResourceActionInput,
  scoring: RESOURCE_SCORING_PROFILE,
  /**
   * The objective, exactly as the catalogue states it.
   *
   * Deliberately the catalogue's own string rather than a fresh one: this is the
   * text every Resource Routing agent has always been given, and re-deriving it
   * would be re-writing the prompt of a benchmark whose scores must not move.
   */
  objectiveDescription(objectiveKey) {
    const objective = CATALOGUE.objectives.find((entry) => entry.key === objectiveKey);
    if (!objective)
      throw new Error(`Resource routing does not publish the objective ${objectiveKey}.`);
    return objective.description;
  },
  createInitialState(objectiveKey, seed, configuration) {
    return createInitialSimulationState('resource-routing', objectiveKey, seed, configuration);
  },
  evaluateAction(state, action) {
    return evaluateSimulationAction(state, action);
  },
  getStatus(state) {
    return getSimulationStatus(state);
  },
  actionSpace: resourceActionSpace,
};
