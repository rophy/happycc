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

/** The params the app sends with `killSession` (`sessionKill` in happy-app/sources/sync/ops.ts). */
export const KILL_SESSION_PARAMS = {} as const;

type SessionMetadata = { flavor?: unknown; client?: { id?: unknown } } | null | undefined;

/** The app's `sessionAbort`: rig sessions get `{}`, every other session gets the reason. */
export function abortParams(metadata: unknown): Record<string, never> | { reason: string } {
    return (metadata as SessionMetadata)?.client?.id === 'rig' ? {} : { reason: ABORT_REASON };
}

/** Same test as the app's PermissionFooter: Codex sessions get the decision-based buttons. */
export function isCodexPermission(metadata: unknown, tool: string): boolean {
    return (metadata as SessionMetadata)?.flavor === 'codex' || tool.startsWith('Codex');
}

/** Tools for which the app's Claude-style footer offers no "for this session" button. */
const NO_FOR_SESSION_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'exit_plan_mode', 'ExitPlanMode']);

export type PermissionAction = 'approve' | 'approve-for-session' | 'deny';

/**
 * The `permission` RPC params the app's PermissionFooter sends for each button
 * (via `sessionAllow` / `sessionDeny` in happy-app/sources/sync/ops.ts; undefined fields are left out, as JSON does):
 * - Codex: Yes → `decision: 'approved'`, Yes for session → `decision: 'approved_for_session'`,
 *   Stop and explain (the only deny) → `approved: false, decision: 'abort'`.
 * - Everyone else: Yes → `{ id, approved: true }`, Yes for this tool → `allowTools: [tool]` (`Bash(<command>)` for Bash),
 *   No → `{ id, approved: false }`.
 */
export function permissionParams(action: PermissionAction, request: PermissionRequest, metadata: unknown): Record<string, unknown> {
    const { id, tool } = request;
    if (isCodexPermission(metadata, tool)) {
        if (action === 'approve') return { id, approved: true, decision: 'approved' };
        if (action === 'approve-for-session') return { id, approved: true, decision: 'approved_for_session' };
        return { id, approved: false, decision: 'abort' };
    }
    if (action === 'approve') return { id, approved: true };
    if (action === 'deny') return { id, approved: false };
    if (NO_FOR_SESSION_TOOLS.has(tool)) {
        throw new Error(`The app offers no "for this session" approval for ${tool}; use approve without --for-session.`);
    }
    const command = (request.arguments as { command?: unknown } | null | undefined)?.command;
    const toolIdentifier = tool === 'Bash' && command ? `Bash(${String(command)})` : tool;
    return { id, approved: true, allowTools: [toolIdentifier] };
}
