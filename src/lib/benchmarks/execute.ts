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
//                validator, and persists its own trace. An execution may name
//                the agent that runs each turn; with none named, the
//                deployment's own agent runs
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
  type AgentSelection,
  agentProviderLabel,
  resolveDeployedSelection,
} from '@/lib/agent/provider';
import { runTurn, TurnConflictError } from '@/lib/agent/run-turn';
import { evaluatePersistedRun } from '@/lib/business/simulation-evaluation';
import { jsonValue, loadRun } from '@/lib/business/simulation-persistence';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { defaultConfigurationFor } from '@/lib/environments/registry';
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
  type BenchmarkAgentAttribution,
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
  /**
   * The agent that runs every case. Omitted, the deployment's own agent runs.
   *
   * This is what makes a benchmark comparable: the same definition, the same
   * scenarios, the same seeds and the same world, run against more than one
   * agent in one process. The selection reaches exactly one place — the turn —
   * so the environment, the tools, the objective, the validator and the
   * persisted trace are identical whichever agent is named here.
   */
  selection?: AgentSelection | null;
  /**
   * Who the created runs are attributed to. Omitted, they carry no agent
   * identity — the deployment's own runs are identified by the configuration
   * the report already records.
   */
  attribution?: BenchmarkAgentAttribution | null;
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
    return configurationForSelection(resolveDeployedSelection(env));
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
 * The configuration an explicit agent selection describes.
 *
 * A selection is a provider this build can construct a client for plus the model
 * that client should ask for, so the label is a readable form of the same fact:
 * a report says the runs came from `openrouter` running that model, and the
 * provider module remains the only place either name is decided.
 */
export function configurationForSelection(selection: AgentSelection): BenchmarkAgentConfiguration {
  return {
    provider: selection.provider,
    model: selection.modelId,
    label: agentProviderLabel(selection.provider),
  };
}

/**
 * Resolve the requested agent configuration against the deployed one, refusing
 * a mismatch.
 *
 * This is the operator-facing request path: `POST /api/benchmarks/[id]/run` may
 * name the agent it believes it is benchmarking, and the benchmark runs whichever
 * agent this deployment resolves. A request that names a different configuration
 * is a contradiction, not an instruction: accepting it would produce a report
 * labelled with an agent that did not run.
 *
 * The comparison engine is the one caller that runs an agent this deployment is
 * not configured for. It does so by naming a *selection*, which is resolved by
 * {@link resolveExecutionAgent} instead — the deployment's own configuration
 * never enters into it, so this function's rule is not weakened, only scoped to
 * the requests it governs.
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
 * The agent configuration an execution will run, and be attributed to.
 *
 * An execution either names the agent that runs — a selection, which is what
 * lets one process run the same benchmark against several agents — or leaves it
 * to the deployment, in which case the request-path rule applies unchanged. The
 * contradiction check survives both routes for the same reason: a report may not
 * be labelled with an agent that did not produce its runs.
 */
function resolveExecutionAgent(input: BenchmarkExecutionInput): BenchmarkAgentConfiguration {
  if (!input.selection) return requireAgentConfiguration(input.agent);
  const selected = configurationForSelection(input.selection);
  if (
    input.agent &&
    (input.agent.provider !== selected.provider || input.agent.model !== selected.model)
  )
    throw new BenchmarkError(
      'AGENT_CONFIGURATION_MISMATCH',
      `This execution was asked to run ${selected.provider} with model ${selected.model}; the request named ${input.agent.provider} with model ${input.agent.model}. A benchmark can only be attributed to the agent that actually produced its runs.`,
    );
  return selected;
}

/**
 * Run a benchmark and report on it.
 *
 * Every case is an independent run: its own row, its own world, its own seed,
 * its own scenario. Nothing mutable is carried between cases.
 */
export async function executeBenchmark(input: BenchmarkExecutionInput): Promise<BenchmarkResult> {
  const definition = getBenchmark(input.benchmarkId, input.benchmarkVersion ?? null);
  const agent = resolveExecutionAgent(input);

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
    runs.push(
      await executeCase({
        ownerId: input.ownerId,
        definition: effective,
        cell,
        selection: input.selection ?? null,
        attribution: input.attribution ?? null,
      }),
    );
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
  attribution: BenchmarkAgentAttribution | null;
}): Promise<string> {
  const { cell, definition, initialization, ownerId, attribution } = input;
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
            // Which agent produced this run. `null` for a run nobody attributed,
            // which is not the same claim as any particular agent.
            agentId: attribution?.agentId ?? null,
            agentVersion: attribution?.agentVersion ?? null,
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
  selection: AgentSelection | null,
): Promise<string | null> {
  let driverFailure: string | null = null;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const current = await loadRun(runId, ownerId);
    if (!current || current.status !== 'RUNNING') break;
    try {
      await runTurn(runId, ownerId, { selection });
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
  selection: AgentSelection | null;
  attribution: BenchmarkAgentAttribution | null;
}): Promise<BenchmarkRun> {
  const { cell, definition, ownerId, selection, attribution } = input;
  // Merged over the WORLD's own defaults, resolved from the environment the
  // definition names — the definition's overrides are a delta on its own world,
  // not on whichever world happened to be the first one shipped.
  const configuration = {
    ...defaultConfigurationFor(definition.environmentKey),
    ...definition.configuration,
  };
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

  const runId = await createCaseRun({ ownerId, definition, cell, initialization, attribution });
  const driverFailure = await driveToTerminal(
    runId,
    ownerId,
    initialization.configuration.maxTurns,
    selection,
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
