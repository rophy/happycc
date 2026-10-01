import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeResult = { status: number; body: unknown };
export type FakeHandler = (body: any, req: IncomingMessage) => FakeResult | Promise<FakeResult>;
export type FakeCall = { method: string; path: string; body: any; authorization?: string };

/** node:http stand-in for the Happy server in unit tests. Handlers are keyed by "METHOD /path". */
export async function startFakeServer(handlers: Record<string, FakeHandler>) {
    const calls: FakeCall[] = [];
    const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', async () => {
            const path = (req.url ?? '').split('?')[0];
            const body = raw ? JSON.parse(raw) : undefined;
            calls.push({ method: req.method ?? '', path, body, authorization: req.headers.authorization });
            const handler = handlers[`${req.method} ${path}`];
            const result = handler ? await handler(body, req) : { status: 404, body: { error: 'not found' } };
            res.writeHead(result.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result.body));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        }),
    };
}

/** A JWT-shaped token with `exp`; the agent never verifies signatures. */
export function makeJwt(expSecondsFromNow: number): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'acc_test', did: 'dev_test', typ: 'access', exp })}.sig`;
}
