// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.0.
//
// next-themes wrapper. Wired into layout.tsx providers slot (class-based dark mode).
'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type * as React from 'react';

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
