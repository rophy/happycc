import { expect, test, type Page } from '@playwright/test';
import { createSession, deleteSession, signIn } from './helpers';

// None of these depend on what the account holds: they sign in to the app shell,
// not to the empty home state.

test.beforeEach(async ({ page }) => {
    await signIn(page);
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
    const sessionId = await createSession(page);
    try {
        await page.reload();
        await expectNoStartControl(page);
    } finally {
        await deleteSession(page, sessionId);
    }
});

test('the session composer offers no image attachment', async ({ page }) => {
    const sessionId = await createSession(page);
    try {
        await page.goto(`/session/${sessionId}`);
        await expect(page.getByPlaceholder('Type a message ...').first()).toBeVisible();
        await expect(page.getByRole('button', { name: 'Add photo' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Add image' })).toHaveCount(0);
    } finally {
        await deleteSession(page, sessionId);
    }
});
