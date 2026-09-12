// @polsia:user-owned — replaceable Strands provider boundary.
// The Strands model client is pointed at Polsia's AI proxy, never at a model
// vendor endpoint. No provider reasoning or hidden trace is persisted.

import { Agent, type Tool } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import type { SimulationState } from '@/lib/contracts/simulation';
import type { SimulationAgentMetadata } from '@/lib/contracts/simulation-agent';
import { env } from '@/lib/env';

export const POLSIA_STRANDS_PROVIDER = 'Polsia AI proxy · Strands Agents SDK';

export class AgentProviderError extends Error {
  readonly code: 'missing_configuration' | 'timeout' | 'provider_error';

  constructor(code: AgentProviderError['code'], message: string) {
    super(message);
    this.name = 'AgentProviderError';
    this.code = code;
  }
}

export interface ResourceAgentInvocation {
  objective: string;
  state: SimulationState;
  tools: Tool[];
  timeoutMs: number;
}

export interface ResourceAgentResult {
  metadata: SimulationAgentMetadata;
  toolCallCount: number;
  acceptedToolCount: number;
}

function safeMessage(error: unknown): string {
  if (error instanceof AgentProviderError) return error.message;
  if (error instanceof Error) return error.message.slice(0, 240);
  return 'The agent provider returned an unknown error.';
}

export async function invokeResourceAgent(
  input: ResourceAgentInvocation,
): Promise<ResourceAgentResult> {
  const apiKey = env.POLSIA_API_KEY ?? env.POLSIA_API_TOKEN;
  if (!apiKey)
    throw new AgentProviderError(
      'missing_configuration',
      'POLSIA_API_KEY is not configured for the Polsia AI proxy.',
    );
  const startedAt = Date.now();
  const model = new OpenAIModel({
    api: 'chat',
    apiKey,
    clientConfig: {
      baseURL: `${env.POLSIA_AI_BASE_URL.replace(/\/+$/, '')}/`,
      timeout: input.timeoutMs,
    },
    modelId: 'causelark-resource-agent',
    maxTokens: 512,
    temperature: 0.2,
  });
  const agent = new Agent({
    model,
    tools: input.tools,
    printer: false,
    toolExecutor: 'sequential',
    systemPrompt: [
      'You are the Causelark Resource Management Agent Twin.',
      'You can only interact with the environment through the explicit tools provided.',
      'Use observe_resources first, then request_action for a single safe action.',
      'Never assume hidden state, never describe private reasoning, and stop after a validated action.',
      `Objective: ${input.objective}`,
    ].join('\n'),
  });
  try {
    const result = await agent.invoke(
      `Choose the next action from this observable state. State: ${JSON.stringify(input.state)}`,
      { limits: { turns: 3 }, cancelSignal: AbortSignal.timeout(input.timeoutMs) },
    );
    const usage = result.metrics?.latestAgentInvocation?.usage;
    const toolMetrics = result.metrics?.toolMetrics ?? {};
    const toolCallCount = Object.values(toolMetrics).reduce(
      (total, item) => total + item.callCount,
      0,
    );
    const acceptedToolCount = Object.values(toolMetrics).reduce(
      (total, item) => total + item.successCount,
      0,
    );
    return {
      metadata: {
        provider: POLSIA_STRANDS_PROVIDER,
        requestStatus: 'completed',
        latencyMs: Date.now() - startedAt,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        safeError: null,
      },
      toolCallCount,
      acceptedToolCount,
    };
  } catch (error) {
    const message = safeMessage(error);
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new AgentProviderError(timedOut ? 'timeout' : 'provider_error', message);
  }
}
