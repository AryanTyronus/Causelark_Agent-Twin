// @polsia:user-owned — the Strands Operator.
//
// This is where the agent actually is. A Strands `Agent` is constructed over the
// tool surface `tools.ts` builds and a `Model` resolved through the provider
// boundary, and invoked once under explicit limits. The model chooses which
// tools to call and in what order; the SDK runs the loop, executes the tools,
// enforces the turn limit and hands back a stop reason. Nothing in this file
// decides what any tool means.
//
// Two things are deliberate and worth stating:
//
//   * The invocation is bounded three ways. `limits.turns` caps the model calls,
//     the tool surface caps its own calls, and an `AbortSignal.timeout` caps the
//     wall clock. The SDK reports an aborted invocation as a *result* with
//     `stopReason: 'cancelled'` rather than throwing, so the timeout is read back
//     off the stop reason — the same handling the simulation agent uses.
//
//   * The whole run is one `invoke`. Not a loop this file drives, not a
//     hand-rolled "while the model wants a tool" cycle. If the SDK's loop is not
//     what is doing the orchestrating, then what is here is not a Strands agent,
//     and the requirement this phase exists to meet would not be met.

import 'server-only';

import { Agent, type Message, type Model, TextBlock } from '@strands-agents/sdk';
import {
  AgentProviderError,
  type AgentProviderKind,
  createAgentModelFor,
  DEFAULT_AGENT_PROVIDER,
  resolveDeployedSelection,
  toAgentProviderError,
} from '@/lib/agent/provider';
import { env } from '@/lib/env';
import {
  MAX_OPERATOR_COUNTERFACTUAL_ANALYSES,
  MAX_OPERATOR_DURATION_MS,
  MAX_OPERATOR_TURNS,
  operatorBounds,
} from './config';
import { buildOperatorSystemPrompt, buildOperatorUserPrompt } from './prompt';
import { createOperatorToolbox } from './tools';
import {
  type OperatorMode,
  type OperatorRunState,
  OperatorRunState as OperatorRunStateSchema,
  type OperatorRunStatus,
} from './types';

/** How far the cause chain is walked looking for the provider's own error. */
const MAX_PROVIDER_CAUSE_DEPTH = 8;

export interface OperatorInvocation {
  /** The authenticated owner. Resolved by the caller from the session. */ ownerId: string;
  objective: string;
  mode: OperatorMode;
  /** The catalogue key the caller named, or `null`. */
  agentKey: string | null;
  /** Required by an execution: the fingerprint of the plan a person approved. */
  authorizedPlanFingerprint: string | null;
  /**
   * The operator's own model.
   *
   * A seam, and the only one. Production omits it, and the deployment's
   * configured provider is used. A test supplies a scripted model so that the
   * whole surface — the real tools, the real engines, the real database — can be
   * driven deterministically without an LLM anywhere in the loop.
   */
  model?: Model | null;
  /** Injected so a test can produce a deterministic trace and report. */
  now?: () => Date;
}

/**
 * Run the operator once and return everything it produced.
 *
 * Never throws for something that happened *inside* the run: a refused tool
 * call, a benchmark whose cases failed, an evidence set too thin to judge — all
 * of those are findings the returned state carries. What it does throw is the
 * operator being unable to start at all, which is a deployment problem rather
 * than a result.
 */
export async function runOperator(input: OperatorInvocation): Promise<OperatorRunState> {
  const bounds = operatorBounds();
  const now = input.now ?? (() => new Date());
  const startedAt = Date.now();

  const execution = createOperatorToolbox({
    ownerId: input.ownerId,
    mode: input.mode,
    objective: input.objective,
    requestedAgentKey: input.agentKey,
    authorizedPlanFingerprint: input.authorizedPlanFingerprint,
    now,
  });

  const model = input.model ?? resolveOperatorModel();

  const agent = new Agent({
    model,
    tools: execution.tools,
    printer: false,
    // The tools share mutable execution state — a plan, a result, the call
    // budget — so calls must run one at a time for the recorded order to match
    // the order the model asked for them in.
    toolExecutor: 'sequential',
    systemPrompt: buildOperatorSystemPrompt({
      objective: input.objective,
      mode: input.mode,
      requestedAgentKey: input.agentKey,
      maxTurns: MAX_OPERATOR_TURNS,
      maxToolCalls: bounds.maxToolCalls,
      maxBenchmarkRuns: bounds.maxBenchmarkRuns,
      maxCounterfactualAnalyses: MAX_OPERATOR_COUNTERFACTUAL_ANALYSES,
    }),
  });
  execution.attachTraceHook(agent);

  let status: OperatorRunStatus = 'completed';
  let stopReason: string = 'endTurn';
  let narration: string | null = null;

  try {
    const result = await agent.invoke(buildOperatorUserPrompt(input.mode), {
      limits: { turns: MAX_OPERATOR_TURNS },
      cancelSignal: AbortSignal.timeout(MAX_OPERATOR_DURATION_MS),
    });
    stopReason = String(result.stopReason);
    narration = extractText(result.lastMessage);
    const cycles = result.metrics?.cycleCount ?? 0;
    execution.recordTurns(cycles > 0 ? cycles : countTurns(execution));
    if (result.stopReason === 'cancelled' || result.stopReason === 'limitTurns')
      status = 'limit-reached';
  } catch (error) {
    // A provider failure is reported, never hidden. The operator itself could
    // not run, so there is no report — but what is returned says exactly that,
    // and the caller can distinguish it from a run that produced no findings.
    const providerError = providerFailure(error);
    stopReason = providerError.code;
    status = 'failed';
    narration = null;
    execution.notices.push(
      `The operator's own model call failed (${providerError.code}): ${providerError.message}`,
    );
  }

  execution.recordDuration(Date.now() - startedAt);

  return OperatorRunStateSchema.parse({
    mode: input.mode,
    status,
    objective: input.objective,
    stopReason,
    requestedAgentKey: input.agentKey,
    agents: execution.catalogue.agents,
    configurationNotice: execution.catalogue.configurationNotice,
    limits: bounds,
    usage: execution.usage,
    plan: execution.plan,
    authorized: execution.authorized,
    trace: execution.trace,
    result: execution.resultSlice,
    caseEvidence: execution.caseEvidence,
    counterfactuals: execution.counterfactuals,
    report: execution.report,
    narration,
    notices: execution.notices,
  });
}

/**
 * The provider failure behind whatever the loop threw.
 *
 * The Strands SDK wraps every model failure in its own `ModelError`, keeping the
 * provider's error as `cause`. An `instanceof` check on the thrown value
 * therefore catches nothing, and a provider failure would be reported as a
 * generic error with its normalized code — the whole point of the provider
 * boundary — silently lost. So the chain is walked for one, and when nothing in
 * it is a provider error the value is classified, which is exactly what the
 * resource agent's own boundary does with the same exceptions.
 *
 * Either way the returned message is one this codebase built rather than one the
 * provider sent, so a failure notice can never carry a credential or a raw
 * provider payload.
 */
function providerFailure(error: unknown): AgentProviderError {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_PROVIDER_CAUSE_DEPTH; depth += 1) {
    if (current === null || current === undefined) break;
    if (current instanceof AgentProviderError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return toAgentProviderError(error, deployedProviderKind());
}

/** The provider this deployment runs on, or the default when none resolves. */
function deployedProviderKind(): AgentProviderKind {
  try {
    return resolveDeployedSelection(env).provider;
  } catch {
    // A run with an injected model has no selection to read, and a deployment
    // that cannot resolve one has already failed before the loop started.
    return DEFAULT_AGENT_PROVIDER;
  }
}

/** The operator's model, resolved through the deployment's provider boundary. */
function resolveOperatorModel(): Model {
  try {
    const selection = resolveDeployedSelection(env);
    return createAgentModelFor(selection, env).model;
  } catch (error) {
    if (error instanceof AgentProviderError)
      throw new AgentProviderError(
        error.code,
        `The operator has no model to run on: ${error.message}`,
      );
    throw error;
  }
}

/**
 * The text of a message, or `null` when it carried none.
 *
 * Narrowed with the SDK's own `TextBlock` rather than a cast: the operator's
 * closing narration is the one free-text field a model writes, and reading it
 * out of whatever block happens to be first would be reading a tool call's
 * arguments as prose.
 */
function extractText(message: Message | undefined): string | null {
  if (!message) return null;
  const text = message.content
    .flatMap((block) => (block instanceof TextBlock ? [block.text] : []))
    .join('\n')
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * A fallback turn count.
 *
 * The SDK reports loop cycles, which is the count that matters. On the failure
 * path there are none, so the trace is used: a model cannot call a tool without
 * having taken a turn, so the number of distinct turns that produced a tool call
 * is a lower bound that is never wrong.
 */
function countTurns(execution: { trace: readonly { at: string }[] }): number {
  return new Set(execution.trace.map((step) => step.at)).size;
}
