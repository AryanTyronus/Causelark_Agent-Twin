// @polsia:user-owned — Agent Twin presentation primitives.
//
// The product's claim is that a result is evidence, so the UI has to be able to
// say where a number came from. These are the small, shared pieces that do that:
// a panel with a stated provenance, a fact row, a comparison bar that always
// carries its number as text, and states for the three things every
// network-backed view can be — loading, empty, or failed.
//
// Two rules hold across all of them.
//
// Status is never communicated by colour alone: every tone is accompanied by the
// word for it, and every bar carries its value as text. A reader who cannot
// distinguish the accent from the background still gets the whole answer.
//
// A missing number is not zero. `Fact` renders `null` as an explicit "not
// recorded" rather than a dash that reads as a nought, because the evaluation
// engine reports `null` for "not derivable from this evidence" and collapsing
// that into a score would invent a measurement.

'use client';

import { AlertTriangle, Inbox, Loader2, Minus } from 'lucide-react';
import type * as React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** Where a claim in the interface came from. Rendered beside the claim itself. */
export type EvidenceSource =
  | 'evaluation'
  | 'benchmark'
  | 'trace'
  | 'counterfactual'
  | 'configuration'
  | 'request';

const SOURCE_LABELS: Record<EvidenceSource, string> = {
  evaluation: 'Evaluation engine',
  benchmark: 'Benchmark engine',
  trace: 'Recorded trace',
  counterfactual: 'Counterfactual engine',
  configuration: 'Deployment configuration',
  request: 'This test',
};

/**
 * The provenance chip.
 *
 * A statement in this product is one of two things — something the environment
 * recorded, or something a defined rule derived from that record — and a reader
 * is entitled to know which. The chip states the engine that produced the claim
 * so no number has to be taken on the interface's word.
 */
export function SourceChip({
  source,
  kind = 'derived',
  className,
}: {
  source: EvidenceSource;
  /** `fact` for something a record states; `derived` for a rule's conclusion. */
  kind?: 'fact' | 'derived';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground',
        className,
      )}
    >
      <span aria-hidden className="font-mono">
        {kind === 'fact' ? '■' : '□'}
      </span>
      {SOURCE_LABELS[source]}
    </span>
  );
}

/**
 * A titled section of the interface, with an optional provenance and a slot for
 * a control.
 *
 * Deliberately flat: a border, a heading, and content. The product is an
 * instrument panel, and a panel that competes with its own readings is a panel
 * that hides them.
 */
export function Panel({
  title,
  description,
  source,
  sourceKind,
  action,
  children,
  className,
  contentClassName,
  id,
}: {
  title: string;
  description?: React.ReactNode;
  source?: EvidenceSource;
  sourceKind?: 'fact' | 'derived';
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  id?: string;
}) {
  return (
    <Card className={cn('shadow-none', className)} id={id}>
      <CardHeader className="gap-2 border-b border-border pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <CardTitle className="font-display text-h4">{title}</CardTitle>
            {description ? (
              <CardDescription className="text-small leading-relaxed">
                {description}
              </CardDescription>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {action}
            {source ? <SourceChip source={source} kind={sourceKind} /> : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className={cn('pt-5', contentClassName)}>{children}</CardContent>
    </Card>
  );
}

/**
 * One labelled reading.
 *
 * `null` is rendered as an explicit absence, never as zero. The evaluation and
 * benchmark engines both use `null` to mean "this evidence cannot support a
 * value", and a UI that printed `0` there would be reporting a measurement
 * nobody made.
 */
export function Fact({
  label,
  value,
  hint,
  mono = true,
  className,
}: {
  label: string;
  value: string | number | null | undefined;
  hint?: string;
  mono?: boolean;
  className?: string;
}) {
  const absent = value === null || value === undefined || value === '';
  return (
    <div className={cn('rounded-sm border border-border bg-card p-3', className)}>
      <p className="text-caption uppercase tracking-[0.06em] text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1.5 break-words text-small',
          mono && !absent && 'font-mono',
          absent && 'text-muted-foreground italic',
        )}
      >
        {absent ? 'not recorded' : value}
      </p>
      {hint ? <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * A horizontal reading against a known ceiling.
 *
 * The bar is decoration; the number is the reading. It is always rendered as
 * text beside the bar, so the value survives a monochrome display, a screen
 * reader, and a very narrow column.
 */
export function ScoreBar({
  value,
  max = 100,
  label,
  detail,
  tone = 'neutral',
  className,
}: {
  value: number | null;
  max?: number;
  label: string;
  detail?: string;
  tone?: 'neutral' | 'positive' | 'negative';
  className?: string;
}) {
  if (value === null)
    return (
      <div className={cn('space-y-1.5', className)}>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-small">{label}</span>
          <span className="font-mono text-small text-muted-foreground">not recorded</span>
        </div>
        <div className="h-1.5 w-full rounded-sm border border-dashed border-border" aria-hidden />
      </div>
    );
  const ratio = max === 0 ? 0 : Math.max(0, Math.min(1, value / max));
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-small">{label}</span>
        <span className="font-mono text-small tabular-nums">
          {detail ?? `${Math.round(value * 100) / 100}`}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-sm bg-muted"
        role="img"
        aria-label={`${label}: ${value} of ${max}`}
      >
        <div
          className={cn(
            'h-full',
            tone === 'positive'
              ? 'bg-brand-600'
              : tone === 'negative'
                ? 'bg-destructive'
                : 'bg-foreground/60',
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

/**
 * A measured proportion, for progress that has a real numerator and denominator.
 *
 * Used only where those two numbers are recorded facts — a case count from the
 * persisted run list, never an estimate of how far along something "probably" is.
 */
export function ProgressReading({
  completed,
  total,
  label,
  className,
}: {
  completed: number;
  total: number;
  label: string;
  className?: string;
}) {
  const bounded = Math.max(0, Math.min(total, completed));
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-small">{label}</span>
        <span className="shrink-0 font-mono text-small tabular-nums">
          {bounded} / {total}
        </span>
      </div>
      <Progress
        value={total === 0 ? 0 : (bounded / total) * 100}
        className="h-1.5 rounded-sm"
        aria-label={`${label}: ${bounded} of ${total} cases recorded`}
      />
    </div>
  );
}

/**
 * Nothing here yet — and a way out of it.
 *
 * An empty page is a state, not a failure, so it is stated plainly with the
 * action that fills it rather than left as a blank region a reader has to
 * interpret.
 */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-sm border border-dashed border-border px-6 py-12 text-center',
        className,
      )}
    >
      <Inbox aria-hidden className="size-5 text-muted-foreground" />
      <p className="font-display text-small uppercase tracking-[0.08em]">{title}</p>
      <p className="max-w-prose text-small text-muted-foreground">{description}</p>
      {action}
    </div>
  );
}

/**
 * Something failed, stated in the operator's terms.
 *
 * The message is always a sentence about what could not be shown and what to do
 * next. Provider and validation failures reach this component as the safe text
 * the server produced; a stack trace, a credential and a provider payload never
 * do, because none of them is ever put in a response.
 */
export function ErrorPanel({
  title = 'This view could not be loaded',
  message,
  action,
  className,
}: {
  title?: string;
  message: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col gap-3 rounded-sm border border-destructive/40 bg-destructive/5 p-5',
        className,
      )}
    >
      <div className="flex items-center gap-2 text-destructive">
        <AlertTriangle aria-hidden className="size-4 shrink-0" />
        <p className="font-display text-small uppercase tracking-[0.06em]">{title}</p>
      </div>
      <p className="text-small leading-relaxed text-foreground">{message}</p>
      {action ? <div className="flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

/** A single line of placeholder text, sized like the content it replaces. */
export function SkeletonLine({ className }: { className?: string }) {
  return <Skeleton className={cn('h-4 w-full', className)} />;
}

/**
 * A table-shaped placeholder.
 *
 * Shaped like the table it stands in for, so the layout does not jump when the
 * data arrives — which is the whole reason for a skeleton rather than a spinner.
 */
export function TableSkeleton({
  rows = 6,
  columns = 4,
  label = 'Loading table',
}: {
  rows?: number;
  columns?: number;
  label?: string;
}) {
  const columnKeys = Array.from({ length: columns }, (_, index) => `column-${index}`);
  const rowKeys = Array.from({ length: rows }, (_, index) => `row-${index}`);
  return (
    <output className="block space-y-2" aria-label={label}>
      <div className="flex gap-3">
        {columnKeys.map((key) => (
          <Skeleton key={key} className="h-3 flex-1" />
        ))}
      </div>
      {rowKeys.map((rowKey) => (
        <div key={rowKey} className="flex gap-3">
          {columnKeys.map((key) => (
            <Skeleton key={`${rowKey}-${key}`} className="h-8 flex-1" />
          ))}
        </div>
      ))}
      <span className="sr-only">{label}…</span>
    </output>
  );
}

/** A panel-shaped placeholder, for a view whose shape is not a table. */
export function PanelSkeleton({
  lines = 3,
  label = 'Loading',
}: {
  lines?: number;
  label?: string;
}) {
  const lineKeys = Array.from({ length: lines }, (_, index) => `line-${index}`);
  return (
    <output className="block space-y-3" aria-label={label}>
      <Skeleton className="h-5 w-48" />
      {lineKeys.map((key) => (
        <Skeleton key={key} className="h-4 w-full" />
      ))}
      <span className="sr-only">{label}…</span>
    </output>
  );
}

/** A bordered inline notice — a stated condition, not an error. */
export function Notice({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: React.HTMLAttributes<HTMLDivElement>['className'];
}) {
  return (
    <div
      className={cn(
        'rounded-sm border border-border bg-muted/30 px-4 py-3 text-small leading-relaxed text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A busy indicator with words, for a wait with no measurable progress. */
export function BusyLine({ label }: { label: string }) {
  return (
    <output className="flex items-center gap-2 text-small text-muted-foreground">
      <Loader2 aria-hidden className="size-3.5 animate-spin" />
      {label}
    </output>
  );
}

/** A tone-carrying word. Never a bare coloured dot. */
export function StatusChip({
  tone,
  children,
  className,
}: {
  tone: 'ok' | 'warn' | 'bad' | 'idle' | 'info';
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.04em]',
        tone === 'ok' && 'border-brand-600/40 bg-brand-50 text-brand-700 dark:bg-brand-900/20',
        tone === 'warn' &&
          'border-amber-600/40 bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300',
        tone === 'bad' && 'border-destructive/40 bg-destructive/5 text-destructive',
        tone === 'info' && 'border-border bg-muted/40 text-foreground',
        tone === 'idle' && 'border-border bg-transparent text-muted-foreground',
        className,
      )}
    >
      <span aria-hidden>
        {tone === 'ok' ? '●' : tone === 'bad' ? '▲' : tone === 'warn' ? '◆' : '○'}
      </span>
      {children}
    </span>
  );
}

/** A reading the evidence does not support, said so rather than left blank. */
export function NotRecorded({ what }: { what: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-small text-muted-foreground italic">
      <Minus aria-hidden className="size-3" />
      {what} not recorded
    </span>
  );
}
