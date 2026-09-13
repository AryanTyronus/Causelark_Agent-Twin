// @vitest-environment node
// @polsia:user-owned — static guard on the evaluation engine's boundary.
//
// An evidence-based evaluator earns its verdict by what it refuses to touch.
// These assertions read the engine's actual source, so a score that quietly
// started depending on a clock, a random draw, a model, or a network call
// cannot hide behind a passing behavioural test.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const EVALUATION_DIR = fileURLToPath(new URL('../../src/lib/evaluation', import.meta.url));
const EVALUATION_ROUTE = fileURLToPath(
  new URL('../../src/app/api/simulations/runs/[runId]/evaluation/route.ts', import.meta.url),
);

const evaluationFiles = readdirSync(EVALUATION_DIR)
  .filter((entry) => entry.endsWith('.ts'))
  .sort();

const evaluationSources = evaluationFiles.map((entry) => ({
  name: `src/lib/evaluation/${entry}`,
  source: readFileSync(path.join(EVALUATION_DIR, entry), 'utf8'),
}));

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined);
}

describe('evaluation module', () => {
  it('is the four-module domain the engine was specified as', () => {
    expect(evaluationFiles).toEqual(['evaluation.ts', 'metrics.ts', 'scoring.ts', 'types.ts']);
  });

  it.each(evaluationSources)(
    '$name imports nothing server-side, external or provider-bound',
    ({ source }) => {
      // The engine may reach the domain contracts and zod, and its own relative
      // modules. Anything else — a database client, a model SDK, an HTTP client,
      // the `server-only` marker — would put a dependency between an evidence
      // set and its verdict that persisted data cannot account for.
      for (const specifier of importSpecifiers(source)) {
        const permitted = specifier === 'zod' || specifier === '@/lib/contracts/simulation';
        expect(permitted || specifier.startsWith('./'), `unexpected import ${specifier}`).toBe(
          true,
        );
      }
    },
  );

  it.each(evaluationSources)('$name reads no clock and no randomness', ({ source }) => {
    // Both would make the same persisted run score differently on a second look.
    expect(source).not.toMatch(/Date\s*\.\s*now/);
    expect(source).not.toMatch(/new\s+Date\b/);
    expect(source).not.toMatch(/performance\s*\.\s*now/);
    expect(source).not.toMatch(/Math\s*\.\s*random/);
    expect(source).not.toMatch(/crypto\s*\.\s*randomUUID/);
  });

  it.each(evaluationSources)('$name makes no network or model call', ({ source }) => {
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/openrouter|bedrock|anthropic|openai|strands/i);
  });

  it.each(evaluationSources)('$name writes nothing to a stream', ({ source }) => {
    expect(source).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it.each(evaluationSources)('$name reaches no persistence client', ({ source }) => {
    expect(source).not.toMatch(/@prisma\/client|@\/lib\/db|prisma\s*\./);
    // Scoring must not be able to write back over the evidence it scored.
    expect(source).not.toMatch(
      /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
  });

  it('exports the evaluation entry point the route and the tests both use', () => {
    const entry = evaluationSources.find((file) => file.name.endsWith('evaluation.ts'));
    expect(entry?.source).toMatch(/export function evaluateRun\(/);
  });
});

describe('evaluation route', () => {
  const route = readFileSync(EVALUATION_ROUTE, 'utf8');

  it('authenticates every request', () => {
    expect(route).toMatch(/import \{ requireAuth, type SessionUser \} from '@\/lib\/require-auth'/);
    expect(route).toMatch(/await requireAuth\(req\)/);
  });

  it('scopes the evidence read to the signed-in owner', () => {
    // An unscoped read would let any signed-in user evaluate another's run.
    expect(route).toMatch(/loadRun\(runId, user\.id\)/);
    expect(route).not.toMatch(/findUnique|findFirst/);
  });

  it('computes the verdict rather than storing one', () => {
    expect(route).toMatch(/evaluateRun\(/);
    expect(route).not.toMatch(/prisma\./);
  });

  it('declares the dynamic runtime and the envelope contract', () => {
    expect(route).toMatch(/export const dynamic = 'force-dynamic'/);
    expect(route).toMatch(/EvaluationEnvelope\.parse/);
  });
});
