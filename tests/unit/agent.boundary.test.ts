// @vitest-environment node
//
// Two model providers are selectable (Bedrock for AWS, OpenRouter for local
// development), and both are Strands model clients. This guard holds that line
// from the outside: the agent path may construct exactly those two clients, may
// reach no third provider — in particular not the raw `openai` package — and may
// not carry credentials in source.
// These assertions read the actual agent-path source files, so a regression
// cannot hide behind a passing runtime test.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AGENT_DIR = fileURLToPath(new URL('../../src/lib/agent', import.meta.url));
const AGENT_STEP_ROUTE = fileURLToPath(
  new URL('../../src/app/api/simulations/runs/[runId]/agent-step/route.ts', import.meta.url),
);

function readSource(file: string): string {
  return readFileSync(file, 'utf8');
}

const agentFiles = readdirSync(AGENT_DIR)
  .filter((entry) => entry.endsWith('.ts'))
  .sort();

const agentSources = agentFiles.map((entry) => ({
  name: `src/lib/agent/${entry}`,
  source: readSource(path.join(AGENT_DIR, entry)),
}));

function segment(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `expected to find "${from}"`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

const provider = readSource(path.join(AGENT_DIR, 'provider.ts'));

describe('agent path provider boundary', () => {
  it('covers every file in the agent module', () => {
    expect(agentFiles.length).toBeGreaterThan(0);
    expect(agentFiles).toContain('provider.ts');
    expect(agentFiles).toContain('resource-tools.ts');
    expect(agentFiles).toContain('resource-agent.ts');
    expect(agentFiles).toContain('run-turn.ts');
  });

  it.each(agentSources)(
    '$name reaches no provider outside the Strands model clients',
    ({ source }) => {
      // The raw `openai` package is off limits: the OpenRouter development
      // provider is reachable only through Strands' own OpenAI-compatible adapter,
      // so the agent loop keeps
      // running inside Strands' tool-calling machinery either way.
      expect(source).not.toMatch(/from\s+['"]openai['"]/);
      expect(source).not.toMatch(/require\(\s*['"]openai['"]\s*\)/);
      // AgentRouter was replaced by OpenRouter. No part of the agent path may
      // still reach for it, including through a stale base URL.
      expect(source).not.toMatch(/agentrouter/i);
      // Every import specifier in the agent path: the Strands adapter is the
      // only OpenAI-flavoured module that may be imported, so no other
      // OpenAI-compatible client can enter through a dependency.
      const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)]
        .map((match) => match[1])
        .filter((specifier): specifier is string => specifier !== undefined);
      for (const specifier of specifiers) {
        if (/openai/i.test(specifier)) expect(specifier).toBe('@strands-agents/sdk/models/openai');
      }
    },
  );

  it('keeps the agent-step route off any other provider', () => {
    const route = readSource(AGENT_STEP_ROUTE);

    expect(route).not.toMatch(/from\s+['"]openai['"]/);
    expect(route).not.toMatch(/require\(\s*['"]openai['"]\s*\)/);
    expect(route).toMatch(/from '@\/lib\/agent\/run-turn'/);
  });

  it.each(agentSources)('$name reads configuration through validated env only', ({ source }) => {
    // Configuration must flow through `@/lib/env`; reading `process.env`
    // directly would bypass validation and could smuggle in a default provider.
    expect(source).not.toMatch(/process\.env/);
  });

  it.each(agentSources)('$name carries no credentials or secrets in source', ({ source }) => {
    expect(source).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(source).not.toMatch(/aws_secret_access_key/i);
    expect(source).not.toMatch(/secretAccessKey\s*[:=]\s*['"`]/);
    expect(source).not.toMatch(/sessionToken\s*[:=]\s*['"`]/);
    expect(source).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(source).not.toMatch(/credentials\s*:\s*\{/);
  });

  it.each(agentSources)('$name does not log provider internals', ({ source }) => {
    // Provider errors can carry request identifiers and identity ARNs; nothing
    // in the agent path may write them to a stream we do not control.
    expect(source).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });
});

describe('selectable model providers', () => {
  it('constructs only the two selectable Strands model clients', () => {
    expect(provider).toMatch(
      /import\s*\{\s*BedrockModel\s*\}\s*from\s*'@strands-agents\/sdk\/models\/bedrock'/,
    );
    expect(provider).toMatch(
      /import\s*\{\s*OpenAIModel\s*\}\s*from\s*'@strands-agents\/sdk\/models\/openai'/,
    );
    // Exactly two model clients are constructed anywhere in the boundary — the
    // native Bedrock one and the Strands OpenAI-compatible one — and nothing
    // else, so no third provider can be reached by editing this file alone.
    const modelConstructors = [...provider.matchAll(/new\s+([A-Za-z_$][\w$]*Model)\(/g)].map(
      (match) => match[1],
    );
    expect(modelConstructors).toEqual(['OpenAIModel', 'BedrockModel']);
  });

  it('takes the Bedrock model ID and region from configuration, never from a literal', () => {
    const resolver = segment(
      provider,
      'export function resolveBedrockConfiguration',
      'export function',
    );

    expect(resolver).toMatch(/source\.BEDROCK_MODEL_ID/);
    // The region half is resolved by its own function so an agent *selection*
    // can name a model without the deployment having to name one too. The
    // property is unchanged — the region still comes from configuration — so it
    // is asserted where it now lives.
    expect(resolver).toMatch(/resolveBedrockRegion\(source\)/);
    const region = segment(provider, 'export function resolveBedrockRegion', '\n}');
    expect(region).toMatch(/source\.BEDROCK_REGION/);
    expect(region).toMatch(/source\.AWS_REGION/);
    // No baked-in model or provider default: an unconfigured deployment must
    // fail rather than silently bill against an SDK default model.
    expect(resolver).not.toMatch(/claude|anthropic|amazon|nova|titan|llama|mistral|cohere/i);
    expect(region).not.toMatch(/claude|anthropic|amazon|nova|titan|llama|mistral|cohere/i);
  });

  it('takes the OpenRouter endpoint, credential and model from configuration', () => {
    const resolver = segment(
      provider,
      'export function resolveOpenRouterConfiguration',
      'export function',
    );
    const endpoint = segment(
      provider,
      'export function resolveOpenRouterEndpoint',
      'export function',
    );

    // The model is the caller's; the endpoint and credential are the
    // deployment's. Splitting them is what lets a selection name a model
    // without carrying — or being able to leak — a credential.
    expect(endpoint).toMatch(/source\.OPENROUTER_BASE_URL/);
    expect(endpoint).toMatch(/source\.OPENROUTER_API_KEY/);
    expect(resolver).toMatch(/source\.OPENROUTER_MODEL/);
    expect(resolver).toMatch(/resolveOpenRouterEndpoint\(source\)/);
    // The endpoint is the only permitted provider host literal in the agent
    // path, and it is the OpenAI-compatible base of the current provider.
    const hosts = [...provider.matchAll(/https?:\/\/([^'"\s]+)/g)].map((match) => match[1]);
    expect(hosts).toEqual(['openrouter.ai/api/v1']);
    // An unset key or model must fail rather than dispatch an unauthenticated
    // request, or run a model the operator never chose.
    expect(endpoint).toMatch(/if\s*\(!apiKey\)/);
    expect(resolver).toMatch(/if\s*\(!modelId\)/);
  });

  it('carries no trace of the provider OpenRouter replaced', () => {
    // A stale AgentRouter reference anywhere on the boundary — a variable, a
    // default endpoint, a safe message — would be a development provider the
    // operator cannot select and cannot see failing.
    expect(provider).not.toMatch(/agentrouter/i);
  });

  it('passes each provider its own configuration and nothing else', () => {
    const factory = segment(provider, 'export function createAgentModelFor', '\n}');

    expect(factory).toMatch(/new OpenAIModel\(/);
    expect(factory).toMatch(/api:\s*'chat'/);
    // The model comes from the selection; the credential and endpoint come from
    // the environment. Neither can be supplied by the other.
    expect(factory).toMatch(/modelId:\s*selection\.modelId/);
    expect(factory).toMatch(/resolveOpenRouterEndpoint\(source\)/);
    expect(factory).toMatch(/baseURL:\s*baseUrl/);
    expect(factory).toMatch(/apiKey,/);
    expect(factory).toMatch(/new BedrockModel\(/);
    expect(factory).toMatch(/region:\s*resolveBedrockRegion\(source\)/);
    // The key is read in exactly one place on the boundary and reaches the
    // model client and nothing else.
    expect(provider.match(/source\.OPENROUTER_API_KEY/g)).toHaveLength(1);
    expect(factory).not.toMatch(/source\.OPENROUTER_API_KEY/);
    expect(factory).not.toMatch(/process\.env/);
  });

  it('lets a selection name a model but never a credential', () => {
    const selection = segment(provider, 'export interface AgentSelection', '\n}');
    expect(selection).toMatch(/provider:\s*AgentProviderKind/);
    expect(selection).toMatch(/modelId:\s*string/);
    // A selection travels through a request, an experiment definition and a
    // report, so anything credential-shaped on it would leak by construction.
    expect(selection).not.toMatch(/apiKey|secret|token|password|credential/i);

    // And a selection that names a provider this build cannot construct is
    // refused here rather than reaching a model client.
    const parse = segment(provider, 'export function parseAgentProviderKind', '\n}');
    expect(parse).toMatch(/'bedrock'\s*\|\|\s*requested\s*===\s*'openrouter'/);
    expect(parse).toMatch(/throw new AgentProviderError/);

    const resolve = segment(provider, 'export function resolveAgentSelection', '\n}');
    expect(resolve).toMatch(/input:\s*\{\s*provider:\s*string/);
    expect(resolve).toMatch(/model:\s*string/);
    expect(resolve).toMatch(/parseAgentProviderKind\(input\.provider\)/);
    expect(resolve).toMatch(/requireModelId\(input\.model\)/);
  });

  it('bounds a single invocation on both axes: model turns and wall-clock time', () => {
    expect(provider).toMatch(/limits:\s*\{\s*turns:\s*maxTurns\s*\}/);
    expect(provider).toMatch(/AbortSignal\.timeout\(input\.timeoutMs\)/);
    // A run-away loop is impossible even if a caller passes a wild bound.
    expect(provider).toMatch(/MAX_AGENT_LOOP_TURNS/);
    expect(provider).toMatch(/clampAgentLoopTurns/);
    expect(provider).not.toMatch(/while\s*\(\s*true\s*\)/);
  });

  it('runs tools sequentially because they share the environment state', () => {
    expect(provider).toMatch(/toolExecutor:\s*'sequential'/);
  });

  it('never persists or returns raw provider messages as a safe error', () => {
    expect(provider).toMatch(/AGENT_PROVIDER_SAFE_MESSAGES/);
    // The safe-error field is explicitly nulled on success rather than carrying
    // an SDK message through.
    expect(provider).toMatch(/safeError:\s*null/);
  });
});

describe('agent-step route runtime', () => {
  it('declares the Node.js runtime the AWS SDK requires', () => {
    const route = readSource(AGENT_STEP_ROUTE);

    expect(route).toMatch(/export const runtime = 'nodejs'/);
    expect(route).toMatch(/export const dynamic = 'force-dynamic'/);
  });
});
