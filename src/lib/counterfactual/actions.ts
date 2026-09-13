//
// A counterfactual needs a decision space: the set of actions the agent could
// have taken instead. The environment publishes that set, so this module does
// not invent one — it enumerates the action contract's own vocabulary, then asks
// the environment's own validator which of those actions the state in question
// actually accepts.
//
// Three properties matter, and all three are structural rather than asserted:
//
//   the space is DERIVED, not restated. The amount range is read back out of
//   `SimulationActionInput` by probing it, so a change to the contract moves the
//   action space with it instead of leaving a copy behind that disagrees.
//
//   the space is ORDERED by named arrays — type, then resource, then amount — so
//   the same state always yields the same alternatives in the same order, and
//   every tie in the report has a defined winner.
//
//   validity is the ENVIRONMENT'S verdict. Nothing here re-implements the rules
//   an action has to satisfy; `evaluateSimulationAction` is asked, and its answer
//   is the answer. A rejected candidate carries the code the environment gave it,
//   so the report never has to describe a refusal in its own words.
//
// Nothing here reads a clock, a random source, a database or a provider.

import { type ActionEvaluation, evaluateSimulationAction } from '@/lib/business/simulation';
import { SimulationActionInput, type SimulationState } from '@/lib/contracts/simulation';
import { ACTION_AMOUNT_PROBE_LIMIT, ACTION_RESOURCE_ORDER, ACTION_TYPE_ORDER } from './types';

/**
 * The amounts the action contract accepts, discovered rather than declared.
 *
 * The probe is bounded by a search limit, not by a copy of the contract's own
 * maximum: if the contract widened `amount` to 8, this list would widen with it.
 */
function supportedAmounts(): number[] {
  const amounts: number[] = [];
  for (let amount = 1; amount <= ACTION_AMOUNT_PROBE_LIMIT; amount += 1)
    if (SimulationActionInput.safeParse({ type: 'rest', amount }).success) amounts.push(amount);
  return amounts;
}

export const ACTION_AMOUNTS: readonly number[] = Object.freeze(supportedAmounts());

/**
 * The canonical form of an action.
 *
 * A `rest` action ignores its resource — the environment recovers energy and
 * raises risk regardless of what was named — so two requests that differ only in
 * a meaningless resource field are one alternative, not two. Canonicalising here
 * is what keeps the space free of duplicates and keeps a candidate's identity
 * equal to the recorded action's identity when they are the same choice.
 */
export function canonicalAction(input: SimulationActionInput): SimulationActionInput {
  const action = SimulationActionInput.parse(input);
  if (action.type === 'rest') return { type: action.type, amount: action.amount };
  return action.resource === undefined
    ? { type: action.type, amount: action.amount }
    : { type: action.type, resource: action.resource, amount: action.amount };
}

/** Stable identity of an action: `type:resource:amount`, `-` when there is none. */
export function actionKey(input: SimulationActionInput): string {
  const action = canonicalAction(input);
  return `${action.type}:${action.resource ?? '-'}:${action.amount}`;
}

/**
 * Every action the vocabulary admits, in enumeration order.
 *
 * `rest` takes no resource, so it contributes one amount axis rather than three;
 * the other two types contribute type × resource × amount.
 */
export function enumerateActionSpace(): SimulationActionInput[] {
  const space: SimulationActionInput[] = [];
  for (const type of ACTION_TYPE_ORDER) {
    if (type === 'rest') {
      for (const amount of ACTION_AMOUNTS) space.push({ type, amount });
      continue;
    }
    for (const resource of ACTION_RESOURCE_ORDER)
      for (const amount of ACTION_AMOUNTS) space.push({ type, resource, amount });
  }
  return space;
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

function toCandidate(action: SimulationActionInput, evaluation: ActionEvaluation): ActionCandidate {
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
  return enumerateActionSpace().map((action) =>
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
