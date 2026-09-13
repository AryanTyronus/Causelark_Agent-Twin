// @vitest-environment node
//
// The handler under test is the shipped one. Authentication is replaced (so a
// signed-out caller can be simulated) and the *operator itself* is replaced —
// the Strands agent is exercised in `operator.agent.test.ts`, and mocking it here
// is what makes every status mapping reachable without a model call. Everything
// between those two — the request contract, the catalogue gate, the agent-key
// gate and the authorisation gate in `run.ts` — is the real code, so what a
// caller receives here is what the deployment actually serves.
//
// The identity question is the one this file takes most seriously. The owner is
// read from the session and from nowhere else, so several tests below send a
// request that names a different account and assert the operator was never told
// about it.

import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  unauthorized: false,
  userId: 'user-1',
  catalogue: null as unknown,
  failWith: null as { code: string; message: string } | null,
  failWithUnknown: false,
  /** Every invocation the operator seam was handed. */
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ env: { NODE_ENV: 'test' } }));

vi.mock('@/lib/require-auth', () => ({
  requireAuth: async () => {
    if (mocks.unauthorized) throw NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return { id: mocks.userId, email: 'owner@example.test' };
  },
}));

vi.mock('@/lib/business/agent-catalog', async () => {
  const fixtures = await import('./agent-twin/operator-fixtures');
  return {
    deploymentAgentCatalog: () => mocks.catalogue ?? fixtures.CATALOG,
  };
});

vi.mock('@/lib/operator/operator', async () => {
  const { AgentProviderError } = await import('@/lib/agent/provider');
  const { OperatorError, OperatorRunState } = await import('@/lib/operator/types');
  const { buildRunState } = await import('./agent-twin/operator-fixtures');
  return {
    runOperator: async (input: Record<string, unknown>) => {
      mocks.calls.push(input);
      if (mocks.failWithUnknown) throw new Error('a connection string with a password in it');
      if (mocks.failWith) {
        if (mocks.failWith.code === 'PROVIDER_UNAVAILABLE')
          throw new AgentProviderError('provider_error', mocks.failWith.message);
        throw new OperatorError(mocks.failWith.code as never, mocks.failWith.message);
      }
      return OperatorRunState.parse(buildRunState(input as { objective: string }));
    },
  };
});

import { POST } from '@/app/api/operator/route';
import { EMPTY_CATALOG } from './agent-twin/operator-fixtures';

const URL = 'http://localhost/api/operator';
const OBJECTIVE = 'Test this agent and tell me whether it is ready to deploy.';
const AGENT_KEY = 'development-agent@twin-development';

function post(body: unknown): Promise<Response> {
  const request = new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return POST(request) as Promise<Response>;
}

beforeEach(() => {
  mocks.unauthorized = false;
  mocks.userId = 'user-1';
  mocks.catalogue = null;
  mocks.failWith = null;
  mocks.failWithUnknown = false;
  mocks.calls = [];
});

describe('the caller must be signed in', () => {
  it('serves 401 and runs nothing when there is no session', async () => {
    mocks.unauthorized = true;
    const response = await post({ objective: OBJECTIVE, mode: 'preview' });
    expect(response.status).toBe(401);
    expect(mocks.calls).toHaveLength(0);
  });
});

describe('the request contract', () => {
  it('rejects a body that is not JSON', async () => {
    const response = await post('not json at all');
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/JSON body is required/);
  });

  it('rejects an objective that is too short, naming the field', async () => {
    const response = await post({ objective: 'hi' });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/not valid/);
    expect(body.errors[0].path).toBe('objective');
    expect(typeof body.errors[0].message).toBe('string');
  });

  it('rejects an objective that is absurdly long', async () => {
    expect((await post({ objective: 'x'.repeat(5_000) })).status).toBe(400);
  });

  it('rejects a mode that is not one of the two', async () => {
    expect((await post({ objective: OBJECTIVE, mode: 'destroy' })).status).toBe(400);
  });

  it('defaults to preview when no mode is sent', async () => {
    const response = await post({ objective: OBJECTIVE });
    expect(response.status).toBe(200);
    expect(mocks.calls[0]?.mode).toBe('preview');
  });
});

describe('the gate on this deployment', () => {
  it('serves 503 when no agent resolves, quoting the configuration notice', async () => {
    mocks.catalogue = EMPTY_CATALOG;
    const response = await post({ objective: OBJECTIVE });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe('NO_AGENT_CONFIGURED');
    expect(body.error).toContain('OPENROUTER_MODEL');
    expect(mocks.calls).toHaveLength(0);
  });

  it('serves 400 and lists the real keys when the named agent does not exist', async () => {
    const response = await post({ objective: OBJECTIVE, agentKey: 'agent-from-elsewhere' });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('UNKNOWN_AGENT');
    expect(body.error).toContain(AGENT_KEY);
    expect(mocks.calls).toHaveLength(0);
  });

  it('serves 400 when an execution is asked for without an authorisation', async () => {
    const response = await post({ objective: OBJECTIVE, agentKey: AGENT_KEY, mode: 'execute' });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('UNAUTHORIZED_MODE');
    expect(body.error).toMatch(/preview mode first/);
    expect(mocks.calls).toHaveLength(0);
  });

  it('passes an authorised execution through to the operator', async () => {
    const response = await post({
      objective: OBJECTIVE,
      agentKey: AGENT_KEY,
      mode: 'execute',
      authorizedPlanFingerprint: 'a-fingerprint-a-person-approved',
    });
    expect(response.status).toBe(200);
    expect(mocks.calls[0]?.authorizedPlanFingerprint).toBe('a-fingerprint-a-person-approved');
  });
});

describe('the owner comes from the session, never from the request', () => {
  it('hands the operator the signed-in user', async () => {
    mocks.userId = 'the-signed-in-account';
    await post({ objective: OBJECTIVE });
    expect(mocks.calls[0]?.ownerId).toBe('the-signed-in-account');
  });

  it('ignores an owner named in the body', async () => {
    mocks.userId = 'the-signed-in-account';
    const response = await post({
      objective: OBJECTIVE,
      ownerId: 'somebody-elses-account',
      userId: 'somebody-elses-account',
      accountId: 'somebody-elses-account',
    });
    expect(response.status).toBe(200);
    expect(mocks.calls[0]?.ownerId).toBe('the-signed-in-account');
  });

  it('does not let the request contract carry an owner at all', async () => {
    const { OperatorRunRequest } = await import('@/lib/operator/types');
    const parsed = OperatorRunRequest.parse({
      objective: OBJECTIVE,
      ownerId: 'somebody-else',
      agentKey: null,
      mode: 'preview',
    });
    expect(Object.keys(parsed).sort()).toEqual(['agentKey', 'mode', 'objective']);
    expect(JSON.stringify(OperatorRunRequest.shape)).not.toMatch(/owner/i);
  });
});

describe('a run that produced findings is a 200, even when the findings are bad', () => {
  it('serves 200 with the whole run state', async () => {
    const response = await post({ objective: OBJECTIVE, agentKey: AGENT_KEY });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.run.objective).toBe(OBJECTIVE);
    expect(body.run.mode).toBe('preview');
    expect(body.run.trace).toEqual([]);
    expect(body.run.report).toBeNull();
  });

  it('never serves a run with an unexpected top-level shape', async () => {
    const response = await post({ objective: OBJECTIVE });
    expect(Object.keys(await response.json()).sort()).toEqual(['run']);
  });
});

describe('a failure of the operator itself', () => {
  it('maps a missing provider to 503 with the code preserved', async () => {
    mocks.failWith = { code: 'PROVIDER_UNAVAILABLE', message: 'No provider model is configured.' };
    const response = await post({ objective: OBJECTIVE });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe('OPERATOR_FAILED');
    expect(body.error).toMatch(/could not reach its model/);
  });

  it('maps an operator that could not start to 500', async () => {
    mocks.failWith = { code: 'OPERATOR_FAILED', message: 'The operator could not start.' };
    const response = await post({ objective: OBJECTIVE });
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe('OPERATOR_FAILED');
  });

  it('never echoes the text of an unexpected throw', async () => {
    mocks.failWithUnknown = true;
    const response = await post({ objective: OBJECTIVE });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('The operator run failed. Nothing was reported.');
    expect(JSON.stringify(body)).not.toContain('password');
  });

  it('never leaks a credential-shaped string on any path', async () => {
    const bodies = await Promise.all([
      post({ objective: 'hi' }),
      post({ objective: OBJECTIVE, agentKey: 'nope' }),
      post({ objective: OBJECTIVE }),
    ]);
    for (const response of bodies) {
      const text = JSON.stringify(await response.json());
      expect(text).not.toMatch(/api[_-]?key|bearer|sk-[a-z0-9]|secret/i);
    }
  });
});
