import { configDefaults, defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
  plugins: [tsconfigPaths()]
});
