import 'server-only';

import { NextResponse } from 'next/server';
import { loadRun, toDetail } from '@/lib/business/simulation-persistence';
import { SimulationRunDetail } from '@/lib/contracts/simulation';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  try {
    const { runId } = await params;
    const run = await loadRun(runId, user.id);
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    return NextResponse.json(SimulationRunDetail.parse(toDetail(run)));
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
