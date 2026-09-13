//
// The overview is the first screen of the product, and the only screen that has
// to answer "what is this" before it answers anything else. Three properties
// matter, and each is asserted here by reading the page:
//
//   1. It states what the product is, and how a test works, before it states a
//      number. A reader who has run nothing still learns what a benchmark is.
//   2. An account with no runs is told so in words and offered the way to make
//      one. Absence is a state, and the page never leaves a reader to read an
//      empty region as a result.
//   3. A catalogue that cannot be read is reported as text — including one the
//      session was refused. The page must never look empty-but-fine, because
//      "you have run nothing" and "we could not ask" are different findings and
//      only one of them is true.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  requested: [] as string[],
  responses: new Map<string, unknown>(),
  failures: new Map<string, number>(),
  /** Paths whose response waits on `gate` — used to hold a response in flight. */
  hold: null as { paths: string[]; gate: Promise<void> } | null,
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: async (path: string) => {
    api.requested.push(path);
    if (api.hold?.paths.includes(path)) await api.hold.gate;
    if (api.failures.has(path))
      throw new Error(`apiFetch ${path} failed (${api.failures.get(path)})`);
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

import DashboardPage from '@/app/(dashboard)/dashboard/page';
import { listBenchmarkSummaries } from '@/lib/benchmarks/catalog';
import { listExperimentSummaries } from '@/lib/comparison/catalog';
import { render } from './render';

const RUNS_PATH = '/api/simulations/runs';
const BENCHMARKS_PATH = '/api/benchmarks';
const EXPERIMENTS_PATH = '/api/agent-comparisons';

const BENCHMARKS = listBenchmarkSummaries();
const EXPERIMENTS = listExperimentSummaries();

/**
 * One recorded run, in the shape the runs endpoint serves.
 *
 * Hand-written because the real summary is a projection of a persisted row, and
 * what is under test is what the page does with the fields — not the projection.
 */
function runSummary(input: {
  id: string;
  scenario?: { id: string; version: number } | null;
  seed: number;
  status?: string;
  terminationReason?: string | null;
}) {
  return {
    id: input.id,
    environmentKey: 'resource-routing',
    objectiveKey: 'complete-delivery',
    seed: input.seed,
    status: input.status ?? 'COMPLETED',
    agentStatus: 'COMPLETED',
    step: 12,
    maxSteps: 24,
    budgetRemaining: 4,
    scenario: input.scenario ?? null,
    terminationReason: input.terminationReason ?? null,
    failureDetails: null,
    createdAt: '2026-09-13T09:15:00.000Z',
    updatedAt: '2026-09-13T09:16:00.000Z',
  };
}

function serve(input: { runs: unknown[] }): void {
  api.responses.set(RUNS_PATH, { runs: input.runs });
  api.responses.set(BENCHMARKS_PATH, { benchmarks: BENCHMARKS });
  api.responses.set(EXPERIMENTS_PATH, { experiments: EXPERIMENTS });
}

/** Hold responses for `paths` until `release()` is called. */
function hold(paths: string[]): () => void {
  let open: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  api.hold = { paths, gate };
  return () => {
    api.hold = null;
    open?.();
  };
}

beforeEach(() => {
  api.requested = [];
  api.responses = new Map();
  api.failures = new Map();
  api.hold = null;
});

describe('the overview', () => {
  it('states what the product is, and how a test works, before any number', async () => {
    serve({ runs: [] });
    const view = await render(<DashboardPage />);
    const text = view.text();

    expect(text).toContain('Autonomous Agent Testing Laboratory');
    expect(text).toContain('Test autonomous intelligence before it touches the real world.');

    // The pipeline, in the order the product actually performs it.
    for (const step of [
      'Agent',
      'Simulated world',
      'Adversarial scenarios',
      'Measure',
      'Analyze',
      'Compare',
    ])
      expect(text).toContain(step);
    expect(text).toContain('What it actually did, scored by the evaluation engine.');

    // And the promise a comparison makes, stated before one is run.
    expect(text).toContain('Only the agent changes.');
    await view.unmount();
  });

  it('says it is loading rather than showing an empty account', async () => {
    serve({ runs: [] });
    const release = hold([RUNS_PATH, BENCHMARKS_PATH, EXPERIMENTS_PATH]);
    const view = await render(<DashboardPage />);

    // Nothing has answered: a skeleton, not a claim about the account.
    expect(view.has('Loading recorded runs')).toBe(true);
    expect(view.has('Loading benchmarks')).toBe(true);
    expect(view.has('No tests yet')).toBe(false);

    release();
    await view.settle();
    expect(view.has('Loading recorded runs')).toBe(false);
    expect(view.has('No tests yet')).toBe(true);
    await view.unmount();
  });

  it('tells a new account it has run nothing, and offers the way to start', async () => {
    serve({ runs: [] });
    const view = await render(<DashboardPage />);

    expect(view.has('No tests yet')).toBe(true);
    expect(view.has('Run your first autonomous agent through the simulator.')).toBe(true);
    // The empty state carries its own way out rather than leaving a dead end.
    expect(view.control('Run a test')).not.toBeNull();
    await view.unmount();
  });

  it('lists the recorded runs with the facts each one carries', async () => {
    serve({
      runs: [
        runSummary({ id: 'run-1', scenario: { id: 'baseline', version: 1 }, seed: 1042 }),
        runSummary({
          id: 'run-2',
          scenario: { id: 'scarcity-shock', version: 2 },
          seed: 7,
          status: 'FAILED',
          terminationReason: 'BUDGET_EXHAUSTED',
        }),
      ],
    });
    const view = await render(<DashboardPage />);

    // The scenario is named by its pinned identity, not by its bare id.
    expect(view.has('baseline@1')).toBe(true);
    expect(view.has('scarcity shock@2')).toBe(true);
    expect(view.has('1042')).toBe(true);
    expect(view.has('complete-delivery')).toBe(true);
    // The status is a word, and so is the reason it ended.
    expect(view.has('COMPLETED')).toBe(true);
    expect(view.has('FAILED')).toBe(true);
    expect(view.has('BUDGET_EXHAUSTED')).toBe(true);
    expect(view.has('2026-09-13 09:15:00')).toBe(true);

    // Each row opens the run it names — the durable evidence, one click away.
    const opened = view.all('a').map((anchor) => anchor.getAttribute('href'));
    expect(opened).toContain('/dashboard/simulations/run-1');
    expect(opened).toContain('/dashboard/simulations/run-2');
    await view.unmount();
  });

  it('reports a run that recorded no scenario as an absence, not as a value', async () => {
    serve({ runs: [runSummary({ id: 'run-1', seed: 3 })] });
    const view = await render(<DashboardPage />);

    expect(view.has('not recorded')).toBe(true);
    await view.unmount();
  });

  it('shows the recent runs, and says where the rest are', async () => {
    serve({
      runs: Array.from({ length: 10 }, (_, index) =>
        runSummary({ id: `run-${index}`, seed: 100 + index }),
      ),
    });
    const view = await render(<DashboardPage />);

    // "Recent" is a bounded list, and the bound is stated by a link to the whole
    // record rather than by a truncated table that looks complete.
    expect(view.all('tbody tr')).toHaveLength(8);
    const hrefs = view.all('a').map((anchor) => anchor.getAttribute('href'));
    expect(hrefs).toContain('/dashboard/simulations');
    await view.unmount();
  });

  it('describes each catalogued benchmark as a standardised test', async () => {
    serve({ runs: [] });
    const view = await render(<DashboardPage />);

    expect(view.has('A benchmark is a standardised test')).toBe(true);
    for (const benchmark of BENCHMARKS) {
      expect(view.has(benchmark.name)).toBe(true);
      expect(view.has(`${benchmark.id}@${benchmark.version}`)).toBe(true);
      expect(view.has(benchmark.environmentKey)).toBe(true);
      expect(view.has(benchmark.objectiveKey)).toBe(true);
      expect(view.has(String(benchmark.scenarioCount))).toBe(true);
      expect(view.has(String(benchmark.seedCount))).toBe(true);
    }
    // The overview links to the benchmark's own page at the version it showed.
    const hrefs = view.all('a').map((anchor) => anchor.getAttribute('href'));
    for (const benchmark of BENCHMARKS)
      expect(hrefs).toContain(`/dashboard/benchmarks/${benchmark.id}?version=${benchmark.version}`);
    await view.unmount();
  });

  it('reports a catalogue it could not read instead of an empty account', async () => {
    for (const path of [RUNS_PATH, BENCHMARKS_PATH, EXPERIMENTS_PATH]) api.failures.set(path, 500);
    const view = await render(<DashboardPage />);

    expect(view.has('Catalogues unavailable')).toBe(true);
    expect(view.has('The Agent Twin catalogues could not be loaded.')).toBe(true);
    expect(view.has('Reloading the page is safe')).toBe(true);
    // The critical one: "we could not ask" is never rendered as "you have run
    // nothing". The page keeps saying it does not know.
    expect(view.has('No tests yet')).toBe(false);
    expect(view.has('Loading recorded runs')).toBe(true);
    await view.unmount();
  });

  it('does not report a refused session as an account with no runs', async () => {
    for (const path of [RUNS_PATH, BENCHMARKS_PATH, EXPERIMENTS_PATH]) api.failures.set(path, 401);
    const view = await render(<DashboardPage />);

    expect(view.has('Catalogues unavailable')).toBe(true);
    expect(view.has('No tests yet')).toBe(false);
    // And no raw client error, status code or response body reaches the reader.
    const text = view.text();
    for (const leak of ['apiFetch', '401', 'Unauthorized', '{}']) expect(text).not.toContain(leak);
    await view.unmount();
  });
});
