// @polsia:user-owned — authenticated, one-turn Agent Twin endpoint.
import 'server-only';

import { NextResponse } from 'next/server';
import { runTurn, TurnConflictError } from '@/lib/agent/run-turn';
import { SimulationAgentStepResult } from '@/lib/contracts/simulation';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  try {
    const { runId } = await params;
    const result = await runTurn(runId, user.id);
    return NextResponse.json(SimulationAgentStepResult.parse(result));
  } catch (error) {
    if (error instanceof TurnConflictError)
      return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: 'Agent turn could not be started.' }, { status: 500 });
  }
}
