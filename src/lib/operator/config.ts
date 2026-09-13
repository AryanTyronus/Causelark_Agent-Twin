//
// An autonomous agent that a person points at a benchmark is an agent that can
// spend money. The bounds below are the whole of its allowance, they are
// constants rather than configuration read from a request, and every one of them
// is enforced inside a tool closure rather than being left to the model's
// judgement about when to stop. A model that ignores its instructions still
// cannot exceed these, because the code that would do the work refuses.
//
// Why these particular numbers:
//
//   MAX_TURNS = 12
//     Aligned with `MAX_AGENT_LOOP_TURNS`, the bound the simulation agent itself
//     runs under. The operator's job is a handful of reads, one plan, one
//     execution and one report; twelve model calls is comfortably more than the
//     seven-step flow needs and still small enough that a confused model cannot
//     loop for long. A run that hits it is reported as `limit-reached` rather
//     than being retried.
//
//   MAX_TOOL_CALLS = 24
//     Two calls per turn on average. The read tools are cheap, but a model that
//     decides to read every case individually would otherwise issue dozens of
//     calls; this cap says it has to choose which cases are worth looking at,
//     which is the judgement the Operator exists to make.
//
//   MAX_BENCHMARK_RUNS = 1
//     One benchmark execution per request. Each case drives a real agent turn
//     loop against a real provider, so a second execution doubles the spend of a
//     request a person authorised for one. Re-running the same benchmark against
//     the same agent is a new request with a new authorisation, not a retry.
//
//   MAX_COUNTERFACTUAL_ANALYSES = 3
//     Counterfactual analysis is cheap — it is a deterministic fold over a
//     recorded trace and contacts no provider — but it is not free, and running
//     it over every case would produce a pile of findings nobody asked for. Three
//     is enough to look at the worst case, the baseline, and one more if the
//     first two disagree; choosing *which* three is the analysis the model is
//     asked to do.
//
//   MAX_DURATION_MS = 180_000
//     Three minutes for the whole request. One benchmark execution is the long
//     pole: seven cases at up to twelve turns each, against a provider with its
//     own per-turn timeouts. This is a ceiling on the request, not an expectation
//     of how long it takes.
//
//   MAX_CASE_EVIDENCE = 6
//     How many cases the operator may pull full evidence for. Bounded separately
//     from the tool-call budget because each one returns an evaluation, an action
//     summary and a fault list; six is enough to characterise a seven-case matrix
//     without the trace becoming a copy of the database.

import type { OperatorMode } from './types';

/** Model calls one operator request may make. */
export const MAX_OPERATOR_TURNS = 12;

/** Tool calls one operator request may make, across every turn. */
export const MAX_OPERATOR_TOOL_CALLS = 24;

/** Benchmark executions one operator request may start. */
export const MAX_OPERATOR_BENCHMARK_RUNS = 1;

/** Counterfactual analyses one operator request may run. */
export const MAX_OPERATOR_COUNTERFACTUAL_ANALYSES = 3;

/** Wall-clock ceiling for one operator request, in milliseconds. */
export const MAX_OPERATOR_DURATION_MS = 180_000;

/** Cases the operator may pull full evidence for. */
export const MAX_OPERATOR_CASE_EVIDENCE = 6;

/** Rejected actions quoted per case. The counts are exact; the list is a sample. */
export const MAX_OPERATOR_REJECTED_ACTIONS = 8;

/** How many bytes of a tool result the trace retains. */
export const MAX_OPERATOR_TRACE_DETAIL_BYTES = 2_048;

/**
 * How many trace steps one run records.
 *
 * A ceiling rather than a target. The tool-call budget is the real bound; this
 * exists so a model that keeps calling tools after the budget is spent cannot
 * grow the trace without limit. The first step past it is refused and the
 * truncation is written into the run's notices, so a reader is told the list is
 * incomplete rather than shown a list that looks complete.
 */
export const MAX_OPERATOR_TRACE_STEPS = 60;

/** Characters of operator narration retained. A paragraph, not an essay. */
export const MAX_OPERATOR_NARRATION_CHARS = 2_000;

/** Characters of operator interpretation retained in a report. */
export const MAX_OPERATOR_INTERPRETATION_CHARS = 1_200;

/**
 * The bounds, as the shape a plan and a run state publish them.
 *
 * Exported as a function rather than a frozen object so a caller cannot mutate
 * the deployment's allowance by holding a reference to it.
 */
export function operatorBounds() {
  return {
    maxTurns: MAX_OPERATOR_TURNS,
    maxToolCalls: MAX_OPERATOR_TOOL_CALLS,
    maxBenchmarkRuns: MAX_OPERATOR_BENCHMARK_RUNS,
    maxCounterfactualAnalyses: MAX_OPERATOR_COUNTERFACTUAL_ANALYSES,
    maxDurationMs: MAX_OPERATOR_DURATION_MS,
  };
}

export type OperatorBounds = ReturnType<typeof operatorBounds>;

/**
 * Whether an execution mode may be requested at all.
 *
 * Both modes are always requestable: `preview` needs nothing configured because
 * it contacts no provider, and `execute` needs an agent that resolves, which is
 * checked against the catalogue rather than guessed at here. This function
 * exists so that the rule has one home, and so that a future mode that *is*
 * deployment-gated has somewhere to say so.
 */
export function modeIsAvailable(mode: OperatorMode): boolean {
  return mode === 'preview' || mode === 'execute';
}
