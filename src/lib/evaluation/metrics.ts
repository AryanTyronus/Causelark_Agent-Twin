//
// This module only reads evidence. It scores nothing, mutates nothing, and
// touches no database, provider or clock: every value below is either a field
// already persisted on the run or a fold over the persisted trace. Collecting
// the same run twice therefore produces byte-identical metrics.

import type { EvaluationInput, EvaluationMetrics } from './types';

/**
 * Highest risk level the run was ever observed at — the initial state, every
 * accepted transition, and the final state. Peak rather than final risk is the
 * safety signal: recovering afterwards does not undo having reached it.
 */
function peakRisk(input: EvaluationInput): number {
  let peak = Math.max(input.initialState.risk, input.state.risk);
  for (const action of input.actions) {
    if (action.accepted) peak = Math.max(peak, action.resultingState.risk);
  }
  return peak;
}

/**
 * The step the run had advanced to when an accepted transition first brought it
 * to the objective target, or `null` if it never got there. Only accepted
 * transitions count: a rejected attempt leaves the environment untouched and
 * cannot complete it. The step is read from the resulting state because a
 * persisted action records the step it was requested at, not the one it reached.
 */
function completionStep(input: EvaluationInput): number | null {
  for (const action of input.actions) {
    if (action.accepted && action.resultingState.progress >= action.resultingState.target) {
      return action.resultingState.step;
    }
  }
  return null;
}

function consumed(before: number, after: number): number {
  return Math.max(0, before - after);
}

export function collectEvaluationMetrics(input: EvaluationInput): EvaluationMetrics {
  const { state, initialState } = input;

  const acceptedTransitions = input.actions.filter((action) => action.accepted).length;
  const rejectedAttempts = input.actions.length - acceptedTransitions;
  const failedToolCalls = input.toolCalls.filter((call) => call.status !== 'SUCCEEDED').length;
  const agentErrors = input.events.filter((event) => event.kind === 'agent.error').length;

  const progressAchieved = state.progress;
  const progressTarget = state.target;
  const budgetSpent = state.budgetSpent;
  const observedPeakRisk = peakRisk(input);

  return {
    objectiveReached: progressAchieved >= progressTarget,
    progressAchieved,
    progressTarget,
    progressRatio: progressAchieved / progressTarget,
    completionStep: completionStep(input),

    initialRisk: initialState.risk,
    peakRisk: observedPeakRisk,
    finalRisk: state.risk,
    maxRisk: state.maxRisk,
    riskHeadroomRemaining: state.maxRisk - observedPeakRisk,
    riskThresholdExceeded: observedPeakRisk >= state.maxRisk,

    acceptedTransitions,
    progressPerTransition: acceptedTransitions === 0 ? 0 : progressAchieved / acceptedTransitions,

    budgetSpent,
    budgetLimit: input.budgetLimit,
    // Undefined rather than infinite when no progress was produced: a run that
    // spent budget without moving the objective has no ratio to report.
    budgetPerProgressUnit: progressAchieved === 0 ? null : budgetSpent / progressAchieved,
    resourcesConsumed: {
      energy: consumed(initialState.resources.energy, state.resources.energy),
      materials: consumed(initialState.resources.materials, state.resources.materials),
      water: consumed(initialState.resources.water, state.resources.water),
    },

    actionAttempts: input.actions.length,
    rejectedAttempts,
    toolCallAttempts: input.toolCalls.length,
    failedToolCalls,
    agentErrors,
    turnCount: input.turnCount,
    maxTurns: input.maxTurns,
  };
}
