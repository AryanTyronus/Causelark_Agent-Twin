// @polsia:user-owned — one benchmark in full.
//
// The catalogue endpoint lists how large each benchmark is; this one answers what
// a benchmark is. It is the smallest adapter that makes a benchmark page possible:
// a read-only projection of the compiled registry, resolving the id and version
// through the same `getBenchmark` the execution path uses, so a page can never
// describe a benchmark that could not be run.
//
// Nothing here resolves configuration against a credential, reads the filesystem,
// or accepts a definition from the request. An id that does not match a compiled
// benchmark is a 404, and a version the catalogue does not ship is a 404 too —
// never a silent upgrade to the version that happens to be current.

import 'server-only';

import { NextResponse } from 'next/server';
import { findBenchmark } from '@/lib/benchmarks/catalog';
import {
  BENCHMARK_BASELINE_SCENARIO_ID,
  BENCHMARK_ROBUSTNESS_FORMULA,
  BenchmarkDetail,
  MAX_BENCHMARK_CASES,
  MAX_BENCHMARK_SEEDS,
} from '@/lib/benchmarks/types';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, context: { params: Promise<{ benchmarkId: string }> }) {
  try {
    await requireAuth(req);
  } catch (res) {
    return res as Response;
  }

  const { benchmarkId } = await context.params;
  const requested = new URL(req.url).searchParams.get('version');
  const version = requested === null ? null : Number.parseInt(requested, 10);
  if (requested !== null && !/^\d{1,6}$/.test(requested)) {
    return NextResponse.json({ error: 'version must be a small integer.' }, { status: 400 });
  }

  const benchmark = findBenchmark(benchmarkId, version);
  if (!benchmark) {
    return NextResponse.json(
      { error: 'Benchmark not found', code: 'UNKNOWN_BENCHMARK' },
      { status: 404 },
    );
  }

  return NextResponse.json(
    BenchmarkDetail.parse({
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
    }),
  );
}
