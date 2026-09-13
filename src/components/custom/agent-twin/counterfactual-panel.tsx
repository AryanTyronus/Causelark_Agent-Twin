//
// "Why did this happen?" is answered by the counterfactual engine, and by
// nothing else. Every number, every verdict word and every sentence in this
// panel arrives from `GET /api/simulations/runs/[runId]/counterfactual`; the
// panel chooses what to put beside what, and writes nothing of its own. There is
// deliberately no model call here: an explanation generated on the client would
// be an interpretation dressed as a finding.
//
// The engine states which assumptions a result holds under, so the panel shows
// the policies it was computed with. A counterfactual without its assumptions is
// not a finding, and a reader is entitled to see what was held equal.
//
// Where a run has recorded decisions, the panel opens on the whole-run report and
// lets a reader descend into one decision point. That second read is a separate
// request — `?decision=<index>` — because the engine answers it with the full
// alternative list and each alternative's own evaluation, which is more than a
// whole-run report can carry for every decision.

'use client';

import { ArrowLeft, GitCompareArrows } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api-client';
import {
  CounterfactualDecisionAnalysis,
  type CounterfactualReport,
  CounterfactualReport as CounterfactualReportSchema,
} from '@/lib/counterfactual/types';
import { formatDelta, formatScore, scenarioLabel } from './format';
import { BusyLine, EmptyState, ErrorPanel, Fact, Notice, Panel, SourceChip } from './ui';

/**
 * The action, as the contract records it. One line, no interpretation.
 */
function actionText(action: { type: string; resource?: string | undefined; amount: number }) {
  return action.resource
    ? `${action.type} ${action.resource} ${action.amount}`
    : `${action.type} ${action.amount}`;
}

export function CounterfactualPanel({ runId }: { runId: string }) {
  const [report, setReport] = useState<CounterfactualReport | null>(null);
  const [analysis, setAnalysis] = useState<CounterfactualDecisionAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (index: number | null) => {
      setLoading(true);
      try {
        // The two shapes are different answers, so they are two different
        // requests rather than one response read two ways: a whole-run report
        // and one decision's full alternative list carry different evidence.
        const path = `/api/simulations/runs/${runId}/counterfactual`;
        if (index === null) {
          setReport(await apiFetch(path, { schema: CounterfactualReportSchema }));
          setAnalysis(null);
        } else {
          setAnalysis(
            await apiFetch(`${path}?decision=${index}`, { schema: CounterfactualDecisionAnalysis }),
          );
        }
        setError(null);
      } catch (cause) {
        // The endpoint distinguishes a decision index the run does not have (400)
        // from a trace that cannot carry an analysis at all (409). Both are
        // stated in the operator's terms; neither surfaces the raw response.
        const status = cause instanceof Error ? cause.message : '';
        setError(
          status.includes('(409)')
            ? 'This run’s recorded trace cannot support a counterfactual analysis. Analysis needs at least one recorded action attempt to reason about.'
            : status.includes('(404)')
              ? 'This run is not available to this account, or it no longer exists.'
              : status.includes('(400)')
                ? 'That decision point is not recorded against this run.'
                : 'The counterfactual analysis could not be computed for this run.',
        );
      } finally {
        setLoading(false);
      }
    },
    [runId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  if (loading)
    return (
      <Panel
        title="Counterfactual analysis"
        description="Re-running the recorded decisions against the environment’s own transition function."
        source="counterfactual"
      >
        <BusyLine label="Computing alternatives" />
      </Panel>
    );
  if (error)
    return (
      <ErrorPanel
        title="Counterfactual analysis unavailable"
        message={error}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => void load(null)}>
            Try again
          </Button>
        }
      />
    );
  if (analysis) return <DecisionAnalysisView analysis={analysis} onBack={() => void load(null)} />;
  if (!report) return null;
  return <ReportView report={report} onOpenDecision={(index) => void load(index)} />;
}

/**
 * The whole run: what it scored, which decisions mattered, and what each one
 * gave up against the best alternative it had.
 */
function ReportView({
  report,
  onOpenDecision,
}: {
  report: CounterfactualReport;
  onOpenDecision: (index: number) => void;
}) {
  const critical = report.causal.criticalDecision;
  return (
    <Panel
      title="Counterfactual analysis"
      description={
        <>
          What the recorded run scored, and what the environment would have done had the agent
          chosen differently at each decision point it faced. Computed from the run’s own trace and
          the environment’s deterministic transition function.
          {report.run.scenario
            ? ` Recorded under the ${scenarioLabel(report.run.scenario.id)} condition.`
            : ''}
        </>
      }
      source="counterfactual"
    >
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <Fact label="Recorded overall score" value={formatScore(report.baseline.overallScore)} />
          <Fact label="Decision points analysed" value={report.summary.decisionPoints} />
          <Fact
            label="Decisions with a better alternative"
            value={report.summary.improvingDecisions}
            hint="Under the stated continuation policy."
          />
          <Fact
            label="Highest regret"
            value={formatScore(report.summary.maxRegret)}
            hint="The most the recorded choice gave up, at one decision point."
          />
          <Fact label="Mean regret" value={formatScore(report.summary.meanRegret)} />
          <Fact
            label="Decisions that flipped the outcome"
            value={report.summary.outcomeFlipDecisions}
            hint="Alternatives that end the run in a different terminal status."
          />
        </div>

        <Notice>
          <span className="font-medium text-foreground">Stated under these policies. </span>
          The action space was <span className="font-mono">{report.policies.actionSpace}</span>
          {'. '}
          What happens after the intervention was{' '}
          <span className="font-mono">{report.policies.continuation}</span>
          {'. '}
          What was held equal was <span className="font-mono">{report.policies.comparison}</span>
          {'. '}A counterfactual is only meaningful relative to its assumptions.
        </Notice>

        {critical ? (
          <div className="rounded-sm border border-border bg-muted/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-display text-small uppercase tracking-[0.06em]">
                Decision ranked first by regret
              </p>
              <SourceChip source="counterfactual" />
            </div>
            <p className="mt-3 text-small leading-relaxed">{critical.statement}</p>
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">
              step {critical.step} · {critical.source} · recorded {actionText(critical.action)} ·
              scored {formatScore(critical.recordedOverall)}
              {critical.bestAlternativeOverall === null
                ? ''
                : ` · best alternative ${formatScore(critical.bestAlternativeOverall)}`}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => onOpenDecision(critical.index)}
            >
              <GitCompareArrows aria-hidden className="size-3.5" />
              Analyze this decision
            </Button>
          </div>
        ) : null}

        {report.decisions.length === 0 ? (
          <EmptyState
            title="No decision points recorded"
            description="This run recorded no action attempts, so there is no decision for the engine to reason about."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Step</TableHead>
                  <TableHead>Recorded decision</TableHead>
                  <TableHead className="w-24">Accepted</TableHead>
                  <TableHead className="w-24 text-right">Regret</TableHead>
                  <TableHead className="w-24 text-right">Flips</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.decisions.map((decision) => (
                  <TableRow key={decision.actionId}>
                    <TableCell className="font-mono text-small">{decision.step}</TableCell>
                    <TableCell>
                      <p className="font-mono text-small">{actionText(decision.action)}</p>
                      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                        {decision.actual.accepted
                          ? decision.actual.observation
                          : `Refused: ${decision.actual.rejectionReason ?? 'no reason recorded'}`}
                      </p>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-small">
                        {decision.actual.accepted ? 'yes' : 'no'}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-small tabular-nums">
                      {formatScore(decision.regret)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-small tabular-nums">
                      {decision.outcomeFlips.count}
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => onOpenDecision(decision.index)}
                      >
                        Analyze
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </Panel>
  );
}

/** One decision point: the actual choice against every alternative it had. */
function DecisionAnalysisView({
  analysis,
  onBack,
}: {
  analysis: CounterfactualDecisionAnalysis;
  onBack: () => void;
}) {
  const best = analysis.decision.best;
  return (
    <Panel
      title="Counterfactual analysis"
      description={`Every action the environment would have accepted at this decision point, carried through the environment and scored by the evaluation engine. Recorded overall score: ${formatScore(analysis.baseline.overallScore)}.`}
      source="counterfactual"
      action={
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden className="size-3.5" />
          Whole run
        </Button>
      }
    >
      <div className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="rounded-sm border border-border p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              Actual decision
            </p>
            <p className="mt-2 font-mono text-small">{actionText(analysis.decision.action)}</p>
            <p className="mt-2 text-small leading-relaxed">
              {analysis.decision.actual.accepted
                ? analysis.decision.actual.observation
                : `Refused by the environment: ${analysis.decision.actual.rejectionReason ?? 'no reason recorded'}`}
            </p>
            <p className="mt-3 font-mono text-[11px] text-muted-foreground">
              step {analysis.decision.step} · recorded by {analysis.decision.source}
            </p>
          </div>
          <div className="rounded-sm border border-border p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              What the engine found
            </p>
            <p className="mt-2 text-small leading-relaxed">{analysis.decision.statement}</p>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Fact label="Analysed" value={analysis.decision.alternatives.analysed} />
              <Fact label="Improving" value={analysis.decision.alternatives.improving} />
              <Fact label="Equivalent" value={analysis.decision.alternatives.equivalent} />
              <Fact label="Worsening" value={analysis.decision.alternatives.worsening} />
            </div>
            {best ? (
              <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                best alternative {actionText(best.action)} · overall{' '}
                {formatScore(best.outcome.overallScore)} · delta {formatDelta(best.delta.overall)}
              </p>
            ) : null}
          </div>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Alternative action</TableHead>
                <TableHead className="w-24 text-right">Overall</TableHead>
                <TableHead className="w-24 text-right">Delta</TableHead>
                <TableHead className="w-28">Outcome</TableHead>
                <TableHead className="w-32">Continuation</TableHead>
                <TableHead>Environment response</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analysis.alternatives.map((alternative) => (
                <TableRow key={alternative.key}>
                  <TableCell className="font-mono text-small">
                    {actionText(alternative.action)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-small tabular-nums">
                    {formatScore(alternative.outcome.overallScore)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-small tabular-nums">
                    {formatDelta(alternative.delta.overall)}
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-small">
                      {alternative.flipsOutcome ? 'flips' : 'unchanged'}
                    </span>
                    <span className="ml-1 text-[11px] text-muted-foreground">
                      {alternative.continuation.terminalStatus}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {alternative.continuation.replayed} replayed ·{' '}
                    {alternative.continuation.accepted} accepted
                    {alternative.continuation.terminatedEarly ? ' · ended early' : ''}
                  </TableCell>
                  <TableCell className="text-small leading-snug text-muted-foreground">
                    {alternative.observation}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {analysis.rejectedAlternatives.length > 0 ? (
          <p className="text-caption text-muted-foreground">
            {analysis.rejectedAlternatives.length} further action(s) were considered and refused by
            the environment’s own validator, so they were not carried through:{' '}
            {analysis.rejectedAlternatives
              .slice(0, 6)
              .map((entry) => `${actionText(entry.action)} (${entry.code})`)
              .join(', ')}
            {analysis.rejectedAlternatives.length > 6 ? ', …' : ''}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
