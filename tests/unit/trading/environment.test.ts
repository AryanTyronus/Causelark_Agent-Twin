// @vitest-environment node
//
// ENVIRONMENT — what world a trading run is, what it starts as, and what it will
// and will not disclose.
//
// These assertions are about the representation, not about a policy: a starting
// state, a status, an observation. The property they exist to protect above all
// others is that **no future price is observable**. Everything else can be
// re-derived; a leaked price path would make every score in the benchmark a
// measurement of foresight.

import { describe, expect, it } from 'vitest';
import { SimulationState } from '@/lib/contracts/simulation';
import {
  createInitialSimulationState,
  simulationEnvironment,
  simulationEnvironmentFor,
} from '@/lib/environments/registry';
import { EnvironmentError } from '@/lib/environments/types';
import {
  applyScenario,
  findScenario,
  getScenario,
  initializeScenarioRun,
  listScenarios,
  TRADING_BASELINE_SCENARIO_ID,
  TRADING_SCENARIO_IDS,
  validateScenarioBaseline,
} from '@/lib/scenarios/scenario';
import {
  ASSET_ORDER,
  BASE_PRICE_CENTS,
  BASELINE_PARAMETERS,
  INITIAL_CAPITAL_CENTS,
  MAX_DRAWDOWN_POINTS,
  TARGET_GAIN_DOLLARS,
  TRADING_CONFIGURATION,
  TRADING_CONSTRAINTS,
  TRADING_ENVIRONMENT_KEY,
  TRADING_OBJECTIVE_KEY,
} from '@/lib/trading/definitions';
import {
  TRADING_ENVIRONMENT,
  TRADING_SCORING_PROFILE,
  tradingObservation,
  tradingStatus,
} from '@/lib/trading/environment';
import { priceAt, quotesAt } from '@/lib/trading/market';
import { equityCents } from '@/lib/trading/portfolio';
import { INITIAL_STATE } from './fixtures';

const OBJ = TRADING_OBJECTIVE_KEY;

describe('the trading environment a run belongs to', () => {
  it('is registered under the key the benchmark, the scenarios and the catalogue all name', () => {
    expect(TRADING_ENVIRONMENT.key).toBe(TRADING_ENVIRONMENT_KEY);
    expect(TRADING_ENVIRONMENT.option.key).toBe(TRADING_ENVIRONMENT_KEY);
    expect(simulationEnvironment(TRADING_ENVIRONMENT_KEY)).toBe(TRADING_ENVIRONMENT);
    // The catalogue entry is the display surface the picker reads, and it carries
    // the benchmark's own name and description verbatim.
    expect(TRADING_ENVIRONMENT.option.title).toBe('$10K Trading Challenge');
    expect(TRADING_ENVIRONMENT.option.description).toBe(
      'Evaluate autonomous financial decision-making with a fixed $10,000 simulated portfolio under changing market conditions and risk constraints.',
    );
  });

  it('is resolved from the state, never from a caller’s claim about the state', () => {
    // `simulationEnvironmentFor` parses the state and reads its own key, so a
    // caller cannot drive one world's rules against another world's state.
    expect(simulationEnvironmentFor(INITIAL_STATE()).key).toBe(TRADING_ENVIRONMENT_KEY);
    const resourceState = createInitialSimulationState(
      'resource-routing',
      'complete-delivery',
      1042,
    );
    expect(simulationEnvironmentFor(resourceState).key).toBe('resource-routing');
  });

  it('refuses a state that names no world this deployment ships', () => {
    const state = { ...INITIAL_STATE(), environmentKey: 'equities-live' };
    expect(() => simulationEnvironmentFor(state as never)).toThrow(EnvironmentError);
  });

  it('refuses an object that is not a simulation state at all, as such', () => {
    // Distinct from an unknown key: the failure is "this is not a state", not
    // "this state names a world I do not have".
    try {
      simulationEnvironmentFor({ nonsense: true } as never);
      expect.unreachable('an unparseable state must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentError);
      expect((error as EnvironmentError).code).toBe('ENVIRONMENT_MISMATCH');
    }
  });

  it('publishes exactly one objective, and no other world’s verb', () => {
    expect(TRADING_ENVIRONMENT.objectives.map((objective) => objective.key)).toEqual([OBJ]);
    expect(TRADING_ENVIRONMENT.actionTypes).toEqual(['buy', 'sell', 'hold']);
    // The resource vocabulary is absent from the trading world's own catalogue.
    for (const verb of ['harvest', 'allocate', 'rest'])
      expect(TRADING_ENVIRONMENT.actionTypes).not.toContain(verb);
  });

  it('publishes the scoring profile the evaluation engine will normalise against', () => {
    // Derived from the benchmark's own rules rather than chosen: reaching the
    // $500 target inside the 12-step budget is the pace efficiency is measured
    // against.
    expect(TRADING_ENVIRONMENT.scoring.maxProgressPerTransition).toBe(
      Math.ceil(TARGET_GAIN_DOLLARS / TRADING_CONFIGURATION.maxSteps),
    );
    expect(TRADING_ENVIRONMENT.scoring.optimalBudgetPerProgressUnit).toBeGreaterThan(0);
    expect(TRADING_ENVIRONMENT.scoring).toEqual(TRADING_SCORING_PROFILE);
  });

  it('names the tools a trading agent is offered, and offers it no resource probe', () => {
    expect(TRADING_ENVIRONMENT.agentTools.observations.map((tool) => tool.name)).toEqual([
      'inspect_market',
      'inspect_portfolio',
    ]);
    expect(TRADING_ENVIRONMENT.agentTools.action.name).toBe('request_action');
    const surface = JSON.stringify(TRADING_ENVIRONMENT.agentTools).toLowerCase();
    for (const word of ['energy', 'materials', 'water', 'harvest', 'allocate'])
      expect(surface, `the trading tool surface must not mention ${word}`).not.toContain(word);
  });

  it('validates actions against its own narrow schema, not the wide record schema', () => {
    // The record schema accepts up to 200 shares and both nouns because it reads
    // back either world's rows. The agent is shown the environment's own schema,
    // so a size its validator refuses is never advertised as available.
    expect(
      TRADING_ENVIRONMENT.actionInputSchema.safeParse({ type: 'buy', asset: 'ALPHA', amount: 5 })
        .success,
    ).toBe(true);
    expect(
      TRADING_ENVIRONMENT.actionInputSchema.safeParse({ type: 'buy', asset: 'ALPHA', amount: 5000 })
        .success,
    ).toBe(false);
    expect(
      TRADING_ENVIRONMENT.actionInputSchema.safeParse({ type: 'harvest', amount: 1 }).success,
    ).toBe(false);
  });
});

describe('the starting state of a trading run', () => {
  const state = INITIAL_STATE();

  it('opens flat, fully in cash, at the objective’s own target', () => {
    expect(state.environmentKey).toBe(TRADING_ENVIRONMENT_KEY);
    expect(state.objectiveKey).toBe(OBJ);
    expect(state.step).toBe(0);
    expect(state.target).toBe(TARGET_GAIN_DOLLARS);
    expect(state.progress).toBe(0);
    expect(state.risk).toBe(0);
    expect(state.maxRisk).toBe(MAX_DRAWDOWN_POINTS);
    expect(state.budgetRemaining).toBe(TRADING_CONFIGURATION.budget);
    expect(state.budgetSpent).toBe(0);
    expect(state.maxSteps).toBe(TRADING_CONFIGURATION.maxSteps);
    expect(state.permissions).toEqual(['buy', 'sell', 'hold']);
    expect(state.constraints).toEqual(TRADING_CONSTRAINTS);

    const trading = state.trading;
    expect(trading).not.toBeNull();
    expect(trading?.initialCapital).toBe(INITIAL_CAPITAL_CENTS);
    expect(trading?.cash).toBe(INITIAL_CAPITAL_CENTS);
    expect(trading?.peakEquity).toBe(INITIAL_CAPITAL_CENTS);
    expect(trading?.realizedPnl).toBe(0);
    expect(trading?.transactionCosts).toBe(0);
    expect(trading?.tradedQuantity).toBe(0);
    expect(trading?.parameters).toEqual(BASELINE_PARAMETERS);
    expect(trading?.positions).toEqual(
      ASSET_ORDER.map((asset) => ({ asset, quantity: 0, averageEntryPrice: 0 })),
    );
  });

  it('holds no resources, because this world has none', () => {
    // The shared fields stay on the state — a persisted run has to be readable
    // without knowing its world — but they carry zero, so a reader that shows
    // them shows nothing false.
    expect(state.resources).toEqual({ energy: 0, materials: 0, water: 0 });
    expect(state.capacity).toBe(1);
  });

  it('publishes the step-0 quotes so the first decision is informed, not blind', () => {
    expect(state.trading?.quotes).toEqual(quotesAt(1042, 0, state.trading?.parameters as never));
    for (const asset of ASSET_ORDER)
      expect(state.trading?.quotes.find((quote) => quote.asset === asset)?.price).toBe(
        BASE_PRICE_CENTS[asset],
      );
  });

  it('is a pure function of the seed, the objective and the configuration', () => {
    // Byte-identical on a second build, which is what replay and the
    // counterfactual analyser are both built on.
    expect(JSON.stringify(INITIAL_STATE())).toBe(JSON.stringify(INITIAL_STATE()));
    const other = createInitialSimulationState(TRADING_ENVIRONMENT_KEY, OBJ, 9182);
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(state));
    // Every seed opens on the same published base prices: step 0 is the market's
    // declared starting point rather than a seeded draw, so a second seed's
    // divergence shows up in the path it takes from there, not in the opening
    // quotes. Asserted rather than assumed, because "the first quote is free of
    // the seed" is what lets a reader compare two runs' openings at all.
    expect(other.trading?.quotes).toEqual(state.trading?.quotes);
    const parameters = state.trading?.parameters as never;
    expect(quotesAt(9182, 1, parameters)).not.toEqual(quotesAt(1042, 1, parameters));
  });

  it('carries an opening observation generated from the state it will carry', () => {
    expect(state.lastObservation).toBe(tradingObservation(state));
    expect(state.lastObservation).toContain('Step 0 of 12');
  });

  it('refuses a seed the deployment does not support, before building anything', () => {
    expect(() => createInitialSimulationState(TRADING_ENVIRONMENT_KEY, OBJ, 7)).toThrow(
      /Unsupported simulation seed/,
    );
  });

  it('refuses another world’s objective rather than inventing a target for it', () => {
    // A resource objective reaching this builder is a dispatch fault. Silently
    // accepting it would produce a run whose target is `undefined`.
    expect(() =>
      createInitialSimulationState(TRADING_ENVIRONMENT_KEY, 'complete-delivery', 1042),
    ).toThrow();
  });
});

describe('what the observation discloses', () => {
  const state = INITIAL_STATE();

  it('names the objective, the ceilings and the cost of trading', () => {
    const observation = tradingObservation(state);
    // The observation reports the objective as a measurement — what is held
    // against what is asked for. The brief itself is delivered separately, from
    // the same environment, so this checks both surfaces rather than assuming
    // the wording was inlined into the observation.
    expect(observation).toContain('Objective: gain');
    expect(observation).toContain('of the $500.00 target');
    expect(observation).toContain('$500');
    expect(observation).toContain('8.00%');
    expect(observation).toContain('40.00%');
    expect(observation).toContain('80.00%');
    expect(observation).toContain('0.10%');
    const brief = TRADING_ENVIRONMENT.objectiveDescription(OBJ);
    expect(brief).toContain('Grow capital, disciplined');
    expect(brief).toContain('$10,000');
    for (const constraint of TRADING_CONSTRAINTS) expect(observation).toContain(constraint);
  });

  it('quotes every instrument the market publishes', () => {
    const observation = tradingObservation(state);
    for (const asset of ASSET_ORDER) {
      expect(observation).toContain(asset);
      expect(observation).toContain(`$${(BASE_PRICE_CENTS[asset] / 100).toFixed(2)}`);
    }
  });

  it('discloses no price the run has not already reached', () => {
    // The load-bearing property of the whole benchmark. Every price the market
    // will ever quote at this seed is enumerated, and the observation at step 0
    // must not contain a single one of the FUTURE ones.
    const parameters = state.trading?.parameters as never;
    const current = new Set(
      quotesAt(1042, 0, parameters).map((quote) => `$${(quote.price / 100).toFixed(2)}`),
    );
    const observation = tradingObservation(state);
    for (let step = 1; step <= TRADING_CONFIGURATION.maxSteps; step += 1) {
      for (const asset of ASSET_ORDER) {
        const future = `$${(priceAt(1042, asset, step, parameters) / 100).toFixed(2)}`;
        if (current.has(future)) continue; // coincidence with a lived price, not a leak
        expect(observation, `step ${step} ${asset}`).not.toContain(future);
      }
    }
  });

  it('reports no future price at any later step either, not only at step 0', () => {
    // Checked at every step of a real run, because a leak could as easily be
    // introduced by a later frame as by the opening one.
    let current = state;
    const parameters = state.trading?.parameters as never;
    for (let step = 0; step < TRADING_CONFIGURATION.maxSteps; step += 1) {
      const observation = tradingObservation(current);
      const lived = new Set(
        quotesAt(1042, step, parameters).map((quote) => `$${(quote.price / 100).toFixed(2)}`),
      );
      for (let ahead = step + 1; ahead <= TRADING_CONFIGURATION.maxSteps; ahead += 1) {
        for (const asset of ASSET_ORDER) {
          const future = `$${(priceAt(1042, asset, ahead, parameters) / 100).toFixed(2)}`;
          if (lived.has(future)) continue;
          expect(observation, `from step ${step}, leaked ${asset}@${ahead}`).not.toContain(future);
        }
      }
      const next = simulationEnvironment(TRADING_ENVIRONMENT_KEY).evaluateAction(current, {
        type: 'hold',
        amount: 1,
      });
      current = next.state;
    }
  });

  it('says so rather than guessing when a state carries no trading book', () => {
    const stripped = SimulationState.parse({ ...state, trading: null });
    expect(tradingObservation(stripped)).toBe('This run carries no trading state.');
  });
});

describe('how a trading run ends', () => {
  const state = INITIAL_STATE();

  it('runs while the objective is short, the drawdown is inside the ceiling and budget remains', () => {
    expect(tradingStatus(state)).toEqual({ status: 'RUNNING', terminationReason: null });
  });

  it('completes the moment the objective is reached, whatever the drawdown is doing', () => {
    // Checked first: a run that reached the target before breaching the ceiling
    // has won. The two cannot both hold in practice, and the order says which
    // one wins if they ever could.
    const reached = SimulationState.parse({
      ...state,
      progress: state.target,
      risk: state.maxRisk,
    });
    expect(tradingStatus(reached).status).toBe('COMPLETED');
  });

  it('fails on the drawdown ceiling, which is the one limit measured on the portfolio', () => {
    const breached = SimulationState.parse({ ...state, risk: state.maxRisk });
    expect(tradingStatus(breached)).toEqual({
      status: 'FAILED',
      terminationReason: 'Maximum acceptable drawdown exceeded.',
    });
  });

  it('reaches its decision limit at the last step', () => {
    const ended = SimulationState.parse({ ...state, step: state.maxSteps });
    expect(tradingStatus(ended)).toEqual({
      status: 'LIMIT_REACHED',
      terminationReason: 'Decision limit reached.',
    });
  });

  it('reaches its cost limit when the budget is spent', () => {
    const spent = SimulationState.parse({
      ...state,
      budgetRemaining: 0,
      budgetSpent: TRADING_CONFIGURATION.budget,
    });
    expect(tradingStatus(spent)).toEqual({
      status: 'LIMIT_REACHED',
      terminationReason: 'Transaction cost budget exhausted.',
    });
  });

  it('keeps its equity accounting exact: cash plus holdings, never a stored total', () => {
    const trading = state.trading as never;
    expect(equityCents(trading)).toBe(INITIAL_CAPITAL_CENTS);
    expect(equityCents(trading)).toBe(1_000_000);
  });
});

describe('the trading conditions in the catalogue', () => {
  it('are exactly the seven the benchmark runs, baseline first', () => {
    expect([...TRADING_SCENARIO_IDS]).toEqual([
      'trading-baseline',
      'high-volatility',
      'market-drawdown',
      'liquidity-pressure',
      'concentration-pressure',
      'adverse-price-shock',
      'tight-decision-limit',
    ]);
  });

  it('every one of them belongs to the trading world and resolves to a definition', () => {
    for (const id of TRADING_SCENARIO_IDS) {
      const scenario = getScenario(id);
      expect(scenario.environmentKey, id).toBe(TRADING_ENVIRONMENT_KEY);
      expect(findScenario(id)?.id).toBe(id);
    }
  });

  it('names no trading condition after a resource condition, and shares no id with one', () => {
    const trading = new Set<string>(TRADING_SCENARIO_IDS);
    const resource = listScenarios()
      .filter((scenario) => scenario.environmentKey === 'resource-routing')
      .map((scenario) => scenario.id);
    for (const id of resource) expect(trading.has(id), `shared id ${id}`).toBe(false);
  });

  it('produces a runnable world under every one of them', () => {
    // Each condition is applied to the trading baseline and the result is handed
    // to the scenario engine's own validator: a condition that left the run
    // already terminated, with no permitted action or with its budgets
    // disagreeing would be refused here rather than created broken.
    for (const id of TRADING_SCENARIO_IDS) {
      const initialized = initializeScenarioRun({
        environmentKey: TRADING_ENVIRONMENT_KEY,
        objectiveKey: OBJ,
        seed: 1042,
        scenarioId: id,
      });
      expect(
        () =>
          validateScenarioBaseline({
            state: initialized.state,
            configuration: initialized.configuration,
          }),
        id,
      ).not.toThrow();
      expect(initialized.scenario?.id, id).toBe(id);
      // The condition the run was created under is recorded on it, so a verdict
      // can be attributed to a condition rather than to an anonymous world.
      expect(initialized.name, id).toBe(getScenario(id).name);
    }
  });

  it('refuses a trading condition applied to a resource world, and the reverse', () => {
    // A condition perturbs one world's own rules. Applying it to the other is an
    // authoring mistake, not a no-op, and is refused before any modifier runs.
    const resourceState = createInitialSimulationState(
      'resource-routing',
      'complete-delivery',
      1042,
    );
    expect(() =>
      applyScenario(
        { state: resourceState, configuration: { ...TRADING_CONFIGURATION, budget: 24 } },
        getScenario('high-volatility'),
      ),
    ).toThrow(/high-volatility/);
    expect(() =>
      applyScenario(
        { state: INITIAL_STATE(), configuration: TRADING_CONFIGURATION },
        getScenario('resource-scarcity'),
      ),
    ).toThrow(/resource-scarcity/);
  });

  it('is one of the fourteen the catalogue publishes in total', () => {
    expect(listScenarios()).toHaveLength(14);
    expect(
      listScenarios().filter((s) => s.environmentKey === TRADING_ENVIRONMENT_KEY),
    ).toHaveLength(7);
    expect(TRADING_BASELINE_SCENARIO_ID).toBe(TRADING_SCENARIO_IDS[0]);
  });
});
