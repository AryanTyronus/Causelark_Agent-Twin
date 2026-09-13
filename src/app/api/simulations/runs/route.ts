import 'server-only';

import { NextResponse } from 'next/server';
import { DEFAULT_CONFIGURATION, isSupportedSeed } from '@/lib/business/simulation';
import { jsonValue, toDetail, toSummary } from '@/lib/business/simulation-persistence';
import {
  SimulationRunDetail,
  SimulationRunList,
  SimulationStartInput,
} from '@/lib/contracts/simulation';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import {
  describeScenarioApplication,
  initializeScenarioRun,
  ScenarioError,
} from '@/lib/scenarios/scenario';

export const dynamic = 'force-dynamic';

function validationErrors(error: {
  flatten: () => { fieldErrors: Record<string, string[] | undefined> };
}) {
  const errors: Record<string, string> = {};
  for (const [field, messages] of Object.entries(error.flatten().fieldErrors)) {
    const message = messages?.[0];
    if (message) errors[field] = message;
  }
  return errors;
}

export async function GET(req: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  try {
    const runs = await prisma.simulationRun.findMany({
      where: { ownerId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return NextResponse.json(SimulationRunList.parse({ runs: runs.map(toSummary) }));
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
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
  const parsed = SimulationStartInput.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ errors: validationErrors(parsed.error) }, { status: 400 });
  if (!isSupportedSeed(parsed.data.seed))
    return NextResponse.json(
      { errors: { seed: 'Choose one of the available replay seeds.' } },
      { status: 400 },
    );
  try {
    const configuration = { ...DEFAULT_CONFIGURATION, ...parsed.data.configuration };
    // The scenario is resolved from the server-side catalogue and applied here,
    // before the run row exists: an unknown id is a bad request, not a run that
    // silently starts unperturbed.
    const initialization = initializeScenarioRun({
      environmentKey: parsed.data.environmentKey,
      objectiveKey: parsed.data.objectiveKey,
      seed: parsed.data.seed,
      configuration,
      scenarioId: parsed.data.scenarioId ?? null,
    });
    const scenarioEvent = describeScenarioApplication(initialization);
    const state = initialization.state;
    const created = await prisma.$transaction(async (tx) => {
      const run = await tx.simulationRun.create({
        data: {
          ownerId: user.id,
          environmentKey: parsed.data.environmentKey,
          objectiveKey: parsed.data.objectiveKey,
          seed: parsed.data.seed,
          scenarioId: initialization.scenario?.id ?? null,
          scenarioVersion: initialization.scenario?.version ?? null,
          status: 'RUNNING',
          agentStatus: 'READY',
          step: 0,
          state: jsonValue(state),
          initialState: jsonValue(state),
          configuration: jsonValue(initialization.configuration),
          tasks: jsonValue(state.tasks),
          constraints: jsonValue(state.constraints),
          budgetLimit: initialization.configuration.budget,
          maxTurns: initialization.configuration.maxTurns,
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
            summary: 'Persistent Agent Twin run started.',
            payload: jsonValue({
              environmentKey: run.environmentKey,
              objectiveKey: run.objectiveKey,
              seed: run.seed,
              ...(initialization.scenario
                ? {
                    scenarioId: initialization.scenario.id,
                    scenarioVersion: initialization.scenario.version,
                  }
                : {}),
            }),
          },
          // Between the run starting and its first observation, so the trace
          // reads: created → scenario applied → observed. Absent entirely for a
          // run with no scenario, which keeps that trace exactly as it was.
          ...(scenarioEvent
            ? [
                {
                  runId: run.id,
                  sequence: 1,
                  step: 0,
                  kind: 'scenario.applied',
                  source: 'system',
                  summary: scenarioEvent.summary,
                  payload: jsonValue(scenarioEvent.payload),
                },
              ]
            : []),
          {
            runId: run.id,
            sequence: scenarioEvent ? 2 : 1,
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
    if (!created) return NextResponse.json({ error: 'Run could not be created.' }, { status: 500 });
    return NextResponse.json(SimulationRunDetail.parse(toDetail(created)), { status: 201 });
  } catch (error) {
    if (error instanceof ScenarioError)
      return NextResponse.json({ errors: { scenarioId: error.message } }, { status: 400 });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
