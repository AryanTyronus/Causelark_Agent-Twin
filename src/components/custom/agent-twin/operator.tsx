// @polsia:user-owned — the Operator console.
//
// One page, three questions in the order a person asks them: what do I want to
// know, what is about to run, and what did it find. Everything below the request
// form is something that actually happened — the plan the operator committed to,
// the tools it called, the numbers the engines returned, and the report assembled
// from them.
//
// Three display rules follow from that, and they are the reason this file is
// shaped the way it is:
//
//   * The operator's own words are never shown as evidence. Its closing narration
//     and its reading of the verdict are in their own panels, labelled, and
//     rendered apart from every measurement. A reader can tell at a glance which
//     sentences came from an engine and which came from a model.
//
//   * A missing number is not a zero. Every figure here goes through the same
//     formatting as the rest of the console, where `null` renders as "not
//     recorded" in words.
//
//   * Preview and live execution are different screens, not a checkbox. A
//     preview ends at a plan and a fingerprint; the button that runs the
//     benchmark is a separate, explicit step that names what it is about to
//     spend.

'use client';

import { Compass, Play, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { type AgentCandidate, AgentCatalog as AgentCatalogSchema } from '@/lib/contracts/agents';
import {
  OPERATOR_ERROR_CODES,
  type OperatorResultSlice,
  OperatorRunEnvelope,
  type OperatorRunState,
  type ReadinessRule,
  type TrustReport,
} from '@/lib/operator/types';
import { formatRatio, formatScore, formatTimestamp, scenarioLabel } from './format';
import {
  EmptyState,
  ErrorPanel,
  Fact,
  Notice,
  Panel,
  PanelSkeleton,
  SourceChip,
  StatusChip,
} from './ui';

const VERDICT_TONE = {
  READY: 'ok',
  CAUTION: 'warn',
  NOT_READY: 'bad',
  INSUFFICIENT_EVIDENCE: 'idle',
} as const;

const RULE_TONE = {
  pass: 'ok',
  caution: 'warn',
  fail: 'bad',
  insufficient: 'idle',
} as const;

/** The status of a tool call, as a word and a tone. Never colour alone. */
function traceTone(status: string): 'ok' | 'warn' | 'bad' {
  if (status === 'completed') return 'ok';
  if (status === 'refused') return 'warn';
  return 'bad';
}

/**
 * The operator's refusal, in the operator's words.
 *
 * The route serves its own refusals as `{ error, code }` — text the server wrote
 * on purpose for a person to read — and `apiFetch` carries that body on the
 * error's `cause`. But a response body is not automatically a message from this
 * product: a proxy's error page, a hosting platform's 500, or a deployment
 * running different code can all arrive here with an `error` field, and printing
 * one would put text this interface cannot vouch for in front of a reader as if
 * the server had said it.
 *
 * So the body is read only when it carries one of this API's declared error
 * codes. That is the one signal that the sentence was written here. Everything
 * else falls through to the status, and each of those sentences is this file's
 * own.
 */
function operatorErrorMessage(cause: unknown): string {
  const body = cause instanceof Error ? cause.cause : null;
  if (body && typeof body === 'object') {
    const { code, error } = body as { code?: unknown; error?: unknown };
    if (
      typeof code === 'string' &&
      typeof error === 'string' &&
      error !== '' &&
      (OPERATOR_ERROR_CODES as readonly string[]).includes(code)
    )
      return error;
  }
  const status = cause instanceof Error ? cause.message : '';
  if (status.includes('(401)'))
    return 'Your session has expired. Sign in again to run the operator.';
  if (status.includes('(503)'))
    return 'This deployment cannot serve an operator run: its model provider is not configured. No plan was made and nothing was executed.';
  return 'The operator run failed. Nothing was reported.';
}

export function OperatorConsole() {
  const [objective, setObjective] = useState('');
  const [agentKey, setAgentKey] = useState('');
  const [agents, setAgents] = useState<AgentCandidate[] | null>(null);
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
  const [run, setRun] = useState<OperatorRunState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const catalog = await apiFetch('/api/agents', { schema: AgentCatalogSchema });
        if (!active) return;
        setAgents(catalog.agents);
        setCatalogNotice(catalog.configurationNotice);
      } catch {
        if (active) setAgents([]);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const invoke = useCallback(
    async (nextMode: 'preview' | 'execute', fingerprint: string | null) => {
      setBusy(true);
      setFailure(null);
      try {
        const envelope = await apiFetch('/api/operator', {
          method: 'POST',
          body: JSON.stringify({
            objective: objective.trim(),
            agentKey: agentKey || null,
            mode: nextMode,
            authorizedPlanFingerprint: fingerprint,
          }),
          schema: OperatorRunEnvelope,
        });
        setRun(envelope.run);
      } catch (error) {
        setFailure(operatorErrorMessage(error));
        // A failed execution attempt leaves the previous preview on screen: the
        // plan a person was looking at is still the plan, and losing it would
        // mean re-running a preview to get back to where they were.
      } finally {
        setBusy(false);
      }
    },
    [agentKey, objective],
  );

  const ready = objective.trim().length >= 8 && !busy;

  return (
    <div className="space-y-8">
      <section>
        <p className="text-eyebrow">Agent Twin</p>
        <h1 className="mt-3 font-display text-h1">Operator</h1>
        <p className="mt-4 max-w-prose text-body-lg leading-relaxed text-muted-foreground">
          Hand it an objective in plain language. The operator decides which benchmark to run,
          commits to a plan you can read before anything happens, executes it through the same
          deterministic engines as the rest of this console, investigates what failed, and writes a
          deployment-readiness report with the evidence attached. It never decides what is true —
          the engines do.
        </p>
      </section>

      <Panel
        title="Objective"
        description="What you want to know. The operator will tell you if it cannot be settled by a benchmark that exists."
        source="request"
        sourceKind="fact"
      >
        <label className="block text-caption uppercase tracking-[0.06em] text-muted-foreground">
          Objective
          <textarea
            aria-label="Objective"
            className="mt-2 min-h-20 w-full rounded-sm border border-border bg-background p-2 font-mono text-small"
            placeholder="Test this agent and tell me whether it is ready to deploy."
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
          />
        </label>

        <label className="mt-4 block text-caption uppercase tracking-[0.06em] text-muted-foreground">
          Agent under test
          <select
            aria-label="Agent under test"
            className="mt-2 w-full rounded-sm border border-border bg-background p-2 text-small"
            value={agentKey}
            onChange={(event) => setAgentKey(event.target.value)}
          >
            <option value="">Let the operator choose</option>
            {(agents ?? []).map((agent) => (
              <option key={agent.key} value={agent.key}>
                {agent.identity} · {agent.configuration.provider}
              </option>
            ))}
          </select>
        </label>

        {agents !== null && agents.length === 0 ? (
          <div className="mt-4">
            <Notice>
              {catalogNotice ??
                'This deployment has no agent configuration that resolves, so there is nothing for the operator to test.'}
            </Notice>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="lg"
            disabled={!ready}
            onClick={() => void invoke('preview', null)}
          >
            <Compass aria-hidden="true" className="size-4" />
            {busy ? 'Working…' : 'Plan a test'}
          </Button>
          <p className="text-caption text-muted-foreground">
            A preview contacts no provider-driven simulation. It costs one bounded operator
            invocation and produces a plan.
          </p>
        </div>
      </Panel>

      {failure ? <ErrorPanel title="The operator run failed" message={failure} /> : null}

      {busy ? (
        <Panel title="Operator working">
          <PanelSkeleton lines={3} label="The operator is running" />
        </Panel>
      ) : null}

      {run ? (
        <OperatorRunView
          run={run}
          onExecute={(fingerprint) => void invoke('execute', fingerprint)}
          busy={busy}
        />
      ) : null}
    </div>
  );
}

/** Everything one operator run produced, in the order it produced it. */
export function OperatorRunView({
  run,
  onExecute,
  busy,
}: {
  run: OperatorRunState;
  onExecute: (fingerprint: string) => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-8">
      <ExecutionStatus run={run} />

      {run.notices.map((notice) => (
        <Notice key={notice}>{notice}</Notice>
      ))}

      {run.plan ? (
        <PlanPanel
          run={run}
          // The execute affordance appears only where a plan exists, only in
          // preview mode, and only when the plan has not already been run.
          onExecute={onExecute}
          busy={busy}
        />
      ) : null}

      <ToolTracePanel run={run} />

      {run.result ? <ResultsPanel result={run.result} /> : null}

      {run.caseEvidence.length > 0 ? <CaseEvidencePanel run={run} /> : null}

      {run.counterfactuals.length > 0 ? <CounterfactualPanel run={run} /> : null}

      {run.report ? <TrustReportPanel report={run.report} /> : null}

      {run.narration ? (
        <Panel
          title="Operator narration"
          description="What the operator wrote in its own words. This is a model's summary, not a measurement — every figure above came from an engine."
          source="request"
          sourceKind="derived"
        >
          <p className="whitespace-pre-wrap text-small leading-relaxed text-muted-foreground">
            {run.narration}
          </p>
        </Panel>
      ) : null}
    </div>
  );
}

function ExecutionStatus({ run }: { run: OperatorRunState }) {
  const tone = run.status === 'completed' ? 'ok' : run.status === 'limit-reached' ? 'warn' : 'bad';
  return (
    <Panel
      title="Execution"
      description={
        run.mode === 'preview'
          ? 'PREVIEW — the operator was not permitted to run a benchmark. What follows is what it found out and what it would do.'
          : run.authorized
            ? 'LIVE EXECUTION — a benchmark was authorised against the plan below and executed through the benchmark engine.'
            : 'LIVE EXECUTION requested — no authorised plan matched, so no benchmark was started.'
      }
      source="configuration"
      sourceKind="fact"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone={run.mode === 'preview' ? 'info' : 'warn'}>
          {run.mode === 'preview' ? 'PREVIEW' : 'LIVE'}
        </StatusChip>
        <StatusChip tone={tone}>{run.status}</StatusChip>
        <StatusChip tone="idle">stopped: {run.stopReason}</StatusChip>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Fact label="Model turns" value={`${run.usage.turns} / ${run.limits.maxTurns}`} />
        <Fact label="Tool calls" value={`${run.usage.toolCalls} / ${run.limits.maxToolCalls}`} />
        <Fact label="Refused calls" value={run.usage.refusedToolCalls} />
        <Fact label="Failed calls" value={run.usage.failedToolCalls} />
        <Fact
          label="Benchmark runs"
          value={`${run.usage.benchmarkRuns} / ${run.limits.maxBenchmarkRuns}`}
        />
        <Fact
          label="Counterfactuals"
          value={`${run.usage.counterfactualAnalyses} / ${run.limits.maxCounterfactualAnalyses}`}
        />
        <Fact label="Duration" value={`${(run.usage.durationMs / 1000).toFixed(1)}s`} />
        <Fact label="Agent requested" value={run.requestedAgentKey ?? 'operator chose'} />
      </dl>

      {run.agents.length > 0 ? (
        <div className="mt-4">
          <p className="text-caption uppercase tracking-[0.06em] text-muted-foreground">
            Agents this deployment can run
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {run.agents.map((agent) => (
              <li key={agent.key}>
                <SourceChip source="configuration" kind="fact" />
                <span className="ml-2 font-mono text-[11px]">{agent.identity}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

function PlanPanel({
  run,
  onExecute,
  busy,
}: {
  run: OperatorRunState;
  onExecute: (fingerprint: string) => void;
  busy: boolean;
}) {
  const plan = run.plan;
  if (!plan) return null;
  return (
    <Panel
      title="Test plan"
      description="Exactly what would be executed. Every field was copied from the benchmark registry and the agent catalogue; the operator could not invent one."
      source="configuration"
      sourceKind="fact"
    >
      <dl className="grid gap-3 sm:grid-cols-3">
        <Fact label="Benchmark" value={`${plan.benchmark.name} (${plan.benchmark.id})`} />
        <Fact label="Version" value={plan.benchmark.version} />
        <Fact label="Agent" value={plan.agent.identity} />
        <Fact label="Provider" value={plan.agent.providerLabel} mono={false} />
        <Fact label="Environment" value={plan.benchmark.environmentKey} />
        <Fact label="Objective" value={plan.benchmark.objectiveKey} />
        <Fact label="Conditions" value={plan.scenarios.length} />
        <Fact label="Seeds" value={plan.seeds.join(', ')} />
        <Fact label="Cases" value={plan.caseCount} />
      </dl>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[28rem] border-collapse text-small">
          <caption className="sr-only">Conditions in the planned matrix</caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th
                scope="col"
                className="pb-2 pr-4 text-caption uppercase tracking-[0.06em] text-muted-foreground"
              >
                Condition
              </th>
              <th
                scope="col"
                className="pb-2 pr-4 text-caption uppercase tracking-[0.06em] text-muted-foreground"
              >
                Version
              </th>
              <th
                scope="col"
                className="pb-2 pr-4 text-caption uppercase tracking-[0.06em] text-muted-foreground"
              >
                Role
              </th>
            </tr>
          </thead>
          <tbody>
            {plan.scenarios.map((scenario) => (
              <tr key={`${scenario.id}@${scenario.version}`} className="border-b border-border/60">
                <td className="py-2 pr-4 font-mono text-[11px]">{scenarioLabel(scenario.id)}</td>
                <td className="py-2 pr-4 font-mono text-[11px]">{scenario.version}</td>
                <td className="py-2 pr-4 text-small">
                  {scenario.isBaseline ? 'Baseline' : 'Perturbed'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-small text-muted-foreground">
        This execution would drive{' '}
        <strong className="font-medium text-foreground">
          {plan.providerDrivenSimulations} provider-driven simulations
        </strong>{' '}
        across {plan.caseCount} case(s) and {plan.seeds.length} seed(s), against{' '}
        {plan.agent.providerLabel}.
      </p>

      <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
        plan fingerprint {plan.fingerprint}
      </p>

      {run.mode === 'preview' ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => onExecute(plan.fingerprint)}
          >
            <Play aria-hidden="true" className="size-4" />
            Authorise and execute
          </Button>
          <p className="text-caption text-muted-foreground">
            This runs the benchmark above for real. It is bounded to {run.limits.maxBenchmarkRuns}{' '}
            execution per request, and the authorisation covers this plan's fingerprint — a
            different plan would be refused.
          </p>
        </div>
      ) : null}
    </Panel>
  );
}

function ToolTracePanel({ run }: { run: OperatorRunState }) {
  return (
    <Panel
      title="Tool activity"
      description="Every tool call the operator made, in order. Each line was written by the tool itself from the result it returned — the operator cannot add to or reword this list."
      source="trace"
      sourceKind="fact"
    >
      {run.trace.length === 0 ? (
        <EmptyState
          title="No tool calls recorded"
          description="The operator produced no tool calls in this run."
        />
      ) : (
        <ol className="space-y-2">
          {run.trace.map((step) => (
            <li
              key={`${step.index}-${step.tool}`}
              className="flex flex-wrap items-baseline gap-2 border-b border-border/60 pb-2 last:border-0"
            >
              <span className="font-mono text-[10px] text-muted-foreground">
                {String(step.index + 1).padStart(2, '0')}
              </span>
              <StatusChip tone={traceTone(step.status)}>{step.status}</StatusChip>
              <span className="text-caption uppercase tracking-[0.06em] text-muted-foreground">
                {step.phase}
              </span>
              <span className="font-mono text-[11px]">{step.tool}</span>
              <span className="w-full text-small text-muted-foreground sm:w-auto sm:flex-1">
                {step.summary}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {formatTimestamp(step.at)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/** The benchmark result, in the console's usual reading order. */
function ResultsPanel({ result }: { result: OperatorResultSlice }) {
  const dimensions = result.dimensions;
  const robustness = result.robustness;
  const readNumber = (key: string) => {
    const value = dimensions[key];
    return typeof value === 'number' ? value : null;
  };
  const readRobustness = (key: string) => {
    const value = robustness[key];
    return typeof value === 'number' ? value : null;
  };
  const readString = (key: string) => {
    const value = robustness[key];
    return typeof value === 'string' ? value : null;
  };

  return (
    <>
      <Panel
        title="Benchmark result"
        description={`${result.benchmark.name} (${result.benchmark.id}@${result.benchmark.version}), run against ${result.agent.label ?? result.agent.provider}. Every figure below is the benchmark engine's own output.`}
        source="benchmark"
        sourceKind="fact"
      >
        <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Fact label="Overall (mean)" value={formatScore(readNumber('averageOverallScore'))} />
          <Fact label="Lowest case" value={formatScore(readNumber('minimumOverallScore'))} />
          <Fact label="Highest case" value={formatScore(readNumber('maximumOverallScore'))} />
          <Fact
            label="Cases evaluated"
            value={readNumber('evaluatedCaseCount') ?? 'not recorded'}
          />
          <Fact label="Task" value={formatScore(readNumber('averageTaskScore'))} />
          <Fact label="Safety" value={formatScore(readNumber('averageSafetyScore'))} />
          <Fact label="Efficiency" value={formatScore(readNumber('averageEfficiencyScore'))} />
          <Fact label="Resources" value={formatScore(readNumber('averageResourceScore'))} />
          <Fact label="Reliability" value={formatScore(readNumber('averageReliabilityScore'))} />
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <SourceChip source="benchmark" kind="derived" />
          <span className="text-small text-muted-foreground">
            Robustness{' '}
            <span className="font-mono">{formatRatio(readRobustness('robustnessScore'))}</span> —{' '}
            {readString('formula') ?? 'not recorded'}, retention against the baseline condition.
            {readString('unavailableReason')
              ? ` Not computed: ${readString('unavailableReason')}.`
              : ''}
          </span>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[42rem] border-collapse text-small">
            <caption className="sr-only">Scenario performance</caption>
            <thead>
              <tr className="border-b border-border text-left">
                {['Condition', 'Score', 'Retention', 'Change', 'Cases', 'Evaluated', 'Status'].map(
                  (heading) => (
                    <th
                      key={heading}
                      scope="col"
                      className="pb-2 pr-4 text-caption uppercase tracking-[0.06em] text-muted-foreground"
                    >
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {result.scenarios.map((scenario) => {
                const id = String(scenario.scenarioId ?? 'unknown');
                const version = Number(scenario.scenarioVersion ?? 0);
                return (
                  <tr key={`${id}@${version}`} className="border-b border-border/60">
                    <td className="py-2 pr-4">
                      <span className="font-mono text-[11px]">{scenarioLabel(id)}</span>
                      {scenario.isBaseline === true ? (
                        <span className="ml-2 text-caption text-muted-foreground">baseline</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 font-mono text-[11px]">
                      {formatScore(scenario.score as number | null)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-[11px]">
                      {formatRatio(scenario.retention as number | null)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-[11px]">
                      {formatScore(scenario.absoluteDegradation as number | null)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-[11px]">
                      {String(scenario.caseCount ?? 0)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-[11px]">
                      {String(scenario.evaluatedCount ?? 0)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-[11px]">
                      {(scenario.runStatus as string | null) ?? 'not recorded'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="Failure profile"
        description="Cases flagged per class, by the benchmark engine's own classification. A class is reported only when a recorded field states it."
        source="benchmark"
        sourceKind="derived"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FAILURE_CATEGORIES.map((category) => {
            const entry = result.failures[category] as
              | { count?: number; metric?: string | null; runIds?: string[] }
              | undefined;
            const count = typeof entry?.count === 'number' ? entry.count : 0;
            return (
              <div key={category} className="rounded-sm border border-border bg-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-caption uppercase tracking-[0.06em] text-muted-foreground">
                    {FAILURE_LABELS[category] ?? category}
                  </p>
                  <StatusChip tone={count === 0 ? 'ok' : 'bad'}>{count}</StatusChip>
                </div>
                <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
                  {entry?.metric ?? 'run status'}
                </p>
                {entry?.runIds && entry.runIds.length > 0 ? (
                  <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                    {entry.runIds.join(', ')}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel
        title="Evidence index"
        description="Every run this execution created. A run id links to the recorded run behind it."
        source="benchmark"
        sourceKind="fact"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-small">
            <caption className="sr-only">Runs produced by this execution</caption>
            <thead>
              <tr className="border-b border-border text-left">
                {['Condition', 'Seed', 'Outcome', 'Status', 'Score', 'Run', ''].map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="pb-2 pr-4 text-caption uppercase tracking-[0.06em] text-muted-foreground"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.runs.map((entry) => (
                <tr key={entry.runId} className="border-b border-border/60">
                  <td className="py-2 pr-4 font-mono text-[11px]">
                    {scenarioLabel(entry.scenarioId)}
                  </td>
                  <td className="py-2 pr-4 font-mono text-[11px]">{entry.seed}</td>
                  <td className="py-2 pr-4">{entry.outcome}</td>
                  <td className="py-2 pr-4 font-mono text-[11px]">{entry.status}</td>
                  <td className="py-2 pr-4 font-mono text-[11px]">
                    {formatScore(entry.overallScore)}
                  </td>
                  <td className="py-2 pr-4 font-mono text-[10px] text-muted-foreground">
                    {entry.runId}
                  </td>
                  <td className="py-2 pr-4">
                    <Link
                      href={`/dashboard/simulations/${entry.runId}`}
                      className="underline underline-offset-4"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function CaseEvidencePanel({ run }: { run: OperatorRunState }) {
  return (
    <Panel
      title="Cases inspected"
      description="The cases the operator chose to look at in detail, with the evaluation engine's own verdict for each."
      source="evaluation"
      sourceKind="derived"
    >
      <div className="space-y-4">
        {run.caseEvidence.map((entry) => (
          <div key={entry.runId} className="rounded-sm border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px]">
                {entry.scenario
                  ? `${scenarioLabel(entry.scenario.id)}@${entry.scenario.version}`
                  : entry.caseKey}
              </span>
              <StatusChip tone="idle">seed {entry.seed}</StatusChip>
              <StatusChip tone={entry.status === 'COMPLETED' ? 'ok' : 'warn'}>
                {entry.status}
              </StatusChip>
              <StatusChip tone="info">
                overall {formatScore(entry.evaluation.overallScore)}
              </StatusChip>
            </div>
            <dl className="mt-3 grid gap-3 sm:grid-cols-4">
              <Fact label="Actions accepted" value={entry.actions.accepted} />
              <Fact label="Actions rejected" value={entry.actions.rejected} />
              <Fact label="Tool calls" value={entry.toolCalls.total} />
              <Fact label="Failed tool calls" value={entry.toolCalls.failed} />
            </dl>
            {entry.actions.rejectedActions.length > 0 ? (
              <ul className="mt-3 space-y-1">
                {entry.actions.rejectedActions.map((action) => (
                  <li
                    key={`${action.step}-${action.type}`}
                    className="text-small text-muted-foreground"
                  >
                    <span className="font-mono text-[11px]">step {action.step}</span> —{' '}
                    {action.type}: {action.reason ?? 'no reason recorded'}
                  </li>
                ))}
              </ul>
            ) : null}
            {entry.faults.length > 0 ? (
              <ul className="mt-3 space-y-1">
                {entry.faults.map((fault) => (
                  <li
                    key={fault}
                    className="flex items-start gap-2 text-small text-muted-foreground"
                  >
                    <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                    {fault}
                  </li>
                ))}
              </ul>
            ) : null}
            <Link
              href={`/dashboard/simulations/${entry.runId}`}
              className="mt-3 inline-block text-small underline underline-offset-4"
            >
              Open the recorded run
            </Link>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function CounterfactualPanel({ run }: { run: OperatorRunState }) {
  return (
    <Panel
      title="Counterfactual findings"
      description="What else the agent could have done, computed by the counterfactual engine under its own declared policies. This describes what was possible; it does not change what the run recorded."
      source="counterfactual"
      sourceKind="derived"
    >
      <div className="space-y-4">
        {run.counterfactuals.map((finding) => (
          <div key={finding.runId} className="rounded-sm border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px]">{finding.caseKey}</span>
              <StatusChip tone="info">
                baseline {formatScore(finding.baselineOverallScore)}
              </StatusChip>
              <StatusChip tone="idle">{finding.decisionsAnalysed} decision(s)</StatusChip>
              {finding.maxRegret !== null && finding.maxRegret > 0 ? (
                <StatusChip tone="warn">max regret {formatScore(finding.maxRegret)}</StatusChip>
              ) : (
                <StatusChip tone="ok">no better alternative found</StatusChip>
              )}
            </div>
            <dl className="mt-3 grid gap-3 sm:grid-cols-4">
              <Fact label="Improving decisions" value={finding.improvingDecisions} />
              <Fact label="Worsening decisions" value={finding.worseningDecisions} />
              <Fact label="Uncontested decisions" value={finding.uncontestedDecisions} />
              <Fact label="Outcome flips" value={finding.outcomeFlipDecisions} />
            </dl>
            {finding.criticalDecision ? (
              <p className="mt-3 text-small leading-relaxed text-muted-foreground">
                <span className="font-mono text-[11px]">
                  decision {finding.criticalDecision.index} · step {finding.criticalDecision.step} ·{' '}
                  {finding.criticalDecision.actionType}
                </span>{' '}
                — {finding.criticalDecision.statement}
              </p>
            ) : null}
            <p className="mt-3 break-all font-mono text-[10px] text-muted-foreground">
              policies:{' '}
              {Object.entries(finding.policies)
                .map(([key, value]) => `${key}=${value}`)
                .join(' · ')}
            </p>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function TrustReportPanel({ report }: { report: TrustReport }) {
  const tone = VERDICT_TONE[report.verdict.verdict];
  return (
    <>
      <Panel
        title="Agent Trust Report"
        description={`Policy version ${report.policyVersion}. Assembled deterministically from the recorded tool results by ${report.verdict.methodology}.`}
        source="benchmark"
        sourceKind="derived"
        id="trust-report"
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={tone}>{report.verdict.verdict.replace('_', ' ')}</StatusChip>
          <span className="text-small text-muted-foreground">{report.verdict.headline}</span>
        </div>

        <dl className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Fact label="Target" value={report.target.identity} />
          <Fact label="Provider" value={report.target.providerLabel} mono={false} />
          <Fact label="Benchmark" value={`${report.benchmark.id}@${report.benchmark.version}`} />
          <Fact label="Cases" value={report.benchmark.caseCount} />
        </dl>

        <h3 className="mt-6 font-display text-h4">Observed</h3>
        <dl className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Fact label="Overall" value={formatScore(report.observed.overall)} />
          <Fact label="Lowest case" value={formatScore(report.observed.minimum)} />
          <Fact label="Highest case" value={formatScore(report.observed.maximum)} />
          <Fact
            label="Robustness"
            value={formatRatio(report.observed.robustness.score)}
            hint={report.observed.robustness.formula}
          />
          <Fact label="Task" value={formatScore(report.observed.categories.task)} />
          <Fact label="Safety" value={formatScore(report.observed.categories.safety)} />
          <Fact label="Efficiency" value={formatScore(report.observed.categories.efficiency)} />
          <Fact label="Resources" value={formatScore(report.observed.categories.resources)} />
          <Fact label="Reliability" value={formatScore(report.observed.categories.reliability)} />
        </dl>

        <h3 className="mt-6 font-display text-h4">Scenario performance</h3>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-small">
            <caption className="sr-only">Scenario performance from the trust report</caption>
            <thead>
              <tr className="border-b border-border text-left">
                {['Condition', 'Score', 'Retention', 'Change', 'Cases'].map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="pb-2 pr-4 text-caption uppercase tracking-[0.06em] text-muted-foreground"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.observed.scenarioPerformance.map((scenario) => (
                <tr
                  key={`${scenario.scenarioId}@${scenario.scenarioVersion}`}
                  className="border-b border-border/60"
                >
                  <td className="py-2 pr-4 font-mono text-[11px]">
                    {scenarioLabel(scenario.scenarioId)}
                    {scenario.isBaseline ? (
                      <span className="ml-2 text-caption text-muted-foreground">baseline</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4 font-mono text-[11px]">{formatScore(scenario.score)}</td>
                  <td className="py-2 pr-4 font-mono text-[11px]">
                    {formatRatio(scenario.retention)}
                  </td>
                  <td className="py-2 pr-4 font-mono text-[11px]">
                    {formatScore(scenario.absoluteDegradation)}
                  </td>
                  <td className="py-2 pr-4 font-mono text-[11px]">
                    {scenario.evaluatedCount}/{scenario.caseCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="mt-6 font-display text-h4">Failures</h3>
        <ul className="mt-3 space-y-2">
          {report.observed.failures.map((failure) => (
            <li
              key={failure.category}
              className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-2 last:border-0"
            >
              <StatusChip tone={failure.count === 0 ? 'ok' : 'bad'}>{failure.count}</StatusChip>
              <span className="text-small">
                {FAILURE_LABELS[failure.category] ?? failure.category}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {failure.metric ?? 'run status'}
              </span>
            </li>
          ))}
        </ul>

        {report.observed.counterfactuals.length > 0 ? (
          <>
            <h3 className="mt-6 font-display text-h4">Counterfactual findings</h3>
            <ul className="mt-3 space-y-2">
              {report.observed.counterfactuals.map((finding) => (
                <li key={finding.runId} className="text-small text-muted-foreground">
                  <span className="font-mono text-[11px]">{finding.caseKey}</span> —{' '}
                  {finding.criticalDecision
                    ? finding.criticalDecision.statement
                    : 'No decision had a higher-scoring alternative.'}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <h3 className="mt-6 font-display text-h4">How this verdict was reached</h3>
        <ul className="mt-3 space-y-2">
          {report.verdict.rules.map((rule) => (
            <RuleRow key={rule.id} rule={rule} />
          ))}
        </ul>

        <h3 className="mt-6 font-display text-h4">Evidence</h3>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <Fact label="Run ids" value={report.evidence.runIds.join(', ') || 'none'} />
          <Fact label="Scenario ids" value={report.evidence.scenarioIds.join(', ') || 'none'} />
          <Fact
            label="Decision ids"
            value={report.evidence.decisionIds.join(', ') || 'none recorded'}
          />
          <Fact
            label="Plan fingerprint"
            value={report.provenance.planFingerprint ?? 'not authorised'}
          />
        </dl>
        <ul className="mt-3 space-y-1">
          {report.evidence.policies.map((policy) => (
            <li
              key={`${policy.name}-${policy.value}`}
              className="font-mono text-[11px] text-muted-foreground"
            >
              {policy.name} = {policy.value}
            </li>
          ))}
        </ul>

        <h3 className="mt-6 font-display text-h4">Provenance</h3>
        <dl className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Fact label="Benchmark runs" value={report.provenance.benchmarkRuns} />
          <Fact label="Counterfactual analyses" value={report.provenance.counterfactualAnalyses} />
          <Fact label="Tool calls" value={report.provenance.toolCalls} />
          <Fact label="Turns" value={report.provenance.turns} />
          <Fact label="Stop reason" value={report.provenance.stopReason} />
          <Fact label="Generated" value={formatTimestamp(report.provenance.generatedAt)} />
        </dl>
      </Panel>

      {report.interpretation || report.recommendation ? (
        <Panel
          title="Operator interpretation"
          description="The operator's reading of the evidence above, in its own words. This is not a measurement, and no figure in this report was read from it."
          source="request"
          sourceKind="derived"
        >
          {report.interpretation ? (
            <p className="whitespace-pre-wrap text-small leading-relaxed text-muted-foreground">
              {report.interpretation}
            </p>
          ) : null}
          {report.recommendation ? (
            <div className="mt-4 border-t border-border pt-4">
              <p className="text-caption uppercase tracking-[0.06em] text-muted-foreground">
                Recommendation
              </p>
              <p className="mt-1.5 whitespace-pre-wrap text-small leading-relaxed">
                {report.recommendation}
              </p>
            </div>
          ) : null}
        </Panel>
      ) : null}
    </>
  );
}

function RuleRow({ rule }: { rule: ReadinessRule }) {
  return (
    <li className="border-b border-border/60 pb-2 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone={RULE_TONE[rule.outcome]}>{rule.outcome}</StatusChip>
        <span className="text-small font-medium">{rule.label}</span>
        {rule.decisive ? (
          <span className="text-caption text-muted-foreground">decisive</span>
        ) : null}
        <span className="font-mono text-[11px] text-muted-foreground">
          {rule.observed ?? 'not recorded'}
        </span>
      </div>
      <p className="mt-1 text-small text-muted-foreground">{rule.detail}</p>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground">{rule.threshold}</p>
    </li>
  );
}

/** The failure classes, in the benchmark engine's own reporting order. */
const FAILURE_CATEGORIES = [
  'taskFailure',
  'safetyViolation',
  'invalidActions',
  'providerFailures',
  'toolFailures',
  'timeouts',
] as const;

const FAILURE_LABELS: Record<string, string> = {
  taskFailure: 'Task failure',
  safetyViolation: 'Safety violation',
  invalidActions: 'Invalid actions',
  providerFailures: 'Provider failures',
  toolFailures: 'Tool failures',
  timeouts: 'Timeouts',
};
