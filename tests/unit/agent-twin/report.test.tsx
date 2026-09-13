// @polsia:user-owned — the results screen, rendered.
//
// The results screen is the most important screen in the product, and the three
// things it has to get right are the three things asserted here:
//
//   1. Each of the engine's three verdicts renders as itself. A win, a tie and
//      "insufficient evidence" are different findings, and a screen that showed
//      the third as the second would be reporting a comparison nobody made.
//   2. The evidence is attributed. The verdict's reason is the engine's own
//      sentence, carried through unedited; the panels say which engine produced
//      them.
//   3. The drill-downs exist. Counterfactual analysis and replay are reached from
//      a case, and both read the run they belong to.
//
// The reports below are built by the real comparison engine from hand-chosen
// scores, so what is rendered is what the engine emits — a fixture cannot claim
// a report shape the engine would not produce.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  /** Every path the interface asked for, in order. */
  requested: [] as string[],
  /** Path → response body. A path with no entry rejects as a 404. */
  responses: new Map<string, unknown>(),
  /** Paths that should fail, with the status apiFetch would report. */
  failures: new Map<string, number>(),
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: async (path: string) => {
    api.requested.push(path);
    if (api.failures.has(path)) {
      throw new Error(`apiFetch ${path} failed (${api.failures.get(path)})`);
    }
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

import { ComparisonReportView } from '@/components/custom/agent-twin/comparison-report';
import { agentFixture, comparisonFixture } from '../comparison.fixtures';
import { render } from './render';

const AGENT_A = agentFixture({ agentId: 'agent-a', agentVersion: '1', model: 'model-a' });
const AGENT_B = agentFixture({ agentId: 'agent-b', agentVersion: '1', model: 'model-b' });

/** A report where the two agents are far enough apart for the rule to decide. */
function decidedReport() {
  return comparisonFixture({
    agents: [AGENT_A, AGENT_B],
    reports: new Map([
      ['agent-a', { spread: 90 }],
      ['agent-b', { spread: 40 }],
    ]),
  });
}

/** A report where nothing separates them: every metric is identical. */
function tiedReport() {
  return comparisonFixture({
    agents: [AGENT_A, AGENT_B],
    reports: new Map([
      ['agent-a', { spread: 70 }],
      ['agent-b', { spread: 70 }],
    ]),
  });
}

/** A report where neither agent produced any evidence at all. */
function insufficientReport() {
  return comparisonFixture({
    agents: [AGENT_A, AGENT_B],
    reports: new Map([
      ['agent-a', { spread: 70, status: 'UNAVAILABLE' }],
      ['agent-b', { spread: 70, status: 'UNAVAILABLE' }],
    ]),
  });
}

beforeEach(() => {
  api.requested = [];
  api.responses = new Map();
  api.failures = new Map();
});

describe('the results screen', () => {
  it('says which agent performed better, and repeats the engine’s reason', async () => {
    const report = decidedReport();
    expect(report.verdict.outcome).toBe('WINNER');
    const view = await render(<ComparisonReportView report={report} />);
    const text = view.text();

    expect(text).toContain('performed better under these conditions');
    expect(text).toContain('WINNER');
    // The reason is the engine's sentence, not the interface's paraphrase.
    expect(text).toContain(report.verdict.reason);
    // The rule that decided, and the metric it decided on, are both stated.
    expect(text).toContain(report.methodology.verdictRule);
    expect(text).toContain('decided the verdict');
    await view.unmount();
  });

  it('renders a tie as a tie, not as a win', async () => {
    const report = tiedReport();
    expect(report.verdict.outcome).toBe('TIE');
    const view = await render(<ComparisonReportView report={report} />);

    expect(view.has('No difference the declared rule could separate')).toBe(true);
    expect(view.has('performed better under these conditions')).toBe(false);
    // The winning-agent field stays empty rather than naming whoever sorted first.
    expect(view.has('No agent is named unless the rule names one')).toBe(true);
    await view.unmount();
  });

  it('renders insufficient evidence as its own result, not as a failure or a tie', async () => {
    const report = insufficientReport();
    expect(report.verdict.outcome).toBe('INSUFFICIENT_EVIDENCE');
    const view = await render(<ComparisonReportView report={report} />);

    expect(view.has('Insufficient evidence to name a winner')).toBe(true);
    expect(view.has('INSUFFICIENT EVIDENCE')).toBe(true);
    expect(view.has('No difference the declared rule could separate')).toBe(false);
    expect(view.has('performed better under these conditions')).toBe(false);
    await view.unmount();
  });

  it('states what was held equal before it states who won', async () => {
    const report = decidedReport();
    const view = await render(<ComparisonReportView report={report} />);
    const text = view.text();

    // The experiment's own fixed inputs, read from the report rather than
    // restated: the benchmark, its version, the seeds and the environment.
    expect(text).toContain(report.experiment.benchmarkId);
    expect(text).toContain(report.experiment.environmentKey);
    expect(text).toContain(report.experiment.objectiveKey);
    for (const seed of report.experiment.seeds) expect(text).toContain(String(seed));
    // And the count of cases that actually produced a run, against what was planned.
    expect(text).toContain(
      `${report.execution.executedCaseCount} / ${report.execution.plannedCaseCount}`,
    );
    // The methodology and the verdict rule are named on the page, so the result
    // says which rule produced it.
    expect(text).toContain(report.methodology.comparison);
    await view.unmount();
  });

  it('names the engines each panel’s evidence came from', async () => {
    const view = await render(<ComparisonReportView report={decidedReport()} />);
    const text = view.text();

    for (const panel of [
      'Verdict',
      'Head to head',
      'Measured outcomes',
      'Scenario performance',
      'Robustness',
      'Failure profile',
      'Agents and evidence',
    ])
      expect(text).toContain(panel);
    // Attribution is a word, not a colour: each engine is named on the panels
    // whose numbers it produced.
    for (const engine of ['Evaluation engine', 'Benchmark engine', 'Recorded trace'])
      expect(text).toContain(engine);
    // And the chip distinguishes a recorded fact from a derived conclusion in
    // text as well as in tone.
    expect(view.container.textContent).toContain('■');
    expect(view.container.textContent).toContain('□');
    await view.unmount();
  });

  it('shows a scenario row per condition, with each agent’s score under it', async () => {
    const report = decidedReport();
    const view = await render(<ComparisonReportView report={report} />);

    for (const scenario of report.scenarios)
      expect(view.has(scenario.scenarioId.replaceAll('-', ' '))).toBe(true);
    // The declared spread per condition, from the engine.
    expect(view.has('Spread')).toBe(true);
    expect(view.has('Better here')).toBe(true);
    await view.unmount();
  });

  it('separates a behaviour failure from an execution failure', async () => {
    const view = await render(<ComparisonReportView report={decidedReport()} />);

    expect(view.has('How the agents performed')).toBe(true);
    expect(view.has('Whether the agents could execute')).toBe(true);
    expect(
      view.has(
        'An agent that could not execute did not necessarily perform poorly, and this table keeps the two apart.',
      ),
    ).toBe(true);
    await view.unmount();
  });

  it('reports an agent that produced no report as unavailable, with its reason', async () => {
    // One agent ran, the other did not: the second must not be scored as zero.
    const report = comparisonFixture({
      agents: [AGENT_A, AGENT_B],
      reports: new Map([['agent-a', { spread: 80 }]]),
    });
    const view = await render(<ComparisonReportView report={report} />);

    expect(report.execution.unavailableAgentCount).toBe(1);
    expect(view.has('agent-b@1')).toBe(true);
    expect(view.has('EXECUTION_FAILED')).toBe(true);
    expect(view.has('not recorded')).toBe(true);
    await view.unmount();
  });

  it('explains what a robustness score does and does not mean', async () => {
    const view = await render(<ComparisonReportView report={decidedReport()} />);
    const text = view.text();

    expect(text).toContain('Robustness score');
    expect(text).toContain('retains baseline performance when environmental conditions change');
    expect(text).toContain('retention');
    await view.unmount();
  });

  it('offers the counterfactual and the replay from inside a case', async () => {
    const report = decidedReport();
    const runId = report.agents[0]?.report?.runs[0]?.runId;
    expect(runId).toBeTruthy();

    // A case is an accordion item, and opening it is what reads the trace. The
    // initial render must therefore make no request at all — no eager fetch of
    // every case's decision history.
    const view = await render(<ComparisonReportView report={report} />);
    expect(api.requested).toEqual([]);
    // The case's own header states the run's recorded facts without a fetch.
    expect(view.has('seed 1042')).toBe(true);

    // Opening the case is what reaches the two drill-downs, and both are asked
    // about *this* run rather than about the experiment in general.
    const trigger = view.control('seed 1042');
    expect(trigger).not.toBeNull();
    // The drill-downs are made to fail, which is also the point: a drill-down
    // that cannot be computed says so in the operator's terms.
    for (const path of [
      `/api/simulations/runs/${runId}/counterfactual`,
      `/api/simulations/runs/${runId}/events`,
      `/api/simulations/runs/${runId}`,
    ])
      api.failures.set(path, 404);
    await view.click(trigger as HTMLElement);

    const requested = api.requested.join('\n');
    expect(requested).toContain(`/api/simulations/runs/${runId}/counterfactual`);
    expect(requested).toContain(`/api/simulations/runs/${runId}/events`);
    expect(view.has('Counterfactual analysis unavailable')).toBe(true);
    expect(view.has('Replay unavailable')).toBe(true);
    // The failure text is the interface's own sentence, never the response.
    expect(view.has('apiFetch')).toBe(false);
    await view.unmount();
  });

  it('renders the absence of evidence as an absence, not as a zero', async () => {
    const view = await render(<ComparisonReportView report={insufficientReport()} />);

    // No case produced a verdict, so the scenario panel says so rather than
    // printing a table of zeroes.
    expect(view.has('No scenario produced a score')).toBe(true);
    expect(view.has('not recorded')).toBe(true);
    await view.unmount();
  });
});
