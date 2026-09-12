// @vitest-environment node
// node not jsdom — jsdom rewrites import.meta.url to a non-file scheme.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface OwnershipEntry {
  path: string;
  tier: string;
  strategy?: string;
  additions?: string;
  slot?: string;
}

const ownership = JSON.parse(
  readFileSync(new URL('../../.polsia/ownership.json', import.meta.url), 'utf-8'),
) as { paths: OwnershipEntry[] };

const find = (path: string) => ownership.paths.find((e) => e.path === path);

// Formats that can carry ownership banners.
const BANNERABLE = /\.(ts|tsx|mjs|cjs|js|css|prisma)$/;
const isConcrete = (path: string) => !path.includes('*');
const readSource = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf-8');
const bannerablePaths = (tier: string) =>
  ownership.paths
    .filter((e) => e.tier === tier && isConcrete(e.path) && BANNERABLE.test(e.path))
    .map((e) => e.path);

describe('.polsia/ownership.json', () => {
  it.each(['src/app/api/**', 'prisma/schema/*.prisma', 'src/hooks/**'])(
    'has no broad framework glob %s (agent-authored files must stay app-owned)',
    (path) => {
      expect(find(path)).toBeUndefined();
    },
  );

  it.each([
    'src/app/health/route.ts',
    'prisma/schema/_base.prisma',
    'prisma/migrations/migration_lock.toml',
    'src/lib/site.ts',
    'src/app/robots.ts',
    'src/app/sitemap.ts',
    'src/app/llms.txt/route.ts',
    'src/lib/llms.ts',
    'src/app/manifest.ts',
    'src/app/opengraph-image.tsx',
  ])('keeps template-shipped %s framework_owned', (path) => {
    expect(find(path)?.tier).toBe('framework_owned');
  });

  it.each(['src/app/api/example/**', 'src/lib/contracts/example.ts'])(
    'keeps the data-plane example %s user_owned (deletable)',
    (path) => {
      expect(find(path)?.tier).toBe('user_owned');
    },
  );

  it('keeps src/lib/env.ts shared with the composed strategy (gate layer 2)', () => {
    const entry = find('src/lib/env.ts');
    expect(entry?.tier).toBe('shared');
    expect(entry?.strategy).toBe('composed');
  });

  it('keeps src/lib/nav.ts user_owned with no slot/composed treatment', () => {
    const entry = find('src/lib/nav.ts');
    expect(entry?.tier).toBe('user_owned');
    expect(entry?.strategy).toBeUndefined();
    expect(entry?.slot).toBeUndefined();
  });

  it('keeps src/lib/llms-config.ts user_owned with no slot/composed treatment (form lives in llms.ts)', () => {
    const entry = find('src/lib/llms-config.ts');
    expect(entry?.tier).toBe('user_owned');
    expect(entry?.strategy).toBeUndefined();
    expect(entry?.slot).toBeUndefined();
  });

  it('keeps src/components/custom/site-nav.tsx user_owned (agent may restyle)', () => {
    expect(find('src/components/custom/site-nav.tsx')?.tier).toBe('user_owned');
  });

  it('keeps src/app/icon.svg user_owned (agent replaces it in place with a brand icon)', () => {
    expect(find('src/app/icon.svg')?.tier).toBe('user_owned');
  });

  it('keeps src/lib/brand.ts user_owned (agent sets the brand)', () => {
    expect(find('src/lib/brand.ts')?.tier).toBe('user_owned');
  });

  // Auth + dashboard route groups are user_owned: the agent builds/restyles pages
  // freely. The auth SECURITY surface (lib/auth, api/auth, schema, guards) is
  // framework_owned via the auth MODULE's own entries, not a route-group blanket —
  // so neither group carries a framework_owned/installer-only blanket here.
  it.each(['src/app/(auth)/**', 'src/app/(dashboard)/**'])(
    'keeps %s user_owned (no route-group framework blanket; security lives in the auth module)',
    (path) => {
      const entry = find(path);
      expect(entry?.tier).toBe('user_owned');
      expect(entry?.additions).toBeUndefined();
    },
  );
});

// Keep reader-facing source banners aligned with the ownership map.
describe('ownership banners agree with the tier map', () => {
  it.each(bannerablePaths('framework_owned'))(
    'framework_owned %s carries the @polsia:framework-owned banner',
    (path) => {
      expect(readSource(path)).toContain('@polsia:framework-owned');
    },
  );

  it.each(bannerablePaths('shared'))('shared %s carries the @polsia:shared banner', (path) => {
    expect(readSource(path)).toContain('@polsia:shared');
  });
});
