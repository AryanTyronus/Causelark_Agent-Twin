//
// Fixtures for the trading tests.
//
// Deliberately thin: the state a fixture returns is built by the shipped
// environment rather than assembled by hand, so a fixture cannot drift from the
// world it is a fixture of. What lives here is the small amount of naming the
// test files share — which seed, which objective, which state a run opens in.

import type { SimulationState } from '@/lib/contracts/simulation';
import { initializeScenarioRun } from '@/lib/scenarios/scenario';
import { TRADING_ENVIRONMENT_KEY, TRADING_OBJECTIVE_KEY } from '@/lib/trading/definitions';

/** The seed the benchmark definition ships. */
export const SEED = 1042;

/** Every seed the deployment publishes, for sweeps that must not assume one. */
export const SUPPORTED_SEEDS = [1042, 2048, 4242, 9182] as const;

/** The starting state of a trading run, scenario-free: exactly what the world builds. */
export function INITIAL_STATE(seed = SEED): SimulationState {
  return initializeScenarioRun({
    environmentKey: TRADING_ENVIRONMENT_KEY,
    objectiveKey: TRADING_OBJECTIVE_KEY,
    seed,
  }).state;
}

/** The starting state of a trading run under one of the seven conditions. */
export function INITIAL_STATE_FOR(scenarioId: string, seed = SEED): SimulationState {
  return initializeScenarioRun({
    environmentKey: TRADING_ENVIRONMENT_KEY,
    objectiveKey: TRADING_OBJECTIVE_KEY,
    seed,
    scenarioId,
  }).state;
}
