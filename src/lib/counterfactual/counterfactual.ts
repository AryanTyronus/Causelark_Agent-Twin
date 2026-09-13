//
// Two entry points, both pure functions of persisted evidence:
//
//   `analyzeCounterfactuals(source)`  — the whole run, one report.
//   `analyzeDecisionAt(source, index)` — one decision point, every alternative.
//
// Both take the same evidence contract the evaluation engine takes, which is the
// point: a counterfactual is computed from exactly the data a verdict is
// computed from, plus the environment's own transition function. Neither entry
// point reads a clock, a random source, a database or a provider, so analysing
// the same run twice returns the same analysis.

import { evaluateRun } from '@/lib/evaluation/evaluation';
import type { EvaluationInput } from '@/lib/evaluation/types';
import { analyseDecision, scoresOf } from './analysis';
import { decisionAt, extractDecisionPoints } from './decisions';
import { reportPolicies } from './report';
import type { CounterfactualDecisionAnalysis as DecisionAnalysis } from './types';
import { CounterfactualDecisionAnalysis } from './types';

export {
  ACTION_AMOUNTS,
  type ActionCandidate,
  actionKey,
  canonicalAction,
  enumerateActionSpace,
  enumerateCandidates,
  rejectedCandidates,
  rejectionCounts,
  validCandidates,
} from './actions';
export { analyseDecision, describeAction, scoresOf } from './analysis';
export {
  buildTrajectory,
  type CounterfactualTrajectory,
  counterfactualActionId,
  counterfactualTerminal,
  projectWorld,
} from './continuation';
export {
  assertAnalysable,
  type DecisionContext,
  decisionAt,
  extractDecisionPoints,
} from './decisions';
export {
  type CounterfactualEvidence,
  counterfactualBranchId,
  counterfactualEvidence,
} from './evidence';
export {
  analyzeCounterfactuals,
  type CounterfactualAnalysis,
  reportPolicies,
} from './report';
export * from './types';

/**
 * Analyse one decision point of a run.
 *
 * The drill-down counterpart to the report: same evidence, same policies, same
 * evaluation engine — but every alternative it considered travels with it, along
 * with its full counterfactual state and verdict, so a single decision can be
 * checked by hand rather than taken on the report's word.
 */
export function analyzeDecisionAt(source: EvaluationInput, index: number): DecisionAnalysis {
  const contexts = extractDecisionPoints(source);
  const context = decisionAt(source, index);
  const baseline = evaluateRun(source);
  const analysed = analyseDecision({ source, baseline, context });
  return CounterfactualDecisionAnalysis.parse({
    run: {
      runId: source.runId,
      status: source.status,
      inProgress: source.status === 'RUNNING',
      scenario: source.scenario ?? null,
      decisionPointCount: contexts.length,
    },
    baseline: { overallScore: baseline.overallScore, scores: scoresOf(baseline) },
    policies: reportPolicies(),
    decision: analysed.decision,
    alternatives: analysed.alternatives,
    rejectedAlternatives: analysed.rejected,
  });
}
