//
// The mapping from a stored run row to `EvaluationInput` lives here, in one
// place, because three callers need it and they must not drift: the evaluation
// endpoint, which serves a single run's verdict; benchmark execution, which
// evaluates every case it ran; and counterfactual analysis, which needs the
// evidence set itself rather than a verdict, so that it can build an alternative
// branch and score *that* through the same evaluator. Callers that mapped
// evidence differently would be reporting on runs nobody else can see.
//
// Nothing about the *scoring* is here — that is `src/lib/evaluation`. This is
// only deserialization: the run's own columns, read back through the contracts.

import {
  SimulationConfiguration,
  SimulationRunStatus,
  SimulationState,
} from '@/lib/contracts/simulation';
import { simulationEnvironment } from '@/lib/environments/registry';
import { evaluateRun } from '@/lib/evaluation/evaluation';
import type { EvaluationInput, EvaluationResult } from '@/lib/evaluation/types';
import { DEFAULT_CONFIGURATION } from './simulation';
import {
  type PersistedRun,
  toAction,
  toEvent,
  toScenarioIdentity,
  toToolCall,
} from './simulation-persistence';

/**
 * Describe a persisted run to the evaluator.
 *
 * A run with no `initialState` column falls back to its current state, which is
 * what the evaluation endpoint has always done: the column is nullable for rows
 * created before it existed.
 */
export function toEvaluationInput(run: PersistedRun): EvaluationInput {
  const state = SimulationState.parse(run.state);
  return {
    runId: run.id,
    status: SimulationRunStatus.parse(run.status),
    state,
    // The world that produced the evidence declares the constants its own scores
    // are normalised against, so a trading run is measured against the pace the
    // trading objective demands rather than the resource world's per-action
    // ceiling. Resolved from the state rather than a parameter: the state is the
    // only trustworthy witness to which world a persisted run belongs to, and
    // every caller of this mapping therefore gets it right without asking.
    scoringProfile: simulationEnvironment(state.environmentKey).scoring,
    initialState: SimulationState.parse(run.initialState ?? run.state),
    actions: run.actions.map(toAction),
    events: run.events.map(toEvent),
    toolCalls: run.toolCalls.map(toToolCall),
    budgetLimit: run.budgetLimit,
    turnCount: run.turnCount,
    maxTurns:
      run.maxTurns ||
      SimulationConfiguration.parse(run.configuration ?? DEFAULT_CONFIGURATION).maxTurns,
    terminationReason: run.terminationReason,
    // Context, not input to a score: it lets a verdict be labelled with the
    // condition it was measured under.
    scenario: toScenarioIdentity(run),
  };
}

/**
 * Evaluate a persisted run from the evidence it recorded.
 *
 * The verdict is the evaluation engine's; this composes the two steps so every
 * caller reads a run the same way.
 */
export function evaluatePersistedRun(run: PersistedRun): EvaluationResult {
  return evaluateRun(toEvaluationInput(run));
}
