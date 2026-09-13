//
// Formatting only. Nothing in this module computes a metric, re-derives a score,
// or decides which value is better — every number it formats arrives already
// produced by the evaluation, benchmark or comparison engine, and the direction
// it is read in comes from the comparison engine's own declared metric table.
//
// The one rule that matters: `null` is never rendered as a number. Every engine
// in this product uses `null` to mean "this evidence cannot support a value",
// and an interface that printed `0` or `—` there would report a measurement
// nobody made. So `null` has its own rendering, and it says so in words.

import { COMPARISON_METRIC_TABLE } from '@/lib/comparison/metrics';
import type { ComparisonMetricKey } from '@/lib/comparison/types';

/** The display name of a metric. Presentation only — the direction is the engine's. */
const METRIC_LABELS: Record<ComparisonMetricKey, string> = {
  averageOverallScore: 'Overall',
  averageTaskScore: 'Task',
  averageSafetyScore: 'Safety',
  averageEfficiencyScore: 'Efficiency',
  averageResourceScore: 'Resources',
  averageReliabilityScore: 'Reliability',
  taskSuccessRate: 'Task success rate',
  completionRate: 'Completion rate',
  robustnessScore: 'Robustness',
  rejectedActionRate: 'Rejected action rate',
  averageRisk: 'Mean peak risk',
  providerFailureCount: 'Provider failures',
  toolFailureCount: 'Tool failures',
  timeoutCount: 'Timeouts',
  averageSteps: 'Mean steps',
  averageBudgetSpent: 'Mean budget spent',
  averageBudgetUtilisation: 'Budget used',
};

/** The metric's declared description, straight from the engine's table. */
export function metricDescription(metric: ComparisonMetricKey): string {
  return (
    COMPARISON_METRIC_TABLE.find((entry) => entry.metric === metric)?.description ??
    'Reported by the comparison engine.'
  );
}

/** Which way is up, as the comparison engine declared it — never as the UI guesses. */
export function metricDirection(metric: ComparisonMetricKey) {
  return COMPARISON_METRIC_TABLE.find((entry) => entry.metric === metric)?.direction ?? 'neutral';
}

export function metricLabel(metric: ComparisonMetricKey): string {
  return METRIC_LABELS[metric] ?? metric;
}

/** A 0–100 score, to one decimal. `null` becomes an explicit absence. */
export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'not recorded';
  return value.toFixed(1);
}

/** A 0–1 rate as a percentage, to one decimal. */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'not recorded';
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * A 0–1 ratio, to two decimals.
 *
 * Robustness and retention are ratios, and they are the figures this product
 * asks a reader to compare most closely — a retention of 0.82 against 0.79 is a
 * difference of three points that a single decimal would render as `0.8` and
 * `0.8`. Two decimals is the fewest that keeps the comparison legible.
 */
export function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'not recorded';
  return value.toFixed(2);
}

/** A signed change, in the metric's own units. */
export function formatDelta(value: number | null | undefined, suffix = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'not recorded';
  const magnitude = Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${value > 0 ? '+' : ''}${magnitude}${suffix}`;
}

/** A count. Never nullable in the contracts, but bounded defensively. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'not recorded';
  return String(Math.round(value));
}

/** A mean of a whole-number quantity, to one decimal. */
export function formatMean(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'not recorded';
  return value.toFixed(1);
}

/**
 * A metric, formatted the way its own quantity should be read.
 *
 * The shape of a number follows from the metric, not from the value: a rate is a
 * percentage even when it happens to be 1, and a count is an integer even when
 * it happens to be 0.5 in a mean.
 */
export function formatMetric(
  metric: ComparisonMetricKey,
  value: number | null | undefined,
): string {
  switch (metric) {
    case 'taskSuccessRate':
    case 'completionRate':
    case 'rejectedActionRate':
    case 'averageBudgetUtilisation':
      return formatRate(value);
    case 'robustnessScore':
      // A ratio, not a score out of 100: the engine reports it as retention.
      return formatRatio(value);
    case 'providerFailureCount':
    case 'toolFailureCount':
    case 'timeoutCount':
      return formatCount(value);
    case 'averageSteps':
    case 'averageBudgetSpent':
      return formatMean(value);
    default:
      return formatScore(value);
  }
}

/** A signed change for a metric, in that metric's own units. */
export function formatMetricDelta(
  metric: ComparisonMetricKey,
  value: number | null | undefined,
): string {
  switch (metric) {
    case 'taskSuccessRate':
    case 'completionRate':
    case 'rejectedActionRate':
    case 'averageBudgetUtilisation': {
      if (value === null || value === undefined || !Number.isFinite(value)) return 'not recorded';
      return `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`;
    }
    case 'robustnessScore': {
      if (value === null || value === undefined || !Number.isFinite(value)) return 'not recorded';
      return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
    }
    case 'providerFailureCount':
    case 'toolFailureCount':
    case 'timeoutCount':
      return formatDelta(value);
    case 'averageSteps':
    case 'averageBudgetSpent':
      return formatDelta(value);
    default:
      return formatDelta(value);
  }
}

/** A scenario id as a readable condition name. Presentation of an id, nothing more. */
export function scenarioLabel(scenarioId: string): string {
  return scenarioId.replaceAll('-', ' ');
}

/** An ISO timestamp as a short, local, unambiguous reading. */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'not recorded';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'not recorded';
  return parsed.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * A one-line summary of what a set of counts says, for a failure category.
 *
 * Purely arithmetic on counts the engine already produced: the point is to let a
 * reader tell "this agent performed poorly" from "this agent could not execute",
 * which is a difference in *which* counter is non-zero, not in how large it is.
 */
export function failureSummary(counts: readonly number[]): string {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return 'None recorded for any agent.';
  const involved = counts.filter((count) => count > 0).length;
  return `${total} recorded across ${involved} of ${counts.length} agents.`;
}
