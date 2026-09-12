// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/better-auth@0.2.0. Drift = commit rejected.
//
// better-auth catch-all route handler. Mounts EVERY better-auth endpoint
// (sign-in, sign-up, sign-out, session, callbacks, ...) under /api/auth/*.
// Lives under /api, which proxy.ts's matcher excludes (no CSP/nonce, not proxied).
//
// toNextJsHandler returns native App Router GET/POST handlers — NO Server Actions,
// so the 'nextCookies()' plugin is intentionally absent: cookies are set on the
// route handler's own NextResponse, which Next.js does not discard.

import 'server-only';
import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';

export const { GET, POST } = toNextJsHandler(auth);
