// @polsia:user-owned — comparison metric directions.
//
// A head-to-head needs to know which way is up. That is the one thing this
// module states, and it states it as data rather than as branching scattered
// through the comparison: every metric a report carries has a declared
// direction, and a metric with no declared direction cannot be reported.
//
// The directions are not preferences. `higher` and `lower` are claimed only
// where the existing evaluation philosophy already establishes the direction —
// a score, a rate of success, a count of faults. `neutral` is the honest answer
// for a quantity that is only meaningful beside the result it bought: steps
// taken, budget spent and budget share used are neither achievements nor
// faults, and a comparison that scored them would be inventing a preference.

import {
  COMPARISON_DISCRIMINATORS,
  type ComparisonMetricDirection,
  type ComparisonMetricKey,
} from './types';

/**
 * Every reported metric, with its direction.
 *
 * Declared as an ordered list rather than a record so the reporting order is a
 * property of this table, not of object key iteration.
 */
export const COMPARISON_METRIC_TABLE: readonly {
  metric: ComparisonMetricKey;
  direction: ComparisonMetricDirection;
  /** What the metric is, in one line, as the report explains it. */
  description: string;
}[] = [
  {
    metric: 'averageOverallScore',
    direction: 'higher',
    description: 'Mean overall evaluation score across the cases that produced a verdict.',
  },
  {
    metric: 'averageTaskScore',
    direction: 'higher',
    description: 'Mean task-success category score across evaluated cases.',
  },
  {
    metric: 'averageSafetyScore',
    direction: 'higher',
    description: 'Mean safety category score across evaluated cases.',
  },
  {
    metric: 'averageEfficiencyScore',
    direction: 'higher',
    description: 'Mean efficiency category score across evaluated cases.',
  },
  {
    metric: 'averageResourceScore',
    direction: 'higher',
    description: 'Mean resource-management category score across evaluated cases.',
  },
  {
    metric: 'averageReliabilityScore',
    direction: 'higher',
    description: 'Mean reliability category score across evaluated cases.',
  },
  {
    metric: 'taskSuccessRate',
    direction: 'higher',
    description: 'Share of evaluated cases whose recorded objective was reached.',
  },
  {
    metric: 'completionRate',
    direction: 'higher',
    description: 'Share of the matrix that reached a terminal status of its own.',
  },
  {
    metric: 'robustnessScore',
    direction: 'higher',
    description: 'Mean baseline retention across the benchmark’s perturbed scenarios.',
  },
  {
    metric: 'rejectedActionRate',
    direction: 'lower',
    description: 'Share of action attempts the environment refused.',
  },
  {
    metric: 'averageRisk',
    direction: 'lower',
    description: 'Mean peak risk reached across evaluated cases.',
  },
  {
    metric: 'providerFailureCount',
    direction: 'lower',
    description: 'Cases the benchmark engine classified as provider failures.',
  },
  {
    metric: 'toolFailureCount',
    direction: 'lower',
    description: 'Cases the benchmark engine classified as tool failures.',
  },
  {
    metric: 'timeoutCount',
    direction: 'lower',
    description: 'Cases the benchmark engine classified as timeouts.',
  },
  {
    metric: 'averageSteps',
    direction: 'neutral',
    description: 'Mean accepted environment transitions. Reported, never scored.',
  },
  {
    metric: 'averageBudgetSpent',
    direction: 'neutral',
    description: 'Mean budget spent. Reported, never scored.',
  },
  {
    metric: 'averageBudgetUtilisation',
    direction: 'neutral',
    description: 'Budget spent over budget available. Reported, never scored.',
  },
];

/** The direction of one metric. Every reported key has one. */
export function directionOf(metric: ComparisonMetricKey): ComparisonMetricDirection {
  const entry = COMPARISON_METRIC_TABLE.find((candidate) => candidate.metric === metric);
  // Unreachable while the table above covers `COMPARISON_METRIC_KEYS`, and a
  // test asserts exactly that. Throwing rather than defaulting keeps a new
  // metric from silently acquiring a direction nobody chose.
  if (!entry) throw new Error(`Comparison metric ${metric} has no declared direction.`);
  return entry.direction;
}

/**
 * Every reported metric, in reporting order.
 *
 * Projected from the table rather than restated, so a metric cannot be reported
 * without a direction and the two can never fall out of step.
 */
export const METRIC_KEYS: readonly ComparisonMetricKey[] = COMPARISON_METRIC_TABLE.map(
  (entry) => entry.metric,
);

/** The metrics that can decide a verdict, in the order they are consulted. */
export const VERDICT_DISCRIMINATORS: readonly ComparisonMetricKey[] = COMPARISON_DISCRIMINATORS;

/**
 * Whether a larger value is better, as a comparison in the metric's direction.
 *
 * Returns `0` for a neutral metric regardless of the values, because a neutral
 * metric has no better — that is what neutral means, and encoding it here keeps
 * every caller from having to remember it.
 */
export function compareValues(metric: ComparisonMetricKey, left: number, right: number): number {
  const direction = directionOf(metric);
  if (direction === 'neutral' || left === right) return 0;
  const ascending = left < right ? -1 : 1;
  return direction === 'higher' ? ascending : -ascending;
}
