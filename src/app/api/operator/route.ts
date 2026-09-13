// @polsia:user-owned — POST /api/operator.
//
// The operator's only entry point. It authenticates, validates the request
// against the shared contract, hands it to the server composition and maps what
// comes back onto a status.
//
// Two things about this handler are load-bearing:
//
//   * The owner is taken from `requireAuth` and from nowhere else. The request
//     schema has no owner field, so there is no shape a caller could send that
//     would name a different account — the operator acts as the signed-in person
//     or not at all.
//
//   * A run that produced findings is a 200, even when the findings are bad.
//     A benchmark whose cases failed, an agent that recorded a risk violation,
//     an evidence set too thin to judge — those are results, and a route that
//     turned them into an error status would be telling a caller their request
//     was malformed when what actually happened is that their agent did badly.
//
// Every refusal this handler writes carries a declared `OperatorErrorCode`, and
// the console relies on that: it shows the server's own words only for a code
// this API is known to have written. A body that arrives without one — a proxy's
// error page, a platform's, a different deployment's — is not text this product
// can vouch for, and is replaced with a sentence the interface wrote itself.
// The 401 from `requireAuth` is the one refusal served outside this file, and it
// is served without a code for exactly that reason.

import 'server-only';

import { NextResponse } from 'next/server';
import { AgentProviderError } from '@/lib/agent/provider';
import { runOperatorForUser } from '@/lib/operator/run';
import { OperatorError, type OperatorErrorCode, OperatorRunRequest } from '@/lib/operator/types';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** How each refusal is served. Anything unlisted is the caller's request. */
const ERROR_STATUS: Partial<Record<OperatorErrorCode, number>> = {
  NO_AGENT_CONFIGURED: 503,
  PROVIDER_UNAVAILABLE: 503,
  OPERATOR_FAILED: 500,
};

export async function POST(req: Request) {
  let user: { id: string };
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'A JSON body is required.', code: 'INVALID_REQUEST' },
      { status: 400 },
    );
  }

  const parsed = OperatorRunRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'The operator request is not valid.',
        code: 'INVALID_REQUEST',
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    const run = await runOperatorForUser(user.id, parsed.data);
    return NextResponse.json({ run });
  } catch (error) {
    if (error instanceof OperatorError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: ERROR_STATUS[error.code] ?? 400 },
      );
    if (error instanceof AgentProviderError)
      return NextResponse.json(
        {
          error: `The operator could not reach its model: ${error.message}`,
          code: 'OPERATOR_FAILED',
        },
        { status: 503 },
      );
    // The message is deliberately not echoed: an unexpected throw could carry
    // anything, and this response is served to whoever is signed in.
    return NextResponse.json(
      { error: 'The operator run failed. Nothing was reported.', code: 'OPERATOR_FAILED' },
      { status: 500 },
    );
  }
}
