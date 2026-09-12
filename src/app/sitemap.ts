// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.0.
//
// /sitemap.xml — merges nav pages (src/lib/nav.ts) with programmatic routes
// (src/lib/seo-routes.ts). To add URLs, edit those companions, not this file.
import type { MetadataRoute } from 'next';
import { navItems } from '@/lib/nav';
import { seoRoutes } from '@/lib/seo-routes';
import { siteUrl } from '@/lib/site';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const seen = new Set<string>(['/']);
  const entries: MetadataRoute.Sitemap = [
    { url: `${siteUrl}/`, changeFrequency: 'weekly', priority: 1 },
  ];

  for (const item of navItems) {
    if (item.requiresAuth) continue; // auth/admin pages don't belong in the sitemap
    if (!item.href.startsWith('/')) continue; // external links aren't ours to list
    if (item.href.includes('#')) continue; // anchors aren't separate URLs
    if (seen.has(item.href)) continue;
    seen.add(item.href);
    entries.push({ url: `${siteUrl}${item.href}`, changeFrequency: 'weekly', priority: 0.7 });
  }

  for (const route of await seoRoutes()) {
    if (!route.path.startsWith('/')) continue;
    if (route.path.includes('#')) continue;
    if (seen.has(route.path)) continue;
    seen.add(route.path);
    const { path, ...meta } = route;
    entries.push({ url: `${siteUrl}${path}`, changeFrequency: 'weekly', priority: 0.6, ...meta });
  }

  return entries;
}
