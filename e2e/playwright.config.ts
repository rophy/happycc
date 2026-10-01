import { defineConfig } from '@playwright/test';

// The stack is started outside Playwright: docker compose --profile e2e up -d --build.
// For the two-tab test to prove there is no refresh-token replay, start the server
// with AUTH_REFRESH_REUSE_GRACE=0s (CI does). The socket reconnect test needs
// AUTH_ACCESS_TOKEN_TTL=3m (CI does) and skips with longer tokens.
export default defineConfig({
    testDir: './tests',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 120_000,
    expect: { timeout: 30_000 },
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    globalSetup: './globalSetup.ts',
    use: {
        baseURL: process.env.HAPPY_WEBAPP_URL ?? 'http://localhost:8080',
        // Phone-sized viewport: the phone layout shows the empty state with the CLI hint.
        viewport: { width: 375, height: 667 },
        browserName: 'chromium',
        trace: 'retain-on-failure',
    },
});
