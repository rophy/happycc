import { describe, it, expect, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { callSessionRpc, pendingPermissionRequests, ABORT_REASON } from './sessionRpc';
import { decrypt, decodeBase64, encrypt, encodeBase64 } from './encryption';

const session = { id: 'sess-1', encryption: { key: tweetnacl.randomBytes(32), variant: 'dataKey' as const } };

function fakeSocket(reply: { ok: boolean; result?: string; error?: string }) {
    const calls: Array<{ event: string; payload: { method: string; params: string } }> = [];
    return {
        calls,
        timeout: () => ({
            emitWithAck: vi.fn(async (event: string, payload: { method: string; params: string }) => {
                calls.push({ event, payload });
                return reply;
            }),
        }),
    };
}

describe('callSessionRpc', () => {
    it('sends an encrypted rpc-call to <sessionId>:<method>', async () => {
        const result = encodeBase64(encrypt(session.encryption.key, 'dataKey', { ok: true }));
        const socket = fakeSocket({ ok: true, result });
        await callSessionRpc(socket, session, 'permission', { id: 'r1', approved: true });
        expect(socket.calls[0].event).toBe('rpc-call');
        expect(socket.calls[0].payload.method).toBe('sess-1:permission');
        const sent = decrypt(session.encryption.key, 'dataKey', decodeBase64(socket.calls[0].payload.params));
        expect(sent).toEqual({ id: 'r1', approved: true });
    });

    it('returns the decrypted result', async () => {
        const result = encodeBase64(encrypt(session.encryption.key, 'dataKey', { done: 1 }));
        await expect(callSessionRpc(fakeSocket({ ok: true, result }), session, 'abort', {})).resolves.toEqual({ done: 1 });
    });

    it('explains an offline session', async () => {
        await expect(callSessionRpc(fakeSocket({ ok: false, error: 'RPC method not available' }), session, 'abort', {}))
            .rejects.toThrow('Session sess-1 is not connected');
    });
});

describe('pendingPermissionRequests', () => {
    it('lists requests from agent state', () => {
        const state = { requests: { r1: { tool: 'Write', arguments: { file_path: '/x' }, createdAt: 5 } } };
        expect(pendingPermissionRequests(state)).toEqual([{ id: 'r1', tool: 'Write', arguments: { file_path: '/x' }, createdAt: 5 }]);
    });

    it('returns [] for missing or malformed state', () => {
        expect(pendingPermissionRequests(null)).toEqual([]);
        expect(pendingPermissionRequests({ requests: 'x' })).toEqual([]);
    });
});

describe('ABORT_REASON', () => {
    it('matches the app text', () => {
        expect(ABORT_REASON).toMatch(/^The user doesn't want to proceed with this tool use\./);
    });
});
