// @polsia:user-owned — the shipped comparison experiment templates.
//
// A template is data. It names the benchmark an experiment runs, the seeds it
// uses, and the bounds on how many agents may be compared. It carries no
// function, no threshold and no scoring rule: the matrix and the report are
// derived from it by the pure modules beside this file.
//
// It deliberately names no agent, no provider and no model. A template that
// pinned a model would be a vendor choice compiled into the product — the exact
// opposite of the claim a comparison makes. The agent configurations arrive in
// the request, and the comparison is only ever as reproducible as the request
// that named them, which is why the report records them in full.

import type { ExperimentTemplate } from './types';

export const EXPERIMENT_TEMPLATES: readonly ExperimentTemplate[] = [
  {
    id: 'resource-routing-agent-comparison',
    version: 1,
    name: 'Resource Routing Agent Comparison',
    description:
      'Runs the same resource-routing robustness benchmark — the same seven conditions, the same seed, the same objective, the same tools and the same evaluation — once per agent, then compares the agents on what the evidence recorded. Each agent meets an identical world and a fresh one per case.',
    benchmarkId: 'resource-routing-robustness',
    benchmarkVersion: 1,
  },
];
