import { type Tool, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type {
  SimulationActionInput as SimulationActionInputType,
  SimulationState,
} from '@/lib/contracts/simulation';
import type { SimulationAgentToolOutcome } from '@/lib/contracts/simulation-agent';
import {
  evaluateSimulationAction,
  getSimulationStatus,
  simulationEnvironmentFor,
} from '@/lib/environments/registry';

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
 * The tools are the state's own environment's, not this module's: a world
 * declares the read-only probes it offers and the one tool through which an
 * action is requested, and the toolbox instantiates exactly those. That is what
 * keeps one world's vocabulary out of another's prompt — a trading agent is
 * never told to observe resources, and a resource agent is never told to inspect
 * a portfolio — while both go through the identical validator, allowance and
 * envelope below.
 *
 * Both kinds of tool are pure with respect to the run: they only ever move a
 * local state copy forward through the same `evaluateSimulationAction` validator
 * the manual operator endpoint uses, so a rejected action can never mutate
 * simulation state. The action allowance is what keeps a single invocation from
 * looping forever — once it is spent, further requests are refused without
 * touching state.
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
  const environment = simulationEnvironmentFor(initialState);

  /**
   * What every probe returns: the whole observable state and the turn's bounds.
   *
   * One envelope for every read-only tool, because an agent that could not see
   * its remaining allowance or its constraints from whichever probe it happened
   * to call would have to discover its limits one refusal at a time.
   */
  const observe = () => ({
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
  });

  const observations = environment.agentTools.observations.map((declaration) =>
    tool({
      name: declaration.name,
      description: declaration.description,
      inputSchema: z.object({}),
      callback: () => {
        const startedAt = Date.now();
        const output = observe();
        outcomes.push({
          toolName: declaration.name,
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
    }),
  );

  const requestAction = tool({
    name: environment.agentTools.action.name,
    description: environment.agentTools.action.description,
    inputSchema: environment.actionInputSchema,
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
    tools: [...observations, requestAction],
    getState: () => currentState,
    getOutcomes: () => [...outcomes],
  };
}
