//
// Every quantity a benchmark averages is already an integer: the evaluation
// engine rounds each category score and the overall score to 0–100 before it
// returns them. Only the *means* are fractional. So the arithmetic here is done
// on integers and rounded once, at the boundary, under one stated rule —
// half away from zero at `BENCHMARK_METRIC_PRECISION` decimal places.
//
// This is deliberately not `Math.round(value * 100) / 100`. That expression
// rounds a binary approximation of a decimal, which is why `2.675` rounds to
// `2.67`. The functions below scale *before* dividing, so the quotient they
// round is computed from integers and no intermediate value is ever silently
// truncated.
//
// Nothing here reads a clock, a random source or a configuration value: the
// same inputs produce the same output on every machine.

import { BENCHMARK_METRIC_PRECISION } from './types';
/** Scores and ratios are handled internally as integer hundredths. */
export const SCORE_SCALE = 10 ** BENCHMARK_METRIC_PRECISION;

/**
 * Round `numerator / denominator` to `decimals` decimal places, half away from
 * zero. Both arguments must be integers for the result to be exact, which is
 * the only way this module ever calls it.
 *
 * A zero denominator yields `0` rather than `Infinity` or `NaN`: callers are
 * expected to have already decided that an undefined ratio is reported as
 * `null`, and this keeps a programming error from producing a value that could
 * be mistaken for a measurement.
 */
export function roundDivide(numerator: number, denominator: number, decimals = 0): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  const scale = 10 ** decimals;
  const scaled = numerator * scale;
  const quotient = Math.trunc(scaled / denominator);
  const remainder = scaled - quotient * denominator;
  const bump =
    Math.abs(remainder) * 2 >= Math.abs(denominator) ? Math.sign(scaled * denominator) : 0;
  return (quotient + bump) / scale;
}

/** A reported score, as exact integer hundredths. */
export function toScoreUnits(value: number): number {
  return roundDivide(value * SCORE_SCALE, 1, 0);
}

/** Exact hundredths back to a reported score. */
export function fromScoreUnits(units: number): number {
  return units / SCORE_SCALE;
}

/**
 * The mean of a list of reported scores, rounded once. `null` for an empty
 * list — an absent measurement is never reported as zero.
 */
export function meanScore(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const units = values.reduce((total, value) => total + toScoreUnits(value), 0);
  return fromScoreUnits(roundDivide(units, values.length, 0));
}

/** The mean of a list of exact hundredths, staying in hundredths. */
export function meanUnits(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return roundDivide(total, values.length, 0);
}

/** The smallest reported score, or `null` for an empty list. */
export function minimumScore(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((lowest, value) => (value < lowest ? value : lowest));
}

/** The largest reported score, or `null` for an empty list. */
export function maximumScore(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((highest, value) => (value > highest ? value : highest));
}

/**
 * `part / whole` as a ratio reported to `BENCHMARK_METRIC_PRECISION` places,
 * computed in exact hundredths. Returns `null` when `whole` is zero, because
 * the ratio does not exist — it is not zero and it is not one.
 */
export function ratioScore(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return roundDivide(toScoreUnits(part), toScoreUnits(whole), BENCHMARK_METRIC_PRECISION);
}
