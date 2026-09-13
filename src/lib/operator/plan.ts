// @polsia:user-owned — the test plan, and the digest a person authorises.
//
// The Operator plans before it executes. The plan is not a message the model
// writes — it is a record the server builds, every field of which is copied from
// the benchmark registry or the agent catalogue. A model that names a benchmark
// that does not exist, or an agent this deployment cannot run, gets a refusal
// rather than a plan, so a benchmark definition can never arrive from a model.
//
// The fingerprint is what makes the authorisation real. A preview hands a person
// a plan and its digest; an execution request carries the digest back; the tool
// that would run the benchmark recomputes the digest from the plan the operator
// actually committed to and refuses the run when the two disagree. So the
// authorisation covers *this* execution — this benchmark, this version, this
// agent, these conditions, these seeds — rather than a category of execution
// that a later decision could widen.

import 'server-only';

import { createHash } from 'node:crypto';
import { getBenchmark } from '@/lib/benchmarks/catalog';
import {
  BENCHMARK_BASELINE_SCENARIO_ID,
  BenchmarkError,
  MAX_BENCHMARK_CASES,
  MAX_BENCHMARK_SEEDS,
} from '@/lib/benchmarks/types';
import { deploymentAgentCatalog } from '@/lib/business/agent-catalog';
import { operatorBounds } from './config';
import type { OperatorTestPlan } from './types';

/**
 * Raised when a plan cannot be built from what the operator asked for.
 *
 * Distinct from `OperatorError`: this is the operator asking for something the
 * catalogue does not have, which is a normal thing for an agent to do while it
 * is working something out. It is refused, recorded, and handed back to the
 * model as text, and the run continues.
 */
export class OperatorPlanRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorPlanRefusal';
  }
}

/** The fields the digest covers. A change to any of them is a different plan. */
export interface PlanFingerprintInput {
  benchmarkId: string;
  benchmarkVersion: number;
  agentKey: string;
  seeds: readonly number[];
  scenarios: readonly { id: string; version: number }[];
}

/**
 * The stable digest of a plan.
 *
 * Canonical by construction: a fixed field order, the registry's own scenario
 * order and seed order, and a version tag so a future change to what a plan
 * contains produces different digests rather than colliding ones. Truncated to
 * 32 hex characters — this guards against a plan drifting between the preview a
 * person approved and the execution that follows, not against a forgery, and the
 * comparison is done server-side against a server-built plan either way.
 */
export function planFingerprint(input: PlanFingerprintInput): string {
  const canonical = JSON.stringify([
    'operator-plan-v1',
    input.benchmarkId,
    input.benchmarkVersion,
    input.agentKey,
    input.seeds,
    input.scenarios.map((scenario) => `${scenario.id}@${scenario.version}`),
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export interface BuildOperatorPlanInput {
  objective: string;
  benchmarkId: string;
  benchmarkVersion?: number | null;
  agentKey: string;
  /** Optional override. Must be a subset of the seeds the definition declares. */
  seeds?: readonly number[] | null;
}

/**
 * Build the plan the operator will execute.
 *
 * Every refusal message names what the registry or the catalogue actually holds,
 * so the operator can correct itself in the next turn instead of guessing. That
 * is the difference between a bounded agent and a stuck one.
 */
export function buildOperatorPlan(input: BuildOperatorPlanInput): OperatorTestPlan {
  let definition: ReturnType<typeof getBenchmark>;
  try {
    definition = getBenchmark(input.benchmarkId, input.benchmarkVersion ?? null);
  } catch (error) {
    if (error instanceof BenchmarkError) throw new OperatorPlanRefusal(error.message);
    throw error;
  }

  const catalogue = deploymentAgentCatalog();
  const agent = catalogue.agents.find((candidate) => candidate.key === input.agentKey);
  if (!agent) {
    const available =
      catalogue.agents.length > 0
        ? catalogue.agents.map((candidate) => candidate.key).join(', ')
        : 'none — this deployment has no configured agent';
    throw new OperatorPlanRefusal(
      `No agent in this deployment's catalogue has the key "${input.agentKey}". Available keys: ${available}.`,
    );
  }

  const seeds = input.seeds && input.seeds.length > 0 ? [...input.seeds] : [...definition.seeds];
  if (seeds.length > MAX_BENCHMARK_SEEDS)
    throw new OperatorPlanRefusal(
      `The benchmark engine allows at most ${MAX_BENCHMARK_SEEDS} seeds; ${seeds.length} were requested.`,
    );
  const unknown = seeds.filter((seed) => !definition.seeds.includes(seed));
  if (unknown.length > 0)
    throw new OperatorPlanRefusal(
      `Seed(s) ${unknown.join(', ')} are not in this benchmark's declared seed set (${definition.seeds.join(', ')}). A seed the definition does not declare would produce a different experiment, not this one.`,
    );

  const scenarios = definition.scenarios.map((scenario) => ({
    id: scenario.id,
    version: scenario.version,
    isBaseline: scenario.id === BENCHMARK_BASELINE_SCENARIO_ID,
  }));

  const caseCount = scenarios.length * seeds.length;
  if (caseCount > MAX_BENCHMARK_CASES)
    throw new OperatorPlanRefusal(
      `This plan would build ${caseCount} cases; the benchmark engine allows at most ${MAX_BENCHMARK_CASES}.`,
    );

  return {
    objective: input.objective,
    benchmark: {
      id: definition.id,
      version: definition.version,
      name: definition.name,
      environmentKey: definition.environmentKey,
      objectiveKey: definition.objectiveKey,
    },
    agent: {
      key: agent.key,
      identity: agent.identity,
      provider: agent.configuration.provider,
      model: agent.configuration.model,
      providerLabel: agent.providerLabel,
      isDeploymentDefault: agent.isDeploymentDefault,
    },
    scenarios,
    seeds,
    caseCount,
    // One simulation per case, each driving a real agent turn loop. Stated on the
    // plan because it is the number a person is being asked to authorise.
    providerDrivenSimulations: caseCount,
    bounds: operatorBounds(),
    fingerprint: planFingerprint({
      benchmarkId: definition.id,
      benchmarkVersion: definition.version,
      agentKey: agent.key,
      seeds,
      scenarios,
    }),
  };
}
