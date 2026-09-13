import 'server-only';

import { NextResponse } from 'next/server';
import { listBenchmarkSummaries } from '@/lib/benchmarks/catalog';
import { BenchmarkCatalog } from '@/lib/benchmarks/types';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

// The catalogue is served from the compiled registry, never from the filesystem
// and never from the request. A caller can learn which benchmarks exist; it
// cannot supply one, and it cannot ask for one that does not ship.
export async function GET(req: Request) {
  try {
    await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  return NextResponse.json(BenchmarkCatalog.parse({ benchmarks: listBenchmarkSummaries() }));
}
