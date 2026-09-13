// @polsia:user-owned — environment-specific Strands orchestration.

import {
  clampAgentLoopTurns,
  invokeResourceAgent,
  type ResourceAgentResult,
} from '@/lib/agent/provider';
import {
  createResourceTools,
  DEFAULT_MAX_ACTIONS_PER_TURN,
  type ResourceToolbox,
} from '@/lib/agent/resource-tools';
import type { SimulationState } from '@/lib/contracts/simulation';

export interface ResourceAgentRun {
  toolbox: ResourceToolbox;
  provider: ResourceAgentResult;
}

export interface ResourceAgentTurnInput {
  objective: string;
  state: SimulationState;
  /** Wall-clock budget for the whole bounded turn. */
  timeoutMs: number;
  maxActionsPerTurn?: number;
}

/**
 * Derives the model-call allowance from the action allowance.
 *
 * Each action needs a model call to request it plus a model call to observe the
 * result, so the loop can afford two model calls per action plus one opening
 * observation. The result is still clamped by the provider's hard ceiling, which
 * keeps a mistuned configuration from ever becoming an unbounded loop.
 */
export function resolveAgentLoopTurns(maxActionsPerTurn: number): number {
  const allowance = Number.isFinite(maxActionsPerTurn) ? Math.floor(maxActionsPerTurn) : 0;
  return clampAgentLoopTurns(allowance * 2 + 1);
}

export async function runResourceAgentTurn(
  input: ResourceAgentTurnInput,
): Promise<ResourceAgentRun> {
  const maxActions = Math.max(
    1,
    Math.floor(input.maxActionsPerTurn ?? DEFAULT_MAX_ACTIONS_PER_TURN),
  );
  const toolbox = createResourceTools(input.state, input.objective, { maxActions });
  const provider = await invokeResourceAgent({
    objective: input.objective,
    state: input.state,
    tools: toolbox.tools,
    timeoutMs: input.timeoutMs,
    maxTurns: resolveAgentLoopTurns(maxActions),
    maxActions,
  });
  return { toolbox, provider };
}
