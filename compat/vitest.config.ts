import { defineConfig } from 'vitest/config';
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
        globalSetup: ['./src/globalSetup.ts'],
        fileParallelism: false,
        maxWorkers: 1,
        minWorkers: 1,
        testTimeout: 180_000,
        hookTimeout: 300_000,
        reporters: ['default', ['json', { outputFile: 'results.json' }]],
    },
});
