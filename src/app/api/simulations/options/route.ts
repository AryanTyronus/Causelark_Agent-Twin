import 'server-only';

import { NextResponse } from 'next/server';
import { getSimulationOptions } from '@/lib/business/simulation';
import { SimulationOptions } from '@/lib/contracts/simulation';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  return NextResponse.json(SimulationOptions.parse(getSimulationOptions()));
}
