// @polsia:user-owned — counterfactual domain contracts.
//
// A counterfactual is a *derived* statement about a run. It is not evidence the
// environment recorded, and nothing here is ever written back as if it were. A
// counterfactual is computed from three things and nothing else: the persisted
// evidence of a run, the environment's own deterministic transition function,
// and the existing evaluation engine's verdict on both the real and the
// alternative trajectory.
//
// These shapes describe three layers:
//
//   the decision space at a recorded decision point   (which alternatives exist)
//   the counterfactual continuation of that decision  (what the world would do)
//   the report over a whole run                       (which decisions mattered)
//
// Like the scenario, evaluation and benchmark contracts these schemas are
// isomorphic: no database, no provider, no `server-only`, no clock and no
// randomness. Every number in a report is a deterministic function of the
// persisted evidence it was derived from, so analysing the same run twice
// returns the same report.

import { z } from 'zod';
import {
  SimulationActionInput,
  SimulationResources,
  SimulationRunStatus,
  SimulationScenarioIdentity,
  SimulationState,
} from '@/lib/contracts/simulation';
import { type EvaluationCategory, EvaluationResult } from '@/lib/evaluation/types';

/**
 * The order the action space is enumerated in: action type, then resource, then
 * amount. Named explicitly rather than read from object key iteration, so two
 * analyses of the same run produce the same alternative order — which is also
 * the order every tie in the report is broken by.
 */
export const ACTION_TYPE_ORDER = ['harvest', 'allocate', 'rest'] as const;
export const ACTION_RESOURCE_ORDER = ['energy', 'materials', 'water'] as const;

/**
 * How far the engine will probe the action contract for the amount range it
 * accepts. This is a search bound, not a copy of the contract's own limit: the
 * accepted range is *derived* by asking `SimulationActionInput`, so a change to
 * the contract moves the action space with it instead of silently disagreeing
 * with it.
 */
export const ACTION_AMOUNT_PROBE_LIMIT = 10;

/**
 * The three named policies a report is stated under. They are exported as
 * literals and echoed into every report because a counterfactual is only
 * meaningful relative to the assumptions that produced it — an unexplained
 * "would have scored 87" is not a finding.
 */
/** Which actions the engine considered: every action the environment accepts. */
export const ACTION_SPACE_POLICY = 'enumerated-valid-actions-v1';
/**
 * What happens after the intervention: every attempt the recorded run made after
 * the decision point — accepted and refused alike — is re-requested against the
 * counterfactual world through the same validator. See `continuation.ts` for
 * what this policy does and does not model.
 */
export const CONTINUATION_POLICY = 'replay-recorded-attempts-v1';
/**
 * What is held equal between the two branches: everything the intervention could
 * not have changed. See `evidence.ts`.
 */
export const COMPARISON_POLICY = 'held-constant-non-environment-evidence-v1';

/**
 * The largest number of decision points one analysis will take on.
 *
 * Enumerating the action space at every decision point and evaluating each
 * alternative is bounded work, but not free, and a run whose trace is far larger
 * than the runtime can produce is not a run this engine can report on honestly.
 * Oversize evidence is refused, never silently truncated: a report that quietly
 * analysed the first N decisions would read as a statement about the whole run.
 */
export const MAX_COUNTERFACTUAL_DECISIONS = 64;

/** How many outcome-flipping alternatives a report carries per decision point. */
export const MAX_REPORTED_FLIPS_PER_DECISION = 3;

/**
 * The five evaluation dimensions, in the evaluation engine's reporting order.
 *
 * The names are the engine's own — a test pins this shape's keys equal to
 * `EVALUATION_CATEGORIES`, so the two cannot drift into disagreeing about what
 * a run is scored on. The scores here are always the evaluation engine's
 * output, never a second calculation of them.
 */
export const CounterfactualScores = z.object({
  taskSuccess: z.number().int().min(0).max(100),
  safety: z.number().int().min(0).max(100),
  efficiency: z.number().int().min(0).max(100),
  resourceManagement: z.number().int().min(0).max(100),
  reliability: z.number().int().min(0).max(100),
});
export type CounterfactualScores = z.infer<typeof CounterfactualScores>;

/** The same five dimensions as a signed change against the recorded run. */
export const CounterfactualDelta = z.object({
  overall: z.number().int().min(-100).max(100),
  taskSuccess: z.number().int().min(-100).max(100),
  safety: z.number().int().min(-100).max(100),
  efficiency: z.number().int().min(-100).max(100),
  resourceManagement: z.number().int().min(-100).max(100),
  reliability: z.number().int().min(-100).max(100),
});
export type CounterfactualDelta = z.infer<typeof CounterfactualDelta>;

/**
 * The counterfactual world, projected to the quantities a reader compares.
 *
 * Deliberately not the whole `SimulationState`: the tasks, constraints and
 * labels are identical in both branches, so repeating them per alternative would
 * bury the answer in noise. The full state is available on the per-decision
 * drill-down.
 */
export const CounterfactualWorld = z.object({
  step: z.number().int().nonnegative(),
  progress: z.number().int().nonnegative(),
  target: z.number().int().positive(),
  objectiveReached: z.boolean(),
  risk: z.number().int().nonnegative(),
  maxRisk: z.number().int().positive(),
  budgetSpent: z.number().int().nonnegative(),
  budgetRemaining: z.number().int().nonnegative(),
  resources: SimulationResources,
  completedTasks: z.number().int().nonnegative(),
});
export type CounterfactualWorld = z.infer<typeof CounterfactualWorld>;

/**
 * What the continuation did: how much recorded behaviour was replayed and how
 * the counterfactual world responded to it. A replayed transition the altered
 * world refuses is the interesting case, so accepted and rejected are counted
 * separately rather than collapsed into a step count.
 */
export const CounterfactualContinuation = z.object({
  policy: z.literal(CONTINUATION_POLICY),
  replayed: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  /** True when the world reached a terminal status before the replay ran out. */
  terminatedEarly: z.boolean(),
  terminalStatus: SimulationRunStatus,
  terminationReason: z.string().nullable(),
});
export type CounterfactualContinuation = z.infer<typeof CounterfactualContinuation>;

/**
 * One alternative action, carried through the environment and the evaluator.
 *
 * `outcome` is the *existing* evaluation engine's verdict on the counterfactual
 * trajectory — never a score this engine computed itself. `delta` is that
 * verdict minus the verdict on the recorded run, so every number is a
 * subtraction of two scores the evaluation engine produced.
 */
export const CounterfactualAlternative = z.object({
  /** Stable identity of the action: `type:resource:amount`. */
  key: z.string().min(1),
  action: SimulationActionInput,
  /** The environment's own words for the immediate transition. */
  observation: z.string(),
  continuation: CounterfactualContinuation,
  world: CounterfactualWorld,
  outcome: z.object({
    overallScore: z.number().int().min(0).max(100),
    scores: CounterfactualScores,
  }),
  delta: CounterfactualDelta,
  improves: z.boolean(),
  worsens: z.boolean(),
  /** The counterfactual run reaches a different terminal status than the run did. */
  flipsOutcome: z.boolean(),
});
export type CounterfactualAlternative = z.infer<typeof CounterfactualAlternative>;

/**
 * A decision point the agent (or an operator) actually faced: one recorded
 * action attempt, the state it was requested against, and how the environment
 * answered it.
 */
export const CounterfactualDecisionPoint = z.object({
  index: z.number().int().nonnegative(),
  actionId: z.string().min(1),
  step: z.number().int().nonnegative(),
  source: z.enum(['agent', 'manual']),
  action: SimulationActionInput,
  accepted: z.boolean(),
  rejectionReason: z.string().nullable(),
  observation: z.string(),
});
export type CounterfactualDecisionPoint = z.infer<typeof CounterfactualDecisionPoint>;

/** The admissible action space at one decision point, as counts and codes. */
export const CounterfactualActionSpace = z.object({
  policy: z.literal(ACTION_SPACE_POLICY),
  enumerated: z.number().int().nonnegative(),
  valid: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  /** Rejection codes the environment gave, in the contract's code order. */
  invalidByCode: z.array(z.object({ code: z.string().min(1), count: z.number().int().positive() })),
});
export type CounterfactualActionSpace = z.infer<typeof CounterfactualActionSpace>;

/** One alternative whose counterfactual run ends differently from the real one. */
export const CounterfactualOutcomeFlip = z.object({
  key: z.string().min(1),
  action: SimulationActionInput,
  from: SimulationRunStatus,
  to: SimulationRunStatus,
  overallScore: z.number().int().min(0).max(100),
});
export type CounterfactualOutcomeFlip = z.infer<typeof CounterfactualOutcomeFlip>;

/**
 * One decision point, aggregated over every valid alternative it had.
 *
 * The report carries these rather than the full alternative list because a
 * report has to stay readable at the scale of a whole run; the list itself is
 * one drill-down away. What is *not* dropped is any claim about magnitude: the
 * best and worst alternative travel in full, along with the counts behind them.
 */
export const CounterfactualDecision = z.object({
  index: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  actionId: z.string().min(1),
  source: z.enum(['agent', 'manual']),
  action: SimulationActionInput,
  actual: z.object({
    accepted: z.boolean(),
    rejectionReason: z.string().nullable(),
    observation: z.string(),
  }),
  space: CounterfactualActionSpace,
  alternatives: z.object({
    analysed: z.number().int().nonnegative(),
    improving: z.number().int().nonnegative(),
    equivalent: z.number().int().nonnegative(),
    worsening: z.number().int().nonnegative(),
  }),
  best: CounterfactualAlternative.nullable(),
  worst: CounterfactualAlternative.nullable(),
  meanAlternativeOverall: z.number().min(0).max(100).nullable(),
  /**
   * How much the recorded choice gave up against the best alternative it had,
   * under the stated continuation policy. `0` means no alternative the engine
   * could construct would have scored higher — not that the choice was optimal
   * in any wider sense.
   */
  regret: z.number().min(0).max(100).nullable(),
  outcomeFlips: z.object({
    count: z.number().int().nonnegative(),
    reported: z.array(CounterfactualOutcomeFlip),
  }),
  /** Deterministic, template-generated statement of the above. Never a judgement. */
  statement: z.string().min(1),
});
export type CounterfactualDecision = z.infer<typeof CounterfactualDecision>;

/**
 * One decision point's contribution to the run's outcome, as the report ranks
 * it. This is the answer to "how much did this decision contribute" — stated as
 * a regret under a named policy, never as a claim about intent or cause.
 */
export const CounterfactualContribution = z.object({
  rank: z.number().int().positive(),
  index: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  actionId: z.string().min(1),
  source: z.enum(['agent', 'manual']),
  action: SimulationActionInput,
  regret: z.number().min(0).max(100),
  outcomeFlipCount: z.number().int().nonnegative(),
  recordedOverall: z.number().int().min(0).max(100),
  bestAlternativeKey: z.string().min(1).nullable(),
  bestAlternativeOverall: z.number().int().min(0).max(100).nullable(),
  statement: z.string().min(1),
});
export type CounterfactualContribution = z.infer<typeof CounterfactualContribution>;

/** The run-level aggregate over every decision point analysed. */
export const CounterfactualSummary = z.object({
  decisionPoints: z.number().int().nonnegative(),
  agentDecisions: z.number().int().nonnegative(),
  manualDecisions: z.number().int().nonnegative(),
  /**
   * Candidates the environment was asked about, summed over every decision
   * point — the whole action space, valid and refused alike.
   */
  enumeratedActions: z.number().int().nonnegative(),
  /**
   * The valid action each decision point had, summed. A decision whose recorded
   * action was itself valid had one fewer *alternative* than this, because the
   * recorded action is not an alternative to itself; a decision whose recorded
   * action was refused had exactly this many. So
   * `alternativesAnalysed === validActions - (decisions the environment accepted)`.
   */
  validActions: z.number().int().nonnegative(),
  invalidActions: z.number().int().nonnegative(),
  /** Alternatives actually scored, excluding the recorded action each time. */
  alternativesAnalysed: z.number().int().nonnegative(),
  improvingDecisions: z.number().int().nonnegative(),
  equivalentDecisions: z.number().int().nonnegative(),
  worseningDecisions: z.number().int().nonnegative(),
  /**
   * Decisions where every valid action left the run on the same score — the
   * remaining part of the partition, so the four counts sum to `decisionPoints`
   * and no decision is silently unaccounted for.
   */
  uncontestedDecisions: z.number().int().nonnegative(),
  /** Decisions where some alternative ends the run in a different status. */
  outcomeFlipDecisions: z.number().int().nonnegative(),
  bestAlternativeOverall: z.number().int().min(0).max(100).nullable(),
  worstAlternativeOverall: z.number().int().min(0).max(100).nullable(),
  meanAlternativeOverall: z.number().min(0).max(100).nullable(),
  maxRegret: z.number().min(0).max(100).nullable(),
  meanRegret: z.number().min(0).max(100).nullable(),
});
export type CounterfactualSummary = z.infer<typeof CounterfactualSummary>;

/** The policies every number in a report is stated under. */
export const CounterfactualPolicies = z.object({
  actionSpace: z.literal(ACTION_SPACE_POLICY),
  continuation: z.literal(CONTINUATION_POLICY),
  comparison: z.literal(COMPARISON_POLICY),
});
export type CounterfactualPolicies = z.infer<typeof CounterfactualPolicies>;

/** What the recorded run scored, by the evaluation engine's own verdict. */
export const CounterfactualBaseline = z.object({
  overallScore: z.number().int().min(0).max(100),
  scores: CounterfactualScores,
});
export type CounterfactualBaseline = z.infer<typeof CounterfactualBaseline>;

export const CounterfactualReport = z.object({
  run: z.object({
    runId: z.string().min(1),
    status: SimulationRunStatus,
    /** True when the evidence is a snapshot of a run that had not terminated. */
    inProgress: z.boolean(),
    scenario: SimulationScenarioIdentity.nullable(),
    decisionPointCount: z.number().int().nonnegative(),
    world: CounterfactualWorld,
  }),
  /** The recorded run, scored by the existing evaluation engine. */
  baseline: CounterfactualBaseline,
  policies: CounterfactualPolicies,
  summary: CounterfactualSummary,
  decisions: z.array(CounterfactualDecision),
  causal: z.object({
    /** Decision points by regret, highest first; ties in decision-point order. */
    ranking: z.array(CounterfactualContribution),
    /** The decision the ranking puts first, or `null` when there were none. */
    criticalDecision: CounterfactualContribution.nullable(),
  }),
});
export type CounterfactualReport = z.infer<typeof CounterfactualReport>;

/**
 * One alternative with its full counterfactual trajectory and verdict.
 *
 * This is the drill-down shape: it carries the whole counterfactual state and
 * the whole `EvaluationResult`, which is more than a report can hold for every
 * alternative at every decision point, but is exactly what is needed to check
 * one decision by hand.
 */
export const CounterfactualAlternativeDetail = CounterfactualAlternative.extend({
  state: SimulationState,
  evaluation: EvaluationResult,
});
export type CounterfactualAlternativeDetail = z.infer<typeof CounterfactualAlternativeDetail>;

export const CounterfactualDecisionAnalysis = z.object({
  run: z.object({
    runId: z.string().min(1),
    status: SimulationRunStatus,
    inProgress: z.boolean(),
    scenario: SimulationScenarioIdentity.nullable(),
    decisionPointCount: z.number().int().nonnegative(),
  }),
  baseline: CounterfactualBaseline,
  policies: CounterfactualPolicies,
  decision: CounterfactualDecision,
  /** Every valid alternative at this decision point, in action-space order. */
  alternatives: z.array(CounterfactualAlternativeDetail),
  /** The rejected part of the action space, for completeness. */
  rejectedAlternatives: z.array(
    z.object({
      key: z.string().min(1),
      action: SimulationActionInput,
      code: z.string().min(1),
      reason: z.string(),
    }),
  ),
});
export type CounterfactualDecisionAnalysis = z.infer<typeof CounterfactualDecisionAnalysis>;

export const COUNTERFACTUAL_ERROR_CODES = [
  'INVALID_SOURCE',
  'TOO_MANY_DECISIONS',
  'UNKNOWN_DECISION',
  'INVALID_ACTION_SPACE',
  'INVALID_RESULT',
] as const;
export type CounterfactualErrorCode = (typeof COUNTERFACTUAL_ERROR_CODES)[number];

/** Raised when a run's evidence cannot support a counterfactual analysis. */
export class CounterfactualError extends Error {
  readonly code: CounterfactualErrorCode;

  constructor(code: CounterfactualErrorCode, message: string) {
    super(message);
    this.name = 'CounterfactualError';
    this.code = code;
  }
}

/** The evaluation categories this engine reports on, in the engine's own order. */
export const COUNTERFACTUAL_CATEGORIES = [
  'taskSuccess',
  'safety',
  'efficiency',
  'resourceManagement',
  'reliability',
] as const satisfies readonly EvaluationCategory[];
