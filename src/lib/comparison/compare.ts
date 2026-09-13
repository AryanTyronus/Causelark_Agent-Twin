// @polsia:user-owned — head-to-head comparison and the verdict.
//
// Everything here compares numbers the benchmark engine already produced. No
// measurement is taken here, no agent is asked anything, and no judgement enters
// from outside: a metric's direction is declared data, a tie is a tie, and the
// verdict is the first declared discriminator on which the leaders disagree.
//
// One property is worth stating plainly, because the rest follows from it. An
// *absent* value is not a value. Two agents with no evidence for a metric have
// not tied on it — they have no basis to be compared on it, and every function
// below treats that as "not comparable" rather than as equality. That is the
// difference between a report that says "these two agents performed the same"
// and one that says "this comparison could not tell".

import { roundDivide } from '@/lib/benchmarks/arithmetic';
import {
  BENCHMARK_FAILURE_CATEGORIES,
  BENCHMARK_METRIC_PRECISION,
  BENCHMARK_ROBUSTNESS_FORMULA,
} from '@/lib/benchmarks/types';
import { compareValues, directionOf, METRIC_KEYS, VERDICT_DISCRIMINATORS } from './metrics';
import {
  COMPARISON_VERDICT_RULE,
  type ComparisonAgent,
  type ComparisonMetricKey,
  type ComparisonVerdict,
  type FailureProfileRow,
  type HeadToHead,
  type MetricComparison,
  type RobustnessComparison,
  type ScenarioComparison,
  type VerdictLevel,
} from './types';

/**
 * A difference of two reported values, rounded once to the reporting precision.
 *
 * Differences can be negative, and `roundDivide` rounds half away from zero, so
 * a delta and its negation are always the same magnitude with opposite signs.
 */
function difference(left: number, right: number): number {
  return roundDivide(left - right, 1, BENCHMARK_METRIC_PRECISION);
}

/** The distance between two reported values, at the reporting precision. */
function magnitude(left: number, right: number): number {
  return roundDivide(Math.abs(left - right), 1, BENCHMARK_METRIC_PRECISION);
}

/** The agents that recorded a value for one metric, in experiment order. */
function comparableAgents(
  agents: readonly ComparisonAgent[],
  metric: ComparisonMetricKey,
): { agent: ComparisonAgent; value: number }[] {
  const comparable: { agent: ComparisonAgent; value: number }[] = [];
  for (const agent of agents) {
    const value = agent.metrics[metric];
    if (value !== null) comparable.push({ agent, value });
  }
  return comparable;
}

/**
 * The agents holding the best value of one metric.
 *
 * Empty when fewer than one agent recorded a value, or when the metric is
 * neutral — a neutral metric has no best, so nobody leads it.
 */
function leadersFor(
  agents: readonly ComparisonAgent[],
  metric: ComparisonMetricKey,
): { leaders: string[]; best: number | null; worst: number | null } {
  const comparable = comparableAgents(agents, metric);
  if (comparable.length === 0 || directionOf(metric) === 'neutral')
    return { leaders: [], best: null, worst: null };

  const first = comparable[0];
  if (!first) return { leaders: [], best: null, worst: null };
  let best = first.value;
  let worst = first.value;
  for (const entry of comparable) {
    if (compareValues(metric, entry.value, best) > 0) best = entry.value;
    if (compareValues(metric, entry.value, worst) < 0) worst = entry.value;
  }
  const leaders = comparable
    .filter((entry) => compareValues(metric, entry.value, best) === 0)
    .map((entry) => entry.agent.key);
  return { leaders, best, worst };
}

/** The gap between the best and worst comparable values, or `null`. */
function spreadOf(
  metric: ComparisonMetricKey,
  best: number | null,
  worst: number | null,
): number | null {
  if (best === null || worst === null || directionOf(metric) === 'neutral') return null;
  return magnitude(best, worst);
}

/** Every metric, across every agent, in the table's reporting order. */
export function compareMetrics(agents: readonly ComparisonAgent[]): MetricComparison[] {
  return METRIC_KEYS.map((metric) => {
    const { leaders, best, worst } = leadersFor(agents, metric);
    return {
      metric,
      direction: directionOf(metric),
      values: agents.map((agent) => agent.metrics[metric]),
      leaders,
      tied: leaders.length > 1,
      spread: spreadOf(metric, best, worst),
    };
  });
}

/**
 * Every pair of agents, compared metric by metric.
 *
 * The pairs are produced in canonical agent order, so a report lists the same
 * pairs in the same order however the request listed its agents. With more than
 * two agents every pair appears: a head-to-head is a statement about two agents,
 * and the interesting differences are not always between the overall leaders.
 */
export function buildHeadToHead(agents: readonly ComparisonAgent[]): HeadToHead[] {
  const pairs: HeadToHead[] = [];
  for (let left = 0; left < agents.length; left += 1) {
    for (let right = left + 1; right < agents.length; right += 1) {
      const a = agents[left];
      const b = agents[right];
      if (!a || !b) continue;
      const metrics = METRIC_KEYS.map((metric) => {
        const leftValue = a.metrics[metric];
        const rightValue = b.metrics[metric];
        if (leftValue === null || rightValue === null)
          return {
            metric,
            direction: directionOf(metric),
            left: leftValue,
            right: rightValue,
            delta: null,
            winner: null,
          };
        const comparison = compareValues(metric, leftValue, rightValue);
        return {
          metric,
          direction: directionOf(metric),
          left: leftValue,
          right: rightValue,
          delta: difference(leftValue, rightValue),
          winner: comparison === 0 ? null : comparison > 0 ? ('left' as const) : ('right' as const),
        };
      });
      pairs.push({
        left: a.key,
        right: b.key,
        metrics,
        leftWins: metrics.filter((entry) => entry.winner === 'left').length,
        rightWins: metrics.filter((entry) => entry.winner === 'right').length,
      });
    }
  }
  return pairs;
}

/**
 * Every scenario, across every agent.
 *
 * The rows follow the benchmark's declared scenario order — the same order the
 * degradation table uses — so a comparison and the benchmark report it is built
 * from present their scenarios identically.
 */
export function compareScenarios(agents: readonly ComparisonAgent[]): ScenarioComparison[] {
  const reference = agents.find((agent) => agent.report !== null)?.report;
  if (!reference) return [];
  return reference.scenarios.map((row) => {
    const scores = agents.map((agent) => {
      const match = agent.report?.scenarios.find(
        (candidate) =>
          candidate.scenarioId === row.scenarioId &&
          candidate.scenarioVersion === row.scenarioVersion,
      );
      return match?.score ?? null;
    });
    const comparable = scores
      .map((score, index) => ({ score, agent: agents[index] }))
      .filter((entry): entry is { score: number; agent: ComparisonAgent } => entry.score !== null);
    const best = comparable.reduce<number | null>(
      (highest, entry) => (highest === null || entry.score > highest ? entry.score : highest),
      null,
    );
    const worst = comparable.reduce<number | null>(
      (lowest, entry) => (lowest === null || entry.score < lowest ? entry.score : lowest),
      null,
    );
    const leaders =
      best === null
        ? []
        : comparable.filter((entry) => entry.score === best).map((entry) => entry.agent.key);
    return {
      scenarioId: row.scenarioId,
      scenarioVersion: row.scenarioVersion,
      isBaseline: row.isBaseline,
      scores,
      leaders,
      tied: leaders.length > 1,
      spread: best === null || worst === null ? null : magnitude(best, worst),
    };
  });
}

/**
 * Every agent's robustness, side by side.
 *
 * The score is the benchmark engine's own `robustnessScore`, under its own
 * formula, unaltered. An agent whose robustness could not be computed keeps its
 * stated reason and contributes no value: it is not compared, and it does not
 * drag a mean anywhere.
 */
export function compareRobustness(agents: readonly ComparisonAgent[]): RobustnessComparison {
  const scores = agents.map((agent) => agent.report?.robustness.robustnessScore ?? null);
  const comparable = scores
    .map((score, index) => ({ score, agent: agents[index] }))
    .filter((entry): entry is { score: number; agent: ComparisonAgent } => entry.score !== null);
  const best = comparable.reduce<number | null>(
    (highest, entry) => (highest === null || entry.score > highest ? entry.score : highest),
    null,
  );
  const worst = comparable.reduce<number | null>(
    (lowest, entry) => (lowest === null || entry.score < lowest ? entry.score : lowest),
    null,
  );
  return {
    formula: BENCHMARK_ROBUSTNESS_FORMULA,
    scores,
    leaders:
      best === null
        ? []
        : comparable.filter((entry) => entry.score === best).map((entry) => entry.agent.key),
    tied: best !== null && comparable.filter((entry) => entry.score === best).length > 1,
    spread: best === null || worst === null ? null : magnitude(best, worst),
    unavailableReasons: agents.map((agent) => agent.report?.robustness.unavailableReason ?? null),
  };
}

/**
 * The failure classes, lined up across agents.
 *
 * The classification is the benchmark engine's; this only places the counts side
 * by side so a difference is visible. No cause is inferred: a count says how
 * many cases a class flagged, and nothing here claims to know why.
 */
export function buildFailureProfiles(agents: readonly ComparisonAgent[]): FailureProfileRow[] {
  return BENCHMARK_FAILURE_CATEGORIES.map((category) => {
    const counts = agents.map((agent) => {
      if (!agent.report) return 0;
      return agent.report.failures[category].count;
    });
    return {
      category,
      metric:
        agents.find((agent) => agent.report !== null)?.report?.failures[category].metric ?? null,
      counts,
      agents: agents.filter((_agent, index) => (counts[index] ?? 0) > 0).map((agent) => agent.key),
    };
  });
}

/**
 * The verdict.
 *
 * The rule walks the declared discriminators in order, narrowing to the agents
 * still in contention. At each rung it is consulted only by the contenders: a
 * third agent that was already behind cannot overtake a leader by winning a
 * lower rung, because it is no longer in contention. A rung nobody has a value
 * for is skipped rather than read as zero.
 *
 * A winner is named only when a rung leaves exactly one contender standing with
 * a value. If the rungs run out with more than one contender, that is a tie. If
 * fewer than two agents ever produced comparable evidence, no rung can separate
 * anybody and the outcome says the evidence is insufficient — it does not name
 * whoever happened to have a number.
 */
export function decideVerdict(agents: readonly ComparisonAgent[]): ComparisonVerdict {
  const levels: VerdictLevel[] = [];
  const withEvidence = agents.filter((agent) => agent.metrics.evaluatedCaseCount > 0);

  const insufficient = (reason: string): ComparisonVerdict => ({
    rule: COMPARISON_VERDICT_RULE,
    outcome: 'INSUFFICIENT_EVIDENCE',
    winner: null,
    winnerIdentity: null,
    decidedBy: null,
    reason,
    levels,
  });

  if (agents.length < 2)
    return insufficient(
      'An experiment needs at least two agents before a winner can mean anything.',
    );
  if (withEvidence.length < 2)
    return insufficient(
      withEvidence.length === 0
        ? 'No agent in this experiment produced a case the evaluation engine could score, so there is no evidence to compare.'
        : `Only ${withEvidence[0]?.identity ?? 'one agent'} produced scorable evidence, so there is nothing to compare it against.`,
    );

  let contenders = withEvidence.map((agent) => agent.key);

  for (const metric of VERDICT_DISCRIMINATORS) {
    const inContention = agents.filter((agent) => contenders.includes(agent.key));
    const comparable = comparableAgents(inContention, metric);
    const { leaders, best } = leadersFor(inContention, metric);

    if (best === null || comparable.length < 2) {
      levels.push({
        metric,
        contenders,
        leaders: [],
        value: null,
        margin: null,
        decided: false,
      });
      continue;
    }

    // The margin is best minus next-best *distinct* value, which is what tells a
    // reader how close the decision was. Absent when only one distinct value
    // exists, because then there is no margin to state.
    const next = comparable
      .map((entry) => entry.value)
      .filter((value) => compareValues(metric, value, best) < 0)
      .reduce<number | null>(
        (highest, value) =>
          highest === null || compareValues(metric, value, highest) > 0 ? value : highest,
        null,
      );

    const decided = leaders.length === 1;
    levels.push({
      metric,
      contenders,
      leaders,
      value: best,
      margin: next === null ? null : magnitude(best, next),
      decided,
    });

    if (decided) {
      const winner = agents.find((agent) => agent.key === leaders[0]);
      return {
        rule: COMPARISON_VERDICT_RULE,
        outcome: 'WINNER',
        winner: leaders[0] ?? null,
        winnerIdentity: winner?.identity ?? null,
        decidedBy: metric,
        reason: `${winner?.identity ?? 'The leading agent'} leads on ${metric} with ${best}, and the agents still in contention do not tie on it.`,
        levels,
      };
    }
    contenders = leaders;
  }

  return {
    rule: COMPARISON_VERDICT_RULE,
    outcome: 'TIE',
    winner: null,
    winnerIdentity: null,
    decidedBy: null,
    reason: `Every declared discriminator either tied or was absent for all of ${contenders.length} agents, so this experiment does not separate them.`,
    levels,
  };
}
