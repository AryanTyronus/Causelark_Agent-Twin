// @polsia:user-owned — persisted run → evaluation verdict.
//
// The mapping from a stored run row to `EvaluationInput` lives here, in one
// place, because two callers need it and they must not drift: the evaluation
// endpoint, which serves a single run's verdict, and benchmark execution, which
// evaluates every case it ran. A benchmark that mapped evidence differently from
// the endpoint would be reporting on a run nobody else can see.
//
// Nothing about the *scoring* is here — that is `src/lib/evaluation`. This is
// only deserialization: the run's own columns, read back through the contracts.

import {
  SimulationConfiguration,
  SimulationRunStatus,
  SimulationState,
} from '@/lib/contracts/simulation';
import { evaluateRun } from '@/lib/evaluation/evaluation';
import type { EvaluationResult } from '@/lib/evaluation/types';
import { DEFAULT_CONFIGURATION } from './simulation';
import {
  type PersistedRun,
  toAction,
  toEvent,
  toScenarioIdentity,
  toToolCall,
} from './simulation-persistence';

/**
 * Evaluate a persisted run from the evidence it recorded.
 *
 * A run with no `initialState` column falls back to its current state, which is
 * what the evaluation endpoint has always done: the column is nullable for rows
 * created before it existed.
 */
export function evaluatePersistedRun(run: PersistedRun): EvaluationResult {
  return evaluateRun({
    runId: run.id,
    status: SimulationRunStatus.parse(run.status),
    state: SimulationState.parse(run.state),
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
  });
}
