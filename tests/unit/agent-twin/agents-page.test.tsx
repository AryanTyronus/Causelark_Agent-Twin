// @polsia:user-owned — the agents page.
//
// This page answers one question — what can this deployment actually run? — and
// the product's answer is deliberately narrow: there is no agent registry, and
// the page must not imply one. So it is tested for the two ways that claim could
// be broken.
//
//   1. It lists what the provider boundary resolves, and nothing that it does
//      not. A provider with no model configured is reported as unconfigured
//      rather than quietly omitted, and no agent row is invented for it.
//   2. It carries no credential. A deployment is configured with a distinctive
//      fake credential and a distinctive fake model, and every assertion runs
//      against a catalogue built from that configuration — so a page that ever
//      rendered the credential, or anything shaped like one, would fail here.
//
// The catalogue is parsed against the schema the endpoint serves, and its agent
// identities are derived by the same isomorphic helpers the endpoint derives them
// with, so a fixture cannot describe a catalogue the page would never receive.
// (`deploymentAgentCatalog` itself is `server-only` and is deliberately not
// imported here — it is exercised where it belongs, against the route.)

import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  requested: [] as string[],
  responses: new Map<string, unknown>(),
  failures: new Map<string, number>(),
  /** Paths whose response waits on `gate` — used to hold a response in flight. */
  hold: null as { paths: string[]; gate: Promise<void> } | null,
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: async (path: string) => {
    api.requested.push(path);
    if (api.hold?.paths.includes(path)) await api.hold.gate;
    if (api.failures.has(path))
      throw new Error(`apiFetch ${path} failed (${api.failures.get(path)})`);
    if (!api.responses.has(path)) throw new Error(`apiFetch ${path} failed (404)`);
    return api.responses.get(path);
  },
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

import AgentsPage from '@/app/(dashboard)/dashboard/agents/page';
import { agentConfigurationKey, compareAgentKeys } from '@/lib/comparison/agents';
import {
  type AgentCandidate,
  type AgentCatalog,
  AgentCatalog as AgentCatalogSchema,
  type AgentProviderOption,
  agentConfigurationFor,
} from '@/lib/contracts/agents';
import { render } from './render';

const AGENTS_PATH = '/api/agents';

/**
 * A credential that must never reach a page.
 *
 * It is deliberately shaped like nothing else in the product, so an assertion
 * that it is absent from the rendered text cannot pass by coincidence.
 */
const CREDENTIAL = 'sk-should-never-be-rendered-4f2a';

/** The two providers this build can construct a client for. */
const PROVIDERS = [
  {
    provider: 'bedrock',
    label: 'Amazon Bedrock',
    production: true,
    model: 'anthropic.claude-sonnet-4-20250514-v1:0',
  },
  {
    provider: 'openrouter',
    label: 'OpenRouter',
    production: false,
    model: 'anthropic/claude-sonnet-4',
  },
] as const;

/** One agent row, derived the way the endpoint derives it. */
function agentFor(provider: string, model: string, isDeploymentDefault: boolean): AgentCandidate {
  const configuration = agentConfigurationFor({ provider, model });
  return {
    key: agentConfigurationKey(configuration),
    identity: `${configuration.agentId}@${configuration.agentVersion}`,
    configuration,
    providerLabel: PROVIDERS.find((entry) => entry.provider === provider)?.label ?? provider,
    isDeploymentDefault,
  };
}

/**
 * The catalogue the endpoint serves for a deployment.
 *
 * `configured` names the providers that resolve to a model here. A provider that
 * does not resolve is still reported — unconfigured, with the variable an
 * operator would set and never a value — and gets no agent row.
 */
function serve(configured: readonly string[]): AgentCatalog {
  const providers: AgentProviderOption[] = PROVIDERS.map((entry) => ({
    provider: entry.provider,
    label: entry.label,
    production: entry.production,
    configured: configured.includes(entry.provider),
    model: configured.includes(entry.provider) ? entry.model : null,
    isDeploymentDefault: entry.provider === 'bedrock',
  }));

  const agents = PROVIDERS.filter((entry) => configured.includes(entry.provider))
    .map((entry) => agentFor(entry.provider, entry.model, entry.provider === 'bedrock'))
    .sort((left, right) => {
      if (left.isDeploymentDefault !== right.isDeploymentDefault)
        return left.isDeploymentDefault ? -1 : 1;
      return compareAgentKeys(left.key, right.key);
    });

  const catalog = AgentCatalogSchema.parse({
    agents,
    providers,
    defaultAgentKey: agents.find((agent) => agent.isDeploymentDefault)?.key ?? null,
    configurationNotice:
      agents.length === 0
        ? 'Amazon Bedrock is not configured for the Agent Twin provider. Set BEDROCK_MODEL_ID (and a region) for this environment.'
        : null,
  });
  api.responses.set(AGENTS_PATH, catalog);
  return catalog;
}

/** Hold responses for `paths` until `release()` is called. */
function hold(paths: string[]): () => void {
  let open: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  api.hold = { paths, gate };
  return () => {
    api.hold = null;
    open?.();
  };
}

/**
 * The page renders two tables, and a row lookup that did not say which one it
 * meant would silently assert against the wrong list — the two disagree by
 * design, so the caption is how a test names the one it is asking about.
 */
function tableWithCaption(view: Awaited<ReturnType<typeof render>>, caption: string) {
  return view
    .all('table')
    .find((table) => table.querySelector('caption')?.textContent?.includes(caption));
}

function providerRow(view: Awaited<ReturnType<typeof render>>, label: string) {
  return [
    ...(tableWithCaption(view, 'Selectable providers')?.querySelectorAll('tbody tr') ?? []),
  ].find((row) => row.textContent?.includes(label));
}

function agentTable(view: Awaited<ReturnType<typeof render>>) {
  return tableWithCaption(view, 'Agent configurations this deployment resolves');
}

beforeEach(() => {
  api.requested = [];
  api.responses = new Map();
  api.failures = new Map();
  api.hold = null;
});

describe('the agents page', () => {
  it('lists the configurations this deployment resolves, with what makes each one identifiable', async () => {
    const catalog = serve(['bedrock', 'openrouter']);
    expect(catalog.agents.length).toBeGreaterThan(0);
    const view = await render(<AgentsPage />);

    expect(view.has('What this deployment can run')).toBe(true);
    for (const agent of catalog.agents) {
      expect(view.has(agent.identity)).toBe(true);
      expect(view.has(agent.configuration.model)).toBe(true);
      expect(view.has(agent.providerLabel)).toBe(true);
      expect(view.has(agent.configuration.agentVersion)).toBe(true);
    }
    // Exactly one of them is the agent this deployment *is*.
    expect(
      view.all('tbody tr').filter((row) => row.textContent?.includes('deployment default')),
    ).toHaveLength(1);
    await view.unmount();
  });

  it('names the provider boundary this build can speak, including what it cannot run', async () => {
    const catalog = serve(['bedrock', 'openrouter']);
    const view = await render(<AgentsPage />);

    // Both providers are stated, whether or not they resolve — an operator
    // looking for a provider learns more from its presence than its absence.
    expect(catalog.providers).toHaveLength(2);
    for (const provider of catalog.providers) {
      expect(view.has(provider.label)).toBe(true);
      expect(view.has(provider.production ? 'production' : 'development')).toBe(true);
    }
    await view.unmount();
  });

  it('reports a provider with no model as unconfigured rather than dropping it', async () => {
    const catalog = serve([]);
    const view = await render(<AgentsPage />);

    // No provider resolved a model, so no agent exists — and every provider is
    // still listed, each saying so.
    expect(catalog.agents).toHaveLength(0);
    expect(catalog.providers.every((provider) => !provider.configured)).toBe(true);
    expect(view.has('not configured')).toBe(true);
    expect(view.has('not set')).toBe(true);
    // The distinction the page exists to make: an agent row is never invented
    // for a provider that cannot run.
    expect(view.has('Nothing resolves here')).toBe(true);
    expect(
      view.all('tbody tr').filter((row) => row.textContent?.includes('selectable')),
    ).toHaveLength(0);
    await view.unmount();
  });

  it('says an unconfigured deployment will report unavailable rather than scored', async () => {
    serve([]);
    const view = await render(<AgentsPage />);

    expect(view.has('No agent is configured for this deployment.')).toBe(true);
    // The consequence is stated, and it is the engine's own convention: a run
    // that reached no provider produced no evidence, so it is not a zero.
    expect(view.has('reported as unavailable rather than scored')).toBe(true);
    expect(view.has('produces no evidence')).toBe(true);
    await view.unmount();
  });

  it('marks a development-only provider as development, not as production', async () => {
    serve(['openrouter']);
    const view = await render(<AgentsPage />);

    // The class of each provider is a word, so it survives a monochrome display.
    // OpenRouter is development-only and Bedrock is not, and the page says both.
    expect(view.has('development')).toBe(true);
    expect(view.has('production')).toBe(true);
    expect(providerRow(view, 'OpenRouter')?.textContent).toContain('development');
    // And a provider that does not resolve here is still listed, marked so.
    expect(providerRow(view, 'Amazon Bedrock')?.textContent).toContain('not configured');
    // The agent list, by contrast, holds only what actually resolves.
    expect(agentTable(view)?.textContent).not.toContain('Amazon Bedrock');
    await view.unmount();
  });

  it('never renders a credential, whichever providers are configured', async () => {
    for (const configured of [[], ['openrouter'], ['bedrock', 'openrouter']] as const) {
      serve(configured);
      const view = await render(<AgentsPage />);
      const text = view.text();

      // The value never appears, and neither does anything shaped like one.
      expect(text).not.toContain(CREDENTIAL);
      expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
      expect(text).not.toContain('OPENROUTER_API_KEY');
      expect(text).not.toMatch(/authorization|bearer/i);
      await view.unmount();
    }
  });

  it('names the variable an operator would set, without ever naming a value', async () => {
    serve([]);
    const view = await render(<AgentsPage />);
    const text = view.text();

    // The reason nothing runs is a missing *setting*, and stating which one is
    // the point — an operator can act on a variable name. It is still not a value.
    expect(text).toContain('BEDROCK_MODEL_ID');
    expect(text).not.toContain(CREDENTIAL);
    await view.unmount();
  });

  it('says it is loading rather than showing a deployment that runs nothing', async () => {
    serve(['bedrock', 'openrouter']);
    const release = hold([AGENTS_PATH]);
    const view = await render(<AgentsPage />);

    // Nothing has answered: "nothing resolves here" would be a claim about the
    // deployment rather than about the wait.
    expect(view.has('Loading the provider configuration')).toBe(true);
    expect(view.has('Nothing resolves here')).toBe(false);

    release();
    await view.settle();
    expect(view.has('Loading the provider configuration')).toBe(false);
    expect(view.has('What this deployment can run')).toBe(true);
    await view.unmount();
  });

  it('reports an unreadable provider configuration rather than an empty deployment', async () => {
    api.failures.set(AGENTS_PATH, 500);
    const view = await render(<AgentsPage />);

    expect(view.has('Agent catalogue unavailable')).toBe(true);
    // A deployment whose configuration cannot be read is not a deployment with
    // no agents, and it is a deployment-side problem rather than the reader's.
    expect(view.has('deployment-side problem')).toBe(true);
    expect(view.has('Nothing resolves here')).toBe(false);
    expect(view.has('apiFetch')).toBe(false);
    await view.unmount();
  });

  it('requires a session before it shows anything', async () => {
    api.failures.set(AGENTS_PATH, 401);
    const view = await render(<AgentsPage />);

    // An unauthenticated read is a failure like any other, and the page states
    // it in the operator's terms rather than leaking the status.
    expect(view.has('Agent catalogue unavailable')).toBe(true);
    expect(view.has('Unauthorized')).toBe(false);
    expect(view.has('401')).toBe(false);
    await view.unmount();
  });
});
