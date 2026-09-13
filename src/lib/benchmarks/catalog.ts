//
// A frozen, in-process registry built once from the shipped definitions, in the
// same shape as the scenario catalogue beside it. There is no filesystem
// discovery, no dynamic import and no user-supplied code path: an id from a
// request can only ever match a benchmark that is compiled into this module,
// and a version that does not match is refused rather than silently upgraded to
// whatever the catalogue holds today.
//
// Every definition is validated at module load — its scenarios resolved against
// the scenario catalogue at the exact versions it pins, its seeds checked
// against the environment, its size checked against the engine's bound. A
// benchmark that references a scenario version the catalogue no longer ships
// fails at startup, not halfway through somebody's execution.

import { getSimulationOptions, isSupportedSeed } from '@/lib/business/simulation';
import { findScenario } from '@/lib/scenarios/catalog';
import { BENCHMARK_DEFINITIONS } from './definitions';
import { buildRunMatrix } from './matrix';
import {
  BENCHMARK_BASELINE_SCENARIO_ID,
  BenchmarkDefinition,
  BenchmarkError,
  type BenchmarkSummary,
} from './types';

const OPTION_KEYS = getSimulationOptions();

/**
 * Check a definition's references before it is allowed into the catalogue.
 *
 * Returns the parsed definition so callers can use the validated value; throws
 * `BenchmarkError` with a code that says which kind of reference was wrong.
 */
export function validateBenchmarkDefinition(candidate: unknown): BenchmarkDefinition {
  const parsed = BenchmarkDefinition.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BenchmarkError(
      'INVALID_BENCHMARK',
      `Benchmark definition is malformed: ${issue?.path.join('.') ?? 'unknown'} — ${issue?.message ?? 'invalid'}.`,
    );
  }
  const definition = parsed.data;

  // The environment is a closed catalogue, so an unknown one is an authoring
  // error rather than something to discover at execution time.
  if (!OPTION_KEYS.environments.some((entry) => entry.key === definition.environmentKey))
    throw new BenchmarkError(
      'INVALID_BENCHMARK',
      `Benchmark ${definition.id} names environment ${definition.environmentKey}, which this deployment does not publish.`,
    );
  if (!OPTION_KEYS.objectives.some((objective) => objective.key === definition.objectiveKey))
    throw new BenchmarkError(
      'INVALID_BENCHMARK',
      `Benchmark ${definition.id} names objective ${definition.objectiveKey}, which this environment does not publish.`,
    );

  const seenSeeds = new Set<number>();
  for (const seed of definition.seeds) {
    if (seenSeeds.has(seed))
      throw new BenchmarkError(
        'INVALID_BENCHMARK',
        `Benchmark ${definition.id} lists seed ${seed} more than once, which would run the same case twice.`,
      );
    seenSeeds.add(seed);
    if (!isSupportedSeed(seed))
      throw new BenchmarkError(
        'INVALID_BENCHMARK',
        `Benchmark ${definition.id} names seed ${seed}, which this environment does not publish.`,
      );
  }

  const seen = new Set<string>();
  for (const reference of definition.scenarios) {
    if (seen.has(reference.id))
      throw new BenchmarkError(
        'INVALID_BENCHMARK',
        `Benchmark ${definition.id} lists scenario ${reference.id} more than once.`,
      );
    seen.add(reference.id);
    const scenario = findScenario(reference.id, reference.version);
    if (!scenario) {
      const known = findScenario(reference.id);
      throw new BenchmarkError(
        'INVALID_SCENARIO',
        known
          ? `Benchmark ${definition.id} pins ${reference.id} at version ${reference.version}, but the catalogue only ships version ${known.version}.`
          : `Benchmark ${definition.id} references unknown scenario ${reference.id}.`,
      );
    }
  }

  // Robustness is a statement about a change, so a definition has to name the
  // condition the change is measured from.
  if (!definition.scenarios.some((entry) => entry.id === BENCHMARK_BASELINE_SCENARIO_ID))
    throw new BenchmarkError(
      'INVALID_BENCHMARK',
      `Benchmark ${definition.id} does not include the ${BENCHMARK_BASELINE_SCENARIO_ID} scenario, so it has no condition to measure degradation against.`,
    );

  // Last, because it is the only check that depends on everything above: the
  // matrix builder is the one place that decides how large a benchmark is.
  buildRunMatrix(definition);
  return definition;
}

const CATALOG: readonly BenchmarkDefinition[] = Object.freeze(
  BENCHMARK_DEFINITIONS.map((definition) => Object.freeze(validateBenchmarkDefinition(definition))),
);

/** Every benchmark, in declared catalogue order. */
export function listBenchmarks(): readonly BenchmarkDefinition[] {
  return CATALOG;
}

/**
 * One benchmark by id, optionally pinned to an exact version. Returns `null`
 * rather than throwing when there is no match.
 */
export function findBenchmark(id: string, version?: number | null): BenchmarkDefinition | null {
  const benchmark = CATALOG.find((entry) => entry.id === id);
  if (!benchmark) return null;
  if (version === undefined || version === null) return benchmark;
  return benchmark.version === version ? benchmark : null;
}

/**
 * One benchmark by id, or by id *and* version. An unknown id and a known id at
 * an unknown version are both refused, with distinct messages — a caller that
 * asked for a version this deployment does not ship needs to know that,
 * rather than being handed the current one.
 */
export function getBenchmark(id: string, version?: number | null): BenchmarkDefinition {
  const benchmark = findBenchmark(id, version);
  if (benchmark) return benchmark;
  const known = CATALOG.find((entry) => entry.id === id);
  if (!known) throw new BenchmarkError('UNKNOWN_BENCHMARK', `Unknown benchmark: ${id}.`);
  throw new BenchmarkError(
    'UNKNOWN_BENCHMARK',
    `Benchmark ${id} was requested at version ${version}, but the catalogue only ships version ${known.version}.`,
  );
}

export function benchmarkSummary(definition: BenchmarkDefinition): BenchmarkSummary {
  return {
    id: definition.id,
    version: definition.version,
    name: definition.name,
    description: definition.description,
    environmentKey: definition.environmentKey,
    objectiveKey: definition.objectiveKey,
    scenarioCount: definition.scenarios.length,
    seedCount: definition.seeds.length,
    caseCount: definition.scenarios.length * definition.seeds.length,
  };
}

/** The catalogue as the `/api/benchmarks` endpoint serves it. */
export function listBenchmarkSummaries(): BenchmarkSummary[] {
  return CATALOG.map(benchmarkSummary);
}
