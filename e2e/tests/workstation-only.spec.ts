import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.beforeEach(async ({ page }) => {
    await signIn(page);
});

test('the new session route is not available', async ({ page }) => {
    await page.goto('/new');
    await expect(page.getByText('Not available in this build').first()).toBeVisible();
});

test('machine routes are not available', async ({ page }) => {
    await page.goto('/machine/x');
    await expect(page.getByText('Not available in this build').first()).toBeVisible();
});

test('the home screen offers no way to start a session', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('happycc auth login').first()).toBeVisible();
    await expect(page.getByText('New session', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Start New Session', { exact: true })).toHaveCount(0);
});
