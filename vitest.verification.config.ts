// Verification config: same resolution rules as the unit suite, but a separate
// include so the database-backed harness never runs as part of `npm test`.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/verification/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
    setupFiles: ['tests/verification/setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
