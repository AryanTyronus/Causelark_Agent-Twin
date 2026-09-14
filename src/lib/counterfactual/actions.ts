//
// A counterfactual needs a decision space: the set of actions the agent could
// have taken instead. The environment publishes that set, so this module does
// not invent one — it asks the state's own environment to enumerate its
// vocabulary, then asks the environment's own validator which of those actions
// the state in question actually accepts.
//
// Three properties matter, and all three are structural rather than asserted:
//
//   the space is DERIVED, not restated. The environment builds it by probing its
//   own validator for the sizes it accepts, so a change to that environment's
//   rule moves its space with it instead of leaving a copy behind that disagrees.
//
//   the space is ORDERED by the environment that publishes it — type, then
//   resource or asset, then amount — so the same state always yields the same
//   alternatives in the same order, and every tie in the report has a defined
//   winner.
//
//   validity is the ENVIRONMENT'S verdict. Nothing here re-implements the rules
//   an action has to satisfy; `evaluateSimulationAction` is asked, and its answer
//   is the answer. A rejected candidate carries the code the environment gave it,
//   so the report never has to describe a refusal in its own words.
//
// The space is a function of the STATE, not of the deployment, because the two
// environments admit different actions: resource routing trades in units of a
// resource, the trading challenge in shares of an asset. Dispatching on the
// state is what keeps one world's vocabulary out of the other's report.
//
// Nothing here reads a clock, a random source, a database or a provider.

import { SimulationActionInput, type SimulationState } from '@/lib/contracts/simulation';
import { evaluateSimulationAction, simulationEnvironmentFor } from '@/lib/environments/registry';
import type { EnvironmentActionEvaluation } from '@/lib/environments/types';

/**
 * The canonical form of an action.
 *
 * A `rest` action ignores its resource — the environment recovers energy and
 * raises risk regardless of what was named — so two requests that differ only in
 * a meaningless resource field are one alternative, not two. `hold` ignores its
 * asset for the same reason: it acts on the portfolio as a whole. Dropping the
 * noun a verb does not read is what keeps the space free of duplicates and keeps
 * a candidate's identity equal to the recorded action's identity when they are
 * the same choice.
 *
 * Every noun the verb DOES read is preserved. An action that named an instrument
 * and had it dropped would share a key with the same order in another
 * instrument, which would report four distinct decisions as one and would remove
 * the other three from the space as though the agent had already made them.
 */
export function canonicalAction(input: SimulationActionInput): SimulationActionInput {
  const action = SimulationActionInput.parse(input);
  if (action.type === 'rest' || action.type === 'hold')
    return { type: action.type, amount: action.amount };
  const canonical: SimulationActionInput = { type: action.type, amount: action.amount };
  if (action.resource !== undefined) canonical.resource = action.resource;
  if (action.asset !== undefined) canonical.asset = action.asset;
  return canonical;
}

/**
 * Stable identity of an action: `type:subject:amount`, `-` when it has none.
 *
 * The subject is whichever noun the verb reads — a resource for the
 * resource-routing world, an instrument for the trading world. The two
 * vocabularies are disjoint by verb, so one key shape identifies an action in
 * either world and an action recorded in one can never collide with an action
 * recorded in the other. A resource action keeps the exact key it has always
 * had, because a resource action's subject is its resource.
 */
export function actionKey(input: SimulationActionInput): string {
  const action = canonicalAction(input);
  const subject = action.asset ?? action.resource ?? '-';
  return `${action.type}:${subject}:${action.amount}`;
}

/**
 * Every action the state's own environment admits, in that environment's
 * enumeration order.
 *
 * Delegated rather than rebuilt here. The environment is the only module that
 * knows what an action means in its own world — which field carries the subject,
 * which sizes its validator accepts, whether a verb takes a subject at all — and
 * a second enumeration written against the shared contract would silently widen
 * to the union of both worlds.
 */
export function enumerateActionSpace(state: SimulationState): SimulationActionInput[] {
  return simulationEnvironmentFor(state).actionSpace(state);
}

/** One enumerated action together with the environment's verdict on it. */
export interface ActionCandidate {
  key: string;
  action: SimulationActionInput;
  accepted: boolean;
  /** The state the action produced; the input state when it was refused. */
  state: SimulationState;
  observation: string;
  rejectionReason: string | null;
  /** The environment's own code for a refusal, or `ACCEPTED`. */
  code: string;
}

function toCandidate(
  action: SimulationActionInput,
  evaluation: EnvironmentActionEvaluation,
): ActionCandidate {
  return {
    key: actionKey(action),
    action: canonicalAction(action),
    accepted: evaluation.accepted,
    state: evaluation.state,
    observation: evaluation.observation,
    rejectionReason: evaluation.rejectionReason,
    code: evaluation.validationCode ?? (evaluation.accepted ? 'ACCEPTED' : 'INVALID_ACTION'),
  };
}

/**
 * The whole action space evaluated against one state, in enumeration order.
 *
 * The state is never mutated: `evaluateSimulationAction` is a pure transition
 * from the state it is handed, which is why every candidate is measured against
 * the same starting point rather than against the candidate before it.
 */
export function enumerateCandidates(state: SimulationState): ActionCandidate[] {
  return enumerateActionSpace(state).map((action) =>
    toCandidate(action, evaluateSimulationAction(state, action)),
  );
}

/** The admissible part of the space at one decision point. */
export function validCandidates(candidates: readonly ActionCandidate[]): ActionCandidate[] {
  return candidates.filter((candidate) => candidate.accepted);
}

/** The refused part of the space, with the environment's reasons. */
export function rejectedCandidates(candidates: readonly ActionCandidate[]): ActionCandidate[] {
  return candidates.filter((candidate) => !candidate.accepted);
}

/**
 * Refusals grouped by the environment's own rejection code.
 *
 * The order is first appearance in the enumeration, so it is a function of the
 * space order rather than of a second list of codes kept here — the vocabulary
 * belongs to the environment, and this module does not restate it.
 */
export function rejectionCounts(
  rejected: readonly ActionCandidate[],
): { code: string; count: number }[] {
  const counts: { code: string; count: number }[] = [];
  for (const candidate of rejected) {
    const entry = counts.find((item) => item.code === candidate.code);
    if (entry) entry.count += 1;
    else counts.push({ code: candidate.code, count: 1 });
  }
  return counts;
}
