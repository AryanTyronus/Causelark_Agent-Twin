import { describe, expect, it } from 'vitest';
import { buildPermissionsPolicy } from '@/lib/permissions-policy';

// Locks the Permissions-Policy posture: every feature is disabled by default and
// only an explicit opt-in flips it to (self); browsing-topics is never openable.
describe('buildPermissionsPolicy', () => {
  it('disables every feature by default (empty allow-lists)', () => {
    expect(buildPermissionsPolicy()).toBe(
      'camera=(), microphone=(), geolocation=(), browsing-topics=()',
    );
  });

  it('matches the historical hardcoded header when nothing is opted in', () => {
    // Regression guard: the pre-seam value must be reproduced exactly so a fresh
    // app keeps the identical locked-down header.
    expect(buildPermissionsPolicy({})).toBe(
      'camera=(), microphone=(), geolocation=(), browsing-topics=()',
    );
  });

  it('opts a single feature in as (self) and leaves the rest disabled', () => {
    const value = buildPermissionsPolicy({ microphone: true });
    expect(value).toContain('microphone=(self)');
    expect(value).toContain('camera=()');
    expect(value).toContain('geolocation=()');
  });

  it('opts multiple features in independently', () => {
    const value = buildPermissionsPolicy({ camera: true, geolocation: true });
    expect(value).toContain('camera=(self)');
    expect(value).toContain('geolocation=(self)');
    expect(value).toContain('microphone=()');
  });

  it('keeps browsing-topics hard-off even when every opt-in is on', () => {
    // There is no seam to enable ad tracking: it stays () regardless of opt-ins.
    const value = buildPermissionsPolicy({ microphone: true, camera: true, geolocation: true });
    expect(value).toContain('browsing-topics=()');
    expect(value).not.toContain('browsing-topics=(self)');
  });
});
