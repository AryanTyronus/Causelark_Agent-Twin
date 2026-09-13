// @vitest-environment node
// @polsia:user-owned — the run-level counterfactual report.
//
// The report is what an operator reads, so these tests are about its internal
// consistency and about it not overstating what it measured: every count either
// partitions a total or is derivable from one, the ranking is a total order with
// a defined tie-break, and the whole thing is a deterministic function of the
// recorded evidence.

import { describe, expect, it } from 'vitest';
import { analyzeCounterfactuals, analyzeDecisionAt } from '@/lib/counterfactual/counterfactual';
import {
  COMPLETING_PLAN,
  POST_TERMINAL_PLAN,
  REFUSED_PLAN,
  STEP_LIMITED_PLAN,
  traceFixture,
} from './counterfactual.fixtures';

const STEP_LIMITED = traceFixture({ actions: STEP_LIMITED_PLAN });
const COMPLETING = traceFixture({ actions: COMPLETING_PLAN });
const REFUSED = traceFixture({ actions: REFUSED_PLAN });
const POST_TERMINAL = traceFixture({ actions: POST_TERMINAL_PLAN });

const report = analyzeCounterfactuals(STEP_LIMITED).report;

describe('the report’s accounting', () => {
  it('describes the run it analysed, not a second run', () => {
    expect(report.run.runId).toBe(STEP_LIMITED.runId);
    expect(report.run.status).toBe('LIMIT_REACHED');
    expect(report.run.inProgress).toBe(false);
    expect(report.run.scenario).toBeNull();
    expect(report.run.decisionPointCount).toBe(12);
    expect(report.run.world).toEqual({
      step: 12,
      progress: 4,
      target: 8,
      objectiveReached: false,
      risk: 3,
      maxRisk: 8,
      budgetSpent: 12,
      budgetRemaining: 12,
      resources: { energy: 12, materials: 3, water: 5 },
      completedTasks: 1,
    });
    // One decision point per recorded action, attempts included.
    expect(report.decisions).toHaveLength(STEP_LIMITED.actions.length);
    expect(report.decisions.map((decision) => decision.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  it('states the verdict it compares against, from the evaluation engine', () => {
    expect(report.baseline.overallScore).toBe(61);
    expect(report.baseline.scores).toEqual({
      taskSuccess: 50,
      safety: 100,
      efficiency: 7,
      resourceManagement: 33,
      reliability: 100,
    });
  });

  it('carries the policies every number in it was computed under', () => {
    expect(report.policies).toEqual({
      actionSpace: 'enumerated-valid-actions-v1',
      continuation: 'replay-recorded-attempts-v1',
      comparison: 'held-constant-non-environment-evidence-v1',
    });
  });

  it('partitions the decision points between the four outcome counts', () => {
    const summary = report.summary;
    expect(
      summary.improvingDecisions +
        summary.equivalentDecisions +
        summary.worseningDecisions +
        summary.uncontestedDecisions,
    ).toBe(summary.decisionPoints);
    expect(summary.decisionPoints).toBe(12);
    expect(summary.agentDecisions + summary.manualDecisions).toBe(summary.decisionPoints);
    expect(summary.agentDecisions).toBe(12);
    expect(summary.manualDecisions).toBe(0);
  });

  it('partitions the enumerated action space between valid and refused', () => {
    const summary = report.summary;
    expect(summary.validActions + summary.invalidActions).toBe(summary.enumeratedActions);
    // Twelve decisions over a thirty-five-action space. Forty-two of the
    // candidates are refused: by the end of the run energy is at capacity, so a
    // harvest of it has nowhere to go.
    expect(summary.enumeratedActions).toBe(12 * 35);
    expect(summary.validActions).toBe(378);
    expect(summary.invalidActions).toBe(42);
    // The refusals are the environment's own, grouped by its own codes — energy
    // harvests that would exceed storage, and allocations of what is not there.
    const refusedCodes = report.decisions.flatMap((decision) => decision.space.invalidByCode);
    expect(refusedCodes.reduce((total, entry) => total + entry.count, 0)).toBe(42);
    expect(new Set(refusedCodes.map((entry) => entry.code))).toEqual(
      new Set(['CAPACITY_EXCEEDED', 'INSUFFICIENT_RESOURCE']),
    );
    // No code repeats within one decision: each decision's grouping is a
    // partition of that decision's refusals, not a running tally.
    for (const decision of report.decisions) {
      const codes = decision.space.invalidByCode;
      expect(new Set(codes.map((entry) => entry.code)).size).toBe(codes.length);
      expect(codes.reduce((total, entry) => total + entry.count, 0)).toBe(decision.space.invalid);
    }
  });

  it('counts only alternatives as alternatives, excluding the recorded choice', () => {
    // Every decision here was accepted, so each gave up exactly one alternative:
    // the choice that was made.
    expect(report.summary.alternativesAnalysed).toBe(
      report.summary.validActions - report.summary.agentDecisions,
    );
    expect(report.summary.alternativesAnalysed).toBe(366);
    for (const decision of report.decisions)
      expect(decision.alternatives.analysed).toBe(decision.space.valid - 1);
  });

  it('holds that relationship on a run whose recorded attempt was refused', () => {
    const refused = analyzeCounterfactuals(REFUSED).report;
    // The recorded refusal is not in the valid space, so it removes nothing from
    // that decision's alternatives: the state had 30, and all 30 are analysed.
    expect(refused.summary.validActions).toBe(35 + 33 + 30);
    expect(refused.summary.alternativesAnalysed).toBe(34 + 32 + 30);
    expect(refused.summary.invalidActions).toBe(0 + 2 + 5);
    expect(refused.summary.validActions + refused.summary.invalidActions).toBe(3 * 35);
    // Every decision had alternatives, so none is uncontested.
    expect(refused.summary.uncontestedDecisions).toBe(0);
    expect(refused.decisions[0]?.alternatives.analysed).toBe(34);
    expect(refused.decisions[1]?.alternatives.analysed).toBe(32);
    expect(refused.decisions[2]?.alternatives.analysed).toBe(30);
  });

  it('reports no alternative at all for a decision with no valid action', () => {
    const post = analyzeCounterfactuals(POST_TERMINAL).report;
    const last = post.decisions.at(-1);
    if (!last) throw new Error('The fixture has no decision points.');
    // The run had already terminated, so the environment refused everything.
    expect(last.space.valid).toBe(0);
    expect(last.space.invalid).toBe(35);
    expect(last.alternatives.analysed).toBe(0);
    expect(last.best).toBeNull();
    expect(last.worst).toBeNull();
    expect(last.regret).toBeNull();
    expect(last.statement).toContain('No alternative was available.');
    expect(post.summary.uncontestedDecisions).toBe(1);
    expect(post.summary.decisionPoints).toBe(13);
    expect(
      post.summary.improvingDecisions +
        post.summary.equivalentDecisions +
        post.summary.worseningDecisions +
        post.summary.uncontestedDecisions,
    ).toBe(13);
  });

  it('measures the alternative statistics over every alternative, not over means', () => {
    const { summary } = report;
    expect(summary.bestAlternativeOverall).toBe(82);
    expect(summary.worstAlternativeOverall).toBe(49);
    // A mean of per-decision means would weight a decision with two alternatives
    // the same as one with thirty-four.
    expect(summary.meanAlternativeOverall).toBe(63.88);
    expect(summary.meanAlternativeOverall).not.toBeNull();
    // Every reported aggregate is inside the range of what it aggregates.
    for (const decision of report.decisions) {
      if (decision.best === null) continue;
      expect(decision.best.outcome.overallScore).toBeLessThanOrEqual(
        summary.bestAlternativeOverall ?? 0,
      );
      expect(decision.worst?.outcome.overallScore).toBeGreaterThanOrEqual(
        summary.worstAlternativeOverall ?? 100,
      );
    }
  });

  it('reports no aggregate at all when there was nothing to aggregate', () => {
    // An empty trace is a run with no decisions: every statistic is absent
    // rather than zero.
    const empty = analyzeCounterfactuals(traceFixture({ actions: [] })).report;
    expect(empty.summary.decisionPoints).toBe(0);
    expect(empty.summary.bestAlternativeOverall).toBeNull();
    expect(empty.summary.worstAlternativeOverall).toBeNull();
    expect(empty.summary.meanAlternativeOverall).toBeNull();
    expect(empty.summary.maxRegret).toBeNull();
    expect(empty.summary.meanRegret).toBeNull();
    expect(empty.causal.ranking).toEqual([]);
    expect(empty.causal.criticalDecision).toBeNull();
  });
});

describe('the ranking', () => {
  it('ranks by regret, descending, with no gaps', () => {
    const regrets = report.causal.ranking.map((entry) => entry.regret);
    expect(regrets).toEqual([...regrets].sort((left, right) => right - left));
    expect(report.causal.ranking.map((entry) => entry.rank)).toEqual(
      regrets.map((_regret, offset) => offset + 1),
    );
  });

  it('breaks every tie by decision order, so the ranking is a total order', () => {
    const ranked = report.causal.ranking;
    expect(ranked).toHaveLength(12);
    for (let index = 1; index < ranked.length; index += 1) {
      const previous = ranked[index - 1];
      const current = ranked[index];
      if (!previous || !current) throw new Error('The ranking is shorter than expected.');
      // Either strictly less regret, or equal regret and a later decision.
      const ordered =
        previous.regret > current.regret ||
        (previous.regret === current.regret && previous.index < current.index);
      expect(ordered, `rank ${index + 1} is out of order`).toBe(true);
    }
    // The first four decisions all gave up 21, so they rank 1–4 in order.
    expect(ranked.slice(0, 4).map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
    expect(ranked.slice(0, 4).map((entry) => entry.regret)).toEqual([21, 21, 21, 21]);
  });

  it('ranks every decision that had anything to compare against', () => {
    // The ranking is ordered by regret, so it is compared as a set: what is
    // asserted is that every contested decision is in it and nothing else is.
    const ranked = [...report.causal.ranking.map((entry) => entry.index)].sort((a, b) => a - b);
    const contested = report.decisions
      .filter((decision) => decision.regret !== null)
      .map((decision) => decision.index);
    expect(ranked).toEqual(contested);
    // A decision nobody could have improved on is still a result, so it stays in
    // the ranking rather than being dropped as uninteresting.
    const completing = analyzeCounterfactuals(COMPLETING).report;
    expect(completing.causal.ranking.map((entry) => entry.regret)).toEqual([8, 8, 4, 0]);
    expect(completing.causal.ranking.at(-1)?.regret).toBe(0);
  });

  it('omits a decision that had no alternatives, and only that', () => {
    const post = analyzeCounterfactuals(POST_TERMINAL).report;
    expect(post.causal.ranking).toHaveLength(12);
    expect(post.causal.ranking.map((entry) => entry.index)).not.toContain(12);
  });

  it('restates each decision’s own numbers rather than a second measurement', () => {
    for (const entry of report.causal.ranking) {
      const decision = report.decisions[entry.index];
      if (!decision) throw new Error(`No decision at index ${entry.index}.`);
      expect(entry.step).toBe(decision.step);
      expect(entry.actionId).toBe(decision.actionId);
      expect(entry.action).toEqual(decision.action);
      expect(entry.source).toBe(decision.source);
      expect(entry.regret).toBe(decision.regret);
      expect(entry.outcomeFlipCount).toBe(decision.outcomeFlips.count);
      expect(entry.bestAlternativeKey).toBe(decision.best?.key ?? null);
      expect(entry.bestAlternativeOverall).toBe(decision.best?.outcome.overallScore ?? null);
      expect(entry.recordedOverall).toBe(report.baseline.overallScore);
    }
  });

  it('names the decision that gave up the most, and says what it gave up', () => {
    const critical = report.causal.criticalDecision;
    expect(critical?.index).toBe(0);
    expect(critical?.regret).toBe(report.summary.maxRegret);
    expect(critical?.rank).toBe(1);
    expect(critical?.statement).toContain('Decision 0 at step 0');
    expect(critical?.statement).toContain('would have scored 82');
    expect(critical?.statement).toContain('21 more');
    expect(critical?.statement).toContain('replay-recorded-attempts-v1');
    expect(critical?.statement).toContain('against the recorded 61');
  });

  it('names no critical decision when none gave anything up', () => {
    // Every decision in this run was as good as the best alternative available,
    // so there is no critical decision — and the report says so rather than
    // ranking an arbitrary winner.
    const best = analyzeCounterfactuals(
      traceFixture({ actions: [{ type: 'allocate', resource: 'water', amount: 5 }] }),
    ).report;
    expect(best.summary.maxRegret).toBe(0);
    expect(best.causal.ranking).toHaveLength(1);
    expect(best.causal.ranking[0]?.regret).toBe(0);
    expect(best.causal.criticalDecision).toBeNull();
    expect(best.causal.ranking[0]?.statement).toContain(
      'no valid alternative would have scored above',
    );
  });
});

describe('the report as a document', () => {
  it('keeps the bulk out of the run-level answer', () => {
    // A run with a dozen decisions has hundreds of alternatives; a report that
    // carried each one's world would be unusable as an answer. The aggregates
    // travel, and the evidence behind them is served by the drill-down.
    const { details } = analyzeCounterfactuals(STEP_LIMITED);
    const alternatives = details.reduce((total, detail) => total + detail.alternatives.length, 0);
    expect(alternatives).toBe(366);
    expect(report).not.toHaveProperty('details');
    for (const decision of report.decisions) {
      expect(decision.best).not.toHaveProperty('state');
      expect(decision.best).not.toHaveProperty('evaluation');
      expect(decision).not.toHaveProperty('alternatives.detail');
    }
    // The drill-down is where the states are, and they are there for all of them.
    const drill = analyzeDecisionAt(STEP_LIMITED, 0);
    expect(drill.alternatives).toHaveLength(34);
    expect(drill.alternatives.every((alternative) => alternative.state !== undefined)).toBe(true);
  });

  it('reports at most a handful of flips per decision, while counting them all', () => {
    const completing = analyzeCounterfactuals(COMPLETING).report;
    for (const decision of completing.decisions) {
      expect(decision.outcomeFlips.reported.length).toBeLessThanOrEqual(3);
      if (decision.outcomeFlips.count > 3) expect(decision.outcomeFlips.reported.length).toBe(3);
      expect(decision.outcomeFlips.count).toBeGreaterThanOrEqual(
        decision.outcomeFlips.reported.length,
      );
    }
  });

  it('is a deterministic function of the evidence', () => {
    const first = analyzeCounterfactuals(STEP_LIMITED).report;
    const second = analyzeCounterfactuals(STEP_LIMITED).report;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // And of the evidence only: a differently labelled run of the same shape
    // produces the same analysis apart from the label.
    const relabelled = analyzeCounterfactuals({
      ...STEP_LIMITED,
      runId: 'another-run',
    }).report;
    const { run: firstRun, ...firstRest } = first;
    const { run: secondRun, ...secondRest } = relabelled;
    expect(firstRun.runId).not.toBe(secondRun.runId);
    expect(secondRest).toEqual(firstRest);
  });

  it('leaves the recorded evidence untouched', () => {
    const before = JSON.stringify(STEP_LIMITED);
    analyzeCounterfactuals(STEP_LIMITED);
    expect(JSON.stringify(STEP_LIMITED)).toBe(before);
  });

  it('reports a run still in progress as one, without claiming an outcome', () => {
    const running = traceFixture({ actions: STEP_LIMITED_PLAN.slice(0, 3) });
    const partial = analyzeCounterfactuals(running).report;
    expect(partial.run.inProgress).toBe(true);
    expect(partial.run.status).toBe('RUNNING');
    expect(partial.run.world.objectiveReached).toBe(false);
    // A branch that ends where the recorded run still is has not flipped it.
    expect(partial.decisions.every((decision) => decision.best !== null)).toBe(true);
  });
});
