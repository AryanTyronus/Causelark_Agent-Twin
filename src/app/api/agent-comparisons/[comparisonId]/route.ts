// @polsia:user-owned — comparison experiment plan endpoint.
import 'server-only';

import { NextResponse } from 'next/server';
import { buildRunMatrix } from '@/lib/benchmarks/matrix';
import { experimentSummary, getExperiment } from '@/lib/comparison/catalog';
import { ComparisonError, ExperimentPlan } from '@/lib/comparison/types';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

/**
 * What one experiment would do, without running it.
 *
 * The plan is computed on demand from the compiled catalogue and the benchmark
 * engine's own matrix builder, so it cannot disagree with what an execution
 * would actually run. It is deliberately not a report: a comparison report is
 * derived from persisted evidence, and there is no evidence for an experiment
 * nobody has run. Asking this endpoint what a comparison *found* is answered
 * with the plan and the bounds, not with invented numbers.
 */
export async function GET(req: Request, { params }: { params: Promise<{ comparisonId: string }> }) {
  // The plan names no user data, but the catalogue is not public: an experiment
  // is only reachable by a signed-in caller, exactly as the benchmark catalogue is.
  try {
    await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  const { comparisonId } = await params;

  const requested = new URL(req.url).searchParams.get('version');
  let version: number | null = null;
  if (requested !== null) {
    // Only a plain, bounded run of digits names a version. `Number.parseInt`
    // would read `1.5` and `1v2` as version 1 and answer for an experiment the
    // caller never asked about.
    if (!/^\d{1,6}$/.test(requested))
      return NextResponse.json(
        { error: 'The version parameter must be a non-negative integer.' },
        { status: 400 },
      );
    version = Number.parseInt(requested, 10);
  }

  try {
    const { template, definition } = getExperiment(comparisonId, version);
    const cases = buildRunMatrix(definition);
    return NextResponse.json(
      ExperimentPlan.parse({
        experiment: experimentSummary({ template, definition }),
        cases,
        // The seeds in matrix order, deduplicated: the matrix repeats the seed
        // set once per scenario, and a plan should state the set it will use.
        seeds: [...new Set(cases.map((entry) => entry.seed))],
      }),
    );
  } catch (error) {
    if (error instanceof ComparisonError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.code === 'UNKNOWN_EXPERIMENT' ? 404 : 409 },
      );
    throw error;
  }
}
