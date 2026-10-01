import { expect, test } from '@playwright/test';
import { SERVER_URL, readCredentials, signIn } from './helpers';

// The compose stack configures no voice, GitHub, PostHog or Claude connect; push keeps its default.

test('the server reports its integrations to signed-in clients only', async ({ page }) => {
    await signIn(page);
    const credentials = (await readCredentials(page))!;
    const result = await page.evaluate(async ([url, token]) => {
        const anonymous = await fetch(`${url}/v1/features`);
        const signedIn = await fetch(`${url}/v1/features`, { headers: { Authorization: `Bearer ${token}` } });
        return { anonymous: anonymous.status, status: signedIn.status, body: await signedIn.json() };
    }, [SERVER_URL, credentials.token] as const);
    expect(result).toEqual({ anonymous: 401, status: 200, body: { voice: false, githubConnect: false, push: true } });
});

test('settings hide integrations that are not configured', async ({ page }) => {
    await signIn(page);

    await page.goto('/settings');
    await expect(page.getByText('Appearance', { exact: true })).toBeVisible();
    await expect(page.getByText('Support us', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Voice Assistant', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Claude Code', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/^connected accounts$/i)).toHaveCount(0);

    await page.goto('/settings/account');
    await expect(page.getByText('Logout', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Analytics', { exact: true })).toHaveCount(0);
});

test('the Claude.ai connect screen is unreachable without the build flag', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings/connect/claude');
    await page.waitForURL((url) => url.pathname === '/settings');
});
