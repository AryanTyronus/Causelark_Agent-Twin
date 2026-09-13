//
// A comparison report is not persisted, so this page can only show a result that
// this browser session still holds. When it holds one, the page says where it
// came from and offers the runs it was derived from. When it does not — a fresh
// session, a different machine, a report evicted from a small store — the page
// says exactly that, and offers the persisted runs instead, because the runs are
// the evidence and the report is a function of them.
//
// What it must never do is reconstruct a plausible report from the runs it can
// read. Recomputing the comparison in the browser would be a second
// implementation of the comparison engine, and two implementations of one
// verdict is a product that cannot say what it means.

'use client';

import { ArrowRight, FlaskConical } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { ExperimentCatalog, type ExperimentSummary } from '@/lib/comparison/types';
import {
  SimulationRunList as SimulationRunListSchema,
  type SimulationRunSummary,
} from '@/lib/contracts/simulation';
import { ComparisonReportView } from './comparison-report';
import { formatTimestamp, scenarioLabel } from './format';
import { readReportsForExperiment, type StoredReport } from './store';
import { EmptyState, ErrorPanel, Notice, Panel, PanelSkeleton, StatusChip } from './ui';

/** `null` while the store has not been read yet; `[]` when it holds nothing. */
type StoredState = StoredReport[] | null;

export function TestResult({ experimentId }: { experimentId: string }) {
  const [stored, setStored] = useState<StoredState>(null);
  const [selected, setSelected] = useState(0);
  const [experiment, setExperiment] = useState<ExperimentSummary | null>(null);
  const [runs, setRuns] = useState<SimulationRunSummary[] | null>(null);
  /**
   * Whether the catalogue could not be read, as opposed to not containing this
   * experiment. The two are different findings and only one of them is true, so
   * the page is not allowed to report "no such experiment" for a catalogue it
   * never saw.
   */
  const [catalogueUnread, setCatalogueUnread] = useState(false);

  // Reading the store is a browser-only operation, so it happens after mount.
  useEffect(() => {
    setStored(readReportsForExperiment(experimentId));
  }, [experimentId]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [catalog, runList] = await Promise.all([
          apiFetch('/api/agent-comparisons', { schema: ExperimentCatalog }),
          apiFetch('/api/simulations/runs', { schema: SimulationRunListSchema }),
        ]);
        if (!active) return;
        setExperiment(catalog.experiments.find((entry) => entry.id === experimentId) ?? null);
        setRuns(runList.runs);
      } catch {
        if (!active) return;
        setRuns([]);
        setCatalogueUnread(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [experimentId]);

  if (stored === null)
    return (
      <Panel title="Result" description="Reading this browser session’s results…">
        <PanelSkeleton lines={4} label="Reading stored results" />
      </Panel>
    );

  if (!experiment && stored.length === 0)
    return catalogueUnread ? (
      <ErrorPanel
        title="Result unavailable"
        message="The deployment’s experiment catalogue could not be read, so this page cannot tell whether this experiment exists. Nothing was run and no data was changed — reloading the page is safe."
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/simulations">See the recorded runs</Link>
          </Button>
        }
      />
    ) : (
      <ErrorPanel
        title="Unknown experiment"
        message={`No experiment named “${experimentId}” is registered in this deployment, and this browser session holds no result for it.`}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/benchmarks">See the benchmark catalogue</Link>
          </Button>
        }
      />
    );

  const entry = stored[selected];

  if (entry)
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-eyebrow">Result</p>
            <h1 className="mt-3 font-display text-h2">{entry.report.experiment.name}</h1>
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">
              {entry.report.experiment.id}@{entry.report.experiment.version}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link href="/dashboard/simulations">Recorded runs</Link>
            </Button>
            <Button asChild>
              <Link href="/dashboard/tests">
                <FlaskConical aria-hidden className="size-4" />
                Run this experiment again
              </Link>
            </Button>
          </div>
        </div>

        <Notice>
          <span className="font-medium text-foreground">This result is held in this browser. </span>
          Agent Twin does not store comparison reports — a report is a pure function of the runs it
          was derived from, and a stored copy could only drift from its own evidence. This one was
          produced{' '}
          <span className="font-mono text-foreground">{formatTimestamp(entry.storedAt)}</span> and
          lasts until this browser session ends. Re-running the experiment reproduces it from the
          same persisted runs.
        </Notice>

        {stored.length > 1 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-caption uppercase tracking-[0.06em] text-muted-foreground">
              Results held here
            </span>
            {stored.map((candidate, index) => (
              <Button
                key={candidate.storedAt}
                type="button"
                size="sm"
                variant={index === selected ? 'default' : 'outline'}
                onClick={() => setSelected(index)}
              >
                {formatTimestamp(candidate.storedAt)}
                <span className="ml-1 font-mono text-[10px]">
                  {candidate.report.execution.executedCaseCount} runs
                </span>
              </Button>
            ))}
          </div>
        ) : null}

        <ComparisonReportView report={entry.report} />
      </div>
    );

  return (
    <div className="space-y-6">
      <div>
        <p className="text-eyebrow">Result</p>
        <h1 className="mt-3 font-display text-h2">{experiment?.name ?? 'Test result'}</h1>
        {experiment ? (
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">
            {experiment.id}@{experiment.version}
          </p>
        ) : null}
      </div>

      <Notice>
        <span className="font-medium text-foreground">
          This browser session does not hold a report for this experiment.{' '}
        </span>
        Comparison reports are not stored, so a result exists only in the session that produced it.
        The runs underneath it are persisted, and they are the evidence —{' '}
        <Link href="/dashboard/simulations" className="underline underline-offset-4">
          open the recorded runs
        </Link>{' '}
        to read them, or run the experiment again to produce a report from the same matrix.
      </Notice>

      {experiment ? (
        <Panel
          title={experiment.name}
          description={experiment.description}
          action={
            <Button asChild size="sm">
              <Link href="/dashboard/tests">
                Run this experiment
                <ArrowRight aria-hidden className="size-3.5" />
              </Link>
            </Button>
          }
        >
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Fact
              label="Benchmark"
              value={`${experiment.benchmarkId}@${experiment.benchmarkVersion}`}
            />
            <Fact label="Environment" value={experiment.environmentKey} />
            <Fact label="Objective" value={experiment.objectiveKey} />
            <Fact label="Conditions" value={`${experiment.scenarioCount} scenario(s)`} />
            <Fact label="Seeds" value={String(experiment.seedCount)} />
            <Fact label="Cases per agent" value={String(experiment.caseCountPerAgent)} />
            <Fact
              label="Agents"
              value={`${experiment.minimumAgents}–${experiment.maximumAgents}`}
            />
            <Fact label="Verdict rule" value={experiment.verdictRule} />
            <Fact label="Methodology" value={experiment.methodology} />
          </dl>
        </Panel>
      ) : null}

      <Panel
        title="Recorded runs for this account"
        description="The persisted evidence a report would be derived from. A run's own record is what a comparison reads, so these are the durable half of any result."
      >
        {runs === null ? (
          <PanelSkeleton lines={4} label="Loading recorded runs" />
        ) : runs.length === 0 ? (
          <EmptyState
            title="No runs recorded yet"
            description="Nothing has been run for this account, so there is no evidence to read."
            action={
              <Button asChild size="sm">
                <Link href="/dashboard/tests">Run a test</Link>
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-small">
              <caption className="sr-only">Recorded runs</caption>
              <thead>
                <tr className="border-b border-border text-left">
                  <th
                    scope="col"
                    className="pb-2 pr-4 text-caption uppercase tracking-[0.06em] text-muted-foreground"
                  >
                    Scenario
                  </th>
                  <th
                    scope="col"
                    className="pb-2 pr-4 text-caption uppercase tracking-[0.06em] text-muted-foreground"
                  >
                    Seed
                  </th>
                  <th
                    scope="col"
                    className="pb-2 pr-4 text-caption uppercase tracking-[0.06em] text-muted-foreground"
                  >
                    Status
                  </th>
                  <th
                    scope="col"
                    className="pb-2 pr-4 text-caption uppercase tracking-[0.06em] text-muted-foreground"
                  >
                    Recorded
                  </th>
                  <th
                    scope="col"
                    className="pb-2 pr-4 text-caption uppercase tracking-[0.06em] text-muted-foreground"
                  >
                    {''}
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 25).map((run) => (
                  <tr key={run.id} className="border-b border-border/60">
                    <td className="py-2.5 pr-4 font-mono text-[11px]">
                      {run.scenario
                        ? `${scenarioLabel(run.scenario.id)}@${run.scenario.version}`
                        : 'not recorded'}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-[11px]">{run.seed}</td>
                    <td className="py-2.5 pr-4">
                      <StatusChip
                        tone={
                          run.status === 'COMPLETED'
                            ? 'ok'
                            : run.status === 'RUNNING'
                              ? 'info'
                              : 'bad'
                        }
                      >
                        {run.status}
                      </StatusChip>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-[11px]">
                      {formatTimestamp(run.createdAt)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Link
                        href={`/dashboard/simulations/${run.id}`}
                        className="underline underline-offset-4"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {runs.length > 25 ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Showing the 25 most recent of {runs.length}.{' '}
                <Link href="/dashboard/simulations" className="underline underline-offset-4">
                  Open the full list
                </Link>
                .
              </p>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-caption uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-mono text-small">{value}</dd>
    </div>
  );
}
