import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

type Handler = (body: any, req: IncomingMessage) => { status: number; body: unknown };

export async function startFakeAuthServer(handlers: Partial<Record<string, Handler>>) {
    const calls: Array<{ path: string; body: any; authorization?: string }> = [];
    const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : undefined;
            const path = (req.url ?? '').split('?')[0];
            calls.push({ path, body, authorization: req.headers.authorization });
            const handler = handlers[`${req.method} ${path}`];
            const result = handler ? handler(body, req) : { status: 404, body: { error: 'not found' } };
            res.writeHead(result.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result.body));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

export function makeJwt(expSecondsFromNow: number, sub = 'acc_test'): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, did: 'dev_test', typ: 'access', exp })}.sig`;
}
