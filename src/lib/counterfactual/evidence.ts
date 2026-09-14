//
// This is the only place in the engine where a synthetic evaluation input is
// built, and it is the most consequential module in it: everything the evaluator
// is told about a branch is decided here. Two rules govern the construction, and
// they are the whole of the comparison policy.
//
//   DIFFERENT WHERE THE INTERVENTION COULD DIFFER. The action list, the final
//   state, the terminal status and the termination reason are the branch's own.
//   Those are precisely the things the choice being examined can change.
//
//   IDENTICAL EVERYWHERE ELSE. The initial state, the event trace, the tool
//   calls, the budget limit, the turn count, the turn budget and the scenario are
//   carried over verbatim from the recorded run. Holding them constant is what
//   makes the two verdicts comparable: they differ in the consequences of one
//   choice rather than in the provider behaviour that happened to accompany it. A
//   comparison that let the non-environment evidence vary would let a provider
//   fault be read as a consequence of a decision.
//
// Nothing here computes anything. The transition came from the environment's own
// validator, the continuation from the environment's own validator again, and the
// verdict below from the evaluation engine's own `evaluateRun` — the same
// function the evaluation endpoint serves a recorded run through. The solver of
// last resort for "is this branch any good?" is never this module.
//
// The branch is given an identity that says what it is. It is derived from the
// recorded run's id and is not a stored row; nothing in the engine writes it
// anywhere, and no report claims it was observed.

import { evaluateRun } from '@/lib/evaluation/evaluation';
import type { EvaluationInput, EvaluationResult } from '@/lib/evaluation/types';
import type { ActionCandidate } from './actions';
import {
  buildTrajectory,
  type CounterfactualTrajectory,
  counterfactualActionId,
} from './continuation';
import type { DecisionContext } from './decisions';

/** Identity of a derived branch: the recorded run, the decision, the choice. */
export function counterfactualBranchId(runId: string, decisionIndex: number, key: string): string {
  return `${counterfactualActionId(runId, decisionIndex, decisionIndex)}~${key}`;
}

/** A counterfactual branch, the evidence describing it, and its verdict. */
export interface CounterfactualEvidence {
  /** Deterministic identity of the branch — never a stored run id. */
  branchId: string;
  trajectory: CounterfactualTrajectory;
  input: EvaluationInput;
  evaluation: EvaluationResult;
}

/**
 * Build and score one counterfactual branch.
 *
 * Deterministic end to end: the same recorded evidence, the same decision point
 * and the same alternative produce the same branch, the same evidence and the
 * same verdict, on any machine and on any run of the analysis.
 */
export function counterfactualEvidence(input: {
  source: EvaluationInput;
  decision: DecisionContext;
  candidate: ActionCandidate;
}): CounterfactualEvidence {
  const { candidate, decision, source } = input;
  const decisionIndex = decision.point.index;
  const trajectory = buildTrajectory({
    source,
    decisionIndex,
    recorded: decision.recorded,
    candidate,
    before: decision.state,
  });
  const branchId = counterfactualBranchId(source.runId, decisionIndex, candidate.key);
  const evidence: EvaluationInput = {
    runId: branchId,
    status: trajectory.continuation.terminalStatus,
    state: trajectory.state,
    // Both branches start in the same world; the intervention happened later.
    initialState: source.initialState,
    actions: trajectory.actions,
    // Held constant. See the module comment: these are the quantities the
    // intervention could not have changed, and letting them vary would attribute
    // a provider's behaviour to a decision.
    events: source.events,
    toolCalls: source.toolCalls,
    budgetLimit: source.budgetLimit,
    turnCount: source.turnCount,
    maxTurns: source.maxTurns,
    terminationReason: trajectory.continuation.terminationReason,
    scenario: source.scenario ?? null,
    // Held constant like the fields above: the intervention changed a decision,
    // not which world the run was in, so scoring the branch under other constants
    // would report a difference the alternative action did not cause.
    scoringProfile: source.scoringProfile,
  };
  return { branchId, trajectory, input: evidence, evaluation: evaluateRun(evidence) };
}
