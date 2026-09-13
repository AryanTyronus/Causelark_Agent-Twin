// @polsia:user-owned — the benchmark catalogue and one benchmark's page.
//
// A benchmark is this product's claim of standardisation, so both pages are
// tested for the thing that claim rests on: that what they describe is the
// compiled definition rather than a description maintained beside it.
//
//   1. The catalogue states each benchmark's fixed inputs — environment,
//      objective, conditions, seeds, cases — and whether anything can actually
//      be run against it.
//   2. The detail page names the conditions at their pinned versions, and marks
//      exactly one of them as the baseline robustness is measured from.
//   3. The detail page asks for the version the caller named, and a benchmark
//      the deployment does not publish is reported as missing rather than shown
//      as an empty specification.
//
// The catalogues read here are the deployment's real ones: a fixture could
// describe a benchmark that would not run, which is the one thing this page must
// never do.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  requested: [] as string[],
  responses: new Map<string, unknown>(),
  failures: new Map<string, number>(),
  query: new URLSearchParams(),
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

vi.mock('next/navigation', () => ({
  useSearchParams: () => api.query,
}));

import BenchmarksPage from '@/app/(dashboard)/dashboard/benchmarks/page';
import { BenchmarkDetailView } from '@/components/custom/agent-twin/benchmark-detail';
import { findBenchmark, listBenchmarkSummaries } from '@/lib/benchmarks/catalog';
import {
  BENCHMARK_BASELINE_SCENARIO_ID,
  BENCHMARK_ROBUSTNESS_FORMULA,
  type BenchmarkDetail,
  BenchmarkDetail as BenchmarkDetailSchema,
  MAX_BENCHMARK_CASES,
  MAX_BENCHMARK_SEEDS,
} from '@/lib/benchmarks/types';
import { listExperimentSummaries } from '@/lib/comparison/catalog';
import { render } from './render';

const CATALOGUE_PATH = '/api/benchmarks';
const EXPERIMENTS_PATH = '/api/agent-comparisons';

const BENCHMARKS = listBenchmarkSummaries();
const EXPERIMENTS = listExperimentSummaries();
const BENCHMARK = BENCHMARKS[0];
if (!BENCHMARK) throw new Error('Fixture: the deployment ships no benchmarks.');

function serveCatalogue(): void {
  api.responses.set(CATALOGUE_PATH, { benchmarks: BENCHMARKS });
  api.responses.set(EXPERIMENTS_PATH, { experiments: EXPERIMENTS });
}

/**
 * The detail the endpoint serves for one benchmark.
 *
 * Built from the compiled registry exactly the way the route builds it — the
 * same `findBenchmark`, the same limits — and parsed against the served shape,
 * so a fixture cannot describe a detail the route would not emit.
 */
function detailFixture(benchmarkId: string, version: number | null = null): BenchmarkDetail {
  const benchmark = findBenchmark(benchmarkId, version);
  if (!benchmark) throw new Error(`Fixture: ${benchmarkId} is not in the compiled registry.`);
  return BenchmarkDetailSchema.parse({
    id: benchmark.id,
    version: benchmark.version,
    name: benchmark.name,
    description: benchmark.description,
    environmentKey: benchmark.environmentKey,
    objectiveKey: benchmark.objectiveKey,
    scenarios: benchmark.scenarios,
    seeds: benchmark.seeds,
    caseCount: benchmark.scenarios.length * benchmark.seeds.length,
    baselineScenarioId: BENCHMARK_BASELINE_SCENARIO_ID,
    robustnessFormula: BENCHMARK_ROBUSTNESS_FORMULA,
    configuration: benchmark.configuration ?? null,
    limits: { maxCases: MAX_BENCHMARK_CASES, maxSeeds: MAX_BENCHMARK_SEEDS },
  });
}

/** The benchmark's compiled definition, for asserting against what it declares. */
function definitionOf(benchmarkId: string) {
  const definition = findBenchmark(benchmarkId, null);
  if (!definition) throw new Error(`Fixture: ${benchmarkId} is not in the compiled registry.`);
  return definition;
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
  api.query = new URLSearchParams();
  api.hold = null;
  serveCatalogue();
});

describe('the benchmark catalogue', () => {
  it('states each benchmark’s fixed inputs, so two results can be compared', async () => {
    const view = await render(<BenchmarksPage />);

    expect(view.has('Standardised tests')).toBe(true);
    expect(view.has('Every benchmark fixes its environment, its conditions')).toBe(true);
    for (const benchmark of BENCHMARKS) {
      expect(view.has(benchmark.name)).toBe(true);
      expect(view.has(`${benchmark.id}@${benchmark.version}`)).toBe(true);
      expect(view.has(benchmark.description)).toBe(true);
      expect(view.has(benchmark.environmentKey)).toBe(true);
      expect(view.has(benchmark.objectiveKey)).toBe(true);
      expect(view.has(String(benchmark.caseCount))).toBe(true);
    }
    await view.unmount();
  });

  it('says which benchmarks can actually be run as a comparison', async () => {
    const view = await render(<BenchmarksPage />);
    const served = EXPERIMENTS.filter(
      (experiment) =>
        experiment.benchmarkId === BENCHMARK.id &&
        experiment.benchmarkVersion === BENCHMARK.version,
    );

    if (served.length > 0)
      expect(view.has(`${served.length} comparison experiment(s) run this benchmark`)).toBe(true);
    else
      expect(view.has('No comparison experiment is registered over this benchmark yet')).toBe(true);
    await view.unmount();
  });

  it('offers each benchmark at the exact version it described', async () => {
    const view = await render(<BenchmarksPage />);
    const hrefs = view.all('a').map((anchor) => anchor.getAttribute('href'));

    for (const benchmark of BENCHMARKS)
      expect(hrefs).toContain(`/dashboard/benchmarks/${benchmark.id}?version=${benchmark.version}`);
    await view.unmount();
  });

  it('says so when the deployment ships no benchmarks at all', async () => {
    api.responses.set(CATALOGUE_PATH, { benchmarks: [] });
    const view = await render(<BenchmarksPage />);

    expect(view.has('This deployment ships no benchmarks')).toBe(true);
    await view.unmount();
  });

  it('reports a catalogue it could not read rather than an empty catalogue', async () => {
    api.failures.set(CATALOGUE_PATH, 500);
    const view = await render(<BenchmarksPage />);

    expect(view.has('Benchmark catalogue unavailable')).toBe(true);
    expect(view.has('reloading the page is safe')).toBe(true);
    // An unreadable registry is never rendered as "this deployment ships none".
    expect(view.has('This deployment ships no benchmarks')).toBe(false);
    expect(view.has('apiFetch')).toBe(false);
    await view.unmount();
  });

  it('says it is loading rather than showing a catalogue of nothing', async () => {
    const release = hold([CATALOGUE_PATH, EXPERIMENTS_PATH]);
    const view = await render(<BenchmarksPage />);

    // Nothing has answered: the page names what it is waiting for rather than
    // rendering an empty catalogue that would read as a result.
    expect(view.has('Loading the benchmark catalogue')).toBe(true);
    expect(view.has('This deployment ships no benchmarks')).toBe(false);

    release();
    await view.settle();
    expect(view.has('Loading the benchmark catalogue')).toBe(false);
    expect(view.has('Standardised tests')).toBe(true);
    await view.unmount();
  });
});

describe('one benchmark', () => {
  it('asks for the benchmark and the version the caller named', async () => {
    // The version travels in the query, so the response is keyed with it too:
    // asking for a version the page did not name would be the defect.
    api.responses.set(
      `${CATALOGUE_PATH}/${BENCHMARK.id}?version=${BENCHMARK.version}`,
      detailFixture(BENCHMARK.id, BENCHMARK.version),
    );
    api.query = new URLSearchParams(`version=${BENCHMARK.version}`);
    const view = await render(<BenchmarkDetailView benchmarkId={BENCHMARK.id} />);

    expect(api.requested).toContain(
      `${CATALOGUE_PATH}/${BENCHMARK.id}?version=${BENCHMARK.version}`,
    );
    expect(view.has('Specification')).toBe(true);
    expect(view.has(`${BENCHMARK.id}@${BENCHMARK.version}`)).toBe(true);
    await view.unmount();
  });

  it('names the conditions at their pinned versions, with one baseline', async () => {
    const definition = definitionOf(BENCHMARK.id);
    api.responses.set(`${CATALOGUE_PATH}/${BENCHMARK.id}`, detailFixture(BENCHMARK.id));
    const view = await render(<BenchmarkDetailView benchmarkId={BENCHMARK.id} />);

    // Every condition, at the version it is pinned to, in matrix order.
    for (const scenario of definition.scenarios) {
      expect(view.has(scenario.id.replaceAll('-', ' '))).toBe(true);
      expect(view.has(String(scenario.version))).toBe(true);
    }
    // Exactly one of them is the baseline; the rest are perturbations.
    expect(view.all('tbody tr')).toHaveLength(definition.scenarios.length);
    expect(
      view.all('tbody tr').filter((row) => row.textContent?.includes('baseline')),
    ).toHaveLength(1);
    expect(view.has(BENCHMARK_BASELINE_SCENARIO_ID.replaceAll('-', ' '))).toBe(true);
    // And the matrix is stated as arithmetic a reader can check.
    expect(view.has(`${definition.scenarios.length} condition(s)`)).toBe(true);
    expect(view.has(`${definition.seeds.length} seed(s)`)).toBe(true);
    await view.unmount();
  });

  it('attributes the robustness figure to the engine and says what it measures', async () => {
    api.responses.set(`${CATALOGUE_PATH}/${BENCHMARK.id}`, detailFixture(BENCHMARK.id));
    const view = await render(<BenchmarkDetailView benchmarkId={BENCHMARK.id} />);
    const text = view.text();

    expect(text).toContain(BENCHMARK_ROBUSTNESS_FORMULA);
    expect(text).toContain('retains its baseline performance when the environment changes');
    // The engine's own convention for absent evidence is stated on the page.
    expect(text).toContain('“unavailable” rather than zero');
    // Provenance is a word on the panel, not a colour.
    expect(text).toContain('Benchmark engine');
    await view.unmount();
  });

  it('states the limits the engine will refuse, before anything runs', async () => {
    api.responses.set(`${CATALOGUE_PATH}/${BENCHMARK.id}`, detailFixture(BENCHMARK.id));
    const view = await render(<BenchmarkDetailView benchmarkId={BENCHMARK.id} />);

    expect(view.has('What the engine will refuse, before anything runs.')).toBe(true);
    expect(view.has(`${MAX_BENCHMARK_CASES} cases`)).toBe(true);
    await view.unmount();
  });

  it('reports a benchmark this deployment does not publish as missing', async () => {
    api.failures.set(`${CATALOGUE_PATH}/no-such-benchmark`, 404);
    const view = await render(<BenchmarkDetailView benchmarkId="no-such-benchmark" />);

    expect(view.has('Benchmark not found')).toBe(true);
    expect(view.has('no-such-benchmark')).toBe(true);
    // The distinction that matters: it cannot be substituted, and the page says
    // why rather than offering an empty specification to fill in.
    expect(view.has('cannot be substituted for it')).toBe(true);
    expect(view.has('Specification')).toBe(false);
    expect(view.has('apiFetch')).toBe(false);
    await view.unmount();
  });

  it('reports an unreadable definition differently from a missing one', async () => {
    api.failures.set(`${CATALOGUE_PATH}/${BENCHMARK.id}`, 500);
    const view = await render(<BenchmarkDetailView benchmarkId={BENCHMARK.id} />);

    // A deployment that cannot read its own registry is not a 404, and the page
    // does not tell the reader the benchmark does not exist.
    expect(view.has('Benchmark unavailable')).toBe(true);
    expect(view.has('Benchmark not found')).toBe(false);
    expect(view.has('Nothing was run and no data was changed.')).toBe(true);
    await view.unmount();
  });

  it('says it is loading rather than showing an empty specification', async () => {
    api.responses.set(`${CATALOGUE_PATH}/${BENCHMARK.id}`, detailFixture(BENCHMARK.id));
    const release = hold([`${CATALOGUE_PATH}/${BENCHMARK.id}`]);
    const view = await render(<BenchmarkDetailView benchmarkId={BENCHMARK.id} />);

    // Nothing has answered: an empty specification would read as a benchmark
    // with no conditions in it, which is not a state a benchmark can be in.
    expect(view.has('Loading the benchmark definition')).toBe(true);
    expect(view.has('Specification')).toBe(false);

    release();
    await view.settle();
    expect(view.has('Loading the benchmark definition')).toBe(false);
    expect(view.has('Specification')).toBe(true);
    await view.unmount();
  });
});
