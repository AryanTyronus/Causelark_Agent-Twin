// @vitest-environment node
// the runs it creates.
//
// The execution test proves the engine; this proves the wiring. A benchmark is
// requested over HTTP, resolved from the server-side catalogue, executed through
// the real simulation path against an in-memory store, and the runs it creates
// are then read back through the pre-existing evaluation, replay and rerun
// endpoints — which must not be able to tell a benchmark-created run from an
// operator-created one.
//
// No credentials, no database, no network.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RunRow {
  id: string;
  ownerId: string;
  environmentKey: string;
  objectiveKey: string;
  seed: number;
  scenarioId: string | null;
  scenarioVersion: number | null;
  status: string;
  agentStatus: string;
  step: number;
  state: unknown;
  initialState: unknown;
  configuration: unknown;
  tasks: unknown;
  constraints: unknown;
  budgetLimit: number;
  budgetUsed: number;
  maxTurns: number;
  turnInProgress: boolean;
  turnCount: number;
  terminationReason: string | null;
  failureDetails: string | null;
  terminalAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface EventRow {
  id: string;
  runId: string;
  sequence: number;
  step: number;
  kind: string;
  source: string;
  summary: string;
  payload: unknown;
  createdAt: Date;
}

interface ActionRow {
  id: string;
  runId: string;
  step: number;
  actionType: string;
  input: unknown;
  accepted: boolean;
  source: string;
  rejectionReason: string | null;
  observation: unknown;
  stateDiff: unknown;
  validationCode: string | null;
  resultingState: unknown;
  createdAt: Date;
}

interface ToolCallRow {
  id: string;
  runId: string;
  step: number;
  toolName: string;
  input: unknown;
  output?: unknown;
  status: string;
  validationReason: string | null;
  latencyMs: number | null;
  createdAt: Date;
}

const mocks = vi.hoisted(() => ({
  unauthenticated: false,
  /** Scenario ids whose first model call should fault, and how. */
  failScenario: null as string | null,
  failCode: 'provider_error' as 'provider_error' | 'timeout',
  /** Initial-state blob per scenario, so the scripted provider can name its run. */
  stateBlobs: new Map<string, string>(),
  runs: new Map<string, RunRow>(),
  events: [] as EventRow[],
  actions: [] as ActionRow[],
  toolCalls: [] as ToolCallRow[],
  runCounter: 0,
  clock: 0,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({
  env: { AGENT_PROVIDER: 'bedrock', BEDROCK_MODEL_ID: 'test-bedrock-model' },
}));

vi.mock('@/lib/require-auth', () => ({
  requireAuth: async () => {
    if (mocks.unauthenticated) throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    return { id: 'user-1', email: 'owner@example.test' };
  },
}));

vi.mock('@/lib/db', () => {
  const nextDate = () => new Date(Date.UTC(2026, 0, 1) + mocks.clock++ * 1000);

  function applyRunUpdate(target: RunRow, data: Record<string, unknown>) {
    const row = target as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && typeof value === 'object' && 'increment' in value) {
        const { increment } = value as { increment: number };
        row[key] = ((row[key] as number) ?? 0) + increment;
        continue;
      }
      row[key] = value;
    }
    target.updatedAt = nextDate();
  }

  function findRun(where: Record<string, unknown>): RunRow | null {
    for (const run of mocks.runs.values()) {
      const row = run as unknown as Record<string, unknown>;
      if (Object.entries(where).every(([key, value]) => row[key] === value)) return run;
    }
    return null;
  }

  function hydrate(run: RunRow, include?: Record<string, unknown>) {
    if (!include) return { ...run };
    const byCreated = (a: { createdAt: Date }, b: { createdAt: Date }) =>
      a.createdAt.getTime() - b.createdAt.getTime();
    return {
      ...run,
      actions: mocks.actions
        .filter((entry) => entry.runId === run.id)
        .sort((a, b) => a.step - b.step || byCreated(a, b)),
      events: mocks.events
        .filter((entry) => entry.runId === run.id)
        .sort((a, b) => a.sequence - b.sequence || byCreated(a, b)),
      toolCalls: mocks.toolCalls.filter((entry) => entry.runId === run.id).sort(byCreated),
    };
  }

  function createRun(data: Record<string, unknown>) {
    mocks.runCounter += 1;
    const id = `run-${mocks.runCounter}`;
    const now = nextDate();
    const row = {
      ownerId: '',
      scenarioId: null,
      scenarioVersion: null,
      agentStatus: 'READY',
      step: 0,
      budgetUsed: 0,
      turnInProgress: false,
      turnCount: 0,
      terminationReason: null,
      failureDetails: null,
      terminalAt: null,
      createdAt: now,
      updatedAt: now,
      ...data,
      id,
    } as unknown as RunRow;
    mocks.runs.set(id, row);
    return row;
  }

  const client = {
    simulationRun: {
      async create(args: { data: Record<string, unknown> }) {
        return { ...createRun(args.data) };
      },
      async findFirst(args: {
        where: Record<string, unknown>;
        select?: Record<string, boolean>;
        include?: Record<string, unknown>;
      }) {
        const run = findRun(args.where);
        if (!run) return null;
        if (args.select) {
          const picked: Record<string, unknown> = {};
          for (const key of Object.keys(args.select))
            picked[key] = (run as unknown as Record<string, unknown>)[key];
          return picked;
        }
        return hydrate(run, args.include ?? {});
      },
      async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        const run = findRun(args.where);
        if (!run) return { count: 0 };
        applyRunUpdate(run, args.data);
        return { count: 1 };
      },
      async update(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        const run = findRun(args.where);
        if (!run) throw new Error('Run disappeared.');
        applyRunUpdate(run, args.data);
        return hydrate(run, {});
      },
    },
    simulationEvent: {
      async count(args: { where: { runId: string } }) {
        return mocks.events.filter((entry) => entry.runId === args.where.runId).length;
      },
      async create(args: { data: Omit<EventRow, 'id' | 'createdAt'> }) {
        const row: EventRow = {
          ...args.data,
          id: `${args.data.runId}-event-${args.data.sequence}`,
          createdAt: nextDate(),
        };
        mocks.events.push(row);
        return row;
      },
      async createMany(args: { data: Array<Omit<EventRow, 'id' | 'createdAt'>> }) {
        for (const data of args.data)
          mocks.events.push({
            ...data,
            id: `${data.runId}-event-${data.sequence}`,
            createdAt: nextDate(),
          });
        return { count: args.data.length };
      },
    },
    simulationAction: {
      async createMany(args: { data: Array<Omit<ActionRow, 'createdAt'>> }) {
        for (const data of args.data) mocks.actions.push({ ...data, createdAt: nextDate() });
        return { count: args.data.length };
      },
    },
    simulationToolCall: {
      async createMany(args: { data: Array<Omit<ToolCallRow, 'createdAt'>> }) {
        for (const data of args.data) mocks.toolCalls.push({ ...data, createdAt: nextDate() });
        return { count: args.data.length };
      },
    },
    async $transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      return work(client);
    },
  };
  return { prisma: client };
});

vi.mock('@/lib/agent/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/provider')>();
  return {
    ...actual,
    invokeResourceAgent: async (input: { state: unknown; tools: Array<{ name: string }> }) => {
      const scenarioId = mocks.stateBlobs.get(JSON.stringify(input.state));
      if (scenarioId && scenarioId === mocks.failScenario) {
        mocks.failScenario = null;
        throw new actual.AgentProviderError(
          mocks.failCode,
          mocks.failCode === 'timeout'
            ? 'The provider call exceeded the turn budget.'
            : 'The provider rejected the request.',
        );
      }
      // A short, deterministic plan that the environment genuinely accepts:
      // harvest one material, then route two into the objective. Nothing here is
      // a simulation shortcut — every call goes through the same validator the
      // operator path uses.
      const plan = [
        { tool: 'observe_resources', input: {} },
        { tool: 'request_action', input: { type: 'harvest', resource: 'materials', amount: 1 } },
        { tool: 'request_action', input: { type: 'allocate', resource: 'materials', amount: 2 } },
      ];
      for (const step of plan) {
        const tool = input.tools.find((candidate) => candidate.name === step.tool);
        if (!tool) throw new Error(`Tool ${step.tool} is not available to the agent.`);
        await (tool as unknown as { invoke(i?: unknown): Promise<unknown> }).invoke(step.input);
      }
      return {
        metadata: {
          provider: 'Test provider',
          requestStatus: 'completed',
          latencyMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          safeError: null,
        },
        toolCallCount: plan.length,
        acceptedToolCount: plan.length,
        stopReason: 'endTurn',
      };
    },
  };
});

import { POST as runBenchmark } from '@/app/api/benchmarks/[benchmarkId]/run/route';
import { GET as listBenchmarks } from '@/app/api/benchmarks/route';
import { GET as getEvaluation } from '@/app/api/simulations/runs/[runId]/evaluation/route';
import { GET as getReplay } from '@/app/api/simulations/runs/[runId]/replay/route';
import { POST as rerunSimulation } from '@/app/api/simulations/runs/[runId]/rerun/route';
import { ROBUSTNESS_SCENARIO_IDS } from '@/lib/benchmarks/definitions';
import { BenchmarkResult } from '@/lib/benchmarks/types';
import { DEFAULT_CONFIGURATION } from '@/lib/business/simulation';
import { evaluatePersistedRun } from '@/lib/business/simulation-evaluation';
import { loadRun } from '@/lib/business/simulation-persistence';
import { SimulationReplay, SimulationRerunResult } from '@/lib/contracts/simulation';
import { EvaluationEnvelope } from '@/lib/evaluation/types';
import { initializeScenarioRun } from '@/lib/scenarios/scenario';

const BENCHMARK_ID = 'resource-routing-robustness';
const OWNER = 'user-1';
const SEED = 1042;
const SCENARIO_IDS = [...ROBUSTNESS_SCENARIO_IDS];
const BASE = 'http://localhost/api';

function buildStateBlobs(): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const scenarioId of SCENARIO_IDS) {
    const { state } = initializeScenarioRun({
      environmentKey: 'resource-routing',
      objectiveKey: 'complete-delivery',
      seed: SEED,
      configuration: DEFAULT_CONFIGURATION,
      scenarioId,
    });
    blobs.set(JSON.stringify(state), scenarioId);
  }
  return blobs;
}

beforeEach(() => {
  mocks.unauthenticated = false;
  mocks.failScenario = null;
  mocks.failCode = 'provider_error';
  mocks.stateBlobs = buildStateBlobs();
  mocks.runs = new Map();
  mocks.events = [];
  mocks.actions = [];
  mocks.toolCalls = [];
  mocks.runCounter = 0;
  mocks.clock = 0;
});

const createdRuns = () => [...mocks.runs.values()];

async function execute(body: unknown = {}) {
  const response = await runBenchmark(
    new Request(`${BASE}/benchmarks/${BENCHMARK_ID}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ benchmarkId: BENCHMARK_ID }) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('benchmark catalogue endpoint', () => {
  it('serves the shipped benchmarks the runner can resolve', async () => {
    const response = await listBenchmarks(new Request(`${BASE}/benchmarks`, { method: 'GET' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { benchmarks: Array<Record<string, unknown>> };
    expect(body.benchmarks).toHaveLength(1);
    const [summary] = body.benchmarks;
    expect(summary).toMatchObject({
      id: BENCHMARK_ID,
      version: 1,
      name: 'Resource Routing Robustness',
      environmentKey: 'resource-routing',
      objectiveKey: 'complete-delivery',
      scenarioCount: 7,
      seedCount: 1,
      caseCount: 7,
    });
    // A caller can learn that a benchmark exists; it cannot learn how to build
    // one, and it cannot submit one.
    expect(Object.keys(summary ?? {}).sort()).toEqual([
      'caseCount',
      'description',
      'environmentKey',
      'id',
      'name',
      'objectiveKey',
      'scenarioCount',
      'seedCount',
      'version',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/modifier|scenarios/);
  });

  it('refuses an unauthenticated caller', async () => {
    mocks.unauthenticated = true;
    const response = await listBenchmarks(new Request(`${BASE}/benchmarks`, { method: 'GET' }));
    expect(response.status).toBe(401);
  });
});

describe('benchmark execution endpoint', () => {
  it('runs the benchmark and returns its report', async () => {
    const { status, body } = await execute();
    expect(status).toBe(201);
    const result = BenchmarkResult.parse(body);
    expect(result.benchmark).toEqual({
      id: BENCHMARK_ID,
      version: 1,
      name: 'Resource Routing Robustness',
    });
    expect(result.configuration.scenarios.map((entry) => entry.id)).toEqual(SCENARIO_IDS);
    expect(result.runs).toHaveLength(7);
  });

  it('creates a real, owner-scoped run for every case', async () => {
    const result = BenchmarkResult.parse((await execute()).body);
    expect(createdRuns()).toHaveLength(result.runs.length);
    for (const entry of result.runs) {
      const run = createdRuns().find((candidate) => candidate.id === entry.runId);
      expect(run).toBeDefined();
      expect(run?.ownerId).toBe(OWNER);
      expect(run?.scenarioId).toBe(entry.case.scenarioId);
      expect(run?.scenarioVersion).toBe(entry.case.scenarioVersion);
      expect(run?.seed).toBe(entry.case.seed);
      expect(run?.environmentKey).toBe('resource-routing');
    }
  });

  it('scores every case from the run the endpoint can read back', async () => {
    const result = BenchmarkResult.parse((await execute()).body);
    for (const entry of result.runs) {
      const persisted = await loadRun(entry.runId, OWNER);
      if (!persisted) throw new Error(`Case ${entry.case.key} left no persisted run.`);
      expect(entry.evaluation).toEqual(evaluatePersistedRun(persisted));
    }
  });

  it('drives at least one case to a real completion', async () => {
    const result = BenchmarkResult.parse((await execute()).body);
    // The scripted plan genuinely reaches the objective in the conditions that
    // leave enough inventory, so the report contains both completions and
    // limit-reached terminations rather than one uniform outcome.
    expect(result.summary.completedCases).toBeGreaterThan(0);
    expect(result.summary.evaluatedCases).toBe(7);
    const completed = result.runs.find((entry) => entry.status === 'COMPLETED');
    expect(completed?.evaluation?.metrics.objectiveReached).toBe(true);
  });

  it('refuses an unknown benchmark without creating a run', async () => {
    const response = await runBenchmark(
      new Request(`${BASE}/benchmarks/no-such-benchmark/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      { params: Promise.resolve({ benchmarkId: 'no-such-benchmark' }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'UNKNOWN_BENCHMARK' });
    expect(createdRuns()).toHaveLength(0);
  });

  it('refuses an unauthenticated caller without creating a run', async () => {
    mocks.unauthenticated = true;
    const { status } = await execute();
    expect(status).toBe(401);
    expect(createdRuns()).toHaveLength(0);
  });

  it('refuses a seed the environment does not publish', async () => {
    const { status, body } = await execute({ seeds: [777] });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/does not publish/);
    expect(createdRuns()).toHaveLength(0);
  });

  it('refuses a request that names an agent this deployment does not run', async () => {
    const { status, body } = await execute({
      agent: { provider: 'openrouter', model: 'some-other-model' },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('AGENT_CONFIGURATION_MISMATCH');
    expect(createdRuns()).toHaveLength(0);
  });

  it('accepts an empty body, because a benchmark needs no parameters', async () => {
    const response = await runBenchmark(
      new Request(`${BASE}/benchmarks/${BENCHMARK_ID}/run`, { method: 'POST' }),
      { params: Promise.resolve({ benchmarkId: BENCHMARK_ID }) },
    );
    expect(response.status).toBe(201);
  });

  it('keeps a failed case visible without losing the rest of the benchmark', async () => {
    mocks.failScenario = 'resource-outage';
    const result = BenchmarkResult.parse((await execute()).body);
    expect(result.runs).toHaveLength(7);
    expect(result.summary.errorCases).toBe(1);
    expect(result.failures.providerFailures.count).toBe(1);
    const outage = result.runs.find((entry) => entry.case.scenarioId === 'resource-outage');
    expect(outage?.status).toBe('ERROR');
    expect(outage?.outcome).toBe('unsuccessful');
    // The other six still produced evidence.
    expect(result.summary.evaluatedCases).toBe(7);
    expect(result.robustness.evaluatedScenarioCount).toBe(7);
  });
});

describe('the existing endpoints on a benchmark-created run', () => {
  /** The run the benchmark created for one scenario. */
  async function caseRun(scenarioId: string) {
    const result = BenchmarkResult.parse((await execute()).body);
    const entry = result.runs.find((candidate) => candidate.case.scenarioId === scenarioId);
    if (!entry) throw new Error(`The benchmark produced no case for ${scenarioId}.`);
    return { result, entry };
  }

  it('serves the same verdict the benchmark reported', async () => {
    const { entry } = await caseRun('budget-pressure');
    const response = await getEvaluation(
      new Request(`${BASE}/simulations/runs/${entry.runId}/evaluation`, { method: 'GET' }),
      { params: Promise.resolve({ runId: entry.runId }) },
    );
    expect(response.status).toBe(200);
    const body = EvaluationEnvelope.parse(await response.json());
    expect(body.evaluation).toEqual(entry.evaluation);
    expect(body.inProgress).toBe(false);
  });

  it('replays a benchmark-created run from the world its scenario produced', async () => {
    const { entry } = await caseRun('resource-outage');
    const response = await getReplay(
      new Request(`${BASE}/simulations/runs/${entry.runId}/replay`, { method: 'GET' }),
      { params: Promise.resolve({ runId: entry.runId }) },
    );
    expect(response.status).toBe(200);
    const replay = SimulationReplay.parse(await response.json());
    const run = await loadRun(entry.runId, OWNER);
    const expectedInitial = initializeScenarioRun({
      environmentKey: 'resource-routing',
      objectiveKey: 'complete-delivery',
      seed: SEED,
      scenarioId: 'resource-outage',
    }).state;
    // Replay starts in the perturbed world, not the world the seed alone implies.
    expect(replay.frames[0]?.state).toEqual(expectedInitial);
    expect(replay.frames[0]?.state.resources.water).toBe(0);
    expect(replay.frames.at(-1)?.state).toEqual(run?.state);
  });

  it('reruns a benchmark-created run at the scenario version it recorded', async () => {
    const { entry } = await caseRun('elevated-risk');
    const original = await loadRun(entry.runId, OWNER);
    const response = await rerunSimulation(
      new Request(`${BASE}/simulations/runs/${entry.runId}/rerun`, { method: 'POST' }),
      { params: Promise.resolve({ runId: entry.runId }) },
    );
    expect(response.status).toBe(201);
    const body = SimulationRerunResult.parse(await response.json());
    expect(body.run.scenario).toEqual({
      id: 'elevated-risk',
      version: entry.case.scenarioVersion,
    });
    expect(body.run.seed).toBe(SEED);
    // The rerun starts in exactly the world the benchmark case started in, and
    // the endpoint's own determinism check agrees.
    expect(body.run.state).toEqual(original?.initialState);
    expect(body.determinism.environmentInitialStateMatches).toBe(true);
  });

  it('keeps a benchmark-created run in the owner’s own run set', async () => {
    const { entry } = await caseRun('baseline');
    // The run the benchmark created is a run like any other: it is stored under
    // the caller's id, with the scenario columns the case pinned.
    expect(await loadRun(entry.runId, OWNER)).not.toBeNull();
    expect(await loadRun(entry.runId, 'someone-else')).toBeNull();
  });
});
