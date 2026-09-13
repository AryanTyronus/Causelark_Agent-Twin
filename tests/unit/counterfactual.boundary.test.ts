// @vitest-environment node
//
// A counterfactual earns its credibility by what it refuses to reach for. These
// assertions read the engine's actual source, so a branch that quietly started
// depending on a clock, a random draw, a model or a database write cannot hide
// behind a passing behavioural test.
//
// The engine has exactly one impure file: `execute.ts`, the integration seam.
// Everything it is built from — the action space, the decision points, the
// continuation, the branch evidence, the comparison, the report — is a pure fold
// over persisted evidence, and that is what makes an alternative reproducible.
//
// Two rules matter more than the rest and are asserted in their own right:
//
//   the engine ASKS the environment; it does not answer for it. Validity is
//   `evaluateSimulationAction`'s verdict and a score is `evaluateRun`'s, so those
//   are the only sources of a transition and a verdict in the engine.
//
//   the engine does not REPEAT a formula another engine owns — not a scoring
//   weight, not a scenario modifier, not a benchmark definition — and where it
//   needs exact decimal arithmetic it imports the benchmark engine's, rather than
//   growing a second copy that could round differently.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const COUNTERFACTUAL_DIR = fileURLToPath(new URL('../../src/lib/counterfactual', import.meta.url));
const ROUTE = fileURLToPath(
  new URL('../../src/app/api/simulations/runs/[runId]/counterfactual/route.ts', import.meta.url),
);

const IMPURE_MODULES = ['execute.ts'];

const moduleFiles = readdirSync(COUNTERFACTUAL_DIR)
  .filter((entry) => entry.endsWith('.ts'))
  .sort();

const pureModules = moduleFiles
  .filter((entry) => !IMPURE_MODULES.includes(entry))
  .map((entry) => ({
    name: `src/lib/counterfactual/${entry}`,
    source: readFileSync(path.join(COUNTERFACTUAL_DIR, entry), 'utf8'),
  }));

function source(name: string): string {
  return pureModules.find((module) => module.name.endsWith(`/${name}`))?.source ?? '';
}

/**
 * The source with its comments removed.
 *
 * The boundary assertions below are about what the engine *does*, and a comment
 * may legitimately discuss the very thing the code must not do — this engine's
 * continuation explains why it does not read a clock, which means the words
 * "new Date" appear in it on purpose. Stripping comments is what lets the rule
 * be both stated and enforced.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const codeModules = pureModules.map((module) => ({
  name: module.name,
  code: code(module.source),
}));

function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/from\s+'([^']+)'/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined);
}

/**
 * What a pure counterfactual calculation may reach: the schema library, the
 * domain contracts, and the two engines whose verdicts it composes — the
 * environment that owns a transition, the evaluation engine that owns a score,
 * and the benchmark engine's exact-decimal arithmetic. Each is itself
 * deterministic and side-effect free.
 */
const PERMITTED_SPECIFIERS = [
  'zod',
  '@/lib/contracts/simulation',
  '@/lib/business/simulation',
  '@/lib/evaluation/types',
  '@/lib/evaluation/evaluation',
  // Reused rather than duplicated: one rounding rule for the whole project.
  '@/lib/benchmarks/arithmetic',
];

describe('counterfactual calculation modules', () => {
  it('are the modules the engine was specified as, plus one integration seam', () => {
    expect(moduleFiles).toEqual([
      'actions.ts',
      'analysis.ts',
      'continuation.ts',
      'counterfactual.ts',
      'decisions.ts',
      'evidence.ts',
      'execute.ts',
      'report.ts',
      'types.ts',
    ]);
    expect(IMPURE_MODULES).toHaveLength(1);
  });

  it.each(pureModules)(
    '$name imports nothing server-side, external or provider-bound',
    ({ source: text }) => {
      for (const specifier of importSpecifiers(text)) {
        const permitted =
          specifier.startsWith('./') ||
          PERMITTED_SPECIFIERS.some((allowed) => allowed === specifier);
        expect(permitted, `unexpected import ${specifier}`).toBe(true);
      }
    },
  );

  it.each(codeModules)('$name reads no clock and no randomness', ({ code: text }) => {
    // Any of these would make the same trace produce a different counterfactual
    // on a second analysis — and a counterfactual that changes is not evidence.
    expect(text).not.toMatch(/Date\s*\.\s*now/);
    expect(text).not.toMatch(/new\s+Date\b/);
    expect(text).not.toMatch(/performance\s*\.\s*now/);
    expect(text).not.toMatch(/Math\s*\.\s*random/);
    expect(text).not.toMatch(/crypto\s*\.\s*randomUUID/);
    expect(text).not.toMatch(/randomUUID|nanoid|\buuid\b/i);
  });

  it.each(codeModules)('$name makes no network or model call', ({ code: text }) => {
    expect(text).not.toMatch(/\bfetch\s*\(/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/process\.env/);
    expect(text).not.toMatch(/openrouter|bedrock|anthropic|openai|strands|invokeResourceAgent/i);
  });

  it.each(codeModules)(
    '$name reaches no persistence client and writes nothing',
    ({ code: text }) => {
      expect(text).not.toMatch(/@prisma\/client|@\/lib\/db|prisma\s*\./);
      // The marker is asserted as an import: a comment may legitimately discuss
      // the boundary it marks.
      expect(text).not.toMatch(/import 'server-only'/);
      // A counterfactual is computed from what was recorded; it is never stored.
      expect(text).not.toMatch(
        /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
      );
    },
  );

  it.each(codeModules)('$name writes nothing to a stream', ({ code: text }) => {
    expect(text).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it.each(codeModules)('$name depends on no unordered iteration', ({ code: text }) => {
    // Object key order is an implementation detail. Every ordering in this
    // engine is by a named array — the action space, the recorded trace, the
    // ranking — so a tie always has the same winner.
    expect(text).not.toMatch(/Object\.(keys|values|entries)\s*\(/);
  });

  it.each(codeModules)('$name treats the evidence as read-only', ({ code: text }) => {
    // The engine folds over persisted evidence; writing back into it would make
    // a second analysis of the same run disagree with the first. Local arrays
    // may be built and sorted freely — what must not happen is an assignment
    // into, or a deletion from, the evidence the engine was handed.
    expect(text).not.toMatch(/\b(source|input|recorded|context|state)\s*\.\s*\w+\s*=[^=]/);
    expect(text).not.toMatch(/delete\s+(source|input|recorded|context|state)\b/);
    // And the evidence is never ordered in place: a module that sorted the
    // recorded trace would reorder the run itself.
    expect(text).not.toMatch(/(source|input|recorded)\.(actions|events|toolCalls)\.sort\(/);
  });
});

describe('the engine asks the existing engines rather than answering for them', () => {
  it('takes every transition from the environment’s own validator', () => {
    // Actions are enumerated and validated in exactly one module, and that
    // module's only source of a verdict is `evaluateSimulationAction`.
    expect(source('actions.ts')).toMatch(/evaluateSimulationAction\(/);
    expect(source('continuation.ts')).toMatch(/evaluateSimulationAction\(/);
    // Nothing re-implements the rules an action has to satisfy. A validator of
    // its own would show up as a hand-written comparison against a capacity, a
    // threshold or a permission list.
    for (const { name, code: text } of codeModules) {
      expect(text, `${name} must not restate an environment rule`).not.toMatch(
        /state\.capacity\s*[<>]|state\.maxRisk\s*[<>]|state\.permissions\.includes|state\.maxSteps\s*[<>]/,
      );
    }
  });

  it('takes every verdict from the evaluation engine', () => {
    for (const { name, code: text } of codeModules) {
      expect(text, `${name} must not score a branch itself`).not.toMatch(
        /scoreOverall|weightedScore/,
      );
    }
    // A branch's verdict, the recorded run's verdict and the drill-down's
    // baseline all come from the one function.
    expect(source('evidence.ts')).toMatch(/evaluateRun\(/);
    expect(source('report.ts')).toMatch(/evaluateRun\(/);
    expect(source('counterfactual.ts')).not.toMatch(/scoreOverall/);
  });

  it('does not duplicate the evaluation engine’s scoring weights', () => {
    for (const { name, code: text } of codeModules) {
      expect(text, `${name} must not redefine a scoring weight`).not.toMatch(
        /TASK_SUCCESS_WEIGHT|SAFETY_WEIGHT|EFFICIENCY_WEIGHT|RESOURCE_MANAGEMENT_WEIGHT|RELIABILITY_WEIGHT|0\.3|0\.25|0\.15/,
      );
    }
  });

  it('does not duplicate the scenario definitions or the benchmark catalogue', () => {
    for (const { name, code: text } of codeModules) {
      expect(text, `${name} must not restate a scenario modifier`).not.toMatch(
        /resource-reduction|budget-reduction|risk-increase|max-steps-reduction|permission-revocation/,
      );
      expect(text, `${name} must not reach into the benchmark catalogue`).not.toMatch(
        /benchmarks\/(catalog|definitions|matrix|execute|robustness|failures)/,
      );
    }
  });

  it('does not restate the environment’s refusal vocabulary', () => {
    // The rejection codes belong to the environment. The engine groups by
    // whatever codes it was handed; a code written down here would be a second
    // copy that could drift from the environment's.
    for (const { name, code: text } of codeModules) {
      expect(text, `${name} must not hard-code a rejection code`).not.toMatch(
        /'INSUFFICIENT_RESOURCE'|'CAPACITY_EXCEEDED'|'BUDGET_EXCEEDED'|'PERMISSION_DENIED'|'TERMINAL_RUN'|'MALFORMED_ACTION'|'RESOURCE_REQUIRED'|'INSUFFICIENT_ENERGY'/,
      );
    }
    // What it does restate, it restates because it is the engine's own answer:
    // the code for an accepted candidate.
    expect(source('actions.ts')).toMatch(/'ACCEPTED'/);
  });

  it('names the three policies it states its numbers under', () => {
    const types = source('types.ts');
    expect(types).toMatch(/enumerated-valid-actions-v1/);
    expect(types).toMatch(/replay-recorded-attempts-v1/);
    expect(types).toMatch(/held-constant-non-environment-evidence-v1/);
    // And documents what each does and does not model.
    expect(types).toMatch(/ACTION_AMOUNT_PROBE_LIMIT/);
    expect(source('continuation.ts')).toMatch(/WHAT IT DOES NOT DO/);
    expect(source('evidence.ts')).toMatch(/IDENTICAL EVERYWHERE ELSE/);
  });

  it('does not claim causation anywhere in the engine', () => {
    for (const { name, code: text } of codeModules) {
      // No generated string may assert it. Comments are stripped above, so this
      // reads the strings the engine can actually emit.
      const strings = [...text.matchAll(/'([^'\n]{12,})'/g)].map((match) => match[1] ?? '');
      for (const literal of strings)
        expect(literal, `${name} states a cause`).not.toMatch(
          /\bcaused?\b|\bbecause\b|\bled to\b|\bresulted in\b/i,
        );
    }
    // The modules say so out loud, which is why the rule above can be checked.
    expect(source('analysis.ts')).toMatch(/not a\s*\n?\/\/\s*claim/);
    expect(source('report.ts')).toMatch(/It is not a causal claim/);
  });
});

describe('the impure seam', () => {
  const execute = readFileSync(path.join(COUNTERFACTUAL_DIR, 'execute.ts'), 'utf8');

  it('is exactly one file, and says so', () => {
    expect(execute).toMatch(/import 'server-only'/);
    // The two seams it uses are the same ones every other run endpoint uses.
    expect(execute).toMatch(/from '@\/lib\/business\/simulation-persistence'/);
    expect(execute).toMatch(/from '@\/lib\/business\/simulation-evaluation'/);
    expect(execute).toMatch(/loadRun\(/);
    expect(execute).toMatch(/toEvaluationInput\(/);
  });

  it('opens no database client of its own and writes nothing', () => {
    // The owner-scoped read is the persistence layer's; a direct client here
    // would bypass that scoping.
    expect(execute).not.toMatch(/from '@\/lib\/db'/);
    expect(execute).not.toMatch(/@prisma\/client|prisma\s*\./);
    expect(execute).not.toMatch(
      /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
  });

  it('creates no run and drives no agent', () => {
    // Analysing a run is not running one: no second simulation, no model call.
    expect(execute).not.toMatch(/runTurn\(|initializeScenarioRun\(|createRun\(|initializeRun\(/);
    expect(execute).not.toMatch(/invokeResourceAgent|resolveAgentProvider|provider/i);
    expect(execute).not.toMatch(/Math\.random|Date\.now/);
  });

  it('scopes every analysis to the signed-in owner', () => {
    expect(execute).toMatch(/loadRun\(request\.runId, request\.ownerId\)/);
    // A missing or foreign run is one answer, so the endpoint cannot be used to
    // learn whether someone else's run id exists.
    expect(execute).toMatch(/if \(!run\) return null/);
  });
});

describe('the counterfactual route', () => {
  const route = readFileSync(ROUTE, 'utf8');

  it('authenticates with the project’s own auth gate and declares the runtime', () => {
    expect(route).toMatch(/import \{ requireAuth/);
    expect(route).toMatch(/from '@\/lib\/require-auth'/);
    expect(route).toMatch(/await requireAuth\(req\)/);
    expect(route).toMatch(/export const dynamic = 'force-dynamic'/);
  });

  it('reads the analysis rather than accepting one', () => {
    // The handler takes no body: a caller cannot submit evidence, an action
    // space, a continuation policy or a scoring rule.
    expect(route).toMatch(/analyzePersistedCounterfactual\(/);
    expect(route).not.toMatch(/request\.json\(\)|await req\.json\(\)/);
    expect(route).not.toMatch(/EvaluationInput|SimulationActionInput|ActionCandidate/);
    expect(route).not.toMatch(/evaluateRun\(|evaluateSimulationAction\(/);
  });

  it('scopes the analysis to the signed-in owner', () => {
    expect(route).toMatch(/ownerId: user\.id/);
    expect(route).not.toMatch(/ownerId:\s*(parsed|body|req|params)/);
  });

  it('answers a missing run and a bad decision index with a status, not a 500', () => {
    // 404 for a run that is not the caller's, 400 for an index the run does not
    // have or a decision parameter that is not an index, 409 for evidence that
    // cannot carry an analysis — a conflict with the trace, not with the request.
    for (const status of [404, 400, 409]) expect(route).toMatch(new RegExp(`\\b${status}\\b`));
    expect(route).toMatch(/UNKNOWN_DECISION/);
    expect(route).toMatch(/instanceof CounterfactualError/);
    // An unrecognised failure is not swallowed.
    expect(route).toMatch(/throw error/);
  });

  it('serves the report by default and one decision on request', () => {
    expect(route).toMatch(/kind === 'report'/);
    expect(route).toMatch(/outcome\.report/);
    expect(route).toMatch(/outcome\.analysis/);
    expect(route).toMatch(/Number\.parseInt/);
  });

  it('accepts only a plain integer as a decision index', () => {
    // `Number.parseInt` reads `1.5` and `1abc` as decision 1, so a parameter
    // checked only for "is a number" would answer for a decision the caller never
    // asked about. The parameter is pattern-checked before it is read, and the
    // pattern is bounded so the parse cannot lose precision either.
    expect(route).toMatch(/test\(requested\)/);
    expect(route).toMatch(/\^\\d\{1,\d+\}\$/);
  });
});

describe('the request contract', () => {
  it('carries no evidence, policy or scoring input', () => {
    const types = source('types.ts');
    // Every schema the engine parses is a shape it produces, never one a caller
    // supplies as a finding.
    expect(types).toMatch(/CounterfactualReport = z\.object/);
    expect(types).toMatch(/CounterfactualDecisionAnalysis = z\.object/);
    // Nothing executable in any contract.
    expect(types).not.toMatch(/z\.function|z\.custom/);
  });

  it('errors carry a code the route can map onto a status', () => {
    const types = source('types.ts');
    expect(types).toMatch(/COUNTERFACTUAL_ERROR_CODES/);
    for (const code of [
      'INVALID_SOURCE',
      'TOO_MANY_DECISIONS',
      'UNKNOWN_DECISION',
      'INVALID_ACTION_SPACE',
      'INVALID_RESULT',
    ])
      expect(types).toContain(`'${code}'`);
    expect(types).toMatch(/class CounterfactualError extends Error/);
  });
});

describe('the counterfactual engine’s own arithmetic', () => {
  it('is the benchmark engine’s, not a second implementation', () => {
    // One rounding rule for the project. A local `Math.round(x * 100) / 100`
    // would round a binary approximation of a decimal and could disagree with
    // the benchmark engine on the same numbers.
    expect(source('report.ts')).toMatch(/from '@\/lib\/benchmarks\/arithmetic'/);
    expect(source('analysis.ts')).toMatch(/from '@\/lib\/benchmarks\/arithmetic'/);
    for (const { name, code: text } of codeModules) {
      expect(text, `${name} must not round a score itself`).not.toMatch(/Math\.round\(|toFixed\(/);
    }
  });
});
