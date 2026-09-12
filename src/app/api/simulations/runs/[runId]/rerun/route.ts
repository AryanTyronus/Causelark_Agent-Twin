// @polsia:user-owned — same-configuration, same-seed environment rerun endpoint.
import 'server-only';

import { NextResponse } from 'next/server';
import { createInitialSimulationState, DEFAULT_CONFIGURATION } from '@/lib/business/simulation';
import { jsonValue, loadRun, toDetail } from '@/lib/business/simulation-persistence';
import {
  SimulationConfiguration,
  SimulationRerunResult,
  SimulationState,
} from '@/lib/contracts/simulation';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  const { runId } = await params;
  const original = await loadRun(runId, user.id);
  if (!original) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  const configuration = SimulationConfiguration.parse(
    original.configuration ?? DEFAULT_CONFIGURATION,
  );
  const state = createInitialSimulationState(
    original.environmentKey as 'resource-routing',
    original.objectiveKey as 'complete-delivery' | 'preserve-reserve' | 'stabilise-grid',
    original.seed,
    configuration,
  );
  const created = await prisma.$transaction(async (tx) => {
    const run = await tx.simulationRun.create({
      data: {
        ownerId: user.id,
        environmentKey: original.environmentKey,
        objectiveKey: original.objectiveKey,
        seed: original.seed,
        status: 'RUNNING',
        agentStatus: 'READY',
        step: 0,
        state: jsonValue(state),
        initialState: jsonValue(state),
        configuration: jsonValue(configuration),
        tasks: jsonValue(state.tasks),
        constraints: jsonValue(state.constraints),
        budgetLimit: configuration.budget,
        maxTurns: configuration.maxTurns,
      },
    });
    await tx.simulationEvent.createMany({
      data: [
        {
          runId: run.id,
          sequence: 0,
          step: 0,
          kind: 'simulation.started',
          source: 'system',
          summary: 'Deterministic same-seed rerun started.',
          payload: jsonValue({ rerunOf: original.id, seed: original.seed }),
        },
        {
          runId: run.id,
          sequence: 1,
          step: 0,
          kind: 'observation.created',
          source: 'system',
          summary: 'Initial observable state recorded.',
          payload: jsonValue({ state }),
        },
      ],
    });
    return tx.simulationRun.findFirst({
      where: { id: run.id },
      include: { actions: true, events: { orderBy: { sequence: 'asc' } }, toolCalls: true },
    });
  });
  if (!created) return NextResponse.json({ error: 'Rerun could not be created.' }, { status: 500 });
  return NextResponse.json(
    SimulationRerunResult.parse({
      run: toDetail(created),
      determinism: {
        environmentInitialStateMatches:
          JSON.stringify(state) ===
          JSON.stringify(SimulationState.parse(original.initialState ?? original.state)),
        transitionEngine: 'deterministic',
        providerDecisionPath: 'variable',
      },
    }),
    { status: 201 },
  );
}
