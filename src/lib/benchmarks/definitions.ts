//
// A benchmark definition is data. It names an environment, an ordered list of
// scenario references pinned to exact versions, an ordered seed set, and the
// objective the agent is given. It carries no function, no threshold and no
// scoring rule: the run matrix and the aggregate report are derived from it by
// the pure modules beside this file.
//
// Scenario versions are written out explicitly rather than read from the
// catalogue. If a scenario is revised to version 2, catalogue validation fails
// loudly at module load and this benchmark has to be re-versioned on purpose —
// which is the point. A benchmark that silently followed the newest scenario
// would stop being a reproducible experiment.

import {
  BASELINE_SCENARIO_ID,
  TRADING_BASELINE_SCENARIO_ID,
  TRADING_SCENARIO_IDS,
} from '@/lib/scenarios/definitions';
import { TRADING_ENVIRONMENT_KEY, TRADING_OBJECTIVE_KEY } from '@/lib/trading/definitions';
import type { BenchmarkDefinition } from './types';

/**
 * The version every shipped scenario currently holds, in both worlds. Named so
 * the pin is visible as a pin rather than looking like a literal that happens to
 * work.
 */
export const PINNED_SCENARIO_VERSION = 1;

/** The seven conditions the resource-routing environment publishes, in order. */
export const ROBUSTNESS_SCENARIO_IDS = [
  BASELINE_SCENARIO_ID,
  'resource-scarcity',
  'budget-pressure',
  'elevated-risk',
  'resource-outage',
  'tight-step-limit',
  'action-rejection',
] as const;

/**
 * The default seed set. One seed keeps a default execution to seven real agent
 * runs; the matrix is ordered by scenario and then by seed, so widening this to
 * `[1042, 2048, 4242, 9812]` produces twenty-eight cases in a stable order
 * without changing anything else.
 *
 * Shared by both benchmarks, because it is a statement about what one execution
 * costs rather than about a world: seven conditions at one seed is seven real
 * agent runs either way.
 */
export const BENCHMARK_SEEDS = [1042] as const;

/** The name the seed constant above was published under. */
export const ROBUSTNESS_BENCHMARK_SEEDS = BENCHMARK_SEEDS;

export const BENCHMARK_DEFINITIONS: readonly BenchmarkDefinition[] = [
  {
    id: 'resource-routing-robustness',
    version: 1,
    name: 'Resource Routing Robustness',
    description:
      'Runs one fixed agent under the baseline resource-routing environment and under six controlled perturbations of it, then measures how much of the baseline score survives each change.',
    environmentKey: 'resource-routing',
    objectiveKey: 'complete-delivery',
    baselineScenarioId: BASELINE_SCENARIO_ID,
    scenarios: ROBUSTNESS_SCENARIO_IDS.map((id) => ({
      id,
      version: PINNED_SCENARIO_VERSION,
    })),
    seeds: [...ROBUSTNESS_BENCHMARK_SEEDS],
  },
  {
    id: 'trading-10k',
    version: 1,
    name: '$10K Trading Challenge',
    description:
      'Evaluate autonomous financial decision-making with a fixed $10,000 simulated portfolio under changing market conditions and risk constraints.',
    environmentKey: TRADING_ENVIRONMENT_KEY,
    objectiveKey: TRADING_OBJECTIVE_KEY,
    baselineScenarioId: TRADING_BASELINE_SCENARIO_ID,
    // The conditions come from the scenario catalogue's own published list rather
    // than being restated here, so a condition added to that world cannot be
    // silently missing from the benchmark that is supposed to measure it.
    scenarios: TRADING_SCENARIO_IDS.map((id) => ({ id, version: PINNED_SCENARIO_VERSION })),
    seeds: [...BENCHMARK_SEEDS],
  },
];
