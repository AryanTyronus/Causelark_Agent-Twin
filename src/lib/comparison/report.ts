// @polsia:user-owned — the comparison report, assembled from evidence.
//
// `reportComparison` is this engine's pure surface: a resolved experiment plus
// the benchmark report each agent produced, in, and a `ComparisonReport` out. It
// is a deterministic function of those things — same experiment, same evidence,
// same bytes out — with no clock, no randomness, no model call and no database
// read anywhere beneath it.
//
// It is strict about one thing in particular: every agent in the experiment must
// be accounted for exactly once, either with the report it produced or with the
// reason it produced none. An experiment that quietly dropped an agent would
// produce a comparison whose columns do not add up to the experiment it claims
// to be about.

import {
  BENCHMARK_ROBUSTNESS_FORMULA,
  type BenchmarkDefinition,
  type BenchmarkResult,
} from '@/lib/benchmarks/types';
import { agentConfigurationKey, agentIdentity, agentsKey } from './agents';
import { buildComparisonAgent } from './aggregate';
import {
  buildFailureProfiles,
  buildHeadToHead,
  compareMetrics,
  compareRobustness,
  compareScenarios,
  decideVerdict,
} from './compare';
import { VERDICT_DISCRIMINATORS } from './metrics';
import {
  type AgentConfiguration,
  type AgentUnavailableReason,
  COMPARISON_METHODOLOGY,
  COMPARISON_VERDICT_RULE,
  ComparisonError,
  type ComparisonReport,
  type ExperimentTemplate,
} from './types';

/**
 * The canonical identity of one experiment.
 *
 * It names everything that could change the result — the template at its
 * version, the benchmark at its version, the seeds the matrix will use, and
 * every agent configuration in canonical order — so two executions that share it
 * ran the same experiment, and two that differ anywhere in it did not. Nothing
 * here is read from ambient configuration: a report has to keep meaning what it
 * meant when it was produced.
 */
export function experimentKey(input: {
  template: ExperimentTemplate;
  definition: BenchmarkDefinition;
  agents: readonly AgentConfiguration[];
  seeds: readonly number[];
}): string {
  return [
    `${input.template.id}@${input.template.version}`,
    `${input.definition.id}@${input.definition.version}`,
    `seeds:${input.seeds.join(',')}`,
    agentsKey(input.agents),
  ].join('|');
}

export interface ComparisonReportInput {
  template: ExperimentTemplate;
  definition: BenchmarkDefinition;
  /** The agents, already in canonical order. */
  agents: readonly AgentConfiguration[];
  /** The seeds the matrix actually used. */
  seeds: readonly number[];
  /** The seeds the benchmark declared, before any override. */
  declaredSeeds: readonly number[];
  /** Each agent's benchmark report, keyed by canonical configuration key. */
  results: ReadonlyMap<string, BenchmarkResult>;
  /** Why an agent produced no report, keyed by canonical configuration key. */
  unavailable: ReadonlyMap<string, AgentUnavailableReason>;
  /** How many cases the experiment intended to run, across all agents. */
  plannedCaseCount: number;
}

/** Assemble the report. */
export function reportComparison(input: ComparisonReportInput): ComparisonReport {
  const keys = input.agents.map(agentConfigurationKey);

  for (const key of keys) {
    if (input.results.has(key) && input.unavailable.has(key))
      throw new ComparisonError(
        'INVALID_REPORT',
        `Agent ${key} was reported both as compared and as unavailable, so the report cannot say what happened to it.`,
      );
  }

  const agents = input.agents.map((agent, index) => {
    const key = keys[index] ?? agentConfigurationKey(agent);
    return buildComparisonAgent({
      agent,
      identity: agentIdentity(agent),
      key,
      report: input.results.get(key) ?? null,
      unavailableReason: input.unavailable.get(key) ?? {
        code: 'NOT_EXECUTED',
        message: 'This agent produced no report and no recorded reason.',
      },
    });
  });

  const executedCaseCount = agents.reduce(
    (total, agent) => total + (agent.report?.summary.executedCases ?? 0),
    0,
  );
  const caseCountPerAgent = input.plannedCaseCount / Math.max(1, input.agents.length);

  return {
    experiment: {
      id: input.template.id,
      version: input.template.version,
      name: input.template.name,
      description: input.template.description,
      benchmarkId: input.definition.id,
      benchmarkVersion: input.definition.version,
      benchmarkName: input.definition.name,
      environmentKey: input.definition.environmentKey,
      objectiveKey: input.definition.objectiveKey,
      scenarios: input.definition.scenarios,
      seeds: [...input.seeds],
      declaredSeeds: [...input.declaredSeeds],
      caseCountPerAgent,
      agentCount: agents.length,
      totalCaseCount: input.plannedCaseCount,
      key: experimentKey({
        template: input.template,
        definition: input.definition,
        agents: input.agents,
        seeds: input.seeds,
      }),
    },
    methodology: {
      comparison: COMPARISON_METHODOLOGY,
      verdictRule: COMPARISON_VERDICT_RULE,
      // Named from the benchmark engine's own constant rather than read off a
      // report, so the methodology states a property of the engine and not of
      // whatever evidence happened to survive.
      robustnessFormula: BENCHMARK_ROBUSTNESS_FORMULA,
      discriminators: [...VERDICT_DISCRIMINATORS],
    },
    agents,
    metrics: compareMetrics(agents),
    scenarios: compareScenarios(agents),
    robustness: compareRobustness(agents),
    failures: buildFailureProfiles(agents),
    headToHead: buildHeadToHead(agents),
    verdict: decideVerdict(agents),
    execution: {
      plannedCaseCount: input.plannedCaseCount,
      executedCaseCount,
      comparedAgentCount: agents.filter((agent) => agent.report !== null).length,
      unavailableAgentCount: agents.filter((agent) => agent.report === null).length,
    },
  };
}
