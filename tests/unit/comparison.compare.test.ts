// @vitest-environment node
//
// These tests pin the properties that make a comparison a measurement rather
// than a preference:
//
//   - a winner is decided by the declared rule and by nothing else, and the rule
//     is checked rung by rung rather than only at its outcome
//   - a tie is reported as a tie, and absent evidence is reported as absent
//     evidence, never as a tie and never as a win for whoever had a number
//   - the report is a function of the *set* of agents, so reordering a request
//     cannot change a single value in it
//
// The reports under test are produced by the real benchmark engine and the real
// comparison engine (see `comparison.fixtures.ts`), never hand-assembled.

import { describe, expect, it } from 'vitest';
import { BENCHMARK_FAILURE_CATEGORIES, BENCHMARK_ROBUSTNESS_FORMULA } from '@/lib/benchmarks/types';
import { agentConfigurationKey } from '@/lib/comparison/agents';
import {
  buildFailureProfiles,
  buildHeadToHead,
  compareScenarios,
  decideVerdict,
} from '@/lib/comparison/compare';
import { compareValues, directionOf, METRIC_KEYS } from '@/lib/comparison/metrics';
import { COMPARISON_DISCRIMINATORS, COMPARISON_VERDICT_RULE } from '@/lib/comparison/types';
import {
  type AgentScores,
  agentFixture,
  comparisonAgentFor,
  comparisonFixture,
} from './comparison.fixtures';

const AGENT_A = agentFixture({ agentId: 'agent-a', model: 'model-a' });
const AGENT_B = agentFixture({ agentId: 'agent-b', model: 'model-b' });
const AGENT_C = agentFixture({ agentId: 'agent-c', model: 'model-c' });

const KEY_A = agentConfigurationKey(AGENT_A);
const KEY_B = agentConfigurationKey(AGENT_B);
const KEY_C = agentConfigurationKey(AGENT_C);

/** Two agents, one ahead of the other on every scored metric. */
const A_AHEAD = comparisonFixture({
  agents: [AGENT_A, AGENT_B],
  reports: new Map([
    ['agent-a', { spread: 80 }],
    ['agent-b', { spread: 60 }],
  ]),
});

/** Two agents whose observable behaviour was identical. */
const IDENTICAL = comparisonFixture({
  agents: [AGENT_A, AGENT_B],
  reports: new Map([
    ['agent-a', { spread: 70 }],
    ['agent-b', { spread: 70 }],
  ]),
});

function metricOf(report: typeof A_AHEAD, key: string) {
  const found = report.metrics.find((entry) => entry.metric === key);
  if (!found) throw new Error(`No metric row for ${key}`);
  return found;
}

describe('metric table', () => {
  it('declares a direction for every metric it reports', () => {
    expect(METRIC_KEYS).toHaveLength(17);
    for (const metric of METRIC_KEYS)
      expect(['higher', 'lower', 'neutral']).toContain(directionOf(metric));
  });

  it('reports every declared metric, in the table’s order', () => {
    expect(A_AHEAD.metrics.map((entry) => entry.metric)).toEqual([...METRIC_KEYS]);
  });

  it('orients a comparison by the metric’s direction, not by its sign', () => {
    expect(compareValues('averageOverallScore', 80, 60)).toBeGreaterThan(0);
    expect(compareValues('averageOverallScore', 60, 80)).toBeLessThan(0);
    // Lower is better for risk, so the smaller number wins.
    expect(compareValues('averageRisk', 1, 2)).toBeGreaterThan(0);
    expect(compareValues('rejectedActionRate', 0, 0.5)).toBeGreaterThan(0);
    // Neutral metrics have no better, whatever the values.
    expect(compareValues('averageSteps', 4, 9)).toBe(0);
    expect(compareValues('averageBudgetSpent', 4, 9)).toBe(0);
    expect(compareValues('averageBudgetUtilisation', 9, 4)).toBe(0);
  });
});

describe('metric comparison across agents', () => {
  it('names the leading configuration and the gap to the trailing one', () => {
    const overall = metricOf(A_AHEAD, 'averageOverallScore');
    expect(overall.values).toEqual([80, 60]);
    expect(overall.leaders).toEqual([KEY_A]);
    expect(overall.tied).toBe(false);
    expect(overall.spread).toBe(20);
  });

  it('reports a tie as shared leadership rather than as no leader', () => {
    const overall = metricOf(IDENTICAL, 'averageOverallScore');
    expect(overall.leaders).toEqual([KEY_A, KEY_B]);
    expect(overall.tied).toBe(true);
    expect(overall.spread).toBe(0);
  });

  it('never scores a metric that has no better, and never names a leader for one', () => {
    for (const key of ['averageSteps', 'averageBudgetSpent', 'averageBudgetUtilisation']) {
      const row = metricOf(A_AHEAD, key);
      expect(row.direction).toBe('neutral');
      expect(row.leaders).toEqual([]);
      expect(row.tied).toBe(false);
      expect(row.spread).toBeNull();
      // Still reported: neutral means unscored, not unmeasured.
      expect(row.values.every((value) => value !== null)).toBe(true);
    }
  });

  it('reports robustness as a scored metric, from the benchmark engine’s own score', () => {
    const row = metricOf(A_AHEAD, 'robustnessScore');
    expect(row.direction).toBe('higher');
    expect(row.values).toEqual([1, 1]);
    expect(row.tied).toBe(true);
  });
});

describe('head to head', () => {
  it('compares every pair, in canonical order, however many agents there are', () => {
    const three = comparisonFixture({
      agents: [AGENT_C, AGENT_A, AGENT_B],
      reports: new Map([
        ['agent-a', { spread: 80 }],
        ['agent-b', { spread: 60 }],
        ['agent-c', { spread: 70 }],
      ]),
    });
    expect(three.headToHead.map((pair) => [pair.left, pair.right])).toEqual([
      [KEY_A, KEY_B],
      [KEY_A, KEY_C],
      [KEY_B, KEY_C],
    ]);
  });

  it('states the delta in the metric’s own units, signed from left to right', () => {
    const [pair] = A_AHEAD.headToHead;
    const overall = pair?.metrics.find((entry) => entry.metric === 'averageOverallScore');
    expect(overall?.left).toBe(80);
    expect(overall?.right).toBe(60);
    expect(overall?.delta).toBe(20);
    expect(overall?.winner).toBe('left');
  });

  it('names no winner on a tie, on a neutral metric, or without both values', () => {
    const [tied] = IDENTICAL.headToHead;
    const overall = tied?.metrics.find((entry) => entry.metric === 'averageOverallScore');
    expect(overall?.delta).toBe(0);
    expect(overall?.winner).toBeNull();

    const steps = tied?.metrics.find((entry) => entry.metric === 'averageSteps');
    expect(steps?.winner).toBeNull();

    const oneSided = comparisonFixture({
      agents: [AGENT_A, AGENT_B],
      reports: new Map([['agent-a', { spread: 80 }]]),
    });
    const [partial] = oneSided.headToHead;
    const absent = partial?.metrics.find((entry) => entry.metric === 'averageOverallScore');
    expect(absent?.left).toBe(80);
    expect(absent?.right).toBeNull();
    expect(absent?.delta).toBeNull();
    expect(absent?.winner).toBeNull();
  });

  it('counts the metrics each side won, over the metrics that can be won', () => {
    const [pair] = A_AHEAD.headToHead;
    expect(pair?.leftWins).toBeGreaterThan(0);
    expect(pair?.rightWins).toBe(0);
    // Robustness ties at 1 for both and the three neutral metrics are unwinnable,
    // so the wins are strictly fewer than the metric count.
    expect((pair?.leftWins ?? 0) + (pair?.rightWins ?? 0)).toBeLessThan(METRIC_KEYS.length);
  });

  it('is a symmetric statement: reversing the pair negates the delta', () => {
    const forward = buildHeadToHead([
      comparisonAgentFor(AGENT_A, { spread: 80 }),
      comparisonAgentFor(AGENT_B, { spread: 60 }),
    ]);
    const backward = buildHeadToHead([
      comparisonAgentFor(AGENT_B, { spread: 60 }),
      comparisonAgentFor(AGENT_A, { spread: 80 }),
    ]);
    const left = forward[0]?.metrics.find((entry) => entry.metric === 'averageOverallScore');
    const right = backward[0]?.metrics.find((entry) => entry.metric === 'averageOverallScore');
    expect(left?.delta).toBe(20);
    expect(right?.delta).toBe(-20);
  });
});

describe('scenario comparison', () => {
  it('lists every declared scenario, in the benchmark’s own order', () => {
    expect(A_AHEAD.scenarios.map((row) => row.scenarioId)).toEqual(
      A_AHEAD.experiment.scenarios.map((row) => row.id),
    );
    expect(A_AHEAD.scenarios).toHaveLength(7);
  });

  it('carries one score per agent, in experiment order', () => {
    const baseline = A_AHEAD.scenarios.find((row) => row.isBaseline);
    expect(baseline?.scores).toEqual([80, 60]);
    expect(baseline?.leaders).toEqual([KEY_A]);
    expect(baseline?.spread).toBe(20);
  });

  it('marks a scenario both agents scored equally as tied', () => {
    const tied = comparisonFixture({
      agents: [AGENT_A, AGENT_B],
      reports: new Map([
        ['agent-a', { spread: 70, byScenario: { 'resource-outage': 30 } }],
        ['agent-b', { spread: 70, byScenario: { 'resource-outage': 30 } }],
      ]),
    });
    const outage = tied.scenarios.find((row) => row.scenarioId === 'resource-outage');
    expect(outage?.leaders).toEqual([KEY_A, KEY_B]);
    expect(outage?.tied).toBe(true);
    expect(outage?.spread).toBe(0);
  });

  it('leaves an agent with no score out of the leaders rather than treating it as zero', () => {
    const partial = comparisonFixture({
      agents: [AGENT_A, AGENT_B],
      reports: new Map([['agent-a', { spread: 80 }]]),
    });
    const baseline = partial.scenarios.find((row) => row.isBaseline);
    expect(baseline?.scores).toEqual([80, null]);
    expect(baseline?.leaders).toEqual([KEY_A]);
    // One comparable score is no spread, not a spread of 80 against an absent 0.
    expect(baseline?.spread).toBe(0);
  });

  it('is empty when no agent produced a report at all', () => {
    expect(compareScenarios([comparisonAgentFor(AGENT_A, null)])).toEqual([]);
  });
});

describe('robustness comparison', () => {
  it('uses the benchmark engine’s formula, unaltered', () => {
    expect(A_AHEAD.robustness.formula).toBe(BENCHMARK_ROBUSTNESS_FORMULA);
    expect(A_AHEAD.methodology.robustnessFormula).toBe(BENCHMARK_ROBUSTNESS_FORMULA);
  });

  it('measures retention, so a higher-scoring agent can be the less robust one', () => {
    // agent-a scores 80 at baseline and 40 under every perturbation; agent-b
    // scores a flat 60 everywhere. b keeps all of its baseline, a keeps half of
    // it, so b is the robust one despite scoring lower overall.
    const fragile = comparisonFixture({
      agents: [AGENT_A, AGENT_B],
      reports: new Map([
        ['agent-a', { spread: 40, byScenario: { baseline: 80 } }],
        ['agent-b', { spread: 60 }],
      ]),
    });
    expect(metricOf(fragile, 'averageOverallScore').leaders).toEqual([KEY_B]);
    expect(fragile.robustness.scores).toEqual([0.5, 1]);
    expect(fragile.robustness.leaders).toEqual([KEY_B]);
    expect(fragile.robustness.tied).toBe(false);
    expect(fragile.robustness.spread).toBe(0.5);
  });

  it('reports an agent with no robustness score as a spread of one, not as zero', () => {
    const partial = comparisonFixture({
      agents: [AGENT_A, AGENT_B],
      reports: new Map([['agent-a', { spread: 80 }]]),
    });
    expect(partial.robustness.scores).toEqual([1, null]);
    expect(partial.robustness.leaders).toEqual([KEY_A]);
    expect(partial.robustness.tied).toBe(false);
    expect(partial.robustness.spread).toBe(0);
    expect(partial.robustness.unavailableReasons).toEqual([null, null]);
  });

  it('carries the benchmark engine’s stated reason when it declined to compute one', () => {
    const unreadable = comparisonFixture({
      agents: [AGENT_A, AGENT_B],
      reports: new Map([
        ['agent-a', { spread: 80, status: 'UNAVAILABLE' }],
        ['agent-b', { spread: 60 }],
      ]),
    });
    expect(unreadable.robustness.scores[0]).toBeNull();
    expect(unreadable.robustness.unavailableReasons[0]).toBe('NO_EVALUATED_BASELINE');
    expect(unreadable.robustness.leaders).toEqual([KEY_B]);
  });

  it('never invents a second robustness formula', () => {
    // The comparison reports the score; it does not recompute one. A report
    // whose robustness the engine declined to compute stays null here however
    // the other agents scored.
    const both = comparisonFixture({
      agents: [AGENT_A, AGENT_B],
      reports: new Map([
        ['agent-a', { spread: 80, status: 'UNAVAILABLE' }],
        ['agent-b', { spread: 60, status: 'UNAVAILABLE' }],
      ]),
    });
    expect(both.robustness.scores).toEqual([null, null]);
    expect(both.robustness.spread).toBeNull();
    expect(both.robustness.leaders).toEqual([]);
  });
});

describe('failure profile', () => {
  it('lines up every declared failure class, per agent', () => {
    expect(A_AHEAD.failures.map((row) => row.category)).toEqual([...BENCHMARK_FAILURE_CATEGORIES]);
    for (const row of A_AHEAD.failures) expect(row.counts).toHaveLength(2);
  });

  it('reports a clean agent as zero and an absent agent as zero', () => {
    for (const row of A_AHEAD.failures) {
      expect(row.counts).toEqual([0, 0]);
      expect(row.agents).toEqual([]);
    }
    const partial = comparisonFixture({
      agents: [AGENT_A, AGENT_B],
      reports: new Map([['agent-a', { spread: 80 }]]),
    });
    for (const row of partial.failures) expect(row.counts).toEqual([0, 0]);
  });

  it('counts each class from the evidence the benchmark engine classified', () => {
    const failing = comparisonFixture({
      agents: [AGENT_A, AGENT_B],
      reports: new Map([
        [
          'agent-a',
          {
            spread: 80,
            metrics: { objectiveReached: false, rejectedAttempts: 2, failedToolCalls: 1 },
          },
        ],
        ['agent-b', { spread: 80 }],
      ]),
    });
    const rowFor = (category: string) => failing.failures.find((row) => row.category === category);
    expect(rowFor('taskFailure')?.counts).toEqual([7, 0]);
    expect(rowFor('taskFailure')?.metric).toBe('objectiveReached');
    expect(rowFor('invalidActions')?.counts).toEqual([7, 0]);
    expect(rowFor('toolFailures')?.counts).toEqual([7, 0]);
    expect(rowFor('taskFailure')?.agents).toEqual([KEY_A]);
    expect(rowFor('safetyViolation')?.counts).toEqual([0, 0]);
  });

  it('counts a timeout from the run’s own terminal status', () => {
    const timedOut = comparisonFixture({
      agents: [AGENT_A, AGENT_B],
      reports: new Map([
        ['agent-a', { spread: 80, status: 'TIMEOUT' }],
        ['agent-b', { spread: 80 }],
      ]),
    });
    const timeouts = timedOut.failures.find((row) => row.category === 'timeouts');
    expect(timeouts?.counts).toEqual([7, 0]);
    expect(timeouts?.metric).toBeNull();
  });

  it('states a count and nothing more, for a report with no agents at all', () => {
    const rows = buildFailureProfiles([comparisonAgentFor(AGENT_A, null)]);
    expect(rows.every((row) => row.counts[0] === 0)).toBe(true);
  });
});

describe('the verdict', () => {
  it('names the winner the overall score decides, and says which rung decided it', () => {
    expect(A_AHEAD.verdict.outcome).toBe('WINNER');
    expect(A_AHEAD.verdict.winner).toBe(KEY_A);
    expect(A_AHEAD.verdict.winnerIdentity).toBe('agent-a@1');
    expect(A_AHEAD.verdict.decidedBy).toBe('averageOverallScore');
    expect(A_AHEAD.verdict.rule).toBe(COMPARISON_VERDICT_RULE);
  });

  it('consults the discriminators in the declared order, recording every rung', () => {
    expect(A_AHEAD.methodology.discriminators).toEqual([...COMPARISON_DISCRIMINATORS]);
    expect(A_AHEAD.verdict.levels.map((level) => level.metric)).toEqual(['averageOverallScore']);
    const [first] = A_AHEAD.verdict.levels;
    expect(first?.contenders).toEqual([KEY_A, KEY_B]);
    expect(first?.leaders).toEqual([KEY_A]);
    expect(first?.value).toBe(80);
    expect(first?.margin).toBe(20);
    expect(first?.decided).toBe(true);
  });

  it('records the rungs that did not decide before the one that did', () => {
    // Both agents score 80 overall, so the first rung ties and the second —
    // task success — separates them.
    const tiedOnOverall = comparisonFixture({
      agents: [AGENT_A, AGENT_B],
      reports: new Map([
        ['agent-a', { spread: 80, categories: { taskSuccess: 90 } }],
        ['agent-b', { spread: 80, categories: { taskSuccess: 50 } }],
      ]),
    });
    expect(tiedOnOverall.verdict.levels.map((level) => level.metric)).toEqual([
      'averageOverallScore',
      'averageTaskScore',
    ]);
    expect(tiedOnOverall.verdict.levels[0]?.decided).toBe(false);
    expect(tiedOnOverall.verdict.levels[0]?.leaders).toEqual([KEY_A, KEY_B]);
    expect(tiedOnOverall.verdict.decidedBy).toBe('averageTaskScore');
    expect(tiedOnOverall.verdict.winner).toBe(KEY_A);
  });

  it('narrows to the leaders, so an agent already behind cannot win a lower rung', () => {
    const three = comparisonFixture({
      agents: [AGENT_A, AGENT_B, AGENT_C],
      reports: new Map([
        ['agent-a', { spread: 80, categories: { taskSuccess: 50 } }],
        ['agent-b', { spread: 80, categories: { taskSuccess: 90 } }],
        // Scores lower overall but highest on task success: out of contention by
        // the time task success is consulted.
        ['agent-c', { spread: 60, categories: { taskSuccess: 100 } }],
      ]),
    });
    expect(three.verdict.decidedBy).toBe('averageTaskScore');
    expect(three.verdict.winner).toBe(KEY_B);
    const taskRung = three.verdict.levels.find((level) => level.metric === 'averageTaskScore');
    expect(taskRung?.contenders).toEqual([KEY_A, KEY_B]);
    expect(taskRung?.contenders).not.toContain(KEY_C);
  });

  it('returns a tie when every discriminator ties, and names nobody', () => {
    expect(IDENTICAL.verdict.outcome).toBe('TIE');
    expect(IDENTICAL.verdict.winner).toBeNull();
    expect(IDENTICAL.verdict.winnerIdentity).toBeNull();
    expect(IDENTICAL.verdict.decidedBy).toBeNull();
    expect(IDENTICAL.verdict.levels).toHaveLength(COMPARISON_DISCRIMINATORS.length);
    expect(IDENTICAL.verdict.levels.every((level) => !level.decided)).toBe(true);
  });

  it('says the evidence is insufficient when only one agent produced any', () => {
    const oneSided = comparisonFixture({
      agents: [AGENT_A, AGENT_B],
      reports: new Map([['agent-a', { spread: 80 }]]),
    });
    expect(oneSided.verdict.outcome).toBe('INSUFFICIENT_EVIDENCE');
    expect(oneSided.verdict.winner).toBeNull();
    expect(oneSided.verdict.decidedBy).toBeNull();
    expect(oneSided.verdict.reason).toMatch(/agent-a@1/);
  });

  it('says the evidence is insufficient when no agent produced anything scorable', () => {
    const none = comparisonFixture({
      agents: [AGENT_A, AGENT_B],
      reports: new Map([
        ['agent-a', { spread: 80, status: 'UNAVAILABLE' }],
        ['agent-b', { spread: 60, status: 'UNAVAILABLE' }],
      ]),
    });
    expect(none.verdict.outcome).toBe('INSUFFICIENT_EVIDENCE');
    expect(none.verdict.reason).toMatch(/no evidence to compare/i);
  });

  it('does not mistake a tie for a win', () => {
    expect(IDENTICAL.verdict.winner).toBeNull();
    expect(
      decideVerdict([comparisonAgentFor(AGENT_A, null), comparisonAgentFor(AGENT_B, null)]).outcome,
    ).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('refuses to decide a single-agent experiment', () => {
    expect(decideVerdict([comparisonAgentFor(AGENT_A, { spread: 80 })]).outcome).toBe(
      'INSUFFICIENT_EVIDENCE',
    );
  });
});

describe('the report is a function of the agent set, not of its order', () => {
  const reports = new Map<string, AgentScores>([
    ['agent-a', { spread: 80, categories: { safety: 40 } }],
    ['agent-b', { spread: 60 }],
    ['agent-c', { spread: 70, statusByScenario: { 'elevated-risk': 'FAILED' } }],
  ]);

  const forward = comparisonFixture({ agents: [AGENT_A, AGENT_B, AGENT_C], reports });
  const backward = comparisonFixture({ agents: [AGENT_C, AGENT_B, AGENT_A], reports });
  const shuffled = comparisonFixture({ agents: [AGENT_B, AGENT_C, AGENT_A], reports });

  it('produces the same experiment key from any ordering of the same agents', () => {
    expect(backward.experiment.key).toBe(forward.experiment.key);
    expect(shuffled.experiment.key).toBe(forward.experiment.key);
  });

  it('produces byte-identical metrics, scenarios, robustness, failures and verdict', () => {
    expect(backward.metrics).toEqual(forward.metrics);
    expect(backward.scenarios).toEqual(forward.scenarios);
    expect(backward.robustness).toEqual(forward.robustness);
    expect(backward.failures).toEqual(forward.failures);
    expect(backward.verdict).toEqual(forward.verdict);
    expect(backward.headToHead).toEqual(forward.headToHead);
    expect(backward.agents.map((agent) => agent.key)).toEqual(
      forward.agents.map((agent) => agent.key),
    );
  });

  it('carries the whole per-agent evidence, so a report can be drilled into', () => {
    for (const agent of forward.agents) {
      if (!agent.report) continue;
      // The run ids and case verdicts a UI would follow are all here.
      expect(agent.report.runs.length).toBeGreaterThan(0);
      expect(agent.report.runs.every((run) => run.runId.length > 0)).toBe(true);
      expect(agent.report.scenarios.length).toBe(forward.experiment.scenarios.length);
    }
  });

  it('recomputes identically: the same report twice is the same report', () => {
    const again = comparisonFixture({ agents: [AGENT_A, AGENT_B, AGENT_C], reports });
    expect(again).toEqual(forward);
  });
});
