// @vitest-environment node
//
// BOUNDARIES — the benchmark is a simulation, and these are the walls.
//
// The $10K Trading Challenge is a set of integers and pure functions. It has no
// broker, no venue, no account, no key, no socket and no clock, and the reason
// this file reads source text rather than calling functions is that the failure
// it guards against is not a wrong number — it is a future edit that adds one
// import. A test that only exercised the happy path would keep passing on the
// day someone wired an execution client into the order path.
//
// So: every module the trading world is built from has its imports pinned to an
// allow-list, and a list of forbidden vocabulary is refused wherever it appears
// in that code. The words are the contract. If a legitimate need for one of them
// ever arises, this file is where the conversation happens.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isKnownEnvironmentKey, SIMULATION_ENVIRONMENTS } from '@/lib/environments/registry';
import { RESOURCE_ROUTING_ENVIRONMENT } from '@/lib/environments/resource-routing';
import {
  TRADING_CONSTRAINTS,
  TRADING_ENVIRONMENT_KEY,
  TRADING_OBJECTIVE_KEY,
} from '@/lib/trading/definitions';
import { TRADING_ENVIRONMENT } from '@/lib/trading/environment';

const ROOT = process.cwd();

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * Source with comments removed. The modules document their invariants in prose —
 * prose that legitimately names the things the code must never do ("no broker",
 * "never submits an order"), so a guard that read the comments would forbid the
 * documentation of its own rule.
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

const TRADING_FILES = [
  'src/lib/trading/definitions.ts',
  'src/lib/trading/market.ts',
  'src/lib/trading/portfolio.ts',
  'src/lib/trading/environment.ts',
  'src/lib/trading/index.ts',
] as const;

const REGISTRY_FILES = [
  'src/lib/environments/types.ts',
  'src/lib/environments/registry.ts',
] as const;

/**
 * Every import the trading world and the dispatch seam are permitted.
 *
 * What is absent is the point: no provider SDK, no database client, no HTTP
 * client, no broker or market-data package, no `server-only` escape, no
 * request layer. The only non-relative imports are the shared simulation
 * contracts, zod, the business constants, the evaluation profile the resource
 * world already published, and the two worlds' own modules.
 */
const ALLOWED_IMPORTS: Record<string, string[]> = {
  'src/lib/trading/definitions.ts': ['@/lib/contracts/simulation'],
  'src/lib/trading/market.ts': ['@/lib/contracts/simulation', './definitions'],
  'src/lib/trading/portfolio.ts': ['@/lib/contracts/simulation', './definitions'],
  'src/lib/trading/environment.ts': [
    '@/lib/business/simulation',
    '@/lib/contracts/simulation',
    '@/lib/environments/types',
    './definitions',
    './market',
    './portfolio',
  ],
  'src/lib/trading/index.ts': ['./definitions', './environment', './market', './portfolio'],
  'src/lib/environments/types.ts': [
    '@/lib/contracts/simulation',
    '@/lib/contracts/simulation-agent',
    'zod',
  ],
  'src/lib/environments/registry.ts': [
    '@/lib/contracts/simulation',
    '@/lib/trading/environment',
    './resource-routing',
    './types',
  ],
};

/**
 * Vocabulary that must never appear in the trading world's code, with why.
 *
 * The first group is the benchmark's own determinism: a trading run has to
 * reproduce from its seed, its configuration and its actions, so ambient time
 * and randomness are disqualifying. The second group is the simulation-only
 * boundary: nothing here may reach a venue, an account, a credential or a
 * socket, and nothing may read configuration that could point one at a real one.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bMath\.random\b/, 'randomness without a seeded source'],
  [/\bDate\b/, 'ambient time (the market is a function of the step, not the clock)'],
  [/\bperformance\.now\b/, 'ambient time'],
  [/\brandomUUID\b/, 'generated identity'],
  [/\bcrypto\b/, 'generated identity'],
  [/\bprocess\.env\b/, 'environment-dependent behaviour (a key, a URL, an account)'],
  [/\bfetch\s*\(/, 'network access'],
  [/\bXMLHttpRequest\b/, 'network access'],
  [/\bWebSocket\b/, 'network access'],
  [/\bhttps?:\/\//, 'a network endpoint'],
  [/\baxios\b/i, 'network access'],
  [/\bnode:http\b|\bnode:net\b|\bnode:tls\b/, 'network access'],
  [/\bAbortController\b/, 'a request in flight'],
  [/\bconsole\./, 'side-effecting logging (a refusal must not be logged as a secret)'],
  [/\bprisma\b/i, 'persistence'],
  [/\bopenrouter\b/i, 'model provider'],
  [/\bbedrock\b/i, 'model provider'],
  [/\bstrands\b/i, 'agent runtime'],
  [/\banthropic\b/i, 'model provider'],
  [/\bopenai\b/i, 'model provider'],
  [/\bsetTimeout\b|\bsetInterval\b/, 'scheduling'],
  [/\beval\s*\(|\bnew Function\b/, 'executable content'],
  // The simulation-only boundary, stated as vocabulary.
  [/\bbroker\b/i, 'a brokerage'],
  [/\bbrokerage\b/i, 'a brokerage'],
  [/\balpaca\b/i, 'a live venue'],
  [/\brobinhood\b/i, 'a live venue'],
  [/\bibkr\b/i, 'a live venue'],
  [/\binvestopedia\b/i, 'a live venue'],
  [/\bcoinbase\b/i, 'a live venue'],
  [/\bapi[_-]?key\b/i, 'a credential'],
  [/\bsecret\b/i, 'a credential'],
  [/\baccess[_-]?token\b/i, 'a credential'],
  [/\bbearer\b/i, 'a credential'],
  [/\baccount[_-]?id\b/i, 'a real account'],
  [/\border[_-]?id\b/i, 'a real order identifier'],
  [/\bplace[_-]?order\b/i, 'order submission'],
  [/\bsubmit[_-]?order\b/i, 'order submission'],
  [/\bexecute[_-]?trade\b/i, 'real execution'],
  [/\bmarket[_-]?data[_-]?(api|feed|url)\b/i, 'a live market feed'],
];

/**
 * A note on `deposit` and `withdraw`, which are absent from the list above
 * deliberately. Those words DO appear in this world — in the constraint list it
 * publishes to the agent: "no deposit, withdrawal or leverage is available".
 * That sentence is the benchmark stating its own boundary, so it is asserted
 * positively further down rather than banned here. The ban belongs on a code
 * path that could move money, and there is no such path to ban: nothing in these
 * files imports a socket, a client, a credential or a configuration value.
 */

describe('the trading world is inert, deterministic and offline', () => {
  for (const file of [...TRADING_FILES, ...REGISTRY_FILES]) {
    it(`${file} imports nothing but the allow-list`, () => {
      const allowed = ALLOWED_IMPORTS[file];
      expect(allowed, `no allow-list entry for ${file}`).toBeDefined();
      const actual = importSpecifiers(file);
      for (const specifier of actual) expect(allowed as string[], specifier).toContain(specifier);
    });

    it(`${file} contains none of the forbidden vocabulary`, () => {
      const source = code(file);
      for (const [pattern, why] of FORBIDDEN)
        expect(pattern.test(source), `${file} contains ${pattern} — ${why}`).toBe(false);
    });
  }

  it('pins the two worlds the seam dispatches between, and no third', () => {
    // The registry is the one module that knows which worlds exist. A third
    // entry is a deliberate act, and this is where it gets noticed: the pair is
    // named, frozen, and the resource world is still first.
    expect(SIMULATION_ENVIRONMENTS.map((environment) => environment.key)).toEqual([
      'resource-routing',
      TRADING_ENVIRONMENT_KEY,
    ]);
    expect(Object.isFrozen(SIMULATION_ENVIRONMENTS)).toBe(true);
    expect(SIMULATION_ENVIRONMENTS[0]).toBe(RESOURCE_ROUTING_ENVIRONMENT);
    // It reaches the trading world through its published environment object and
    // not through the market or the portfolio directly: the seam hands the world
    // to the pipeline whole, rather than reassembling it from parts.
    // Its import set exactly, not merely within it: the seam's only door to this
    // world is the world's own environment object, never its market, its
    // portfolio or its definitions.
    expect(importSpecifiers('src/lib/environments/registry.ts')).toEqual(
      [...(ALLOWED_IMPORTS['src/lib/environments/registry.ts'] as string[])].sort(),
    );
    const registry = code('src/lib/environments/registry.ts');
    expect(registry).toContain('SIMULATION_ENVIRONMENTS');
    expect(registry).toContain('TRADING_ENVIRONMENT');
    expect(registry).toContain('RESOURCE_ROUTING_ENVIRONMENT');
    // And no third world is reachable by a key that is not one of the two.
    expect(isKnownEnvironmentKey('trading-10k')).toBe(true);
    expect(isKnownEnvironmentKey('resource-routing')).toBe(true);
    for (const key of ['equities', 'crypto', 'forex', 'trading', 'paper-trading'])
      expect(isKnownEnvironmentKey(key), key).toBe(false);
  });
});

describe('the surface a trading agent is offered cannot place a real order', () => {
  it('offers two read-only probes and one request into the simulator', () => {
    const names = TRADING_ENVIRONMENT.agentTools.observations.map((tool) => tool.name);
    expect(names).toEqual(['inspect_market', 'inspect_portfolio']);
    // The action tool is a REQUEST. It hands the simulator an intention; it does
    // not execute anything, and the environment's validator is what decides.
    expect(TRADING_ENVIRONMENT.agentTools.action.name).toBe('request_action');
    // There is no tool for connecting, authenticating, funding or executing.
    const surface = JSON.stringify({
      observations: TRADING_ENVIRONMENT.agentTools.observations,
      action: TRADING_ENVIRONMENT.agentTools.action,
    }).toLowerCase();
    for (const word of [
      'broker',
      'brokerage',
      'account',
      'credential',
      'api key',
      'api_key',
      'apikey',
      'token',
      'password',
      'secret',
      'connect',
      'authenticate',
      'live',
      'real money',
      'deposit',
      'withdraw',
      'transfer',
      'wire',
    ])
      expect(surface, `the trading tool surface must not offer ${word}`).not.toContain(word);
  });

  it('publishes actions that only a simulator can honour', () => {
    // The permitted verbs are the three the state machine implements. An action
    // type outside this set is refused by the validator rather than forwarded
    // anywhere, and there is nowhere for it to be forwarded to.
    expect(TRADING_ENVIRONMENT.actionTypes).toEqual(['buy', 'sell', 'hold']);
    for (const verb of ['execute', 'submit', 'connect', 'authenticate', 'deposit', 'withdraw'])
      expect(TRADING_ENVIRONMENT.actionTypes).not.toContain(verb);
  });

  it('names the world and objective by constants, not by a string an env var could set', () => {
    expect(TRADING_ENVIRONMENT.key).toBe(TRADING_ENVIRONMENT_KEY);
    expect(TRADING_ENVIRONMENT.objectives.map((objective) => objective.key)).toEqual([
      TRADING_OBJECTIVE_KEY,
    ]);
    expect(TRADING_ENVIRONMENT_KEY).toBe('trading-10k');
  });
});

describe('the world states the simulation-only boundary to the agent', () => {
  it('tells the agent its capital is fixed and no venue can be reached', () => {
    // The spec's boundary, in the words the agent actually reads. Asserted
    // because "the benchmark never moves money" is only half the property: the
    // other half is that the agent is TOLD so, and does not spend a decision
    // looking for a deposit function that does not exist.
    const constraints = TRADING_CONSTRAINTS.join(' \n ');
    expect(constraints).toMatch(/no deposit,\s*withdrawal or leverage/i);
    expect(constraints).toMatch(/\$10,000/);
    // And the surface it is offered is described as a simulation.
    expect(TRADING_ENVIRONMENT.option.description).toContain('simulated');
    expect(TRADING_ENVIRONMENT.option.description).toContain('risk constraints');
  });

  it('publishes no constraint that implies an external venue exists', () => {
    const constraints = TRADING_CONSTRAINTS.join(' ').toLowerCase();
    for (const word of ['broker', 'exchange account', 'margin call', 'settlement', 'counterparty'])
      expect(constraints, `the constraints must not imply ${word}`).not.toContain(word);
  });
});

describe('the benchmark’s own source carries no live-trading path', () => {
  const BENCHMARK_SOURCES = [
    'src/lib/benchmarks/definitions.ts',
    'src/lib/benchmarks/execute.ts',
    'src/lib/benchmarks/matrix.ts',
    'src/lib/benchmarks/robustness.ts',
  ] as const;

  it('keeps the benchmark runner free of network and execution vocabulary', () => {
    for (const file of BENCHMARK_SOURCES) {
      const source = code(file);
      for (const pattern of [
        /\bfetch\s*\(/,
        /\bWebSocket\b/,
        /\bprocess\.env\b/,
        /\bMath\.random\b/,
        /\bDate\b/,
      ])
        expect(pattern.test(source), `${file} contains ${pattern}`).toBe(false);
    }
  });

  it('reaches the trading world only through the shipped registry and definitions', () => {
    // The benchmark describes a run; it does not know how a market moves. The
    // price model lives behind the environment, so a definition can name the
    // world and the conditions without reaching into either.
    const imports = importSpecifiers('src/lib/benchmarks/definitions.ts');
    for (const specifier of imports) expect(specifier).not.toContain('@/lib/trading/market');
    const tradingImports = imports.filter((specifier) => specifier.startsWith('@/lib/trading/'));
    for (const specifier of tradingImports)
      expect(['@/lib/trading/definitions', '@/lib/trading/environment']).toContain(specifier);
  });
});

describe('no credential or secret can be read into a run', () => {
  it('has no environment-variable read anywhere in the world or the seam', () => {
    // Stated separately from the vocabulary sweep because it is the specific
    // mechanism by which a benchmark would acquire a key: if nothing reads
    // `process.env`, no deployment can configure this world into a live one.
    for (const file of [...TRADING_FILES, ...REGISTRY_FILES]) {
      const source = read(file);
      expect(source, `${file} reads process.env`).not.toMatch(/process\.env/);
      expect(source, `${file} references a Next runtime config`).not.toMatch(
        /next\/config|runtime\s*=\s*['"]/,
      );
    }
  });

  it('carries no URL-shaped literal in the world it simulates', () => {
    for (const file of TRADING_FILES) {
      const source = code(file);
      expect(source, `${file} contains a URL`).not.toMatch(/https?:\/\//);
      expect(source, `${file} contains a host`).not.toMatch(/wss?:\/\//);
    }
  });
});
