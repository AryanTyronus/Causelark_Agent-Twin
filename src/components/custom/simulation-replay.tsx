// @polsia:user-owned — replay controls driven by persisted replay frames.
'use client';

import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';
import {
  SimulationReplay as SimulationReplaySchema,
  type SimulationReplay as SimulationReplayType,
} from '@/lib/contracts/simulation';

export function SimulationReplay({ runId }: { runId: string }) {
  const [replay, setReplay] = useState<SimulationReplayType | null>(null);
  const [selected, setSelected] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch(`/api/simulations/runs/${runId}/replay`, { schema: SimulationReplaySchema })
      .then((value) => {
        setReplay(SimulationReplaySchema.parse(value));
        setSelected(value.selectedFrame);
      })
      .catch(() => setError('Replay history is unavailable.'));
  }, [runId]);
  useEffect(() => {
    if (!playing || !replay) return;
    const timer = window.setTimeout(() => {
      if (selected >= replay.frames.length - 1) setPlaying(false);
      else setSelected((current) => current + 1);
    }, 850);
    return () => window.clearTimeout(timer);
  }, [playing, replay, selected]);
  if (error)
    return (
      <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
        {error}
      </p>
    );
  if (!replay)
    return (
      <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
        Loading persisted replay…
      </p>
    );
  const frame = replay.frames[selected] ?? replay.frames[0];
  if (!frame)
    return (
      <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
        No replay frames recorded.
      </p>
    );
  return (
    <Card className="shadow-md">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="font-display text-h4">Replay</CardTitle>
          <Badge variant="secondary">
            frame {frame.index + 1} / {replay.frames.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setSelected(0)}>
            <SkipBack className="size-4" />
            Start
          </Button>
          <Button type="button" size="sm" onClick={() => setPlaying((value) => !value)}>
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            {playing ? 'Pause' : 'Play'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setSelected((value) => Math.min(value + 1, replay.frames.length - 1))}
          >
            <SkipForward className="size-4" />
            Step
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              const next = replay.importantFrameIndexes.find((index) => index > selected);
              setSelected(next ?? selected);
            }}
          >
            Next important
          </Button>
        </div>
        <div className="rounded-lg border border-brand-200/70 bg-brand-50/30 p-4 dark:border-brand-900/50 dark:bg-brand-950/20">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-medium">{frame.label}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                step {frame.step} · {frame.important ? 'important event' : 'state transition'}
              </p>
            </div>
            <span className="font-mono text-sm">
              {frame.state.progress} / {frame.state.target}
            </span>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {Object.entries(frame.state.resources).map(([name, value]) => (
              <div key={name} className="rounded border border-border bg-card px-3 py-2 text-xs">
                <span className="text-muted-foreground">{name}</span>
                <span className="float-right font-mono">{value}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="text-eyebrow">State changes</p>
          {frame.diffs.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No changes in the initial frame.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {frame.diffs.map((diff) => (
                <li key={diff.field} className="font-mono text-xs text-muted-foreground">
                  {diff.field}: {JSON.stringify(diff.before)} → {JSON.stringify(diff.after)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
