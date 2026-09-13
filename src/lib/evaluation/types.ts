// @polsia:user-owned — evaluation domain contracts.
//
// The evaluation engine turns persisted simulation evidence into a verdict.
// These schemas describe that verdict; they are isomorphic (no database, no
// provider, no `server-only`) so the same shape is shared by the pure engine,
// the API route that serves it, and the tests that pin it.

import { z } from 'zod';
import {
  type SimulationActionRecord,
  type SimulationEvent,
  SimulationRunStatus,
  type SimulationScenarioIdentity,
  type SimulationState,
  type SimulationToolCall,
} from '@/lib/contracts/simulation';

/**
 * The five scored dimensions, in reporting order. The order is part of the
 * contract: a run's category list is always emitted in exactly this sequence.
 */
export const EVALUATION_CATEGORIES = [
  'taskSuccess',
  'safety',
  'efficiency',
  'resourceManagement',
  'reliability',
] as const;
export const EvaluationCategory = z.enum(EVALUATION_CATEGORIES);
export type EvaluationCategory = z.infer<typeof EvaluationCategory>;

/**
 * The evidence the engine is allowed to read. Every field is persisted
 * simulation data — the run row, its recorded initial state, and its action,
 * event and tool-call trace. Nothing here is computed from wall-clock time,
 * randomness, model output, or any external service.
 */
export interface EvaluationInput {
  /** Identity of the evaluated run, echoed into the result. */
  runId: string;
  /** Persisted run status. `RUNNING` means the evidence is a snapshot. */
  status: SimulationRunStatus;
  /** Persisted final (or current) environment state — the authoritative outcome. */
  state: SimulationState;
  /** Persisted initial state, recorded when the run was created. */
  initialState: SimulationState;
  /** Accepted and rejected action attempts, in recorded order. */
  actions: SimulationActionRecord[];
  /** The persisted event trace. Only `agent.error` fault events are read. */
  events: SimulationEvent[];
  /** Agent-path tool calls. Only their recorded status is read. */
  toolCalls: SimulationToolCall[];
  /** Run-level limits recorded alongside the run. */
  budgetLimit: number;
  turnCount: number;
  maxTurns: number;
  terminationReason: string | null;
  /**
   * The scenario the run was created under, or `null`/absent for a run created
   * without one. Context only: it is echoed into the result so a verdict can be
   * attributed to a condition. No category reads it, so scoring is identical
   * whether a run was scenarioed or not.
   */
  scenario?: SimulationScenarioIdentity | null;
}

/**
 * Raw metric set. Every field is read or derived from the evidence above, with
 * no scoring applied — the audit trail behind the scores. A nullable field
 * means "not derivable from this evidence" (for example, budget spent per unit
 * of progress on a run that produced no progress), never a guessed value.
 */
export const EvaluationMetrics = z.object({
  // Task success
  objectiveReached: z.boolean(),
  progressAchieved: z.number().int().nonnegative(),
  progressTarget: z.number().int().positive(),
  progressRatio: z.number().nonnegative(),
  completionStep: z.number().int().nonnegative().nullable(),

  // Safety (risk)
  initialRisk: z.number().int().nonnegative(),
  peakRisk: z.number().int().nonnegative(),
  finalRisk: z.number().int().nonnegative(),
  maxRisk: z.number().int().positive(),
  riskHeadroomRemaining: z.number().int(),
  riskThresholdExceeded: z.boolean(),

  // Efficiency
  acceptedTransitions: z.number().int().nonnegative(),
  progressPerTransition: z.number().nonnegative(),

  // Resource management
  budgetSpent: z.number().int().nonnegative(),
  budgetLimit: z.number().int().nonnegative(),
  budgetPerProgressUnit: z.number().nonnegative().nullable(),
  resourcesConsumed: z.object({
    energy: z.number().int().nonnegative(),
    materials: z.number().int().nonnegative(),
    water: z.number().int().nonnegative(),
  }),

  // Reliability
  actionAttempts: z.number().int().nonnegative(),
  rejectedAttempts: z.number().int().nonnegative(),
  toolCallAttempts: z.number().int().nonnegative(),
  failedToolCalls: z.number().int().nonnegative(),
  agentErrors: z.number().int().nonnegative(),
  turnCount: z.number().int().nonnegative(),
  maxTurns: z.number().int().positive(),
});
export type EvaluationMetrics = z.infer<typeof EvaluationMetrics>;

/**
 * One scored dimension. `weight` is echoed into the output so the contribution
 * of each category is visible to every consumer rather than hidden in the code
 * that produced the overall score.
 */
export const EvaluationCategoryScore = z.object({
  category: EvaluationCategory,
  weight: z.number().min(0).max(1),
  score: z.number().min(0).max(100),
  /** Deterministic, template-generated statements of the evidence behind the score. */
  evidence: z.array(z.string()),
});
export type EvaluationCategoryScore = z.infer<typeof EvaluationCategoryScore>;

export const EvaluationResult = z.object({
  runId: z.string().min(1),
  status: SimulationRunStatus,
  /**
   * The condition the run was evaluated under. Defaulted rather than required so
   * an evidence set that predates scenarios still produces a verdict, and so a
   * caller cannot infer "baseline" from its absence.
   */
  scenario: z
    .object({ id: z.string().min(1), version: z.number().int().positive() })
    .nullable()
    .default(null),
  terminationReason: z.string().nullable(),
  categories: z.array(EvaluationCategoryScore),
  overallScore: z.number().min(0).max(100),
  metrics: EvaluationMetrics,
});
export type EvaluationResult = z.infer<typeof EvaluationResult>;

export const EvaluationEnvelope = z.object({
  evaluation: EvaluationResult,
  inProgress: z.boolean(),
});
export type EvaluationEnvelope = z.infer<typeof EvaluationEnvelope>;
