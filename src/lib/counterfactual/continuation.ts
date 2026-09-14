//
// A counterfactual is only as good as its answer to "and then what?". This
// module supplies that answer by replaying the run's own recorded attempts
// through the environment's own validator, from the world the alternative action
// produced. The policy is named — `replay-recorded-attempts-v1` — because a
// counterfactual stated without its continuation assumption is not a finding:
//
//   WHAT IT DOES. Every attempt the recorded run made after the decision point is
//   re-requested, in recorded order, against the counterfactual world — the
//   accepted ones and the refused ones alike, including any the run made after it
//   had already terminated. The environment answers each one afresh, so a request
//   the altered world can no longer satisfy is recorded as refused, and a request
//   it can now satisfy is recorded as accepted, rather than either being assumed.
//
//   WHY REFUSALS ARE REPLAYED TOO. The run's pattern of attempts is held constant
//   across branches, exactly as its event trace and tool calls are. Replaying only
//   the accepted transitions would hand every branch a cleaner record than the run
//   it is compared against — the evaluation engine counts rejected attempts, so a
//   branch that silently dropped the run's refusals would be scored on a run whose
//   agent never made them. Replaying the attempts and letting the environment
//   re-answer keeps that count a property of the choice rather than an artefact of
//   the policy. It also makes the policy's central check exact: with the recorded
//   choice replayed as its own alternative, the branch reproduces the recorded
//   run transition for transition, and the two verdicts are identical.
//
//   WHY THE REPLAY DOES NOT STOP AT TERMINATION. A branch that ends the run early
//   — by reaching the objective, say — still re-asks every remaining recorded
//   attempt, and a finished world refuses them. Stopping there instead would
//   compare the branch over a *prefix* of the attempt pattern the recorded run was
//   scored over, and would break the identity check above for any run the runtime
//   recorded an attempt after terminating. The engine reports this rather than
//   hiding it: `terminatedEarly` says the world ended before the attempt pattern
//   ran out, and `accepted`/`rejected` are counted separately so a branch that
//   succeeded early is not silently read as one that kept working.
//
//   WHAT IT DOES NOT DO. It does not re-run the agent, and it does not ask a
//   model what it would have done next. It does not model the runtime's per-turn
//   action allowance: an attempt the runtime refused before the environment ever
//   saw it is indistinguishable in persisted evidence from one the environment
//   refused, so it is re-asked of the environment and the environment's answer is
//   what the branch records. Each recorded attempt is also a decision point in
//   its own right, and is analysed as one.
//
// Nothing here reads a clock, a random source, a database or a provider, and no
// recorded value is mutated — every world this module produces is a new object
// returned by the environment's own pure transition.

import type {
  SimulationActionRecord,
  SimulationRunStatus,
  SimulationState,
} from '@/lib/contracts/simulation';
import { evaluateSimulationAction, getSimulationStatus } from '@/lib/environments/registry';
import type { EvaluationInput } from '@/lib/evaluation/types';
import { type ActionCandidate, canonicalAction } from './actions';
import type { CounterfactualContinuation, CounterfactualWorld } from './types';

/** How a counterfactual branch ends. */
export interface CounterfactualTerminal {
  status: SimulationRunStatus;
  terminationReason: string | null;
}

/**
 * The status a counterfactual branch ends in.
 *
 * The environment answers for itself first: a branch that reaches the objective,
 * exhausts its budget or breaches the risk threshold ends the way the
 * environment says it ends, regardless of how the recorded run finished. Only
 * when the environment leaves the branch RUNNING does the recorded run's own
 * ending carry over — and it carries over only for the endings that are *not*
 * environment-mediated. A run stopped by its turn budget, or by a provider fault
 * the runtime recorded, stopped for a reason the intervention could not have
 * changed; those are held constant along with the rest of the non-environment
 * evidence (`COMPARISON_POLICY`). Everything else is a snapshot, reported as
 * RUNNING, which is what a branch the environment never terminated actually is.
 */
export function counterfactualTerminal(
  source: EvaluationInput,
  state: SimulationState,
): CounterfactualTerminal {
  const environment = getSimulationStatus(state);
  if (environment.status !== 'RUNNING')
    return { status: environment.status, terminationReason: environment.terminationReason };
  if (source.status === 'LIMIT_REACHED' || source.status === 'ERROR' || source.status === 'TIMEOUT')
    return { status: source.status, terminationReason: source.terminationReason };
  return { status: 'RUNNING', terminationReason: null };
}

/** A stored state, projected to the quantities a reader compares. */
export function projectWorld(state: SimulationState): CounterfactualWorld {
  return {
    step: state.step,
    progress: state.progress,
    target: state.target,
    objectiveReached: state.progress >= state.target,
    risk: state.risk,
    maxRisk: state.maxRisk,
    budgetSpent: state.budgetSpent,
    budgetRemaining: state.budgetRemaining,
    resources: { ...state.resources },
    completedTasks: state.tasks.filter((task) => task.complete).length,
  };
}

/** Identity of a derived record. Deterministic and plainly not a stored id. */
export function counterfactualActionId(runId: string, decisionIndex: number, slot: number): string {
  return `${runId}~cf${decisionIndex}~${slot}`;
}

/**
 * Build the record an intervention would have written had the agent chosen the
 * alternative.
 *
 * The shape is the one the agent runtime persists — the same fields, the same
 * meaning — so the evaluation engine reads a counterfactual trajectory through
 * exactly the code path it reads a recorded one through. The timestamp is the
 * recorded request's own, not a new one: the alternative would have been chosen
 * at that moment, and `new Date()` here would make the same analysis produce
 * different bytes on a second run.
 */
function interventionRecord(input: {
  source: EvaluationInput;
  decisionIndex: number;
  recorded: SimulationActionRecord;
  candidate: ActionCandidate;
  before: SimulationState;
}): SimulationActionRecord {
  const { before, candidate, decisionIndex, recorded, source } = input;
  return {
    id: counterfactualActionId(source.runId, decisionIndex, decisionIndex),
    step: recorded.step,
    type: candidate.action.type,
    input: candidate.action,
    source: recorded.source,
    accepted: true,
    rejectionReason: null,
    observation: candidate.observation,
    stateDiff: { before, after: candidate.state },
    resultingState: candidate.state,
    createdAt: recorded.createdAt,
  };
}

/** A replayed transition, recorded the way the runtime would have recorded it. */
function replayRecord(input: {
  source: EvaluationInput;
  decisionIndex: number;
  recorded: SimulationActionRecord;
  before: SimulationState;
  slot: number;
}): { record: SimulationActionRecord; after: SimulationState; accepted: boolean } {
  const { before, decisionIndex, recorded, slot, source } = input;
  const action = canonicalAction(recorded.input);
  const evaluation = evaluateSimulationAction(before, action);
  const after = evaluation.accepted ? evaluation.state : before;
  return {
    accepted: evaluation.accepted,
    after,
    record: {
      id: counterfactualActionId(source.runId, decisionIndex, slot),
      step: before.step,
      type: action.type,
      input: action,
      source: recorded.source,
      accepted: evaluation.accepted,
      rejectionReason: evaluation.rejectionReason,
      observation: evaluation.observation,
      stateDiff: { before, after },
      resultingState: after,
      createdAt: recorded.createdAt,
    },
  };
}

/** The counterfactual branch: the world it reaches and how it got there. */
export interface CounterfactualTrajectory {
  /** The whole action list the counterfactual evaluation reads. */
  actions: SimulationActionRecord[];
  /** The world after the intervention and the continuation. */
  state: SimulationState;
  continuation: CounterfactualContinuation;
}

/**
 * Build one counterfactual branch.
 *
 * The actions recorded *before* the decision point are carried over verbatim:
 * they are the past, and the intervention cannot change what already happened.
 * They are therefore identical in both branches, which is what makes the two
 * evaluations differ only in the consequences of the choice being examined.
 */
export function buildTrajectory(input: {
  source: EvaluationInput;
  decisionIndex: number;
  recorded: SimulationActionRecord;
  candidate: ActionCandidate;
  before: SimulationState;
}): CounterfactualTrajectory {
  const { before, candidate, decisionIndex, recorded, source } = input;
  const actions: SimulationActionRecord[] = [
    ...source.actions.slice(0, decisionIndex),
    interventionRecord({ source, decisionIndex, recorded, candidate, before }),
  ];

  let state = candidate.state;
  let replayed = 0;
  let accepted = 0;
  let rejected = 0;
  /** The world ended while the attempt pattern still had attempts left to make. */
  let terminatedEarly = false;

  const remaining = source.actions.slice(decisionIndex + 1);
  for (const next of remaining) {
    if (getSimulationStatus(state).status !== 'RUNNING') terminatedEarly = true;
    const outcome = replayRecord({
      source,
      decisionIndex,
      recorded: next,
      before: state,
      slot: actions.length,
    });
    if (outcome.accepted) accepted += 1;
    else rejected += 1;
    replayed += 1;
    state = outcome.after;
    actions.push(outcome.record);
  }

  const terminal = counterfactualTerminal(source, state);
  return {
    actions,
    state,
    continuation: {
      policy: 'replay-recorded-attempts-v1',
      replayed,
      accepted,
      rejected,
      terminatedEarly,
      terminalStatus: terminal.status,
      terminationReason: terminal.terminationReason,
    },
  };
}
