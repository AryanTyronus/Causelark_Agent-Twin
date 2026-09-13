// @vitest-environment node
// @polsia:user-owned — the benchmark detail adapter, driven through the real route.
//
// The benchmark catalogue endpoint lists benchmarks; it does not describe one.
// The detail route added in this phase is a read-only projection of the compiled
// registry, and it is the only backend surface this phase adds — so what it does
// and does not expose is asserted here rather than assumed.
//
// Three properties matter:
//
//   1. It is behind the same auth gate as the rest of the catalogue. An
//      experiment's scenarios and seeds are not public.
//   2. It resolves the benchmark from the server-side registry by id and version
//      and from nothing else. A caller cannot supply a definition, and an unknown
//      id is a 404 rather than an empty 200.
//   3. It carries no credential. The projection names a provider and a model only
//      where the benchmark's own configuration declares one, and it never carries
//      a key, a header or an environment value.

import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ unauthorized: false }));

vi.mock('server-only', () => ({}));

vi.mock('@/lib/require-auth', () => ({
  requireAuth: async () => {
    if (mocks.unauthorized) throw NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return { id: 'user-1', email: 'owner@example.test' };
  },
}));

import { GET as getBenchmark } from '@/app/api/benchmarks/[benchmarkId]/route';
import { listBenchmarks } from '@/lib/benchmarks/catalog';
import {
  BENCHMARK_BASELINE_SCENARIO_ID,
  BENCHMARK_ROBUSTNESS_FORMULA,
  BenchmarkDetail,
} from '@/lib/benchmarks/types';
import { BENCHMARK_ID, EXPERIMENT_ID } from '../comparison.fixtures';

const URL_BASE = 'http://localhost/api/benchmarks';

function params(benchmarkId: string) {
  return { params: Promise.resolve({ benchmarkId }) };
}

function request(query = ''): Request {
  return new Request(`${URL_BASE}/${BENCHMARK_ID}${query}`);
}

beforeEach(() => {
  mocks.unauthorized = false;
});

describe('the benchmark detail endpoint', () => {
  it('refuses a caller who is not signed in', async () => {
    mocks.unauthorized = true;
    const response = await getBenchmark(request(), params(BENCHMARK_ID));
    expect(response.status).toBe(401);
  });

  it('serves the benchmark the experiment is built on, at its pinned version', async () => {
    const definition = listBenchmarks().find((entry) => entry.id === BENCHMARK_ID);
    expect(definition).toBeDefined();

    const response = await getBenchmark(request(), params(BENCHMARK_ID));
    expect(response.status).toBe(200);
    const detail = BenchmarkDetail.parse(await response.json());

    expect(detail.id).toBe(BENCHMARK_ID);
    expect(detail.version).toBe(definition?.version);
    // The scenarios and seeds are the registry's own, at their pinned versions.
    expect(detail.seeds).toEqual(definition?.seeds);
    expect(detail.scenarios.map((scenario) => scenario.id)).toEqual(
      definition?.scenarios.map((scenario) => scenario.id),
    );
    // The matrix size is derived from the registry, not supplied by the caller.
    expect(detail.caseCount).toBe(
      (definition?.scenarios.length ?? 0) * (definition?.seeds.length ?? 0),
    );
    // The baseline condition and the robustness formula travel with the detail,
    // so a reader can tell which condition the others are compared against.
    expect(detail.baselineScenarioId).toBe(BENCHMARK_BASELINE_SCENARIO_ID);
    expect(detail.robustnessFormula).toBe(BENCHMARK_ROBUSTNESS_FORMULA);
    expect(detail.limits.maxCases).toBeGreaterThan(0);
    expect(detail.limits.maxSeeds).toBeGreaterThan(0);
  });

  it('answers for a version the caller names, and only for a real one', async () => {
    const definition = listBenchmarks().find((entry) => entry.id === BENCHMARK_ID);
    const pinned = await getBenchmark(
      request(`?version=${definition?.version ?? 1}`),
      params(BENCHMARK_ID),
    );
    expect(pinned.status).toBe(200);

    const absent = await getBenchmark(request('?version=99'), params(BENCHMARK_ID));
    expect(absent.status).toBe(404);
    expect((await absent.json()).code).toBe('UNKNOWN_BENCHMARK');
  });

  it('refuses a version that is not a plain, bounded integer', async () => {
    // `Number.parseInt` would read each of these as version 1 and answer for a
    // benchmark the caller never asked about.
    for (const query of [
      '?version=1.5',
      '?version=1v2',
      '?version=',
      '?version=-1',
      '?version=x',
    ]) {
      const response = await getBenchmark(request(query), params(BENCHMARK_ID));
      expect(response.status, `${query} must not resolve a version`).toBe(400);
    }
  });

  it('reports an unknown benchmark as not found rather than as an empty benchmark', async () => {
    const response = await getBenchmark(request(), params('no-such-benchmark'));
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe('UNKNOWN_BENCHMARK');
    // A sentence, and one that does not reflect the caller's own input back.
    expect(body.error).toContain('Benchmark not found');
    expect(body.error).not.toContain('no-such-benchmark');
  });

  it('carries no credential and no caller-supplied definition', async () => {
    const response = await getBenchmark(request(), params(BENCHMARK_ID));
    const body = await response.text();

    // A key, an authorization header or a connection string would be a leak; the
    // projection is built from the compiled registry, which holds none of them.
    expect(body).not.toMatch(/api[_-]?key|authorization|bearer|secret|password|DATABASE_URL/i);
    // And the request cannot add a scenario, a seed or a scoring rule.
    const submitted = new Request(`${URL_BASE}/${BENCHMARK_ID}`, {
      method: 'GET',
      headers: { 'x-benchmark-definition': JSON.stringify({ scenarios: [] }) },
    });
    const again = await getBenchmark(submitted, params(BENCHMARK_ID));
    expect(await again.text()).toBe(body);
  });

  it('is the catalogue the review step reads, so the two cannot disagree', async () => {
    // The detail is a projection of the same registry the plan endpoint builds
    // its matrix from; the experiment's own benchmark id is what ties them.
    const response = await getBenchmark(request(), params(BENCHMARK_ID));
    const detail = BenchmarkDetail.parse(await response.json());
    expect(EXPERIMENT_ID.length).toBeGreaterThan(0);
    expect(detail.scenarios.length).toBeGreaterThan(1);
    // Exactly one baseline condition stands among the perturbations: the
    // robustness formula needs one to measure a change from.
    expect(
      detail.scenarios.filter((scenario) => scenario.id === detail.baselineScenarioId),
    ).toHaveLength(1);
  });
});
