//
// This module answers the two questions the phase exists for, at the scale of a
// single decision:
//
//   What would have happened?  Each valid alternative is carried through the
//   environment's own transition, through the named continuation policy, and
//   through the existing evaluation engine. What comes back is a verdict the
//   evaluation engine produced, not one this engine invented.
//
//   How much did the choice contribute?  `regret` is the difference between the
//   best verdict any alternative reached and the verdict the recorded run
//   received. It measures what the choice gave up *among the alternatives the
//   engine could construct*, under a stated continuation policy — it is not a
//   claim that the choice caused the outcome, and not a claim about what the
//   agent intended.
//
// Every ordering here is deliberate. Alternatives are produced in action-space
// order and every extremum is chosen by a strict comparison, so the first
// candidate to reach a value keeps it: two alternatives that score identically
// are separated by their position in the space, never by iteration order.
//
// Nothing here reads a clock, a random source, a database or a provider.

import { meanScore } from '@/lib/benchmarks/arithmetic';
import type { SimulationActionInput, SimulationRunStatus } from '@/lib/contracts/simulation';
import type { EvaluationCategory, EvaluationInput, EvaluationResult } from '@/lib/evaluation/types';
import {
  type ActionCandidate,
  actionKey,
  canonicalAction,
  enumerateCandidates,
  rejectedCandidates,
  rejectionCounts,
  validCandidates,
} from './actions';
import { projectWorld } from './continuation';
import type { DecisionContext } from './decisions';
import { type CounterfactualEvidence, counterfactualEvidence } from './evidence';
import {
  ACTION_SPACE_POLICY,
  type CounterfactualActionSpace,
  type CounterfactualAlternative,
  type CounterfactualAlternativeDetail,
  type CounterfactualDecision,
  type CounterfactualDelta,
  CounterfactualError,
  type CounterfactualOutcomeFlip,
  type CounterfactualScores,
  MAX_REPORTED_FLIPS_PER_DECISION,
} from './types';

/** How an action reads in a generated statement. */
export function describeAction(input: SimulationActionInput): string {
  const action = canonicalAction(input);
  return action.resource === undefined
    ? `${action.type} ${action.amount}`
    : `${action.type} ${action.amount} ${action.resource}`;
}

/**
 * The five dimension scores out of an evaluation result.
 *
 * A missing category is an engine fault, not a zero: the evaluation engine
 * always returns all five, so reading a dimension it did not return would mean
 * scoring a branch on a number nobody computed.
 */
export function scoresOf(evaluation: EvaluationResult): CounterfactualScores {
  const byCategory = new Map<EvaluationCategory, number>(
    evaluation.categories.map((entry) => [entry.category, entry.score]),
  );
  const read = (category: EvaluationCategory): number => {
    const score = byCategory.get(category);
    if (score === undefined)
      throw new CounterfactualError(
        'INVALID_RESULT',
        `The evaluation engine returned no ${category} score, so the branch cannot be compared dimension by dimension.`,
      );
    return score;
  };
  return {
    taskSuccess: read('taskSuccess'),
    safety: read('safety'),
    efficiency: read('efficiency'),
    resourceManagement: read('resourceManagement'),
    reliability: read('reliability'),
  };
}

function deltaOf(
  branch: CounterfactualScores,
  baseline: CounterfactualScores,
  branchOverall: number,
  baselineOverall: number,
): CounterfactualDelta {
  return {
    overall: branchOverall - baselineOverall,
    taskSuccess: branch.taskSuccess - baseline.taskSuccess,
    safety: branch.safety - baseline.safety,
    efficiency: branch.efficiency - baseline.efficiency,
    resourceManagement: branch.resourceManagement - baseline.resourceManagement,
    reliability: branch.reliability - baseline.reliability,
  };
}

function toAlternative(input: {
  candidate: ActionCandidate;
  evidence: CounterfactualEvidence;
  baselineScores: CounterfactualScores;
  baselineOverall: number;
  baselineStatus: SimulationRunStatus;
}): CounterfactualAlternative {
  const { baselineOverall, baselineScores, baselineStatus, candidate, evidence } = input;
  const scores = scoresOf(evidence.evaluation);
  const overall = evidence.evaluation.overallScore;
  const status = evidence.trajectory.continuation.terminalStatus;
  return {
    key: candidate.key,
    action: candidate.action,
    observation: candidate.observation,
    continuation: evidence.trajectory.continuation,
    world: projectWorld(evidence.trajectory.state),
    outcome: { overallScore: overall, scores },
    delta: deltaOf(scores, baselineScores, overall, baselineOverall),
    improves: overall > baselineOverall,
    worsens: overall < baselineOverall,
    flipsOutcome: status !== baselineStatus,
  };
}

/** One decision point: its aggregate, its alternatives, and its refusals. */
export interface AnalysedDecision {
  decision: CounterfactualDecision;
  /** Every valid alternative, in action-space order, with its full trajectory. */
  alternatives: CounterfactualAlternativeDetail[];
  rejected: { key: string; action: SimulationActionInput; code: string; reason: string }[];
}

/**
 * Analyse one decision point.
 *
 * The recorded verdict is passed in rather than recomputed: it is the same
 * verdict for every decision point in a run, and it is the value every delta in
 * this analysis is measured against.
 */
export function analyseDecision(input: {
  source: EvaluationInput;
  baseline: EvaluationResult;
  context: DecisionContext;
}): AnalysedDecision {
  const { baseline, context, source } = input;
  const actualKey = actionKey(context.recorded.input);
  const candidates = enumerateCandidates(context.state);
  const spaceValid = validCandidates(candidates);
  const spaceRejected = rejectedCandidates(candidates);

  // The choice actually made is not an alternative to itself, so it leaves the
  // space in whichever half the environment put it in.
  const valid = spaceValid.filter((candidate) => candidate.key !== actualKey);
  const rejected = spaceRejected.filter((candidate) => candidate.key !== actualKey);

  const baselineScores = scoresOf(baseline);
  const analysed = valid.map((candidate) => {
    const evidence = counterfactualEvidence({ source, decision: context, candidate });
    return {
      evidence,
      alternative: toAlternative({
        candidate,
        evidence,
        baselineScores,
        baselineOverall: baseline.overallScore,
        baselineStatus: baseline.status,
      }),
    };
  });
  const alternatives = analysed.map((entry) => entry.alternative);
  const best = pickExtreme(alternatives, 'best');
  const worst = pickExtreme(alternatives, 'worst');
  const flips = alternatives
    .map((alternative, position) => ({ alternative, position }))
    .filter((entry) => entry.alternative.flipsOutcome)
    .sort(
      (left, right) =>
        right.alternative.outcome.overallScore - left.alternative.outcome.overallScore ||
        left.position - right.position,
    );

  const space: CounterfactualActionSpace = {
    policy: ACTION_SPACE_POLICY,
    enumerated: candidates.length,
    valid: spaceValid.length,
    invalid: spaceRejected.length,
    invalidByCode: rejectionCounts(spaceRejected),
  };
  const regret =
    best === null ? null : Math.max(0, best.outcome.overallScore - baseline.overallScore);

  return {
    decision: {
      index: context.point.index,
      step: context.point.step,
      actionId: context.point.actionId,
      source: context.point.source,
      action: context.point.action,
      actual: {
        accepted: context.point.accepted,
        rejectionReason: context.point.rejectionReason,
        observation: context.point.observation,
      },
      space,
      alternatives: {
        analysed: alternatives.length,
        improving: alternatives.filter((alternative) => alternative.improves).length,
        equivalent: alternatives.filter(
          (alternative) => !alternative.improves && !alternative.worsens,
        ).length,
        worsening: alternatives.filter((alternative) => alternative.worsens).length,
      },
      best,
      worst,
      meanAlternativeOverall: meanScore(alternatives.map((entry) => entry.outcome.overallScore)),
      regret,
      outcomeFlips: {
        count: flips.length,
        reported: flips
          .slice(0, MAX_REPORTED_FLIPS_PER_DECISION)
          .map(({ alternative }) => toFlip(alternative, baseline.status)),
      },
      statement: describeDecision({
        context,
        baseline,
        best,
        alternativeCount: alternatives.length,
        space,
        regret,
        flipCount: flips.length,
      }),
    },
    alternatives: analysed.map((entry) => ({
      ...entry.alternative,
      state: entry.evidence.trajectory.state,
      evaluation: entry.evidence.evaluation,
    })),
    rejected: rejected.map((candidate) => ({
      key: candidate.key,
      action: candidate.action,
      code: candidate.code,
      reason: candidate.rejectionReason ?? 'The environment refused this action.',
    })),
  };
}

function toFlip(
  alternative: CounterfactualAlternative,
  from: SimulationRunStatus,
): CounterfactualOutcomeFlip {
  return {
    key: alternative.key,
    action: alternative.action,
    from,
    to: alternative.continuation.terminalStatus,
    overallScore: alternative.outcome.overallScore,
  };
}

/**
 * The best or worst alternative, ties going to the earlier position in the
 * action space. Strict comparison rather than `>=` is what makes that true.
 */
function pickExtreme(
  alternatives: readonly CounterfactualAlternative[],
  which: 'best' | 'worst',
): CounterfactualAlternative | null {
  const first = alternatives[0];
  if (first === undefined) return null;
  return alternatives.reduce((chosen, candidate) => {
    const higher = candidate.outcome.overallScore > chosen.outcome.overallScore;
    const lower = candidate.outcome.overallScore < chosen.outcome.overallScore;
    if (which === 'best') return higher ? candidate : chosen;
    return lower ? candidate : chosen;
  }, first);
}

/**
 * A deterministic sentence describing the decision.
 *
 * Generated from the numbers above by template, in the same spirit as the
 * evaluation engine's evidence lines: it restates the measurement and adds no
 * interpretation. In particular it never says the decision *caused* anything — it
 * says what an alternative would have scored under a named continuation policy,
 * which is all the evidence supports.
 */
function describeDecision(input: {
  context: DecisionContext;
  baseline: EvaluationResult;
  best: CounterfactualAlternative | null;
  alternativeCount: number;
  space: CounterfactualActionSpace;
  regret: number | null;
  flipCount: number;
}): string {
  const { alternativeCount, baseline, best, context, flipCount, regret, space } = input;
  const who = context.point.source === 'agent' ? 'the agent' : 'the operator';
  const opening = `Decision ${context.point.index} at step ${context.point.step}: ${who} chose ${describeAction(context.point.action)}, which the environment ${context.point.accepted ? 'accepted' : 'refused'}.`;
  const catalogue = `${space.valid} of ${space.enumerated} possible actions were valid there; ${alternativeCount} remained as alternatives.`;
  if (best === null || regret === null)
    return `${opening} ${catalogue} No alternative was available.`;
  const comparison =
    regret === 0
      ? `None would have scored above the recorded ${baseline.overallScore}; the best, ${best.key}, was worth the same.`
      : `The best of them, ${best.key}, would have scored ${best.outcome.overallScore} against the recorded ${baseline.overallScore}.`;
  const flips =
    flipCount === 0
      ? ''
      : ` ${flipCount} of them would have ended the run in a different status than ${baseline.status}.`;
  return `${opening} ${catalogue} ${comparison}${flips}`;
}
