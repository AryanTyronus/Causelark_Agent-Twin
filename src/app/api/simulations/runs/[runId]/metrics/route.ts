// @polsia:user-owned — persisted-record simulation metrics endpoint.
import 'server-only';

import { NextResponse } from 'next/server';
import { calculateSimulationMetrics } from '@/lib/business/simulation-metrics';
import { loadRun, toAction, toEvent } from '@/lib/business/simulation-persistence';
import { SimulationMetricsEnvelope, SimulationState } from '@/lib/contracts/simulation';
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
  const state = SimulationState.parse(run.state);
  const initialState = SimulationState.parse(run.initialState ?? run.state);
  const metrics = calculateSimulationMetrics({
    status: run.status as
      | 'RUNNING'
      | 'COMPLETED'
      | 'FAILED'
      | 'TIMEOUT'
      | 'LIMIT_REACHED'
      | 'ERROR',
    state,
    initialState,
    budgetLimit: run.budgetLimit,
    actions: run.actions.map(toAction),
    events: run.events.map(toEvent),
    terminationReason: run.terminationReason,
  });
  return NextResponse.json(
    SimulationMetricsEnvelope.parse({ metrics, inProgress: run.status === 'RUNNING' }),
  );
}
