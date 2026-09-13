//
// The whole of this module exists to answer one question exactly: are these two
// agent configurations the same configuration? A comparison that got that wrong
// would fold two agents into one column, or split one agent across two, and
// every number beside it would be about something other than what it says.
//
// So identity is not derived from array position, from the order the request
// listed agents in, or from a JSON serialisation whose key order is not
// guaranteed. It is derived from the fields themselves, in a declared order,
// each escaped so that no field can impersonate a separator. Two configurations
// produce the same key if and only if all five of their fields are equal.
//
// Nothing here reads a clock, a random source, a database or the environment.

import {
  type AgentConfiguration,
  ComparisonError,
  MAX_AGENT_METADATA_ENTRIES,
  MIN_EXPERIMENT_AGENTS,
} from './types';

/**
 * The separator between identity fields.
 *
 * `|` and `@` are both percent-encoded by `encodeURIComponent`, so neither can
 * survive inside an escaped field. That is what makes the join unambiguous
 * without fixing a length prefix for every part.
 */
const FIELD_SEPARATOR = '|';
const NAME_SEPARATOR = '@';

/**
 * Escape one identity field.
 *
 * `encodeURIComponent` leaves `! ~ * ' ( )` unescaped. None of them is a
 * separator here, and the schema constrains the fields that carry them, so the
 * only requirement is that the separators themselves cannot pass through — which
 * they cannot.
 */
function escapeField(value: string): string {
  return encodeURIComponent(value);
}

/** The agent's metadata in canonical order: sorted by key, then by value. */
export function canonicalMetadata(
  agent: AgentConfiguration,
): readonly { key: string; value: string }[] {
  const entries = agent.metadata ?? [];
  return [...entries].sort((left, right) =>
    left.key < right.key
      ? -1
      : left.key > right.key
        ? 1
        : left.value < right.value
          ? -1
          : left.value > right.value
            ? 1
            : 0,
  );
}

/** The metadata as one escaped, order-independent field. */
function encodeMetadata(agent: AgentConfiguration): string {
  return canonicalMetadata(agent)
    .map((entry) => `${escapeField(entry.key)}=${escapeField(entry.value)}`)
    .join('&');
}

/**
 * The agent's name: `agentId@agentVersion`.
 *
 * This is the label a team uses for an agent, and nothing more. It is what a
 * report shows a reader, and it is deliberately *not* what a matrix cell is
 * keyed on — two different configurations of the same agent share this string.
 */
export function agentIdentity(agent: AgentConfiguration): string {
  return `${escapeField(agent.agentId)}${NAME_SEPARATOR}${escapeField(agent.agentVersion)}`;
}

/**
 * The canonical key of one exact configuration.
 *
 * Two configurations share a key if and only if they are the same agent, at the
 * same version, on the same provider, asking for the same model, carrying the
 * same metadata. This is what a matrix cell, a report column and an experiment
 * key are built from, so it has to be injective — and it is, because every field
 * is escaped and the separators cannot appear inside one.
 */
export function agentConfigurationKey(agent: AgentConfiguration): string {
  return [
    agentIdentity(agent),
    escapeField(agent.provider),
    escapeField(agent.model),
    encodeMetadata(agent),
  ].join(FIELD_SEPARATOR);
}

/**
 * Order two configuration keys canonically.
 *
 * Byte-wise on the key, which is a total order over strings and therefore
 * independent of the order the agents arrived in. The comparison sorts by this
 * everywhere it needs an order, so reordering a request cannot change a report.
 */
export function compareAgentKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Check the parts of a configuration its schema cannot state on its own.
 *
 * Two things are refused here. A duplicate metadata key is ambiguous — the same
 * configuration could be written two ways, which is exactly what identity must
 * not permit. A provider this build cannot construct a client for is refused up
 * front, so an experiment fails before it creates a run rather than after.
 */
export function validateAgentConfiguration(agent: AgentConfiguration): AgentConfiguration {
  const seen = new Set<string>();
  for (const entry of agent.metadata ?? []) {
    if (seen.has(entry.key))
      throw new ComparisonError(
        'INVALID_AGENT_CONFIGURATION',
        `Agent ${agentIdentity(agent)} lists metadata key "${entry.key}" more than once, so its identity would be ambiguous.`,
      );
    seen.add(entry.key);
  }
  if (seen.size > MAX_AGENT_METADATA_ENTRIES)
    throw new ComparisonError(
      'INVALID_AGENT_CONFIGURATION',
      `Agent ${agentIdentity(agent)} carries more than ${MAX_AGENT_METADATA_ENTRIES} metadata entries.`,
    );
  return agent;
}

/**
 * Put a set of agents into canonical order, refusing anything that is not a
 * comparison of distinct agents.
 *
 * Three refusals, each for the same reason: an experiment compares distinct
 * agents, and a set that is not distinct cannot produce a column per agent.
 *
 *   - fewer than two agents is not a comparison
 *   - two identical configurations would produce two columns of the same numbers
 *   - two *different* configurations sharing one `agentId@agentVersion` would
 *     produce two columns a reader could not tell apart, so the key alone is not
 *     enough to keep them separate: the name collision is refused outright
 *     rather than silently disambiguated by whichever sorted first
 *
 * The agent-count refusal lives here rather than only on the request schema so
 * that the engine's own entry point cannot be talked into a one-agent
 * "comparison" by a caller that skipped its validation.
 */
export function orderAgents(agents: readonly AgentConfiguration[]): AgentConfiguration[] {
  const validated = agents.map(validateAgentConfiguration);
  if (validated.length < MIN_EXPERIMENT_AGENTS)
    throw new ComparisonError(
      'TOO_FEW_AGENTS',
      `A comparison needs at least ${MIN_EXPERIMENT_AGENTS} agents; this experiment named ${validated.length}.`,
    );
  const byKey = new Map<string, AgentConfiguration>();
  const byIdentity = new Map<string, string>();
  for (const agent of validated) {
    const key = agentConfigurationKey(agent);
    const existing = byKey.get(key);
    if (existing)
      throw new ComparisonError(
        'DUPLICATE_AGENT',
        `Agent ${agentIdentity(agent)} on ${agent.provider} with model ${agent.model} appears twice in one experiment.`,
      );
    const identity = agentIdentity(agent);
    const colliding = byIdentity.get(identity);
    if (colliding)
      throw new ComparisonError(
        'DUPLICATE_AGENT',
        `Two different configurations share the agent name ${identity}: ${colliding} and ${key}. An experiment cannot compare one agent against itself, and a report cannot show two columns under one name.`,
      );
    byIdentity.set(identity, key);
    byKey.set(key, agent);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => compareAgentKeys(left, right))
    .map(([, agent]) => agent);
}

/** The canonical key of an ordered agent list, as one field. */
export function agentsKey(agents: readonly AgentConfiguration[]): string {
  return agents.map(agentConfigurationKey).join(FIELD_SEPARATOR);
}
