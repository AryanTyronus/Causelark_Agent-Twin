//
// A case row is where a comparison stops being a table and becomes a record. The
// details grid states only what the run itself recorded — which agent, which
// provider, which model, which benchmark at which version, which scenario at
// which version, which seed, what status, what the evaluation engine scored, and
// the terminal reason the environment gave.
//
// Everything below the grid is fetched on demand and rendered by the engine that
// produced it: the counterfactual analysis by the counterfactual engine, the
// timeline by the run's own recorded events. Nothing on this screen is written
// by the interface.

'use client';

import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import type { BenchmarkRun } from '@/lib/benchmarks/types';
import type { AgentConfiguration } from '@/lib/comparison/types';
import { CounterfactualPanel } from './counterfactual-panel';
import { formatScore, scenarioLabel } from './format';
import { ReplayTimeline } from './replay-panel';
import { StatusChip } from './ui';

/** The recorded run status, as a word and a tone. Never colour alone. */
function statusTone(status: string): 'ok' | 'warn' | 'bad' | 'info' {
  if (status === 'COMPLETED') return 'ok';
  if (status === 'RUNNING') return 'info';
  return 'bad';
}

export function CaseEvidence({
  agent,
  agentLabel,
  run,
  benchmark,
  objectiveKey,
  defaultOpen = false,
}: {
  agent: AgentConfiguration;
  agentLabel: string;
  run: BenchmarkRun;
  benchmark: { id: string; version: number; name: string };
  /** The objective the experiment fixed, as the report recorded it. */
  objectiveKey: string;
  defaultOpen?: boolean;
}) {
  const evaluation = run.evaluation;
  const objectiveReached = evaluation?.metrics.objectiveReached ?? null;
  return (
    <Accordion
      type="single"
      collapsible
      defaultValue={defaultOpen ? `case-${run.runId}` : undefined}
    >
      <AccordionItem value={`case-${run.runId}`} className="border border-border">
        <AccordionTrigger className="px-4 py-3 hover:no-underline">
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2 text-left">
            <span className="font-mono text-small">
              {scenarioLabel(run.case.scenarioId)}@{run.case.scenarioVersion}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              seed {run.case.seed}
              {run.case.isBaseline ? ' · baseline' : ''}
            </span>
            <StatusChip tone={statusTone(run.status)}>{run.status}</StatusChip>
            {objectiveReached === null ? (
              <span className="font-mono text-[11px] text-muted-foreground">not evaluated</span>
            ) : (
              <span className="font-mono text-[11px]">
                objective {objectiveReached ? 'reached' : 'not reached'}
              </span>
            )}
            <span className="ml-auto font-mono text-small tabular-nums">
              {evaluation ? formatScore(evaluation.overallScore) : 'not scored'}
            </span>
          </span>
        </AccordionTrigger>
        <AccordionContent className="space-y-6 px-4 pb-5">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            <Detail label="Agent" value={`${agent.agentId}@${agent.agentVersion}`} />
            <Detail label="Provider" value={agent.provider} />
            <Detail label="Model" value={agent.model} />
            <Detail label="Report column" value={agentLabel} />
            <Detail label="Benchmark" value={`${benchmark.id}@${benchmark.version}`} />
            <Detail label="Scenario" value={`${run.case.scenarioId}@${run.case.scenarioVersion}`} />
            <Detail label="Seed" value={String(run.case.seed)} />
            <Detail label="Run status" value={run.status} />
            <Detail label="Run outcome" value={run.outcome} />
            <Detail label="Objective" value={objectiveKey} />
            <Detail
              label="Overall score"
              value={evaluation ? formatScore(evaluation.overallScore) : 'not scored'}
            />
            <Detail label="Terminal reason" value={run.terminationReason ?? 'not recorded'} />
          </dl>

          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/dashboard/simulations/${run.runId}`}>
                <ExternalLink aria-hidden className="size-3.5" />
                Open the run inspector
              </Link>
            </Button>
            <span className="self-center font-mono text-[11px] text-muted-foreground">
              run {run.runId}
            </span>
          </div>

          {evaluation ? (
            <div className="rounded-sm border border-border p-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                Evaluation engine verdict
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {evaluation.categories.map((category) => (
                  <div key={category.category}>
                    <p className="text-caption text-muted-foreground">{category.category}</p>
                    <p className="mt-1 font-mono text-small tabular-nums">
                      {formatScore(category.score)}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      weight {category.weight}
                    </p>
                  </div>
                ))}
              </div>
              <ul className="mt-3 space-y-1">
                {evaluation.categories.flatMap((category) =>
                  category.evidence.map((line) => (
                    <li
                      key={`${category.category}-${line}`}
                      className="text-[11px] text-muted-foreground"
                    >
                      <span className="font-mono">{category.category}</span> · {line}
                    </li>
                  )),
                )}
              </ul>
            </div>
          ) : null}

          <CounterfactualPanel runId={run.runId} />
          <ReplayTimeline runId={run.runId} />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-caption uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-mono text-small">{value}</dd>
    </div>
  );
}
