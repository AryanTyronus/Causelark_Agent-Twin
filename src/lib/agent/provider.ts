// @polsia:user-owned — replaceable Strands provider boundary.
//
// Agent Twin execution runs on the official Strands Agents TypeScript SDK. Two
// model providers are selectable, explicitly, through `AGENT_PROVIDER`:
//
//   bedrock     (default) — `BedrockModel` drives the Amazon Bedrock Converse
//                API through `@aws-sdk/client-bedrock-runtime`. This is the
//                intended production/hackathon provider.
//   agentrouter — `OpenAIModel` (Strands' native OpenAI-compatible adapter) in
//                Chat Completions mode points at AgentRouter. This is a
//                DEVELOPMENT provider, so the Agent Twin can run locally
//                before AWS credentials exist.
//
// Both providers drive the same bounded Strands `Agent` over the same
// allow-listed simulation tools, so tool calling, validation, persistence,
// metrics and replay are identical either way — only the model client differs.
// There is no silent fallback: an unrecognised `AGENT_PROVIDER` fails the turn.
//
// AWS credentials are never read from application env vars; the AWS SDK resolves
// them through its standard credential provider chain (environment, shared
// config/credentials files, SSO, container/instance metadata, web identity).
// The AgentRouter API key is read from server-only env and never leaves this
// module: it is passed to the model client and is not part of any persisted or
// returned value.
//
// Only safe metadata crosses this boundary: the provider label, bounded loop
// counters, token usage, a stop reason, and a normalized error code. Prompts,
// model reasoning, and raw provider payloads are never returned for
// persistence.

import { Agent, type Model, type Tool } from '@strands-agents/sdk';
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import type { SimulationState } from '@/lib/contracts/simulation';
import type { SimulationAgentMetadata } from '@/lib/contracts/simulation-agent';
import { env } from '@/lib/env';

/** Provider label persisted with every turn and surfaced in the run inspector. */
export const BEDROCK_STRANDS_PROVIDER = 'Amazon Bedrock · Strands Agents SDK';
/** Development-provider label, persisted the same way so a run is never ambiguous. */
export const AGENTROUTER_STRANDS_PROVIDER = 'AgentRouter (development) · Strands Agents SDK';

/** The providers the Agent Twin can be pointed at. */
export type AgentProviderKind = 'bedrock' | 'agentrouter';

/**
 * Provider used when `AGENT_PROVIDER` is unset. Bedrock is the intended
 * provider, so an existing deployment that never sets the variable keeps
 * behaving exactly as before.
 */
export const DEFAULT_AGENT_PROVIDER: AgentProviderKind = 'bedrock';

/** AgentRouter's OpenAI-compatible base; the client appends `/chat/completions`. */
export const DEFAULT_AGENTROUTER_BASE_URL = 'https://agentrouter.org/v1';
/** Development model served through AgentRouter. */
export const DEFAULT_AGENTROUTER_MODEL = 'deepseek-v4-flash';

/** Output budget for a single model call. */
export const AGENT_MAX_OUTPUT_TOKENS = 1024;
/** Low temperature keeps tool choice stable; the model itself is never claimed deterministic. */
export const AGENT_TEMPERATURE = 0.2;
/** Model-call bound applied when the caller does not ask for one. */
export const DEFAULT_AGENT_LOOP_TURNS = 6;
/** Hard ceiling on model calls per bounded turn, whatever the caller asks for. */
export const MAX_AGENT_LOOP_TURNS = 12;

export type AgentProviderErrorCode =
  | 'missing_configuration'
  | 'missing_credentials'
  | 'access_denied'
  | 'throttled'
  | 'timeout'
  | 'provider_error';

/**
 * Operator- and client-safe text for each normalized failure. These strings are
 * persisted as failure details, so they must never carry credentials, request
 * bodies, or raw provider payloads.
 */
export const AGENT_PROVIDER_SAFE_MESSAGES: Record<AgentProviderErrorCode, string> = {
  missing_configuration:
    'Amazon Bedrock is not configured for the Agent Twin provider. Set BEDROCK_MODEL_ID (and a region) for this environment.',
  missing_credentials:
    'AWS credentials could not be resolved from the standard AWS credential provider chain.',
  access_denied:
    'Amazon Bedrock denied access to the configured model or region. Check the AWS identity policy and Bedrock model access.',
  throttled: 'Amazon Bedrock throttled the request. Retry the turn.',
  timeout: 'Amazon Bedrock did not answer within the configured turn timeout.',
  provider_error: 'The Amazon Bedrock provider returned an error.',
};

/**
 * Safe text for AgentRouter failures. The Bedrock record above is worded for
 * AWS, so the development provider carries its own: an operator reading a
 * failure should be told which provider and which variable to look at.
 */
export const AGENTROUTER_SAFE_MESSAGES: Record<AgentProviderErrorCode, string> = {
  missing_configuration:
    'AgentRouter is selected but not configured. Set AGENTROUTER_API_KEY (and optionally AGENTROUTER_BASE_URL and AGENTROUTER_MODEL) for this environment.',
  missing_credentials: 'AgentRouter rejected the configured API key. Check AGENTROUTER_API_KEY.',
  access_denied:
    'AgentRouter denied access to the configured model. Check AGENTROUTER_MODEL and the account entitlements for it.',
  throttled: 'AgentRouter throttled the request. Retry the turn.',
  timeout: 'AgentRouter did not answer within the configured turn timeout.',
  provider_error: 'The AgentRouter provider returned an error.',
};

/** Safe text for an unreadable `AGENT_PROVIDER` value. */
export const AGENT_PROVIDER_SELECTION_MESSAGE =
  'AGENT_PROVIDER is not a recognised provider. Use "bedrock" or "agentrouter".';

export class AgentProviderError extends Error {
  readonly code: AgentProviderErrorCode;

  constructor(code: AgentProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentProviderError';
    this.code = code;
  }
}

/** The subset of the environment the provider resolves its model configuration from. */
export interface BedrockEnvironment {
  BEDROCK_MODEL_ID?: string | undefined;
  BEDROCK_REGION?: string | undefined;
  AWS_REGION?: string | undefined;
}

export interface BedrockProviderConfiguration {
  /** Model ID pinned explicitly — never an SDK default that can drift between upgrades. */
  modelId: string;
  /**
   * Region override. `undefined` lets the AWS SDK resolve the region from its own
   * chain (AWS_REGION, AWS_DEFAULT_REGION, shared config, IMDS), which is the
   * documented AWS behaviour and keeps deployment configuration out of this file.
   */
  region: string | undefined;
}

function trimmed(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate ? candidate : undefined;
}

/**
 * Resolves the Bedrock model ID and region from configuration. A missing model ID
 * is a configuration failure rather than a silent fall back to the SDK default:
 * the model that gets billed should always be the model the operator chose.
 */
export function resolveBedrockConfiguration(
  source: BedrockEnvironment,
): BedrockProviderConfiguration {
  const modelId = trimmed(source.BEDROCK_MODEL_ID);
  if (!modelId)
    throw new AgentProviderError(
      'missing_configuration',
      AGENT_PROVIDER_SAFE_MESSAGES.missing_configuration,
    );
  return {
    modelId,
    region: trimmed(source.BEDROCK_REGION) ?? trimmed(source.AWS_REGION),
  };
}

/** The AgentRouter-facing environment: server-only credentials plus endpoint config. */
export interface AgentRouterEnvironment {
  AGENTROUTER_BASE_URL?: string | undefined;
  AGENTROUTER_API_KEY?: string | undefined;
  AGENTROUTER_MODEL?: string | undefined;
}

export interface AgentRouterConfiguration {
  /** OpenAI-compatible base URL; the SDK client appends `/chat/completions`. */
  baseUrl: string;
  /** Server-only credential. Never persisted, logged, or returned. */
  apiKey: string;
  modelId: string;
}

/**
 * Resolves the AgentRouter endpoint, credential and model.
 *
 * The endpoint is configuration rather than a literal so an operator can point
 * at a different deployment, but it defaults to the current AgentRouter origin.
 * A missing API key is a configuration failure: there is no anonymous mode, so
 * the turn fails visibly instead of dispatching an unauthenticated request.
 */
export function resolveAgentRouterConfiguration(
  source: AgentRouterEnvironment,
): AgentRouterConfiguration {
  const apiKey = trimmed(source.AGENTROUTER_API_KEY);
  if (!apiKey)
    throw new AgentProviderError(
      'missing_configuration',
      AGENTROUTER_SAFE_MESSAGES.missing_configuration,
    );
  return {
    baseUrl: trimmed(source.AGENTROUTER_BASE_URL) ?? DEFAULT_AGENTROUTER_BASE_URL,
    apiKey,
    modelId: trimmed(source.AGENTROUTER_MODEL) ?? DEFAULT_AGENTROUTER_MODEL,
  };
}

/** The full environment the provider resolves its selection and model from. */
export interface AgentProviderEnvironment extends BedrockEnvironment, AgentRouterEnvironment {
  AGENT_PROVIDER?: string | undefined;
}

/**
 * Resolves which provider backs the agent path.
 *
 * Selection is explicit and never falls back: a value that is not one of the
 * known providers is a configuration failure, so a typo cannot silently run a
 * different (and possibly billed) provider than the operator intended.
 */
export function resolveAgentProvider(source: AgentProviderEnvironment): AgentProviderKind {
  const requested = trimmed(source.AGENT_PROVIDER);
  if (!requested) return DEFAULT_AGENT_PROVIDER;
  if (requested === 'bedrock' || requested === 'agentrouter') return requested;
  throw new AgentProviderError('missing_configuration', AGENT_PROVIDER_SELECTION_MESSAGE);
}

/** The persisted label for a resolved provider. */
export function agentProviderLabel(provider: AgentProviderKind): string {
  return provider === 'agentrouter' ? AGENTROUTER_STRANDS_PROVIDER : BEDROCK_STRANDS_PROVIDER;
}

/**
 * The persisted label for the provider this environment selects, without
 * throwing. Used on failure paths, where the turn still has to record which
 * provider it was attempting — including when the selection itself was the
 * thing that failed.
 */
export function selectedProviderLabel(source: AgentProviderEnvironment): string {
  return agentProviderLabel(
    trimmed(source.AGENT_PROVIDER) === 'agentrouter' ? 'agentrouter' : DEFAULT_AGENT_PROVIDER,
  );
}

/**
 * Bounds the agent loop. Each Strands turn is one model call plus the tool
 * execution that follows it, so the bound is the number of model calls a single
 * invocation may make — never unbounded.
 */
export function clampAgentLoopTurns(requested?: number): number {
  if (requested === undefined) return DEFAULT_AGENT_LOOP_TURNS;
  if (!Number.isFinite(requested) || requested < 1) return DEFAULT_AGENT_LOOP_TURNS;
  return Math.min(Math.floor(requested), MAX_AGENT_LOOP_TURNS);
}

const CREDENTIAL_ERROR_NAMES = new Set([
  'CredentialsProviderError',
  'CredentialProviderError',
  'TokenProviderError',
  'InvalidCredentialsError',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'ExpiredTokenException',
  'ExpiredToken',
  // The OpenAI-compatible client raises these for a rejected or absent key.
  'AuthenticationError',
  'MissingApiKeyError',
]);

const ACCESS_DENIED_ERROR_NAMES = new Set([
  'AccessDeniedException',
  'AccessDeniedError',
  'AuthorizationException',
  'ModelAccessDeniedException',
  'ResourceNotFoundException',
  // OpenAI-compatible 403 / unknown-model responses.
  'PermissionDeniedError',
  'NotFoundError',
]);

const THROTTLED_ERROR_NAMES = new Set([
  'ThrottlingException',
  'Throttling',
  'ThrottlingError',
  'TooManyRequestsException',
  'ServiceQuotaExceededException',
  'ProvisionedThroughputExceededException',
  'ModelThrottledError',
  // OpenAI-compatible 429.
  'RateLimitError',
]);

const TIMEOUT_ERROR_NAMES = new Set([
  'TimeoutError',
  'AbortError',
  'TimeoutException',
  'RequestTimeout',
  'RequestTimeoutException',
  'ConnectionTimeoutError',
  'ConnectTimeoutError',
  // OpenAI-compatible client timeout and caller-cancelled request.
  'APIConnectionTimeoutError',
  'APIUserAbortError',
]);

/**
 * Built-in error names. They carry no provider signal, so they are never
 * reported as a classification detail — otherwise every plain `Error` would
 * decorate its safe message with a meaningless `[Error]`.
 */
const GENERIC_ERROR_NAMES = new Set([
  'Error',
  'Object',
  'Exception',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
]);

function identifierShaped(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') return undefined;
  const token = candidate.trim();
  // Only identifier-shaped names pass: SDK error names are enum-like, while
  // free-form messages could embed request details.
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(token)) return undefined;
  return GENERIC_ERROR_NAMES.has(token) ? undefined : token;
}

/**
 * The most specific safe name for a failure.
 *
 * AWS errors carry their name in `.name`. The OpenAI SDK, which backs the
 * AgentRouter provider, sets no `name` at all on any of its error classes — the
 * class identity lives on the constructor. Only SDK-side names are read: the
 * `code` and `type` fields on an OpenAI error are copied from the provider's
 * response body, so they are never echoed. The name is reported only when it is
 * identifier-shaped, so a message cannot smuggle request details into a
 * persisted safe error.
 */
function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as {
    name?: unknown;
    Code?: unknown;
    constructor?: { name?: unknown };
  };
  return (
    identifierShaped(record.name) ??
    identifierShaped(record.Code) ??
    identifierShaped(record.constructor?.name)
  );
}

/**
 * The HTTP status of an HTTP-based provider failure, when the error exposes one.
 * A status is the one signal that survives bundling and minification, which is
 * what makes it the primary classifier for the OpenAI-compatible provider.
 */
function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/** HTTP status → normalized code, for providers that report the response status. */
const STATUS_ERROR_CODES: Record<number, AgentProviderErrorCode> = {
  401: 'missing_credentials',
  403: 'access_denied',
  404: 'access_denied',
  408: 'timeout',
  429: 'throttled',
  504: 'timeout',
};

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '';
}

/** How far down a wrapped error chain classification will look before giving up. */
const MAX_ERROR_CAUSE_DEPTH = 8;

/**
 * Maps a provider/SDK failure onto the normalized error codes the API surfaces.
 *
 * The Strands SDK wraps every model failure in its own `ModelError`, keeping the
 * underlying provider error as `cause`. Classification therefore walks the
 * chain: the outer wrapper is generic, and the actionable signal (an
 * unreachable credential chain, an access denial, a throttle) lives further in.
 *
 * Two signals are read, both safe: the HTTP status when the provider exposes one
 * (the OpenAI-compatible classes set no `name`, so status is what identifies
 * them), and identifier-shaped error names. Messages are inspected solely for a
 * missing-region hint and are never forwarded.
 */
export function classifyProviderError(error: unknown): {
  code: AgentProviderErrorCode;
  detail: string | undefined;
} {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    if (current === undefined || current === null) break;
    const name = errorName(current);
    const status = statusCode(current);
    const byStatus = status === undefined ? undefined : STATUS_ERROR_CODES[status];
    // A status-classified failure is reported by its status: the SDK's own class
    // for a 504 is `InternalServerError`, which would contradict the timeout the
    // status actually identifies.
    if (byStatus && status !== undefined)
      return { code: byStatus, detail: statusErrorDetail(status) };
    if (name && CREDENTIAL_ERROR_NAMES.has(name))
      return { code: 'missing_credentials', detail: name };
    if (name && ACCESS_DENIED_ERROR_NAMES.has(name)) return { code: 'access_denied', detail: name };
    if (name && THROTTLED_ERROR_NAMES.has(name)) return { code: 'throttled', detail: name };
    if (name && TIMEOUT_ERROR_NAMES.has(name)) return { code: 'timeout', detail: name };
    current = (current as { cause?: unknown }).cause;
  }
  // Only the outermost name is reported: it is what the caller threw.
  const name = errorName(error);
  if (/region is missing/i.test(errorMessage(error)))
    return { code: 'missing_configuration', detail: name };
  return { code: 'provider_error', detail: name };
}

/** Fallback detail for a status-classified failure whose class name is unavailable. */
function statusErrorDetail(status: number): string {
  return `HTTP ${status}`;
}

function withDetail(base: string, detail?: string): string {
  return detail ? `${base} [${detail}]` : base;
}

/** The safe, persistable message for a Bedrock code plus an optional error-name hint. */
export function safeProviderMessage(code: AgentProviderErrorCode, detail?: string): string {
  return withDetail(AGENT_PROVIDER_SAFE_MESSAGES[code], detail);
}

/**
 * The safe message for a specific provider. A failure must never name the
 * provider that was not running, so the table is chosen from the selection
 * rather than from whatever the SDK happened to throw.
 */
export function safeProviderMessageFor(
  provider: AgentProviderKind,
  code: AgentProviderErrorCode,
  detail?: string,
): string {
  const base =
    provider === 'agentrouter'
      ? AGENTROUTER_SAFE_MESSAGES[code]
      : AGENT_PROVIDER_SAFE_MESSAGES[code];
  return withDetail(base, detail);
}

/**
 * Wraps any thrown value in a normalized, safe `AgentProviderError`. An existing
 * `AgentProviderError` — a configuration failure raised before the SDK was
 * reached — passes through untouched.
 */
export function toAgentProviderError(
  error: unknown,
  provider: AgentProviderKind = DEFAULT_AGENT_PROVIDER,
): AgentProviderError {
  if (error instanceof AgentProviderError) return error;
  const { code, detail } = classifyProviderError(error);
  return new AgentProviderError(code, safeProviderMessageFor(provider, code, detail), {
    cause: error,
  });
}

export interface ResourceAgentInvocation {
  objective: string;
  state: SimulationState;
  tools: Tool[];
  /** Wall-clock budget for the whole bounded invocation, including every model and tool call. */
  timeoutMs: number;
  /** Model-call bound for this invocation; clamped to `MAX_AGENT_LOOP_TURNS`. */
  maxTurns?: number;
  /** Upper bound on how many actions the agent should attempt this turn. */
  maxActions?: number;
}

export interface ResourceAgentResult {
  metadata: SimulationAgentMetadata;
  toolCallCount: number;
  acceptedToolCount: number;
  /** The Strands stop reason, persisted for observability (e.g. `endTurn`, `limitTurns`). */
  stopReason: string;
}

/**
 * The system prompt states the bounded working agreement: iterate, but through an
 * explicit allowance, and never narrate private reasoning.
 */
export function buildAgentSystemPrompt(input: {
  objective: string;
  maxActions: number;
  maxTurns: number;
}): string {
  return [
    'You are the Causelark Resource Management Agent Twin.',
    'You can only affect the environment through the allow-listed tools provided.',
    'Work in short bounded cycles: call observe_resources, then request_action, then observe again to confirm the result before deciding the next action.',
    `You may request at most ${input.maxActions} actions in this turn and you have at most ${input.maxTurns} model turns.`,
    'Stop as soon as the objective is reached, the environment is terminal, or no safe action remains. Do not repeat an action the environment already rejected.',
    'Report only observable facts and tool outcomes. Never describe private reasoning or hidden state.',
    `Objective: ${input.objective}`,
  ].join('\n');
}

function buildAgentUserPrompt(state: SimulationState): string {
  return [
    'Begin by observing the environment, then act.',
    `Observable state: ${JSON.stringify(state)}`,
  ].join('\n');
}

export interface AgentModelSelection {
  model: Model;
  /** Persisted label, so a run records which provider actually served it. */
  providerLabel: string;
}

/**
 * Builds the Strands model client for the selected provider.
 *
 * Both branches return a plain Strands `Model`, so everything downstream — the
 * bounded `Agent`, the allow-listed tools, tool execution, metrics and the
 * persisted metadata — is provider-independent. Only the client differs.
 *
 * Configuration is resolved before any client is constructed, so a missing
 * model ID or API key fails as a normalized configuration error rather than as
 * an opaque SDK throw.
 */
export function createAgentModel(
  provider: AgentProviderKind,
  source: AgentProviderEnvironment,
): AgentModelSelection {
  if (provider === 'agentrouter') {
    const configuration = resolveAgentRouterConfiguration(source);
    return {
      model: new OpenAIModel({
        // Chat Completions is the OpenAI-compatible surface AgentRouter exposes,
        // including the `tools` / `tool_calls` fields the agent loop depends on.
        api: 'chat',
        modelId: configuration.modelId,
        apiKey: configuration.apiKey,
        clientConfig: { baseURL: configuration.baseUrl },
        temperature: AGENT_TEMPERATURE,
        // `maxTokens` is deliberately not set: the adapter turns it into
        // `max_completion_tokens`, which is OpenAI's own newer field rather than
        // the `max_tokens` an OpenAI-*compatible* endpoint documents. The output
        // bound is still enforced, through the passthrough the adapter provides.
        params: { max_tokens: AGENT_MAX_OUTPUT_TOKENS },
      }),
      providerLabel: AGENTROUTER_STRANDS_PROVIDER,
    };
  }
  const configuration = resolveBedrockConfiguration(source);
  return {
    model: new BedrockModel({
      modelId: configuration.modelId,
      region: configuration.region,
      maxTokens: AGENT_MAX_OUTPUT_TOKENS,
      temperature: AGENT_TEMPERATURE,
    }),
    providerLabel: BEDROCK_STRANDS_PROVIDER,
  };
}

export async function invokeResourceAgent(
  input: ResourceAgentInvocation,
): Promise<ResourceAgentResult> {
  const provider = resolveAgentProvider(env);
  const maxTurns = clampAgentLoopTurns(input.maxTurns);
  const maxActions = Math.max(1, Math.floor(input.maxActions ?? 1));
  const startedAt = Date.now();
  const { model, providerLabel } = createAgentModel(provider, env);
  const agent = new Agent({
    model,
    tools: input.tools,
    printer: false,
    // The environment tools share mutable state, so tool calls must run one at a
    // time for the persisted transition order to match the model's intent.
    toolExecutor: 'sequential',
    systemPrompt: buildAgentSystemPrompt({
      objective: input.objective,
      maxActions,
      maxTurns,
    }),
  });
  try {
    const result = await agent.invoke(buildAgentUserPrompt(input.state), {
      limits: { turns: maxTurns },
      cancelSignal: AbortSignal.timeout(input.timeoutMs),
    });
    // The SDK reports an aborted invocation as a result rather than a throw, so
    // the timeout has to be read back off the stop reason.
    if (result.stopReason === 'cancelled')
      throw new AgentProviderError('timeout', safeProviderMessageFor(provider, 'timeout'));
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
        provider: providerLabel,
        requestStatus: 'completed',
        latencyMs: Date.now() - startedAt,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        safeError: null,
      },
      toolCallCount,
      acceptedToolCount,
      stopReason: result.stopReason,
    };
  } catch (error) {
    throw toAgentProviderError(error, provider);
  }
}
