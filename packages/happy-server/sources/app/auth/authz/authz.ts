import { db } from '@/storage/db';
import { loadAuthzConfig, type AuthzConfig } from './authzConfig';
import { callAuthzWebhook, type AuthzDecision } from './authzWebhook';

/** Device kinds that hold the account's root secret; `cli` devices are never checked. */
export const CHECKED_KINDS: ReadonlySet<string> = new Set(['web', 'mobile', 'agent']);

const ALLOWED: AuthzDecision = { allowed: true };

let config: AuthzConfig | null = null;
const decisions = new Map<string, { decision: AuthzDecision; expiresAt: number }>();
const inFlight = new Map<string, Promise<AuthzDecision>>();

/** Reads AUTHZ_WEBHOOK_* (throws on invalid config, like loadAuthConfig). Call once at startup. */
export function initAuthz(env: NodeJS.ProcessEnv = process.env): void {
    config = loadAuthzConfig(env);
}

export function isAuthzEnabled(): boolean {
    return config !== null;
}

export function authzCacheTtlMs(): number {
    return config?.cacheTtlMs ?? 0;
}

export function resetAuthzForTests(): void {
    config = null;
    decisions.clear();
    inFlight.clear();
}

/** The 403 body for a denial: `reason` only when the webhook gave one. */
export function forbiddenBody(decision: { allowed: false; reason: string | null }): { error: 'forbidden'; reason?: string } {
    return decision.reason ? { error: 'forbidden', reason: decision.reason } : { error: 'forbidden' };
}

/** Whether the device's user may use it now. Allowed without a call when off or for `cli` devices. */
export async function authorizeDevice(deviceId: string): Promise<AuthzDecision> {
    if (!config) {
        return ALLOWED;
    }
    const device = await db.device.findUnique({ where: { id: deviceId }, select: { accountId: true, kind: true, name: true } });
    if (!device) {
        return { allowed: false, reason: null };
    }
    return authorizeAccount(device.accountId, { kind: device.kind, deviceName: device.name });
}

/** Same decision for a sign-in that has no device yet (the code exchange). */
export async function authorizeAccount(accountId: string, client: { kind: string; deviceName: string }): Promise<AuthzDecision> {
    const current = config;
    if (!current || !CHECKED_KINDS.has(client.kind)) {
        return ALLOWED;
    }
    const key = `${accountId}:${client.kind}`;
    const cached = decisions.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.decision;
    }
    const pending = inFlight.get(key);
    if (pending) {
        return pending;
    }
    const call = (async () => {
        const account = await db.account.findUnique({ where: { id: accountId } });
        if (!account) {
            return { allowed: false, reason: null } as AuthzDecision;
        }
        const claims = (account.idpClaims ?? {}) as Record<string, unknown>;
        const fullName = [account.firstName, account.lastName].filter(Boolean).join(' ');
        const { decision, failed } = await callAuthzWebhook(current, {
            user: {
                accountId,
                issuer: account.oidcIssuer,
                subject: account.oidcSubject,
                email: account.email,
                name: typeof claims.name === 'string' ? claims.name : (fullName || null),
                claims,
            },
            client,
        });
        if (!failed) {
            decisions.set(key, { decision, expiresAt: Date.now() + current.cacheTtlMs });
        }
        return decision;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, call);
    return call;
}
