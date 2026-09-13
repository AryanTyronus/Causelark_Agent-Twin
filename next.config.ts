//
// Why this file is shared-by-slot:
//   - Security headers MUST ship on day 1.
//   - Cache Components is OFF per D17 (Next.js 16); flipping it is a
//     platform-level decision the agent must not make freehand.
//   - Modules may contribute only through the declared package/image/plugin slots.
//   - Vercel ships zero security headers by default — every header below
//     is explicit and non-negotiable.
//
// D17: Cache Components MUST remain OFF for v1. Do NOT add
// `cacheComponents: true`. Re-enable per app after re-bug telemetry
// stabilizes on the new agent.

import type { NextConfig } from 'next';

// Eager-load so @t3-oss validates env on every build (relative path: @/ won't resolve here).
import './src/lib/env';

// User-owned bits (remote image hosts, package options, and one-off config plugins)
// live in next.user-config.ts; the agent edits there, not here. Framework keys below
// always win, and the security headers are re-asserted after plugin composition.
import {
  appCapabilities,
  userConfigPlugins,
  userNextConfig,
  userRemotePatterns,
} from './next.user-config';
// Builds the Permissions-Policy value from appCapabilities (relative path: @/ won't resolve here).
import { buildPermissionsPolicy } from './src/lib/permissions-policy';

const nextConfig: NextConfig = {
  ...userNextConfig,
  reactStrictMode: true,
  poweredByHeader: false,

  // D17: Cache Components OFF. Do not flip this on without platform review.
  // experimental: { cacheComponents: false } — intentionally omitted; default is off.

  // Image security.
  images: {
    // User-configured remote image hosts.
    remotePatterns: [...userRemotePatterns],
    localPatterns: [{ pathname: '/assets/**', search: '' }],
    dangerouslyAllowLocalIP: false,
    qualities: [75],
  },

  // Security headers — MUST pass on day 1.
  // CSP is set in `proxy.ts` because the nonce is per-request.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // X-Frame-Options is obsoleted by CSP frame-ancestors per OWASP, but
          // we ship both for defense in depth across older browsers.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            // Locked-down by default; apps opt features in via appCapabilities
            // (next.user-config.ts). browsing-topics stays hard-off.
            key: 'Permissions-Policy',
            value: buildPermissionsPolicy(appCapabilities),
          },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

// Compose the user's config plugins (next.user-config.ts) outermost, then re-assert
// the security keys so a plugin can extend the build (webpack/turbopack/etc.) but
// never drop the day-1 security headers or re-enable the powered-by header.
const withConfigPlugins = userConfigPlugins.reduce((config, plugin) => plugin(config), nextConfig);

export default {
  ...withConfigPlugins,
  headers: nextConfig.headers,
  poweredByHeader: false,
} satisfies NextConfig;
