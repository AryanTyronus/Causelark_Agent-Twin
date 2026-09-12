// @polsia:user-owned — programmatic SEO URLs for /sitemap.xml: dynamic [slug]
// pages (e.g. /champions/[slug]) that aren't in the nav menu. Edit this file,
// never src/app/sitemap.ts (framework-owned). Return one entry per page with an
// app-absolute `path` ('/...'); may be async to fetch data. Return [] if none.
//
//   export async function seoRoutes(): Promise<SeoRoute[]> {
//     const items = await getItems();
//     return items.map((i) => ({ path: `/items/${i.slug}`, priority: 0.6 }));
//   }
import type { MetadataRoute } from 'next';

/** App-absolute `path` (e.g. /items/aatrox) + optional Next sitemap fields. */
export type SeoRoute = { path: string } & Omit<MetadataRoute.Sitemap[number], 'url'>;

export async function seoRoutes(): Promise<SeoRoute[]> {
  return [];
}
