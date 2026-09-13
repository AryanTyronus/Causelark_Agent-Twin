// @polsia:user-owned — Prisma-to-contract mapping for simulation route handlers.

import 'server-only';

import type {
  Prisma,
  SimulationAction,
  SimulationEvent,
  SimulationRun,
  SimulationToolCall,
} from '@prisma/client';
import { DEFAULT_CONFIGURATION } from '@/lib/business/simulation';
import {
  SimulationActionInput,
  SimulationActionRecord,
  SimulationConfiguration,
  SimulationEvent as SimulationEventSchema,
  SimulationRunDetail,
  type SimulationScenarioIdentity,
  SimulationState,
  SimulationToolCall as SimulationToolCallSchema,
} from '@/lib/contracts/simulation';
import { prisma } from '@/lib/db';

export type PersistedRun = SimulationRun & {
  actions: SimulationAction[];
  events: SimulationEvent[];
  toolCalls: SimulationToolCall[];
};

export function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/**
 * The scenario a run was created under, or `null` when it had none.
 *
 * Both columns are written together and neither is meaningful alone, so a row
 * missing either is treated as unscenarioed rather than being reported as a
 * half-identified condition.
 */
export function toScenarioIdentity(
  run: Pick<SimulationRun, 'scenarioId' | 'scenarioVersion'>,
): SimulationScenarioIdentity | null {
  if (run.scenarioId == null || run.scenarioVersion == null) return null;
  return { id: run.scenarioId, version: run.scenarioVersion };
}

export function toSummary(run: SimulationRun) {
  const state = SimulationState.parse(run.state);
  return {
    id: run.id,
    environmentKey: run.environmentKey,
    objectiveKey: run.objectiveKey,
    seed: run.seed,
    status: run.status,
    agentStatus: run.agentStatus,
    step: run.step,
    maxSteps: state.maxSteps,
    budgetRemaining: state.budgetRemaining,
    scenario: toScenarioIdentity(run),
    terminationReason: run.terminationReason,
    failureDetails: run.failureDetails,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

export function toAction(action: SimulationAction) {
  return SimulationActionRecord.parse({
    id: action.id,
    step: action.step,
    type: action.actionType,
    input: SimulationActionInput.parse(action.input),
    source: action.source === 'agent' ? 'agent' : 'manual',
    accepted: action.accepted,
    rejectionReason: action.rejectionReason,
    observation:
      typeof action.observation === 'string'
        ? action.observation
        : JSON.stringify(action.observation),
    stateDiff:
      action.stateDiff && typeof action.stateDiff === 'object'
        ? (action.stateDiff as Record<string, unknown>)
        : {},
    resultingState: SimulationState.parse(action.resultingState),
    createdAt: action.createdAt.toISOString(),
  });
}

export function toEvent(event: SimulationEvent) {
  return SimulationEventSchema.parse({
    id: event.id,
    sequence: event.sequence,
    step: event.step,
    kind: event.kind,
    source: event.source,
    summary: event.summary,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  });
}

export function toToolCall(call: SimulationToolCall) {
  return SimulationToolCallSchema.parse({
    id: call.id,
    step: call.step,
    toolName: call.toolName,
    input: call.input,
    output: call.output,
    status: call.status,
    validationReason: call.validationReason,
    latencyMs: call.latencyMs,
    createdAt: call.createdAt.toISOString(),
  });
}

export function toDetail(run: PersistedRun) {
  const state = SimulationState.parse(run.state);
  const configuration = SimulationConfiguration.parse(run.configuration ?? DEFAULT_CONFIGURATION);
  return SimulationRunDetail.parse({
    ...toSummary(run),
    state,
    configuration,
    tasks: state.tasks,
    constraints: state.constraints,
    actions: run.actions.map(toAction),
    events: run.events.map(toEvent),
    toolCalls: run.toolCalls.map(toToolCall),
  });
}

export async function loadRun(runId: string, ownerId: string): Promise<PersistedRun | null> {
  return prisma.simulationRun.findFirst({
    where: { id: runId, ownerId },
    include: {
      actions: { orderBy: [{ step: 'asc' }, { createdAt: 'asc' }] },
      events: { orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }] },
      toolCalls: { orderBy: [{ createdAt: 'asc' }] },
    },
  });
}
