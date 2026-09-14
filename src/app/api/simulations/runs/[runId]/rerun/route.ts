import 'server-only';

import { NextResponse } from 'next/server';
import { jsonValue, loadRun, toDetail } from '@/lib/business/simulation-persistence';
import {
  SimulationConfiguration,
  SimulationEnvironmentKey,
  SimulationObjectiveKey,
  SimulationRerunResult,
  SimulationState,
} from '@/lib/contracts/simulation';
import { prisma } from '@/lib/db';
import { defaultConfigurationFor } from '@/lib/environments/registry';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import {
  describeScenarioApplication,
  initializeScenarioRun,
  ScenarioError,
} from '@/lib/scenarios/scenario';

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
  // The environment and objective are parsed rather than cast. A row whose key
  // is not one this deployment ships is a run that cannot be reproduced, and
  // saying so is better than coercing it into some other world's rules.
  const environmentKey = SimulationEnvironmentKey.parse(original.environmentKey);
  const objectiveKey = SimulationObjectiveKey.parse(original.objectiveKey);
  const configuration = SimulationConfiguration.parse(
    original.configuration ?? defaultConfigurationFor(environmentKey),
  );
  let initialization: ReturnType<typeof initializeScenarioRun>;
  try {
    // The scenario is replayed from the identity the original run recorded, at
    // the version it recorded — never from whatever the catalogue holds now. A
    // rerun must reproduce the original world, not a newer one with the same id.
    initialization = initializeScenarioRun({
      environmentKey,
      objectiveKey,
      seed: original.seed,
      configuration,
      scenarioId: original.scenarioId,
      scenarioVersion: original.scenarioVersion,
    });
  } catch (error) {
    if (error instanceof ScenarioError)
      return NextResponse.json(
        {
          error: `This run cannot be reproduced: ${error.message}`,
          code: error.code,
        },
        { status: 409 },
      );
    throw error;
  }
  const scenarioEvent = describeScenarioApplication(initialization);
  const state = initialization.state;
  const created = await prisma.$transaction(async (tx) => {
    const run = await tx.simulationRun.create({
      data: {
        ownerId: user.id,
        environmentKey: original.environmentKey,
        objectiveKey: original.objectiveKey,
        seed: original.seed,
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
          summary: 'Deterministic same-seed rerun started.',
          payload: jsonValue({ rerunOf: original.id, seed: original.seed }),
        },
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
