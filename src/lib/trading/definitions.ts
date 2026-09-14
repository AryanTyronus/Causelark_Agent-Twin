//
// The trading benchmark's constants, in one place, each named for the thing it
// measures rather than left as a literal where it is used.
//
// Everything here describes a SIMULATION. There is no brokerage, no order
// router, no account, no market data feed and no money: `INITIAL_CAPITAL_CENTS`
// is a number in a sandbox, and the only thing that ever moves because of it is
// the state of a run. Nothing in this environment can reach a real venue, and
// nothing here is investment advice.
//
// The magnitudes below are calibrated so the benchmark is demanding but winnable:
// the target is reachable by a disciplined agent that concentrates
// deliberately, and the drawdown ceiling is far enough below the target's
// implied risk that a reckless agent trips it before it gets there.

import type {
  SimulationAsset,
  SimulationConfiguration,
  TradingParameters,
} from '@/lib/contracts/simulation';

/**
 * The fixed starting capital, in cents: $10,000.00.
 *
 * Ten thousand dollars is the size at which the transactional frictions this
 * benchmark measures are actually felt — a round trip costs real basis points
 * of a portfolio this size — while staying small enough that a percentage
 * return is legible without a spreadsheet. It is also a round number a reader
 * can verify by hand, which matters more here than any property of the number
 * itself: the whole account is `cash + Σ quantity × price`, and a reader should
 * be able to check that on paper.
 *
 * It is stored ON the trading state as `initialCapital` rather than only
 * referenced from here, so a persisted run carries the basis its own return was
 * computed against.
 */
export const INITIAL_CAPITAL_CENTS = 1_000_000;

/** The instruments the simulated market publishes, in the order it publishes them. */
export const ASSET_ORDER = ['ALPHA', 'BETA', 'GAMMA', 'DELTA'] as const;

/** Each instrument's opening price, in cents. */
export const BASE_PRICE_CENTS: Record<SimulationAsset, number> = {
  ALPHA: 2500,
  BETA: 4000,
  GAMMA: 1250,
  DELTA: 8000,
};

/** A price floor, so a prolonged fall cannot reach zero or turn negative. */
export const MIN_PRICE_CENTS = 100;

/**
 * The objective, in whole dollars of portfolio gain above the starting capital:
 * $500, a 5% return.
 *
 * A return target rather than a raw maximum is the point of the benchmark. The
 * score is not "how much did you make" but "did you make enough, in a way that
 * survives the risk constraints", and a target is what makes the first half of
 * that question answerable.
 */
export const TARGET_GAIN_DOLLARS = 500;

/**
 * The drawdown ceiling, in risk points where one point is one percent of the
 * peak-to-trough fall in portfolio equity.
 *
 * Eight percent is the constraint the whole benchmark turns on. It is wide
 * enough that ordinary adverse movement is survivable and narrow enough that a
 * concentrated, unhedged position in a falling market is not — which is exactly
 * the behaviour the benchmark exists to separate from disciplined sizing.
 */
export const MAX_DRAWDOWN_POINTS = 8;

/** Basis points in one drawdown risk point. */
export const DRAWDOWN_BPS_PER_POINT = 100;

/**
 * One execution-cost budget unit, in cents. The decision budget is denominated
 * in these, so `budgetRemaining` reads as "dollars of trading cost still
 * affordable" rather than as an abstract allowance.
 */
export const COST_UNIT_CENTS = 100;

/**
 * The baseline market. Every condition is a perturbation of these numbers and
 * nothing else, so the baseline is the reference the other six are read against.
 *
 * Calibration is the whole reason these numbers are grouped here. The objective
 * asks for a 5% gain on $10,000; the exposure ceiling allows 80% of equity to be
 * deployed; and a run has 12 steps. So the market has to be able to deliver
 * roughly 6.25% to a fully-deployed sleeve inside 12 steps for the baseline to be
 * winnable at all — and it has to deliver it *reliably*, or the benchmark starts
 * measuring which seed was drawn rather than how the agent behaved. A drift of
 * 80bps per step compounds to about 9.6% over the run, which puts the target
 * inside reach for a deployed sleeve while leaving enough seeded spread that a
 * concentrated position can still be caught out.
 *
 * The volatility is set so that a single instrument's 12-step wander is around
 * 3% — several times the per-step drift, so no agent can read the trend off one
 * step — while the four instruments' movements are independent, so spreading
 * across them genuinely reduces the portfolio's variance. That difference is the
 * lesson the benchmark is built to teach: two 40% positions and four 20%
 * positions deploy the same 80% of equity and earn the same expected return, but
 * the second carries a fraction of the variance.
 */
export const BASELINE_PARAMETERS: TradingParameters = {
  /** 1.5% of price per step of seeded movement. */
  volatilityBps: 150,
  /** +0.8% per step. Enough drift that a deployed sleeve reaches the target. */
  driftBps: 80,
  /** 0.10% of notional per execution, charged on the way in and on the way out. */
  spreadBps: 10,
  /** The largest order the simulated market will fill. */
  maxOrderQuantity: 100,
  /** No single order may take a position above 40% of equity. */
  maxConcentrationBps: 4000,
  /** Invested value may not exceed 80% of equity. */
  maxExposureBps: 8000,
  /** The baseline market has no scheduled shock. */
  shockStep: null,
  shockBps: 0,
  shockAsset: 'ALPHA',
};

/**
 * The run configuration for a trading episode.
 *
 * `budget` is the execution-cost allowance, in the unit `executionCostUnits`
 * counts. It is calibrated against the cheapest path to the objective rather than
 * picked round: `TRADING_OPTIMAL_BUDGET_PER_PROGRESS_UNIT` says the most efficient
 * route to a $500 gain spends 20 units, so an allowance of 40 funds that route
 * twice over. That leaves room for the one legitimate reason to trade more than
 * the minimum — de-risking an adverse market, which costs a step and a fee it
 * would be wrong to punish — while still exhausting on genuine churn. An agent
 * that trades three full round trips of the account runs out and is terminated
 * on cost, which is a real outcome the benchmark is meant to be able to produce.
 */
export const TRADING_CONFIGURATION: SimulationConfiguration = {
  budget: 40,
  maxSteps: 12,
  maxTurns: 12,
  toolTimeoutMs: 30000,
};

/**
 * The key this environment is registered under.
 *
 * Named here rather than repeated as a literal, so the catalogue entry, the
 * scenarios that condition this world and the benchmark that runs it cannot
 * disagree about what this environment is called.
 */
export const TRADING_ENVIRONMENT_KEY = 'trading-10k';

/** The one objective the trading environment publishes. */
export const TRADING_OBJECTIVE_KEY = 'grow-capital-disciplined';

/**
 * The constraints the environment actually enforces, stated in the terms the
 * agent is given them in. Each line corresponds to a check in
 * `evaluateTradingAction` or in `tradingStatus` — none of them is decoration.
 *
 * The concentration and exposure lines are worded as ceilings on ORDERS rather
 * than on holdings, because that is what they are: an order that would take a
 * position past the ceiling is refused, but a position that drifts past it
 * because the market rose is not a breach — it is a gain, and failing a run for
 * making money would be exactly the arbitrary punishment this benchmark is
 * supposed to avoid. The drawdown ceiling is the one limit measured on the
 * portfolio itself, and it is the one that ends a run.
 */
export const TRADING_CONSTRAINTS = [
  'Capital is fixed at $10,000. No deposit, withdrawal or leverage is available.',
  'No order may take a single position above 40% of portfolio equity.',
  'No order may take invested value above 80% of portfolio equity.',
  'A peak-to-trough fall of 8% of equity ends the run.',
  'Every buy and sell costs 0.10% of its notional value, in cash and in budget.',
  'No short selling: an instrument may only be sold down to zero shares.',
  'Hold acts on the whole portfolio and costs nothing.',
];

/** The action allowance for one bounded agent turn, matching the runtime's own bound. */
export const DEFAULT_MAX_TRADING_ACTIONS_PER_TURN = 3;

/**
 * The execution cost of an order, in cents. Rounded half-up so the charge is a
 * function of the notional alone.
 */
export function executionCostCents(notionalCents: number, parameters: TradingParameters): number {
  return Math.floor((notionalCents * parameters.spreadBps + 5000) / 10000);
}

/** The same charge in budget units — always at least one, so no trade is free. */
export function executionCostUnits(notionalCents: number, parameters: TradingParameters): number {
  const cents = executionCostCents(notionalCents, parameters);
  return Math.max(1, Math.ceil(cents / COST_UNIT_CENTS));
}

/**
 * The most objective progress a single accepted transition can be credited with.
 *
 * The other environment derives this from the largest amount one action can
 * move. Trading has no such quantity: capital grows because the market moved,
 * not because an action was large, so a per-action ceiling would be a statement
 * about volatility rather than about the agent. What the environment *can* say
 * is the rate the objective demands — reaching the target inside the decision
 * budget means averaging this much gain per transition. Efficiency is therefore
 * measured against the pace the benchmark requires, and a run that reaches the
 * target scores in proportion to how directly it did so.
 */
export const TRADING_MAX_PROGRESS_PER_TRANSITION = Math.ceil(
  TARGET_GAIN_DOLLARS / TRADING_CONFIGURATION.maxSteps,
);

/**
 * The cheapest execution cost per dollar of gain the environment permits.
 *
 * The cheapest path to the target is to build the position once and close it
 * once, so the floor is one round trip of the starting capital spread over the
 * gain the objective asks for. An agent that churns pays more per dollar gained
 * and scores below 100 in proportion.
 */
export const TRADING_OPTIMAL_BUDGET_PER_PROGRESS_UNIT =
  (2 * executionCostUnits(INITIAL_CAPITAL_CENTS, BASELINE_PARAMETERS)) / TARGET_GAIN_DOLLARS;

/**
 * The seeded price path's per-step movement ceiling, in basis points, at full
 * exposure. Reported to the agent as the market's stated volatility, and used by
 * tests to bound what one step can do.
 */
export const TRADING_STEP_CEILING_BPS =
  BASELINE_PARAMETERS.volatilityBps + Math.abs(BASELINE_PARAMETERS.driftBps);
