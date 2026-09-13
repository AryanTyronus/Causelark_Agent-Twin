// @vitest-environment node
// @polsia:user-owned — what a counterfactual comparison must and must not do.
//
// The load-bearing test in this file is the round trip: replayed as an
// alternative to itself, the recorded choice must reproduce the recorded run
// exactly — the same world, the same status, the same verdict. If the
// continuation policy, the branch evidence or the comparison arithmetic had
// introduced anything of their own, that test would fail, because the only input
// it varies is the choice, and it does not vary it.
//
// The rest pins the comparison's discipline: an alternative is scored by the
// evaluation engine rather than by this one, the evidence that the intervention
// could not have changed is held constant, and no ordering depends on iteration.

import { describe, expect, it } from 'vitest';
import { evaluateSimulationAction, getSimulationStatus } from '@/lib/business/simulation';
import { enumerateCandidates, validCandidates } from '@/lib/counterfactual/actions';
import { analyseDecision, describeAction, scoresOf } from '@/lib/counterfactual/analysis';
import { analyzeDecisionAt } from '@/lib/counterfactual/counterfactual';
import { decisionAt } from '@/lib/counterfactual/decisions';
import { counterfactualEvidence } from '@/lib/counterfactual/evidence';
import { evaluateRun } from '@/lib/evaluation/evaluation';
import {
  COMPLETING_PLAN,
  REFUSED_PLAN,
  STEP_LIMITED_PLAN,
  traceFixture,
} from './counterfactual.fixtures';

const STEP_LIMITED = traceFixture({ actions: STEP_LIMITED_PLAN });
const COMPLETING = traceFixture({ actions: COMPLETING_PLAN });
const REFUSED = traceFixture({ actions: REFUSED_PLAN });

/** A fixture's decision point, together with the verdict every delta is against. */
function decisionOf(source: typeof STEP_LIMITED, index: number) {
  return { source, context: decisionAt(source, index), baseline: evaluateRun(source) };
}

/** The candidate in a decision's own space that *is* the recorded choice. */
function identityCandidate(source: typeof STEP_LIMITED, index: number) {
  const context = decisionAt(source, index);
  const recorded = context.recorded.input;
  const match = enumerateCandidates(context.state).find(
    (candidate) =>
      candidate.action.type === recorded.type &&
      candidate.action.amount === recorded.amount &&
      candidate.action.resource === recorded.resource,
  );
  if (!match) throw new Error(`Decision ${index} is not in its own action space.`);
  return { context, candidate: match };
}

describe('the recorded choice, replayed as its own alternative', () => {
  // The policy replaces exactly one transition — the decision — and replays the
  // rest of the run's own recorded transitions. So replaying the recorded choice
  // as the intervention is the identity, and the branch must land on the run.
  it.each(STEP_LIMITED_PLAN.map((_action, index) => index))(
    'reproduces the recorded run exactly at decision %i',
    (index) => {
      const { candidate, context } = identityCandidate(STEP_LIMITED, index);
      const evidence = counterfactualEvidence({
        source: STEP_LIMITED,
        decision: context,
        candidate,
      });
      // The branch's last world is the recorded run's last world.
      expect(evidence.trajectory.state).toEqual(STEP_LIMITED.state);
      // Its ending is the recorded run's ending.
      expect(evidence.trajectory.continuation.terminalStatus).toBe(STEP_LIMITED.status);
      expect(evidence.trajectory.continuation.terminationReason).toBe(
        STEP_LIMITED.terminationReason,
      );
      expect(evidence.input.status).toBe(STEP_LIMITED.status);
      expect(evidence.input.state).toEqual(STEP_LIMITED.state);
      // And therefore the same verdict, byte for byte — the engine was handed
      // evidence describing the same run. The only field that differs is the
      // label: the branch says it is a branch, and claims nothing else.
      const recorded = evaluateRun(STEP_LIMITED);
      const { runId, ...branchVerdict } = evidence.evaluation;
      const { runId: recordedId, ...recordedVerdict } = recorded;
      expect(runId).toBe(evidence.branchId);
      expect(recordedId).toBe(STEP_LIMITED.runId);
      expect(branchVerdict).toEqual(recordedVerdict);
    },
  );

  it('holds for a run that reached its objective and for one whose last attempt was refused', () => {
    for (const source of [COMPLETING, REFUSED]) {
      const { candidate, context } = identityCandidate(source, 0);
      const evidence = counterfactualEvidence({ source, decision: context, candidate });
      expect(evidence.trajectory.state).toEqual(source.state);
      const { runId, ...branchVerdict } = evidence.evaluation;
      const { runId: recordedId, ...recordedVerdict } = evaluateRun(source);
      expect(runId).not.toBe(recordedId);
      expect(branchVerdict).toEqual(recordedVerdict);
    }
  });

  it('preserves the run’s pattern of attempts, refusals included', () => {
    // A run that was refused once stays refused once in its own branch. The
    // evaluation engine counts rejected attempts, so a policy that replayed only
    // the accepted transitions would hand the branch a cleaner record than the
    // run it is being compared against.
    const { candidate, context } = identityCandidate(REFUSED, 0);
    const evidence = counterfactualEvidence({ source: REFUSED, decision: context, candidate });
    expect(REFUSED.actions.filter((action) => !action.accepted)).toHaveLength(1);
    expect(evidence.input.actions.filter((action) => !action.accepted)).toHaveLength(1);
    expect(evidence.trajectory.continuation.replayed).toBe(2);
    expect(evidence.trajectory.continuation.accepted).toBe(1);
    expect(evidence.trajectory.continuation.rejected).toBe(1);
  });
});

describe('the branch evidence', () => {
  const context = decisionAt(STEP_LIMITED, 4);
  const candidate = validCandidates(enumerateCandidates(context.state)).find(
    (entry) => entry.key === 'allocate:water:2',
  );
  if (!candidate) throw new Error('The expected alternative is not valid in this world.');
  const evidence = counterfactualEvidence({ source: STEP_LIMITED, decision: context, candidate });

  it('varies only what the intervention could have changed', () => {
    // The branch's own: what it did, where it ended, and how it was labelled.
    expect(evidence.input.runId).toBe(evidence.branchId);
    expect(evidence.input.runId).not.toBe(STEP_LIMITED.runId);
    expect(evidence.input.state).toEqual(evidence.trajectory.state);
    expect(evidence.input.actions).toEqual(evidence.trajectory.actions);
    expect(evidence.input.terminationReason).toBe(
      evidence.trajectory.continuation.terminationReason,
    );
    // Held constant, verbatim: the world both branches started in, the provider
    // evidence that accompanied the run, and the run-level limits. A comparison
    // that let these vary would read a provider fault as a decision's fault.
    expect(evidence.input.initialState).toEqual(STEP_LIMITED.initialState);
    expect(evidence.input.events).toBe(STEP_LIMITED.events);
    expect(evidence.input.toolCalls).toBe(STEP_LIMITED.toolCalls);
    expect(evidence.input.budgetLimit).toBe(STEP_LIMITED.budgetLimit);
    expect(evidence.input.turnCount).toBe(STEP_LIMITED.turnCount);
    expect(evidence.input.maxTurns).toBe(STEP_LIMITED.maxTurns);
    expect(evidence.input.scenario).toEqual(STEP_LIMITED.scenario);
  });

  it('keeps the past identical in both branches and intervenes at one transition', () => {
    const before = evidence.input.actions.slice(0, context.point.index);
    expect(before).toEqual(STEP_LIMITED.actions.slice(0, context.point.index));
    // Everything from the decision point on is the branch's, and the record at
    // the decision point is the alternative, not the choice that was made.
    expect(evidence.input.actions[context.point.index]?.input).toEqual(candidate.action);
    expect(evidence.input.actions).toHaveLength(
      context.point.index + 1 + evidence.trajectory.continuation.replayed,
    );
  });

  it('gives the branch an identity derived from the run, the decision and the choice', () => {
    const repeat = counterfactualEvidence({ source: STEP_LIMITED, decision: context, candidate });
    expect(repeat.branchId).toBe(evidence.branchId);
    expect(evidence.branchId).toContain(STEP_LIMITED.runId);
    expect(evidence.branchId).toContain('cf4');
    expect(evidence.branchId).toContain(candidate.key);
    // Two alternatives at the same decision are two branches, not one.
    const other = validCandidates(enumerateCandidates(context.state)).find(
      (entry) => entry.key !== candidate.key,
    );
    if (!other) throw new Error('The fixture state admits only one action.');
    expect(
      counterfactualEvidence({ source: STEP_LIMITED, decision: context, candidate: other })
        .branchId,
    ).not.toBe(evidence.branchId);
  });

  it('scores the branch through the evaluation engine, not through arithmetic of its own', () => {
    // The verdict is exactly what the engine returns for the evidence built
    // here; a score computed locally would not survive this.
    expect(evidence.evaluation).toEqual(evaluateRun(evidence.input));
    expect(evidence.evaluation.categories.map((entry) => entry.category)).toEqual([
      'taskSuccess',
      'safety',
      'efficiency',
      'resourceManagement',
      'reliability',
    ]);
    expect(Object.values(scoresOf(evidence.evaluation))).toHaveLength(5);
  });

  it('describes both worlds as having suffered the same provider faults', () => {
    const withFaults = traceFixture({ actions: STEP_LIMITED_PLAN, agentErrors: 2 });
    const faulty = decisionAt(withFaults, 3);
    const alternative = validCandidates(enumerateCandidates(faulty.state))[0];
    if (!alternative) throw new Error('The fixture state admits no action.');
    const branch = counterfactualEvidence({
      source: withFaults,
      decision: faulty,
      candidate: alternative,
    });
    expect(withFaults.events).toHaveLength(2);
    expect(branch.input.events).toEqual(withFaults.events);
    // A fault is not a consequence of a decision, so the reliability dimension
    // sees the same fault count in both worlds.
    expect(branch.evaluation.metrics.agentErrors).toBe(evaluateRun(withFaults).metrics.agentErrors);
  });
});

describe('one decision analysed', () => {
  const analysed = analyseDecision(decisionOf(STEP_LIMITED, 0));

  it('does not offer the recorded choice as an alternative to itself', () => {
    const keys = analysed.alternatives.map((alternative) => alternative.key);
    expect(keys).not.toContain('allocate:materials:1');
    // The space still counts it: the space is the environment's, and the choice
    // was one of the actions available there.
    expect(analysed.decision.space.valid).toBe(35);
    expect(analysed.decision.alternatives.analysed).toBe(34);
    expect(keys).toHaveLength(34);
  });

  it('keeps the alternatives in action-space order, without duplicates', () => {
    const keys = analysed.alternatives.map((alternative) => alternative.key);
    expect(keys.slice(0, 3)).toEqual(['harvest:energy:1', 'harvest:energy:2', 'harvest:energy:3']);
    // Canonicalising the space is what keeps a choice from appearing twice
    // under two keys — a `rest` request's resource is meaningless.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('reports the recorded outcome as the runtime recorded it', () => {
    expect(analysed.decision.actual).toEqual({
      accepted: true,
      rejectionReason: null,
      observation: 'Allocated 1 materials toward the objective.',
    });
    expect(analysed.decision.action).toEqual({
      type: 'allocate',
      resource: 'materials',
      amount: 1,
    });
    expect(analysed.decision.index).toBe(0);
    expect(analysed.decision.step).toBe(0);
    expect(analysed.decision.source).toBe('agent');
    expect(analysed.decision.actionId).toBe(STEP_LIMITED.actions[0]?.id);
  });

  it('partitions the alternatives into improving, equivalent and worsening', () => {
    const { improving, equivalent, worsening, analysed: total } = analysed.decision.alternatives;
    expect(improving + equivalent + worsening).toBe(total);
    expect(total).toBe(analysed.alternatives.length);
    expect(improving).toBe(12);
    expect(equivalent).toBe(2);
    expect(worsening).toBe(20);
    for (const alternative of analysed.alternatives) {
      const expected = alternative.outcome.overallScore - 61;
      expect(alternative.delta.overall).toBe(expected);
      expect(alternative.improves).toBe(expected > 0);
      expect(alternative.worsens).toBe(expected < 0);
      // A delta is a difference of two engine verdicts, dimension by dimension.
      expect(alternative.delta.taskSuccess).toBe(alternative.outcome.scores.taskSuccess - 50);
      expect(alternative.delta.safety).toBe(alternative.outcome.scores.safety - 100);
      expect(alternative.delta.efficiency).toBe(alternative.outcome.scores.efficiency - 7);
      expect(alternative.delta.resourceManagement).toBe(
        alternative.outcome.scores.resourceManagement - 33,
      );
      expect(alternative.delta.reliability).toBe(alternative.outcome.scores.reliability - 100);
    }
  });

  it('measures what the choice gave up, never below zero', () => {
    expect(analysed.decision.best?.key).toBe('allocate:energy:5');
    expect(analysed.decision.best?.outcome.overallScore).toBe(82);
    expect(analysed.decision.regret).toBe(21);
    // Regret is the best alternative against the recorded verdict: 82 − 61.
    expect(analysed.decision.regret).toBe((analysed.decision.best?.outcome.overallScore ?? 0) - 61);
    for (const source of [STEP_LIMITED, COMPLETING, REFUSED]) {
      const decision = analyseDecision(decisionOf(source, 0)).decision;
      expect(decision.regret).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports no regret at all when nothing could have improved on the choice', () => {
    // The completing run's first allocation was as good as anything available:
    // nothing scored above it, so it gave nothing up.
    const completing = analyseDecision(decisionOf(COMPLETING, 0)).decision;
    expect(completing.best?.outcome.overallScore).toBe(86);
    expect(completing.regret).toBe(0);
    expect(completing.alternatives.improving).toBe(0);
  });

  it('breaks a tie in favour of the earlier action in the space', () => {
    const best = analysed.decision.best;
    const worst = analysed.decision.worst;
    if (!best || !worst) throw new Error('The analysis produced no extremes.');
    const topScore = Math.max(...analysed.alternatives.map((a) => a.outcome.overallScore));
    const lowScore = Math.min(...analysed.alternatives.map((a) => a.outcome.overallScore));
    // Several alternatives may tie; the first in action-space order wins, never
    // whichever the reduce happened to reach first.
    expect(best.key).toBe(
      analysed.alternatives.find((a) => a.outcome.overallScore === topScore)?.key,
    );
    expect(worst.key).toBe(
      analysed.alternatives.find((a) => a.outcome.overallScore === lowScore)?.key,
    );
    expect(
      analysed.alternatives.filter((a) => a.outcome.overallScore === topScore).length,
    ).toBeGreaterThan(0);
  });

  it('reports an outcome flip only when the branch ends differently', () => {
    for (const alternative of analysed.alternatives)
      expect(alternative.flipsOutcome).toBe(
        alternative.continuation.terminalStatus !== STEP_LIMITED.status,
      );
    // The recorded run ended LIMIT_REACHED; the two branches that reached the
    // objective ended COMPLETED, and nothing else changed status.
    expect(analysed.decision.outcomeFlips.count).toBe(2);
    expect(analysed.decision.outcomeFlips.reported.map((flip) => flip.key)).toEqual([
      'allocate:energy:5',
      'allocate:water:5',
    ]);
    for (const flip of analysed.decision.outcomeFlips.reported) {
      expect(flip.from).toBe('LIMIT_REACHED');
      expect(flip.to).toBe('COMPLETED');
      expect(flip.action).toEqual(analysed.alternatives.find((a) => a.key === flip.key)?.action);
    }
  });

  it('caps the flips it reports while counting every one of them', () => {
    const completing = analyseDecision(decisionOf(COMPLETING, 0));
    // 32 of the 34 alternatives leave the objective unmet.
    expect(completing.decision.outcomeFlips.count).toBe(32);
    expect(completing.decision.outcomeFlips.reported).toHaveLength(3);
    const reported = completing.decision.outcomeFlips.reported.map((flip) => flip.overallScore);
    expect(reported).toEqual([...reported].sort((left, right) => right - left));
  });

  it('carries the full world and the full verdict behind every alternative', () => {
    // The report is an aggregate; this is the evidence it was folded from, so a
    // single decision can be checked by hand rather than taken on trust.
    for (const alternative of analysed.alternatives) {
      expect(alternative.state.step).toBe(alternative.world.step);
      expect(alternative.state.progress).toBe(alternative.world.progress);
      expect(alternative.state.risk).toBe(alternative.world.risk);
      expect(alternative.state.budgetSpent).toBe(alternative.world.budgetSpent);
      expect(alternative.state.resources).toEqual(alternative.world.resources);
      expect(alternative.evaluation.overallScore).toBe(alternative.outcome.overallScore);
      expect(alternative.evaluation.status).toBe(alternative.continuation.terminalStatus);
      expect(scoresOf(alternative.evaluation)).toEqual(alternative.outcome.scores);
    }
  });

  it('names the refusals with the environment’s own reason and code', () => {
    const refused = analyseDecision(decisionOf(REFUSED, 2));
    expect(refused.decision.space.valid).toBe(30);
    expect(refused.decision.space.invalid).toBe(5);
    expect(refused.decision.space.invalidByCode).toEqual([
      { code: 'INSUFFICIENT_RESOURCE', count: 5 },
    ]);
    // The recorded refusal is the decision itself, so it is not repeated as an
    // alternative — but the space still counts the five the state refused.
    expect(refused.rejected.map((entry) => entry.key)).not.toContain('allocate:materials:5');
    expect(refused.rejected).toHaveLength(4);
    expect(refused.decision.space.invalid - refused.rejected.length).toBe(1);
    for (const entry of refused.rejected) {
      expect(entry.code).toBe('INSUFFICIENT_RESOURCE');
      // The reason is the environment's sentence, verbatim, naming the amount
      // that particular candidate asked for.
      expect(entry.reason).toBe(`Not enough materials to allocate ${entry.action.amount}.`);
    }
    expect(refused.alternatives).toHaveLength(30);
  });

  it('analyses an attempt that was refused exactly as it analyses one that was accepted', () => {
    const refused = analyseDecision(decisionOf(REFUSED, 2)).decision;
    expect(refused.actual.accepted).toBe(false);
    expect(refused.actual.rejectionReason).toBe('Not enough materials to allocate 5.');
    // The alternative world is built from the world the refusal met — a refusal
    // changed nothing, so the choice could still have gone elsewhere.
    expect(refused.best?.key).toBe('allocate:energy:5');
    expect(refused.best?.outcome.overallScore).toBe(97);
    expect(refused.regret).toBe(9);
  });

  it('says what it measured, and claims no causation', () => {
    const statement = analysed.decision.statement;
    expect(statement).toContain('Decision 0 at step 0');
    expect(statement).toContain('the agent chose allocate 1 materials');
    expect(statement).toContain('which the environment accepted');
    expect(statement).toContain('35 of 35 possible actions were valid there');
    expect(statement).toContain('The best of them, allocate:energy:5, would have scored 82');
    expect(statement).toContain('against the recorded 61');
    expect(statement).toContain('2 of them would have ended the run in a different status');
    // No causal vocabulary in the generated text: the evidence supports what an
    // alternative would have scored, not that the choice produced the outcome.
    expect(statement).not.toMatch(
      /\bcaused?\b|\bbecause\b|\bled to\b|\bresulted in\b|\bproves?\b|\bresponsible\b/i,
    );
  });

  it('attributes the choice to the operator when the operator made it', () => {
    const manual = traceFixture({ actions: STEP_LIMITED_PLAN, sources: ['manual', 'agent'] });
    const decision = analyseDecision(decisionOf(manual, 0)).decision;
    expect(decision.source).toBe('manual');
    expect(decision.statement).toContain('the operator chose');
  });

  it('is deterministic: the same decision twice is the same analysis', () => {
    const first = analyseDecision(decisionOf(STEP_LIMITED, 3));
    const second = analyseDecision(decisionOf(STEP_LIMITED, 3));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('leaves the evidence it was handed untouched', () => {
    const before = JSON.stringify(STEP_LIMITED);
    analyseDecision(decisionOf(STEP_LIMITED, 5));
    expect(JSON.stringify(STEP_LIMITED)).toBe(before);
  });

  it('measures a candidate against the world it met, not against another candidate', () => {
    const context = decisionAt(STEP_LIMITED, 6);
    const candidate = validCandidates(enumerateCandidates(context.state))[5];
    if (!candidate) throw new Error('The fixture state admits too few actions.');
    // Re-deriving the candidate's world from the decision's state must give the
    // same answer: the space is a fan-out from one world, not a chain.
    expect(evaluateSimulationAction(context.state, candidate.action).state).toEqual(
      candidate.state,
    );
    expect(getSimulationStatus(candidate.state).status).toBe('RUNNING');
  });
});

describe('the drill-down for one decision', () => {
  it('serves every alternative with its state and its verdict', () => {
    const analysis = analyzeDecisionAt(STEP_LIMITED, 0);
    expect(analysis.run.runId).toBe(STEP_LIMITED.runId);
    expect(analysis.run.decisionPointCount).toBe(12);
    expect(analysis.run.inProgress).toBe(false);
    expect(analysis.run.scenario).toBeNull();
    expect(analysis.baseline.overallScore).toBe(61);
    expect(analysis.decision.index).toBe(0);
    expect(analysis.alternatives).toHaveLength(34);
    expect(analysis.alternatives[0]?.evaluation.overallScore).toBe(
      analysis.alternatives[0]?.outcome.overallScore,
    );
  });

  it('travels with the policies every number in it was computed under', () => {
    const analysis = analyzeDecisionAt(STEP_LIMITED, 0);
    expect(analysis.policies).toEqual({
      actionSpace: 'enumerated-valid-actions-v1',
      continuation: 'replay-recorded-attempts-v1',
      comparison: 'held-constant-non-environment-evidence-v1',
    });
  });

  it('agrees with the analysis it was split out of', () => {
    const analysis = analyzeDecisionAt(STEP_LIMITED, 0);
    const analysed = analyseDecision(decisionOf(STEP_LIMITED, 0));
    expect(analysis.decision).toEqual(analysed.decision);
    expect(analysis.alternatives).toEqual(analysed.alternatives);
    expect(analysis.rejectedAlternatives).toEqual(analysed.rejected);
  });

  it('reports a run still in progress as one', () => {
    const running = traceFixture({ actions: STEP_LIMITED_PLAN.slice(0, 3) });
    expect(running.status).toBe('RUNNING');
    const analysis = analyzeDecisionAt(running, 1);
    expect(analysis.run.inProgress).toBe(true);
    expect(analysis.run.status).toBe('RUNNING');
  });

  it('describes an action the way a reader reads it', () => {
    expect(describeAction({ type: 'rest', amount: 3 })).toBe('rest 3');
    // A rest action's resource is not part of what it does, so it is not named.
    expect(describeAction({ type: 'rest', resource: 'energy', amount: 3 })).toBe('rest 3');
    expect(describeAction({ type: 'allocate', resource: 'water', amount: 2 })).toBe(
      'allocate 2 water',
    );
  });
});
