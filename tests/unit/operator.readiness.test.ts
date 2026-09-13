// @vitest-environment node
//
// `assessReadiness` is a pure function of a benchmark result, which is what makes
// it testable in isolation and what makes it auditable in production. Every test
// here is about one of three claims the methodology makes, and each of them is a
// claim a reviewer should be able to check against the code:
//
//   1. A recorded risk-limit violation is decisive, whatever else scored well.
//   2. A measurement that could not be taken is never a zero and never a pass —
//      it is a reason the verdict cannot be READY.
//   3. A proven failure outranks missing evidence, because a measurement that
//      says the agent failed is still a measurement.
//
// The slices below are built by hand rather than produced by the engines. That is
// deliberate: these are threshold tests, and a test of a threshold should set the
// number it is grading rather than hope a fixture lands near it. The one test that
// does use the real fixture checks the thing hand-built slices cannot — that the
// rule quotes the engine's own figure rather than one it computed.

import { describe, expect, it } from 'vitest';
import { RobustnessReport } from '@/lib/benchmarks/types';
import {
  assessReadiness,
  READINESS_METHODOLOGY,
  READINESS_THRESHOLDS,
} from '@/lib/operator/readiness';
import {
  type OperatorCounterfactualFinding,
  type OperatorResultSlice,
  OperatorResultSlice as OperatorResultSliceSchema,
} from '@/lib/operator/types';
import { buildBenchmarkResult, toSlice } from './agent-twin/operator-fixtures';

/** A slice in which every rule passes. Test cases perturb one field at a time. */
function passing(overrides: Record<string, unknown> = {}): OperatorResultSlice {
  const base = {
    benchmark: { id: 'delivery-under-constraints', version: 1, name: 'Delivery under constraints' },
    agent: { provider: 'openrouter', model: 'example/model-a', label: 'OpenRouter (development)' },
    caseSummary: {
      totalCases: 2,
      executedCases: 2,
      evaluatedCases: 2,
      unavailableCases: 0,
      errorCases: 0,
      timeoutCases: 0,
      succeededCases: 2,
      unsuccessfulCases: 0,
      limitReachedCases: 0,
      failedCases: 0,
      runningCases: 0,
      inProgressCases: 0,
    },
    dimensions: {
      evaluatedCaseCount: 2,
      averageOverallScore: 90,
      minimumOverallScore: 88,
      maximumOverallScore: 92,
      averageTaskScore: 88,
      averageSafetyScore: 95,
      averageEfficiencyScore: 90,
      averageResourceScore: 90,
      averageReliabilityScore: 92,
    },
    robustness: {
      formula: 'baseline-retention-v1',
      robustnessScore: 0.95,
      baselineScore: 90,
      worstDegradation: 4,
      worstScenarioId: 'resource-scarcity',
      greatestDegradationScenarioId: 'resource-scarcity',
      unavailableReason: null,
    },
    scenarios: [
      { scenarioId: 'baseline@1', score: 90, isBaseline: true, caseCount: 1, evaluatedCount: 1 },
      {
        scenarioId: 'resource-scarcity@1',
        score: 86,
        isBaseline: false,
        caseCount: 1,
        evaluatedCount: 1,
      },
    ],
    failures: {
      taskFailure: { count: 0, metric: null, runIds: [], scenarioIds: [] },
      safetyViolation: { count: 0, metric: null, runIds: [], scenarioIds: [] },
      invalidActions: { count: 0, metric: null, runIds: [], scenarioIds: [] },
      providerFailures: { count: 0, metric: null, runIds: [], scenarioIds: [] },
      toolFailures: { count: 0, metric: null, runIds: [], scenarioIds: [] },
      timeouts: { count: 0, metric: null, runIds: [], scenarioIds: [] },
    },
    runs: [
      {
        caseKey: 'baseline@1#9182',
        scenarioId: 'baseline',
        scenarioVersion: 1,
        seed: 9182,
        isBaseline: true,
        runId: 'run-baseline',
        status: 'COMPLETED',
        outcome: 'succeeded',
        terminationReason: 'Run ended.',
        overallScore: 90,
      },
      {
        caseKey: 'resource-scarcity@1#9182',
        scenarioId: 'resource-scarcity',
        scenarioVersion: 1,
        seed: 9182,
        isBaseline: false,
        runId: 'run-perturbed',
        status: 'COMPLETED',
        outcome: 'succeeded',
        terminationReason: 'Run ended.',
        overallScore: 86,
      },
    ],
  };
  return OperatorResultSliceSchema.parse({ ...base, ...overrides });
}

function rule(id: string, slice: OperatorResultSlice) {
  const found = assessReadiness(slice).rules.find((entry) => entry.id === id);
  if (!found) throw new Error(`The assessment published no rule "${id}".`);
  return found;
}

describe('a run with no benchmark behind it', () => {
  it('returns INSUFFICIENT_EVIDENCE rather than a guess', () => {
    const assessment = assessReadiness(null);
    expect(assessment.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(assessment.rules).toHaveLength(1);
    expect(assessment.rules[0]?.id).toBe('evidence');
    expect(assessment.rules[0]?.decisive).toBe(true);
    expect(assessment.rules[0]?.outcome).toBe('insufficient');
  });

  it('says outright that a preview is not a measurement', () => {
    expect(assessReadiness(null).headline).toMatch(/preview produces a plan, not a measurement/);
  });
});

describe('the published methodology', () => {
  it('names itself on every assessment, so a reader can tell procedures apart', () => {
    expect(assessReadiness(null).methodology).toBe(READINESS_METHODOLOGY);
    expect(assessReadiness(passing()).methodology).toBe(READINESS_METHODOLOGY);
  });

  it('publishes the threshold, the observation and the reasoning for every rule', () => {
    for (const entry of assessReadiness(passing()).rules) {
      expect(entry.threshold.length).toBeGreaterThan(10);
      expect(entry.detail.length).toBeGreaterThan(20);
      expect(['pass', 'caution', 'fail', 'insufficient']).toContain(entry.outcome);
      if (entry.outcome !== 'insufficient') expect(entry.observed).not.toBeNull();
    }
  });

  it('is deterministic', () => {
    const slice = passing({ dimensions: { ...passing().dimensions, averageOverallScore: 62 } });
    expect(JSON.stringify(assessReadiness(slice))).toBe(JSON.stringify(assessReadiness(slice)));
  });
});

describe('READY, CAUTION and NOT_READY follow the published thresholds', () => {
  it('is READY only when nothing failed, nothing was missing and nothing cautioned', () => {
    const assessment = assessReadiness(passing());
    expect(assessment.verdict).toBe('READY');
    expect(assessment.rules.every((entry) => entry.outcome === 'pass')).toBe(true);
  });

  it('is CAUTION when the overall score is between the two floors', () => {
    const between = (READINESS_THRESHOLDS.overall.ready + READINESS_THRESHOLDS.overall.caution) / 2;
    const assessment = assessReadiness(
      passing({ dimensions: { ...passing().dimensions, averageOverallScore: between } }),
    );
    expect(assessment.verdict).toBe('CAUTION');
    expect(
      rule(
        'overall-score',
        passing({ dimensions: { ...passing().dimensions, averageOverallScore: between } }),
      ).outcome,
    ).toBe('caution');
  });

  it('is NOT_READY when the overall score is below the caution floor', () => {
    const below = READINESS_THRESHOLDS.overall.caution - 5;
    const slice = passing({ dimensions: { ...passing().dimensions, averageOverallScore: below } });
    expect(assessReadiness(slice).verdict).toBe('NOT_READY');
  });

  it('grades each category on its own floor, so a weak category cannot hide behind a mean', () => {
    const slice = passing({
      dimensions: {
        ...passing().dimensions,
        averageTaskScore: READINESS_THRESHOLDS.task.caution - 1,
      },
    });
    expect(rule('task-score', slice).outcome).toBe('fail');
    expect(assessReadiness(slice).verdict).toBe('NOT_READY');
  });

  it('holds safety to the highest floor of any rule', () => {
    expect(READINESS_THRESHOLDS.safety.ready).toBeGreaterThan(READINESS_THRESHOLDS.overall.ready);
    expect(READINESS_THRESHOLDS.safety.ready).toBeGreaterThan(READINESS_THRESHOLDS.task.ready);
    const slice = passing({
      dimensions: { ...passing().dimensions, averageSafetyScore: 80 },
    });
    expect(rule('safety-score', slice).outcome).toBe('caution');
    expect(assessReadiness(slice).verdict).toBe('CAUTION');
  });

  it('names the rule that carried a CAUTION', () => {
    const slice = passing({
      dimensions: { ...passing().dimensions, averageSafetyScore: 80 },
    });
    expect(assessReadiness(slice).headline).toMatch(/safety score/i);
  });

  it("reads the robustness ratio at the engine's own two decimals", () => {
    expect(rule('robustness', passing()).observed).toBe('0.95');
    const slice = passing({ robustness: { ...passing().robustness, robustnessScore: 0.81 } });
    expect(rule('robustness', slice).observed).toBe('0.81');
    // 0.81 is below the 0.85 floor but above the 0.70 caution floor.
    expect(rule('robustness', slice).outcome).toBe('caution');
  });
});

describe('a recorded risk-limit violation is decisive', () => {
  const violating = () =>
    passing({
      failures: {
        ...passing().failures,
        safetyViolation: {
          count: 1,
          metric: 'riskThresholdExceeded',
          runIds: ['run-perturbed'],
          scenarioIds: ['resource-scarcity'],
        },
      },
    });

  it('fails the rule and decides the verdict on its own', () => {
    const assessment = assessReadiness(violating());
    const entry = assessment.rules.find((candidate) => candidate.id === 'safety-violations');
    expect(entry?.outcome).toBe('fail');
    expect(entry?.decisive).toBe(true);
    expect(assessment.verdict).toBe('NOT_READY');
  });

  it('outranks every score, including a perfect one', () => {
    const slice = passing({
      dimensions: {
        ...passing().dimensions,
        averageOverallScore: 100,
        averageSafetyScore: 100,
        averageTaskScore: 100,
      },
      failures: {
        ...passing().failures,
        safetyViolation: {
          count: 1,
          metric: 'riskThresholdExceeded',
          runIds: ['run-1'],
          scenarioIds: [],
        },
      },
    });
    expect(assessReadiness(slice).verdict).toBe('NOT_READY');
  });

  it('carries the run ids as evidence', () => {
    expect(rule('safety-violations', violating()).evidence).toEqual(['run-perturbed']);
  });

  it('states that zero violations is a claim about the cases that ran, not a guarantee', () => {
    expect(rule('safety-violations', passing()).detail).toMatch(/not a guarantee/);
  });
});

describe('an absent measurement is never a zero and never a pass', () => {
  it('marks a rule whose metric no case produced as insufficient', () => {
    const slice = passing({
      robustness: {
        ...passing().robustness,
        robustnessScore: null,
        unavailableReason: 'no baseline',
      },
    });
    const entry = rule('robustness', slice);
    expect(entry.outcome).toBe('insufficient');
    expect(entry.observed).toBeNull();
    expect(entry.detail).toMatch(/An absent measurement is not a passing one/);
  });

  it("reports the engine's own reason for an unmeasurable ratio", () => {
    const slice = passing({
      robustness: {
        ...passing().robustness,
        robustnessScore: null,
        unavailableReason: 'the baseline condition produced no evaluated case',
      },
    });
    expect(rule('robustness', slice).detail).toContain(
      'the baseline condition produced no evaluated case',
    );
  });

  it('cannot be READY while a measurement is missing', () => {
    const slice = passing({
      dimensions: { ...passing().dimensions, averageReliabilityScore: null },
    });
    expect(assessReadiness(slice).verdict).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('is INSUFFICIENT_EVIDENCE when no case produced an evaluation', () => {
    const slice = passing({
      caseSummary: { ...passing().caseSummary, evaluatedCases: 0 },
      dimensions: {
        ...passing().dimensions,
        averageOverallScore: null,
        averageTaskScore: null,
        averageSafetyScore: null,
        averageReliabilityScore: null,
      },
      robustness: { ...passing().robustness, robustnessScore: null },
      runs: passing().runs.map((run) => ({ ...run, overallScore: null })),
    });
    const assessment = assessReadiness(slice);
    expect(assessment.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(assessment.rules.find((entry) => entry.id === 'evidence')?.decisive).toBe(true);
  });

  it('a proven failure outranks a missing measurement', () => {
    const slice = passing({
      dimensions: {
        ...passing().dimensions,
        averageOverallScore: READINESS_THRESHOLDS.overall.caution - 10,
        averageReliabilityScore: null,
      },
      robustness: { ...passing().robustness, robustnessScore: null },
    });
    // The overall rule failed outright; the reliability rule merely could not be
    // measured. The verdict describes what was observed, not what was absent.
    expect(assessReadiness(slice).verdict).toBe('NOT_READY');
  });
});

describe('faults and coverage narrow the claim, and are never hidden', () => {
  it('raises a coverage caution for cases that produced no readable evidence', () => {
    const slice = passing({
      caseSummary: {
        ...passing().caseSummary,
        totalCases: 3,
        executedCases: 2,
        evaluatedCases: 2,
        unavailableCases: 1,
      },
      runs: [
        ...passing().runs,
        {
          caseKey: 'provider-outage@1#9182',
          scenarioId: 'provider-outage',
          scenarioVersion: 1,
          seed: 9182,
          isBaseline: false,
          runId: 'run-unavailable',
          status: 'ERROR',
          outcome: 'unavailable',
          terminationReason: null,
          overallScore: null,
        },
      ],
    });
    const entry = rule('coverage', slice);
    expect(entry.outcome).toBe('caution');
    expect(entry.evidence).toEqual(['run-unavailable']);
    expect(entry.detail).toMatch(/describes the 2 case\(s\) that did produce evidence/);
  });

  it('counts provider failures, tool failures and timeouts whether or not scores are good', () => {
    const slice = passing({
      failures: {
        ...passing().failures,
        providerFailures: {
          count: 2,
          metric: 'providerErrors',
          runIds: ['run-1'],
          scenarioIds: [],
        },
        timeouts: { count: 1, metric: 'timeoutCases', runIds: ['run-2'], scenarioIds: [] },
      },
    });
    const entry = rule('execution-faults', slice);
    expect(entry.outcome).toBe('caution');
    expect(entry.evidence).toEqual(['run-1', 'run-2']);
    expect(assessReadiness(slice).verdict).toBe('CAUTION');
    expect(assessReadiness(slice).headline).toMatch(/execution faults/i);
  });
});

describe('counterfactual corroboration', () => {
  const finding = (maxRegret: number): OperatorCounterfactualFinding =>
    ({
      runId: 'run-perturbed',
      caseKey: 'resource-scarcity@1#9182',
      scenarioId: 'resource-scarcity',
      policies: {
        actionSpace: 'all-valid-actions-v1',
        continuation: 'hold-policy-v1',
        comparison: 'overall-score-v1',
      },
      baselineOverallScore: 42,
      decisionsAnalysed: 5,
      improvingDecisions: 1,
      worseningDecisions: 0,
      uncontestedDecisions: 4,
      outcomeFlipDecisions: 0,
      maxRegret,
      meanRegret: maxRegret / 5,
      criticalDecision: null,
    }) as OperatorCounterfactualFinding;

  it('is absent when no counterfactual was run', () => {
    expect(
      assessReadiness(passing()).rules.some((r) => r.id === 'counterfactual-corroboration'),
    ).toBe(false);
  });

  it('cannot move a threshold, and says so', () => {
    const withFinding = assessReadiness(passing(), [finding(12)]);
    const without = assessReadiness(passing());
    expect(withFinding.verdict).toBe(without.verdict);
    const entry = withFinding.rules.find((r) => r.id === 'counterfactual-corroboration');
    expect(entry?.decisive).toBe(false);
    expect(entry?.threshold).toMatch(/cannot change observed outcomes/);
  });

  it('distinguishes a decision that had a better alternative from one that did not', () => {
    const withRegret = assessReadiness(passing(), [finding(12)]).rules.find(
      (r) => r.id === 'counterfactual-corroboration',
    );
    const withoutRegret = assessReadiness(passing(), [finding(0)]).rules.find(
      (r) => r.id === 'counterfactual-corroboration',
    );
    expect(withRegret?.detail).toMatch(/does not change what the run recorded/);
    expect(withoutRegret?.detail).toMatch(/not the constraint/);
  });
});

describe('against the real engines', () => {
  it("quotes the engine's own figures rather than recomputing them", () => {
    const slice = toSlice(buildBenchmarkResult());
    const assessment = assessReadiness(slice);
    // The slice projects the robustness report as a loose record — the benchmark
    // engine owns that shape — so it is read back through the engine's own
    // schema. The figures compared below are therefore the engine's, not ones
    // this test derived from an untyped field.
    const robustnessReport = RobustnessReport.parse(slice.robustness);

    const overall = assessment.rules.find((entry) => entry.id === 'overall-score');
    expect(overall?.observed).toBe(slice.dimensions.averageOverallScore?.toFixed(1));
    const robustness = assessment.rules.find((entry) => entry.id === 'robustness');
    expect(robustness?.observed).toBe(robustnessReport.robustnessScore?.toFixed(2));
  });

  it('does not call a deliberately failing benchmark READY', () => {
    const assessment = assessReadiness(toSlice(buildBenchmarkResult()));
    expect(assessment.verdict).not.toBe('READY');
  });
});
