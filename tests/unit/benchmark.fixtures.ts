// @polsia:user-owned — deterministic benchmark test fixtures.
//
// Real evaluation results here would mean running real simulations, which would
// make an aggregation test a test of the simulation engine instead of a test of
// the arithmetic. These fixtures are therefore built by hand: an evaluation with
// exactly the scores a case needs, and a run that wraps it. Nothing reads a
// clock or a random source, so a fixture built twice is the same fixture, and a
// local run id is never required.

import { outcomeOf } from '@/lib/benchmarks/aggregation';
import { benchmarkCaseKey } from '@/lib/benchmarks/matrix';
import { type BenchmarkCase, type BenchmarkCaseStatus, BenchmarkRun } from '@/lib/benchmarks/types';
import type { SimulationRunStatus } from '@/lib/contracts/simulation';
import {
  EFFICIENCY_WEIGHT,
  RELIABILITY_WEIGHT,
  RESOURCE_MANAGEMENT_WEIGHT,
  SAFETY_WEIGHT,
  scoreOverall,
  TASK_SUCCESS_WEIGHT,
} from '@/lib/evaluation/scoring';
import {
  EVALUATION_CATEGORIES,
  type EvaluationCategory,
  type EvaluationMetrics,
  EvaluationResult,
} from '@/lib/evaluation/types';

export type { BenchmarkCase, BenchmarkRun, BenchmarkCaseStatus };

export const BASELINE = 'baseline';

/** The evaluation engine's own weights, read from its exported constants. */
const CATEGORY_WEIGHTS: Record<EvaluationCategory, number> = {
  taskSuccess: TASK_SUCCESS_WEIGHT,
  safety: SAFETY_WEIGHT,
  efficiency: EFFICIENCY_WEIGHT,
  resourceManagement: RESOURCE_MANAGEMENT_WEIGHT,
  reliability: RELIABILITY_WEIGHT,
};

function weightsFor(category: EvaluationCategory): number {
  return CATEGORY_WEIGHTS[category];
}

/** A complete, valid metric set: nothing faulted and the objective was reached. */
export function metricsFixture(overrides: Partial<EvaluationMetrics> = {}): EvaluationMetrics {
  return {
    objectiveReached: true,
    progressAchieved: 10,
    progressTarget: 10,
    progressRatio: 1,
    completionStep: 4,
    initialRisk: 1,
    peakRisk: 2,
    finalRisk: 2,
    maxRisk: 10,
    riskHeadroomRemaining: 8,
    riskThresholdExceeded: false,
    acceptedTransitions: 4,
    progressPerTransition: 2.5,
    budgetSpent: 10,
    budgetLimit: 24,
    budgetPerProgressUnit: 1,
    resourcesConsumed: { energy: 3, materials: 3, water: 3 },
    actionAttempts: 4,
    rejectedAttempts: 0,
    toolCallAttempts: 4,
    failedToolCalls: 0,
    agentErrors: 0,
    turnCount: 1,
    maxTurns: 12,
    ...overrides,
  };
}

/**
 * An evaluation whose five category scores are exactly what the caller asked
 * for and whose overall score is the weighted mean of them — combined by the
 * evaluation engine's own `scoreOverall`, so a fixture cannot claim an overall
 * score the real engine would not have produced from the same categories.
 */
export function evaluationFixture(input: {
  runId: string;
  scores: Partial<Record<EvaluationCategory, number>> & { overall?: number };
  status?: SimulationRunStatus;
  scenario?: { id: string; version: number } | null;
  terminationReason?: string | null;
  metrics?: Partial<EvaluationMetrics>;
}): EvaluationResult {
  const categories = EVALUATION_CATEGORIES.map((category) => ({
    category,
    weight: weightsFor(category),
    score: input.scores[category] ?? 50,
    evidence: [`Fixture evidence for ${category}.`],
  }));
  return EvaluationResult.parse({
    runId: input.runId,
    status: input.status ?? 'COMPLETED',
    scenario: input.scenario ?? null,
    terminationReason: input.terminationReason ?? null,
    categories,
    overallScore: input.scores.overall ?? scoreOverall(categories),
    metrics: metricsFixture(input.metrics),
  });
}

/** One matrix cell, built the way `buildRunMatrix` builds it. */
export function caseFixture(input: {
  index: number;
  scenarioId: string;
  scenarioVersion?: number;
  seed: number;
  isBaseline?: boolean;
}): BenchmarkCase {
  const scenarioVersion = input.scenarioVersion ?? 1;
  return {
    index: input.index,
    key: benchmarkCaseKey(input.scenarioId, scenarioVersion, input.seed),
    scenarioId: input.scenarioId,
    scenarioVersion,
    seed: input.seed,
    isBaseline: input.isBaseline ?? input.scenarioId === BASELINE,
  };
}

/** A completed case whose evaluation carries the requested score. */
export function runFixture(input: {
  index: number;
  scenarioId: string;
  seed?: number;
  overall?: number;
  scores?: Partial<Record<EvaluationCategory, number>>;
  status?: BenchmarkCaseStatus;
  terminationReason?: string | null;
  metrics?: Partial<EvaluationMetrics>;
  runId?: string;
}): BenchmarkRun {
  const seed = input.seed ?? 1042;
  const cell = caseFixture({
    index: input.index,
    scenarioId: input.scenarioId,
    seed,
  });
  const status = input.status ?? 'COMPLETED';
  const simulationStatus = status === 'UNAVAILABLE' ? 'COMPLETED' : status;
  return BenchmarkRun.parse({
    case: cell,
    runId: input.runId ?? `run-${input.scenarioId}-${seed}`,
    status,
    outcome: outcomeOf(status),
    terminationReason: input.terminationReason ?? null,
    evaluation:
      status === 'UNAVAILABLE'
        ? null
        : evaluationFixture({
            runId: input.runId ?? `run-${input.scenarioId}-${seed}`,
            scores: { ...(input.scores ?? {}), overall: input.overall ?? 80 },
            status: simulationStatus,
            scenario: { id: cell.scenarioId, version: cell.scenarioVersion },
            terminationReason: input.terminationReason ?? null,
            metrics: input.metrics,
          }),
  });
}

/**
 * A uniform benchmark: every scenario scores the same, so any degradation the
 * report shows must have come from the definition rather than from the data.
 */
export function uniformRuns(scenarioIds: readonly string[], overall: number): BenchmarkRun[] {
  return scenarioIds.map((scenarioId, index) => runFixture({ index, scenarioId, overall }));
}
