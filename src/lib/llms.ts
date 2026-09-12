// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.0.
//
// The /llms.txt domain (llmstxt.org proposal): the config SHAPE (LlmsConfig) AND
// the renderer that builds the plain-text document from it, using the same public
// page sources + filters as the sitemap (src/lib/nav.ts + src/lib/seo-routes.ts).
// The route src/app/llms.txt/route.ts only SERVES what renderLlmsTxt() returns —
// no construction lives there. The per-app VALUE is the user-owned llmsConfig in
// src/lib/llms-config.ts; the framework owns this shape + renderer so /llms.txt
// stays standard and can be patched centrally.
import { navItems } from '@/lib/nav';
import { seoRoutes } from '@/lib/seo-routes';
import { siteDescription, siteName, siteUrl } from '@/lib/site';

/** A single link line rendered as `- [label](url)` or `- [label](url): description`. */
export type LlmsLink = {
  /** Link text. */
  label: string;
  /** App-absolute ('/docs') — prefixed with siteUrl — or a full external URL. */
  href: string;
  /** Optional one-line description rendered after the link. */
  description?: string;
};

/** A curated `## {title}` section with its own list of links. */
export type LlmsSection = {
  /** Rendered as a `## {title}` heading. */
  title: string;
  links: LlmsLink[];
};

/** Everything the user-owned companion may contribute to /llms.txt. All fields
 *  optional so an empty config still type-checks; the `## Pages` list is
 *  generated regardless. */
export type LlmsConfig = {
  /** One short paragraph rendered right after the blockquote. */
  intro?: string;
  /** One-line description per app-absolute href, merged into the Pages list. */
  pageDescriptions?: Record<string, string>;
  /** Extra curated sections rendered after `## Pages`. */
  sections?: LlmsSection[];
  /** Rendered as the `## Optional` section — content safe to skip for shorter contexts. */
  optional?: LlmsLink[];
};

/** `- [label](url)` or `- [label](url): description`. */
function renderLink(label: string, url: string, description?: string): string {
  return description ? `- [${label}](${url}): ${description}` : `- [${label}](${url})`;
}

/** App-absolute hrefs get the deploy origin; external URLs pass through. */
function resolveHref(href: string): string {
  return href.startsWith('/') ? `${siteUrl}${href}` : href;
}

/** Derive a readable label from a programmatic path, e.g. /blog/hi-there -> Hi There. */
function labelFromPath(path: string): string {
  const segment = path.split('/').filter(Boolean).pop() ?? path;
  return segment.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Build the /llms.txt document from the user-owned config + the SAME public page
 *  sources + filters as src/app/sitemap.ts. Async because seoRoutes() may fetch. */
export async function renderLlmsTxt(config: LlmsConfig): Promise<string> {
  const blocks: string[] = [`# ${siteName}`, `> ${siteDescription}`];
  if (config.intro) blocks.push(config.intro);

  // Pages — dedupe seeded with '/', mirroring src/app/sitemap.ts.
  const seen = new Set<string>(['/']);
  const pageLines: string[] = [renderLink('Home', `${siteUrl}/`, config.pageDescriptions?.['/'])];

  for (const item of navItems) {
    if (item.requiresAuth) continue; // auth/admin pages aren't public
    if (!item.href.startsWith('/')) continue; // external links aren't ours to list
    if (item.href.includes('#')) continue; // anchors aren't separate URLs
    if (seen.has(item.href)) continue;
    seen.add(item.href);
    pageLines.push(
      renderLink(item.label, `${siteUrl}${item.href}`, config.pageDescriptions?.[item.href]),
    );
  }

  for (const route of await seoRoutes()) {
    if (!route.path.startsWith('/')) continue;
    if (route.path.includes('#')) continue;
    if (seen.has(route.path)) continue;
    seen.add(route.path);
    pageLines.push(
      renderLink(
        labelFromPath(route.path),
        `${siteUrl}${route.path}`,
        config.pageDescriptions?.[route.path],
      ),
    );
  }

  blocks.push(['## Pages', ...pageLines].join('\n'));

  // Extra curated sections from the companion.
  for (const section of config.sections ?? []) {
    const lines = section.links.map((l) => renderLink(l.label, resolveHref(l.href), l.description));
    blocks.push([`## ${section.title}`, ...lines].join('\n'));
  }

  // Optional — per spec, content safe to skip for shorter contexts.
  if (config.optional && config.optional.length > 0) {
    const lines = config.optional.map((l) =>
      renderLink(l.label, resolveHref(l.href), l.description),
    );
    blocks.push(['## Optional', ...lines].join('\n'));
  }

  return `${blocks.join('\n\n')}\n`;
}
