//
// An agent has no registry in this product, and this file does not invent one.
// An agent configuration is what the comparison engine already accepts on a run
// request: a name, a version, a provider and a model. What this file adds is the
// shape the UI needs to *offer* those configurations — the providers this build
// can construct a client for, the configuration this deployment runs by default,
// and a deterministic way to turn a provider-and-model choice into the identity
// the comparison engine keys a report column on.
//
// It is isomorphic on purpose, exactly like `@/lib/contracts/simulation`: the
// route that serves the catalogue and the client that renders it share one
// schema, so a field cannot be added on one side and missed on the other. The
// identity helper is here for the same reason — the server builds the default
// agent's identity with it and the client builds each selected agent's identity
// with it, so the two cannot derive different names for the same agent.
//
// No credential appears anywhere in this file, in its schemas, or in the values
// they describe. A credential is deployment configuration; an agent's identity
// is its provider and its model.

import { z } from 'zod';
import { AgentConfiguration } from '@/lib/comparison/types';

/**
 * A provider a caller may select, with the label the deployment publishes for it.
 *
 * The label travels from the server rather than being restated here: the
 * provider module owns the wording that is persisted with every turn, and a
 * second copy in the UI could drift from it.
 */
export const AgentProviderOption = z.object({
  /** The provider key the run request carries. */
  provider: z.string().min(1),
  /** Human label for the picker. */
  label: z.string().min(1),
  /** False for a development-only provider, so the UI can say so. */
  production: z.boolean(),
  /** Whether this deployment can actually build a client for it right now. */
  configured: z.boolean(),
  /** The model this provider resolves to, or `null` when none is set. */
  model: z.string().nullable(),
  /** True for the provider `AGENT_PROVIDER` selects. */
  isDeploymentDefault: z.boolean(),
});
export type AgentProviderOption = z.infer<typeof AgentProviderOption>;

/** One agent configuration, ready to be sent on a run request. */
export const AgentCandidate = z.object({
  /** Canonical configuration key — the same key the report columns are built from. */
  key: z.string().min(1),
  /** `agentId@agentVersion`, as the report shows it. */
  identity: z.string().min(1),
  configuration: AgentConfiguration,
  /** The label this deployment publishes for the provider. */
  providerLabel: z.string().min(1),
  /** True for the agent `AGENT_PROVIDER` resolves to. */
  isDeploymentDefault: z.boolean(),
});
export type AgentCandidate = z.infer<typeof AgentCandidate>;

export const AgentCatalog = z.object({
  /** The agents this deployment is configured for, in canonical order. */
  agents: z.array(AgentCandidate),
  /** Every provider this build can construct a client for. */
  providers: z.array(AgentProviderOption),
  /** The default agent's key, or `null` when no provider is configured. */
  defaultAgentKey: z.string().nullable(),
  /**
   * Why the deployment has no configured agent, when it has none. Safe text —
   * it names an environment variable, never a value.
   */
  configurationNotice: z.string().nullable(),
});
export type AgentCatalog = z.infer<typeof AgentCatalog>;

/**
 * Turn a provider and a model into the identity the comparison engine keys on.
 *
 * The model is free-form because it has to be: a provider's catalogue changes
 * without this build, so pinning a list would go stale, and the provider module
 * refuses to guess one. What the identity has to be is *stable and injective* —
 * the same provider and model always produce the same name, and two different
 * models never collide. So the model is slugged into the version field, which
 * admits only `[A-Za-z0-9._-]` and must start alphanumeric; every other
 * character becomes a separator.
 *
 * The slug is not a display string. The model the provider is actually asked for
 * travels beside it, unmodified, in `model`.
 */
export function modelVersionSlug(model: string): string {
  const slug = model
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[-._]{2,}/g, '-')
    .replace(/[-._]+$/, '');
  // A model that slugs to nothing is still a model the operator named; the
  // version field has to carry something, and an empty string is not a version.
  return slug === '' ? 'unspecified' : slug;
}

/**
 * The agent configuration a provider-and-model choice describes.
 *
 * `agentId` is the provider because that is what it is: two agents under one
 * provider differ by the model they ask for, and nothing else about them
 * differs. The model then belongs in the version field, which is what the
 * report shows beside the name.
 */
export function agentConfigurationFor(input: {
  provider: string;
  model: string;
}): AgentConfiguration {
  return {
    agentId: input.provider.toLowerCase(),
    agentVersion: modelVersionSlug(input.model),
    provider: input.provider,
    model: input.model,
  };
}

/**
 * The short label a report column or a picker row shows for an agent.
 *
 * The identity is canonical but slugged, and the slug of a model is not the
 * model. This reads the configuration instead, so a reader sees the model the
 * provider was actually asked for.
 */
export function agentDisplayLabel(agent: { provider: string; model: string }): string {
  return `${agent.provider} · ${agent.model}`;
}
