// @polsia:user-owned — comparison domain contracts.
//
// An agent comparison is a declarative experiment: one benchmark, held fixed,
// run against several agent configurations. These schemas describe the shipped
// template, the experiment a request resolves to, the deterministic matrix it
// expands into, and the report derived from the persisted evidence those runs
// produced.
//
// Like the scenario, evaluation and benchmark contracts, these schemas are
// isomorphic: no database, no provider, no `server-only`, no clock and no
// randomness. Nothing here names a model, a provider or a vendor — an agent
// configuration is whatever the caller declares, and the only thing this layer
// asserts about it is that it is reproducible.

import { z } from 'zod';
import {
  BENCHMARK_ROBUSTNESS_FORMULA,
  BenchmarkCase,
  BenchmarkResult,
  BenchmarkScenario,
} from '@/lib/benchmarks/types';
import { SimulationEnvironmentKey, SimulationObjectiveKey } from '@/lib/contracts/simulation';

/** Versions are small integers assigned by hand, never timestamps. */
export const COMPARISON_VERSION_MIN = 1;

/**
 * A comparison runs the benchmark's matrix once per agent, so its cost is the
 * benchmark's cost multiplied by the agent count. The bound is therefore
 * expressed over the *whole* experiment and reuses the benchmark engine's own
 * ceiling rather than inventing a second one: twenty-eight cases is the most
 * this engine will drive in one execution, whether that is one agent over seven
 * scenarios and four seeds, or four agents over seven scenarios at one seed.
 */
export const MAX_COMPARISON_CASES = 28;

/** An experiment compares agents, so one is not an experiment. */
export const MIN_EXPERIMENT_AGENTS = 2;

/**
 * A hard ceiling on the agent count, independent of the matrix bound. With the
 * shipped benchmark's seven scenarios this is already unreachable — the matrix
 * bound binds first — but it keeps a hypothetical one-scenario benchmark from
 * turning into an unbounded fan-out.
 */
export const MAX_EXPERIMENT_AGENTS = 8;

/** The number of metadata entries one agent configuration may carry. */
export const MAX_AGENT_METADATA_ENTRIES = 16;

/**
 * The name of the comparison methodology this engine implements.
 *
 * It fixes what a comparison *is*: every agent runs the same benchmark, at the
 * same scenario versions, at the same seeds, in its own fresh world; each
 * agent's evidence is aggregated by the benchmark engine unchanged; agents are
 * then compared metric by metric, with every metric's direction declared rather
 * than assumed. A change to any of that is a new methodology name, because a
 * report has to say which rule produced it.
 */
export const COMPARISON_METHODOLOGY = 'same-conditions-head-to-head-v1';

/**
 * The rule that turns a metric-by-metric comparison into a single verdict.
 *
 * It is deliberately not a second scoring system. There is no weighted sum of
 * comparison metrics, no tuned coefficient and no model judgement anywhere in
 * it: it walks a declared list of discriminators in order, and the first one on
 * which the tied leaders do not all agree decides. If none of them separates
 * them, the verdict is a tie. If the evidence cannot support a decision at all,
 * the verdict says that instead of naming a winner.
 */
export const COMPARISON_VERDICT_RULE = 'declared-discriminator-order-v1';

/**
 * The discriminators, in the order the verdict rule consults them.
 *
 * The first is the evaluation engine's own overall score — its weighted verdict
 * over all five categories, which is the most complete single statement the
 * existing evaluation philosophy makes. The rest are that engine's five
 * dimensions in *descending weight order*, which is the order the evaluation
 * engine itself declares them in and the order of the weights it applies:
 * task success (0.30), safety (0.25), then efficiency, resource management and
 * reliability (0.15 each, in declared order). Robustness comes last, because it
 * is the benchmark engine's separate statement about behaviour across
 * conditions rather than a property of any single run.
 *
 * A discriminator whose values are absent for every tied leader is skipped
 * rather than read as zero.
 */
export const COMPARISON_DISCRIMINATORS = [
  'averageOverallScore',
  'averageTaskScore',
  'averageSafetyScore',
  'averageEfficiencyScore',
  'averageResourceScore',
  'averageReliabilityScore',
  'robustnessScore',
] as const;

/**
 * Whether a larger value of a metric is better, worse, or neither.
 *
 * `neutral` is a real answer, not a placeholder: an agent that took more steps,
 * spent more budget or used a larger share of it has not thereby performed
 * better or worse — those quantities only mean something alongside the result
 * they bought. A neutral metric is reported and compared, but it can never
 * decide a winner.
 */
export const COMPARISON_METRIC_DIRECTIONS = ['higher', 'lower', 'neutral'] as const;
export const ComparisonMetricDirection = z.enum(COMPARISON_METRIC_DIRECTIONS);
export type ComparisonMetricDirection = z.infer<typeof ComparisonMetricDirection>;

/**
 * Every metric a comparison reports, in reporting order.
 *
 * Each one is either read straight from the benchmark engine's report or is an
 * exact ratio of two counts it already produced. Nothing here is a new
 * measurement: `EvaluationMetrics` is the source of the per-case quantities, and
 * the benchmark report is the source of the aggregates.
 */
export const COMPARISON_METRIC_KEYS = [
  'averageOverallScore',
  'averageTaskScore',
  'averageSafetyScore',
  'averageEfficiencyScore',
  'averageResourceScore',
  'averageReliabilityScore',
  'taskSuccessRate',
  'completionRate',
  'robustnessScore',
  'rejectedActionRate',
  'averageRisk',
  'providerFailureCount',
  'toolFailureCount',
  'timeoutCount',
  'averageSteps',
  'averageBudgetSpent',
  'averageBudgetUtilisation',
] as const;
export const ComparisonMetricKey = z.enum(COMPARISON_METRIC_KEYS);
export type ComparisonMetricKey = z.infer<typeof ComparisonMetricKey>;

/**
 * One agent's own metadata entry.
 *
 * Modelled as an ordered list of pairs rather than an object so that
 * canonicalisation does not depend on property iteration order. Two
 * configurations are the same configuration only if their metadata is the same
 * after sorting by key, which is a guarantee a plain object cannot make here.
 */
export const AgentMetadataEntry = z.object({
  key: z.string().min(1).max(64),
  value: z.string().max(200),
});
export type AgentMetadataEntry = z.infer<typeof AgentMetadataEntry>;

/**
 * The agent configuration a comparison runs.
 *
 * `agentId` and `agentVersion` together are the agent's *name* — the label a
 * team uses for it — while `provider` and `model` record which build of it
 * actually ran. Both matter, and they are kept apart deliberately: a comparison
 * keyed on the name alone could silently fold two different configurations of
 * the same agent into one, and a report that recorded only the provider and
 * model could not say whose agent it was.
 *
 * Nothing here is a credential. An agent configuration travels through a
 * request, an experiment and a report, so it names the provider this build
 * construct a client for — never the key that client authenticates with, which
 * stays deployment configuration.
 *
 * The character constraints are not cosmetic. Identity is derived by joining
 * these fields, so a field that could contain the separator could make two
 * different configurations produce one key. Constraining the charset is what
 * makes that impossible by construction rather than by escaping alone.
 */
export const AgentConfiguration = z.object({
  agentId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Agent ids are lower-kebab-case.'),
  agentVersion: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      'Agent versions are letters, digits, dots, underscores and dashes.',
    ),
  provider: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Provider names are lower-case and separator-free.'),
  /** Free-form: model ids carry slashes, colons and dots across providers. */
  model: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'Model ids may not contain the identity separators.'),
  metadata: z.array(AgentMetadataEntry).max(MAX_AGENT_METADATA_ENTRIES).optional(),
});
export type AgentConfiguration = z.infer<typeof AgentConfiguration>;

/**
 * A shipped comparison experiment: what to run, never against what.
 *
 * A template pins the benchmark, the methodology and the bounds on how many
 * agents an execution may compare. It deliberately names no agent, no provider
 * and no model: the configurations arrive in the request, because a template
 * with a model baked in would be a hard-coded vendor choice wearing a
 * reproducible experiment's clothes.
 */
export const ExperimentTemplate = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Experiment ids are lower-kebab-case.'),
  version: z.number().int().min(COMPARISON_VERSION_MIN),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  benchmarkId: z.string().min(1).max(64),
  benchmarkVersion: z.number().int().min(COMPARISON_VERSION_MIN),
  /** Ordered: the matrix follows this order, then the seed order. */
  seeds: z.array(z.number().int().min(0).max(999999)).min(1).optional(),
});
export type ExperimentTemplate = z.infer<typeof ExperimentTemplate>;

/** The template minus its body: what the catalogue endpoint publishes. */
export const ExperimentSummary = z.object({
  id: z.string().min(1),
  version: z.number().int().min(COMPARISON_VERSION_MIN),
  name: z.string().min(1),
  description: z.string().min(1),
  benchmarkId: z.string().min(1),
  benchmarkVersion: z.number().int().min(COMPARISON_VERSION_MIN),
  benchmarkName: z.string().min(1),
  environmentKey: SimulationEnvironmentKey,
  objectiveKey: SimulationObjectiveKey,
  scenarioCount: z.number().int().positive(),
  seedCount: z.number().int().positive(),
  caseCountPerAgent: z.number().int().positive(),
  minimumAgents: z.number().int().min(MIN_EXPERIMENT_AGENTS),
  maximumAgents: z.number().int().min(MIN_EXPERIMENT_AGENTS),
  methodology: z.literal(COMPARISON_METHODOLOGY),
  verdictRule: z.literal(COMPARISON_VERDICT_RULE),
});
export type ExperimentSummary = z.infer<typeof ExperimentSummary>;

export const ExperimentCatalog = z.object({ experiments: z.array(ExperimentSummary) });
export type ExperimentCatalog = z.infer<typeof ExperimentCatalog>;

/**
 * What an experiment would do, before anyone runs it.
 *
 * The cases are the benchmark engine's own `BenchmarkCase` records, unchanged:
 * the experiment nests that matrix under each agent, so what a caller reads here
 * is exactly the per-agent matrix that will be executed. No agent is named,
 * because a plan is a property of the template and its benchmark — the agents
 * are the caller's to declare, and the bounds say how many.
 */
export const ExperimentPlan = z.object({
  experiment: ExperimentSummary,
  /** The ordered benchmark cells each agent will run. */
  cases: z.array(BenchmarkCase),
  /** The distinct seeds the matrix will use, in matrix order. */
  seeds: z.array(z.number().int().min(0)),
});
export type ExperimentPlan = z.infer<typeof ExperimentPlan>;

/**
 * One cell of the experiment matrix: one agent, on one benchmark case.
 *
 * `key` is the stable identity of the cell, and it is built from the agent's
 * *configuration* key rather than from its name. Two configurations that share
 * an agent id and version but differ in provider or model are different cells,
 * and the key says so; an experiment in which they would collide is refused
 * before a matrix is built, rather than being resolved by whichever ran first.
 */
export const ComparisonCase = z.object({
  index: z.number().int().nonnegative(),
  key: z.string().min(1),
  /** The canonical configuration key of the agent this cell runs. */
  agent: z.string().min(1),
  agentId: z.string().min(1),
  agentVersion: z.string().min(1),
  scenarioId: z.string().min(1),
  scenarioVersion: z.number().int().min(COMPARISON_VERSION_MIN),
  seed: z.number().int().min(0),
  isBaseline: z.boolean(),
});
export type ComparisonCase = z.infer<typeof ComparisonCase>;

/**
 * One agent's comparison-ready metrics.
 *
 * Every field is `null` when the evidence does not support it — a rate whose
 * denominator is zero, a mean over no cases, a robustness score the benchmark
 * engine declined to compute. A `null` here is an absent measurement and is
 * never read as a zero by anything downstream: the comparison treats two absent
 * values as "no basis to compare", not as "equal at zero".
 */
export const AgentMetrics = z.object({
  evaluatedCaseCount: z.number().int().nonnegative(),
  averageOverallScore: z.number().nullable(),
  averageTaskScore: z.number().nullable(),
  averageSafetyScore: z.number().nullable(),
  averageEfficiencyScore: z.number().nullable(),
  averageResourceScore: z.number().nullable(),
  averageReliabilityScore: z.number().nullable(),
  /** Cases whose recorded objective was reached, over evaluated cases. */
  taskSuccessRate: z.number().nullable(),
  /** Cases that reached a terminal status of their own, over the matrix. */
  completionRate: z.number().nullable(),
  robustnessScore: z.number().nullable(),
  /** Rejected action attempts over all action attempts, across evaluated cases. */
  rejectedActionRate: z.number().nullable(),
  /** Mean peak risk across evaluated cases. Lower is better. */
  averageRisk: z.number().nullable(),
  providerFailureCount: z.number().int().nonnegative(),
  toolFailureCount: z.number().int().nonnegative(),
  timeoutCount: z.number().int().nonnegative(),
  /** Mean accepted transitions across evaluated cases. Neutral: not a virtue. */
  averageSteps: z.number().nullable(),
  /** Mean budget spent across evaluated cases. Neutral. */
  averageBudgetSpent: z.number().nullable(),
  /** Budget spent over budget available, across evaluated cases. Neutral. */
  averageBudgetUtilisation: z.number().nullable(),
});
export type AgentMetrics = z.infer<typeof AgentMetrics>;

/**
 * Why an agent produced no comparable evidence.
 *
 * A configuration the deployment cannot run, a provider that refused, an
 * experiment that faulted — the agent is reported as unavailable with the
 * reason, never as an agent that scored zero.
 */
export const AgentUnavailableReason = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});
export type AgentUnavailableReason = z.infer<typeof AgentUnavailableReason>;

/**
 * One agent's side of the comparison.
 *
 * `report` is the benchmark engine's own result for this agent, included whole —
 * it is the evidence, and it already carries every run id, every case verdict,
 * every scenario row and the failure analysis, so a consumer can drill from the
 * comparison down to a single simulation run without this layer restating any of
 * it. `metrics` is the flattened, comparison-ready view of the same evidence,
 * derived from that report and from nothing else.
 */
export const ComparisonAgent = z.object({
  agent: AgentConfiguration,
  /** `agentId@agentVersion` — the agent's name. */
  identity: z.string().min(1),
  /** The canonical key that names this exact configuration. */
  key: z.string().min(1),
  status: z.enum(['COMPARED', 'UNAVAILABLE']),
  unavailableReason: AgentUnavailableReason.nullable(),
  metrics: AgentMetrics,
  /** `null` when the agent produced no report at all. */
  report: BenchmarkResult.nullable(),
  /** The scenario this agent scored highest under, or `null` with no evidence. */
  strongestScenarioId: z.string().nullable(),
  /** The scenario this agent scored lowest under, or `null` with no evidence. */
  weakestScenarioId: z.string().nullable(),
});
export type ComparisonAgent = z.infer<typeof ComparisonAgent>;

/** One metric, across every agent in the experiment. */
export const MetricComparison = z.object({
  metric: ComparisonMetricKey,
  direction: ComparisonMetricDirection,
  /** One entry per agent, in experiment order. `null` where not derivable. */
  values: z.array(z.number().nullable()),
  /** The agent configuration keys that hold the best comparable value. */
  leaders: z.array(z.string()),
  /** `true` when the leaders hold the value jointly. Empty leaders make it `false`. */
  tied: z.boolean(),
  /**
   * The gap between the best and the worst *comparable* value, or `null` when
   * fewer than two agents have a value or the metric is neutral.
   */
  spread: z.number().nullable(),
});
export type MetricComparison = z.infer<typeof MetricComparison>;

/** Two agents, compared metric by metric. */
export const HeadToHead = z.object({
  left: z.string().min(1),
  right: z.string().min(1),
  metrics: z.array(
    z.object({
      metric: ComparisonMetricKey,
      direction: ComparisonMetricDirection,
      left: z.number().nullable(),
      right: z.number().nullable(),
      /** `left - right` in the metric's own units, or `null` without both. */
      delta: z.number().nullable(),
      /** `null` for a tie, for a neutral metric, or without both values. */
      winner: z.enum(['left', 'right']).nullable(),
    }),
  ),
  /** Metrics each side won, over the metrics that can be won. */
  leftWins: z.number().int().nonnegative(),
  rightWins: z.number().int().nonnegative(),
});
export type HeadToHead = z.infer<typeof HeadToHead>;

/** One scenario, across every agent in the experiment. */
export const ScenarioComparison = z.object({
  scenarioId: z.string().min(1),
  scenarioVersion: z.number().int().min(COMPARISON_VERSION_MIN),
  isBaseline: z.boolean(),
  /** One entry per agent, in experiment order. */
  scores: z.array(z.number().nullable()),
  leaders: z.array(z.string()),
  tied: z.boolean(),
  /** Best minus worst among the comparable scores, or `null`. */
  spread: z.number().nullable(),
});
export type ScenarioComparison = z.infer<typeof ScenarioComparison>;

/** Every agent's robustness, side by side, with the formula unaltered. */
export const RobustnessComparison = z.object({
  formula: z.literal(BENCHMARK_ROBUSTNESS_FORMULA),
  /** One entry per agent, in experiment order. */
  scores: z.array(z.number().nullable()),
  leaders: z.array(z.string()),
  tied: z.boolean(),
  spread: z.number().nullable(),
  /**
   * One entry per agent: why its robustness could not be computed, or `null`.
   * Carried so an absent score is explained rather than merely missing.
   */
  unavailableReasons: z.array(z.string().nullable()),
});
export type RobustnessComparison = z.infer<typeof RobustnessComparison>;

/**
 * One failure class, per agent.
 *
 * The benchmark engine already classified the evidence; this only lines the
 * classifications up so a difference between agents is visible at a glance.
 * Nothing here asserts *why* an agent failed more often — a count is a count.
 */
export const FailureProfileRow = z.object({
  category: z.string().min(1),
  metric: z.string().nullable(),
  /** One count per agent, in experiment order. */
  counts: z.array(z.number().int().nonnegative()),
  /** The agents that recorded at least one case in this class. */
  agents: z.array(z.string()),
});
export type FailureProfileRow = z.infer<typeof FailureProfileRow>;

/** One rung of the verdict rule, recorded whether or not it decided. */
export const VerdictLevel = z.object({
  metric: ComparisonMetricKey,
  /** The agents still in contention when this rung was consulted. */
  contenders: z.array(z.string()),
  /** The contenders holding the best comparable value at this rung. */
  leaders: z.array(z.string()),
  /** The best value at this rung, or `null` when nobody had one. */
  value: z.number().nullable(),
  /** Best minus next-best among the contenders, or `null` with nothing to compare. */
  margin: z.number().nullable(),
  /** `true` when this rung separated the contenders down to one. */
  decided: z.boolean(),
});
export type VerdictLevel = z.infer<typeof VerdictLevel>;

export const COMPARISON_VERDICT_OUTCOMES = ['WINNER', 'TIE', 'INSUFFICIENT_EVIDENCE'] as const;
export const ComparisonVerdictOutcome = z.enum(COMPARISON_VERDICT_OUTCOMES);
export type ComparisonVerdictOutcome = z.infer<typeof ComparisonVerdictOutcome>;

/**
 * The verdict.
 *
 * `OUTCOME_WINNER` names one agent and the rung that decided it; `TIE` says the
 * declared discriminators did not separate the agents that had evidence;
 * `INSUFFICIENT_EVIDENCE` says a decision could not be reached at all — fewer
 * than two agents produced comparable evidence, or the rungs that could have
 * separated them were absent for everyone. The third state exists so that
 * "we cannot say" never has to be spelled as a win for whoever happened to have
 * a number.
 */
export const ComparisonVerdict = z.object({
  rule: z.literal(COMPARISON_VERDICT_RULE),
  outcome: ComparisonVerdictOutcome,
  /** The winning configuration key, or `null` unless the outcome is a winner. */
  winner: z.string().nullable(),
  /** The winning agent's name, or `null`. */
  winnerIdentity: z.string().nullable(),
  /** The discriminator that decided, or `null`. */
  decidedBy: ComparisonMetricKey.nullable(),
  /** Why the outcome is what it is, in the rule's own terms. */
  reason: z.string().min(1),
  levels: z.array(VerdictLevel),
});
export type ComparisonVerdict = z.infer<typeof ComparisonVerdict>;

/**
 * What the experiment was, so the report can be reproduced from itself.
 *
 * Every value here is an input that changed the result. Nothing is read from
 * ambient configuration at report time, because a report has to keep meaning
 * what it meant when it was produced.
 */
export const ComparisonExperimentRecord = z.object({
  id: z.string().min(1),
  version: z.number().int().min(COMPARISON_VERSION_MIN),
  name: z.string().min(1),
  description: z.string().min(1),
  benchmarkId: z.string().min(1),
  benchmarkVersion: z.number().int().min(COMPARISON_VERSION_MIN),
  benchmarkName: z.string().min(1),
  environmentKey: SimulationEnvironmentKey,
  objectiveKey: SimulationObjectiveKey,
  scenarios: z.array(BenchmarkScenario),
  /** The seeds the matrix actually used. */
  seeds: z.array(z.number().int().min(0)),
  /** The seeds the benchmark declared, before any override. */
  declaredSeeds: z.array(z.number().int().min(0)),
  /** Matrix cells per agent. */
  caseCountPerAgent: z.number().int().positive(),
  agentCount: z.number().int().positive(),
  /** Matrix cells across the whole experiment: `caseCountPerAgent × agentCount`. */
  totalCaseCount: z.number().int().positive(),
  /**
   * The canonical identity of this exact experiment: the template, the
   * benchmark, the seeds and every agent configuration, in canonical order.
   * Two executions that share it ran the same experiment.
   */
  key: z.string().min(1),
});

/** The rules the report was produced under. */
export const ComparisonMethodology = z.object({
  comparison: z.literal(COMPARISON_METHODOLOGY),
  verdictRule: z.literal(COMPARISON_VERDICT_RULE),
  robustnessFormula: z.literal(BENCHMARK_ROBUSTNESS_FORMULA),
  discriminators: z.array(ComparisonMetricKey),
});

/**
 * A comparison report: a deterministic function of an experiment and the
 * persisted evaluations its runs produced.
 *
 * It carries run references rather than copied traces, and it stores no derived
 * value that cannot be recomputed from the evidence beside it. The one thing it
 * cannot recompute — what the models actually did — is recorded exactly as
 * observed, because model output is not deterministic and a report that implied
 * otherwise would be lying about its own provenance.
 */
export const ComparisonReport = z.object({
  experiment: ComparisonExperimentRecord,
  methodology: ComparisonMethodology,
  /** One entry per agent, in canonical configuration order. */
  agents: z.array(ComparisonAgent),
  metrics: z.array(MetricComparison),
  scenarios: z.array(ScenarioComparison),
  robustness: RobustnessComparison,
  failures: z.array(FailureProfileRow),
  headToHead: z.array(HeadToHead),
  verdict: ComparisonVerdict,
  /** Cases the experiment intended to run, against cases that produced a run. */
  execution: z.object({
    plannedCaseCount: z.number().int().nonnegative(),
    executedCaseCount: z.number().int().nonnegative(),
    comparedAgentCount: z.number().int().nonnegative(),
    unavailableAgentCount: z.number().int().nonnegative(),
  }),
});
export type ComparisonReport = z.infer<typeof ComparisonReport>;

/** What `POST /api/agent-comparisons/[comparisonId]/run` accepts. */
export const ComparisonRunRequest = z.object({
  /**
   * The agents to compare. At least two, at most as many as the matrix bound
   * allows, each one exactly once.
   */
  agents: z.array(AgentConfiguration).min(MIN_EXPERIMENT_AGENTS).max(MAX_EXPERIMENT_AGENTS),
  /** Optional seed override, replacing the benchmark's declared seed set. */
  seeds: z.array(z.number().int().min(0).max(999999)).min(1).optional(),
});
export type ComparisonRunRequest = z.infer<typeof ComparisonRunRequest>;

export const COMPARISON_ERROR_CODES = [
  'UNKNOWN_EXPERIMENT',
  'INVALID_EXPERIMENT',
  'INVALID_AGENT_CONFIGURATION',
  'DUPLICATE_AGENT',
  'TOO_FEW_AGENTS',
  'TOO_MANY_AGENTS',
  'MATRIX_TOO_LARGE',
  'INVALID_REPORT',
] as const;
export type ComparisonErrorCode = (typeof COMPARISON_ERROR_CODES)[number];

/** Raised when a comparison cannot be resolved, validated or assembled. */
export class ComparisonError extends Error {
  readonly code: ComparisonErrorCode;

  constructor(code: ComparisonErrorCode, message: string) {
    super(message);
    this.name = 'ComparisonError';
    this.code = code;
  }
}
