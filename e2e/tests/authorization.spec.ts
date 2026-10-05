import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

const AUTHZ_MOCK = process.env.AUTHZ_MOCK_URL ?? 'http://localhost:8190';
const CAROL = 'carol@example.com';

test.afterEach(async ({ request }) => {
    await request.delete(`${AUTHZ_MOCK}/deny/${CAROL}`);
});

test('a denied user sees the reason, then gets in once allowed, without signing in again', async ({ page, request }) => {
    await signIn(page, 'Carol Example');
    await request.put(`${AUTHZ_MOCK}/deny/${CAROL}`);
    await page.reload();
    await expect(page.getByText('Not authorized')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`${CAROL} is not allowed to use the app.`)).toBeVisible();

    await request.delete(`${AUTHZ_MOCK}/deny/${CAROL}`);
    await page.waitForTimeout(1_500); // the server caches decisions for AUTHZ_WEBHOOK_CACHE_TTL (1s in compose)
    await page.getByText('Retry', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sessions' }).first()).toBeVisible();
    await expect(page.getByText('Not authorized')).toHaveCount(0);
});

test('a denied user cannot sign in, and is told why', async ({ page, request }) => {
    await request.put(`${AUTHZ_MOCK}/deny/${CAROL}`);
    await page.goto('/');
    await page.getByText('Sign in', { exact: true }).click();
    await page.getByRole('button', { name: /Carol Example/ }).click();
    await expect(page.getByText(`Not authorized: ${CAROL} is not allowed to use the app.`)).toBeVisible({ timeout: 15_000 });
});
