import 'server-only';

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/require-auth';
import { listScenarioSummaries } from '@/lib/scenarios/scenario';
import { ScenarioCatalog } from '@/lib/scenarios/types';

export const dynamic = 'force-dynamic';

/**
 * Lists the scenarios this deployment can start a run under. The catalogue is
 * static and carries no user data, but it is served behind the same
 * authentication as the simulation catalogue it belongs to rather than
 * inventing a second policy for one endpoint.
 */
export async function GET(req: Request) {
  try {
    await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  return NextResponse.json(ScenarioCatalog.parse({ scenarios: listScenarioSummaries() }));
}
