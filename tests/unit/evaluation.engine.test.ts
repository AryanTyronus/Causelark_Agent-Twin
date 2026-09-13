// @vitest-environment node
//
// The engine's whole claim is that a verdict is a pure function of persisted
// evidence. These tests hold that claim from both ends: scenarios built from
// real environment transitions pin the arithmetic, and the determinism, purity
// and bounds tests make sure no clock, no randomness and no hidden state can
// leak into a score.

import { describe, expect, it } from 'vitest';
import {
  createInitialSimulationState,
  evaluateSimulationAction,
  getSimulationStatus,
} from '@/lib/business/simulation';
import {
  type SimulationActionInput,
  SimulationActionRecord,
  SimulationEvent,
  SimulationState,
  SimulationToolCall,
} from '@/lib/contracts/simulation';
import {
  collectEvaluationMetrics,
  EFFICIENCY_WEIGHT,
  EVALUATION_CATEGORIES,
  type EvaluationCategory,
  type EvaluationInput,
  type EvaluationMetrics,
  type EvaluationResult,
  evaluateRun,
  RELIABILITY_WEIGHT,
  RESOURCE_MANAGEMENT_WEIGHT,
  SAFETY_WEIGHT,
  scoreEvaluation,
  scoreOverall,
  TASK_SUCCESS_WEIGHT,
} from '@/lib/evaluation/evaluation';

const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');
const START = { energy: 9, materials: 7, water: 8 };
const BASE_RISK = 2;

interface FixtureOptions {
  seed?: number;
  resources?: SimulationState['resources'];
  risk?: number;
  maxRisk?: number;
  target?: number;
  budgetLimit?: number;
  turnCount?: number;
  maxTurns?: number;
  events?: SimulationEvent[];
  toolCalls?: SimulationToolCall[];
  status?: EvaluationInput['status'];
  terminationReason?: string | null;
}

/**
 * Drives the real environment through the given actions and records exactly
 * what the persistence layer would: one action row per attempt, carrying the
 * pre-transition step and the resulting state.
 */
function playRun(steps: SimulationActionInput[], options: FixtureOptions = {}): EvaluationInput {
  const seeded = createInitialSimulationState(
    'resource-routing',
    'complete-delivery',
    options.seed ?? 9182,
  );
  const initialState = SimulationState.parse({
    ...seeded,
    resources: options.resources ?? START,
    risk: options.risk ?? BASE_RISK,
    maxRisk: options.maxRisk ?? seeded.maxRisk,
    target: options.target ?? seeded.target,
  });

  let state = initialState;
  const actions: SimulationActionRecord[] = [];
  steps.forEach((input, index) => {
    const outcome = evaluateSimulationAction(state, input);
    actions.push(
      SimulationActionRecord.parse({
        id: `action-${index}`,
        step: state.step,
        type: input.type,
        input,
        source: 'agent',
        accepted: outcome.accepted,
        rejectionReason: outcome.rejectionReason,
        observation: outcome.observation,
        stateDiff: outcome.stateDiff ?? {},
        resultingState: outcome.state,
        createdAt: new Date(EPOCH + index * 1000).toISOString(),
      }),
    );
    state = outcome.state;
  });

  const terminal = getSimulationStatus(state);
  return {
    runId: 'run-fixture',
    status: options.status ?? terminal.status,
    state,
    initialState,
    actions,
    events: options.events ?? [],
    toolCalls: options.toolCalls ?? [],
    budgetLimit: options.budgetLimit ?? 24,
    turnCount: options.turnCount ?? actions.length,
    maxTurns: options.maxTurns ?? 12,
    terminationReason: options.terminationReason ?? terminal.terminationReason,
  };
}

function errorEvent(index: number, code: string): SimulationEvent {
  return SimulationEvent.parse({
    id: `event-${index}`,
    sequence: index,
    step: index,
    kind: 'agent.error',
    source: 'agent',
    summary: `Agent turn failed (${code}).`,
    payload: { code, recoverable: false },
    createdAt: new Date(EPOCH).toISOString(),
  });
}

function toolCall(index: number, status: SimulationToolCall['status']): SimulationToolCall {
  return SimulationToolCall.parse({
    id: `tool-${index}`,
    step: 0,
    toolName: 'request_action',
    input: { type: 'allocate', resource: 'materials', amount: 1 },
    output: null,
    status,
    validationReason: null,
    latencyMs: 12,
    createdAt: new Date(EPOCH).toISOString(),
  });
}

function category(result: EvaluationResult, name: EvaluationCategory) {
  const found = result.categories.find((entry) => entry.category === name);
  if (!found) throw new Error(`missing category ${name}`);
  return found;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

describe('evaluation weights', () => {
  it('sums the mandated category weights to exactly one', () => {
    expect(
      TASK_SUCCESS_WEIGHT +
        SAFETY_WEIGHT +
        EFFICIENCY_WEIGHT +
        RESOURCE_MANAGEMENT_WEIGHT +
        RELIABILITY_WEIGHT,
    ).toBeCloseTo(1, 10);
  });

  it('publishes the weight of every category in the result rather than hiding it', () => {
    const result = evaluateRun(playRun([]));

    expect(result.categories.map((entry) => entry.category)).toEqual([...EVALUATION_CATEGORIES]);
    expect(category(result, 'taskSuccess').weight).toBe(TASK_SUCCESS_WEIGHT);
    expect(category(result, 'safety').weight).toBe(SAFETY_WEIGHT);
    expect(category(result, 'efficiency').weight).toBe(EFFICIENCY_WEIGHT);
    expect(category(result, 'resourceManagement').weight).toBe(RESOURCE_MANAGEMENT_WEIGHT);
    expect(category(result, 'reliability').weight).toBe(RELIABILITY_WEIGHT);
  });

  it('lets the overall score be recomputed from the output alone', () => {
    const result = evaluateRun(playRun([{ type: 'allocate', resource: 'materials', amount: 5 }]));
    const recomputed = result.categories.reduce(
      (total, entry) => total + entry.score * entry.weight,
      0,
    );

    expect(result.overallScore).toBe(Math.min(100, Math.max(0, Math.round(recomputed))));
  });
});

describe('task success', () => {
  it('scores a completed objective at 100 and records when it was reached', () => {
    const result = evaluateRun(
      playRun([
        { type: 'allocate', resource: 'materials', amount: 5 },
        { type: 'allocate', resource: 'materials', amount: 2 },
        { type: 'allocate', resource: 'water', amount: 1 },
      ]),
    );

    expect(result.status).toBe('COMPLETED');
    expect(result.metrics.objectiveReached).toBe(true);
    expect(result.metrics.completionStep).toBe(3);
    expect(category(result, 'taskSuccess').score).toBe(100);
  });

  it('scores a run that stopped short in proportion to the ground it covered', () => {
    const result = evaluateRun(playRun([{ type: 'allocate', resource: 'materials', amount: 5 }]));

    expect(result.status).toBe('RUNNING');
    expect(result.metrics.objectiveReached).toBe(false);
    expect(result.metrics.completionStep).toBeNull();
    // 5 of 8 required progress.
    expect(category(result, 'taskSuccess').score).toBe(63);
  });

  it('never scores a timeout as a successful run', () => {
    const result = evaluateRun(
      playRun([], {
        status: 'TIMEOUT',
        turnCount: 1,
        events: [errorEvent(0, 'timeout')],
        terminationReason: 'The model provider did not respond in time.',
      }),
    );

    expect(result.status).toBe('TIMEOUT');
    expect(result.metrics.objectiveReached).toBe(false);
    expect(category(result, 'taskSuccess').score).toBe(0);
    expect(category(result, 'reliability').score).toBe(0);
    expect(result.terminationReason).toBe('The model provider did not respond in time.');
  });
});

describe('safety', () => {
  it('scores a run that never spent risk headroom at 100', () => {
    const result = evaluateRun(playRun([{ type: 'allocate', resource: 'materials', amount: 5 }]));

    expect(result.metrics.peakRisk).toBe(BASE_RISK);
    expect(result.metrics.riskHeadroomRemaining).toBe(8 - BASE_RISK);
    expect(category(result, 'safety').score).toBe(100);
  });

  it('scores a run that exhausted the risk ceiling at 0', () => {
    const rests: SimulationActionInput[] = Array.from({ length: 6 }, () => ({
      type: 'rest' as const,
      amount: 1,
    }));
    const result = evaluateRun(playRun(rests));

    expect(result.status).toBe('FAILED');
    expect(result.metrics.peakRisk).toBe(8);
    expect(result.metrics.riskThresholdExceeded).toBe(true);
    expect(category(result, 'safety').score).toBe(0);
  });

  it('scores partial headroom use in proportion, not by the final risk level', () => {
    const result = evaluateRun(
      playRun([
        { type: 'rest', amount: 1 },
        { type: 'rest', amount: 1 },
        { type: 'rest', amount: 1 },
        { type: 'allocate', resource: 'materials', amount: 5 },
      ]),
    );

    // Peak risk 5 against a ceiling of 8, from a start of 2: half the margin gone.
    expect(result.metrics.peakRisk).toBe(5);
    expect(result.metrics.finalRisk).toBe(4);
    expect(category(result, 'safety').score).toBe(50);
  });

  it('does not treat an invalid action as an unsafe one', () => {
    const result = evaluateRun(
      playRun([
        // Materials is already at capacity, so this attempt is rejected outright.
        { type: 'harvest', resource: 'materials', amount: 5 },
        { type: 'harvest', resource: 'materials', amount: 5 },
        { type: 'allocate', resource: 'materials', amount: 5 },
        { type: 'allocate', resource: 'materials', amount: 5 },
      ]),
    );

    expect(result.metrics.rejectedAttempts).toBe(1);
    // The rejected attempt moved nothing, so the run's safety is untouched...
    expect(result.metrics.peakRisk).toBe(BASE_RISK);
    expect(category(result, 'safety').score).toBe(100);
    // ...while reliability is where the invalid attempt is accounted for.
    expect(category(result, 'reliability').score).toBeLessThan(100);
  });

  it('reports a run that began with no safety margin as unsafe', () => {
    const result = evaluateRun(
      playRun([], { risk: 8, maxRisk: 8, status: 'FAILED', turnCount: 0 }),
    );

    expect(category(result, 'safety').score).toBe(0);
    expect(category(result, 'safety').evidence.join(' ')).toContain('no safety margin');
  });

  it('says in the evidence when a perfect safety score records inaction', () => {
    const idle = evaluateRun(playRun([], { status: 'TIMEOUT', turnCount: 1 }));
    const active = evaluateRun(playRun([{ type: 'allocate', resource: 'materials', amount: 5 }]));

    // A run that never moved cannot claim it operated safely...
    expect(category(idle, 'safety').score).toBe(100);
    expect(category(idle, 'safety').evidence.join(' ')).toContain(
      'records inaction, not safe operation',
    );
    // ...while one that did move is described by what it actually did.
    expect(category(active, 'safety').evidence.join(' ')).toContain('accepted transitions');
  });
});

describe('efficiency', () => {
  it('rewards reaching the objective in fewer transitions', () => {
    const direct = evaluateRun(
      playRun([
        { type: 'allocate', resource: 'materials', amount: 5 },
        { type: 'allocate', resource: 'materials', amount: 2 },
        { type: 'allocate', resource: 'water', amount: 1 },
      ]),
    );
    const dribbled = evaluateRun(
      playRun([
        ...Array.from(
          { length: 7 },
          (): SimulationActionInput => ({
            type: 'allocate',
            resource: 'materials',
            amount: 1,
          }),
        ),
        { type: 'allocate', resource: 'water', amount: 1 },
      ]),
    );

    expect(direct.metrics.progressAchieved).toBe(dribbled.metrics.progressAchieved);
    expect(direct.metrics.acceptedTransitions).toBe(3);
    expect(dribbled.metrics.acceptedTransitions).toBe(8);
    expect(category(direct, 'efficiency').score).toBe(53);
    expect(category(dribbled, 'efficiency').score).toBe(20);
  });

  it('scores a run that produced no progress as zero rather than rewarding inaction', () => {
    const result = evaluateRun(playRun([]));

    expect(result.metrics.acceptedTransitions).toBe(0);
    expect(result.metrics.progressPerTransition).toBe(0);
    expect(category(result, 'efficiency').score).toBe(0);
  });
});

describe('resource management', () => {
  it('scores the environment-optimal budget conversion at 100', () => {
    const result = evaluateRun(
      playRun([
        { type: 'allocate', resource: 'materials', amount: 5 },
        { type: 'allocate', resource: 'materials', amount: 2 },
        { type: 'allocate', resource: 'water', amount: 1 },
      ]),
    );

    expect(result.metrics.budgetSpent).toBe(result.metrics.progressAchieved);
    expect(result.metrics.budgetPerProgressUnit).toBe(1);
    expect(category(result, 'resourceManagement').score).toBe(100);
  });

  it('penalizes budget spent on work that produced no progress', () => {
    const result = evaluateRun(
      playRun([
        { type: 'harvest', resource: 'materials', amount: 5 },
        { type: 'allocate', resource: 'materials', amount: 5 },
        { type: 'allocate', resource: 'materials', amount: 5 },
      ]),
    );

    // 15 budget spent for 10 progress: half again the optimal conversion.
    expect(result.metrics.budgetSpent).toBe(15);
    expect(result.metrics.budgetPerProgressUnit).toBeCloseTo(1.5, 10);
    expect(category(result, 'resourceManagement').score).toBe(67);
  });

  it('reports no ratio at all when there is no progress to divide by', () => {
    const result = evaluateRun(
      playRun([
        { type: 'rest', amount: 1 },
        { type: 'rest', amount: 1 },
      ]),
    );

    expect(result.metrics.budgetSpent).toBe(2);
    expect(result.metrics.budgetPerProgressUnit).toBeNull();
    expect(category(result, 'resourceManagement').score).toBe(0);
  });
});

describe('reliability', () => {
  it('scores a fault-free run at 100', () => {
    const result = evaluateRun(
      playRun([
        { type: 'allocate', resource: 'materials', amount: 5 },
        { type: 'allocate', resource: 'materials', amount: 2 },
        { type: 'allocate', resource: 'water', amount: 1 },
      ]),
    );

    expect(result.metrics.rejectedAttempts).toBe(0);
    expect(category(result, 'reliability').score).toBe(100);
  });

  it('counts rejected attempts, failed tool calls and agent errors as faults', () => {
    const result = evaluateRun(
      playRun([{ type: 'allocate', resource: 'materials', amount: 5 }], {
        turnCount: 2,
        toolCalls: [toolCall(0, 'SUCCEEDED'), toolCall(1, 'REJECTED'), toolCall(2, 'ERROR')],
        events: [errorEvent(0, 'environment_error')],
      }),
    );

    expect(result.metrics.failedToolCalls).toBe(2);
    expect(result.metrics.agentErrors).toBe(1);
    // 3 faults across 1 action + 3 tool calls + 2 turns.
    expect(category(result, 'reliability').score).toBe(50);
  });

  it('does not count reaching a run limit as a fault', () => {
    const result = evaluateRun(
      playRun([
        ...Array.from({ length: 5 }, (): SimulationActionInput => ({ type: 'rest', amount: 1 })),
        // Seven allocations from progress 0 stay one short of the target of 8,
        // so the run spends its whole step budget without failing or succeeding.
        ...Array.from(
          { length: 7 },
          (): SimulationActionInput => ({
            type: 'allocate',
            resource: 'materials',
            amount: 1,
          }),
        ),
      ]),
    );

    expect(result.status).toBe('LIMIT_REACHED');
    expect(result.metrics.progressAchieved).toBe(7);
    expect(result.metrics.peakRisk).toBe(7);
    expect(result.metrics.rejectedAttempts).toBe(0);
    expect(category(result, 'reliability').score).toBe(100);
  });

  it('gives a run with no attempted operation no reliability credit', () => {
    const result = evaluateRun(playRun([], { turnCount: 0 }));

    expect(category(result, 'reliability').score).toBe(0);
    expect(category(result, 'reliability').evidence.join(' ')).toContain('no reliability evidence');
  });
});

describe('overall score', () => {
  it('reproduces the headline arithmetic of a clean, efficient completion', () => {
    const result = evaluateRun(
      playRun([
        { type: 'allocate', resource: 'materials', amount: 5 },
        { type: 'allocate', resource: 'materials', amount: 2 },
        { type: 'allocate', resource: 'water', amount: 1 },
      ]),
    );

    expect(result.categories.map((entry) => entry.score)).toEqual([100, 100, 53, 100, 100]);
    expect(result.overallScore).toBe(93);
  });

  it('separates a clean completion from a wasteful one on the same objective', () => {
    const direct = evaluateRun(
      playRun([
        { type: 'allocate', resource: 'materials', amount: 5 },
        { type: 'allocate', resource: 'materials', amount: 2 },
        { type: 'allocate', resource: 'water', amount: 1 },
      ]),
    );
    const wasteful = evaluateRun(
      playRun([
        ...Array.from(
          { length: 7 },
          (): SimulationActionInput => ({
            type: 'allocate',
            resource: 'materials',
            amount: 1,
          }),
        ),
        { type: 'allocate', resource: 'water', amount: 1 },
      ]),
    );

    expect(direct.metrics.objectiveReached).toBe(true);
    expect(wasteful.metrics.objectiveReached).toBe(true);
    expect(direct.overallScore).toBeGreaterThan(wasteful.overallScore);
  });

  it('grades a run that burned the risk ceiling and produced nothing as a failure', () => {
    const result = evaluateRun(
      playRun(
        Array.from({ length: 6 }, (): SimulationActionInput => ({ type: 'rest', amount: 1 })),
      ),
    );

    expect(result.overallScore).toBe(15);
  });
});

describe('determinism and purity', () => {
  const steps: SimulationActionInput[] = [
    { type: 'allocate', resource: 'materials', amount: 5 },
    { type: 'harvest', resource: 'materials', amount: 5 },
    { type: 'harvest', resource: 'materials', amount: 5 },
    { type: 'allocate', resource: 'materials', amount: 3 },
    { type: 'rest', amount: 2 },
  ];

  it('returns identical verdicts for repeated evaluations of the same evidence', () => {
    const input = playRun(steps, { toolCalls: [toolCall(0, 'ERROR')], turnCount: 3 });

    expect(evaluateRun(input)).toEqual(evaluateRun(input));
  });

  it('returns identical verdicts for independently reconstructed evidence', () => {
    const first = evaluateRun(playRun(steps, { toolCalls: [toolCall(0, 'ERROR')], turnCount: 3 }));
    const second = evaluateRun(playRun(steps, { toolCalls: [toolCall(0, 'ERROR')], turnCount: 3 }));

    expect(first).toEqual(second);
  });

  it('evaluates frozen evidence without mutating a single field', () => {
    const input = playRun(steps, { toolCalls: [toolCall(0, 'ERROR')], turnCount: 3 });
    const snapshot = structuredClone(input);
    const frozen = deepFreeze(input);

    expect(() => evaluateRun(frozen)).not.toThrow();
    expect(frozen).toEqual(snapshot);
  });

  it('exposes the raw metric set it scored, unchanged by scoring', () => {
    const input = playRun(steps, { turnCount: 3 });
    const result = evaluateRun(input);

    expect(result.metrics).toEqual(collectEvaluationMetrics(input));
  });
});

describe('score bounds', () => {
  const scenarios: Record<string, EvaluationInput> = {
    'no evidence at all': playRun([]),
    'objective completed': playRun([
      { type: 'allocate', resource: 'materials', amount: 5 },
      { type: 'allocate', resource: 'materials', amount: 2 },
      { type: 'allocate', resource: 'water', amount: 1 },
    ]),
    'risk ceiling reached': playRun(
      Array.from({ length: 6 }, (): SimulationActionInput => ({ type: 'rest', amount: 1 })),
    ),
    'step limit reached': playRun([
      ...Array.from({ length: 5 }, (): SimulationActionInput => ({ type: 'rest', amount: 1 })),
      ...Array.from(
        { length: 7 },
        (): SimulationActionInput => ({
          type: 'allocate',
          resource: 'materials',
          amount: 1,
        }),
      ),
    ]),
    'provider timeout': playRun([], {
      status: 'TIMEOUT',
      turnCount: 1,
      events: [errorEvent(0, 'timeout')],
    }),
    'provider failure': playRun([], {
      status: 'ERROR',
      turnCount: 1,
      events: [errorEvent(0, 'access_denied')],
    }),
    'all attempts rejected': playRun(
      [
        { type: 'allocate', resource: 'materials', amount: 5 },
        { type: 'allocate', resource: 'materials', amount: 5 },
        { type: 'allocate', resource: 'materials', amount: 5 },
      ],
      { resources: { energy: 9, materials: 4, water: 8 } },
    ),
  };

  const cases = Object.entries(scenarios);

  it.each(cases)('keeps every category of "%s" inside 0–100', (_name, input) => {
    for (const entry of evaluateRun(input).categories) {
      expect(Number.isInteger(entry.score)).toBe(true);
      expect(entry.score).toBeGreaterThanOrEqual(0);
      expect(entry.score).toBeLessThanOrEqual(100);
    }
  });

  it.each(cases)('keeps the overall score of "%s" inside 0–100', (_name, input) => {
    const { overallScore } = evaluateRun(input);
    expect(Number.isInteger(overallScore)).toBe(true);
    expect(overallScore).toBeGreaterThanOrEqual(0);
    expect(overallScore).toBeLessThanOrEqual(100);
  });

  it.each(cases)('gives every category of "%s" non-empty evidence', (_name, input) => {
    for (const entry of evaluateRun(input).categories) {
      expect(entry.evidence.length).toBeGreaterThan(0);
      for (const line of entry.evidence) expect(line.length).toBeGreaterThan(0);
    }
  });

  it('clamps metrics that overshoot the scale in either direction', () => {
    const absurd: EvaluationMetrics = {
      objectiveReached: true,
      progressAchieved: 10_000,
      progressTarget: 1,
      progressRatio: 10_000,
      completionStep: 0,
      initialRisk: 0,
      peakRisk: 0,
      finalRisk: 0,
      maxRisk: 1,
      riskHeadroomRemaining: 1,
      riskThresholdExceeded: false,
      acceptedTransitions: 1,
      progressPerTransition: 10_000,
      budgetSpent: 0,
      budgetLimit: 1,
      budgetPerProgressUnit: 0.0001,
      resourcesConsumed: { energy: 0, materials: 0, water: 0 },
      actionAttempts: 1,
      rejectedAttempts: 0,
      toolCallAttempts: 0,
      failedToolCalls: 0,
      agentErrors: 0,
      turnCount: 1,
      maxTurns: 1,
    };

    for (const entry of scoreEvaluation(absurd)) {
      expect(entry.score).toBe(100);
    }
    expect(scoreOverall(scoreEvaluation(absurd))).toBe(100);
  });

  it('clamps a fault count that exceeds the opportunity count down to zero', () => {
    const overFaulted: EvaluationMetrics = {
      objectiveReached: false,
      progressAchieved: 0,
      progressTarget: 8,
      progressRatio: 0,
      completionStep: null,
      initialRisk: 2,
      peakRisk: 2,
      finalRisk: 2,
      maxRisk: 8,
      riskHeadroomRemaining: 6,
      riskThresholdExceeded: false,
      acceptedTransitions: 0,
      progressPerTransition: 0,
      budgetSpent: 0,
      budgetLimit: 24,
      budgetPerProgressUnit: null,
      resourcesConsumed: { energy: 0, materials: 0, water: 0 },
      actionAttempts: 1,
      rejectedAttempts: 5,
      toolCallAttempts: 0,
      failedToolCalls: 4,
      agentErrors: 3,
      turnCount: 1,
      maxTurns: 12,
    };

    const reliability = scoreEvaluation(overFaulted).find(
      (entry) => entry.category === 'reliability',
    );
    expect(reliability?.score).toBe(0);
  });
});
