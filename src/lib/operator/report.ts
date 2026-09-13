// @polsia:user-owned — the Agent Trust Report, assembled deterministically.
//
// The report is built here, in code, from the structured results the operator's
// tools already recorded. That is the entire design: the model decides *what to
// look at*, and this file decides *what the report says about it*. Every figure
// is a field copied from a benchmark result, an evaluation result or a
// counterfactual report — there is no arithmetic in this file that the engines
// have not already done, and there is nowhere in it that a model's text could
// reach.
//
// The one thing the model may write is `interpretation`, and it is kept in its
// own field, capped, labelled, and rendered apart from every measurement. A
// reader can therefore tell, from the shape of the document alone, which
// sentences are facts and which are a reading of them.
//
// This file is pure. It reads no database, contacts no provider and consults no
// clock beyond the timestamp it is handed.

import { MAX_OPERATOR_INTERPRETATION_CHARS } from './config';
import { assessReadiness, READINESS_METHODOLOGY } from './readiness';
import {
  type OperatorCounterfactualFinding,
  type OperatorResultSlice,
  type OperatorTestPlan,
  type TrustReport,
  TrustReport as TrustReportSchema,
} from './types';

/** The report's own contract version, so a reader can tell formats apart. */
export const TRUST_REPORT_POLICY_VERSION = 1;

export interface TrustReportInput {
  objective: string;
  plan: OperatorTestPlan;
  result: OperatorResultSlice;
  counterfactuals: readonly OperatorCounterfactualFinding[];
  /** The operator's own words, if it produced any. Never a measurement. */
  interpretation?: string | null;
  recommendation?: string | null;
  planFingerprint: string | null;
  toolCalls: number;
  turns: number;
  stopReason: string;
  benchmarkRuns: number;
  counterfactualAnalyses: number;
  /** Injected so the report can be built deterministically in a test. */
  generatedAt: string;
}

/** A nullable number, copied rather than computed. */
function numberIn(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringIn(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalStringIn(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function countIn(source: Record<string, number>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A model-written field, trimmed to its allowance. */
function bounded(value: string | null | undefined, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

/** The failure classes, in the engine's own reporting order. */
const FAILURE_CATEGORY_ORDER = [
  'taskFailure',
  'safetyViolation',
  'invalidActions',
  'providerFailures',
  'toolFailures',
  'timeouts',
] as const;

/**
 * Build the report.
 *
 * The verdict is computed here rather than accepted from a caller: an operator
 * cannot decide its own verdict any more than it can decide its own scores. What
 * a caller may supply is the reading of a verdict it has been shown.
 */
export function buildTrustReport(input: TrustReportInput): TrustReport {
  const { plan, result } = input;
  const assessment = assessReadiness(result, input.counterfactuals);
  const robustness = result.robustness;

  const scenarioPerformance = result.scenarios.map((scenario) => ({
    scenarioId: stringIn(scenario, 'scenarioId') ?? 'unknown',
    scenarioVersion: numberIn(scenario, 'scenarioVersion') ?? plan.benchmark.version,
    isBaseline: scenario.isBaseline === true,
    score: numberIn(scenario, 'score'),
    retention: numberIn(scenario, 'retention'),
    absoluteDegradation: numberIn(scenario, 'absoluteDegradation'),
    caseCount: numberIn(scenario, 'caseCount') ?? 0,
    evaluatedCount: numberIn(scenario, 'evaluatedCount') ?? 0,
    runStatus: optionalStringIn(scenario, 'runStatus'),
  }));

  const failures = FAILURE_CATEGORY_ORDER.map((category) => {
    const entry = result.failures[category];
    const record =
      typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const runIds = Array.isArray(record.runIds)
      ? record.runIds.filter((value): value is string => typeof value === 'string')
      : [];
    const scenarioIds = Array.isArray(record.scenarioIds)
      ? record.scenarioIds.filter((value): value is string => typeof value === 'string')
      : [];
    return {
      category,
      count: numberIn(record, 'count') ?? 0,
      metric: optionalStringIn(record, 'metric'),
      runIds,
      scenarioIds,
    };
  });

  const policies = [
    { name: 'readiness method', value: READINESS_METHODOLOGY },
    { name: 'robustness formula', value: stringIn(robustness, 'formula') ?? 'not recorded' },
    ...input.counterfactuals.flatMap((finding) =>
      Object.entries(finding.policies).map(([name, value]) => ({
        name: `counterfactual ${name}`,
        value,
      })),
    ),
  ];

  return TrustReportSchema.parse({
    policyVersion: TRUST_REPORT_POLICY_VERSION,
    objective: input.objective,
    target: {
      key: plan.agent.key,
      identity: plan.agent.identity,
      provider: plan.agent.provider,
      model: plan.agent.model,
      providerLabel: plan.agent.providerLabel,
    },
    benchmark: {
      id: plan.benchmark.id,
      version: plan.benchmark.version,
      name: plan.benchmark.name,
      environmentKey: plan.benchmark.environmentKey,
      objectiveKey: plan.benchmark.objectiveKey,
      scenarios: plan.scenarios.map((scenario) => ({
        id: scenario.id,
        version: scenario.version,
      })),
      seeds: plan.seeds,
      caseCount: plan.caseCount,
    },
    observed: {
      overall: numberIn(result.dimensions, 'averageOverallScore'),
      minimum: numberIn(result.dimensions, 'minimumOverallScore'),
      maximum: numberIn(result.dimensions, 'maximumOverallScore'),
      categories: {
        task: numberIn(result.dimensions, 'averageTaskScore'),
        safety: numberIn(result.dimensions, 'averageSafetyScore'),
        efficiency: numberIn(result.dimensions, 'averageEfficiencyScore'),
        resources: numberIn(result.dimensions, 'averageResourceScore'),
        reliability: numberIn(result.dimensions, 'averageReliabilityScore'),
      },
      robustness: {
        formula: stringIn(robustness, 'formula') ?? 'not recorded',
        score: numberIn(robustness, 'robustnessScore'),
        baselineScore: numberIn(robustness, 'baselineScore'),
        worstDegradation: numberIn(robustness, 'worstDegradation'),
        greatestDegradationScenarioId: optionalStringIn(
          robustness,
          'greatestDegradationScenarioId',
        ),
        worstScenarioId: optionalStringIn(robustness, 'worstScenarioId'),
        unavailableReason: optionalStringIn(robustness, 'unavailableReason'),
      },
      caseSummary: {
        totalCases: countIn(result.caseSummary, 'totalCases'),
        executedCases: countIn(result.caseSummary, 'executedCases'),
        evaluatedCases: countIn(result.caseSummary, 'evaluatedCases'),
        succeededCases: countIn(result.caseSummary, 'succeededCases'),
        unsuccessfulCases: countIn(result.caseSummary, 'unsuccessfulCases'),
        unavailableCases: countIn(result.caseSummary, 'unavailableCases'),
        errorCases: countIn(result.caseSummary, 'errorCases'),
        timeoutCases: countIn(result.caseSummary, 'timeoutCases'),
      },
      scenarioPerformance,
      failures,
      counterfactuals: [...input.counterfactuals],
    },
    verdict: assessment,
    interpretation: bounded(input.interpretation, MAX_OPERATOR_INTERPRETATION_CHARS),
    recommendation: bounded(input.recommendation, MAX_OPERATOR_INTERPRETATION_CHARS),
    evidence: {
      runIds: result.runs.map((run) => run.runId),
      scenarioIds: [...new Set(result.runs.map((run) => run.scenarioId))],
      decisionIds: input.counterfactuals
        .filter((finding) => finding.criticalDecision !== null)
        .map(
          (finding) =>
            `${finding.runId}#decision-${finding.criticalDecision?.index ?? 0}@step-${finding.criticalDecision?.step ?? 0}`,
        ),
      policies,
    },
    provenance: {
      planFingerprint: input.planFingerprint,
      benchmarkRuns: input.benchmarkRuns,
      counterfactualAnalyses: input.counterfactualAnalyses,
      toolCalls: input.toolCalls,
      turns: input.turns,
      stopReason: input.stopReason,
      generatedAt: input.generatedAt,
    },
  });
}
