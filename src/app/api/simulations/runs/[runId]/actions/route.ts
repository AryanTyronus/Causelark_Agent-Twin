import 'server-only';

import type { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { evaluateSimulationAction, getSimulationStatus } from '@/lib/business/simulation';
import { jsonValue, loadRun, toAction, toDetail } from '@/lib/business/simulation-persistence';
import {
  SimulationActionInput,
  SimulationActionResult,
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
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { errors: { form: 'Request body must be valid JSON.' } },
      { status: 400 },
    );
  }
  const parsed = SimulationActionInput.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ errors: { form: 'Action shape is invalid.' } }, { status: 400 });
  const { runId } = await params;
  const run = await loadRun(runId, user.id);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  const state = SimulationState.parse(run.state);
  const evaluation = evaluateSimulationAction(state, parsed.data);
  try {
    const persisted = await prisma.$transaction(async (tx) => {
      const action = await tx.simulationAction.create({
        data: {
          runId,
          step: state.step,
          actionType: parsed.data.type,
          input: jsonValue(parsed.data),
          source: 'manual',
          accepted: evaluation.accepted,
          rejectionReason: evaluation.rejectionReason,
          observation: jsonValue(evaluation.observation),
          stateDiff: jsonValue(evaluation.stateDiff ?? {}),
          validationCode: evaluation.validationCode,
          resultingState: jsonValue(evaluation.state),
        },
      });
      const sequence = await tx.simulationEvent.count({ where: { runId } });
      const events: Prisma.SimulationEventCreateManyInput[] = [
        {
          runId,
          sequence,
          step: state.step,
          kind: 'action.requested',
          source: 'operator',
          summary: `Operator requested ${parsed.data.type}.`,
          payload: jsonValue({ input: parsed.data }),
        },
        {
          runId,
          sequence: sequence + 1,
          step: evaluation.state.step,
          kind: evaluation.accepted ? 'action.validated' : 'action.rejected',
          source: 'system',
          summary: evaluation.accepted
            ? 'Operator action validated.'
            : (evaluation.rejectionReason ?? 'Operator action rejected.'),
          payload: jsonValue({ reason: evaluation.rejectionReason, source: 'manual' }),
        },
      ];
      if (evaluation.accepted)
        events.push({
          runId,
          sequence: sequence + 2,
          step: evaluation.state.step,
          kind: 'state.changed',
          source: 'system',
          summary: 'Environment state changed.',
          payload: jsonValue({ before: state, after: evaluation.state }),
        });
      await tx.simulationEvent.createMany({ data: events });
      const next = getSimulationStatus(evaluation.state);
      if (evaluation.accepted)
        await tx.simulationRun.update({
          where: { id: runId },
          data: {
            state: jsonValue(evaluation.state),
            step: evaluation.state.step,
            status: next.status,
            agentStatus:
              next.status === 'COMPLETED'
                ? 'COMPLETED'
                : next.status === 'RUNNING'
                  ? 'WAITING'
                  : 'FAILED',
            budgetUsed: evaluation.state.budgetSpent,
            terminationReason: next.terminationReason,
            terminalAt: next.status === 'RUNNING' ? null : new Date(),
          },
        });
      const updated = await tx.simulationRun.findFirst({
        where: { id: runId },
        include: {
          actions: { orderBy: [{ step: 'asc' }, { createdAt: 'asc' }] },
          events: { orderBy: { sequence: 'asc' } },
          toolCalls: { orderBy: { createdAt: 'asc' } },
        },
      });
      if (!updated) throw new Error('Simulation run disappeared.');
      return { action, run: updated };
    });
    const payload = SimulationActionResult.parse({
      action: toAction(persisted.action),
      run: toDetail(persisted.run),
    });
    return NextResponse.json(payload, { status: evaluation.accepted ? 200 : 409 });
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
