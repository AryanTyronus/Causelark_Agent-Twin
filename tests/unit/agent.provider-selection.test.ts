// @vitest-environment node
//
// OpenRouter is the development provider; Bedrock stays the intended AWS one.
// These tests hold the selection contract itself: which provider a given
// configuration selects, that an unreadable value fails instead of falling back,
// that each provider builds only its own model client, and that the OpenRouter
// credential never reaches a persisted or returned value.
//
// The Strands SDK and both model clients are mocked at the provider boundary, so
// no test here needs an OpenRouter API key, an AWS credential, or a network
// call. A real OpenRouter round trip is a separate, live boundary: it is not
// exercised here and is not claimed by this suite.

import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {} as {
    AGENT_PROVIDER?: string | undefined;
    OPENROUTER_BASE_URL?: string | undefined;
    OPENROUTER_API_KEY?: string | undefined;
    OPENROUTER_MODEL?: string | undefined;
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
  AgentProviderError,
  agentProviderLabel,
  BEDROCK_STRANDS_PROVIDER,
  classifyProviderError,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_OPENROUTER_BASE_URL,
  invokeResourceAgent,
  OPENROUTER_SAFE_MESSAGES,
  OPENROUTER_STRANDS_PROVIDER,
  type ResourceAgentInvocation,
  resolveAgentProvider,
  resolveOpenRouterConfiguration,
  selectedProviderLabel,
  toAgentProviderError,
} from '@/lib/agent/provider';
import { createInitialSimulationState } from '@/lib/business/simulation';

const BEDROCK_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
/** A value that must never appear in a returned or persisted field. */
const API_KEY = 'sk-openrouter-test-key-that-must-not-leak';
/**
 * An arbitrary catalogue ID. The suite deliberately does not treat any model as
 * *the* OpenRouter model: the model is configuration, and the tests below assert
 * only that whatever is configured is what reaches the client.
 */
const OPENROUTER_MODEL = 'vendor/model-under-test';

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

function configureOpenRouter(overrides: Record<string, string | undefined> = {}) {
  mocks.env.AGENT_PROVIDER = 'openrouter';
  mocks.env.OPENROUTER_API_KEY = API_KEY;
  mocks.env.OPENROUTER_MODEL = OPENROUTER_MODEL;
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
    ['openrouter', 'openrouter'],
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

  it.each([
    // The removed provider is not a recognised value: a deployment still
    // carrying AGENT_PROVIDER=agentrouter must fail loudly, not run Bedrock.
    ['agentrouter'],
    ['AgentRouter'],
    ['OpenRouter'],
    ['BEDROCK'],
    ['openai'],
    ['bedrock '],
    ['open-router'],
    [''],
  ])('fails safely on the unreadable value %j rather than guessing a provider', (configured) => {
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
  });

  it('never falls back to another provider: a bad selection builds no model at all', async () => {
    mocks.env.AGENT_PROVIDER = 'gpt';
    mocks.env.OPENROUTER_API_KEY = API_KEY;
    mocks.env.OPENROUTER_MODEL = OPENROUTER_MODEL;
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
    expect(agentProviderLabel('openrouter')).toBe(OPENROUTER_STRANDS_PROVIDER);
    expect(OPENROUTER_STRANDS_PROVIDER).not.toBe(BEDROCK_STRANDS_PROVIDER);
  });

  it('labels the selected provider without throwing, including on a bad selection', () => {
    expect(selectedProviderLabel({})).toBe(BEDROCK_STRANDS_PROVIDER);
    expect(selectedProviderLabel({ AGENT_PROVIDER: 'openrouter' })).toBe(
      OPENROUTER_STRANDS_PROVIDER,
    );
    // Never claims OpenRouter on an unreadable value, and never throws on the
    // failure path where the label still has to be recorded.
    expect(selectedProviderLabel({ AGENT_PROVIDER: 'nonsense' })).toBe(BEDROCK_STRANDS_PROVIDER);
    // The removed provider is not a label this build can produce.
    expect(selectedProviderLabel({ AGENT_PROVIDER: 'agentrouter' })).toBe(BEDROCK_STRANDS_PROVIDER);
  });

  it('never names a removed provider in any safe message', () => {
    const messages = [
      ...Object.values(OPENROUTER_SAFE_MESSAGES),
      ...Object.values(AGENT_PROVIDER_SAFE_MESSAGES),
      AGENT_PROVIDER_SELECTION_MESSAGE,
    ];
    for (const message of messages) expect(message).not.toMatch(/agentrouter/i);
  });
});

describe('OpenRouter configuration', () => {
  it('defaults to the OpenRouter OpenAI-compatible endpoint', () => {
    expect(DEFAULT_OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1');

    expect(
      resolveOpenRouterConfiguration({
        OPENROUTER_API_KEY: API_KEY,
        OPENROUTER_MODEL: OPENROUTER_MODEL,
      }),
    ).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: API_KEY,
      modelId: OPENROUTER_MODEL,
    });
  });

  it('has no default model, so the model is always an explicit choice', () => {
    // Configuration rather than a baked-in catalogue entry: an unchosen model
    // must fail rather than silently run and bill against one.
    const error = (() => {
      try {
        return resolveOpenRouterConfiguration({
          OPENROUTER_API_KEY: API_KEY,
          OPENROUTER_MODEL: undefined,
        });
      } catch (thrown: unknown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(AgentProviderError);
    expect((error as AgentProviderError).code).toBe('missing_configuration');
    expect((error as AgentProviderError).message).toBe(
      OPENROUTER_SAFE_MESSAGES.missing_configuration,
    );
  });

  it('honours an overridden endpoint and model, so both are configuration', () => {
    expect(
      resolveOpenRouterConfiguration({
        OPENROUTER_API_KEY: ` ${API_KEY} `,
        OPENROUTER_BASE_URL: ' https://openrouter.internal.example/api/v1 ',
        OPENROUTER_MODEL: ' some/other-model ',
      }),
    ).toEqual({
      baseUrl: 'https://openrouter.internal.example/api/v1',
      apiKey: API_KEY,
      modelId: 'some/other-model',
    });
  });

  it.each([[undefined], [''], ['   ']])(
    'fails with missing_configuration when the API key is %j rather than calling anonymously',
    (apiKey) => {
      const error = (() => {
        try {
          return resolveOpenRouterConfiguration({
            OPENROUTER_API_KEY: apiKey,
            OPENROUTER_MODEL: OPENROUTER_MODEL,
          });
        } catch (thrown: unknown) {
          return thrown;
        }
      })();

      expect(error).toBeInstanceOf(AgentProviderError);
      expect((error as AgentProviderError).code).toBe('missing_configuration');
      expect((error as AgentProviderError).message).toBe(
        OPENROUTER_SAFE_MESSAGES.missing_configuration,
      );
    },
  );

  it.each([
    ['no key', { OPENROUTER_MODEL: OPENROUTER_MODEL }],
    ['no model', { OPENROUTER_API_KEY: API_KEY }],
    ['neither', {}],
  ])('fails before touching the provider when OpenRouter is selected with %s', async (_, env) => {
    mocks.env.AGENT_PROVIDER = 'openrouter';
    Object.assign(mocks.env, env);
    mocks.invokeResult = usageResult();

    const error = (await invoke().catch((thrown: unknown) => thrown)) as AgentProviderError;

    expect(error.code).toBe('missing_configuration');
    expect(error.message).toBe(OPENROUTER_SAFE_MESSAGES.missing_configuration);
    expect(mocks.openAiConfigs).toHaveLength(0);
    expect(mocks.invocations).toHaveLength(0);
  });

  it('does not require a Bedrock model ID to run OpenRouter', async () => {
    configureOpenRouter();
    mocks.invokeResult = usageResult();

    const result = await invoke();

    expect(result.metadata.provider).toBe(OPENROUTER_STRANDS_PROVIDER);
    expect(mocks.bedrockConfigs).toHaveLength(0);
  });

  it('does not fall forward to OpenRouter when Bedrock is selected but unconfigured', async () => {
    mocks.env.AGENT_PROVIDER = 'bedrock';
    mocks.env.OPENROUTER_API_KEY = API_KEY;
    mocks.env.OPENROUTER_MODEL = OPENROUTER_MODEL;
    mocks.invokeResult = usageResult();

    const error = (await invoke().catch((thrown: unknown) => thrown)) as AgentProviderError;

    expect(error.code).toBe('missing_configuration');
    expect(error.message).toBe(AGENT_PROVIDER_SAFE_MESSAGES.missing_configuration);
    // The configured development provider was available and still not used.
    expect(mocks.bedrockConfigs).toHaveLength(0);
    expect(mocks.openAiConfigs).toHaveLength(0);
    expect(mocks.invocations).toHaveLength(0);
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

  it('builds the Strands OpenAI-compatible client, and only it, for OpenRouter', async () => {
    mocks.env.AGENT_PROVIDER = 'openrouter';
    mocks.env.OPENROUTER_API_KEY = API_KEY;
    mocks.env.OPENROUTER_MODEL = OPENROUTER_MODEL;
    mocks.invokeResult = usageResult();

    const result = await invoke();

    expect(mocks.openAiConfigs).toHaveLength(1);
    expect(mocks.openAiConfigs[0]).toMatchObject({
      // Chat Completions is the OpenAI-compatible surface that carries the
      // `tools` / `tool_calls` fields the tool loop depends on.
      api: 'chat',
      modelId: OPENROUTER_MODEL,
      // The credential reaches the model client on the server side only.
      apiKey: API_KEY,
      clientConfig: { baseURL: 'https://openrouter.ai/api/v1' },
      // The output bound goes out as `max_tokens`, the field an
      // OpenAI-compatible endpoint documents, not OpenAI's own
      // `max_completion_tokens` — which `maxTokens` would have produced.
      params: { max_tokens: AGENT_MAX_OUTPUT_TOKENS },
    });
    expect(mocks.openAiConfigs[0]?.maxTokens).toBeUndefined();
    // Bedrock is not constructed at all when OpenRouter is selected.
    expect(mocks.bedrockConfigs).toHaveLength(0);
    expect(result.metadata.provider).toBe(OPENROUTER_STRANDS_PROVIDER);
  });

  it('points the client at the configured endpoint and model', async () => {
    configureOpenRouter({
      OPENROUTER_BASE_URL: 'https://openrouter.internal.example/api/v1',
      OPENROUTER_MODEL: 'some/other-model',
    });
    mocks.invokeResult = usageResult();

    await invoke();

    expect(mocks.openAiConfigs[0]).toMatchObject({
      modelId: 'some/other-model',
      clientConfig: { baseURL: 'https://openrouter.internal.example/api/v1' },
    });
  });

  it('runs both providers through the identical bounded tool loop', async () => {
    mocks.env.BEDROCK_MODEL_ID = BEDROCK_MODEL_ID;
    mocks.invokeResult = usageResult();
    await invoke({ tools: stubTools, maxTurns: 5 });

    configureOpenRouter();
    await invoke({ tools: stubTools, maxTurns: 5 });

    expect(mocks.agentConfigs).toHaveLength(2);
    const [bedrockAgent, openRouterAgent] = mocks.agentConfigs;
    // Provider choice cannot bypass validation: the model sees exactly the
    // caller-supplied allow-listed toolbox, sequentially, under the same bounds.
    for (const config of [bedrockAgent, openRouterAgent]) {
      expect(config).toMatchObject({
        tools: stubTools,
        printer: false,
        toolExecutor: 'sequential',
      });
    }
    expect(openRouterAgent?.systemPrompt).toBe(bedrockAgent?.systemPrompt);
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

    configureOpenRouter();
    mocks.invokeResult = usageResult();
    const openRouter = await invoke();

    expect(openRouter.toolCallCount).toBe(bedrock.toolCallCount);
    expect(openRouter.acceptedToolCount).toBe(bedrock.acceptedToolCount);
    expect(openRouter.stopReason).toBe(bedrock.stopReason);
    // Everything but the provider label and wall-clock latency is identical.
    const { latencyMs: _bedrockLatency, ...bedrockMetadata } = bedrock.metadata;
    const { latencyMs: _openRouterLatency, ...openRouterMetadata } = openRouter.metadata;
    expect(openRouterMetadata).toEqual({
      ...bedrockMetadata,
      provider: OPENROUTER_STRANDS_PROVIDER,
    });
  });

  it('treats a cancelled OpenRouter invocation as a timeout, not a crash', async () => {
    configureOpenRouter();
    mocks.invokeResult = { stopReason: 'cancelled' };

    const error = (await invoke().catch((thrown: unknown) => thrown)) as AgentProviderError;

    expect(error.code).toBe('timeout');
    expect(error.message).toBe(OPENROUTER_SAFE_MESSAGES.timeout);
  });
});

describe('OpenRouter credential containment', () => {
  it('returns metadata that carries no credential or request body', async () => {
    configureOpenRouter();
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
  ])('maps an OpenRouter %s to %s with OpenRouter-worded safe text', (name, expected) => {
    mocks.env.AGENT_PROVIDER = 'openrouter';
    mocks.env.OPENROUTER_API_KEY = API_KEY;
    mocks.env.OPENROUTER_MODEL = OPENROUTER_MODEL;

    const error = toAgentProviderError(providerError(name), 'openrouter');

    expect(error.code).toBe(expected);
    expect(error.message).toBe(`${OPENROUTER_SAFE_MESSAGES[expected as never]} [${name}]`);
    // OpenRouter failures are described in OpenRouter's terms, not AWS's.
    expect(error.message).not.toBe(AGENT_PROVIDER_SAFE_MESSAGES[expected as never]);
  });

  it('classifies an OpenRouter failure wrapped by the SDK without leaking the key', async () => {
    configureOpenRouter();
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
      `${OPENROUTER_SAFE_MESSAGES.missing_credentials} [AuthenticationError]`,
    );
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain('Bearer');
    expect(error.message).not.toContain('Incorrect API key provided');
    expect(String(error.stack ?? '')).not.toContain(API_KEY);
  });

  it('keeps the AWS error taxonomy intact for the Bedrock provider', () => {
    // The OpenRouter additions must not reclassify any AWS failure.
    expect(toAgentProviderError(providerError('AccessDeniedException'), 'bedrock').message).toBe(
      `${AGENT_PROVIDER_SAFE_MESSAGES.access_denied} [AccessDeniedException]`,
    );
    expect(toAgentProviderError(providerError('ThrottlingException'), 'bedrock').code).toBe(
      'throttled',
    );
    // And an unreadable name never reaches the message.
    expect(
      toAgentProviderError(providerError('Invalid body {"k":"v"}'), 'openrouter').message,
    ).toBe(OPENROUTER_SAFE_MESSAGES.provider_error);
  });
});

describe('OpenRouter error classification against the real OpenAI SDK classes', () => {
  // The OpenAI SDK sets no `name` on any of its error classes, so a classifier
  // that reads only `.name` reports every OpenRouter failure as a generic
  // provider error. These cases use the SDK's own error objects rather than
  // hand-made names, because hand-made names cannot catch that.
  //
  // The body is a representative OpenRouter-shaped error envelope. It is a
  // fixture, not a captured live response: no live OpenRouter call is made by
  // this suite.
  const unauthorizedBody = {
    error: {
      message: 'No auth credentials found',
      code: 401,
    },
  };

  function apiError(status: number, body: object = unauthorizedBody) {
    return OpenAI.APIError.generate(status, body, undefined, new Headers());
  }

  it.each([
    [401, 'missing_credentials'],
    [402, 'access_denied'],
    [403, 'access_denied'],
    [404, 'access_denied'],
    [408, 'timeout'],
    [429, 'throttled'],
    [504, 'timeout'],
  ])('maps a real HTTP %i failure to %s', (status, expected) => {
    const error = toAgentProviderError(apiError(status), 'openrouter');

    expect(error.code).toBe(expected);
    expect(error.message).toBe(`${OPENROUTER_SAFE_MESSAGES[expected as never]} [HTTP ${status}]`);
  });

  it.each([400, 500, 502, 503])(
    'keeps HTTP %i a provider error rather than over-claiming a cause',
    (status) => {
      expect(toAgentProviderError(apiError(status), 'openrouter').code).toBe('provider_error');
    },
  );

  it('maps a connection timeout and a caller cancellation to timeout', () => {
    expect(toAgentProviderError(new OpenAI.APIConnectionTimeoutError(), 'openrouter').code).toBe(
      'timeout',
    );
    expect(toAgentProviderError(new OpenAI.APIUserAbortError(), 'openrouter').code).toBe('timeout');
  });

  it('classifies an OpenRouter failure the SDK wrapped, as Strands always does', () => {
    // Strands wraps every model failure in its own ModelError with the provider
    // error as `cause`, so classification has to walk the chain.
    const wrapped = new Error('ModelError', { cause: apiError(429) });

    expect(classifyProviderError(wrapped).code).toBe('throttled');
    expect(toAgentProviderError(wrapped, 'openrouter').code).toBe('throttled');
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

    const error = toAgentProviderError(leaky, 'openrouter');

    expect(error.message).toBe(`${OPENROUTER_SAFE_MESSAGES.missing_credentials} [HTTP 401]`);
    expect(error.message).not.toContain('sk-live');
    expect(error.message).not.toContain('abcdef0123456789');
  });

  it('reports no detail for a plain Error instead of a meaningless one', () => {
    expect(classifyProviderError(new Error('leaky'))).toEqual({
      code: 'provider_error',
      detail: undefined,
    });
    expect(toAgentProviderError(new Error('leaky'), 'openrouter').message).toBe(
      OPENROUTER_SAFE_MESSAGES.provider_error,
    );
  });
});
