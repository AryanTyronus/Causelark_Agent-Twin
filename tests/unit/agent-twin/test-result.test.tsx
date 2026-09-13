// @polsia:user-owned — the result page, rendered.
//
// A comparison report is deliberately not persisted, so this page has three
// distinct things to say and must never blur them:
//
//   1. A report this browser session still holds is shown in full, and labelled
//      as held here — not as a record.
//   2. A report this session does not hold is reported as exactly that, beside
//      the persisted runs it would be derived from. This is the property that
//      matters most: the page must not reconstruct a plausible report from the
//      runs it can read, because that would be a second implementation of the
//      comparison engine. The assertion is therefore that no verdict appears.
//   3. An experiment the deployment does not register, with nothing held here,
//      is reported as unknown rather than shown as an empty result.
//
// The store is the real one — a report is seeded through `storeReport`, the same
// call the run flow makes — so what the page reads is what the product writes.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  requested: [] as string[],
  responses: new Map<string, unknown>(),
  failures: new Map<string, number>(),
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: async (path: string) => {
    api.requested.push(path);
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

import { storeReport } from '@/components/custom/agent-twin/store';
import { TestResult } from '@/components/custom/agent-twin/test-result';
import { listExperimentSummaries } from '@/lib/comparison/catalog';
import { agentFixture, comparisonFixture, EXPERIMENT_ID } from '../comparison.fixtures';
import { render } from './render';

const RUNS_PATH = '/api/simulations/runs';
const EXPERIMENTS_PATH = '/api/agent-comparisons';

const EXPERIMENTS = listExperimentSummaries();
const EXPERIMENT = EXPERIMENTS.find((entry) => entry.id === EXPERIMENT_ID);
if (!EXPERIMENT) throw new Error(`Fixture: ${EXPERIMENT_ID} is not registered.`);

/** A two-agent report the real comparison engine produced, decided by the rule. */
function reportFixture() {
  return comparisonFixture({
    agents: [
      agentFixture({ agentId: 'agent-a', agentVersion: '1', model: 'model-a' }),
      agentFixture({ agentId: 'agent-b', agentVersion: '1', model: 'model-b' }),
    ],
    reports: new Map([
      ['agent-a', { spread: 92 }],
      ['agent-b', { spread: 38 }],
    ]),
  });
}

/** One recorded run, in the shape the runs endpoint serves. */
function runSummary(id: string, seed: number) {
  return {
    id,
    environmentKey: 'resource-routing',
    objectiveKey: 'complete-delivery',
    seed,
    status: 'COMPLETED',
    agentStatus: 'COMPLETED',
    step: 10,
    maxSteps: 24,
    budgetRemaining: 5,
    scenario: { id: 'baseline', version: 1 },
    terminationReason: null,
    failureDetails: null,
    createdAt: '2026-09-13T09:15:00.000Z',
    updatedAt: '2026-09-13T09:16:00.000Z',
  };
}

function serve(input: { runs?: unknown[]; experiments?: unknown[] } = {}): void {
  api.responses.set(RUNS_PATH, { runs: input.runs ?? [] });
  api.responses.set(EXPERIMENTS_PATH, { experiments: input.experiments ?? EXPERIMENTS });
}

beforeEach(() => {
  api.requested = [];
  api.responses = new Map();
  api.failures = new Map();
  window.sessionStorage.clear();
  serve();
});

describe('a result held by this browser session', () => {
  it('shows the report it holds, and says the result is held here rather than stored', async () => {
    const report = reportFixture();
    expect(report.verdict.outcome).toBe('WINNER');
    storeReport(report);

    const view = await render(<TestResult experimentId={EXPERIMENT_ID} />);

    // The engine's own verdict and its own reason, rendered whole.
    expect(view.has(report.verdict.outcome.replaceAll('_', ' '))).toBe(true);
    expect(view.has(report.verdict.reason)).toBe(true);
    // And the provenance of the copy on screen: a browser session, not a record.
    expect(view.has('This result is held in this browser.')).toBe(true);
    expect(view.has('Agent Twin does not store comparison reports')).toBe(true);
    expect(view.has('lasts until this browser session ends')).toBe(true);
    await view.unmount();
  });

  it('offers the two things a reader can do with a result: read the runs, or run it again', async () => {
    storeReport(reportFixture());
    const view = await render(<TestResult experimentId={EXPERIMENT_ID} />);
    const hrefs = view.all('a').map((anchor) => anchor.getAttribute('href'));

    expect(hrefs).toContain('/dashboard/simulations');
    expect(hrefs).toContain('/dashboard/tests');
    await view.unmount();
  });

  it('names the experiment the result came from', async () => {
    storeReport(reportFixture());
    const view = await render(<TestResult experimentId={EXPERIMENT_ID} />);

    expect(view.has(reportFixture().experiment.name)).toBe(true);
    expect(view.has(`${EXPERIMENT_ID}@${EXPERIMENT.version}`)).toBe(true);
    await view.unmount();
  });
});

describe('an experiment this session holds no report for', () => {
  it('says the report is not held here, and does not reconstruct one', async () => {
    serve({ runs: [runSummary('run-1', 1042), runSummary('run-2', 7)] });
    const view = await render(<TestResult experimentId={EXPERIMENT_ID} />);

    expect(view.has('This browser session does not hold a report for this experiment.')).toBe(true);
    expect(view.has('Comparison reports are not stored')).toBe(true);

    // The critical assertion: the runs are readable, and the page still prints
    // no verdict. Recomputing the comparison in the browser would be a second
    // comparison engine, and the page must not become one.
    expect(view.has('WINNER')).toBe(false);
    expect(view.has('performed better under these conditions')).toBe(false);
    expect(view.has('No difference the declared rule could separate')).toBe(false);
    expect(view.has('Insufficient evidence to name a winner')).toBe(false);
    await view.unmount();
  });

  it('describes the experiment that would produce one, from its registration', async () => {
    serve({ runs: [runSummary('run-1', 1042)] });
    const view = await render(<TestResult experimentId={EXPERIMENT_ID} />);

    // The test's own fixed inputs, so a reader can see what re-running means.
    expect(view.has(EXPERIMENT.name)).toBe(true);
    expect(view.has(`${EXPERIMENT.benchmarkId}@${EXPERIMENT.benchmarkVersion}`)).toBe(true);
    expect(view.has(EXPERIMENT.verdictRule)).toBe(true);
    expect(view.has(EXPERIMENT.methodology)).toBe(true);
    await view.unmount();
  });

  it('offers the persisted runs, because the runs are the evidence', async () => {
    serve({ runs: [runSummary('run-1', 1042)] });
    const view = await render(<TestResult experimentId={EXPERIMENT_ID} />);

    expect(view.has('Recorded runs for this account')).toBe(true);
    expect(view.has('baseline@1')).toBe(true);
    expect(view.has('1042')).toBe(true);
    const hrefs = view.all('a').map((anchor) => anchor.getAttribute('href'));
    expect(hrefs).toContain('/dashboard/simulations/run-1');
    await view.unmount();
  });

  it('reports an account with no runs as having no evidence, not as a zero result', async () => {
    const view = await render(<TestResult experimentId={EXPERIMENT_ID} />);

    expect(view.has('No runs recorded yet')).toBe(true);
    expect(view.has('there is no evidence to read')).toBe(true);
    await view.unmount();
  });
});

describe('an experiment this deployment does not register', () => {
  it('reports it as unknown rather than as an empty result', async () => {
    const view = await render(<TestResult experimentId="no-such-experiment" />);

    expect(view.has('Unknown experiment')).toBe(true);
    expect(view.has('no-such-experiment')).toBe(true);
    expect(view.has('this browser session holds no result for it')).toBe(true);
    // Nothing is offered to run, because there is nothing registered to run.
    expect(view.has('Run this experiment')).toBe(false);
    expect(view.has('apiFetch')).toBe(false);
    await view.unmount();
  });

  it('still shows a result this session holds for an experiment that is no longer registered', async () => {
    // A report is evidence of what was run, so it stays readable even if the
    // registration it came from has since been withdrawn.
    const report = reportFixture();
    storeReport(report);
    const view = await render(<TestResult experimentId={EXPERIMENT_ID} />);

    expect(view.has('Unknown experiment')).toBe(false);
    expect(view.has(report.verdict.reason)).toBe(true);
    await view.unmount();
  });

  it('reports an unreadable catalogue as unreadable, not as an unknown experiment', async () => {
    api.failures.set(EXPERIMENTS_PATH, 500);
    api.failures.set(RUNS_PATH, 500);
    const view = await render(<TestResult experimentId={EXPERIMENT_ID} />);

    expect(view.has('Result unavailable')).toBe(true);
    expect(view.has('cannot tell whether this experiment exists')).toBe(true);
    // The page never asserts that an experiment does not exist on the strength
    // of a catalogue it could not read.
    expect(view.has('Unknown experiment')).toBe(false);
    expect(view.has('apiFetch')).toBe(false);
    await view.unmount();
  });
});
