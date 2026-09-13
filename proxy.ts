import { type NextRequest, NextResponse } from 'next/server';
import { buildCsp } from '@/lib/csp';
// Per-app extra CSP sources (frame/connect/media/font/img). User-owned, default empty.
import { cspExtraSources } from './next.user-config';

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';

  // CSP — script-src strict (nonce + 'strict-dynamic'); style-src relaxed for
  // headless UI. Built in src/lib/csp.ts (single source, unit-tested). The
  // per-request nonce is still exposed via x-nonce for script-src consumers.
  const csp = buildCsp(nonce, isDev, process.env.NEXT_PUBLIC_API_URL ?? '', cspExtraSources);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
