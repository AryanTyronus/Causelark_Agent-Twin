//
// A benchmark is a declarative experiment: an environment, an ordered set of
// scenario conditions, a seed set, and the agent configuration that ran it.
// These shapes describe the definition, the deterministic run matrix derived
// from it, and the aggregate report derived from the persisted evidence those
// runs produced.
//
// Like the scenario and evaluation contracts, these schemas are isomorphic: no
// database, no provider, no `server-only`, no clock and no randomness. A
// benchmark definition carries data only — never a function — so a definition
// resolved from an identifier can only ever be one that shipped with the code.

import { z } from 'zod';
import {
  SimulationConfiguration,
  SimulationEnvironmentKey,
  SimulationObjectiveKey,
  SimulationRunStatus,
} from '@/lib/contracts/simulation';
import { EvaluationResult } from '@/lib/evaluation/types';

/** Versions are small integers assigned by hand, never timestamps. */
export const BENCHMARK_VERSION_MIN = 1;

/**
 * The largest matrix one execution may build: one world's seven conditions
 * against the four seeds the environments publish. Bounded deliberately — a
 * benchmark case drives a real agent turn loop, and this phase favours
 * reproducibility over throughput.
 */
export const MAX_BENCHMARK_CASES = 28;

/** The environment publishes four replay seeds; a benchmark may select from them. */
export const MAX_BENCHMARK_SEEDS = 4;

/** Scores are reported to this many decimal places. See `roundMetric`. */
export const BENCHMARK_METRIC_PRECISION = 2;

/**
 * The scenario a benchmark measures degradation against when it names none of
 * its own. Robustness is a statement about a change, so a definition must name
 * the condition it is a change *from* — and a condition is a scenario identity
 * inside one world, so the reference has to be the definition's to make.
 *
 * This is the resource-routing world's baseline, and it stays the default so
 * every definition written before a second world existed keeps its exact
 * meaning.
 */
export const BENCHMARK_BASELINE_SCENARIO_ID = 'baseline';

/**
 * The agent that produced a benchmark's runs.
 *
 * `provider` is deliberately a free-form string rather than an enum: the
 * benchmark engine stays provider-agnostic and has no business knowing the
 * provider catalogue. What makes the label trustworthy is not that the schema
 * recognises it, but that execution refuses to run a configuration this
 * deployment does not actually resolve.
 */
export const BenchmarkAgentConfiguration = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
  /** Human-readable provider label, recorded in the report only. */
  label: z.string().min(1).max(160).optional(),
});
export type BenchmarkAgentConfiguration = z.infer<typeof BenchmarkAgentConfiguration>;

/**
 * The agent a set of runs is attributed to.
 *
 * The benchmark engine does not mint identities and does not interpret them. It
 * records the label its executor supplied so a run's evidence can be traced
 * back to the agent that produced it; what that label *means* — which provider,
 * which model, which configuration — is the comparison layer's business. A run
 * that carries no attribution keeps `null` here rather than a placeholder,
 * because "no agent recorded" and "this agent" are different claims.
 */
export const BenchmarkAgentAttribution = z.object({
  agentId: z.string().min(1).max(64),
  agentVersion: z.string().min(1).max(64),
});
export type BenchmarkAgentAttribution = z.infer<typeof BenchmarkAgentAttribution>;

/** A reference to a scenario the benchmark runs under, pinned to a version. */
export const BenchmarkScenario = z.object({
  id: z.string().min(1).max(64),
  version: z.number().int().min(BENCHMARK_VERSION_MIN),
});
export type BenchmarkScenario = z.infer<typeof BenchmarkScenario>;

export const BenchmarkDefinition = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Benchmark ids are lower-kebab-case.'),
  version: z.number().int().min(BENCHMARK_VERSION_MIN),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  environmentKey: SimulationEnvironmentKey,
  objectiveKey: SimulationObjectiveKey,
  /**
   * The condition robustness is measured as a change *from*.
   *
   * Defaulted rather than required, and defaulted to the resource-routing
   * baseline in particular: every benchmark that shipped before a second
   * environment existed named that condition implicitly, and a benchmark that
   * still does is not ambiguous — it is one whose world has exactly one
   * baseline. A world with its own baseline names it.
   */
  baselineScenarioId: z.string().min(1).max(64).default(BENCHMARK_BASELINE_SCENARIO_ID),
  /** Ordered: the matrix follows this order, then the seed order. */
  scenarios: z.array(BenchmarkScenario).min(1),
  /** Ordered: the matrix follows the scenario order, then this order. */
  seeds: z.array(z.number().int().min(0).max(999999)).min(1),
  /** Optional per-benchmark overrides merged over the environment defaults. */
  configuration: SimulationConfiguration.partial().optional(),
});
export type BenchmarkDefinition = z.infer<typeof BenchmarkDefinition>;

/** The definition minus its body: what the catalogue endpoint publishes. */
export const BenchmarkSummary = z.object({
  id: z.string().min(1),
  version: z.number().int().min(BENCHMARK_VERSION_MIN),
  name: z.string().min(1),
  description: z.string().min(1),
  environmentKey: SimulationEnvironmentKey,
  objectiveKey: SimulationObjectiveKey,
  scenarioCount: z.number().int().positive(),
  seedCount: z.number().int().positive(),
  caseCount: z.number().int().positive(),
});
export type BenchmarkSummary = z.infer<typeof BenchmarkSummary>;

export const BenchmarkCatalog = z.object({ benchmarks: z.array(BenchmarkSummary) });
export type BenchmarkCatalog = z.infer<typeof BenchmarkCatalog>;

/**
 * One cell of the run matrix: a scenario at an exact version, at an exact seed.
 *
 * `key` is the stable identity of the cell — `scenario@version#seed` — so a case
 * can be associated with the run it produced, and with a row in the report,
 * without depending on array position or on a generated run id.
 */
export const BenchmarkCase = z.object({
  index: z.number().int().nonnegative(),
  key: z.string().min(1),
  scenarioId: z.string().min(1),
  scenarioVersion: z.number().int().min(BENCHMARK_VERSION_MIN),
  seed: z.number().int().min(0),
  isBaseline: z.boolean(),
});
export type BenchmarkCase = z.infer<typeof BenchmarkCase>;

/**
 * A case's own run status, plus `UNAVAILABLE` for a case whose run produced no
 * readable evidence. The distinction must never blur: a case that failed for an
 * infrastructural reason is not a run that failed on merit.
 */
export const BENCHMARK_CASE_STATUSES = [...SimulationRunStatus.options, 'UNAVAILABLE'] as const;
export const BenchmarkCaseStatus = z.enum(BENCHMARK_CASE_STATUSES);
export type BenchmarkCaseStatus = z.infer<typeof BenchmarkCaseStatus>;

/**
 * The three-way split the report must keep: intended terminations, faults, and
 * cases with no verdict at all. Reaching a run limit groups with success,
 * following the evaluation engine's own distinction between a limit and a fault.
 */
export const BENCHMARK_OUTCOMES = [
  'succeeded',
  'unsuccessful',
  'inProgress',
  'unavailable',
] as const;
export const BenchmarkOutcome = z.enum(BENCHMARK_OUTCOMES);
export type BenchmarkOutcome = z.infer<typeof BenchmarkOutcome>;

/**
 * Report-only severity order, worst first. A scenario's `runStatus` is the worst
 * status any of its cases reached, and ties in the "worst scenario" comparisons
 * break by this declared order, then by the benchmark definition's scenario
 * order — never by object key iteration.
 */
export const CASE_STATUS_SEVERITY = [
  'ERROR',
  'FAILED',
  'TIMEOUT',
  'UNAVAILABLE',
  'RUNNING',
  'LIMIT_REACHED',
  'COMPLETED',
] as const;

/** One executed case: the cell, the run it produced, and the verdict for that run. */
export const BenchmarkRun = z.object({
  case: BenchmarkCase,
  runId: z.string().min(1),
  status: BenchmarkCaseStatus,
  outcome: BenchmarkOutcome,
  terminationReason: z.string().nullable().default(null),
  /** `null` when the case produced no evidence to evaluate. */
  evaluation: EvaluationResult.nullable().default(null),
});
export type BenchmarkRun = z.infer<typeof BenchmarkRun>;

/** Counts over the matrix. Every field is derived from the runs, never chosen. */
export const BenchmarkCaseSummary = z.object({
  scenarioCount: z.number().int().nonnegative(),
  seedCount: z.number().int().nonnegative(),
  totalCases: z.number().int().nonnegative(),
  /** Cases whose run reached a terminal status of its own. */
  completedCases: z.number().int().nonnegative(),
  limitReachedCases: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(),
  timeoutCases: z.number().int().nonnegative(),
  errorCases: z.number().int().nonnegative(),
  runningCases: z.number().int().nonnegative(),
  unavailableCases: z.number().int().nonnegative(),
  /** The outcome partition: succeeded + unsuccessful + inProgress + unavailable = executed. */
  succeededCases: z.number().int().nonnegative(),
  unsuccessfulCases: z.number().int().nonnegative(),
  inProgressCases: z.number().int().nonnegative(),
  /** Cases that produced a run. `totalCases - executedCases` never ran. */
  executedCases: z.number().int().nonnegative(),
  /** Cases that yielded an EvaluationResult to average over. */
  evaluatedCases: z.number().int().nonnegative(),
});
export type BenchmarkCaseSummary = z.infer<typeof BenchmarkCaseSummary>;

/**
 * Aggregate scores. Every field is `null` when no case yielded an evaluation —
 * an absent measurement, never a zero standing in for one.
 */
export const BenchmarkDimensions = z.object({
  evaluatedCaseCount: z.number().int().nonnegative(),
  averageOverallScore: z.number().nullable(),
  minimumOverallScore: z.number().nullable(),
  maximumOverallScore: z.number().nullable(),
  averageTaskScore: z.number().nullable(),
  averageSafetyScore: z.number().nullable(),
  averageEfficiencyScore: z.number().nullable(),
  averageResourceScore: z.number().nullable(),
  averageReliabilityScore: z.number().nullable(),
});
export type BenchmarkDimensions = z.infer<typeof BenchmarkDimensions>;

/** Why a robustness score could not be computed. */
export const ROBUSTNESS_UNAVAILABLE_REASONS = [
  'MISSING_BASELINE',
  'NO_EVALUATED_BASELINE',
  'NO_PERTURBED_SCENARIOS',
  'NO_EVALUATED_SCENARIOS',
  'ZERO_BASELINE',
] as const;
export const RobustnessUnavailableReason = z.enum(ROBUSTNESS_UNAVAILABLE_REASONS);
export type RobustnessUnavailableReason = z.infer<typeof RobustnessUnavailableReason>;

/**
 * One scenario's row in the degradation table. Scores are the rounded means of
 * the scenario's evaluated cases; degradations are defined over those reported
 * scores so every number can be recomputed from the numbers beside it.
 */
export const ScenarioDegradation = z.object({
  scenarioId: z.string().min(1),
  scenarioVersion: z.number().int().min(BENCHMARK_VERSION_MIN),
  isBaseline: z.boolean(),
  score: z.number().nullable(),
  baselineScore: z.number().nullable(),
  /** `baselineScore - score`. Negative means the scenario improved on the baseline. */
  absoluteDegradation: z.number().nullable(),
  /** `absoluteDegradation / baselineScore`. `null` when the baseline is zero or absent. */
  relativeDegradation: z.number().nullable(),
  /** `score / baselineScore`, capped at 1. `null` when the baseline is zero or absent. */
  retention: z.number().nullable(),
  taskScore: z.number().nullable(),
  safetyScore: z.number().nullable(),
  efficiencyScore: z.number().nullable(),
  resourceScore: z.number().nullable(),
  reliabilityScore: z.number().nullable(),
  caseCount: z.number().int().nonnegative(),
  evaluatedCount: z.number().int().nonnegative(),
  /** The worst status any of the scenario's cases reached, or `null` with no cases. */
  runStatus: BenchmarkCaseStatus.nullable(),
});
export type ScenarioDegradation = z.infer<typeof ScenarioDegradation>;

/**
 * Agent Twin's current deterministic robustness metric.
 *
 * It measures how much of the baseline condition's score survives each
 * environmental change. It is not a universal scientific quantity and is not
 * claimed to be one: it is a named, versioned, reproducible ratio whose inputs
 * are all printed in the report beside it.
 */
export const BENCHMARK_ROBUSTNESS_FORMULA = 'baseline-retention-v1';

/**
 * One benchmark in full: the standardised test itself, not its size.
 *
 * The catalogue carries counts, because a list only needs to say how large each
 * benchmark is. A page about one benchmark needs to say what it *is* — which
 * conditions at which pinned versions, which seeds, and the formula its
 * robustness figure is a retention against — so this shape publishes the
 * definition as data. It is a projection of the compiled registry and nothing
 * more: no configuration is resolved against a credential, and no definition can
 * arrive from a request.
 */
export const BenchmarkDetail = z.object({
  id: z.string().min(1),
  version: z.number().int().min(BENCHMARK_VERSION_MIN),
  name: z.string().min(1),
  description: z.string().min(1),
  environmentKey: SimulationEnvironmentKey,
  objectiveKey: SimulationObjectiveKey,
  /** The conditions, in matrix order, each pinned to an exact version. */
  scenarios: z.array(BenchmarkScenario),
  /** The seeds, in matrix order. */
  seeds: z.array(z.number().int().min(0)),
  /** Matrix cells: scenarios × seeds. */
  caseCount: z.number().int().positive(),
  /** The scenario robustness is measured as a change from, for this benchmark. */
  baselineScenarioId: z.string().min(1),
  /** The formula the benchmark engine computes robustness with. */
  robustnessFormula: z.literal(BENCHMARK_ROBUSTNESS_FORMULA),
  /** Configuration this benchmark declares over the environment's defaults. */
  configuration: SimulationConfiguration.partial().nullable(),
  /** The engine's own bound on how large one execution may be. */
  limits: z.object({
    maxCases: z.number().int().positive(),
    maxSeeds: z.number().int().positive(),
  }),
});
export type BenchmarkDetail = z.infer<typeof BenchmarkDetail>;

export const RobustnessReport = z.object({
  formula: z.literal(BENCHMARK_ROBUSTNESS_FORMULA),
  baselineScenarioId: z.string().min(1).nullable(),
  baselineScore: z.number().nullable(),
  /** Mean score across every scenario that yielded evidence, baseline included. */
  averageScenarioScore: z.number().nullable(),
  /** Lowest scenario score among those. */
  worstScenarioScore: z.number().nullable(),
  /** Mean degradation across the perturbed scenarios that yielded evidence. */
  averageDegradation: z.number().nullable(),
  /** Largest degradation across those; negative if every scenario improved. */
  worstDegradation: z.number().nullable(),
  /** Mean retention across the perturbed scenarios that yielded evidence, or `null`. */
  robustnessScore: z.number().nullable(),
  unavailableReason: RobustnessUnavailableReason.nullable(),
  worstScenarioId: z.string().min(1).nullable(),
  bestNonBaselineScenarioId: z.string().min(1).nullable(),
  greatestDegradationScenarioId: z.string().min(1).nullable(),
  evaluatedScenarioCount: z.number().int().nonnegative(),
  perturbedScenarioCount: z.number().int().nonnegative(),
});
export type RobustnessReport = z.infer<typeof RobustnessReport>;

/**
 * The failure classes the persisted evidence supports. Each is a count over
 * distinct cases, with the metric that was read and the runs it flagged, in
 * matrix order. Nothing here is inferred from agent text: a class is reported
 * only when a recorded field states it.
 */
export const BENCHMARK_FAILURE_CATEGORIES = [
  'taskFailure',
  'safetyViolation',
  'invalidActions',
  'providerFailures',
  'toolFailures',
  'timeouts',
] as const;
export const BenchmarkFailureCategory = z.enum(BENCHMARK_FAILURE_CATEGORIES);
export type BenchmarkFailureCategory = z.infer<typeof BenchmarkFailureCategory>;

export const BenchmarkFailureFinding = z.object({
  /** Cases flagged, not occurrences: a case with three rejections counts once. */
  count: z.number().int().nonnegative(),
  /** The persisted metric the classification read, or `null` for a status-only class. */
  metric: z.string().nullable(),
  runIds: z.array(z.string()),
  scenarioIds: z.array(z.string()),
});
export type BenchmarkFailureFinding = z.infer<typeof BenchmarkFailureFinding>;

export const BenchmarkFailureAnalysis = z.object({
  taskFailure: BenchmarkFailureFinding,
  safetyViolation: BenchmarkFailureFinding,
  invalidActions: BenchmarkFailureFinding,
  providerFailures: BenchmarkFailureFinding,
  toolFailures: BenchmarkFailureFinding,
  timeouts: BenchmarkFailureFinding,
});
export type BenchmarkFailureAnalysis = z.infer<typeof BenchmarkFailureAnalysis>;

/** The effective inputs a result was produced from. */
export const BenchmarkResultConfiguration = z.object({
  environmentKey: SimulationEnvironmentKey,
  objectiveKey: SimulationObjectiveKey,
  scenarios: z.array(BenchmarkScenario),
  /** The seeds the matrix actually used. */
  seeds: z.array(z.number().int().min(0)),
  /** The seeds the definition declared, before any override. */
  declaredSeeds: z.array(z.number().int().min(0)),
  caseCount: z.number().int().positive(),
});
export type BenchmarkResultConfiguration = z.infer<typeof BenchmarkResultConfiguration>;

/**
 * A benchmark result: a deterministic function of a benchmark definition and the
 * persisted evaluations its runs produced.
 *
 * It carries run references rather than copied traces, and it stores no derived
 * value that cannot be recomputed from the evidence beside it.
 */
export const BenchmarkResult = z.object({
  benchmark: z.object({
    id: z.string().min(1),
    version: z.number().int().min(BENCHMARK_VERSION_MIN),
    name: z.string().min(1),
  }),
  agent: BenchmarkAgentConfiguration,
  configuration: BenchmarkResultConfiguration,
  summary: BenchmarkCaseSummary,
  dimensions: BenchmarkDimensions,
  robustness: RobustnessReport,
  scenarios: z.array(ScenarioDegradation),
  failures: BenchmarkFailureAnalysis,
  runs: z.array(BenchmarkRun),
});
export type BenchmarkResult = z.infer<typeof BenchmarkResult>;

/** What `POST /api/benchmarks/[benchmarkId]/run` accepts. Nothing executable. */
export const BenchmarkRunRequest = z.object({
  /** Optional; when present it must be the configuration this deployment resolves. */
  agent: BenchmarkAgentConfiguration.optional(),
  /** Optional seed override: replaces the definition's declared seed set. */
  seeds: z.array(z.number().int().min(0).max(999999)).min(1).max(MAX_BENCHMARK_SEEDS).optional(),
});
export type BenchmarkRunRequest = z.infer<typeof BenchmarkRunRequest>;

export const BENCHMARK_ERROR_CODES = [
  'UNKNOWN_BENCHMARK',
  'INVALID_BENCHMARK',
  'INVALID_SCENARIO',
  'AGENT_CONFIGURATION_MISMATCH',
  'INVALID_AGENT_CONFIGURATION',
  'INVALID_RESULT',
] as const;
export type BenchmarkErrorCode = (typeof BENCHMARK_ERROR_CODES)[number];

/** Raised when a benchmark cannot be resolved, validated or aggregated. */
export class BenchmarkError extends Error {
  readonly code: BenchmarkErrorCode;

  constructor(code: BenchmarkErrorCode, message: string) {
    super(message);
    this.name = 'BenchmarkError';
    this.code = code;
  }
}
