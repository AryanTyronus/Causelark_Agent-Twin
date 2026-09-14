// @vitest-environment node
//
// EVALUATION — what a trading run is scored on, and what the score is for.
//
// The engine is the platform's, unchanged: five categories, a weighted mean, and
// a scoring profile that travels with the evidence. Nothing in this file adds a
// dimension, and that is the point — the trading benchmark is measured by the
// same evaluator as the resource benchmark, so a score means the same kind of
// thing in both.
//
// THE FORMULA, in full, so a reader can recompute any verdict by hand:
//
//   taskSuccess          100 * progressAchieved / progressTarget                 w 0.30
//   safety               100 * (1 - consumedHeadroom / availableHeadroom)        w 0.25
//   efficiency           100 * progressPerTransition / maxProgressPerTransition    w 0.15
//   resourceManagement   100 * optimalBudgetPerProgressUnit / budgetPerProgressUnit w 0.15
//   reliability          100 * (1 - faults / opportunities)                      w 0.15
//   overall              round(sum(category * weight)), clamped to 0..100
//
// In this world those quantities are, concretely: progress is the portfolio's
// gain in dollars against the $500 target; risk is peak-to-trough drawdown in
// whole percent against the 8% ceiling; a transition is one accepted buy, sell
// or hold; budget units are execution-cost units; and faults are rejected
// requests, failed tool calls and agent errors.
//
// The behaviour these tests exist to pin is the objective's own second sentence:
// a profitable run is not automatically a good one. A run that made MORE money
// with a worse path scores LOWER, and that is asserted against two real
// trajectories rather than argued for.

import { describe, expect, it } from 'vitest';
import { evaluateRun } from '@/lib/evaluation/evaluation';
import { collectEvaluationMetrics } from '@/lib/evaluation/metrics';
import {
  DEFAULT_SCORING_PROFILE,
  EFFICIENCY_WEIGHT,
  RELIABILITY_WEIGHT,
  RESOURCE_MANAGEMENT_WEIGHT,
  SAFETY_WEIGHT,
  scoreEvaluation,
  scoreOverall,
  TASK_SUCCESS_WEIGHT,
} from '@/lib/evaluation/scoring';
import { EVALUATION_CATEGORIES, type EvaluationInput } from '@/lib/evaluation/types';
import { TRADING_SCORING_PROFILE } from '@/lib/trading/environment';
import { equityCents, totalReturnBps } from '@/lib/trading/portfolio';
import { INITIAL_STATE } from './fixtures';
import {
  basketPolicy,
  churningPolicy,
  DISCIPLINED_BOOK,
  disciplinedPolicy,
  recklessPolicy,
  type ScriptedRun,
  scriptedRun,
} from './harness';

/** Score one scripted run and hand back both the verdict and the run. */
function score(run: ScriptedRun) {
  return { run, evaluation: evaluateRun(run.evidence) };
}

/** The score of one named category, or a thrown error naming what was missing. */
function categoryOf(run: ScriptedRun, category: string): number {
  const found = evaluateRun(run.evidence).categories.find((entry) => entry.category === category);
  if (!found) throw new Error(`the verdict reported no ${category} category`);
  return found.score;
}

/** The final portfolio gain in dollars, which is what progress measures here. */
function gain(run: ScriptedRun): number {
  return run.state.progress;
}

/** The final portfolio return in basis points. */
function returnBps(run: ScriptedRun): number {
  const book = run.state.trading;
  if (!book) throw new Error('expected a trading book');
  return totalReturnBps(book);
}

describe('the dimensions a trading run is scored on', () => {
  const run = scriptedRun({ policy: disciplinedPolicy() });

  it('reports all five categories, in the engine’s own order, with its own weights', () => {
    const { evaluation } = score(run);
    expect(evaluation.categories.map((entry) => entry.category)).toEqual([
      ...EVALUATION_CATEGORIES,
    ]);
    expect(evaluation.categories.map((entry) => entry.weight)).toEqual([
      TASK_SUCCESS_WEIGHT,
      SAFETY_WEIGHT,
      EFFICIENCY_WEIGHT,
      RESOURCE_MANAGEMENT_WEIGHT,
      RELIABILITY_WEIGHT,
    ]);
    // The weights are a weighted MEAN, so they have to sum to one. A profile
    // that did not would silently rescale every score in the benchmark.
    const total = evaluation.categories.reduce((sum, entry) => sum + entry.weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('is reproducible by hand from the result alone', () => {
    // The whole formula, recomputed from the reported metrics and the exported
    // weights: if this drifts, the numbers a reader checks no longer reconcile
    // with the numbers they are shown.
    const { evaluation } = score(run);
    const metrics = evaluation.metrics;
    const profile = TRADING_SCORING_PROFILE;

    const byHand: Record<string, number> = {
      taskSuccess: metrics.progressRatio * 100,
      safety:
        metrics.maxRisk - metrics.initialRisk <= 0
          ? 0
          : (1 -
              Math.min(
                1,
                Math.max(0, metrics.peakRisk - metrics.initialRisk) /
                  (metrics.maxRisk - metrics.initialRisk),
              )) *
            100,
      efficiency: (metrics.progressPerTransition / profile.maxProgressPerTransition) * 100,
      resourceManagement:
        metrics.budgetPerProgressUnit === null || metrics.budgetPerProgressUnit <= 0
          ? 0
          : (profile.optimalBudgetPerProgressUnit / metrics.budgetPerProgressUnit) * 100,
      reliability:
        metrics.actionAttempts + metrics.toolCallAttempts + metrics.turnCount === 0
          ? 0
          : (1 -
              (metrics.rejectedAttempts + metrics.failedToolCalls + metrics.agentErrors) /
                (metrics.actionAttempts + metrics.toolCallAttempts + metrics.turnCount)) *
            100,
    };
    const clamp = (value: number) =>
      Math.min(100, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));

    for (const entry of evaluation.categories)
      expect(entry.score, entry.category).toBe(clamp(byHand[entry.category] as number));

    const overall = clamp(
      evaluation.categories.reduce((sum, entry) => sum + entry.score * entry.weight, 0),
    );
    expect(evaluation.overallScore).toBe(overall);
  });

  it('reads every dimension the benchmark claims to measure', () => {
    // Each claimed dimension is tied to the concrete quantity it comes from, so
    // a reader can point at the number rather than at the category name.
    const metrics = evaluateRun(run.evidence).metrics;
    const book = run.state.trading as never;
    const rejectedRisk = run.codes.filter(
      (code) => code === 'CONCENTRATION_LIMIT' || code === 'EXPOSURE_LIMIT',
    ).length;

    // Return: the gain against the target, and the portfolio's own return.
    expect(metrics.progressAchieved).toBe(gain(run));
    expect(metrics.progressTarget).toBe(run.initialState.target);
    expect(returnBps(run)).toBe(totalReturnBps(book));
    // Drawdown: peak and final, against the ceiling the run is terminated on.
    expect(metrics.maxRisk).toBe(run.initialState.maxRisk);
    expect(metrics.peakRisk).toBeGreaterThanOrEqual(metrics.finalRisk);
    expect(metrics.riskHeadroomRemaining).toBe(metrics.maxRisk - metrics.finalRisk);
    // Risk constraint violations.
    expect(metrics.riskThresholdExceeded).toBe(run.evidence.status === 'FAILED');
    expect(rejectedRisk).toBe(run.codes.filter((code) => code.endsWith('_LIMIT')).length);
    // Rejected action rate, tool failures, steps.
    expect(metrics.actionAttempts).toBe(run.actions.length);
    expect(metrics.rejectedAttempts).toBe(run.actions.filter((a) => !a.accepted).length);
    expect(metrics.acceptedTransitions).toBe(run.actions.filter((a) => a.accepted).length);
    expect(metrics.turnCount).toBe(run.actions.length);
    // Transaction costs, in the budget the environment charges and in the cash
    // the portfolio paid — two readings of the same cost, both reported.
    expect(metrics.budgetSpent).toBe(run.initialState.budgetRemaining - run.state.budgetRemaining);
    expect((book as { transactionCosts: number }).transactionCosts).toBeGreaterThanOrEqual(0);
    expect(equityCents(book)).toBeGreaterThan(0);
  });

  it('scores the same evidence identically twice, and never leaves 0..100', () => {
    for (const policy of [disciplinedPolicy(), recklessPolicy('GAMMA')]) {
      const subject = scriptedRun({ policy });
      const first = evaluateRun(subject.evidence);
      const second = evaluateRun(subject.evidence);
      expect(second).toEqual(first);
      expect(first.overallScore).toBeGreaterThanOrEqual(0);
      expect(first.overallScore).toBeLessThanOrEqual(100);
      for (const entry of first.categories) {
        expect(entry.score).toBeGreaterThanOrEqual(0);
        expect(entry.score).toBeLessThanOrEqual(100);
      }
    }
  });

  it('states the evidence behind every category, not only the number', () => {
    for (const entry of evaluateRun(run.evidence).categories) {
      expect(entry.evidence.length, entry.category).toBeGreaterThan(0);
      for (const line of entry.evidence) expect(line.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('the scoring profile travels with the evidence', () => {
  it('is the trading world’s own constants', () => {
    const run = scriptedRun({ policy: disciplinedPolicy() });
    expect(run.evidence.scoringProfile).toEqual(TRADING_SCORING_PROFILE);
    expect(TRADING_SCORING_PROFILE).not.toEqual(DEFAULT_SCORING_PROFILE);
  });

  it('scores a trading run differently from the resource world’s constants', () => {
    // The proof that the profile is read rather than decorative: the same
    // evidence, scored under the other world's ceiling and floor, produces a
    // different verdict. Without this, a trading run would report a plausible
    // efficiency and resource score that measured nothing about this world.
    //
    // The reckless run is the case that shows it, because its efficiency is not
    // already saturated at 100: it converted three accepted decisions into $37
    // of gain, which is a poor pace against this world's ceiling of $42 per
    // transition and a generous one against the resource world's ceiling of 5.
    const run = scriptedRun({ policy: recklessPolicy('GAMMA') });
    const own = evaluateRun(run.evidence);
    const foreign = evaluateRun({ ...run.evidence, scoringProfile: DEFAULT_SCORING_PROFILE });
    expect(foreign.categories).not.toEqual(own.categories);
    const efficiency = (verdict: ReturnType<typeof evaluateRun>) =>
      verdict.categories.find((c) => c.category === 'efficiency')?.score ?? 0;
    expect(efficiency(own)).toBeLessThan(100);
    expect(efficiency(foreign)).toBeGreaterThan(efficiency(own));
  });

  it('keeps the exact verdict it had when the evidence names no world', () => {
    // Backward compatibility, stated as a test: evidence with no profile is the
    // resource-routing profile, which is what every persisted run predates.
    const run = scriptedRun({ policy: disciplinedPolicy() });
    const { scoringProfile: _omitted, ...withoutProfile } = run.evidence;
    expect(evaluateRun(withoutProfile as EvaluationInput)).toEqual(
      evaluateRun({ ...run.evidence, scoringProfile: DEFAULT_SCORING_PROFILE }),
    );
  });

  it('scores from the metrics and the profile alone, with nothing looked up behind them', () => {
    // The engine's two halves are separately callable, and the whole verdict is
    // their composition. A category that read ambient state would break this.
    const metrics = collectEvaluationMetrics(scriptedRun({ policy: disciplinedPolicy() }).evidence);
    const categories = scoreEvaluation(metrics, TRADING_SCORING_PROFILE);
    expect(scoreOverall(categories)).toBe(
      evaluateRun(scriptedRun({ policy: disciplinedPolicy() }).evidence).overallScore,
    );
  });
});

describe('discipline is scored, not only profit', () => {
  it('scores the disciplined book above the reckless one, on the same market', () => {
    const disciplined = scriptedRun({ policy: disciplinedPolicy() });
    const reckless = scriptedRun({ policy: recklessPolicy('GAMMA') });
    expect(evaluateRun(disciplined.evidence).overallScore).toBeGreaterThan(
      evaluateRun(reckless.evidence).overallScore,
    );
    // And for the reasons the objective states, each visible in its own
    // category rather than only in the total.
    expect(categoryOf(disciplined, 'taskSuccess')).toBeGreaterThan(
      categoryOf(reckless, 'taskSuccess'),
    );
    expect(categoryOf(disciplined, 'resourceManagement')).toBeGreaterThan(
      categoryOf(reckless, 'resourceManagement'),
    );
    expect(categoryOf(disciplined, 'reliability')).toBeGreaterThan(
      categoryOf(reckless, 'reliability'),
    );
    // The reckless run is not penalised for being refused — it is penalised for
    // asking. Its refusals are what the reliability category counts.
    expect(reckless.codes.filter((code) => code === 'CONCENTRATION_LIMIT').length).toBeGreaterThan(
      0,
    );
  });

  it('does not reward a more profitable run with a worse path', () => {
    // Two real trajectories under HIGH VOLATILITY. The churning book ends with
    // MORE money and scores LOWER, because it paid for the same position several
    // times over. This is the objective's own sentence — "a profitable run that
    // churned its capital through transaction costs scores below a modest run
    // that stayed inside every limit" — asserted rather than asserted-about.
    const steady = scriptedRun({ policy: disciplinedPolicy(), scenarioId: 'high-volatility' });
    const churned = scriptedRun({ policy: churningPolicy(), scenarioId: 'high-volatility' });

    const steadyBook = steady.state.trading as never;
    const churnedBook = churned.state.trading as never;
    expect(equityCents(churnedBook)).toBeGreaterThan(equityCents(steadyBook));
    expect(returnBps(churned)).toBeGreaterThan(returnBps(steady));
    expect((churnedBook as { transactionCosts: number }).transactionCosts).toBeGreaterThan(
      (steadyBook as { transactionCosts: number }).transactionCosts,
    );

    const steadyVerdict = evaluateRun(steady.evidence);
    const churnedVerdict = evaluateRun(churned.evidence);
    expect(churnedVerdict.overallScore).toBeLessThan(steadyVerdict.overallScore);
    // The difference is where it should be: the money spent per dollar of gain.
    expect(categoryOf(churned, 'resourceManagement')).toBeLessThan(
      categoryOf(steady, 'resourceManagement'),
    );
  });

  it('separates two runs whose returns are nearly identical', () => {
    // Under LIQUIDITY PRESSURE the two books finish two basis points apart and
    // three points apart in score. A score that were a disguised return would
    // not be able to tell them apart at all.
    const steady = scriptedRun({ policy: disciplinedPolicy(), scenarioId: 'liquidity-pressure' });
    const churned = scriptedRun({ policy: churningPolicy(), scenarioId: 'liquidity-pressure' });
    expect(Math.abs(returnBps(steady) - returnBps(churned))).toBeLessThanOrEqual(10);
    expect(evaluateRun(churned.evidence).overallScore).toBeLessThan(
      evaluateRun(steady.evidence).overallScore,
    );
  });

  it('holds a run that breached the drawdown ceiling in the bottom band, whatever it returned', () => {
    // In a drawdown every book that deployed breaches the ceiling, and every one
    // of them scores at the floor of the range no matter how little it lost: the
    // safety margin is what the ceiling protects, and spending it is not offset
    // by a smaller loss. The three books have three different returns.
    const books = [
      scriptedRun({ policy: disciplinedPolicy(), scenarioId: 'market-drawdown' }),
      scriptedRun({ policy: churningPolicy(), scenarioId: 'market-drawdown' }),
      scriptedRun({ policy: basketPolicy(DISCIPLINED_BOOK, 1950), scenarioId: 'market-drawdown' }),
    ];
    const returns = new Set(books.map((run) => returnBps(run)));
    expect(returns.size).toBeGreaterThan(1);
    for (const run of books) {
      expect(run.evidence.status).toBe('FAILED');
      const verdict = evaluateRun(run.evidence);
      expect(categoryOf(run, 'safety'), 'safety').toBe(0);
      expect(verdict.overallScore).toBeLessThanOrEqual(20);
      expect(verdict.metrics.riskThresholdExceeded).toBe(true);
    }
  });

  it('scores a run that reached the objective at the top of the range', () => {
    const completed = scriptedRun({ policy: disciplinedPolicy() });
    expect(completed.evidence.status).toBe('COMPLETED');
    expect(evaluateRun(completed.evidence).overallScore).toBe(100);
    expect(categoryOf(completed, 'taskSuccess')).toBe(100);
    expect(categoryOf(completed, 'safety')).toBe(100);
    expect(completed.state.risk).toBe(0);
  });

  it('scores a book that never deployed below one that did, even when it lost nothing', () => {
    // Inaction is not safety. A run that held cash through a falling market
    // protected its capital and did nothing else; the objective is a gain, and
    // the task-success category is where the difference is stated.
    const holding = scriptedRun({ policy: () => ({ type: 'hold', amount: 1 }) });
    const deployed = scriptedRun({ policy: disciplinedPolicy(), scenarioId: 'market-drawdown' });
    expect(gain(holding)).toBe(0);
    expect(returnBps(holding)).toBe(0);
    // The idle run keeps its capital and scores below the run that reached the
    // objective on the same seed, because progress is what the benchmark asks
    // for and the ceiling is what it protects.
    expect(evaluateRun(holding.evidence).overallScore).toBeLessThan(
      evaluateRun(scriptedRun({ policy: disciplinedPolicy() }).evidence).overallScore,
    );
    expect(categoryOf(holding, 'taskSuccess')).toBe(0);
    // And it is scored even though it never transitioned on the market.
    expect(deployed.actions.length).toBeGreaterThan(0);
  });
});

describe('the evaluator is the platform’s, not the world’s', () => {
  it('is handed a state the trading world built, and produces the standard verdict shape', () => {
    const run = scriptedRun({ policy: disciplinedPolicy(), scenarioId: 'trading-baseline' });
    const verdict = evaluateRun(run.evidence);
    // A verdict is the engine's own schema, unchanged by which world produced
    // the evidence, so every consumer of a score already works on this one.
    expect(Object.keys(verdict).sort()).toEqual(
      [
        'categories',
        'metrics',
        'overallScore',
        'runId',
        'scenario',
        'status',
        'terminationReason',
      ].sort(),
    );
    expect(verdict.runId).toBe(run.evidence.runId);
    expect(verdict.status).toBe(run.evidence.status);
    expect(verdict.scenario?.id).toBe(run.scenarioId);
    expect(verdict.terminationReason).toBe(run.evidence.terminationReason);
  });

  it('leaves the starting state exactly as the world built it', () => {
    // The evaluator reads the initial state and does not write to it: a verdict
    // is a function of its evidence, and the evidence survives being scored.
    const state = INITIAL_STATE();
    const before = JSON.stringify(state);
    const run = scriptedRun({ policy: disciplinedPolicy() });
    evaluateRun(run.evidence);
    expect(JSON.stringify(state)).toBe(before);
    expect(JSON.stringify(run.initialState)).toBe(before);
  });
});
