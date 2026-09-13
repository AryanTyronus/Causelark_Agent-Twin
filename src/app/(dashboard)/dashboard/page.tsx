// @polsia:user-owned — the Agent Twin overview.
//
// Four sections, in the order a newcomer needs them: what this is, what has
// already been run here, what the standardised tests are, and how a test works.
//
// "Recent tests" reads the owner's persisted runs and nothing else. There is no
// separate experiment history to read — a comparison report is deliberately not
// stored — so the recorded runs are the honest answer to "what has been run",
// and when there are none the page says so instead of showing a zero.

'use client';

import { ArrowRight, Play } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatTimestamp, scenarioLabel } from '@/components/custom/agent-twin/format';
import { EmptyState, Panel, PanelSkeleton, StatusChip } from '@/components/custom/agent-twin/ui';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { BenchmarkCatalog, type BenchmarkSummary } from '@/lib/benchmarks/types';
import { ExperimentCatalog, type ExperimentSummary } from '@/lib/comparison/types';
import {
  SimulationRunList as SimulationRunListSchema,
  type SimulationRunSummary,
} from '@/lib/contracts/simulation';

/** The recorded-run status, as a word and a tone. Never colour alone. */
function runTone(status: string): 'ok' | 'warn' | 'bad' | 'info' {
  if (status === 'COMPLETED') return 'ok';
  if (status === 'RUNNING') return 'info';
  return 'bad';
}

const PIPELINE = [
  { step: 'Agent', detail: 'A model, configured to act.' },
  { step: 'Simulated world', detail: 'A deterministic environment it can change.' },
  { step: 'Adversarial scenarios', detail: 'The same world, stressed.' },
  { step: 'Measure', detail: 'What it actually did, scored by the evaluation engine.' },
  { step: 'Analyze', detail: 'Which decision cost it, and what else it could have done.' },
  { step: 'Compare', detail: 'The same test, run against another agent.' },
];

export default function DashboardPage() {
  const [runs, setRuns] = useState<SimulationRunSummary[] | null>(null);
  const [benchmarks, setBenchmarks] = useState<BenchmarkSummary[] | null>(null);
  const [experiments, setExperiments] = useState<ExperimentSummary[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [runList, benchmarkCatalog, experimentCatalog] = await Promise.all([
          apiFetch('/api/simulations/runs', { schema: SimulationRunListSchema }),
          apiFetch('/api/benchmarks', { schema: BenchmarkCatalog }),
          apiFetch('/api/agent-comparisons', { schema: ExperimentCatalog }),
        ]);
        if (!active) return;
        setRuns(runList.runs);
        setBenchmarks(benchmarkCatalog.benchmarks);
        setExperiments(experimentCatalog.experiments);
      } catch {
        if (active)
          setFailed(
            'The Agent Twin catalogues could not be loaded. Reloading the page is safe; if this persists, the deployment’s database or session may be unavailable.',
          );
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const recent = runs ? runs.slice(0, 8) : null;

  return (
    <div className="space-y-10">
      <section>
        <p className="text-eyebrow">Agent Twin</p>
        <h1 className="mt-3 font-display text-h1">Autonomous Agent Testing Laboratory</h1>
        <p className="mt-4 max-w-prose text-body-lg leading-relaxed text-muted-foreground">
          Test autonomous intelligence before it touches the real world. Agent Twin puts an agent
          inside a controlled digital environment, stress-tests it under adversarial conditions, and
          measures what it actually does — then shows which decision cost it and how another agent
          behaves on exactly the same test.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/dashboard/tests">
              <Play aria-hidden="true" className="size-4" />
              Run a test
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/dashboard/benchmarks">
              Explore benchmarks
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </div>
      </section>

      {failed ? (
        <Panel title="Catalogues unavailable">
          <p role="alert" className="text-small text-muted-foreground">
            {failed}
          </p>
        </Panel>
      ) : null}

      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-h3">Recent tests</h2>
            <p className="mt-1 max-w-prose text-small text-muted-foreground">
              The runs recorded for this account, newest first. A comparison report is not stored —
              the runs it was derived from are, and every report is reproducible from them.
            </p>
          </div>
          <Link
            href="/dashboard/simulations"
            className="text-small text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            All recorded runs
          </Link>
        </div>

        <div className="mt-4">
          {recent === null ? (
            <Panel title="Recorded runs">
              <PanelSkeleton lines={4} label="Loading recorded runs" />
            </Panel>
          ) : recent.length === 0 ? (
            <EmptyState
              title="No tests yet"
              description="Run your first autonomous agent through the simulator."
              action={
                <Button asChild size="sm">
                  <Link href="/dashboard/tests">Run a test</Link>
                </Button>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] border-collapse text-small">
                <caption className="sr-only">Recent recorded runs</caption>
                <thead>
                  <tr className="border-b border-border text-left">
                    <Th>Scenario</Th>
                    <Th>Seed</Th>
                    <Th>Objective</Th>
                    <Th>Status</Th>
                    <Th>Terminal reason</Th>
                    <Th>Recorded</Th>
                    <Th>{''}</Th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((run) => (
                    <tr key={run.id} className="border-b border-border/60">
                      <Td mono>
                        {run.scenario
                          ? `${scenarioLabel(run.scenario.id)}@${run.scenario.version}`
                          : 'not recorded'}
                      </Td>
                      <Td mono>{run.seed}</Td>
                      <Td mono>{run.objectiveKey}</Td>
                      <Td>
                        <StatusChip tone={runTone(run.status)}>{run.status}</StatusChip>
                      </Td>
                      <Td mono>{run.terminationReason ?? 'not recorded'}</Td>
                      <Td mono>{formatTimestamp(run.createdAt)}</Td>
                      <Td>
                        <Link
                          href={`/dashboard/simulations/${run.id}`}
                          className="underline underline-offset-4"
                        >
                          Open
                        </Link>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 className="font-display text-h3">Benchmarks</h2>
        <p className="mt-1 max-w-prose text-small text-muted-foreground">
          A benchmark is a standardised test: a fixed environment, a fixed set of conditions at
          pinned versions, and a fixed seed set. Because the conditions never move, two results from
          the same benchmark are comparable.
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {benchmarks === null ? (
            <Panel title="Benchmark catalogue">
              <PanelSkeleton lines={4} label="Loading benchmarks" />
            </Panel>
          ) : (
            benchmarks.map((benchmark) => (
              <Panel
                key={`${benchmark.id}@${benchmark.version}`}
                title={benchmark.name}
                description={
                  <span className="font-mono text-[11px]">
                    {benchmark.id}@{benchmark.version}
                  </span>
                }
                action={
                  <Link
                    href={`/dashboard/benchmarks/${benchmark.id}?version=${benchmark.version}`}
                    className="text-small underline underline-offset-4"
                  >
                    Open
                  </Link>
                }
              >
                <p className="max-w-prose text-small leading-relaxed text-muted-foreground">
                  {benchmark.description}
                </p>
                <dl className="mt-4 grid grid-cols-2 gap-3">
                  <Mini label="Environment" value={benchmark.environmentKey} />
                  <Mini label="Objective" value={benchmark.objectiveKey} />
                  <Mini label="Conditions" value={String(benchmark.scenarioCount)} />
                  <Mini label="Seeds" value={String(benchmark.seedCount)} />
                </dl>
              </Panel>
            ))
          )}
        </div>

        {experiments && experiments.length > 0 ? (
          <p className="mt-4 text-small text-muted-foreground">
            {experiments.length} comparison experiment(s) are registered over these benchmarks — the
            tests that run two or more agents under the same conditions.{' '}
            <Link href="/dashboard/tests" className="underline underline-offset-4">
              Run one
            </Link>
            .
          </p>
        ) : null}
      </section>

      <section>
        <h2 className="font-display text-h3">How it works</h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PIPELINE.map((entry, index) => (
            <li key={entry.step} className="rounded-sm border border-border p-4">
              <p className="font-mono text-[10px] text-muted-foreground">
                {String(index + 1).padStart(2, '0')}
              </p>
              <p className="mt-2 font-display text-h4">{entry.step}</p>
              <p className="mt-1 text-small leading-relaxed text-muted-foreground">
                {entry.detail}
              </p>
            </li>
          ))}
        </ol>
        <p className="mt-4 max-w-prose text-small text-muted-foreground">
          A standalone run shows one agent under one condition. A comparison runs two or more agents
          through the same benchmark — same environment, same scenarios, same seeds, same objective,
          same tools, same evaluation. Only the agent changes.
        </p>
      </section>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="pb-2 pr-4 text-caption uppercase tracking-[0.06em] text-muted-foreground"
    >
      {children}
    </th>
  );
}

function Td({ children, mono = false }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td className={`py-2.5 pr-4 align-top ${mono ? 'font-mono text-[11px]' : ''}`}>{children}</td>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-caption uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-mono text-[11px]">{value}</dd>
    </div>
  );
}
