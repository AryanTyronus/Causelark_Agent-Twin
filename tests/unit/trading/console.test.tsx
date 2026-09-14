//
// UI — the console shows the new benchmark, and still shows the old one.
//
// The requirement was "the picker shows both" with minimum changes to the
// console, so the interesting assertion is not that a page renders — it is that
// it renders the trading benchmark *without having been taught about it*. Every
// surface below maps over the catalogue it is served, and the catalogue is the
// deployment's own compiled registry. If a trading row appears, it is because
// registration put it there, not because a component was edited to name it.
//
// The second assertion in each pair is the one the phase is really about: the
// resource benchmark is still first, still under its own name, still with its
// own conditions. A picker that gained a row by displacing one would pass a
// naive "does the new name appear" test and fail a reader.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ApiCall {
  path: string;
  method: string;
}

const api = vi.hoisted(() => ({
  requested: [] as ApiCall[],
  responses: new Map<string, unknown>(),
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: async (path: string, init?: { method?: string }) => {
    api.requested.push({ path, method: init?.method ?? 'GET' });
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

import BenchmarksPage from '@/app/(dashboard)/dashboard/benchmarks/page';
import { listBenchmarkSummaries } from '@/lib/benchmarks/catalog';
import { getSimulationOptions } from '@/lib/business/simulation';
import { listExperimentSummaries } from '@/lib/comparison/catalog';
import { render } from '../agent-twin/render';

/** The deployment's real catalogues, as the endpoints serve them. */
const BENCHMARKS = listBenchmarkSummaries();
const EXPERIMENTS = listExperimentSummaries();

const TRADING_NAME = '$10K Trading Challenge';
const TRADING_DESCRIPTION =
  'Evaluate autonomous financial decision-making with a fixed $10,000 simulated portfolio under changing market conditions and risk constraints.';
const RESOURCE_NAME = 'Resource Routing Robustness';

function serve(): void {
  api.responses.set('/api/benchmarks', { benchmarks: BENCHMARKS });
  api.responses.set('/api/agent-comparisons', { experiments: EXPERIMENTS });
}

beforeEach(() => {
  api.requested = [];
  api.responses = new Map();
  window.history.replaceState({}, '', '/dashboard/benchmarks');
});

describe('the benchmark picker offers both benchmarks', () => {
  it('reads the catalogue the deployment ships', async () => {
    serve();
    const view = await render(<BenchmarksPage />);
    await view.settle();
    expect(api.requested.map((call) => call.path)).toContain('/api/benchmarks');
    // The catalogue really does carry two, so a page that showed one would be
    // dropping a row rather than being served one.
    expect(BENCHMARKS).toHaveLength(2);
  });

  it('shows the $10K Trading Challenge with its published name and description', async () => {
    serve();
    const view = await render(<BenchmarksPage />);
    await view.settle();
    expect(view.has(TRADING_NAME)).toBe(true);
    expect(view.has(TRADING_DESCRIPTION)).toBe(true);
    // And its own conditions, not the other benchmark's.
    expect(view.has('trading-baseline')).toBe(false);
    expect(view.has('7')).toBe(true);
  });

  it('keeps Resource Routing Robustness in the list, unchanged and first', async () => {
    serve();
    const view = await render(<BenchmarksPage />);
    await view.settle();
    expect(view.has(RESOURCE_NAME)).toBe(true);
    const text = view.text();
    expect(text.indexOf(RESOURCE_NAME)).toBeGreaterThan(-1);
    expect(text.indexOf(RESOURCE_NAME)).toBeLessThan(text.indexOf(TRADING_NAME));
    expect(RESOURCE_NAME).toBe(BENCHMARKS[0]?.name);
  });
});

describe('each benchmark row describes itself from its own definition', () => {
  it('names the world, the objective and the case count of each benchmark', async () => {
    serve();
    const view = await render(<BenchmarksPage />);
    await view.settle();
    // The row is built from the catalogue entry, so these are the definition's
    // own values rather than anything the page chose.
    expect(view.has('trading-10k')).toBe(true);
    expect(view.has('grow-capital-disciplined')).toBe(true);
    expect(view.has('resource-routing')).toBe(true);
    expect(view.has('complete-delivery')).toBe(true);
    // Each row reports its own facts, and each definition really declares seven
    // conditions at one seed, so the number a reader sees is the number that
    // will run.
    for (const label of ['Environment', 'Objective', 'Conditions', 'Seeds', 'Cases'])
      expect(view.has(label), label).toBe(true);
    expect(BENCHMARKS.map((benchmark) => benchmark.scenarioCount)).toEqual([7, 7]);
    expect(BENCHMARKS.map((benchmark) => benchmark.seedCount)).toEqual([1, 1]);
    expect(BENCHMARKS.map((benchmark) => benchmark.caseCount)).toEqual([7, 7]);
  });

  it('reports the comparison registered over each benchmark, by its own id', async () => {
    serve();
    const view = await render(<BenchmarksPage />);
    await view.settle();
    expect(EXPERIMENTS).toHaveLength(2);
    // Both rows say which experiment runs them, and neither row falls into the
    // "no comparison is registered" notice — which is what a benchmark that
    // gained a definition but no template would show.
    expect(view.has('resource-routing-agent-comparison@1')).toBe(true);
    expect(view.has('trading-10k-agent-comparison@1')).toBe(true);
    expect(view.has('No comparison experiment is registered over this benchmark yet')).toBe(false);
    const benchmarkIds = EXPERIMENTS.map((experiment) => experiment.benchmarkId);
    expect(new Set(benchmarkIds).size).toBe(2);
  });
});

describe('the simulation lab’s own environment picker is untouched', () => {
  it('still offers the resource world, with its objectives and no second world', () => {
    // The lab form and the benchmark picker are different surfaces reading
    // different endpoints. This phase added a benchmark; it did not add a
    // second world to the lab form, and the run starter that reads it still
    // builds a resource run exactly as it did. Stated as a test so that the
    // boundary between "registered as a benchmark" and "startable by hand from
    // the lab" is a documented decision rather than an accident.
    const options = getSimulationOptions();
    expect(options.environments).toHaveLength(1);
    expect(options.environments[0]?.key).toBe('resource-routing');
    expect(options.environments[0]?.title).toBe('Resource routing');
    // Its objectives are the resource world's, and the trading objective is not
    // among them — a form that offered it would submit a run the lab cannot
    // configure.
    expect(options.objectives.map((objective) => objective.key)).not.toContain(
      'grow-capital-disciplined',
    );
  });
});
