// @vitest-environment node
//
// The Strands SDK and the Bedrock model client are mocked at the provider
// boundary: these tests never construct an AWS client, never resolve
// credentials, and never make a network call. Real Bedrock invocation is an
// external boundary verified separately with valid AWS credentials.

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {} as {
    BEDROCK_MODEL_ID?: string | undefined;
    BEDROCK_REGION?: string | undefined;
    AWS_REGION?: string | undefined;
  },
  agentConfigs: [] as Array<Record<string, unknown>>,
  bedrockConfigs: [] as Array<Record<string, unknown>>,
  invocations: [] as Array<{ args: unknown; options: Record<string, unknown> }>,
  invokeResult: undefined as unknown,
  invokeError: undefined as unknown,
}));

vi.mock('@/lib/env', () => ({ env: mocks.env }));

vi.mock('@strands-agents/sdk', () => ({
  Agent: class {
    constructor(config: unknown) {
      mocks.agentConfigs.push(config as Record<string, unknown>);
    }
    async invoke(args: unknown, options: Record<string, unknown>) {
      mocks.invocations.push({ args, options });
      if (mocks.invokeError) throw mocks.invokeError;
      return mocks.invokeResult;
    }
  },
}));

vi.mock('@strands-agents/sdk/models/bedrock', () => ({
  BedrockModel: class {
    constructor(options: unknown) {
      mocks.bedrockConfigs.push(options as Record<string, unknown>);
    }
  },
}));

import type { Tool } from '@strands-agents/sdk';

import {
  AGENT_PROVIDER_SAFE_MESSAGES,
  AgentProviderError,
  BEDROCK_STRANDS_PROVIDER,
  buildAgentSystemPrompt,
  clampAgentLoopTurns,
  classifyProviderError,
  DEFAULT_AGENT_LOOP_TURNS,
  invokeResourceAgent,
  MAX_AGENT_LOOP_TURNS,
  type ResourceAgentInvocation,
  resolveBedrockConfiguration,
  safeProviderMessage,
  toAgentProviderError,
} from '@/lib/agent/provider';
import { createInitialSimulationState } from '@/lib/business/simulation';

const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

const state = createInitialSimulationState('resource-routing', 'complete-delivery', 9182);

/** The SDK is mocked, so a name is all the provider ever reads from a tool here. */
const toolNames = ['observe_resources', 'request_action'];
const stubTools = toolNames.map((name) => ({ name })) as unknown as Tool[];

function usageResult(overrides: Record<string, unknown> = {}) {
  return {
    stopReason: 'endTurn',
    metrics: {
      latestAgentInvocation: { usage: { inputTokens: 812, outputTokens: 96 } },
      toolMetrics: {
        observe_resources: { callCount: 2, successCount: 2, errorCount: 0, totalTime: 1 },
        request_action: { callCount: 3, successCount: 2, errorCount: 1, totalTime: 1 },
      },
    },
    ...overrides,
  };
}

async function invoke(overrides: Partial<ResourceAgentInvocation> = {}) {
  return invokeResourceAgent({
    objective: 'Route enough material into the delivery objective before limits.',
    state,
    tools: stubTools,
    timeoutMs: 1000,
    maxTurns: 5,
    maxActions: 2,
    ...overrides,
  });
}

function awsError(name: string, message = 'provider detail that must not leak'): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

afterEach(() => {
  mocks.env.BEDROCK_MODEL_ID = undefined;
  mocks.env.BEDROCK_REGION = undefined;
  mocks.env.AWS_REGION = undefined;
  mocks.agentConfigs.length = 0;
  mocks.bedrockConfigs.length = 0;
  mocks.invocations.length = 0;
  mocks.invokeResult = undefined;
  mocks.invokeError = undefined;
});

describe('Bedrock provider configuration', () => {
  it('builds the native Bedrock model from the configured model ID and region', async () => {
    mocks.env.BEDROCK_MODEL_ID = MODEL_ID;
    mocks.env.BEDROCK_REGION = 'eu-west-1';
    mocks.env.AWS_REGION = 'us-east-1';
    mocks.invokeResult = usageResult();

    await invoke();

    expect(mocks.bedrockConfigs).toHaveLength(1);
    expect(mocks.bedrockConfigs[0]).toMatchObject({ modelId: MODEL_ID, region: 'eu-west-1' });
  });

  it('honours the environment for both model ID and region', async () => {
    mocks.env.BEDROCK_MODEL_ID = 'anthropic.claude-3-5-haiku-20241022-v1:0';
    mocks.env.BEDROCK_REGION = 'ap-southeast-2';
    mocks.invokeResult = usageResult();

    await invoke();

    expect(mocks.bedrockConfigs[0]).toMatchObject({
      modelId: 'anthropic.claude-3-5-haiku-20241022-v1:0',
      region: 'ap-southeast-2',
    });
  });

  it('falls back to AWS_REGION and then to the AWS SDK region chain', () => {
    expect(
      resolveBedrockConfiguration({ BEDROCK_MODEL_ID: MODEL_ID, AWS_REGION: 'us-west-2' }),
    ).toEqual({ modelId: MODEL_ID, region: 'us-west-2' });
    // Both unset: `region: undefined` lets the AWS SDK resolve region itself.
    expect(resolveBedrockConfiguration({ BEDROCK_MODEL_ID: MODEL_ID })).toEqual({
      modelId: MODEL_ID,
      region: undefined,
    });
  });

  it('fails with missing_configuration instead of silently using an SDK default model', async () => {
    mocks.env.BEDROCK_MODEL_ID = undefined;
    mocks.invokeResult = usageResult();

    const error = await invoke().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AgentProviderError);
    expect((error as AgentProviderError).code).toBe('missing_configuration');
    expect((error as AgentProviderError).message).toBe(
      AGENT_PROVIDER_SAFE_MESSAGES.missing_configuration,
    );
    // No model was constructed and no request was attempted.
    expect(mocks.bedrockConfigs).toHaveLength(0);
    expect(mocks.invocations).toHaveLength(0);
  });

  it('treats a blank model ID as missing configuration', () => {
    expect(() => resolveBedrockConfiguration({ BEDROCK_MODEL_ID: '   ' })).toThrowError(
      AgentProviderError,
    );
  });
});

describe('Bedrock provider invocation', () => {
  it('invokes Strands with the allow-listed tools and a bounded, timeout-guarded turn', async () => {
    mocks.env.BEDROCK_MODEL_ID = MODEL_ID;
    mocks.invokeResult = usageResult();
    const tools = [{ name: 'observe_resources' }, { name: 'request_action' }] as unknown as Tool[];

    await invoke({ tools, maxTurns: 5 });

    expect(mocks.agentConfigs).toHaveLength(1);
    expect(mocks.agentConfigs[0]).toMatchObject({
      tools,
      printer: false,
      toolExecutor: 'sequential',
    });
    expect(mocks.invocations).toHaveLength(1);
    expect(mocks.invocations[0]?.options.limits).toEqual({ turns: 5 });
    expect(mocks.invocations[0]?.options.cancelSignal).toBeInstanceOf(AbortSignal);
  });

  it('clamps the model-call bound so a mistuned caller can never run unbounded', () => {
    expect(clampAgentLoopTurns(DEFAULT_AGENT_LOOP_TURNS)).toBe(DEFAULT_AGENT_LOOP_TURNS);
    expect(clampAgentLoopTurns(undefined)).toBe(DEFAULT_AGENT_LOOP_TURNS);
    expect(clampAgentLoopTurns(0)).toBe(DEFAULT_AGENT_LOOP_TURNS);
    expect(clampAgentLoopTurns(-4)).toBe(DEFAULT_AGENT_LOOP_TURNS);
    expect(clampAgentLoopTurns(Number.NaN)).toBe(DEFAULT_AGENT_LOOP_TURNS);
    expect(clampAgentLoopTurns(3)).toBe(3);
    expect(clampAgentLoopTurns(3.9)).toBe(3);
    expect(clampAgentLoopTurns(10_000)).toBe(MAX_AGENT_LOOP_TURNS);
  });

  it('returns only safe metadata and tool counters', async () => {
    mocks.env.BEDROCK_MODEL_ID = MODEL_ID;
    mocks.invokeResult = usageResult();

    const result = await invoke();

    expect(result.metadata).toEqual({
      provider: BEDROCK_STRANDS_PROVIDER,
      requestStatus: 'completed',
      latencyMs: expect.any(Number),
      inputTokens: 812,
      outputTokens: 96,
      safeError: null,
    });
    expect(result.metadata.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.toolCallCount).toBe(5);
    expect(result.acceptedToolCount).toBe(4);
    expect(result.stopReason).toBe('endTurn');
  });

  it('reports missing usage as null rather than inventing numbers', async () => {
    mocks.env.BEDROCK_MODEL_ID = MODEL_ID;
    mocks.invokeResult = { stopReason: 'endTurn' };

    const result = await invoke();

    expect(result.metadata.inputTokens).toBeNull();
    expect(result.metadata.outputTokens).toBeNull();
    expect(result.toolCallCount).toBe(0);
  });

  it('treats an SDK-cancelled invocation as a timeout', async () => {
    mocks.env.BEDROCK_MODEL_ID = MODEL_ID;
    mocks.invokeResult = { stopReason: 'cancelled' };

    const error = await invoke().catch((thrown: unknown) => thrown);

    expect((error as AgentProviderError).code).toBe('timeout');
  });

  it('records a bounded loop trip as a normal completed turn', async () => {
    mocks.env.BEDROCK_MODEL_ID = MODEL_ID;
    mocks.invokeResult = usageResult({ stopReason: 'limitTurns' });

    const result = await invoke();

    expect(result.stopReason).toBe('limitTurns');
    expect(result.metadata.requestStatus).toBe('completed');
  });

  it('keeps the system prompt bounded and free of chain-of-thought instructions', () => {
    const prompt = buildAgentSystemPrompt({ objective: 'Deliver.', maxActions: 3, maxTurns: 7 });

    expect(prompt).toContain('observe_resources');
    expect(prompt).toContain('request_action');
    expect(prompt).toContain('at most 3 actions');
    expect(prompt).toContain('at most 7 model turns');
    expect(prompt).toContain('Never describe private reasoning');
  });
});

describe('provider error normalization', () => {
  it.each([
    ['CredentialsProviderError', 'missing_credentials'],
    ['TokenProviderError', 'missing_credentials'],
    ['UnrecognizedClientException', 'missing_credentials'],
    ['ExpiredTokenException', 'missing_credentials'],
    ['AccessDeniedException', 'access_denied'],
    ['ResourceNotFoundException', 'access_denied'],
    ['ThrottlingException', 'throttled'],
    ['ServiceQuotaExceededException', 'throttled'],
    ['ModelThrottledError', 'throttled'],
    ['TimeoutError', 'timeout'],
    ['AbortError', 'timeout'],
    ['RequestTimeoutException', 'timeout'],
    ['SomethingUnexpectedException', 'provider_error'],
  ])('maps %s to %s', (name, expected) => {
    expect(classifyProviderError(awsError(name)).code).toBe(expected);
  });

  it('maps a missing-region failure to missing_configuration', () => {
    expect(classifyProviderError(new Error('Region is missing')).code).toBe(
      'missing_configuration',
    );
  });

  it('classifies non-Error throws without crashing', () => {
    expect(classifyProviderError('boom').code).toBe('provider_error');
    expect(classifyProviderError(undefined).code).toBe('provider_error');
    expect(classifyProviderError(null).code).toBe('provider_error');
  });

  it('normalizes SDK failures without leaking credentials or provider payloads', async () => {
    mocks.env.BEDROCK_MODEL_ID = MODEL_ID;
    mocks.invokeError = awsError(
      'AccessDeniedException',
      'User: arn:aws:iam::123456789012:user/x is not authorized; AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE',
    );

    const error = (await invoke().catch((thrown: unknown) => thrown)) as AgentProviderError;

    expect(error.code).toBe('access_denied');
    expect(error.message).toBe(safeProviderMessage('access_denied', 'AccessDeniedException'));
    expect(error.message).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(error.message).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(error.message).not.toContain('arn:aws:iam');
    expect(error.message).not.toContain('provider detail that must not leak');
  });

  it('passes an existing AgentProviderError through unchanged', () => {
    const original = new AgentProviderError('throttled', AGENT_PROVIDER_SAFE_MESSAGES.throttled);
    expect(toAgentProviderError(original)).toBe(original);
  });

  it('never echoes a free-form error name that could carry request details', () => {
    const error = new Error('leaky');
    error.name = 'Invalid request: body {"secret":"abc"}';
    expect(classifyProviderError(error).detail).toBeUndefined();
    expect(toAgentProviderError(error).message).toBe(AGENT_PROVIDER_SAFE_MESSAGES.provider_error);
  });
});
