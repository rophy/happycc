import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/configuration', () => ({ configuration: { currentCliVersion: '9.9.9' } }));
// The real logger opens a log file under configuration.logsDir at import time.
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

import { PushNotificationClient } from './pushNotifications';

type Captured = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };

async function startServer(status = 200) {
    const requests: Captured[] = [];
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            requests.push({ method: req.method, url: req.url, headers: req.headers, body });
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, result: 'sent', tokens: 1 }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

describe('PushNotificationClient.sendSessionNotification', () => {
    let close: (() => Promise<void>) | null = null;
    afterEach(async () => {
        await close?.();
        close = null;
    });

    it('sends only the event kind to the session push-event endpoint', async () => {
        const server = await startServer();
        close = server.close;
        const client = new PushNotificationClient('token-1', server.url);

        await client.sendSessionNotification({ kind: 'permission', sessionId: 'sess/1' });

        expect(server.requests).toHaveLength(1);
        const [request] = server.requests;
        expect(request.method).toBe('POST');
        expect(request.url).toBe('/v1/sessions/sess%2F1/push-event');
        expect(request.headers.authorization).toBe('Bearer token-1');
        expect(request.headers['x-happy-client']).toBe('cli-daemon/9.9.9');
        expect(JSON.parse(request.body)).toEqual({ kind: 'permission' });
    });

    it('never rejects when the server fails', async () => {
        const server = await startServer(500);
        close = server.close;
        const client = new PushNotificationClient('token-1', server.url);
        await expect(client.sendSessionNotification({ kind: 'done', sessionId: 's1' })).resolves.toBeUndefined();
    });
});
