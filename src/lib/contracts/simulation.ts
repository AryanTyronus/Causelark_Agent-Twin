// @polsia:user-owned — client/server contracts for the observable simulation.
// This module is deliberately free of server, Prisma, and provider imports.

import { z } from 'zod';

export const SimulationEnvironmentKey = z.enum(['resource-routing']);
export const SimulationObjectiveKey = z.enum([
  'complete-delivery',
  'preserve-reserve',
  'stabilise-grid',
]);
export const SimulationActionType = z.enum(['harvest', 'allocate', 'rest']);
export const SimulationResource = z.enum(['energy', 'materials', 'water']);
export const SimulationRunStatus = z.enum([
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'TIMEOUT',
  'LIMIT_REACHED',
  'ERROR',
]);
export const SimulationAgentStatus = z.enum([
  'READY',
  'THINKING',
  'ACTING',
  'WAITING',
  'COMPLETED',
  'FAILED',
  'RECOVERING',
]);
export const SimulationEventKind = z.enum([
  'simulation.started',
  'scenario.applied',
  'observation.created',
  'agent.turn.started',
  'agent.turn.completed',
  'tool.requested',
  'tool.result',
  'action.requested',
  'action.validated',
  'action.rejected',
  'state.changed',
  'task.progressed',
  'agent.error',
  'simulation.completed',
  'simulation.failed',
]);

export const SimulationOption = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
});
export const SimulationSeedOption = z.object({
  value: z.number().int().min(0).max(999999),
  label: z.string().min(1),
});
export const SimulationResourceDefinition = z.object({
  key: SimulationResource,
  label: z.string().min(1),
  description: z.string().min(1),
  startingRange: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]),
  capacity: z.number().int().positive(),
  harvestEnergyCost: z.number().int().nonnegative(),
  allocationValue: z.number().int().positive(),
});
export const SimulationTaskDefinition = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  resource: SimulationResource,
  requiredAmount: z.number().int().positive(),
});
export const SimulationConfiguration = z.object({
  budget: z.number().int().positive().max(100),
  maxSteps: z.number().int().positive().max(50),
  maxTurns: z.number().int().positive().max(30),
  toolTimeoutMs: z.number().int().positive().max(30000),
});
export const SimulationToolDefinition = z.object({
  name: z.enum(['observe_resources', 'request_action']),
  description: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});
export const SimulationOptions = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  environments: z.array(SimulationOption).min(1),
  objectives: z.array(SimulationOption).min(1),
  actions: z.array(SimulationOption).min(1),
  seeds: z.array(SimulationSeedOption).min(1),
  configuration: SimulationConfiguration,
  resources: z.array(SimulationResourceDefinition).min(1),
  tasks: z.array(SimulationTaskDefinition).min(1),
  constraints: z.array(z.string().min(1)).min(1),
  tools: z.array(SimulationToolDefinition).min(1),
});
/**
 * Identity of the scenario a run was created under, or `null` for a run created
 * without one. The version is recorded rather than resolved, so a run stays
 * attributable to the exact scenario definition that shaped it even after the
 * catalogue moves on.
 */
export const SimulationScenarioIdentity = z.object({
  id: z.string().min(1).max(64),
  version: z.number().int().positive(),
});
export const SimulationStartInput = z.object({
  environmentKey: SimulationEnvironmentKey,
  objectiveKey: SimulationObjectiveKey,
  seed: z.number().int().min(0).max(999999),
  configuration: SimulationConfiguration.partial().optional(),
  /** Scenario id resolved server-side against the scenario catalogue. */
  scenarioId: z.string().min(1).max(64).optional(),
});

export const SimulationResources = z.object({
  energy: z.number().int().min(0),
  materials: z.number().int().min(0),
  water: z.number().int().min(0),
});
export const SimulationTaskProgress = SimulationTaskDefinition.extend({
  progress: z.number().int().min(0),
  complete: z.boolean(),
});
export const SimulationState = z.object({
  environmentKey: SimulationEnvironmentKey,
  objectiveKey: SimulationObjectiveKey,
  seed: z.number().int().min(0).max(999999),
  step: z.number().int().min(0),
  maxSteps: z.number().int().positive(),
  resources: SimulationResources,
  capacity: z.number().int().positive(),
  progress: z.number().int().min(0),
  target: z.number().int().positive(),
  risk: z.number().int().min(0),
  maxRisk: z.number().int().positive(),
  budgetRemaining: z.number().int().min(0).default(24),
  budgetSpent: z.number().int().min(0).default(0),
  tasks: z.array(SimulationTaskProgress).default([]),
  permissions: z.array(z.string().min(1)).default(['harvest', 'allocate', 'rest']),
  constraints: z.array(z.string().min(1)).default([]),
  lastAction: SimulationActionType.nullable(),
  lastObservation: z.string().default('Initial observable state ready.'),
});
export const SimulationActionInput = z.object({
  type: SimulationActionType,
  resource: SimulationResource.optional(),
  amount: z.number().int().min(1).max(5),
});

export const SimulationRunSummary = z.object({
  id: z.string().min(1),
  environmentKey: SimulationEnvironmentKey,
  objectiveKey: SimulationObjectiveKey,
  seed: z.number().int().min(0).max(999999),
  status: SimulationRunStatus,
  agentStatus: SimulationAgentStatus,
  step: z.number().int().min(0),
  maxSteps: z.number().int().positive(),
  budgetRemaining: z.number().int().min(0),
  scenario: SimulationScenarioIdentity.nullable().default(null),
  terminationReason: z.string().nullable(),
  failureDetails: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const SimulationActionRecord = z.object({
  id: z.string().min(1),
  step: z.number().int().min(0),
  type: SimulationActionType,
  input: SimulationActionInput,
  source: z.enum(['manual', 'agent']).default('manual'),
  accepted: z.boolean(),
  rejectionReason: z.string().nullable(),
  observation: z.string(),
  stateDiff: z.record(z.string(), z.unknown()).default({}),
  resultingState: SimulationState,
  createdAt: z.string().datetime(),
});
export const SimulationEvent = z.object({
  id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  kind: SimulationEventKind,
  source: z.enum(['system', 'agent', 'tool', 'operator']),
  summary: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export const SimulationToolCall = z.object({
  id: z.string().min(1),
  step: z.number().int().nonnegative(),
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum(['REQUESTED', 'SUCCEEDED', 'REJECTED', 'ERROR']),
  validationReason: z.string().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime(),
});
export const SimulationRunDetail = SimulationRunSummary.extend({
  state: SimulationState,
  configuration: SimulationConfiguration,
  tasks: z.array(SimulationTaskProgress),
  constraints: z.array(z.string()),
  actions: z.array(SimulationActionRecord),
  events: z.array(SimulationEvent).default([]),
  toolCalls: z.array(SimulationToolCall).default([]),
});
export const SimulationRunList = z.object({ runs: z.array(SimulationRunSummary) });
export const SimulationActionResult = z.object({
  run: SimulationRunDetail,
  action: SimulationActionRecord,
});
export const SimulationAgentStepResult = z.object({
  run: SimulationRunDetail,
  turn: z.object({
    status: z.enum(['COMPLETED', 'RECOVERING', 'FAILED']),
    provider: z.string().min(1),
    toolCalls: z.number().int().nonnegative(),
    acceptedActions: z.number().int().nonnegative(),
    safeError: z.string().nullable(),
  }),
});
export const SimulationMetrics = z.object({
  outcome: SimulationRunStatus,
  taskSuccess: z.boolean(),
  steps: z.number().int().nonnegative(),
  successfulActions: z.number().int().nonnegative(),
  rejectedActions: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  invalidActionRate: z.number().min(0).max(1),
  budgetUsed: z.number().int().nonnegative(),
  budgetLimit: z.number().int().positive(),
  resourcesUsed: SimulationResources,
  failures: z.array(z.string()),
  terminationReason: z.string().nullable(),
});
export const SimulationMetricsEnvelope = z.object({
  metrics: SimulationMetrics,
  inProgress: z.boolean(),
});
export const SimulationEventsEnvelope = z.object({
  events: z.array(SimulationEvent),
  nextCursor: z.number().int().nonnegative().nullable(),
});
export const SimulationStateDiff = z.object({
  field: z.string().min(1),
  before: z.unknown(),
  after: z.unknown(),
});
export const SimulationReplayFrame = z.object({
  index: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  eventId: z.string().min(1).nullable(),
  label: z.string().min(1),
  state: SimulationState,
  diffs: z.array(SimulationStateDiff),
  important: z.boolean(),
});
export const SimulationReplay = z.object({
  frames: z.array(SimulationReplayFrame),
  importantFrameIndexes: z.array(z.number().int().nonnegative()),
  selectedFrame: z.number().int().nonnegative(),
});
export const SimulationRerunResult = z.object({
  run: SimulationRunDetail,
  determinism: z.object({
    environmentInitialStateMatches: z.boolean(),
    transitionEngine: z.literal('deterministic'),
    providerDecisionPath: z.literal('variable'),
  }),
});

export type SimulationEnvironmentKey = z.infer<typeof SimulationEnvironmentKey>;
export type SimulationObjectiveKey = z.infer<typeof SimulationObjectiveKey>;
export type SimulationActionType = z.infer<typeof SimulationActionType>;
export type SimulationResource = z.infer<typeof SimulationResource>;
export type SimulationOptions = z.infer<typeof SimulationOptions>;
export type SimulationConfiguration = z.infer<typeof SimulationConfiguration>;
export type SimulationStartInput = z.infer<typeof SimulationStartInput>;
export type SimulationScenarioIdentity = z.infer<typeof SimulationScenarioIdentity>;
export type SimulationResources = z.infer<typeof SimulationResources>;
export type SimulationTaskProgress = z.infer<typeof SimulationTaskProgress>;
export type SimulationState = z.infer<typeof SimulationState>;
export type SimulationActionInput = z.infer<typeof SimulationActionInput>;
export type SimulationRunStatus = z.infer<typeof SimulationRunStatus>;
export type SimulationAgentStatus = z.infer<typeof SimulationAgentStatus>;
export type SimulationRunSummary = z.infer<typeof SimulationRunSummary>;
export type SimulationActionRecord = z.infer<typeof SimulationActionRecord>;
export type SimulationEvent = z.infer<typeof SimulationEvent>;
export type SimulationToolCall = z.infer<typeof SimulationToolCall>;
export type SimulationRunDetail = z.infer<typeof SimulationRunDetail>;
export type SimulationActionResult = z.infer<typeof SimulationActionResult>;
export type SimulationAgentStepResult = z.infer<typeof SimulationAgentStepResult>;
export type SimulationMetrics = z.infer<typeof SimulationMetrics>;
export type SimulationEventsEnvelope = z.infer<typeof SimulationEventsEnvelope>;
export type SimulationReplayFrame = z.infer<typeof SimulationReplayFrame>;
export type SimulationReplay = z.infer<typeof SimulationReplay>;
export type SimulationRerunResult = z.infer<typeof SimulationRerunResult>;
