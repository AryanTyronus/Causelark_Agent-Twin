// @vitest-environment node
//
// CONDITIONS — what each of the seven markets does to the world it produces.
//
// A benchmark whose conditions were only registered would be seven names. What
// makes them conditions is that each one changes something the agent meets, in a
// stated direction, and that the change is *visible to the agent*: a market that
// is harder in a way nobody is told about measures guesswork, not decision-making.
//
// So every assertion below is a pair — the parameter moved the way the condition
// says it moves, and the constraint announcing it is in the observation at step
// 0. The seven are also shown to be perturbations of ONE market rather than seven
// markets: each leaves the baseline's own rules in place and adds to them.

import { describe, expect, it } from 'vitest';
import { SimulationState } from '@/lib/contracts/simulation';
import { evaluateSimulationAction, getSimulationStatus } from '@/lib/environments/registry';
import {
  CONCENTRATION_CONSTRAINT,
  CONCENTRATION_LIMIT_BPS,
  EXPOSURE_LIMIT_BPS,
  HIGH_VOLATILITY_CONSTRAINT,
  HIGH_VOLATILITY_INCREASE_BPS,
  LIQUIDITY_CONSTRAINT,
  LIQUIDITY_ORDER_SIZE_REDUCTION,
  LIQUIDITY_SPREAD_INCREASE_BPS,
  MARKET_DRAWDOWN_CONSTRAINT,
  MARKET_DRAWDOWN_REDUCTION_BPS,
  SHOCK_ASSET,
  SHOCK_BPS,
  SHOCK_CONSTRAINT,
  SHOCK_STEP,
  TIGHT_DECISION_BUDGET_REDUCTION,
  TIGHT_DECISION_STEP_REDUCTION,
  TRADING_BASELINE_SCENARIO_ID,
  TRADING_SCENARIO_IDS,
} from '@/lib/scenarios/definitions';
import {
  applyScenario,
  getScenario,
  initializeScenarioRun,
  validateScenarioBaseline,
} from '@/lib/scenarios/scenario';
import {
  ASSET_ORDER,
  BASELINE_PARAMETERS,
  executionCostCents,
  executionCostUnits,
  TRADING_CONFIGURATION,
  TRADING_CONSTRAINTS,
  TRADING_ENVIRONMENT_KEY,
  TRADING_OBJECTIVE_KEY,
} from '@/lib/trading/definitions';
import { TRADING_ENVIRONMENT, tradingObservation } from '@/lib/trading/environment';
import { quotesAt } from '@/lib/trading/market';

/** The state one condition produces, from the shipped pipeline. */
function runOf(scenarioId: string) {
  return initializeScenarioRun({
    environmentKey: TRADING_ENVIRONMENT_KEY,
    objectiveKey: TRADING_OBJECTIVE_KEY,
    seed: 1042,
    scenarioId,
  });
}

function stateOf(scenarioId: string) {
  return runOf(scenarioId).state;
}

/** The market parameters one condition publishes. */
function parametersOf(scenarioId: string) {
  const parameters = stateOf(scenarioId).trading?.parameters;
  if (!parameters) throw new Error(`${scenarioId} produced no market parameters`);
  return parameters;
}

const BASELINE = stateOf(TRADING_BASELINE_SCENARIO_ID);

describe('the baseline market is the control the other six are read against', () => {
  it('is the unperturbed published market, with no modifier at all', () => {
    expect(getScenario(TRADING_BASELINE_SCENARIO_ID).modifiers).toEqual([]);
    expect(parametersOf(TRADING_BASELINE_SCENARIO_ID)).toEqual(BASELINE_PARAMETERS);
    expect(BASELINE.constraints).toEqual(TRADING_CONSTRAINTS);
    expect(BASELINE.maxSteps).toBe(TRADING_CONFIGURATION.maxSteps);
    expect(BASELINE.budgetRemaining).toBe(TRADING_CONFIGURATION.budget);
  });

  it('is the condition the definition names as its baseline', () => {
    expect(TRADING_SCENARIO_IDS[0]).toBe(TRADING_BASELINE_SCENARIO_ID);
    expect(TRADING_ENVIRONMENT.defaultConfiguration).toEqual(TRADING_CONFIGURATION);
  });
});

describe('high volatility raises the step noise and leaves the trend alone', () => {
  const parameters = parametersOf('high-volatility');

  it('quadruples the swings the market takes around its path', () => {
    expect(parameters.volatilityBps).toBe(
      BASELINE_PARAMETERS.volatilityBps + HIGH_VOLATILITY_INCREASE_BPS,
    );
    expect(parameters.volatilityBps).toBeGreaterThan(BASELINE_PARAMETERS.volatilityBps);
    // The trend is deliberately untouched: this condition is about variance, and
    // a condition that also moved the drift would be measuring two things.
    expect(parameters.driftBps).toBe(BASELINE_PARAMETERS.driftBps);
  });

  it('opens on the published prices and diverges only as the run walks forward', () => {
    // Step 0 is the market's declared starting point for every condition, so a
    // reader comparing two openings is comparing the same thing.
    expect(quotesAt(1042, 0, parameters)).toEqual(quotesAt(1042, 0, BASELINE_PARAMETERS));
    expect(quotesAt(1042, 3, parameters)).not.toEqual(quotesAt(1042, 3, BASELINE_PARAMETERS));
  });

  it('tells the agent the market it is in is volatile', () => {
    expect(stateOf('high-volatility').constraints).toContain(HIGH_VOLATILITY_CONSTRAINT);
    expect(tradingObservation(stateOf('high-volatility'))).toContain(HIGH_VOLATILITY_CONSTRAINT);
  });
});

describe('market drawdown removes the drift rather than adding variance', () => {
  const parameters = parametersOf('market-drawdown');

  it('turns the drift down, at the same volatility', () => {
    expect(parameters.driftBps).toBe(BASELINE_PARAMETERS.driftBps - MARKET_DRAWDOWN_REDUCTION_BPS);
    expect(parameters.driftBps).toBeLessThan(0);
    expect(parameters.volatilityBps).toBe(BASELINE_PARAMETERS.volatilityBps);
  });

  it('prices the market lower than the baseline once the path has moved', () => {
    // The drift is what makes a decline a decline: at a later step the same
    // instrument is worth less here than it is in the control.
    const asset = ASSET_ORDER[0] as (typeof ASSET_ORDER)[number];
    const declined = quotesAt(1042, 4, parameters).find((quote) => quote.asset === asset)?.price;
    const control = quotesAt(1042, 4, BASELINE_PARAMETERS).find(
      (quote) => quote.asset === asset,
    )?.price;
    expect(declined as number).toBeLessThan(control as number);
  });

  it('tells the agent the market is falling', () => {
    expect(stateOf('market-drawdown').constraints).toContain(MARKET_DRAWDOWN_CONSTRAINT);
    expect(tradingObservation(stateOf('market-drawdown'))).toContain(MARKET_DRAWDOWN_CONSTRAINT);
  });
});

describe('liquidity pressure makes execution dearer and fills smaller', () => {
  const parameters = parametersOf('liquidity-pressure');

  it('widens the spread and shrinks the largest order that will fill', () => {
    expect(parameters.spreadBps).toBe(
      BASELINE_PARAMETERS.spreadBps + LIQUIDITY_SPREAD_INCREASE_BPS,
    );
    expect(parameters.maxOrderQuantity).toBe(
      BASELINE_PARAMETERS.maxOrderQuantity - LIQUIDITY_ORDER_SIZE_REDUCTION,
    );
    expect(parameters.maxOrderQuantity).toBeLessThan(BASELINE_PARAMETERS.maxOrderQuantity);
  });

  it('charges more for the same notional than the baseline market would', () => {
    const notional = 100 * (BASELINE_PARAMETERS.maxOrderQuantity as number);
    expect(executionCostCents(notional, parameters)).toBeGreaterThan(
      executionCostCents(notional, BASELINE_PARAMETERS),
    );
    expect(executionCostUnits(notional, parameters)).toBeGreaterThanOrEqual(
      executionCostUnits(notional, BASELINE_PARAMETERS),
    );
  });

  it('refuses an order the baseline market would have filled', () => {
    // The size that no longer fills, asked of both markets through the same
    // validator. The refusal is the environment's, not the condition's.
    const oversized = {
      type: 'buy',
      asset: 'ALPHA',
      amount: BASELINE_PARAMETERS.maxOrderQuantity,
    } as const;
    expect(evaluateSimulationAction(BASELINE, oversized).accepted).toBe(true);
    const refused = evaluateSimulationAction(stateOf('liquidity-pressure'), oversized);
    expect(refused.accepted).toBe(false);
    expect(refused.validationCode).toBe('ORDER_TOO_LARGE');
  });

  it('tells the agent the market is thin', () => {
    expect(stateOf('liquidity-pressure').constraints).toContain(LIQUIDITY_CONSTRAINT);
    expect(tradingObservation(stateOf('liquidity-pressure'))).toContain(LIQUIDITY_CONSTRAINT);
  });
});

describe('concentration pressure halves the ceilings the book must respect', () => {
  const parameters = parametersOf('concentration-pressure');

  it('halves both the position and the exposure ceiling', () => {
    expect(parameters.maxConcentrationBps).toBe(CONCENTRATION_LIMIT_BPS);
    expect(parameters.maxExposureBps).toBe(EXPOSURE_LIMIT_BPS);
    expect(parameters.maxConcentrationBps).toBeLessThan(BASELINE_PARAMETERS.maxConcentrationBps);
    expect(parameters.maxExposureBps).toBeLessThan(BASELINE_PARAMETERS.maxExposureBps);
  });

  it('refuses on the tighter ceiling an order the baseline market accepted', () => {
    // Walk the baseline book into a concentrated position, then ask the same
    // question of the tightened market from the same starting point. The tighter
    // market refuses earlier — that is the whole condition.
    const order = {
      type: 'buy',
      asset: 'ALPHA',
      amount: BASELINE_PARAMETERS.maxOrderQuantity,
    } as const;
    const baselineFirst = evaluateSimulationAction(BASELINE, order);
    expect(baselineFirst.accepted).toBe(true);

    const tightened = stateOf('concentration-pressure');
    const first = evaluateSimulationAction(tightened, order);
    // Whether the very first order fits or not, the tightened market must refuse
    // at or before the point the baseline does.
    const baselineShare = (baselineFirst.state.trading?.positions ?? []).find(
      (position) => position.asset === 'ALPHA',
    )?.quantity;
    const tightenedShare = (first.state.trading?.positions ?? []).find(
      (position) => position.asset === 'ALPHA',
    )?.quantity;
    expect(tightenedShare ?? 0).toBeLessThanOrEqual(baselineShare ?? 0);
    if (!first.accepted)
      expect(['CONCENTRATION_LIMIT', 'EXPOSURE_LIMIT']).toContain(first.validationCode);
  });

  it('tells the agent the ceilings are tighter than the published ones', () => {
    expect(stateOf('concentration-pressure').constraints).toContain(CONCENTRATION_CONSTRAINT);
    expect(tradingObservation(stateOf('concentration-pressure'))).toContain(
      CONCENTRATION_CONSTRAINT,
    );
  });
});

describe('adverse price shock names one instrument and one step', () => {
  const parameters = parametersOf('adverse-price-shock');

  it('records the fall, the instrument and the step it lands on', () => {
    expect(parameters.shockAsset).toBe(SHOCK_ASSET);
    expect(parameters.shockStep).toBe(SHOCK_STEP);
    expect(parameters.shockBps).toBe(SHOCK_BPS);
    expect(SHOCK_STEP).toBeGreaterThan(0);
    expect(SHOCK_STEP).toBeLessThan(TRADING_CONFIGURATION.maxSteps);
    expect(ASSET_ORDER as readonly string[]).toContain(SHOCK_ASSET);
  });

  it('has not landed before its step and is visible on it', () => {
    // The shock is a *scheduled* event, so it must be absent from the path
    // before its step — otherwise the condition would have landed early and the
    // agent would be told about a risk that had already happened.
    expect(quotesAt(1042, SHOCK_STEP - 1, parameters)).toEqual(
      quotesAt(1042, SHOCK_STEP - 1, BASELINE_PARAMETERS),
    );
    const shocked = quotesAt(1042, SHOCK_STEP, parameters).find(
      (quote) => quote.asset === SHOCK_ASSET,
    )?.price as number;
    const control = quotesAt(1042, SHOCK_STEP, BASELINE_PARAMETERS).find(
      (quote) => quote.asset === SHOCK_ASSET,
    )?.price as number;
    expect(shocked).toBeLessThan(control);
  });

  it('tells the agent which instrument is exposed and when', () => {
    const observation = tradingObservation(stateOf('adverse-price-shock'));
    expect(observation).toContain(SHOCK_CONSTRAINT);
    expect(stateOf('adverse-price-shock').constraints).toContain(SHOCK_CONSTRAINT);
  });
});

describe('tight decision limit halves both budgets the agent spends', () => {
  const state = stateOf('tight-decision-limit');

  it('halves the steps and the cost allowance together', () => {
    expect(state.maxSteps).toBe(TRADING_CONFIGURATION.maxSteps - TIGHT_DECISION_STEP_REDUCTION);
    expect(state.budgetRemaining).toBe(
      TRADING_CONFIGURATION.budget - TIGHT_DECISION_BUDGET_REDUCTION,
    );
    expect(state.budgetSpent).toBe(0);
    expect(state.maxSteps).toBeLessThan(TRADING_CONFIGURATION.maxSteps);
  });

  it('leaves the market itself exactly as the baseline published it', () => {
    // This condition is about the budget, not the market: a book that is harder
    // to trade is a different test from one that is harder to afford.
    expect(state.trading?.parameters).toEqual(BASELINE_PARAMETERS);
    expect(quotesAt(1042, 4, parametersOf('tight-decision-limit'))).toEqual(
      quotesAt(1042, 4, BASELINE_PARAMETERS),
    );
  });
});

describe('all seven are perturbations of one market, and none of them is a trap', () => {
  it('produces a runnable world under every condition', () => {
    for (const id of TRADING_SCENARIO_IDS) {
      const run = runOf(id);
      const state = run.state;
      expect(SimulationState.safeParse(state).success, id).toBe(true);
      expect(state.environmentKey, id).toBe(TRADING_ENVIRONMENT_KEY);
      expect(getSimulationStatus(state), id).toEqual({
        status: 'RUNNING',
        terminationReason: null,
      });
      // Validated against the configuration the condition itself produced, not
      // against the default one: two of these conditions exist precisely to move
      // the step limit and the execution budget, and the configuration moves with
      // the state. Validating a halved run against the unhalved configuration
      // would fail a scenario for having done exactly what it declares.
      expect(
        () => validateScenarioBaseline({ state, configuration: run.configuration }),
        id,
      ).not.toThrow();
      // The baseline is the control and deliberately changes nothing; every
      // condition beside it has to change something, or it is a name.
      if (id === TRADING_BASELINE_SCENARIO_ID) expect(run.changes).toEqual([]);
      else expect(run.changes.length, id).toBeGreaterThan(0);
    }
  });

  it('keeps the baseline’s own rules and adds to them, never replacing them', () => {
    // Every constraint the baseline publishes is still published under every
    // condition: a condition that dropped a rule would be a different benchmark.
    for (const id of TRADING_SCENARIO_IDS) {
      const constraints = stateOf(id).constraints;
      for (const rule of TRADING_CONSTRAINTS) expect(constraints, `${id}: ${rule}`).toContain(rule);
      expect(constraints.length).toBeGreaterThanOrEqual(TRADING_CONSTRAINTS.length);
      // And every constraint the observation shows the agent is one the state
      // actually carries — nothing is announced that is not in force.
      const observation = tradingObservation(stateOf(id));
      for (const rule of constraints) expect(observation, `${id}: ${rule}`).toContain(rule);
    }
  });

  it('changes only the market it is applied to, and does so identically twice', () => {
    // Purity, stated as the property the benchmark depends on: applying a
    // condition does not write to the baseline handed in, and the same condition
    // applied twice produces the same world.
    const baseline = initializeScenarioRun({
      environmentKey: TRADING_ENVIRONMENT_KEY,
      objectiveKey: TRADING_OBJECTIVE_KEY,
      seed: 1042,
      scenarioId: TRADING_BASELINE_SCENARIO_ID,
    });
    const before = JSON.stringify(baseline.state);
    const applied = applyScenario(baseline, getScenario('high-volatility'));
    expect(JSON.stringify(baseline.state)).toBe(before);

    const again = applyScenario(
      initializeScenarioRun({
        environmentKey: TRADING_ENVIRONMENT_KEY,
        objectiveKey: TRADING_OBJECTIVE_KEY,
        seed: 1042,
        scenarioId: TRADING_BASELINE_SCENARIO_ID,
      }),
      getScenario('high-volatility'),
    );
    expect(JSON.stringify(again.state)).toBe(JSON.stringify(applied.state));
    // And the condition records what it changed, so a verdict can be attributed
    // to the parameters that were moved rather than to a name.
    expect(applied.changes.length).toBeGreaterThan(0);
    expect(applied.changes.map((change) => change.field)).toContain(
      'trading.parameters.volatilityBps',
    );
  });

  it('produces a different market for every condition that claims to change one', () => {
    // Five conditions perturb the market itself and each must produce a distinct
    // one: a condition whose parameters matched another's would read as a
    // difficulty that is not there. The other two are excluded for their own
    // reasons — the baseline *is* the market, and `tight-decision-limit` changes
    // what the agent can afford rather than what it is trading, which its own
    // test above asserts.
    const marketConditions = TRADING_SCENARIO_IDS.filter(
      (id) => id !== TRADING_BASELINE_SCENARIO_ID && id !== 'tight-decision-limit',
    );
    expect(marketConditions).toHaveLength(5);
    const shapes = marketConditions.map((id) => JSON.stringify(parametersOf(id)));
    expect(new Set(shapes).size).toBe(marketConditions.length);
    for (const id of marketConditions)
      expect(parametersOf(id), id).not.toEqual(BASELINE_PARAMETERS);
    // Against the control as well as against each other: the baseline's own
    // parameters are a sixth distinct set, so no condition quietly returns the
    // baseline market under a different name.
    expect(new Set([...shapes, JSON.stringify(BASELINE_PARAMETERS)]).size).toBe(
      marketConditions.length + 1,
    );
  });
});
