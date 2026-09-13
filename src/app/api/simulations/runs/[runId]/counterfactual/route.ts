import 'server-only';

import { NextResponse } from 'next/server';
import { analyzePersistedCounterfactual } from '@/lib/counterfactual/execute';
import { CounterfactualError } from '@/lib/counterfactual/types';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

/**
 * Counterfactual analysis is computed on demand from stored evidence rather than
 * persisted. Nothing about it is state: it creates no run, writes no row, calls
 * no model, and is a pure function of the run's own trace, so recomputing it
 * cannot disagree with a stored copy — while a stored copy could drift from the
 * evidence it was derived from.
 *
 * `?decision=<index>` narrows the answer to one decision point and returns every
 * alternative it had, with the full counterfactual state behind each. The
 * default is the whole-run report.
 */
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  const { runId } = await params;

  const requested = new URL(req.url).searchParams.get('decision');
  let decisionIndex: number | null = null;
  if (requested !== null) {
    // Only a plain, bounded run of digits names a decision point. `Number.parseInt`
    // would read `1.5` and `1abc` as decision 1 and answer for a decision the caller
    // never asked about.
    if (!/^\d{1,9}$/.test(requested))
      return NextResponse.json(
        { error: 'The decision parameter must be a non-negative integer.' },
        { status: 400 },
      );
    decisionIndex = Number.parseInt(requested, 10);
  }

  try {
    const outcome = await analyzePersistedCounterfactual({
      runId,
      ownerId: user.id,
      decisionIndex,
    });
    if (!outcome) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    return NextResponse.json(outcome.kind === 'report' ? outcome.report : outcome.analysis);
  } catch (error) {
    if (error instanceof CounterfactualError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        // A decision index the run does not have is a bad request; a trace that
        // cannot carry an analysis is a conflict with the evidence itself.
        { status: error.code === 'UNKNOWN_DECISION' ? 400 : 409 },
      );
    throw error;
  }
}
