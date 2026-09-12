import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the page sources + companion so the filters/merge can be exercised
// deterministically. '@/lib/site' stays real → siteUrl is the localhost default
// (NEXT_PUBLIC_APP_URL) and siteName/siteDescription come from the brand seed.
vi.mock('@/lib/nav', () => ({
  navItems: [
    { label: 'Home', href: '/', group: 'primary' }, // deduped against the seeded '/'
    { label: 'Pricing', href: '/pricing', group: 'primary' },
    { label: 'Docs', href: '/docs', group: 'primary' },
    { label: 'Dashboard', href: '/dashboard', group: 'primary', requiresAuth: true }, // skipped
    { label: 'GitHub', href: 'https://github.com/acme', group: 'footer' }, // external, skipped
    { label: 'Features', href: '/#features', group: 'primary' }, // anchor, skipped
    { label: 'Pricing (footer)', href: '/pricing', group: 'footer' }, // duplicate, skipped
  ],
}));

vi.mock('@/lib/seo-routes', () => ({
  seoRoutes: async () => [
    { path: '/blog/hello-world', priority: 0.6 },
    { path: '/champions/aatrox' },
    { path: '/pricing' }, // already seen via nav, skipped
    { path: '/blog#section' }, // anchor, skipped
    { path: 'relative' }, // not app-absolute, skipped
  ],
}));

vi.mock('@/lib/llms-config', () => ({
  llmsConfig: {
    intro: 'Test intro paragraph.',
    pageDescriptions: {
      '/pricing': 'Our plans.',
      '/blog/hello-world': 'First post.',
    },
    sections: [
      {
        title: 'Docs',
        links: [
          { label: 'API', href: '/docs/api', description: 'REST endpoints.' },
          { label: 'Status', href: 'https://status.example.com' },
        ],
      },
    ],
    optional: [{ label: 'Changelog', href: '/changelog' }],
  },
}));

import { GET } from '../../src/app/llms.txt/route';

const ORIGIN = 'http://localhost:3000';

let prevIndexable: string | undefined;

beforeEach(() => {
  prevIndexable = process.env.SEO_INDEXABLE;
});

afterEach(() => {
  if (prevIndexable === undefined) delete process.env.SEO_INDEXABLE;
  else process.env.SEO_INDEXABLE = prevIndexable;
  vi.clearAllMocks();
});

describe('/llms.txt route', () => {
  it('404s when SEO_INDEXABLE is unset (fail-closed like robots)', async () => {
    delete process.env.SEO_INDEXABLE;
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it('404s when SEO_INDEXABLE is not exactly "true"', async () => {
    process.env.SEO_INDEXABLE = 'false';
    expect((await GET()).status).toBe(404);
    process.env.SEO_INDEXABLE = '1';
    expect((await GET()).status).toBe(404);
  });

  describe('when indexable', () => {
    let body: string;
    let res: Response;

    beforeEach(async () => {
      process.env.SEO_INDEXABLE = 'true';
      res = await GET();
      body = await res.text();
    });

    it('serves text/plain; charset=utf-8', () => {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    });

    it('starts with the site name heading and description blockquote', () => {
      expect(
        body.startsWith(
          '# Causelark\n\n> Run autonomous agents safely in deterministic worlds. A simulation and evaluation platform for reproducible agent engineering.',
        ),
      ).toBe(true);
    });

    it('renders the intro paragraph after the blockquote', () => {
      expect(body).toContain('\n\nTest intro paragraph.\n\n');
    });

    it('lists public nav pages with the sitemap filters applied', () => {
      expect(body).toContain('## Pages');
      expect(body).toContain(`- [Home](${ORIGIN}/)`);
      expect(body).toContain(`- [Docs](${ORIGIN}/docs)`);
      // requiresAuth, external, and anchor items are skipped.
      expect(body).not.toContain('Dashboard');
      expect(body).not.toContain('github.com');
      expect(body).not.toContain('#features');
    });

    it('dedupes repeated hrefs (Pricing appears once)', () => {
      const occurrences = body.split(`(${ORIGIN}/pricing)`).length - 1;
      expect(occurrences).toBe(1);
    });

    it('merges pageDescriptions into the Pages list', () => {
      expect(body).toContain(`- [Pricing](${ORIGIN}/pricing): Our plans.`);
      expect(body).toContain(`- [Hello World](${ORIGIN}/blog/hello-world): First post.`);
    });

    it('includes seoRoutes() entries with derived labels and skips their filtered paths', () => {
      expect(body).toContain(`- [Aatrox](${ORIGIN}/champions/aatrox)`);
      expect(body).not.toContain('/blog#section');
      expect(body).not.toContain('](relative)');
    });

    it('renders extra curated sections (app-absolute prefixed, external kept as-is)', () => {
      expect(body).toContain('## Docs');
      expect(body).toContain(`- [API](${ORIGIN}/docs/api): REST endpoints.`);
      expect(body).toContain('- [Status](https://status.example.com)');
    });

    it('renders the Optional section', () => {
      expect(body).toContain('## Optional');
      expect(body).toContain(`- [Changelog](${ORIGIN}/changelog)`);
    });

    it('emits only absolute URLs (no relative link targets)', () => {
      expect(body).not.toContain('](/');
    });
  });
});
