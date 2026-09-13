//
// The same shape as the benchmark engine's barrel: the domain contracts, the
// pure modules that derive a report from evidence, and the catalogue. The
// execution layer is deliberately *not* re-exported here — it is the one file
// that reaches a database and an agent runtime, and a caller that wants it
// should have to name it, so that importing a comparison type can never drag a
// server-only module into a bundle that should not have one.

export { agentConfigurationKey, agentIdentity, compareAgentKeys, orderAgents } from './agents';
export { agentMetrics, extremeScenarios } from './aggregate';
export { findExperiment, getExperiment, listExperimentSummaries, listExperiments } from './catalog';
export {
  buildFailureProfiles,
  buildHeadToHead,
  compareMetrics,
  compareRobustness,
  compareScenarios,
  decideVerdict,
} from './compare';
export { EXPERIMENT_TEMPLATES } from './definitions';
export {
  buildComparisonMatrix,
  comparisonCaseKey,
  maximumAgentsFor,
  resolveExperimentAgents,
} from './matrix';
export { COMPARISON_METRIC_TABLE, compareValues, directionOf, METRIC_KEYS } from './metrics';
export { experimentKey, reportComparison } from './report';
export * from './types';
