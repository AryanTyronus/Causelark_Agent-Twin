//
// Four things about this flow can be wrong in a way that would matter, and each
// is asserted here by using the interface rather than by calling its helpers:
//
//   1. It configures a real experiment. The benchmark, the experiment, the case
//      count and the seeds shown before a run come from the deployment's own
//      compiled catalogue, so the review step describes what will actually run.
//   2. It refuses a comparison that is not a comparison. Two identical agent
//      configurations are the same agent, and the flow says so before a run
//      rather than after one.
//   3. It snapshots before it posts. The execution view can only attribute a run
//      to this test if the owner's existing runs were read first, so the order of
//      those two requests is asserted rather than assumed.
//   4. It reports a failure as a sentence. A 401, a 503 and a validation refusal
//      each reach the operator as text the server wrote, never as a response body
//      the interface echoed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ApiCall {
  path: string;
  method: string;
  body: string | null;
}

interface Failure {
  status: number;
  body?: unknown;
}

const api = vi.hoisted(() => ({
  requested: [] as ApiCall[],
  responses: new Map<string, unknown>(),
  failures: new Map<string, Failure>(),
  /** Paths whose response waits on `gate` — used to hold a request in flight. */
  gatedPaths: [] as string[],
  gate: null as Promise<void> | null,
  openGate: null as (() => void) | null,
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string | null }) => {
    api.requested.push({ path, method: init?.method ?? 'GET', body: init?.body ?? null });
    if (api.gate && api.gatedPaths.some((prefix) => path.startsWith(prefix))) await api.gate;
    const failure = api.failures.get(path);
    if (failure) {
      const error = new Error(`apiFetch ${path} failed (${failure.status})`);
      if (failure.body !== undefined) Object.assign(error, { cause: failure.body });
      throw error;
    }
    if (!api.responses.has(path)) throw new Error(`apiFetch ${path} failed (404)`);
    return api.responses.get(path);
  },
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

import { TestRunner } from '@/components/custom/agent-twin/test-runner';
import { listBenchmarkSummaries } from '@/lib/benchmarks/catalog';
import { buildRunMatrix } from '@/lib/benchmarks/matrix';
import {
  experimentSummary,
  getExperiment,
  listExperimentSummaries,
} from '@/lib/comparison/catalog';
import { ExperimentPlan } from '@/lib/comparison/types';
import { agentFixture, comparisonFixture } from '../comparison.fixtures';
import { render } from './render';

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Fixture: ${what} is missing from the catalogue.`);
  return value;
}

// The deployment's real registries, and the real matrix builder the plan
// endpoint uses — so what the flow displays is what an execution would run.
const EXPERIMENTS = listExperimentSummaries();
const BENCHMARKS = listBenchmarkSummaries();
const EXPERIMENT = required(EXPERIMENTS[0], 'the first experiment');

/** The plan the endpoint would return, built exactly the way it builds it. */
function planFixture(experimentId: string) {
  const { template, definition } = getExperiment(experimentId);
  const cases = buildRunMatrix(definition);
  return ExperimentPlan.parse({
    experiment: experimentSummary({ template, definition }),
    cases,
    seeds: [...new Set(cases.map((entry) => entry.seed))],
  });
}

/**
 * The providers this build can construct a client for, as the endpoint serves
 * them. Hand-written because the real catalogue reads deployment environment:
 * what is under test here is the flow, not the deployment's configuration.
 */
const AGENT_CATALOG = {
  agents: [
    {
      key: 'bedrock@model-a',
      identity: 'bedrock@model-a',
      configuration: {
        agentId: 'bedrock',
        agentVersion: 'model-a',
        provider: 'bedrock',
        model: 'model-a',
      },
      providerLabel: 'Amazon Bedrock',
      isDeploymentDefault: true,
    },
  ],
  providers: [
    {
      provider: 'bedrock',
      label: 'Amazon Bedrock',
      production: true,
      configured: true,
      model: 'model-a',
      isDeploymentDefault: true,
    },
    {
      provider: 'openrouter',
      label: 'OpenRouter',
      production: true,
      configured: true,
      model: null,
      isDeploymentDefault: false,
    },
  ],
  defaultAgentKey: 'bedrock@model-a',
  configurationNotice: null,
};

const RUN_PATH = `/api/agent-comparisons/${EXPERIMENT.id}/run`;
const PLAN_PATH = `/api/agent-comparisons/${EXPERIMENT.id}`;

/**
 * The report the run endpoint would return for the two agents this flow sends.
 *
 * Two configurations of the same provider, differing only in the model they ask
 * for — which is exactly what the flow builds from two rows in the form. The
 * report is assembled by the real comparison engine, so the verdict rendered is
 * the engine's, not the test's.
 */
function reportFixture() {
  return comparisonFixture({
    agents: [
      agentFixture({ agentId: 'bedrock', agentVersion: 'model-a', model: 'model-a' }),
      agentFixture({ agentId: 'bedrock', agentVersion: 'model-b', model: 'model-b' }),
    ],
    reports: new Map([
      ['bedrock@model-a', { spread: 88 }],
      ['bedrock@model-b', { spread: 46 }],
    ]),
  });
}

/** Load the three catalogues and the plan, as a fresh page load does. */
function serveCatalogues(): void {
  api.responses.set('/api/agent-comparisons', { experiments: EXPERIMENTS });
  api.responses.set('/api/benchmarks', { benchmarks: BENCHMARKS });
  api.responses.set('/api/agents', AGENT_CATALOG);
  api.responses.set(PLAN_PATH, planFixture(EXPERIMENT.id));
  // The recorder's snapshot. An empty list is the honest answer for a fresh
  // account, and it makes the recording state observable.
  api.responses.set('/api/simulations/runs', { runs: [] });
}

/** Type a model into one of the two agent rows. */
async function nameModel(
  view: Awaited<ReturnType<typeof render>>,
  index: number,
  model: string,
): Promise<void> {
  const input = view.one(`#model-${index}`);
  if (!input) throw new Error(`The model field for agent ${index} is not on the page.`);
  await view.type(input, model);
}

/** Hold responses for `paths` until `release()` is called. */
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

beforeEach(() => {
  api.requested = [];
  api.responses = new Map();
  api.failures = new Map();
  api.gate = null;
  api.gatedPaths = [];
  api.openGate = null;
  window.sessionStorage.clear();
  serveCatalogues();
});

describe('the Run a Test flow', () => {
  it('says it is loading rather than showing an empty form', async () => {
    // Nothing has answered yet: the page must state what it is waiting for.
    const release = hold(['/api/agent-comparisons', '/api/benchmarks', '/api/agents']);
    const view = await render(<TestRunner />);

    expect(view.has('Loading the experiment and benchmark catalogues')).toBe(true);
    expect(view.has('1. Select agents')).toBe(false);

    release();
    await view.settle();
    expect(view.has('1. Select agents')).toBe(true);
    await view.unmount();
  });

  it('configures the real experiment the deployment catalogue declares', async () => {
    const view = await render(<TestRunner />);

    expect(view.has('1. Select agents')).toBe(true);
    expect(view.has('2. Select benchmark')).toBe(true);
    expect(view.has('3. Review conditions')).toBe(true);

    // The card shows the benchmark the default experiment pins, resolved from the
    // benchmark catalogue rather than restated — so the name a reader sees is the
    // name the engine will run.
    expect(view.has(EXPERIMENT.benchmarkName)).toBe(true);
    expect(view.has(`${EXPERIMENT.benchmarkId}@${EXPERIMENT.benchmarkVersion}`)).toBe(true);

    // And every catalogue benchmark is one the picker can resolve to an
    // experiment. Selecting a benchmark no experiment runs would leave the flow
    // with no plan and no explanation, so this is the invariant that makes
    // offering them all honest.
    for (const benchmark of BENCHMARKS)
      expect(
        EXPERIMENTS.some(
          (entry) =>
            entry.benchmarkId === benchmark.id && entry.benchmarkVersion === benchmark.version,
        ),
        `no experiment runs ${benchmark.id}@${benchmark.version}`,
      ).toBe(true);

    // And the plan states the matrix the engine will drive, from the engine's
    // own builder rather than from a second count written in the interface.
    const plan = planFixture(EXPERIMENT.id);
    expect(view.has(`${plan.cases.length} cases per agent`)).toBe(true);
    expect(view.has(plan.experiment.verdictRule)).toBe(true);
    expect(view.has(plan.experiment.methodology)).toBe(true);
    for (const seed of plan.seeds) expect(view.has(String(seed))).toBe(true);
    await view.unmount();
  });

  it('states what is held equal before the run, not after it', async () => {
    const view = await render(<TestRunner />);

    for (const condition of [
      'Same environment',
      'Same scenarios',
      'Same seeds',
      'Same objective',
      'Same tools',
      'Same evaluation',
    ])
      expect(view.has(condition)).toBe(true);
    expect(view.has('Only the agent changes.')).toBe(true);
    await view.unmount();
  });

  it('does not offer to run until two distinct agents are named', async () => {
    const view = await render(<TestRunner />);
    const run = view.control('Run test');

    expect(run).not.toBeNull();
    // The deployment default is one agent; the second row is deliberately blank.
    expect((run as HTMLButtonElement).disabled).toBe(true);
    expect(view.has('Two distinct agents are required before this test can start.')).toBe(true);

    await nameModel(view, 1, 'model-b');
    expect((view.control('Run test') as HTMLButtonElement).disabled).toBe(false);
    await view.unmount();
  });

  it('refuses two rows that describe the same agent, and names the collision', async () => {
    const view = await render(<TestRunner />);
    // Row A already asks for the deployment default; making row B ask for the
    // same model makes them one agent, which is not a comparison.
    await nameModel(view, 1, 'model-a');

    expect(view.has('Two of the selected agents are the same configuration')).toBe(true);
    expect(view.has('bedrock@model-a')).toBe(true);
    expect((view.control('Run test') as HTMLButtonElement).disabled).toBe(true);

    // Changing one of them resolves it, and the refusal is withdrawn.
    await nameModel(view, 1, 'model-b');
    expect(view.has('Two of the selected agents are the same configuration')).toBe(false);
    expect((view.control('Run test') as HTMLButtonElement).disabled).toBe(false);
    await view.unmount();
  });

  it('shows the identity each row will be compared under', async () => {
    const view = await render(<TestRunner />);
    await nameModel(view, 1, 'vendor/model:free');

    // The slug is the identity; the model the provider is asked for is shown
    // beside it unmodified, because the slug is not the model.
    expect(view.has('identity bedrock@vendor-model-free')).toBe(true);
    expect(view.has('asked for vendor/model:free')).toBe(true);
    await view.unmount();
  });

  it('snapshots the recorded runs before it posts the run request', async () => {
    const view = await render(<TestRunner />);
    await nameModel(view, 1, 'model-b');
    api.responses.set(RUN_PATH, reportFixture());
    await view.click(view.control('Run test') as HTMLElement);

    const calls = api.requested.map((call) => `${call.method} ${call.path}`);
    const snapshot = calls.lastIndexOf('GET /api/simulations/runs');
    const post = calls.indexOf(`POST ${RUN_PATH}`);

    expect(post).toBeGreaterThanOrEqual(0);
    expect(snapshot).toBeGreaterThanOrEqual(0);
    // A run created between the request and the snapshot would be mistaken for
    // one that already existed, so the snapshot has to come first.
    expect(snapshot).toBeLessThan(post);
    await view.unmount();
  });

  it('sends the two configurations it showed, and nothing else', async () => {
    const view = await render(<TestRunner />);
    await nameModel(view, 1, 'model-b');
    api.responses.set(RUN_PATH, reportFixture());
    await view.click(view.control('Run test') as HTMLElement);

    const post = api.requested.find((call) => call.method === 'POST' && call.path === RUN_PATH);
    expect(post?.body).toBeTruthy();
    const payload = JSON.parse(post?.body ?? '{}') as {
      agents: Array<{ agentId: string; agentVersion: string; provider: string; model: string }>;
    };
    expect(payload.agents).toEqual([
      { agentId: 'bedrock', agentVersion: 'model-a', provider: 'bedrock', model: 'model-a' },
      { agentId: 'bedrock', agentVersion: 'model-b', provider: 'bedrock', model: 'model-b' },
    ]);
    // No credential, no header, no configuration the operator did not name.
    expect(Object.keys(payload)).toEqual(['agents']);
    await view.unmount();
  });

  it('shows the run as it happens, from the runs it has recorded', async () => {
    const view = await render(<TestRunner />);
    await nameModel(view, 1, 'model-b');
    // Hold the run request so the in-flight state is observable rather than
    // raced against.
    const release = hold([RUN_PATH]);
    api.responses.set(RUN_PATH, reportFixture());
    await view.click(view.control('Run test') as HTMLElement);

    expect(view.has('Test in progress')).toBe(true);
    expect(view.has('Cases recorded')).toBe(true);
    // The view states the truth about a case with no run: not started.
    expect(view.has('○')).toBe(true);
    expect(view.has('0 /')).toBe(true);
    // And it says elapsed time as a clock, never as progress.
    expect(view.has('elapsed')).toBe(true);

    release();
    await view.settle();
    await view.settle();
    await view.unmount();
  });

  it('reports a test that cannot be run in the operator’s terms', async () => {
    const view = await render(<TestRunner />);
    await nameModel(view, 1, 'model-b');
    api.failures.set(RUN_PATH, { status: 503 });
    await view.click(view.control('Run test') as HTMLElement);

    expect(view.has('The test could not be run')).toBe(true);
    expect(
      view.has(
        'This deployment cannot run one of the selected agents. Check the provider configuration and try again.',
      ),
    ).toBe(true);
    // The raw apiFetch message is never shown to an operator.
    expect(view.has('apiFetch')).toBe(false);
    await view.unmount();
  });

  it('repeats the server’s own refusal when a run is rejected', async () => {
    const view = await render(<TestRunner />);
    await nameModel(view, 1, 'model-b');
    // The comparison route refuses an over-large matrix with field errors the
    // server wrote on purpose; that wording is what the operator should see.
    api.failures.set(RUN_PATH, {
      status: 413,
      body: {
        errors: { agents: 'This experiment would drive more cases than the engine allows.' },
      },
    });
    await view.click(view.control('Run test') as HTMLElement);

    expect(view.has('This experiment would drive more cases than the engine allows.')).toBe(true);
    await view.unmount();
  });

  it('tells a signed-out operator to sign in rather than to retry', async () => {
    const view = await render(<TestRunner />);
    await nameModel(view, 1, 'model-b');
    api.failures.set(RUN_PATH, { status: 401 });
    await view.click(view.control('Run test') as HTMLElement);

    expect(view.has('Your session has expired. Sign in again to run a test.')).toBe(true);
    await view.unmount();
  });

  it('leaves nothing running when the request fails', async () => {
    const view = await render(<TestRunner />);
    await nameModel(view, 1, 'model-b');
    api.failures.set(RUN_PATH, { status: 500 });
    await view.click(view.control('Run test') as HTMLElement);

    // The execution view is gone: it must not keep claiming a test is in flight.
    expect(view.has('Test in progress')).toBe(false);
    expect(view.has('A test is already running')).toBe(false);
    expect(view.has('no case was created for it.')).toBe(true);
    await view.unmount();
  });

  it('shows the report the server returned, and says where it came from', async () => {
    const report = reportFixture();
    const view = await render(<TestRunner />);
    await nameModel(view, 1, 'model-b');
    api.responses.set(RUN_PATH, report);
    await view.click(view.control('Run test') as HTMLElement);
    await view.settle();

    expect(view.has('Test complete')).toBe(true);
    // The report is the engine's, rendered whole: the verdict is on the page.
    expect(view.has(report.verdict.outcome.replaceAll('_', ' '))).toBe(true);
    expect(view.has(report.verdict.reason)).toBe(true);
    // And the interface states plainly that it computed none of it.
    expect(view.has('none of it was computed in the browser')).toBe(true);
    expect(view.has('A comparison report is not stored.')).toBe(true);
    await view.unmount();
  });

  it('states a catalogue failure instead of an empty form', async () => {
    api.failures.set('/api/agent-comparisons', { status: 500 });
    const view = await render(<TestRunner />);

    expect(view.has('Catalogues unavailable')).toBe(true);
    expect(view.has('reloading the page is safe')).toBe(true);
    // No half-configured form is offered for a catalogue that never loaded.
    expect(view.has('1. Select agents')).toBe(false);
    await view.unmount();
  });
});
