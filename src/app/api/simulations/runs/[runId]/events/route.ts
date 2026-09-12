// @polsia:user-owned — ordered persisted simulation timeline.
import 'server-only';

import { NextResponse } from 'next/server';
import { loadRun } from '@/lib/business/simulation-persistence';
import { SimulationEventsEnvelope } from '@/lib/contracts/simulation';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  const { runId } = await params;
  const run = await loadRun(runId, user.id);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  const cursorValue = Number(new URL(req.url).searchParams.get('after') ?? 0);
  const cursor = Number.isFinite(cursorValue) && cursorValue >= 0 ? Math.floor(cursorValue) : 0;
  const events = run.events
    .filter((event) => event.sequence > cursor)
    .map((event) => ({
      id: event.id,
      sequence: event.sequence,
      step: event.step,
      kind: event.kind,
      source: event.source,
      summary: event.summary,
      payload: event.payload,
      createdAt: event.createdAt.toISOString(),
    }));
  return NextResponse.json(
    SimulationEventsEnvelope.parse({ events, nextCursor: events.at(-1)?.sequence ?? cursor }),
  );
}
