// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.2.
//
// Visitor beacon: a pixel per page load from the deploy-injected slug + base.
'use client';

import { useEffect } from 'react';

export function PolsiaAnalytics({ slug, base }: { slug: string; base?: string }) {
  useEffect(() => {
    if (!slug) return;
    try {
      let vid = localStorage.getItem('polsia_vid');
      if (!vid) {
        vid = crypto.randomUUID();
        localStorage.setItem('polsia_vid', vid);
      }
      const host = (base ?? 'https://polsia.com').replace(/\/+$/, '');
      new Image().src = `${host}/api/beacon/pixel?s=${encodeURIComponent(slug)}&v=${encodeURIComponent(vid)}`;
    } catch {
      // best-effort: a beacon failure must never surface to the visitor
    }
  }, [slug, base]);
  return null;
}
