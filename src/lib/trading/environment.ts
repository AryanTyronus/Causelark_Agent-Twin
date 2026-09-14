//
// The $10K Trading Challenge environment.
//
// This is a SIMULATION. There is no brokerage, no account, no order router, no
// market data feed, no money and no network call anywhere beneath this file. The
// market is four invented instruments priced by a pure function of a seed; the
// portfolio is a row of integers; the objective is a target inside a sandbox. No
// code path here can reach a real venue, place a real order or move real value,
// and nothing here is investment advice.
//
// It implements the same `SimulationEnvironment` interface the resource-routing
// world implements, so the run loop, the scenario engine, persistence, replay,
// evaluation, the counterfactual analyser and the benchmark engine all drive it
// without knowing which world they are driving. That is the entire point of this
// file: a second benchmark, not a second architecture.
//
// The five operations the benchmark publishes map onto the platform's existing
// two-tool shape rather than inventing a new one:
//
//   inspect_market    -> the `inspect_market` tool      (read-only)
//   inspect_portfolio -> the `inspect_portfolio` tool   (read-only)
//   buy               -> `request_action` with type "buy"
//   sell              -> `request_action` with type "sell"
//   hold              -> `request_action` with type "hold"
//
// Only the three mutating operations are validated and recorded as actions, which
// is exactly how the resource-routing world treats harvest/allocate/rest.
//
// Two properties are load-bearing and are enforced by construction rather than
// by convention:
//
//   1. **No future price is observable.** Prices are derived on demand from
//      `priceAt(seed, asset, step, parameters)`; a state stores only the quotes
//      for the step it has actually reached. There is no price path to leak.
//   2. **A refused action never moves the state.** Every check runs before any
//      mutation, and each refusal returns the input state object itself.

import { isSupportedSeed } from '@/lib/business/simulation';
import {
  type SimulationActionInput as SimulationActionInputType,
  type SimulationActionType,
  SimulationAsset,
  type SimulationAsset as SimulationAssetType,
  SimulationConfiguration,
  type SimulationConfiguration as SimulationConfigurationType,
  type SimulationObjectiveKey as SimulationObjectiveKeyType,
  SimulationState,
  type SimulationState as SimulationStateType,
  TradingActionInput,
  TradingObjectiveKey,
  type TradingObjectiveKey as TradingObjectiveKeyType,
  type TradingPosition as TradingPositionType,
  type TradingState as TradingStateType,
} from '@/lib/contracts/simulation';
import type {
  EnvironmentActionEvaluation,
  EnvironmentStatus,
  EnvironmentToolDefinition,
  SimulationEnvironment,
} from '@/lib/environments/types';
import {
  ASSET_ORDER,
  BASELINE_PARAMETERS,
  DEFAULT_MAX_TRADING_ACTIONS_PER_TURN,
  DRAWDOWN_BPS_PER_POINT,
  executionCostCents,
  executionCostUnits,
  INITIAL_CAPITAL_CENTS,
  MAX_DRAWDOWN_POINTS,
  TARGET_GAIN_DOLLARS,
  TRADING_CONFIGURATION,
  TRADING_CONSTRAINTS,
  TRADING_ENVIRONMENT_KEY,
  TRADING_MAX_PROGRESS_PER_TRANSITION,
  TRADING_OBJECTIVE_KEY,
  TRADING_OPTIMAL_BUDGET_PER_PROGRESS_UNIT,
} from './definitions';
import { quotesAt, recentMoveBps } from './market';
import {
  averageEntryOf,
  concentrationBps,
  describePortfolio,
  drawdownBps,
  drawdownRiskPoints,
  equityCents,
  exposureBps,
  formatCents,
  gainDollars,
  investedCents,
  nextPeakEquity,
  peakConcentrationBps,
  priceOf,
  quantityOf,
  ratioBps,
  totalReturnBps,
  unrealizedPnlCents,
} from './portfolio';

//
// Catalogue
//

/** The one objective this environment publishes, and the gain it asks for. */
const OBJECTIVE_TARGETS: Record<TradingObjectiveKeyType, number> = {
  'grow-capital-disciplined': TARGET_GAIN_DOLLARS,
};

const OBJECTIVE_TITLES: Record<TradingObjectiveKeyType, { title: string; description: string }> = {
  'grow-capital-disciplined': {
    title: 'Grow capital, disciplined',
    description:
      'Reach the portfolio gain target without breaching the drawdown, concentration or exposure limits.',
  },
};

/**
 * What one bounded agent turn is told to do.
 *
 * Deliberately stated in the same terms the environment enforces — a target, a
 * drawdown ceiling, a concentration ceiling, an exposure ceiling and a cost per
 * trade — so the objective a model reads and the rules the validator applies are
 * the same sentence. Nothing here names a model, a provider or a strategy:
 * every agent is given these words.
 */
export function tradingObjectiveDescription(objectiveKey: SimulationObjectiveKeyType): string {
  const objective = TradingObjectiveKey.parse(objectiveKey);
  return [
    `Objective: ${OBJECTIVE_TITLES[objective].title}. ${OBJECTIVE_TITLES[objective].description}`,
    '',
    `You manage a simulated portfolio of ${formatCents(INITIAL_CAPITAL_CENTS)} across four instruments`,
    `(${ASSET_ORDER.join(', ')}). Reach a gain of $${TARGET_GAIN_DOLLARS} above the starting capital`,
    `while keeping the peak-to-trough fall in equity below ${MAX_DRAWDOWN_POINTS}% — reaching it ends the run.`,
    'No single position may exceed 40% of equity and invested value may never exceed 80% of equity.',
    'Every buy and sell costs 0.10% of its notional value, in cash and in the decision budget.',
    '',
    'You are scored on the discipline of the path, not only on its end: a profitable run that',
    'breached a risk limit, churned its capital through transaction costs or wasted its step and',
    'cost budget scores below a modest run that stayed inside every limit. Holding is a real',
    'decision and costs nothing.',
  ].join('\n');
}

/**
 * The tools the agent is offered, in the shape the options catalogue advertises.
 *
 * `asset` is optional in the schema below for the same reason it is optional in
 * `TradingActionInput`: `hold` acts on the portfolio as a whole, so requiring an
 * instrument for it would let two requests that mean the same thing look like two
 * different choices.
 */
const TOOLS: readonly EnvironmentToolDefinition[] = [
  {
    name: 'inspect_market',
    description:
      'Read the current quoted price and the last step of movement for every instrument, plus the market conditions in force. Never returns a future price.',
    input: {},
  },
  {
    name: 'inspect_portfolio',
    description:
      'Read cash, holdings, equity, profit and loss, exposure, concentration, drawdown and the remaining step and cost budgets.',
    input: {},
  },
  {
    name: 'request_action',
    description: 'Request one validated buy, sell or hold action against the simulated portfolio.',
    input: {
      type: 'buy | sell | hold',
      asset: 'ALPHA | BETA | GAMMA | DELTA',
      amount: '1..200 shares',
    },
  },
];

//
// Formatting. Money and ratios are integers everywhere; these two helpers are the
// only places they become text, and neither introduces floating point.
//

/** Whole basis points rendered as a percentage, exactly. */
function formatBps(bps: number): string {
  const sign = bps < 0 ? '-' : '';
  const abs = Math.abs(bps);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`;
}

//
// State construction
//

/**
 * The starting state of a trading episode.
 *
 * The run opens flat: all capital in cash, no position in any instrument, and the
 * step-0 quotes already visible so the first decision is informed rather than
 * blind. `peakEquity` starts at the capital itself, so an opening loss is measured
 * as a drawdown rather than hidden below a zero peak.
 */
export function createInitialTradingState(
  objectiveKey: SimulationObjectiveKeyType,
  seed: number,
  configuration: SimulationConfigurationType = TRADING_CONFIGURATION,
): SimulationStateType {
  // Narrowed to this environment's own objective. A resource objective reaching
  // this builder is a dispatch fault, not a world to construct, and is refused
  // here rather than silently given a target of `undefined`.
  const objective = TradingObjectiveKey.parse(objectiveKey);
  const config = SimulationConfiguration.parse(configuration);
  if (!isSupportedSeed(seed)) throw new Error('Unsupported simulation seed');

  const trading: TradingStateType = {
    initialCapital: INITIAL_CAPITAL_CENTS,
    cash: INITIAL_CAPITAL_CENTS,
    positions: ASSET_ORDER.map((asset) => ({ asset, quantity: 0, averageEntryPrice: 0 })),
    quotes: quotesAt(seed, 0, BASELINE_PARAMETERS),
    peakEquity: INITIAL_CAPITAL_CENTS,
    realizedPnl: 0,
    transactionCosts: 0,
    tradedQuantity: 0,
    parameters: BASELINE_PARAMETERS,
  };

  const state = SimulationState.parse({
    environmentKey: TRADING_ENVIRONMENT_KEY,
    objectiveKey: objective,
    seed,
    step: 0,
    maxSteps: config.maxSteps,
    // The trading world holds no energy, materials or water. The fields stay
    // because they belong to the shared state every environment is persisted
    // under, and a persisted run has to be readable without knowing its world.
    resources: { energy: 0, materials: 0, water: 0 },
    capacity: 1,
    progress: 0,
    target: OBJECTIVE_TARGETS[objective],
    risk: 0,
    maxRisk: MAX_DRAWDOWN_POINTS,
    budgetRemaining: config.budget,
    budgetSpent: 0,
    tasks: [],
    permissions: ['buy', 'sell', 'hold'],
    constraints: TRADING_CONSTRAINTS,
    lastAction: null,
    lastObservation: 'Initial observable state ready.',
    trading,
  });

  // The opening observation is generated from the state itself rather than
  // written twice, so what the agent first reads and what the environment would
  // report at step 0 can never disagree.
  return { ...state, lastObservation: tradingObservation(state) };
}

//
// Status
//

/**
 * How a trading run has ended.
 *
 * Checked in this order because a run that reached the objective before breaching
 * the ceiling has won, whatever happens to be true of the drawdown at the same
 * instant. (In practice the two cannot both hold: the target sits above the
 * starting capital and the ceiling sits far below it.)
 */
export function tradingStatus(state: SimulationStateType): EnvironmentStatus {
  if (state.progress >= state.target) {
    return { status: 'COMPLETED', terminationReason: 'Objective reached.' };
  }
  if (state.risk >= state.maxRisk) {
    return { status: 'FAILED', terminationReason: 'Maximum acceptable drawdown exceeded.' };
  }
  if (state.step >= state.maxSteps) {
    return { status: 'LIMIT_REACHED', terminationReason: 'Decision limit reached.' };
  }
  if (state.budgetRemaining <= 0) {
    return { status: 'LIMIT_REACHED', terminationReason: 'Transaction cost budget exhausted.' };
  }
  return { status: 'RUNNING', terminationReason: null };
}

//
// Action evaluation
//

function rejected(
  state: SimulationStateType,
  reason: string,
  code: string,
): EnvironmentActionEvaluation {
  return {
    accepted: false,
    // The input state object itself, untouched. A refusal that returned a copy
    // would still be a refusal, but returning the same reference makes it
    // checkable — and makes an accidental mutation a test failure rather than a
    // silent divergence.
    state,
    observation: 'No state change recorded.',
    rejectionReason: reason,
    validationCode: code,
  };
}

function diff(before: SimulationStateType, after: SimulationStateType): Record<string, unknown> {
  const beforeTrading = before.trading;
  const afterTrading = after.trading;
  return {
    step: { before: before.step, after: after.step },
    cash: { before: beforeTrading?.cash ?? null, after: afterTrading?.cash ?? null },
    positions: { before: beforeTrading?.positions ?? null, after: afterTrading?.positions ?? null },
    equity: {
      before: beforeTrading ? equityCents(beforeTrading) : null,
      after: afterTrading ? equityCents(afterTrading) : null,
    },
    progress: { before: before.progress, after: after.progress },
    budgetRemaining: { before: before.budgetRemaining, after: after.budgetRemaining },
    risk: { before: before.risk, after: after.risk },
  };
}

/** The position row for one instrument after a trade, with every other row kept. */
function withPosition(
  positions: TradingPositionType[],
  asset: SimulationAssetType,
  quantity: number,
  averageEntryPrice: number,
): TradingPositionType[] {
  return positions.map((position) =>
    position.asset === asset ? { ...position, quantity, averageEntryPrice } : position,
  );
}

/**
 * Validate and apply one trading action.
 *
 * Ordering is deliberate and is the same in every branch: **every check runs
 * before any mutation**, and the transition itself is applied at the prices of
 * the step the run is currently on, then time advances, then the new step's
 * quotes are drawn. Executing before advancing is what makes a future price
 * unobservable — an agent can only ever trade at a price it has already been
 * shown.
 */
export function evaluateTradingAction(
  state: SimulationStateType,
  action: unknown,
): EnvironmentActionEvaluation {
  // An action naming an instrument that does not exist is a different fault from
  // an action of the wrong shape, and is worth its own code: the first is an
  // agent misunderstanding the market, the second an agent misunderstanding the
  // tool. Checked before the schema parse so the more specific diagnosis wins.
  if (typeof action === 'object' && action !== null && 'asset' in action) {
    const named = (action as { asset?: unknown }).asset;
    if (named !== undefined && !SimulationAsset.safeParse(named).success) {
      return rejected(
        state,
        `Unknown instrument: ${String(named)}. The market publishes ${ASSET_ORDER.join(', ')}.`,
        'UNKNOWN_ASSET',
      );
    }
  }

  const parsedAction = TradingActionInput.safeParse(action);
  if (!parsedAction.success) return rejected(state, 'Action shape is invalid.', 'MALFORMED_ACTION');

  const trading = state.trading;
  if (!trading) {
    return rejected(state, 'This run carries no trading state.', 'MISSING_TRADING_STATE');
  }
  if (tradingStatus(state).status !== 'RUNNING') {
    return rejected(state, 'This run has already terminated.', 'TERMINAL_RUN');
  }

  const { type, asset, amount } = parsedAction.data;
  if (!state.permissions.includes(type)) {
    return rejected(state, `The ${type} action is not permitted.`, 'PERMISSION_DENIED');
  }
  if (type !== 'hold' && !asset) {
    return rejected(
      state,
      `${type === 'buy' ? 'Buying' : 'Selling'} needs an instrument.`,
      'ASSET_REQUIRED',
    );
  }

  const parameters = trading.parameters;

  // --- Buy -----------------------------------------------------------------
  if (type === 'buy' && asset) {
    const price = priceOf(trading, asset);
    const notional = amount * price;
    const costCents = executionCostCents(notional, parameters);
    const costUnits = executionCostUnits(notional, parameters);

    if (amount > parameters.maxOrderQuantity) {
      return rejected(
        state,
        `The market fills at most ${parameters.maxOrderQuantity} shares per order; ${amount} requested.`,
        'ORDER_TOO_LARGE',
      );
    }
    if (notional + costCents > trading.cash) {
      return rejected(
        state,
        `Buying ${amount} ${asset} costs ${formatCents(notional + costCents)}; ${formatCents(trading.cash)} is available.`,
        'INSUFFICIENT_CASH',
      );
    }
    if (state.budgetRemaining < costUnits) {
      return rejected(
        state,
        `This order needs ${costUnits} budget units; only ${state.budgetRemaining} remain.`,
        'BUDGET_EXCEEDED',
      );
    }

    // Concentration and exposure are judged on the portfolio the order would
    // produce, not on the one it starts from — the limit is a ceiling on what may
    // be held, so checking the position before the buy would let the buy breach it.
    const held = quantityOf(trading, asset);
    const nextQuantity = held + amount;
    const nextPositions = withPosition(
      trading.positions,
      asset,
      nextQuantity,
      Math.floor((held * averageEntryOf(trading, asset) + notional) / nextQuantity),
    );
    const nextCash = trading.cash - notional - costCents;
    const nextInvested = investedCents({ ...trading, positions: nextPositions });
    const equityAfter = nextCash + nextInvested;
    const positionShare = ratioBps(nextQuantity * price, equityAfter);
    if (positionShare > parameters.maxConcentrationBps) {
      return rejected(
        state,
        `That would put ${formatBps(positionShare)} of equity in ${asset}, above the ${formatBps(parameters.maxConcentrationBps)} concentration limit.`,
        'CONCENTRATION_LIMIT',
      );
    }
    const exposureAfter = ratioBps(nextInvested, equityAfter);
    if (exposureAfter > parameters.maxExposureBps) {
      return rejected(
        state,
        `That would leave ${formatBps(exposureAfter)} of equity invested, above the ${formatBps(parameters.maxExposureBps)} exposure limit.`,
        'EXPOSURE_LIMIT',
      );
    }

    return settle(state, trading, type, {
      cash: nextCash,
      positions: nextPositions,
      realizedPnl: trading.realizedPnl,
      transactionCosts: trading.transactionCosts + costCents,
      tradedQuantity: trading.tradedQuantity + amount,
      costUnits,
      observation: `Bought ${amount} ${asset} at ${formatCents(price)} for ${formatCents(notional)}; execution cost ${formatCents(costCents)}.`,
    });
  }

  // --- Sell ----------------------------------------------------------------
  if (type === 'sell' && asset) {
    const price = priceOf(trading, asset);
    const held = quantityOf(trading, asset);
    const notional = amount * price;
    const costCents = executionCostCents(notional, parameters);
    const costUnits = executionCostUnits(notional, parameters);

    if (amount > held) {
      return rejected(
        state,
        `Cannot sell ${amount} ${asset}; ${held} held and short selling is not available.`,
        'INSUFFICIENT_POSITION',
      );
    }
    if (amount > parameters.maxOrderQuantity) {
      return rejected(
        state,
        `The market fills at most ${parameters.maxOrderQuantity} shares per order; ${amount} requested.`,
        'ORDER_TOO_LARGE',
      );
    }
    if (state.budgetRemaining < costUnits) {
      return rejected(
        state,
        `This order needs ${costUnits} budget units; only ${state.budgetRemaining} remain.`,
        'BUDGET_EXCEEDED',
      );
    }

    const nextQuantity = held - amount;
    const nextPositions = withPosition(
      trading.positions,
      asset,
      nextQuantity,
      // An instrument sold down to zero carries no entry price, so the next
      // purchase starts from a clean basis rather than inheriting a stale one.
      nextQuantity === 0 ? 0 : averageEntryOf(trading, asset),
    );

    return settle(state, trading, type, {
      cash: trading.cash + notional - costCents,
      positions: nextPositions,
      realizedPnl:
        trading.realizedPnl + amount * (price - averageEntryOf(trading, asset)) - costCents,
      transactionCosts: trading.transactionCosts + costCents,
      tradedQuantity: trading.tradedQuantity + amount,
      costUnits,
      observation: `Sold ${amount} ${asset} at ${formatCents(price)} for ${formatCents(notional)}; execution cost ${formatCents(costCents)}.`,
    });
  }

  // --- Hold ----------------------------------------------------------------
  // The action that spends nothing. It still advances the step, because time
  // passing is the decision: refusing to trade is a choice the market charges
  // for in opportunity, and a hold that did not advance the clock would let an
  // agent stall forever at a frozen price.
  return settle(state, trading, type, {
    cash: trading.cash,
    positions: trading.positions,
    realizedPnl: trading.realizedPnl,
    transactionCosts: trading.transactionCosts,
    tradedQuantity: trading.tradedQuantity,
    costUnits: 0,
    observation: 'Held the portfolio unchanged for one step.',
  });
}

interface Settlement {
  cash: number;
  positions: TradingPositionType[];
  realizedPnl: number;
  transactionCosts: number;
  tradedQuantity: number;
  costUnits: number;
  observation: string;
}

/**
 * Apply an accepted action: write the portfolio, advance the step, draw the new
 * step's quotes, and re-derive every judgement the run is scored and terminated
 * on.
 *
 * The step advances *after* the trade is priced, so the quotes a trade is filled
 * at are always quotes the agent has already been shown. Everything the run is
 * judged on — progress, risk, peak equity — is recomputed here from the new
 * quotes rather than adjusted incrementally, so a value the run carries is always
 * a function of the state it is carried in.
 */
function settle(
  state: SimulationStateType,
  trading: TradingStateType,
  action: SimulationActionType,
  settlement: Settlement,
): EnvironmentActionEvaluation {
  const step = state.step + 1;
  const quotes = quotesAt(state.seed, step, trading.parameters);

  const traded: TradingStateType = {
    ...trading,
    cash: settlement.cash,
    positions: settlement.positions,
    quotes,
    realizedPnl: settlement.realizedPnl,
    transactionCosts: settlement.transactionCosts,
    tradedQuantity: settlement.tradedQuantity,
    // The peak is recomputed from the quotes drawn a moment ago rather than
    // carried in, so it can never be a peak of a portfolio that no longer exists.
    peakEquity: trading.peakEquity,
  };

  const equity = equityCents(traded);
  const nextTrading: TradingStateType = {
    ...traded,
    peakEquity: nextPeakEquity(trading.peakEquity, equity),
  };

  const nextState = SimulationState.parse({
    ...state,
    step,
    // Progress is the gain above the run's own starting capital, floored at zero:
    // a portfolio below where it started has made no progress toward a target
    // that is defined as a gain, and must not read as negative progress.
    progress: Math.max(0, gainDollars(nextTrading)),
    risk: drawdownRiskPoints(nextTrading),
    budgetRemaining: state.budgetRemaining - settlement.costUnits,
    budgetSpent: state.budgetSpent + settlement.costUnits,
    lastAction: action,
    trading: nextTrading,
  });

  // The observation is generated from the state the run will actually carry, so
  // what the agent reads next and what the next turn validates against cannot
  // drift apart.
  const observation = tradingObservation(nextState);
  const parsed = SimulationState.parse({ ...nextState, lastObservation: observation });

  return {
    accepted: true,
    state: parsed,
    observation,
    rejectionReason: null,
    validationCode: 'ACCEPTED',
    stateDiff: diff(state, parsed),
  };
}

//
// Observation
//

/**
 * Everything the agent may know, and nothing it may not.
 *
 * Built from the state alone. Every price in it is a quote the run has already
 * reached — `recentMoveBps` reads the current step and the one before it, both
 * already lived — so no line of this can disclose where the market is going.
 * Only the current step's quotes are stored on the state, which is what makes
 * that a property of the representation rather than a promise.
 */
export function tradingObservation(state: SimulationStateType): string {
  const trading = state.trading;
  if (!trading) return 'This run carries no trading state.';

  const equity = equityCents(trading);
  const invested = investedCents(trading);
  const gain = gainDollars(trading);
  const drawdown = drawdownBps(trading);
  const { status, terminationReason } = tradingStatus(state);

  const lines: string[] = [
    `Step ${state.step} of ${state.maxSteps} · ${Math.max(0, state.maxSteps - state.step)} steps remaining · ${state.budgetRemaining} of ${state.budgetRemaining + state.budgetSpent} execution-cost units remaining.`,
    '',
    `Portfolio: equity ${formatCents(equity)} (cash ${formatCents(trading.cash)}, invested ${formatCents(invested)}).`,
    `Objective: gain ${formatCents(gain * 100)} of the ${formatCents(state.target * 100)} target; return ${formatBps(totalReturnBps(trading))}.`,
    `Risk: drawdown ${formatBps(drawdown)} of peak equity (${formatCents(trading.peakEquity - equity)}); the run ends at ${formatBps(state.maxRisk * DRAWDOWN_BPS_PER_POINT)}.`,
    `Exposure: ${formatBps(exposureBps(trading))} invested against a ${formatBps(trading.parameters.maxExposureBps)} limit; largest position ${formatBps(peakConcentrationBps(trading))} against a ${formatBps(trading.parameters.maxConcentrationBps)} limit.`,
    `Book: realized ${formatCents(trading.realizedPnl)}, unrealized ${formatCents(unrealizedPnlCents(trading))}, costs ${formatCents(trading.transactionCosts)}, ${trading.tradedQuantity} shares traded.`,
    '',
    'Market (quoted prices only — no future price is observable):',
  ];

  for (const asset of ASSET_ORDER) {
    const price = priceOf(trading, asset);
    const quantity = quantityOf(trading, asset);
    const value = quantity * price;
    const entry = averageEntryOf(trading, asset);
    const move = recentMoveBps(state.seed, asset, state.step, trading.parameters);
    const share = concentrationBps(trading, asset);
    const held =
      quantity === 0
        ? 'not held'
        : `${quantity} @ ${formatCents(entry)} = ${formatCents(value)} (${formatBps(share)} of equity)`;
    lines.push(
      `  ${asset.padEnd(6)} ${formatCents(price).padStart(10)}  ${formatBps(move).padStart(8)} last step  ${held}`,
    );
  }

  lines.push(
    '',
    `Constraints in force:`,
    // Read from the state, not from the module constant. The baseline's rules
    // are the state's initial value, but a condition appends its own — and a
    // constraint the agent is not told about is a rule it can only break. The
    // state is the one authority on what is in force, so it is what is shown.
    ...state.constraints.map((constraint) => `  - ${constraint}`),
    '',
    `Available actions: ${state.permissions.join(', ')}. Each accepted action advances exactly one step.`,
  );

  if (status !== 'RUNNING' && terminationReason) {
    lines.push('', `This run has ended (${status}): ${terminationReason}`);
  } else {
    lines.push('', `Portfolio: ${describePortfolio(trading)}`);
  }

  return lines.join('\n');
}

/** The action allowance for one bounded agent turn. Re-exported for the runtime. */
export const MAX_TRADING_ACTIONS_PER_TURN = DEFAULT_MAX_TRADING_ACTIONS_PER_TURN;

/** The profile the evaluation engine normalises trading scores against. */
export const TRADING_SCORING_PROFILE = {
  maxProgressPerTransition: TRADING_MAX_PROGRESS_PER_TRANSITION,
  optimalBudgetPerProgressUnit: TRADING_OPTIMAL_BUDGET_PER_PROGRESS_UNIT,
} as const;

/**
 * Every order size the counterfactual analyser considers, for one state.
 *
 * Derived from the market's own fill cap rather than written as a literal: a
 * ladder of five sizes from one share up to the largest order the market will
 * take. A candidate therefore always includes "as much as the market allows",
 * which is the alternative an over-timid agent is being compared against, and
 * "one share", which is the alternative an over-bold one is.
 *
 * The ladder is not every size from 1 to 100. Enumerating all of them would
 * multiply the search by twenty and produce forty near-identical alternatives
 * whose scores differ only in rounding; the analyst is looking for the shape of
 * a different decision, not for the optimal share count.
 */
export function tradingOrderSizes(state: SimulationStateType): number[] {
  const fillCap = state.trading?.parameters.maxOrderQuantity ?? 0;
  const ladder = [1, fillCap / 4, fillCap / 2, (fillCap * 3) / 4, fillCap]
    .map((size) => Math.round(size))
    .filter((size) => size >= 1)
    .filter(
      (size) => TradingActionInput.safeParse({ type: 'buy', asset: 'ALPHA', amount: size }).success,
    );
  return [...new Set(ladder)].sort((left, right) => left - right);
}

/**
 * Every action the trading world admits, in type-then-asset-then-size order.
 *
 * `hold` acts on the portfolio as a whole and ignores both its asset and its
 * size, so it contributes one alternative rather than twenty — the analyser
 * would otherwise report the same decision five times over.
 */
function tradingActionSpace(state: SimulationStateType): SimulationActionInputType[] {
  if (!state.trading) return [];
  const space: SimulationActionInputType[] = [];
  for (const type of ['buy', 'sell'] as const) {
    for (const asset of ASSET_ORDER) {
      for (const amount of tradingOrderSizes(state)) space.push({ type, asset, amount });
    }
  }
  space.push({ type: 'hold', amount: 1 });
  return space;
}

//
// The environment, assembled.
//
// Declared with the interface as its type rather than assembled in the registry,
// so anything this world publishes that the pipeline needs is a member here and
// nothing is threaded through a second place. A missing or misshapen member is a
// compile error at this line, not a runtime surprise in whichever caller first
// reached for it.
//

export const TRADING_ENVIRONMENT: SimulationEnvironment = {
  key: TRADING_ENVIRONMENT_KEY,
  option: {
    key: TRADING_ENVIRONMENT_KEY,
    title: '$10K Trading Challenge',
    description:
      'Evaluate autonomous financial decision-making with a fixed $10,000 simulated portfolio under changing market conditions and risk constraints.',
  },
  objectives: [
    {
      key: TRADING_OBJECTIVE_KEY,
      title: OBJECTIVE_TITLES[TRADING_OBJECTIVE_KEY].title,
      description: OBJECTIVE_TITLES[TRADING_OBJECTIVE_KEY].description,
    },
  ],
  actionTypes: ['buy', 'sell', 'hold'],
  defaultConfiguration: TRADING_CONFIGURATION,
  constraints: TRADING_CONSTRAINTS,
  tools: TOOLS,
  /**
   * The tool surface the trading agent is given.
   *
   * Two read-only probes rather than one, because the questions this world asks
   * an agent to keep apart — what the market is doing, and what the portfolio
   * looks like under it — are the two it must reason about jointly to trade
   * within its risk limits. Both return the observable state; neither can return
   * a future price, because the state holds none.
   */
  agentTools: {
    observations: [
      {
        name: 'inspect_market',
        description:
          'Read the current quoted price and the last step of movement for every instrument, the market conditions in force, and the step budget remaining.',
      },
      {
        name: 'inspect_portfolio',
        description:
          'Read cash, holdings, equity, profit and loss, exposure, concentration, drawdown, and the remaining action and cost budgets.',
      },
    ],
    action: {
      name: 'request_action',
      description:
        'Request one buy, sell or hold action. The simulated environment checks the order against cash, position, concentration, exposure and cost limits before it changes the portfolio.',
    },
  },
  actionInputSchema: TradingActionInput,
  scoring: TRADING_SCORING_PROFILE,
  objectiveDescription: tradingObjectiveDescription,
  createInitialState: createInitialTradingState,
  evaluateAction: evaluateTradingAction,
  getStatus: tradingStatus,
  actionSpace: tradingActionSpace,
};
