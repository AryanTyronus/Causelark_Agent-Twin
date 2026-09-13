// @polsia:user-owned — persisted-record evaluation endpoint.
import 'server-only';

import { NextResponse } from 'next/server';
import { DEFAULT_CONFIGURATION } from '@/lib/business/simulation';
import {
  loadRun,
  toAction,
  toEvent,
  toScenarioIdentity,
  toToolCall,
} from '@/lib/business/simulation-persistence';
import {
  SimulationConfiguration,
  SimulationRunStatus,
  SimulationState,
} from '@/lib/contracts/simulation';
import { evaluateRun } from '@/lib/evaluation/evaluation';
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

  const evaluation = evaluateRun({
    runId: run.id,
    status: SimulationRunStatus.parse(run.status),
    state: SimulationState.parse(run.state),
    initialState: SimulationState.parse(run.initialState ?? run.state),
    actions: run.actions.map(toAction),
    events: run.events.map(toEvent),
    toolCalls: run.toolCalls.map(toToolCall),
    budgetLimit: run.budgetLimit,
    turnCount: run.turnCount,
    maxTurns:
      run.maxTurns ||
      SimulationConfiguration.parse(run.configuration ?? DEFAULT_CONFIGURATION).maxTurns,
    terminationReason: run.terminationReason,
    // Context, not input to a score: it lets a verdict be labelled with the
    // condition it was measured under.
    scenario: toScenarioIdentity(run),
  });

  return NextResponse.json(
    EvaluationEnvelope.parse({ evaluation, inProgress: run.status === 'RUNNING' }),
  );
}
