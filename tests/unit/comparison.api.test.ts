// @vitest-environment node
// @polsia:user-owned — the comparison API, driven through the real route handlers.
//
// The handlers under test are the shipped ones. Authentication is replaced (so a
// signed-out caller can be simulated) and the execution seam is replaced (so
// every error-code-to-status mapping can be exercised without running a
// simulation), while the catalogue, the experiment resolution and the plan are
// the real modules: what a caller receives here is what the deployment actually
// serves.
//
// Nothing in this file reads a credential, and no test asserts on one — reading
// an environment variable into an assertion would put a live secret into the
// output if it ever failed.

import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** When set, the auth gate refuses with this status. */
  unauthorized: false,
  /** The signed-in caller every authenticated request is attributed to. */
  userId: 'user-1',
  /** The error `executeComparison` should raise, if any. */
  failWith: null as { code: string; message: string } | null,
  /** A value that is not a `ComparisonError`, to exercise the fallback. */
  failWithUnknown: false,
  /** Every input the execution seam was handed. */
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock('server-only', () => ({}));

vi.mock('@/lib/require-auth', () => ({
  requireAuth: async () => {
    if (mocks.unauthorized) throw NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return { id: mocks.userId, email: 'owner@example.test' };
  },
}));

vi.mock('@/lib/comparison/execute', () => ({
  executeComparison: async (input: Record<string, unknown>) => {
    mocks.calls.push(input);
    if (mocks.failWithUnknown) throw new Error('a database password appeared here');
    if (mocks.failWith) {
      const { ComparisonError } = await import('@/lib/comparison/types');
      throw new ComparisonError(mocks.failWith.code as never, mocks.failWith.message);
    }
    const { comparisonFixture } = await import('./comparison.fixtures');
    return comparisonFixture({
      agents: [
        { agentId: 'agent-a', agentVersion: '1', provider: 'bedrock', model: 'model-a' },
        { agentId: 'agent-b', agentVersion: '1', provider: 'bedrock', model: 'model-b' },
      ],
      reports: new Map([
        ['agent-a', { spread: 80 }],
        ['agent-b', { spread: 60 }],
      ]),
    });
  },
}));

import { GET as getPlan } from '@/app/api/agent-comparisons/[comparisonId]/route';
import { POST as runComparison } from '@/app/api/agent-comparisons/[comparisonId]/run/route';
import { GET as listExperiments } from '@/app/api/agent-comparisons/route';
import { ExperimentCatalog, ExperimentPlan } from '@/lib/comparison/types';

const EXPERIMENT_ID = 'resource-routing-agent-comparison';
const CATALOG_URL = 'http://localhost/api/agent-comparisons';
const PLAN_URL = `${CATALOG_URL}/${EXPERIMENT_ID}`;
const RUN_URL = `${PLAN_URL}/run`;

const AGENT_A = { agentId: 'agent-a', agentVersion: '1', provider: 'bedrock', model: 'model-a' };
const AGENT_B = { agentId: 'agent-b', agentVersion: '1', provider: 'bedrock', model: 'model-b' };

beforeEach(() => {
  mocks.unauthorized = false;
  mocks.userId = 'user-1';
  mocks.failWith = null;
  mocks.failWithUnknown = false;
  mocks.calls = [];
});

const params = (comparisonId: string) => ({ params: Promise.resolve({ comparisonId }) });

function postRequest(body: string, url = RUN_URL) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

async function bodyOf(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe('GET /api/agent-comparisons', () => {
  it('serves the compiled catalogue', async () => {
    const response = await listExperiments(new Request(CATALOG_URL));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(() => ExperimentCatalog.parse(body)).not.toThrow();
    const experiments = body.experiments as Array<Record<string, unknown>>;
    expect(experiments.map((entry) => entry.id)).toEqual([EXPERIMENT_ID]);
  });

  it('states the methodology and the bounds without naming an agent', async () => {
    const body = await bodyOf(await listExperiments(new Request(CATALOG_URL)));
    const [experiment] = body.experiments as Array<Record<string, unknown>>;
    expect(experiment?.methodology).toBe('same-conditions-head-to-head-v1');
    expect(experiment?.verdictRule).toBe('declared-discriminator-order-v1');
    expect(experiment?.benchmarkId).toBe('resource-routing-robustness');
    expect(experiment?.caseCountPerAgent).toBe(7);
    expect(experiment?.minimumAgents).toBe(2);
    expect(experiment?.maximumAgents).toBe(4);
    // No template names a provider, a model or an agent.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toMatch(/bedrock|openrouter|anthropic|openai|claude|gpt-/i);
  });

  it('refuses a caller who is not signed in', async () => {
    mocks.unauthorized = true;
    const response = await listExperiments(new Request(CATALOG_URL));
    expect(response.status).toBe(401);
  });
});

describe('GET /api/agent-comparisons/[comparisonId]', () => {
  it('returns the plan an experiment would run, without running it', async () => {
    const response = await getPlan(new Request(PLAN_URL), params(EXPERIMENT_ID));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(() => ExperimentPlan.parse(body)).not.toThrow();
    const plan = ExperimentPlan.parse(body);
    expect(plan.cases).toHaveLength(7);
    expect(plan.seeds).toEqual([1042]);
    expect(plan.experiment.caseCountPerAgent).toBe(plan.cases.length);
    expect(plan.experiment.seedCount).toBe(plan.seeds.length);
    expect(plan.cases[0]).toMatchObject({
      index: 0,
      scenarioId: 'baseline',
      scenarioVersion: 1,
      seed: 1042,
      isBaseline: true,
    });
    // A plan is a property of the template and its benchmark: it names no agent,
    // because the agents are the caller's to declare. Nor does it name a
    // provider or a model, and it reports nothing about an agent — there is no
    // evidence yet for a report to be derived from.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toMatch(/"agents"|agentId|agentVersion|"provider"|"model"/);
    expect(body).not.toHaveProperty('metrics');
    expect(body).not.toHaveProperty('headToHead');
  });

  it('serves the newest shipped version when the caller pins none', async () => {
    const unpinned = await bodyOf(await getPlan(new Request(PLAN_URL), params(EXPERIMENT_ID)));
    const pinned = await bodyOf(
      await getPlan(new Request(`${PLAN_URL}?version=1`), params(EXPERIMENT_ID)),
    );
    expect(pinned).toEqual(unpinned);
    expect((pinned.experiment as { version: number }).version).toBe(1);
  });

  it('serves the benchmark engine’s own matrix rather than a second description', async () => {
    const body = await bodyOf(await getPlan(new Request(PLAN_URL), params(EXPERIMENT_ID)));
    const cases = (body.cases as Array<Record<string, unknown>>).map((entry) => entry.key);
    expect(cases).toEqual([
      'baseline@1#1042',
      'resource-scarcity@1#1042',
      'budget-pressure@1#1042',
      'elevated-risk@1#1042',
      'resource-outage@1#1042',
      'tight-step-limit@1#1042',
      'action-rejection@1#1042',
    ]);
  });

  it('answers an unknown experiment with 404', async () => {
    const response = await getPlan(new Request(CATALOG_URL), params('no-such-experiment'));
    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toMatchObject({ code: 'UNKNOWN_EXPERIMENT' });
  });

  it('answers a version the catalogue does not ship with 404, not the current one', async () => {
    const response = await getPlan(new Request(`${PLAN_URL}?version=99`), params(EXPERIMENT_ID));
    expect(response.status).toBe(404);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ code: 'UNKNOWN_EXPERIMENT' });
    // The caller is told which version it asked for, rather than being handed
    // the current one as though the request had meant it.
    expect(String(body.error)).toMatch(/version 99/);
  });

  it('refuses a version that is not a plain integer', async () => {
    // `Number.parseInt` would read `1.5` and `1v2` as version 1 and answer for an
    // experiment the caller never asked about.
    for (const version of ['1.5', '1v2', '-1', 'abc', '', ' ']) {
      const response = await getPlan(
        new Request(`${PLAN_URL}?version=${encodeURIComponent(version)}`),
        params(EXPERIMENT_ID),
      );
      expect(response.status, `version=${JSON.stringify(version)}`).toBe(400);
      expect(await bodyOf(response)).toHaveProperty('error');
    }
  });

  it('refuses a caller who is not signed in', async () => {
    mocks.unauthorized = true;
    expect((await getPlan(new Request(PLAN_URL), params(EXPERIMENT_ID))).status).toBe(401);
  });
});

describe('POST /api/agent-comparisons/[comparisonId]/run', () => {
  const validBody = () => JSON.stringify({ agents: [AGENT_A, AGENT_B] });

  it('runs the comparison and returns the report', async () => {
    const response = await runComparison(postRequest(validBody()), params(EXPERIMENT_ID));
    expect(response.status).toBe(201);
    const report = (await bodyOf(response)) as {
      verdict?: { outcome?: string };
      agents?: unknown[];
    };
    expect(report.agents).toHaveLength(2);
    expect(report.verdict?.outcome).toBe('WINNER');
  });

  it('scopes the experiment to the signed-in owner and nothing else', async () => {
    await runComparison(postRequest(validBody()), params(EXPERIMENT_ID));
    expect(mocks.calls).toHaveLength(1);
    expect(mocks.calls[0]?.ownerId).toBe('user-1');
    expect(mocks.calls[0]?.comparisonId).toBe(EXPERIMENT_ID);
  });

  it('passes only the agents and an optional seed set to the engine', async () => {
    await runComparison(
      postRequest(JSON.stringify({ agents: [AGENT_A, AGENT_B], seeds: [1042] })),
      params(EXPERIMENT_ID),
    );
    const call = mocks.calls[0] ?? {};
    expect(Object.keys(call).sort()).toEqual(['agents', 'comparisonId', 'ownerId', 'seeds']);
    expect(call.seeds).toEqual([1042]);
  });

  it('cannot be handed a benchmark, a scenario list or a scoring rule', async () => {
    // Extra keys are stripped by the schema, not passed through: the experiment
    // is resolved from the server-side catalogue.
    await runComparison(
      postRequest(
        JSON.stringify({
          agents: [AGENT_A, AGENT_B],
          benchmarkId: 'something-else',
          scenarios: ['baseline'],
          weights: { safety: 1 },
          verdict: 'agent-b',
        }),
      ),
      params(EXPERIMENT_ID),
    );
    const call = mocks.calls[0] ?? {};
    expect(Object.keys(call).sort()).toEqual(['agents', 'comparisonId', 'ownerId', 'seeds']);
    expect(JSON.stringify(call)).not.toMatch(/something-else|weights|verdict/);
  });

  it('refuses a body that is not valid JSON, distinctly from an empty one', async () => {
    const response = await runComparison(postRequest('{not json'), params(EXPERIMENT_ID));
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({ errors: { form: expect.any(String) } });
    expect(mocks.calls).toHaveLength(0);
  });

  it('refuses an empty body, because a comparison needs agents', async () => {
    const response = await runComparison(postRequest(''), params(EXPERIMENT_ID));
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).errors).toHaveProperty('agents');
    expect(mocks.calls).toHaveLength(0);
  });

  it('refuses fewer than two agents, before reaching the engine', async () => {
    const response = await runComparison(
      postRequest(JSON.stringify({ agents: [AGENT_A] })),
      params(EXPERIMENT_ID),
    );
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).errors).toHaveProperty('agents');
    expect(mocks.calls).toHaveLength(0);
  });

  it('refuses zero agents', async () => {
    const response = await runComparison(
      postRequest(JSON.stringify({ agents: [] })),
      params(EXPERIMENT_ID),
    );
    expect(response.status).toBe(400);
    expect(mocks.calls).toHaveLength(0);
  });

  it('refuses more agents than the request schema allows, before reaching the engine', async () => {
    const agents = Array.from({ length: 9 }, (_value, index) => ({
      agentId: `agent-${index}`,
      agentVersion: '1',
      provider: 'bedrock',
      model: `model-${index}`,
    }));
    const response = await runComparison(
      postRequest(JSON.stringify({ agents })),
      params(EXPERIMENT_ID),
    );
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).errors).toHaveProperty('agents');
    expect(mocks.calls).toHaveLength(0);
  });

  it('refuses a malformed agent identifier', async () => {
    for (const agent of [
      { ...AGENT_A, agentId: 'Agent A' },
      { ...AGENT_A, agentId: '' },
      { ...AGENT_A, agentVersion: 'v 1' },
      { ...AGENT_A, provider: 'bed rock' },
      { ...AGENT_A, model: 'model|a' },
      { agentId: 'agent-a', agentVersion: '1', provider: 'bedrock' },
    ]) {
      const response = await runComparison(
        postRequest(JSON.stringify({ agents: [agent, AGENT_B] })),
        params(EXPERIMENT_ID),
      );
      expect(response.status, JSON.stringify(agent)).toBe(400);
    }
    expect(mocks.calls).toHaveLength(0);
  });

  it('refuses a malformed seed set', async () => {
    for (const seeds of [[], [-1], [1.5], ['x'], [1000000]]) {
      const response = await runComparison(
        postRequest(JSON.stringify({ agents: [AGENT_A, AGENT_B], seeds })),
        params(EXPERIMENT_ID),
      );
      expect(response.status, JSON.stringify(seeds)).toBe(400);
    }
    expect(mocks.calls).toHaveLength(0);
  });

  it('maps an unknown experiment to 404', async () => {
    mocks.failWith = { code: 'UNKNOWN_EXPERIMENT', message: 'Unknown experiment: nope.' };
    const response = await runComparison(postRequest(validBody()), params('nope'));
    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toMatchObject({ code: 'UNKNOWN_EXPERIMENT' });
  });

  it('maps a duplicate agent to 400', async () => {
    mocks.failWith = { code: 'DUPLICATE_AGENT', message: 'Agent agent-a@1 appears twice.' };
    const response = await runComparison(postRequest(validBody()), params(EXPERIMENT_ID));
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({ code: 'DUPLICATE_AGENT' });
  });

  it('maps a too-few-agents refusal to 400', async () => {
    mocks.failWith = { code: 'TOO_FEW_AGENTS', message: 'A comparison needs at least 2 agents.' };
    const response = await runComparison(postRequest(validBody()), params(EXPERIMENT_ID));
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({ code: 'TOO_FEW_AGENTS' });
  });

  it('maps an unrunnable agent configuration to 503', async () => {
    mocks.failWith = { code: 'INVALID_AGENT_CONFIGURATION', message: 'Unusable provider.' };
    const response = await runComparison(postRequest(validBody()), params(EXPERIMENT_ID));
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toMatchObject({ code: 'INVALID_AGENT_CONFIGURATION' });
  });

  it('maps an oversized matrix to 413', async () => {
    mocks.failWith = { code: 'MATRIX_TOO_LARGE', message: 'Above the 28 this engine will drive.' };
    const response = await runComparison(postRequest(validBody()), params(EXPERIMENT_ID));
    expect(response.status).toBe(413);
    expect(await bodyOf(response)).toMatchObject({ code: 'MATRIX_TOO_LARGE' });
  });

  it('maps an unusable report to 500', async () => {
    mocks.failWith = { code: 'INVALID_REPORT', message: 'The report could not be assembled.' };
    const response = await runComparison(postRequest(validBody()), params(EXPERIMENT_ID));
    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toMatchObject({ code: 'INVALID_REPORT' });
  });

  it('reports an unexpected failure without leaking what it was', async () => {
    mocks.failWithUnknown = true;
    const response = await runComparison(postRequest(validBody()), params(EXPERIMENT_ID));
    expect(response.status).toBe(500);
    const body = await bodyOf(response);
    expect(body).toEqual({ error: 'Internal Server Error' });
    expect(JSON.stringify(body)).not.toMatch(/password|secret|key/i);
  });

  it('refuses a caller who is not signed in, and runs nothing', async () => {
    mocks.unauthorized = true;
    const response = await runComparison(postRequest(validBody()), params(EXPERIMENT_ID));
    expect(response.status).toBe(401);
    expect(mocks.calls).toHaveLength(0);
  });

  it('attributes every experiment to the caller, never to a body field', async () => {
    await runComparison(
      postRequest(JSON.stringify({ agents: [AGENT_A, AGENT_B], ownerId: 'someone-else' })),
      params(EXPERIMENT_ID),
    );
    expect(mocks.calls[0]?.ownerId).toBe('user-1');
  });

  it('serves no secret, no credential and no provider error text', async () => {
    const response = await runComparison(postRequest(validBody()), params(EXPERIMENT_ID));
    const serialised = JSON.stringify(await bodyOf(response));
    expect(serialised).not.toMatch(/sk-or-v1|api[_-]?key|authorization|bearer|password/i);
  });
});
