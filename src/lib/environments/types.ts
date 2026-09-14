//
// The environment seam.
//
// Agent Twin shipped with exactly one environment — resource routing — and its
// rules were written as single functions: one `createInitialSimulationState`, one
// `evaluateSimulationAction`, one `getSimulationStatus`. Everything above them
// (the run loop, the scenario engine, persistence, replay, evaluation, the
// counterfactual analyser, the benchmark engine, the comparison engine) was
// written against those seams without caring what the world inside them was.
//
// This module names that seam. An environment is a world the pipeline can run:
// it builds a starting state, validates and applies one action, decides when a
// run has ended, describes its own objective, and states the two numbers the
// evaluation engine needs to normalise its scores. Adding the trading benchmark
// meant writing one more implementation of this interface and registering it —
// not writing a second pipeline beside the first.
//
// The interface is deliberately narrow. Every member is something the existing
// callers already needed from the resource-routing functions; nothing here was
// invented to make the new environment fit, and no existing caller had to change
// what it asks for.

import type { z } from 'zod';
import type {
  SimulationActionInput as SimulationActionInputType,
  SimulationActionType,
  SimulationConfiguration,
  SimulationEnvironmentKey,
  SimulationObjectiveKey,
  SimulationState,
} from '@/lib/contracts/simulation';
import type { SimulationAgentToolName } from '@/lib/contracts/simulation-agent';

/**
 * The bound a probing search uses to discover an environment's accepted action
 * sizes without being told them.
 *
 * An environment derives its own size ladder by asking its own validator which
 * magnitudes it accepts, up to this limit. The limit is a search bound, not the
 * contract's maximum: a world whose sizes stop at five discovers five, and a
 * world that accepts more discovers more. Nothing here restates either world's
 * rule, which is what keeps a discovered ladder from disagreeing with the rule
 * it was discovered from.
 */
export const ACTION_SPACE_PROBE_LIMIT = 10;

/**
 * The result of offering one action to an environment.
 *
 * Structurally identical to the `ActionEvaluation` the resource-routing
 * validator has always returned, so that function satisfies this contract
 * unchanged and remains the authority on its own world's rules.
 */
export interface EnvironmentActionEvaluation {
  /** Whether the action was applied. A refused action never moved the state. */
  accepted: boolean;
  /** The resulting state, or the untouched input state when refused. */
  state: SimulationState;
  observation: string;
  rejectionReason: string | null;
  /** The environment's own code for the outcome; `ACCEPTED` when applied. */
  validationCode?: string;
  stateDiff?: Record<string, unknown>;
}

/** How an environment says a run has ended. */
export interface EnvironmentStatus {
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'LIMIT_REACHED';
  terminationReason: string | null;
}

/**
 * The two normalising constants the evaluation engine scores against.
 *
 * They live on the environment because they are facts about the environment's
 * own rules — what one transition can produce, and what the cheapest possible
 * conversion costs — and the evaluation engine reads no others. An environment
 * that does not state them cannot be scored, which is the intended failure mode:
 * a benchmark whose dimensions were normalised against a number nobody derived
 * would be reporting a ratio to nothing.
 */
export interface EnvironmentScoringProfile {
  /** Greatest objective progress a single accepted transition can produce. */
  maxProgressPerTransition: number;
  /** Best achievable budget units per unit of objective progress. */
  optimalBudgetPerProgressUnit: number;
}

/** A catalogue entry, in the shape the options endpoint already serves. */
export interface EnvironmentCatalogueOption {
  key: string;
  title: string;
  description: string;
}

/** One tool an environment offers a model, with the allow-list it publishes. */
export interface EnvironmentToolDefinition {
  name: string;
  description: string;
  input: Record<string, unknown>;
}

/**
 * One tool as the agent is actually offered it during a turn.
 *
 * Distinct from `EnvironmentToolDefinition`, which is the catalogue's *display*
 * surface. The two differ on purpose: the catalogue describes a world to a human
 * reading a picker, the agent is told what a tool does in the words that shape
 * its behaviour. Collapsing them would mean editing one to change the other, and
 * the agent-facing wording is the half a benchmark's scores depend on.
 */
export interface EnvironmentAgentTool {
  /**
   * The name the turn's own tool-call records carry.
   *
   * Typed to the record contract rather than `string`, so a world cannot offer a
   * probe that its own trace would refuse to persist: an outcome naming an
   * unrecorded tool would be dropped at the persistence layer, and the run would
   * silently lose the observation the agent acted on.
   */
  name: SimulationAgentToolName;
  description: string;
}

/**
 * One runnable world.
 *
 * Every member is a pure function of its arguments: no clock, no randomness, no
 * network and no database. That is what lets the same seed and the same action
 * sequence reproduce the same states — the property replay and counterfactual
 * analysis are both built on.
 */
export interface SimulationEnvironment {
  key: SimulationEnvironmentKey;
  /** The catalogue entry the options endpoint serves for this world. */
  option: EnvironmentCatalogueOption;
  /** The objectives this world publishes, in its own declared order. */
  objectives: { key: SimulationObjectiveKey; title: string; description: string }[];
  /** The action verbs this world accepts. The permissions a run starts with. */
  actionTypes: readonly SimulationActionType[];
  /** The run configuration a run of this world starts from. */
  defaultConfiguration: SimulationConfiguration;
  /** The constraints this world enforces, in the words the agent is given them in. */
  constraints: readonly string[];
  /** The tools the agent is offered, as the catalogue advertises them. */
  tools: readonly EnvironmentToolDefinition[];
  /**
   * The tools the agent is offered during a turn, in the order it is offered
   * them, and in the words it is offered them in.
   *
   * Published because the tool surface is part of a world, not of the pipeline:
   * a read-only probe named for resources is a probe a trading agent cannot
   * interpret, and the wording of an action tool is what tells an agent what it
   * may ask for. The toolbox builds exactly these, so a world's vocabulary
   * reaches the model only through this member.
   */
  agentTools: {
    /** Read-only probes. Each returns the observable state and the turn's bounds. */
    observations: readonly EnvironmentAgentTool[];
    /** The single tool through which an action is requested. */
    action: EnvironmentAgentTool;
  };
  /**
   * The schema this world validates a requested action against.
   *
   * Published because the agent is *shown* it: a tool's input schema becomes the
   * JSON schema the model reads, so an environment that advertised the shared
   * record schema instead of its own would be telling the agent that sizes its
   * validator refuses are available. The record schema is deliberately wide — it
   * has to read back either world's persisted rows — and that width must not
   * reach the prompt.
   */
  actionInputSchema: z.ZodType<SimulationActionInputType>;
  scoring: EnvironmentScoringProfile;
  /** The objective text one bounded agent turn is given. */
  objectiveDescription(objectiveKey: SimulationObjectiveKey): string;
  createInitialState(
    objectiveKey: SimulationObjectiveKey,
    seed: number,
    configuration: SimulationConfiguration,
  ): SimulationState;
  /** Validate and apply one action. A refused action must not move the state. */
  evaluateAction(state: SimulationState, action: unknown): EnvironmentActionEvaluation;
  getStatus(state: SimulationState): EnvironmentStatus;
  /**
   * Every action this world admits, in its own enumeration order.
   *
   * The counterfactual analyser needs a decision space to search, and the only
   * module that knows what one is here is the environment itself. Publishing it
   * means the space cannot drift from the validator that judges it: a candidate
   * the environment would refuse is enumerated and refused, rather than being
   * absent because a second list forgot it.
   *
   * Order is part of the contract. The analyser breaks ties by enumeration
   * order, so the same state must yield the same alternatives in the same
   * sequence, every time.
   */
  actionSpace(state: SimulationState): SimulationActionInputType[];
}

/** Raised when a run names an environment this deployment does not publish. */
export class EnvironmentError extends Error {
  readonly code: 'UNKNOWN_ENVIRONMENT' | 'ENVIRONMENT_MISMATCH';

  constructor(code: EnvironmentError['code'], message: string) {
    super(message);
    this.name = 'EnvironmentError';
    this.code = code;
  }
}
