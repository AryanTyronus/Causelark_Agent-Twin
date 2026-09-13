import 'server-only';

import { NextResponse } from 'next/server';
import { loadRun, toAction, toEvent } from '@/lib/business/simulation-persistence';
import { buildSimulationReplay } from '@/lib/business/simulation-replay';
import { SimulationReplay, SimulationState } from '@/lib/contracts/simulation';
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
  const frame = Number(new URL(req.url).searchParams.get('frame') ?? 0);
  const replay = buildSimulationReplay({
    initialState: SimulationState.parse(run.initialState ?? run.state),
    actions: run.actions.map(toAction),
    events: run.events.map(toEvent),
    selectedFrame: Number.isFinite(frame) ? frame : undefined,
  });
  return NextResponse.json(SimulationReplay.parse(replay));
}
