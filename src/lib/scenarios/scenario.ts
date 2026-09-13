// @polsia:user-owned — the scenario engine's public surface.
//
// `initializeScenarioRun` is the one seam between the environment and the
// scenario engine: it builds the world the environment would have built, then
// hands it to `applyScenario` before any run row exists and before any agent
// turn can read it. A run created without a scenario skips the engine entirely
// and keeps the exact state and configuration the environment produced, which is
// what keeps every existing run reproducible byte for byte.

import { createInitialSimulationState, DEFAULT_CONFIGURATION } from '@/lib/business/simulation';
import type {
  SimulationConfiguration,
  SimulationEnvironmentKey,
  SimulationObjectiveKey,
  SimulationScenarioIdentity,
  SimulationState,
} from '@/lib/contracts/simulation';
import { applyScenario } from './apply';
import { getScenario } from './catalog';
import type { ScenarioChange } from './types';

export { applyScenario, validateScenarioBaseline } from './apply';
export {
  findScenario,
  getScenario,
  listScenarioSummaries,
  listScenarios,
  scenarioSummary,
} from './catalog';
export {
  BASELINE_SCENARIO_ID,
  BUDGET_PRESSURE_REDUCTION,
  ELEVATED_RISK_INCREASE,
  OUTAGE_CONSTRAINT,
  OUTAGE_LEVEL,
  OUTAGE_RESOURCE,
  REJECTED_ACTION_CONSTRAINT,
  REJECTED_ACTION_TYPE,
  SCARCITY_ENERGY_REDUCTION,
  SCARCITY_MATERIALS_REDUCTION,
  SCARCITY_RESOURCE_FLOOR,
  SCARCITY_WATER_REDUCTION,
  SCENARIO_DEFINITIONS,
  TIGHT_STEP_LIMIT_REDUCTION,
} from './definitions';
export { applyModifier, SCENARIO_MODIFIER_KINDS } from './modifiers';
export * from './types';

/** A world ready to persist, plus the scenario that shaped it. */
export interface ScenarioInitialization {
  state: SimulationState;
  configuration: SimulationConfiguration;
  /** `null` when the run was created without a scenario. */
  scenario: SimulationScenarioIdentity | null;
  /** Catalogue name at creation time, for the trace only; never persisted. */
  name: string | null;
  changes: ScenarioChange[];
}

export interface ScenarioInitializationInput {
  environmentKey: SimulationEnvironmentKey;
  objectiveKey: SimulationObjectiveKey;
  seed: number;
  configuration?: SimulationConfiguration;
  scenarioId?: string | null;
  /** Pin a recorded version. New runs leave this unset and take the shipped one. */
  scenarioVersion?: number | null;
}

/**
 * Build the initial world for a run, scenario applied.
 *
 * With no scenario id this is exactly `createInitialSimulationState` — same
 * state, same configuration, nothing added. With one, the scenario is resolved
 * from the catalogue (optionally version-pinned) and applied to the baseline
 * before the run is persisted, so the agent can only ever observe the perturbed
 * world and can never act before the perturbation exists.
 */
export function initializeScenarioRun(input: ScenarioInitializationInput): ScenarioInitialization {
  const configuration = input.configuration ?? DEFAULT_CONFIGURATION;
  const state = createInitialSimulationState(
    input.environmentKey,
    input.objectiveKey,
    input.seed,
    configuration,
  );
  if (!input.scenarioId) return { state, configuration, scenario: null, name: null, changes: [] };

  const scenario = getScenario(input.scenarioId, input.scenarioVersion);
  const applied = applyScenario({ state, configuration }, scenario);
  return {
    state: applied.state,
    configuration: applied.configuration,
    scenario: applied.scenario,
    name: applied.name,
    changes: applied.changes,
  };
}

/**
 * The trace record for a scenario application, or `null` when there was none.
 *
 * Applying a scenario is something the environment did to the run before the
 * agent existed, so it is a system event — never an agent action, and never a
 * separate log. The payload carries the identity and the change records, which
 * is the only place the pre-scenario values survive: a run stores the world it
 * started in, not the world it would have started in.
 */
export function describeScenarioApplication(
  initialization: ScenarioInitialization,
): { summary: string; payload: Record<string, unknown> } | null {
  if (!initialization.scenario) return null;
  return {
    summary: `Scenario applied: ${initialization.name} v${initialization.scenario.version}.`,
    payload: {
      scenarioId: initialization.scenario.id,
      scenarioVersion: initialization.scenario.version,
      scenarioName: initialization.name,
      changes: initialization.changes,
    },
  };
}
