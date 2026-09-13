// @polsia:user-owned — the Run a Test flow.
//
// One primary action, in four steps: choose the agents, choose the benchmark,
// review the conditions, run. Everything the flow shows comes from a catalogue
// the server compiled — the experiment registry, the benchmark registry, and the
// agent configurations this deployment can actually construct a client for. The
// flow invents no agent, no benchmark and no score.
//
// The step that matters most is the third one. What makes a comparison mean
// anything is what was held equal: the same environment, the same scenarios, the
// same seeds, the same objective, the same tools, the same evaluation. Only the
// agent changes. That is stated before the run, in the same terms the report
// will use afterwards, so the claim is checkable rather than marketing.
//
// The run itself is a real one. It drives real model turns, it takes real time,
// and it is shown as it happens by reading the runs it creates — never by a
// progress bar that moves on a timer. If the deployment cannot run two distinct
// agents, the flow says so and does not offer to pretend.

'use client';

import { AlertTriangle, Check, GitCompareArrows, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiFetch } from '@/lib/api-client';
import { BenchmarkCatalog, type BenchmarkSummary } from '@/lib/benchmarks/types';
import {
  type ComparisonReport,
  ComparisonReport as ComparisonReportSchema,
  ExperimentCatalog,
  type ExperimentPlan,
  ExperimentPlan as ExperimentPlanSchema,
  type ExperimentSummary,
} from '@/lib/comparison/types';
import {
  type AgentCatalog,
  AgentCatalog as AgentCatalogSchema,
  agentConfigurationFor,
  modelVersionSlug,
} from '@/lib/contracts/agents';
import { ComparisonReportView } from './comparison-report';
import { ExecutionView, matchPlan, useRunRecorder } from './execution-view';
import { readModels, rememberModels, storeReport } from './store';
import { ErrorPanel, Notice, Panel, PanelSkeleton, StatusChip } from './ui';

/** One agent the operator is configuring, as they are typing it. */
interface AgentDraft {
  /**
   * A stable identity for this row, so React state follows the row rather than
   * its position when an earlier agent is removed.
   */
  rowKey: string;
  provider: string;
  model: string;
}

/**
 * The conditions a comparison holds equal.
 *
 * Declared here as wording, not as logic: each line is a property of the
 * experiment the server resolved, and the review step prints them beside the one
 * thing that does change.
 */
const CONTROLLED_CONDITIONS = [
  { label: 'Same environment', detail: 'Every agent meets the same simulated world.' },
  {
    label: 'Same scenarios',
    detail: 'Every agent runs the same conditions, at the same versions.',
  },
  { label: 'Same seeds', detail: 'Every agent runs the same seeds, in the same order.' },
  { label: 'Same objective', detail: 'Every agent is given the same goal.' },
  { label: 'Same tools', detail: 'Every agent is offered the same allow-listed actions.' },
  { label: 'Same evaluation', detail: 'Every run is scored by the same evaluation engine.' },
];

/**
 * The message to show for a failed API call.
 *
 * The routes answer a bad request with `{ errors: { field: message } }` and a
 * domain refusal with `{ error, code }`; both are safe operator-facing text the
 * server wrote on purpose. Anything else — a 500, a network failure — is
 * reported as what it is rather than by echoing a response body the interface
 * has not been told how to read.
 */
function apiErrorMessage(cause: unknown): string {
  const body = cause instanceof Error ? cause.cause : null;
  if (body && typeof body === 'object') {
    const errors = (body as { errors?: Record<string, string> }).errors;
    if (errors) {
      const first = Object.values(errors)[0];
      if (typeof first === 'string') return first;
    }
    const message = (body as { error?: string }).error;
    if (typeof message === 'string' && message !== '') return message;
  }
  const status = cause instanceof Error ? cause.message : '';
  if (status.includes('(401)')) return 'Your session has expired. Sign in again to run a test.';
  if (status.includes('(503)'))
    return 'This deployment cannot run one of the selected agents. Check the provider configuration and try again.';
  if (status.includes('(413)'))
    return 'This experiment would run more cases than the engine will drive in one test. Compare fewer agents, or use a smaller benchmark.';
  return 'The test could not be started. Nothing was left running — no case was created for it.';
}

/**
 * A row identity for a draft agent.
 *
 * A counter rather than a random value: drafts are created only by this
 * component, and a monotonic key makes the sequence readable in a test failure.
 */
let rowSequence = 0;
function nextRowKey(): string {
  rowSequence += 1;
  return `agent-row-${rowSequence}`;
}

export function TestRunner() {
  const [experiments, setExperiments] = useState<ExperimentSummary[] | null>(null);
  const [benchmarks, setBenchmarks] = useState<BenchmarkSummary[] | null>(null);
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [benchmarkKey, setBenchmarkKey] = useState<string | null>(null);
  const [experimentId, setExperimentId] = useState<string | null>(null);
  const [plan, setPlan] = useState<ExperimentPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<AgentDraft[]>([]);
  const [knownModels, setKnownModels] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [report, setReport] = useState<ComparisonReport | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const recorder = useRunRecorder();

  // Load the three catalogues once. They are registries compiled into the build,
  // so a second read would return exactly what the first one did.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [experimentCatalog, benchmarkCatalog, agentCatalog] = await Promise.all([
          apiFetch('/api/agent-comparisons', { schema: ExperimentCatalog }),
          apiFetch('/api/benchmarks', { schema: BenchmarkCatalog }),
          apiFetch('/api/agents', { schema: AgentCatalogSchema }),
        ]);
        if (!active) return;
        setExperiments(experimentCatalog.experiments);
        setBenchmarks(benchmarkCatalog.benchmarks);
        setCatalog(agentCatalog);
        setKnownModels(readModels());

        const first = experimentCatalog.experiments[0];
        if (first) {
          setBenchmarkKey(`${first.benchmarkId}@${first.benchmarkVersion}`);
          setExperimentId(first.id);
        }
        const deploymentAgent = agentCatalog.agents.find((agent) => agent.isDeploymentDefault);
        setDrafts([
          {
            rowKey: nextRowKey(),
            provider:
              deploymentAgent?.configuration.provider ?? agentCatalog.providers[0]?.provider ?? '',
            model: deploymentAgent?.configuration.model ?? '',
          },
          // The second agent is deliberately blank. Pre-filling it would be a
          // suggestion about what to compare, and the product does not have one.
          { rowKey: nextRowKey(), provider: agentCatalog.providers[0]?.provider ?? '', model: '' },
        ]);
      } catch {
        if (active)
          setLoadError(
            'The Agent Twin catalogues could not be loaded. This is usually a session or connection problem — reloading the page is safe.',
          );
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // The plan is what the experiment will actually run. Read from the endpoint
  // that builds it from the benchmark engine's own matrix, so the review step
  // states the real case count rather than a hopeful one.
  useEffect(() => {
    if (!experimentId) return;
    let active = true;
    setPlan(null);
    setPlanError(null);
    void (async () => {
      try {
        const value = await apiFetch(`/api/agent-comparisons/${experimentId}`, {
          schema: ExperimentPlanSchema,
        });
        if (active) setPlan(value);
      } catch {
        if (active)
          setPlanError(
            'This experiment could not be resolved from the deployment’s catalogue, so it cannot be run.',
          );
      }
    })();
    return () => {
      active = false;
    };
  }, [experimentId]);

  // Elapsed time is a clock, and it is labelled as a clock. It is not progress.
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [running]);

  const selectedBenchmark = useMemo(
    () =>
      benchmarks?.find((benchmark) => `${benchmark.id}@${benchmark.version}` === benchmarkKey) ??
      null,
    [benchmarks, benchmarkKey],
  );

  /**
   * The configured rows, each still carrying the identity of the row it came
   * from.
   *
   * The row key travels with the configuration because the configuration's own
   * identity is not usable as one here: two rows describing the same agent is
   * exactly the state this form has to be able to *show* in order to refuse it,
   * and a list keyed on the agent's identity would collapse them into one.
   */
  const selectedAgents = useMemo(
    () =>
      drafts
        .filter((draft) => draft.provider !== '' && draft.model.trim() !== '')
        .map((draft) => ({
          rowKey: draft.rowKey,
          configuration: agentConfigurationFor({
            provider: draft.provider,
            model: draft.model.trim(),
          }),
        })),
    [drafts],
  );

  const configurations = useMemo(
    () => selectedAgents.map((entry) => entry.configuration),
    [selectedAgents],
  );

  const planProgress = useMemo(
    () => (plan ? matchPlan(plan.cases, configurations, recorder.recorded) : new Map()),
    [plan, configurations, recorder.recorded],
  );

  const updateDraft = useCallback((index: number, patch: Partial<AgentDraft>) => {
    setDrafts((current) =>
      current.map((draft, position) => (position === index ? { ...draft, ...patch } : draft)),
    );
    setValidationError(null);
  }, []);

  /**
   * Why these agents cannot be compared, or `null`.
   *
   * This mirrors the rule the comparison engine enforces rather than replacing
   * it — the server refuses a duplicate too, and its message is what a caller
   * sees if this check is ever bypassed. It exists so the operator is told
   * before a run rather than after one.
   */
  const duplicateReason = useMemo(() => {
    if (configurations.length < 2) return null;
    const seen = new Map<string, number>();
    for (const configuration of configurations) {
      const identity = `${configuration.agentId}@${configuration.agentVersion}`;
      seen.set(identity, (seen.get(identity) ?? 0) + 1);
    }
    for (const [identity, count] of seen)
      if (count > 1)
        return `Two of the selected agents are the same configuration (${identity}). A comparison needs two distinct agents, so change one of their models.`;
    return null;
  }, [configurations]);

  async function start() {
    if (!experimentId || !plan) return;
    if (configurations.length < 2) {
      setValidationError('A comparison needs two agents. Name a model for both before running.');
      return;
    }
    if (duplicateReason) {
      setValidationError(duplicateReason);
      return;
    }
    setValidationError(null);
    setRunError(null);
    setReport(null);
    setElapsed(0);
    setRunning(true);

    // The snapshot must be taken before the request is sent, or a run created
    // between the two would be mistaken for one that already existed.
    await recorder.begin();
    try {
      const value = await apiFetch(`/api/agent-comparisons/${experimentId}/run`, {
        method: 'POST',
        body: JSON.stringify({ agents: configurations }),
        schema: ComparisonReportSchema,
      });
      storeReport(value);
      rememberModels(configurations.map((configuration) => configuration.model).filter(Boolean));
      setReport(value);
    } catch (cause) {
      setRunError(apiErrorMessage(cause));
    } finally {
      recorder.stop();
      setRunning(false);
    }
  }

  if (loadError)
    return (
      <ErrorPanel
        title="Catalogues unavailable"
        message={loadError}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard">Back to the overview</Link>
          </Button>
        }
      />
    );

  if (!experiments || !benchmarks || !catalog)
    return (
      <div className="space-y-6">
        <Panel title="Run a test" description="Loading the experiment and benchmark catalogues…">
          <PanelSkeleton lines={5} label="Loading catalogues" />
        </Panel>
      </div>
    );

  if (report)
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-eyebrow">Result</p>
            <h2 className="mt-2 font-display text-h2">Test complete</h2>
            <p className="mt-2 max-w-prose text-small text-muted-foreground">
              Produced from {report.execution.executedCaseCount} persisted runs, scored by the
              evaluation engine and compared by the comparison engine. Every number below came back
              from the server; none of it was computed in the browser.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link href="/dashboard/simulations">See the recorded evidence</Link>
            </Button>
            <Button type="button" onClick={() => setReport(null)}>
              <GitCompareArrows aria-hidden className="size-4" />
              Run another test
            </Button>
          </div>
        </div>
        <ComparisonReportView report={report} />
        <p className="text-caption text-muted-foreground">
          A comparison report is not stored. The runs it was derived from are, and they are the
          evidence — the report is a pure function of them.{' '}
          <Link href="/dashboard/simulations" className="underline underline-offset-4">
            Open the recorded runs
          </Link>
          .
        </p>
      </div>
    );

  return (
    <div className="space-y-6">
      {running && plan ? (
        <ExecutionView
          experimentLabel={`${plan.experiment.id}@${plan.experiment.version}`}
          plan={planProgress}
          recorded={recorder.recorded}
          recording={recorder.recording}
          elapsedSeconds={elapsed}
        />
      ) : null}

      {runError ? (
        <ErrorPanel
          title="The test could not be run"
          message={runError}
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void start()}>
              Try again
            </Button>
          }
        />
      ) : null}

      <Step
        number={1}
        title="Select agents"
        description="An agent configuration is a provider and the model it asks for. Credentials belong to the deployment, never to an agent, and are never shown here."
        done={configurations.length >= 2 && duplicateReason === null}
      >
        <div className="space-y-4">
          {catalog.agents.length === 0 ? (
            <Notice>
              <span className="font-medium text-foreground">
                This deployment has no configured agent.{' '}
              </span>
              {catalog.configurationNotice ??
                'Set a provider model for this environment before running a test.'}{' '}
              An agent can still be named below, but the run will report it as unavailable rather
              than inventing a result for it.
            </Notice>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              This deployment is configured for{' '}
              {catalog.agents.map((agent) => agent.identity).join(', ')}. Any other model the
              provider serves can be named below — a model is an agent’s identity, and the provider
              boundary is what makes a selection runnable.
            </p>
          )}

          {drafts.map((draft, index) => (
            <div key={draft.rowKey} className="rounded-sm border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  Agent {String.fromCharCode(65 + index)}
                </p>
                {drafts.length > 2 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setDrafts((current) => current.filter((_, position) => position !== index))
                    }
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                    Remove
                  </Button>
                ) : null}
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
                <div className="space-y-1.5">
                  <Label htmlFor={`provider-${index}`}>Provider</Label>
                  <Select
                    value={draft.provider}
                    onValueChange={(value) => updateDraft(index, { provider: value })}
                  >
                    <SelectTrigger id={`provider-${index}`}>
                      <SelectValue placeholder="Select a provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {catalog.providers.map((provider) => (
                        <SelectItem key={provider.provider} value={provider.provider}>
                          {provider.label}
                          {provider.production ? '' : ' — development'}
                          {provider.configured ? '' : ' — not configured'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`model-${index}`}>Model</Label>
                  <Input
                    id={`model-${index}`}
                    value={draft.model}
                    list="agent-twin-known-models"
                    placeholder="The model this agent asks for, e.g. vendor/model-name"
                    onChange={(event) => updateDraft(index, { model: event.target.value })}
                  />
                </div>
              </div>
              {draft.provider !== '' && draft.model.trim() !== '' ? (
                <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                  identity{' '}
                  {
                    agentConfigurationFor({ provider: draft.provider, model: draft.model.trim() })
                      .agentId
                  }
                  @{modelVersionSlug(draft.model.trim())} · asked for {draft.model.trim()}
                </p>
              ) : null}
            </div>
          ))}

          <datalist id="agent-twin-known-models">
            {knownModels.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={drafts.length >= (plan?.experiment.maximumAgents ?? 2)}
              onClick={() =>
                setDrafts((current) => [
                  ...current,
                  { rowKey: nextRowKey(), provider: current[0]?.provider ?? '', model: '' },
                ])
              }
            >
              <Plus aria-hidden className="size-3.5" />
              Add agent
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {plan
                ? `This benchmark can be compared across at most ${plan.experiment.maximumAgents} agents at these seeds.`
                : 'Select a benchmark to see how many agents it can compare.'}
            </span>
          </div>

          {knownModels.length > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              The model field suggests {knownModels.length} model(s) this browser has used before.
              That list is a convenience kept in this browser, not a catalogue of what the provider
              serves.
            </p>
          ) : null}

          {duplicateReason ? (
            <p role="alert" className="text-small text-destructive">
              {duplicateReason}
            </p>
          ) : null}
        </div>
      </Step>

      <Step
        number={2}
        title="Select benchmark"
        description="A benchmark is a standardised test: a fixed environment, a fixed set of conditions at pinned versions, and a fixed seed set. The experiment pins the benchmark at an exact version, so a benchmark cannot change underneath a result."
        done={plan !== null}
      >
        {planError ? (
          <ErrorPanel title="Benchmark unavailable" message={planError} />
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5 sm:max-w-md">
              <Label htmlFor="benchmark-select">Benchmark</Label>
              <Select
                value={benchmarkKey ?? undefined}
                onValueChange={(value) => {
                  setBenchmarkKey(value);
                  const next = experiments.find(
                    (experiment) =>
                      `${experiment.benchmarkId}@${experiment.benchmarkVersion}` === value,
                  );
                  setExperimentId(next?.id ?? null);
                }}
              >
                <SelectTrigger id="benchmark-select">
                  <SelectValue placeholder="Select a benchmark" />
                </SelectTrigger>
                <SelectContent>
                  {benchmarks.map((benchmark) => (
                    <SelectItem
                      key={`${benchmark.id}@${benchmark.version}`}
                      value={`${benchmark.id}@${benchmark.version}`}
                    >
                      {benchmark.name} v{benchmark.version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedBenchmark ? (
              <div className="rounded-sm border border-border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <p className="font-display text-h4">{selectedBenchmark.name}</p>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {selectedBenchmark.id}@{selectedBenchmark.version}
                  </span>
                </div>
                <p className="mt-2 max-w-prose text-small leading-relaxed text-muted-foreground">
                  {selectedBenchmark.description}
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <MiniFact label="Environment" value={selectedBenchmark.environmentKey} />
                  <MiniFact label="Objective" value={selectedBenchmark.objectiveKey} />
                  <MiniFact
                    label="Conditions"
                    value={`${selectedBenchmark.scenarioCount} scenario(s)`}
                  />
                  <MiniFact label="Seeds" value={`${selectedBenchmark.seedCount} seed(s)`} />
                </div>
              </div>
            ) : null}

            {plan ? (
              <div className="rounded-sm border border-border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <p className="text-small font-medium">Experiment</p>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {plan.experiment.id}@{plan.experiment.version}
                  </span>
                </div>
                <p className="mt-2 max-w-prose text-small leading-relaxed text-muted-foreground">
                  {plan.experiment.description}
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <MiniFact
                    label="Cases per agent"
                    value={String(plan.experiment.caseCountPerAgent)}
                  />
                  <MiniFact label="Seeds" value={plan.seeds.join(', ')} />
                  <MiniFact label="Verdict rule" value={plan.experiment.verdictRule} />
                  <MiniFact label="Methodology" value={plan.experiment.methodology} />
                </div>
                <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                  Conditions:{' '}
                  {plan.cases
                    .filter(
                      (entry, index, all) =>
                        all.findIndex((other) => other.scenarioId === entry.scenarioId) === index,
                    )
                    .map((entry) => entry.scenarioId)
                    .join(', ')}
                </p>
              </div>
            ) : (
              <PanelSkeleton lines={3} label="Resolving the experiment" />
            )}
          </div>
        )}
      </Step>

      <Step
        number={3}
        title="Review conditions"
        description="Only the agent changes. Everything else in this experiment is held equal by the engine, not by convention."
        done={configurations.length >= 2 && plan !== null}
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-sm border border-border p-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                Agents under comparison
              </p>
              <ul className="mt-3 space-y-2">
                {selectedAgents.length === 0 ? (
                  <li className="text-small text-muted-foreground">No agent configured yet.</li>
                ) : (
                  selectedAgents.map((entry) => (
                    <li key={entry.rowKey}>
                      <p className="font-mono text-small">
                        {entry.configuration.agentId}@{entry.configuration.agentVersion}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                        {entry.configuration.provider} · {entry.configuration.model}
                      </p>
                    </li>
                  ))
                )}
              </ul>
            </div>
            <div className="rounded-sm border border-border p-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                Conditions held equal
              </p>
              <ul className="mt-3 space-y-2">
                {CONTROLLED_CONDITIONS.map((condition) => (
                  <li key={condition.label} className="flex gap-2">
                    <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-brand-600" />
                    <span>
                      <span className="text-small">{condition.label}</span>
                      <span className="block text-[11px] leading-snug text-muted-foreground">
                        {condition.detail}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <p className="font-display text-h4">Only the agent changes.</p>

          {plan ? (
            <Notice>
              This test will run{' '}
              <span className="font-mono text-foreground">{plan.cases.length} cases per agent</span>{' '}
              across {configurations.length || 2} agent(s) —{' '}
              <span className="font-mono text-foreground">
                {plan.cases.length * (configurations.length || 2)} real runs
              </span>
              , each driving an actual model. It is not a simulation of a test; it is the test.
            </Notice>
          ) : null}

          {validationError ? (
            <p role="alert" className="text-small text-destructive">
              {validationError}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="lg"
              onClick={() => void start()}
              disabled={
                running || plan === null || configurations.length < 2 || duplicateReason !== null
              }
            >
              {running ? 'Running…' : report ? 'Run again' : 'Run test'}
            </Button>
            {running ? (
              <StatusChip tone="info">A test is already running</StatusChip>
            ) : configurations.length < 2 || duplicateReason ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <AlertTriangle aria-hidden className="size-3.5" />
                Two distinct agents are required before this test can start.
              </span>
            ) : null}
          </div>
        </div>
      </Step>
    </div>
  );
}

/** One numbered step of the flow. */
function Step({
  number,
  title,
  description,
  done,
  children,
}: {
  number: number;
  title: string;
  description: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <Panel
      title={`${number}. ${title}`}
      description={description}
      action={<StatusChip tone={done ? 'ok' : 'idle'}>{done ? 'ready' : 'incomplete'}</StatusChip>}
    >
      {children}
    </Panel>
  );
}

function MiniFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-caption uppercase tracking-[0.06em] text-muted-foreground">{label}</p>
      <p className="mt-0.5 break-words font-mono text-[11px]">{value}</p>
    </div>
  );
}
