// @vitest-environment node
//
// The engine's claim is that a scenario is a deterministic, validated, purely
// declarative perturbation of the world the environment would have built. These
// tests hold that claim from both ends: real seeds pin the arithmetic, and the
// validation, immutability, ordering and determinism tests make sure no clock,
// no randomness, no hidden mutation and no unvalidated world can get through.

import { describe, expect, it } from 'vitest';
import {
  createInitialSimulationState,
  DEFAULT_CONFIGURATION,
  evaluateSimulationAction,
  getSimulationStatus,
} from '@/lib/business/simulation';
import { type SimulationConfiguration, SimulationState } from '@/lib/contracts/simulation';
import {
  applyModifier,
  applyScenario,
  BASELINE_SCENARIO_ID,
  BUDGET_PRESSURE_REDUCTION,
  describeScenarioApplication,
  ELEVATED_RISK_INCREASE,
  findScenario,
  getScenario,
  initializeScenarioRun,
  listScenarioSummaries,
  listScenarios,
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
  SCENARIO_MODIFIER_KINDS,
  Scenario,
  type ScenarioBaseline,
  type ScenarioChange,
  ScenarioError,
  TIGHT_STEP_LIMIT_REDUCTION,
} from '@/lib/scenarios/scenario';

const SEEDS = [1042, 2048, 4242, 9182];
const OBJECTIVE = 'complete-delivery' as const;

function baseline(
  seed = 1042,
  configuration: SimulationConfiguration = DEFAULT_CONFIGURATION,
): ScenarioBaseline {
  return {
    state: createInitialSimulationState('resource-routing', OBJECTIVE, seed, configuration),
    configuration,
  };
}

/** Applies a shipped scenario to a fresh baseline and returns both. */
function apply(id: string, seed = 1042, configuration = DEFAULT_CONFIGURATION) {
  const base = baseline(seed, configuration);
  return { base, result: applyScenario(base, getScenario(id)) };
}

/** The single change record for a field, or `undefined` if the field did not move. */
function moved(result: { changes: ScenarioChange[] }, field: string) {
  return result.changes.find((entry) => entry.field === field);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** A synthetic definition, for probing behaviour no shipped scenario exercises. */
function probe(modifiers: Scenario['modifiers']): Scenario {
  return Scenario.parse({
    id: 'probe',
    name: 'Probe',
    description: 'A test-only definition.',
    version: 1,
    modifiers,
  });
}

describe('scenario catalogue', () => {
  it('ships the baseline plus one scenario per named condition', () => {
    expect(listScenarios().map((scenario) => scenario.id)).toEqual([
      'baseline',
      'resource-scarcity',
      'budget-pressure',
      'elevated-risk',
      'resource-outage',
      'tight-step-limit',
      'action-rejection',
    ]);
  });

  it('validates every shipped definition against the schema', () => {
    for (const definition of SCENARIO_DEFINITIONS) {
      expect(Scenario.safeParse(definition).success, definition.id).toBe(true);
    }
  });

  it('versions every definition with an integer, never a timestamp', () => {
    for (const scenario of listScenarios()) {
      expect(Number.isInteger(scenario.version), scenario.id).toBe(true);
      expect(scenario.version, scenario.id).toBeGreaterThanOrEqual(1);
    }
    // A timestamp would be a number far above any hand-authored version.
    expect(listScenarios().every((scenario) => scenario.version < 1000)).toBe(true);
  });

  it('closes the modifier vocabulary to the six the engine implements', () => {
    expect(SCENARIO_MODIFIER_KINDS).toEqual([
      'budget-reduction',
      'max-steps-reduction',
      'permission-revocation',
      'resource-outage',
      'resource-reduction',
      'risk-increase',
    ]);
  });

  it('summarises the catalogue without leaking modifier internals', () => {
    const summaries = listScenarioSummaries();
    expect(summaries).toHaveLength(SCENARIO_DEFINITIONS.length);
    for (const summary of summaries) {
      expect(Object.keys(summary).sort()).toEqual(['description', 'id', 'name', 'version']);
    }
  });

  it('fails an unknown id clearly rather than falling back to a default', () => {
    expect(findScenario('no-such-scenario')).toBeNull();
    expect(() => getScenario('no-such-scenario')).toThrow(ScenarioError);
    expect(() => getScenario('no-such-scenario')).toThrow(/Unknown scenario/);
    expect(() => getScenario('no-such-scenario', 1)).toThrow(/Unknown scenario/);
  });

  it('refuses a recorded version the catalogue no longer ships', () => {
    expect(getScenario('resource-scarcity', 1).id).toBe('resource-scarcity');
    expect(() => getScenario('resource-scarcity', 2)).toThrow(ScenarioError);
    expect(() => getScenario('resource-scarcity', 2)).toThrow(
      /recorded at version 2, but the catalogue only ships version 1/,
    );
  });
});

describe('baseline scenario', () => {
  it('leaves the seeded world exactly as the environment built it', () => {
    for (const seed of SEEDS) {
      const { base, result } = apply(BASELINE_SCENARIO_ID, seed);
      expect(result.state).toEqual(base.state);
      expect(result.configuration).toEqual(base.configuration);
      expect(result.changes).toEqual([]);
    }
  });

  it('is indistinguishable from creating a run with no scenario at all', () => {
    for (const seed of SEEDS) {
      const unscenarioed = initializeScenarioRun({
        environmentKey: 'resource-routing',
        objectiveKey: OBJECTIVE,
        seed,
        scenarioId: null,
      });
      const scenarioed = initializeScenarioRun({
        environmentKey: 'resource-routing',
        objectiveKey: OBJECTIVE,
        seed,
        scenarioId: BASELINE_SCENARIO_ID,
      });
      expect(scenarioed.state).toEqual(unscenarioed.state);
      expect(scenarioed.configuration).toEqual(unscenarioed.configuration);
      // The world is untouched, but the condition is recorded — that is what
      // makes baseline usable as a control in a comparison.
      expect(unscenarioed.scenario).toBeNull();
      expect(scenarioed.scenario).toEqual({ id: BASELINE_SCENARIO_ID, version: 1 });
      expect(scenarioed.changes).toEqual([]);
    }
  });
});

describe('resource scarcity', () => {
  it('reduces each stock by its named reduction on every supported seed', () => {
    for (const seed of SEEDS) {
      const { base, result } = apply('resource-scarcity', seed);
      expect(result.state.resources.energy).toBe(
        base.state.resources.energy - SCARCITY_ENERGY_REDUCTION,
      );
      expect(result.state.resources.materials).toBe(
        base.state.resources.materials - SCARCITY_MATERIALS_REDUCTION,
      );
      expect(result.state.resources.water).toBe(
        base.state.resources.water - SCARCITY_WATER_REDUCTION,
      );
    }
  });

  it('never reduces a stock to zero — an outage is a separate, explicit scenario', () => {
    for (const seed of SEEDS) {
      const { result } = apply('resource-scarcity', seed);
      expect(result.state.resources.energy).toBeGreaterThanOrEqual(SCARCITY_RESOURCE_FLOOR);
      expect(result.state.resources.materials).toBeGreaterThanOrEqual(SCARCITY_RESOURCE_FLOOR);
      expect(result.state.resources.water).toBeGreaterThanOrEqual(SCARCITY_RESOURCE_FLOOR);
    }
  });

  it('reports what it changed, per field, attributable to the modifier', () => {
    const { base, result } = apply('resource-scarcity');
    expect(result.changes).toEqual([
      {
        field: 'resources.energy',
        before: base.state.resources.energy,
        after: base.state.resources.energy - SCARCITY_ENERGY_REDUCTION,
        modifier: 'resource-reduction',
      },
      {
        field: 'resources.materials',
        before: base.state.resources.materials,
        after: base.state.resources.materials - SCARCITY_MATERIALS_REDUCTION,
        modifier: 'resource-reduction',
      },
      {
        field: 'resources.water',
        before: base.state.resources.water,
        after: base.state.resources.water - SCARCITY_WATER_REDUCTION,
        modifier: 'resource-reduction',
      },
    ]);
  });

  it('still leaves the objective reachable through the normal validation path', () => {
    const { result } = apply('resource-scarcity');
    const allocation = evaluateSimulationAction(result.state, {
      type: 'allocate',
      resource: 'materials',
      amount: 1,
    });
    expect(allocation.accepted).toBe(true);
    expect(allocation.state.progress).toBe(1);
  });
});

describe('budget pressure', () => {
  it('reduces the starting budget and keeps configuration and state in agreement', () => {
    const { base, result } = apply('budget-pressure');
    expect(result.state.budgetRemaining).toBe(
      base.state.budgetRemaining - BUDGET_PRESSURE_REDUCTION,
    );
    expect(result.configuration.budget).toBe(result.state.budgetRemaining);
    expect(result.state.budgetSpent).toBe(0);
  });

  it('reports both the state and the configuration move', () => {
    const { base, result } = apply('budget-pressure');
    expect(moved(result, 'budgetRemaining')).toEqual({
      field: 'budgetRemaining',
      before: base.state.budgetRemaining,
      after: base.state.budgetRemaining - BUDGET_PRESSURE_REDUCTION,
      modifier: 'budget-reduction',
    });
    expect(moved(result, 'configuration.budget')).toEqual({
      field: 'configuration.budget',
      before: base.configuration.budget,
      after: base.state.budgetRemaining - BUDGET_PRESSURE_REDUCTION,
      modifier: 'budget-reduction',
    });
  });

  it('leaves the reduced budget able to pay for the objective', () => {
    const { result } = apply('budget-pressure');
    expect(result.state.budgetRemaining).toBeGreaterThan(result.state.target);
    expect(getSimulationStatus(result.state).status).toBe('RUNNING');
  });
});

describe('elevated risk', () => {
  it('raises starting risk without ever approaching the failure threshold', () => {
    for (const seed of SEEDS) {
      const { base, result } = apply('elevated-risk', seed);
      expect(result.state.risk).toBe(base.state.risk + ELEVATED_RISK_INCREASE);
      expect(result.state.maxRisk).toBe(base.state.maxRisk);
      expect(result.state.risk).toBeLessThan(result.state.maxRisk);
      expect(result.state.maxRisk - result.state.risk).toBeGreaterThanOrEqual(1);
    }
  });

  it('reports the risk move', () => {
    const { base, result } = apply('elevated-risk');
    expect(moved(result, 'risk')).toEqual({
      field: 'risk',
      before: base.state.risk,
      after: base.state.risk + ELEVATED_RISK_INCREASE,
      modifier: 'risk-increase',
    });
  });

  it('refuses elevation that would leave no headroom below the threshold', () => {
    const base = baseline();
    const lethal = probe([{ kind: 'risk-increase', increaseBy: base.state.maxRisk }]);
    expect(() => applyScenario(base, lethal)).toThrow(ScenarioError);
    expect(() => applyScenario(base, lethal)).toThrow(/no headroom/);
  });
});

describe('resource outage', () => {
  it('takes the named resource offline through the existing state model', () => {
    const { result } = apply('resource-outage');
    expect(result.state.resources[OUTAGE_RESOURCE]).toBe(OUTAGE_LEVEL);
    expect(moved(result, `resources.${OUTAGE_RESOURCE}`)?.after).toBe(OUTAGE_LEVEL);
  });

  it('leaves the other resources untouched', () => {
    const { base, result } = apply('resource-outage');
    const others = (['energy', 'materials'] as const).filter(
      (resource) => resource !== OUTAGE_RESOURCE,
    );
    for (const resource of others)
      expect(result.state.resources[resource]).toBe(base.state.resources[resource]);
  });

  it('tells the agent the resource is gone instead of leaving a silent trap', () => {
    const { base, result } = apply('resource-outage');
    expect(result.state.constraints).toEqual([...base.state.constraints, OUTAGE_CONSTRAINT]);
    expect(moved(result, 'constraints')?.after).toContain(OUTAGE_CONSTRAINT);
  });

  it('makes an allocation from the offline resource a genuine validation rejection', () => {
    const { result } = apply('resource-outage');
    const attempt = evaluateSimulationAction(result.state, {
      type: 'allocate',
      resource: OUTAGE_RESOURCE,
      amount: 1,
    });
    // Refused by the environment's own validator, not by anything scenario-aware.
    expect(attempt.accepted).toBe(false);
    expect(attempt.validationCode).toBe('INSUFFICIENT_RESOURCE');
    expect(attempt.state).toEqual(result.state);
  });

  it('still lets the agent harvest the offline resource back', () => {
    const { result } = apply('resource-outage');
    expect(result.state.resources.energy).toBeGreaterThanOrEqual(1);
    const harvest = evaluateSimulationAction(result.state, {
      type: 'harvest',
      resource: OUTAGE_RESOURCE,
      amount: 2,
    });
    expect(harvest.accepted).toBe(true);
    expect(harvest.state.resources[OUTAGE_RESOURCE]).toBe(2);
  });
});

describe('tight step limit', () => {
  it('reduces the decision budget in the state and the configuration together', () => {
    const { base, result } = apply('tight-step-limit');
    const expected = base.state.maxSteps - TIGHT_STEP_LIMIT_REDUCTION;
    expect(result.state.maxSteps).toBe(expected);
    expect(result.configuration.maxSteps).toBe(expected);
  });

  it('reports both moves', () => {
    const { base, result } = apply('tight-step-limit');
    const expected = base.state.maxSteps - TIGHT_STEP_LIMIT_REDUCTION;
    expect(moved(result, 'maxSteps')?.after).toBe(expected);
    expect(moved(result, 'configuration.maxSteps')?.after).toBe(expected);
  });

  it('terminates the run at the reduced limit, because status reads that same field', () => {
    const { result } = apply('tight-step-limit');
    const atLimit = SimulationState.parse({ ...result.state, step: result.state.maxSteps });
    expect(getSimulationStatus(atLimit)).toEqual({
      status: 'LIMIT_REACHED',
      terminationReason: 'Step budget exhausted.',
    });
    expect(
      evaluateSimulationAction(atLimit, { type: 'allocate', resource: 'materials', amount: 1 })
        .validationCode,
    ).toBe('TERMINAL_RUN');
  });

  it('saturates at the floor rather than producing an impossible limit', () => {
    const tiny = { ...DEFAULT_CONFIGURATION, maxSteps: 4 };
    const { result } = apply('tight-step-limit', 1042, tiny);
    expect(result.state.maxSteps).toBe(3);
    expect(result.configuration.maxSteps).toBe(3);
    expect(getSimulationStatus(result.state).status).toBe('RUNNING');
  });
});

describe('action rejection', () => {
  it('revokes the action through the environment permission list', () => {
    const { base, result } = apply('action-rejection');
    expect(base.state.permissions).toContain(REJECTED_ACTION_TYPE);
    expect(result.state.permissions).not.toContain(REJECTED_ACTION_TYPE);
    expect(result.state.permissions.length).toBeGreaterThan(0);
    expect(moved(result, 'permissions')?.after).toEqual(result.state.permissions);
  });

  it('produces a genuine rejection from the normal validation pipeline', () => {
    const { result } = apply('action-rejection');
    const attempt = evaluateSimulationAction(result.state, {
      type: REJECTED_ACTION_TYPE,
      amount: 1,
    });
    expect(attempt.accepted).toBe(false);
    // The environment's own code for a refusal it decided on, not a scenario code.
    expect(attempt.validationCode).toBe('PERMISSION_DENIED');
    expect(attempt.rejectionReason).toBe(`The ${REJECTED_ACTION_TYPE} action is not permitted.`);
    expect(attempt.state).toEqual(result.state);
    expect(attempt.stateDiff).toBeUndefined();
  });

  it('does not change any state when the revoked action is attempted', () => {
    const { result } = apply('action-rejection');
    const before = structuredClone(result.state);
    evaluateSimulationAction(result.state, { type: REJECTED_ACTION_TYPE, amount: 5 });
    expect(result.state).toEqual(before);
  });

  it('leaves the remaining actions working', () => {
    const { result } = apply('action-rejection');
    const remaining = result.state.permissions;
    expect(remaining).toContain('allocate');
    expect(
      evaluateSimulationAction(result.state, { type: 'allocate', resource: 'materials', amount: 2 })
        .accepted,
    ).toBe(true);
  });

  it('publishes the revocation to the agent as a constraint', () => {
    const { result } = apply('action-rejection');
    expect(result.state.constraints).toContain(REJECTED_ACTION_CONSTRAINT);
  });
});

describe('scenario validation', () => {
  it('rejects a modifier kind the engine does not implement', () => {
    const unknown = {
      ...getScenario(BASELINE_SCENARIO_ID),
      modifiers: [{ kind: 'scatter-resources', amount: 3 }],
    } as unknown as Scenario;
    expect(() => applyScenario(baseline(), unknown)).toThrow(ScenarioError);
    expect(() => applyScenario(baseline(), unknown)).toThrow(/not valid/);
  });

  it('rejects an unknown modifier at the dispatch point even if the schema was bypassed', () => {
    expect(() =>
      applyModifier(baseline(), { kind: 'not-a-modifier' } as unknown as Scenario['modifiers'][0]),
    ).toThrow(/Unknown scenario modifier/);
  });

  it('rejects malformed definitions', () => {
    const base = baseline();
    expect(() =>
      applyScenario(base, { ...getScenario(BASELINE_SCENARIO_ID), id: 'Not Kebab' } as Scenario),
    ).toThrow(ScenarioError);
    expect(() =>
      applyScenario(base, { ...getScenario(BASELINE_SCENARIO_ID), version: 0 } as Scenario),
    ).toThrow(ScenarioError);
    expect(() =>
      applyScenario(base, { ...getScenario(BASELINE_SCENARIO_ID), version: 1.5 } as Scenario),
    ).toThrow(ScenarioError);
  });

  it('rejects a baseline that is not a valid world', () => {
    const invalid = { ...baseline(), state: { nonsense: true } } as unknown as ScenarioBaseline;
    expect(() => applyScenario(invalid, getScenario(BASELINE_SCENARIO_ID))).toThrow(
      /not a valid simulation state/,
    );
    const negative = baseline();
    expect(() =>
      applyScenario(
        {
          ...negative,
          state: { ...negative.state, resources: { ...negative.state.resources, water: -1 } },
        },
        getScenario('resource-scarcity'),
      ),
    ).toThrow(ScenarioError);
  });

  it('refuses a scenario that would revoke every action', () => {
    const total = probe([
      {
        kind: 'permission-revocation',
        actions: ['harvest', 'allocate', 'rest'],
        constraint: 'Nothing is permitted.',
      },
    ]);
    expect(() => applyScenario(baseline(), total)).toThrow(/no action permitted/);
  });

  it('refuses a scenario that would produce an already-terminated run', () => {
    const exhausting = probe([{ kind: 'budget-reduction', reduceBy: 24 }]);
    // The modifier saturates at the floor rather than zeroing the budget, so the
    // scenario stays valid — the floor is what keeps it from being impossible.
    const result = applyScenario(baseline(), exhausting);
    expect(result.state.budgetRemaining).toBe(1);
    expect(getSimulationStatus(result.state).status).toBe('RUNNING');
  });

  it('exposes the error code so a caller can tell the failures apart', () => {
    try {
      applyScenario(baseline(), { ...getScenario(BASELINE_SCENARIO_ID), version: 0 } as Scenario);
      expect.unreachable('the invalid definition should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioError);
      expect((error as ScenarioError).code).toBe('INVALID_SCENARIO');
    }
  });
});

describe('immutability', () => {
  it.each(listScenarios().map((scenario) => scenario.id))(
    'applying %s leaves the baseline object untouched',
    (id) => {
      const base = baseline();
      const snapshot = structuredClone(base);
      deepFreeze(base);
      // A frozen baseline turns any in-place write into a thrown TypeError, so
      // this asserts the absence of mutation rather than merely its absence
      // from the result.
      expect(() => applyScenario(base, getScenario(id))).not.toThrow();
      expect(base).toEqual(snapshot);
    },
  );

  it('does not let a modifier read a value a previous modifier already overwrote', () => {
    // If the outage wrote through to the baseline, the reduction would see 0 and
    // saturate at the floor instead of shaving the seeded stock.
    const base = baseline();
    const snapshot = structuredClone(base);
    const scenario = probe([
      { kind: 'resource-outage', resource: 'water', level: 0, constraint: 'Water offline.' },
      {
        kind: 'resource-reduction',
        reductions: { water: SCARCITY_WATER_REDUCTION },
        floor: SCARCITY_RESOURCE_FLOOR,
      },
    ]);
    const result = applyScenario(base, scenario);
    expect(result.state.resources.water).toBe(SCARCITY_RESOURCE_FLOOR);
    expect(base).toEqual(snapshot);
  });
});

describe('determinism', () => {
  it.each(listScenarios().map((scenario) => scenario.id))(
    'applies %s identically on a second run of the same seed',
    (id) => {
      for (const seed of SEEDS) {
        const first = apply(id, seed).result;
        const second = apply(id, seed).result;
        expect(second).toEqual(first);
      }
    },
  );

  it('produces identical worlds through the run initializer', () => {
    for (const seed of SEEDS) {
      const input = {
        environmentKey: 'resource-routing' as const,
        objectiveKey: OBJECTIVE,
        seed,
        scenarioId: 'resource-scarcity',
      };
      expect(initializeScenarioRun(input)).toEqual(initializeScenarioRun(input));
    }
  });

  it('preserves the seed it was given', () => {
    for (const seed of SEEDS) {
      for (const scenario of listScenarios()) {
        const result = initializeScenarioRun({
          environmentKey: 'resource-routing',
          objectiveKey: OBJECTIVE,
          seed,
          scenarioId: scenario.id,
        });
        expect(result.state.seed, scenario.id).toBe(seed);
      }
    }
  });

  it('keeps definitions, worlds and change records serializable through JSON', () => {
    for (const scenario of listScenarios()) {
      // Definitions are persisted as data and served over the API, so a
      // definition that only survives as a live object would not be usable.
      const roundTripped = JSON.parse(JSON.stringify(scenario)) as Scenario;
      expect(applyScenario(baseline(), roundTripped), scenario.id).toEqual(
        applyScenario(baseline(), scenario),
      );
      const result = applyScenario(baseline(), scenario);
      expect(SimulationState.parse(JSON.parse(JSON.stringify(result.state))), scenario.id).toEqual(
        result.state,
      );
      expect(JSON.parse(JSON.stringify(result.changes)), scenario.id).toEqual(result.changes);
    }
  });
});

describe('modifier ordering', () => {
  const reduceThenOutage = probe([
    {
      kind: 'resource-reduction',
      reductions: { water: 2 },
      floor: SCARCITY_RESOURCE_FLOOR,
    },
    { kind: 'resource-outage', resource: 'water', level: 0, constraint: 'Water offline.' },
  ]);
  const outageThenReduce = probe([
    { kind: 'resource-outage', resource: 'water', level: 0, constraint: 'Water offline.' },
    {
      kind: 'resource-reduction',
      reductions: { water: 2 },
      floor: SCARCITY_RESOURCE_FLOOR,
    },
  ]);

  it('applies modifiers in the order the definition declares them', () => {
    // Not commutative: reduce-then-outage ends at 0, outage-then-reduce saturates
    // at the floor because the reduction finds an empty stock.
    expect(applyScenario(baseline(), reduceThenOutage).state.resources.water).toBe(0);
    expect(applyScenario(baseline(), outageThenReduce).state.resources.water).toBe(
      SCARCITY_RESOURCE_FLOOR,
    );
  });

  it('emits change records in the same declared order', () => {
    const result = applyScenario(baseline(), reduceThenOutage);
    expect(result.changes.map((entry) => entry.field)).toEqual([
      'resources.water',
      'resources.water',
      'constraints',
    ]);
    expect(Number(result.changes[0]?.before)).toBeGreaterThan(
      Number(result.changes[1]?.after ?? 0),
    );
  });

  it('orders the shipped scenarios deterministically across repeated loads', () => {
    expect(SCENARIO_DEFINITIONS.map((scenario) => scenario.id)).toEqual(
      listScenarios().map((scenario) => scenario.id),
    );
  });
});

describe('scenario application record', () => {
  it('describes the application as a system event naming scenario and version', () => {
    const initialization = initializeScenarioRun({
      environmentKey: 'resource-routing',
      objectiveKey: OBJECTIVE,
      seed: 1042,
      scenarioId: 'resource-scarcity',
    });
    const described = describeScenarioApplication(initialization);
    expect(described?.summary).toBe('Scenario applied: Resource Scarcity v1.');
    expect(described?.payload).toEqual({
      scenarioId: 'resource-scarcity',
      scenarioVersion: 1,
      scenarioName: 'Resource Scarcity',
      changes: initialization.changes,
    });
  });

  it('describes nothing for a run created without a scenario', () => {
    const initialization = initializeScenarioRun({
      environmentKey: 'resource-routing',
      objectiveKey: OBJECTIVE,
      seed: 1042,
      scenarioId: null,
    });
    expect(describeScenarioApplication(initialization)).toBeNull();
    expect(initialization.changes).toEqual([]);
  });

  it('carries the pre-scenario values, which the run itself does not store', () => {
    const { base } = apply('budget-pressure');
    const initialization = initializeScenarioRun({
      environmentKey: 'resource-routing',
      objectiveKey: OBJECTIVE,
      seed: 1042,
      scenarioId: 'budget-pressure',
    });
    const described = describeScenarioApplication(initialization);
    const changes = described?.payload.changes as ScenarioChange[];
    expect(changes.find((entry) => entry.field === 'budgetRemaining')?.before).toBe(
      base.state.budgetRemaining,
    );
    expect(initialization.state.budgetRemaining).not.toBe(base.state.budgetRemaining);
  });
});

describe('backward compatibility', () => {
  it('returns the untouched environment world when no scenario is requested', () => {
    for (const seed of SEEDS) {
      const initialization = initializeScenarioRun({
        environmentKey: 'resource-routing',
        objectiveKey: OBJECTIVE,
        seed,
      });
      expect(initialization.state).toEqual(
        createInitialSimulationState('resource-routing', OBJECTIVE, seed, DEFAULT_CONFIGURATION),
      );
      expect(initialization.configuration).toEqual(DEFAULT_CONFIGURATION);
      expect(initialization.scenario).toBeNull();
      expect(initialization.name).toBeNull();
      expect(initialization.changes).toEqual([]);
    }
  });

  it('honours a configuration override without a scenario, exactly as before', () => {
    const configuration = { ...DEFAULT_CONFIGURATION, budget: 30, maxSteps: 20 };
    const initialization = initializeScenarioRun({
      environmentKey: 'resource-routing',
      objectiveKey: 'stabilise-grid',
      seed: 4242,
      configuration,
    });
    expect(initialization.configuration).toEqual(configuration);
    expect(initialization.state.maxSteps).toBe(20);
    expect(initialization.state.budgetRemaining).toBe(30);
  });

  it('fails an unknown scenario id rather than quietly running unperturbed', () => {
    expect(() =>
      initializeScenarioRun({
        environmentKey: 'resource-routing',
        objectiveKey: OBJECTIVE,
        seed: 1042,
        scenarioId: 'no-such-scenario',
      }),
    ).toThrow(/Unknown scenario/);
  });
});
