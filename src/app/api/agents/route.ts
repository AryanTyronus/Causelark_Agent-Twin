import 'server-only';

import { NextResponse } from 'next/server';
import { deploymentAgentCatalog } from '@/lib/business/agent-catalog';
import { AgentCatalog } from '@/lib/contracts/agents';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

/**
 * The agent configurations this deployment can run.
 *
 * Not a registry: nothing is stored, and nothing is invented. Each entry is a
 * provider-and-model pair this deployment's own provider boundary resolves,
 * reported with the identity the comparison engine keys a report column on. The
 * credentials behind them are deployment configuration and are never read into
 * the response — a provider with no credential is listed as unconfigured, with
 * the missing variable named and no value.
 *
 * Authenticated like every other catalogue in the product: an operator can ask
 * what this deployment runs, and nobody else can.
 */
export async function GET(req: Request) {
  try {
    await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  return NextResponse.json(AgentCatalog.parse(deploymentAgentCatalog()));
}
