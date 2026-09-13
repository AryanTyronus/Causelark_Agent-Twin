//
// This is the only file in `src/lib/counterfactual/` that touches anything
// outside the process's own memory, and it touches exactly two seams:
//
//   persistence → `loadRun`, the same owner-scoped read every run endpoint uses
//   evaluation  → `toEvaluationInput`, the same mapping the evaluation endpoint
//                 scores a run through
//
// It opens no database client of its own, writes nothing, creates no run, and
// runs no agent. A counterfactual is a statement *about* a run, computed from
// what the run recorded; it is never a second simulation, and nothing here could
// produce evidence that did not already exist.
//
// The rest of the engine — the action space, the continuation, the comparison,
// the report — is a pure fold over the evidence this file hands it.

import 'server-only';

import { toEvaluationInput } from '@/lib/business/simulation-evaluation';
import { loadRun } from '@/lib/business/simulation-persistence';
import { analyzeCounterfactuals, analyzeDecisionAt } from './counterfactual';
import type { CounterfactualDecisionAnalysis, CounterfactualReport } from './types';

export interface CounterfactualAnalysisRequest {
  runId: string;
  /** The signed-in owner the run must belong to. */
  ownerId: string;
  /** Analyse one decision point instead of the whole run. */
  decisionIndex?: number | null;
}

/**
 * The two shapes a request can produce. Discriminated rather than nullable in
 * both directions, so a caller serving one cannot accidentally serve the other.
 */
export type CounterfactualAnalysisOutcome =
  | { kind: 'report'; report: CounterfactualReport }
  | { kind: 'decision'; analysis: CounterfactualDecisionAnalysis };

/**
 * Analyse a persisted run's counterfactuals.
 *
 * Returns `null` when the run is not the owner's or does not exist — the same
 * single answer the other run endpoints give, so a caller cannot use this
 * endpoint to learn whether someone else's run id exists.
 *
 * Errors the engine raises — a trace too large to analyse, a decision index the
 * run does not have — propagate as `CounterfactualError` for the caller to map
 * onto a status.
 */
export async function analyzePersistedCounterfactual(
  request: CounterfactualAnalysisRequest,
): Promise<CounterfactualAnalysisOutcome | null> {
  const run = await loadRun(request.runId, request.ownerId);
  if (!run) return null;
  const source = toEvaluationInput(run);
  if (request.decisionIndex !== undefined && request.decisionIndex !== null)
    return { kind: 'decision', analysis: analyzeDecisionAt(source, request.decisionIndex) };
  return { kind: 'report', report: analyzeCounterfactuals(source).report };
}
