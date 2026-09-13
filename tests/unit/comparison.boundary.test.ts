// @vitest-environment node
// @polsia:user-owned — static guard on the comparison engine's boundary.
//
// A comparison earns its authority by what its calculation modules refuse to
// touch. These assertions read the engine's actual source, so a report that
// quietly started depending on a clock, a random draw, a model, a network call
// or a database read cannot hide behind a passing behavioural test.
//
// The engine has exactly one impure file: `execute.ts`, the integration seam.
// Everything above it — the identity, the matrix, the aggregation, the
// head-to-head, the verdict, the report — is a pure fold over data, and that is
// what makes a comparison reproducible. The provider appears in exactly one
// place, and no vendor name appears anywhere: an agent configuration is
// whatever a caller declares, resolved through the provider boundary.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { directionOf, METRIC_KEYS, VERDICT_DISCRIMINATORS } from '@/lib/comparison/metrics';
import { COMPARISON_DISCRIMINATORS, COMPARISON_METRIC_KEYS } from '@/lib/comparison/types';

const COMPARISON_DIR = fileURLToPath(new URL('../../src/lib/comparison', import.meta.url));
const API_DIR = fileURLToPath(new URL('../../src/app/api/agent-comparisons', import.meta.url));
const SCHEMA_DIR = fileURLToPath(new URL('../../prisma/schema', import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations', import.meta.url));

const IMPURE_MODULES = ['execute.ts'];

const moduleFiles = readdirSync(COMPARISON_DIR)
  .filter((entry) => entry.endsWith('.ts'))
  .sort();

const pureModules = moduleFiles
  .filter((entry) => !IMPURE_MODULES.includes(entry))
  .map((entry) => ({
    name: `src/lib/comparison/${entry}`,
    source: readFileSync(path.join(COMPARISON_DIR, entry), 'utf8'),
  }));

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined);
}

/**
 * What a pure comparison calculation may reach: the schema library, the domain
 * contracts, and the benchmark engine's own pure modules. Each of those is
 * itself deterministic and side-effect free.
 *
 * `@/lib/benchmarks/execute` is deliberately absent: reading a persisted run is
 * the seam's job, and a comparison module that could reach the execution path
 * could re-run a simulation rather than compare the one that ran.
 */
const PERMITTED_SPECIFIERS = [
  'zod',
  '@/lib/contracts/simulation',
  '@/lib/benchmarks/types',
  '@/lib/benchmarks/arithmetic',
  '@/lib/benchmarks/matrix',
  '@/lib/benchmarks/catalog',
];

describe('comparison calculation modules', () => {
  it('are the modules the engine was specified as, plus one integration seam', () => {
    expect(moduleFiles).toEqual([
      'agents.ts',
      'aggregate.ts',
      'catalog.ts',
      'compare.ts',
      'comparison.ts',
      'definitions.ts',
      'execute.ts',
      'matrix.ts',
      'metrics.ts',
      'report.ts',
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
    // Any of these would make the same experiment produce a different report on
    // a second run.
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
    // A comparison aggregates what was persisted; it never writes.
    expect(source).not.toMatch(
      /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
  });

  it.each(pureModules)('$name writes nothing to a stream', ({ source }) => {
    expect(source).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it.each(pureModules)('$name depends on no unordered iteration', ({ source }) => {
    // Object key order is an implementation detail. Identity, the matrix and
    // every table derived from it must be ordered by a declared array or an
    // explicit comparator.
    expect(source).not.toMatch(/Object\.(keys|values|entries)\s*\(/);
  });

  it('admits no LLM judge and no vendor name into the calculation layer', () => {
    for (const { name, source } of pureModules) {
      // No judging layer, and no prompt — the verdict is a declared rule.
      expect(source, `${name} must not judge`).not.toMatch(
        /\b(llm|judge|judging|grader|rubric|prompt)\b/i,
      );
      // No hard-coded provider or model name: an agent configuration is the
      // caller's to declare, and this layer only validates and keys it.
      expect(source, `${name} must not name a vendor`).not.toMatch(
        /bedrock|openrouter|anthropic|openai|claude|gpt-|mistral|gemini/i,
      );
    }
  });

  it('keeps the impure seam to exactly one file', () => {
    const execute = readFileSync(path.join(COMPARISON_DIR, 'execute.ts'), 'utf8');
    expect(execute).toMatch(/import 'server-only'/);
    expect(execute).toMatch(/from '@\/lib\/agent\/provider'/);
    // It executes the existing benchmark path rather than a second engine.
    expect(execute).toMatch(/executeBenchmark\(/);
    expect(execute).toMatch(/buildComparisonMatrix\(/);
    expect(execute).toMatch(/reportComparison\(/);
    // It never simulates, never scores, and never reads a clock.
    expect(execute).not.toMatch(/scoreOverall|Math\.random|Date\.now/);
    expect(execute).not.toMatch(/from '@\/lib\/db'/);
    expect(execute).not.toMatch(/runTurn\(|initializeScenarioRun\(|evaluatePersistedRun\(/);
    // The only model name it could reach is the caller's, through the boundary.
    expect(execute).not.toMatch(/bedrock:\s*'|openrouter:\s*'|modelId:\s*'/);
  });

  it('keeps the barrel free of the impure seam', () => {
    const barrel = readFileSync(path.join(COMPARISON_DIR, 'comparison.ts'), 'utf8');
    // Importing a comparison *type* must not be able to drag a server-only
    // module into a client bundle. `executeComparison` is imported directly by
    // the route that is allowed to have it.
    expect(barrel).not.toMatch(/from '\.\/execute'/);
    expect(barrel).toMatch(/from '\.\/report'/);
    expect(barrel).toMatch(/from '\.\/agents'/);
  });

  it('is imported by no client component', () => {
    const barrel = readFileSync(path.join(COMPARISON_DIR, 'comparison.ts'), 'utf8');
    expect(barrel).not.toMatch(/use client|'server-only'/);
  });

  it('does not duplicate the evaluation engine’s scoring weights', () => {
    for (const { name, source } of pureModules) {
      expect(source, `${name} must not redefine a scoring weight`).not.toMatch(
        /TASK_SUCCESS_WEIGHT|SAFETY_WEIGHT|EFFICIENCY_WEIGHT|RESOURCE_MANAGEMENT_WEIGHT|RELIABILITY_WEIGHT/,
      );
    }
  });

  it('does not implement a second robustness formula', () => {
    for (const { name, source } of pureModules) {
      // The comparison reads `robustness.robustnessScore` and prints the
      // benchmark engine's formula name. The formula itself stays in one place.
      expect(source, `${name} must not recompute robustness`).not.toMatch(
        /retentionOf|measureRobustness|buildScenarioDegradations|scenarioScore\s*\/\s*baselineScore/,
      );
    }
  });

  it('does not duplicate the scenario definitions or the benchmark matrix', () => {
    for (const { name, source } of pureModules) {
      expect(source, `${name} must not restate a scenario modifier`).not.toMatch(
        /resource-reduction|budget-reduction|risk-increase|max-steps-reduction|permission-revocation/,
      );
      // The matrix is nested, never rebuilt: the benchmark engine's own builder
      // supplies the per-agent half.
      expect(source, `${name} must not build its own benchmark matrix`).not.toMatch(
        /scenarios\.flatMap|seeds\.flatMap/,
      );
    }
  });
});

describe('the metric table and the verdict rule are complete', () => {
  it('declares a direction for every metric the contracts allow to be reported', () => {
    expect([...METRIC_KEYS].sort()).toEqual([...COMPARISON_METRIC_KEYS].sort());
    for (const metric of COMPARISON_METRIC_KEYS) expect(directionOf(metric)).toBeDefined();
  });

  it('consults only metrics it reports, in the order the contracts declare', () => {
    expect([...VERDICT_DISCRIMINATORS]).toEqual([...COMPARISON_DISCRIMINATORS]);
    for (const metric of COMPARISON_DISCRIMINATORS)
      expect(COMPARISON_METRIC_KEYS).toContain(metric);
  });

  it('never lets a neutral metric decide a verdict', () => {
    const metrics = readFileSync(path.join(COMPARISON_DIR, 'metrics.ts'), 'utf8');
    for (const metric of ['averageSteps', 'averageBudgetSpent', 'averageBudgetUtilisation'])
      expect(COMPARISON_DISCRIMINATORS).not.toContain(metric);
    // Neutrality is enforced in one place, and it returns "no better" rather
    // than a direction-derived answer.
    expect(metrics).toMatch(/if \(direction === 'neutral' \|\| left === right\) return 0;/);
  });

  it('states the verdict rule as declared data rather than as judgement', () => {
    const types = readFileSync(path.join(COMPARISON_DIR, 'types.ts'), 'utf8');
    expect(types).toMatch(/declared-discriminator-order-v1/);
    expect(types).toMatch(/same-conditions-head-to-head-v1/);
    // The rule is a walk over a declared list; the ordering is explained where
    // it is declared, so a reader does not have to infer it from the code.
    expect(types).toMatch(/descending weight order/);
  });
});

describe('comparison routes', () => {
  const catalogRoute = readFileSync(path.join(API_DIR, 'route.ts'), 'utf8');
  const planRoute = readFileSync(path.join(API_DIR, '[comparisonId]/route.ts'), 'utf8');
  const runRoute = readFileSync(path.join(API_DIR, '[comparisonId]/run/route.ts'), 'utf8');

  it('authenticate every request with the project’s own auth gate', () => {
    for (const route of [catalogRoute, planRoute, runRoute]) {
      expect(route).toMatch(/import \{ requireAuth/);
      expect(route).toMatch(/from '@\/lib\/require-auth'/);
      expect(route).toMatch(/await requireAuth\(req\)/);
    }
  });

  it('declare the dynamic runtime', () => {
    for (const route of [catalogRoute, planRoute, runRoute])
      expect(route).toMatch(/export const dynamic = 'force-dynamic'/);
    // A comparison drives real agent turns, so the handler needs Node.
    expect(runRoute).toMatch(/export const runtime = 'nodejs'/);
  });

  it('resolve the experiment from the server-side registry, never from the request', () => {
    // A caller cannot submit a benchmark, a scenario list, a scoring rule or a
    // matrix: only the id, and the agents to compare.
    for (const route of [planRoute, runRoute]) {
      expect(route).not.toMatch(/BenchmarkDefinition\.(parse|safeParse)/);
      expect(route).not.toMatch(/ExperimentTemplate\.(parse|safeParse)/);
      expect(route).not.toMatch(/listScenarios|SCENARIO_DEFINITIONS|getScenario\(/);
    }
    expect(runRoute).toMatch(/ComparisonRunRequest\.safeParse/);
    expect(runRoute).toMatch(/executeComparison\(/);
  });

  it('scopes every run it creates to the signed-in owner', () => {
    expect(runRoute).toMatch(/ownerId: user\.id/);
    expect(runRoute).not.toMatch(/ownerId:\s*(parsed|body|req|request)/);
  });

  it('map a comparison failure onto a status rather than a silent 500', () => {
    expect(runRoute).toMatch(/instanceof ComparisonError/);
    expect(runRoute).toMatch(/statusFor\(/);
    expect(planRoute).toMatch(/instanceof ComparisonError/);
    expect(planRoute).toMatch(/status:/);
  });

  it('serve the catalogue and the plan from the compiled registry', () => {
    expect(catalogRoute).toMatch(/listExperimentSummaries\(\)/);
    expect(catalogRoute).not.toMatch(/readdir|readFile|import\(/);
    expect(planRoute).toMatch(/getExperiment\(/);
    // The plan is the benchmark engine's own matrix, not a second description
    // of it that could drift.
    expect(planRoute).toMatch(/buildRunMatrix\(/);
    expect(planRoute).not.toMatch(/readdir|readFile|import\(/);
  });

  it('never echo a request body or a provider response back to a caller', () => {
    for (const route of [catalogRoute, planRoute, runRoute]) {
      expect(route).not.toMatch(/console\.(log|info|warn|error|debug)/);
      expect(route).not.toMatch(/OPENROUTER_API_KEY|BETTER_AUTH_SECRET|DATABASE_URL/);
      expect(route).not.toMatch(/safeError|authorization|apiKey/i);
    }
  });
});

describe('a comparison adds no storage of its own', () => {
  const schemaFiles = readdirSync(SCHEMA_DIR).sort();
  const schemaSource = schemaFiles
    .map((entry) => readFileSync(path.join(SCHEMA_DIR, entry), 'utf8'))
    .join('\n');

  it('declares no table for a comparison, an experiment or a report', () => {
    // The runs a comparison executes are ordinary `SimulationRun` rows, and they
    // are the evidence. A report is a pure function of those rows, so a stored
    // copy could only ever drift from the evidence it claims to summarise.
    expect(schemaFiles).toEqual(['_base.prisma', 'auth.prisma', 'simulation.prisma']);
    expect(schemaSource).not.toMatch(/^model\s+\w*(Comparison|Experiment|Report|Benchmark)\w*/m);
    expect(schemaSource).not.toMatch(/^enum\s+\w*(Comparison|Verdict|Experiment)\w*/m);
    // Nothing in the schema knows the comparison layer exists.
    expect(schemaSource).not.toMatch(/comparison|verdict|headToHead/i);
  });

  it('ships no migration for one', () => {
    const migrations = readdirSync(MIGRATIONS_DIR).filter((entry) => /^\d{14}_/.test(entry));
    expect(migrations).toEqual([
      '20260603000000_init_better_auth',
      '20260612000000_add_better_auth_admin',
      '20260912000000_add_simulation_tables',
      '20260913000000_add_scenario_identity',
    ]);
    for (const entry of migrations) expect(entry).not.toMatch(/comparison|benchmark|report/i);
  });
});
