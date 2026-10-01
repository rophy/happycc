import { createHash, randomBytes, webcrypto } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('expo-crypto', () => ({
    getRandomBytes: (size: number) => new Uint8Array(randomBytes(size)),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256', SHA512: 'SHA-512' },
    digest: (algorithm: string, bytes: Uint8Array) => webcrypto.subtle.digest(algorithm, bytes),
}));
vi.mock('@/encryption/libsodium.lib', () => ({ default: sodium }));

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import {
    OidcLoginError,
    buildLoginUrl,
    createPendingLogin,
    deserializePendingLogin,
    exchangeCode,
    serializePendingLogin,
} from './oidcLogin';

const SERVER = 'https://happy.test';

beforeAll(async () => {
    await sodium.ready;
});

function exchangeServer(respond: (body: any) => { status: number; body: unknown }) {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const body = JSON.parse(String(init.body));
        calls.push({ url: String(input), body, headers: init.headers });
        const result = respond(body);
        return new Response(JSON.stringify(result.body), { status: result.status });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
}

describe('createPendingLogin', () => {
    it('creates an S256 challenge the server accepts and a 32-byte box keypair', async () => {
        const pending = await createPendingLogin();
        // Mirrors happy-server redeemExchangeCode.
        expect(createHash('sha256').update(pending.codeVerifier).digest('base64url')).toBe(pending.codeChallenge);
        expect(pending.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
        expect(decodeBase64(pending.publicKey)).toHaveLength(32);
        expect(decodeBase64(pending.secretKey)).toHaveLength(32);
        const other = await createPendingLogin();
        expect(other.codeVerifier).not.toBe(pending.codeVerifier);
        expect(other.publicKey).not.toBe(pending.publicKey);
    });

    it('round-trips through sessionStorage serialization', async () => {
        const pending = await createPendingLogin();
        expect(deserializePendingLogin(serializePendingLogin(pending))).toEqual(pending);
        expect(deserializePendingLogin('{"codeVerifier":1}')).toBeNull();
        expect(deserializePendingLogin('nope')).toBeNull();
    });

    it('records createdAt and rejects pending logins older than 10 minutes', async () => {
        const pending = await createPendingLogin();
        const t0 = 1_700_000_000_000;
        const raw = serializePendingLogin(pending, t0);
        expect(JSON.parse(raw).createdAt).toBe(t0);
        expect(deserializePendingLogin(raw, t0 + 10 * 60 * 1000)).toEqual(pending);
        expect(deserializePendingLogin(raw, t0 + 10 * 60 * 1000 + 1)).toBeNull();
        const { createdAt: _omit, ...withoutCreatedAt } = JSON.parse(raw);
        expect(deserializePendingLogin(JSON.stringify(withoutCreatedAt), t0)).toBeNull();
    });
});

describe('buildLoginUrl', () => {
    it('builds web and mobile login URLs', async () => {
        const pending = await createPendingLogin();
        const web = new URL(buildLoginUrl({ serverUrl: SERVER, pending, client: 'web' }));
        expect(web.origin + web.pathname).toBe(`${SERVER}/v1/auth/oidc/login`);
        expect(web.searchParams.get('client')).toBe('web');
        expect(web.searchParams.get('code_challenge')).toBe(pending.codeChallenge);
        expect(web.searchParams.has('redirect_uri')).toBe(false);

        const mobile = new URL(buildLoginUrl({ serverUrl: SERVER, pending, client: 'mobile', redirectUri: 'corpapp://auth/callback' }));
        expect(mobile.searchParams.get('client')).toBe('mobile');
        expect(mobile.searchParams.get('redirect_uri')).toBe('corpapp://auth/callback');
    });
});

describe('exchangeCode', () => {
    it('redeems the code and opens the key bundle', async () => {
        const pending = await createPendingLogin();
        const rootSecret = new Uint8Array(randomBytes(32));
        const server = exchangeServer((body) => ({
            status: 200,
            body: {
                accountId: 'acc_1',
                accessToken: 'access-1',
                refreshToken: 'refresh-1',
                keyBundle: encodeBase64(encryptBox(rootSecret, decodeBase64(body.ephemeralPublicKey))),
            },
        }));
        const credentials = await exchangeCode({ serverUrl: SERVER, code: 'code-1', pending, deviceName: 'Web', fetchImpl: server.fetchImpl });
        expect(credentials).toEqual({ token: 'access-1', refreshToken: 'refresh-1', secret: encodeBase64(rootSecret, 'base64url') });
        expect(server.calls[0].url).toBe(`${SERVER}/v1/auth/oidc/exchange`);
        expect(server.calls[0].body).toEqual({
            code: 'code-1',
            codeVerifier: pending.codeVerifier,
            ephemeralPublicKey: pending.publicKey,
            deviceName: 'Web',
        });
    });

    it('explains an expired or reused code', async () => {
        const pending = await createPendingLogin();
        const server = exchangeServer(() => ({ status: 400, body: { error: 'invalid_grant' } }));
        await expect(exchangeCode({ serverUrl: SERVER, code: 'c', pending, deviceName: 'Web', fetchImpl: server.fetchImpl }))
            .rejects.toThrow(/expired or was already used/);
    });

    it('rejects a key bundle that was not sealed to this login', async () => {
        const pending = await createPendingLogin();
        const stranger = sodium.crypto_box_keypair();
        const server = exchangeServer(() => ({
            status: 200,
            body: {
                accessToken: 'a', refreshToken: 'r',
                keyBundle: encodeBase64(encryptBox(new Uint8Array(32), stranger.publicKey)),
            },
        }));
        const error = await exchangeCode({ serverUrl: SERVER, code: 'c', pending, deviceName: 'Web', fetchImpl: server.fetchImpl }).catch((e) => e);
        expect(error).toBeInstanceOf(OidcLoginError);
        expect(error.message).toMatch(/key bundle/i);
    });

    it('reports network failures', async () => {
        const pending = await createPendingLogin();
        const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
        await expect(exchangeCode({ serverUrl: SERVER, code: 'c', pending, deviceName: 'Web', fetchImpl }))
            .rejects.toThrow(/reach the server/);
    });
});
