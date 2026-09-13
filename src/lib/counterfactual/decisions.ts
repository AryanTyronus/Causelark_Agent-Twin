// @polsia:user-owned — decision points, read out of persisted evidence.
//
// A decision point is not a concept the environment persists; it is read out of
// the trace. Every action the run recorded is a moment where something chose one
// action out of the ones available, and the state to perturb is the state that
// action was requested against — the previous action's resulting state, or the
// run's recorded initial state for the first one. That derivation is exact
// rather than approximate: the runtime persists each action's resulting state,
// and a refused action's resulting state is the state it was refused against.
//
// Attempts the *runtime* refused before the environment saw them are decision
// points too, and are reported with the outcome they recorded. Nothing here
// claims an environment verdict for an action the environment never received;
// what is analysisable is the choice, which happened either way.
//
// Nothing here reads a clock, a random source, a database or a provider.

import { type SimulationActionRecord, SimulationState } from '@/lib/contracts/simulation';
import type { EvaluationInput } from '@/lib/evaluation/types';
import { canonicalAction } from './actions';
import {
  type CounterfactualDecisionPoint,
  CounterfactualError,
  MAX_COUNTERFACTUAL_DECISIONS,
} from './types';

/** One recorded decision: the choice, and the world it was made against. */
export interface DecisionContext {
  point: CounterfactualDecisionPoint;
  /** The state the action was requested against — what any alternative meets. */
  state: SimulationState;
  recorded: SimulationActionRecord;
}

/**
 * Prove the evidence can carry a counterfactual analysis.
 *
 * Two things are checked, and both are refusals rather than truncations: a state
 * that does not parse means the trace cannot be transitioned from at all, and a
 * trace longer than the engine's bound is refused outright because a report that
 * silently analysed part of a run would read as a statement about the whole of
 * it. The bound is far above what the runtime can produce — a run is capped by
 * its own turn and step budgets — so only hand-edited evidence can reach it.
 */
export function assertAnalysable(source: EvaluationInput): void {
  try {
    SimulationState.parse(source.initialState);
    SimulationState.parse(source.state);
  } catch {
    throw new CounterfactualError(
      'INVALID_SOURCE',
      'The run evidence does not contain a valid simulation state, so no counterfactual can be transitioned from it.',
    );
  }
  if (source.actions.length > MAX_COUNTERFACTUAL_DECISIONS)
    throw new CounterfactualError(
      'TOO_MANY_DECISIONS',
      `This run recorded ${source.actions.length} actions; analysis is bounded at ${MAX_COUNTERFACTUAL_DECISIONS} decision points.`,
    );
  const inconsistent = source.actions.findIndex(
    (action) => !SimulationState.safeParse(action.resultingState).success,
  );
  if (inconsistent !== -1)
    throw new CounterfactualError(
      'INVALID_SOURCE',
      `The action recorded at position ${inconsistent} has no usable resulting state, so the decisions after it cannot be placed in a world.`,
    );
}

/**
 * Every recorded action, in recorded order, with the world it met.
 *
 * Order is the evidence's own order — the persistence layer orders actions by
 * step and creation time — so the analysis follows the run rather than a second
 * ordering invented here.
 */
export function extractDecisionPoints(source: EvaluationInput): DecisionContext[] {
  assertAnalysable(source);
  return source.actions.map((recorded, index) => {
    // `assertAnalysable` has already proved every recorded action carries a
    // usable resulting state, so the fallback below is for the type checker's
    // benefit under `noUncheckedIndexedAccess`, not a path that can be taken.
    const previous = source.actions[index - 1]?.resultingState ?? source.initialState;
    return {
      recorded,
      state: index === 0 ? source.initialState : previous,
      point: {
        index,
        actionId: recorded.id,
        step: recorded.step,
        source: recorded.source,
        action: canonicalAction(recorded.input),
        accepted: recorded.accepted,
        rejectionReason: recorded.rejectionReason,
        observation: recorded.observation,
      },
    };
  });
}

/** One decision point by index, or a refusal that names the index asked for. */
export function decisionAt(source: EvaluationInput, index: number): DecisionContext {
  const decisions = extractDecisionPoints(source);
  const match = decisions.find((decision) => decision.point.index === index);
  if (!match)
    throw new CounterfactualError(
      'UNKNOWN_DECISION',
      `This run has ${decisions.length} decision points; there is no decision at index ${index}.`,
    );
  return match;
}
