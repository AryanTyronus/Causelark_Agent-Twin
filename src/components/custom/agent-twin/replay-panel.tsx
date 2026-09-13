// @polsia:user-owned — the recorded timeline of one run.
//
// Replay in this product is not a re-enactment. Every line here is an event the
// environment recorded while the run was happening, read back in sequence from
// `GET /api/simulations/runs/[runId]/events`. The phase names group recorded
// kinds into the loop a reader is being shown — observation, decision, action,
// transition — and the wording of each line is the event's own summary, not a
// paraphrase written here.
//
// Raw payloads are one disclosure away rather than on screen by default, but
// they are never withheld: the point of an evidence view is that a reader can
// get to the record, and a summary nobody can check is not evidence.

'use client';

import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { apiFetch } from '@/lib/api-client';
import {
  type SimulationEvent,
  SimulationEventsEnvelope,
  SimulationRunDetail as SimulationRunDetailSchema,
  type SimulationToolCall,
} from '@/lib/contracts/simulation';
import { BusyLine, EmptyState, ErrorPanel, Panel, StatusChip } from './ui';

/**
 * Which stage of the loop a recorded event belongs to.
 *
 * The mapping is a grouping of the environment's own event kinds, in the order
 * the loop runs. It decides how a line is labelled and where it sits in the
 * timeline; it decides nothing about what the line says.
 */
const EVENT_PHASE: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' }> = {
  'simulation.started': { label: 'Setup', tone: 'info' },
  'scenario.applied': { label: 'Setup', tone: 'info' },
  'observation.created': { label: 'Observation', tone: 'info' },
  'agent.turn.started': { label: 'Agent decision', tone: 'info' },
  'agent.turn.completed': { label: 'Agent decision', tone: 'ok' },
  'tool.requested': { label: 'Tool call', tone: 'info' },
  'tool.result': { label: 'Tool call', tone: 'ok' },
  'action.requested': { label: 'Action', tone: 'info' },
  'action.validated': { label: 'Action', tone: 'ok' },
  'action.rejected': { label: 'Action', tone: 'warn' },
  'state.changed': { label: 'Environment transition', tone: 'info' },
  'task.progressed': { label: 'Environment transition', tone: 'ok' },
  'agent.error': { label: 'Agent fault', tone: 'bad' },
  'simulation.completed': { label: 'Outcome', tone: 'ok' },
  'simulation.failed': { label: 'Outcome', tone: 'bad' },
};

function phaseOf(kind: string) {
  return EVENT_PHASE[kind] ?? { label: 'Recorded', tone: 'info' as const };
}

export function ReplayTimeline({ runId }: { runId: string }) {
  const [events, setEvents] = useState<SimulationEvent[] | null>(null);
  const [toolCalls, setToolCalls] = useState<SimulationToolCall[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // The run detail carries the tool calls and the run's own identity; the
      // events endpoint carries the trace. Both are read once, on open — a
      // replay is a record being read back, not a live view.
      const [envelope, detail] = await Promise.all([
        apiFetch(`/api/simulations/runs/${runId}/events`, { schema: SimulationEventsEnvelope }),
        apiFetch(`/api/simulations/runs/${runId}`, { schema: SimulationRunDetailSchema }),
      ]);
      setEvents(envelope.events);
      setToolCalls(detail.toolCalls);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.includes('(404)')
          ? 'This run is not available to this account, or it no longer exists.'
          : 'The recorded trace for this run could not be read.',
      );
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorPanel title="Replay unavailable" message={error} />;
  if (!events)
    return (
      <Panel title="Replay" description="Reading the recorded trace…">
        <BusyLine label="Loading recorded events" />
      </Panel>
    );
  if (events.length === 0)
    return (
      <Panel title="Replay">
        <EmptyState
          title="No events recorded"
          description="This run produced no persisted events, so there is nothing to replay."
        />
      </Panel>
    );

  return (
    <Panel
      title="Replay"
      description="Every line below is an event the environment recorded during this run, in sequence. The wording is the record's own."
      source="trace"
      sourceKind="fact"
    >
      <ol className="space-y-0">
        {events.map((event, index) => {
          const phase = phaseOf(event.kind);
          const previous = index === 0 ? null : phaseOf(events[index - 1]?.kind ?? '');
          const startsPhase = previous === null || previous.label !== phase.label;
          return (
            <li key={event.id} className="relative flex gap-4 pb-5 last:pb-0">
              <div className="flex w-4 shrink-0 flex-col items-center" aria-hidden>
                <span className="mt-1.5 size-2 shrink-0 rounded-full border border-border bg-background" />
                <span className="mt-1 w-px flex-1 bg-border" />
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                {startsPhase ? (
                  <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                    {phase.label}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-small leading-relaxed">{event.summary}</p>
                  <StatusChip tone={phase.tone}>{event.kind}</StatusChip>
                </div>
                <p className="font-mono text-[11px] text-muted-foreground">
                  #{event.sequence} · step {event.step} · recorded by {event.source}
                </p>
                {Object.keys(event.payload).length > 0 ? (
                  <Accordion type="single" collapsible>
                    <AccordionItem value={event.id} className="border-b-0">
                      <AccordionTrigger className="py-1 text-[11px] text-muted-foreground hover:no-underline">
                        <span className="inline-flex items-center gap-1">
                          <ChevronRight aria-hidden className="size-3" />
                          Recorded payload
                        </span>
                      </AccordionTrigger>
                      <AccordionContent>
                        <pre className="overflow-x-auto rounded-sm border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                          {JSON.stringify(event.payload, null, 2)}
                        </pre>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {toolCalls.length > 0 ? (
        <p className="mt-4 text-caption text-muted-foreground">
          {toolCalls.length} tool call(s) are recorded against this run.
        </p>
      ) : null}
    </Panel>
  );
}
