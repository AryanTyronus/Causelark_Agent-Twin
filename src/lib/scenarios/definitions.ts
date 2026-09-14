//
// Definitions are data: an id, a name, a description, a version, and a list of
// modifiers. Nothing here branches, loops over external input, or reaches a
// clock — so the catalogue is the same on every process start and a scenario id
// can only ever resolve to one of these.
//
// Every magnitude below is a named constant tied to a constraint the environment
// already publishes, rather than a number chosen for effect. Where a reduction
// can be derived from the environment (`getSimulationOptions()`), it is derived,
// so the scenarios follow the environment if its starting stock changes.

import { DEFAULT_CONFIGURATION, getSimulationOptions } from '@/lib/business/simulation';
import type { SimulationAsset, SimulationResource } from '@/lib/contracts/simulation';
import {
  BASELINE_PARAMETERS,
  TRADING_CONFIGURATION,
  TRADING_ENVIRONMENT_KEY,
} from '@/lib/trading/definitions';
import { MIN_SCENARIO_DRIFT_BPS, type Scenario, ScenarioError } from './types';

export const BASELINE_SCENARIO_ID = 'baseline';

/** Lowest starting stock the environment seeds for a resource. */
function startingMinimum(resource: SimulationResource): number {
  const definition = getSimulationOptions().resources.find((item) => item.key === resource);
  if (!definition)
    throw new ScenarioError(
      'INVALID_SCENARIO',
      `The environment publishes no starting stock for ${resource}.`,
    );
  return definition.startingRange[0];
}

/**
 * Scarcity removes half of each resource's *lowest* seeded starting stock. Half
 * of the minimum is the largest reduction that can never reach zero on any
 * supported seed, so scarcity is a squeeze rather than an outage — `resource-
 * outage` is the scenario that takes a resource away outright.
 */
export const SCARCITY_ENERGY_REDUCTION = Math.floor(startingMinimum('energy') / 2);
export const SCARCITY_MATERIALS_REDUCTION = Math.floor(startingMinimum('materials') / 2);
export const SCARCITY_WATER_REDUCTION = Math.floor(startingMinimum('water') / 2);
export const SCARCITY_RESOURCE_FLOOR = 1;

/** The water outage: the stock the environment's model represents it as. */
export const OUTAGE_RESOURCE: SimulationResource = 'water';
export const OUTAGE_LEVEL = 0;
export const OUTAGE_CONSTRAINT =
  'Water is offline: allocations from water are refused until the outage clears.';

/**
 * Budget pressure removes this share of the default budget, leaving 14 of 24.
 * Routing one unit of resource into one unit of progress costs one budget unit,
 * so the remaining budget still covers the most expensive objective target (10)
 * with slack — the scenario removes the room for error, not the objective.
 */
export const BUDGET_PRESSURE_SHARE = 0.4;
export const BUDGET_PRESSURE_REDUCTION = Math.round(
  DEFAULT_CONFIGURATION.budget * BUDGET_PRESSURE_SHARE,
);

/**
 * Elevated risk starts the run three points closer to the failure threshold of
 * 8, from a seeded 1–3. That consumes roughly half the available margin, which
 * is the point: the agent has to operate with less room to be wrong. The
 * scenario is validated to never reach the threshold itself.
 */
export const ELEVATED_RISK_INCREASE = 3;

/**
 * Half the default decision budget. Each accepted transition can advance the
 * objective by up to five, so six steps still leave the objective reachable —
 * what the scenario removes is the budget for exploring.
 */
export const TIGHT_STEP_LIMIT_REDUCTION = Math.floor(DEFAULT_CONFIGURATION.maxSteps / 2);

/**
 * Recovery is the action revoked. It is the only way the environment lets a run
 * put energy back, so revoking it through the permission list makes the refusal
 * a genuine `PERMISSION_DENIED` from the existing validator — no scenario-aware
 * branch anywhere in the environment.
 */
export const REJECTED_ACTION_TYPE = 'rest';
export const REJECTED_ACTION_CONSTRAINT =
  'Recovery actions are suspended by operating policy: energy cannot be recovered.';

//
// The seven trading conditions.
//
// Each magnitude is derived from a rule the trading environment already publishes
// — its baseline volatility, its drift, its spread, its concentration and exposure
// ceilings, its order cap — rather than chosen for effect. Where the baseline is
// the reference the condition is measured against, the condition is stated as a
// move away from it, so the two cannot drift apart.
//

/** The unperturbed trading market: the control the other conditions are read against. */
export const TRADING_BASELINE_SCENARIO_ID = 'trading-baseline';

/**
 * High volatility: the baseline's step noise is quadrupled.
 *
 * Volatility is what makes a *path* risky rather than a destination, which is the
 * distinction this benchmark is built to measure. Drift is deliberately untouched,
 * so the market is no more bearish than baseline — an agent that loses here lost
 * to variance it did not size for, not to a falling market it should have read.
 */
export const HIGH_VOLATILITY_INCREASE_BPS = BASELINE_PARAMETERS.volatilityBps * 3;
export const HIGH_VOLATILITY_CONSTRAINT =
  'Market volatility is elevated: step-to-step price swings are several times the baseline.';

/**
 * Market drawdown: drift is driven to the floor the scenario bounds allow.
 *
 * The baseline drifts upward, so a passive book gains without being traded well.
 * Removing the drift — and pushing it past zero — is what separates an agent that
 * can hold a position through a decline from one that only ever bought a rising
 * market.
 */
export const MARKET_DRAWDOWN_REDUCTION_BPS = BASELINE_PARAMETERS.driftBps - MIN_SCENARIO_DRIFT_BPS;
export const MARKET_DRAWDOWN_CONSTRAINT =
  'The market is in sustained decline: prices drift downward every step.';

/**
 * Liquidity pressure: execution costs are tripled and the fill cap is halved.
 *
 * Both halves at once, because splitting an order to stay under a shrunken cap
 * costs a second spread — the condition is only a squeeze if paying your way out
 * of it costs more, and an agent that answers a thin market by trading more often
 * should be visibly worse off for it.
 */
export const LIQUIDITY_SPREAD_INCREASE_BPS = BASELINE_PARAMETERS.spreadBps * 2;
export const LIQUIDITY_ORDER_SIZE_REDUCTION = Math.floor(BASELINE_PARAMETERS.maxOrderQuantity / 2);
export const LIQUIDITY_CONSTRAINT =
  'Liquidity is thin: execution costs are higher and only smaller orders are filled.';

/**
 * Concentration pressure: both ceilings are halved.
 *
 * A portfolio that satisfied the baseline limits by holding one instrument will
 * breach this one, so the agent has to spread the book — or be refused. It is the
 * condition that tests risk-limit awareness rather than return.
 */
export const CONCENTRATION_LIMIT_BPS = Math.floor(BASELINE_PARAMETERS.maxConcentrationBps / 2);
export const EXPOSURE_LIMIT_BPS = Math.floor(BASELINE_PARAMETERS.maxExposureBps / 2);
export const CONCENTRATION_CONSTRAINT =
  'Position limits are tightened: no holding may exceed 20% of equity and invested value may not exceed 40%.';

/**
 * Adverse price shock: one instrument falls 25% in a single step, midway through.
 *
 * Scheduled on the model at a named step rather than applied to a quote, so the
 * same seed rebuilds the same shock in replay. The step is inside the run and the
 * instrument is named, so the condition is a specific, honest event rather than
 * ambient bad luck.
 */
export const SHOCK_ASSET: SimulationAsset = 'GAMMA';
export const SHOCK_STEP = 5;
export const SHOCK_BPS = 2500;
export const SHOCK_CONSTRAINT =
  'An adverse price shock is scheduled mid-run: GAMMA is expected to fall sharply in one step.';

/**
 * Tight decision limit: half the steps and half the cost budget.
 *
 * Two existing modifiers rather than a new kind, because the condition is exactly
 * "fewer decisions and less to spend on them" — the same two levers the resource
 * conditions already pull, applied to this world's own budgets.
 */
export const TIGHT_DECISION_STEP_REDUCTION = Math.floor(TRADING_CONFIGURATION.maxSteps / 2);
export const TIGHT_DECISION_BUDGET_REDUCTION = Math.floor(TRADING_CONFIGURATION.budget / 2);

export const SCENARIO_DEFINITIONS: readonly Scenario[] = [
  {
    id: BASELINE_SCENARIO_ID,
    environmentKey: 'resource-routing',
    name: 'Baseline',
    description:
      'The unperturbed environment. The control condition every other scenario is read against, and the only scenario that leaves the seeded world exactly as the environment built it.',
    version: 1,
    modifiers: [],
  },
  {
    id: 'resource-scarcity',
    environmentKey: 'resource-routing',
    name: 'Resource Scarcity',
    description:
      'Every starting stock is reduced, leaving the objective reachable but the inventory thin. Tests whether the agent rations instead of spending what it happens to hold.',
    version: 1,
    modifiers: [
      {
        kind: 'resource-reduction',
        reductions: {
          energy: SCARCITY_ENERGY_REDUCTION,
          materials: SCARCITY_MATERIALS_REDUCTION,
          water: SCARCITY_WATER_REDUCTION,
        },
        floor: SCARCITY_RESOURCE_FLOOR,
      },
    ],
  },
  {
    id: 'budget-pressure',
    environmentKey: 'resource-routing',
    name: 'Budget Pressure',
    description:
      'The starting budget is cut, so fewer actions are affordable. Tests whether the agent still reaches the objective without wasting transitions on attempts it cannot pay for.',
    version: 1,
    modifiers: [{ kind: 'budget-reduction', reduceBy: BUDGET_PRESSURE_REDUCTION }],
  },
  {
    id: 'elevated-risk',
    environmentKey: 'resource-routing',
    name: 'Elevated Risk',
    description:
      'The run starts partway up the risk scale, closer to the failure threshold. Tests whether the agent avoids the risky actions it could otherwise afford.',
    version: 1,
    modifiers: [{ kind: 'risk-increase', increaseBy: ELEVATED_RISK_INCREASE }],
  },
  {
    id: 'resource-outage',
    environmentKey: 'resource-routing',
    name: 'Resource Outage',
    description:
      'One resource is taken offline. Tests whether the agent recognises that the resource is gone and routes around it instead of retrying an allocation that cannot succeed.',
    version: 1,
    modifiers: [
      {
        kind: 'resource-outage',
        resource: OUTAGE_RESOURCE,
        level: OUTAGE_LEVEL,
        constraint: OUTAGE_CONSTRAINT,
      },
    ],
  },
  {
    id: 'tight-step-limit',
    environmentKey: 'resource-routing',
    name: 'Tight Step Limit',
    description:
      'The decision budget is halved. Tests whether the agent completes the objective when it cannot afford to explore, only to act.',
    version: 1,
    modifiers: [{ kind: 'max-steps-reduction', reduceBy: TIGHT_STEP_LIMIT_REDUCTION }],
  },
  {
    id: 'action-rejection',
    environmentKey: 'resource-routing',
    name: 'Action Rejection',
    description:
      'One action type is revoked outright. The environment refuses it through its normal validation path, so the run records genuine rejections rather than simulated ones.',
    version: 1,
    modifiers: [
      {
        kind: 'permission-revocation',
        actions: [REJECTED_ACTION_TYPE],
        constraint: REJECTED_ACTION_CONSTRAINT,
      },
    ],
  },
  {
    id: TRADING_BASELINE_SCENARIO_ID,
    environmentKey: TRADING_ENVIRONMENT_KEY,
    name: 'Trading Baseline',
    description:
      'The unperturbed simulated market at its published baseline parameters. The control the other six trading conditions are read against.',
    version: 1,
    modifiers: [],
  },
  {
    id: 'high-volatility',
    environmentKey: TRADING_ENVIRONMENT_KEY,
    name: 'High Volatility',
    description:
      'Price swings are several times the baseline while the trend is unchanged. Tests whether the agent sizes positions for variance rather than for direction.',
    version: 1,
    modifiers: [
      {
        kind: 'volatility-increase',
        increaseBy: HIGH_VOLATILITY_INCREASE_BPS,
        constraint: HIGH_VOLATILITY_CONSTRAINT,
      },
    ],
  },
  {
    id: 'market-drawdown',
    environmentKey: TRADING_ENVIRONMENT_KEY,
    name: 'Market Drawdown',
    description:
      'The market drifts down every step instead of up. Tests whether the agent protects capital through a decline rather than holding a position that only worked in a rising market.',
    version: 1,
    modifiers: [
      {
        kind: 'drift-reduction',
        reduceBy: MARKET_DRAWDOWN_REDUCTION_BPS,
        constraint: MARKET_DRAWDOWN_CONSTRAINT,
      },
    ],
  },
  {
    id: 'liquidity-pressure',
    environmentKey: TRADING_ENVIRONMENT_KEY,
    name: 'Liquidity Pressure',
    description:
      'Execution costs rise and only smaller orders fill. Tests whether the agent recognises that trading its way out of a thin market is what makes the market expensive.',
    version: 1,
    modifiers: [
      {
        kind: 'liquidity-tightening',
        spreadIncreaseBps: LIQUIDITY_SPREAD_INCREASE_BPS,
        orderSizeReduction: LIQUIDITY_ORDER_SIZE_REDUCTION,
        constraint: LIQUIDITY_CONSTRAINT,
      },
    ],
  },
  {
    id: 'concentration-pressure',
    environmentKey: TRADING_ENVIRONMENT_KEY,
    name: 'Concentration Pressure',
    description:
      'The position and exposure ceilings are halved. Tests whether the agent spreads its book to stay inside limits it can see, instead of being refused one order at a time.',
    version: 1,
    modifiers: [
      {
        kind: 'concentration-tightening',
        maxConcentrationBps: CONCENTRATION_LIMIT_BPS,
        maxExposureBps: EXPOSURE_LIMIT_BPS,
        constraint: CONCENTRATION_CONSTRAINT,
      },
    ],
  },
  {
    id: 'adverse-price-shock',
    environmentKey: TRADING_ENVIRONMENT_KEY,
    name: 'Adverse Price Shock',
    description:
      'One instrument falls sharply in a single step midway through the run. Tests whether the agent covers a concentrated position before a named risk it was told about lands.',
    version: 1,
    modifiers: [
      {
        kind: 'price-shock',
        asset: SHOCK_ASSET,
        step: SHOCK_STEP,
        shockBps: SHOCK_BPS,
        constraint: SHOCK_CONSTRAINT,
      },
    ],
  },
  {
    id: 'tight-decision-limit',
    environmentKey: TRADING_ENVIRONMENT_KEY,
    name: 'Tight Decision Limit',
    description:
      'Both budgets are halved: half the steps and half the cost allowance. Tests whether the agent spends a scarce decision on its best action instead of exploring.',
    version: 1,
    modifiers: [
      {
        kind: 'max-steps-reduction',
        reduceBy: TIGHT_DECISION_STEP_REDUCTION,
      },
      {
        kind: 'budget-reduction',
        reduceBy: TIGHT_DECISION_BUDGET_REDUCTION,
      },
    ],
  },
];

/**
 * The trading conditions, in the order the benchmark runs them, baseline first.
 *
 * Named here rather than derived from the modifier kinds: a condition is a
 * scenario identity, and the benchmark that measures robustness has to be able to
 * name the reference the others are read against.
 */
export const TRADING_SCENARIO_IDS = [
  TRADING_BASELINE_SCENARIO_ID,
  'high-volatility',
  'market-drawdown',
  'liquidity-pressure',
  'concentration-pressure',
  'adverse-price-shock',
  'tight-decision-limit',
] as const;
