// @polsia:user-owned — the run-level counterfactual report.
//
// This module folds one analysis per decision point into a single report and
// ranks the decisions by what they gave up. The ranking is the answer to "how
// much did a specific decision contribute to the outcome", and it is stated
// throughout as a regret under a named continuation policy: what the best
// alternative the engine could construct would have scored, minus what the run
// recorded. It is not a causal claim, and the report never phrases it as one.
//
// Two ordering rules are load-bearing:
//
//   Decision points keep recorded order — a function of the evidence, never of
//   iteration.
//
//   The ranking sorts by regret, descending, and breaks every tie by decision
//   order. Two decisions that gave up the same amount are therefore always
//   ranked the same way, on every run of the analysis.
//
// Nothing here reads a clock, a random source, a database or a provider.

import { maximumScore, meanScore, minimumScore } from '@/lib/benchmarks/arithmetic';
import { evaluateRun } from '@/lib/evaluation/evaluation';
import type { EvaluationInput, EvaluationResult } from '@/lib/evaluation/types';
import { type AnalysedDecision, analyseDecision, describeAction, scoresOf } from './analysis';
import { projectWorld } from './continuation';
import { extractDecisionPoints } from './decisions';
import {
  ACTION_SPACE_POLICY,
  COMPARISON_POLICY,
  CONTINUATION_POLICY,
  type CounterfactualContribution,
  type CounterfactualDecision,
  type CounterfactualPolicies,
  type CounterfactualReport,
  CounterfactualReport as CounterfactualReportSchema,
  type CounterfactualSummary,
} from './types';

/** A whole-run analysis: the report, plus the detail a drill-down serves. */
export interface CounterfactualAnalysis {
  report: CounterfactualReport;
  /**
   * Every decision point with the full alternative list behind it. The report
   * carries per-decision aggregates because a report has to stay readable at the
   * scale of a run; this keeps the evidence those aggregates were folded from.
   */
  details: AnalysedDecision[];
}

/**
 * The policies every number in an analysis is stated under.
 *
 * Exported as one function rather than repeated at each entry point, so a report
 * and a drill-down of the same run can never claim to have been computed under
 * different assumptions.
 */
export function reportPolicies(): CounterfactualPolicies {
  return {
    actionSpace: ACTION_SPACE_POLICY,
    continuation: CONTINUATION_POLICY,
    comparison: COMPARISON_POLICY,
  };
}

/**
 * A deterministic sentence describing what a decision gave up.
 *
 * Template-generated from the measured numbers, and explicit about the policy
 * the counterfactual was computed under, because "the agent would have scored
 * 87" is not a finding unless the reader knows what "would have" means.
 */
function describeContribution(
  decision: CounterfactualDecision,
  regret: number,
  recordedOverall: number,
): string {
  const head = `Decision ${decision.index} at step ${decision.step} (${describeAction(decision.action)}):`;
  if (regret === 0 || decision.best === null)
    return `${head} no valid alternative would have scored above the recorded ${recordedOverall}.`;
  return `${head} ${decision.best.key} would have scored ${decision.best.outcome.overallScore} against the recorded ${recordedOverall} — ${regret} more, under the ${CONTINUATION_POLICY} continuation.`;
}

/**
 * Rank the decisions by regret.
 *
 * Every decision that had any alternative to compare against is ranked,
 * including the ones that gave up nothing: a decision nobody could have improved
 * on is a result, and dropping it would make the ranking read as though the run
 * had fewer decisions than it did.
 */
function rankDecisions(
  decisions: readonly CounterfactualDecision[],
  recordedOverall: number,
): CounterfactualContribution[] {
  const scored: { decision: CounterfactualDecision; regret: number; position: number }[] = [];
  decisions.forEach((decision, position) => {
    if (decision.regret !== null) scored.push({ decision, regret: decision.regret, position });
  });
  scored.sort((left, right) => right.regret - left.regret || left.position - right.position);
  return scored.map((entry, offset) => ({
    rank: offset + 1,
    index: entry.decision.index,
    step: entry.decision.step,
    actionId: entry.decision.actionId,
    source: entry.decision.source,
    action: entry.decision.action,
    regret: entry.regret,
    outcomeFlipCount: entry.decision.outcomeFlips.count,
    recordedOverall,
    bestAlternativeKey: entry.decision.best?.key ?? null,
    bestAlternativeOverall: entry.decision.best?.outcome.overallScore ?? null,
    statement: describeContribution(entry.decision, entry.regret, recordedOverall),
  }));
}

/**
 * The run-level aggregate.
 *
 * The four decision counts plus `uncontestedDecisions` partition the decision
 * points exactly, and the alternative statistics are computed over every
 * analysed alternative rather than averaged from the per-decision means — a mean
 * of means would weight a decision with two alternatives the same as one with
 * thirty.
 */
function summarise(
  decisions: readonly CounterfactualDecision[],
  details: readonly AnalysedDecision[],
): CounterfactualSummary {
  const alternativeScores = details.flatMap((detail) =>
    detail.alternatives.map((alternative) => alternative.outcome.overallScore),
  );
  const regrets = decisions
    .map((decision) => decision.regret)
    .filter((regret): regret is number => regret !== null);
  const withAlternatives = decisions.filter((decision) => decision.alternatives.analysed > 0);
  return {
    decisionPoints: decisions.length,
    agentDecisions: decisions.filter((decision) => decision.source === 'agent').length,
    manualDecisions: decisions.filter((decision) => decision.source === 'manual').length,
    alternativesAnalysed: decisions.reduce(
      (total, decision) => total + decision.alternatives.analysed,
      0,
    ),
    enumeratedActions: decisions.reduce((total, decision) => total + decision.space.enumerated, 0),
    validActions: decisions.reduce((total, decision) => total + decision.space.valid, 0),
    invalidActions: decisions.reduce((total, decision) => total + decision.space.invalid, 0),
    improvingDecisions: decisions.filter((decision) => decision.alternatives.improving > 0).length,
    equivalentDecisions: withAlternatives.filter(
      (decision) => decision.alternatives.improving === 0 && decision.alternatives.worsening === 0,
    ).length,
    worseningDecisions: withAlternatives.filter(
      (decision) => decision.alternatives.improving === 0 && decision.alternatives.worsening > 0,
    ).length,
    uncontestedDecisions: decisions.filter((decision) => decision.alternatives.analysed === 0)
      .length,
    outcomeFlipDecisions: decisions.filter((decision) => decision.outcomeFlips.count > 0).length,
    bestAlternativeOverall: maximumScore(alternativeScores),
    worstAlternativeOverall: minimumScore(alternativeScores),
    meanAlternativeOverall: meanScore(alternativeScores),
    maxRegret: maximumScore(regrets),
    meanRegret: meanScore(regrets),
  };
}

/**
 * Analyse a whole run.
 *
 * Pure and deterministic: the same evidence twice returns the same report,
 * byte for byte. The recorded run is scored once, by the evaluation engine, and
 * every comparison in the report is measured against that one verdict.
 */
export function analyzeCounterfactuals(source: EvaluationInput): CounterfactualAnalysis {
  const baseline: EvaluationResult = evaluateRun(source);
  const contexts = extractDecisionPoints(source);
  const details = contexts.map((context) => analyseDecision({ source, baseline, context }));
  const decisions = details.map((detail) => detail.decision);
  const ranking = rankDecisions(decisions, baseline.overallScore);
  const top = ranking[0];

  return {
    details,
    report: CounterfactualReportSchema.parse({
      run: {
        runId: source.runId,
        status: source.status,
        inProgress: source.status === 'RUNNING',
        scenario: source.scenario ?? null,
        decisionPointCount: contexts.length,
        world: projectWorld(source.state),
      },
      baseline: { overallScore: baseline.overallScore, scores: scoresOf(baseline) },
      policies: reportPolicies(),
      summary: summarise(decisions, details),
      decisions,
      causal: {
        ranking,
        // `null` rather than the top of a ranking in which nothing improved: a
        // "critical decision" that gave up nothing is not a critical decision.
        criticalDecision: top !== undefined && top.regret > 0 ? top : null,
      },
    }),
  };
}
