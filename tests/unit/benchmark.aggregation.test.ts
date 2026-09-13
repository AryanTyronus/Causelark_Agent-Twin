// @vitest-environment node
//
// Everything here is a pure fold over evaluation results, so the fixtures supply
// the scores directly and the assertions are arithmetic. No simulation runs, no
// database, no provider, no clock.

import { describe, expect, it } from 'vitest';
import { reportBenchmark } from '@/lib/benchmarks/benchmark';
import { getBenchmark, validateBenchmarkDefinition } from '@/lib/benchmarks/catalog';
import { ROBUSTNESS_SCENARIO_IDS } from '@/lib/benchmarks/definitions';
import { retentionOf } from '@/lib/benchmarks/robustness';
import {
  BENCHMARK_METRIC_PRECISION,
  type BenchmarkAgentConfiguration,
  type BenchmarkRun,
} from '@/lib/benchmarks/types';
import type { EvaluationCategory } from '@/lib/evaluation/types';
import { runFixture } from './benchmark.fixtures';

const DEFINITION = getBenchmark('resource-routing-robustness');
const AGENT: BenchmarkAgentConfiguration = { provider: 'bedrock', model: 'test-model' };
const SCENARIO_IDS = [...ROBUSTNESS_SCENARIO_IDS];

function report(runs: readonly BenchmarkRun[]) {
  return reportBenchmark(DEFINITION, runs, AGENT);
}

/** One run per shipped scenario, each scored by the map (default 50). */
function scored(scores: Record<string, number>, seed = 1042): BenchmarkRun[] {
  return SCENARIO_IDS.map((scenarioId, index) =>
    runFixture({ index, scenarioId, seed, overall: scores[scenarioId] ?? 50 }),
  );
}

/** A benchmark whose baseline scores `baseline` and every other scenario `rest`. */
function flat(baseline: number, rest: number): BenchmarkRun[] {
  return SCENARIO_IDS.map((scenarioId, index) =>
    runFixture({
      index,
      scenarioId,
      overall: scenarioId === 'baseline' ? baseline : rest,
    }),
  );
}

const round = (value: number) => Number(value.toFixed(BENCHMARK_METRIC_PRECISION));

describe('benchmark aggregation', () => {
  it('counts every case, and every terminal status separately', () => {
    const runs: BenchmarkRun[] = [
      runFixture({ index: 0, scenarioId: 'baseline', status: 'COMPLETED', overall: 90 }),
      runFixture({
        index: 1,
        scenarioId: 'resource-scarcity',
        status: 'LIMIT_REACHED',
        overall: 70,
      }),
      runFixture({ index: 2, scenarioId: 'budget-pressure', status: 'FAILED', overall: 10 }),
      runFixture({ index: 3, scenarioId: 'elevated-risk', status: 'TIMEOUT', overall: 20 }),
      runFixture({ index: 4, scenarioId: 'resource-outage', status: 'ERROR', overall: 0 }),
      runFixture({ index: 5, scenarioId: 'tight-step-limit', status: 'RUNNING', overall: 30 }),
      runFixture({ index: 6, scenarioId: 'action-rejection', status: 'UNAVAILABLE' }),
    ];
    const { summary } = report(runs);
    expect(summary).toMatchObject({
      scenarioCount: 7,
      seedCount: 1,
      totalCases: 7,
      executedCases: 7,
      evaluatedCases: 6,
      completedCases: 1,
      limitReachedCases: 1,
      failedCases: 1,
      timeoutCases: 1,
      errorCases: 1,
      runningCases: 1,
      unavailableCases: 1,
    });
  });

  it('splits cases three ways without losing one', () => {
    const { summary } = report(flat(90, 70));
    expect(
      summary.succeededCases +
        summary.unsuccessfulCases +
        summary.inProgressCases +
        summary.unavailableCases,
    ).toBe(summary.executedCases);
    expect(summary.succeededCases).toBe(summary.executedCases);
    expect(summary.unsuccessfulCases).toBe(0);
  });

  it('counts a run that hit its step or turn limit as a success', () => {
    const runs = scored({ baseline: 90 }).map((run, index) =>
      index === 0
        ? { ...run, status: 'LIMIT_REACHED' as const, outcome: 'succeeded' as const }
        : run,
    );
    const { summary } = report(runs);
    expect(summary.limitReachedCases).toBe(1);
    expect(summary.unsuccessfulCases).toBe(0);
  });

  it('averages the successful evaluations and reports the extremes', () => {
    const { dimensions } = report(scored({ baseline: 100, 'resource-scarcity': 50 }));
    // Six scenarios at 50 and one at 100 → (6×50 + 100) / 7.
    expect(dimensions.averageOverallScore).toBe(round(400 / 7));
    expect(dimensions.minimumOverallScore).toBe(50);
    expect(dimensions.maximumOverallScore).toBe(100);
    expect(dimensions.evaluatedCaseCount).toBe(7);
  });

  it('averages each of the five dimensions independently', () => {
    const categoryScores: Partial<Record<EvaluationCategory, number>> = {
      taskSuccess: 90,
      safety: 80,
      efficiency: 70,
      resourceManagement: 60,
      reliability: 50,
    };
    const runs = SCENARIO_IDS.map((scenarioId, index) =>
      runFixture({
        index,
        scenarioId,
        overall: 70,
        scores:
          index === 0
            ? categoryScores
            : {
                taskSuccess: 10,
                safety: 20,
                efficiency: 30,
                resourceManagement: 40,
                reliability: 50,
              },
      }),
    );
    const { dimensions } = report(runs);
    // One run at each of the two values, six at the second.
    expect(dimensions.averageTaskScore).toBe(round((90 + 6 * 10) / 7));
    expect(dimensions.averageSafetyScore).toBe(round((80 + 6 * 20) / 7));
    expect(dimensions.averageEfficiencyScore).toBe(round((70 + 6 * 30) / 7));
    expect(dimensions.averageResourceScore).toBe(round((60 + 6 * 40) / 7));
    expect(dimensions.averageReliabilityScore).toBe(50);
  });

  it('reports an absent measurement as null, never as zero', () => {
    const { dimensions, summary } = report([]);
    expect(summary.executedCases).toBe(0);
    expect(summary.evaluatedCases).toBe(0);
    expect(dimensions.evaluatedCaseCount).toBe(0);
    expect(dimensions.averageOverallScore).toBeNull();
    expect(dimensions.minimumOverallScore).toBeNull();
    expect(dimensions.maximumOverallScore).toBeNull();
    expect(dimensions.averageTaskScore).toBeNull();
    expect(dimensions.averageSafetyScore).toBeNull();
    expect(dimensions.averageEfficiencyScore).toBeNull();
    expect(dimensions.averageResourceScore).toBeNull();
    expect(dimensions.averageReliabilityScore).toBeNull();
  });

  it('keeps the matrix size visible when only part of the benchmark ran', () => {
    const runs = scored({ baseline: 90 }).slice(0, 3);
    const { summary } = report(runs);
    expect(summary.totalCases).toBe(7);
    expect(summary.executedCases).toBe(3);
    expect(summary.evaluatedCases).toBe(3);
    expect(summary.succeededCases).toBe(3);
  });

  it('excludes an unevaluated case from the averages but keeps it counted', () => {
    const runs = [
      runFixture({ index: 0, scenarioId: 'baseline', overall: 100 }),
      runFixture({ index: 1, scenarioId: 'resource-scarcity', status: 'UNAVAILABLE' }),
      runFixture({ index: 2, scenarioId: 'budget-pressure', overall: 50 }),
    ];
    const { dimensions, summary } = report(runs);
    expect(summary.evaluatedCases).toBe(2);
    expect(summary.unavailableCases).toBe(1);
    expect(dimensions.averageOverallScore).toBe(75);
    expect(dimensions.evaluatedCaseCount).toBe(2);
  });

  it('does not let a failed case become a zero-score success', () => {
    const runs = [
      runFixture({ index: 0, scenarioId: 'baseline', status: 'FAILED', overall: 0 }),
      runFixture({ index: 1, scenarioId: 'resource-scarcity', status: 'COMPLETED', overall: 90 }),
    ];
    const { summary, dimensions } = report(runs);
    expect(summary.failedCases).toBe(1);
    expect(summary.unsuccessfulCases).toBe(1);
    expect(summary.succeededCases).toBe(1);
    // The failure is still averaged over — it is evidence — but it is not renamed.
    expect(dimensions.averageOverallScore).toBe(45);
  });

  it('refuses a run that is not part of the definition', () => {
    const alien = runFixture({ index: 0, scenarioId: 'not-a-scenario', overall: 90 });
    expect(() => report([alien])).toThrowError(/not part of benchmark/);
  });

  it('refuses the same case twice', () => {
    const run = runFixture({ index: 0, scenarioId: 'baseline', overall: 90 });
    expect(() => report([run, run])).toThrowError(/reported twice/);
  });

  it('is deterministic: the same runs produce the same result twice', () => {
    const runs = flat(90, 60);
    expect(report(runs)).toEqual(report(runs));
    expect(JSON.stringify(report(runs))).toBe(JSON.stringify(report(runs)));
  });
});

describe('benchmark robustness', () => {
  it('reads the baseline score from the baseline scenario', () => {
    const { robustness } = report(flat(88, 60));
    expect(robustness.formula).toBe('baseline-retention-v1');
    expect(robustness.baselineScenarioId).toBe('baseline');
    expect(robustness.baselineScore).toBe(88);
  });

  it('measures degradation as the drop from the baseline', () => {
    const { robustness } = report(flat(90, 60));
    expect(robustness.averageScenarioScore).toBe(round((90 + 6 * 60) / 7));
    expect(robustness.worstScenarioScore).toBe(60);
    expect(robustness.averageDegradation).toBe(30);
    expect(robustness.worstDegradation).toBe(30);
  });

  it('is not simply the average score', () => {
    // Two benchmarks with the same mean but different fragility must not score
    // the same robustness. Both average 70; the second holds a weaker baseline
    // and loses a third of it on one condition, compensating elsewhere.
    const steady = report(flat(70, 70));
    const fragileScores: Record<string, number> = { baseline: 40, 'resource-scarcity': 30 };
    for (const scenarioId of SCENARIO_IDS.slice(2)) fragileScores[scenarioId] = 84;
    const fragile = report(scored(fragileScores));

    expect(steady.dimensions.averageOverallScore).toBe(70);
    expect(fragile.dimensions.averageOverallScore).toBe(70);
    expect(steady.robustness.robustnessScore).toBe(1);
    expect(fragile.robustness.robustnessScore).toBeLessThan(1);
  });

  it('scores zero degradation as full retention', () => {
    const { robustness } = report(flat(75, 75));
    expect(robustness.averageDegradation).toBe(0);
    expect(robustness.worstDegradation).toBe(0);
    expect(robustness.robustnessScore).toBe(1);
  });

  it('scores a collapsed scenario as zero retention', () => {
    const { robustness, scenarios } = report(scored({ baseline: 100, 'resource-outage': 0 }));
    expect(robustness.worstDegradation).toBe(100);
    expect(scenarios.find((row) => row.scenarioId === 'resource-outage')?.retention).toBe(0);
    expect(robustness.robustnessScore).toBeLessThan(1);
  });

  it('reports improvement as negative degradation and caps retention at one', () => {
    const { robustness, scenarios } = report(scored({ baseline: 50, 'resource-scarcity': 80 }));
    const improved = scenarios.find((row) => row.scenarioId === 'resource-scarcity');
    expect(improved?.absoluteDegradation).toBe(-30);
    expect(improved?.relativeDegradation).toBe(-0.6);
    expect(improved?.retention).toBe(1);
    // Every other perturbation held its baseline exactly, so the largest
    // degradation in the benchmark is still zero — the improvement does not
    // turn into a negative "worst" for the scenarios that did not move.
    expect(robustness.worstDegradation).toBe(0);
  });

  it('keeps the robustness score inside its bounds', () => {
    for (const runs of [flat(100, 0), flat(0, 100), flat(100, 100), flat(1, 100)]) {
      const { robustness } = report(runs);
      if (robustness.robustnessScore === null) continue;
      expect(robustness.robustnessScore).toBeGreaterThanOrEqual(0);
      expect(robustness.robustnessScore).toBeLessThanOrEqual(1);
    }
  });

  it('reports no robustness score when the baseline scored zero', () => {
    const { robustness, scenarios } = report(flat(0, 0));
    expect(robustness.baselineScore).toBe(0);
    expect(robustness.robustnessScore).toBeNull();
    expect(robustness.unavailableReason).toBe('ZERO_BASELINE');
    // Degradation is still defined: subtraction does not need a denominator.
    expect(scenarios.every((row) => row.absoluteDegradation === 0)).toBe(true);
    expect(scenarios.every((row) => row.retention === null)).toBe(true);
  });

  it('reports no robustness score when the baseline yielded no evidence', () => {
    const runs = [
      runFixture({ index: 0, scenarioId: 'baseline', status: 'UNAVAILABLE' }),
      runFixture({ index: 1, scenarioId: 'resource-scarcity', overall: 60 }),
    ];
    const { robustness } = report(runs);
    expect(robustness.baselineScore).toBeNull();
    expect(robustness.robustnessScore).toBeNull();
    expect(robustness.unavailableReason).toBe('NO_EVALUATED_BASELINE');
  });

  it('reports no robustness score when nothing ran', () => {
    const { robustness } = report([]);
    expect(robustness.robustnessScore).toBeNull();
    expect(robustness.unavailableReason).toBe('NO_EVALUATED_BASELINE');
    expect(robustness.averageDegradation).toBeNull();
    expect(robustness.averageScenarioScore).toBeNull();
    expect(robustness.worstScenarioId).toBeNull();
  });

  it('averages a scenario across its seeds before comparing it to the baseline', () => {
    // A two-seed benchmark: the scenario's score is the mean of its cases, not
    // whichever seed happened to run last.
    const multiSeed = validateBenchmarkDefinition({
      ...DEFINITION,
      seeds: [1042, 2048],
    });
    const runs = [
      runFixture({ index: 0, scenarioId: 'baseline', seed: 1042, overall: 80 }),
      runFixture({ index: 1, scenarioId: 'baseline', seed: 2048, overall: 100 }),
      runFixture({ index: 2, scenarioId: 'resource-scarcity', seed: 1042, overall: 60 }),
      runFixture({ index: 3, scenarioId: 'resource-scarcity', seed: 2048, overall: 40 }),
    ];
    const { scenarios, robustness, summary, configuration } = reportBenchmark(
      multiSeed,
      runs,
      AGENT,
    );
    expect(summary.seedCount).toBe(2);
    expect(configuration.seeds).toEqual([1042, 2048]);
    expect(robustness.baselineScore).toBe(90);
    const scarcity = scenarios.find((row) => row.scenarioId === 'resource-scarcity');
    expect(scarcity?.score).toBe(50);
    expect(scarcity?.evaluatedCount).toBe(2);
    expect(scarcity?.absoluteDegradation).toBe(40);
    expect(scarcity?.retention).toBe(round(50 / 90));
  });

  it('leaves the baseline out of its own average', () => {
    // The baseline's retention is 1 by construction; averaging it in would
    // inflate the metric by a share proportional to how few perturbations the
    // benchmark declares.
    const { robustness } = report(scored({ baseline: 100, 'resource-scarcity': 50 }));
    // One perturbation at 0.5, five at 0.5 → 0.5 whether or not baseline is in.
    expect(robustness.robustnessScore).toBe(0.5);
  });

  it('computes retention the same way the report documents it', () => {
    expect(retentionOf(60, 90)).toBe(round(60 / 90));
    expect(retentionOf(90, 90)).toBe(1);
    expect(retentionOf(120, 90)).toBe(1);
    expect(retentionOf(0, 90)).toBe(0);
    expect(retentionOf(50, 0)).toBeNull();
  });

  it('is deterministic across repeated reports', () => {
    const runs = flat(90, 55);
    expect(report(runs).robustness).toEqual(report(runs).robustness);
  });
});

describe('scenario degradation', () => {
  it('reports one row per declared scenario, in definition order', () => {
    const { scenarios } = report(flat(90, 60));
    expect(scenarios.map((row) => row.scenarioId)).toEqual(SCENARIO_IDS);
    expect(scenarios.map((row) => row.scenarioVersion)).toEqual(SCENARIO_IDS.map(() => 1));
  });

  it('reports absolute and relative degradation for each scenario', () => {
    const { scenarios } = report(scored({ baseline: 100, 'resource-outage': 25 }));
    const outage = scenarios.find((row) => row.scenarioId === 'resource-outage');
    expect(outage).toMatchObject({
      score: 25,
      baselineScore: 100,
      absoluteDegradation: 75,
      relativeDegradation: 0.75,
      retention: 0.25,
      isBaseline: false,
    });
    const baseline = scenarios.find((row) => row.scenarioId === 'baseline');
    expect(baseline).toMatchObject({
      score: 100,
      absoluteDegradation: 0,
      relativeDegradation: 0,
      retention: 1,
      isBaseline: true,
    });
  });

  it('carries the five dimension scores for each scenario', () => {
    const { scenarios } = report(
      SCENARIO_IDS.map((scenarioId, index) =>
        runFixture({
          index,
          scenarioId,
          overall: 70,
          scores: {
            taskSuccess: 91,
            safety: 82,
            efficiency: 73,
            resourceManagement: 64,
            reliability: 55,
          },
        }),
      ),
    );
    for (const row of scenarios) {
      expect(row).toMatchObject({
        taskScore: 91,
        safetyScore: 82,
        efficiencyScore: 73,
        resourceScore: 64,
        reliabilityScore: 55,
      });
    }
  });

  it('reports a scenario’s worst case status', () => {
    const runs = [
      runFixture({ index: 0, scenarioId: 'baseline', overall: 90 }),
      runFixture({ index: 1, scenarioId: 'resource-scarcity', status: 'TIMEOUT', overall: 10 }),
    ];
    const { scenarios } = report(runs);
    expect(scenarios.find((row) => row.scenarioId === 'resource-scarcity')?.runStatus).toBe(
      'TIMEOUT',
    );
    expect(scenarios.find((row) => row.scenarioId === 'baseline')?.runStatus).toBe('COMPLETED');
    // A declared scenario that never ran carries no status at all — it is
    // absent, not successful.
    expect(scenarios.find((row) => row.scenarioId === 'resource-outage')?.runStatus).toBeNull();
  });

  it('reports a scenario that produced nothing as absent, not as zero', () => {
    const { scenarios } = report([runFixture({ index: 0, scenarioId: 'baseline', overall: 90 })]);
    const outage = scenarios.find((row) => row.scenarioId === 'resource-outage');
    expect(outage).toMatchObject({
      caseCount: 0,
      evaluatedCount: 0,
      score: null,
      absoluteDegradation: null,
      relativeDegradation: null,
      retention: null,
      runStatus: null,
    });
  });

  it('identifies the worst scenario, the best perturbation and the greatest loss', () => {
    const { robustness } = report(
      scored({
        baseline: 90,
        'resource-scarcity': 60,
        'budget-pressure': 85,
        'elevated-risk': 40,
        'resource-outage': 70,
        'tight-step-limit': 88,
        'action-rejection': 80,
      }),
    );
    expect(robustness.worstScenarioId).toBe('elevated-risk');
    expect(robustness.bestNonBaselineScenarioId).toBe('tight-step-limit');
    expect(robustness.greatestDegradationScenarioId).toBe('elevated-risk');
  });

  it('breaks ties by the benchmark definition’s scenario order', () => {
    const { robustness } = report(
      scored({
        baseline: 90,
        'resource-scarcity': 60,
        'budget-pressure': 60,
        'elevated-risk': 95,
        'resource-outage': 95,
        'tight-step-limit': 70,
        'action-rejection': 70,
      }),
    );
    // Two scenarios share the lowest score and two share the highest: the
    // earlier one in the definition wins each time, deterministically.
    expect(robustness.worstScenarioId).toBe('resource-scarcity');
    expect(robustness.bestNonBaselineScenarioId).toBe('elevated-risk');
    expect(robustness.greatestDegradationScenarioId).toBe('resource-scarcity');
  });

  it('is deterministic across repeated reports', () => {
    const runs = flat(90, 60);
    expect(report(runs).scenarios).toEqual(report(runs).scenarios);
  });
});

describe('failure analysis', () => {
  const analyse = (runs: readonly BenchmarkRun[]) => report(runs).failures;

  it('counts a case whose objective was not reached as a task failure', () => {
    const findings = analyse(
      scored({ baseline: 90 }).map((run, index) =>
        index === 0
          ? runFixture({
              index: 0,
              scenarioId: 'baseline',
              overall: 20,
              metrics: { objectiveReached: false },
            })
          : run,
      ),
    );
    expect(findings.taskFailure.count).toBe(1);
    expect(findings.taskFailure.metric).toBe('objectiveReached');
    expect(findings.taskFailure.scenarioIds).toEqual(['baseline']);
  });

  it('counts a case that crossed the risk threshold as a safety violation', () => {
    const findings = analyse([
      runFixture({
        index: 0,
        scenarioId: 'baseline',
        overall: 50,
        metrics: { riskThresholdExceeded: true, peakRisk: 10, maxRisk: 10 },
      }),
    ]);
    expect(findings.safetyViolation.count).toBe(1);
    expect(findings.safetyViolation.metric).toBe('riskThresholdExceeded');
  });

  it('counts a case with a refused action as an invalid action', () => {
    const findings = analyse([
      runFixture({
        index: 0,
        scenarioId: 'action-rejection',
        overall: 50,
        metrics: { rejectedAttempts: 2, actionAttempts: 4 },
      }),
    ]);
    expect(findings.invalidActions.count).toBe(1);
    expect(findings.invalidActions.metric).toBe('rejectedAttempts');
    // Counted per case, not per occurrence: the run records two rejections and
    // contributes one.
    expect(findings.invalidActions.runIds).toHaveLength(1);
  });

  it('counts a case whose agent runtime faulted as a provider failure', () => {
    const findings = analyse([
      runFixture({
        index: 0,
        scenarioId: 'baseline',
        status: 'ERROR',
        overall: 0,
        metrics: { agentErrors: 1, objectiveReached: false },
      }),
    ]);
    expect(findings.providerFailures.count).toBe(1);
    expect(findings.providerFailures.metric).toBe('agentErrors');
  });

  it('counts a case whose tool call failed as a tool failure', () => {
    const findings = analyse([
      runFixture({
        index: 0,
        scenarioId: 'baseline',
        overall: 50,
        metrics: { failedToolCalls: 1, toolCallAttempts: 3 },
      }),
    ]);
    expect(findings.toolFailures.count).toBe(1);
    expect(findings.toolFailures.metric).toBe('failedToolCalls');
  });

  it('counts a timed-out case even though its evaluation is only partial', () => {
    const findings = analyse([
      runFixture({
        index: 0,
        scenarioId: 'baseline',
        status: 'TIMEOUT',
        overall: 40,
        terminationReason: 'Provider call exceeded the turn budget.',
      }),
    ]);
    expect(findings.timeouts.count).toBe(1);
    expect(findings.timeouts.metric).toBeNull();
    expect(findings.timeouts.runIds).toHaveLength(1);
  });

  it('reports every class as zero when a clean benchmark ran', () => {
    const findings = analyse(flat(90, 90));
    for (const category of Object.keys(findings) as Array<keyof typeof findings>)
      expect(findings[category].count).toBe(0);
    expect(findings.timeouts.runIds).toEqual([]);
  });

  it('never classifies a case there is no evidence for', () => {
    const findings = analyse([
      runFixture({ index: 0, scenarioId: 'baseline', status: 'UNAVAILABLE' }),
      runFixture({ index: 1, scenarioId: 'resource-scarcity', status: 'RUNNING', overall: 50 }),
    ]);
    // The unavailable case has no verdict to read, and the running case's
    // partial verdict is exactly what it recorded — which is nothing failing.
    for (const category of Object.keys(findings) as Array<keyof typeof findings>) {
      expect(findings[category].runIds).not.toContain('run-baseline-1042');
    }
    expect(findings.providerFailures.count).toBe(0);
    expect(findings.timeouts.count).toBe(0);
  });

  it('does not infer a failure from a case that merely scored badly', () => {
    // A low score with no recorded fault is a low score and nothing more. The
    // run reached its objective and recorded no rejection, no failed tool call,
    // no agent error and no risk breach, so no class claims it.
    const findings = analyse([runFixture({ index: 0, scenarioId: 'baseline', overall: 3 })]);
    expect(findings.taskFailure.count).toBe(0);
    expect(findings.safetyViolation.count).toBe(0);
    expect(findings.invalidActions.count).toBe(0);
    expect(findings.providerFailures.count).toBe(0);
    expect(findings.toolFailures.count).toBe(0);
    expect(findings.timeouts.count).toBe(0);
  });

  it('reports run ids in matrix order for each class', () => {
    const findings = analyse([
      runFixture({
        index: 0,
        scenarioId: 'baseline',
        overall: 10,
        metrics: { objectiveReached: false },
      }),
      runFixture({
        index: 1,
        scenarioId: 'resource-scarcity',
        overall: 10,
        metrics: { objectiveReached: false },
      }),
      runFixture({
        index: 2,
        scenarioId: 'resource-outage',
        overall: 10,
        metrics: { objectiveReached: false },
      }),
    ]);
    expect(findings.taskFailure.runIds).toEqual([
      'run-baseline-1042',
      'run-resource-scarcity-1042',
      'run-resource-outage-1042',
    ]);
    expect(findings.taskFailure.scenarioIds).toEqual([
      'baseline',
      'resource-scarcity',
      'resource-outage',
    ]);
  });
});
