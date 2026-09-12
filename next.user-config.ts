// @polsia:user-owned — your Next.js customizations, merged into next.config.ts by the
// framework. Edit freely (no slot markers). next.config.ts stays framework-owned: don't
// put security headers / CSP / a full `images` block here.
import type { NextConfig } from 'next';
import type { CspExtraSources } from './src/lib/csp';
import type { AppCapabilities } from './src/lib/permissions-policy';

type RemotePatterns = NonNullable<NonNullable<NextConfig['images']>['remotePatterns']>;

/** Remote hosts you load <Image> from. e.g. { protocol: 'https', hostname: 'images.unsplash.com' } */
export const userRemotePatterns: RemotePatterns = [];

/**
 * Browser capabilities this app needs (drives the Permissions-Policy header).
 * Default: everything OFF — the app cannot even PROMPT for these, so e.g. audio
 * recording never starts. Flip one to `true` to emit `<feature>=(self)`, which
 * lets THIS origin request it; the browser's own permission prompt is still the
 * gate (the user must click Allow). Leave features you don't use OFF — declaring
 * unused device permissions is flagged by security audits.
 *   microphone  → getUserMedia({ audio }), MediaRecorder (voice recording)
 *   camera      → getUserMedia({ video }) (video calls, QR scan, photo)
 *   geolocation → navigator.geolocation ("near me", maps)
 */
export const appCapabilities: AppCapabilities = {
  microphone: false,
  camera: false,
  geolocation: false,
};

/**
 * Extra Content-Security-Policy source allow-lists, appended to the locked base
 * policy (proxy.ts). Default: all EMPTY (same-origin only). List the EXACT
 * third-party origins a feature needs — never a bare `*` (wildcards and
 * script/style execution escapes are dropped). script-src and style-src are
 * intentionally NOT configurable here: the strict script-src is the XSS rampart,
 * locked by tests/unit/csp.test.ts.
 *   frameSrc   → third-party <iframe> (Stripe, YouTube, reCAPTCHA, Calendly, maps)
 *   connectSrc → fetch/XHR/WebSocket/SSE to other origins (Supabase, Sentry, APIs)
 *   mediaSrc   → <audio>/<video> loaded from other origins
 *   fontSrc    → web fonts from other origins (next/font self-hosts, so rare)
 *   imgSrc     → images beyond the base `https:` allowance (rare)
 * e.g. { frameSrc: ['https://js.stripe.com'], connectSrc: ['https://*.supabase.co'] }
 */
export const cspExtraSources: CspExtraSources = {
  frameSrc: [],
  connectSrc: [],
  mediaSrc: [],
  fontSrc: [],
  imgSrc: [],
};

/** Package-level Next options (transpilePackages, experimental.optimizePackageImports, …). */
export const userNextConfig: NextConfig = {
  serverExternalPackages: ['@strands-agents/sdk', '@anthropic-ai/sdk'],
};

export type ConfigPlugin = (config: NextConfig) => NextConfig;

/**
 * Next plugins that must WRAP the whole config (next-intl, Sentry, MDX,
 * bundle-analyzer). Each entry is a `(config) => config` wrapper — pre-bind
 * options. next.config.ts applies these and re-asserts the security headers
 * afterward, so a plugin can extend the build but never drop the day-1 posture.
 * For i18n, install the `i18n` module and add its plugin here per its AGENT.md.
 *
 *   export const userConfigPlugins: ConfigPlugin[] = [
 *     createNextIntlPlugin('./src/i18n/request.ts'),
 *     (config) => withSentryConfig(config, { silent: true }),
 *   ];
 */
export const userConfigPlugins: ConfigPlugin[] = [];
