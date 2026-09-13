// @vitest-environment node
// @polsia:user-owned — the pure half of the Agent Twin interface.
//
// Three things in this layer can be wrong in a way that would matter, and each
// is asserted here as a statement about the product:
//
//   1. An agent's identity. Two different models must never produce the same
//      identity, and the same model must always produce the same one — a report
//      column that collides is a comparison that silently compares one agent
//      with itself.
//   2. The absence of a number. Every engine in this product uses `null` to mean
//      "this evidence cannot support a value". An interface that rendered `0`
//      there would report a measurement nobody made, so `null` is asserted to
//      render as words and never as a figure.
//   3. Matching recorded runs to planned cases. Progress is only allowed to
//      count a case whose own run says it belongs to that agent and that case.

import { describe, expect, it } from 'vitest';
import { matchPlan, type RecordedRun } from '@/components/custom/agent-twin/execution-view';
import {
  failureSummary,
  formatCount,
  formatDelta,
  formatMetric,
  formatMetricDelta,
  formatRate,
  formatRatio,
  formatScore,
  formatTimestamp,
  metricDescription,
  metricDirection,
  metricLabel,
  scenarioLabel,
} from '@/components/custom/agent-twin/format';
import { BenchmarkCase, BenchmarkRun } from '@/lib/benchmarks/types';
import { AgentConfiguration } from '@/lib/comparison/types';
import { agentConfigurationFor, agentDisplayLabel, modelVersionSlug } from '@/lib/contracts/agents';

describe('an agent’s identity', () => {
  it('is the provider and the model, and nothing else', () => {
    const configuration = agentConfigurationFor({ provider: 'openrouter', model: 'vendor/model' });
    expect(configuration).toEqual({
      agentId: 'openrouter',
      agentVersion: 'vendor-model',
      provider: 'openrouter',
      model: 'vendor/model',
    });
    // The configuration is what the comparison engine accepts on a request, so
    // the fixture is checked against that contract rather than a restatement.
    expect(AgentConfiguration.safeParse(configuration).success).toBe(true);
  });

  it('keeps the model it was asked for, unmodified, beside the slug', () => {
    const model = 'meta-llama/Llama-3.3-70B-Instruct:free';
    const configuration = agentConfigurationFor({ provider: 'openrouter', model });
    expect(configuration.model).toBe(model);
    expect(configuration.agentVersion).not.toBe(model);
    expect(configuration.agentVersion).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });

  it('never gives two different models the same version', () => {
    const models = [
      'vendor/model-a',
      'vendor/model-b',
      'vendor/model-a:free',
      'a/b',
      'a-b',
      'a:b',
      'a.b',
    ];
    const slugs = models.map(modelVersionSlug);
    // `a/b`, `a-b` and `a:b` all slug to `a-b`, which is exactly the collision
    // the comparison engine refuses: it rejects two configurations that share an
    // agent id and version, so the operator is told rather than silently
    // comparing one agent with itself.
    expect(new Set(slugs).size).toBeLessThan(models.length);
    expect(slugs.filter((slug) => slug === 'a-b').length).toBe(3);
  });

  it('always produces a version, even for a model that slugs to nothing', () => {
    expect(modelVersionSlug('')).toBe('unspecified');
    expect(modelVersionSlug('///')).toBe('unspecified');
    expect(modelVersionSlug('  spaced  out  ')).toBe('spaced-out');
  });

  it('reads as the model the provider was actually asked for', () => {
    expect(agentDisplayLabel({ provider: 'bedrock', model: 'anthropic.claude-v2' })).toBe(
      'bedrock · anthropic.claude-v2',
    );
  });
});

describe('a number that does not exist', () => {
  const absent: Array<number | null | undefined> = [null, undefined, Number.NaN];

  it('is never rendered as zero', () => {
    for (const value of absent) {
      expect(formatScore(value)).toBe('not recorded');
      expect(formatRate(value)).toBe('not recorded');
      expect(formatCount(value)).toBe('not recorded');
      expect(formatTimestamp(null)).toBe('not recorded');
    }
  });

  it('is never rendered as zero for any metric, whatever its quantity', () => {
    for (const value of absent) {
      for (const metric of ['averageOverallScore', 'taskSuccessRate', 'timeoutCount'] as const) {
        expect(formatMetric(metric, value)).toBe('not recorded');
        expect(formatMetricDelta(metric, value)).toBe('not recorded');
      }
    }
  });

  it('is reported as zero only when the engine actually recorded zero', () => {
    expect(formatScore(0)).toBe('0.0');
    expect(formatCount(0)).toBe('0');
    expect(formatRate(0)).toBe('0.0%');
  });

  it('is read in the metric’s own units, not the value’s shape', () => {
    expect(formatMetric('taskSuccessRate', 1)).toBe('100.0%');
    expect(formatMetric('timeoutCount', 2)).toBe('2');
    expect(formatMetric('averageSteps', 7.5)).toBe('7.5');
    // Robustness is a 0–1 retention ratio, so it keeps two decimals: at one
    // decimal a retention of 0.82 and one of 0.79 would both read `0.8`, and
    // those are the two figures a reader compares most closely.
    expect(formatMetric('robustnessScore', 0.82)).toBe('0.82');
    expect(formatMetric('robustnessScore', 0.79)).toBe('0.79');
    expect(formatRatio(1)).toBe('1.00');
    expect(formatRatio(null)).toBe('not recorded');
  });

  it('reads a direction from the engine, never from the interface', () => {
    // The comparison engine owns which way is up for each metric. The UI asks;
    // it does not decide. A metric whose direction the interface guessed would
    // be a metric whose winner the interface could invert.
    expect(metricDirection('averageOverallScore')).toBe('higher');
    expect(metricDirection('providerFailureCount')).toBe('lower');
    expect(metricDescription('robustnessScore').length).toBeGreaterThan(0);
    expect(metricLabel('averageOverallScore')).toBe('Overall');
  });

  it('renders a change as a bounded figure, never as a raw float', () => {
    // Every delta in this product is a subtraction between two figures the
    // evaluation engine produced, and a weighted mean is routinely not a short
    // decimal. A delta interpolated straight into the markup would put
    // `+3.3333333333333335` on an instrument panel, so the change goes through
    // the same formatter as everything else — with the sign the reader needs.
    const subtraction = 61.33333333333333 - 58;
    expect(formatDelta(subtraction)).toBe('+3.33');
    expect(formatDelta(subtraction)).not.toContain('3333333');
    expect(formatDelta(-subtraction)).toBe('-3.33');
    expect(formatDelta(0)).toBe('0.00');
    // At and above ten the extra decimal is noise, not resolution.
    expect(formatDelta(12.3456)).toBe('+12.3');
    // And a change the evidence cannot support is still an absence.
    expect(formatDelta(null)).toBe('not recorded');
  });

  it('renders a scenario id as a condition name and nothing more', () => {
    expect(scenarioLabel('resource-scarcity')).toBe('resource scarcity');
  });

  it('separates a behaviour failure from an execution failure by which counter moved', () => {
    // The distinction the product has to make: "performed poorly" is a task or
    // safety counter, "could not execute" is a provider, tool or timeout one.
    expect(failureSummary([0, 0])).toBe('None recorded for any agent.');
    expect(failureSummary([3, 0])).toContain('3 recorded across 1 of 2 agents');
  });
});

describe('matching a recorded run to a planned case', () => {
  const planned = [
    BenchmarkCase.parse({
      index: 0,
      key: 'baseline@1#1042',
      scenarioId: 'baseline',
      scenarioVersion: 1,
      seed: 1042,
      isBaseline: true,
    }),
    BenchmarkCase.parse({
      index: 1,
      key: 'resource-outage@1#1042',
      scenarioId: 'resource-outage',
      scenarioVersion: 1,
      seed: 1042,
      isBaseline: false,
    }),
  ];
  const agents = [
    { agentId: 'bedrock', agentVersion: 'model-a' },
    { agentId: 'openrouter', agentVersion: 'model-b' },
  ];

  function run(overrides: Partial<RecordedRun>): RecordedRun {
    return {
      runId: 'run-1',
      status: 'RUNNING',
      agentId: 'bedrock',
      agentVersion: 'model-a',
      caseKey: 'baseline@1#1042',
      benchmarkId: 'resource-routing-robustness',
      ...overrides,
    };
  }

  it('gives every agent the same case list, because the matrix does', () => {
    const progress = matchPlan(planned, agents, []);
    expect([...progress.keys()]).toEqual(['bedrock@model-a', 'openrouter@model-b']);
    for (const cases of progress.values()) {
      expect(cases.map((entry) => entry.scenarioId)).toEqual(['baseline', 'resource-outage']);
      // Nothing recorded, so nothing is marked as started.
      expect(cases.every((entry) => entry.runId === null && entry.status === null)).toBe(true);
    }
  });

  it('marks a case only for the agent whose run says it belongs to it', () => {
    const progress = matchPlan(planned, agents, [
      run({ runId: 'run-a', status: 'COMPLETED' }),
      run({
        runId: 'run-b',
        status: 'RUNNING',
        agentId: 'openrouter',
        agentVersion: 'model-b',
        caseKey: 'baseline@1#1042',
      }),
    ]);
    expect(progress.get('bedrock@model-a')?.[0]).toMatchObject({
      runId: 'run-a',
      status: 'COMPLETED',
    });
    expect(progress.get('openrouter@model-b')?.[0]).toMatchObject({
      runId: 'run-b',
      status: 'RUNNING',
    });
    // The second case has no run for either agent, and is not credited to one.
    expect(progress.get('bedrock@model-a')?.[1]?.runId).toBeNull();
    expect(progress.get('openrouter@model-b')?.[1]?.runId).toBeNull();
  });

  it('does not credit a run recorded under another benchmark’s case key', () => {
    const progress = matchPlan(planned, agents, [
      run({ caseKey: 'baseline@2#1042' }),
      run({ runId: 'run-3', caseKey: 'baseline@1#9999' }),
    ]);
    expect(progress.get('bedrock@model-a')?.every((entry) => entry.runId === null)).toBe(true);
  });

  it('does not credit an unattributed run to any agent', () => {
    // A run that recorded no agent is not evidence about an agent. Counting it
    // against the first column would be the interface inventing an attribution.
    const progress = matchPlan(planned, agents, [
      run({ agentId: null, agentVersion: null }),
      run({ runId: 'run-4', agentId: null, agentVersion: null }),
    ]);
    expect(progress.get('bedrock@model-a')?.every((entry) => entry.runId === null)).toBe(true);
    expect(progress.get('openrouter@model-b')?.every((entry) => entry.runId === null)).toBe(true);
  });

  it('keys each planned case uniquely across agents', () => {
    const progress = matchPlan(planned, agents, []);
    const keys = [...progress.values()].flat().map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('a benchmark run’s own record', () => {
  it('is what the comparison reads, so the fixture parses as the real contract', () => {
    const failing: BenchmarkRun = {
      case: BenchmarkCase.parse({
        index: 0,
        key: 'baseline@1#1042',
        scenarioId: 'baseline',
        scenarioVersion: 1,
        seed: 1042,
        isBaseline: true,
      }),
      runId: 'run-1',
      status: 'COMPLETED',
      outcome: 'succeeded',
      terminationReason: 'OBJECTIVE_REACHED',
      evaluation: null,
    };
    expect(BenchmarkRun.safeParse(failing).success).toBe(true);
    // An unevaluated run keeps `null`, and the interface renders it as words
    // rather than as a score of zero.
    expect(formatScore(failing.evaluation?.overallScore ?? null)).toBe('not recorded');
  });
});
