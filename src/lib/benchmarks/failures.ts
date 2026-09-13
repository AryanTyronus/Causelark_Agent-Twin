//
// This module reads the evaluation engine's own metric set and the run's own
// status. It re-simulates nothing, replays nothing, and asks no model anything:
// every class below is a field that a run already recorded about itself, and a
// case is classified only when that field says so.
//
// What it deliberately does not do:
//
// - It does not read agent text. A run's observations and summaries are written
//   for a human, and no amount of prose is evidence that a run failed a task.
// - It does not read provider error codes. The runtime normalizes those into
//   safe messages before they are persisted, and `providerFailures` here counts
//   the persisted `agent.error` signal — what it proves is that the agent
//   runtime faulted, not which upstream cause produced the fault.
// - It does not claim causality. A case can be counted under several classes —
//   a run that faulted on its first turn both failed its task and produced a
//   provider failure — because the classes describe what the record contains,
//   not a chain of events the record cannot establish.

import type { EvaluationResult } from '@/lib/evaluation/types';
import type { BenchmarkFailureAnalysis, BenchmarkFailureFinding, BenchmarkRun } from './types';

/** The persisted metric each class reads, for the report's own provenance. */
const CLASSIFICATION_METRICS = {
  taskFailure: 'objectiveReached',
  safetyViolation: 'riskThresholdExceeded',
  invalidActions: 'rejectedAttempts',
  providerFailures: 'agentErrors',
  toolFailures: 'failedToolCalls',
  timeouts: null,
} as const;

function finding(
  category: keyof typeof CLASSIFICATION_METRICS,
  flagged: readonly BenchmarkRun[],
): BenchmarkFailureFinding {
  const seen = new Set<string>();
  const scenarioIds: string[] = [];
  for (const entry of flagged) {
    if (seen.has(entry.case.scenarioId)) continue;
    seen.add(entry.case.scenarioId);
    scenarioIds.push(entry.case.scenarioId);
  }
  return {
    count: flagged.length,
    metric: CLASSIFICATION_METRICS[category],
    // Matrix order, because `runs` arrives in matrix order and nothing here
    // reorders it.
    runIds: flagged.map((entry) => entry.runId),
    scenarioIds,
  };
}

/** A case can only be classified against evidence, so an unevaluated run is never one. */
function evaluated(
  runs: readonly BenchmarkRun[],
): Array<{ run: BenchmarkRun; evaluation: EvaluationResult }> {
  const entries: Array<{ run: BenchmarkRun; evaluation: EvaluationResult }> = [];
  for (const run of runs) {
    if (run.evaluation) entries.push({ run, evaluation: run.evaluation });
  }
  return entries;
}

/**
 * Classify every executed case against the evidence it recorded.
 *
 * Counts are over *cases*, not occurrences: a run that was refused three times
 * contributes one to `invalidActions`, because the question this layer answers
 * is how many conditions produced a rejection, not how many rejections there
 * were. The run's own counts remain in its evaluation metrics.
 */
export function analyseFailures(runs: readonly BenchmarkRun[]): BenchmarkFailureAnalysis {
  const withEvidence = evaluated(runs);
  const pick = (
    predicate: (entry: { run: BenchmarkRun; evaluation: EvaluationResult }) => boolean,
  ) => withEvidence.filter(predicate).map((entry) => entry.run);

  return {
    taskFailure: finding(
      'taskFailure',
      pick(({ evaluation }) => !evaluation.metrics.objectiveReached),
    ),
    safetyViolation: finding(
      'safetyViolation',
      pick(({ evaluation }) => evaluation.metrics.riskThresholdExceeded),
    ),
    invalidActions: finding(
      'invalidActions',
      pick(({ evaluation }) => evaluation.metrics.rejectedAttempts > 0),
    ),
    providerFailures: finding(
      'providerFailures',
      pick(({ evaluation }) => evaluation.metrics.agentErrors > 0),
    ),
    toolFailures: finding(
      'toolFailures',
      pick(({ evaluation }) => evaluation.metrics.failedToolCalls > 0),
    ),
    // The only class read from the run's status rather than from its metrics:
    // a timeout is a termination the runtime recorded, and the evaluation of a
    // timed-out run is a partial verdict that does not itself state why it
    // stopped.
    timeouts: finding(
      'timeouts',
      runs.filter((run) => run.status === 'TIMEOUT'),
    ),
  };
}
