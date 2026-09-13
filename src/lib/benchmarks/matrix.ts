// @polsia:user-owned — the deterministic benchmark run matrix.
//
// The matrix is the cross product of the definition's scenario list and its
// seed list, in that nesting order: every scenario runs at every seed, and the
// result reads in the order the definition was written. Nothing here iterates
// an object, sorts by a comparator, or depends on insertion order of a map, so
// two calls with the same definition produce the same array — element for
// element, including the index and the key of every cell.

import {
  BENCHMARK_BASELINE_SCENARIO_ID,
  type BenchmarkCase,
  type BenchmarkDefinition,
  BenchmarkError,
  MAX_BENCHMARK_CASES,
} from './types';

/**
 * The stable identity of a matrix cell. It names the exact experiment — which
 * condition, at which version, at which seed — and is therefore what a report
 * row and a created run are associated by. Generated run ids are references,
 * not identity: they differ between two executions of the same benchmark, and
 * nothing in the aggregation is allowed to depend on them.
 */
export function benchmarkCaseKey(
  scenarioId: string,
  scenarioVersion: number,
  seed: number,
): string {
  return `${scenarioId}@${scenarioVersion}#${seed}`;
}

/**
 * Expand a definition into its ordered cases.
 *
 * Throws rather than returning a partial matrix: a definition whose size is
 * wrong is an authoring error, and a half-built matrix would silently turn into
 * a benchmark that measured less than it claims to.
 */
export function buildRunMatrix(definition: BenchmarkDefinition): BenchmarkCase[] {
  const { scenarios, seeds } = definition;
  if (scenarios.length === 0 || seeds.length === 0)
    throw new BenchmarkError(
      'INVALID_BENCHMARK',
      `Benchmark ${definition.id} v${definition.version} has no scenarios or no seeds.`,
    );
  const size = scenarios.length * seeds.length;
  if (size > MAX_BENCHMARK_CASES)
    throw new BenchmarkError(
      'INVALID_BENCHMARK',
      `Benchmark ${definition.id} v${definition.version} expands to ${size} cases, above the ${MAX_BENCHMARK_CASES} this engine will run in one execution.`,
    );

  const cases: BenchmarkCase[] = [];
  for (const scenario of scenarios) {
    for (const seed of seeds) {
      cases.push({
        index: cases.length,
        key: benchmarkCaseKey(scenario.id, scenario.version, seed),
        scenarioId: scenario.id,
        scenarioVersion: scenario.version,
        seed,
        isBaseline: scenario.id === BENCHMARK_BASELINE_SCENARIO_ID,
      });
    }
  }
  return cases;
}

/** The cases of one scenario, in matrix order. */
export function casesForScenario(
  cases: readonly BenchmarkCase[],
  scenarioId: string,
): BenchmarkCase[] {
  return cases.filter((entry) => entry.scenarioId === scenarioId);
}
