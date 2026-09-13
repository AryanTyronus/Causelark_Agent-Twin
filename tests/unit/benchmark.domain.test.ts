// @vitest-environment node
// @polsia:user-owned — benchmark definitions, catalogue and run matrix.
//
// The matrix is the contract every other part of the engine rests on: if it is
// not the same array on every call, nothing above it can be reproducible. These
// tests pin its order, its identity and its refusals.

import { describe, expect, it } from 'vitest';
import {
  benchmarkSummary,
  findBenchmark,
  getBenchmark,
  listBenchmarkSummaries,
  listBenchmarks,
  validateBenchmarkDefinition,
} from '@/lib/benchmarks/catalog';
import {
  BENCHMARK_DEFINITIONS,
  PINNED_SCENARIO_VERSION,
  ROBUSTNESS_BENCHMARK_SEEDS,
  ROBUSTNESS_SCENARIO_IDS,
} from '@/lib/benchmarks/definitions';
import { benchmarkCaseKey, buildRunMatrix, casesForScenario } from '@/lib/benchmarks/matrix';
import { BenchmarkError, MAX_BENCHMARK_CASES } from '@/lib/benchmarks/types';
import { DEFAULT_CONFIGURATION } from '@/lib/business/simulation';
import { listScenarioSummaries } from '@/lib/scenarios/catalog';

const BENCHMARK_ID = 'resource-routing-robustness';
/** The seven shipped conditions, in the order the benchmark declares them. */
const SCENARIO_IDS = [...ROBUSTNESS_SCENARIO_IDS];

describe('benchmark definitions', () => {
  it('resolves a shipped benchmark by id', () => {
    const benchmark = getBenchmark(BENCHMARK_ID);
    expect(benchmark.id).toBe(BENCHMARK_ID);
    expect(benchmark.version).toBe(1);
    expect(benchmark.environmentKey).toBe('resource-routing');
    expect(benchmark.objectiveKey).toBe('complete-delivery');
  });

  it('resolves a shipped benchmark at its exact version, and refuses another', () => {
    expect(getBenchmark(BENCHMARK_ID, 1).version).toBe(1);
    expect(() => getBenchmark(BENCHMARK_ID, 99)).toThrowError(BenchmarkError);
    expect(() => getBenchmark(BENCHMARK_ID, 99)).toThrowError(/only ships version 1/);
  });

  it('refuses an unknown benchmark id clearly', () => {
    expect(findBenchmark('no-such-benchmark')).toBeNull();
    expect(() => getBenchmark('no-such-benchmark')).toThrowError(/Unknown benchmark/);
  });

  it('distinguishes an unknown id from an unknown version', () => {
    const unknownId = (() => {
      try {
        getBenchmark('no-such-benchmark');
      } catch (error) {
        return (error as BenchmarkError).code;
      }
      return null;
    })();
    const unknownVersion = (() => {
      try {
        getBenchmark(BENCHMARK_ID, 42);
      } catch (error) {
        return (error as BenchmarkError).code;
      }
      return null;
    })();
    expect(unknownId).toBe('UNKNOWN_BENCHMARK');
    expect(unknownVersion).toBe('UNKNOWN_BENCHMARK');
  });

  it('freezes the catalogue so a caller cannot rewrite a definition', () => {
    const benchmark = listBenchmarks()[0];
    expect(Object.isFrozen(benchmark)).toBe(true);
    expect(Object.isFrozen(listBenchmarks())).toBe(true);
  });

  it('lists every shipped definition as a summary', () => {
    const summaries = listBenchmarkSummaries();
    expect(summaries).toHaveLength(BENCHMARK_DEFINITIONS.length);
    const summary = summaries.find((entry) => entry.id === BENCHMARK_ID);
    expect(summary).toMatchObject({
      id: BENCHMARK_ID,
      name: 'Resource Routing Robustness',
      environmentKey: 'resource-routing',
      scenarioCount: 7,
      seedCount: 1,
      caseCount: 7,
    });
    expect(summary?.description.length).toBeGreaterThan(0);
  });

  it('summarises the definition it was handed', () => {
    const benchmark = getBenchmark(BENCHMARK_ID);
    expect(benchmarkSummary(benchmark)).toEqual({
      id: benchmark.id,
      version: benchmark.version,
      name: benchmark.name,
      description: benchmark.description,
      environmentKey: benchmark.environmentKey,
      objectiveKey: benchmark.objectiveKey,
      scenarioCount: benchmark.scenarios.length,
      seedCount: benchmark.seeds.length,
      caseCount: benchmark.scenarios.length * benchmark.seeds.length,
    });
  });

  it('references only scenarios the scenario catalogue ships, at the pinned version', () => {
    const benchmark = getBenchmark(BENCHMARK_ID);
    const shipped = new Map(listScenarioSummaries().map((entry) => [entry.id, entry.version]));
    for (const reference of benchmark.scenarios) {
      expect(shipped.get(reference.id)).toBe(reference.version);
      expect(reference.version).toBe(PINNED_SCENARIO_VERSION);
    }
  });

  it('covers all seven shipped scenarios, in evaluation order', () => {
    const benchmark = getBenchmark(BENCHMARK_ID);
    expect(benchmark.scenarios.map((entry) => entry.id)).toEqual(SCENARIO_IDS);
    expect(new Set(SCENARIO_IDS).size).toBe(7);
  });

  it('declares a baseline condition to measure degradation against', () => {
    const benchmark = getBenchmark(BENCHMARK_ID);
    expect(benchmark.scenarios.filter((entry) => entry.id === 'baseline')).toHaveLength(1);
  });

  it('declares its seed set explicitly', () => {
    const benchmark = getBenchmark(BENCHMARK_ID);
    expect(benchmark.seeds).toEqual([...ROBUSTNESS_BENCHMARK_SEEDS]);
    expect(benchmark.seeds.length).toBeGreaterThan(0);
  });

  it('is declarative: it carries data and nothing executable', () => {
    const walk = (value: unknown, at: string): void => {
      if (typeof value === 'function')
        throw new Error(`Benchmark definition contains a function at ${at}`);
      if (value === null || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) walk(entry, `${at}.${key}`);
    };
    for (const benchmark of listBenchmarks()) walk(benchmark, benchmark.id);
    expect(JSON.parse(JSON.stringify(listBenchmarks()))).toEqual(listBenchmarks());
  });
});

describe('benchmark definition validation', () => {
  const valid = () => JSON.parse(JSON.stringify(BENCHMARK_DEFINITIONS[0]));

  it('accepts the shipped definitions', () => {
    for (const definition of BENCHMARK_DEFINITIONS)
      expect(validateBenchmarkDefinition(definition).id).toBe(definition.id);
  });

  it('rejects an unknown scenario reference', () => {
    const candidate = valid();
    candidate.scenarios[3] = { id: 'no-such-scenario', version: 1 };
    expect(() => validateBenchmarkDefinition(candidate)).toThrowError(/unknown scenario/);
  });

  it('rejects a scenario version the catalogue does not ship', () => {
    const candidate = valid();
    candidate.scenarios[1] = { id: 'resource-scarcity', version: 7 };
    expect(() => validateBenchmarkDefinition(candidate)).toThrowError(/only ships version 1/);
    try {
      validateBenchmarkDefinition(candidate);
    } catch (error) {
      expect((error as BenchmarkError).code).toBe('INVALID_SCENARIO');
    }
  });

  it('rejects a repeated scenario', () => {
    const candidate = valid();
    candidate.scenarios = [candidate.scenarios[0], candidate.scenarios[1], candidate.scenarios[1]];
    expect(() => validateBenchmarkDefinition(candidate)).toThrowError(/more than once/);
  });

  it('rejects a repeated seed', () => {
    const candidate = valid();
    candidate.seeds = [1042, 1042];
    expect(() => validateBenchmarkDefinition(candidate)).toThrowError(/more than once/);
  });

  it('rejects a seed the environment does not publish', () => {
    const candidate = valid();
    candidate.seeds = [777];
    expect(() => validateBenchmarkDefinition(candidate)).toThrowError(/does not publish/);
  });

  it('rejects an unknown environment or objective', () => {
    // Both are closed vocabularies owned by the simulation contracts, so an
    // unknown value is refused before anything is resolved — and the refusal
    // names the field, so an author knows which one to fix.
    const environment = valid();
    environment.environmentKey = 'no-such-environment';
    expect(() => validateBenchmarkDefinition(environment)).toThrowError(/environmentKey/);

    const objective = valid();
    objective.objectiveKey = 'no-such-objective';
    expect(() => validateBenchmarkDefinition(objective)).toThrowError(/objectiveKey/);

    for (const candidate of [environment, objective]) {
      try {
        validateBenchmarkDefinition(candidate);
      } catch (error) {
        expect(error).toBeInstanceOf(BenchmarkError);
        expect((error as BenchmarkError).code).toBe('INVALID_BENCHMARK');
      }
    }
  });

  it('rejects a definition with no baseline condition', () => {
    const candidate = valid();
    candidate.scenarios = candidate.scenarios.filter(
      (entry: { id: string }) => entry.id !== 'baseline',
    );
    expect(() => validateBenchmarkDefinition(candidate)).toThrowError(/baseline/);
  });

  it('rejects a malformed definition rather than defaulting its fields', () => {
    expect(() => validateBenchmarkDefinition({ id: 'x', version: 1 })).toThrowError(/malformed/);
    const notKebab = valid();
    notKebab.id = 'Not Kebab';
    expect(() => validateBenchmarkDefinition(notKebab)).toThrowError(/malformed/);
  });

  it('accepts the widest matrix the environment can express', () => {
    // Seven scenarios at the four published seeds is exactly the bound, so a
    // valid definition can never exceed it — the check exists for the day a
    // scenario or a seed is added.
    const widest = validateBenchmarkDefinition({
      ...JSON.parse(JSON.stringify(BENCHMARK_DEFINITIONS[0])),
      seeds: [1042, 2048, 4242, 9182],
    });
    expect(buildRunMatrix(widest)).toHaveLength(MAX_BENCHMARK_CASES);
  });

  it('refuses to build a matrix larger than the engine will run in one execution', () => {
    const definition = getBenchmark(BENCHMARK_ID);
    const oversized = {
      ...definition,
      scenarios: Array.from({ length: 8 }, (_unused, index) => ({
        id: `synthetic-${index}`,
        version: 1,
      })),
      seeds: [1042, 2048, 4242, 9182],
    };
    expect(() => buildRunMatrix(oversized)).toThrowError(/above the 28/);
  });

  it('inherits the environment configuration unless the definition overrides it', () => {
    // Overriding is allowed but must not be required: the shipped benchmark
    // leaves it unset and takes the environment's own defaults.
    const benchmark = getBenchmark(BENCHMARK_ID);
    expect(benchmark.configuration).toBeUndefined();
    expect(DEFAULT_CONFIGURATION.maxTurns).toBeGreaterThan(0);
  });
});

describe('benchmark run matrix', () => {
  it('expands one scenario at one seed to a single case', () => {
    const definition = validateBenchmarkDefinition({
      ...JSON.parse(JSON.stringify(BENCHMARK_DEFINITIONS[0])),
      scenarios: [{ id: 'baseline', version: 1 }],
      seeds: [1042],
    });
    const matrix = buildRunMatrix(definition);
    expect(matrix).toHaveLength(1);
    expect(matrix[0]).toEqual({
      index: 0,
      key: 'baseline@1#1042',
      scenarioId: 'baseline',
      scenarioVersion: 1,
      seed: 1042,
      isBaseline: true,
    });
  });

  it('expands the shipped definition to one case per scenario', () => {
    const matrix = buildRunMatrix(getBenchmark(BENCHMARK_ID));
    expect(matrix).toHaveLength(7);
    expect(matrix.map((entry) => entry.scenarioId)).toEqual(SCENARIO_IDS);
    expect(matrix.every((entry) => entry.seed === 1042)).toBe(true);
  });

  it('expands multiple scenarios at multiple seeds to the full cross product', () => {
    const definition = validateBenchmarkDefinition({
      ...JSON.parse(JSON.stringify(BENCHMARK_DEFINITIONS[0])),
      scenarios: [
        { id: 'baseline', version: 1 },
        { id: 'resource-scarcity', version: 1 },
        { id: 'resource-outage', version: 1 },
      ],
      seeds: [1042, 2048],
    });
    const matrix = buildRunMatrix(definition);
    expect(matrix).toHaveLength(6);
    expect(matrix.map((entry) => entry.key)).toEqual([
      'baseline@1#1042',
      'baseline@1#2048',
      'resource-scarcity@1#1042',
      'resource-scarcity@1#2048',
      'resource-outage@1#1042',
      'resource-outage@1#2048',
    ]);
  });

  it('orders by scenario first, then by seed — not by object iteration', () => {
    const definition = validateBenchmarkDefinition({
      ...JSON.parse(JSON.stringify(BENCHMARK_DEFINITIONS[0])),
      scenarios: [
        { id: 'baseline', version: 1 },
        { id: 'resource-outage', version: 1 },
      ],
      seeds: [9182, 1042],
    });
    expect(buildRunMatrix(definition).map((entry) => entry.key)).toEqual([
      'baseline@1#9182',
      'baseline@1#1042',
      'resource-outage@1#9182',
      'resource-outage@1#1042',
    ]);
  });

  it('is deterministic: two builds of the same definition are deep-equal', () => {
    const definition = getBenchmark(BENCHMARK_ID);
    expect(buildRunMatrix(definition)).toEqual(buildRunMatrix(definition));
    expect(JSON.stringify(buildRunMatrix(definition))).toBe(
      JSON.stringify(buildRunMatrix(definition)),
    );
  });

  it('contains no duplicate cases', () => {
    const matrix = buildRunMatrix(getBenchmark(BENCHMARK_ID));
    expect(new Set(matrix.map((entry) => entry.key)).size).toBe(matrix.length);
  });

  it('gives every case stable identity independent of its position', () => {
    const matrix = buildRunMatrix(getBenchmark(BENCHMARK_ID));
    for (const entry of matrix) {
      expect(entry.key).toBe(benchmarkCaseKey(entry.scenarioId, entry.scenarioVersion, entry.seed));
      expect(entry.index).toBe(matrix.indexOf(entry));
    }
    expect(matrix[0]?.key).toBe('baseline@1#1042');
    expect(matrix.at(-1)?.key).toBe('action-rejection@1#1042');
  });

  it('selects a scenario’s cases in matrix order', () => {
    const matrix = buildRunMatrix(getBenchmark(BENCHMARK_ID));
    expect(casesForScenario(matrix, 'resource-scarcity')).toEqual([
      expect.objectContaining({ scenarioId: 'resource-scarcity', index: 1 }),
    ]);
    expect(casesForScenario(matrix, 'not-a-scenario')).toEqual([]);
  });

  it('refuses to build a matrix from a definition with no scenarios or seeds', () => {
    const definition = getBenchmark(BENCHMARK_ID);
    expect(() => buildRunMatrix({ ...definition, seeds: [] })).toThrowError(BenchmarkError);
    expect(() => buildRunMatrix({ ...definition, scenarios: [] })).toThrowError(BenchmarkError);
  });
});
