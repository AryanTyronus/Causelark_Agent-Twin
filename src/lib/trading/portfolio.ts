//
// Portfolio arithmetic.
//
// Every value here is DERIVED from the stored state and never stored itself.
// That is the whole design of this module: a persisted trading state holds cash,
// quantities, average entry prices, quotes and a peak — facts — and every
// judgement made from them (equity, exposure, concentration, unrealized P&L,
// return, drawdown) is a pure function of those facts. A stored derived value
// could disagree with its own components; a computed one cannot.
//
// All money is integer cents and all quantities are whole shares, so none of
// this arithmetic can drift. Ratios are returned in whole basis points, which
// keeps them integers too: one basis point is 0.01%.

import type { SimulationAsset, TradingState } from '@/lib/contracts/simulation';
import { DRAWDOWN_BPS_PER_POINT } from './definitions';

/** Basis points in one whole unit. */
const BPS = 10000;

/**
 * Ratio in basis points, guarding the empty portfolio. Always rounded half-up.
 *
 * Exported because the environment has to judge concentration and exposure on a
 * portfolio an order *would* produce, which is not a state any of the functions
 * below can be handed. One implementation of "a ratio in basis points" means a
 * hypothetical portfolio and a real one can never round differently.
 */
export function ratioBps(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.floor((numerator * BPS + Math.floor(denominator / 2)) / denominator);
}

/** The price the state currently quotes for one instrument. */
export function priceOf(state: TradingState, asset: SimulationAsset): number {
  return state.quotes.find((quote) => quote.asset === asset)?.price ?? 0;
}

/** The held quantity of one instrument. */
export function quantityOf(state: TradingState, asset: SimulationAsset): number {
  return state.positions.find((position) => position.asset === asset)?.quantity ?? 0;
}

/** The average entry price of one instrument, or 0 while it is not held. */
export function averageEntryOf(state: TradingState, asset: SimulationAsset): number {
  return state.positions.find((position) => position.asset === asset)?.averageEntryPrice ?? 0;
}

/** What one holding is worth at the current quotes, in cents. */
export function positionValueCents(state: TradingState, asset: SimulationAsset): number {
  return quantityOf(state, asset) * priceOf(state, asset);
}

/** What every holding is worth together, in cents — the invested value. */
export function investedCents(state: TradingState): number {
  return state.positions.reduce(
    (total, position) => total + position.quantity * priceOf(state, position.asset),
    0,
  );
}

/**
 * Total portfolio equity in cents: cash plus the market value of everything held.
 *
 * This is the single quantity the objective, the drawdown ceiling and every
 * ratio below are measured from.
 */
export function equityCents(state: TradingState): number {
  return state.cash + investedCents(state);
}

/** Open profit or loss on the held positions, in cents. May be negative. */
export function unrealizedPnlCents(state: TradingState): number {
  return state.positions.reduce((total, position) => {
    if (position.quantity === 0) return total;
    return (
      total + position.quantity * (priceOf(state, position.asset) - position.averageEntryPrice)
    );
  }, 0);
}

/** Equity gain above the run's own starting capital, in whole dollars. */
export function gainDollars(state: TradingState): number {
  return Math.floor((equityCents(state) - state.initialCapital) / 100);
}

/** Total return on the starting capital, in basis points. May be negative. */
export function totalReturnBps(state: TradingState): number {
  return ratioBps(equityCents(state) - state.initialCapital, state.initialCapital);
}

/** Invested value as a share of equity, in basis points. */
export function exposureBps(state: TradingState): number {
  return ratioBps(investedCents(state), equityCents(state));
}

/** One holding's share of equity, in basis points. */
export function concentrationBps(state: TradingState, asset: SimulationAsset): number {
  return ratioBps(positionValueCents(state, asset), equityCents(state));
}

/** The largest single-position share of equity, in basis points. */
export function peakConcentrationBps(state: TradingState): number {
  return state.positions.reduce(
    (worst, position) => Math.max(worst, concentrationBps(state, position.asset)),
    0,
  );
}

/**
 * How far equity has fallen from its own high-water mark, in basis points.
 *
 * Measured from the peak the state carries rather than from the starting
 * capital, because a portfolio that rose and then gave the gain back has
 * drawn down — reading it from the start would call that flat.
 */
export function drawdownBps(state: TradingState): number {
  if (state.peakEquity <= 0) return 0;
  const fall = state.peakEquity - equityCents(state);
  return fall <= 0 ? 0 : ratioBps(fall, state.peakEquity);
}

/**
 * Drawdown expressed in the risk points the run is scored and terminated on:
 * whole percent of peak-to-trough fall, rounded down.
 *
 * Flooring is deliberate. The ceiling is a cliff — reaching it ends the run — so
 * a fall of 7.9% must read as 7, not as 8.
 */
export function drawdownRiskPoints(state: TradingState): number {
  return Math.floor(drawdownBps(state) / DRAWDOWN_BPS_PER_POINT);
}

/** The peak equity a state should carry forward: the higher of its own and `equity`. */
export function nextPeakEquity(currentPeak: number, equity: number): number {
  return Math.max(currentPeak, equity);
}

/**
 * Integer cents rendered as dollars, exactly.
 *
 * The money module owns the one way a cent amount becomes text, so no caller
 * divides by 100 and hopes `toFixed` rounds the way the integer would have.
 * Grouped in threes: the amounts quoted here are portfolio values, and the
 * benchmark publishes itself as the "$10K Trading Challenge", so `$10,000.00`
 * is the spelling a reader is expecting.
 *
 * String surgery on an integer. No floating point is introduced, so the text
 * cannot disagree with the number it came from.
 */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const grouped = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${grouped}.${String(abs % 100).padStart(2, '0')}`;
}

/** A one-line description of the portfolio, for the environment's own trace. */
export function describePortfolio(state: TradingState): string {
  const held = state.positions.filter((position) => position.quantity > 0);
  const equity = formatCents(equityCents(state));
  if (held.length === 0) return `Holding no positions; equity ${equity}.`;
  const parts = held.map(
    (position) =>
      `${position.quantity} ${position.asset} @ ${formatCents(position.averageEntryPrice)}`,
  );
  return `Holding ${parts.join(', ')}; equity ${equity}.`;
}
