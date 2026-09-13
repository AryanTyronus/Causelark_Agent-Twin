//
// A benchmark is a standardised test, so the page is written like a test
// specification rather than a product card: what it measures, in what
// environment, under how many conditions at how many seeds, and whether anything
// can actually be run against it. The catalogue is compiled into the deployment,
// so every row here can be run and none of them can be supplied by a caller.

'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ErrorPanel, Notice, Panel, PanelSkeleton } from '@/components/custom/agent-twin/ui';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { BenchmarkCatalog, type BenchmarkSummary } from '@/lib/benchmarks/types';
import { ExperimentCatalog, type ExperimentSummary } from '@/lib/comparison/types';

export default function BenchmarksPage() {
  const [benchmarks, setBenchmarks] = useState<BenchmarkSummary[] | null>(null);
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [catalog, experimentCatalog] = await Promise.all([
          apiFetch('/api/benchmarks', { schema: BenchmarkCatalog }),
          apiFetch('/api/agent-comparisons', { schema: ExperimentCatalog }),
        ]);
        if (!active) return;
        setBenchmarks(catalog.benchmarks);
        setExperiments(experimentCatalog.experiments);
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (failed)
    return (
      <ErrorPanel
        title="Benchmark catalogue unavailable"
        message="The deployment’s benchmark registry could not be read. Nothing was run and no data was changed — reloading the page is safe."
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard">Back to the overview</Link>
          </Button>
        }
      />
    );

  return (
    <div className="space-y-6">
      <div>
        <p className="text-eyebrow">Benchmarks</p>
        <h1 className="mt-3 font-display text-h2">Standardised tests</h1>
        <p className="mt-3 max-w-prose text-small leading-relaxed text-muted-foreground">
          Every benchmark fixes its environment, its conditions at exact versions, and its seeds.
          Because nothing in a benchmark moves between runs, two results from the same benchmark at
          the same version are comparable — which is the whole point of running one.
        </p>
      </div>

      {benchmarks === null ? (
        <Panel title="Catalogue">
          <PanelSkeleton lines={5} label="Loading the benchmark catalogue" />
        </Panel>
      ) : benchmarks.length === 0 ? (
        <Notice>This deployment ships no benchmarks, so no test can be run against one.</Notice>
      ) : (
        <div className="space-y-4">
          {benchmarks.map((benchmark) => {
            const over = experiments.filter(
              (experiment) =>
                experiment.benchmarkId === benchmark.id &&
                experiment.benchmarkVersion === benchmark.version,
            );
            return (
              <Panel
                key={`${benchmark.id}@${benchmark.version}`}
                title={benchmark.name}
                description={
                  <span className="font-mono text-[11px]">
                    {benchmark.id}@{benchmark.version}
                  </span>
                }
                action={
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={`/dashboard/benchmarks/${benchmark.id}?version=${benchmark.version}`}
                    >
                      Open
                      <ArrowRight aria-hidden className="size-3.5" />
                    </Link>
                  </Button>
                }
              >
                <p className="max-w-prose text-small leading-relaxed text-muted-foreground">
                  {benchmark.description}
                </p>
                <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                  <Fact label="Environment" value={benchmark.environmentKey} />
                  <Fact label="Objective" value={benchmark.objectiveKey} />
                  <Fact label="Conditions" value={String(benchmark.scenarioCount)} />
                  <Fact label="Seeds" value={String(benchmark.seedCount)} />
                  <Fact label="Cases" value={String(benchmark.caseCount)} />
                </dl>
                <p className="mt-4 text-[11px] text-muted-foreground">
                  {over.length > 0
                    ? `${over.length} comparison experiment(s) run this benchmark: ${over
                        .map((experiment) => `${experiment.id}@${experiment.version}`)
                        .join(', ')}.`
                    : 'No comparison experiment is registered over this benchmark yet, so it can be read here but not run as an agent-versus-agent test.'}
                </p>
              </Panel>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-caption uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-mono text-[11px]">{value}</dd>
    </div>
  );
}
