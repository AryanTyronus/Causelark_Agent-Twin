//
// Shared machinery for the trading tests.
//
// Everything here drives the shipped pipeline — the scenario engine builds the
// world, the registry dispatches the transition, the evaluation engine scores
// what was recorded — and nothing here re-implements a rule. A harness that
// restated the environment's own arithmetic would let a test pass while the
// benchmark was broken.
//
// There is no model anywhere in this file. The policies below are pure functions
// of the state they are handed, and every one of them reads ONLY what
// `tradingObservation` discloses — the current quotes, the current book, the
// remaining budgets. That is what makes a run here reproducible, and it is also
// what makes the policies legitimate: an agent could implement any of them from
// its observation alone.

import {
  type SimulationActionInput,
  type SimulationActionRecord,
  SimulationActionRecord as SimulationActionRecordSchema,
  type SimulationAsset as SimulationAssetType,
  type SimulationConfiguration,
  type SimulationEvent,
  SimulationState,
  type SimulationState as SimulationStateType,
  type SimulationToolCall,
} from '@/lib/contracts/simulation';
import { evaluateSimulationAction, getSimulationStatus } from '@/lib/environments/registry';
import type { EvaluationInput } from '@/lib/evaluation/types';
import { initializeScenarioRun } from '@/lib/scenarios/scenario';
import {
  ASSET_ORDER,
  TRADING_ENVIRONMENT_KEY,
  TRADING_OBJECTIVE_KEY,
} from '@/lib/trading/definitions';
import { TRADING_SCORING_PROFILE, tradingObservation } from '@/lib/trading/environment';
import { concentrationBps, equityCents, priceOf, quantityOf } from '@/lib/trading/portfolio';

/**
 * A fixed instant, used for every `createdAt` in this file.
 *
 * The records below are shaped like persisted ones, and a persisted row carries
 * a timestamp. Reading the clock would make two builds of the same fixture
 * differ, and nothing under test reads the field — it exists so the record
 * parses.
 */
export const FIXED_INSTANT = '2026-01-01T00:00:00.000Z';

/** The seed the benchmark ships. Every fixture here runs at it. */
export const BENCHMARK_SEED = 1042;

/** A policy: the next action to request, or `null` to stop deciding. */
export type Policy = (state: SimulationStateType, step: number) => SimulationActionInput | null;

/**
 * One scripted trajectory, in the shape the evaluation engine reads.
 *
 * The actions are real: each was offered to the environment's own validator, and
 * the record carries that verdict and the state it produced. Nothing here is
 * synthesised from an expectation of what the environment would do.
 */
export interface ScriptedRun {
  configuration: SimulationConfiguration;
  initialState: SimulationStateType;
  state: SimulationStateType;
  actions: SimulationActionRecord[];
  /**
   * Every validation code the environment returned, in request order.
   *
   * Carried separately from the records because the persisted row stores the
   * human-readable refusal and not the code: a test asserting on `buy` being
   * refused for concentration should assert the reason the validator gave, not
   * parse it back out of a sentence.
   */
  codes: string[];
  scenarioId: string | null;
  scenarioName: string | null;
  /** The evidence the evaluation engine and the counterfactual analyser read. */
  evidence: EvaluationInput;
}

/** One step of one scripted trajectory, before it is wrapped as a record. */
interface Step {
  requested: SimulationActionInput;
  /**
   * The step the action was requested at.
   *
   * Read from the state the request was offered to, NOT from the state it
   * produced: a refused action returns its input untouched, so a refusal at step
   * 0 would be recorded at step -1 by the arithmetic that works for an accepted
   * one. Both are the same step either way — the action belongs to the decision
   * point it was made at.
   */
  requestedAtStep: number;
  accepted: boolean;
  code: string;
  observation: string;
  rejectionReason: string | null;
  stateDiff: Record<string, unknown>;
  resultingState: SimulationStateType;
}

/**
 * Drive one run of the trading world to a terminal status.
 *
 * The loop is the same shape the runtime uses: ask the policy, offer the answer
 * to the environment, record what the environment said, carry the resulting
 * state forward. It stops when the world says the run has ended, or when the
 * policy declines to decide — in which case the run is left mid-flight and its
 * status is whatever the environment reports, which is the evidence a snapshot
 * evaluation has to handle.
 */
export function scriptedRun(input: {
  policy: Policy;
  seed?: number;
  scenarioId?: string | null;
  scenarioVersion?: number | null;
}): ScriptedRun {
  const seed = input.seed ?? BENCHMARK_SEED;
  const initialized = initializeScenarioRun({
    environmentKey: TRADING_ENVIRONMENT_KEY,
    objectiveKey: TRADING_OBJECTIVE_KEY,
    seed,
    scenarioId: input.scenarioId ?? null,
    scenarioVersion: input.scenarioVersion ?? null,
  });

  const initialState = initialized.state;
  const steps: Step[] = [];
  let state = initialState;

  // Bounded by the world's own step ceiling rather than by a number chosen here:
  // a policy that never returns null still cannot outrun the run's own limit. The
  // extra step is the one that carries the run from its last decision to the
  // terminal status the environment reports for it.
  for (let guard = 0; guard <= initialState.maxSteps; guard += 1) {
    if (getSimulationStatus(state).status !== 'RUNNING') break;
    const requested = input.policy(state, steps.length);
    if (requested === null) break;
    const evaluation = evaluateSimulationAction(state, requested);
    steps.push({
      requested,
      requestedAtStep: state.step,
      accepted: evaluation.accepted,
      code: evaluation.validationCode ?? (evaluation.accepted ? 'ACCEPTED' : 'REFUSED'),
      observation: evaluation.observation,
      rejectionReason: evaluation.rejectionReason,
      stateDiff: evaluation.stateDiff ?? {},
      resultingState: evaluation.state,
    });
    state = evaluation.state;
  }

  const actions = steps.map((step, index) =>
    SimulationActionRecordSchema.parse({
      id: `${input.scenarioId ?? 'plain'}-action-${index}`,
      step: step.requestedAtStep,
      type: step.requested.type,
      input: step.requested,
      source: 'agent',
      accepted: step.accepted,
      rejectionReason: step.rejectionReason,
      observation: step.observation,
      stateDiff: step.stateDiff,
      resultingState: step.resultingState,
      createdAt: FIXED_INSTANT,
    }),
  );

  const status = getSimulationStatus(state);
  return {
    configuration: initialized.configuration,
    initialState,
    state,
    actions,
    codes: steps.map((step) => step.code),
    scenarioId: initialized.scenario?.id ?? null,
    scenarioName: initialized.name,
    evidence: {
      runId: `${input.scenarioId ?? 'trading'}-${seed}`,
      status: status.status,
      state,
      initialState,
      actions,
      events: [],
      toolCalls: [],
      budgetLimit: initialized.configuration.budget,
      turnCount: actions.length,
      maxTurns: initialized.configuration.maxTurns,
      terminationReason: status.terminationReason,
      scenario: initialized.scenario,
      // The world that produced this evidence publishes the constants its scores
      // are normalised against — read from the environment, never restated.
      scoringProfile: TRADING_SCORING_PROFILE,
    },
  };
}

//
// Policies.
//
// Each is a pure function of the state, so the same market produces the same
// decisions every time, and each reads only disclosed quantities.
//

/** The largest share of equity one instrument may be targeted to hold. */
export const CONCENTRATION_CEILING_BPS = 4000;

/** The exposure ceiling the baseline market publishes, in basis points. */
export const EXPOSURE_CEILING_BPS = 8000;

/**
 * Hold a fixed basket at a fixed share of equity each, topping up as equity
 * grows and holding when every target is already met.
 *
 * This is the shape of a disciplined book: it decides once what it wants to own,
 * pays a spread to get there, and then stops paying spreads. It is deliberately
 * a *fixture* and not a claimed strategy — the basket is passed in, and the
 * tests that use one name it.
 */
export function basketPolicy(basket: readonly SimulationAssetType[], targetBps: number): Policy {
  return (state) => {
    const trading = state.trading;
    if (!trading) return null;
    const target = Math.floor((equityCents(trading) * targetBps) / 10000);
    for (const asset of basket) {
      const price = priceOf(trading, asset);
      if (price <= 0) continue;
      const deficit = target - quantityOf(trading, asset) * price;
      if (deficit < price) continue;
      const amount = Math.min(Math.floor(deficit / price), trading.parameters.maxOrderQuantity);
      if (amount >= 1) return { type: 'buy', asset, amount };
    }
    return { type: 'hold', amount: 1 };
  };
}

/**
 * The disciplined fixture: two instruments, each held at the concentration
 * ceiling, which is the deepest book the limits allow.
 *
 * It reaches the $500 objective on the baseline seed, so the completion path of
 * the evaluation engine is exercised by a real trajectory rather than by a
 * hand-built metric set. It is a fixture chosen to be winnable, not a strategy:
 * nothing gives an agent the knowledge of which two instruments to name, and the
 * benchmark does not reward knowing.
 */
export const DISCIPLINED_BOOK: readonly SimulationAssetType[] = ['ALPHA', 'DELTA'];

/** The disciplined fixture's policy, at the published ceiling. */
export function disciplinedPolicy(targetBps = 3900): Policy {
  return basketPolicy(DISCIPLINED_BOOK, targetBps);
}

/**
 * The churning fixture: build the same book, then round-trip a slice of it every
 * step afterwards.
 *
 * It ends up owning roughly what the disciplined book owns and pays for it
 * several times over — the behaviour the objective's own wording calls out
 * ("churned its capital through transaction costs"), and the one the
 * resource-management dimension exists to separate from a patient book.
 */
export function churningPolicy(targetBps = 3900): Policy {
  const build = disciplinedPolicy(targetBps);
  return (state) => {
    const trading = state.trading;
    if (!trading) return null;
    const wanted = build(state, 0);
    if (wanted && wanted.type === 'buy') return wanted;
    // Fully built: sell one share of the largest holding, then buy it straight
    // back on the following step, paying the spread in both directions.
    const held = [...trading.positions]
      .filter((position) => position.quantity > 0)
      .sort((left, right) => right.quantity - left.quantity);
    const largest = held[0];
    if (!largest) return { type: 'hold', amount: 1 };
    return { type: 'sell', asset: largest.asset, amount: 1 };
  };
}

/**
 * The reckless fixture: put the largest fillable order into one instrument every
 * step, whatever the ceiling says.
 *
 * It never spreads, it keeps asking for more than the concentration limit allows
 * once it is full (so it collects refusals), and it holds a single unhedged
 * position through whatever the market does. This is what the drawdown ceiling
 * and the concentration ceiling exist to stop.
 */
export function recklessPolicy(asset: SimulationAssetType = 'GAMMA'): Policy {
  return (state) => {
    const trading = state.trading;
    if (!trading) return null;
    const price = priceOf(trading, asset);
    if (price <= 0) return null;
    const amount = Math.min(Math.floor(trading.cash / price), trading.parameters.maxOrderQuantity);
    if (amount < 1) return { type: 'hold', amount: 1 };
    return { type: 'buy', asset, amount };
  };
}

/**
 * Sell a holding back down to a target share of equity, then hold.
 *
 * The de-risking decision the counterfactual analyser is supposed to be able to
 * find: the same book, answered differently once the market has moved.
 */
export function sellDownPolicy(asset: SimulationAssetType, targetBps: number): Policy {
  return (state) => {
    const trading = state.trading;
    if (!trading) return null;
    const price = priceOf(trading, asset);
    if (price <= 0) return { type: 'hold', amount: 1 };
    const target = Math.floor((equityCents(trading) * targetBps) / 10000);
    const value = quantityOf(trading, asset) * price;
    if (value <= target) return { type: 'hold', amount: 1 };
    const amount = Math.min(
      Math.ceil((value - target) / price),
      trading.parameters.maxOrderQuantity,
      quantityOf(trading, asset),
    );
    if (amount < 1) return { type: 'hold', amount: 1 };
    return { type: 'sell', asset, amount };
  };
}

//
// Readings over a scripted run.
//

/** The largest single-position share of equity any frame of the run reached. */
export function peakShareBps(run: ScriptedRun): number {
  return run.actions.reduce((worst, action) => {
    const trading = action.resultingState.trading;
    if (!trading) return worst;
    return Math.max(worst, ...ASSET_ORDER.map((asset) => concentrationBps(trading, asset)));
  }, 0);
}

/** Every validation code the environment returned over the run, in order. */
export function codesOf(run: ScriptedRun): string[] {
  return run.codes;
}

/** How many of the run's requests the environment accepted. */
export function acceptedCount(run: ScriptedRun): number {
  return run.actions.filter((action) => action.accepted).length;
}

/** The observation the environment would report for a state, at any time. */
export function observe(state: SimulationStateType): string {
  return tradingObservation(state);
}

/** The state of a run, schema-checked, for assertions that want a parsed value. */
export function parseState(state: SimulationStateType): SimulationStateType {
  return SimulationState.parse(state);
}

/** An empty event trace, for evidence that needs none. */
export const NO_EVENTS: SimulationEvent[] = [];
export const NO_TOOL_CALLS: SimulationToolCall[] = [];
