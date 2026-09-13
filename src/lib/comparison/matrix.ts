//
// The matrix is the cross product of the canonical agent list and the benchmark
// engine's own run matrix, in that nesting order: every agent runs every case of
// the benchmark. The nested half is not rebuilt here — `buildRunMatrix` supplies
// it, so a comparison case and a benchmark case describe the same conditions by
// construction rather than by two implementations agreeing.
//
// Nothing here iterates an object, sorts by a comparator other than the declared
// canonical one, or depends on the order the agents arrived in. Two calls with
// the same benchmark and the same *set* of agents produce the same array —
// element for element, including the index and the key of every cell — however
// that set was ordered by the caller.

import { benchmarkCaseKey, buildRunMatrix } from '@/lib/benchmarks/matrix';
import type { BenchmarkDefinition } from '@/lib/benchmarks/types';
import { agentConfigurationKey, compareAgentKeys, orderAgents } from './agents';
import {
  type AgentConfiguration,
  type ComparisonCase,
  ComparisonError,
  MAX_COMPARISON_CASES,
} from './types';

/** The separator between the agent half of a case key and the benchmark half. */
const CASE_SEPARATOR = '|';

/**
 * The stable identity of an experiment matrix cell.
 *
 * `agentConfigurationKey | scenarioId@scenarioVersion#seed`. The benchmark half
 * is the benchmark engine's own `benchmarkCaseKey`, unchanged, so a cell names
 * the same experiment the benchmark would have run — and the agent half is the
 * full configuration key, so the cell distinguishes two configurations of one
 * agent rather than collapsing them.
 *
 * Generated run ids are references, not identity: they differ between two
 * executions of the same experiment, and nothing downstream may depend on them.
 */
export function comparisonCaseKey(
  agentKey: string,
  scenarioId: string,
  scenarioVersion: number,
  seed: number,
): string {
  return `${agentKey}${CASE_SEPARATOR}${benchmarkCaseKey(scenarioId, scenarioVersion, seed)}`;
}

/**
 * How many agents this benchmark can be compared across.
 *
 * Derived from the benchmark's own size against the engine's ceiling, so the
 * bound is the existing one rather than a second, weaker limit: a two-scenario
 * benchmark at one seed can compare fourteen agents, and the shipped
 * seven-scenario benchmark at one seed can compare four.
 */
export function maximumAgentsFor(definition: BenchmarkDefinition): number {
  const casesPerAgent = buildRunMatrix(definition).length;
  return Math.floor(MAX_COMPARISON_CASES / casesPerAgent);
}

/**
 * Expand an experiment into its ordered cases.
 *
 * Throws rather than returning a partial matrix: an experiment whose size is
 * wrong is a request error, and a half-built matrix would silently turn into a
 * comparison that measured less than it claims to.
 *
 * The agents are put into canonical order first, so the matrix depends on the
 * *set* of agents and not on the order they were listed in.
 */
export function buildComparisonMatrix(
  definition: BenchmarkDefinition,
  agents: readonly AgentConfiguration[],
): ComparisonCase[] {
  const ordered = [...agents].sort((left, right) =>
    compareAgentKeys(agentConfigurationKey(left), agentConfigurationKey(right)),
  );
  const cases: ComparisonCase[] = [];
  for (const agent of ordered) {
    const agentKey = agentConfigurationKey(agent);
    for (const entry of buildRunMatrix(definition)) {
      cases.push({
        index: cases.length,
        key: comparisonCaseKey(agentKey, entry.scenarioId, entry.scenarioVersion, entry.seed),
        agent: agentKey,
        agentId: agent.agentId,
        agentVersion: agent.agentVersion,
        scenarioId: entry.scenarioId,
        scenarioVersion: entry.scenarioVersion,
        seed: entry.seed,
        isBaseline: entry.isBaseline,
      });
    }
  }
  return cases;
}

/**
 * Validate an experiment's size and return its agents in canonical order.
 *
 * The agent count is checked against the *benchmark's* capacity rather than a
 * constant, so the message names the real constraint: this benchmark, at these
 * seeds, can be compared across at most this many agents.
 */
export function resolveExperimentAgents(
  definition: BenchmarkDefinition,
  agents: readonly AgentConfiguration[],
): AgentConfiguration[] {
  const ordered = orderAgents(agents);
  const cases = buildRunMatrix(definition).length;
  const maximum = Math.floor(MAX_COMPARISON_CASES / cases);
  if (ordered.length > maximum)
    throw new ComparisonError(
      'MATRIX_TOO_LARGE',
      `Comparing ${ordered.length} agents over ${definition.id} v${definition.version} would run ${ordered.length * cases} cases, above the ${MAX_COMPARISON_CASES} this engine will drive in one experiment. That benchmark's matrix is ${cases} cases, so it can be compared across at most ${maximum} agents at these seeds.`,
    );
  return ordered;
}
