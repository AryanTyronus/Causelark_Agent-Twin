// @polsia:user-owned — allow-listed Strands tools for the resource environment.

import { type Tool, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { evaluateSimulationAction } from '@/lib/business/simulation';
import {
  SimulationActionInput,
  type SimulationActionInput as SimulationActionInputType,
  type SimulationState,
} from '@/lib/contracts/simulation';
import type { SimulationAgentToolOutcome } from '@/lib/contracts/simulation-agent';

export interface ResourceToolbox {
  tools: Tool[];
  getState: () => SimulationState;
  getOutcomes: () => SimulationAgentToolOutcome[];
}

export function createResourceTools(
  initialState: SimulationState,
  objective: string,
): ResourceToolbox {
  let currentState = initialState;
  const outcomes: SimulationAgentToolOutcome[] = [];
  const observeResources = tool({
    name: 'observe_resources',
    description: 'Read observable resources, budget, tasks, constraints, and objective progress.',
    inputSchema: z.object({}),
    callback: () => {
      const output = {
        objective,
        state: currentState,
        availableActions: ['harvest', 'allocate', 'rest'],
        constraints: currentState.constraints,
      };
      outcomes.push({
        toolName: 'observe_resources',
        input: {},
        output,
        status: 'SUCCEEDED',
        validationReason: null,
        stateBefore: currentState,
        stateAfter: currentState,
      });
      return output;
    },
  });
  const requestAction = tool({
    name: 'request_action',
    description:
      'Request one action. The deterministic environment validates it before changing state.',
    inputSchema: SimulationActionInput,
    callback: (input: SimulationActionInputType) => {
      const stateBefore = currentState;
      const evaluation = evaluateSimulationAction(currentState, input);
      if (evaluation.accepted) currentState = evaluation.state;
      const outcome: SimulationAgentToolOutcome = {
        toolName: 'request_action',
        input,
        output: {
          accepted: evaluation.accepted,
          observation: evaluation.observation,
          stateDiff: evaluation.stateDiff ?? {},
        },
        status: evaluation.accepted ? 'SUCCEEDED' : 'REJECTED',
        validationReason: evaluation.rejectionReason,
        stateBefore,
        stateAfter: currentState,
      };
      outcomes.push(outcome);
      return outcome.output;
    },
  });
  return {
    tools: [observeResources, requestAction],
    getState: () => currentState,
    getOutcomes: () => [...outcomes],
  };
}
