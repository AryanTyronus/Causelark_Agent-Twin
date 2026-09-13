//
// The body names the agents to compare and may override the benchmark's seed
// set. It may not carry scenarios, thresholds, scoring rules, weights or
// anything else executable: the experiment is resolved from the server-side
// catalogue, its benchmark and scenarios come from their catalogues, its
// verdicts come from the evaluation engine, and its runs are real runs owned by
// the caller.
//
// The report is computed on demand and returned. Nothing about it is persisted:
// the SimulationRun records it is derived from are the evidence, and a stored
// copy of a report could drift from the evidence it was derived from.
import 'server-only';

import { NextResponse } from 'next/server';
import { executeComparison } from '@/lib/comparison/execute';
import { ComparisonError, ComparisonRunRequest } from '@/lib/comparison/types';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';
// A comparison drives a real agent turn loop per case, per agent, so the handler
// needs the Node runtime the AWS SDK and its credential chain require.
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

/** The status a `ComparisonError` maps to, so a caller can tell what to fix. */
function statusFor(code: ComparisonError['code']): number {
  switch (code) {
    case 'UNKNOWN_EXPERIMENT':
      return 404;
    case 'INVALID_AGENT_CONFIGURATION':
      return 503;
    case 'MATRIX_TOO_LARGE':
      return 413;
    case 'INVALID_REPORT':
      return 500;
    default:
      return 400;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ comparisonId: string }> },
) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  const { comparisonId } = await params;

  // A comparison needs agents, so unlike a benchmark an absent body is not a
  // valid request — but a malformed one still has to be told apart from an
  // empty one.
  let body: unknown;
  try {
    const text = await req.text();
    body = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return NextResponse.json(
      { errors: { form: 'Request body must be valid JSON.' } },
      { status: 400 },
    );
  }
  const parsed = ComparisonRunRequest.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ errors: validationErrors(parsed.error) }, { status: 400 });

  try {
    const report = await executeComparison({
      ownerId: user.id,
      comparisonId,
      agents: parsed.data.agents,
      seeds: parsed.data.seeds ?? null,
    });
    return NextResponse.json(report, { status: 201 });
  } catch (error) {
    if (error instanceof ComparisonError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: statusFor(error.code) },
      );
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
