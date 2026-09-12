// @polsia:user-owned — brand identity. Edit freely. `site.ts` re-exports
// siteName/siteDescription; `manifest.ts` + `opengraph-image.tsx` read `brandVisual`.

export const siteName = 'Causelark';
export const siteDescription =
  'Run autonomous agents safely in deterministic worlds. A simulation and evaluation platform for reproducible agent engineering.';

// PWA + social-share colors. HEX only (the oklch() tokens in globals.css aren't
// readable here) — set to match your brand seed.
export const brandVisual = {
  /** PWA browser-UI / status-bar color. */
  themeColor: '#9a6a00',
  /** PWA splash + install background. */
  backgroundColor: '#f8f7f2',
  /** Social-share (OG/Twitter) image. */
  og: {
    background: '#151713',
    foreground: '#f8f7f2',
    /** Second line under the site name; '' hides it. */
    tagline: 'Run autonomous agents safely in deterministic worlds.',
  },
} as const;
