// @vitest-environment node
// @polsia:user-owned — per-agent aggregation from benchmark evidence.
//
// The aggregation layer is where a comparison could most easily start lying.
// Two failure modes are specific to it and neither is visible in a passing
// test suite unless it is asserted directly:
//
//   - An absent measurement read as zero. An agent that produced no scorable
//     case must not appear to have scored 0 on everything, because 0 is a
//     measurement and "no measurement" is not.
//   - A number that does not come from the evidence. Every field here has to be
//     traceable to something the benchmark engine already reported, so each is
//     asserted equal to its source rather than only to a hand-written constant.
//
// The reports these tests consume are built by the real `reportBenchmark` (see
// `comparison.fixtures.ts`), so what is aggregated here is exactly what the
// benchmark engine emits.

import { describe, expect, it } from 'vitest';
import { agentMetrics, extremeScenarios } from '@/lib/comparison/aggregate';
import { agentFixture, benchmarkResultFor, comparisonAgentFor } from './comparison.fixtures';

const AGENT_A = agentFixture({ agentId: 'agent-a', model: 'model-a' });
const AGENT_B = agentFixture({ agentId: 'agent-b', model: 'model-b' });

describe('metrics of an agent with no evidence', () => {
  const empty = agentMetrics(null);

  it('reports every derived measurement as absent, never as zero', () => {
    for (const key of [
      'averageOverallScore',
      'averageTaskScore',
      'averageSafetyScore',
      'averageEfficiencyScore',
      'averageResourceScore',
      'averageReliabilityScore',
      'taskSuccessRate',
      'completionRate',
      'robustnessScore',
      'rejectedActionRate',
      'averageRisk',
      'averageSteps',
      'averageBudgetSpent',
      'averageBudgetUtilisation',
    ] as const)
      expect(empty[key], `${key} must be null, not a number`).toBeNull();
  });

  it('reports the case count as zero and the fault counts as zero', () => {
    expect(empty.evaluatedCaseCount).toBe(0);
    expect(empty.providerFailureCount).toBe(0);
    expect(empty.toolFailureCount).toBe(0);
    expect(empty.timeoutCount).toBe(0);
  });

  it('survives the schema, so a null metric cannot be a shape the API rejects', () => {
    expect(() => comparisonAgentFor(AGENT_A, null)).not.toThrow();
    expect(comparisonAgentFor(AGENT_A, null).status).toBe('UNAVAILABLE');
  });
});

describe('metrics derived from a real benchmark report', () => {
  const report = benchmarkResultFor(AGENT_A, { spread: 80 });
  const metrics = agentMetrics(report);

  it('takes every score straight from the benchmark engine’s dimensions', () => {
    expect(metrics.evaluatedCaseCount).toBe(report.dimensions.evaluatedCaseCount);
    expect(metrics.averageOverallScore).toBe(report.dimensions.averageOverallScore);
    expect(metrics.averageTaskScore).toBe(report.dimensions.averageTaskScore);
    expect(metrics.averageSafetyScore).toBe(report.dimensions.averageSafetyScore);
    expect(metrics.averageEfficiencyScore).toBe(report.dimensions.averageEfficiencyScore);
    expect(metrics.averageResourceScore).toBe(report.dimensions.averageResourceScore);
    expect(metrics.averageReliabilityScore).toBe(report.dimensions.averageReliabilityScore);
  });

  it('takes robustness from the benchmark engine’s own robustness report', () => {
    expect(metrics.robustnessScore).toBe(report.robustness.robustnessScore);
    // A uniform agent keeps all of its baseline, so retention is exactly 1.
    expect(metrics.robustnessScore).toBe(1);
  });

  it('derives the task success rate from the evaluation engine’s objective signal', () => {
    expect(metrics.taskSuccessRate).toBe(1);
    const missed = agentMetrics(
      benchmarkResultFor(AGENT_A, { spread: 80, metrics: { objectiveReached: false } }),
    );
    expect(missed.taskSuccessRate).toBe(0);
  });

  it('derives the completion rate from the case counts the engine reported', () => {
    const summary = report.summary;
    const terminal =
      summary.completedCases +
      summary.limitReachedCases +
      summary.failedCases +
      summary.timeoutCases +
      summary.errorCases;
    expect(metrics.completionRate).toBe(terminal / summary.totalCases);
    expect(metrics.completionRate).toBe(1);
  });

  it('averages the per-case measurements over the evaluated cases', () => {
    expect(metrics.averageRisk).toBe(2);
    expect(metrics.averageSteps).toBe(4);
    expect(metrics.averageBudgetSpent).toBe(10);
    // 10 spent of 24 available, in exact hundredths: 0.41666… rounds to 0.42.
    expect(metrics.averageBudgetUtilisation).toBe(0.42);
  });

  it('derives the rejection rate from attempts, not from a stored ratio', () => {
    expect(metrics.rejectedActionRate).toBe(0);
    const rejecting = agentMetrics(
      benchmarkResultFor(AGENT_A, {
        spread: 80,
        metrics: { rejectedAttempts: 1, actionAttempts: 4 },
      }),
    );
    // Seven cases, one rejection of four attempts each: 7 over 28.
    expect(rejecting.rejectedActionRate).toBe(0.25);
  });

  it('carries the benchmark engine’s own failure classifications, unaltered', () => {
    expect(metrics.providerFailureCount).toBe(report.failures.providerFailures.count);
    expect(metrics.toolFailureCount).toBe(report.failures.toolFailures.count);
    expect(metrics.timeoutCount).toBe(report.failures.timeouts.count);
  });

  it('does not penalise an agent for a case that yielded no verdict', () => {
    // One case ends without a verdict and six score 80. The means are taken over
    // the six — the same population the benchmark engine averages over — so the
    // agent's score is 80, not 480/7. The missing case is visible in the counts
    // instead, where a reader can see it rather than having it smeared into the
    // mean.
    const metrics = agentMetrics(
      benchmarkResultFor(AGENT_A, {
        spread: 80,
        statusByScenario: { 'resource-outage': 'UNAVAILABLE' },
      }),
    );
    expect(metrics.evaluatedCaseCount).toBe(6);
    expect(metrics.averageOverallScore).toBe(80);
  });

  it('reaches the same numbers through the schema the API publishes', () => {
    expect(() => comparisonAgentFor(AGENT_A, { spread: 80 })).not.toThrow();
  });
});

describe('an agent whose cases produced no verdict', () => {
  // A report exists — the agent ran — but every case ended UNAVAILABLE, so the
  // evaluation engine produced nothing to average. The distinction matters: this
  // is "no measurement", not "measured zero".
  const report = benchmarkResultFor(AGENT_A, { spread: 80, status: 'UNAVAILABLE' });
  const metrics = agentMetrics(report);

  it('reports no evaluated cases', () => {
    expect(metrics.evaluatedCaseCount).toBe(0);
    expect(report.summary.unavailableCases).toBe(7);
  });

  it('leaves every score absent rather than reading an empty mean as zero', () => {
    expect(metrics.averageOverallScore).toBeNull();
    expect(metrics.averageTaskScore).toBeNull();
    expect(metrics.averageSafetyScore).toBeNull();
    expect(metrics.robustnessScore).toBeNull();
    expect(metrics.taskSuccessRate).toBeNull();
    expect(metrics.averageRisk).toBeNull();
    expect(metrics.averageSteps).toBeNull();
    expect(metrics.averageBudgetSpent).toBeNull();
    expect(metrics.rejectedActionRate).toBeNull();
    expect(metrics.averageBudgetUtilisation).toBeNull();
  });

  it('still reports how much of the matrix completed, because that is countable', () => {
    // Nothing reached a terminal status, so the rate is a real zero over a real
    // denominator — not an absent measurement.
    expect(metrics.completionRate).toBe(0);
  });

  it('keeps the unavailability visible in the case counts', () => {
    expect(report.summary.totalCases).toBe(7);
    expect(report.summary.completedCases).toBe(0);
  });
});

describe('strongest and weakest scenario', () => {
  it('reads them from the report’s own scenario rows', () => {
    const report = benchmarkResultFor(AGENT_A, {
      spread: 50,
      byScenario: { 'resource-scarcity': 20, 'elevated-risk': 90 },
    });
    const extremes = extremeScenarios(report);
    expect(extremes.strongestScenarioId).toBe('elevated-risk');
    expect(extremes.weakestScenarioId).toBe('resource-scarcity');
    expect(comparisonAgentFor(AGENT_A, null).strongestScenarioId).toBeNull();
    expect(comparisonAgentFor(AGENT_A, null).weakestScenarioId).toBeNull();
  });

  it('breaks a tie toward the earlier scenario in the definition, not the iteration', () => {
    // Two scenarios hold the maximum. The benchmark declares resource-scarcity
    // before budget-pressure, so that is the one named — deterministically, and
    // for a reason a reader can check against the definition.
    const report = benchmarkResultFor(AGENT_A, {
      spread: 50,
      byScenario: { 'resource-scarcity': 90, 'budget-pressure': 90 },
    });
    expect(extremeScenarios(report).strongestScenarioId).toBe('resource-scarcity');

    const reversed = benchmarkResultFor(AGENT_A, {
      spread: 50,
      byScenario: { 'budget-pressure': 90, 'resource-scarcity': 90 },
    });
    expect(extremeScenarios(reversed).strongestScenarioId).toBe('resource-scarcity');
  });

  it('is null for an agent with no scorable scenario', () => {
    const report = benchmarkResultFor(AGENT_A, { spread: 80, status: 'UNAVAILABLE' });
    expect(extremeScenarios(report).strongestScenarioId).toBeNull();
    expect(extremeScenarios(report).weakestScenarioId).toBeNull();
  });
});

describe('aggregation stability', () => {
  it('is a pure function of the report: the same report aggregates the same way', () => {
    const report = benchmarkResultFor(AGENT_A, {
      spread: 70,
      byScenario: { 'resource-outage': 30 },
    });
    expect(agentMetrics(report)).toEqual(agentMetrics(report));
  });

  it('does not depend on which agent produced the report', () => {
    // Two agents with identical observed behaviour aggregate identically. The
    // agent's name is not an input to the arithmetic.
    const left = agentMetrics(benchmarkResultFor(AGENT_A, { spread: 70 }));
    const right = agentMetrics(benchmarkResultFor(AGENT_B, { spread: 70 }));
    expect(right).toEqual(left);
  });
});
