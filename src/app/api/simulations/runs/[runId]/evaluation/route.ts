// @polsia:user-owned — persisted-record evaluation endpoint.
import 'server-only';

import { NextResponse } from 'next/server';
import { evaluatePersistedRun } from '@/lib/business/simulation-evaluation';
import { loadRun } from '@/lib/business/simulation-persistence';
import { EvaluationEnvelope } from '@/lib/evaluation/types';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

// The verdict is computed on demand from stored evidence rather than persisted.
// Evaluation is a pure fold over the run's own trace, so recomputing it cannot
// disagree with a stored copy — while a stored copy could drift from the
// evidence it was derived from.
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

  // One mapping, shared with benchmark execution, so a benchmark case and an
  // operator-opened run are scored from identical inputs.
  const evaluation = evaluatePersistedRun(run);

  return NextResponse.json(
    EvaluationEnvelope.parse({ evaluation, inProgress: run.status === 'RUNNING' }),
  );
}
