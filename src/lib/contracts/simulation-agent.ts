// @polsia:user-owned — safe, observable agent boundary.

import { z } from 'zod';
import { SimulationActionInput, SimulationState } from '@/lib/contracts/simulation';

export const SimulationAgentToolName = z.enum(['observe_resources', 'request_action']);
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
