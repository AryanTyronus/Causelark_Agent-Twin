// @polsia:user-owned — environment-specific Strands orchestration.

import { invokeResourceAgent, type ResourceAgentResult } from '@/lib/agent/provider';
import { createResourceTools, type ResourceToolbox } from '@/lib/agent/resource-tools';
import type { SimulationState } from '@/lib/contracts/simulation';

export interface ResourceAgentRun {
  toolbox: ResourceToolbox;
  provider: ResourceAgentResult;
}

export async function runResourceAgentTurn(input: {
  objective: string;
  state: SimulationState;
  timeoutMs: number;
}): Promise<ResourceAgentRun> {
  const toolbox = createResourceTools(input.state, input.objective);
  const provider = await invokeResourceAgent({
    objective: input.objective,
    state: input.state,
    tools: toolbox.tools,
    timeoutMs: input.timeoutMs,
  });
  return { toolbox, provider };
}
