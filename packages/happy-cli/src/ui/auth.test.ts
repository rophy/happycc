import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeJwt, startFakeAuthServer } from '@/testing/fakeAuthServer';

const mockConfiguration = vi.hoisted(() => ({
    happyHomeDir: '', privateKeyFile: '', settingsFile: '', serverUrl: '', currentCliVersion: '9.9.9',
    logsDir: '/tmp', isDaemonProcess: false,
}));
vi.mock('@/configuration', () => ({ configuration: mockConfiguration }));

import { readCredentials } from '@/persistence';
import { DeviceLoginError, deviceLogin } from './auth';

let dir: string;
let server: Awaited<ReturnType<typeof startFakeAuthServer>> | null = null;
const clientInfo = { host: 'dev-42', os: 'linux', cliVersion: '9.9.9' };

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-login-'));
    mockConfiguration.happyHomeDir = dir;
    mockConfiguration.privateKeyFile = join(dir, 'access.key');
    mockConfiguration.settingsFile = join(dir, 'settings.json');
});
afterEach(async () => {
    await server?.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
});

function io() {
    const lines: string[] = [];
    const qrs: string[] = [];
    const sleeps: number[] = [];
    return {
        lines, qrs, sleeps,
        io: { print: (l: string) => lines.push(l), showQr: (u: string) => qrs.push(u), sleep: async (ms: number) => { sleeps.push(ms); } },
    };
}

/** Fake server: `responses` are returned by /device/token in order. */
async function fakeDeviceServer(responses: Array<(ephemeralPublicKey: Uint8Array) => { status: number; body: unknown }>) {
    let ephemeral = new Uint8Array();
    let polls = 0;
    return startFakeAuthServer({
        'POST /v1/auth/device/start': (body) => {
            ephemeral = new Uint8Array(Buffer.from(body.ephemeralPublicKey, 'base64'));
            return {
                status: 200,
                body: {
                    deviceCode: 'dc-1', userCode: 'BCDF-GHJK',
                    verifyUrl: 'https://happy.test/activate',
                    verifyUrlComplete: 'https://happy.test/activate?code=BCDF-GHJK',
                    interval: 5, expiresIn: 600,
                },
            };
        },
        'POST /v1/auth/device/token': () => responses[Math.min(polls++, responses.length - 1)](ephemeral),
    });
}

function approved(contentPublicKey: Uint8Array, accessToken: string) {
    return (ephemeralPublicKey: Uint8Array) => {
        const plain = new Uint8Array(33);
        plain.set(contentPublicKey, 1);
        const sender = tweetnacl.box.keyPair();
        const nonce = tweetnacl.randomBytes(24);
        const boxed = tweetnacl.box(plain, nonce, ephemeralPublicKey, sender.secretKey);
        const bundle = Buffer.concat([sender.publicKey, nonce, boxed]).toString('base64');
        return { status: 200, body: { accountId: 'acc_1', accessToken, refreshToken: 'rt-1', keyBundle: bundle } };
    };
}

const pending = () => ({ status: 400, body: { error: 'authorization_pending' } });

describe('deviceLogin', () => {
    it('prints the URL and code, polls until approved, and stores credentials', async () => {
        const contentPublicKey = new Uint8Array(32).fill(7);
        const token = makeJwt(900);
        server = await fakeDeviceServer([pending, pending, approved(contentPublicKey, token)]);
        const t = io();
        const creds = await deviceLogin({ serverUrl: server.url, clientInfo, io: t.io });

        expect(t.lines.join('\n')).toContain('https://happy.test/activate?code=BCDF-GHJK');
        expect(t.lines.join('\n')).toContain('BCDF-GHJK');
        expect(t.qrs).toEqual(['https://happy.test/activate?code=BCDF-GHJK']);
        expect(t.sleeps).toEqual([5000, 5000, 5000]);
        expect(server.calls[0].body.clientInfo).toEqual(clientInfo);

        expect(creds.token).toBe(token);
        expect(creds.refreshToken).toBe('rt-1');
        expect(creds.encryption.type).toBe('dataKey');
        if (creds.encryption.type !== 'dataKey') return;
        expect(Buffer.from(creds.encryption.publicKey).equals(Buffer.from(contentPublicKey))).toBe(true);
        expect(creds.encryption.machineKey).toHaveLength(32);
        expect(await readCredentials()).toEqual(creds);
    });

    it('slows down when asked', async () => {
        server = await fakeDeviceServer([
            () => ({ status: 400, body: { error: 'slow_down' } }),
            approved(new Uint8Array(32), makeJwt(900)),
        ]);
        const t = io();
        await deviceLogin({ serverUrl: server.url, clientInfo, io: t.io });
        expect(t.sleeps).toEqual([5000, 10000]);
    });

    it.each([
        ['access_denied', 'denied'],
        ['expired_token', 'expired'],
        ['invalid_grant', 'failed'],
    ])('stops on %s', async (error, message) => {
        server = await fakeDeviceServer([() => ({ status: 400, body: { error } })]);
        const t = io();
        await expect(deviceLogin({ serverUrl: server.url, clientInfo, io: t.io })).rejects.toThrow(DeviceLoginError);
        await expect(deviceLogin({ serverUrl: server.url, clientInfo, io: io().io })).rejects.toThrow(new RegExp(message, 'i'));
        expect(await readCredentials()).toBeNull();
    });

    it('rejects a key bundle that is not [0 | contentPublicKey]', async () => {
        server = await fakeDeviceServer([(eph) => {
            const bad = approved(new Uint8Array(32), makeJwt(900))(eph);
            (bad.body as any).keyBundle = Buffer.alloc(80).toString('base64');
            return bad;
        }]);
        await expect(deviceLogin({ serverUrl: server.url, clientInfo, io: io().io })).rejects.toThrow(/key bundle/i);
        expect(await readCredentials()).toBeNull();
    });

    it('never prints tokens', async () => {
        const token = makeJwt(900);
        server = await fakeDeviceServer([approved(new Uint8Array(32), token)]);
        const t = io();
        await deviceLogin({ serverUrl: server.url, clientInfo, io: t.io });
        expect(t.lines.join('\n')).not.toContain(token);
        expect(t.lines.join('\n')).not.toContain('rt-1');
    });
});
