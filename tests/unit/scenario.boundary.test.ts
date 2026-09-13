// @vitest-environment node
//
// The scenario engine is supposed to be a small, inert, deterministic layer
// wedged between the environment and the agent. That property is easy to lose
// by accident — one `Date.now()` for a version, one provider import for a
// "smart" modifier — so these tests read the module's own source and refuse
// those edits, rather than waiting for a flaky ordering bug to surface.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT = process.cwd();
const MODULE_DIR = path.join(ROOT, 'src/lib/scenarios');
const ROUTE = 'src/app/api/scenarios/route.ts';

const auth = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'unauthorized', calls: 0 }));

// `server-only` is a Next bundler alias, not a resolvable package. The route
// keeps its import — that guard is what stops it being pulled into a client
// bundle — and the module below is asserted not to have one.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({
  requireAuth: async () => {
    auth.calls += 1;
    if (auth.mode === 'unauthorized') {
      throw new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    return { id: 'user-1', email: 'owner@example.test' };
  },
}));

import { GET as listScenarios } from '@/app/api/scenarios/route';
import { DEFAULT_CONFIGURATION, getSimulationOptions } from '@/lib/business/simulation';
import {
  BUDGET_PRESSURE_REDUCTION,
  SCARCITY_ENERGY_REDUCTION,
  SCARCITY_MATERIALS_REDUCTION,
  SCARCITY_WATER_REDUCTION,
  TIGHT_STEP_LIMIT_REDUCTION,
} from '@/lib/scenarios/definitions';
import {
  initializeScenarioRun,
  listScenarios as listScenarioDefinitions,
} from '@/lib/scenarios/scenario';

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * Source with comments removed. Every guard below is about what the code does,
 * and the module documents its invariants in prose — prose that legitimately
 * names the things the code must never do.
 */
function code(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

function importSpecifiers(relative: string): string[] {
  const source = code(relative);
  const specifiers = [
    ...source.matchAll(/\bfrom\s+'([^']+)'/g),
    ...source.matchAll(/\bimport\s+'([^']+)'/g),
  ].map((match) => match[1] as string);
  return [...new Set(specifiers)].sort();
}

const SCENARIO_FILES = [
  'apply.ts',
  'catalog.ts',
  'definitions.ts',
  'modifiers.ts',
  'scenario.ts',
  'types.ts',
] as const;

/**
 * Every import the scenario layer is permitted, per file. Anything outside this
 * is a boundary breach: a model provider, a database client, a clock, a network
 * client, or the request layer.
 */
const ALLOWED_IMPORTS: Record<(typeof SCENARIO_FILES)[number], string[]> = {
  'types.ts': ['@/lib/contracts/simulation', 'zod'],
  'modifiers.ts': ['@/lib/contracts/simulation', './types'],
  'definitions.ts': ['@/lib/business/simulation', '@/lib/contracts/simulation', './types'],
  'catalog.ts': ['./definitions', './types'],
  'apply.ts': ['@/lib/business/simulation', '@/lib/contracts/simulation', './modifiers', './types'],
  'scenario.ts': [
    '@/lib/business/simulation',
    '@/lib/contracts/simulation',
    './apply',
    './catalog',
    './definitions',
    './modifiers',
    './types',
  ],
};

/** Vocabulary that must never appear in scenario code, with why. */
const FORBIDDEN_IN_SCENARIO_CODE: Array<[RegExp, string]> = [
  [/\bMath\.random\b/, 'randomness'],
  [/\bDate\b/, 'ambient time (scenario versions must not be timestamps)'],
  [/\bperformance\.now\b/, 'ambient time'],
  [/\brandomUUID\b/, 'generated identity'],
  [/\bcrypto\b/, 'generated identity'],
  [/\bprocess\.env\b/, 'environment-dependent behaviour'],
  [/\bfetch\s*\(/, 'network access'],
  [/\bXMLHttpRequest\b/, 'network access'],
  [/\bWebSocket\b/, 'network access'],
  [/\bconsole\./, 'side-effecting logging'],
  [/\bprisma\b/i, 'persistence'],
  [/\bopenrouter\b/i, 'model provider'],
  [/\bbedrock\b/i, 'model provider'],
  [/\bstrands\b/i, 'agent runtime'],
  [/\banthropic\b/i, 'model provider'],
  [/\bopenai\b/i, 'model provider'],
  [/\bsetTimeout\b|\bsetInterval\b/, 'scheduling'],
  [/\beval\s*\(|\bnew Function\b/, 'executable scenario content'],
  [/\brejectionReason\b/, 'fabricated rejections (the validator owns rejection)'],
  [/\bPERMISSION_DENIED\b/, 'fabricated rejections (the validator owns rejection)'],
];

afterEach(() => {
  auth.mode = 'ok';
  auth.calls = 0;
});

describe('scenario module surface', () => {
  it('is exactly the known set of files', () => {
    expect(readdirSync(MODULE_DIR).sort()).toEqual([...SCENARIO_FILES]);
  });

  it('imports nothing outside its allow-list', () => {
    for (const file of SCENARIO_FILES) {
      const allowed = ALLOWED_IMPORTS[file];
      for (const specifier of importSpecifiers(`src/lib/scenarios/${file}`)) {
        expect(allowed, `${file} imports ${specifier}`).toContain(specifier);
      }
    }
  });

  it('never reaches a database, provider or request client transitively', () => {
    for (const file of SCENARIO_FILES) {
      const specifiers = importSpecifiers(`src/lib/scenarios/${file}`);
      for (const banned of [
        '@/lib/db',
        '@prisma/client',
        'server-only',
        '@/lib/auth',
        '@/lib/require-auth',
        'next/headers',
        'next/server',
        'next/navigation',
      ]) {
        expect(specifiers, `${file} must not import ${banned}`).not.toContain(banned);
      }
    }
  });

  it('contains no ambient time, randomness, or provider code', () => {
    for (const file of SCENARIO_FILES) {
      const source = code(`src/lib/scenarios/${file}`);
      for (const [pattern, reason] of FORBIDDEN_IN_SCENARIO_CODE) {
        expect(pattern.test(source), `${file} contains ${reason} (${pattern})`).toBe(false);
      }
    }
  });

  it('discovers nothing dynamically', () => {
    for (const file of SCENARIO_FILES) {
      const source = code(`src/lib/scenarios/${file}`);
      // No filesystem discovery, no dynamic import, no require.
      for (const pattern of [
        /\bimport\s*\(/,
        /\brequire\s*\(/,
        /\breaddirSync\b|\breadFileSync\b|\bglob\b/,
        /\bimport\.meta\.glob\b/,
      ]) {
        expect(pattern.test(source), `${file} matches ${pattern}`).toBe(false);
      }
    }
  });

  it('is isomorphic: importing the engine needs no Next runtime', async () => {
    // The engine is imported at the top of this file in a plain node
    // environment, with no `server-only` stub registered — so this test having
    // run at all is the assertion. It is restated as a value so a future
    // `server-only` import fails here loudly rather than in someone's build.
    const engine = await import('@/lib/scenarios/scenario');
    expect(typeof engine.applyScenario).toBe('function');
    expect(typeof engine.listScenarioSummaries).toBe('function');
  });
});

describe('scenario definitions are inert data', () => {
  it('holds only JSON values, with no functions anywhere in the graph', () => {
    const walk = (value: unknown, at: string): void => {
      if (value === null) return;
      const kind = typeof value;
      if (kind === 'string' || kind === 'number' || kind === 'boolean') return;
      if (Array.isArray(value)) {
        value.forEach((entry, index) => {
          walk(entry, `${at}[${index}]`);
        });
        return;
      }
      expect(kind, `${at} is a ${kind}`).toBe('object');
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        walk(entry, `${at}.${key}`);
      }
    };
    for (const scenario of listScenarioDefinitions()) walk(scenario, scenario.id);
  });

  it('survives a JSON round-trip unchanged', () => {
    const scenarios = listScenarioDefinitions();
    expect(JSON.parse(JSON.stringify(scenarios))).toEqual(scenarios);
  });

  it('cannot be mutated through the catalogue', () => {
    const first = listScenarioDefinitions()[0];
    expect(first).toBeDefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first as { version: number }).version = 99;
    }).toThrow();
    expect(listScenarioDefinitions()[0]?.version).toBe(1);
  });

  it('derives its reductions from what the environment publishes', () => {
    const { resources } = getSimulationOptions();
    const startingMinimum = (key: string) => {
      const definition = resources.find((entry) => entry.key === key);
      expect(definition, `the environment publishes ${key}`).toBeDefined();
      return definition?.startingRange[0] ?? Number.NaN;
    };
    // Not arbitrary numbers: half of each published starting minimum.
    expect(SCARCITY_ENERGY_REDUCTION).toBe(Math.floor(startingMinimum('energy') / 2));
    expect(SCARCITY_MATERIALS_REDUCTION).toBe(Math.floor(startingMinimum('materials') / 2));
    expect(SCARCITY_WATER_REDUCTION).toBe(Math.floor(startingMinimum('water') / 2));
    expect(BUDGET_PRESSURE_REDUCTION).toBeGreaterThan(0);
    expect(BUDGET_PRESSURE_REDUCTION).toBeLessThan(DEFAULT_CONFIGURATION.budget);
    expect(TIGHT_STEP_LIMIT_REDUCTION).toBeGreaterThan(0);
    expect(TIGHT_STEP_LIMIT_REDUCTION).toBeLessThan(DEFAULT_CONFIGURATION.maxSteps);
  });
});

describe('scenario application stays behind its seam', () => {
  it('is never invoked directly by a route', () => {
    // Routes initialise through `initializeScenarioRun`, which applies the
    // scenario before the world is handed to a run. Applying a scenario to a
    // live run would let an agent's environment change under it.
    const routes = readdirSync(path.join(ROOT, 'src/app/api'), { recursive: true })
      .map(String)
      .filter((entry) => entry.endsWith('.ts'));
    const offenders = routes.filter((entry) => {
      const source = code(path.join('src/app/api', entry));
      return /\bapplyScenario\s*\(/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it('lets the environment, not the scenario layer, reject actions', () => {
    // The agent tool surface validates through the environment's own evaluator.
    const tools = code('src/lib/agent/resource-tools.ts');
    expect(tools).toMatch(/\bevaluateSimulationAction\b/);
    // And the scenario layer cannot mint a rejection of its own: it has no
    // rejection vocabulary at all (asserted above) and never touches actions.
    for (const file of SCENARIO_FILES) {
      const source = code(`src/lib/scenarios/${file}`);
      expect(/\bSimulationActionRecord\b/.test(source), `${file} builds action records`).toBe(
        false,
      );
    }
  });

  it('starts a scenario run in the perturbed world, before anything can act', () => {
    const initialized = initializeScenarioRun({
      environmentKey: 'resource-routing',
      objectiveKey: 'complete-delivery',
      seed: 1042,
      scenarioId: 'tight-step-limit',
    });
    // Step zero: nothing has happened yet, and the environment already differs.
    expect(initialized.state.step).toBe(0);
    expect(initialized.state.lastAction).toBeNull();
    expect(initialized.state.maxSteps).toBe(
      DEFAULT_CONFIGURATION.maxSteps - TIGHT_STEP_LIMIT_REDUCTION,
    );
    expect(initialized.configuration.maxSteps).toBe(initialized.state.maxSteps);
    expect(initialized.scenario).toEqual({ id: 'tight-step-limit', version: 1 });
  });
});

describe('scenario catalogue endpoint boundary', () => {
  it('requires authentication, like the endpoint it mirrors', () => {
    auth.mode = 'unauthorized';
    return listScenarios(new Request('http://localhost/api/scenarios')).then((response) => {
      expect(response.status).toBe(401);
      expect(auth.calls).toBe(1);
    });
  });

  it('serves only published summaries, never the modifier internals', async () => {
    const response = await listScenarios(new Request('http://localhost/api/scenarios'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { scenarios: Array<Record<string, unknown>> };
    expect(body.scenarios.length).toBeGreaterThan(0);
    for (const entry of body.scenarios) {
      expect(Object.keys(entry).sort()).toEqual(['description', 'id', 'name', 'version']);
      expect(typeof entry.version).toBe('number');
      expect(Number.isInteger(entry.version)).toBe(true);
    }
    expect(JSON.stringify(body)).not.toMatch(/modifier|floor|reduceBy|increaseBy/);
  });

  it('imports only what a read-only catalogue needs', () => {
    const specifiers = importSpecifiers(ROUTE);
    expect(specifiers).toContain('@/lib/require-auth');
    expect(specifiers).toContain('@/lib/scenarios/scenario');
    for (const banned of ['@/lib/db', '@prisma/client', '@/lib/scenarios/apply']) {
      expect(specifiers, `route imports ${banned}`).not.toContain(banned);
    }
    // Authentication happens before the catalogue is read.
    const source = code(ROUTE);
    expect(source.indexOf('requireAuth')).toBeLessThan(source.indexOf('listScenarioSummaries'));
  });
});
