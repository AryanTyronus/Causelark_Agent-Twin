// @vitest-environment node
// @polsia:user-owned — the plan, and the digest a person authorises.
//
// The plan is the boundary between what an operator may imagine and what this
// deployment can actually run. These tests are about one property: that every
// field of a plan comes from the benchmark registry or the agent catalogue, and
// that anything else is refused with a message naming what does exist — so the
// operator can correct itself rather than invent a benchmark definition.

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ env: { NODE_ENV: 'test' } }));

vi.mock('@/lib/business/agent-catalog', async () => {
  const fixtures = await import('./agent-twin/operator-fixtures');
  return {
    deploymentAgentCatalog: () => fixtures.CATALOG,
    emptyAgentCatalog: () => fixtures.EMPTY_CATALOG,
  };
});

import { getBenchmark, listBenchmarkSummaries } from '@/lib/benchmarks/catalog';
import { MAX_BENCHMARK_CASES, MAX_BENCHMARK_SEEDS } from '@/lib/benchmarks/types';
import { operatorBounds } from '@/lib/operator/config';
import { buildOperatorPlan, OperatorPlanRefusal, planFingerprint } from '@/lib/operator/plan';
import { CATALOG, fixturePlan } from './agent-twin/operator-fixtures';

const REGISTRY = listBenchmarkSummaries();
const BENCHMARK = REGISTRY[0];
if (!BENCHMARK) throw new Error('The benchmark registry is empty; these tests need one benchmark.');
const BENCHMARK_ID = BENCHMARK.id;
const AGENT_KEY = CATALOG.agents[0]?.key ?? '';
const OBJECTIVE = 'Test this agent and tell me whether it is ready to deploy.';

function plan(overrides: Partial<Parameters<typeof buildOperatorPlan>[0]> = {}) {
  return buildOperatorPlan({
    objective: OBJECTIVE,
    benchmarkId: BENCHMARK_ID,
    agentKey: AGENT_KEY,
    ...overrides,
  });
}

describe('a plan is copied, never invented', () => {
  it('takes every benchmark field from the registry', () => {
    const definition = getBenchmark(BENCHMARK_ID, null);
    const built = plan();

    expect(built.benchmark.id).toBe(definition.id);
    expect(built.benchmark.version).toBe(definition.version);
    expect(built.benchmark.name).toBe(definition.name);
    expect(built.benchmark.environmentKey).toBe(definition.environmentKey);
    expect(built.benchmark.objectiveKey).toBe(definition.objectiveKey);
    expect(built.scenarios.map((scenario) => `${scenario.id}@${scenario.version}`)).toEqual(
      definition.scenarios.map((scenario) => `${scenario.id}@${scenario.version}`),
    );
    expect(built.seeds).toEqual(definition.seeds);
  });

  it('takes every agent field from the catalogue', () => {
    const agent = CATALOG.agents[0];
    if (!agent) throw new Error('The fixture catalogue is empty.');
    const built = plan();

    expect(built.agent.key).toBe(agent.key);
    expect(built.agent.identity).toBe(agent.identity);
    expect(built.agent.provider).toBe(agent.configuration.provider);
    expect(built.agent.model).toBe(agent.configuration.model);
  });

  it('states the number of provider-driven simulations a person is authorising', () => {
    const built = plan();
    expect(built.caseCount).toBe(built.scenarios.length * built.seeds.length);
    expect(built.providerDrivenSimulations).toBe(built.caseCount);
  });

  it('publishes the bounds the execution will run under', () => {
    expect(plan().bounds).toEqual(operatorBounds());
  });

  it('marks exactly the registry baseline condition as the baseline', () => {
    const built = plan();
    const baselines = built.scenarios.filter((scenario) => scenario.isBaseline);
    expect(baselines.length).toBeLessThanOrEqual(1);
    for (const scenario of built.scenarios)
      expect(scenario.version).toBe(
        getBenchmark(BENCHMARK_ID, null).scenarios.find((entry) => entry.id === scenario.id)
          ?.version,
      );
  });
});

describe('a plan that cannot be built is refused, and says why', () => {
  it('refuses a benchmark that is not registered', () => {
    expect(() => plan({ benchmarkId: 'a-benchmark-i-just-made-up' })).toThrow(OperatorPlanRefusal);
    expect(() => plan({ benchmarkId: 'a-benchmark-i-just-made-up' })).toThrow(
      /a-benchmark-i-just-made-up/,
    );
  });

  it('refuses a version that does not exist', () => {
    expect(() => plan({ benchmarkVersion: 999 })).toThrow(OperatorPlanRefusal);
  });

  it('refuses an agent this deployment cannot run, and lists the ones it can', () => {
    try {
      plan({ agentKey: 'agent-from-another-deployment' });
      throw new Error('the plan should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(OperatorPlanRefusal);
      expect((error as Error).message).toContain('agent-from-another-deployment');
      expect((error as Error).message).toContain(AGENT_KEY);
    }
  });

  it('refuses a seed the definition does not declare, naming the declared set', () => {
    const declared = getBenchmark(BENCHMARK_ID, null).seeds;
    const undeclared = declared.includes(424242) ? 1 : 424242;
    try {
      plan({ seeds: [undeclared] });
      throw new Error('the plan should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(OperatorPlanRefusal);
      expect((error as Error).message).toContain(String(undeclared));
      expect((error as Error).message).toContain(String(declared[0]));
    }
  });

  it('refuses more seeds than the benchmark engine allows', () => {
    const declared = getBenchmark(BENCHMARK_ID, null).seeds;
    const first = declared[0];
    if (first === undefined) throw new Error('The benchmark declares no seeds.');
    const tooMany = Array.from({ length: MAX_BENCHMARK_SEEDS + 1 }, (_, index) => first + index);
    expect(() => plan({ seeds: tooMany })).toThrow(OperatorPlanRefusal);
  });

  it('never produces a plan larger than the engine allows', () => {
    const definition = getBenchmark(BENCHMARK_ID, null);
    expect(definition.scenarios.length * definition.seeds.length).toBeLessThanOrEqual(
      MAX_BENCHMARK_CASES,
    );
  });
});

describe("the console suite's plan fixture is the plan this builder produces", () => {
  // `plan.ts` imports `server-only`, which Vitest cannot resolve in a browser
  // environment, so the console suite renders in jsdom against a copy of this
  // builder kept in the shared fixtures. These two tests are what keep the copy
  // honest: identical inputs, identical plan — fingerprint included — and the
  // copy carries no field the real plan does not have. Without them the console
  // could be tested against a plan the server would never send.
  it('produces the same plan, field for field, from the same inputs', () => {
    expect(
      fixturePlan({ objective: OBJECTIVE, benchmarkId: BENCHMARK_ID, agentKey: AGENT_KEY }),
    ).toEqual(plan());
  });

  it('produces no field the real plan does not have', () => {
    const built = plan();
    expect(Object.keys(built).sort()).toEqual(
      Object.keys(
        fixturePlan({ objective: OBJECTIVE, benchmarkId: BENCHMARK_ID, agentKey: AGENT_KEY }),
      ).sort(),
    );
  });
});

describe('the fingerprint covers exactly what was authorised', () => {
  const base = {
    benchmarkId: BENCHMARK_ID,
    benchmarkVersion: 1,
    agentKey: AGENT_KEY,
    seeds: [1, 2],
    scenarios: [
      { id: 'baseline', version: 1 },
      { id: 'perturbed', version: 2 },
    ],
  };

  it('is stable for the same plan', () => {
    expect(planFingerprint(base)).toBe(planFingerprint({ ...base }));
    // Two independent builds of the same plan carry the same digest, which is
    // what lets a preview's fingerprint be presented to a person and honoured
    // by the execution that follows it.
    expect(plan().fingerprint).toBe(plan().fingerprint);
  });

  it('is 32 hex characters, so it can be shown to a person and quoted back', () => {
    expect(planFingerprint(base)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('changes when any covered field changes', () => {
    const original = planFingerprint(base);
    const variants = [
      { ...base, benchmarkId: 'another-benchmark' },
      { ...base, benchmarkVersion: 2 },
      { ...base, agentKey: 'another-agent' },
      { ...base, seeds: [1] },
      { ...base, seeds: [2, 1] },
      { ...base, scenarios: [{ id: 'baseline', version: 1 }] },
      {
        ...base,
        scenarios: [{ id: 'baseline', version: 2 }, base.scenarios[1] ?? { id: 'p', version: 1 }],
      },
    ];
    for (const variant of variants) expect(planFingerprint(variant)).not.toBe(original);
  });

  it('is reproducible from the plan alone, so the server can recompute it', () => {
    const built = plan();
    expect(
      planFingerprint({
        benchmarkId: built.benchmark.id,
        benchmarkVersion: built.benchmark.version,
        agentKey: built.agent.key,
        seeds: built.seeds,
        scenarios: built.scenarios,
      }),
    ).toBe(built.fingerprint);
  });
});
