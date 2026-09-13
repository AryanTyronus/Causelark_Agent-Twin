// @vitest-environment node
//
// Everything here is an operator behaving badly and the boundary holding. The
// attempts are made the only way they can be made in production: by a model
// asking the loop for a tool, which is why most of these drive the real Strands
// agent rather than calling a function. A test that called `query_database`
// directly would prove the tool does not exist; a test that makes a *model* ask
// for it proves the surface it was offered cannot reach one.
//
// The four claims this file exists to hold:
//
//   1. There is no tool that can read a file, run a command, open a socket, run
//      SQL or read an environment variable.
//   2. A run produced for one account cannot be read by another — not by naming
//      a run id, and not by the model asserting whose it is.
//   3. Tool output is data. A benchmark whose name contains instructions changes
//      nothing about what the operator may do next.
//   4. Nothing the model can send, and nothing a tool can return, puts a
//      credential on the wire.

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** Owners whose runs the simulated database will resolve. */
  readableOwners: new Set<string>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ env: { NODE_ENV: 'test' } }));

vi.mock('@/lib/business/agent-catalog', async () => {
  const fixtures = await import('./agent-twin/operator-fixtures');
  return { deploymentAgentCatalog: () => fixtures.CATALOG };
});

vi.mock('@/lib/business/simulation-persistence', () => ({
  loadRun: async (runId: string, ownerId: string) =>
    mocks.readableOwners.has(ownerId) ? { id: runId, seed: 9182, ownerId } : null,
}));

vi.mock('@/lib/business/simulation-evaluation', async () => {
  const fixtures = await import('./agent-twin/operator-fixtures');
  return {
    toEvaluationInput: (run: { id: string }) => fixtures.buildEvidenceRun({ runId: run.id }),
  };
});

vi.mock('@/lib/benchmarks/execute', async () => {
  const fixtures = await import('./agent-twin/operator-fixtures');
  return {
    configurationForSelection: (selection: { provider: string; modelId: string }) => ({
      provider: selection.provider,
      model: selection.modelId,
      label: 'OpenRouter (development) · Strands Agents SDK',
    }),
    executeBenchmark: async (input: { benchmarkId: string }) =>
      fixtures.buildBenchmarkResult({
        benchmarkId: input.benchmarkId,
        benchmarkName: fixtures.INJECTED,
      }),
  };
});

import { listBenchmarkSummaries } from '@/lib/benchmarks/catalog';
import { MAX_OPERATOR_BENCHMARK_RUNS, MAX_OPERATOR_TOOL_CALLS } from '@/lib/operator/config';
import { runOperator } from '@/lib/operator/operator';
import { createOperatorToolbox } from '@/lib/operator/tools';
import { callTool, INJECTED, type ToolResult } from './agent-twin/operator-fixtures';
import { calls, offeredTools, ScriptedOperatorModel, say } from './agent-twin/operator-model';

const OWNER = 'the-signed-in-account';
const BENCHMARK_ID = listBenchmarkSummaries()[0]?.id ?? '';
const AGENT_KEY = 'development-agent@twin-development';
const OBJECTIVE = 'Test this agent and tell me whether it is ready to deploy.';

function toolbox(ownerId = OWNER, mode: 'preview' | 'execute' = 'preview') {
  if (mode === 'execute') mocks.readableOwners.add(ownerId);
  return createOperatorToolbox({
    ownerId,
    mode,
    objective: OBJECTIVE,
    requestedAgentKey: AGENT_KEY,
    authorizedPlanFingerprint: null,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
}

function invoke(model: ScriptedOperatorModel, overrides: Record<string, unknown> = {}) {
  mocks.readableOwners.add(OWNER);
  return runOperator({
    ownerId: OWNER,
    objective: OBJECTIVE,
    mode: 'preview',
    agentKey: AGENT_KEY,
    authorizedPlanFingerprint: null,
    model,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });
}

describe('1 · there is no dangerous tool', () => {
  const ALLOWED = [
    'list_agents',
    'list_benchmarks',
    'get_benchmark',
    'inspect_results',
    'inspect_case',
    'replay_case',
    'analyze_counterfactual',
    'create_test_plan',
    'generate_trust_report',
    'run_benchmark',
  ];

  it('offers exactly the declared surface, in both modes', () => {
    for (const mode of ['preview', 'execute'] as const) {
      for (const tool of toolbox(OWNER, mode).tools) expect(ALLOWED).toContain(tool.name);
    }
  });

  it('has no tool whose name suggests filesystem, shell, network, SQL or environment access', () => {
    const names = toolbox(OWNER, 'execute').tools.map((tool) => tool.name);
    expect(names.join(' ')).not.toMatch(
      /file|disk|path|dir|shell|exec|spawn|process|command|http|fetch|request|url|socket|sql|query|database|prisma|env|secret|credential|key/i,
    );
  });

  it('declares no tool that takes a path, a command, a URL or a statement', () => {
    for (const tool of toolbox(OWNER, 'execute').tools) {
      const schema = JSON.stringify(tool.toolSpec.inputSchema);
      expect(schema).not.toMatch(/"path"|"command"|"url"|"sql"|"query"|"file"|"env"|"variable"/i);
    }
  });

  it('lets a model ask for one anyway — and records the refusal rather than pretending', async () => {
    const model = new ScriptedOperatorModel([
      calls({ tool: 'query_database', input: { sql: 'select * from "SimulationRun"' } }),
      calls({ tool: 'read_file', input: { path: '/etc/passwd' } }),
      calls({ tool: 'shell', input: { command: 'env' } }),
      say('Those tools do not exist, so I used none of them.'),
    ]);
    const run = await invoke(model);

    expect(run.trace.map((step) => step.tool)).toEqual(['query_database', 'read_file', 'shell']);
    expect(run.trace.every((step) => step.status === 'failed')).toBe(true);
    expect(run.usage.failedToolCalls).toBe(3);
    expect(run.status).toBe('completed');
    const failure = JSON.stringify(run.trace.map((step) => step.detail));
    expect(failure).toMatch(/No tool with that name|did not match its schema/);
  });
});

/**
 * An execution that has run a benchmark, as a specific account.
 *
 * Two toolboxes, because the authorisation is a two-step thing: the first
 * commits to a plan and learns its fingerprint, the second presents that
 * fingerprint back and is allowed to execute. That is the same sequence a person
 * goes through in the console, reproduced here because several tests below need
 * a genuine run to attack.
 */
async function executed(ownerId: string) {
  const planning = toolbox(ownerId, 'execute');
  const planned = (await callTool(planning.tools, 'create_test_plan', {
    benchmarkId: BENCHMARK_ID,
    agentKey: AGENT_KEY,
  })) as ToolResult;
  expect(planned.refused).toBeUndefined();

  mocks.readableOwners.add(ownerId);
  const authorised = createOperatorToolbox({
    ownerId,
    mode: 'execute',
    objective: OBJECTIVE,
    requestedAgentKey: AGENT_KEY,
    authorizedPlanFingerprint: planning.plan?.fingerprint ?? '',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  await callTool(authorised.tools, 'create_test_plan', {
    benchmarkId: BENCHMARK_ID,
    agentKey: AGENT_KEY,
  });
  const run = (await callTool(authorised.tools, 'run_benchmark', {
    benchmarkId: BENCHMARK_ID,
  })) as ToolResult;
  expect(run.refused).toBeUndefined();
  return authorised;
}

describe("2 · one account cannot reach another account's evidence", () => {
  it('refuses a run id that this execution did not produce', async () => {
    const execution = await executed(OWNER);
    const result = (await callTool(execution.tools, 'inspect_case', {
      runId: 'the-run-belonging-to-someone-else',
    })) as ToolResult;
    expect(result.refused).toBe(true);
    expect(execution.caseEvidence).toHaveLength(0);
  });

  it('refuses without describing the other run', async () => {
    const execution = await executed(OWNER);
    const result = (await callTool(execution.tools, 'inspect_case', {
      runId: 'the-run-belonging-to-someone-else',
    })) as ToolResult;
    // The refusal names the ids this execution *does* have, and nothing about
    // the one it does not: not whose it is, not its scores, not whether it
    // exists at all. A boundary that explained itself would be an oracle.
    const reason = String(result.reason);
    expect(reason).not.toMatch(
      /owner|belongs to|another user|other account|not found|does not exist/i,
    );
    expect(reason).toContain(execution.resultSlice?.runs[0]?.runId ?? 'no-run');
  });

  it('refuses a run that exists but is not recorded for this account', async () => {
    // The simulated database holds an owner allowlist. The execution produced
    // these runs, but once the row is no longer readable for it, the second
    // ownership check is what stops the read.
    const execution = await executed(OWNER);
    mocks.readableOwners.delete(OWNER);

    const runId = execution.resultSlice?.runs[0]?.runId;
    if (!runId) throw new Error('the execution produced no runs');
    const result = (await callTool(execution.tools, 'inspect_case', { runId })) as ToolResult;
    expect(result.refused).toBe(true);
    expect(String(result.reason)).toMatch(/not recorded for this account/);
    expect(execution.caseEvidence).toHaveLength(0);
  });

  it('refuses to analyse or replay a run it does not own', async () => {
    const execution = await executed(OWNER);
    for (const tool of ['analyze_counterfactual', 'replay_case', 'inspect_case']) {
      const result = (await callTool(execution.tools, tool, {
        runId: 'somebody-elses-run',
      })) as ToolResult;
      expect(result.refused).toBe(true);
    }
    expect(execution.counterfactuals).toHaveLength(0);
    expect(execution.usage.counterfactualAnalyses).toBe(0);
  });

  it('gives the model no way to assert whose run it is looking at', () => {
    for (const tool of toolbox(OWNER, 'execute').tools) {
      const schema = JSON.stringify(tool.toolSpec.inputSchema);
      expect(schema).not.toMatch(/owner|userId|account|tenant|as_user/i);
    }
  });

  it('ignores an owner the model passes anyway', async () => {
    const execution = toolbox('account-a', 'execute');
    const result = (await callTool(execution.tools, 'inspect_case', {
      runId: 'run-baseline',
      ownerId: 'account-b',
      userId: 'account-b',
    })) as ToolResult;
    expect(result.refused).toBe(true);
  });
});

describe('3 · tool output is data, never an instruction', () => {
  it('changes nothing about the surface when a result contains instructions', async () => {
    // `INJECTED` is a benchmark name carrying an instruction to the model. It
    // reaches the model verbatim as data, in the trace and in the result slice.
    const model = new ScriptedOperatorModel([
      calls({ tool: 'list_benchmarks' }),
      calls({ tool: 'get_benchmark', input: { benchmarkId: BENCHMARK_ID } }),
      calls({ tool: 'list_agents' }),
      say('Noted.'),
    ]);
    const run = await invoke(model);

    expect(offeredTools(model, 1)).toEqual(offeredTools(model, 0));
    expect(offeredTools(model, 2)).toEqual(offeredTools(model, 0));
    expect(offeredTools(model, 2)).not.toContain('run_benchmark');
    // The injected text reached the model as a benchmark name inside a tool
    // result, and the run that followed is exactly the scripted one: three
    // reads, no fourth call, no tool the surface did not already offer.
    expect(run.status).toBe('completed');
    expect(run.trace.map((step) => step.tool)).toEqual([
      'list_benchmarks',
      'get_benchmark',
      'list_agents',
    ]);
  });

  it('carries an injected string through as text and nothing else', async () => {
    const execution = await executed(OWNER);
    const result = execution.resultSlice;
    if (!result) throw new Error('the execution produced no result');

    // The injected string came from the engine, through the tool, and is carried
    // exactly where the engine put it — and the shape the operator reasons over
    // is the declared projection, not whatever the engine happened to return.
    expect(JSON.stringify(result)).toContain(INJECTED);
    expect(Object.keys(result).sort()).toEqual([
      'agent',
      'benchmark',
      'caseSummary',
      'dimensions',
      'failures',
      'robustness',
      'runs',
      'scenarios',
    ]);
  });

  it('drops any field a tool result was not declared to carry', async () => {
    const execution = toolbox(OWNER, 'execute');
    await callTool(execution.tools, 'create_test_plan', {
      benchmarkId: BENCHMARK_ID,
      agentKey: AGENT_KEY,
    });
    await callTool(execution.tools, 'run_benchmark', { benchmarkId: BENCHMARK_ID });

    // The result slice and the plan are both parsed by their contracts, so a
    // field an engine added — including one that looked like a permission — is
    // not carried into what the operator reasons over.
    expect(Object.keys(execution.plan ?? {}).sort()).toEqual([
      'agent',
      'benchmark',
      'bounds',
      'caseCount',
      'fingerprint',
      'objective',
      'providerDrivenSimulations',
      'scenarios',
      'seeds',
    ]);
    expect(JSON.stringify(execution.plan)).not.toMatch(/owner|permission|scope|role/i);
  });
});

describe('4 · the budgets hold against a model that ignores them', () => {
  it('stops an unbounded loop and records the refusal', async () => {
    const model = new ScriptedOperatorModel(
      [calls({ tool: 'list_agents' }, { tool: 'list_benchmarks' }, { tool: 'list_benchmarks' })],
      { repeatLast: true },
    );
    const run = await invoke(model);

    expect(run.usage.toolCalls).toBe(MAX_OPERATOR_TOOL_CALLS);
    expect(run.usage.refusedToolCalls).toBeGreaterThan(0);
    expect(run.status).toBe('limit-reached');
  });

  it('refuses a second benchmark execution even under authorisation', async () => {
    const execution = toolbox(OWNER, 'execute');
    await callTool(execution.tools, 'create_test_plan', {
      benchmarkId: BENCHMARK_ID,
      agentKey: AGENT_KEY,
    });
    const fingerprint = execution.plan?.fingerprint ?? '';

    const authorised = createOperatorToolbox({
      ownerId: OWNER,
      mode: 'execute',
      objective: OBJECTIVE,
      requestedAgentKey: AGENT_KEY,
      authorizedPlanFingerprint: fingerprint,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    await callTool(authorised.tools, 'create_test_plan', {
      benchmarkId: BENCHMARK_ID,
      agentKey: AGENT_KEY,
    });
    await callTool(authorised.tools, 'run_benchmark', { benchmarkId: BENCHMARK_ID });
    const second = (await callTool(authorised.tools, 'run_benchmark', {
      benchmarkId: BENCHMARK_ID,
    })) as ToolResult;

    expect(second.refused).toBe(true);
    expect(authorised.usage.benchmarkRuns).toBe(MAX_OPERATOR_BENCHMARK_RUNS);
  });

  it('refuses an oversized benchmark rather than building it', async () => {
    const execution = toolbox(OWNER);
    // Both routes are closed: a seeds list longer than the schema allows, and a
    // seeds list of the right length naming seeds the definition never declared.
    await expect(
      callTool(execution.tools, 'create_test_plan', {
        benchmarkId: BENCHMARK_ID,
        agentKey: AGENT_KEY,
        seeds: Array.from({ length: 500 }, (_, index) => index),
      }),
    ).rejects.toThrow();

    const invented = (await callTool(execution.tools, 'create_test_plan', {
      benchmarkId: BENCHMARK_ID,
      agentKey: AGENT_KEY,
      seeds: [1, 2, 3, 4],
    })) as ToolResult;
    expect(invented.refused).toBe(true);
    expect(execution.plan).toBeNull();
  });

  it('refuses a benchmark that does not exist, however plausible its name', async () => {
    for (const invented of [
      'resource-routing-robustness-v2',
      'RESOURCE-ROUTING-ROBUSTNESS',
      '../../etc/passwd',
      'baseline',
    ]) {
      const execution = toolbox(OWNER);
      const result = (await callTool(execution.tools, 'create_test_plan', {
        benchmarkId: invented,
        agentKey: AGENT_KEY,
      })) as ToolResult;
      expect(result.refused).toBe(true);
      expect(execution.plan).toBeNull();
    }
    // An empty id never reaches the tool at all: the schema refuses it first.
    await expect(
      callTool(toolbox(OWNER).tools, 'create_test_plan', { benchmarkId: '', agentKey: AGENT_KEY }),
    ).rejects.toThrow();
  });

  it('rejects a malformed call at the schema, without spending a tool call', async () => {
    const execution = toolbox(OWNER);
    await expect(
      callTool(execution.tools, 'get_benchmark', { benchmarkId: { $ne: null } }),
    ).rejects.toThrow();
    await expect(callTool(execution.tools, 'inspect_case', { runId: 12_345 })).rejects.toThrow();
    expect(execution.usage.toolCalls).toBe(0);
    expect(execution.trace).toHaveLength(0);
  });
});

describe('5 · nothing carries a credential', () => {
  it('has no credential-shaped text in a full run state', async () => {
    const model = new ScriptedOperatorModel([
      calls({ tool: 'list_agents' }),
      calls({ tool: 'list_benchmarks' }),
      calls({
        tool: 'create_test_plan',
        input: { benchmarkId: BENCHMARK_ID, agentKey: AGENT_KEY },
      }),
      say('Planned.'),
    ]);
    const run = await invoke(model);
    const serialised = JSON.stringify(run);
    expect(serialised).not.toMatch(
      /sk-[a-zA-Z0-9]{8}|bearer\s|api[_-]?key|client[_-]?secret|password/i,
    );
    // And not the names of the variables a credential would live in.
    expect(serialised).not.toMatch(/OPENROUTER_API_KEY|BETTER_AUTH_SECRET|AWS_SECRET_ACCESS_KEY/);
  });

  it("does not put a provider failure's raw payload in a notice", async () => {
    const model = new ScriptedOperatorModel([
      calls({ tool: 'list_agents' }),
      {
        kind: 'throw',
        error: Object.assign(new Error('401 unauthorized: Bearer sk-live-abcdef123456'), {
          name: 'AuthenticationError',
          status: 401,
        }),
      },
    ]);
    const run = await invoke(model);
    const notices = run.notices.join(' ');
    expect(run.status).toBe('failed');
    // The provider's own text — the header value it echoed — is gone. What is
    // left is a message this codebase wrote: the classified code, and guidance
    // naming the configuration to look at. A variable *name* is not a credential,
    // and withholding it would leave a reader with nothing to act on.
    expect(notices).not.toMatch(/sk-live|Bearer|unauthorized: /i);
    expect(run.stopReason).toBe('missing_credentials');
    expect(notices).toMatch(/credential/i);
  });
});
