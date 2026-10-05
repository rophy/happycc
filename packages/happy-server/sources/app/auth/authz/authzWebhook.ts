import { log } from '@/utils/log';
import type { AuthzConfig } from './authzConfig';

export type AuthzDecision = { allowed: true } | { allowed: false; reason: string | null };

export interface AuthzRequest {
    user: {
        accountId: string;
        issuer: string | null;
        subject: string | null;
        email: string | null;
        name: string | null;
        claims: Record<string, unknown>;
    };
    client: { kind: string; deviceName: string };
}

export const UNAVAILABLE_REASON = 'Authorization is unavailable. Try again later.';
const MAX_REASON_LENGTH = 500;

/**
 * Asks the webhook whether this user may use this client. Any failure (status, timeout,
 * network, malformed body) denies with UNAVAILABLE_REASON and reports `failed` so the
 * caller does not cache it. Logs never include the secret or the claims.
 */
export async function callAuthzWebhook(
    config: AuthzConfig,
    request: AuthzRequest,
): Promise<{ decision: AuthzDecision; failed: boolean }> {
    const started = Date.now();
    const fail = (why: string) => {
        log({ module: 'authz', level: 'warn' }, `Webhook failed for account ${request.user.accountId} (${request.client.kind}): ${why}`);
        return { decision: { allowed: false, reason: UNAVAILABLE_REASON } as AuthzDecision, failed: true };
    };
    let response: Response;
    try {
        response = await fetch(config.url, {
            method: 'POST',
            // A redirect would re-post the body and secret elsewhere: fail closed instead.
            redirect: 'error',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.secret}` },
            body: JSON.stringify(request),
            // @types/node 20 has two conflicting AbortSignal declarations; see push/pushSend.ts.
            signal: AbortSignal.timeout(config.timeoutMs) as unknown as RequestInit['signal'],
        });
    } catch (error) {
        return fail(error instanceof Error ? error.name : 'request error');
    }
    if (!response.ok) {
        return fail(`status ${response.status}`);
    }
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return fail('malformed body');
    }
    const allowed = (body as { allowed?: unknown } | null)?.allowed;
    if (typeof allowed !== 'boolean') {
        return fail('no boolean "allowed"');
    }
    const rawReason = (body as { reason?: unknown }).reason;
    const decision: AuthzDecision = allowed
        ? { allowed: true }
        : { allowed: false, reason: typeof rawReason === 'string' && rawReason.length > 0 ? rawReason.slice(0, MAX_REASON_LENGTH) : null };
    log({ module: 'authz' }, `Account ${request.user.accountId} (${request.client.kind}): ${allowed ? 'allowed' : 'denied'} in ${Date.now() - started}ms`);
    return { decision, failed: false };
}
