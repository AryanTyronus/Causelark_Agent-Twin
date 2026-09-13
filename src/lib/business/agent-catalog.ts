//
// There is no agent registry in this product, and this module does not add one.
// An agent configuration is the caller's to declare on a run request, and this
// module answers exactly one question honestly: which agent configurations can
// *this deployment* actually construct a client for, right now?
//
// The answer comes from the provider boundary rather than from a table. It asks
// the same resolvers a turn asks, and reports what they resolved to — the
// provider, the model, and the identity the comparison engine will key a report
// column on. It never asks the OpenRouter endpoint resolver for anything,
// because the endpoint carries the credential: configuration is reported,
// credentials are not. A deployment with a model configured but no key is
// therefore still *listed*, marked unconfigured, so the UI can say why an agent
// would fail before it runs rather than after.
//
// Nothing here runs an agent, opens a connection, or writes a row.

import 'server-only';

import {
  type AgentProviderEnvironment,
  AgentProviderError,
  type AgentProviderKind,
  agentProviderLabel,
  resolveAgentProvider,
  resolveBedrockConfiguration,
  resolveOpenRouterConfiguration,
} from '@/lib/agent/provider';
import { agentConfigurationKey, compareAgentKeys } from '@/lib/comparison/agents';
import {
  type AgentCandidate,
  type AgentProviderOption,
  agentConfigurationFor,
} from '@/lib/contracts/agents';
import { env } from '@/lib/env';

/**
 * The providers this build can construct a model client for, in the order the
 * selector should offer them: the intended production provider first.
 */
const SELECTABLE_PROVIDERS: readonly AgentProviderKind[] = ['bedrock', 'openrouter'];

/** Whether a provider is a development-only one, so the UI can say so. */
const DEVELOPMENT_PROVIDERS: ReadonlySet<AgentProviderKind> = new Set(['openrouter']);

interface ResolvedProvider {
  provider: AgentProviderKind;
  /** The model this provider resolves to, or `null` when it does not resolve. */
  modelId: string | null;
  /** Safe text naming the variable that is missing. Never a value. */
  notice: string | null;
}

/**
 * Resolve each selectable provider's model, once.
 *
 * The OpenRouter branch deliberately resolves the *configuration* rather than
 * the endpoint: a missing model and a missing key are both configuration
 * failures, and an operator needs to be told which one they have. The resolved
 * object is discarded here — only the model ID leaves this function, so the
 * credential cannot reach a caller even by accident.
 */
function resolveProviders(source: AgentProviderEnvironment): ResolvedProvider[] {
  return SELECTABLE_PROVIDERS.map((provider) => {
    try {
      const modelId =
        provider === 'openrouter'
          ? resolveOpenRouterConfiguration(source).modelId
          : resolveBedrockConfiguration(source).modelId;
      return { provider, modelId, notice: null };
    } catch (error) {
      // `AgentProviderError` messages are written to be safe to show an
      // operator: they name an environment variable, never a value.
      return {
        provider,
        modelId: null,
        notice:
          error instanceof AgentProviderError
            ? error.message
            : `${provider} could not be resolved from this deployment's configuration.`,
      };
    }
  });
}

export interface DeploymentAgentCatalog {
  agents: AgentCandidate[];
  providers: AgentProviderOption[];
  defaultAgentKey: string | null;
  configurationNotice: string | null;
}

/**
 * Which agent this deployment runs when nothing names one.
 *
 * Separate from the catalogue because a turn needs the same answer without
 * building the whole list, and because "the default provider is unconfigured" is
 * a different situation from "no provider resolved at all".
 */
export function deployedAgent(source: AgentProviderEnvironment = env) {
  const provider = resolveAgentProvider(source);
  const resolved = resolveProviders(source).find((entry) => entry.provider === provider);
  if (!resolved || resolved.modelId === null)
    return { provider, configuration: null, notice: resolved?.notice ?? null };
  return {
    provider,
    configuration: agentConfigurationFor({ provider, model: resolved.modelId }),
    notice: null,
  };
}

/**
 * Every agent configuration this deployment can run.
 *
 * `AGENT_PROVIDER` selects one of them, and that one is first: it is the agent
 * this deployment *is*, and the only entry whose selection was an operator
 * decision rather than a catalogue entry. The rest are the other providers the
 * build can construct a client for, offered so an agent has something to be
 * compared against without an operator having to know a provider key by heart.
 *
 * A provider is listed as an agent only when it resolves to a model. One that
 * does not is still reported in `providers`, marked unconfigured with the reason
 * — an operator looking for a provider that is absent from the list learns more
 * from its presence than from its absence.
 */
export function deploymentAgentCatalog(
  source: AgentProviderEnvironment = env,
): DeploymentAgentCatalog {
  const defaultProvider = resolveAgentProvider(source);
  const resolved = resolveProviders(source);

  const providers: AgentProviderOption[] = resolved.map((entry) => ({
    provider: entry.provider,
    label: agentProviderLabel(entry.provider),
    production: !DEVELOPMENT_PROVIDERS.has(entry.provider),
    configured: entry.modelId !== null,
    model: entry.modelId,
    isDeploymentDefault: entry.provider === defaultProvider,
  }));

  const agents: AgentCandidate[] = resolved
    .filter((entry): entry is ResolvedProvider & { modelId: string } => entry.modelId !== null)
    .map((entry) => {
      const configuration = agentConfigurationFor({
        provider: entry.provider,
        model: entry.modelId,
      });
      return {
        key: agentConfigurationKey(configuration),
        identity: `${configuration.agentId}@${configuration.agentVersion}`,
        configuration,
        providerLabel: agentProviderLabel(entry.provider),
        isDeploymentDefault: entry.provider === defaultProvider,
      };
    });

  // The deployment's own agent first, then canonical order — the same order the
  // comparison engine sorts agents into, so a report's columns read the same way
  // whichever side of the wire built them.
  agents.sort((left, right) => {
    if (left.isDeploymentDefault !== right.isDeploymentDefault)
      return left.isDeploymentDefault ? -1 : 1;
    return compareAgentKeys(left.key, right.key);
  });

  return {
    agents,
    providers,
    defaultAgentKey: agents.find((agent) => agent.isDeploymentDefault)?.key ?? null,
    // Only a deployment with nothing runnable is in a state worth explaining.
    // When one agent resolves, an unconfigured second provider is a fact about
    // the catalogue, not a problem with it.
    configurationNotice:
      agents.length === 0 ? (resolved.find((entry) => entry.notice)?.notice ?? null) : null,
  };
}
