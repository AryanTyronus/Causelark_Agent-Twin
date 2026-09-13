// `themeColor` (browser chrome) defaults to the brand seed; add colorScheme etc. here.

import type { Viewport } from 'next';
import { brandVisual } from '@/lib/brand';

export const viewportConfig: Viewport = {
  themeColor: brandVisual.themeColor,
};
