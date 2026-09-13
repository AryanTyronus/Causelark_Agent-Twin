// @polsia:user-owned — deterministic counterfactual test fixtures.
//
// These fixtures do not mock the environment. Every trace below is folded
// through the *real* deterministic transition engine — `createInitialSimulationState`
// and `evaluateSimulationAction` — so a fixture is a trace the environment would
// genuinely have produced, and a test built on one is a test of the
// counterfactual engine rather than of a hand-written state.
//
// Two properties make them suitable for that: nothing reads a clock (timestamps
// are generated from a fixed epoch by arithmetic), and nothing reads a random
// source (the seed selects the world, exactly as it does in production). A
// fixture built twice is the same fixture, and no database or run id is needed.

import {
  createInitialSimulationState,
  DEFAULT_CONFIGURATION,
  evaluateSimulationAction,
  getSimulationStatus,
} from '@/lib/business/simulation';
import type {
  SimulationActionInput,
  SimulationActionRecord,
  SimulationRunStatus,
  SimulationScenarioIdentity,
} from '@/lib/contracts/simulation';
import type { EvaluationInput } from '@/lib/evaluation/types';

/** The fixed instant every fixture timestamp is derived from. Never "now". */
export const FIXTURE_EPOCH = '2026-01-01T00:00:00.000Z';

/** A deterministic ISO timestamp, derived by arithmetic from the epoch. */
export function timestampAt(index: number): string {
  const hours = String(Math.floor(index / 60)).padStart(2, '0');
  const minutes = String(index % 60).padStart(2, '0');
  return `2026-01-01T${hours}:${minutes}:00.000Z`;
}

export interface TraceFixtureInput {
  actions: SimulationActionInput[];
  runId?: string;
  seed?: number;
  /** Recorded terminal status. Defaults to what the folded trace reaches. */
  status?: SimulationRunStatus;
  terminationReason?: string | null;
  scenario?: SimulationScenarioIdentity | null;
  /** Per-action provenance; defaults to every action being the agent's. */
  sources?: ('agent' | 'manual')[];
  /** Recorded `agent.error` events, for the held-constant comparison. */
  agentErrors?: number;
}

/**
 * Fold an action list through the environment and describe it as persisted
 * evidence. Refused actions are recorded the way the runtime records them: a
 * refusal leaves the state where it was and does not advance the step.
 */
export function traceFixture(input: TraceFixtureInput): EvaluationInput {
  const seed = input.seed ?? 1042;
  const runId = input.runId ?? `run-fixture-${seed}`;
  const initialState = createInitialSimulationState('resource-routing', 'complete-delivery', seed);
  let state = initialState;
  const actions: SimulationActionRecord[] = [];
  input.actions.forEach((action, index) => {
    const evaluation = evaluateSimulationAction(state, action);
    const after = evaluation.accepted ? evaluation.state : state;
    actions.push({
      id: `${runId}~action${index}`,
      step: state.step,
      type: action.type,
      input: action,
      source: input.sources?.[index] ?? 'agent',
      accepted: evaluation.accepted,
      rejectionReason: evaluation.rejectionReason,
      observation: evaluation.observation,
      stateDiff: { before: state, after },
      resultingState: after,
      createdAt: timestampAt(index),
    });
    state = after;
  });

  const reached = getSimulationStatus(state);
  return {
    runId,
    status: input.status ?? reached.status,
    state,
    initialState,
    actions,
    events: Array.from({ length: input.agentErrors ?? 0 }, (_unused, index) => ({
      id: `${runId}~error${index}`,
      sequence: index,
      step: state.step,
      kind: 'agent.error' as const,
      source: 'agent' as const,
      summary: 'The provider rejected the request.',
      payload: {},
      createdAt: timestampAt(index),
    })),
    toolCalls: [],
    budgetLimit: DEFAULT_CONFIGURATION.budget,
    turnCount: 1,
    maxTurns: DEFAULT_CONFIGURATION.maxTurns,
    terminationReason: input.terminationReason ?? reached.terminationReason,
    scenario: input.scenario ?? null,
  };
}

/**
 * A run that spends its whole decision budget without finishing the objective.
 *
 * Four measured allocations, five harvests that refill energy, and three rests
 * that spend what is left. It ends exactly at the step limit with the objective
 * five units short, which is the interesting shape for a counterfactual: the
 * agent had the resources to finish and spent its steps elsewhere.
 */
export const STEP_LIMITED_PLAN: SimulationActionInput[] = [
  { type: 'allocate', resource: 'materials', amount: 1 },
  { type: 'allocate', resource: 'materials', amount: 1 },
  { type: 'allocate', resource: 'materials', amount: 1 },
  { type: 'allocate', resource: 'materials', amount: 1 },
  { type: 'harvest', resource: 'energy', amount: 1 },
  { type: 'harvest', resource: 'energy', amount: 1 },
  { type: 'harvest', resource: 'energy', amount: 1 },
  { type: 'harvest', resource: 'energy', amount: 1 },
  { type: 'harvest', resource: 'energy', amount: 1 },
  { type: 'rest', amount: 1 },
  { type: 'rest', amount: 1 },
  { type: 'rest', amount: 1 },
];

/** A short run that reaches the objective in four transitions. */
export const COMPLETING_PLAN: SimulationActionInput[] = [
  { type: 'allocate', resource: 'materials', amount: 5 },
  { type: 'allocate', resource: 'materials', amount: 2 },
  { type: 'harvest', resource: 'materials', amount: 4 },
  { type: 'allocate', resource: 'materials', amount: 1 },
];

/** A run whose last recorded request was refused for want of the resource. */
export const REFUSED_PLAN: SimulationActionInput[] = [
  { type: 'allocate', resource: 'materials', amount: 4 },
  { type: 'allocate', resource: 'materials', amount: 3 },
  { type: 'allocate', resource: 'materials', amount: 5 },
];

/** The step-limited run with one further request recorded after it terminated. */
export const POST_TERMINAL_PLAN: SimulationActionInput[] = [
  ...STEP_LIMITED_PLAN,
  { type: 'allocate', resource: 'water', amount: 2 },
];
