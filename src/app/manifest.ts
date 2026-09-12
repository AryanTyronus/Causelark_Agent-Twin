// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.0.
//
// /manifest.webmanifest — colors come from `brandVisual` in src/lib/brand.ts; set them there.
import type { MetadataRoute } from 'next';
import { brandVisual } from '@/lib/brand';
import { siteDescription, siteName } from '@/lib/site';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: siteName,
    short_name: siteName,
    description: siteDescription,
    start_url: '/',
    display: 'standalone',
    background_color: brandVisual.backgroundColor,
    theme_color: brandVisual.themeColor,
    icons: [{ src: '/icon.svg', type: 'image/svg+xml', sizes: 'any' }],
  };
}
