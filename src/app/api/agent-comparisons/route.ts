// @polsia:user-owned — owner-scoped comparison experiment catalogue endpoint.
import 'server-only';

import { NextResponse } from 'next/server';
import { listExperimentSummaries } from '@/lib/comparison/catalog';
import { ExperimentCatalog } from '@/lib/comparison/types';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

/**
 * The experiment templates this deployment can run.
 *
 * Served from the compiled registry, never from the filesystem and never from
 * the request. A caller can learn which comparisons exist, what benchmark each
 * one pins, how many cases each agent would run and how many agents it can
 * compare; it cannot supply an experiment, and it cannot ask for one that does
 * not ship.
 *
 * No template names a provider or a model — the summary carries the bounds and
 * the methodology, and the agent configurations are the caller's to declare on
 * the run request.
 */
export async function GET(req: Request) {
  try {
    await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  return NextResponse.json(ExperimentCatalog.parse({ experiments: listExperimentSummaries() }));
}
