//
// `reportBenchmark` is the whole of Phase 3's pure surface: a benchmark
// definition plus the runs it produced, in, and a `BenchmarkResult` out. It is a
// deterministic function of those two things — same definition, same
// evaluations, same bytes out — with no clock, no randomness, no model call and
// no database read anywhere beneath it.
//
// It is strict about one thing in particular: every run it is handed must belong
// to the definition's own matrix. A run from a different benchmark, or from a
// scenario the definition does not declare, is refused rather than folded in.
// Aggregating evidence that does not belong to the experiment would produce a
// number about nothing.

import { aggregateDimensions, type outcomeOf } from './aggregation';
import { analyseFailures } from './failures';
import { buildRunMatrix } from './matrix';
import { buildScenarioDegradations, measureRobustness } from './robustness';
import {
  type BenchmarkAgentConfiguration,
  type BenchmarkCaseSummary,
  type BenchmarkDefinition,
  BenchmarkError,
  BenchmarkResult,
  type BenchmarkRun,
} from './types';

export interface BenchmarkReportOptions {
  /** The seed set the definition declared, when the executed set was overridden. */
  declaredSeeds?: readonly number[];
}

/** Counts over the matrix, derived from the runs and from nothing else. */
export function summariseCases(
  definition: BenchmarkDefinition,
  runs: readonly BenchmarkRun[],
): BenchmarkCaseSummary {
  const matrix = buildRunMatrix(definition);
  const count = (status: BenchmarkRun['status']) =>
    runs.filter((run) => run.status === status).length;
  const outcome = (value: ReturnType<typeof outcomeOf>) =>
    runs.filter((run) => run.outcome === value).length;

  return {
    scenarioCount: definition.scenarios.length,
    seedCount: definition.seeds.length,
    totalCases: matrix.length,
    completedCases: count('COMPLETED'),
    limitReachedCases: count('LIMIT_REACHED'),
    failedCases: count('FAILED'),
    timeoutCases: count('TIMEOUT'),
    errorCases: count('ERROR'),
    runningCases: count('RUNNING'),
    unavailableCases: count('UNAVAILABLE'),
    succeededCases: outcome('succeeded'),
    unsuccessfulCases: outcome('unsuccessful'),
    inProgressCases: outcome('inProgress'),
    executedCases: runs.length,
    evaluatedCases: runs.filter((run) => run.evaluation !== null).length,
  };
}

/**
 * Assemble the report.
 *
 * `runs` must be in matrix order — `executeBenchmark` produces them that way,
 * and the ordering is what makes tie-breaking in the degradation table mean
 * "the earlier scenario in the definition" rather than "whichever the sort
 * happened to put first".
 */
export function reportBenchmark(
  definition: BenchmarkDefinition,
  runs: readonly BenchmarkRun[],
  agent: BenchmarkAgentConfiguration,
  options: BenchmarkReportOptions = {},
): BenchmarkResult {
  const matrix = buildRunMatrix(definition);
  const declared = new Set(matrix.map((entry) => entry.key));
  const seen = new Set<string>();
  for (const run of runs) {
    if (!declared.has(run.case.key))
      throw new BenchmarkError(
        'INVALID_RESULT',
        `Case ${run.case.key} is not part of benchmark ${definition.id} v${definition.version}.`,
      );
    if (seen.has(run.case.key))
      throw new BenchmarkError('INVALID_RESULT', `Case ${run.case.key} was reported twice.`);
    seen.add(run.case.key);
  }

  const degradations = buildScenarioDegradations(definition, runs);

  return BenchmarkResult.parse({
    benchmark: {
      id: definition.id,
      version: definition.version,
      name: definition.name,
    },
    agent,
    configuration: {
      environmentKey: definition.environmentKey,
      objectiveKey: definition.objectiveKey,
      scenarios: definition.scenarios,
      seeds: definition.seeds,
      declaredSeeds: [...(options.declaredSeeds ?? definition.seeds)],
      caseCount: matrix.length,
    },
    summary: summariseCases(definition, runs),
    dimensions: aggregateDimensions(runs),
    robustness: measureRobustness(degradations),
    scenarios: degradations,
    failures: analyseFailures(runs),
    runs,
  });
}

export { aggregateDimensions, outcomeOf } from './aggregation';
export * from './arithmetic';
export { analyseFailures } from './failures';
export { benchmarkCaseKey, buildRunMatrix, casesForScenario } from './matrix';
export { buildScenarioDegradations, measureRobustness, retentionOf } from './robustness';
export * from './types';
