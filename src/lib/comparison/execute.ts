// @polsia:user-owned — comparison execution.
//
// This is the only file in `src/lib/comparison/` that touches a database, an
// environment variable or the agent runtime. Everything it composes is an
// existing seam, used exactly as the operator-facing routes use it:
//
//   catalogue  → the experiment and the benchmark it pins, resolved from the
//                server-side registry, never from the request
//   matrix     → `buildComparisonMatrix`, which nests the benchmark engine's own
//                run matrix under each agent's canonical key
//   execution  → `executeBenchmark`, the Phase 3 execution path, once per agent,
//                with the agent named as a *selection*. That is the whole of the
//                controlled-conditions claim: the same definition, the same
//                scenarios, the same seeds, the same world, the same validator,
//                the same tools, the same objective — and one thing different
//   evaluation → inside `executeBenchmark`, through the existing evaluation
//                engine, unchanged
//   reporting  → `reportBenchmark` per agent, then the pure comparison modules
//
// It creates no second simulation engine, drives no turn itself, manipulates no
// simulation state directly, fabricates no evaluation input, and re-simulates
// nothing. A comparison's numbers are the benchmark engine's numbers, arranged.
//
// A failure belongs to the agent that produced it. Provider resolution happens
// inside the per-agent loop rather than before it for exactly that reason, so an
// agent this deployment cannot run is reported as unavailable and the remaining
// agents still produce evidence. The request is still validated before any run
// exists — unknown experiment, malformed configuration, duplicate agent,
// oversized matrix — so a bad request cannot leave a half-run experiment behind.
//
// Agents run sequentially and in canonical order. Reproducibility matters more
// than throughput here, and a failure part-way through leaves a report that is
// honest about which agents it got to. Nothing in the design assumes sequential
// execution — each agent owns its own runs, and each case its own world — so a
// later phase can parallelise this loop without changing any contract above it.

import 'server-only';

import { resolveAgentSelection } from '@/lib/agent/provider';
import { validateBenchmarkDefinition } from '@/lib/benchmarks/catalog';
import { executeBenchmark } from '@/lib/benchmarks/execute';
import { BenchmarkError, type BenchmarkResult } from '@/lib/benchmarks/types';
import { agentConfigurationKey, agentIdentity } from './agents';
import { getExperiment } from './catalog';
import { buildComparisonMatrix, resolveExperimentAgents } from './matrix';
import { reportComparison } from './report';
import {
  type AgentConfiguration,
  type AgentUnavailableReason,
  ComparisonError,
  type ComparisonReport,
} from './types';

export interface ComparisonExecutionInput {
  /** The signed-in owner every case run is created for. */
  ownerId: string;
  /** The experiment template to run, by id. */
  comparisonId: string;
  /** Pin an exact template version. Omitted, the newest shipped version is used. */
  comparisonVersion?: number | null;
  /** The agents to compare. At least two, each named once. */
  agents: readonly AgentConfiguration[];
  /** Optional seed override, replacing the benchmark's declared seed set. */
  seeds?: readonly number[] | null;
}

/**
 * The agent selection an agent configuration describes.
 *
 * Narrowed through the provider boundary rather than read field by field, so an
 * experiment naming a provider this build cannot construct a client for is
 * refused here, before any run exists, with the provider module's own message.
 * The provider column of an agent configuration is deliberately free-form — this
 * layer stays provider-agnostic — and this is the one place it is resolved into
 * something a model client can actually be built from.
 */
function selectionFor(agent: AgentConfiguration) {
  try {
    return resolveAgentSelection({ provider: agent.provider, model: agent.model });
  } catch (error) {
    throw new ComparisonError(
      'INVALID_AGENT_CONFIGURATION',
      `Agent ${agentIdentity(agent)} names a provider this deployment cannot run: ${error instanceof Error ? error.message : 'unusable provider'}`,
    );
  }
}

/**
 * The code an agent's failure is recorded under.
 *
 * The code the failing layer raised is kept rather than flattened to one
 * generic value, so a reader can tell an agent this deployment cannot run from
 * a benchmark the engine refused from an execution that faulted outright.
 */
function failureCode(error: unknown): string {
  if (error instanceof BenchmarkError || error instanceof ComparisonError) return error.code;
  return 'EXECUTION_FAILED';
}

/**
 * Run a comparison and report on it.
 *
 * Each agent is executed by the benchmark engine in its own right, over the same
 * definition. One agent failing does not invalidate the experiment: the failure
 * is recorded against that agent, with the reason the runtimes actually gave,
 * and the remaining agents are still executed and still compared. The report
 * then says how many agents were comparable, and the verdict declines to name a
 * winner it cannot support.
 *
 * That includes an agent this deployment cannot run at all. Its provider is
 * resolved inside the loop rather than before it, so a fleet in which one member
 * names an unusable provider produces a report naming the agents that did run —
 * not a refused request that discards the evidence the others would have
 * produced. The request itself is still validated first: an unknown experiment,
 * a malformed configuration, a duplicate agent or an oversized matrix fails
 * before a single run exists, so a bad request cannot leave a partial experiment
 * in the database.
 */
export async function executeComparison(
  input: ComparisonExecutionInput,
): Promise<ComparisonReport> {
  const { template, definition } = getExperiment(
    input.comparisonId,
    input.comparisonVersion ?? null,
  );

  // A seed override produces a different experiment, so it passes through the
  // same gate the shipped benchmark passed — an unsupported or repeated seed is
  // refused here rather than becoming a per-agent failure later, which would
  // report a bad request as a set of unrunnable agents.
  const effectiveDefinition =
    input.seeds && input.seeds.length > 0
      ? validateBenchmarkDefinition({ ...definition, seeds: [...input.seeds] })
      : definition;

  const agents = resolveExperimentAgents(effectiveDefinition, input.agents);
  const matrix = buildComparisonMatrix(effectiveDefinition, agents);

  const results = new Map<string, BenchmarkResult>();
  const unavailable = new Map<string, AgentUnavailableReason>();

  for (const agent of agents) {
    const key = agentConfigurationKey(agent);
    try {
      results.set(
        key,
        await executeBenchmark({
          ownerId: input.ownerId,
          benchmarkId: definition.id,
          benchmarkVersion: definition.version,
          selection: selectionFor(agent),
          attribution: { agentId: agent.agentId, agentVersion: agent.agentVersion },
          seeds: effectiveDefinition.seeds,
        }),
      );
    } catch (error) {
      // One agent's failure is that agent's failure. It is recorded with the
      // code the failing layer raised, so a reader can tell an unrunnable
      // provider from a benchmark the engine refused, and the experiment carries
      // on with the agents that did run.
      unavailable.set(key, {
        code: failureCode(error),
        message:
          error instanceof Error
            ? error.message.slice(0, 400)
            : 'This agent produced no report and no reason was recorded.',
      });
    }
  }

  return reportComparison({
    template,
    definition,
    agents,
    seeds: effectiveDefinition.seeds,
    declaredSeeds: definition.seeds,
    results,
    unavailable,
    plannedCaseCount: matrix.length,
  });
}
