import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['sources/**/*.integration.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  plugins: [tsconfigPaths()]
});
