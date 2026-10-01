import { expect, test, type WebSocket } from '@playwright/test';
import { readCredentials, signIn } from './helpers';

// The server cuts a sync socket 60 s after its access token expires. Waiting that
// out is only practical with short tokens: start the stack with
// AUTH_ACCESS_TOKEN_TTL=3m (CI does). Longer than 2 min, so tokens are still
// "fresh" against the app's 2-minute refresh margin.
const MAX_TTL_SEC = 5 * 60;
const EXPIRY_GRACE_SEC = 60;

interface UpdatesSocket {
    ws: WebSocket;
    connected: boolean;
    serverDisconnected: boolean;
    closed: boolean;
}

function tokenLifetimeSec(token: string): number {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return claims.exp - claims.iat;
}

test('the sync socket reconnects after the server cuts it at token expiry', async ({ page }) => {
    // Socket.io frames received from the server: "40…" namespace connected,
    // "41" server disconnect. Sent frames (which carry the token) are never read.
    const sockets: UpdatesSocket[] = [];
    page.on('websocket', (ws) => {
        if (!new URL(ws.url()).pathname.startsWith('/v1/updates')) return;
        const entry: UpdatesSocket = { ws, connected: false, serverDisconnected: false, closed: false };
        sockets.push(entry);
        ws.on('framereceived', ({ payload }) => {
            const frame = typeof payload === 'string' ? payload : payload.toString('utf8');
            if (frame.startsWith('40')) entry.connected = true;
            if (frame.startsWith('41')) entry.serverDisconnected = true;
        });
        ws.on('close', () => { entry.closed = true; });
    });

    await signIn(page);
    const ttl = tokenLifetimeSec((await readCredentials(page))!.token);
    test.skip(ttl > MAX_TTL_SEC, `Access tokens live ${ttl}s; start the stack with AUTH_ACCESS_TOKEN_TTL=3m to run this test.`);
    test.setTimeout((ttl + EXPIRY_GRACE_SEC + 180) * 1000);

    await expect.poll(() => sockets.filter((s) => s.connected && !s.closed).length).toBe(1);
    const first = sockets.find((s) => s.connected && !s.closed)!;

    // The server cuts it (socket.io "io server disconnect") at its token's exp + 60 s.
    await expect.poll(() => first.serverDisconnected && first.closed, {
        timeout: (ttl + EXPIRY_GRACE_SEC + 60) * 1000,
        intervals: [5_000],
    }).toBe(true);

    // The app opens a new socket and the server accepts its fresh token.
    await expect.poll(() => sockets.slice(sockets.indexOf(first) + 1).some((s) => s.connected && !s.closed), {
        timeout: 60_000,
    }).toBe(true);
});
