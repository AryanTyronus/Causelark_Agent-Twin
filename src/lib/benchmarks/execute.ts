// @polsia:user-owned — benchmark execution.
//
// This is the only file in `src/lib/benchmarks/` that touches a database, an
// environment variable or the agent runtime. Everything it composes is an
// existing seam, used exactly as the operator-facing routes use it:
//
//   catalogue  → the benchmark and every scenario it pins, resolved from the
//                server-side registry, never from the request
//   scenario   → `initializeScenarioRun`, which builds the perturbed world
//                before the run row exists
//   persistence→ the same run row, the same columns, the same
//                started → scenario applied → observed event sequence that
//                `POST /api/simulations/runs` writes
//   agent      → `runTurn`, the one bounded agent step, which claims its own
//                turn, validates every action through the environment's own
//                validator, and persists its own trace
//   evaluation → `evaluatePersistedRun`, the same mapping the evaluation
//                endpoint serves
//
// It creates no second simulation engine, manipulates no simulation state
// directly, fabricates no evaluation input, and never re-simulates a run to
// produce a benchmark number.
//
// Cases run sequentially and in matrix order. That is deliberate for this phase:
// reproducibility matters more than throughput, and a failure part-way through
// leaves a report that is honest about how far it got. Nothing in the design
// assumes sequential execution — each case owns its own run, its own seed and
// its own world — so a later phase can parallelise this loop without changing
// any contract above it.

import 'server-only';

import {
  AgentProviderError,
  agentProviderLabel,
  resolveAgentProvider,
  resolveBedrockConfiguration,
  resolveOpenRouterConfiguration,
} from '@/lib/agent/provider';
import { runTurn, TurnConflictError } from '@/lib/agent/run-turn';
import { DEFAULT_CONFIGURATION } from '@/lib/business/simulation';
import { evaluatePersistedRun } from '@/lib/business/simulation-evaluation';
import { jsonValue, loadRun } from '@/lib/business/simulation-persistence';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import {
  describeScenarioApplication,
  initializeScenarioRun,
  type ScenarioInitialization,
} from '@/lib/scenarios/scenario';
import { outcomeOf } from './aggregation';
import { reportBenchmark } from './benchmark';
import { getBenchmark, validateBenchmarkDefinition } from './catalog';
import { buildRunMatrix } from './matrix';
import {
  type BenchmarkAgentConfiguration,
  type BenchmarkCase,
  type BenchmarkDefinition,
  BenchmarkError,
  type BenchmarkResult,
  type BenchmarkRun,
} from './types';

/** A driver that could not complete a case says so without inventing a cause. */
const DRIVER_FAILURE_REASON = 'The benchmark driver could not complete this case.';

export interface BenchmarkExecutionInput {
  /** The signed-in owner every case run is created for. */
  ownerId: string;
  benchmarkId: string;
  /** Pin an exact version. Omitted, the newest shipped version is used. */
  benchmarkVersion?: number | null;
  /** Optional: the agent configuration that ran the benchmark. See below. */
  agent?: BenchmarkAgentConfiguration | null;
  /** Optional seed override, replacing the definition's declared seed set. */
  seeds?: readonly number[] | null;
}

/**
 * The agent configuration this deployment actually runs.
 *
 * The benchmark engine is provider-agnostic: it never imports a model client
 * and never branches on which provider is configured. It does, however, have to
 * be able to say *which* agent produced a set of runs — a benchmark result whose
 * agent is unlabelled is not reproducible. So the provider module is asked,
 * once, what it resolves, and the answer is recorded.
 */
export function resolveDeployedAgentConfiguration(): BenchmarkAgentConfiguration {
  try {
    const provider = resolveAgentProvider(env);
    const model =
      provider === 'openrouter'
        ? resolveOpenRouterConfiguration(env).modelId
        : resolveBedrockConfiguration(env).modelId;
    return { provider, model, label: agentProviderLabel(provider) };
  } catch (error) {
    if (error instanceof AgentProviderError)
      throw new BenchmarkError(
        'INVALID_AGENT_CONFIGURATION',
        `This deployment has no usable agent provider, so a benchmark cannot be attributed to one: ${error.message}`,
      );
    throw error;
  }
}

/**
 * Resolve the requested agent configuration, refusing a mismatch.
 *
 * A caller may name the agent it believes it is benchmarking. The benchmark runs
 * whichever agent this deployment resolves — there is no per-run provider
 * override anywhere in the runtime, and Phase 3 does not add one. So a request
 * that names a different configuration is a contradiction, not an instruction:
 * accepting it would produce a report labelled with an agent that did not run.
 */
export function requireAgentConfiguration(
  requested: BenchmarkAgentConfiguration | null | undefined,
): BenchmarkAgentConfiguration {
  const deployed = resolveDeployedAgentConfiguration();
  if (!requested) return deployed;
  if (requested.provider !== deployed.provider || requested.model !== deployed.model)
    throw new BenchmarkError(
      'AGENT_CONFIGURATION_MISMATCH',
      `This deployment runs ${deployed.provider} with model ${deployed.model}; the request asked for ${requested.provider} with model ${requested.model}. A benchmark can only be attributed to the agent that actually produced its runs.`,
    );
  return deployed;
}

/**
 * Run a benchmark and report on it.
 *
 * Every case is an independent run: its own row, its own world, its own seed,
 * its own scenario. Nothing mutable is carried between cases.
 */
export async function executeBenchmark(input: BenchmarkExecutionInput): Promise<BenchmarkResult> {
  const definition = getBenchmark(input.benchmarkId, input.benchmarkVersion ?? null);
  const agent = requireAgentConfiguration(input.agent);

  // A seed override produces a different experiment, so it is validated through
  // the same gate the shipped definitions pass — an unsupported or repeated seed
  // is refused before a single run is created.
  const effective =
    input.seeds && input.seeds.length > 0
      ? validateBenchmarkDefinition({ ...definition, seeds: [...input.seeds] })
      : definition;

  const matrix = buildRunMatrix(effective);
  const runs: BenchmarkRun[] = [];
  for (const cell of matrix) {
    runs.push(await executeCase({ ownerId: input.ownerId, definition: effective, cell }));
  }

  return reportBenchmark(effective, runs, agent, { declaredSeeds: definition.seeds });
}

/**
 * Create a run for one matrix cell.
 *
 * The row this writes is the same row `POST /api/simulations/runs` writes —
 * same scenario seam, same columns, same event sequence — with the benchmark's
 * own identity added to the start event payload so a run can be traced back to
 * the experiment that produced it. It is written here rather than through a
 * shared helper because extracting one would mean editing the two existing
 * routes; the trace shape is pinned by a test that compares it against the
 * operator path instead.
 */
async function createCaseRun(input: {
  ownerId: string;
  definition: BenchmarkDefinition;
  cell: BenchmarkCase;
  initialization: ScenarioInitialization;
}): Promise<string> {
  const { cell, definition, initialization, ownerId } = input;
  const state = initialization.state;
  const scenarioEvent = describeScenarioApplication(initialization);
  const created = await prisma.$transaction(async (tx) => {
    const run = await tx.simulationRun.create({
      data: {
        ownerId,
        environmentKey: definition.environmentKey,
        objectiveKey: definition.objectiveKey,
        seed: cell.seed,
        scenarioId: initialization.scenario?.id ?? null,
        scenarioVersion: initialization.scenario?.version ?? null,
        status: 'RUNNING',
        agentStatus: 'READY',
        step: 0,
        state: jsonValue(state),
        initialState: jsonValue(state),
        configuration: jsonValue(initialization.configuration),
        tasks: jsonValue(state.tasks),
        constraints: jsonValue(state.constraints),
        budgetLimit: initialization.configuration.budget,
        maxTurns: initialization.configuration.maxTurns,
      },
    });
    await tx.simulationEvent.createMany({
      data: [
        {
          runId: run.id,
          sequence: 0,
          step: 0,
          kind: 'simulation.started',
          source: 'system',
          summary: 'Benchmark case started.',
          payload: jsonValue({
            environmentKey: run.environmentKey,
            objectiveKey: run.objectiveKey,
            seed: run.seed,
            benchmarkId: definition.id,
            benchmarkVersion: definition.version,
            caseKey: cell.key,
          }),
        },
        ...(scenarioEvent
          ? [
              {
                runId: run.id,
                sequence: 1,
                step: 0,
                kind: 'scenario.applied',
                source: 'system',
                summary: scenarioEvent.summary,
                payload: jsonValue(scenarioEvent.payload),
              },
            ]
          : []),
        {
          runId: run.id,
          sequence: scenarioEvent ? 2 : 1,
          step: 0,
          kind: 'observation.created',
          source: 'system',
          summary: 'Initial observable state recorded.',
          payload: jsonValue({ state }),
        },
      ],
    });
    return run;
  });
  return created.id;
}

/**
 * Drive one case to a terminal status using the existing bounded turn loop.
 *
 * `runTurn` is the authority on termination: it applies the environment's own
 * status rules and the run's own persisted turn budget, so this loop only has to
 * keep asking until the run stops saying RUNNING. It never sets a status itself
 * and never inspects simulation state — a turn is the only thing that may move a
 * run, and it is the same turn the operator path uses.
 *
 * A turn that faults does not throw: the runtime records the fault and returns.
 * A genuine driver error is caught so one broken case cannot abort the cases
 * after it; the run's persisted status is then the honest answer, and a run left
 * RUNNING is reported as still in progress rather than as a failure it did not
 * record.
 */
async function driveToTerminal(
  runId: string,
  ownerId: string,
  maxTurns: number,
): Promise<string | null> {
  let driverFailure: string | null = null;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const current = await loadRun(runId, ownerId);
    if (!current || current.status !== 'RUNNING') break;
    try {
      await runTurn(runId, ownerId);
    } catch (error) {
      if (!(error instanceof TurnConflictError)) {
        driverFailure = DRIVER_FAILURE_REASON;
        break;
      }
      // Another turn holds the claim, or the run went terminal between the read
      // and the claim. Re-read before deciding: only a run that is still
      // RUNNING *and* unclaimed is a genuine conflict worth surfacing.
      const after = await loadRun(runId, ownerId);
      if (!after || after.status !== 'RUNNING') break;
      if (after.turnInProgress) {
        driverFailure = DRIVER_FAILURE_REASON;
        break;
      }
    }
  }
  return driverFailure;
}

/** Execute one matrix cell and evaluate whatever it produced. */
async function executeCase(input: {
  ownerId: string;
  definition: BenchmarkDefinition;
  cell: BenchmarkCase;
}): Promise<BenchmarkRun> {
  const { cell, definition, ownerId } = input;
  const configuration = { ...DEFAULT_CONFIGURATION, ...definition.configuration };
  const initialization = initializeScenarioRun({
    environmentKey: definition.environmentKey,
    objectiveKey: definition.objectiveKey,
    seed: cell.seed,
    configuration,
    scenarioId: cell.scenarioId,
    scenarioVersion: cell.scenarioVersion,
  });

  // The catalogue resolved the scenario at the exact version the matrix pinned.
  // If it did not, the experiment being run is not the experiment being
  // reported, so this is an engine fault rather than an environmental one.
  const resolved = initialization.scenario;
  if (!resolved || resolved.id !== cell.scenarioId || resolved.version !== cell.scenarioVersion)
    throw new BenchmarkError(
      'INVALID_SCENARIO',
      `Case ${cell.key} resolved to ${resolved ? `${resolved.id}@${resolved.version}` : 'no scenario'}.`,
    );

  const runId = await createCaseRun({ ownerId, definition, cell, initialization });
  const driverFailure = await driveToTerminal(
    runId,
    ownerId,
    initialization.configuration.maxTurns,
  );

  const persisted = await loadRun(runId, ownerId);
  if (!persisted)
    return {
      case: cell,
      runId,
      status: 'UNAVAILABLE',
      outcome: outcomeOf('UNAVAILABLE'),
      terminationReason: driverFailure,
      evaluation: null,
    };

  const status = persisted.status as BenchmarkRun['status'];
  return {
    case: cell,
    runId,
    status,
    outcome: outcomeOf(status),
    terminationReason: persisted.terminationReason ?? driverFailure,
    evaluation: evaluatePersistedRun(persisted),
  };
}
