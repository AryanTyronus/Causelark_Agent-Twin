// This module is deliberately free of server, Prisma, and provider imports.

import { z } from 'zod';

export const SimulationEnvironmentKey = z.enum(['resource-routing', 'trading-10k']);
export const SimulationObjectiveKey = z.enum([
  'complete-delivery',
  'preserve-reserve',
  'stabilise-grid',
  'grow-capital-disciplined',
]);
/**
 * Every action either environment's contract admits.
 *
 * The vocabulary is one enum rather than one per environment because an action
 * record, a permission list and a scenario's revocation list all name an action
 * type, and a persisted run has to be readable without first resolving which
 * environment wrote it. Each environment validates against its own narrower
 * subset — see `ResourceActionInput` and `TradingActionInput` below — so adding
 * the trading verbs here does not widen what the resource-routing validator
 * accepts.
 */
export const SimulationActionType = z.enum(['harvest', 'allocate', 'rest', 'buy', 'sell', 'hold']);
export const SimulationResource = z.enum(['energy', 'materials', 'water']);
/** The instruments the simulated market publishes. Never a real ticker. */
export const SimulationAsset = z.enum(['ALPHA', 'BETA', 'GAMMA', 'DELTA']);
/** The actions the resource-routing environment validates. */
export const ResourceActionType = z.enum(['harvest', 'allocate', 'rest']);
/** The actions the trading environment validates. */
export const TradingActionType = z.enum(['buy', 'sell', 'hold']);
/**
 * The objectives each environment publishes.
 *
 * Kept as data beside the vocabulary so an environment's objective list is
 * stated once, in the contract both the environment and its catalogue read.
 */
export const RESOURCE_OBJECTIVE_KEYS = [
  'complete-delivery',
  'preserve-reserve',
  'stabilise-grid',
] as const;
export const TRADING_OBJECTIVE_KEYS = ['grow-capital-disciplined'] as const;
export const ResourceObjectiveKey = z.enum(RESOURCE_OBJECTIVE_KEYS);
export const TradingObjectiveKey = z.enum(TRADING_OBJECTIVE_KEYS);
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

//
// The trading environment's own state. This is an entirely simulated market:
// there is no brokerage, no order, no account and no money behind it, and no
// value here is ever sent anywhere. It is an evaluation substrate for agent
// behaviour.
//
// Every monetary quantity is an integer number of cents and every quantity is a
// whole number of shares, so portfolio arithmetic is exact integer arithmetic
// and cannot drift between two runs of the same trajectory. Nothing derived is
// stored: equity, exposure, concentration, unrealized P&L and drawdown are all
// pure functions of the fields below, which is what keeps a persisted state
// from ever holding a number that disagrees with its own components.
//

/** One holding. A position of zero shares is carried so the asset list is total. */
export const TradingPosition = z.object({
  asset: SimulationAsset,
  quantity: z.number().int().min(0),
  /** Weighted average entry price in cents per share; 0 while nothing is held. */
  averageEntryPrice: z.number().int().min(0),
});

/** The current price of one instrument, in cents per share. */
export const TradingQuote = z.object({
  asset: SimulationAsset,
  price: z.number().int().positive(),
});

/**
 * The market model's parameters. These are the only trading fields a scenario
 * perturbs — the seeded price path is a pure function of the seed, the asset,
 * the step and these, so a condition changes the market by changing the model
 * it is generated from rather than by rewriting prices after the fact.
 */
export const TradingParameters = z.object({
  /** Per-step price volatility, in basis points of price. */
  volatilityBps: z.number().int().nonnegative(),
  /** Per-step drift, in basis points. Negative is a falling market. */
  driftBps: z.number().int(),
  /** Round-trip execution cost, in basis points of notional. */
  spreadBps: z.number().int().nonnegative(),
  /** Largest single order the simulated market will fill, in shares. */
  maxOrderQuantity: z.number().int().positive(),
  /** Ceiling on one position's share of equity, in basis points. */
  maxConcentrationBps: z.number().int().min(1).max(10000),
  /** Ceiling on invested value as a share of equity, in basis points. */
  maxExposureBps: z.number().int().min(1).max(10000),
  /** The step a scheduled shock lands on, or `null` when the market has none. */
  shockStep: z.number().int().nonnegative().nullable(),
  /** How far the shocked asset moves at that step, in basis points. Always down. */
  shockBps: z.number().int().nonnegative(),
  /** Which instrument the shock lands on. */
  shockAsset: SimulationAsset,
});

export const TradingState = z.object({
  /** The run's own capital basis in cents. Always $10,000 — recorded, not implied. */
  initialCapital: z.number().int().positive(),
  cash: z.number().int().min(0),
  /** One entry per published asset, in the market's own declared order. */
  positions: z.array(TradingPosition),
  /** The latest observable price per asset. Never a future one. */
  quotes: z.array(TradingQuote),
  /** Highest equity in cents seen so far — the reference drawdown is measured from. */
  peakEquity: z.number().int().min(0),
  /** P&L booked by closed trades, in cents. May be negative. */
  realizedPnl: z.number().int(),
  /** Execution costs paid so far, in cents. */
  transactionCosts: z.number().int().min(0),
  /** Shares bought and sold so far, for turnover reporting. */
  tradedQuantity: z.number().int().min(0),
  parameters: TradingParameters,
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
  /**
   * The trading environment's state, or `null` for every other environment.
   *
   * Nullable and defaulted rather than required so a resource-routing state
   * parses byte for byte as it did before this field existed, and so a stored
   * run written by an earlier build still reads back.
   */
  trading: TradingState.nullable().default(null),
});
/**
 * How large a single action may be, in units of whatever is being moved: one
 * resource unit in the resource-routing environment, one share in the trading
 * one.
 *
 * The two environments need different ceilings and this is not a compromise
 * between them. A resource action moves at most five of a stock whose capacity
 * is twelve, so five is a rule about that world. A trading order moves shares of
 * a $10,000 portfolio, where five shares is $125 — an order size that could not
 * deploy the capital inside a twelve-step run at all. Each environment therefore
 * carries its own bound below, and the record-level schema carries the wider of
 * the two so that a persisted action written by either world parses.
 */
export const SIMULATION_MAX_ACTION_AMOUNT = 5;

/**
 * The largest order the trading environment's request schema admits.
 *
 * Larger than the market's own fill cap on purpose, so an oversized order is
 * diagnosed as `ORDER_TOO_LARGE` — a well-formed request the market refused —
 * rather than as a malformed one. The two faults have different causes and an
 * agent that conflates them will not learn the right lesson from either.
 */
export const SIMULATION_MAX_TRADING_ACTION_SHARES = 200;

const actionAmount = z.number().int().min(1).max(SIMULATION_MAX_ACTION_AMOUNT);
const tradingActionAmount = z.number().int().min(1).max(SIMULATION_MAX_TRADING_ACTION_SHARES);

/**
 * What the resource-routing validator accepts.
 *
 * Narrower than the record-level schema below, and deliberately frozen: this is
 * the shape the resource-routing tool advertises to a model and parses a request
 * with, so adding the trading verbs to the shared vocabulary must not widen what
 * this environment will take. `buy` reaches this schema and is refused by it.
 */
export const ResourceActionInput = z.object({
  type: ResourceActionType,
  resource: SimulationResource.optional(),
  amount: actionAmount,
});

/**
 * What the trading validator accepts.
 *
 * `hold` names no asset for the same reason `rest` names no resource: it acts on
 * the portfolio as a whole, so requiring an instrument would let two requests
 * that mean the same thing look like two different choices.
 */
export const TradingActionInput = z.object({
  type: TradingActionType,
  asset: SimulationAsset.optional(),
  amount: tradingActionAmount,
});

/**
 * The record-level action shape: what a persisted action row, a permission list
 * and a counterfactual branch carry. A superset of both environments' inputs, so
 * an action recorded before the trading vocabulary existed still parses.
 *
 * Wide on both axes — every verb, either noun, the larger amount bound — because
 * its job is to read back what was written, not to decide what is allowed. What
 * is allowed is each environment's own narrower schema above.
 */
export const SimulationActionInput = z.object({
  type: SimulationActionType,
  resource: SimulationResource.optional(),
  asset: SimulationAsset.optional(),
  amount: tradingActionAmount,
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
export type SimulationAsset = z.infer<typeof SimulationAsset>;
export type ResourceActionType = z.infer<typeof ResourceActionType>;
export type TradingActionType = z.infer<typeof TradingActionType>;
export type ResourceObjectiveKey = z.infer<typeof ResourceObjectiveKey>;
export type TradingObjectiveKey = z.infer<typeof TradingObjectiveKey>;
export type TradingPosition = z.infer<typeof TradingPosition>;
export type TradingQuote = z.infer<typeof TradingQuote>;
export type TradingParameters = z.infer<typeof TradingParameters>;
export type TradingState = z.infer<typeof TradingState>;
export type ResourceActionInput = z.infer<typeof ResourceActionInput>;
export type TradingActionInput = z.infer<typeof TradingActionInput>;
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
