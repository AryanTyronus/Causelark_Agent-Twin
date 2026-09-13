// @polsia:user-owned — the experiment catalogue.
//
// A frozen, in-process registry built once from the shipped templates, in the
// same shape as the benchmark and scenario catalogues beside them. There is no
// filesystem discovery, no dynamic import and no user-supplied code path: an id
// from a request can only ever match a template compiled into this module, and a
// version that does not match is refused rather than silently upgraded to
// whatever the catalogue holds today.
//
// Every template is validated at module load — its benchmark resolved at the
// exact version it pins, and the version of the benchmark it names checked
// against what is actually shipped. A template that references a benchmark this
// build does not ship fails at startup, not halfway through somebody's
// experiment.

import { getBenchmark } from '@/lib/benchmarks/catalog';
import type { BenchmarkDefinition } from '@/lib/benchmarks/types';
import { EXPERIMENT_TEMPLATES } from './definitions';
import { maximumAgentsFor } from './matrix';
import {
  COMPARISON_METHODOLOGY,
  COMPARISON_VERDICT_RULE,
  ComparisonError,
  type ExperimentSummary,
  type ExperimentTemplate,
  MIN_EXPERIMENT_AGENTS,
} from './types';

/** A template together with the benchmark it resolves to. */
export interface ResolvedTemplate {
  template: ExperimentTemplate;
  definition: BenchmarkDefinition;
}

/**
 * Resolve a template's benchmark reference, refusing a version mismatch.
 *
 * `getBenchmark` already distinguishes an unknown benchmark from a known one at
 * an unknown version; both are re-raised as comparison errors so the endpoint
 * reports one kind of failure with one code.
 */
function resolveTemplate(template: ExperimentTemplate): ResolvedTemplate {
  let definition: BenchmarkDefinition;
  try {
    definition = getBenchmark(template.benchmarkId, template.benchmarkVersion);
  } catch (error) {
    throw new ComparisonError(
      'INVALID_EXPERIMENT',
      `Experiment ${template.id} names a benchmark this deployment cannot resolve: ${error instanceof Error ? error.message : 'unknown benchmark'}`,
    );
  }
  // A template must be able to compare at least two agents, or it is not an
  // experiment. Checked here so an unusable template cannot ship.
  if (maximumAgentsFor(definition) < MIN_EXPERIMENT_AGENTS)
    throw new ComparisonError(
      'INVALID_EXPERIMENT',
      `Experiment ${template.id} pins a benchmark of ${definition.scenarios.length * definition.seeds.length} cases, which leaves no room to compare the ${MIN_EXPERIMENT_AGENTS} agents a comparison needs.`,
    );
  return { template, definition };
}

const CATALOG: readonly ResolvedTemplate[] = Object.freeze(
  EXPERIMENT_TEMPLATES.map((template) => Object.freeze(resolveTemplate(template))),
);

/** Every experiment, in declared catalogue order. */
export function listExperiments(): readonly ResolvedTemplate[] {
  return CATALOG;
}

/**
 * One experiment by id, optionally pinned to an exact version. Returns `null`
 * rather than throwing when there is no match.
 */
export function findExperiment(id: string, version?: number | null): ResolvedTemplate | null {
  const entry = CATALOG.find((candidate) => candidate.template.id === id);
  if (!entry) return null;
  if (version === undefined || version === null) return entry;
  return entry.template.version === version ? entry : null;
}

/**
 * One experiment by id, or by id *and* version. An unknown id and a known id at
 * an unknown version are both refused, with distinct messages — a caller that
 * asked for a version this deployment does not ship needs to know that, rather
 * than being handed the current one.
 */
export function getExperiment(id: string, version?: number | null): ResolvedTemplate {
  const entry = findExperiment(id, version);
  if (entry) return entry;
  const known = CATALOG.find((candidate) => candidate.template.id === id);
  if (!known) throw new ComparisonError('UNKNOWN_EXPERIMENT', `Unknown experiment: ${id}.`);
  throw new ComparisonError(
    'UNKNOWN_EXPERIMENT',
    `Experiment ${id} was requested at version ${version}, but the catalogue only ships version ${known.template.version}.`,
  );
}

/** The catalogue as the `/api/agent-comparisons` endpoint serves it. */
export function experimentSummary(entry: ResolvedTemplate): ExperimentSummary {
  const { template, definition } = entry;
  const seeds = template.seeds ?? definition.seeds;
  return {
    id: template.id,
    version: template.version,
    name: template.name,
    description: template.description,
    benchmarkId: definition.id,
    benchmarkVersion: definition.version,
    benchmarkName: definition.name,
    environmentKey: definition.environmentKey,
    objectiveKey: definition.objectiveKey,
    scenarioCount: definition.scenarios.length,
    seedCount: seeds.length,
    caseCountPerAgent: definition.scenarios.length * seeds.length,
    minimumAgents: MIN_EXPERIMENT_AGENTS,
    maximumAgents: maximumAgentsFor(definition),
    methodology: COMPARISON_METHODOLOGY,
    verdictRule: COMPARISON_VERDICT_RULE,
  };
}

export function listExperimentSummaries(): ExperimentSummary[] {
  return CATALOG.map(experimentSummary);
}
