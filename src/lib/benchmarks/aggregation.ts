// @polsia:user-owned — benchmark aggregation.
//
// Everything here is a fold over the EvaluationResults a benchmark's runs
// produced. Nothing is re-simulated, nothing is asked of a model, and no score
// is invented: if a case has no evaluation its contribution is absent, so a
// dimension with no evidence is reported as `null` rather than as zero.
//
// The evaluation engine's arithmetic is the authority. Category and overall
// scores arrive already rounded to 0–100 integers, so this layer only ever
// averages integers — and it does so in exact hundredths, rounding once at the
// boundary. See `arithmetic.ts` for the rounding rule.

import type { EvaluationCategory } from '@/lib/evaluation/types';
import { maximumScore, meanScore, minimumScore } from './arithmetic';
import { type BenchmarkCaseStatus, type BenchmarkRun, CASE_STATUS_SEVERITY } from './types';

/** The evaluation category whose score is reported as each dimension. */
const DIMENSION_CATEGORIES = {
  taskScore: 'taskSuccess',
  safetyScore: 'safety',
  efficiencyScore: 'efficiency',
  resourceScore: 'resourceManagement',
  reliabilityScore: 'reliability',
} as const satisfies Record<string, EvaluationCategory>;

export type BenchmarkDimensionField = keyof typeof DIMENSION_CATEGORIES;

/** Every overall score recorded, in matrix order. */
function overallScores(runs: readonly BenchmarkRun[]): number[] {
  const scores: number[] = [];
  for (const run of runs) {
    if (run.evaluation) scores.push(run.evaluation.overallScore);
  }
  return scores;
}

/** Every score recorded under one evaluation category, in matrix order. */
function categoryScores(runs: readonly BenchmarkRun[], category: EvaluationCategory): number[] {
  const scores: number[] = [];
  for (const run of runs) {
    if (!run.evaluation) continue;
    const match = run.evaluation.categories.find((entry) => entry.category === category);
    if (match) scores.push(match.score);
  }
  return scores;
}

/** One dimension's mean across a set of cases, or `null` with no evidence. */
export function dimensionMean(
  runs: readonly BenchmarkRun[],
  field: BenchmarkDimensionField,
): number | null {
  return meanScore(categoryScores(runs, DIMENSION_CATEGORIES[field]));
}

/** The aggregate score block: the overall distribution plus the five dimension means. */
export function aggregateDimensions(runs: readonly BenchmarkRun[]) {
  const overall = overallScores(runs);
  return {
    evaluatedCaseCount: overall.length,
    averageOverallScore: meanScore(overall),
    minimumOverallScore: minimumScore(overall),
    maximumOverallScore: maximumScore(overall),
    averageTaskScore: dimensionMean(runs, 'taskScore'),
    averageSafetyScore: dimensionMean(runs, 'safetyScore'),
    averageEfficiencyScore: dimensionMean(runs, 'efficiencyScore'),
    averageResourceScore: dimensionMean(runs, 'resourceScore'),
    averageReliabilityScore: dimensionMean(runs, 'reliabilityScore'),
  };
}

/**
 * The worst status any of a set of cases reached.
 *
 * `CASE_STATUS_SEVERITY` is declared worst-first, so the lowest index wins: the
 * reduction is a minimum over a fixed declared order rather than a comparator
 * invented here. Ties are impossible, because each status occupies exactly one
 * slot in that order.
 */
export function worstCaseStatus(
  statuses: readonly BenchmarkCaseStatus[],
): BenchmarkCaseStatus | null {
  let worst: BenchmarkCaseStatus | null = null;
  let worstRank = Number.POSITIVE_INFINITY;
  for (const status of statuses) {
    const rank = CASE_STATUS_SEVERITY.indexOf(status);
    if (rank < worstRank) {
      worstRank = rank;
      worst = status;
    }
  }
  return worst;
}

/**
 * The three-way split the report keeps alongside the raw status counts.
 *
 * `LIMIT_REACHED` counts as a success and `RUNNING` as still in progress, which
 * mirrors the evaluation engine: reaching a bound is an intended termination,
 * while a fault or a timeout is not. `UNAVAILABLE` is its own outcome, because
 * a case with no readable evidence is neither.
 */
export function outcomeOf(status: BenchmarkCaseStatus) {
  if (status === 'COMPLETED' || status === 'LIMIT_REACHED') return 'succeeded' as const;
  if (status === 'FAILED' || status === 'TIMEOUT' || status === 'ERROR')
    return 'unsuccessful' as const;
  if (status === 'UNAVAILABLE') return 'unavailable' as const;
  return 'inProgress' as const;
}
