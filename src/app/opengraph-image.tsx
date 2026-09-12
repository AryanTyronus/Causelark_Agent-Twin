// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.0.
//
// Open Graph / Twitter image — name + colors come from `brandVisual.og` in src/lib/brand.ts.
import { ImageResponse } from 'next/og';
import { brandVisual, siteName } from '@/lib/brand';

export const alt = siteName;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  const { background, foreground, tagline } = brandVisual.og;
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background,
        color: foreground,
        padding: '0 80px',
        textAlign: 'center',
      }}
    >
      <div style={{ display: 'flex', fontSize: 96, fontWeight: 700, letterSpacing: '-0.02em' }}>
        {siteName}
      </div>
      {tagline ? (
        <div style={{ display: 'flex', marginTop: 24, fontSize: 40, opacity: 0.7 }}>{tagline}</div>
      ) : null}
    </div>,
    size,
  );
}
