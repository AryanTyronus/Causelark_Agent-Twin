import { describe, expect, it } from 'vitest';
import { buildCsp } from '@/lib/csp';

// Locks the platform CSP posture so a future edit can't silently re-tighten
// style-src (breaks Radix/shadcn in prod) or loosen script-src (XSS regression).
describe('buildCsp', () => {
  const scriptSrc = (csp: string) =>
    csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
  const styleSrc = (csp: string) =>
    csp.split(';').find((d) => d.trim().startsWith('style-src')) ?? '';

  it('keeps script-src strict in production: nonce + strict-dynamic, no unsafe-inline/eval', () => {
    const s = scriptSrc(buildCsp('abc123', false));
    expect(s).toContain("'nonce-abc123'");
    expect(s).toContain("'strict-dynamic'");
    expect(s).not.toContain("'unsafe-inline'");
    expect(s).not.toContain("'unsafe-eval'");
  });

  it('allows inline styles (style-src unsafe-inline, NO style nonce) so headless UI works in prod', () => {
    const s = styleSrc(buildCsp('abc123', false));
    expect(s).toContain("'unsafe-inline'");
    // a nonce on style-src would make 'unsafe-inline' ignored — must not be present
    expect(s).not.toContain('nonce-');
  });

  it('only adds unsafe-eval to script-src in development', () => {
    expect(scriptSrc(buildCsp('n', true))).toContain("'unsafe-eval'");
    expect(scriptSrc(buildCsp('n', false))).not.toContain("'unsafe-eval'");
  });

  it('locks the rest of the policy down', () => {
    const csp = buildCsp('n', false);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it('appends a configured API origin to connect-src', () => {
    expect(buildCsp('n', false, 'https://api.example.com')).toContain(
      "connect-src 'self' https://api.example.com",
    );
  });
});

// The per-app cspExtraSources seam (next.user-config.ts) may open resource
// directives, but must never loosen the script/style rampart or accept wildcards.
describe('buildCsp — extra sources seam', () => {
  const directive = (csp: string, name: string) =>
    csp
      .split(';')
      .find((d) => d.trim().startsWith(`${name} `))
      ?.trim() ?? '';

  it('stays same-origin-only when no extras are given', () => {
    const csp = buildCsp('n', false);
    expect(directive(csp, 'frame-src')).toBe("frame-src 'self'");
    expect(directive(csp, 'media-src')).toBe("media-src 'self'");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
  });

  it('appends extras to their own resource directives', () => {
    const csp = buildCsp('n', false, '', {
      frameSrc: ['https://js.stripe.com'],
      connectSrc: ['https://api.supabase.co'],
      mediaSrc: ['https://cdn.example.com'],
      fontSrc: ['https://fonts.gstatic.com'],
    });
    expect(directive(csp, 'frame-src')).toBe("frame-src 'self' https://js.stripe.com");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self' https://api.supabase.co");
    expect(directive(csp, 'media-src')).toBe("media-src 'self' https://cdn.example.com");
    expect(directive(csp, 'font-src')).toContain('https://fonts.gstatic.com');
  });

  it('keeps the configured API origin alongside extra connect-src entries', () => {
    const csp = buildCsp('n', false, 'https://api.example.com', {
      connectSrc: ['wss://realtime.example.com'],
    });
    expect(directive(csp, 'connect-src')).toBe(
      "connect-src 'self' https://api.example.com wss://realtime.example.com",
    );
  });

  it('drops wildcard and execution-escape tokens from extras', () => {
    const csp = buildCsp('n', false, '', {
      frameSrc: ['*', 'https://ok.example.com'],
      connectSrc: ["'unsafe-inline'", "'strict-dynamic'", 'https://fine.example.com'],
    });
    expect(directive(csp, 'frame-src')).toBe("frame-src 'self' https://ok.example.com");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self' https://fine.example.com");
  });

  it('deduplicates repeated source tokens', () => {
    const csp = buildCsp('n', false, 'https://api.example.com', {
      connectSrc: ['https://api.example.com', "'self'"],
    });
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self' https://api.example.com");
  });

  it('never lets extras reach script-src or style-src (XSS rampart intact)', () => {
    const csp = buildCsp('abc', false, 'https://api.example.com', {
      frameSrc: ['https://frame.example.com'],
      connectSrc: ['https://connect.example.com'],
      fontSrc: ['https://font.example.com'],
    });
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
    // extra origins land only on their resource directives, never on script/style
    expect(directive(csp, 'script-src')).not.toContain('example.com');
    expect(directive(csp, 'style-src')).not.toContain('example.com');
  });
});
