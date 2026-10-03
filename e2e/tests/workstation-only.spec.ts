import { expect, test, type Page } from '@playwright/test';
import { createSession, signInToShell } from './helpers';

// None of these depend on what the account holds: they sign in to the app shell,
// not to the empty home state.

test.beforeEach(async ({ page }) => {
    await signInToShell(page);
});

async function expectNoStartControl(page: Page): Promise<void> {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sessions' }).first()).toBeVisible();
    await expect(page.getByText('New session', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Start New Session', { exact: true })).toHaveCount(0);
}

test('the new session route is not available', async ({ page }) => {
    await page.goto('/new');
    await expect(page.getByText('Not available in this build').first()).toBeVisible();
});

test('machine routes are not available', async ({ page }) => {
    await page.goto('/machine/x');
    await expect(page.getByText('Not available in this build').first()).toBeVisible();
});

test('the home screen offers no way to start a session', async ({ page }) => {
    // Whatever the account holds now (empty or populated)...
    await expectNoStartControl(page);
    // ...and after it certainly holds a session.
    await createSession(page);
    await page.reload();
    await expectNoStartControl(page);
});
