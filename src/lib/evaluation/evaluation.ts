//
// A run is evaluated from what it persisted and nothing else. The environment
// produces the evidence; this module computes the verdict. It never invokes a
// model, never calls a provider, never mutates simulation state, actions,
// events or replay data, and reads no clock, no randomness and no external
// service — so evaluating the same persisted run twice returns the same result.
//
// The verdict is not an opinion about whether the agent "was good". It is a set
// of five numbers, each normalized to 0–100, each accompanied by the persisted
// quantities it was computed from, combined with weights that are exported
// constants and repeated in the output.

import { collectEvaluationMetrics } from './metrics';
import { DEFAULT_SCORING_PROFILE, scoreEvaluation, scoreOverall } from './scoring';
import { type EvaluationInput, EvaluationResult } from './types';

/**
 * Evaluate one persisted run.
 *
 * Pure and deterministic: `evaluateRun(input)` twice over the same evidence
 * returns deep-equal results. The result carries the raw metric set alongside
 * the scores so any number can be traced back to the data that produced it.
 */
export function evaluateRun(input: EvaluationInput): EvaluationResult {
  const metrics = collectEvaluationMetrics(input);
  // The world's own constants, or the resource-routing ones this engine has
  // always used. Never a lookup behind the evidence: two runs scored from the
  // same input must produce the same verdict, and a profile read from ambient
  // state could change between them.
  const categories = scoreEvaluation(metrics, input.scoringProfile ?? DEFAULT_SCORING_PROFILE);
  return EvaluationResult.parse({
    runId: input.runId,
    status: input.status,
    // Echoed for attribution only — no scorer reads it, so a scenario run and an
    // unscenarioed run with the same evidence score identically.
    scenario: input.scenario ?? null,
    terminationReason: input.terminationReason,
    categories,
    overallScore: scoreOverall(categories),
    metrics,
  });
}

export { collectEvaluationMetrics } from './metrics';
export {
  DEFAULT_SCORING_PROFILE,
  EFFICIENCY_WEIGHT,
  MAX_CATEGORY_SCORE,
  MAX_PROGRESS_PER_TRANSITION,
  MIN_CATEGORY_SCORE,
  OPTIMAL_BUDGET_PER_PROGRESS_UNIT,
  RELIABILITY_WEIGHT,
  RESOURCE_MANAGEMENT_WEIGHT,
  SAFETY_WEIGHT,
  scoreEvaluation,
  scoreOverall,
  TASK_SUCCESS_WEIGHT,
} from './scoring';
export * from './types';
