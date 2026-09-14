//
// A scenario is a deterministic environmental perturbation expressed as data.
// Nothing in these shapes can execute: a scenario is an id, a version, and a
// list of modifiers, each of which is a tagged record of parameters that the
// engine knows how to interpret. A user-supplied id can therefore only ever
// resolve to a definition that shipped with the code — never to code itself.
//
// These schemas are isomorphic (no database, no provider, no `server-only`), so
// the catalogue, the application engine, the API route that serves them and the
// tests that pin them all share one description.

import { z } from 'zod';
import {
  SimulationActionType,
  SimulationAsset,
  SimulationConfiguration,
  SimulationEnvironmentKey,
  SimulationResource,
  SimulationScenarioIdentity,
  SimulationState,
} from '@/lib/contracts/simulation';

/**
 * The modifier vocabulary. Each kind is a declarative parameter record the
 * engine applies through its own pure function; a definition can carry no other
 * kind. Ordering inside a scenario is the declared array order.
 */
export const ScenarioModifierKind = z.enum([
  'resource-reduction',
  'resource-outage',
  'budget-reduction',
  'risk-increase',
  'max-steps-reduction',
  'permission-revocation',
  // The trading conditions. Every one of these perturbs `state.trading.parameters`
  // — the model the seeded price path is generated from — rather than rewriting a
  // price after it has been observed. A condition that edited quotes directly
  // would be a condition the market could not have produced, and the run's own
  // replay would not reproduce it.
  'volatility-increase',
  'drift-reduction',
  'liquidity-tightening',
  'concentration-tightening',
  'price-shock',
]);
export type ScenarioModifierKind = z.infer<typeof ScenarioModifierKind>;

/**
 * The order reductions are evaluated in. The environment's own resource order,
 * named explicitly rather than read from object key iteration, so the emitted
 * change records are in a stable order regardless of how a definition happens
 * to be written.
 */
export const SCENARIO_RESOURCE_ORDER = ['energy', 'materials', 'water'] as const;

//
// The trading conditions' bounds, in the same spirit: a named limit a modifier
// saturates at, rather than a number implied by whichever arithmetic it happens
// to use. Each is derived from a rule the trading environment already publishes.
//

/**
 * The most volatile a conditioned market gets, in basis points per step.
 *
 * Ten times the baseline's 150bps, and a ten-percent step is already far past
 * anything the eight-point drawdown ceiling tolerates on a concentrated book.
 * Past this the market stops being a market to trade and becomes a coin flip, and
 * a benchmark whose conditions are unwinnable measures nothing about the agent.
 */
export const MAX_SCENARIO_VOLATILITY_BPS = 1500;

/**
 * The most adverse drift a conditioned market gets, in basis points per step.
 *
 * Bounded because drift compounds: at twelve steps, -400bps a step compounds to
 * roughly a 38% fall, which is already well beyond the drawdown ceiling. A steeper
 * floor would guarantee failure on every action sequence, and a condition no
 * strategy survives is not a test of discipline.
 */
export const MIN_SCENARIO_DRIFT_BPS = -400;

/** The widest round-trip cost a conditioned market charges, in basis points. */
export const MAX_SCENARIO_SPREAD_BPS = 250;

/** A thinned market never stops filling orders entirely. */
export const MIN_SCENARIO_ORDER_QUANTITY = 1;

/**
 * The tightest concentration ceiling a condition may impose, in basis points.
 *
 * 1000 is a tenth of equity in one instrument, and it is the exact boundary: the
 * four published instruments at a tenth each fill the 40% exposure ceiling these
 * conditions pair it with and not a basis point more. Tighter, and the objective
 * would be unreachable through *any* allocation rather than through an
 * undisciplined one — a condition that fails every agent measures nothing.
 */
export const MIN_SCENARIO_CONCENTRATION_BPS = 1000;

/** The tightest exposure ceiling a condition may impose, in basis points. */
export const MIN_SCENARIO_EXPOSURE_BPS = 1000;

/** Shave a fixed amount from each named resource, saturating at `floor`. */
const ResourceReductionModifier = z.object({
  kind: z.literal('resource-reduction'),
  reductions: z.object({
    energy: z.number().int().positive().optional(),
    materials: z.number().int().positive().optional(),
    water: z.number().int().positive().optional(),
  }),
  floor: z.number().int().nonnegative(),
});

/** Take one resource offline by setting it to a fixed level. */
const ResourceOutageModifier = z.object({
  kind: z.literal('resource-outage'),
  resource: SimulationResource,
  level: z.number().int().nonnegative(),
  constraint: z.string().min(1).max(200),
});

/** Shave a fixed amount from the starting budget, saturating at the floor. */
const BudgetReductionModifier = z.object({
  kind: z.literal('budget-reduction'),
  reduceBy: z.number().int().positive(),
});

/** Start the run closer to the risk threshold. */
const RiskIncreaseModifier = z.object({
  kind: z.literal('risk-increase'),
  increaseBy: z.number().int().positive(),
});

/** Shave a fixed amount from the decision budget, saturating at the floor. */
const MaxStepsReductionModifier = z.object({
  kind: z.literal('max-steps-reduction'),
  reduceBy: z.number().int().positive(),
});

/**
 * Revoke action types. This removes them from the environment's own permission
 * list, so the existing validator refuses them with its own
 * `PERMISSION_DENIED` — the rejection is produced by the normal pipeline rather
 * than manufactured after the fact.
 */
const PermissionRevocationModifier = z.object({
  kind: z.literal('permission-revocation'),
  actions: z.array(SimulationActionType).min(1),
  constraint: z.string().min(1).max(200),
});

/**
 * Raise per-step price volatility, saturating at the ceiling below.
 *
 * A condition changes the market by changing the model it is generated from, so
 * this moves a parameter the seeded path is a pure function of, never a price.
 */
const VolatilityIncreaseModifier = z.object({
  kind: z.literal('volatility-increase'),
  increaseBy: z.number().int().positive(),
  constraint: z.string().min(1).max(200),
});

/** Push per-step drift down, saturating at the floor below. Negative is falling. */
const DriftReductionModifier = z.object({
  kind: z.literal('drift-reduction'),
  reduceBy: z.number().int().positive(),
  constraint: z.string().min(1).max(200),
});

/**
 * Thin the market: execution costs rise and the largest fillable order shrinks.
 *
 * Both halves are one modifier because they are one condition. A market that
 * charged more per trade but filled any size would be a cost scenario, not a
 * liquidity one — what makes liquidity pressure hard is that neither splitting an
 * order nor paying more makes it whole.
 */
const LiquidityTighteningModifier = z.object({
  kind: z.literal('liquidity-tightening'),
  spreadIncreaseBps: z.number().int().nonnegative(),
  orderSizeReduction: z.number().int().nonnegative(),
  constraint: z.string().min(1).max(200),
});

/** Lower the concentration and exposure ceilings a portfolio must stay inside. */
const ConcentrationTighteningModifier = z.object({
  kind: z.literal('concentration-tightening'),
  maxConcentrationBps: z.number().int().min(MIN_SCENARIO_CONCENTRATION_BPS).max(10000),
  maxExposureBps: z.number().int().min(MIN_SCENARIO_EXPOSURE_BPS).max(10000),
  constraint: z.string().min(1).max(200),
});

/**
 * Schedule an adverse move in one instrument at a given step.
 *
 * Scheduled on the *model* rather than applied to a quote, so the shock lands in
 * whichever state has actually reached that step — a replay rebuilds the same
 * shock from the same seed without replaying the scenario over it.
 */
const PriceShockModifier = z.object({
  kind: z.literal('price-shock'),
  asset: SimulationAsset,
  step: z.number().int().nonnegative(),
  shockBps: z.number().int().positive(),
  constraint: z.string().min(1).max(200),
});

export const ScenarioModifier = z.discriminatedUnion('kind', [
  ResourceReductionModifier,
  ResourceOutageModifier,
  BudgetReductionModifier,
  RiskIncreaseModifier,
  MaxStepsReductionModifier,
  PermissionRevocationModifier,
  VolatilityIncreaseModifier,
  DriftReductionModifier,
  LiquidityTighteningModifier,
  ConcentrationTighteningModifier,
  PriceShockModifier,
]);
export type ScenarioModifier = z.infer<typeof ScenarioModifier>;
export type ScenarioModifierOf<K extends ScenarioModifierKind> = Extract<
  ScenarioModifier,
  { kind: K }
>;

export const SCENARIO_VERSION_MIN = 1;

export const Scenario = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Scenario ids are lower-kebab-case.'),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  /** Bumped whenever the modifiers below change meaning. Never a timestamp. */
  version: z.number().int().min(SCENARIO_VERSION_MIN),
  /**
   * The world this scenario conditions.
   *
   * A condition is a perturbation of one environment's own rules — a resource
   * stock, a market model — so a scenario has to name the world it belongs to
   * before it can be applied to anything, or read against anything.
   *
   * Defaulted to the resource-routing world so every definition written before a
   * second environment existed, and every persisted scenario identity, keeps its
   * exact meaning. Both catalogues hold both worlds' scenarios; this is the field
   * that keeps one world's conditions off the other's runs.
   */
  environmentKey: SimulationEnvironmentKey.default('resource-routing'),
  modifiers: z.array(ScenarioModifier),
});
export type Scenario = z.infer<typeof Scenario>;

/** The catalogue projection of a scenario: identity and prose, no modifiers. */
export const ScenarioSummary = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.number().int().positive(),
});
export type ScenarioSummary = z.infer<typeof ScenarioSummary>;
export const ScenarioCatalog = z.object({ scenarios: z.array(ScenarioSummary) });
export type ScenarioCatalog = z.infer<typeof ScenarioCatalog>;

/**
 * One environmental field the scenario moved. `modifier` names the modifier
 * kind responsible, so a reader can attribute every change without diffing the
 * state. This is the audit trail the run persists — an explicit record per
 * field rather than an opaque before/after dump.
 */
export const ScenarioChange = z.object({
  field: z.string().min(1),
  before: z.unknown(),
  after: z.unknown(),
  modifier: ScenarioModifierKind,
});
export type ScenarioChange = z.infer<typeof ScenarioChange>;

/**
 * The pre-scenario inputs a scenario perturbs: the state and configuration the
 * environment would have produced on its own. The seed lives on the state and
 * is never touched by a modifier.
 */
export interface ScenarioBaseline {
  state: SimulationState;
  configuration: SimulationConfiguration;
}

/**
 * The outcome of applying one scenario: the perturbed baseline, the scenario
 * that produced it, and the change records explaining it.
 */
export const ScenarioApplicationResult = z.object({
  scenario: SimulationScenarioIdentity,
  name: z.string().min(1),
  description: z.string().min(1),
  state: SimulationState,
  configuration: SimulationConfiguration,
  changes: z.array(ScenarioChange),
});
export type ScenarioApplicationResult = z.infer<typeof ScenarioApplicationResult>;

// Bounds a scenario may not cross. They exist so a modifier can saturate at a
// named limit instead of pushing the environment into a state the validator
// would reject — and so the limits are visible rather than implied by whichever
// arithmetic a modifier happens to use.
/** A resource reduction never takes a stock below this; outages do it explicitly. */
export const MIN_SCENARIO_RESOURCE = 1;
/** A reduced budget always leaves at least one affordable action. */
export const MIN_SCENARIO_BUDGET = 1;
/** A reduced decision budget always leaves room for more than one action. */
export const MIN_SCENARIO_MAX_STEPS = 3;
/** Elevated risk must leave this much headroom below the failure threshold. */
export const MIN_SCENARIO_RISK_HEADROOM = 1;

export const SCENARIO_ERROR_CODES = [
  'UNKNOWN_SCENARIO',
  'INVALID_SCENARIO',
  'UNKNOWN_MODIFIER',
  'INVALID_BASELINE',
  'INVALID_RESULT',
] as const;
export type ScenarioErrorCode = (typeof SCENARIO_ERROR_CODES)[number];

/** Raised when a scenario cannot be resolved or would produce an invalid world. */
export class ScenarioError extends Error {
  readonly code: ScenarioErrorCode;

  constructor(code: ScenarioErrorCode, message: string) {
    super(message);
    this.name = 'ScenarioError';
    this.code = code;
  }
}
