'use client';

import { ExternalLink, RefreshCw, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SimulationEventTimeline } from '@/components/custom/simulation-event-timeline';
import { SimulationReplay } from '@/components/custom/simulation-replay';
import { SimulationStatePanel } from '@/components/custom/simulation-state-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';
import {
  SimulationAgentStepResult,
  type SimulationEvent,
  SimulationEventsEnvelope,
  type SimulationMetrics,
  SimulationMetricsEnvelope,
  SimulationReplay as SimulationReplaySchema,
  type SimulationReplay as SimulationReplayType,
  type SimulationRunDetail,
  SimulationRunDetail as SimulationRunDetailSchema,
} from '@/lib/contracts/simulation';

export function AgentTwinRunView({ runId }: { runId: string }) {
  const [run, setRun] = useState<SimulationRunDetail | null>(null);
  const [events, setEvents] = useState<SimulationEvent[]>([]);
  const [metrics, setMetrics] = useState<SimulationMetrics | null>(null);
  const [replay, setReplay] = useState<SimulationReplayType | null>(null);
  const [loading, setLoading] = useState(true);
  const [advancing, setAdvancing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextRun, nextEvents, nextMetrics, nextReplay] = await Promise.all([
        apiFetch(`/api/simulations/runs/${runId}`, { schema: SimulationRunDetailSchema }),
        apiFetch(`/api/simulations/runs/${runId}/events`, { schema: SimulationEventsEnvelope }),
        apiFetch(`/api/simulations/runs/${runId}/metrics`, { schema: SimulationMetricsEnvelope }),
        apiFetch(`/api/simulations/runs/${runId}/replay`, { schema: SimulationReplaySchema }),
      ]);
      setRun(SimulationRunDetailSchema.parse(nextRun));
      setEvents(nextEvents.events);
      setMetrics(nextMetrics.metrics);
      setReplay(SimulationReplaySchema.parse(nextReplay));
      setError(null);
    } catch {
      setError('The persisted Agent Twin snapshot could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!run || run.status !== 'RUNNING') return;
    const timer = window.setTimeout(() => {
      void refresh();
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [refresh, run]);

  async function advance() {
    if (!run || run.status !== 'RUNNING') return;
    setAdvancing(true);
    try {
      const result = await apiFetch(`/api/simulations/runs/${run.id}/agent-step`, {
        method: 'POST',
        body: '{}',
        schema: SimulationAgentStepResult,
      });
      setRun(SimulationRunDetailSchema.parse(result.run));
      toast(
        result.turn.safeError ??
          `Agent turn recorded ${result.turn.acceptedActions} validated action(s).`,
      );
      await refresh();
    } catch {
      toast.error('Agent turn could not be completed; persisted recovery state is shown below.');
      await refresh();
    } finally {
      setAdvancing(false);
    }
  }

  if (loading)
    return (
      <p className="rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
        Loading persisted Agent Twin state…
      </p>
    );
  if (error || !run)
    return (
      <div className="space-y-4">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          {error ?? 'Run not found.'}
        </p>
        <Button asChild variant="outline">
          <Link href="/dashboard/simulations">Back to simulation lab</Link>
        </Button>
      </div>
    );
  const state = run.state;
  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-eyebrow">Agent Twin inspector</p>
          <h1 className="mt-2 font-display text-h1">{run.objectiveKey.replaceAll('-', ' ')}</h1>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            run {run.id} · seed {run.seed} · {run.configuration.maxTurns} turn limit
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge
            variant={
              run.status === 'COMPLETED'
                ? 'default'
                : run.status === 'RUNNING'
                  ? 'secondary'
                  : 'destructive'
            }
          >
            {run.status}
          </Badge>
          <Badge variant="outline">{run.agentStatus}</Badge>
          <Button type="button" onClick={advance} disabled={advancing || run.status !== 'RUNNING'}>
            <Sparkles className="size-4" />
            {advancing ? 'Running turn…' : 'Run one agent turn'}
          </Button>
          <Button type="button" variant="outline" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        </div>
      </div>
      <Card className="border-brand-200/70 bg-gradient-to-br from-brand-50/70 via-card to-background shadow-lg dark:border-brand-900/50 dark:from-brand-950/30">
        <CardHeader>
          <CardTitle className="font-display text-h3">
            Objective, observation, and provider boundary
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div>
            <p className="text-eyebrow">Environment</p>
            <p className="mt-2 font-medium">{run.environmentKey}</p>
          </div>
          <div>
            <p className="text-eyebrow">Objective progress</p>
            <p className="mt-2 font-mono text-lg">
              {state.progress} / {state.target}
            </p>
          </div>
          <div>
            <p className="text-eyebrow">Current observation</p>
            <p className="mt-2 text-sm text-muted-foreground">{state.lastObservation}</p>
          </div>
        </CardContent>
      </Card>
      <SimulationStatePanel run={run} state={state} />
      <div className="grid gap-6 xl:grid-cols-2">
        <SimulationEventTimeline events={events} toolCalls={run.toolCalls} />
        <Card className="shadow-md">
          <CardHeader>
            <CardTitle className="font-display text-h4">Run metrics</CardTitle>
          </CardHeader>
          <CardContent>
            {metrics ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ['Outcome', metrics.outcome],
                  ['Task success', metrics.taskSuccess ? 'yes' : 'not yet'],
                  ['Steps', String(metrics.steps)],
                  ['Valid actions', String(metrics.successfulActions)],
                  ['Rejected actions', String(metrics.rejectedActions)],
                  ['Invalid rate', `${Math.round(metrics.invalidActionRate * 100)}%`],
                  ['Budget used', `${metrics.budgetUsed} / ${metrics.budgetLimit}`],
                  ['Provider failures', String(metrics.failures.length)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="mt-1 font-mono text-sm">{value}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Metrics are recalculating from persisted records…
              </p>
            )}
          </CardContent>
        </Card>
      </div>
      <SimulationReplay runId={runId} />
      <div className="flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <Link href="/dashboard/simulations">
            <ExternalLink className="size-4" />
            Return to lab
          </Link>
        </Button>
        {replay && (
          <span className="self-center text-xs text-muted-foreground">
            Replay contains {replay.frames.length} persisted frame(s); provider decisions remain
            labelled variable on rerun.
          </span>
        )}
      </div>
    </div>
  );
}
