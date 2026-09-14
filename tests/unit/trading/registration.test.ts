// @vitest-environment node
//
// REGISTRATION — the benchmark is in the catalogue, beside the existing one.
//
// The requirement this file discharges is mostly a negative one: the $10K
// Trading Challenge had to arrive *without* disturbing Resource Routing
// Robustness. So the assertions here are paired — for every surface that gained
// the trading benchmark, the same surface is checked to still carry the resource
// benchmark, under the same key and the same name it had before.
//
// Registration is data-driven rather than a second wiring path: the catalogue
// reads a definitions array, the templates read a templates array, and the
// scenario catalogue already carried both worlds' conditions. Nothing in this
// file calls a trading-specific registration function, and that is deliberate.

import { describe, expect, it } from 'vitest';
import { getBenchmark, listBenchmarkSummaries } from '@/lib/benchmarks/catalog';
import { BENCHMARK_DEFINITIONS, BENCHMARK_SEEDS } from '@/lib/benchmarks/definitions';
import { buildRunMatrix } from '@/lib/benchmarks/matrix';
import {
  BENCHMARK_ROBUSTNESS_FORMULA,
  type BenchmarkDefinition,
  MAX_BENCHMARK_CASES,
} from '@/lib/benchmarks/types';
import { getSimulationOptions } from '@/lib/business/simulation';
import { EXPERIMENT_TEMPLATES } from '@/lib/comparison/definitions';
import { SIMULATION_ENVIRONMENTS } from '@/lib/environments/registry';
import { TRADING_SCENARIO_IDS } from '@/lib/scenarios/definitions';
import { getScenario, listScenarios } from '@/lib/scenarios/scenario';
import { TRADING_ENVIRONMENT_KEY, TRADING_OBJECTIVE_KEY } from '@/lib/trading/definitions';

const TRADING = getBenchmark('trading-10k') as BenchmarkDefinition;
const RESOURCE = getBenchmark('resource-routing-robustness') as BenchmarkDefinition;

describe('the $10K Trading Challenge is in the benchmark catalogue', () => {
  it('carries the published key, name and description verbatim', () => {
    expect(TRADING.id).toBe('trading-10k');
    expect(TRADING.name).toBe('$10K Trading Challenge');
    expect(TRADING.description).toBe(
      'Evaluate autonomous financial decision-making with a fixed $10,000 simulated portfolio under changing market conditions and risk constraints.',
    );
  });

  it('names the world, the objective and the condition it is measured against', () => {
    expect(TRADING.environmentKey).toBe(TRADING_ENVIRONMENT_KEY);
    expect(TRADING.objectiveKey).toBe(TRADING_OBJECTIVE_KEY);
    expect(TRADING.baselineScenarioId).toBe(TRADING_SCENARIO_IDS[0]);
    // A condition identity is only meaningful inside its own world, so every
    // scenario the definition names has to belong to the world it names.
    for (const scenario of TRADING.scenarios)
      expect(getScenario(scenario.id).environmentKey, scenario.id).toBe(TRADING.environmentKey);
  });

  it('declares its seven conditions once each, at a pinned version', () => {
    expect(TRADING.scenarios.map((scenario) => scenario.id)).toEqual([...TRADING_SCENARIO_IDS]);
    expect(new Set(TRADING.scenarios.map((scenario) => scenario.id)).size).toBe(7);
    for (const scenario of TRADING.scenarios)
      expect(Number.isInteger(scenario.version), scenario.id).toBe(true);
    expect(TRADING.seeds).toEqual([...BENCHMARK_SEEDS]);
    expect(TRADING.scenarios.length * TRADING.seeds.length).toBeLessThanOrEqual(
      MAX_BENCHMARK_CASES,
    );
  });

  it('is reducible by the platform’s own matrix and robustness formula', () => {
    const cells = buildRunMatrix(TRADING);
    expect(cells).toHaveLength(TRADING.scenarios.length * TRADING.seeds.length);
    expect(cells.filter((cell) => cell.isBaseline)).toHaveLength(TRADING.seeds.length);
    for (const cell of cells) expect(cell.scenarioVersion).toBeGreaterThan(0);
    // The formula is a constant of the schema both benchmarks' reports parse
    // against, so a trading report cannot claim a different reduction.
    expect(BENCHMARK_ROBUSTNESS_FORMULA).toBe('baseline-retention-v1');
  });
});

describe('registering the trading benchmark left Resource Routing Robustness alone', () => {
  it('still carries the resource benchmark under its own key and name', () => {
    expect(RESOURCE.id).toBe('resource-routing-robustness');
    expect(RESOURCE.name).toBe('Resource Routing Robustness');
    expect(RESOURCE.environmentKey).toBe('resource-routing');
    expect(RESOURCE.baselineScenarioId).toBe('baseline');
  });

  it('lists both benchmarks, and the resource one keeps its place first', () => {
    // Order is the catalogue's own. The resource benchmark shipped first and is
    // still the one a reader sees first, so a picker's default does not move.
    const ids = BENCHMARK_DEFINITIONS.map((definition) => definition.id);
    expect(ids).toEqual(['resource-routing-robustness', 'trading-10k']);
    expect(listBenchmarkSummaries().map((summary) => summary.id)).toEqual(ids);
  });

  it('summarises both for the picker, each with its own conditions and version', () => {
    const summaries = listBenchmarkSummaries();
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      expect(summary.name.length, summary.id).toBeGreaterThan(0);
      expect(summary.description.length, summary.id).toBeGreaterThan(0);
      expect(summary.scenarioCount, summary.id).toBe(7);
      expect(summary.version, summary.id).toBe(1);
    }
    // The two benchmarks are genuinely different measurements, not the same one
    // registered twice under two names.
    const [resource, trading] = summaries;
    expect(resource?.environmentKey).not.toBe(trading?.environmentKey);
    expect(resource?.name).not.toBe(trading?.name);
  });

  it('keeps the resource world’s own declaration unchanged', () => {
    // The seam gained a world; it did not edit the one that was there.
    const resource = SIMULATION_ENVIRONMENTS.find(
      (environment) => environment.key === 'resource-routing',
    );
    expect(resource?.option.title).toBe('Resource routing');
    expect(resource?.actionTypes).toEqual(['harvest', 'allocate', 'rest']);
  });
});

describe('both worlds are offered by the same catalogue surfaces', () => {
  it('carries the registry’s own world list, without a second declaration of it', () => {
    // The catalogue the lab form reads is built from the same registry the
    // pipeline dispatches through, so a world that exists in one exists in the
    // other. The resource world is still the only entry the form offers, which
    // is what keeps the lab's run starter building exactly what it built before.
    const catalogue = getSimulationOptions();
    expect(catalogue.environments.map((environment) => environment.key)).toEqual([
      'resource-routing',
    ]);
    expect(SIMULATION_ENVIRONMENTS.map((environment) => environment.key)).toEqual([
      'resource-routing',
      TRADING_ENVIRONMENT_KEY,
    ]);
    // Every objective the form offers belongs to a world the registry ships.
    // Widened to `string` because the catalogue's keys are a plain string while
    // the registry's are the literal union it dispatches on — the comparison is
    // about membership, not about which type is the narrower one.
    const shipped = new Set<string>(SIMULATION_ENVIRONMENTS.map((environment) => environment.key));
    for (const environment of catalogue.environments)
      expect(shipped.has(environment.key), environment.key).toBe(true);
    expect(catalogue.objectives.map((objective) => objective.key)).not.toContain(
      TRADING_OBJECTIVE_KEY,
    );
  });

  it('publishes all fourteen conditions, seven from each world', () => {
    const scenarios = listScenarios();
    expect(scenarios).toHaveLength(14);
    expect(scenarios.filter((s) => s.environmentKey === TRADING_ENVIRONMENT_KEY)).toHaveLength(7);
    expect(scenarios.filter((s) => s.environmentKey === 'resource-routing')).toHaveLength(7);
    // No id is shared, so a run can be attributed to one world by its condition
    // alone — which is how the degradation table is keyed.
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(scenarios.length);
  });

  it('offers a comparison template per benchmark, both naming their own benchmark', () => {
    expect(EXPERIMENT_TEMPLATES).toHaveLength(2);
    const resource = EXPERIMENT_TEMPLATES.find((t) => t.benchmarkId === RESOURCE.id);
    const trading = EXPERIMENT_TEMPLATES.find((t) => t.benchmarkId === TRADING.id);
    expect(resource?.id).toBe('resource-routing-agent-comparison');
    expect(trading?.id).toBe('trading-10k-agent-comparison');
    // Every template points at a benchmark that actually ships, at the version
    // that ships — a template is a promise the catalogue has to be able to keep.
    for (const template of EXPERIMENT_TEMPLATES) {
      const definition = getBenchmark(template.benchmarkId);
      expect(definition, template.id).toBeDefined();
      expect(definition?.version, template.id).toBe(template.benchmarkVersion);
    }
    // And the trading template states the boundary in the text a user reads.
    expect(trading?.description).toContain('Simulated portfolio only');
    expect(trading?.description).toContain('no brokerage');
  });
});
