// @vitest-environment node
// @polsia:user-owned — provider selection between Bedrock and AgentRouter.
//
// AgentRouter is the development provider; Bedrock stays the intended AWS one.
// These tests hold the selection contract itself: which provider a given
// configuration selects, that an unreadable value fails instead of falling back,
// that each provider builds only its own model client, and that the AgentRouter
// credential never reaches a persisted or returned value.
//
// The Strands SDK and both model clients are mocked at the provider boundary, so
// no test here needs an AgentRouter API key, an AWS credential, or a network
// call. The real AgentRouter round trip is verified separately, under an
// explicit credential, outside the normal suite.

import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {} as {
    AGENT_PROVIDER?: string | undefined;
    AGENTROUTER_BASE_URL?: string | undefined;
    AGENTROUTER_API_KEY?: string | undefined;
    AGENTROUTER_MODEL?: string | undefined;
    BEDROCK_MODEL_ID?: string | undefined;
    BEDROCK_REGION?: string | undefined;
    AWS_REGION?: string | undefined;
  },
  agentConfigs: [] as Array<Record<string, unknown>>,
  bedrockConfigs: [] as Array<Record<string, unknown>>,
  openAiConfigs: [] as Array<Record<string, unknown>>,
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

vi.mock('@strands-agents/sdk/models/openai', () => ({
  OpenAIModel: class {
    constructor(options: unknown) {
      mocks.openAiConfigs.push(options as Record<string, unknown>);
    }
  },
}));

import type { Tool } from '@strands-agents/sdk';

import {
  AGENT_MAX_OUTPUT_TOKENS,
  AGENT_PROVIDER_SAFE_MESSAGES,
  AGENT_PROVIDER_SELECTION_MESSAGE,
  AGENTROUTER_SAFE_MESSAGES,
  AGENTROUTER_STRANDS_PROVIDER,
  AgentProviderError,
  agentProviderLabel,
  BEDROCK_STRANDS_PROVIDER,
  classifyProviderError,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENTROUTER_BASE_URL,
  DEFAULT_AGENTROUTER_MODEL,
  invokeResourceAgent,
  type ResourceAgentInvocation,
  resolveAgentProvider,
  resolveAgentRouterConfiguration,
  selectedProviderLabel,
  toAgentProviderError,
} from '@/lib/agent/provider';
import { createInitialSimulationState } from '@/lib/business/simulation';

const BEDROCK_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
/** A value that must never appear in a returned or persisted field. */
const API_KEY = 'sk-agentrouter-test-key-that-must-not-leak';

const state = createInitialSimulationState('resource-routing', 'complete-delivery', 9182);
const stubTools = [{ name: 'observe_resources' }, { name: 'request_action' }] as unknown as Tool[];

function usageResult(overrides: Record<string, unknown> = {}) {
  return {
    stopReason: 'endTurn',
    metrics: {
      latestAgentInvocation: { usage: { inputTokens: 640, outputTokens: 88 } },
      toolMetrics: {
        observe_resources: { callCount: 2, successCount: 2, errorCount: 0, totalTime: 1 },
        request_action: { callCount: 2, successCount: 1, errorCount: 1, totalTime: 1 },
      },
    },
    ...overrides,
  };
}

function providerError(name: string, message = 'raw provider payload'): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function invoke(overrides: Partial<ResourceAgentInvocation> = {}) {
  return invokeResourceAgent({
    objective: 'Route enough material into the delivery objective before limits.',
    state,
    tools: stubTools,
    timeoutMs: 1000,
    maxTurns: 4,
    maxActions: 2,
    ...overrides,
  });
}

function configureAgentRouter(overrides: Record<string, string | undefined> = {}) {
  mocks.env.AGENT_PROVIDER = 'agentrouter';
  mocks.env.AGENTROUTER_API_KEY = API_KEY;
  Object.assign(mocks.env, overrides);
}

afterEach(() => {
  for (const key of Object.keys(mocks.env)) {
    delete mocks.env[key as keyof typeof mocks.env];
  }
  mocks.agentConfigs.length = 0;
  mocks.bedrockConfigs.length = 0;
  mocks.openAiConfigs.length = 0;
  mocks.invocations.length = 0;
  mocks.invokeResult = undefined;
  mocks.invokeError = undefined;
});

describe('AGENT_PROVIDER selection', () => {
  it.each([
    ['agentrouter', 'agentrouter'],
    ['bedrock', 'bedrock'],
  ])('selects %s when AGENT_PROVIDER=%s', (configured, expected) => {
    expect(resolveAgentProvider({ AGENT_PROVIDER: configured })).toBe(expected);
  });

  it('defaults to Bedrock so an existing deployment keeps its behaviour', () => {
    expect(DEFAULT_AGENT_PROVIDER).toBe('bedrock');
    expect(resolveAgentProvider({})).toBe('bedrock');
    expect(resolveAgentProvider({ AGENT_PROVIDER: undefined })).toBe('bedrock');
    expect(resolveAgentProvider({ AGENT_PROVIDER: '   ' })).toBe('bedrock');
  });

  it.each([['AgentRouter'], ['BEDROCK'], ['openai'], ['bedrock '], ['agent-router'], ['']])(
    'fails safely on the unreadable value %j rather than guessing a provider',
    (configured) => {
      // A trailing-space value is the one exception: it trims to a known
      // provider. Every other value must fail.
      if (configured === 'bedrock ') {
        expect(resolveAgentProvider({ AGENT_PROVIDER: configured })).toBe('bedrock');
        return;
      }
      const error = (() => {
        try {
          return resolveAgentProvider({ AGENT_PROVIDER: configured });
        } catch (thrown: unknown) {
          return thrown;
        }
      })();

      if (configured === '') {
        // An empty string is "unset" under emptyStringAsUndefined, not a typo.
        expect(error).toBe('bedrock');
        return;
      }
      expect(error).toBeInstanceOf(AgentProviderError);
      expect((error as AgentProviderError).code).toBe('missing_configuration');
      expect((error as AgentProviderError).message).toBe(AGENT_PROVIDER_SELECTION_MESSAGE);
    },
  );

  it('never falls back to another provider: a bad selection builds no model at all', async () => {
    mocks.env.AGENT_PROVIDER = 'gpt';
    mocks.env.AGENTROUTER_API_KEY = API_KEY;
    mocks.env.BEDROCK_MODEL_ID = BEDROCK_MODEL_ID;
    mocks.invokeResult = usageResult();

    const error = (await invoke().catch((thrown: unknown) => thrown)) as AgentProviderError;

    expect(error).toBeInstanceOf(AgentProviderError);
    expect(error.code).toBe('missing_configuration');
    // Neither provider was constructed and no request was attempted: a typo
    // cannot bill against a provider the operator did not choose.
    expect(mocks.bedrockConfigs).toHaveLength(0);
    expect(mocks.openAiConfigs).toHaveLength(0);
    expect(mocks.agentConfigs).toHaveLength(0);
    expect(mocks.invocations).toHaveLength(0);
  });
});

describe('provider labels', () => {
  it('labels each provider distinctly so a run is never ambiguous', () => {
    expect(agentProviderLabel('bedrock')).toBe(BEDROCK_STRANDS_PROVIDER);
    expect(agentProviderLabel('agentrouter')).toBe(AGENTROUTER_STRANDS_PROVIDER);
    expect(AGENTROUTER_STRANDS_PROVIDER).not.toBe(BEDROCK_STRANDS_PROVIDER);
  });

  it('labels the selected provider without throwing, including on a bad selection', () => {
    expect(selectedProviderLabel({})).toBe(BEDROCK_STRANDS_PROVIDER);
    expect(selectedProviderLabel({ AGENT_PROVIDER: 'agentrouter' })).toBe(
      AGENTROUTER_STRANDS_PROVIDER,
    );
    // Never claims AgentRouter on an unreadable value, and never throws on the
    // failure path where the label still has to be recorded.
    expect(selectedProviderLabel({ AGENT_PROVIDER: 'nonsense' })).toBe(BEDROCK_STRANDS_PROVIDER);
  });
});

describe('AgentRouter configuration', () => {
  it('defaults to the current AgentRouter endpoint and the DeepSeek development model', () => {
    expect(DEFAULT_AGENTROUTER_BASE_URL).toBe('https://agentrouter.org/v1');
    expect(DEFAULT_AGENTROUTER_BASE_URL).toMatch(/^https:\/\/agentrouter\.org/);
    // The retired origin must not reappear anywhere in the provider.
    expect(DEFAULT_AGENTROUTER_BASE_URL).not.toContain('co.agentrouter.org');
    expect(DEFAULT_AGENTROUTER_MODEL).toBe('deepseek-v4-flash');

    expect(resolveAgentRouterConfiguration({ AGENTROUTER_API_KEY: API_KEY })).toEqual({
      baseUrl: 'https://agentrouter.org/v1',
      apiKey: API_KEY,
      modelId: 'deepseek-v4-flash',
    });
  });

  it('honours an overridden endpoint and model, so the endpoint is configuration', () => {
    expect(
      resolveAgentRouterConfiguration({
        AGENTROUTER_API_KEY: ` ${API_KEY} `,
        AGENTROUTER_BASE_URL: ' https://agentrouter.internal.example/v1 ',
        AGENTROUTER_MODEL: ' deepseek-v4 ',
      }),
    ).toEqual({
      baseUrl: 'https://agentrouter.internal.example/v1',
      apiKey: API_KEY,
      modelId: 'deepseek-v4',
    });
  });

  it.each([[undefined], [''], ['   ']])(
    'fails with missing_configuration when the API key is %j rather than calling anonymously',
    (apiKey) => {
      const error = (() => {
        try {
          return resolveAgentRouterConfiguration({ AGENTROUTER_API_KEY: apiKey });
        } catch (thrown: unknown) {
          return thrown;
        }
      })();

      expect(error).toBeInstanceOf(AgentProviderError);
      expect((error as AgentProviderError).code).toBe('missing_configuration');
      expect((error as AgentProviderError).message).toBe(
        AGENTROUTER_SAFE_MESSAGES.missing_configuration,
      );
    },
  );

  it('fails before touching the provider when AgentRouter is selected without a key', async () => {
    mocks.env.AGENT_PROVIDER = 'agentrouter';
    mocks.invokeResult = usageResult();

    const error = (await invoke().catch((thrown: unknown) => thrown)) as AgentProviderError;

    expect(error.code).toBe('missing_configuration');
    expect(error.message).toBe(AGENTROUTER_SAFE_MESSAGES.missing_configuration);
    expect(mocks.openAiConfigs).toHaveLength(0);
    expect(mocks.invocations).toHaveLength(0);
  });

  it('does not require a Bedrock model ID to run AgentRouter', async () => {
    configureAgentRouter();
    mocks.invokeResult = usageResult();

    const result = await invoke();

    expect(result.metadata.provider).toBe(AGENTROUTER_STRANDS_PROVIDER);
    expect(mocks.bedrockConfigs).toHaveLength(0);
  });
});

describe('model construction per provider', () => {
  it('builds the native Bedrock model, and only it, for AGENT_PROVIDER=bedrock', async () => {
    mocks.env.AGENT_PROVIDER = 'bedrock';
    mocks.env.BEDROCK_MODEL_ID = BEDROCK_MODEL_ID;
    mocks.env.BEDROCK_REGION = 'eu-west-1';
    mocks.invokeResult = usageResult();

    const result = await invoke();

    expect(mocks.bedrockConfigs).toHaveLength(1);
    expect(mocks.bedrockConfigs[0]).toMatchObject({
      modelId: BEDROCK_MODEL_ID,
      region: 'eu-west-1',
    });
    expect(mocks.openAiConfigs).toHaveLength(0);
    expect(result.metadata.provider).toBe(BEDROCK_STRANDS_PROVIDER);
  });

  it('builds the Strands OpenAI-compatible client, and only it, for AgentRouter', async () => {
    mocks.env.AGENT_PROVIDER = 'agentrouter';
    mocks.env.AGENTROUTER_API_KEY = API_KEY;
    mocks.invokeResult = usageResult();

    const result = await invoke();

    expect(mocks.openAiConfigs).toHaveLength(1);
    expect(mocks.openAiConfigs[0]).toMatchObject({
      // Chat Completions is the OpenAI-compatible surface that carries the
      // `tools` / `tool_calls` fields the tool loop depends on.
      api: 'chat',
      modelId: 'deepseek-v4-flash',
      apiKey: API_KEY,
      clientConfig: { baseURL: 'https://agentrouter.org/v1' },
      // The output bound goes out as `max_tokens`, the field an
      // OpenAI-compatible endpoint documents, not OpenAI's own
      // `max_completion_tokens` — which `maxTokens` would have produced.
      params: { max_tokens: AGENT_MAX_OUTPUT_TOKENS },
    });
    expect(mocks.openAiConfigs[0]?.maxTokens).toBeUndefined();
    // Bedrock is not constructed at all when AgentRouter is selected.
    expect(mocks.bedrockConfigs).toHaveLength(0);
    expect(result.metadata.provider).toBe(AGENTROUTER_STRANDS_PROVIDER);
  });

  it('points the client at the configured endpoint and model', async () => {
    configureAgentRouter({
      AGENTROUTER_BASE_URL: 'https://agentrouter.internal.example/v1',
      AGENTROUTER_MODEL: 'deepseek-v4',
    });
    mocks.invokeResult = usageResult();

    await invoke();

    expect(mocks.openAiConfigs[0]).toMatchObject({
      modelId: 'deepseek-v4',
      clientConfig: { baseURL: 'https://agentrouter.internal.example/v1' },
    });
  });

  it('runs both providers through the identical bounded tool loop', async () => {
    mocks.env.BEDROCK_MODEL_ID = BEDROCK_MODEL_ID;
    mocks.invokeResult = usageResult();
    await invoke({ tools: stubTools, maxTurns: 5 });

    configureAgentRouter();
    await invoke({ tools: stubTools, maxTurns: 5 });

    expect(mocks.agentConfigs).toHaveLength(2);
    const [bedrockAgent, agentRouterAgent] = mocks.agentConfigs;
    // Provider choice cannot bypass validation: the model sees exactly the
    // caller-supplied allow-listed toolbox, sequentially, under the same bounds.
    for (const config of [bedrockAgent, agentRouterAgent]) {
      expect(config).toMatchObject({
        tools: stubTools,
        printer: false,
        toolExecutor: 'sequential',
      });
    }
    expect(agentRouterAgent?.systemPrompt).toBe(bedrockAgent?.systemPrompt);
    expect(mocks.invocations.map((call) => call.options.limits)).toEqual([
      { turns: 5 },
      { turns: 5 },
    ]);
    for (const call of mocks.invocations) {
      expect(call.options.cancelSignal).toBeInstanceOf(AbortSignal);
    }
  });

  it('reports the same safe metrics shape through either provider', async () => {
    mocks.env.BEDROCK_MODEL_ID = BEDROCK_MODEL_ID;
    mocks.invokeResult = usageResult();
    const bedrock = await invoke();

    configureAgentRouter();
    mocks.invokeResult = usageResult();
    const agentRouter = await invoke();

    expect(agentRouter.toolCallCount).toBe(bedrock.toolCallCount);
    expect(agentRouter.acceptedToolCount).toBe(bedrock.acceptedToolCount);
    expect(agentRouter.stopReason).toBe(bedrock.stopReason);
    // Everything but the provider label and wall-clock latency is identical.
    const { latencyMs: _bedrockLatency, ...bedrockMetadata } = bedrock.metadata;
    const { latencyMs: _agentRouterLatency, ...agentRouterMetadata } = agentRouter.metadata;
    expect(agentRouterMetadata).toEqual({
      ...bedrockMetadata,
      provider: AGENTROUTER_STRANDS_PROVIDER,
    });
  });

  it('treats a cancelled AgentRouter invocation as a timeout, not a crash', async () => {
    configureAgentRouter();
    mocks.invokeResult = { stopReason: 'cancelled' };

    const error = (await invoke().catch((thrown: unknown) => thrown)) as AgentProviderError;

    expect(error.code).toBe('timeout');
    expect(error.message).toBe(AGENTROUTER_SAFE_MESSAGES.timeout);
  });
});

describe('AgentRouter credential containment', () => {
  it('returns metadata that carries no credential or request body', async () => {
    configureAgentRouter();
    mocks.invokeResult = usageResult();

    const result = await invoke();

    expect(Object.keys(result.metadata).sort()).toEqual([
      'inputTokens',
      'latencyMs',
      'outputTokens',
      'provider',
      'requestStatus',
      'safeError',
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Bearer');
  });

  it.each([
    ['AuthenticationError', 'missing_credentials'],
    ['MissingApiKeyError', 'missing_credentials'],
    ['PermissionDeniedError', 'access_denied'],
    ['NotFoundError', 'access_denied'],
    ['RateLimitError', 'throttled'],
    ['APIConnectionTimeoutError', 'timeout'],
    ['APIUserAbortError', 'timeout'],
    ['APIError', 'provider_error'],
  ])('maps an AgentRouter %s to %s with AgentRouter-worded safe text', (name, expected) => {
    mocks.env.AGENT_PROVIDER = 'agentrouter';
    mocks.env.AGENTROUTER_API_KEY = API_KEY;

    const error = toAgentProviderError(providerError(name), 'agentrouter');

    expect(error.code).toBe(expected);
    expect(error.message).toBe(`${AGENTROUTER_SAFE_MESSAGES[expected as never]} [${name}]`);
    // AgentRouter failures are described in AgentRouter's terms, not AWS's.
    expect(error.message).not.toBe(AGENT_PROVIDER_SAFE_MESSAGES[expected as never]);
  });

  it('classifies an AgentRouter failure wrapped by the SDK without leaking the key', async () => {
    configureAgentRouter();
    // Strands wraps every model error in its own ModelError with the provider
    // error as the cause, so the taxonomy has to be read off the cause chain.
    const inner = providerError(
      'AuthenticationError',
      `Incorrect API key provided: ${API_KEY}. Authorization: Bearer ${API_KEY}`,
    );
    const wrapped = new Error('ModelError', { cause: new Error('wrapped', { cause: inner }) });
    wrapped.name = 'ModelError';
    mocks.invokeError = wrapped;

    const error = (await invoke().catch((thrown: unknown) => thrown)) as AgentProviderError;

    expect(error.code).toBe('missing_credentials');
    expect(error.message).toBe(
      `${AGENTROUTER_SAFE_MESSAGES.missing_credentials} [AuthenticationError]`,
    );
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain('Bearer');
    expect(error.message).not.toContain('Incorrect API key provided');
    expect(String(error.stack ?? '')).not.toContain(API_KEY);
  });

  it('keeps the AWS error taxonomy intact for the Bedrock provider', () => {
    // The AgentRouter additions must not reclassify any AWS failure.
    expect(toAgentProviderError(providerError('AccessDeniedException'), 'bedrock').message).toBe(
      `${AGENT_PROVIDER_SAFE_MESSAGES.access_denied} [AccessDeniedException]`,
    );
    expect(toAgentProviderError(providerError('ThrottlingException'), 'bedrock').code).toBe(
      'throttled',
    );
    // And an unreadable name never reaches the message.
    expect(
      toAgentProviderError(providerError('Invalid body {"k":"v"}'), 'agentrouter').message,
    ).toBe(AGENTROUTER_SAFE_MESSAGES.provider_error);
  });
});

describe('AgentRouter error classification against the real OpenAI SDK classes', () => {
  // The OpenAI SDK sets no `name` on any of its error classes, so a classifier
  // that reads only `.name` reports every AgentRouter failure as a generic
  // provider error. These cases use the SDK's own error objects rather than
  // hand-made names, because hand-made names cannot catch that.
  //
  // `liveUnauthorizedBody` is the body the live https://agentrouter.org/v1
  // endpoint actually returned to an unauthenticated request.
  const liveUnauthorizedBody = {
    error: {
      message:
        'unauthorized client detected, contact support for assistance at https://discord.gg/HgekCyHJqB',
    },
    message: 'UNAUTHENTICATED',
    success: false,
    type: 'unauthorized_client_error',
  };

  function apiError(status: number, body: object = liveUnauthorizedBody) {
    return OpenAI.APIError.generate(status, body, undefined, new Headers());
  }

  it.each([
    [401, 'missing_credentials'],
    [403, 'access_denied'],
    [404, 'access_denied'],
    [408, 'timeout'],
    [429, 'throttled'],
    [504, 'timeout'],
  ])('maps a real HTTP %i failure to %s', (status, expected) => {
    const error = toAgentProviderError(apiError(status), 'agentrouter');

    expect(error.code).toBe(expected);
    expect(error.message).toBe(`${AGENTROUTER_SAFE_MESSAGES[expected as never]} [HTTP ${status}]`);
  });

  it.each([400, 500, 503])(
    'keeps HTTP %i a provider error rather than over-claiming a cause',
    (status) => {
      expect(toAgentProviderError(apiError(status), 'agentrouter').code).toBe('provider_error');
    },
  );

  it('maps a connection timeout and a caller cancellation to timeout', () => {
    expect(toAgentProviderError(new OpenAI.APIConnectionTimeoutError(), 'agentrouter').code).toBe(
      'timeout',
    );
    expect(toAgentProviderError(new OpenAI.APIUserAbortError(), 'agentrouter').code).toBe(
      'timeout',
    );
  });

  it('classifies an AgentRouter failure the SDK wrapped, as Strands always does', () => {
    // Strands wraps every model failure in its own ModelError with the provider
    // error as `cause`, so classification has to walk the chain.
    const wrapped = new Error('ModelError', { cause: apiError(429) });

    expect(classifyProviderError(wrapped).code).toBe('throttled');
    expect(toAgentProviderError(wrapped, 'agentrouter').code).toBe('throttled');
  });

  it('never echoes a body-derived field, which the provider controls', () => {
    // An OpenAI error copies `code` and `type` straight from the response body.
    // Those are provider-controlled, so they must not be echoed into a message
    // that gets persisted.
    const leaky = apiError(401, {
      error: { message: 'denied' },
      type: 'sk-live-abcdef0123456789',
      code: 'sk-live-abcdef0123456789',
    });

    const error = toAgentProviderError(leaky, 'agentrouter');

    expect(error.message).toBe(`${AGENTROUTER_SAFE_MESSAGES.missing_credentials} [HTTP 401]`);
    expect(error.message).not.toContain('sk-live');
    expect(error.message).not.toContain('abcdef0123456789');
  });

  it('reports no detail for a plain Error instead of a meaningless one', () => {
    expect(classifyProviderError(new Error('leaky'))).toEqual({
      code: 'provider_error',
      detail: undefined,
    });
    expect(toAgentProviderError(new Error('leaky'), 'agentrouter').message).toBe(
      AGENTROUTER_SAFE_MESSAGES.provider_error,
    );
  });
});
