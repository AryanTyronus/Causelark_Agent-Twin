// @vitest-environment node
// @polsia:user-owned — static guard on the Agent Twin provider boundary.
//
// Two model providers are selectable (Bedrock for AWS, OpenRouter for local
// development), and both are Strands model clients. This guard holds that line
// from the outside: the agent path may construct exactly those two clients, may
// reach no third provider — in particular not the raw `openai` package nor the
// Polsia OpenAI-compatible proxy — and may not carry credentials in source.
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
      // The raw `openai` package and the Polsia OpenAI-compatible proxy are both
      // off limits: the OpenRouter development provider is reachable only
      // through Strands' own OpenAI-compatible adapter, so the agent loop keeps
      // running inside Strands' tool-calling machinery either way.
      expect(source).not.toMatch(/from\s+['"]openai['"]/);
      expect(source).not.toMatch(/require\(\s*['"]openai['"]\s*\)/);
      expect(source).not.toMatch(/POLSIA_/);
      expect(source).not.toMatch(/polsia[-_]?ai/i);
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

    // Every file in this repository carries the user-owned ownership banner, so
    // it is stripped before looking for a provider reference: what must not
    // appear here is the legacy OpenAI-compatible proxy, not the marker.
    expect(route.replace(/@polsia:user-owned/g, '')).not.toMatch(/openai|polsia/i);
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
    expect(resolver).toMatch(/source\.BEDROCK_REGION/);
    expect(resolver).toMatch(/source\.AWS_REGION/);
    // No baked-in model or provider default: an unconfigured deployment must
    // fail rather than silently bill against an SDK default model.
    expect(resolver).not.toMatch(/claude|anthropic|amazon|nova|titan|llama|mistral|cohere/i);
  });

  it('takes the OpenRouter endpoint, credential and model from configuration', () => {
    const resolver = segment(
      provider,
      'export function resolveOpenRouterConfiguration',
      'export function',
    );

    expect(resolver).toMatch(/source\.OPENROUTER_BASE_URL/);
    expect(resolver).toMatch(/source\.OPENROUTER_API_KEY/);
    expect(resolver).toMatch(/source\.OPENROUTER_MODEL/);
    // The endpoint is the only permitted provider host literal in the agent
    // path, and it is the OpenAI-compatible base of the current provider.
    const hosts = [...provider.matchAll(/https?:\/\/([^'"\s]+)/g)].map((match) => match[1]);
    expect(hosts).toEqual(['openrouter.ai/api/v1']);
    // An unset key or model must fail rather than dispatch an unauthenticated
    // request, or run a model the operator never chose.
    expect(resolver).toMatch(/if\s*\(!apiKey\s*\|\|\s*!modelId\)/);
  });

  it('carries no trace of the provider OpenRouter replaced', () => {
    // A stale AgentRouter reference anywhere on the boundary — a variable, a
    // default endpoint, a safe message — would be a development provider the
    // operator cannot select and cannot see failing.
    expect(provider).not.toMatch(/agentrouter/i);
  });

  it('passes each provider its own configuration and nothing else', () => {
    const factory = segment(provider, 'export function createAgentModel', '\n}');

    expect(factory).toMatch(/new OpenAIModel\(/);
    expect(factory).toMatch(/api:\s*'chat'/);
    expect(factory).toMatch(/modelId:\s*configuration\.modelId/);
    expect(factory).toMatch(/apiKey:\s*configuration\.apiKey/);
    expect(factory).toMatch(/baseURL:\s*configuration\.baseUrl/);
    expect(factory).toMatch(/new BedrockModel\(/);
    expect(factory).toMatch(/region:\s*configuration\.region/);
    // The key reaches the model client and nothing else on the boundary.
    expect(provider.match(/configuration\.apiKey/g)).toHaveLength(1);
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
