import { z } from 'zod';
import { SimulationActionInput, SimulationState } from '@/lib/contracts/simulation';

/**
 * The tool names a turn's outcome may carry.
 *
 * Closed, and the union of every published environment's agent surface rather
 * than one world's. A closed vocabulary is what keeps an unrecognised tool name
 * out of the trace; a union is what lets a run of either world be persisted and
 * read back through the same record. Adding an environment means adding its
 * probes here, and a test asserts this list and the environments' declarations
 * agree — so a world cannot offer a tool its own trace cannot record.
 *
 * `request_action` is deliberately shared: both worlds request actions through
 * one tool, and the action's own schema is what differs between them.
 */
export const SimulationAgentToolName = z.enum([
  'observe_resources',
  'inspect_market',
  'inspect_portfolio',
  'request_action',
]);
export const SimulationAgentToolRequest = z.object({
  toolName: SimulationAgentToolName,
  input: z.record(z.string(), z.unknown()),
});
export const SimulationAgentToolOutcome = z.object({
  toolName: SimulationAgentToolName,
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum(['SUCCEEDED', 'REJECTED', 'ERROR']),
  validationReason: z.string().nullable(),
  /** Wall-clock duration of the tool execution, persisted on the tool-call record. */
  latencyMs: z.number().int().nonnegative().nullable().default(null),
  stateBefore: SimulationState,
  stateAfter: SimulationState,
});
export const SimulationAgentObservation = z.object({
  state: SimulationState,
  objective: z.string().min(1),
  availableActions: z.array(SimulationActionInput),
});
export const SimulationAgentFailure = z.object({
  code: z.enum([
    'MISSING_CONFIGURATION',
    'PROVIDER_ERROR',
    'TIMEOUT',
    'MALFORMED_TOOL_CALL',
    'ENVIRONMENT_ERROR',
  ]),
  message: z.string().min(1),
  recoverable: z.boolean(),
});
export const SimulationAgentMetadata = z.object({
  provider: z.string().min(1),
  requestStatus: z.enum(['started', 'completed', 'failed', 'timed_out']),
  latencyMs: z.number().int().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  safeError: z.string().nullable(),
});
export const SimulationAgentEventKind = z.enum([
  'turn_started',
  'observation',
  'tool_requested',
  'tool_result',
  'turn_completed',
  'failure',
]);

export type SimulationAgentToolName = z.infer<typeof SimulationAgentToolName>;
export type SimulationAgentToolOutcome = z.infer<typeof SimulationAgentToolOutcome>;
export type SimulationAgentObservation = z.infer<typeof SimulationAgentObservation>;
export type SimulationAgentFailure = z.infer<typeof SimulationAgentFailure>;
export type SimulationAgentMetadata = z.infer<typeof SimulationAgentMetadata>;
