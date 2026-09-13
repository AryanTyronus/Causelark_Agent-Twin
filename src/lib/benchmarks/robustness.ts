//
// The question this answers is narrow and specific: *how much of the score a
// condition achieved under the baseline environment survives when the
// environment changes?* It is deliberately not the average score. An agent that
// scores 40 everywhere is perfectly robust and poor; an agent that scores 95 at
// baseline and 30 under scarcity averages 62 and is fragile. Robustness is a
// statement about the *difference*, so the baseline condition is the reference
// and the perturbations are what is measured against it.
//
// THE FORMULA (version `baseline-retention-v1`):
//
//   baselineScore       = mean overall score of the baseline scenario's cases
//   scenarioScore       = mean overall score of that scenario's cases
//   degradation         = baselineScore - scenarioScore     (per perturbed scenario)
//   relativeDegradation = degradation / baselineScore
//   retention           = scenarioScore / baselineScore, capped at 1
//   robustnessScore     = mean retention over the perturbed scenarios with evidence
//
// It is reported at `BENCHMARK_METRIC_PRECISION` decimal places, computed in
// exact hundredths from the same reported scores the result prints beside it —
// so every number here can be recomputed by hand from the row above it.
//
// Three properties are chosen rather than discovered, and are stated so nobody
// has to reverse-engineer them from the arithmetic:
//
// 1. **Retention is capped at 1.** A robustness score answers how much of the
//    baseline was *kept*; there is no such thing as keeping more of it than
//    there was. Improvement is not hidden — it shows up as a negative
//    `absoluteDegradation` on that scenario, and in its raw score.
// 2. **The baseline's own retention is not averaged in.** It is 1 by
//    construction, and counting it would inflate the metric by a share
//    proportional to how few perturbations a benchmark happens to declare. The
//    baseline is the reference, not a perturbation.
// 3. **A zero baseline yields no robustness score.** If the baseline scored zero
//    the ratio does not exist — it is neither 0 nor 1 — so the report says
//    `ZERO_BASELINE` rather than manufacturing a number. Degradation is still
//    reported, because subtraction is still defined.
//
// This is Agent Twin's current deterministic robustness metric. It is not a
// universal scientific quantity, it is not comparable across benchmark
// definitions, and it is not claimed to be either.

import { aggregateDimensions, worstCaseStatus } from './aggregation';
import { meanScore, meanUnits, ratioScore, SCORE_SCALE, toScoreUnits } from './arithmetic';
import {
  BENCHMARK_BASELINE_SCENARIO_ID,
  BENCHMARK_ROBUSTNESS_FORMULA,
  type BenchmarkDefinition,
  type BenchmarkRun,
  type RobustnessReport,
  type RobustnessUnavailableReason,
  type ScenarioDegradation,
} from './types';

/** `score / baseline`, capped at 1. `null` when the baseline is zero. */
export function retentionOf(score: number, baselineScore: number): number | null {
  const ratio = ratioScore(score, baselineScore);
  if (ratio === null) return null;
  return ratio > 1 ? 1 : ratio;
}

/**
 * Build one row per declared scenario, in the definition's own scenario order,
 * each carrying its mean scores and its degradation against the baseline.
 *
 * A row exists for every declared scenario even when that scenario yielded no
 * evidence, so a condition that produced nothing is visibly absent rather than
 * quietly dropped from the denominator.
 */
export function buildScenarioDegradations(
  definition: BenchmarkDefinition,
  runs: readonly BenchmarkRun[],
): ScenarioDegradation[] {
  const perScenario = definition.scenarios.map((reference) => {
    const cases = runs.filter((run) => run.case.scenarioId === reference.id);
    const scores: number[] = [];
    for (const entry of cases) {
      if (entry.evaluation) scores.push(entry.evaluation.overallScore);
    }
    const dimensions = aggregateDimensions(cases);
    return {
      scenarioId: reference.id,
      scenarioVersion: reference.version,
      isBaseline: reference.id === BENCHMARK_BASELINE_SCENARIO_ID,
      score: meanScore(scores),
      taskScore: dimensions.averageTaskScore,
      safetyScore: dimensions.averageSafetyScore,
      efficiencyScore: dimensions.averageEfficiencyScore,
      resourceScore: dimensions.averageResourceScore,
      reliabilityScore: dimensions.averageReliabilityScore,
      caseCount: cases.length,
      evaluatedCount: scores.length,
      runStatus: worstCaseStatus(cases.map((entry) => entry.status)),
    };
  });

  const baselineScore = perScenario.find((row) => row.isBaseline)?.score ?? null;

  return perScenario.map((row) => {
    // Degradation is defined over the *reported* scores, not over an unrounded
    // intermediate, so the printed numbers always reconcile: an auditor can
    // subtract the two values in the row and get the degradation beside them.
    // The subtraction itself happens in integer hundredths.
    const scenarioScore = row.score;
    if (baselineScore === null || scenarioScore === null)
      return {
        ...row,
        baselineScore,
        absoluteDegradation: null,
        relativeDegradation: null,
        retention: null,
      };

    const degradationUnits = toScoreUnits(baselineScore) - toScoreUnits(scenarioScore);
    return {
      ...row,
      baselineScore,
      absoluteDegradation: degradationUnits / SCORE_SCALE,
      relativeDegradation: ratioScore(baselineScore - scenarioScore, baselineScore),
      retention: retentionOf(scenarioScore, baselineScore),
    };
  });
}

/**
 * Reduce a scenario table to the robustness report.
 *
 * The baseline is read out of the same table that carries it, never recomputed,
 * so the report and the row it summarises cannot disagree.
 */
export function measureRobustness(rows: readonly ScenarioDegradation[]): RobustnessReport {
  const baselineRow = rows.find((row) => row.isBaseline);
  const baselineScore = baselineRow?.score ?? null;
  const perturbed = rows.filter((row) => !row.isBaseline);

  const evaluated = rows.filter(
    (row): row is ScenarioDegradation & { score: number } => row.score !== null,
  );
  const evaluatedPerturbed = perturbed.filter(
    (row): row is ScenarioDegradation & { score: number } => row.score !== null,
  );
  const degradations = evaluatedPerturbed
    .map((row) => row.absoluteDegradation)
    .filter((value): value is number => value !== null);

  // The ratio-based score is the only part that can be undefined. Everything
  // else is reported whenever its own inputs exist.
  let robustnessScore: number | null = null;
  let unavailableReason: RobustnessUnavailableReason | null = null;
  if (!baselineRow) unavailableReason = 'MISSING_BASELINE';
  else if (baselineScore === null) unavailableReason = 'NO_EVALUATED_BASELINE';
  else if (perturbed.length === 0) unavailableReason = 'NO_PERTURBED_SCENARIOS';
  else if (evaluatedPerturbed.length === 0) unavailableReason = 'NO_EVALUATED_SCENARIOS';
  else if (baselineScore === 0) unavailableReason = 'ZERO_BASELINE';
  else {
    const retentionUnits = evaluatedPerturbed.map((row) => toScoreUnits(row.retention ?? 0));
    const mean = meanUnits(retentionUnits);
    robustnessScore = mean === null ? null : mean / SCORE_SCALE;
  }

  return {
    formula: BENCHMARK_ROBUSTNESS_FORMULA,
    baselineScenarioId: baselineRow?.scenarioId ?? null,
    baselineScore,
    averageScenarioScore: meanScore(evaluated.map((row) => row.score)),
    worstScenarioScore: lowestScore(rows)?.score ?? null,
    averageDegradation: meanScore(degradations),
    worstDegradation: degradations.length === 0 ? null : Math.max(...degradations),
    robustnessScore,
    unavailableReason,
    worstScenarioId: lowestScore(rows)?.scenarioId ?? null,
    bestNonBaselineScenarioId: highestScore(evaluatedPerturbed)?.scenarioId ?? null,
    greatestDegradationScenarioId: largestDegradation(evaluatedPerturbed)?.scenarioId ?? null,
    evaluatedScenarioCount: evaluated.length,
    perturbedScenarioCount: perturbed.length,
  };
}

/**
 * The scenario with the lowest score, over every row that has one. Ties break
 * toward the earlier row — the benchmark definition's own scenario order —
 * because the reduction keeps the first minimum it sees rather than sorting on
 * an unstable key.
 */
function lowestScore(rows: readonly ScenarioDegradation[]): ScenarioDegradation | null {
  let lowest: ScenarioDegradation | null = null;
  for (const row of rows) {
    if (row.score === null) continue;
    if (lowest === null || lowest.score === null || row.score < lowest.score) lowest = row;
  }
  return lowest;
}

/** The evaluated perturbed scenario with the highest score; ties keep the earlier. */
function highestScore(rows: readonly ScenarioDegradation[]): ScenarioDegradation | null {
  let highest: ScenarioDegradation | null = null;
  for (const row of rows) {
    if (row.score === null) continue;
    if (highest === null || highest.score === null || row.score > highest.score) highest = row;
  }
  return highest;
}

/** The evaluated perturbed scenario that lost the most; ties keep the earlier. */
function largestDegradation(rows: readonly ScenarioDegradation[]): ScenarioDegradation | null {
  let worst: ScenarioDegradation | null = null;
  for (const row of rows) {
    const value = row.absoluteDegradation;
    if (value === null) continue;
    if (worst === null || worst.absoluteDegradation === null || value > worst.absoluteDegradation)
      worst = row;
  }
  return worst;
}
