// @vitest-environment node
// @polsia:user-owned — the Strands loop, driven deterministically.
//
// This is the suite that proves the Operator is an agent rather than a function.
// Nothing here mocks the SDK: a real `Agent` is constructed over the real tool
// surface, a real `invoke` runs the real loop, and the SDK's own limits, hooks and
// stop reasons are what the assertions read. The one substitution is the model,
// which is a script — because a test that needed a live LLM would be a test that
// could not run, and because a script is the only way to assert what the loop
// does when the model behaves badly.
//
// Three properties are load-bearing here and each has its own section:
//
//   * The model chooses the order. The trace is a record of the calls it asked
//     for, in the order it asked for them, with the phase assigned by the server.
//   * The bounds are the SDK's, not the prompt's. A model that never stops
//     calling tools is stopped by `limits.turns` and reports `limitTurns`.
//   * A failure is never hidden. A provider that dies produces a run whose status
//     says so and whose notices quote it, rather than an empty report.

import { describe, expect, it, vi } from 'vitest';

const OWNER = 'operator-agent-owner';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ env: { NODE_ENV: 'test' } }));

vi.mock('@/lib/business/agent-catalog', async () => {
  const fixtures = await import('./agent-twin/operator-fixtures');
  return { deploymentAgentCatalog: () => fixtures.CATALOG };
});

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

import { AgentProviderError } from '@/lib/agent/provider';
import { listBenchmarkSummaries } from '@/lib/benchmarks/catalog';
import { MAX_OPERATOR_TOOL_CALLS, MAX_OPERATOR_TURNS } from '@/lib/operator/config';
import { type OperatorInvocation, runOperator } from '@/lib/operator/operator';
import {
  calls,
  fails,
  offeredTools,
  ScriptedOperatorModel,
  say,
} from './agent-twin/operator-model';

const BENCHMARK_ID = listBenchmarkSummaries()[0]?.id ?? '';
const AGENT_KEY = 'development-agent@twin-development';
const OBJECTIVE = 'Test this agent and tell me whether it is ready to deploy.';
const AT = new Date('2026-01-01T00:00:00.000Z');

function invoke(
  model: ScriptedOperatorModel,
  overrides: Partial<OperatorInvocation> = {},
): Promise<Awaited<ReturnType<typeof runOperator>>> {
  return runOperator({
    ownerId: OWNER,
    objective: OBJECTIVE,
    mode: 'preview',
    agentKey: AGENT_KEY,
    authorizedPlanFingerprint: null,
    model,
    now: () => AT,
    ...overrides,
  });
}

/** The seven-step flow, as a script. Used by several tests below. */
function fullScript() {
  return [
    calls({ tool: 'list_agents' }),
    calls({ tool: 'list_benchmarks' }),
    calls({ tool: 'get_benchmark', input: { benchmarkId: BENCHMARK_ID } }),
    calls({ tool: 'create_test_plan', input: { benchmarkId: BENCHMARK_ID, agentKey: AGENT_KEY } }),
    say('I have planned the test. It is ready to run.'),
  ];
}

describe('the model chooses what to do, and the trace records it', () => {
  it("runs the SDK loop and reaches the model's own conclusion", async () => {
    const model = new ScriptedOperatorModel(fullScript());
    const run = await invoke(model);

    expect(run.status).toBe('completed');
    expect(run.stopReason).toBe('endTurn');
    expect(model.calls).toHaveLength(5);
    expect(run.narration).toBe('I have planned the test. It is ready to run.');
  });

  it('records one trace step per tool call, in the order the model asked for them', async () => {
    const run = await invoke(new ScriptedOperatorModel(fullScript()));
    expect(run.trace.map((step) => step.tool)).toEqual([
      'list_agents',
      'list_benchmarks',
      'get_benchmark',
      'create_test_plan',
    ]);
    expect(run.trace.map((step) => step.index)).toEqual([0, 1, 2, 3]);
    expect(run.trace.every((step) => step.status === 'completed')).toBe(true);
  });

  it('assigns each phase on the server, from a declared table', async () => {
    const run = await invoke(new ScriptedOperatorModel(fullScript()));
    expect(run.trace.map((step) => step.phase)).toEqual([
      'discover',
      'discover',
      'discover',
      'plan',
    ]);
  });

  it('carries a tool-written summary and a server timestamp on every step', async () => {
    const run = await invoke(new ScriptedOperatorModel(fullScript()));
    for (const step of run.trace) {
      expect(step.summary.length).toBeGreaterThan(10);
      expect(step.at).toBe(AT.toISOString());
    }
  });

  it('exposes no private reasoning — only the actions and their summaries', async () => {
    const model = new ScriptedOperatorModel([
      ...fullScript().slice(0, 4),
      say('My private chain of thought: I considered running every counterfactual.'),
    ]);
    const run = await invoke(model);
    // What the model *said* is narration, held apart from the trace. What the
    // trace holds is only what was done.
    expect(run.narration).toContain('My private chain of thought');
    const trace = JSON.stringify(run.trace);
    expect(trace).not.toContain('private chain of thought');
  });

  it('does not fabricate a status for a step that never happened', async () => {
    const run = await invoke(
      new ScriptedOperatorModel([calls({ tool: 'list_agents' }), say('done')]),
    );
    expect(run.trace).toHaveLength(1);
    expect(run.trace.some((step) => step.tool === 'run_benchmark')).toBe(false);
    expect(run.report).toBeNull();
    expect(run.result).toBeNull();
  });
});

describe('an execution the caller authorised runs the whole flow', () => {
  async function planned(): Promise<{
    model: ScriptedOperatorModel;
    run: Awaited<ReturnType<typeof runOperator>>;
  }> {
    // The fingerprint is not known until the plan is committed, so the run is
    // driven twice: once to produce the plan and its digest, once to execute it
    // under that digest — exactly the preview/authorise/execute sequence a person
    // goes through in the console.
    const preview = await invoke(new ScriptedOperatorModel(fullScript()));
    const fingerprint = preview.plan?.fingerprint;
    if (!fingerprint) throw new Error('the preview produced no plan fingerprint');

    const model = new ScriptedOperatorModel([
      ...fullScript().slice(0, 4),
      calls({ tool: 'run_benchmark', input: { benchmarkId: BENCHMARK_ID } }),
      calls({ tool: 'inspect_results' }),
      calls({
        tool: 'generate_trust_report',
        input: { interpretation: 'The perturbed condition lost ground.' },
      }),
      say('Report assembled.'),
    ]);
    const run = await invoke(model, {
      mode: 'execute',
      authorizedPlanFingerprint: fingerprint,
    });
    return { model, run };
  }

  it('executes, inspects and reports through the real engines', async () => {
    const { run } = await planned();
    expect(run.authorized).toBe(true);
    expect(run.result).not.toBeNull();
    expect(run.report).not.toBeNull();
    expect(run.usage.benchmarkRuns).toBe(1);
  });

  it('records the execution phase on the step that spent provider capacity', async () => {
    const { run } = await planned();
    const step = run.trace.find((entry) => entry.tool === 'run_benchmark');
    expect(step?.phase).toBe('execute');
    expect(step?.status).toBe('completed');
    expect(run.trace.find((entry) => entry.tool === 'inspect_results')?.phase).toBe('inspect');
    expect(run.trace.find((entry) => entry.tool === 'generate_trust_report')?.phase).toBe('report');
  });

  it('produces a report whose verdict came from the engine', async () => {
    const { run } = await planned();
    expect(run.report?.verdict.methodology).toBe('observed-evidence-thresholds-v1');
    expect(run.report?.observed.overall).toBe(run.result?.dimensions.averageOverallScore);
    expect(run.report?.interpretation).toBe('The perturbed condition lost ground.');
  });
});

describe('the execution tool is absent from a preview, not merely refused', () => {
  it('never offers run_benchmark to the model in preview mode', async () => {
    const model = new ScriptedOperatorModel([calls({ tool: 'list_agents' }), say('done')]);
    await invoke(model);

    for (let index = 0; index < model.calls.length; index += 1) {
      expect(offeredTools(model, index)).not.toContain('run_benchmark');
    }
  });

  it('offers run_benchmark once the run is authorised to execute', async () => {
    const model = new ScriptedOperatorModel([calls({ tool: 'list_agents' }), say('done')]);
    await invoke(model, { mode: 'execute', authorizedPlanFingerprint: 'anything' });
    expect(offeredTools(model)).toContain('run_benchmark');
  });

  it('records an attempt to call a tool that was not offered, rather than hiding it', async () => {
    const model = new ScriptedOperatorModel([
      calls({ tool: 'run_benchmark', input: { benchmarkId: BENCHMARK_ID } }),
      say('done'),
    ]);
    const run = await invoke(model);

    const step = run.trace.find((entry) => entry.tool === 'run_benchmark');
    expect(step?.status).toBe('failed');
    expect(run.result).toBeNull();
    expect(run.usage.failedToolCalls).toBe(1);
  });
});

describe('the SDK stops a model that will not stop', () => {
  it('terminates at the turn limit and reports it as such', async () => {
    // A model that calls a tool on every turn, forever. The turn limit is the
    // only thing that ends this run; `repeatLast` is what lets the script
    // genuinely never end.
    const model = new ScriptedOperatorModel([calls({ tool: 'list_benchmarks' })], {
      repeatLast: true,
    });
    const run = await invoke(model);

    expect(run.status).toBe('limit-reached');
    expect(run.stopReason).toBe('limitTurns');
    expect(run.usage.turns).toBe(MAX_OPERATOR_TURNS);
    expect(model.calls).toHaveLength(MAX_OPERATOR_TURNS);
    expect(run.report).toBeNull();
  });

  it('refuses the calls past the tool-call budget rather than making them', async () => {
    // Three calls per turn, so the tool-call budget (not the turn limit) is what
    // bites: 24 allowed calls are reached part-way through the ninth turn.
    const model = new ScriptedOperatorModel(
      [calls({ tool: 'list_agents' }, { tool: 'list_benchmarks' }, { tool: 'list_benchmarks' })],
      { repeatLast: true },
    );
    const run = await invoke(model);

    expect(run.usage.toolCalls).toBe(MAX_OPERATOR_TOOL_CALLS);
    expect(run.usage.refusedToolCalls).toBeGreaterThan(0);
    expect(run.trace.some((step) => step.status === 'refused')).toBe(true);
    // Every call past the budget got a refusal a model can read and act on.
    const refusals = run.trace.filter((step) => step.status === 'refused');
    expect(refusals[0]?.summary).toContain(String(MAX_OPERATOR_TOOL_CALLS));
  });
});

describe('a failure is reported, never hidden', () => {
  it("surfaces a provider failure with the provider's own code, through the SDK's wrapper", async () => {
    // The SDK wraps a model failure in its own `ModelError`, so the provider's
    // error only exists as `cause`. If the operator read only the thrown value it
    // would report a generic failure and lose the code — which is the failure
    // this test exists to catch.
    const model = new ScriptedOperatorModel([
      calls({ tool: 'list_agents' }),
      fails(new AgentProviderError('throttled', 'The provider throttled the request.')),
    ]);
    const run = await invoke(model);

    expect(run.status).toBe('failed');
    expect(run.stopReason).toBe('throttled');
    expect(run.report).toBeNull();
    expect(run.narration).toBeNull();
    expect(run.notices.join(' ')).toContain('throttled');
    expect(run.notices.join(' ')).toContain('The provider throttled the request.');
  });

  it('classifies an unclassified failure rather than losing it', async () => {
    const model = new ScriptedOperatorModel([
      calls({ tool: 'list_benchmarks' }),
      fails(new Error('the connection dropped')),
    ]);
    const run = await invoke(model);

    expect(run.status).toBe('failed');
    expect(run.stopReason).toBe('provider_error');
    expect(run.trace.map((step) => step.tool)).toEqual(['list_benchmarks']);
    expect(run.notices.join(' ')).toMatch(/model call failed/);
  });

  it('records a refused tool call without ending the run', async () => {
    const model = new ScriptedOperatorModel([
      calls({ tool: 'get_benchmark', input: { benchmarkId: 'a-benchmark-that-does-not-exist' } }),
      say('That benchmark does not exist.'),
    ]);
    const run = await invoke(model);

    expect(run.status).toBe('completed');
    expect(run.trace[0]?.status).toBe('refused');
    expect(run.usage.refusedToolCalls).toBe(1);
    expect(run.narration).toBe('That benchmark does not exist.');
  });

  it('records a malformed tool call as a failure and keeps going', async () => {
    const model = new ScriptedOperatorModel([
      calls({ tool: 'get_benchmark', input: { benchmarkId: 42 } }),
      calls({ tool: 'list_agents' }),
      say('Corrected.'),
    ]);
    const run = await invoke(model);

    expect(run.trace[0]?.status).toBe('failed');
    expect(run.trace[1]?.status).toBe('completed');
    expect(run.status).toBe('completed');
  });

  it('reports an unclassified model error as a provider failure, never as a silent stop', async () => {
    const model = new ScriptedOperatorModel([fails(new Error('no such model'))]);
    const run = await invoke(model);
    expect(run.status).toBe('failed');
    expect(run.stopReason).toBe('provider_error');
    expect(run.trace).toHaveLength(0);
    expect(run.report).toBeNull();
    expect(run.notices).toHaveLength(1);
  });
});

describe('the run state is the whole of what a run produced', () => {
  it('carries the objective, the mode and the agent that was asked for', async () => {
    const run = await invoke(new ScriptedOperatorModel(fullScript()));
    expect(run.objective).toBe(OBJECTIVE);
    expect(run.mode).toBe('preview');
    expect(run.requestedAgentKey).toBe(AGENT_KEY);
  });

  it('publishes the bounds it ran under', async () => {
    const run = await invoke(new ScriptedOperatorModel(fullScript()));
    expect(run.limits.maxTurns).toBe(MAX_OPERATOR_TURNS);
    expect(run.limits.maxToolCalls).toBe(MAX_OPERATOR_TOOL_CALLS);
    expect(run.limits.maxBenchmarkRuns).toBe(1);
  });

  it('lists the agents this deployment can run, with no credential in sight', async () => {
    const run = await invoke(new ScriptedOperatorModel(fullScript()));
    expect(run.agents.map((agent) => agent.key)).toEqual([AGENT_KEY]);
    expect(JSON.stringify(run)).not.toMatch(/api[_-]?key|bearer|secret|sk-/i);
  });

  it('is a valid OperatorRunState', async () => {
    const run = await invoke(new ScriptedOperatorModel(fullScript()));
    const schema = await import('@/lib/operator/types');
    expect(() => schema.OperatorRunState.parse(run)).not.toThrow();
  });
});
