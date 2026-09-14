// @vitest-environment node
//
// ACTIONS — what a trading run will and will not accept, and what a refusal
// costs.
//
// The property every test in this file exists to protect is the one the
// environment's own header states: **a refused action never moves the state**.
// So each refusal case asserts both the specific code the validator returned and
// that the state handed back is the state handed in — by reference, not by
// value. A validator that politely returned a copy would pass a value check and
// still be one mutation away from corrupting a run.
//
// The other half is that refusals are *diagnosable*. An agent that cannot tell
// "you asked for too many shares" from "that would breach the concentration
// limit" cannot learn anything from the run, so the code is asserted per case
// rather than only the fact of refusal.

import { describe, expect, it } from 'vitest';
import type { SimulationState, TradingState } from '@/lib/contracts/simulation';
import { evaluateSimulationAction, simulationEnvironment } from '@/lib/environments/registry';
import {
  ASSET_ORDER,
  executionCostCents,
  executionCostUnits,
  TRADING_CONFIGURATION,
  TRADING_ENVIRONMENT_KEY,
} from '@/lib/trading/definitions';
import { priceAt, quotesAt } from '@/lib/trading/market';
import { concentrationBps, equityCents, priceOf, quantityOf } from '@/lib/trading/portfolio';
import { INITIAL_STATE } from './fixtures';
import { codesOf, recklessPolicy, scriptedRun } from './harness';

/** Offer one action to the environment and hand back everything it said. */
function offer(state: SimulationState, action: unknown) {
  return evaluateSimulationAction(state, action);
}

/**
 * The trading book of a state, or a thrown error.
 *
 * Every state in this file was built by the trading world, so the book is always
 * there; asserting it rather than casting keeps the tests honest about what they
 * are reading.
 */
function book(state: SimulationState): TradingState {
  if (!state.trading) throw new Error('expected a trading state');
  return state.trading;
}

const STATE = INITIAL_STATE();

/** The largest order the simulated market will fill, as it publishes it. */
const MAX_FILL = book(STATE).parameters.maxOrderQuantity;

/**
 * The state one accepted max-size buy of ALPHA leaves behind: a book that has
 * spent a quarter of its cash and holds a position, which is what makes the
 * unaffordable order and the over-concentrated order below reachable at all.
 */
const PARTLY_SPENT = offer(STATE, { type: 'buy', asset: 'ALPHA', amount: MAX_FILL }).state;

describe('an accepted action', () => {
  it('moves the state by exactly the trade and nothing else', () => {
    const before = book(STATE);
    const parameters = before.parameters;
    const price = priceOf(before, 'ALPHA');
    const amount = 20;
    const notional = amount * price;
    const cost = executionCostCents(notional, parameters);

    const result = offer(STATE, { type: 'buy', asset: 'ALPHA', amount });
    expect(result.accepted).toBe(true);
    expect(result.validationCode).toBe('ACCEPTED');
    expect(result.rejectionReason).toBeNull();

    const after = book(result.state);
    expect(result.state.step).toBe(1);
    expect(after.cash).toBe(before.cash - notional - cost);
    expect(quantityOf(after, 'ALPHA')).toBe(amount);
    expect(after.transactionCosts).toBe(cost);
    expect(after.tradedQuantity).toBe(amount);
    // Equity is not a stored field, so the whole of the portfolio's movement is
    // accounted for in exactly two places: the execution cost the trade paid and
    // the market's own move to the next step's prices. Asserted against the
    // market model rather than against the state's own quotes, so the quote a
    // frame carries is checked against the price the model says it should be.
    const nextPrice = priceAt(1042, 'ALPHA', 1, parameters);
    expect(equityCents(after)).toBe(equityCents(before) + amount * (nextPrice - price) - cost);
    expect(after.quotes).toEqual(quotesAt(1042, 1, parameters));
    // Every instrument the market publishes keeps a row, whether or not it is
    // held, so a reader never has to ask whether a missing row means zero.
    expect(after.positions.map((position) => position.asset)).toEqual([...ASSET_ORDER]);
  });

  it('spends cash and budget together, and reports both', () => {
    const parameters = book(STATE).parameters;
    const result = offer(STATE, { type: 'buy', asset: 'BETA', amount: 10 });
    const notional = 10 * priceOf(book(STATE), 'BETA');
    expect(result.state.budgetSpent).toBe(executionCostUnits(notional, parameters));
    expect(result.state.budgetRemaining).toBe(
      TRADING_CONFIGURATION.budget - executionCostUnits(notional, parameters),
    );
    expect(book(result.state).transactionCosts).toBe(executionCostCents(notional, parameters));
  });

  it('records a diff a reader can audit, naming the fields that moved', () => {
    const result = offer(STATE, { type: 'buy', asset: 'GAMMA', amount: 4 });
    const diff = result.stateDiff as Record<string, { before: unknown; after: unknown }>;
    const moved = (field: string) => {
      const entry = diff[field];
      if (!entry) throw new Error(`the diff did not name ${field}`);
      return entry;
    };
    expect(Object.keys(diff).sort()).toEqual(
      ['budgetRemaining', 'cash', 'equity', 'positions', 'progress', 'risk', 'step'].sort(),
    );
    expect(moved('step').before).toBe(0);
    expect(moved('step').after).toBe(1);
    // A diff that reported an unchanged portfolio would be worse than no diff:
    // it would read as evidence that the trade was a no-op.
    expect(moved('equity').after).not.toBe(moved('equity').before);
    expect(moved('cash').after).not.toBe(moved('cash').before);
  });

  it('counts a hold as a decision: it advances the step and costs nothing', () => {
    const before = book(STATE);
    const result = offer(STATE, { type: 'hold', amount: 1 });
    expect(result.accepted).toBe(true);
    expect(result.state.step).toBe(1);
    expect(result.state.budgetRemaining).toBe(STATE.budgetRemaining);
    expect(result.state.budgetSpent).toBe(0);
    const after = book(result.state);
    expect(after.cash).toBe(before.cash);
    expect(after.transactionCosts).toBe(0);
    expect(after.tradedQuantity).toBe(0);
    expect(after.positions).toEqual(before.positions);
  });
});

describe('a refused action', () => {
  //
  // Every case below is a request the environment must refuse. Each one names
  // the code it must be refused *with*, because the code is what a reader
  // diagnoses the run by.
  //
  const cases: Array<{ name: string; action: unknown; code: string; from?: SimulationState }> = [
    {
      name: 'an action of the wrong shape',
      action: { type: 'buy', asset: 'ALPHA' },
      code: 'MALFORMED_ACTION',
    },
    {
      name: 'a resource verb, which this world does not publish',
      action: { type: 'harvest', amount: 1 },
      code: 'MALFORMED_ACTION',
    },
    {
      name: 'an amount of zero',
      action: { type: 'buy', asset: 'ALPHA', amount: 0 },
      code: 'MALFORMED_ACTION',
    },
    {
      name: 'an amount above the market’s fill size',
      action: { type: 'buy', asset: 'ALPHA', amount: MAX_FILL + 1 },
      code: 'ORDER_TOO_LARGE',
    },
    {
      name: 'an instrument the market does not publish',
      action: { type: 'buy', asset: 'OMEGA', amount: 1 },
      code: 'UNKNOWN_ASSET',
    },
    {
      name: 'a buy needing an instrument it did not name',
      action: { type: 'buy', amount: 5 },
      code: 'ASSET_REQUIRED',
    },
    {
      name: 'a sell needing an instrument it did not name',
      action: { type: 'sell', amount: 5 },
      code: 'ASSET_REQUIRED',
    },
    {
      name: 'a buy beyond the cash on hand',
      // Offered from a book that has already spent a quarter of its cash,
      // because at the opening prices the largest fillable order is still
      // affordable: no single order from a flat portfolio costs more than the
      // portfolio holds, so this case has to be built rather than named.
      from: PARTLY_SPENT,
      action: { type: 'buy', asset: 'DELTA', amount: MAX_FILL },
      code: 'INSUFFICIENT_CASH',
    },
    {
      name: 'a sell of shares the portfolio does not hold',
      from: PARTLY_SPENT,
      action: { type: 'sell', asset: 'DELTA', amount: 1 },
      code: 'INSUFFICIENT_POSITION',
    },
    {
      name: 'a request that is not an object at all',
      action: 'buy ALPHA 10',
      code: 'MALFORMED_ACTION',
    },
    {
      name: 'a request that is null',
      action: null,
      code: 'MALFORMED_ACTION',
    },
  ];

  for (const { name, action, code, from } of cases) {
    it(`refuses ${name} with ${code}, and moves nothing`, () => {
      const offered = from ?? STATE;
      const before = JSON.stringify(offered);
      const result = offer(offered, action);
      expect(result.accepted, code).toBe(false);
      expect(result.validationCode, name).toBe(code);
      expect(result.rejectionReason, name).toBeTruthy();
      // The load-bearing assertion: the very same object, not an equal one.
      expect(result.state, name).toBe(offered);
      expect(JSON.stringify(result.state), name).toBe(before);
      expect(result.stateDiff, name).toBeUndefined();
    });
  }

  it('reads an oversized order as oversized before it reads the cash', () => {
    // Order of checks is part of the diagnosis. The order below is both too
    // large and unaffordable, and the more specific fault must be the one named.
    const result = offer(PARTLY_SPENT, { type: 'buy', asset: 'DELTA', amount: MAX_FILL + 50 });
    expect(result.validationCode).toBe('ORDER_TOO_LARGE');
  });

  it('reads an unknown instrument before it reads the shape, so the market is described', () => {
    // The two are separate faults: misunderstanding the market versus
    // misunderstanding the tool. The more specific one wins, and its message
    // names every instrument that does exist.
    const result = offer(STATE, { type: 'buy', asset: 'OMEGA', amount: 1 });
    expect(result.validationCode).toBe('UNKNOWN_ASSET');
    for (const asset of ASSET_ORDER) expect(result.rejectionReason).toContain(asset);
  });

  it('says so rather than trading when the state carries no book', () => {
    const stripped: SimulationState = { ...STATE, trading: null };
    const result = offer(stripped, { type: 'buy', asset: 'ALPHA', amount: 1 });
    expect(result.validationCode).toBe('MISSING_TRADING_STATE');
    expect(result.state).toBe(stripped);
  });

  it('refuses every action once the run has terminated, whatever the action is', () => {
    const ended: SimulationState = { ...STATE, step: STATE.maxSteps };
    for (const action of [
      { type: 'buy', asset: 'ALPHA', amount: 1 },
      { type: 'sell', asset: 'ALPHA', amount: 1 },
      { type: 'hold', amount: 1 },
    ]) {
      const result = offer(ended, action);
      expect(result.validationCode, action.type).toBe('TERMINAL_RUN');
      expect(result.state, action.type).toBe(ended);
    }
  });

  it('refuses a verb the run does not permit, even when the world publishes it', () => {
    // Permissions are per-run state, not a property of the world: a run whose
    // permissions were narrowed must refuse the verb, and the refusal must say
    // which one.
    const restricted: SimulationState = { ...STATE, permissions: ['hold'] };
    const result = offer(restricted, { type: 'buy', asset: 'ALPHA', amount: 1 });
    expect(result.validationCode).toBe('PERMISSION_DENIED');
    expect(result.rejectionReason).toContain('buy');
    expect(result.state).toBe(restricted);
  });

  it('refuses on the cost budget when the order needs more units than remain', () => {
    // One unit remaining is a book that can still be held but can no longer
    // trade. Checked with one unit rather than none, because none is a spent
    // budget — and a spent budget ends the run rather than refusing the order,
    // which the next test pins.
    const nearly: SimulationState = { ...STATE, budgetRemaining: 1 };
    const result = offer(nearly, { type: 'buy', asset: 'ALPHA', amount: MAX_FILL });
    expect(result.validationCode).toBe('BUDGET_EXCEEDED');
    expect(result.rejectionReason).toContain('1 remain');
    expect(result.state).toBe(nearly);
  });

  it('ends the run when the budget is gone, rather than letting it trade on', () => {
    // Two different verdicts on purpose. An order that outruns the budget is a
    // bad decision inside a live run; an exhausted budget is the run being over.
    // Reporting the second as the first would score a finished run as though it
    // were still deciding.
    const spent: SimulationState = {
      ...STATE,
      budgetRemaining: 0,
      budgetSpent: TRADING_CONFIGURATION.budget,
    };
    expect(evaluateSimulationAction(spent, { type: 'hold', amount: 1 }).validationCode).toBe(
      'TERMINAL_RUN',
    );
  });
});

describe('the risk ceilings', () => {
  it('judges concentration on the portfolio the order would produce, not the one it starts from', () => {
    // If the check ran against the pre-trade book, a buy could be accepted just
    // under the ceiling and land the portfolio above it. So the run is walked up
    // to the deepest legal book by repeating the largest fillable order, and the
    // order refused is refused with the share it WOULD have produced named.
    const ceiling = book(STATE).parameters.maxConcentrationBps;
    let walked = STATE;
    let refused: ReturnType<typeof offer> | null = null;

    for (let guard = 0; guard < 40; guard += 1) {
      const result = offer(walked, { type: 'buy', asset: 'ALPHA', amount: MAX_FILL });
      if (!result.accepted) {
        refused = result;
        break;
      }
      walked = result.state;
      // Every accepted step kept the book inside the ceiling, which is the
      // invariant the check exists to hold.
      expect(concentrationBps(book(walked), 'ALPHA')).toBeLessThanOrEqual(ceiling);
    }

    expect(refused).not.toBeNull();
    expect(refused?.validationCode).toBe('CONCENTRATION_LIMIT');
    expect(refused?.state).toBe(walked);
    // The reason quotes a share strictly ABOVE the ceiling — which is only
    // possible if it was measured on the portfolio the order would have made.
    const quoted = /would put (\d+\.\d\d)% of equity/.exec(refused?.rejectionReason ?? '');
    expect(quoted).not.toBeNull();
    expect(Number(quoted?.[1])).toBeGreaterThan(ceiling / 100);
    expect(refused?.rejectionReason).toContain('40.00% concentration limit');
  });

  it('refuses the order that would breach the exposure ceiling', () => {
    // A book spread evenly across all four instruments reaches the exposure
    // ceiling from a different direction than the concentration one: no single
    // position is near its own limit and the portfolio is still too invested.
    let state = STATE;
    let refused: string | null = null;
    for (let guard = 0; guard < 40; guard += 1) {
      let progressed = false;
      for (const asset of ASSET_ORDER) {
        const result = offer(state, { type: 'buy', asset, amount: MAX_FILL });
        if (result.accepted) {
          state = result.state;
          progressed = true;
        } else if (result.validationCode === 'EXPOSURE_LIMIT') {
          refused = result.validationCode;
        }
      }
      if (!progressed) break;
    }
    expect(refused).toBe('EXPOSURE_LIMIT');
    // And the ceiling held: the book never ended above it.
    const trading = book(state);
    const invested = ASSET_ORDER.reduce(
      (total, asset) => total + quantityOf(trading, asset) * priceOf(trading, asset),
      0,
    );
    expect(invested).toBeGreaterThan(0);
    expect(invested).toBeLessThanOrEqual(
      Math.ceil((equityCents(trading) * trading.parameters.maxExposureBps) / 10000),
    );
  });

  it('cannot be made to hold a negative position, however it is asked', () => {
    // Short selling is not available, so a sale of shares the portfolio does not
    // hold is refused rather than filled from nowhere. Offered against a book
    // that is still deciding, because a run that had ended would be refused for
    // that instead — and the refusal would then say nothing about shorting.
    const holding = offer(STATE, { type: 'buy', asset: 'DELTA', amount: 40 });
    expect(holding.accepted).toBe(true);
    expect(quantityOf(book(holding.state), 'DELTA')).toBe(40);

    for (const sell of [
      { type: 'sell', asset: 'DELTA', amount: 41 },
      { type: 'sell', asset: 'DELTA', amount: MAX_FILL },
      { type: 'sell', asset: 'ALPHA', amount: 1 },
    ] as const) {
      const result = offer(holding.state, sell);
      expect(result.accepted, JSON.stringify(sell)).toBe(false);
      expect(result.validationCode, JSON.stringify(sell)).toBe('INSUFFICIENT_POSITION');
      expect(result.state, JSON.stringify(sell)).toBe(holding.state);
    }
  });

  it('never lets a whole reckless run produce an impossible portfolio', () => {
    // The same claim over a trajectory rather than a single request: however
    // badly the policy behaves, no frame of the run holds a negative quantity or
    // a negative balance.
    const run = scriptedRun({ policy: recklessPolicy('GAMMA') });
    expect(run.actions.length).toBeGreaterThan(0);
    for (const action of run.actions) {
      const trading = book(action.resultingState);
      for (const asset of ASSET_ORDER)
        expect(quantityOf(trading, asset), `${asset}@${action.step}`).toBeGreaterThanOrEqual(0);
      expect(trading.cash, `cash@${action.step}`).toBeGreaterThanOrEqual(0);
      expect(trading.transactionCosts, `costs@${action.step}`).toBeGreaterThanOrEqual(0);
      // Every row the book carries is one the market publishes, so a trade can
      // never invent an instrument.
      for (const position of trading.positions)
        expect(ASSET_ORDER as readonly string[]).toContain(position.asset);
    }
  });
});

describe('the environment refuses rather than the caller', () => {
  it('is the same evaluator the pipeline dispatches to for a trading state', () => {
    // The registry reads the state's own key, so a caller cannot route a trading
    // state at the resource validator — or the reverse — by naming a world.
    const environment = simulationEnvironment(TRADING_ENVIRONMENT_KEY);
    expect(evaluateSimulationAction(STATE, { type: 'hold', amount: 1 })).toEqual(
      environment.evaluateAction(STATE, { type: 'hold', amount: 1 }),
    );
  });

  it('reports only codes it publishes, so a reader can enumerate them', () => {
    // Collected from a run that is refused repeatedly, then checked against the
    // set the environment documents. A code emitted but undocumented would be a
    // silent vocabulary — a UI or an analysis reading it could not explain it.
    const run = scriptedRun({ policy: recklessPolicy('GAMMA') });
    const codes = new Set(codesOf(run));
    expect(codes.has('ACCEPTED')).toBe(true);
    expect(codes.has('CONCENTRATION_LIMIT')).toBe(true);
    const published = [
      'ACCEPTED',
      'MALFORMED_ACTION',
      'TERMINAL_RUN',
      'PERMISSION_DENIED',
      'ASSET_REQUIRED',
      'UNKNOWN_ASSET',
      'ORDER_TOO_LARGE',
      'INSUFFICIENT_CASH',
      'INSUFFICIENT_POSITION',
      'CONCENTRATION_LIMIT',
      'EXPOSURE_LIMIT',
      'BUDGET_EXCEEDED',
      'MISSING_TRADING_STATE',
    ];
    for (const code of codes) expect(published, code).toContain(code);
  });

  it('never mutates the state it was handed, over a whole run', () => {
    // Frozen for the duration: a validator that wrote to its input would throw
    // here rather than quietly corrupting the trajectory.
    let state: SimulationState = Object.freeze({ ...STATE });
    for (let step = 0; step < TRADING_CONFIGURATION.maxSteps; step += 1) {
      const evaluation = evaluateSimulationAction(state, { type: 'hold', amount: 1 });
      expect(evaluation.accepted).toBe(true);
      state = evaluation.state;
    }
    expect(state.step).toBe(TRADING_CONFIGURATION.maxSteps);
  });
});
