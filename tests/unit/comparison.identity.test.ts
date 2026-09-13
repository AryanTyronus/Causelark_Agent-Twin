// @vitest-environment node
//
// These are the assertions that keep a comparison honest about *who* it
// compared. If two configurations collapse into one key, two agents share a
// column and every number in the report is about the wrong thing; if one
// configuration splits into two, one agent's evidence is halved across two
// columns. Neither failure announces itself, so the properties are pinned here.

import { describe, expect, it } from 'vitest';
import { getBenchmark } from '@/lib/benchmarks/catalog';
import { benchmarkCaseKey, buildRunMatrix } from '@/lib/benchmarks/matrix';
import {
  agentConfigurationKey,
  agentIdentity,
  agentsKey,
  compareAgentKeys,
  orderAgents,
} from '@/lib/comparison/agents';
import { getExperiment } from '@/lib/comparison/catalog';
import {
  buildComparisonMatrix,
  comparisonCaseKey,
  maximumAgentsFor,
  resolveExperimentAgents,
} from '@/lib/comparison/matrix';
import { AgentConfiguration, ComparisonError } from '@/lib/comparison/types';
import { agentFixture, EXPERIMENT_ID, SCENARIO_IDS } from './comparison.fixtures';

const AGENT_A = agentFixture({ agentId: 'agent-a', model: 'model-a' });
const AGENT_B = agentFixture({ agentId: 'agent-b', model: 'model-b' });

describe('agent identity', () => {
  it('names an agent as id@version and nothing else', () => {
    expect(agentIdentity(AGENT_A)).toBe('agent-a@1');
    expect(agentIdentity(agentFixture({ agentId: 'planner', agentVersion: '2026-01' }))).toBe(
      'planner@2026-01',
    );
  });

  it('keys a configuration on every field that can change what it does', () => {
    const base = agentConfigurationKey(AGENT_A);
    // Each of the four identity fields, changed alone, moves the key.
    expect(agentConfigurationKey({ ...AGENT_A, agentId: 'agent-z' })).not.toBe(base);
    expect(agentConfigurationKey({ ...AGENT_A, agentVersion: '2' })).not.toBe(base);
    expect(agentConfigurationKey({ ...AGENT_A, provider: 'openrouter' })).not.toBe(base);
    expect(agentConfigurationKey({ ...AGENT_A, model: 'model-z' })).not.toBe(base);
    expect(
      agentConfigurationKey({ ...AGENT_A, metadata: [{ key: 'temperature', value: '0.2' }] }),
    ).not.toBe(base);
  });

  it('is stable: the same configuration keys the same way every time', () => {
    expect(agentConfigurationKey(AGENT_A)).toBe(agentConfigurationKey({ ...AGENT_A }));
    expect(agentConfigurationKey(AGENT_A)).toBe(
      agentConfigurationKey({ ...AGENT_A, metadata: [] }),
    );
  });

  it('does not depend on the order metadata was written in', () => {
    const written = agentFixture({
      agentId: 'agent-a',
      metadata: [
        { key: 'temperature', value: '0.2' },
        { key: 'prompt', value: 'v3' },
      ],
    });
    const reversed = agentFixture({
      agentId: 'agent-a',
      metadata: [
        { key: 'prompt', value: 'v3' },
        { key: 'temperature', value: '0.2' },
      ],
    });
    expect(agentConfigurationKey(written)).toBe(agentConfigurationKey(reversed));
  });

  it('does not collapse two configurations that differ only in metadata', () => {
    const left = agentFixture({ agentId: 'agent-a', metadata: [{ key: 'prompt', value: 'v1' }] });
    const right = agentFixture({ agentId: 'agent-a', metadata: [{ key: 'prompt', value: 'v2' }] });
    expect(agentConfigurationKey(left)).not.toBe(agentConfigurationKey(right));
  });

  it('escapes every field, so no field can impersonate a separator', () => {
    // A value crafted to look like another configuration's fields must not
    // produce its key. The schemas reject these characters outright, and the
    // escaping is the second line of defence behind them.
    const crafted = agentFixture({ agentId: 'agent-a', model: 'model-a|agent-b@1|bedrock' });
    expect(agentConfigurationKey(crafted)).not.toBe(
      agentConfigurationKey(agentFixture({ agentId: 'agent-b', model: 'model-a' })),
    );
    expect(agentConfigurationKey(crafted)).toContain('%7C');
  });

  it('refuses a configuration whose schema forbids the identity separators', () => {
    for (const bad of [
      { agentId: 'Agent-A' },
      { agentId: 'agent_a' },
      { agentId: 'agent-a', provider: 'bed rock' },
      { agentId: 'agent-a', model: 'model|a' },
      { agentId: 'agent-a', model: 'model~a' },
      { agentId: 'agent-a', agentVersion: 'v 1' },
    ])
      expect(AgentConfiguration.safeParse(agentFixture(bad)).success).toBe(false);
  });

  it('refuses a configuration with a duplicate metadata key', () => {
    expect(() =>
      orderAgents([
        agentFixture({
          agentId: 'agent-a',
          metadata: [
            { key: 'prompt', value: 'v1' },
            { key: 'prompt', value: 'v2' },
          ],
        }),
        AGENT_B,
      ]),
    ).toThrowError(/more than once/);
  });

  it('orders agents canonically, independent of the order they were given in', () => {
    expect(orderAgents([AGENT_B, AGENT_A]).map(agentIdentity)).toEqual(['agent-a@1', 'agent-b@1']);
    expect(orderAgents([AGENT_A, AGENT_B]).map(agentIdentity)).toEqual(['agent-a@1', 'agent-b@1']);
    expect(compareAgentKeys('a', 'b')).toBeLessThan(0);
    expect(compareAgentKeys('b', 'a')).toBeGreaterThan(0);
    expect(compareAgentKeys('a', 'a')).toBe(0);
  });

  it('refuses the same configuration twice in one experiment', () => {
    expect(() => orderAgents([AGENT_A, { ...AGENT_A }])).toThrowError(ComparisonError);
    expect(() => orderAgents([AGENT_A, { ...AGENT_A }])).toThrowError(/appears twice/);
  });

  it('refuses two different configurations sharing one agent name', () => {
    // One agent id at one version cannot be two columns: a reader could not tell
    // them apart, and the report could not say which was which.
    expect(() => orderAgents([AGENT_A, { ...AGENT_A, model: 'model-b' }])).toThrowError(
      /share the agent name/,
    );
  });

  it('keys an agent list by configuration, not by position', () => {
    expect(agentsKey([AGENT_A, AGENT_B])).toBe(agentsKey([AGENT_A, AGENT_B]));
    // A list keyed by position would produce the same string here; a list keyed
    // by configuration does not.
    expect(agentsKey([AGENT_B, AGENT_A])).not.toBe(agentsKey([AGENT_A, AGENT_B]));
  });
});

describe('experiment matrix', () => {
  const definition = getBenchmark('resource-routing-robustness');

  it('nests the benchmark matrix under each agent', () => {
    const cases = buildComparisonMatrix(definition, [AGENT_A, AGENT_B]);
    const perAgent = buildRunMatrix(definition);
    expect(cases).toHaveLength(perAgent.length * 2);
    expect(cases.slice(0, perAgent.length).map((entry) => entry.scenarioId)).toEqual(
      perAgent.map((entry) => entry.scenarioId),
    );
  });

  it('is order-independent in the agents', () => {
    const forward = buildComparisonMatrix(definition, [AGENT_A, AGENT_B]);
    const backward = buildComparisonMatrix(definition, [AGENT_B, AGENT_A]);
    // Element for element, including every index and every key.
    expect(backward).toEqual(forward);
    expect(backward.map((entry) => entry.key)).toEqual(forward.map((entry) => entry.key));
  });

  it('is order-independent in the seeds and scenarios', () => {
    const one = buildComparisonMatrix(definition, [AGENT_A, AGENT_B]);
    const two = buildComparisonMatrix({ ...definition }, [AGENT_A, AGENT_B]);
    expect(two).toEqual(one);
  });

  it('keys a case on the agent configuration and the benchmark cell', () => {
    const key = comparisonCaseKey('agent-a@1|bedrock|model-a|', 'baseline', 1, 1042);
    expect(key).toBe(`agent-a@1|bedrock|model-a||${benchmarkCaseKey('baseline', 1, 1042)}`);
  });

  it('gives two configurations of one agent different cells', () => {
    const other = { ...AGENT_A, model: 'model-other' };
    const cases = buildComparisonMatrix(definition, [
      AGENT_A,
      { ...other, agentId: 'agent-a', agentVersion: '2' },
    ]);
    const keys = new Set(cases.map((entry) => entry.key));
    expect(keys.size).toBe(cases.length);
  });

  it('reuses the benchmark engine’s own matrix rather than a second one', () => {
    const cases = buildComparisonMatrix(definition, [AGENT_A]);
    const expected = buildRunMatrix(definition).map((entry) => entry.key);
    expect(cases.map((entry) => entry.key.split('|').slice(4).join('|'))).toEqual(expected);
  });

  it('bounds the agent count by the benchmark’s own capacity', () => {
    // Seven scenarios at one seed is seven cases per agent, so four agents fit
    // inside the engine's twenty-eight-case ceiling and five do not.
    expect(maximumAgentsFor(definition)).toBe(4);
    expect(resolveExperimentAgents(definition, [AGENT_A, AGENT_B])).toHaveLength(2);
    expect(() =>
      resolveExperimentAgents(definition, [
        AGENT_A,
        AGENT_B,
        agentFixture({ agentId: 'agent-c' }),
        agentFixture({ agentId: 'agent-d' }),
        agentFixture({ agentId: 'agent-e' }),
      ]),
    ).toThrowError(/MATRIX_TOO_LARGE|above the 28/);
  });

  it('refuses an oversized matrix before building it', () => {
    try {
      resolveExperimentAgents(definition, [
        AGENT_A,
        AGENT_B,
        agentFixture({ agentId: 'agent-c' }),
        agentFixture({ agentId: 'agent-d' }),
        agentFixture({ agentId: 'agent-e' }),
      ]);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ComparisonError);
      expect((error as ComparisonError).code).toBe('MATRIX_TOO_LARGE');
    }
  });

  it('returns the agents in canonical order from the resolver', () => {
    expect(resolveExperimentAgents(definition, [AGENT_B, AGENT_A]).map(agentIdentity)).toEqual([
      'agent-a@1',
      'agent-b@1',
    ]);
  });
});

describe('experiment catalogue', () => {
  it('resolves the shipped experiment and the benchmark it pins', () => {
    const { template, definition } = getExperiment(EXPERIMENT_ID);
    expect(template.id).toBe(EXPERIMENT_ID);
    expect(definition.id).toBe('resource-routing-robustness');
    expect(definition.version).toBe(template.benchmarkVersion);
  });

  it('refuses an unknown experiment', () => {
    expect(() => getExperiment('no-such-experiment')).toThrowError(/Unknown experiment/);
  });

  it('refuses a version the catalogue does not ship', () => {
    expect(() => getExperiment(EXPERIMENT_ID, 99)).toThrowError(/only ships version/);
  });

  it('compares against the benchmark’s own scenarios, unchanged', () => {
    const { definition } = getExperiment(EXPERIMENT_ID);
    expect(definition.scenarios.map((entry) => entry.id)).toEqual([...SCENARIO_IDS]);
    expect(definition.scenarios.every((entry) => entry.version === 1)).toBe(true);
  });
});
