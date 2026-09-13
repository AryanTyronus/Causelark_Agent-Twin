//
// Everything here is a fold over the benchmark engine's own report for one
// agent. Nothing is re-simulated, nothing is asked of a model, and no score is
// invented: the report already carries the dimensions, the robustness score,
// the scenario rows, the failure analysis and every case's `EvaluationResult`,
// and this module only re-expresses those numbers in the form a head-to-head
// needs.
//
// Two rules are load-bearing.
//
// Absence is absence. A rate whose denominator is zero is `null`, not zero; a
// mean over no cases is `null`; a robustness score the benchmark engine declined
// to compute stays `null` and keeps its stated reason. The comparison treats two
// absences as "no basis to compare" — never as "equal at zero", which would let
// an agent that produced nothing tie with one that produced a real measurement.
//
// Counts are counts. Every mean is taken over the *evaluated* cases only, which
// is the same population the benchmark engine averages over, so an agent is not
// penalised for a case that yielded no verdict — that case is reported in the
// case counts and in the failure analysis instead, where a reader can see it.

import { meanScore, ratioScore } from '@/lib/benchmarks/arithmetic';
import type { BenchmarkResult, BenchmarkRun } from '@/lib/benchmarks/types';
import type { AgentMetrics, ComparisonAgent } from './types';

/** The cases that produced a verdict, in matrix order. */
function evaluated(runs: readonly BenchmarkRun[]): BenchmarkRun[] {
  return runs.filter((run) => run.evaluation !== null);
}

/**
 * The mean of an integer-valued per-case measurement, over evaluated cases.
 *
 * `meanScore` is the benchmark engine's mean of reported scores: it works in
 * exact integer hundredths and rounds once at the boundary, half away from
 * zero. Step counts, budget amounts and risk levels are all integers, so the
 * same arithmetic applies unchanged and no second rounding rule is introduced.
 * The name is the benchmark engine's, the guarantee is the benchmark engine's.
 */
function meanOf(
  runs: readonly BenchmarkRun[],
  read: (run: BenchmarkRun) => number | null,
): number | null {
  const values: number[] = [];
  for (const run of runs) {
    const value = read(run);
    if (value !== null) values.push(value);
  }
  return meanScore(values);
}

/** The sum of an integer-valued per-case measurement, over evaluated cases. */
function sumOf(runs: readonly BenchmarkRun[], read: (run: BenchmarkRun) => number): number {
  return runs.reduce((total, run) => total + read(run), 0);
}

/**
 * The metrics one agent's report supports.
 *
 * `report` is `null` for an agent that produced no evidence at all — a
 * configuration this deployment could not run, or an execution that faulted
 * before its first case. In that case every metric is `null` or zero, and the
 * agent's status says why. An agent is never reported as having scored zero.
 */
export function agentMetrics(report: BenchmarkResult | null): AgentMetrics {
  if (!report) return emptyMetrics();
  const cases = evaluated(report.runs);
  const summary = report.summary;
  const dimensions = report.dimensions;

  // Objective reached is the evaluation engine's own task-success signal, so
  // the rate is taken over it rather than over a run status re-read here.
  const reached = cases.filter((run) => run.evaluation?.metrics.objectiveReached === true).length;

  // A case reached a terminal status of its own when it is neither still
  // running nor unreadable: those are the two states that produced no verdict.
  const terminal =
    summary.completedCases +
    summary.limitReachedCases +
    summary.failedCases +
    summary.timeoutCases +
    summary.errorCases;

  const spent = sumOf(cases, (run) => run.evaluation?.metrics.budgetSpent ?? 0);
  const limits = sumOf(cases, (run) => run.evaluation?.metrics.budgetLimit ?? 0);

  return {
    evaluatedCaseCount: dimensions.evaluatedCaseCount,
    averageOverallScore: dimensions.averageOverallScore,
    averageTaskScore: dimensions.averageTaskScore,
    averageSafetyScore: dimensions.averageSafetyScore,
    averageEfficiencyScore: dimensions.averageEfficiencyScore,
    averageResourceScore: dimensions.averageResourceScore,
    averageReliabilityScore: dimensions.averageReliabilityScore,
    taskSuccessRate: ratioScore(reached, cases.length),
    completionRate: ratioScore(terminal, summary.totalCases),
    robustnessScore: report.robustness.robustnessScore,
    rejectedActionRate: ratioScore(
      sumOf(cases, (run) => run.evaluation?.metrics.rejectedAttempts ?? 0),
      sumOf(cases, (run) => run.evaluation?.metrics.actionAttempts ?? 0),
    ),
    averageRisk: meanOf(cases, (run) => run.evaluation?.metrics.peakRisk ?? null),
    providerFailureCount: report.failures.providerFailures.count,
    toolFailureCount: report.failures.toolFailures.count,
    timeoutCount: report.failures.timeouts.count,
    averageSteps: meanOf(cases, (run) => run.evaluation?.metrics.acceptedTransitions ?? null),
    averageBudgetSpent: meanOf(cases, (run) => run.evaluation?.metrics.budgetSpent ?? null),
    averageBudgetUtilisation: ratioScore(spent, limits),
  };
}

/** The metric block of an agent that produced no evidence. */
function emptyMetrics(): AgentMetrics {
  return {
    evaluatedCaseCount: 0,
    averageOverallScore: null,
    averageTaskScore: null,
    averageSafetyScore: null,
    averageEfficiencyScore: null,
    averageResourceScore: null,
    averageReliabilityScore: null,
    taskSuccessRate: null,
    completionRate: null,
    robustnessScore: null,
    rejectedActionRate: null,
    averageRisk: null,
    providerFailureCount: 0,
    toolFailureCount: 0,
    timeoutCount: 0,
    averageSteps: null,
    averageBudgetSpent: null,
    averageBudgetUtilisation: null,
  };
}

/**
 * The scenario an agent scored highest, and lowest, under.
 *
 * The fold walks the report's scenario rows in the benchmark's declared order
 * and keeps the first strict best and first strict worst, so a tie resolves to
 * the earlier scenario in the definition rather than to whichever the iteration
 * happened to reach first. Scenarios with no score are skipped: an absent
 * measurement is not a low one.
 */
export function extremeScenarios(report: BenchmarkResult | null): {
  strongestScenarioId: string | null;
  weakestScenarioId: string | null;
} {
  if (!report) return { strongestScenarioId: null, weakestScenarioId: null };
  let strongest: { id: string; score: number } | null = null;
  let weakest: { id: string; score: number } | null = null;
  for (const row of report.scenarios) {
    if (row.score === null) continue;
    if (!strongest || row.score > strongest.score)
      strongest = { id: row.scenarioId, score: row.score };
    if (!weakest || row.score < weakest.score) weakest = { id: row.scenarioId, score: row.score };
  }
  return {
    strongestScenarioId: strongest?.id ?? null,
    weakestScenarioId: weakest?.id ?? null,
  };
}

/** Assemble one agent's side of the comparison from its own report. */
export function buildComparisonAgent(input: {
  agent: ComparisonAgent['agent'];
  identity: string;
  key: string;
  report: BenchmarkResult | null;
  unavailableReason: ComparisonAgent['unavailableReason'];
}): ComparisonAgent {
  const extremes = extremeScenarios(input.report);
  return {
    agent: input.agent,
    identity: input.identity,
    key: input.key,
    status: input.report ? 'COMPARED' : 'UNAVAILABLE',
    unavailableReason: input.report ? null : input.unavailableReason,
    metrics: agentMetrics(input.report),
    report: input.report,
    ...extremes,
  };
}
