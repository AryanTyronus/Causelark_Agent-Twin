//
// The console is where the operator becomes a product rather than an engine, and
// three of this phase's claims are only true if they are true *here*:
//
//   1. A preview ends at a plan. Running a benchmark is a separate, explicit act
//      that names what it is about to spend, and nothing runs before it.
//   2. Nothing is shown that did not happen. A report appears only after an
//      execution, a trace line only for a call that was actually made, and a
//      figure only where an engine produced one.
//   3. The operator's words are never evidence. Its narration and its reading of
//      the verdict render in their own labelled panels, apart from every
//      measurement, and the structured detail a tool recorded is not dumped into
//      the page.
//
// The run states below are assembled by the real engines — the real plan from the
// benchmark registry, the real result projection, the real trust report — so the
// verdict on screen is the one a deployment would compute rather than one typed
// into this file.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ApiCall {
  path: string;
  method: string;
  body: string | null;
}

const api = vi.hoisted(() => ({
  requested: [] as ApiCall[],
  responses: new Map<string, unknown>(),
  failures: new Map<string, { status: number; body?: unknown }>(),
  /** Paths whose response waits on `gate` — used to hold a request in flight. */
  gatedPaths: [] as string[],
  gate: null as Promise<void> | null,
  openGate: null as (() => void) | null,
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: async (
    path: string,
    init?: {
      method?: string;
      body?: string | null;
      schema?: { parse: (value: unknown) => unknown };
    },
  ) => {
    api.requested.push({ path, method: init?.method ?? 'GET', body: init?.body ?? null });
    if (api.gate && api.gatedPaths.some((prefix) => path.startsWith(prefix))) await api.gate;
    const failure = api.failures.get(path);
    if (failure) {
      const error = new Error(`apiFetch ${path} failed (${failure.status})`);
      if (failure.body !== undefined) Object.assign(error, { cause: failure.body });
      throw error;
    }
    if (!api.responses.has(path)) throw new Error(`apiFetch ${path} failed (404)`);
    const value = api.responses.get(path);
    // The real client validates every response against the contract the caller
    // named. Doing the same here means a fixture that drifted from the contract
    // fails in this suite rather than rendering something the server could not
    // have sent.
    return init?.schema ? init.schema.parse(value) : value;
  },
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ env: { NODE_ENV: 'test' } }));

vi.mock('@/lib/business/agent-catalog', async () => {
  const fixtures = await import('./operator-fixtures');
  return { deploymentAgentCatalog: () => fixtures.CATALOG };
});

import { OperatorConsole } from '@/components/custom/agent-twin/operator';
import { listBenchmarkSummaries } from '@/lib/benchmarks/catalog';
import { operatorBounds } from '@/lib/operator/config';
import { buildTrustReport } from '@/lib/operator/report';
import {
  type OperatorPhase,
  type OperatorRunState,
  OperatorRunState as OperatorRunStateSchema,
  type OperatorToolStatus,
} from '@/lib/operator/types';
import {
  buildBenchmarkResult,
  buildCaseEvidence,
  buildCounterfactualFinding,
  CATALOG,
  EMPTY_CATALOG,
  fixturePlan,
  toSlice,
} from './operator-fixtures';
import { render } from './render';

const AT = '2026-01-01T00:00:00.000Z';
const OBJECTIVE = 'Test this agent and tell me whether it is ready to deploy.';
const AGENT_KEY = 'development-agent@twin-development';
const BENCHMARK = required(listBenchmarkSummaries()[0], 'the first catalogued benchmark');

const PLAN = fixturePlan({
  objective: OBJECTIVE,
  benchmarkId: BENCHMARK.id,
  agentKey: AGENT_KEY,
});

const RESULT = toSlice(
  buildBenchmarkResult({
    benchmarkId: BENCHMARK.id,
    benchmarkVersion: BENCHMARK.version,
    benchmarkName: BENCHMARK.name,
  }),
);

const INTERPRETATION =
  'The agent completed most of the objective but lost ground under scarcity, and one allocation was refused.';

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Fixture: ${what} is missing from the catalogue.`);
  return value;
}

/** One recorded tool call, shaped exactly as the server records one. */
function step(
  index: number,
  phase: OperatorPhase,
  tool: string,
  status: OperatorToolStatus,
  summary: string,
  detail: Record<string, unknown> = {},
) {
  return { index, phase, tool, status, summary, detail, at: AT };
}

const PREVIEW_TRACE = [
  step(
    0,
    'discover',
    'list_agents',
    'completed',
    'One agent configuration resolves in this deployment.',
  ),
  step(
    1,
    'discover',
    'list_benchmarks',
    'completed',
    'One registered benchmark is available to run.',
  ),
  step(
    2,
    'discover',
    'get_benchmark',
    'refused',
    'No benchmark with that id is registered in this deployment.',
    { requested: 'a-benchmark-that-does-not-exist' },
  ),
  step(
    3,
    'discover',
    'get_benchmark',
    'completed',
    `Read ${BENCHMARK.id}@${BENCHMARK.version}: ${BENCHMARK.scenarioCount} conditions, ${BENCHMARK.seedCount} declared seed.`,
  ),
  step(
    4,
    'plan',
    'create_test_plan',
    'completed',
    `Planned ${PLAN.caseCount} case(s) across ${PLAN.scenarios.length} condition(s).`,
  ),
];

const EXECUTE_TRACE = [
  ...PREVIEW_TRACE,
  step(5, 'execute', 'run_benchmark', 'completed', `Executed ${PLAN.caseCount} case(s).`),
  step(6, 'inspect', 'inspect_case', 'completed', 'Read one case and its evaluation.'),
  step(
    7,
    'analyze',
    'analyze_counterfactual',
    'completed',
    'Ranked the alternatives at every decision.',
  ),
  step(8, 'report', 'generate_trust_report', 'completed', 'Assembled the trust report.'),
];

function report(overrides: Record<string, unknown> = {}) {
  return buildTrustReport({
    objective: OBJECTIVE,
    plan: PLAN,
    result: RESULT,
    counterfactuals: [],
    interpretation: null,
    recommendation: null,
    planFingerprint: PLAN.fingerprint,
    toolCalls: 5,
    turns: 5,
    stopReason: 'endTurn',
    benchmarkRuns: 0,
    counterfactualAnalyses: 0,
    generatedAt: AT,
    ...overrides,
  });
}

/** A run state, validated by the contract the route serves it under. */
function runState(overrides: Partial<OperatorRunState> = {}): OperatorRunState {
  return OperatorRunStateSchema.parse({
    mode: 'preview' as const,
    status: 'completed' as const,
    objective: OBJECTIVE,
    stopReason: 'endTurn',
    requestedAgentKey: AGENT_KEY,
    agents: CATALOG.agents,
    configurationNotice: null,
    limits: operatorBounds(),
    usage: {
      turns: 5,
      toolCalls: 5,
      refusedToolCalls: 1,
      failedToolCalls: 0,
      benchmarkRuns: 0,
      counterfactualAnalyses: 0,
      durationMs: 12_400,
    },
    plan: PLAN,
    authorized: false,
    trace: PREVIEW_TRACE,
    result: null,
    caseEvidence: [],
    counterfactuals: [],
    report: null,
    narration: 'I have planned the test. It is ready to run.',
    notices: [],
    ...overrides,
  });
}

/** The same run after a person authorised it and the benchmark actually ran. */
function executedState(overrides: Partial<OperatorRunState> = {}): OperatorRunState {
  return runState({
    mode: 'execute',
    authorized: true,
    usage: {
      turns: 9,
      toolCalls: 9,
      refusedToolCalls: 1,
      failedToolCalls: 0,
      benchmarkRuns: 1,
      counterfactualAnalyses: 1,
      durationMs: 84_000,
    },
    trace: EXECUTE_TRACE,
    result: RESULT,
    caseEvidence: [buildCaseEvidence()],
    counterfactuals: [buildCounterfactualFinding()],
    report: report({
      counterfactuals: [buildCounterfactualFinding()],
      interpretation: INTERPRETATION,
      recommendation: 'Run the scarcity condition again at a second seed before deploying.',
      benchmarkRuns: 1,
      counterfactualAnalyses: 1,
      toolCalls: 9,
      turns: 9,
    }),
    narration: 'Report assembled from the recorded results.',
    ...overrides,
  });
}

/** Serve the agent catalogue every mount asks for. */
function serveCatalogue(catalog: unknown = CATALOG): void {
  api.responses.set('/api/agents', catalog);
}

/** Name the objective and the agent, plan a test, and return the view on a plan. */
async function planATest(state: OperatorRunState = runState()) {
  const view = await render(<OperatorConsole />);
  await view.type(required(view.one('textarea') ?? undefined, 'the objective field'), OBJECTIVE);
  await view.type(
    required(view.control('Agent under test') ?? undefined, 'the agent picker'),
    AGENT_KEY,
  );
  api.responses.set('/api/operator', { run: state });
  await view.click(required(view.control('Plan a test') ?? undefined, 'the plan button'));
  return view;
}

/** Hold responses for `paths` until the returned function is called. */
function hold(paths: string[]): () => void {
  api.gatedPaths = paths;
  api.gate = new Promise<void>((resolve) => {
    api.openGate = resolve;
  });
  return () => {
    api.gate = null;
    api.gatedPaths = [];
    api.openGate?.();
  };
}

/** The operator must never put a credential, or the name of one, on the page. */
function expectNoCredential(view: Awaited<ReturnType<typeof render>>): void {
  expect(view.text()).not.toMatch(
    /sk-[a-zA-Z0-9]{8}|bearer\s|api[_-]?key\s*[:=]|client[_-]?secret|password/i,
  );
}

beforeEach(() => {
  api.requested = [];
  api.responses = new Map();
  api.failures = new Map();
  api.gate = null;
  api.gatedPaths = [];
  api.openGate = null;
  serveCatalogue();
});

describe('the request', () => {
  it('offers the agents this deployment can actually run', async () => {
    const view = await render(<OperatorConsole />);
    const select = required(view.control('Agent under test') ?? undefined, 'the agent picker');

    for (const agent of CATALOG.agents) {
      expect(select.textContent).toContain(agent.identity);
      expect(select.textContent).toContain(agent.configuration.provider);
    }
    expect(select.textContent).toContain('Let the operator choose');
    await view.unmount();
  });

  it('says so plainly when no agent on this deployment resolves', async () => {
    serveCatalogue(EMPTY_CATALOG);
    const view = await render(<OperatorConsole />);

    expect(view.has('No provider model is configured. Set OPENROUTER_MODEL to run an agent.')).toBe(
      true,
    );
    await view.unmount();
  });

  it('will not plan until an objective has been stated', async () => {
    const view = await render(<OperatorConsole />);
    const plan = required(
      view.control('Plan a test') ?? undefined,
      'the plan button',
    ) as HTMLButtonElement;

    expect(plan.disabled).toBe(true);
    await view.type(required(view.one('textarea') ?? undefined, 'the objective field'), 'brief');
    expect((view.control('Plan a test') as HTMLButtonElement).disabled).toBe(true);

    await view.type(required(view.one('textarea') ?? undefined, 'the objective field'), OBJECTIVE);
    expect((view.control('Plan a test') as HTMLButtonElement).disabled).toBe(false);
    await view.unmount();
  });

  it('sends the objective, the chosen agent and preview mode', async () => {
    const view = await render(<OperatorConsole />);
    await view.type(required(view.one('textarea') ?? undefined, 'the objective field'), OBJECTIVE);
    await view.type(
      required(view.control('Agent under test') ?? undefined, 'the agent picker'),
      AGENT_KEY,
    );
    api.responses.set('/api/operator', { run: runState() });
    await view.click(required(view.control('Plan a test') ?? undefined, 'the plan button'));

    const call = api.requested.find((entry) => entry.path === '/api/operator');
    expect(call?.method).toBe('POST');
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'preview',
      authorizedPlanFingerprint: null,
    });
    await view.unmount();
  });

  it('says it is working rather than showing a stale screen', async () => {
    const release = hold(['/api/operator']);
    const view = await render(<OperatorConsole />);
    await view.type(required(view.one('textarea') ?? undefined, 'the objective field'), OBJECTIVE);

    api.responses.set('/api/operator', { run: runState() });
    // Awaited, because the busy state is a React update: asserting before the
    // flush would be asserting on the render that has not happened yet.
    await view.click(required(view.control('Plan a test') ?? undefined, 'the plan button'));

    // Still in flight — the response is being held — so the page states what it
    // is doing rather than showing a form that looks idle.
    expect(view.has('The operator is running')).toBe(true);
    expect(view.has('Working')).toBe(true);

    release();
    await view.settle();
    expect(view.has('The operator is running')).toBe(false);
    await view.unmount();
  });
});

describe('a preview ends at a plan', () => {
  it('labels the run as a preview and says no benchmark was run', async () => {
    const view = await planATest();

    expect(view.has('PREVIEW')).toBe(true);
    expect(view.has('the operator was not permitted to run a benchmark')).toBe(true);
    await view.unmount();
  });

  it('shows the plan exactly as the registry defines it', async () => {
    const view = await planATest();

    expect(view.has(`${BENCHMARK.name} (${BENCHMARK.id})`)).toBe(true);
    expect(view.has(String(PLAN.benchmark.version))).toBe(true);
    expect(view.has(PLAN.agent.identity)).toBe(true);
    expect(view.has(PLAN.agent.providerLabel)).toBe(true);
    expect(view.has(PLAN.benchmark.environmentKey)).toBe(true);
    expect(view.has(PLAN.benchmark.objectiveKey)).toBe(true);
    expect(view.has(PLAN.seeds.join(', '))).toBe(true);
    for (const scenario of PLAN.scenarios)
      expect(view.has(scenario.id.replaceAll('-', ' '))).toBe(true);
    await view.unmount();
  });

  it('states what the execution would spend, before it is authorised', async () => {
    const view = await planATest();

    expect(view.has(`${PLAN.providerDrivenSimulations} provider-driven simulations`)).toBe(true);
    expect(view.has(`${PLAN.caseCount} case(s)`)).toBe(true);
    expect(view.has(`${PLAN.seeds.length} seed(s)`)).toBe(true);
    expect(view.has(`plan fingerprint ${PLAN.fingerprint}`)).toBe(true);
    await view.unmount();
  });

  it('shows the bounds the run was held to', async () => {
    const state = runState();
    const view = await planATest(state);

    expect(view.has(`${state.usage.turns} / ${state.limits.maxTurns}`)).toBe(true);
    expect(view.has(`${state.usage.benchmarkRuns} / ${state.limits.maxBenchmarkRuns}`)).toBe(true);
    expect(view.has(`stopped: ${state.stopReason}`)).toBe(true);
    await view.unmount();
  });

  it('offers no report and no result before a benchmark has run', async () => {
    const view = await planATest();

    expect(view.has('Agent Trust Report')).toBe(false);
    expect(view.has('Benchmark result')).toBe(false);
    expect(view.has('Counterfactual findings')).toBe(false);
    expect(view.has('Cases inspected')).toBe(false);
    await view.unmount();
  });

  it('shows the operator narration, labelled as a summary rather than a measurement', async () => {
    const view = await planATest();

    expect(view.has('Operator narration')).toBe(true);
    expect(view.has("This is a model's summary, not a measurement")).toBe(true);
    expect(view.has('I have planned the test. It is ready to run.')).toBe(true);
    await view.unmount();
  });

  it('asks for an explicit authorisation, and sends the fingerprint a person saw', async () => {
    const view = await planATest();
    const authorise = required(
      view.control('Authorise and execute') ?? undefined,
      'the authorise button',
    ) as HTMLButtonElement;
    expect(authorise.disabled).toBe(false);

    api.responses.set('/api/operator', { run: executedState() });
    await view.click(authorise);

    const calls = api.requested.filter((entry) => entry.path === '/api/operator');
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'execute',
      authorizedPlanFingerprint: PLAN.fingerprint,
    });
    await view.unmount();
  });
});

describe('the trace is what happened', () => {
  it('renders one line per recorded call, in the order they were made', async () => {
    const view = await planATest();
    const lines = view.all('ol li');

    expect(lines).toHaveLength(PREVIEW_TRACE.length);
    PREVIEW_TRACE.forEach((recorded, index) => {
      const line = lines[index];
      expect(line?.textContent).toContain(recorded.tool);
      expect(line?.textContent).toContain(recorded.status);
      expect(line?.textContent).toContain(recorded.phase);
      expect(line?.textContent).toContain(recorded.summary);
    });
    await view.unmount();
  });

  it('numbers the steps from one, the way a reader counts them', async () => {
    const view = await planATest();
    expect(view.all('ol li')[0]?.textContent).toContain('01');
    await view.unmount();
  });

  it('states an empty trace rather than showing an empty list', async () => {
    const view = await planATest(runState({ trace: [], plan: null }));

    expect(view.has('No tool calls recorded')).toBe(true);
    expect(view.has('produced no tool calls in this run')).toBe(true);
    await view.unmount();
  });

  it('renders the tool summaries without dumping the structured detail', async () => {
    const view = await planATest(
      runState({
        trace: [
          step(0, 'discover', 'list_benchmarks', 'completed', 'Read the registry.', {
            rows: ['a-sentinel-the-page-must-not-print'],
          }),
        ],
      }),
    );

    expect(view.has('Read the registry.')).toBe(true);
    // The detail is a bounded echo for the trace record. It is not a payload to
    // be printed at a reader, and it is where a raw engine object would land.
    expect(view.has('a-sentinel-the-page-must-not-print')).toBe(false);
    await view.unmount();
  });
});

describe('a run that executed', () => {
  it('labels a live execution and names what it was authorised to run', async () => {
    const view = await planATest(executedState());

    expect(view.has('LIVE')).toBe(true);
    expect(view.has('a benchmark was authorised against the plan below')).toBe(true);
    expect(view.has('1 / 1')).toBe(true);
    await view.unmount();
  });

  it('says plainly when an execution matched no authorised plan', async () => {
    const view = await planATest(
      runState({
        mode: 'execute',
        authorized: false,
        notices: ['The plan presented did not match the plan this run committed to.'],
      }),
    );

    expect(view.has('LIVE')).toBe(true);
    expect(view.has('no authorised plan matched, so no benchmark was started')).toBe(true);
    expect(view.has('did not match the plan this run committed to')).toBe(true);
    expect(view.has('Benchmark result')).toBe(false);
    await view.unmount();
  });

  it("renders the benchmark engine's own figures", async () => {
    const view = await planATest(executedState());

    expect(view.has(`Every figure below is the benchmark engine's own output`)).toBe(true);
    expect(view.has(String(RESULT.dimensions.averageOverallScore))).toBe(true);
    expect(view.has('Robustness')).toBe(true);
    expect(view.has(String(RESULT.robustness.formula))).toBe(true);
    await view.unmount();
  });

  it('links every run it produced to the recorded run behind it', async () => {
    const view = await planATest(executedState());

    for (const entry of RESULT.runs) {
      expect(view.has(entry.runId)).toBe(true);
      expect(
        view
          .all('a')
          .some((link) => link.getAttribute('href') === `/dashboard/simulations/${entry.runId}`),
      ).toBe(true);
    }
    await view.unmount();
  });

  it("renders the case the operator inspected, with the evaluator's verdict", async () => {
    const evidence = buildCaseEvidence();
    const view = await planATest(executedState({ caseEvidence: [evidence] }));

    expect(view.has('Cases inspected')).toBe(true);
    expect(view.has(evidence.caseKey)).toBe(true);
    expect(view.has(String(evidence.actions.accepted))).toBe(true);
    expect(view.has(`overall ${evidence.evaluation.overallScore.toFixed(1)}`)).toBe(true);
    await view.unmount();
  });

  it("shows a refused action with the environment's own reason", async () => {
    const evidence = buildCaseEvidence();
    const view = await planATest(executedState({ caseEvidence: [evidence] }));

    const rejected = evidence.actions.rejectedActions[0];
    if (!rejected?.reason) throw new Error('Fixture: the case evidence recorded no refusal.');
    expect(view.has(rejected.reason)).toBe(true);
    await view.unmount();
  });

  it('shows a fault the run recorded, and none when it recorded none', async () => {
    const faulted = buildCaseEvidence({
      runId: 'run-with-a-fault',
      scenario: { id: 'resource-scarcity', version: 1 },
      faultEvents: ['The agent reached the turn limit before the objective was complete.'],
    });
    const view = await planATest(executedState({ caseEvidence: [faulted] }));

    expect(view.has('The agent reached the turn limit before the objective was complete.')).toBe(
      true,
    );
    expect(view.has('resource scarcity@1')).toBe(true);
    await view.unmount();
  });

  it("renders the counterfactual engine's ranking, not a summary of it", async () => {
    const finding = buildCounterfactualFinding();
    const view = await planATest(executedState({ counterfactuals: [finding] }));

    expect(view.has('Counterfactual findings')).toBe(true);
    expect(view.has(String(finding.decisionsAnalysed))).toBe(true);
    expect(view.has(`max regret ${finding.maxRegret?.toFixed(1)}`)).toBe(true);
    expect(view.has(finding.criticalDecision?.statement ?? 'no statement')).toBe(true);
    for (const [name, value] of Object.entries(finding.policies))
      expect(view.has(`${name}=${value}`)).toBe(true);
    await view.unmount();
  });

  it('says a finding with no better alternative found one', async () => {
    const finding = buildCounterfactualFinding({ maxRegret: 0, criticalDecision: null });
    const view = await planATest(
      executedState({
        counterfactuals: [finding],
        report: report({ counterfactuals: [finding] }),
      }),
    );

    expect(view.has('no better alternative found')).toBe(true);
    expect(view.has('No decision had a higher-scoring alternative.')).toBe(true);
    await view.unmount();
  });
});

describe('the trust report', () => {
  it('renders the verdict the engine computed, with the methodology named', async () => {
    const state = executedState();
    const view = await planATest(state);
    const verdict = state.report?.verdict;

    expect(view.has('Agent Trust Report')).toBe(true);
    expect(view.has(verdict?.verdict.replace('_', ' ') ?? 'no verdict')).toBe(true);
    expect(view.has(verdict?.headline ?? 'no headline')).toBe(true);
    expect(view.has(verdict?.methodology ?? 'no methodology')).toBe(true);
    expect(view.has(`Policy version ${state.report?.policyVersion}`)).toBe(true);
    await view.unmount();
  });

  it('publishes every rule behind the verdict, threshold and all', async () => {
    const state = executedState();
    const view = await planATest(state);

    for (const rule of state.report?.verdict.rules ?? []) {
      expect(view.has(rule.label)).toBe(true);
      expect(view.has(rule.detail)).toBe(true);
      expect(view.has(rule.threshold)).toBe(true);
    }
    expect(view.has('decisive')).toBe(
      (state.report?.verdict.rules ?? []).some((rule) => rule.decisive),
    );
    await view.unmount();
  });

  it('names the evidence the report was derived from', async () => {
    const state = executedState();
    const view = await planATest(state);

    expect(view.has('Evidence')).toBe(true);
    for (const runId of state.report?.evidence.runIds ?? []) expect(view.has(runId)).toBe(true);
    for (const scenarioId of state.report?.evidence.scenarioIds ?? [])
      expect(view.has(scenarioId)).toBe(true);
    for (const policy of state.report?.evidence.policies ?? [])
      expect(view.has(`${policy.name} = ${policy.value}`)).toBe(true);
    expect(view.has(PLAN.fingerprint)).toBe(true);
    await view.unmount();
  });

  it("keeps the operator's reading out of the measured half", async () => {
    const state = executedState();
    const view = await planATest(state);
    const interpretation = view.one('p.whitespace-pre-wrap')?.textContent ?? '';

    expect(view.has('Operator interpretation')).toBe(true);
    expect(
      view.has('This is not a measurement, and no figure in this report was read from it'),
    ).toBe(true);
    expect(interpretation).toContain(INTERPRETATION);
    // The verdict panel is assembled from engine output alone, so the operator's
    // own sentence appears in the report's own text nowhere.
    const report = view.one('#trust-report')?.textContent ?? '';
    expect(report).not.toContain(INTERPRETATION);
    expect(report).not.toContain('Run the scarcity condition again at a second seed');
    await view.unmount();
  });

  it("shows the recommendation as the operator's, apart from the verdict", async () => {
    const view = await planATest(executedState());

    expect(view.has('Recommendation')).toBe(true);
    expect(view.has('Run the scarcity condition again at a second seed before deploying.')).toBe(
      true,
    );
    await view.unmount();
  });

  it('shows no interpretation panel when the operator wrote none', async () => {
    const view = await planATest(executedState({ report: report() }));

    expect(view.has('Agent Trust Report')).toBe(true);
    expect(view.has('Operator interpretation')).toBe(false);
    await view.unmount();
  });
});

describe('a failure is stated in words', () => {
  it('reports an expired session', async () => {
    const view = await render(<OperatorConsole />);
    await view.type(required(view.one('textarea') ?? undefined, 'the objective field'), OBJECTIVE);
    api.failures.set('/api/operator', { status: 401, body: { error: 'Unauthorized' } });
    await view.click(required(view.control('Plan a test') ?? undefined, 'the plan button'));

    expect(view.has('The operator run failed')).toBe(true);
    expect(view.has('Your session has expired. Sign in again to run the operator.')).toBe(true);
    expectNoCredential(view);
    await view.unmount();
  });

  it('reports a deployment whose provider is not configured, quoting the deployment', async () => {
    const view = await render(<OperatorConsole />);
    await view.type(required(view.one('textarea') ?? undefined, 'the objective field'), OBJECTIVE);
    api.failures.set('/api/operator', {
      status: 503,
      body: {
        error: 'No provider model is configured. Set OPENROUTER_MODEL to run an agent.',
        code: 'NO_AGENT_CONFIGURED',
      },
    });
    await view.click(required(view.control('Plan a test') ?? undefined, 'the plan button'));

    expect(view.has('Set OPENROUTER_MODEL to run an agent.')).toBe(true);
    await view.unmount();
  });

  it('replaces a 503 that names no code with a sentence of its own', async () => {
    // A 503 from something in front of the deployment is not this API speaking,
    // so its body is not shown as if it were.
    const view = await render(<OperatorConsole />);
    await view.type(required(view.one('textarea') ?? undefined, 'the objective field'), OBJECTIVE);
    api.failures.set('/api/operator', {
      status: 503,
      body: { error: 'upstream connect error or disconnect/reset before headers' },
    });
    await view.click(required(view.control('Plan a test') ?? undefined, 'the plan button'));

    expect(view.has('upstream connect error')).toBe(false);
    expect(view.has('its model provider is not configured')).toBe(true);
    await view.unmount();
  });

  it("shows the operator's own refusal in the operator's own words", async () => {
    const view = await render(<OperatorConsole />);
    await view.type(required(view.one('textarea') ?? undefined, 'the objective field'), OBJECTIVE);
    api.failures.set('/api/operator', {
      status: 400,
      body: {
        error:
          'An execution needs the fingerprint of a plan a person approved. Run a preview first.',
        code: 'UNAUTHORIZED_MODE',
      },
    });
    await view.click(required(view.control('Plan a test') ?? undefined, 'the plan button'));

    expect(
      view.has(
        'An execution needs the fingerprint of a plan a person approved. Run a preview first.',
      ),
    ).toBe(true);
    await view.unmount();
  });

  it('states an unexplained failure without echoing whatever was thrown', async () => {
    const view = await render(<OperatorConsole />);
    await view.type(required(view.one('textarea') ?? undefined, 'the objective field'), OBJECTIVE);
    api.failures.set('/api/operator', {
      status: 500,
      body: { error: 'postgres://user:hunter2@localhost:5432/db' },
    });
    await view.click(required(view.control('Plan a test') ?? undefined, 'the plan button'));

    expect(view.has('The operator run failed. Nothing was reported.')).toBe(true);
    expect(view.has('hunter2')).toBe(false);
    await view.unmount();
  });

  it('keeps the plan on screen when an execution fails, because it is still the plan', async () => {
    const view = await planATest();
    api.failures.set('/api/operator', {
      status: 503,
      body: { error: 'The operator could not reach its model.', code: 'OPERATOR_FAILED' },
    });
    await view.click(
      required(view.control('Authorise and execute') ?? undefined, 'the authorise button'),
    );

    expect(view.has('The operator could not reach its model.')).toBe(true);
    expect(view.has(`plan fingerprint ${PLAN.fingerprint}`)).toBe(true);
    expect(view.has('PREVIEW')).toBe(true);
    await view.unmount();
  });

  it('never puts a credential, or the name of one, on the page', async () => {
    const view = await planATest(executedState());
    expectNoCredential(view);
    await view.unmount();
  });
});
