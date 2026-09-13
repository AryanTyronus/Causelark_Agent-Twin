//
// The body may name the agent the caller believes it is benchmarking and may
// override the definition's seed set. It may not carry scenarios, thresholds,
// scoring rules or anything else executable: the benchmark is resolved from the
// server-side catalogue, its scenarios come from the scenario catalogue, its
// verdicts come from the evaluation engine, and its runs are real runs owned by
// the caller.
import 'server-only';

import { NextResponse } from 'next/server';
import { executeBenchmark } from '@/lib/benchmarks/execute';
import { BenchmarkError, BenchmarkRunRequest } from '@/lib/benchmarks/types';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';
// A benchmark drives a real agent turn loop per case, so the handler needs the
// Node runtime the AWS SDK and its credential chain require.
export const runtime = 'nodejs';

function validationErrors(error: {
  flatten: () => { fieldErrors: Record<string, string[] | undefined> };
}) {
  const errors: Record<string, string> = {};
  for (const [field, messages] of Object.entries(error.flatten().fieldErrors)) {
    const message = messages?.[0];
    if (message) errors[field] = message;
  }
  return errors;
}

/** The status a `BenchmarkError` maps to, so a caller can tell what to fix. */
function statusFor(code: BenchmarkError['code']): number {
  switch (code) {
    case 'UNKNOWN_BENCHMARK':
      return 404;
    case 'INVALID_SCENARIO':
      return 409;
    case 'INVALID_AGENT_CONFIGURATION':
      return 503;
    case 'INVALID_RESULT':
      return 500;
    default:
      return 400;
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ benchmarkId: string }> }) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  const { benchmarkId } = await params;

  // A benchmark execution needs no parameters, so an absent body is a valid
  // request rather than a malformed one.
  let body: unknown = {};
  try {
    const text = await req.text();
    body = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return NextResponse.json(
      { errors: { form: 'Request body must be valid JSON.' } },
      { status: 400 },
    );
  }
  const parsed = BenchmarkRunRequest.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ errors: validationErrors(parsed.error) }, { status: 400 });

  try {
    const result = await executeBenchmark({
      ownerId: user.id,
      benchmarkId,
      agent: parsed.data.agent ?? null,
      seeds: parsed.data.seeds ?? null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof BenchmarkError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: statusFor(error.code) },
      );
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
