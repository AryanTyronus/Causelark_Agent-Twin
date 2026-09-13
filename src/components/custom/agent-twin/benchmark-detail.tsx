// @polsia:user-owned — one benchmark, read as a specification.
//
// The page answers the questions a reader has before trusting a number: which
// conditions, at which versions, at which seeds, what robustness is a retention
// against, and what the engine will refuse to do. All of it comes from the
// compiled definition, so the page describes exactly the benchmark that would
// run — not a description maintained beside it.

'use client';

import { ArrowLeft, Play } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { scenarioLabel } from '@/components/custom/agent-twin/format';
import {
  ErrorPanel,
  Notice,
  Panel,
  PanelSkeleton,
  StatusChip,
} from '@/components/custom/agent-twin/ui';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  type BenchmarkDetail,
  BenchmarkDetail as BenchmarkDetailSchema,
} from '@/lib/benchmarks/types';

export function BenchmarkDetailView({ benchmarkId }: { benchmarkId: string }) {
  const params = useSearchParams();
  const version = params.get('version');

  const [detail, setDetail] = useState<BenchmarkDetail | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(null);
    const query = version === null ? '' : `?version=${encodeURIComponent(version)}`;
    void (async () => {
      try {
        const value = await apiFetch(`/api/benchmarks/${encodeURIComponent(benchmarkId)}${query}`, {
          schema: BenchmarkDetailSchema,
        });
        if (active) setDetail(value);
      } catch (cause) {
        if (!active) return;
        const message = cause instanceof Error ? cause.message : '';
        if (message.includes('(404)'))
          setError({
            title: 'Benchmark not found',
            message: `This deployment ships no benchmark ${benchmarkId}${
              version ? ` at version ${version}` : ''
            }. A benchmark is compiled into the deployment, so a version the catalogue does not publish cannot be substituted for it.`,
          });
        else
          setError({
            title: 'Benchmark unavailable',
            message:
              'The benchmark definition could not be read. Nothing was run and no data was changed.',
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [benchmarkId, version]);

  if (error)
    return (
      <ErrorPanel
        title={error.title}
        message={error.message}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/benchmarks">
              <ArrowLeft aria-hidden className="size-3.5" />
              Benchmark catalogue
            </Link>
          </Button>
        }
      />
    );

  if (!detail)
    return (
      <Panel title="Benchmark">
        <PanelSkeleton lines={6} label="Loading the benchmark definition" />
      </Panel>
    );

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard/benchmarks"
          className="text-caption uppercase tracking-[0.06em] text-muted-foreground underline underline-offset-4"
        >
          Benchmarks
        </Link>
        <h1 className="mt-3 font-display text-h2">{detail.name}</h1>
        <p className="mt-2 font-mono text-[11px] text-muted-foreground">
          {detail.id}@{detail.version}
        </p>
        <p className="mt-4 max-w-prose text-small leading-relaxed text-muted-foreground">
          {detail.description}
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/dashboard/tests">
              <Play aria-hidden className="size-4" />
              Run a test on this benchmark
            </Link>
          </Button>
        </div>
      </div>

      <Panel
        title="Specification"
        description="Fixed by the definition. Nothing here is resolved from the environment at read time, which is what makes two results from this benchmark comparable."
        source="benchmark"
        sourceKind="fact"
      >
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Environment" value={detail.environmentKey} />
          <Fact label="Objective" value={detail.objectiveKey} />
          <Fact label="Conditions" value={String(detail.scenarios.length)} />
          <Fact label="Seeds" value={detail.seeds.join(', ')} />
          <Fact label="Cases per agent" value={String(detail.caseCount)} />
          <Fact label="Baseline condition" value={detail.baselineScenarioId} />
        </dl>
        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
          Matrix: {detail.scenarios.length} condition(s) × {detail.seeds.length} seed(s) ={' '}
          {detail.caseCount} case(s) per agent, run in condition order then seed order.
        </p>
      </Panel>

      <Panel
        title="Conditions"
        description="Each condition is a scenario pinned to an exact version. The baseline is the condition robustness is measured as a change from."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse text-small">
            <caption className="sr-only">Scenarios this benchmark pins</caption>
            <thead>
              <tr className="border-b border-border text-left">
                <Th>#</Th>
                <Th>Condition</Th>
                <Th>Pinned version</Th>
                <Th>Role</Th>
              </tr>
            </thead>
            <tbody>
              {detail.scenarios.map((scenario, index) => (
                <tr
                  key={`${scenario.id}@${scenario.version}`}
                  className="border-b border-border/60"
                >
                  <Td mono>{String(index + 1).padStart(2, '0')}</Td>
                  <Td mono>{scenarioLabel(scenario.id)}</Td>
                  <Td mono>{scenario.version}</Td>
                  <Td>
                    {scenario.id === detail.baselineScenarioId ? (
                      <StatusChip tone="info">baseline</StatusChip>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">perturbation</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="Robustness"
        description="How this benchmark turns a spread of scores into one figure."
      >
        <p className="max-w-prose text-small leading-relaxed text-muted-foreground">
          Robustness measures how well an agent retains its baseline performance when the
          environment changes. This benchmark computes it as{' '}
          <span className="font-mono text-foreground">{detail.robustnessFormula}</span>: the
          baseline condition is scored, every other condition is scored the same way, and the figure
          is what is retained. It is the benchmark engine's own output — the interface does not
          compute a second one, and where the evidence cannot support a figure the engine returns
          “unavailable” rather than zero.
        </p>
      </Panel>

      <Panel title="Limits" description="What the engine will refuse, before anything runs.">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Largest execution" value={`${detail.limits.maxCases} cases`} />
          <Fact label="Seeds per benchmark" value={String(detail.limits.maxSeeds)} />
          <Fact
            label="Declared overrides"
            value={detail.configuration ? Object.keys(detail.configuration).join(', ') : 'none'}
          />
        </dl>
        <Notice>
          A benchmark case drives a real agent turn loop, so the matrix is bounded deliberately.
          This phase favours reproducibility over throughput: it is better to run a small test that
          can be repeated than a large one that cannot.
        </Notice>
      </Panel>
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

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-caption uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-mono text-small">{value}</dd>
    </div>
  );
}
