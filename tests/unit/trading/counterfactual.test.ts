// @vitest-environment node
//
// COUNTERFACTUAL — what else the agent could have done, in this world.
//
// There is no second counterfactual framework here, and this file exists mostly
// to prove that. The analyser is the platform's: it reads the recorded trace,
// asks the *state's own environment* to enumerate the action space, asks that
// same environment's validator which of those actions the state accepts, and
// scores every branch with the evaluation engine. Nothing in the trading world
// supplies a branch, a candidate or a score.
//
// What the trading world supplies is vocabulary, and the assertions below are
// about that arriving intact: an order's instrument is part of its identity, the
// four instruments are four distinct alternatives rather than one, and a refusal
// comes back in the environment's own words and code rather than paraphrased by
// the analyser.
//
// SIMULATION ONLY. Nothing here — or anywhere in this benchmark — reaches a
// broker, submits an order, moves money, or opens a socket. The "orders" are
// integers in a pure transition function.

import { describe, expect, it } from 'vitest';
import type { SimulationActionInput } from '@/lib/contracts/simulation';
import { enumerateActionSpace, enumerateCandidates } from '@/lib/counterfactual/actions';
import { analyzeCounterfactuals, analyzeDecisionAt } from '@/lib/counterfactual/counterfactual';
import { assertAnalysable } from '@/lib/counterfactual/decisions';
import {
  ACTION_SPACE_POLICY,
  CONTINUATION_POLICY,
  COUNTERFACTUAL_CATEGORIES,
  CounterfactualError,
  MAX_COUNTERFACTUAL_DECISIONS,
} from '@/lib/counterfactual/types';
import { evaluateRun } from '@/lib/evaluation/evaluation';
import {
  ASSET_ORDER,
  TARGET_GAIN_DOLLARS,
  TRADING_ENVIRONMENT_KEY,
} from '@/lib/trading/definitions';
import { INITIAL_STATE } from './fixtures';
import { disciplinedPolicy, recklessPolicy, scriptedRun } from './harness';

/** Every action code the trading validator publishes, as the environment names them. */
const TRADING_REFUSAL_CODES = [
  'MALFORMED_ACTION',
  'TERMINAL_RUN',
  'PERMISSION_DENIED',
  'ASSET_REQUIRED',
  'UNKNOWN_ASSET',
  'ORDER_TOO_LARGE',
  'INSUFFICIENT_CASH',
  'INSUFFICIENT_POSITION',
  'CONCENTRATION_LIMIT',
  'EXPOSURE_LIMIT',
  'BUDGET_EXCEEDED',
  'MISSING_TRADING_STATE',
];

describe('a trading run is analysed by the platform’s counterfactual engine', () => {
  const run = scriptedRun({ policy: disciplinedPolicy() });
  const analysis = analyzeCounterfactuals(run.evidence);

  it('reports one decision point per recorded action, scored by the existing engine', () => {
    expect(analysis.report.run.decisionPointCount).toBe(run.actions.length);
    expect(analysis.report.decisions).toHaveLength(run.actions.length);
    expect(analysis.report.baseline.overallScore).toBe(evaluateRun(run.evidence).overallScore);
    // The five categories are the evaluator's, in the evaluator's order.
    expect(Object.keys(analysis.report.baseline.scores)).toEqual([...COUNTERFACTUAL_CATEGORIES]);
  });

  it('projects the trading world onto the quantities a reader compares', () => {
    // The shared projection, read on this world's own numbers: progress is the
    // portfolio's gain against the $500 objective and risk is drawdown against
    // the ceiling, which are the two quantities the benchmark scores. The
    // portfolio's cash and positions are not in this summary — they travel with
    // each alternative's full state, one drill-down away.
    const world = analysis.report.run.world;
    expect(world.target).toBe(TARGET_GAIN_DOLLARS);
    expect(world.progress).toBe(run.state.progress);
    expect(world.objectiveReached).toBe(run.state.progress >= TARGET_GAIN_DOLLARS);
    expect(world.risk).toBe(run.state.risk);
    expect(world.maxRisk).toBe(run.state.maxRisk);
    expect(world.budgetRemaining).toBe(run.state.budgetRemaining);
    expect(world.budgetSpent).toBe(run.state.budgetSpent);
    // This world has no resources and no task list, so those fields carry zero
    // rather than a value invented to fill them.
    expect(world.resources).toEqual({ energy: 0, materials: 0, water: 0 });
    expect(world.completedTasks).toBe(0);
  });

  it('names the policy every branch was built under, rather than implying a search', () => {
    expect(analysis.report.policies.actionSpace).toBe(ACTION_SPACE_POLICY);
    expect(analysis.report.policies.continuation).toBe(CONTINUATION_POLICY);
    for (const decision of analysis.report.decisions) {
      expect(decision.space.policy).toBe(ACTION_SPACE_POLICY);
      expect(decision.statement.length).toBeGreaterThan(0);
    }
  });

  it('reads back each decision as the trading action that was recorded', () => {
    for (const [index, action] of run.actions.entries()) {
      const decision = analysis.report.decisions[index];
      expect(decision?.actionId, `decision ${index}`).toBe(action.id);
      expect(decision?.step, `decision ${index}`).toBe(action.step);
      expect(decision?.action.type, `decision ${index}`).toBe(action.input.type);
      // An order carries its instrument, and the instrument survives the read.
      if (action.input.type === 'buy' || action.input.type === 'sell')
        expect(decision?.action.asset, `decision ${index}`).toBe(action.input.asset);
      expect(decision?.actual.accepted, `decision ${index}`).toBe(action.accepted);
      expect(decision?.actual.rejectionReason, `decision ${index}`).toBe(action.rejectionReason);
    }
  });

  it('is the same report twice, and leaves the evidence it read untouched', () => {
    const before = JSON.stringify(run.evidence);
    expect(analyzeCounterfactuals(run.evidence)).toEqual(analysis);
    expect(JSON.stringify(run.evidence)).toBe(before);
  });
});

describe('the counterfactual action space is the trading world’s own', () => {
  const state = INITIAL_STATE();

  it('enumerates orders in this world’s vocabulary, and no other world’s verb', () => {
    const space = enumerateActionSpace(state);
    expect(space.length).toBeGreaterThan(1);
    for (const action of space) {
      expect(['buy', 'sell', 'hold'], action.type).toContain(action.type);
      expect(action.resource, `a trading action names no resource`).toBeUndefined();
      if (action.type === 'hold') continue;
      expect(ASSET_ORDER as readonly string[]).toContain(action.asset as string);
    }
    // The resource world's verbs are absent by enumeration, not by filtering.
    for (const verb of ['harvest', 'allocate', 'rest'])
      expect(space.map((action) => action.type)).not.toContain(verb);
  });

  it('treats the four instruments as four distinct alternatives, not one', () => {
    // The property a naive `type:amount` key would destroy: four orders of the
    // same size in four instruments are four different decisions, and collapsing
    // them would report the agent's one order as three others already made.
    const candidates = enumerateCandidates(state);
    const keys = candidates.map((candidate) => candidate.key);
    expect(new Set(keys).size).toBe(keys.length);

    const size = (
      enumerateActionSpace(state).find((action) => action.type === 'buy') as SimulationActionInput
    ).amount;
    const sameSize = candidates.filter(
      (candidate) =>
        candidate.action.type === 'buy' &&
        candidate.action.amount === size &&
        candidate.action.asset !== undefined,
    );
    expect(sameSize).toHaveLength(ASSET_ORDER.length);
    expect(new Set(sameSize.map((candidate) => candidate.key)).size).toBe(ASSET_ORDER.length);
    for (const asset of ASSET_ORDER) expect(keys).toContain(`buy:${asset}:${size}`);
  });

  it('asks the environment which candidates it accepts, rather than deciding itself', () => {
    // Validity is the environment's verdict: every candidate's acceptance is the
    // one `evaluateSimulationAction` gave, and a refusal carries its code.
    const candidates = enumerateCandidates(state);
    for (const candidate of candidates) {
      if (candidate.accepted) {
        expect(candidate.rejectionReason).toBeNull();
        expect(candidate.code).toBe('ACCEPTED');
        // And an accepted candidate really transitioned the world.
        expect(candidate.state).not.toBe(state);
        expect(candidate.state.environmentKey).toBe(TRADING_ENVIRONMENT_KEY);
      } else {
        expect(candidate.rejectionReason).not.toBeNull();
        expect(TRADING_REFUSAL_CODES, candidate.code).toContain(candidate.code);
        // A refused candidate is refused *before* the world moved: it hands back
        // the very state it was offered, so no alternative can leak a mutation.
        expect(candidate.state).toBe(state);
      }
    }
    expect(candidates.filter((candidate) => candidate.accepted).length).toBeGreaterThan(0);
  });
});

describe('one trading decision, checked by hand', () => {
  const run = scriptedRun({ policy: recklessPolicy('GAMMA') });
  const analysis = analyzeDecisionAt(run.evidence, 0);

  it('carries every alternative with its full counterfactual world and verdict', () => {
    expect(analysis.alternatives.length).toBeGreaterThan(0);
    for (const alternative of analysis.alternatives) {
      // The full state, not the projection: this is the drill-down.
      expect(alternative.state.environmentKey).toBe(TRADING_ENVIRONMENT_KEY);
      expect(alternative.state.trading).not.toBeNull();
      // And a verdict from the same engine that scored the run itself.
      expect(alternative.evaluation.categories.map((entry) => entry.category)).toEqual([
        ...COUNTERFACTUAL_CATEGORIES,
      ]);
      expect(alternative.outcome.overallScore).toBe(alternative.evaluation.overallScore);
      expect(alternative.outcome.overallScore).toBeGreaterThanOrEqual(0);
      expect(alternative.outcome.overallScore).toBeLessThanOrEqual(100);
      // The flags are the delta's own sign, not a second opinion about it.
      expect(alternative.improves).toBe(alternative.delta.overall > 0);
      expect(alternative.worsens).toBe(alternative.delta.overall < 0);
      expect(alternative.continuation.policy).toBe(CONTINUATION_POLICY);
    }
  });

  it('reports the refusals in the environment’s own words and codes', () => {
    // The analyser does not describe a refusal in its own vocabulary: the code
    // and the sentence beside it are the validator's, which is what keeps the
    // counterfactual's account of a rejection identical to the run's.
    for (const decision of analyzeCounterfactuals(run.evidence).report.decisions) {
      const detail = analyzeDecisionAt(run.evidence, decision.index);
      const counted = decision.space.invalidByCode.reduce((sum, entry) => sum + entry.count, 0);
      // Every refused candidate is accounted for by a code the environment gave.
      expect(counted, `decision ${decision.index}`).toBe(decision.space.invalid);
      for (const rejected of detail.rejectedAlternatives) {
        expect(TRADING_REFUSAL_CODES, rejected.code).toContain(rejected.code);
        expect(rejected.reason.trim().length, rejected.code).toBeGreaterThan(0);
        expect(rejected.key.length).toBeGreaterThan(0);
      }
    }
  });

  it('excludes the choice actually made from the alternatives to it, in either half', () => {
    // The recorded action is not an alternative to itself. Whichever half of the
    // admissible space the environment put it in, it leaves that half — so the
    // reported alternatives are one fewer than the half they came from, and the
    // count is not an off-by-one in either direction. Asserted over every
    // decision of a run that has both accepted and refused choices in it.
    const mixed = scriptedRun({ policy: recklessPolicy('GAMMA') });
    expect(mixed.actions.some((action) => action.accepted)).toBe(true);
    expect(mixed.actions.some((action) => !action.accepted)).toBe(true);
    for (const decision of analyzeCounterfactuals(mixed.evidence).report.decisions) {
      const detail = analyzeDecisionAt(mixed.evidence, decision.index);
      const takenValid = decision.actual.accepted;
      expect(detail.alternatives.length, `decision ${decision.index}`).toBe(
        decision.space.valid - (takenValid ? 1 : 0),
      );
      expect(detail.rejectedAlternatives.length, `decision ${decision.index}`).toBe(
        decision.space.invalid - (takenValid ? 0 : 1),
      );
      // And the recorded action really is in the half its verdict says it is.
      expect(decision.space.invalid + decision.space.valid).toBe(decision.space.enumerated);
    }
  });

  it('refuses an index the run does not have, and says what it does have', () => {
    expect(() => analyzeDecisionAt(run.evidence, 9_999)).toThrow(CounterfactualError);
    try {
      analyzeDecisionAt(run.evidence, 9_999);
      expect.unreachable('an absent decision must be refused');
    } catch (error) {
      expect((error as CounterfactualError).code).toBe('UNKNOWN_DECISION');
      expect((error as Error).message).toContain(String(run.actions.length));
    }
  });
});

describe('the counterfactual bounds and refusals are the engine’s, unchanged', () => {
  it('refuses a trace longer than its published bound rather than analysing part of it', () => {
    const run = scriptedRun({ policy: disciplinedPolicy() });
    const first = run.actions[0];
    if (!first) throw new Error('expected a recorded action');
    const padded = Array.from({ length: MAX_COUNTERFACTUAL_DECISIONS + 1 }, (_, index) => ({
      ...first,
      id: `padded-${index}`,
    }));
    expect(() => assertAnalysable({ ...run.evidence, actions: padded })).toThrow(
      CounterfactualError,
    );
    try {
      assertAnalysable({ ...run.evidence, actions: padded });
      expect.unreachable('an over-long trace must be refused');
    } catch (error) {
      expect((error as CounterfactualError).code).toBe('TOO_MANY_DECISIONS');
    }
    // At the bound exactly, it is accepted: the bound is a bound, not an off-by-one.
    expect(() =>
      assertAnalysable({
        ...run.evidence,
        actions: padded.slice(0, MAX_COUNTERFACTUAL_DECISIONS),
      }),
    ).not.toThrow();
  });

  it('refuses evidence whose recorded states cannot be transitioned from', () => {
    const run = scriptedRun({ policy: disciplinedPolicy() });
    const first = run.actions[0];
    if (!first) throw new Error('expected a recorded action');
    const broken = [{ ...first, resultingState: { ...first.resultingState, step: -1 } }];
    try {
      assertAnalysable({ ...run.evidence, actions: broken });
      expect.unreachable('unusable evidence must be refused');
    } catch (error) {
      expect((error as CounterfactualError).code).toBe('INVALID_SOURCE');
    }
  });
});
