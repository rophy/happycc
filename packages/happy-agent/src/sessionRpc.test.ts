import { describe, it, expect, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { callSessionRpc, pendingPermissionRequests, ABORT_REASON, abortParams, KILL_SESSION_PARAMS, permissionParams } from './sessionRpc';
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
        expect(ABORT_REASON).toBe(`The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`);
    });
});

// Payloads pinned to happy-app: sessionAbort/sessionKill/sessionAllow/sessionDeny (sources/sync/ops.ts)
// as called by components/tools/PermissionFooter.tsx.
describe('abortParams', () => {
    it('sends the reason for normal sessions', () => {
        expect(abortParams({ flavor: 'claude' })).toEqual({ reason: ABORT_REASON });
        expect(abortParams(null)).toEqual({ reason: ABORT_REASON });
    });

    it('sends {} for rig sessions', () => {
        expect(abortParams({ client: { id: 'rig' } })).toEqual({});
    });
});

describe('KILL_SESSION_PARAMS', () => {
    it('is the empty object the app sends', () => {
        expect(KILL_SESSION_PARAMS).toEqual({});
    });
});

describe('permissionParams', () => {
    const write = { id: 'r1', tool: 'Write', arguments: { file_path: '/x', content: 'y' } };
    const bash = { id: 'r2', tool: 'Bash', arguments: { command: 'ls -la' } };
    const read = { id: 'r3', tool: 'Read', arguments: { file_path: '/x' } };
    const acpEdit = { id: 'r4', tool: 'edit', arguments: [{ type: 'diff', path: '/x' }] };

    for (const flavor of ['claude', 'opencode', 'acp']) {
        describe(`flavor ${flavor}`, () => {
            const metadata = { flavor };
            it('approve sends { id, approved: true }', () => {
                expect(permissionParams('approve', write, metadata)).toStrictEqual({ id: 'r1', approved: true });
            });
            it('deny sends { id, approved: false }', () => {
                expect(permissionParams('deny', write, metadata)).toStrictEqual({ id: 'r1', approved: false });
            });
            it('approve --for-session sends allowTools: [tool]', () => {
                expect(permissionParams('approve-for-session', read, metadata)).toStrictEqual({ id: 'r3', approved: true, allowTools: ['Read'] });
                expect(permissionParams('approve-for-session', acpEdit, metadata)).toStrictEqual({ id: 'r4', approved: true, allowTools: ['edit'] });
            });
            it('approve --for-session on Bash sends Bash(<command>)', () => {
                expect(permissionParams('approve-for-session', bash, metadata)).toStrictEqual({ id: 'r2', approved: true, allowTools: ['Bash(ls -la)'] });
            });
            it('approve --for-session is refused where the app has no such button', () => {
                expect(() => permissionParams('approve-for-session', write, metadata)).toThrow('no "for this session" approval for Write');
            });
        });
    }

    describe('flavor codex', () => {
        const metadata = { flavor: 'codex' };
        it('approve sends decision approved', () => {
            expect(permissionParams('approve', bash, metadata)).toStrictEqual({ id: 'r2', approved: true, decision: 'approved' });
        });
        it('approve --for-session sends decision approved_for_session', () => {
            expect(permissionParams('approve-for-session', bash, metadata)).toStrictEqual({ id: 'r2', approved: true, decision: 'approved_for_session' });
        });
        it('deny sends the app\'s only deny, decision abort', () => {
            expect(permissionParams('deny', bash, metadata)).toStrictEqual({ id: 'r2', approved: false, decision: 'abort' });
        });
        it('a Codex* tool name counts as Codex whatever the flavor', () => {
            expect(permissionParams('approve', { id: 'r5', tool: 'CodexBash', arguments: {} }, { flavor: 'claude' }))
                .toStrictEqual({ id: 'r5', approved: true, decision: 'approved' });
        });
    });
});
