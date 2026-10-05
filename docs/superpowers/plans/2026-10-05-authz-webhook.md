# Authorization Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in server webhook decides whether a user may use the web app, mobile app and `happycc-agent`; the CLI is never checked.

**Architecture:** A new server module (`sources/app/auth/authz/`) loads config, calls the webhook and caches decisions per account and device kind. Every enforcement point (code exchange, `app.authenticate`, socket handshake, a per-socket timer) calls one function, `authorizeDevice(deviceId)`. Denials are HTTP 403 `{ error: 'forbidden', reason? }` or a socket error / `forbidden` event carrying the same data; the app shows a full-screen "Not authorized" view, the agent prints the reason and exits.

**Tech Stack:** Fastify 5 + Socket.IO + Prisma (server, vitest), Expo/React Native (app, vitest), Node CLI with axios + socket.io-client (agent, vitest), Playwright e2e against `docker-compose.yaml`.

**Spec:** `docs/superpowers/specs/2026-10-05-authz-webhook-design.md`

## Global Constraints

- Opt-in: with `AUTHZ_WEBHOOK_URL` unset, behaviour is unchanged and no webhook call or extra DB query happens.
- Checked device kinds: `web`, `mobile`, `agent`. `cli` devices are never checked.
- Denial response: HTTP 403 `{ "error": "forbidden", "reason": "<text>" }`, `reason` omitted when the webhook gave none. Devices are never revoked by a denial.
- `AUTHZ_WEBHOOK_SECRET` is required when `AUTHZ_WEBHOOK_URL` is set; sent as `Authorization: Bearer <secret>`.
- `AUTHZ_WEBHOOK_URL` must be `https://` unless `AUTHZ_WEBHOOK_ALLOW_INSECURE=true`.
- `AUTHZ_WEBHOOK_CACHE_TTL` default `60s`; `AUTHZ_WEBHOOK_TIMEOUT` default `5s` (format of `parseDuration`: `<n>s|m|h|d`).
- Fail closed: error status, timeout, network error or malformed body → deny with reason `Authorization is unavailable. Try again later.`; failures are not cached.
- `reason` is plain text, truncated to 500 characters.
- Claims forwarded are the ID token claims minus `iss`, `sub`, `aud`, `exp`, `iat`, `nonce`, `at_hash`, `auth_time`.
- Token refresh (`/v1/auth/refresh`) is not checked.
- Never log the webhook secret or the claims.
- Commit messages: `<type>: <description>`, types feat/fix/refactor/chore/docs/build/test, no mention of "Claude" or "Happy", no co-author or generated footer. Commits are GPG-signed automatically; never disable signing.

## File Structure

Server (`packages/happy-server`):
- Create `sources/app/auth/authz/authzConfig.ts` — env → `AuthzConfig | null`.
- Create `sources/app/auth/authz/authzWebhook.ts` — one webhook call → `AuthzDecision` (fail closed).
- Create `sources/app/auth/authz/authz.ts` — runtime: `initAuthz`, `isAuthzEnabled`, `authorizeDevice`, `forbiddenBody`, cache, single flight.
- Create `sources/app/auth/authz/idpClaims.ts` — `filterIdpClaims`.
- Create tests next to each: `authzConfig.test.ts`, `authzWebhook.test.ts`, `authz.test.ts`, `idpClaims.test.ts`.
- Create `prisma/migrations/20261005000000_account_idp_claims/migration.sql`; modify `prisma/schema.prisma` (Account).
- Modify `sources/app/auth/oidc/oidcClient.ts` (claims on identity and refresh), `provisioning.ts`, `idpCheck.ts`, `sources/testing/authTestKit.ts`.
- Modify `sources/app/api/routes/oidcRoutes.ts` (exchange), `sources/app/api/utils/enableAuthentication.ts`, `sources/app/api/socket/socketAuth.ts`, `sources/app/api/socket.ts`, `sources/main.ts`.
- Create `sources/app/api/routes/authzRoutes.spec.ts`; extend `sources/app/api/socket/socketAuth.spec.ts`.

Agent (`packages/happy-agent`): modify `src/api.ts`, `src/loopbackLogin.ts`, `src/session.ts`; create `src/forbidden.ts` + `src/forbidden.test.ts`.

App (`packages/happy-app`): create `sources/auth/authorization.ts` (+ test), `sources/components/NotAuthorizedGate.tsx`; modify `sources/auth/authFetch.ts`, `sources/auth/oidcLogin.ts`, `sources/sync/apiSocket.ts`, `sources/app/_layout.tsx`, `sources/text/_default.ts` and all 10 files in `sources/text/translations/`.

Stack/e2e: create `deploy/authz-mock/server.mjs`; modify `docker-compose.yaml`, `deploy/oidc-mock/config.yaml`; create `e2e/tests/authorization.spec.ts`.

Docs: modify `docs/deployment.md`.

---

### Task 1: Store the ID token claims

**Files:**
- Create: `packages/happy-server/sources/app/auth/authz/idpClaims.ts`, `idpClaims.test.ts`
- Modify: `packages/happy-server/prisma/schema.prisma` (model `Account`, after `idpCheckedAt`)
- Create: `packages/happy-server/prisma/migrations/20261005000000_account_idp_claims/migration.sql`
- Modify: `packages/happy-server/sources/app/auth/oidc/oidcClient.ts` (`OidcIdentity`, `IdpRefreshResult`, `handleCallback`, `refresh`)
- Modify: `packages/happy-server/sources/app/auth/oidc/provisioning.ts`, `idpCheck.ts`
- Test: `packages/happy-server/sources/app/auth/oidc/provisioning.test.ts` (create if absent, else extend), `idpCheck.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `filterIdpClaims(claims: Record<string, unknown>): Record<string, unknown>` in `@/app/auth/authz/idpClaims`; `OidcIdentity.claims?: Record<string, unknown>`; `IdpRefreshResult` ok branch `{ status: 'ok'; refreshToken: string | null; claims?: Record<string, unknown> }`; `Account.idpClaims Json?`.

- [ ] **Step 1: Schema and migration**

In `schema.prisma`, model `Account`, after `idpCheckedAt DateTime?` add:
```prisma
    /// Latest ID token claims (filterIdpClaims), forwarded to the authorization webhook
    idpClaims         Json?
```
`prisma/migrations/20261005000000_account_idp_claims/migration.sql`:
```sql
-- AlterTable
ALTER TABLE "Account" ADD COLUMN "idpClaims" JSONB;
```

- [ ] **Step 2: Generate the client**

Run: `pnpm --filter happy-server exec prisma generate`
Expected: "Generated Prisma Client".

- [ ] **Step 3: Write the failing tests**

`sources/app/auth/authz/idpClaims.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { filterIdpClaims } from './idpClaims';

describe('filterIdpClaims', () => {
    it('drops token bookkeeping claims and keeps the rest', () => {
        expect(filterIdpClaims({
            iss: 'i', sub: 's', aud: 'a', exp: 1, iat: 1, nonce: 'n', at_hash: 'h', auth_time: 1,
            email: 'a@example.com', groups: ['g1'], name: 'A',
        })).toEqual({ email: 'a@example.com', groups: ['g1'], name: 'A' });
    });
});
```


Look at `sources/app/auth/oidc/` for an existing provisioning test (`ls packages/happy-server/sources/app/auth/oidc/*provision*`). Add to it (or create `provisioning.test.ts` with the same setup as `idpCheck.test.ts`: `setupAuthTest()` then dynamic imports):
```ts
it('stores the filtered ID token claims at each sign-in', async () => {
    const { provisionAccount } = await import('./provisioning');
    const identity = { issuer: 'https://idp.test', subject: 'claims-1', email: 'c@example.com', name: 'C', refreshToken: null };
    const { accountId } = await provisionAccount({ ...identity, claims: { groups: ['a'], nonce: 'x' } });
    expect((await db.account.findUniqueOrThrow({ where: { id: accountId } })).idpClaims).toEqual({ groups: ['a'] });
    await provisionAccount({ ...identity, claims: { groups: ['b'] } });
    expect((await db.account.findUniqueOrThrow({ where: { id: accountId } })).idpClaims).toEqual({ groups: ['b'] });
});
```
In `idpCheck.test.ts`, following the file's existing account/refresh-token setup, add:
```ts
it('stores the claims of a refreshed ID token', async () => {
    // same setup as the file's "allows when the IdP accepts" test: an account with a sealed IdP refresh token and idpCheckedAt in the past
    fake.setRefreshResult({ status: 'ok', refreshToken: null, claims: { groups: ['new'], exp: 1 } });
    expect(await check(accountId)).toBe(true);
    expect((await db.account.findUniqueOrThrow({ where: { id: accountId } })).idpClaims).toEqual({ groups: ['new'] });
});
```
(Use the names the file already uses for the fake client, the check function and the account; read the file first.)

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/`
Expected: FAIL (`./idpClaims` missing; claims not stored).

- [ ] **Step 5: Implement**

`sources/app/auth/authz/idpClaims.ts`:
```ts
/** ID token claims that describe the token itself, not the user: never stored or forwarded. */
const TOKEN_CLAIMS = new Set(['iss', 'sub', 'aud', 'exp', 'iat', 'nonce', 'at_hash', 'auth_time']);

/** The user's ID token claims as stored per account and forwarded to the authorization webhook. */
export function filterIdpClaims(claims: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(claims).filter(([key]) => !TOKEN_CLAIMS.has(key)));
}
```


`oidcClient.ts`:
```ts
export interface OidcIdentity {
    issuer: string;
    subject: string;
    email: string | null;
    name: string | null;
    refreshToken: string | null;
    /** All ID token claims; filtered before they are stored. */
    claims?: Record<string, unknown>;
}

export type IdpRefreshResult =
    | { status: 'ok'; refreshToken: string | null; claims?: Record<string, unknown> }
    | { status: 'rejected' }
    | { status: 'unavailable' };
```
(keep the existing `unavailable` member as it is). In `handleCallback` return `claims: { ...claims }` in addition to the existing fields. In `refresh`:
```ts
const tokens = await client.refreshTokenGrant(config, refreshToken);
const claims = tokens.claims();
return { status: 'ok', refreshToken: tokens.refresh_token ?? null, ...(claims ? { claims: { ...claims } } : {}) };
```
`provisioning.ts` — import `filterIdpClaims` from `@/app/auth/authz/idpClaims` and `Prisma` (already imported). In `upsertAccount`, add the claims to `idpFields`' neighbour:
```ts
const claimFields = identity.claims ? { idpClaims: filterIdpClaims(identity.claims) as Prisma.InputJsonValue } : {};
```
and spread `...claimFields` into both the `update` data and the `create` data.

`idpCheck.ts` — after the `if (result.refreshToken) { ... }` block, add:
```ts
if (result.claims) {
    await db.account.update({ where: { id: accountId }, data: { idpClaims: filterIdpClaims(result.claims) as Prisma.InputJsonValue } });
}
```
(import `Prisma` from `@prisma/client` and `filterIdpClaims` from `@/app/auth/authz/idpClaims`).

- [ ] **Step 6: Run the oidc and authz tests, expect PASS; type check**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/ && pnpm --filter happy-server exec tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add packages/happy-server/prisma packages/happy-server/sources/app/auth
git commit -m "feat: keep each account's latest ID token claims"
```

### Task 2: Server authorization core (config, webhook call, decision cache)

**Files:**
- Create: `packages/happy-server/sources/app/auth/authz/authzConfig.ts`, `authzWebhook.ts`, `authz.ts`
- Test: `packages/happy-server/sources/app/auth/authz/authzConfig.test.ts`, `authzWebhook.test.ts`, `authz.test.ts`

**Interfaces:**
- Consumes: `parseDuration(value: string): number` (seconds) from `@/app/auth/oidc/authConfig`; `db` from `@/storage/db`; `Account.idpClaims` (Task 1).
- Produces:
  ```ts
  // authzConfig.ts
  export interface AuthzConfig { url: string; secret: string; cacheTtlMs: number; timeoutMs: number }
  export function loadAuthzConfig(env: NodeJS.ProcessEnv): AuthzConfig | null
  // authzWebhook.ts
  export type AuthzDecision = { allowed: true } | { allowed: false; reason: string | null };
  export interface AuthzRequest {
      user: { accountId: string; issuer: string | null; subject: string | null; email: string | null; name: string | null; claims: Record<string, unknown> };
      client: { kind: string; deviceName: string };
  }
  export const UNAVAILABLE_REASON = 'Authorization is unavailable. Try again later.';
  export async function callAuthzWebhook(config: AuthzConfig, request: AuthzRequest): Promise<{ decision: AuthzDecision; failed: boolean }>
  // authz.ts
  export const CHECKED_KINDS: ReadonlySet<string>  // web, mobile, agent
  export function initAuthz(env?: NodeJS.ProcessEnv): void
  export function isAuthzEnabled(): boolean
  export function authzCacheTtlMs(): number
  export async function authorizeDevice(deviceId: string): Promise<AuthzDecision>
  export async function authorizeAccount(accountId: string, client: { kind: string; deviceName: string }): Promise<AuthzDecision>
  export function forbiddenBody(decision: { allowed: false; reason: string | null }): { error: 'forbidden'; reason?: string }
  export function resetAuthzForTests(): void
  ```

- [ ] **Step 1: Write the failing config test**

`authzConfig.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadAuthzConfig } from './authzConfig';

describe('loadAuthzConfig', () => {
    it('is off without a URL', () => {
        expect(loadAuthzConfig({})).toBeNull();
        expect(loadAuthzConfig({ AUTHZ_WEBHOOK_URL: '  ' })).toBeNull();
    });

    it('reads the URL, secret and durations with defaults', () => {
        expect(loadAuthzConfig({ AUTHZ_WEBHOOK_URL: 'https://authz.test/check', AUTHZ_WEBHOOK_SECRET: 's' })).toEqual({
            url: 'https://authz.test/check', secret: 's', cacheTtlMs: 60_000, timeoutMs: 5_000,
        });
        expect(loadAuthzConfig({
            AUTHZ_WEBHOOK_URL: 'https://authz.test/check', AUTHZ_WEBHOOK_SECRET: 's',
            AUTHZ_WEBHOOK_CACHE_TTL: '1s', AUTHZ_WEBHOOK_TIMEOUT: '2s',
        })).toMatchObject({ cacheTtlMs: 1_000, timeoutMs: 2_000 });
    });

    it('requires a secret and https', () => {
        expect(() => loadAuthzConfig({ AUTHZ_WEBHOOK_URL: 'https://authz.test' })).toThrow(/AUTHZ_WEBHOOK_SECRET/);
        expect(() => loadAuthzConfig({ AUTHZ_WEBHOOK_URL: 'http://authz.test', AUTHZ_WEBHOOK_SECRET: 's' })).toThrow(/https/);
        expect(loadAuthzConfig({
            AUTHZ_WEBHOOK_URL: 'http://localhost:8190', AUTHZ_WEBHOOK_SECRET: 's', AUTHZ_WEBHOOK_ALLOW_INSECURE: 'true',
        })?.url).toBe('http://localhost:8190');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/authz/authzConfig.test.ts`
Expected: FAIL, cannot find module `./authzConfig`.

- [ ] **Step 3: Implement `authzConfig.ts`**

```ts
import { parseDuration } from '@/app/auth/oidc/authConfig';

/** The authorization webhook (docs/deployment.md, "Authorization"). Null when AUTHZ_WEBHOOK_URL is unset. */
export interface AuthzConfig {
    url: string;
    secret: string;
    cacheTtlMs: number;
    timeoutMs: number;
}

export function loadAuthzConfig(env: NodeJS.ProcessEnv): AuthzConfig | null {
    const url = env.AUTHZ_WEBHOOK_URL?.trim();
    if (!url) {
        return null;
    }
    const secret = env.AUTHZ_WEBHOOK_SECRET?.trim();
    if (!secret) {
        throw new Error('AUTHZ_WEBHOOK_SECRET is required when AUTHZ_WEBHOOK_URL is set');
    }
    if (!url.startsWith('https://') && env.AUTHZ_WEBHOOK_ALLOW_INSECURE !== 'true') {
        throw new Error('AUTHZ_WEBHOOK_URL must use https (set AUTHZ_WEBHOOK_ALLOW_INSECURE=true for local development)');
    }
    return {
        url,
        secret,
        cacheTtlMs: parseDuration(env.AUTHZ_WEBHOOK_CACHE_TTL ?? '60s') * 1000,
        timeoutMs: parseDuration(env.AUTHZ_WEBHOOK_TIMEOUT ?? '5s') * 1000,
    };
}
```

- [ ] **Step 4: Run the config test, expect PASS**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/authz/authzConfig.test.ts`

- [ ] **Step 5: Write the failing webhook test**

`authzWebhook.test.ts` (a real local HTTP server, no mocks):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { callAuthzWebhook, UNAVAILABLE_REASON, type AuthzRequest } from './authzWebhook';

let server: Server;
let base: string;
let handler: (req: IncomingMessage, body: string, res: ServerResponse) => void;

beforeAll(async () => {
    server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => handler(req, body, res));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const config = () => ({ url: `${base}/check`, secret: 'shh', cacheTtlMs: 60_000, timeoutMs: 300 });
const request: AuthzRequest = {
    user: { accountId: 'a1', issuer: 'https://idp', subject: 'alice', email: 'a@example.com', name: 'Alice', claims: { groups: ['g'] } },
    client: { kind: 'web', deviceName: 'Web' },
};
const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
};

describe('callAuthzWebhook', () => {
    it('posts the request with the bearer secret and returns an allow', async () => {
        let seen: { auth?: string; body?: unknown; method?: string } = {};
        handler = (req, body, res) => { seen = { auth: req.headers.authorization, body: JSON.parse(body), method: req.method }; json(res, 200, { allowed: true }); };
        expect(await callAuthzWebhook(config(), request)).toEqual({ decision: { allowed: true }, failed: false });
        expect(seen).toEqual({ auth: 'Bearer shh', body: request, method: 'POST' });
    });

    it('returns a deny with its reason, truncated to 500 characters', async () => {
        handler = (_q, _b, res) => json(res, 200, { allowed: false, reason: 'x'.repeat(600) });
        const { decision, failed } = await callAuthzWebhook(config(), request);
        expect(failed).toBe(false);
        expect(decision).toEqual({ allowed: false, reason: 'x'.repeat(500) });
    });

    it('returns a deny without a reason when none is given', async () => {
        handler = (_q, _b, res) => json(res, 200, { allowed: false });
        expect((await callAuthzWebhook(config(), request)).decision).toEqual({ allowed: false, reason: null });
    });

    it.each([
        ['an error status', (res: ServerResponse) => json(res, 500, { allowed: true })],
        ['a malformed body', (res: ServerResponse) => res.writeHead(200).end('not json')],
        ['a body without allowed', (res: ServerResponse) => json(res, 200, { ok: true })],
        ['a timeout', (_res: ServerResponse) => { /* never answers */ }],
    ])('fails closed on %s', async (_name, respond) => {
        handler = (_q, _b, res) => respond(res);
        expect(await callAuthzWebhook(config(), request)).toEqual({ decision: { allowed: false, reason: UNAVAILABLE_REASON }, failed: true });
    });

    it('fails closed when the webhook cannot be reached', async () => {
        const unreachable = { ...config(), url: 'http://127.0.0.1:1/check' };
        expect((await callAuthzWebhook(unreachable, request)).failed).toBe(true);
    });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/authz/`
Expected: FAIL, modules not found.

- [ ] **Step 7: Implement `authzWebhook.ts`**

`authzWebhook.ts`:
```ts
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
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.secret}` },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(config.timeoutMs),
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
```

- [ ] **Step 8: Run the webhook test, expect PASS**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/authz/`

- [ ] **Step 9: Write the failing runtime test**

`authz.test.ts` uses the test DB (`createTestDb`) and a local webhook server like Step 5:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PrismaClient } from '@prisma/client';
import { setupAuthTest } from '@/testing/authTestKit';

let db: PrismaClient;
let server: Server;
let base: string;
let calls: Array<{ user: { email: string | null; claims: unknown }; client: { kind: string } }> = [];
let answer: (body: { client: { kind: string } }) => { status: number; body: unknown } = () => ({ status: 200, body: { allowed: true } });
let authz: typeof import('./authz');
let devices: typeof import('@/app/auth/oidc/devices');

beforeAll(async () => {
    db = (await setupAuthTest()).db;
    server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const body = JSON.parse(raw);
            calls.push(body);
            const { status, body: out } = answer(body);
            res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(out));
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    authz = await import('./authz');
    devices = await import('@/app/auth/oidc/devices');
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const env = (ttl = '60s') => ({
    AUTHZ_WEBHOOK_URL: `${base}/check`, AUTHZ_WEBHOOK_SECRET: 's', AUTHZ_WEBHOOK_ALLOW_INSECURE: 'true', AUTHZ_WEBHOOK_CACHE_TTL: ttl,
});

let n = 0;
async function device(kind: string) {
    n++;
    const account = await db.account.create({
        data: { publicKey: `pk-authz-${n}`, oidcIssuer: 'https://idp.test', oidcSubject: `u${n}`, email: `u${n}@example.com`, firstName: 'U', lastName: `${n}`, idpClaims: { groups: ['g'], name: `User ${n}` } },
    });
    const d = await devices.createDevice({ accountId: account.id, kind, name: `${kind}-device` });
    return { accountId: account.id, deviceId: d.deviceId };
}

beforeEach(() => {
    calls = [];
    answer = () => ({ status: 200, body: { allowed: true } });
    authz.resetAuthzForTests();
});

describe('authorizeDevice', () => {
    it('allows everything and calls nothing when not configured', async () => {
        authz.initAuthz({});
        expect(authz.isAuthzEnabled()).toBe(false);
        expect(await authz.authorizeDevice((await device('web')).deviceId)).toEqual({ allowed: true });
        expect(calls).toEqual([]);
    });

    it('never checks cli devices', async () => {
        authz.initAuthz(env());
        answer = () => ({ status: 200, body: { allowed: false } });
        expect(await authz.authorizeDevice((await device('cli')).deviceId)).toEqual({ allowed: true });
        expect(calls).toEqual([]);
    });

    it.each(['web', 'mobile', 'agent'])('asks the webhook for %s devices, with the user and claims', async (kind) => {
        authz.initAuthz(env());
        const d = await device(kind);
        answer = () => ({ status: 200, body: { allowed: false, reason: 'No access' } });
        expect(await authz.authorizeDevice(d.deviceId)).toEqual({ allowed: false, reason: 'No access' });
        expect(calls).toEqual([{
            user: { accountId: d.accountId, issuer: 'https://idp.test', subject: expect.any(String), email: expect.stringMatching(/@example\.com$/), name: expect.stringMatching(/^User /), claims: { groups: ['g'], name: expect.any(String) } },
            client: { kind, deviceName: `${kind}-device` },
        }]);
    });

    it('caches a decision per account and kind for the TTL', async () => {
        authz.initAuthz(env('60s'));
        const d = await device('web');
        await authz.authorizeDevice(d.deviceId);
        await authz.authorizeDevice(d.deviceId);
        expect(calls).toHaveLength(1);
    });

    it('shares one webhook call between concurrent requests', async () => {
        authz.initAuthz(env());
        const d = await device('web');
        await Promise.all([authz.authorizeDevice(d.deviceId), authz.authorizeDevice(d.deviceId), authz.authorizeDevice(d.deviceId)]);
        expect(calls).toHaveLength(1);
    });

    it('asks again after the TTL', async () => {
        authz.initAuthz(env('1s'));
        const d = await device('web');
        await authz.authorizeDevice(d.deviceId);
        await new Promise((r) => setTimeout(r, 1_100));
        await authz.authorizeDevice(d.deviceId);
        expect(calls).toHaveLength(2);
    });

    it('does not cache failures', async () => {
        authz.initAuthz(env());
        const d = await device('web');
        answer = () => ({ status: 500, body: {} });
        expect((await authz.authorizeDevice(d.deviceId)).allowed).toBe(false);
        answer = () => ({ status: 200, body: { allowed: true } });
        expect(await authz.authorizeDevice(d.deviceId)).toEqual({ allowed: true });
        expect(calls).toHaveLength(2);
    });

    it('denies an unknown device', async () => {
        authz.initAuthz(env());
        expect((await authz.authorizeDevice('no-such-device')).allowed).toBe(false);
    });
});

describe('forbiddenBody', () => {
    it('omits a missing reason', () => {
        expect(authz.forbiddenBody({ allowed: false, reason: null })).toEqual({ error: 'forbidden' });
        expect(authz.forbiddenBody({ allowed: false, reason: 'r' })).toEqual({ error: 'forbidden', reason: 'r' });
    });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/authz/authz.test.ts`
Expected: FAIL, cannot find module `./authz`.

- [ ] **Step 11: Implement `authz.ts`**

```ts
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
```

- [ ] **Step 12: Run the authz tests, expect PASS**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/authz/`

- [ ] **Step 13: Type check and commit**

```bash
pnpm --filter happy-server exec tsc --noEmit
git add packages/happy-server/sources/app/auth/authz
git commit -m "feat: add an opt-in authorization webhook with a decision cache"
```

### Task 3: Enforce the decision on the server

**Files:**
- Modify: `packages/happy-server/sources/app/api/routes/oidcRoutes.ts` (exchange route, after the `account.disabledAt` check)
- Modify: `packages/happy-server/sources/app/api/utils/enableAuthentication.ts`
- Modify: `packages/happy-server/sources/app/api/socket/socketAuth.ts` (after the `isDeviceActive` block)
- Modify: `packages/happy-server/sources/app/api/socket.ts` (connection handler)
- Modify: `packages/happy-server/sources/main.ts` (after `await initOidcAuth();`)
- Test: create `packages/happy-server/sources/app/api/routes/authzRoutes.spec.ts`; extend `packages/happy-server/sources/app/api/socket/socketAuth.spec.ts`

**Interfaces:**
- Consumes: `initAuthz`, `isAuthzEnabled`, `authzCacheTtlMs`, `authorizeDevice`, `authorizeAccount`, `forbiddenBody`, `resetAuthzForTests` (Task 2).
- Produces: HTTP 403 `{ error: 'forbidden', reason? }`; socket handshake error `Error('forbidden')` with `data: { error: 'forbidden', reason? }`; socket event `forbidden` with `{ reason?: string }` before a server-side disconnect.

- [ ] **Step 1: Write the failing route tests**

`authzRoutes.spec.ts`. Read `oidcRoutes.spec.ts` first and reuse its helper that walks a sign-in to an exchange code for a given client (`web`, `mobile`, `agent`); if it has none, build one with the same requests it makes. The test file:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '../types';
import { buildTestApp, setupAuthTest } from '@/testing/authTestKit';

let db: PrismaClient;
let app: Fastify;
let server: Server;
let allowed = true;
let calls = 0;
let authz: typeof import('@/app/auth/authz/authz');
let devices: typeof import('@/app/auth/oidc/devices');

beforeAll(async () => {
    db = (await setupAuthTest()).db;
    server = createServer((_req, res) => {
        calls++;
        res.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(allowed ? { allowed: true } : { allowed: false, reason: 'Ask IT' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    authz = await import('@/app/auth/authz/authz');
    devices = await import('@/app/auth/oidc/devices');
    authz.initAuthz({
        AUTHZ_WEBHOOK_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/check`,
        AUTHZ_WEBHOOK_SECRET: 's', AUTHZ_WEBHOOK_ALLOW_INSECURE: 'true', AUTHZ_WEBHOOK_CACHE_TTL: '1s',
    });
    app = await buildTestApp((a) => {
        a.get('/whoami', { preHandler: a.authenticate }, async (request) => ({ userId: request.userId }));
    });
});
afterAll(async () => {
    authz.resetAuthzForTests();
    await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => { allowed = true; calls = 0; });

let n = 0;
async function device(kind: string) {
    n++;
    const account = await db.account.create({ data: { publicKey: `pk-authz-route-${n}`, oidcSubject: `r${n}` } });
    return devices.createDevice({ accountId: account.id, kind, name: kind });
}
const whoami = (token: string) => app.inject({ method: 'GET', url: '/whoami', headers: { authorization: `Bearer ${token}` } });

describe('authenticated routes', () => {
    it.each(['web', 'mobile', 'agent'])('refuse a denied %s device with the reason', async (kind) => {
        const d = await device(kind);
        allowed = false;
        const res = await whoami(d.accessToken);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', reason: 'Ask IT' });
    });

    it('let an allowed device through', async () => {
        const d = await device('web');
        expect((await whoami(d.accessToken)).statusCode).toBe(200);
    });

    it('never check a cli device', async () => {
        const d = await device('cli');
        allowed = false;
        expect((await whoami(d.accessToken)).statusCode).toBe(200);
        expect(calls).toBe(0);
    });
});
```
Add, in the same file, an exchange test using the sign-in helper from `oidcRoutes.spec.ts` (register `oidcRoutes` in `buildTestApp` the way that spec does): with `allowed = false`, `POST /v1/auth/oidc/exchange` for a `web` code returns 403 `{ error: 'forbidden', reason: 'Ask IT' }` and `db.device.count({ where: { accountId } })` is unchanged; with `allowed = true` it returns 200.

- [ ] **Step 2: Write the failing socket test**

In `socketAuth.spec.ts`, mock the authz module next to the existing mocks:
```ts
const authorizeDevice = vi.fn();
vi.mock('@/app/auth/authz/authz', () => ({ authorizeDevice: (...a: unknown[]) => authorizeDevice(...a) }));
```
In `beforeEach`: `authorizeDevice.mockReset().mockResolvedValue({ allowed: true });`. Add:
```ts
it('refuses a denied device with the reason in the error data', async () => {
    authorizeDevice.mockResolvedValue({ allowed: false, reason: 'Ask IT' });
    const next = vi.fn();
    await authenticateSocket(userSocket(), next);
    const error = next.mock.calls[0][0];
    expect(error.message).toBe('forbidden');
    expect(error.data).toEqual({ error: 'forbidden', reason: 'Ask IT' });
});

it('refuses when the authorization check throws, without throwing', async () => {
    authorizeDevice.mockRejectedValue(new Error('db down'));
    const next = vi.fn();
    await authenticateSocket(userSocket(), next);
    expect(next.mock.calls[0][0].message).toBe('forbidden');
});
```
with a `userSocket()` helper beside `sessionSocket()`:
```ts
function userSocket() {
    return { handshake: { auth: { token: 't', clientType: 'user-scoped' }, headers: {} }, data: {} as Record<string, unknown> } as any;
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter happy-server exec vitest run sources/app/api/routes/authzRoutes.spec.ts sources/app/api/socket/socketAuth.spec.ts`
Expected: the new tests FAIL (200 instead of 403; socket accepted).

- [ ] **Step 4: Implement the enforcement points**

`enableAuthentication.ts` — after `request.deviceId = verified.deviceId;` (inside the try):
```ts
const decision = await authorizeDevice(verified.deviceId);
if (!decision.allowed) {
    debug({ module: 'auth' }, `auth:forbidden userId=${verified.userId}`);
    return reply.code(403).send(forbiddenBody(decision));
}
```
with `import { authorizeDevice, forbiddenBody } from "@/app/auth/authz/authz";`. (`authorizeDevice` returns immediately when the webhook is off, without a DB query.)

`oidcRoutes.ts` exchange — after the `if (account.disabledAt) { ... }` block:
```ts
const decision = await authorizeAccount(account.id, {
    kind: redeemed.clientKind,
    deviceName: request.body.deviceName ?? redeemed.clientKind,
});
if (!decision.allowed) {
    return reply.code(403).send(forbiddenBody(decision));
}
```
with `import { authorizeAccount, forbiddenBody } from '@/app/auth/authz/authz';`.

`socketAuth.ts` — after the `if (!active) { ... }` block:
```ts
let decision: Awaited<ReturnType<typeof authorizeDevice>>;
try {
    decision = await authorizeDevice(verified.deviceId);
} catch (error) {
    log({ module: 'websocket', level: 'error' }, `Authorization check failed: ${error}`);
    decision = { allowed: false, reason: null };
}
if (!decision.allowed) {
    log({ module: 'websocket' }, `Forbidden device for token`);
    next(Object.assign(new Error('forbidden'), { data: forbiddenBody(decision) }));
    return;
}
```
with `import { authorizeDevice, forbiddenBody } from "@/app/auth/authz/authz";`.

`socket.ts` — in the connection handler, after the `expiryTimer` declaration:
```ts
// Re-check authorization while the socket is open: a denial tells the client why, then disconnects.
const authzTimer = isAuthzEnabled()
    ? setInterval(async () => {
        try {
            const decision = await authorizeDevice(socket.data.deviceId as string);
            if (!decision.allowed) {
                socket.emit('forbidden', forbiddenBody(decision));
                socket.disconnect(true);
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Authorization re-check failed: ${error}`);
        }
    }, Math.max(authzCacheTtlMs(), 1_000))
    : null;
```
and in the `disconnect` handler, next to `clearTimeout(expiryTimer);`: `if (authzTimer) clearInterval(authzTimer);`. Import `{ authorizeDevice, authzCacheTtlMs, forbiddenBody, isAuthzEnabled }` from `@/app/auth/authz/authz`.

`main.ts` — after `await initOidcAuth();` add `initAuthz();` with `import { initAuthz } from "./app/auth/authz/authz";`.

- [ ] **Step 5: Run the server tests, expect PASS; type check**

Run: `pnpm --filter happy-server exec vitest run && pnpm --filter happy-server exec tsc --noEmit`
Expected: all pass (existing tests run with the webhook off).

- [ ] **Step 6: Commit**

```bash
git add packages/happy-server/sources
git commit -m "feat: refuse unauthorized app, web and agent devices at sign-in, requests and sockets"
```

### Task 4: `happycc-agent` reports a denial and exits

**Files:**
- Create: `packages/happy-agent/src/forbidden.ts`, `packages/happy-agent/src/forbidden.test.ts`
- Modify: `packages/happy-agent/src/api.ts` (`handleApiError`, the `status === 403` branch)
- Modify: `packages/happy-agent/src/loopbackLogin.ts` (exchange catch block)
- Modify: `packages/happy-agent/src/session.ts` (`connect_error` handler; a new `forbidden` listener)

**Interfaces:**
- Consumes: the server's 403 body and socket error data (Task 3).
- Produces:
  ```ts
  export function forbiddenReason(data: unknown): string | null | undefined  // undefined = not a forbidden payload
  export function notAuthorizedMessage(reason: string | null): string
  ```

- [ ] **Step 1: Write the failing test**

`forbidden.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { forbiddenReason, notAuthorizedMessage } from './forbidden';

describe('forbidden', () => {
    it('recognizes the server forbidden payload', () => {
        expect(forbiddenReason({ error: 'forbidden', reason: 'Ask IT' })).toBe('Ask IT');
        expect(forbiddenReason({ error: 'forbidden' })).toBeNull();
        expect(forbiddenReason({ error: 'other' })).toBeUndefined();
        expect(forbiddenReason(undefined)).toBeUndefined();
    });

    it('builds the message', () => {
        expect(notAuthorizedMessage('Ask IT')).toBe('Not authorized: Ask IT');
        expect(notAuthorizedMessage(null)).toBe('Not authorized: your organization has not given you access.');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @happycc/agent exec vitest run src/forbidden.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `forbidden.ts`**

```ts
/** The server's denial payload ({ error: 'forbidden', reason? }): its reason, or undefined if `data` is not one. */
export function forbiddenReason(data: unknown): string | null | undefined {
    const value = data as { error?: unknown; reason?: unknown } | null | undefined;
    if (value?.error !== 'forbidden') {
        return undefined;
    }
    return typeof value.reason === 'string' && value.reason.length > 0 ? value.reason : null;
}

export function notAuthorizedMessage(reason: string | null): string {
    return `Not authorized: ${reason ?? 'your organization has not given you access.'}`;
}
```

- [ ] **Step 4: Use it at the three call sites**

`api.ts`, in `handleApiError`, replace the `status === 403` branch with:
```ts
if (status === 403) {
    const reason = forbiddenReason(err.response?.data);
    if (reason !== undefined) {
        throw new Error(notAuthorizedMessage(reason));
    }
    throw new Error(`Forbidden: ${context}. Check your account permissions.`);
}
```
`loopbackLogin.ts`, at the start of the exchange `catch (error)` block:
```ts
const reason = axios.isAxiosError(error) && error.response?.status === 403 ? forbiddenReason(error.response.data) : undefined;
if (reason !== undefined) {
    throw new LoginError(notAuthorizedMessage(reason));
}
```
`session.ts`: add a method and call it from both places:
```ts
/** The server refused this device: stop reconnecting and surface why. */
private stopForbidden(reason: string | null): void {
    this.loggedOut = true;
    this.clearReconnectTimer();
    this.clearDisconnectGrace();
    this.emit('connect_error', new Error(notAuthorizedMessage(reason)));
    this.socket.close();
}
```
At the top of the existing `this.socket.on('connect_error', (error: Error) => {` handler:
```ts
const reason = forbiddenReason((error as Error & { data?: unknown }).data);
if (reason !== undefined) {
    this.stopForbidden(reason);
    return;
}
```
And after that handler:
```ts
this.socket.on('forbidden', (data: unknown) => {
    this.stopForbidden(forbiddenReason(data) ?? null);
});
```
Import `{ forbiddenReason, notAuthorizedMessage }` from `./forbidden` in all three files.

- [ ] **Step 5: Run the agent tests and type check, expect PASS**

Run: `pnpm --filter @happycc/agent test`
Expected: all pass (the existing 316 plus the new ones).

- [ ] **Step 6: Commit**

```bash
git add packages/happy-agent/src
git commit -m "feat: print the authorization denial reason in the agent and stop"
```

### Task 5: The app shows "Not authorized"

**Files:**
- Create: `packages/happy-app/sources/auth/authorization.ts`, `packages/happy-app/sources/auth/authorization.test.ts`, `packages/happy-app/sources/components/NotAuthorizedGate.tsx`
- Modify: `packages/happy-app/sources/auth/authFetch.ts` (`authFetch`), `packages/happy-app/sources/auth/oidcLogin.ts` (`exchangeCode`), `packages/happy-app/sources/sync/apiSocket.ts` (`connect_error` handler and a `forbidden` listener), `packages/happy-app/sources/app/_layout.tsx` (wrap `<SidebarNavigator />`)
- Modify: `packages/happy-app/sources/text/_default.ts` and every file in `packages/happy-app/sources/text/translations/` (`ca, en, es, it, ja, pl, pt, ru, zh-Hans, zh-Hant`)
- Test: `packages/happy-app/sources/auth/authorization.test.ts`; extend `packages/happy-app/sources/auth/authFetch.test.ts`

**Interfaces:**
- Consumes: the 403 body and socket payloads from Task 3.
- Produces:
  ```ts
  export function forbiddenReason(data: unknown): string | null | undefined
  export function reportForbidden(reason: string | null): void
  export function clearForbidden(): void
  export function getForbidden(): { reason: string | null } | null
  export function subscribeForbidden(listener: () => void): () => void
  export function useForbidden(): { reason: string | null } | null
  ```

- [ ] **Step 1: Write the failing tests**

`authorization.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { clearForbidden, forbiddenReason, getForbidden, reportForbidden, subscribeForbidden } from './authorization';

describe('authorization state', () => {
    it('parses the server forbidden payload', () => {
        expect(forbiddenReason({ error: 'forbidden', reason: 'Ask IT' })).toBe('Ask IT');
        expect(forbiddenReason({ error: 'forbidden' })).toBeNull();
        expect(forbiddenReason({ error: 'nope' })).toBeUndefined();
    });

    it('reports and clears a denial, notifying listeners', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeForbidden(listener);
        reportForbidden('Ask IT');
        expect(getForbidden()).toEqual({ reason: 'Ask IT' });
        clearForbidden();
        expect(getForbidden()).toBeNull();
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
    });
});
```
In `authFetch.test.ts`, following the file's existing provider and `fetch` stubbing, add:
```ts
it('reports a forbidden 403 from the server', async () => {
    // stub fetch to return new Response(JSON.stringify({ error: 'forbidden', reason: 'Ask IT' }), { status: 403 })
    const response = await authFetch(`${SERVER}/v1/sessions`);
    expect(response.status).toBe(403);
    expect(getForbidden()).toEqual({ reason: 'Ask IT' });
    clearForbidden();
});
```
(use the server URL constant and fetch stub the file already uses; import `getForbidden`, `clearForbidden` from `./authorization`).

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter happy-app exec vitest run sources/auth/authorization.test.ts sources/auth/authFetch.test.ts`
Expected: FAIL, module not found / no report.

- [ ] **Step 3: Implement `authorization.ts`**

```ts
import { useSyncExternalStore } from 'react';

/**
 * Whether the server refused this device (authorization webhook): set from a 403
 * `{ error: 'forbidden' }` or the socket's denial, shown by NotAuthorizedGate.
 */
type Forbidden = { reason: string | null };

let current: Forbidden | null = null;
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of listeners) listener();
}

/** The reason of a `{ error: 'forbidden', reason? }` payload, or undefined if `data` is not one. */
export function forbiddenReason(data: unknown): string | null | undefined {
    const value = data as { error?: unknown; reason?: unknown } | null | undefined;
    if (value?.error !== 'forbidden') {
        return undefined;
    }
    return typeof value.reason === 'string' && value.reason.length > 0 ? value.reason : null;
}

export function reportForbidden(reason: string | null): void {
    current = { reason };
    notify();
}

export function clearForbidden(): void {
    current = null;
    notify();
}

export function getForbidden(): Forbidden | null {
    return current;
}

export function subscribeForbidden(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useForbidden(): Forbidden | null {
    return useSyncExternalStore(subscribeForbidden, getForbidden, getForbidden);
}
```

- [ ] **Step 4: Report denials from `authFetch` and the socket; reject them at sign-in**

`authFetch.ts` — add a helper and use it on both returns of the server path:
```ts
/** A server 403 `{ error: 'forbidden' }` means this device is not authorized: tell the gate. */
async function noteForbidden(response: Response): Promise<Response> {
    if (response.status === 403) {
        try {
            const reason = forbiddenReason(await response.clone().json());
            if (reason !== undefined) {
                reportForbidden(reason);
            }
        } catch {
            // not a JSON body: an ordinary 403
        }
    }
    return response;
}
```
In `authFetch`, replace `return response;` (after the first server fetch) with `return noteForbidden(response);` and the final `return fetch(url, withBearer(init, fresh));` with `return noteForbidden(await fetch(url, withBearer(init, fresh)));`. Import `{ forbiddenReason, reportForbidden }` from `./authorization`.

`oidcLogin.ts` — in `exchangeCode`, before `if (response.status === 400) {`:
```ts
if (response.status === 403) {
    let reason: string | null | undefined;
    try {
        reason = forbiddenReason(await response.json());
    } catch {
        reason = undefined;
    }
    if (reason !== undefined) {
        throw new OidcLoginError(`Not authorized: ${reason ?? 'your organization has not given you access to this app.'}`);
    }
}
```
(import `forbiddenReason` from `./authorization`).

`apiSocket.ts` — at the top of the `socket.on('connect_error', (error) => {` handler:
```ts
const reason = forbiddenReason((error as Error & { data?: unknown }).data);
if (reason !== undefined) {
    reportForbidden(reason);
}
```
and next to the other `socket.on(...)` registrations:
```ts
socket.on('forbidden', (data: unknown) => {
    reportForbidden(forbiddenReason(data) ?? null);
});
```
(import `{ forbiddenReason, reportForbidden }` from `@/auth/authorization`). Reconnect scheduling stays as it is: once allowed again, the next attempt succeeds.

- [ ] **Step 5: Translations**

Add a top-level section to `_default.ts` (and the same keys to `en.ts`) after `welcome: { ... }`:
```ts
    notAuthorized: {
        title: 'Not authorized',
        defaultReason: 'Your organization has not given you access to this app.',
    },
```
Add the section to every translation file with translated strings:
- `ca.ts`: `title: 'No autoritzat'`, `defaultReason: "La teva organització no t'ha donat accés a aquesta aplicació."`
- `es.ts`: `title: 'No autorizado'`, `defaultReason: 'Tu organización no te ha dado acceso a esta aplicación.'`
- `it.ts`: `title: 'Non autorizzato'`, `defaultReason: "La tua organizzazione non ti ha concesso l'accesso a questa app."`
- `ja.ts`: `title: '権限がありません'`, `defaultReason: '組織からこのアプリへのアクセスが許可されていません。'`
- `pl.ts`: `title: 'Brak uprawnień'`, `defaultReason: 'Twoja organizacja nie przyznała Ci dostępu do tej aplikacji.'`
- `pt.ts`: `title: 'Não autorizado'`, `defaultReason: 'Sua organização não concedeu a você acesso a este app.'`
- `ru.ts`: `title: 'Нет доступа'`, `defaultReason: 'Ваша организация не предоставила вам доступ к этому приложению.'`
- `zh-Hans.ts`: `title: '未授权'`, `defaultReason: '你的组织尚未授予你使用此应用的权限。'`
- `zh-Hant.ts`: `title: '未授權'`, `defaultReason: '你的組織尚未授予你使用此應用程式的權限。'`

- [ ] **Step 6: The gate**

`components/NotAuthorizedGate.tsx`:
```tsx
import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { clearForbidden, useForbidden } from '@/auth/authorization';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { t } from '@/text';

/** Replaces the app with a "Not authorized" view while the server refuses this device. */
export const NotAuthorizedGate = React.memo((props: { children: React.ReactNode }) => {
    const forbidden = useForbidden();
    const auth = useAuth();
    if (!forbidden) {
        return <>{props.children}</>;
    }
    return (
        <View style={styles.container}>
            <Text style={styles.title}>{t('notAuthorized.title')}</Text>
            <Text style={styles.reason}>{forbidden.reason ?? t('notAuthorized.defaultReason')}</Text>
            <View style={styles.buttons}>
                <RoundButton title={t('common.retry')} onPress={clearForbidden} />
                {auth.isAuthenticated && (
                    <RoundButton title={t('common.logout')} display="inverted" action={async () => { clearForbidden(); await auth.logout(); }} />
                )}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16, backgroundColor: theme.colors.groupped.background },
    title: { fontSize: 22, fontWeight: '600', color: theme.colors.text },
    reason: { fontSize: 16, textAlign: 'center', maxWidth: 480, color: theme.colors.textSecondary },
    buttons: { flexDirection: 'row', gap: 12 },
}));
```
Check the names used against the code before writing: `useAuth` (exported by `@/auth/AuthContext`, with `isAuthenticated` and `logout`), the `t` import path (see another component, e.g. `components/EmptyMainScreen.tsx`), and theme color names (`theme.colors.text`, `theme.colors.textSecondary`); adjust to what exists.

In `app/_layout.tsx`, wrap the navigator: `<NotAuthorizedGate><SidebarNavigator /></NotAuthorizedGate>`, importing `NotAuthorizedGate` from `@/components/NotAuthorizedGate`.

- [ ] **Step 7: Run the app tests and type check, expect PASS**

Run: `pnpm --filter happy-app exec vitest run && pnpm --filter happy-app exec tsc --noEmit`

- [ ] **Step 8: Commit**

```bash
git add packages/happy-app/sources
git commit -m "feat: show a not authorized view when the server refuses this device"
```

### Task 6: Local stack mock webhook and end-to-end test

**Files:**
- Create: `deploy/authz-mock/server.mjs`
- Modify: `docker-compose.yaml` (new `authz-mock` service; `server` environment; `oidc-mock` ports)
- Modify: `deploy/oidc-mock/config.yaml` (user `carol`)
- Create: `e2e/tests/authorization.spec.ts`

**Interfaces:**
- Consumes: everything above, through the browser.
- Produces: a mock at `http://localhost:8190` (in the oidc-mock network namespace): `POST /check` (the webhook), `PUT /deny/<email>` and `DELETE /deny/<email>` (test control).

- [ ] **Step 1: The mock**

`deploy/authz-mock/server.mjs`:
```js
// Authorization webhook for the local stack: allows everyone except the emails on the deny list.
// The e2e suite edits the list: PUT /deny/<email>, DELETE /deny/<email>.
import { createServer } from 'node:http';

const SECRET = process.env.AUTHZ_WEBHOOK_SECRET ?? 'local-authz-secret';
const denied = new Set();

createServer((req, res) => {
    const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const deny = req.url?.match(/^\/deny\/(.+)$/);
    if (deny && req.method === 'PUT') { denied.add(decodeURIComponent(deny[1])); return send(200, { denied: [...denied] }); }
    if (deny && req.method === 'DELETE') { denied.delete(decodeURIComponent(deny[1])); return send(200, { denied: [...denied] }); }
    if (req.url !== '/check' || req.method !== 'POST') return send(404, { error: 'not found' });
    if (req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { error: 'bad secret' });
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
        const email = JSON.parse(raw).user?.email;
        send(200, denied.has(email) ? { allowed: false, reason: `${email} is not allowed to use the app.` } : { allowed: true });
    });
}).listen(8190, () => console.log('authz-mock on :8190'));
```

- [ ] **Step 2: Wire it into compose**

In `docker-compose.yaml`:
- under `oidc-mock.ports` add `- "8190:8190"   # authz-mock (shares this network namespace)`;
- add the service (before `postgres:`):
  ```yaml
  authz-mock:
    image: node:22-alpine
    network_mode: "service:oidc-mock"
    depends_on:
      oidc-mock: { condition: service_started }
    environment:
      AUTHZ_WEBHOOK_SECRET: local-authz-secret
    volumes:
      - ./deploy/authz-mock/server.mjs:/server.mjs:ro
    command: ["node", "/server.mjs"]
  ```
- in `server.depends_on` add `authz-mock: { condition: service_started }`; in `server.environment` add:
  ```yaml
      AUTHZ_WEBHOOK_URL: http://localhost:8190/check
      AUTHZ_WEBHOOK_SECRET: local-authz-secret
      AUTHZ_WEBHOOK_ALLOW_INSECURE: "true"
      AUTHZ_WEBHOOK_CACHE_TTL: 1s
  ```
- in `deploy/oidc-mock/config.yaml` add a user:
  ```yaml
    - sub: carol
      email: carol@example.com
      name: Carol Example
  ```
Add one line to the compose header comment: `# authz-mock answers the server's authorization webhook (allow all; the e2e suite denies carol).`

- [ ] **Step 3: Write the e2e test**

`e2e/tests/authorization.spec.ts`:
```ts
import { expect, test } from '@playwright/test';
import { signInToShell } from './helpers';

const AUTHZ_MOCK = process.env.AUTHZ_MOCK_URL ?? 'http://localhost:8190';
const CAROL = 'carol@example.com';

test.afterEach(async ({ request }) => {
    await request.delete(`${AUTHZ_MOCK}/deny/${CAROL}`);
});

test('a denied user sees the reason, then gets in once allowed, without signing in again', async ({ page, request }) => {
    await signInToShell(page, 'Carol Example');
    await request.put(`${AUTHZ_MOCK}/deny/${CAROL}`);
    await page.reload();
    await expect(page.getByText('Not authorized')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`${CAROL} is not allowed to use the app.`)).toBeVisible();

    await request.delete(`${AUTHZ_MOCK}/deny/${CAROL}`);
    await page.waitForTimeout(1_500); // the server caches decisions for AUTHZ_WEBHOOK_CACHE_TTL (1s in compose)
    await page.getByText('Retry', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sessions' }).first()).toBeVisible();
    await expect(page.getByText('Not authorized')).toHaveCount(0);
});

test('a denied user cannot sign in, and is told why', async ({ page, request }) => {
    await request.put(`${AUTHZ_MOCK}/deny/${CAROL}`);
    await page.goto('/');
    await page.getByText('Sign in', { exact: true }).click();
    await page.getByRole('button', { name: /Carol Example/ }).click();
    await expect(page.getByText(`Not authorized: ${CAROL} is not allowed to use the app.`)).toBeVisible({ timeout: 15_000 });
});
```

- [ ] **Step 4: Run the stack and the e2e suite**

Run:
```bash
docker compose --profile e2e up -d --build server webapp authz-mock
cd e2e && npx playwright test
```
Expected: all specs pass, including `authorization.spec.ts`; the other specs (alice, bob) are unaffected because the mock allows them. Do not touch the container `oidc-mock-oidc-mock-1` (another project); this stack's containers belong to this repo's compose project.

- [ ] **Step 5: Commit**

```bash
git add deploy/authz-mock docker-compose.yaml deploy/oidc-mock/config.yaml e2e/tests/authorization.spec.ts
git commit -m "test: deny and allow a user through a mock authorization webhook end to end"
```

### Task 7: Document it for admins

**Files:**
- Modify: `docs/deployment.md` (new section "Authorization" after "Identity provider"; the sentence "Who may use happycc is decided in the provider…"; the "Optional" configuration table)
- Modify: `docs/superpowers/specs/2026-10-05-authz-webhook-design.md` (status line)

- [ ] **Step 1: Write the docs**

In `docs/deployment.md`, replace "Who may use happycc is decided in the provider, for example by assigning users or groups to the client." with:
```markdown
Who may sign in is decided in the provider: restrict the client to the users or groups who should use
happycc, if your provider supports it (for example Microsoft Entra "Assignment required" or Okta
assignments). For a decision made by your own systems, use the authorization webhook below.
```
Add after the "Identity provider" section:
```markdown
## Authorization

Optional. Set `AUTHZ_WEBHOOK_URL` and the server asks your webhook whether a user may use the web app,
the mobile app and `happycc-agent`, which can read every session of the account. The `happycc` CLI is
never checked: it only acts on its own workstation.

The server sends:

```http
POST <AUTHZ_WEBHOOK_URL>
Authorization: Bearer <AUTHZ_WEBHOOK_SECRET>
Content-Type: application/json

{ "user": { "accountId": "...", "issuer": "...", "subject": "...", "email": "...", "name": "...",
            "claims": { "groups": ["..."] } },
  "client": { "kind": "web" | "mobile" | "agent", "deviceName": "..." } }
```

`claims` are the user's latest ID token claims (without token bookkeeping such as `exp` or `nonce`).
Answer `200` with `{ "allowed": true }` or `{ "allowed": false, "reason": "..." }`; the reason (up to 500
characters) is shown to the user. Decisions apply at sign-in, on every request and on open
connections, and are cached per user and client for `AUTHZ_WEBHOOK_CACHE_TTL`, so a change takes
effect within that time without signing in again. A denial does not sign the user out.

If the webhook fails (error status, timeout, invalid answer), access is denied with "Authorization is
unavailable. Try again later.", and the next request asks again.
```
(Use a four-backtick outer fence when pasting so the inner `http` fence survives.) Add to the "Optional" table:
```markdown
| `AUTHZ_WEBHOOK_URL`, `AUTHZ_WEBHOOK_SECRET` | Authorization webhook (above); the secret is required with the URL, and the URL must be `https` unless `AUTHZ_WEBHOOK_ALLOW_INSECURE=true` |
| `AUTHZ_WEBHOOK_CACHE_TTL`, `AUTHZ_WEBHOOK_TIMEOUT` | Decision cache (default `60s`) and webhook timeout (default `5s`) |
```
In the spec, change the status line to `Status: implemented (2026-10-05)`.

- [ ] **Step 2: Commit**

```bash
git add docs/deployment.md docs/superpowers/specs/2026-10-05-authz-webhook-design.md
git commit -m "docs: document the authorization webhook for admins"
```
