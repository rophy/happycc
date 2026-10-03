/**
 * Session-scoped RPC, the same calls the app makes: the server relays
 * `rpc-call` for `<sessionId>:<method>` to the CLI that owns the session.
 * Params and results are encrypted with the session key, like machineRpc.
 */
import type { DecryptedSession } from './api';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';

/** Copied verbatim from the app's sessionAbort (non-rig sessions). */
export const ABORT_REASON = `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`;

export type RpcSocket = {
    timeout(ms: number): { emitWithAck(event: string, payload: { method: string; params: string }): Promise<unknown> };
};

export type PermissionRequest = { id: string; tool: string; arguments: unknown; createdAt?: number };

type RpcAck = { ok: boolean; result?: string; error?: string };

export async function callSessionRpc(
    socket: RpcSocket,
    session: Pick<DecryptedSession, 'id' | 'encryption'>,
    method: string,
    params: unknown,
): Promise<unknown> {
    const { key, variant } = session.encryption;
    const response = await socket.timeout(30_000).emitWithAck('rpc-call', {
        method: `${session.id}:${method}`,
        params: encodeBase64(encrypt(key, variant, params)),
    }) as RpcAck;
    if (!response.ok) {
        throw new Error(response.error === 'RPC method not available'
            ? `Session ${session.id} is not connected (its CLI is offline).`
            : response.error ?? 'RPC call failed');
    }
    return response.result ? decrypt(key, variant, decodeBase64(response.result)) : null;
}

export function pendingPermissionRequests(agentState: unknown): PermissionRequest[] {
    const requests = (agentState as { requests?: unknown } | null)?.requests;
    if (!requests || typeof requests !== 'object' || Array.isArray(requests)) return [];
    return Object.entries(requests as Record<string, { tool?: unknown; arguments?: unknown; createdAt?: unknown }>)
        .filter(([, r]) => r && typeof r.tool === 'string')
        .map(([id, r]) => ({
            id,
            tool: r.tool as string,
            arguments: r.arguments,
            ...(typeof r.createdAt === 'number' ? { createdAt: r.createdAt } : {}),
        }));
}
