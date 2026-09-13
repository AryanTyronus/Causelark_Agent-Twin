//
// The Operator is a Strands agent, and the phase it belongs to exists to prove
// that. Proving it in a test suite therefore has to drive the *real* loop — the
// real SDK, the real tool surface, the real engines — while making the one thing
// that is neither deterministic nor free, the model call, a script.
//
// So this is a `Model`: the SDK's own abstract class, implementing the one
// method the loop consumes. It emits the same streaming events a provider emits,
// in the same order, and the SDK aggregates them exactly as it aggregates a real
// response. Nothing about the agent loop is bypassed, mocked or re-implemented —
// if this fake and a real provider disagreed about the protocol, the SDK would
// fail here rather than in production.
//
// Two properties matter beyond correctness:
//
//   * It records what it was *offered* — the tool specs and the system prompt —
//     on every call. That is what lets a test assert something a prompt cannot:
//     that the preview tool list does not contain `run_benchmark` at all, so no
//     amount of persuasive text from a model can reach it.
//
//   * It is exhaustive. A script that runs out throws rather than quietly
//     repeating, because a test whose model ran out of things to say is a test
//     that is asserting against a truncated run.

import {
  type ContentBlockDelta,
  Model,
  type ModelStreamEvent,
  type StreamOptions,
  type Usage,
} from '@strands-agents/sdk';

/** A tool call the scripted model will ask for. */
export interface ScriptedCall {
  tool: string;
  /**
   * The arguments, or a callback that produces them when the call is made.
   *
   * Defaults to `{}` — an empty argument object, which is valid for the read
   * tools.
   *
   * The callback exists for one case: an argument that cannot be known when the
   * script is written. The integration harness is the caller — `inspect_case`
   * takes a run id, and run ids only exist once `run_benchmark` has executed,
   * which happens *after* the script is fixed. Resolving the argument at emit
   * time is what a real model does: it reads the run id out of the tool result
   * it was just handed. It may be async for the same reason, so a harness can
   * resolve the id from the database rather than from a parsed message.
   */
  input?:
    | Record<string, unknown>
    | (() => Record<string, unknown> | Promise<Record<string, unknown>>);
  /**
   * Overrides the generated tool-use id.
   *
   * Only useful for a repeat of the same call in one turn, where two identical
   * ids would make the SDK's tool-use bookkeeping ambiguous.
   */
  toolUseId?: string;
}

/** The arguments for one scripted call, resolved at the moment it is emitted. */
async function resolveInput(call: ScriptedCall): Promise<Record<string, unknown>> {
  if (typeof call.input !== 'function') return call.input ?? {};
  return await call.input();
}

export type ScriptedStep =
  | { kind: 'calls'; calls: ScriptedCall[] }
  | { kind: 'say'; text: string }
  /** The provider itself failed. Used to prove a provider failure is never hidden. */
  | { kind: 'throw'; error: Error };

/** `calls(...)` — one turn in which the model asks for these tools. */
export function calls(...list: ScriptedCall[]): ScriptedStep {
  return { kind: 'calls', calls: list };
}

/** `say(text)` — one turn in which the model answers and the loop ends. */
export function say(text: string): ScriptedStep {
  return { kind: 'say', text };
}

/** `fails(error)` — the model call throws, as an unreachable provider would. */
export function fails(error: Error): ScriptedStep {
  return { kind: 'throw', error };
}

/** What one model call was offered, recorded for assertions. */
export interface ModelCallRecord {
  /** Tool names in the order the SDK listed them. */
  tools: string[];
  /** The system prompt, flattened to text. */
  systemPrompt: string;
  /** How many messages were in the conversation when the call was made. */
  messageCount: number;
}

const USAGE: Usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

/**
 * A model that answers from a script.
 *
 * `repeatLast` exists for one test: the unbounded-loop adversary. A model that
 * calls the same tool forever is exactly the failure the turn and tool-call
 * budgets exist to stop, and the only way to check that the budget holds is to
 * let a script genuinely never end.
 */
export class ScriptedOperatorModel extends Model {
  readonly calls: ModelCallRecord[] = [];
  private cursor = 0;

  constructor(
    private readonly script: ScriptedStep[],
    private readonly options: { repeatLast?: boolean } = {},
  ) {
    super();
  }

  updateConfig(): void {}

  getConfig() {
    // Set explicitly so the SDK does not warn about an unset context window on
    // every call; no other field is read by the loop.
    return { contextWindowLimit: 200_000 };
  }

  /** The scripted step for this call, or a throw when the script is exhausted. */
  private next(): ScriptedStep {
    const step = this.script[this.cursor];
    if (step === undefined) {
      if (this.options.repeatLast) {
        const last = this.script[this.script.length - 1];
        if (last) return last;
      }
      throw new Error(
        `The scripted model was asked for call #${this.cursor + 1} but the script has ${this.script.length} step(s). A run that needs more turns than its script provides is not a run this test can assert against.`,
      );
    }
    this.cursor += 1;
    return step;
  }

  async *stream(
    messages: { content: readonly unknown[] }[],
    options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    this.calls.push({
      tools: (options?.toolSpecs ?? []).map((spec) => spec.name),
      systemPrompt: flattenSystemPrompt(options?.systemPrompt),
      messageCount: messages.length,
    });

    const step = this.next();
    if (step.kind === 'throw') throw step.error;

    yield { type: 'modelMessageStartEvent', role: 'assistant' };

    if (step.kind === 'calls') {
      for (const [index, call] of step.calls.entries()) {
        yield {
          type: 'modelContentBlockStartEvent',
          start: {
            type: 'toolUseStart',
            name: call.tool,
            toolUseId: call.toolUseId ?? `tooluse-${this.cursor}-${index}`,
          },
        };
        yield {
          type: 'modelContentBlockDeltaEvent',
          delta: {
            type: 'toolUseInputDelta',
            input: JSON.stringify(await resolveInput(call)),
          } satisfies ContentBlockDelta,
        };
        yield { type: 'modelContentBlockStopEvent' };
      }
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else {
      yield { type: 'modelContentBlockStartEvent' };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: step.text } satisfies ContentBlockDelta,
      };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }

    yield { type: 'modelMetadataEvent', usage: USAGE, metrics: { latencyMs: 1 } };
  }
}

/** The system prompt as text. An array of blocks is joined in order. */
function flattenSystemPrompt(prompt: StreamOptions['systemPrompt']): string {
  if (prompt === undefined) return '';
  if (typeof prompt === 'string') return prompt;
  return prompt
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

/** The tool names offered on a given call. */
export function offeredTools(model: ScriptedOperatorModel, callIndex = 0): string[] {
  return model.calls[callIndex]?.tools ?? [];
}
