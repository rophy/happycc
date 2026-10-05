import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { callAuthzWebhook, UNAVAILABLE_REASON, type AuthzRequest } from './authzWebhook';

let server: Server;
let base: string;
let handler: (req: IncomingMessage, body: string, res: ServerResponse) => void;

beforeAll(async () => {
    server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => handler(req, body, res));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const config = () => ({ url: `${base}/check`, secret: 'shh', cacheTtlMs: 60_000, timeoutMs: 300 });
const request: AuthzRequest = {
    user: { accountId: 'a1', issuer: 'https://idp', subject: 'alice', email: 'a@example.com', name: 'Alice', claims: { groups: ['g'] } },
    client: { kind: 'web', deviceName: 'Web' },
};
const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
};

describe('callAuthzWebhook', () => {
    it('posts the request with the bearer secret and returns an allow', async () => {
        let seen: { auth?: string; body?: unknown; method?: string } = {};
        handler = (req, body, res) => { seen = { auth: req.headers.authorization, body: JSON.parse(body), method: req.method }; json(res, 200, { allowed: true }); };
        expect(await callAuthzWebhook(config(), request)).toEqual({ decision: { allowed: true }, failed: false });
        expect(seen).toEqual({ auth: 'Bearer shh', body: request, method: 'POST' });
    });

    it('returns a deny with its reason, truncated to 500 characters', async () => {
        handler = (_q, _b, res) => json(res, 200, { allowed: false, reason: 'x'.repeat(600) });
        const { decision, failed } = await callAuthzWebhook(config(), request);
        expect(failed).toBe(false);
        expect(decision).toEqual({ allowed: false, reason: 'x'.repeat(500) });
    });

    it('returns a deny without a reason when none is given', async () => {
        handler = (_q, _b, res) => json(res, 200, { allowed: false });
        expect((await callAuthzWebhook(config(), request)).decision).toEqual({ allowed: false, reason: null });
    });

    it.each([
        ['an error status', (res: ServerResponse) => json(res, 500, { allowed: true })],
        ['a malformed body', (res: ServerResponse) => res.writeHead(200).end('not json')],
        ['a body without allowed', (res: ServerResponse) => json(res, 200, { ok: true })],
        ['a timeout', (_res: ServerResponse) => { /* never answers */ }],
    ])('fails closed on %s', async (_name, respond) => {
        handler = (_q, _b, res) => respond(res);
        expect(await callAuthzWebhook(config(), request)).toEqual({ decision: { allowed: false, reason: UNAVAILABLE_REASON }, failed: true });
    });

    it.each([302, 307])('fails closed on a %i redirect instead of following it', async (status) => {
        let hits = 0;
        handler = (_q, _b, res) => {
            hits++;
            if (hits === 1) res.writeHead(status, { location: `${base}/elsewhere` }).end();
            else json(res, 200, { allowed: true });
        };
        expect(await callAuthzWebhook(config(), request)).toEqual({ decision: { allowed: false, reason: UNAVAILABLE_REASON }, failed: true });
        expect(hits).toBe(1);
    });

    it('fails closed when the webhook cannot be reached', async () => {
        const unreachable = { ...config(), url: 'http://127.0.0.1:1/check' };
        expect((await callAuthzWebhook(unreachable, request)).failed).toBe(true);
    });
});
