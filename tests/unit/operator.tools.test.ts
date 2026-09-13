// @vitest-environment node
//
// These exercise the real Strands tool objects through the SDK's own `invoke`
// entry point, with no model anywhere in the loop. What they are checking is the
// surface itself: that it is bounded, that it refuses rather than improvises, and
// that every refusal is recorded rather than swallowed.
//
// Three boundaries are stubbed, and only three:
//
//   * `@/lib/env` — so the suite needs no provider credential and no database
//     URL. The operator never reads a credential; this file proves the rest of
//     the surface works without one configured.
//   * the agent catalogue, which is otherwise resolved from the deployment's
//     environment.
//   * the two database seams — a run row and a benchmark execution.
//
// Everything between them is real: the benchmark registry, the plan builder, the
// evaluation engine, the counterfactual engine, the replay builder, the budget
// accounting and the trace.

import { describe, expect, it, vi } from 'vitest';

const OWNER = 'operator-tools-owner';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ env: { NODE_ENV: 'test' } }));

vi.mock('@/lib/business/agent-catalog', async () => {
  const fixtures = await import('./agent-twin/operator-fixtures');
  return { deploymentAgentCatalog: () => fixtures.CATALOG };
});

/**
 * The run row.
 *
 * `loadRun` is the owner-scoped read: a run whose owner is not the caller comes
 * back as `null`, exactly as the real one does. The mapping to evidence is
 * stubbed so the fixture does not have to be a Prisma row — but the evidence it
 * returns is built by the real environment, so the evaluator and the
 * counterfactual engine score something that actually happened.
 */
vi.mock('@/lib/business/simulation-persistence', () => ({
  loadRun: async (runId: string, ownerId: string) =>
    ownerId === OWNER ? { id: runId, seed: 9182, ownerId } : null,
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
    executeBenchmark: async () => fixtures.buildBenchmarkResult(),
  };
});

import { listBenchmarkSummaries } from '@/lib/benchmarks/catalog';
import { MAX_OPERATOR_COUNTERFACTUAL_ANALYSES } from '@/lib/operator/config';
import { planFingerprint } from '@/lib/operator/plan';
import type { OperatorExecution } from '@/lib/operator/tools';
import { createOperatorToolbox } from '@/lib/operator/tools';
import { buildBenchmarkResult, callTool, type ToolResult } from './agent-twin/operator-fixtures';

const OBJECTIVE = 'Test this agent and tell me whether it is ready to deploy.';

/** A toolbox for one request, in the mode under test. */
function toolbox(
  overrides: { mode?: 'preview' | 'execute'; fingerprint?: string | null; ownerId?: string } = {},
): OperatorExecution {
  return createOperatorToolbox({
    ownerId: overrides.ownerId ?? OWNER,
    mode: overrides.mode ?? 'preview',
    objective: OBJECTIVE,
    requestedAgentKey: null,
    authorizedPlanFingerprint: overrides.fingerprint ?? null,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
}

const BENCHMARK_ID = listBenchmarkSummaries()[0]?.id ?? '';
const AGENT_KEY = 'development-agent@twin-development';

/** Commit to a plan and return its fingerprint, as a preview would. */
async function commitPlan(execution: OperatorExecution, agentKey = AGENT_KEY): Promise<string> {
  const result = (await callTool(execution.tools, 'create_test_plan', {
    benchmarkId: BENCHMARK_ID,
    agentKey,
  })) as ToolResult;
  expect(result.refused).toBeUndefined();
  const fingerprint = execution.plan?.fingerprint;
  if (!fingerprint) throw new Error('create_test_plan committed no plan.');
  return fingerprint;
}

describe('the operator tool surface', () => {
  it('offers read and action tools, and no execution tool in preview', () => {
    const names = toolbox().tools.map((tool) => tool.name);

    expect(names).toEqual([
      'list_agents',
      'list_benchmarks',
      'get_benchmark',
      'inspect_results',
      'inspect_case',
      'replay_case',
      'analyze_counterfactual',
      'create_test_plan',
      'generate_trust_report',
    ]);
    // The boundary is the tool list, not a flag the model could argue with.
    expect(names).not.toContain('run_benchmark');
  });

  it('adds exactly one execution tool when the run is authorised to execute', () => {
    const names = toolbox({ mode: 'execute' }).tools.map((tool) => tool.name);
    expect(names).toContain('run_benchmark');
    expect(names).toHaveLength(10);
  });

  it('exposes no shell, HTTP, SQL, filesystem or environment tool', () => {
    const names = toolbox({ mode: 'execute' }).tools.map((tool) => tool.name);
    for (const forbidden of [
      'query_database',
      'sql',
      'read_file',
      'write_file',
      'shell',
      'exec',
      'http_request',
      'fetch',
      'env',
      'getenv',
      'credential',
    ])
      expect(names).not.toContain(forbidden);
  });

  it('gives every tool a description and a declared input schema', () => {
    for (const tool of toolbox().tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.toolSpec.inputSchema).toBeDefined();
    }
  });

  it('never names an owner in any tool schema', () => {
    const serialised = JSON.stringify(toolbox({ mode: 'execute' }).tools.map((t) => t.toolSpec));
    expect(serialised).not.toMatch(/owner/i);
    expect(serialised).not.toMatch(/userId/i);
    expect(serialised).not.toMatch(/account/i);
  });
});

describe('discovery tools', () => {
  it('reports the agents this deployment can actually run', async () => {
    const result = (await callTool(toolbox().tools, 'list_agents')) as ToolResult;
    expect((result.agents as { key: string }[]).map((agent) => agent.key)).toEqual([AGENT_KEY]);
  });

  it('lists only benchmarks that are in the compiled registry', async () => {
    const result = (await callTool(toolbox().tools, 'list_benchmarks')) as ToolResult;
    const registered = listBenchmarkSummaries().map((benchmark) => benchmark.id);
    expect((result.benchmarks as { id: string }[]).map((entry) => entry.id)).toEqual(registered);
  });

  it('refuses an invented benchmark id instead of describing one', async () => {
    const result = (await callTool(toolbox().tools, 'get_benchmark', {
      benchmarkId: 'imaginary-benchmark',
    })) as ToolResult;
    expect(result.refused).toBe(true);
    expect(String(result.reason)).toContain('imaginary-benchmark');
  });

  it('refuses a version that does not exist', async () => {
    const result = (await callTool(toolbox().tools, 'get_benchmark', {
      benchmarkId: BENCHMARK_ID,
      version: 999,
    })) as ToolResult;
    expect(result.refused).toBe(true);
  });
});

describe('planning', () => {
  it('commits a plan whose every field came from the registry and the catalogue', async () => {
    const execution = toolbox();
    await commitPlan(execution);

    const plan = execution.plan;
    expect(plan).not.toBeNull();
    expect(plan?.benchmark.id).toBe(BENCHMARK_ID);
    expect(plan?.agent.key).toBe(AGENT_KEY);
    expect(plan?.agent.model).toBe('example/model-a');
    expect(plan?.caseCount).toBe((plan?.scenarios.length ?? 0) * (plan?.seeds.length ?? 0));
    expect(plan?.fingerprint).toHaveLength(32);
  });

  it('refuses a plan naming an agent the deployment cannot run', async () => {
    const result = (await callTool(toolbox().tools, 'create_test_plan', {
      benchmarkId: BENCHMARK_ID,
      agentKey: 'some-agent-that-does-not-exist',
    })) as ToolResult;
    expect(result.refused).toBe(true);
    expect(String(result.reason)).toContain(AGENT_KEY);
  });

  it('refuses a seed the definition does not declare', async () => {
    const result = (await callTool(toolbox().tools, 'create_test_plan', {
      benchmarkId: BENCHMARK_ID,
      agentKey: AGENT_KEY,
      seeds: [123456],
    })) as ToolResult;
    expect(result.refused).toBe(true);
    expect(String(result.reason)).toContain('123456');
  });

  it('produces a fingerprint that changes when the plan changes', async () => {
    const first = toolbox();
    const fingerprint = await commitPlan(first);
    const definition = first.plan;
    if (!definition) throw new Error('no plan');

    const differentSeeds = planFingerprint({
      benchmarkId: definition.benchmark.id,
      benchmarkVersion: definition.benchmark.version,
      agentKey: definition.agent.key,
      seeds: [...definition.seeds, 1],
      scenarios: definition.scenarios,
    });
    expect(differentSeeds).not.toBe(fingerprint);
  });
});

describe('execution', () => {
  it('refuses to execute when no plan has been committed', async () => {
    const execution = toolbox({ mode: 'execute', fingerprint: 'anything' });
    const result = (await callTool(execution.tools, 'run_benchmark', {
      benchmarkId: BENCHMARK_ID,
    })) as ToolResult;
    expect(result.refused).toBe(true);
    expect(execution.usage.benchmarkRuns).toBe(0);
  });

  it('refuses an execution whose authorisation does not match the committed plan', async () => {
    const execution = toolbox({ mode: 'execute', fingerprint: 'a-fingerprint-someone-approved' });
    await commitPlan(execution);
    const result = (await callTool(execution.tools, 'run_benchmark', {
      benchmarkId: BENCHMARK_ID,
    })) as ToolResult;

    expect(result.refused).toBe(true);
    expect(execution.usage.benchmarkRuns).toBe(0);
    expect(execution.result).toBeNull();
    // And it says so where a reader will see it, not only in the tool result.
    expect(execution.notices.join(' ')).toContain('did not match');
  });

  it('refuses an execution naming a benchmark other than the planned one', async () => {
    const execution = toolbox({ mode: 'execute' });
    const fingerprint = await commitPlan(execution);
    const other = listBenchmarkSummaries().find((benchmark) => benchmark.id !== BENCHMARK_ID);
    if (!other) return;

    const executing = toolbox({ mode: 'execute', fingerprint });
    await commitPlan(executing);
    const result = (await callTool(executing.tools, 'run_benchmark', {
      benchmarkId: other.id,
    })) as ToolResult;
    expect(result.refused).toBe(true);
  });

  it('executes when the committed plan matches the authorisation', async () => {
    const execution = toolbox({ mode: 'execute' });
    const fingerprint = await commitPlan(execution);
    const authorized = toolbox({ mode: 'execute', fingerprint });
    await commitPlan(authorized);

    const result = (await callTool(authorized.tools, 'run_benchmark', {
      benchmarkId: BENCHMARK_ID,
    })) as ToolResult;

    expect(result.refused).toBeUndefined();
    expect(authorized.authorized).toBe(true);
    expect(authorized.usage.benchmarkRuns).toBe(1);
    expect(authorized.resultSlice?.runs).toHaveLength(2);
  });

  it('refuses a second execution and names the allowance', async () => {
    const execution = toolbox({ mode: 'execute' });
    const fingerprint = await commitPlan(execution);
    const authorized = toolbox({ mode: 'execute', fingerprint });
    await commitPlan(authorized);
    await callTool(authorized.tools, 'run_benchmark', { benchmarkId: BENCHMARK_ID });

    const result = (await callTool(authorized.tools, 'run_benchmark', {
      benchmarkId: BENCHMARK_ID,
    })) as ToolResult;
    expect(result.refused).toBe(true);
    expect(authorized.usage.benchmarkRuns).toBe(1);
  });
});

describe('evidence inspection', () => {
  async function executed(): Promise<OperatorExecution> {
    const execution = toolbox({ mode: 'execute' });
    const fingerprint = await commitPlan(execution);
    const run = toolbox({ mode: 'execute', fingerprint });
    await commitPlan(run);
    await callTool(run.tools, 'run_benchmark', { benchmarkId: BENCHMARK_ID });
    return run;
  }

  it('refuses to inspect results before anything has run', async () => {
    const result = (await callTool(toolbox().tools, 'inspect_results')) as ToolResult;
    expect(result.refused).toBe(true);
  });

  it('returns the aggregate the benchmark engine produced, unaltered', async () => {
    const execution = await executed();
    const result = (await callTool(execution.tools, 'inspect_results')) as ToolResult;
    const expected = buildBenchmarkResult();

    expect(result.dimensions).toEqual(expected.dimensions);
    expect(result.robustness).toEqual(expected.robustness);
    expect(result.caseSummary).toEqual(expected.summary);
  });

  it('inspects a case through the real evaluation engine', async () => {
    const execution = await executed();
    const runId = execution.resultSlice?.runs[0]?.runId;
    if (!runId) throw new Error('no runs');

    const result = (await callTool(execution.tools, 'inspect_case', { runId })) as ToolResult;
    expect(result.refused).toBeUndefined();
    expect(execution.caseEvidence).toHaveLength(1);
    const evidence = execution.caseEvidence[0];
    expect(evidence?.runId).toBe(runId);
    expect(evidence?.evaluation.overallScore).toBeGreaterThanOrEqual(0);
    expect(evidence?.actions.total).toBeGreaterThan(0);
  });

  it('replays a case through the real replay builder', async () => {
    const execution = await executed();
    const runId = execution.resultSlice?.runs[0]?.runId;
    if (!runId) throw new Error('no runs');

    const result = (await callTool(execution.tools, 'replay_case', { runId })) as ToolResult;
    expect(result.refused).toBeUndefined();
    expect(Number(result.frameCount)).toBeGreaterThan(0);
  });

  it('analyses a counterfactual through the real counterfactual engine', async () => {
    const execution = await executed();
    const runId = execution.resultSlice?.runs[0]?.runId;
    if (!runId) throw new Error('no runs');

    const result = (await callTool(execution.tools, 'analyze_counterfactual', {
      runId,
    })) as ToolResult;
    expect(result.refused).toBeUndefined();
    expect(execution.counterfactuals).toHaveLength(1);
    // The engine declares these; the operator only echoes them.
    expect(execution.counterfactuals[0]?.policies.actionSpace).toBeTruthy();
    expect(execution.usage.counterfactualAnalyses).toBe(1);
  });

  it('refuses to analyse the same run twice', async () => {
    const execution = await executed();
    const runId = execution.resultSlice?.runs[0]?.runId;
    if (!runId) throw new Error('no runs');
    await callTool(execution.tools, 'analyze_counterfactual', { runId });

    const result = (await callTool(execution.tools, 'analyze_counterfactual', {
      runId,
    })) as ToolResult;
    expect(result.refused).toBe(true);
    expect(execution.usage.counterfactualAnalyses).toBe(1);
  });

  it('refuses to inspect a run this execution did not produce', async () => {
    const execution = await executed();
    const result = (await callTool(execution.tools, 'inspect_case', {
      runId: 'a-run-belonging-to-someone-else',
    })) as ToolResult;
    expect(result.refused).toBe(true);
    expect(execution.caseEvidence).toHaveLength(0);
  });

  it('refuses to inspect a run that is not recorded for this account', async () => {
    // The execution produced the run, but the owner-scoped read does not
    // resolve it — the second check, exercised on its own.
    const execution = await executed();
    const foreign = createOperatorToolbox({
      ownerId: 'a-different-account',
      mode: 'execute',
      objective: OBJECTIVE,
      requestedAgentKey: null,
      authorizedPlanFingerprint: null,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const runId = execution.resultSlice?.runs[0]?.runId;
    if (!runId) throw new Error('no runs');
    const result = (await callTool(foreign.tools, 'inspect_case', { runId })) as ToolResult;
    expect(result.refused).toBe(true);
  });

  it('caps the counterfactual allowance at the documented bound', () => {
    expect(MAX_OPERATOR_COUNTERFACTUAL_ANALYSES).toBeLessThanOrEqual(3);
  });
});

describe('the trust report', () => {
  it('refuses to report when nothing has been executed', async () => {
    const result = (await callTool(toolbox().tools, 'generate_trust_report', {})) as ToolResult;
    expect(result.refused).toBe(true);
    expect(result.verdict).toBeUndefined();
  });

  it('assembles a report whose figures came from the engine', async () => {
    const execution = toolbox({ mode: 'execute' });
    const fingerprint = await commitPlan(execution);
    const run = toolbox({ mode: 'execute', fingerprint });
    await commitPlan(run);
    await callTool(run.tools, 'run_benchmark', { benchmarkId: BENCHMARK_ID });

    await callTool(run.tools, 'generate_trust_report', {
      interpretation: 'The perturbed condition retained most of its score.',
    });

    const report = run.report;
    expect(report).not.toBeNull();
    const expected = buildBenchmarkResult();
    expect(report?.observed.overall).toBe(expected.dimensions.averageOverallScore);
    expect(report?.observed.robustness.score).toBe(expected.robustness.robustnessScore);
    expect(report?.benchmark.id).toBe(BENCHMARK_ID);
    expect(report?.target.key).toBe(AGENT_KEY);
    // The operator's own words are in their own field and nowhere else.
    expect(report?.interpretation).toContain('retained most of its score');
  });

  it('records the plan fingerprint as provenance only when the run was authorised', async () => {
    const execution = toolbox({ mode: 'execute' });
    const fingerprint = await commitPlan(execution);
    const run = toolbox({ mode: 'execute', fingerprint });
    await commitPlan(run);
    await callTool(run.tools, 'run_benchmark', { benchmarkId: BENCHMARK_ID });
    await callTool(run.tools, 'generate_trust_report', {});

    expect(run.report?.provenance.planFingerprint).toBe(fingerprint);
  });
});

describe('budgets and the trace', () => {
  it('refuses once the tool-call allowance is spent, and records the refusal', async () => {
    const execution = toolbox();
    for (let index = 0; index < 24; index += 1) await callTool(execution.tools, 'list_agents');

    const result = (await callTool(execution.tools, 'list_agents')) as ToolResult;
    expect(result.refused).toBe(true);
    expect(execution.usage.toolCalls).toBe(24);
    expect(execution.trace).toHaveLength(25);
    expect(execution.trace[execution.trace.length - 1]?.status).toBe('refused');
  });

  it('records a step for every call, with a tool-written summary and a server phase', async () => {
    const execution = toolbox();
    await callTool(execution.tools, 'list_agents');
    await callTool(execution.tools, 'list_benchmarks');

    expect(execution.trace.map((step) => step.tool)).toEqual(['list_agents', 'list_benchmarks']);
    expect(execution.trace.map((step) => step.phase)).toEqual(['discover', 'discover']);
    expect(execution.trace[0]?.summary.length).toBeGreaterThan(10);
    // The timestamp is generated at the boundary, not supplied by a caller.
    expect(execution.trace[0]?.at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('refuses malformed arguments at the schema, without reaching the tool', async () => {
    const execution = toolbox();
    await expect(callTool(execution.tools, 'get_benchmark', { benchmarkId: 42 })).rejects.toThrow();
    expect(execution.usage.toolCalls).toBe(0);
  });

  it('bounds tool detail so the trace cannot become a second copy of the evidence', async () => {
    const execution = toolbox({ mode: 'execute' });
    const fingerprint = await commitPlan(execution);
    const run = toolbox({ mode: 'execute', fingerprint });
    await commitPlan(run);
    await callTool(run.tools, 'run_benchmark', { benchmarkId: BENCHMARK_ID });

    const step = run.trace.find((entry) => entry.tool === 'run_benchmark');
    expect(JSON.stringify(step?.detail).length).toBeLessThan(2_048);
  });
});
