// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.0.
//
// Centralized site identity for the SEO metadata routes (robots.ts, sitemap.ts,
// manifest.ts) and the root layout's default Open Graph / Twitter / canonical
// metadata. One source of truth so the OG siteName, the manifest name, and the
// <title> template can't drift apart.
import { env } from '@/lib/env';

// Absolute public origin for SEO (metadataBase, canonical, robots, sitemap, OG).
// Reuses the app's single validated public origin — NEXT_PUBLIC_APP_URL, a
// required `.url()` in src/lib/env.ts — so one deploy var covers both the app
// and SEO; there is no separate SEO origin to keep in sync.
// The `?? 'http://localhost:3000'` fallback matters only under
// SKIP_ENV_VALIDATION=1, where the typed env proxy bypasses zod (and its
// `.default()`) and can return undefined for an unset var; validated builds
// always carry a value. Trailing slashes are stripped so `${siteUrl}${href}`
// never produces a double slash.
export const siteUrl = (env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

// Brand identity (name + description) is USER-OWNED — the agent sets it per app
// in src/lib/brand.ts. Re-exported here so the SEO plumbing (layout/manifest) and
// every existing `@/lib/site` import keep a single entry point. `siteUrl` above
// stays framework-owned (it's the deploy origin, not a brand string).
export { siteDescription, siteName } from '@/lib/brand';
