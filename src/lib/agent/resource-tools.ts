import { type Tool, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { evaluateSimulationAction, getSimulationStatus } from '@/lib/business/simulation';
import {
  SimulationActionInput,
  type SimulationActionInput as SimulationActionInputType,
  type SimulationState,
} from '@/lib/contracts/simulation';
import type { SimulationAgentToolOutcome } from '@/lib/contracts/simulation-agent';

/** Upper bound on `request_action` attempts inside one bounded agent turn. */
export const DEFAULT_MAX_ACTIONS_PER_TURN = 3;

export interface ResourceToolbox {
  tools: Tool[];
  getState: () => SimulationState;
  getOutcomes: () => SimulationAgentToolOutcome[];
}

export interface ResourceToolboxOptions {
  /** Maximum `request_action` attempts (accepted or rejected) in this turn. */
  maxActions?: number;
}

/**
 * Builds the allow-listed tool set for one bounded turn.
 *
 * Both tools are pure with respect to the run: they only ever move a local state
 * copy forward through the same `evaluateSimulationAction` validator the manual
 * operator endpoint uses, so a rejected action can never mutate simulation state.
 * The action allowance is what keeps a single invocation from looping forever —
 * once it is spent, further requests are refused without touching state.
 */
export function createResourceTools(
  initialState: SimulationState,
  objective: string,
  options: ResourceToolboxOptions = {},
): ResourceToolbox {
  let currentState = initialState;
  let actionsRequested = 0;
  const outcomes: SimulationAgentToolOutcome[] = [];
  const maxActions = Math.max(1, Math.floor(options.maxActions ?? DEFAULT_MAX_ACTIONS_PER_TURN));
  const remainingActions = () => Math.max(0, maxActions - actionsRequested);
  const terminal = () => getSimulationStatus(currentState).status !== 'RUNNING';
  const observeResources = tool({
    name: 'observe_resources',
    description:
      'Read observable resources, budget, tasks, constraints, objective progress, and remaining action allowance.',
    inputSchema: z.object({}),
    callback: () => {
      const startedAt = Date.now();
      const output = {
        objective,
        state: currentState,
        // Read from the environment rather than restated here: a scenario can
        // revoke an action, and the agent must be told what it may actually do
        // instead of discovering it one rejection at a time.
        availableActions: currentState.permissions,
        constraints: currentState.constraints,
        stepsRemaining: Math.max(0, currentState.maxSteps - currentState.step),
        actionsRemaining: remainingActions(),
        terminal: terminal(),
      };
      outcomes.push({
        toolName: 'observe_resources',
        input: {},
        output,
        status: 'SUCCEEDED',
        validationReason: null,
        latencyMs: Date.now() - startedAt,
        stateBefore: currentState,
        stateAfter: currentState,
      });
      return output;
    },
  });
  const requestAction = tool({
    name: 'request_action',
    description:
      'Request one action. The deterministic environment validates it before changing state. You may request a limited number of actions per turn.',
    inputSchema: SimulationActionInput,
    callback: (input: SimulationActionInputType) => {
      const startedAt = Date.now();
      const stateBefore = currentState;
      if (actionsRequested >= maxActions) {
        const output = {
          accepted: false,
          observation:
            'The action allowance for this turn is already spent. Stop and report the outcome.',
          stateDiff: {},
          actionsRemaining: 0,
          status: getSimulationStatus(currentState).status,
          terminal: terminal(),
        };
        outcomes.push({
          toolName: 'request_action',
          input,
          output,
          status: 'REJECTED',
          validationReason: 'The per-turn action allowance is spent.',
          latencyMs: Date.now() - startedAt,
          stateBefore,
          stateAfter: currentState,
        });
        return output;
      }
      actionsRequested += 1;
      const evaluation = evaluateSimulationAction(currentState, input);
      if (evaluation.accepted) currentState = evaluation.state;
      const output = {
        accepted: evaluation.accepted,
        observation: evaluation.observation,
        stateDiff: evaluation.stateDiff ?? {},
        actionsRemaining: remainingActions(),
        status: getSimulationStatus(currentState).status,
        terminal: terminal(),
      };
      outcomes.push({
        toolName: 'request_action',
        input,
        output,
        status: evaluation.accepted ? 'SUCCEEDED' : 'REJECTED',
        validationReason: evaluation.rejectionReason,
        latencyMs: Date.now() - startedAt,
        stateBefore,
        stateAfter: currentState,
      });
      return output;
    },
  });
  return {
    tools: [observeResources, requestAction],
    getState: () => currentState,
    getOutcomes: () => [...outcomes],
  };
}
