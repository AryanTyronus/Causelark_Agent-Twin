// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.0. Drift = commit rejected.
//
// Vitest covers unit tests on Zod schemas, API route handler validation
// branches, and pure utilities. Browser-level verification runs engine-side
// against the deployed preview URL, not in this repo.

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['tests/unit/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**'],
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
