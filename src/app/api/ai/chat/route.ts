// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/ai@0.1.0. Drift = commit rejected.
//
// POST /api/ai/chat — streaming chat relay to the Polsia AI proxy.
// SECURITY: this relays caller messages to the platform LLM proxy using the
// server-only platform key. The platform meters per-app token budget, but this
// route is NOT an authorization boundary — gate it behind an authenticated
// session and/or your own per-user quota before exposing user-facing chat in
// production (e.g. check the session in this handler and return 401 otherwise).

import 'server-only';
import { NextResponse } from 'next/server';
import { AiConfigurationError, streamChat } from '@/lib/ai/client';
import { chatRequestSchema } from '@/lib/ai/schema';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const result = chatRequestSchema.safeParse(json);

  if (!result.success) {
    return NextResponse.json(
      { error: result.error.flatten().formErrors[0] ?? 'invalid_request' },
      { status: 400 },
    );
  }

  try {
    const upstream = await streamChat({
      messages: result.data.messages,
      model: result.data.model,
      task: result.data.task,
    });

    // Relay the OpenAI-compatible SSE stream straight through to the browser.
    return new Response(upstream.body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  } catch (err) {
    if (err instanceof AiConfigurationError) {
      return NextResponse.json({ error: 'ai_not_configured' }, { status: 503 });
    }
    return NextResponse.json({ error: 'ai_request_failed' }, { status: 502 });
  }
}
