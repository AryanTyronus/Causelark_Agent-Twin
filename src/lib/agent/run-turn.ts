import 'server-only';

import type { Prisma } from '@prisma/client';
import {
  AgentProviderError,
  type AgentSelection,
  agentProviderLabel,
  selectedProviderLabel,
} from '@/lib/agent/provider';
import { runResourceAgentTurn } from '@/lib/agent/resource-agent';
import { DEFAULT_MAX_ACTIONS_PER_TURN } from '@/lib/agent/resource-tools';
import { getSimulationOptions } from '@/lib/business/simulation';
import { jsonValue, loadRun, toDetail } from '@/lib/business/simulation-persistence';
import {
  SimulationConfiguration,
  SimulationObjectiveKey,
  SimulationState,
} from '@/lib/contracts/simulation';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { getSimulationStatus, simulationEnvironmentFor } from '@/lib/environments/registry';

export class TurnConflictError extends Error {
  constructor() {
    super('Another Agent Twin turn is already in progress or the run is terminal.');
    this.name = 'TurnConflictError';
  }
}

export interface TurnOptions {
  /**
   * The agent that runs this turn. Omitted, the deployment's own agent runs.
   *
   * A turn is the only thing that may move a run, so this is the only place an
   * agent can be chosen: whichever agent is selected, it meets the same
   * environment, the same validator, the same tools, the same objective and the
   * same persisted trace. Nothing else about the turn changes.
   */
  selection?: AgentSelection | null;
}

function errorKind(error: AgentProviderError): 'TIMEOUT' | 'ERROR' {
  return error.code === 'timeout' ? 'TIMEOUT' : 'ERROR';
}

export async function runTurn(runId: string, ownerId: string, options: TurnOptions = {}) {
  const selection = options.selection ?? null;
  const claimed = await prisma.simulationRun.updateMany({
    where: { id: runId, ownerId, status: 'RUNNING', turnInProgress: false },
    data: { turnInProgress: true, agentStatus: 'THINKING' },
  });
  if (claimed.count !== 1) throw new TurnConflictError();

  try {
    const run = await loadRun(runId, ownerId);
    if (!run) throw new TurnConflictError();
    const state = SimulationState.parse(run.state);
    // Named apart from this function's own `options`, which carry the agent
    // selection: this is the environment's catalogue, that is the turn's.
    const catalogue = getSimulationOptions();
    // The run's own persisted configuration governs its turn budget, not the
    // catalogue default the run may have overridden at creation time.
    const configuration = SimulationConfiguration.parse(
      run.configuration ?? catalogue.configuration,
    );
    // The objective text comes from the world this run belongs to, not from the
    // resource catalogue: after the trading benchmark exists the catalogue lists
    // objectives that only one of the two worlds answers to, and looking a
    // trading objective up in it would report a missing objective rather than
    // the brief the agent was meant to be given.
    const environment = simulationEnvironmentFor(state);
    // Parsed rather than cast: the objective key arrives from a persisted row, and
    // an unknown one should be refused as a bad run rather than looked up in a
    // world that never published it.
    const objectiveKey = SimulationObjectiveKey.safeParse(run.objectiveKey);
    if (!objectiveKey.success)
      throw new AgentProviderError('provider_error', 'Simulation objective is unavailable.');
    const objective = environment.objectiveDescription(objectiveKey.data);
    const agentRun = await runResourceAgentTurn({
      objective,
      state,
      timeoutMs: configuration.toolTimeoutMs,
      maxActionsPerTurn: DEFAULT_MAX_ACTIONS_PER_TURN,
      selection,
    });
    const outcomes = agentRun.toolbox.getOutcomes();
    const finalState = agentRun.toolbox.getState();
    const statusResult = getSimulationStatus(finalState);
    const turnLimitReached = run.turnCount + 1 >= (run.maxTurns || configuration.maxTurns);
    const nextStatus =
      statusResult.status === 'RUNNING' && turnLimitReached ? 'LIMIT_REACHED' : statusResult.status;
    const nextReason =
      nextStatus === 'LIMIT_REACHED' && statusResult.status === 'RUNNING'
        ? 'Agent turn limit reached.'
        : statusResult.terminationReason;
    const persisted = await prisma.$transaction(async (tx) => {
      const sequenceStart = await tx.simulationEvent.count({ where: { runId } });
      const eventRows: Prisma.SimulationEventCreateManyInput[] = [];
      const event = (
        kind: string,
        source: string,
        summary: string,
        payload: Record<string, unknown>,
        step: number,
      ) => {
        eventRows.push({
          runId,
          sequence: sequenceStart + eventRows.length,
          step,
          kind,
          source,
          summary,
          payload: jsonValue(payload),
        });
      };
      event(
        'agent.turn.started',
        'agent',
        'Agent turn started.',
        { provider: agentRun.provider.metadata.provider },
        state.step,
      );
      event(
        'observation.created',
        'system',
        'Observable state provided to the agent.',
        { state: state },
        state.step,
      );
      const actionRows: Prisma.SimulationActionCreateManyInput[] = [];
      const toolRows: Prisma.SimulationToolCallCreateManyInput[] = [];
      outcomes.forEach((outcome, index) => {
        const latencyMs = outcome.latencyMs ?? null;
        const toolStatus = outcome.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'REJECTED';
        toolRows.push({
          id: `${runId}-turn-${run.turnCount + 1}-${index}`,
          runId,
          step: outcome.stateBefore.step,
          toolName: outcome.toolName,
          input: jsonValue(outcome.input),
          output: outcome.output ? jsonValue(outcome.output) : undefined,
          status: toolStatus,
          validationReason: outcome.validationReason,
          latencyMs,
        });
        event(
          'tool.requested',
          'tool',
          `${outcome.toolName} requested.`,
          { toolName: outcome.toolName, input: outcome.input },
          outcome.stateBefore.step,
        );
        event(
          'tool.result',
          'tool',
          `${outcome.toolName} ${toolStatus.toLowerCase()}.`,
          { status: toolStatus, validationReason: outcome.validationReason },
          outcome.stateAfter.step,
        );
        if (outcome.toolName === 'request_action') {
          const actionInput = outcome.input as { type: string; resource?: string; amount: number };
          actionRows.push({
            id: `${runId}-agent-action-${run.turnCount + 1}-${index}`,
            runId,
            step: outcome.stateBefore.step,
            actionType: actionInput.type,
            input: jsonValue(outcome.input),
            accepted: outcome.status === 'SUCCEEDED',
            source: 'agent',
            rejectionReason: outcome.validationReason,
            observation: jsonValue(outcome.output ?? {}),
            stateDiff: jsonValue({ before: outcome.stateBefore, after: outcome.stateAfter }),
            validationCode: outcome.status === 'SUCCEEDED' ? 'ACCEPTED' : 'REJECTED',
            resultingState: jsonValue(outcome.stateAfter),
          });
          event(
            'action.requested',
            'agent',
            `Agent requested ${actionInput.type}.`,
            { input: outcome.input },
            outcome.stateBefore.step,
          );
          event(
            outcome.status === 'SUCCEEDED' ? 'action.validated' : 'action.rejected',
            'system',
            outcome.status === 'SUCCEEDED'
              ? 'Action validated and applied.'
              : (outcome.validationReason ?? 'Action rejected.'),
            { input: outcome.input },
            outcome.stateAfter.step,
          );
          if (outcome.status === 'SUCCEEDED')
            event(
              'state.changed',
              'system',
              'Environment state changed.',
              { before: outcome.stateBefore, after: outcome.stateAfter },
              outcome.stateAfter.step,
            );
        }
      });
      if (actionRows.length) await tx.simulationAction.createMany({ data: actionRows });
      if (toolRows.length) await tx.simulationToolCall.createMany({ data: toolRows });
      event(
        'agent.turn.completed',
        'agent',
        'Agent turn completed with safe metadata.',
        {
          provider: agentRun.provider.metadata.provider,
          latencyMs: agentRun.provider.metadata.latencyMs,
          inputTokens: agentRun.provider.metadata.inputTokens,
          outputTokens: agentRun.provider.metadata.outputTokens,
          toolCalls: outcomes.length,
          stopReason: agentRun.provider.stopReason,
        },
        finalState.step,
      );
      if (nextStatus !== 'RUNNING')
        event(
          nextStatus === 'COMPLETED' ? 'simulation.completed' : 'simulation.failed',
          'system',
          nextReason ?? 'Simulation terminated.',
          { status: nextStatus },
          finalState.step,
        );
      if (eventRows.length) await tx.simulationEvent.createMany({ data: eventRows });
      await tx.simulationRun.update({
        where: { id: runId },
        data: {
          state: jsonValue(finalState),
          step: finalState.step,
          status: nextStatus,
          agentStatus:
            nextStatus === 'COMPLETED'
              ? 'COMPLETED'
              : nextStatus === 'RUNNING'
                ? 'WAITING'
                : 'FAILED',
          budgetUsed: finalState.budgetSpent,
          turnCount: { increment: 1 },
          turnInProgress: false,
          terminationReason: nextReason,
          terminalAt: nextStatus === 'RUNNING' ? null : new Date(),
        },
      });
      const updated = await tx.simulationRun.findFirst({
        where: { id: runId, ownerId },
        include: {
          actions: { orderBy: [{ step: 'asc' }, { createdAt: 'asc' }] },
          events: { orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }] },
          toolCalls: { orderBy: [{ createdAt: 'asc' }] },
        },
      });
      if (!updated) throw new Error('Simulation run disappeared during agent turn.');
      return { run: toDetail(updated), outcomes, provider: agentRun.provider, status: nextStatus };
    });
    return {
      run: persisted.run,
      turn: {
        status: 'COMPLETED' as const,
        provider: agentRun.provider.metadata.provider,
        toolCalls: persisted.outcomes.length,
        acceptedActions: persisted.outcomes.filter(
          (outcome) => outcome.toolName === 'request_action' && outcome.status === 'SUCCEEDED',
        ).length,
        safeError: null,
      },
    };
  } catch (error) {
    const isProviderError = error instanceof AgentProviderError;
    const message = error instanceof Error ? error.message.slice(0, 240) : 'Agent turn failed.';
    const status = isProviderError && errorKind(error) === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR';
    await prisma.$transaction(async (tx) => {
      const sequence = await tx.simulationEvent.count({ where: { runId } });
      // The failure belongs to the step the run actually reached, not step 0.
      const currentRun = await tx.simulationRun.findFirst({
        where: { id: runId, ownerId },
        select: { step: true },
      });
      await tx.simulationEvent.create({
        data: {
          runId,
          sequence,
          step: currentRun?.step ?? 0,
          kind: 'agent.error',
          source: 'agent',
          summary: message,
          payload: jsonValue({
            code: isProviderError ? error.code : 'environment_error',
            recoverable: false,
          }),
        },
      });
      await tx.simulationRun.updateMany({
        where: { id: runId, ownerId },
        data: {
          status,
          agentStatus: 'FAILED',
          failureDetails: message,
          terminationReason: message,
          terminalAt: new Date(),
          turnInProgress: false,
          turnCount: { increment: 1 },
        },
      });
    });
    const failedRun = await loadRun(runId, ownerId);
    if (!failedRun) throw error;
    return {
      run: toDetail(failedRun),
      turn: {
        status: 'FAILED' as const,
        // The turn must name the provider it was actually attempting, including
        // when the provider selection itself was what failed. When a caller
        // named the agent, the name comes from that selection — reading the
        // environment here would report a provider that was never invoked.
        provider: selection ? agentProviderLabel(selection.provider) : selectedProviderLabel(env),
        toolCalls: 0,
        acceptedActions: 0,
        safeError: message,
      },
    };
  }
}
