//
// A frozen, in-process registry built once from the shipped definitions. There
// is no filesystem discovery, no dynamic import and no user-supplied code path:
// an id from a request can only ever match a definition that is compiled into
// this module, and a version that does not match is refused rather than
// silently upgraded to whatever the catalogue holds today.

import { SCENARIO_DEFINITIONS } from './definitions';
import { Scenario, ScenarioError, type ScenarioSummary } from './types';

/**
 * Parsed once, at module load, so a malformed shipped definition fails at
 * startup rather than halfway through creating somebody's run. Everything is
 * frozen: a caller cannot reach into the catalogue and rewrite a scenario.
 */
const CATALOG: readonly Scenario[] = Object.freeze(
  SCENARIO_DEFINITIONS.map((definition) => Object.freeze(Scenario.parse(definition))),
);

/** Every scenario, in declared catalogue order. */
export function listScenarios(): readonly Scenario[] {
  return CATALOG;
}

/**
 * One scenario by id, optionally pinned to an exact version. Returns `null`
 * rather than throwing when there is no match, for callers that treat an
 * unknown id as user input (the create endpoints do).
 */
export function findScenario(id: string, version?: number | null): Scenario | null {
  const scenario = CATALOG.find((entry) => entry.id === id);
  if (!scenario) return null;
  if (version === undefined || version === null) return scenario;
  return scenario.version === version ? scenario : null;
}

/**
 * One scenario by id, or by id *and* recorded version.
 *
 * The version is part of the lookup because a persisted run names the exact
 * definition that shaped it. When the catalogue has moved on, re-running that
 * run under a different definition would be a different experiment wearing the
 * same id — so the mismatch is refused, loudly, rather than quietly accepted.
 */
export function getScenario(id: string, version?: number | null): Scenario {
  const scenario = findScenario(id, version);
  if (scenario) return scenario;
  const known = CATALOG.find((entry) => entry.id === id);
  if (!known) throw new ScenarioError('UNKNOWN_SCENARIO', `Unknown scenario: ${id}.`);
  throw new ScenarioError(
    'UNKNOWN_SCENARIO',
    `Scenario ${id} was recorded at version ${version}, but the catalogue only ships version ${known.version}.`,
  );
}

export function scenarioSummary(scenario: Scenario): ScenarioSummary {
  return {
    id: scenario.id,
    name: scenario.name,
    description: scenario.description,
    version: scenario.version,
  };
}

/** The catalogue as the `/api/scenarios` endpoint serves it. */
export function listScenarioSummaries(): ScenarioSummary[] {
  return CATALOG.map(scenarioSummary);
}
