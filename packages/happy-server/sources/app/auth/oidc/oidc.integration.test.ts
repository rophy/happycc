/**
 * Requires oidc-mock from the repo docker-compose:  docker compose up -d oidc-mock
 * Run with:  pnpm --filter happy-server test:integration
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { HttpBrowser, pickerFields } from '@/testing/httpBrowser';

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const ISSUER = process.env.IT_OIDC_ISSUER ?? 'http://localhost:8180';
const CLIENT_ID = 'happy-server';
const CLIENT_SECRET = 'happy-dev-secret';

let deriveContentPublicKey: (root: Uint8Array) => Uint8Array;

beforeAll(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-oidc-it-'));
    const pgliteDir = path.join(dataDir, 'pglite');
    Object.assign(process.env, {
        OIDC_ISSUER: ISSUER,
        OIDC_CLIENT_ID: CLIENT_ID,
        OIDC_CLIENT_SECRET: CLIENT_SECRET,
        OIDC_ALLOW_INSECURE_ISSUER: 'true',
        PUBLIC_URL: BASE,
        WEBAPP_URL: BASE,
        DATA_DIR: dataDir, // files.ts uses local storage under DATA_DIR when S3_HOST is unset
        // '@/storage/db' builds its PrismaClient singleton at import time, so these
        // must be set before '@/index' (which imports it) is ever imported.
        DB_PROVIDER: 'pglite',
        PGLITE_DIR: pgliteDir,
    });
    const migrationsDir = path.join(__dirname, '../../../../prisma/migrations');
    const { runMigrations } = await import('@/standalone');
    await runMigrations({ pgliteDir, migrationsDir });
    const { startServer } = await import('@/index');
    await startServer({ pgliteDir: path.join(dataDir, 'pglite'), masterSecret: 'integration-master-secret-0000000000000000', port: PORT, host: '127.0.0.1' });
    ({ deriveContentPublicKey } = await import('./accountKeys'));
});

/** Follows startUrl to the oidc-mock picker, picks `sub`, and follows the redirects back. */
async function idpLogin(browser: HttpBrowser, startUrl: string, sub: string, stopAt?: (url: string) => boolean) {
    const picker = await browser.get(startUrl);
    expect(picker.url.startsWith(`${ISSUER}/authorize`)).toBe(true);
    return browser.postForm(`${ISSUER}/authorize/callback`, pickerFields(picker.body, sub), { stopAt });
}

function openBox(bundleBase64: string, secretKey: Uint8Array): Uint8Array {
    const bundle = privacyKit.decodeBase64(bundleBase64);
    const opened = tweetnacl.box.open(bundle.slice(56), bundle.slice(32, 56), bundle.slice(0, 32), secretKey);
    if (!opened) throw new Error('cannot open key bundle');
    return opened;
}

async function post(pathname: string, body: unknown, token?: string) {
    const res = await fetch(`${BASE}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, json: await res.json() as any };
}

async function webLogin(browser: HttpBrowser, sub: string) {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const result = await idpLogin(
        browser,
        `${BASE}/v1/auth/oidc/login?client=web&code_challenge=${challenge}`,
        sub,
        (url) => url.startsWith(`${BASE}/auth/callback`),
    );
    const code = new URLSearchParams(new URL(result.location!).hash.slice(1)).get('code')!;
    const ephemeral = tweetnacl.box.keyPair();
    const exchange = await post('/v1/auth/oidc/exchange', {
        code, codeVerifier: verifier, ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(ephemeral.publicKey)),
    });
    expect(exchange.status).toBe(200);
    return { ...exchange.json, root: openBox(exchange.json.keyBundle, ephemeral.secretKey) };
}

describe('OIDC against oidc-mock', () => {
    let cliAccountId = '';
    let cliContentKey = new Uint8Array();

    it('CLI device flow: start → IdP login → approve → token', async () => {
        const browser = new HttpBrowser();
        const ephemeral = tweetnacl.box.keyPair();
        const start = await post('/v1/auth/device/start', {
            ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(ephemeral.publicKey)),
            clientInfo: { host: 'it-host', os: 'linux', cliVersion: 'it' },
        });
        expect(start.status).toBe(200);

        const confirm = await idpLogin(browser, start.json.verifyUrlComplete, 'alice');
        expect(confirm.status).toBe(200);
        expect(confirm.body).toContain('it-host');
        const csrf = /name="csrf" value="([^"]+)"/.exec(confirm.body)![1];
        const decided = await browser.postForm(`${BASE}/activate`, { code: start.json.userCode, csrf, decision: 'approve' });
        expect(decided.body).toContain('Return to your terminal');

        await new Promise((r) => setTimeout(r, 5100));
        const token = await post('/v1/auth/device/token', { deviceCode: start.json.deviceCode });
        expect(token.status).toBe(200);
        const plain = openBox(token.json.keyBundle, ephemeral.secretKey);
        expect(plain[0]).toBe(0);
        cliContentKey = plain.slice(1);
        cliAccountId = token.json.accountId;

        const profile = await fetch(`${BASE}/v1/account/profile`, { headers: { authorization: `Bearer ${token.json.accessToken}` } });
        expect(profile.status).toBe(200);
        expect((await profile.json() as any).firstName).toBe('Alice');

        const refreshed = await post('/v1/auth/refresh', { refreshToken: token.json.refreshToken });
        expect(refreshed.status).toBe(200);
        // A client that lost the response may retry the previous token once, within the grace window.
        const retried = await post('/v1/auth/refresh', { refreshToken: token.json.refreshToken });
        expect(retried.status).toBe(200);
        const reused = await post('/v1/auth/refresh', { refreshToken: token.json.refreshToken });
        expect(reused.json).toEqual({ error: 'invalid_grant', reason: 'reused' });
        const afterReuse = await post('/v1/auth/refresh', { refreshToken: retried.json.refreshToken });
        expect(afterReuse.json.reason).toBe('revoked');
    });

    it('web exchange: same account, root secret matches the CLI content key', async () => {
        const web = await webLogin(new HttpBrowser(), 'alice');
        expect(web.accountId).toBe(cliAccountId);
        expect(Buffer.from(deriveContentPublicKey(web.root)).equals(Buffer.from(cliContentKey))).toBe(true);

        const logout = await post('/v1/auth/logout', {}, web.accessToken);
        expect(logout.status).toBe(200);
        const refresh = await post('/v1/auth/refresh', { refreshToken: web.refreshToken });
        expect(refresh.json.reason).toBe('revoked');
    });

    it('a different user gets a different account', async () => {
        const web = await webLogin(new HttpBrowser(), 'bob');
        expect(web.accountId).not.toBe(cliAccountId);
    });

    it('loopback (happy-agent): redirects to 127.0.0.1 and exchanges for the root secret', async () => {
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const redirectUri = 'http://127.0.0.1:9/callback';
        const result = await idpLogin(
            new HttpBrowser(),
            `${BASE}/v1/auth/oidc/login?client=loopback&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirectUri)}`,
            'alice',
            (url) => url.startsWith('http://127.0.0.1:9/'),
        );
        const location = new URL(result.location!);
        expect(`${location.origin}${location.pathname}`).toBe(redirectUri);

        const ephemeral = tweetnacl.box.keyPair();
        const exchange = await post('/v1/auth/oidc/exchange', {
            code: location.searchParams.get('code'),
            codeVerifier: verifier,
            ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(ephemeral.publicKey)),
            deviceName: 'happy-agent@it-host',
        });
        expect(exchange.status).toBe(200);
        expect(exchange.json.accountId).toBe(cliAccountId);
        const root = openBox(exchange.json.keyBundle, ephemeral.secretKey);
        expect(Buffer.from(deriveContentPublicKey(root)).equals(Buffer.from(cliContentKey))).toBe(true);

        const { db } = await import('@/storage/db');
        const device = await db.device.findFirstOrThrow({ where: { accountId: cliAccountId, name: 'happy-agent@it-host' } });
        expect(device.kind).toBe('agent');
    });

    it('revoking the IdP refresh token revokes the account devices at the next check', async () => {
        const web = await webLogin(new HttpBrowser(), 'alice');
        const { db } = await import('@/storage/db');
        const { openIdpRefreshToken } = await import('./keyVault');
        const account = await db.account.findUniqueOrThrow({ where: { id: web.accountId } });
        expect(account.idpRefreshToken).not.toBeNull();

        // Revoke at the IdP, then make the server's 15-minute check due.
        const revoke = await fetch(`${ISSUER}/revoke`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                token: openIdpRefreshToken(account.idpRefreshToken!),
                token_type_hint: 'refresh_token',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
            }).toString(),
        });
        expect(revoke.status).toBe(200);
        await db.account.update({ where: { id: web.accountId }, data: { idpCheckedAt: new Date(0) } });

        const refresh = await post('/v1/auth/refresh', { refreshToken: web.refreshToken });
        expect(refresh.json).toEqual({ error: 'invalid_grant', reason: 'disabled' });
        const active = await db.device.count({ where: { accountId: web.accountId, revokedAt: null } });
        expect(active).toBe(0);
    });
});
