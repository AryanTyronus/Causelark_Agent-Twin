// @polsia:framework-owned — the framework owns this shell (re-stamped on upgrade; the
// ownership gate rejects edits). Customize via the user-owned seams it imports — see
// AGENTS.md "Customizing the shell" (lang/head/viewport/providers/nav/brand).
// Code installed by polsia/template-next@0.3.6.
import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { GlobalMounts } from '@/components/custom/global-mounts';
import { HeadContent } from '@/components/custom/head-content';
import { SiteFooter, SiteNav } from '@/components/custom/site-nav';
import { PolsiaAnalytics } from '@/components/polsia-analytics';
import { AppProviders } from '@/components/providers';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { locale } from '@/lib/locale';
import { siteDescription, siteName, siteUrl } from '@/lib/site';
import { viewportConfig } from '@/lib/viewport-config';
import './globals.css';

// Framework SEO defaults. `metadataBase` makes every relative metadata URL
// (canonical, OG image) absolute. `title.template` lets a page export
// `title: 'Pricing'` and get `Pricing · <site>` for free, while pages with no
// title fall back to `title.default`. Per-page title/description/OG-image and
// structured data come from the page's own `metadata` export (POL-2616) — these
// are only the site-wide defaults.
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: siteName,
    template: `%s · ${siteName}`,
  },
  description: siteDescription,
  applicationName: siteName,
  // No GLOBAL canonical/og:url here: a layout-level `/` is INHERITED by every
  // child route, so each subpage would self-declare as a duplicate of home.
  // Per-page identity (canonical, og:url) belongs to the page's own `metadata`
  // export — the home (setup)/page.tsx sets `/`; other pages set their own path.
  openGraph: {
    type: 'website',
    siteName,
    title: siteName,
    description: siteDescription,
  },
  twitter: {
    card: 'summary_large_image',
    title: siteName,
    description: siteDescription,
  },
};

// Per-app viewport + browser theme-color — edit src/lib/viewport-config.ts.
export const viewport: Viewport = { ...viewportConfig };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Next.js 16: headers() is async. Reading it opts the route into dynamic
  // rendering (per-request) — required for the per-request CSP nonce.
  // POLSIA_STATIC_CHECK is a BUILD-ONLY escape hatch for Polsia's in-sandbox
  // render gate: when set, skip the nonce read so routes stay statically
  // prerenderable and `next build` render-checks every route (catching SSR
  // throws a normal dynamic build never surfaces). It is NEVER set on the real
  // deploy build, so production keeps the per-request nonce + dynamic rendering
  // unchanged (SEO/CSP identical).
  const nonce = process.env.POLSIA_STATIC_CHECK
    ? undefined
    : ((await headers()).get('x-nonce') ?? undefined);
  // Visitor beacon: deploy-injected app slug + per-env platform base.
  const analyticsSlug = process.env.POLSIA_ANALYTICS_SLUG;
  const analyticsBase = process.env.POLSIA_API_BASE_URL;

  return (
    <html lang={locale.lang} dir={locale.dir} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-body text-foreground antialiased">
        {/* Extra <head> (verification/preconnect/scripts) — edit head-content.tsx. */}
        <HeadContent nonce={nonce} />
        {/* Framework provider composition. App-wide React providers go in the
            user-owned src/components/providers.tsx (AppProviders, below), which wraps
            the whole app — add providers there, not here. The `nonce` is available to
            CSP-aware providers via the `x-nonce` header in proxy.ts. */}
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem nonce={nonce}>
          {/* App-wide context providers (auth, cart, …) — edit providers.tsx, not this file. */}
          <AppProviders>
            {/* Global, data-driven nav rendered from src/lib/nav.ts — every page is
                reachable without a per-page header. */}
            <SiteNav />
            {children}
            <SiteFooter />
            {/* Global toast host — any client component can `import { toast } from 'sonner'`. */}
            <Toaster />
            {/* Root/global mounts (Cmd+K palette, global listeners, overlays) — edit global-mounts.tsx, not this file. */}
            <GlobalMounts />
          </AppProviders>
          {analyticsSlug ? <PolsiaAnalytics slug={analyticsSlug} base={analyticsBase} /> : null}
        </ThemeProvider>
      </body>
    </html>
  );
}
