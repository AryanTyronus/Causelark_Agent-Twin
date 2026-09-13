// @polsia:user-owned — deterministic comparison test fixtures.
//
// Real per-agent reports here would mean running real simulations, which would
// make a comparison test a test of the simulation engine rather than of the
// comparison. So the scores are chosen by hand — but the reports are not: each
// one is assembled by the *real* `reportBenchmark` from real `BenchmarkRun`
// fixtures, so what the comparison consumes is exactly what the benchmark engine
// produces, and a fixture cannot claim a report shape the engine would not emit.
//
// Nothing reads a clock or a random source, so a fixture built twice is the same
// fixture.

import { reportBenchmark } from '@/lib/benchmarks/benchmark';
import { getBenchmark } from '@/lib/benchmarks/catalog';
import { ROBUSTNESS_SCENARIO_IDS } from '@/lib/benchmarks/definitions';
import type { BenchmarkResult } from '@/lib/benchmarks/types';
import { agentConfigurationKey, agentIdentity, orderAgents } from '@/lib/comparison/agents';
import { buildComparisonAgent } from '@/lib/comparison/aggregate';
import { getExperiment } from '@/lib/comparison/catalog';
import { reportComparison } from '@/lib/comparison/report';
import type { AgentConfiguration, ComparisonAgent, ComparisonReport } from '@/lib/comparison/types';
import type { EvaluationCategory, EvaluationMetrics } from '@/lib/evaluation/types';
import type { BenchmarkCaseStatus } from './benchmark.fixtures';
import { runFixture } from './benchmark.fixtures';

export const EXPERIMENT_ID = 'resource-routing-agent-comparison';
export const BENCHMARK_ID = 'resource-routing-robustness';
export const BASELINE_SCENARIO = 'baseline';

/** The benchmark's own scenario list, in matrix order. */
export const SCENARIO_IDS: readonly string[] = ROBUSTNESS_SCENARIO_IDS;

/** An agent configuration, with only the fields a test cares about supplied. */
export function agentFixture(
  input: Partial<AgentConfiguration> & { agentId: string },
): AgentConfiguration {
  return {
    agentVersion: '1',
    provider: 'bedrock',
    model: 'fixture-model-a',
    ...input,
  };
}

/**
 * One agent's scores, per scenario.
 *
 * `spread` is the score every scenario not named takes, so a test states only
 * the differences it is exercising.
 */
export interface AgentScores {
  spread: number;
  byScenario?: Record<string, number>;
  /** Per-case metric overrides, applied to every case this agent ran. */
  metrics?: Partial<EvaluationMetrics>;
  /**
   * Per-case category scores, applied to every case this agent ran. A category
   * not named takes the evaluation fixture's default, so a test that varies one
   * dimension leaves the others where they were.
   */
  categories?: Partial<Record<EvaluationCategory, number>>;
  /**
   * The status every case of this agent ends in. Defaults to `COMPLETED`, so a
   * test that says nothing about status gets a fully evaluated agent.
   */
  status?: BenchmarkCaseStatus;
  /** Per-scenario statuses, overriding `status` for the scenarios named. */
  statusByScenario?: Record<string, BenchmarkCaseStatus>;
}

/**
 * A real benchmark report for one agent, from hand-chosen scores.
 *
 * The runs are built in the benchmark's declared matrix order, which is what
 * `reportBenchmark` requires, and the definition is resolved from the shipped
 * catalogue, so the report passes every reference check the engine makes.
 */
export function benchmarkResultFor(
  agent: AgentConfiguration,
  scores: AgentScores,
): BenchmarkResult {
  const definition = getBenchmark(BENCHMARK_ID);
  const runs = SCENARIO_IDS.map((scenarioId, index) =>
    runFixture({
      index,
      scenarioId,
      overall: scores.byScenario?.[scenarioId] ?? scores.spread,
      scores: scores.categories,
      runId: `${agent.agentId}-${scenarioId}`,
      status: scores.statusByScenario?.[scenarioId] ?? scores.status,
      metrics: scores.metrics,
    }),
  );
  return reportBenchmark(definition, runs, {
    provider: agent.provider,
    model: agent.model,
  });
}

/**
 * A comparison report for a set of agents, assembled by the real engine.
 *
 * `reports` maps an agent to the scores it should have produced; an agent absent
 * from it is one that produced no report at all, which is how a failed or
 * unrunnable agent is modelled here. An agent may be named either by its agent id
 * or by its `agentId@agentVersion` identity, and the identity is consulted when
 * the id is absent — which is what lets a test compare two models of the *same*
 * provider: those two configurations share an agent id, and only their identity
 * tells them apart.
 */
export function comparisonFixture(input: {
  agents: readonly AgentConfiguration[];
  reports: ReadonlyMap<string, AgentScores>;
  seeds?: readonly number[];
}): ComparisonReport {
  const { template, definition } = getExperiment(EXPERIMENT_ID);
  const seeds = input.seeds ?? definition.seeds;
  // Canonicalised the way `executeComparison` canonicalises them, so a test that
  // reorders its agents is exercising the real path rather than a shortcut.
  const agents = orderAgents(input.agents);
  const results = new Map<string, BenchmarkResult>();
  const unavailable = new Map<string, { code: string; message: string }>();
  for (const agent of agents) {
    const key = agentConfigurationKey(agent);
    const scores = input.reports.get(agent.agentId) ?? input.reports.get(agentIdentity(agent));
    if (scores) results.set(key, benchmarkResultFor(agent, scores));
    else
      unavailable.set(key, {
        code: 'EXECUTION_FAILED',
        message: `Fixture: ${agent.agentId} produced no report.`,
      });
  }
  return reportComparison({
    template,
    definition,
    agents,
    seeds,
    declaredSeeds: definition.seeds,
    results,
    unavailable,
    plannedCaseCount: agents.length * SCENARIO_IDS.length,
  });
}

/** One agent's side of a comparison, built directly, for aggregate tests. */
export function comparisonAgentFor(
  agent: AgentConfiguration,
  scores: AgentScores | null,
): ComparisonAgent {
  const key = agentConfigurationKey(agent);
  return buildComparisonAgent({
    agent,
    identity: agentIdentity(agent),
    key,
    report: scores ? benchmarkResultFor(agent, scores) : null,
    unavailableReason: scores ? null : { code: 'EXECUTION_FAILED', message: 'Fixture failure.' },
  });
}

/** A uniform score set: every scenario the same, so robustness is exactly 1. */
export function uniform(spread: number): AgentScores {
  return { spread };
}
