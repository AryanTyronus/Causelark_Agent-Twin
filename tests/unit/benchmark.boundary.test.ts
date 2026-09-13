// @vitest-environment node
//
// A benchmark earns its numbers by what its calculation modules refuse to touch.
// These assertions read the engine's actual source, so a score that quietly
// started depending on a clock, a random draw, a model, a network call or a
// database read cannot hide behind a passing behavioural test.
//
// The engine has exactly one impure file: `execute.ts`, which is the integration
// seam by design. Everything above it — the definitions, the matrix, the
// aggregation, the robustness metric, the failure analysis — is a pure fold over
// data, and that is what makes a benchmark reproducible.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BENCHMARK_DIR = fileURLToPath(new URL('../../src/lib/benchmarks', import.meta.url));
const BENCHMARK_ROUTE = fileURLToPath(
  new URL('../../src/app/api/benchmarks/route.ts', import.meta.url),
);
const BENCHMARK_RUN_ROUTE = fileURLToPath(
  new URL('../../src/app/api/benchmarks/[benchmarkId]/run/route.ts', import.meta.url),
);

const IMPURE_MODULES = ['execute.ts'];

const moduleFiles = readdirSync(BENCHMARK_DIR)
  .filter((entry) => entry.endsWith('.ts'))
  .sort();

const pureModules = moduleFiles
  .filter((entry) => !IMPURE_MODULES.includes(entry))
  .map((entry) => ({
    name: `src/lib/benchmarks/${entry}`,
    source: readFileSync(path.join(BENCHMARK_DIR, entry), 'utf8'),
  }));

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined);
}

/**
 * What a pure benchmark calculation may reach: the schema library, the domain
 * contracts, and the registries it resolves references against. Each of those is
 * itself deterministic and side-effect free — none reads a clock, a random
 * source, a database or a provider.
 */
const PERMITTED_SPECIFIERS = [
  'zod',
  '@/lib/contracts/simulation',
  '@/lib/evaluation/types',
  '@/lib/business/simulation',
  '@/lib/scenarios/catalog',
  '@/lib/scenarios/definitions',
];

describe('benchmark calculation modules', () => {
  it('are the modules the engine was specified as, plus one integration seam', () => {
    expect(moduleFiles).toEqual([
      'aggregation.ts',
      'arithmetic.ts',
      'benchmark.ts',
      'catalog.ts',
      'definitions.ts',
      'execute.ts',
      'failures.ts',
      'matrix.ts',
      'robustness.ts',
      'types.ts',
    ]);
    expect(IMPURE_MODULES).toHaveLength(1);
  });

  it.each(pureModules)(
    '$name imports nothing server-side, external or provider-bound',
    ({ source }) => {
      for (const specifier of importSpecifiers(source)) {
        const permitted =
          specifier.startsWith('./') ||
          PERMITTED_SPECIFIERS.some((allowed) => allowed === specifier);
        expect(permitted, `unexpected import ${specifier}`).toBe(true);
      }
    },
  );

  it.each(pureModules)('$name reads no clock and no randomness', ({ source }) => {
    // Any of these would make the same benchmark definition produce a different
    // report on a second run.
    expect(source).not.toMatch(/Date\s*\.\s*now/);
    expect(source).not.toMatch(/new\s+Date\b/);
    expect(source).not.toMatch(/performance\s*\.\s*now/);
    expect(source).not.toMatch(/Math\s*\.\s*random/);
    expect(source).not.toMatch(/crypto\s*\.\s*randomUUID/);
    expect(source).not.toMatch(/randomUUID|nanoid|\buuid\b/i);
  });

  it.each(pureModules)('$name makes no network or model call', ({ source }) => {
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/openrouter|bedrock|anthropic|openai|strands/i);
  });

  it.each(pureModules)('$name reaches no persistence client', ({ source }) => {
    expect(source).not.toMatch(/@prisma\/client|@\/lib\/db|prisma\s*\./);
    // The marker is asserted as an import: a comment may legitimately discuss
    // the boundary it marks.
    expect(source).not.toMatch(/import 'server-only'/);
    // A benchmark aggregates what was persisted; it never writes.
    expect(source).not.toMatch(
      /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
  });

  it.each(pureModules)('$name writes nothing to a stream', ({ source }) => {
    expect(source).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it.each(pureModules)('$name depends on no unordered iteration', ({ source }) => {
    // Object key order is an implementation detail; the matrix and every table
    // derived from it must be ordered by the definition's own arrays.
    expect(source).not.toMatch(/Object\.(keys|values|entries)\s*\(/);
  });

  it('keeps the impure seam to exactly one file', () => {
    const execute = readFileSync(path.join(BENCHMARK_DIR, 'execute.ts'), 'utf8');
    // The seam is allowed to be impure, and is required to be the only one —
    // so the impurity is visible in one place rather than spread across the
    // calculation modules.
    expect(execute).toMatch(/import 'server-only'/);
    expect(execute).toMatch(/from '@\/lib\/db'/);
    expect(execute).toMatch(/from '@\/lib\/env'/);
    expect(execute).toMatch(/from '@\/lib\/agent\/run-turn'/);
    // It executes the existing turn loop rather than a second simulation engine.
    expect(execute).toMatch(/runTurn\(/);
    expect(execute).toMatch(/initializeScenarioRun\(/);
    expect(execute).toMatch(/evaluatePersistedRun\(/);
    // It never computes a score of its own.
    expect(execute).not.toMatch(/scoreOverall|Math\.random|Date\.now/);
  });

  it('does not duplicate the evaluation engine’s scoring weights', () => {
    for (const { name, source } of pureModules) {
      expect(source, `${name} must not redefine a scoring weight`).not.toMatch(
        /TASK_SUCCESS_WEIGHT|SAFETY_WEIGHT|EFFICIENCY_WEIGHT|RESOURCE_MANAGEMENT_WEIGHT|RELIABILITY_WEIGHT/,
      );
    }
  });

  it('does not duplicate the scenario definitions', () => {
    // The engine references scenario ids and versions; the definitions
    // themselves stay in the scenario engine's own catalogue.
    for (const { name, source } of pureModules) {
      expect(source, `${name} must not restate a scenario modifier`).not.toMatch(
        /resource-reduction|budget-reduction|risk-increase|max-steps-reduction|permission-revocation/,
      );
    }
  });

  it('documents the robustness formula and claims no more than it measures', () => {
    const robustness = readFileSync(path.join(BENCHMARK_DIR, 'robustness.ts'), 'utf8');
    expect(robustness).toMatch(/baseline-retention-v1/);
    expect(robustness).toMatch(/retention\s*=\s*scenarioScore \/ baselineScore/);
    expect(robustness).toMatch(/robustnessScore\s*=\s*mean retention/);
    // The metric is stated as Agent Twin's own, not as a universal quantity.
    expect(robustness).toMatch(/not a\s*\n?\/\/\s*universal scientific quantity/);
  });
});

describe('benchmark routes', () => {
  const catalogRoute = readFileSync(BENCHMARK_ROUTE, 'utf8');
  const runRoute = readFileSync(BENCHMARK_RUN_ROUTE, 'utf8');

  it('authenticate every request with the project’s own auth gate', () => {
    for (const route of [catalogRoute, runRoute]) {
      expect(route).toMatch(/import \{ requireAuth/);
      expect(route).toMatch(/from '@\/lib\/require-auth'/);
      expect(route).toMatch(/await requireAuth\(req\)/);
    }
  });

  it('declare the dynamic runtime', () => {
    expect(catalogRoute).toMatch(/export const dynamic = 'force-dynamic'/);
    expect(runRoute).toMatch(/export const dynamic = 'force-dynamic'/);
    // A benchmark drives real agent turns, so the handler needs Node.
    expect(runRoute).toMatch(/export const runtime = 'nodejs'/);
  });

  it('resolve the benchmark from the server-side registry, never from the request', () => {
    expect(runRoute).toMatch(/executeBenchmark\(/);
    // A caller cannot submit a definition, a scenario list or a scoring rule.
    expect(runRoute).not.toMatch(/BenchmarkDefinition\.(parse|safeParse)/);
    expect(runRoute).not.toMatch(/listScenarios|SCENARIO_DEFINITIONS|getScenario\(/);
    expect(runRoute).toMatch(/BenchmarkRunRequest\.safeParse/);
  });

  it('accept an empty body, because a benchmark needs no parameters', () => {
    expect(runRoute).toMatch(/text\.trim\(\) === '' \? \{\}/);
  });

  it('scopes every run it creates to the signed-in owner', () => {
    expect(runRoute).toMatch(/ownerId: user\.id/);
    expect(runRoute).not.toMatch(/ownerId:\s*(parsed|body|req)/);
  });

  it('map a benchmark failure onto a status rather than a silent 500', () => {
    expect(runRoute).toMatch(/UNKNOWN_BENCHMARK/);
    expect(runRoute).toMatch(/statusFor\(/);
    expect(runRoute).toMatch(/instanceof BenchmarkError/);
  });

  it('serve the catalogue from the compiled registry', () => {
    expect(catalogRoute).toMatch(/listBenchmarkSummaries\(\)/);
    expect(catalogRoute).not.toMatch(/readdir|readFile|import\(/);
  });
});

describe('the benchmark request contract', () => {
  it('carries no scenario, threshold or scoring input', async () => {
    const { BenchmarkRunRequest } = await import('@/lib/benchmarks/types');
    const keys = Object.keys(BenchmarkRunRequest.shape).sort();
    expect(keys).toEqual(['agent', 'seeds']);
  });

  it('carries no executable value', () => {
    const types = readFileSync(path.join(BENCHMARK_DIR, 'types.ts'), 'utf8');
    // The request is data: an agent label and a seed list.
    expect(types).not.toMatch(/z\.function|z\.custom/);
  });
});

describe('benchmark definitions', () => {
  it('are declarative data with versions pinned explicitly', () => {
    const definitions = readFileSync(path.join(BENCHMARK_DIR, 'definitions.ts'), 'utf8');
    // Versions are pinned by a named constant, so a scenario bump fails loudly
    // rather than being followed silently by whichever benchmark references it.
    expect(definitions).toMatch(/PINNED_SCENARIO_VERSION = \d+/);
    expect(definitions).toMatch(
      /scenarioVersion|version: PINNED_SCENARIO_VERSION|PINNED_SCENARIO_VERSION/,
    );
    // Nothing executable, dynamic or environmental in how a definition is built.
    expect(definitions).not.toMatch(/\beval\s*\(|new Function|z\.function|z\.custom/);
    expect(definitions).not.toMatch(/Math\.random|Date\.now|new Date|fetch\(|process\.env/);
    expect(definitions).not.toMatch(/defineBenchmark|registerBenchmark/);
  });

  it('are the only source of benchmark identity the engine will run', () => {
    const catalog = readFileSync(path.join(BENCHMARK_DIR, 'catalog.ts'), 'utf8');
    // The catalogue is built from the shipped definitions, in process — there is
    // no filesystem discovery and no user-supplied definition path.
    expect(catalog).toMatch(/BENCHMARK_DEFINITIONS/);
    expect(catalog).toMatch(/Object\.freeze/);
    expect(catalog).not.toMatch(/readdir|readFileSync|import\(|require\(/);
  });
});
