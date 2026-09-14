//
// The $10K Trading Challenge, as one import.
//
// A barrel, and nothing more: it re-exports the environment, the market model,
// the portfolio arithmetic and the constants, so a caller that needs two of them
// does not have to know how the module happens to be split into files. The split
// is by kind of question — what the world costs and forbids (definitions), where
// prices come from (market), what the portfolio is worth (portfolio), and what
// happens when an agent acts (environment) — and callers should not have to
// reconstruct it.
//
// Everything reachable from here is a pure function of its arguments. No clock,
// no randomness, no network, no database, no brokerage, no money: this is a
// simulation, and the only thing it can change is the state of a run.

export {
  ASSET_ORDER,
  BASE_PRICE_CENTS,
  BASELINE_PARAMETERS,
  COST_UNIT_CENTS,
  DEFAULT_MAX_TRADING_ACTIONS_PER_TURN,
  DRAWDOWN_BPS_PER_POINT,
  executionCostCents,
  executionCostUnits,
  INITIAL_CAPITAL_CENTS,
  MAX_DRAWDOWN_POINTS,
  MIN_PRICE_CENTS,
  TARGET_GAIN_DOLLARS,
  TRADING_CONFIGURATION,
  TRADING_CONSTRAINTS,
  TRADING_MAX_PROGRESS_PER_TRANSITION,
  TRADING_OBJECTIVE_KEY,
  TRADING_OPTIMAL_BUDGET_PER_PROGRESS_UNIT,
  TRADING_STEP_CEILING_BPS,
} from './definitions';
export {
  createInitialTradingState,
  evaluateTradingAction,
  MAX_TRADING_ACTIONS_PER_TURN,
  TRADING_ENVIRONMENT,
  TRADING_SCORING_PROFILE,
  tradingObjectiveDescription,
  tradingObservation,
  tradingStatus,
} from './environment';
export {
  basePrice,
  moveNoisePermille,
  priceAt,
  quotesAt,
  recentMoveBps,
  stepMoveBps,
} from './market';
export {
  averageEntryOf,
  concentrationBps,
  describePortfolio,
  drawdownBps,
  drawdownRiskPoints,
  equityCents,
  exposureBps,
  gainDollars,
  investedCents,
  nextPeakEquity,
  peakConcentrationBps,
  positionValueCents,
  priceOf,
  quantityOf,
  ratioBps,
  totalReturnBps,
  unrealizedPnlCents,
} from './portfolio';
