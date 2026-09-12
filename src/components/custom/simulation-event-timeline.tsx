// @polsia:user-owned — persisted event and tool-call timeline.
'use client';

import { CheckCircle2, CircleAlert, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { SimulationEvent, SimulationToolCall } from '@/lib/contracts/simulation';

export function SimulationEventTimeline({
  events,
  toolCalls,
}: {
  events: SimulationEvent[];
  toolCalls: SimulationToolCall[];
}) {
  if (events.length === 0)
    return (
      <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
        No persisted events yet.
      </p>
    );
  return (
    <Card className="shadow-md">
      <CardHeader className="pb-3">
        <CardTitle className="font-display text-h4">Persisted activity</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {events.map((event) => {
            const tool = toolCalls.find(
              (item) => item.toolName === event.payload.toolName && item.step === event.step,
            );
            const failure =
              event.kind.includes('rejected') ||
              event.kind.includes('error') ||
              event.kind.includes('failed');
            return (
              <li key={event.id} className="relative border-l border-border pl-5">
                <span className="absolute -left-2 top-0 flex size-4 items-center justify-center rounded-full bg-background">
                  {failure ? (
                    <CircleAlert className="size-4 text-destructive" />
                  ) : event.kind.startsWith('tool') ? (
                    <Wrench className="size-3.5 text-brand-600" />
                  ) : (
                    <CheckCircle2 className="size-4 text-brand-600" />
                  )}
                </span>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{event.summary}</p>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      #{event.sequence} · step {event.step} · {event.source}
                    </p>
                  </div>
                  <Badge variant={failure ? 'destructive' : 'secondary'}>{event.kind}</Badge>
                </div>
                {tool?.validationReason && (
                  <p className="mt-2 text-xs text-destructive">
                    Validation: {tool.validationReason}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
