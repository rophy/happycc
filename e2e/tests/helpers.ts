import { expect, type Page } from '@playwright/test';

export const SERVER_URL = process.env.HAPPY_SERVER_URL ?? 'http://localhost:3005';
const WEBAPP_URL = process.env.HAPPY_WEBAPP_URL ?? 'http://localhost:8080';
const AUTH_KEY = 'auth_credentials';

export interface Credentials {
    token: string;
    refreshToken: string;
    secret: string;
}

export async function readCredentials(page: Page): Promise<Credentials | null> {
    return page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    }, AUTH_KEY);
}

export async function writeCredentials(page: Page, credentials: Credentials): Promise<void> {
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [AUTH_KEY, JSON.stringify(credentials)] as const);
}

/** Same access token, but already expired: the app must refresh before using it. */
export function expireAccessToken(token: string): string {
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    claims.exp = Math.floor(Date.now() / 1000) - 60;
    return `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
}

export function accessTokenExpiry(token: string): number {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return claims.exp * 1000;
}

/** POST /v1/auth/refresh from the page; returns the HTTP status. */
export async function redeemRefreshToken(page: Page, refreshToken: string): Promise<number> {
    return page.evaluate(async ([url, token]) => {
        const response = await fetch(`${url}/v1/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: token }),
        });
        return response.status;
    }, [SERVER_URL, refreshToken] as const);
}

export async function expectSignedIn(page: Page): Promise<void> {
    await expect(page.getByText('happyco auth login').first()).toBeVisible();
    await expect(page.getByText('Sign in', { exact: true })).toHaveCount(0);
    const credentials = await readCredentials(page);
    expect(credentials?.refreshToken).toBeTruthy();
    expect(page.url()).not.toContain('#code');
}

export async function expectSignedOut(page: Page): Promise<void> {
    await expect(page.getByText('Sign in', { exact: true })).toBeVisible();
    expect(await readCredentials(page)).toBeNull();
}

/** Sign-in button → server → oidc-mock picker → server → /auth/callback → home. */
export async function signIn(page: Page, user = 'Alice Example'): Promise<void> {
    await page.goto('/');
    await page.getByText('Sign in', { exact: true }).click();
    await page.getByRole('button', { name: new RegExp(user) }).click();
    await page.waitForURL((url) => url.origin === new URL(WEBAPP_URL).origin && url.pathname === '/');
    await expectSignedIn(page);
}
