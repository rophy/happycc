import { expect, test, type Request } from '@playwright/test';
import {
    SERVER_URL,
    accessTokenExpiry,
    expectSignedIn,
    expectSignedOut,
    expireAccessToken,
    readCredentials,
    redeemRefreshToken,
    signIn,
    writeCredentials,
} from './helpers';

test('signs in through the identity provider', async ({ page }) => {
    await signIn(page);
    // Reloading keeps the session (credentials persisted, no second login).
    await page.reload();
    await expectSignedIn(page);
});

test('logout returns to sign-in and revokes the device', async ({ page }) => {
    await signIn(page);
    const before = (await readCredentials(page))!;

    await page.goto('/settings/account');
    await page.getByText('Logout', { exact: true }).first().click();
    // The web confirm modal renders after the page, so its "Logout" button is the last match.
    await page.getByText('Logout', { exact: true }).last().click();

    await page.waitForURL((url) => url.pathname === '/');
    await expectSignedOut(page);
    expect(await redeemRefreshToken(page, before.refreshToken)).toBe(401);
});

test('a revoked session returns to sign-in', async ({ page }) => {
    await signIn(page);
    const credentials = (await readCredentials(page))!;

    const status = await page.evaluate(async ([url, token]) => {
        const response = await fetch(`${url}/v1/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        return response.status;
    }, [SERVER_URL, credentials.token] as const);
    expect(status).toBe(200);

    // Force the next request to refresh: the revoked device's refresh token is rejected.
    await writeCredentials(page, { ...credentials, token: expireAccessToken(credentials.token) });
    await page.reload();
    await expectSignedOut(page);
});

test('two tabs share one refresh without revoking the device', async ({ context }) => {
    const tabA = await context.newPage();
    await signIn(tabA);
    const tabB = await context.newPage();
    await tabB.goto('/');
    await expectSignedIn(tabB);

    const refreshes: Request[] = [];
    for (const tab of [tabA, tabB]) {
        tab.on('request', (request) => {
            if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/auth/refresh') {
                refreshes.push(request);
            }
        });
    }

    // Both tabs start from an expired access token and must refresh at the same time.
    const credentials = (await readCredentials(tabA))!;
    await writeCredentials(tabA, { ...credentials, token: expireAccessToken(credentials.token) });
    await Promise.all([tabA.reload(), tabB.reload()]);
    await expectSignedIn(tabA);
    await expectSignedIn(tabB);

    // One tab refreshed; the other adopted its rotation inside the lock.
    expect(refreshes).toHaveLength(1);
    const after = (await readCredentials(tabA))!;
    expect(after.refreshToken).not.toBe(credentials.refreshToken);
    expect(accessTokenExpiry(after.token)).toBeGreaterThan(Date.now() + 2 * 60 * 1000);

    // The device survived: its current refresh token still redeems.
    expect(await redeemRefreshToken(tabA, after.refreshToken)).toBe(200);
});
