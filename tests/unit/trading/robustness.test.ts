// @vitest-environment node
//
// ROBUSTNESS — how much of the baseline score survives each market condition.
//
// There is no second robustness calculation here, and that is the whole point of
// this file. The trading benchmark is reduced by `buildScenarioDegradations` and
// `measureRobustness` — the same two functions, reading the same
// `baseline-retention-v1` formula, that the resource benchmark is reduced by. A
// trading-specific robustness metric would make the two benchmarks' headline
// numbers incomparable while looking identical, which is worse than having no
// number at all.
//
// What these tests add is the trading world's own content: that every one of the
// seven conditions reaches the table, that the baseline is the condition the
// benchmark declares, and that the report's numbers reconcile with the rows it
// summarises — the last of which is what a reader auditing a robustness claim
// actually checks.

import { describe, expect, it } from 'vitest';
import { meanScore } from '@/lib/benchmarks/arithmetic';
import { getBenchmark } from '@/lib/benchmarks/catalog';
import { buildRunMatrix } from '@/lib/benchmarks/matrix';
import {
  buildScenarioDegradations,
  measureRobustness,
  retentionOf,
} from '@/lib/benchmarks/robustness';
import {
  BENCHMARK_ROBUSTNESS_FORMULA,
  type BenchmarkDefinition,
  type BenchmarkRun,
  CASE_STATUS_SEVERITY,
} from '@/lib/benchmarks/types';
import { evaluateRun } from '@/lib/evaluation/evaluation';
import { TRADING_BASELINE_SCENARIO_ID } from '@/lib/scenarios/definitions';
import { disciplinedPolicy, type Policy, recklessPolicy, scriptedRun } from './harness';

const DEFINITION = getBenchmark('trading-10k') as BenchmarkDefinition;

/**
 * One cell of the trading matrix — a condition at the benchmark's own seed —
 * executed through the shipped pipeline and scored by the shipped engine.
 *
 * The run is scripted rather than model-driven because a robustness test must
 * not depend on a provider: what it measures is the environment's sensitivity to
 * its conditions, so the policy is held fixed and only the condition varies.
 */
function cell(policy: Policy, scenarioId: string, seed: number): BenchmarkRun {
  const run = scriptedRun({ policy, scenarioId, seed });
  return {
    case: {
      index: 0,
      key: `${scenarioId}@${seed}`,
      scenarioId,
      scenarioVersion: 1,
      seed,
      isBaseline: scenarioId === DEFINITION.baselineScenarioId,
    },
    runId: run.evidence.runId,
    status: run.evidence.status,
    outcome:
      run.evidence.status === 'COMPLETED' || run.evidence.status === 'LIMIT_REACHED'
        ? 'succeeded'
        : run.evidence.status === 'FAILED'
          ? 'unsuccessful'
          : 'inProgress',
    terminationReason: run.evidence.terminationReason,
    evaluation: evaluateRun(run.evidence),
  };
}

/** Every condition in the definition, at the benchmark's own seed, one policy. */
function corpus(policy: Policy): BenchmarkRun[] {
  return buildRunMatrix(DEFINITION).map((entry) => cell(policy, entry.scenarioId, entry.seed));
}

describe('the trading benchmark is reduced by the platform’s robustness engine', () => {
  it('publishes the same formula constant the resource benchmark publishes', () => {
    // One formula, named once, in the schema that both benchmarks' reports are
    // parsed against. If a second calculation were ever introduced this is where
    // it would have to show up.
    expect(DEFINITION.id).toBe('trading-10k');
    const report = measureRobustness(
      buildScenarioDegradations(DEFINITION, corpus(disciplinedPolicy())),
    );
    expect(report.formula).toBe(BENCHMARK_ROBUSTNESS_FORMULA);
    expect(getBenchmark('resource-routing-robustness')?.environmentKey).toBe('resource-routing');
  });

  it('puts every one of the seven conditions in the table, baseline first', () => {
    const rows = buildScenarioDegradations(DEFINITION, corpus(disciplinedPolicy()));
    expect(rows.map((row) => row.scenarioId)).toEqual(
      DEFINITION.scenarios.map((scenario) => scenario.id),
    );
    expect(rows).toHaveLength(7);
    expect(rows.filter((row) => row.isBaseline)).toHaveLength(1);
    expect(rows.find((row) => row.isBaseline)?.scenarioId).toBe(TRADING_BASELINE_SCENARIO_ID);
  });

  it('leaves a condition that produced no evidence visibly in the table', () => {
    // A condition that ran nothing must be an absent row with a null score, not
    // a missing row: dropping it would silently enlarge the mean.
    const rows = buildScenarioDegradations(DEFINITION, corpus(disciplinedPolicy()).slice(0, 1));
    expect(rows).toHaveLength(7);
    const empty = rows.filter((row) => row.evaluatedCount === 0);
    expect(empty.length).toBe(6);
    for (const row of empty) {
      expect(row.score).toBeNull();
      expect(row.retention).toBeNull();
    }
  });

  it('derives retention, and the degradation beside it, from the row it publishes', () => {
    const rows = buildScenarioDegradations(DEFINITION, corpus(disciplinedPolicy()));
    const baseline = rows.find((row) => row.isBaseline);
    expect(baseline?.score).not.toBeNull();
    const baselineScore = baseline?.score as number;

    for (const row of rows) {
      expect(row.baselineScore, row.scenarioId).toBe(baselineScore);
      if (row.score === null) continue;

      // Retention is the published ratio, not a second opinion about it.
      expect(row.retention, row.scenarioId).toBe(retentionOf(row.score, baselineScore));

      // Degradation is reported in the SAME units as the scores it subtracts —
      // points of the 0..100 scale, not a fraction of the baseline — so an
      // auditor can do the subtraction on the two printed numbers themselves and
      // land on the value beside them. A fraction here would read as a plausible
      // 0..1 number and quietly break that reconciliation.
      const byHand = Math.round((baselineScore - row.score) * 100) / 100;
      expect(row.absoluteDegradation, row.scenarioId).toBe(byHand);
      expect(Math.abs(byHand), row.scenarioId).toBeLessThanOrEqual(100);

      // And the relative figure is that degradation over the baseline, to the
      // published precision — the rounding of a ratio, so within half a unit in
      // the last place rather than exact.
      const relative = row.relativeDegradation as number;
      expect(Math.abs(relative - byHand / baselineScore), row.scenarioId).toBeLessThanOrEqual(
        0.005 + Number.EPSILON,
      );
      // The two readings of the same gap agree: one is the complement of the
      // other against the baseline.
      expect(row.retention as number, row.scenarioId).toBeCloseTo(1 - relative, 2);
    }
  });

  it('summarises the rows it was handed, so the printout reconciles', () => {
    const rows = buildScenarioDegradations(DEFINITION, corpus(disciplinedPolicy()));
    const report = measureRobustness(rows);
    const evaluated = rows.filter((row) => row.score !== null);
    const perturbed = rows.filter((row) => !row.isBaseline && row.score !== null);

    expect(report.baselineScenarioId).toBe(TRADING_BASELINE_SCENARIO_ID);
    expect(report.evaluatedScenarioCount).toBe(evaluated.length);
    expect(report.perturbedScenarioCount).toBe(rows.filter((row) => !row.isBaseline).length);
    expect(report.worstScenarioScore).toBe(
      Math.min(...evaluated.map((row) => row.score as number)),
    );
    expect(report.averageScenarioScore).toBe(
      meanScore(evaluated.map((row) => row.score as number)),
    );
    expect(report.averageDegradation).toBe(
      meanScore(perturbed.map((row) => row.absoluteDegradation as number)),
    );
    // The headline is the mean of the perturbed scenarios' REPORTED retentions
    // and nothing else — the baseline's own 1 is a reference, not a sample, and
    // counting it would inflate the metric by however few perturbations the
    // definition happens to declare. Recomputed here with the platform's own
    // mean, from the retentions the rows publish beside it.
    expect(report.robustnessScore).toBe(meanScore(perturbed.map((row) => row.retention as number)));
    expect(report.unavailableReason).toBeNull();
  });

  it('reports the number unavailable rather than zero when there is no baseline to retain', () => {
    // An absent measurement must never arrive as a zero: a robustness score of 0
    // reads as "nothing survived", which is a claim, not an absence. The two ways
    // a baseline can fail to be a usable reference are distinguished, because
    // they are different faults — one is a definition that names no baseline, the
    // other a baseline that ran and scored nothing.
    // No baseline row in the table at all: the report cannot even name the
    // condition it would have measured against.
    const absent = measureRobustness(
      buildScenarioDegradations(DEFINITION, corpus(disciplinedPolicy())).filter(
        (row) => !row.isBaseline,
      ),
    );
    expect(absent.robustnessScore).toBeNull();
    expect(absent.unavailableReason).toBe('MISSING_BASELINE');
    expect(absent.baselineScore).toBeNull();
    expect(absent.baselineScenarioId).toBeNull();

    // The row is present, so the report can still name the condition it failed to
    // measure against — and the score it cannot compute is still not a zero.
    const unscored = measureRobustness(
      buildScenarioDegradations(DEFINITION, corpus(disciplinedPolicy()).slice(1)),
    );
    expect(unscored.robustnessScore).toBeNull();
    expect(unscored.unavailableReason).toBe('NO_EVALUATED_BASELINE');
    expect(unscored.baselineScenarioId).toBe(TRADING_BASELINE_SCENARIO_ID);
    expect(unscored.baselineScore).toBeNull();
  });
});

describe('what the trading conditions do to a fixed policy', () => {
  const rows = () => buildScenarioDegradations(DEFINITION, corpus(disciplinedPolicy()));

  it('holds the baseline above every perturbed condition, which is what makes it a baseline', () => {
    // If a condition scored ABOVE the baseline the benchmark would be claiming
    // that perturbing the market helped, which is a calibration fault, not a
    // finding. The baseline is the easiest of the seven by construction.
    const table = rows();
    const baseline = table.find((row) => row.isBaseline)?.score ?? 0;
    for (const row of table.filter((entry) => !entry.isBaseline)) {
      expect(row.score, row.scenarioId).not.toBeNull();
      expect(row.score as number, row.scenarioId).toBeLessThanOrEqual(baseline);
    }
  });

  it('reports the greatest degradation against the condition that caused it', () => {
    const table = rows();
    const report = measureRobustness(table);
    const worst = table
      .filter((row) => !row.isBaseline && row.absoluteDegradation !== null)
      .reduce((a, b) => ((a.absoluteDegradation ?? 0) >= (b.absoluteDegradation ?? 0) ? a : b));
    expect(report.greatestDegradationScenarioId).toBe(worst.scenarioId);
    expect(report.worstDegradation).toBe(worst.absoluteDegradation);
  });

  it('is a deterministic function of the conditions, not of the order they ran in', () => {
    const first = measureRobustness(rows());
    const second = measureRobustness(rows());
    expect(second).toEqual(first);
  });

  it('degrades a reckless policy differently from a disciplined one, on the same seven markets', () => {
    // Robustness is a property of a policy, not of the world: the table is
    // rebuilt per agent, and two policies facing identical markets must not
    // produce identical rows. If they did, the reduction would be reading the
    // conditions rather than the behaviour.
    const disciplined = measureRobustness(rows());
    const reckless = measureRobustness(
      buildScenarioDegradations(DEFINITION, corpus(recklessPolicy('GAMMA'))),
    );
    expect(reckless.baselineScore).not.toBe(disciplined.baselineScore);
    expect(reckless.robustnessScore).not.toBe(disciplined.robustnessScore);
    // Both are still reduced by the one formula.
    expect(reckless.formula).toBe(disciplined.formula);
  });

  it('reports each condition’s own dimensional scores, not only its total', () => {
    // The row carries the five dimension means, so a degradation can be
    // attributed to a dimension rather than only to the headline number.
    for (const row of rows()) {
      if (row.score === null) continue;
      for (const dimension of [
        row.taskScore,
        row.safetyScore,
        row.efficiencyScore,
        row.resourceScore,
        row.reliabilityScore,
      ])
        expect(dimension, row.scenarioId).not.toBeNull();
      expect(row.caseCount, row.scenarioId).toBe(1);
      expect(CASE_STATUS_SEVERITY as readonly string[]).toContain(row.runStatus);
    }
  });
});
