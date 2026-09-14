//
// The simulated market. This is the whole of the price model, and it is a pure
// function: a price is derived from the seed, the instrument, the step and the
// market parameters, and from nothing else. There is no clock, no random source,
// no network call and no external data feed anywhere beneath this file.
//
// The model is written this way for one reason above all others: **the agent
// must not be able to observe a future price.** If a price path were generated
// once and stored, the state the agent is shown would contain steps it has not
// reached yet, and the benchmark would be measuring foresight rather than
// decision-making. Deriving a price on demand means the only prices that exist
// in a state are the ones the run has actually arrived at.
//
// Every quantity is an integer. Prices are whole cents per share, moves are
// whole basis points, and the compounding step is integer division with
// round-half-up — so the same seed and the same parameters produce the same
// path on every machine, in every process, forever.

import { type SimulationAsset, TradingParameters } from '@/lib/contracts/simulation';
import { ASSET_ORDER, BASE_PRICE_CENTS, MIN_PRICE_CENTS } from './definitions';

/** Round-half-up integer division, for positive numerators. */
function divideRound(numerator: number, denominator: number): number {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

/**
 * A well-mixed 32-bit hash.
 *
 * Deterministic and platform-independent: every operation is a 32-bit integer
 * multiply or shift, so nothing here depends on floating-point behaviour or on
 * how a particular engine orders its arithmetic.
 */
function mix(value: number): number {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 2246822519) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 3266489917) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** The instrument's index in the published order. Fixed, so the hash is too. */
function assetIndex(asset: SimulationAsset): number {
  return ASSET_ORDER.indexOf(asset);
}

/**
 * The pseudo-random component of one step's move, in whole per-mille of price:
 * an integer in `[-1000, 1000]`, which spans exactly `[-1, 1]` when scaled.
 *
 * The asset and the step are folded in as separate mixed terms rather than
 * added, so two assets never walk in lockstep and one asset's step `n` is not
 * another's step `n + 1`.
 */
export function moveNoisePermille(seed: number, asset: SimulationAsset, step: number): number {
  const h = mix(
    mix(seed ^ Math.imul(assetIndex(asset) + 1, 0x9e3779b1)) ^ Math.imul(step, 0x85ebca6b),
  );
  return (h % 2001) - 1000;
}

/** The baseline each instrument opens at, in cents. */
export function basePrice(asset: SimulationAsset): number {
  return BASE_PRICE_CENTS[asset];
}

/**
 * The step's total move for one instrument, in whole basis points.
 *
 * Drift applies to every step; volatility scales the seeded noise; a scheduled
 * shock subtracts its own magnitude on its own step, on its own instrument.
 * The shock is a subtraction rather than a sign flip so its size is a property
 * of the definition rather than of whichever way the noise happened to fall.
 */
export function stepMoveBps(
  seed: number,
  asset: SimulationAsset,
  step: number,
  parameters: TradingParameters,
): number {
  const noise = moveNoisePermille(seed, asset, step);
  const drift = parameters.driftBps;
  const volatility = divideRound(parameters.volatilityBps * noise, 1000);
  const shock =
    parameters.shockStep === step && parameters.shockAsset === asset ? parameters.shockBps : 0;
  return drift + volatility - shock;
}

/** One step of compounding: `price` moved by `bps`, floored at the market's minimum. */
function compound(price: number, bps: number): number {
  const moved = divideRound(price * (10000 + bps), 10000);
  return Math.max(MIN_PRICE_CENTS, moved);
}

/**
 * The price of one instrument at one step.
 *
 * Step 0 is the instrument's opening price; every later step compounds the one
 * before it. The walk is replayed from the opening price rather than cached,
 * because a cached path would have to live somewhere the agent can read.
 *
 * Iterating is safe because a run's step count is bounded by its decision
 * budget — the same bound the environment already enforces on every other
 * per-step quantity.
 */
export function priceAt(
  seed: number,
  asset: SimulationAsset,
  step: number,
  parameters: TradingParameters,
): number {
  const parsed = TradingParameters.parse(parameters);
  let price = basePrice(asset);
  for (let at = 1; at <= step; at += 1)
    price = compound(price, stepMoveBps(seed, asset, at, parsed));
  return price;
}

/** Every instrument's price at one step, in the market's declared asset order. */
export function quotesAt(
  seed: number,
  step: number,
  parameters: TradingParameters,
): { asset: SimulationAsset; price: number }[] {
  return ASSET_ORDER.map((asset) => ({ asset, price: priceAt(seed, asset, step, parameters) }));
}

/**
 * How far an instrument moved from the previous step, in basis points.
 *
 * Reported to the agent as recent movement. It reads two prices and nothing
 * else — both of them steps the run has already reached — so it can never
 * disclose where the market is going.
 */
export function recentMoveBps(
  seed: number,
  asset: SimulationAsset,
  step: number,
  parameters: TradingParameters,
): number {
  if (step <= 0) return 0;
  const previous = priceAt(seed, asset, step - 1, parameters);
  const current = priceAt(seed, asset, step, parameters);
  return divideRound((current - previous) * 10000, previous);
}
