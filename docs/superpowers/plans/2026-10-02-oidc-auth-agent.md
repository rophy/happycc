# OIDC Auth — happy-agent Loopback Login and Mobile Gym Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `happy-agent` sign in with an RFC 8252 loopback authorization-code flow that delivers the account root secret. Keep its 15-minute access tokens fresh. Make `happy resume` read the new `agent.key` format. Remove `happy-mobile-gym`.

**Architecture:** The server gains a third app-facing login target, `client=loopback`. It accepts only `http://127.0.0.1:<port>/callback` or `http://[::1]:<port>/callback`, redirects there with `?code=`, and redeems the code at the existing `/v1/auth/oidc/exchange` as device kind `agent`. `happy-agent auth login` runs a one-shot `127.0.0.1:0` listener, prints the login URL, waits up to 5 minutes for the callback, then exchanges the code with PKCE and an ephemeral box key. It saves `{token, refreshToken, secret}` atomically under a file lock. A per-process `TokenStore` refreshes on demand, 2 minutes before expiry or after one 401. Refreshes are single-flight, adopt-or-refresh under the credentials lock. Sockets take an `auth` callback that awaits a fresh token at every handshake.

**Tech Stack:** TypeScript (ESM), axios, tweetnacl, socket.io-client, node:http, Vitest 3, Fastify + Prisma (server), oidc-mock + `pnpm env:up:authenticated` for integration.

**Spec:** `docs/superpowers/specs/2026-09-30-oidc-auth-design.md` (§2 "happy-agent (remote control CLI)", "Refresh", "Sockets", "Logout", "Removed from clients")

**Depends on:** Plans 1–3 (server, CLI, app) as committed on this branch.

## Global Constraints

- Server contract (plan 1, extended by Task 1):
  - `GET /v1/auth/oidc/login?client=loopback&code_challenge=<S256, base64url 43–128 chars>&redirect_uri=<uri>` → 302 to the IdP. A bad challenge or redirect gets `400 {error}`, and an undiscovered IdP gets `503 {error: 'idp_unavailable'}`.
  - The loopback `redirect_uri` must be exactly `http://127.0.0.1:<port>/callback` or `http://[::1]:<port>/callback`, with port 1–65535 and no leading zeros. It may not use `localhost`, carry userinfo, use any other path, or have a query or fragment.
  - After the IdP, the callback redirects to `${redirect_uri}?code=<exchangeCode>` (single use, 60 s TTL).
  - `POST /v1/auth/oidc/exchange {code, codeVerifier, ephemeralPublicKey: base64(32 bytes), deviceName?: string(≤100)}` → `200 {accountId, accessToken, refreshToken, keyBundle}`. `keyBundle` is base64 `[ephPub(32) | nonce(24) | box(rootSecret(32))]`, the same as for web. Errors are `400 {error: 'invalid_request' | 'invalid_grant'}` and `500 {error: 'server_error'}`.
  - The exchange records a `Device` with `kind = 'agent'` and `name = deviceName`. The agent sends `happy-agent@<os hostname>`.
  - `POST /v1/auth/refresh {refreshToken}` → `200 {accessToken, refreshToken}`, or `401 {error: 'invalid_grant', reason}`.
  - `POST /v1/auth/logout` with `Authorization: Bearer <access token>` → `200 {success: true}`.
- The agent credentials file is `config.credentialPath` (`$HAPPY_HOME_DIR/agent.key`, default `~/.happy/agent.key`). It holds `{"token", "refreshToken", "secret": base64(32 bytes)}` and is written atomically (temp file + rename) with mode `0o600`, only while holding the lock `agent.key.lock`. A file without `refreshToken` counts as logged out, in both happy-agent and `happy resume`.
- Proactive refresh margin is 2 minutes before the JWT `exp`. A refresh POST has a hard 10 s deadline (`timeout` + `AbortSignal.timeout`). Logout POST has a hard 5 s deadline. Login waits at most 5 minutes for the browser callback.
- Retry at most once per HTTP request on 401, and only for URLs whose origin equals `config.serverUrl`'s origin.
- Never print or log access tokens, refresh tokens, or key material, in login output, `auth status`, or error messages.
- Commit messages are `<type>: <short description>`, with types feat/fix/refactor/chore/docs/build/test. No AI attribution, no `Co-Authored-By`, and no mention of Claude. Commits are GPG-signed automatically; never disable signing. Do not push.
- The repo is pinned to `pnpm@10.11.0`; check with `pnpm --version` before any `pnpm install`.
- Commands:
  - **Server:** unit `pnpm --filter happy-server exec vitest run <files>`; full `pnpm --filter happy-server test`; typecheck `pnpm --filter happy-server typecheck`; integration `docker compose up -d oidc-mock && pnpm --filter happy-server test:integration`.
  - **Agent:** unit `pnpm --filter happy-agent exec vitest run <files>`; full `pnpm --filter happy-agent test`, which builds `dist/` first because `cli-smoke.test.ts` and `index.test.ts` run the built binary; typecheck `pnpm --filter happy-agent typecheck`.
  - **CLI:** unit `pnpm --filter happy exec vitest run --project unit <files>`; full `pnpm --filter happy test`.
  - **App:** `pnpm --filter happy-app exec vitest run <files>`; typecheck `pnpm --filter happy-app typecheck`.

## Rulings

- **Copy, don't share.** happy-agent gets its own minimal `fileLock.ts` (verbatim copy of `packages/happy-cli/src/utils/fileLock.ts`), `jwt.ts` (verbatim copy), and a ~150-line `tokenStore.ts` adapted from the CLI's. Reasons:
  - happy-agent already duplicates the CLI's crypto (`src/encryption.ts`), so this follows the existing pattern.
  - `@slopus/happy-wire` is a types/zod package also consumed by the React Native app, so it cannot host `node:fs` locks or axios code.
  - A new shared package would add a workspace entry, lockfile churn, and a second published dependency for the npm-published `happy-agent`.
  - The CLI store is bound to the CLI `configuration` singleton, logger, and global axios interceptor, so extracting it would mean refactoring a hardened module for no behavior gain.
- **Agent token store vs. the CLI's.**
  - **Kept:** single-flight, adopt-or-refresh under the lock, `invalid_grant` → clear only if the file still holds that refresh token, and the hard deadline.
  - **Dropped as unneeded for a short-lived command process:**
    - The background timer: every request and socket handshake checks `exp` against the 2-minute margin instead.
    - The global axios interceptor: an explicit `withAuthRetry` wraps the six API calls.
    - `pendingRotation`: if a write fails after the server rotated, the error surfaces and the next run replays the previous token inside the server's `AUTH_REFRESH_REUSE_GRACE`.
  - **Added:** the store refuses to adopt or refresh a file whose `secret` differs from its own, which means another account logged in meanwhile. Same reasoning as app commit `afc3a007`.
- **No browser launch.** `open` is a dependency of happy-cli, not happy-agent, so per the approved design the agent only prints the URL. `--no-browser` is still accepted (scripts and the integration test pass it) and is documented as "only print the URL". No dependency is added.
- **No migration.** `Device.kind` and `OidcExchangeCode.clientKind` are free `String` columns (`prisma/schema.prisma` lines 77 and 124), so `'agent'` needs only TypeScript type changes. The exchange code stores `clientKind = 'agent'` for the `loopback` login target.
- **CLI resume keeps reading `agent.key`.** `resolveHappySession.ts` only uses `secret` and `contentKeyPair` from it; HTTP goes through the CLI's own token store. So the only CLI change is that the schema requires `refreshToken`.
- **Integration test reuses `pnpm env:up:authenticated`** (server from source + seeded CLI daemon for user `alice` via the device flow), as `happy-agent.integration.test.ts` already does. It needs `docker compose up -d oidc-mock`. The agent signs in as the same user, so it decrypts machine metadata the CLI daemon encrypted.
- **Mobile gym leftovers:**
  - `scripts/app-store/seed-multiplayer.mjs` imports `packages/happy-mobile-gym/dist`, and `docs/core-demo-recording.md` is only gym instructions, so both are deleted.
  - The app-store and Android guides point at the compose stack instead, and say plainly that the multiplayer card has no producer until one is rebuilt.
  - `environments.ts` keeps its `isolated` guard because old isolated environments may still exist on disk. Only its two gym messages change.
  - `scripts/app-store/OBSERVATIONS.md` and the "synthetic `gym` provider" lines refer to a past capture run and to an Agent provider name, not this package, so they are left alone.

## File Structure

```
packages/happy-server/
  sources/app/auth/oidc/loopbackRedirect.ts (+ .test.ts)   create: parseLoopbackRedirectUri
  sources/app/auth/oidc/exchangeCodes.ts                   modify: ExchangeClientKind adds 'agent'
  sources/app/auth/oidc/devices.ts                         modify: DeviceKind adds 'agent'
  sources/app/api/routes/oidcRoutes.ts                     modify: client=loopback target, redirect with ?code=
  sources/app/api/routes/oidcRoutes.spec.ts                modify: loopback route tests
  sources/app/auth/oidc/oidc.integration.test.ts           modify: loopback against oidc-mock
docs/superpowers/specs/2026-09-30-oidc-auth-design.md      modify: Device.kind lists agent
packages/happy-agent/
  src/fileLock.ts (+ .test.ts)          create: withFileLock (copy of CLI)
  src/testing/fakeServer.ts             create: node:http fake + makeJwt for unit tests
  src/credentials.ts (+ .test.ts)       rewrite: {token, refreshToken, secret}, atomic 0600, lock helpers
  src/loopbackLogin.ts (+ .test.ts)     create: listener, PKCE, exchange, save
  src/auth.ts (+ .test.ts)              rewrite: login/logout/status (no QR)
  src/jwt.ts (+ .test.ts)               create: decodeJwtExpiry (copy of CLI)
  src/tokenStore.ts (+ .test.ts)        create: TokenStore, LoggedOutError, withAuthRetry, socketAuth
  src/api.ts, src/api.test.ts           modify: TokenSource param, 401 retry
  src/session.ts, src/session.test.ts   modify: socket auth callback
  src/machineRpc.ts                     modify: socket auth callback
  src/index.ts                          modify: auth commands, openAuth helper, tokens everywhere
  src/cli-smoke.test.ts                 modify: login help text, Credentials fixture
  src/happy-agent.integration.test.ts   modify: loopback login via HttpBrowser + decrypt checks
  package.json, README.md               modify: drop qrcode-terminal; auth docs
packages/happy-cli/src/resume/localHappyAgentAuth.ts (+ .test.ts)   modify: require refreshToken
delete: packages/happy-mobile-gym/, docs/core-demo-recording.md, scripts/app-store/seed-multiplayer.mjs
package.json, pnpm-workspace.yaml, pnpm-lock.yaml          modify: drop gym (and agent's qrcode deps)
packages/happy-app/sources/sync/serverConfig.ts            modify: drop EXPO_PUBLIC_HARNESS_MODE block
environments/environments.ts                               modify: gym messages
scripts/app-store/README.md, ANDROID.md, android-capture.mjs   modify: gym mentions → compose stack
```

---

### Task 1: Server loopback login target and `agent` devices

**Files:**
- Create: `packages/happy-server/sources/app/auth/oidc/loopbackRedirect.ts`
- Test: `packages/happy-server/sources/app/auth/oidc/loopbackRedirect.test.ts`
- Modify: `packages/happy-server/sources/app/auth/oidc/exchangeCodes.ts`
- Modify: `packages/happy-server/sources/app/auth/oidc/devices.ts:5`
- Modify: `packages/happy-server/sources/app/api/routes/oidcRoutes.ts`
- Modify: `packages/happy-server/sources/app/api/routes/oidcRoutes.spec.ts`
- Modify: `packages/happy-server/sources/app/auth/oidc/oidc.integration.test.ts`
- Modify: `docs/superpowers/specs/2026-09-30-oidc-auth-design.md:62`

**Interfaces:**
- Produces:
  ```ts
  // loopbackRedirect.ts
  function parseLoopbackRedirectUri(value: string | undefined): string | null  // the input unchanged, or null
  // exchangeCodes.ts
  type ExchangeClientKind = 'web' | 'mobile' | 'agent'
  function createExchangeCode(input: { accountId: string; clientKind: ExchangeClientKind; pkceChallenge: string }): Promise<string>
  function redeemExchangeCode(code: string, codeVerifier: string): Promise<{ accountId: string; clientKind: ExchangeClientKind } | null>
  // devices.ts
  type DeviceKind = 'cli' | 'web' | 'mobile' | 'agent'
  // oidcRoutes.ts
  type LoginTarget = ... | { kind: 'loopback'; appChallenge: string; redirectUri: string }
  ```
  HTTP: `GET /v1/auth/oidc/login?client=loopback&code_challenge=…&redirect_uri=…`. The callback answers `302 Location: ${redirect_uri}?code=<code>`.

- [ ] **Step 1: Write the failing unit test**

```ts
// packages/happy-server/sources/app/auth/oidc/loopbackRedirect.test.ts
import { describe, expect, it } from 'vitest';
import { parseLoopbackRedirectUri } from './loopbackRedirect';

describe('parseLoopbackRedirectUri', () => {
    it.each([
        'http://127.0.0.1:53682/callback',
        'http://[::1]:53682/callback',
        'http://127.0.0.1:1/callback',
        'http://127.0.0.1:80/callback',
        'http://127.0.0.1:65535/callback',
    ])('accepts %s unchanged', (uri) => {
        expect(parseLoopbackRedirectUri(uri)).toBe(uri);
    });

    it.each([
        undefined,
        '',
        'http://localhost:53682/callback',
        'http://127.0.0.2:53682/callback',
        'http://0.0.0.0:53682/callback',
        'http://[::2]:53682/callback',
        'http://[0:0:0:0:0:0:0:1]:53682/callback',
        'https://127.0.0.1:53682/callback',
        'HTTP://127.0.0.1:53682/callback',
        'http://127.0.0.1/callback',
        'http://127.0.0.1:0/callback',
        'http://127.0.0.1:00080/callback',
        'http://127.0.0.1:65536/callback',
        'http://127.0.0.1:99999/callback',
        'http://127.0.0.1:53682/',
        'http://127.0.0.1:53682/callback/',
        'http://127.0.0.1:53682/other',
        'http://127.0.0.1:53682/%63allback',
        'http://127.0.0.1:53682/callback?x=1',
        'http://127.0.0.1:53682/callback?',
        'http://127.0.0.1:53682/callback#frag',
        'http://user@127.0.0.1:53682/callback',
        ' http://127.0.0.1:53682/callback',
        'corpapp://auth/callback',
    ])('rejects %s', (uri) => {
        expect(parseLoopbackRedirectUri(uri)).toBeNull();
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/loopbackRedirect.test.ts`
Expected: FAIL. Vitest cannot resolve `./loopbackRedirect`.

- [ ] **Step 3: Implement the parser**

```ts
// packages/happy-server/sources/app/auth/oidc/loopbackRedirect.ts
const LOOPBACK_REDIRECT = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/callback$/;

/**
 * RFC 8252 loopback redirect for happy-agent: exactly `http://127.0.0.1:<port>/callback`
 * or `http://[::1]:<port>/callback`, port 1–65535. Returns the URI unchanged, or null.
 * The regex pins the exact shape (no localhost, userinfo, other path, query or fragment);
 * URL parsing double-checks that a WHATWG parser reads it the same way.
 */
export function parseLoopbackRedirectUri(value: string | undefined): string | null {
    if (!value) {
        return null;
    }
    const match = LOOPBACK_REDIRECT.exec(value);
    if (!match) {
        return null;
    }
    const port = Number(match[2]);
    if (port < 1 || port > 65535) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (
        url.protocol !== 'http:'
        || (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]')
        || url.username !== ''
        || url.password !== ''
        || url.pathname !== '/callback'
        || url.search !== ''
        || url.hash !== ''
    ) {
        return null;
    }
    return value;
}
```

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/loopbackRedirect.test.ts`
Expected: PASS (29 cases).

- [ ] **Step 4: Write the failing route tests**

Append inside `describe('oidcRoutes', …)` in `packages/happy-server/sources/app/api/routes/oidcRoutes.spec.ts`, before its closing `});`:

```ts
    it('loopback: redirects to the agent listener and records an agent device holding the root secret', async () => {
        const { verifier, challenge } = pkce();
        const redirectUri = 'http://127.0.0.1:53682/callback';
        const callback = await login(
            `client=loopback&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirectUri)}`,
            'r-loopback',
        );
        expect(callback.statusCode).toBe(302);
        const location = new URL(callback.headers.location as string);
        expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
        expect([...location.searchParams.keys()]).toEqual(['code']);
        const code = location.searchParams.get('code')!;

        const ephemeral = tweetnacl.box.keyPair();
        const exchange = await app.inject({
            method: 'POST',
            url: '/v1/auth/oidc/exchange',
            payload: {
                code,
                codeVerifier: verifier,
                ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(ephemeral.publicKey)),
                deviceName: 'happy-agent@build-host',
            },
        });
        expect(exchange.statusCode).toBe(200);
        const body = exchange.json();
        const bundle = privacyKit.decodeBase64(body.keyBundle);
        const root = tweetnacl.box.open(bundle.slice(56), bundle.slice(32, 56), bundle.slice(0, 32), ephemeral.secretKey)!;
        const account = await db.account.findUniqueOrThrow({ where: { id: body.accountId } });
        expect(Buffer.from(root).equals(Buffer.from(vault.keyVault.unwrap(account.wrappedRootSecret!)))).toBe(true);
        const device = await db.device.findFirstOrThrow({ where: { accountId: body.accountId } });
        expect(device.kind).toBe('agent');
        expect(device.name).toBe('happy-agent@build-host');
    });

    it('loopback: accepts the IPv6 loopback literal', async () => {
        const { challenge } = pkce();
        const callback = await login(
            `client=loopback&code_challenge=${challenge}&redirect_uri=${encodeURIComponent('http://[::1]:8123/callback')}`,
            'r-loopback-v6',
        );
        expect(callback.statusCode).toBe(302);
        expect(callback.headers.location as string).toMatch(/^http:\/\/\[::1\]:8123\/callback\?code=/);
    });

    it.each([
        'http://localhost:53682/callback',
        'https://127.0.0.1:53682/callback',
        'http://127.0.0.1:53682/other',
        'http://127.0.0.1:53682/callback?x=1',
        'http://127.0.0.1:0/callback',
        'corpapp://auth/callback',
    ])('loopback: rejects redirect_uri %s', async (uri) => {
        const { challenge } = pkce();
        const res = await app.inject({
            method: 'GET',
            url: `/v1/auth/oidc/login?client=loopback&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(uri)}`,
        });
        expect(res.statusCode).toBe(400);
    });

    it('loopback: requires a redirect_uri and a code challenge', async () => {
        const { challenge } = pkce();
        const noRedirect = await app.inject({ method: 'GET', url: `/v1/auth/oidc/login?client=loopback&code_challenge=${challenge}` });
        expect(noRedirect.statusCode).toBe(400);
        const noChallenge = await app.inject({
            method: 'GET',
            url: `/v1/auth/oidc/login?client=loopback&redirect_uri=${encodeURIComponent('http://127.0.0.1:53682/callback')}`,
        });
        expect(noChallenge.statusCode).toBe(400);
    });
```

Run: `pnpm --filter happy-server exec vitest run sources/app/api/routes/oidcRoutes.spec.ts`
Expected: FAIL. The new tests get 400 from zod (`client` enum lacks `loopback`).

- [ ] **Step 5: Implement the route, exchange-code and device kinds**

`packages/happy-server/sources/app/auth/oidc/devices.ts` line 5:

```ts
export type DeviceKind = 'cli' | 'web' | 'mobile' | 'agent';
```

`packages/happy-server/sources/app/auth/oidc/exchangeCodes.ts`: add the type below the imports and use it in both signatures and the cast.

```ts
export type ExchangeClientKind = 'web' | 'mobile' | 'agent';
```

- In `createExchangeCode`, change `clientKind: 'web' | 'mobile';` to `clientKind: ExchangeClientKind;`.
- Change `redeemExchangeCode`'s return type to `Promise<{ accountId: string; clientKind: ExchangeClientKind } | null>`.
- Change its last line to `return { accountId: row.accountId, clientKind: row.clientKind as ExchangeClientKind };`.

`packages/happy-server/sources/app/api/routes/oidcRoutes.ts`:

1. Add the import `import { parseLoopbackRedirectUri } from '@/app/auth/oidc/loopbackRedirect';`.
2. Extend `LoginTarget`:

```ts
export type LoginTarget =
    | { kind: 'web'; appChallenge: string }
    | { kind: 'mobile'; appChallenge: string; redirectUri: string }
    | { kind: 'loopback'; appChallenge: string; redirectUri: string }
    | { kind: 'activate'; userCode: string | null };
```

3. In the login querystring schema, change `client: z.enum(['web', 'mobile', 'activate']),` to `client: z.enum(['web', 'mobile', 'loopback', 'activate']),`.
4. Replace the inner `if (query.client === 'mobile') { … } else { … }` block with:

```ts
            if (query.client === 'mobile') {
                if (!query.redirect_uri || !config.mobileRedirectUris.includes(query.redirect_uri)) {
                    return reply.code(400).send({ error: 'redirect_uri is not allowed' });
                }
                target = { kind: 'mobile', appChallenge: query.code_challenge, redirectUri: query.redirect_uri };
            } else if (query.client === 'loopback') {
                const redirectUri = parseLoopbackRedirectUri(query.redirect_uri);
                if (!redirectUri) {
                    return reply.code(400).send({ error: 'redirect_uri is not allowed' });
                }
                target = { kind: 'loopback', appChallenge: query.code_challenge, redirectUri };
            } else {
                target = { kind: 'web', appChallenge: query.code_challenge };
            }
```

5. In the callback, replace the lines from `const code = await createExchangeCode(` through `if (target.kind === 'mobile') { … }` with:

```ts
        const clientKind = target.kind === 'loopback' ? 'agent' : target.kind;
        const code = await createExchangeCode({ accountId, clientKind, pkceChallenge: target.appChallenge });
        reply.header('set-cookie', clearCookieHeader(LOGIN_COOKIE));
        if (target.kind === 'mobile' || target.kind === 'loopback') {
            return reply.redirect(`${target.redirectUri}?code=${encodeURIComponent(code)}`);
        }
```

The web redirect line after it stays. The exchange handler needs no change: it already passes `redeemed.clientKind` as the device kind and `request.body.deviceName ?? redeemed.clientKind` as the name.

- [ ] **Step 6: Run the route tests and typecheck**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/loopbackRedirect.test.ts sources/app/api/routes/oidcRoutes.spec.ts`
Expected: PASS.

Run: `pnpm --filter happy-server typecheck`
Expected: no errors.

- [ ] **Step 7: Extend the oidc-mock integration test**

In `packages/happy-server/sources/app/auth/oidc/oidc.integration.test.ts`, insert this test right after `it('a different user gets a different account', …)` and before the IdP-revocation test, because that test revokes all of alice's devices:

```ts
    it('loopback (happy-agent): redirects to 127.0.0.1 and exchanges for the root secret', async () => {
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const redirectUri = 'http://127.0.0.1:9/callback';
        const result = await idpLogin(
            new HttpBrowser(),
            `${BASE}/v1/auth/oidc/login?client=loopback&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirectUri)}`,
            'alice',
            (url) => url.startsWith('http://127.0.0.1:9/'),
        );
        const location = new URL(result.location!);
        expect(`${location.origin}${location.pathname}`).toBe(redirectUri);

        const ephemeral = tweetnacl.box.keyPair();
        const exchange = await post('/v1/auth/oidc/exchange', {
            code: location.searchParams.get('code'),
            codeVerifier: verifier,
            ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(ephemeral.publicKey)),
            deviceName: 'happy-agent@it-host',
        });
        expect(exchange.status).toBe(200);
        expect(exchange.json.accountId).toBe(cliAccountId);
        const root = openBox(exchange.json.keyBundle, ephemeral.secretKey);
        expect(Buffer.from(deriveContentPublicKey(root)).equals(Buffer.from(cliContentKey))).toBe(true);

        const { db } = await import('@/storage/db');
        const device = await db.device.findFirstOrThrow({ where: { accountId: cliAccountId, name: 'happy-agent@it-host' } });
        expect(device.kind).toBe('agent');
    });
```

Run: `docker compose up -d oidc-mock && pnpm --filter happy-server test:integration`
Expected: PASS (all tests, including the new one).

- [ ] **Step 8: Update the spec's schema line**

In `docs/superpowers/specs/2026-09-30-oidc-auth-design.md`, change ``- New `Device`: `id`, `accountId`, `kind` (`cli` | `web` | `mobile`), `name`,`` to ``- New `Device`: `id`, `accountId`, `kind` (`cli` | `web` | `mobile` | `agent`), `name`,``.

- [ ] **Step 9: Full server suite and commit**

Run: `pnpm --filter happy-server test`
Expected: all pass.

```bash
git add packages/happy-server/sources/app/auth/oidc/loopbackRedirect.ts packages/happy-server/sources/app/auth/oidc/loopbackRedirect.test.ts \
  packages/happy-server/sources/app/auth/oidc/exchangeCodes.ts packages/happy-server/sources/app/auth/oidc/devices.ts \
  packages/happy-server/sources/app/api/routes/oidcRoutes.ts packages/happy-server/sources/app/api/routes/oidcRoutes.spec.ts \
  packages/happy-server/sources/app/auth/oidc/oidc.integration.test.ts docs/superpowers/specs/2026-09-30-oidc-auth-design.md
git commit -m "feat: add loopback OIDC login for happy-agent"
```

---

### Task 2: happy-agent loopback sign-in and credentials file v2

**Files:**
- Create: `packages/happy-agent/src/fileLock.ts`, `packages/happy-agent/src/fileLock.test.ts`
- Create: `packages/happy-agent/src/testing/fakeServer.ts`
- Create: `packages/happy-agent/src/loopbackLogin.ts`, `packages/happy-agent/src/loopbackLogin.test.ts`
- Rewrite: `packages/happy-agent/src/credentials.ts`, `packages/happy-agent/src/credentials.test.ts`
- Rewrite: `packages/happy-agent/src/auth.ts`, `packages/happy-agent/src/auth.test.ts`
- Modify: `packages/happy-agent/src/index.ts` (auth commands)
- Modify: `packages/happy-agent/src/api.test.ts`, `packages/happy-agent/src/cli-smoke.test.ts` (Credentials fixtures, help text)
- Modify: `packages/happy-agent/package.json`, `pnpm-lock.yaml`, `packages/happy-agent/README.md`

**Interfaces:**
- Consumes: Task 1's server contract (Global Constraints).
- Produces:
  ```ts
  // fileLock.ts
  function withFileLock<T>(lockPath: string, fn: () => Promise<T>, opts?: { retryIntervalMs?: number; maxAttempts?: number; staleAfterMs?: number }): Promise<T>
  // credentials.ts
  type StoredCredentials = { token: string; refreshToken: string; secret: Uint8Array }
  type Credentials = StoredCredentials & { contentKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array } }
  const CREDENTIALS_LOCK_OPTIONS: { staleAfterMs: 30_000; maxAttempts: 200 }
  function credentialsLockFile(config: Config): string                 // config.credentialPath + '.lock'
  function ensureCredentialsDir(config: Config): void                  // mkdir -p dirname, mode 0700
  function readCredentials(config: Config): Credentials | null         // null: missing, invalid, no refreshToken, secret ≠ 32 bytes
  function writeCredentials(config: Config, credentials: StoredCredentials): void   // atomic, 0600; caller holds the lock
  function clearCredentials(config: Config): void
  function clearCredentialsIfRefreshToken(config: Config, refreshToken: string): boolean
  function requireCredentials(config: Config): Credentials             // throws 'Not authenticated. Run `happy-agent auth login` first.'
  // loopbackLogin.ts
  const LOGIN_TIMEOUT_MS = 300_000
  class LoginError extends Error {}
  function loopbackLogin(opts: { config: Config; deviceName: string; io: { print(line: string): void }; timeoutMs?: number }): Promise<StoredCredentials>
  // auth.ts
  function authLogin(config: Config): Promise<void>
  function authLogout(config: Config): Promise<void>
  function authStatus(config: Config): Promise<void>
  // testing/fakeServer.ts (tests only)
  function startFakeServer(handlers: Record<string, FakeHandler>): Promise<{ url: string; calls: FakeCall[]; close(): Promise<void> }>
  function makeJwt(expSecondsFromNow: number): string
  ```
  `Credentials` keeps a `token` field, so `api.ts`, `session.ts`, `machineRpc.ts` and `index.ts` compile unchanged until Task 3.

- [ ] **Step 1: Copy the file lock with its tests**

`packages/happy-agent/src/fileLock.ts` is a byte-for-byte copy of `packages/happy-cli/src/utils/fileLock.ts`:

```bash
cp packages/happy-cli/src/utils/fileLock.ts packages/happy-agent/src/fileLock.ts
```

```ts
// packages/happy-agent/src/fileLock.test.ts
import { mkdtempSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFileLock } from './fileLock';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'happy-agent-lock-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('withFileLock', () => {
    it('runs the callback and releases the lock', async () => {
        const lock = join(dir, 'a.lock');
        const result = await withFileLock(lock, async () => {
            expect(existsSync(lock)).toBe(true);
            return 42;
        });
        expect(result).toBe(42);
        expect(existsSync(lock)).toBe(false);
    });

    it('releases the lock when the callback throws', async () => {
        const lock = join(dir, 'b.lock');
        await expect(withFileLock(lock, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(existsSync(lock)).toBe(false);
    });

    it('serializes concurrent callers', async () => {
        const lock = join(dir, 'c.lock');
        const order: string[] = [];
        const slow = withFileLock(lock, async () => {
            order.push('a:start');
            await new Promise((r) => setTimeout(r, 150));
            order.push('a:end');
        }, { retryIntervalMs: 10 });
        await new Promise((r) => setTimeout(r, 20));
        const fast = withFileLock(lock, async () => { order.push('b'); }, { retryIntervalMs: 10 });
        await Promise.all([slow, fast]);
        expect(order).toEqual(['a:start', 'a:end', 'b']);
    });

    it('breaks a stale lock', async () => {
        const lock = join(dir, 'd.lock');
        writeFileSync(lock, '');
        const old = new Date(Date.now() - 60_000);
        utimesSync(lock, old, old);
        await expect(withFileLock(lock, async () => 'ok', { retryIntervalMs: 10 })).resolves.toBe('ok');
    });

    it('gives up after maxAttempts', async () => {
        const lock = join(dir, 'e.lock');
        writeFileSync(lock, '');
        await expect(withFileLock(lock, async () => 'never', { retryIntervalMs: 5, maxAttempts: 3, staleAfterMs: 60_000 }))
            .rejects.toThrow(`Failed to acquire lock ${lock}`);
    });
});
```

Run: `pnpm --filter happy-agent exec vitest run src/fileLock.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 2: Add the fake server test helper**

```ts
// packages/happy-agent/src/testing/fakeServer.ts
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeResult = { status: number; body: unknown };
export type FakeHandler = (body: any, req: IncomingMessage) => FakeResult | Promise<FakeResult>;
export type FakeCall = { method: string; path: string; body: any; authorization?: string };

/** node:http stand-in for the Happy server in unit tests. Handlers are keyed by "METHOD /path". */
export async function startFakeServer(handlers: Record<string, FakeHandler>) {
    const calls: FakeCall[] = [];
    const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', async () => {
            const path = (req.url ?? '').split('?')[0];
            const body = raw ? JSON.parse(raw) : undefined;
            calls.push({ method: req.method ?? '', path, body, authorization: req.headers.authorization });
            const handler = handlers[`${req.method} ${path}`];
            const result = handler ? await handler(body, req) : { status: 404, body: { error: 'not found' } };
            res.writeHead(result.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result.body));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        }),
    };
}

/** A JWT-shaped token with `exp`; the agent never verifies signatures. */
export function makeJwt(expSecondsFromNow: number): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'acc_test', did: 'dev_test', typ: 'access', exp })}.sig`;
}
```

- [ ] **Step 3: Write the failing credentials test**

Replace `packages/happy-agent/src/credentials.test.ts` entirely:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from './config';
import {
    clearCredentials,
    clearCredentialsIfRefreshToken,
    credentialsLockFile,
    readCredentials,
    requireCredentials,
    writeCredentials,
} from './credentials';
import { deriveContentKeyPair, encodeBase64, getRandomBytes } from './encryption';

let homeDir: string;
let config: Config;

beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'happy-agent-creds-'));
    config = { serverUrl: 'https://api.example.test', homeDir, credentialPath: join(homeDir, 'nested', 'agent.key') };
});
afterEach(() => { rmSync(homeDir, { recursive: true, force: true }); });

describe('credentials', () => {
    it('round-trips token, refresh token and secret, and derives the content key pair', () => {
        const secret = getRandomBytes(32);
        writeCredentials(config, { token: 'access-1', refreshToken: 'refresh-1', secret });
        const read = readCredentials(config)!;
        expect(read.token).toBe('access-1');
        expect(read.refreshToken).toBe('refresh-1');
        expect(read.secret).toEqual(secret);
        expect(read.contentKeyPair).toEqual(deriveContentKeyPair(secret));
    });

    it('writes {token, refreshToken, secret} with mode 0600 and leaves no temp file', () => {
        const secret = getRandomBytes(32);
        writeCredentials(config, { token: 'access-1', refreshToken: 'refresh-1', secret });
        expect(statSync(config.credentialPath).mode & 0o777).toBe(0o600);
        expect(existsSync(`${config.credentialPath}.tmp`)).toBe(false);
        expect(JSON.parse(readFileSync(config.credentialPath, 'utf-8'))).toEqual({
            token: 'access-1',
            refreshToken: 'refresh-1',
            secret: encodeBase64(secret),
        });
    });

    it('treats pre-OIDC credentials without a refresh token as logged out', () => {
        writeCredentials(config, { token: 't', refreshToken: 'r', secret: getRandomBytes(32) });
        writeFileSync(config.credentialPath, JSON.stringify({ token: 'old', secret: encodeBase64(getRandomBytes(32)) }));
        expect(readCredentials(config)).toBeNull();
    });

    it('returns null for a missing file, invalid JSON or a wrong-length secret', () => {
        expect(readCredentials(config)).toBeNull();
        writeCredentials(config, { token: 't', refreshToken: 'r', secret: getRandomBytes(32) });
        writeFileSync(config.credentialPath, '{not json');
        expect(readCredentials(config)).toBeNull();
        writeFileSync(config.credentialPath, JSON.stringify({ token: 't', refreshToken: 'r', secret: encodeBase64(getRandomBytes(16)) }));
        expect(readCredentials(config)).toBeNull();
    });

    it('clears credentials only while they still hold the given refresh token', () => {
        writeCredentials(config, { token: 't', refreshToken: 'refresh-1', secret: getRandomBytes(32) });
        expect(clearCredentialsIfRefreshToken(config, 'other')).toBe(false);
        expect(readCredentials(config)).not.toBeNull();
        expect(clearCredentialsIfRefreshToken(config, 'refresh-1')).toBe(true);
        expect(existsSync(config.credentialPath)).toBe(false);
    });

    it('clearCredentials tolerates a missing file', () => {
        expect(() => clearCredentials(config)).not.toThrow();
    });

    it('requireCredentials points at auth login', () => {
        expect(() => requireCredentials(config)).toThrow('Not authenticated. Run `happy-agent auth login` first.');
    });

    it('locks next to the credentials file', () => {
        expect(credentialsLockFile(config)).toBe(`${config.credentialPath}.lock`);
    });
});
```

Run: `pnpm --filter happy-agent exec vitest run src/credentials.test.ts`
Expected: FAIL (`clearCredentialsIfRefreshToken` / `credentialsLockFile` not exported; `writeCredentials` signature mismatch).

- [ ] **Step 4: Rewrite `credentials.ts`**

```ts
// packages/happy-agent/src/credentials.ts
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deriveContentKeyPair, decodeBase64, encodeBase64 } from './encryption';
import type { Config } from './config';

/** What agent.key holds. `secret` is the account root secret delivered at login. */
export type StoredCredentials = {
    token: string;
    refreshToken: string;
    secret: Uint8Array;
};

export type Credentials = StoredCredentials & {
    contentKeyPair: {
        publicKey: Uint8Array;
        secretKey: Uint8Array;
    };
};

/** A stale lock (crashed holder) is reclaimed after 30 s; a live holder is awaited for up to ~20 s. */
export const CREDENTIALS_LOCK_OPTIONS = { staleAfterMs: 30_000, maxAttempts: 200 };

export function credentialsLockFile(config: Config): string {
    return `${config.credentialPath}.lock`;
}

export function ensureCredentialsDir(config: Config): void {
    mkdirSync(dirname(config.credentialPath), { recursive: true, mode: 0o700 });
}

/** Null when the file is missing, unreadable, or lacks a refresh token (pre-OIDC credentials count as logged out). */
export function readCredentials(config: Config): Credentials | null {
    try {
        const parsed = JSON.parse(readFileSync(config.credentialPath, 'utf-8')) as {
            token?: unknown;
            refreshToken?: unknown;
            secret?: unknown;
        };
        if (
            typeof parsed.token !== 'string' || parsed.token.length === 0
            || typeof parsed.refreshToken !== 'string' || parsed.refreshToken.length === 0
            || typeof parsed.secret !== 'string' || parsed.secret.length === 0
        ) {
            return null;
        }
        const secret = decodeBase64(parsed.secret);
        if (secret.length !== 32) {
            return null;
        }
        return {
            token: parsed.token,
            refreshToken: parsed.refreshToken,
            secret,
            contentKeyPair: deriveContentKeyPair(secret),
        };
    } catch {
        return null;
    }
}

/** Atomic write (temp file + rename, mode 0600). Callers hold credentialsLockFile(config). */
export function writeCredentials(config: Config, credentials: StoredCredentials): void {
    ensureCredentialsDir(config);
    const tmp = `${config.credentialPath}.tmp`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, JSON.stringify({
        token: credentials.token,
        refreshToken: credentials.refreshToken,
        secret: encodeBase64(credentials.secret),
    }), { mode: 0o600 });
    renameSync(tmp, config.credentialPath);
}

export function clearCredentials(config: Config): void {
    rmSync(config.credentialPath, { force: true });
}

/** Clears the credentials only if they still carry `refreshToken`, so a newer login is kept. */
export function clearCredentialsIfRefreshToken(config: Config, refreshToken: string): boolean {
    const current = readCredentials(config);
    if (!current || current.refreshToken !== refreshToken) {
        return false;
    }
    clearCredentials(config);
    return true;
}

export function requireCredentials(config: Config): Credentials {
    const creds = readCredentials(config);
    if (!creds) {
        throw new Error('Not authenticated. Run `happy-agent auth login` first.');
    }
    return creds;
}
```

Run: `pnpm --filter happy-agent exec vitest run src/credentials.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing loopback login test**

```ts
// packages/happy-agent/src/loopbackLogin.test.ts
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from './config';
import { readCredentials, type StoredCredentials } from './credentials';
import { decodeBase64, encodeBase64, libsodiumEncryptForPublicKey } from './encryption';
import { LoginError, loopbackLogin } from './loopbackLogin';
import { startFakeServer } from './testing/fakeServer';

const LOGIN_URL = /(https?:\/\/\S+\/v1\/auth\/oidc\/login\?\S+)/;
const rootSecret = new Uint8Array(randomBytes(32));

let homeDir: string;
let server: Awaited<ReturnType<typeof startFakeServer>> | null = null;

beforeEach(() => { homeDir = mkdtempSync(join(tmpdir(), 'happy-agent-login-')); });
afterEach(async () => {
    await server?.close();
    server = null;
    rmSync(homeDir, { recursive: true, force: true });
});

function configFor(serverUrl: string): Config {
    return { serverUrl, homeDir: join(homeDir, 'home'), credentialPath: join(homeDir, 'home', 'agent.key') };
}

async function startExchangeServer(status = 200) {
    server = await startFakeServer({
        'POST /v1/auth/oidc/exchange': (body) => status !== 200
            ? { status, body: { error: 'invalid_grant' } }
            : {
                status: 200,
                body: {
                    accountId: 'acc_1',
                    accessToken: 'access-token-1',
                    refreshToken: 'refresh-token-1',
                    keyBundle: encodeBase64(libsodiumEncryptForPublicKey(rootSecret, decodeBase64(body.ephemeralPublicKey))),
                },
            },
    });
    return server;
}

/** Runs loopbackLogin; `browser` receives the printed login URL and plays the browser's part. */
async function runLogin(config: Config, browser: (loginUrl: URL) => Promise<void>, timeoutMs?: number) {
    const lines: string[] = [];
    let browserRun: Promise<void> | null = null;
    let credentials: StoredCredentials | undefined;
    let error: Error | undefined;
    try {
        credentials = await loopbackLogin({
            config,
            deviceName: 'happy-agent@test-host',
            timeoutMs,
            io: {
                print: (line) => {
                    lines.push(line);
                    const match = LOGIN_URL.exec(line);
                    if (match && !browserRun) {
                        browserRun = browser(new URL(match[1]));
                    }
                },
            },
        });
    } catch (e) {
        error = e as Error;
    }
    await browserRun;
    return { credentials, error, output: lines.join('\n') };
}

describe('loopbackLogin', () => {
    it('prints the login URL, receives the code on 127.0.0.1 and stores the credentials', async () => {
        const fake = await startExchangeServer();
        let challenge = '';
        const result = await runLogin(configFor(fake.url), async (loginUrl) => {
            expect(`${loginUrl.origin}${loginUrl.pathname}`).toBe(`${fake.url}/v1/auth/oidc/login`);
            expect(loginUrl.searchParams.get('client')).toBe('loopback');
            challenge = loginUrl.searchParams.get('code_challenge')!;
            expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
            const redirectUri = loginUrl.searchParams.get('redirect_uri')!;
            expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
            const res = await fetch(`${redirectUri}?code=exchange-code-1`);
            expect(res.status).toBe(200);
            expect(await res.text()).toContain('You can close this tab');
        });
        if (result.error) throw result.error;

        const exchange = fake.calls.find((c) => c.path === '/v1/auth/oidc/exchange')!;
        expect(exchange.body.code).toBe('exchange-code-1');
        expect(exchange.body.deviceName).toBe('happy-agent@test-host');
        expect(createHash('sha256').update(exchange.body.codeVerifier).digest('base64url')).toBe(challenge);

        const stored = readCredentials(configFor(fake.url))!;
        expect(stored.token).toBe('access-token-1');
        expect(stored.refreshToken).toBe('refresh-token-1');
        expect(Buffer.from(stored.secret).equals(Buffer.from(rootSecret))).toBe(true);
        expect(statSync(join(homeDir, 'home', 'agent.key')).mode & 0o777).toBe(0o600);
        expect(existsSync(join(homeDir, 'home', 'agent.key.lock'))).toBe(false);
        expect(result.output).not.toContain('access-token-1');
        expect(result.output).not.toContain('refresh-token-1');
    });

    it('answers other paths with 404 and keeps waiting', async () => {
        const fake = await startExchangeServer();
        const result = await runLogin(configFor(fake.url), async (loginUrl) => {
            const redirect = new URL(loginUrl.searchParams.get('redirect_uri')!);
            expect((await fetch(`${redirect.origin}/favicon.ico`)).status).toBe(404);
            expect((await fetch(`${redirect.origin}/other?code=x`)).status).toBe(404);
            await fetch(`${redirect.href}?code=exchange-code-2`);
        });
        if (result.error) throw result.error;
        expect(fake.calls.find((c) => c.path === '/v1/auth/oidc/exchange')?.body.code).toBe('exchange-code-2');
    });

    it('fails when the browser returns an error', async () => {
        const fake = await startExchangeServer();
        const result = await runLogin(configFor(fake.url), async (loginUrl) => {
            const res = await fetch(`${loginUrl.searchParams.get('redirect_uri')}?error=access_denied`);
            expect(res.status).toBe(400);
        });
        expect(result.error).toBeInstanceOf(LoginError);
        expect(result.error?.message).toContain('cancelled or denied');
        expect(fake.calls).toEqual([]);
        expect(existsSync(join(homeDir, 'home', 'agent.key'))).toBe(false);
    });

    it('fails when the callback carries no code', async () => {
        const fake = await startExchangeServer();
        const result = await runLogin(configFor(fake.url), async (loginUrl) => {
            const res = await fetch(loginUrl.searchParams.get('redirect_uri')!);
            expect(res.status).toBe(400);
        });
        expect(result.error).toBeInstanceOf(LoginError);
        expect(result.error?.message).toContain('did not include a code');
        expect(fake.calls).toEqual([]);
    });

    it('times out and closes the listener', async () => {
        const fake = await startExchangeServer();
        let redirectUri = '';
        const result = await runLogin(configFor(fake.url), async (loginUrl) => {
            redirectUri = loginUrl.searchParams.get('redirect_uri')!;
        }, 50);
        expect(result.error).toBeInstanceOf(LoginError);
        expect(result.error?.message).toContain('timed out');
        await expect(fetch(`${redirectUri}?code=late`)).rejects.toThrow();
    });

    it('reports a rejected exchange without writing credentials', async () => {
        const fake = await startExchangeServer(400);
        const result = await runLogin(configFor(fake.url), async (loginUrl) => {
            await fetch(`${loginUrl.searchParams.get('redirect_uri')}?code=stale`);
        });
        expect(result.error).toBeInstanceOf(LoginError);
        expect(result.error?.message).toContain('400 invalid_grant');
        expect(existsSync(join(homeDir, 'home', 'agent.key'))).toBe(false);
    });
});
```

Run: `pnpm --filter happy-agent exec vitest run src/loopbackLogin.test.ts`
Expected: FAIL (cannot resolve `./loopbackLogin`).

- [ ] **Step 6: Implement `loopbackLogin.ts`**

```ts
// packages/happy-agent/src/loopbackLogin.ts
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import type { Config } from './config';
import {
    CREDENTIALS_LOCK_OPTIONS,
    credentialsLockFile,
    ensureCredentialsDir,
    writeCredentials,
    type StoredCredentials,
} from './credentials';
import { decodeBase64, decryptBoxBundle, encodeBase64 } from './encryption';
import { withFileLock } from './fileLock';

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 15_000;

export class LoginError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LoginError';
    }
}

export interface LoopbackLoginIO {
    print(line: string): void;
}

type CallbackResult = { code: string } | { error: string };

type ExchangeResponse = {
    accountId: string;
    accessToken: string;
    refreshToken: string;
    keyBundle: string;
};

function page(title: string, message: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
        + `<body style="font-family: system-ui, sans-serif; margin: 3rem;"><h1>${title}</h1><p>${message}</p></body></html>`;
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
    res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', connection: 'close' });
    res.end(body);
}

/** One-shot listener on http://127.0.0.1:<random port>/callback (RFC 8252 loopback redirect). */
async function startCallbackListener(): Promise<{ redirectUri: string; result: Promise<CallbackResult>; close(): void }> {
    let settle!: (result: CallbackResult) => void;
    const result = new Promise<CallbackResult>((resolve) => { settle = resolve; });
    let handled = false;
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method !== 'GET' || url.pathname !== '/callback') {
            send(res, 404, 'text/plain; charset=utf-8', 'Not found');
            return;
        }
        if (handled) {
            send(res, 400, 'text/html; charset=utf-8', page('Already handled', 'This sign-in was already handled. You can close this tab.'));
            return;
        }
        handled = true;
        const code = url.searchParams.get('code');
        if (url.searchParams.has('error') || !code) {
            send(res, 400, 'text/html; charset=utf-8', page('Sign-in failed', 'Return to your terminal and run happy-agent auth login again.'));
            settle({
                error: url.searchParams.has('error')
                    ? 'Sign-in was cancelled or denied in the browser.'
                    : 'The sign-in callback did not include a code.',
            });
            return;
        }
        send(res, 200, 'text/html; charset=utf-8', page('Signed in', 'You can close this tab and return to your terminal.'));
        settle({ code });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    return {
        redirectUri: `http://127.0.0.1:${port}/callback`,
        result,
        close: () => {
            server.close();
            server.closeIdleConnections();
        },
    };
}

export async function loopbackLogin(opts: {
    config: Config;
    deviceName: string;
    io: LoopbackLoginIO;
    timeoutMs?: number;
}): Promise<StoredCredentials> {
    const { config, io } = opts;
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const ephemeral = tweetnacl.box.keyPair();

    const listener = await startCallbackListener();
    let timer: NodeJS.Timeout | undefined;
    let callback: CallbackResult;
    try {
        const params = new URLSearchParams({ client: 'loopback', code_challenge: codeChallenge, redirect_uri: listener.redirectUri });
        io.print('');
        io.print('To sign in, open this URL in a browser on this machine:');
        io.print('');
        io.print(`  ${config.serverUrl}/v1/auth/oidc/login?${params.toString()}`);
        io.print('');
        io.print('Waiting for the browser to finish signing in...');
        const timeout = new Promise<CallbackResult>((resolve) => {
            timer = setTimeout(
                () => resolve({ error: 'Sign-in timed out. Run `happy-agent auth login` again.' }),
                opts.timeoutMs ?? LOGIN_TIMEOUT_MS,
            );
        });
        callback = await Promise.race([listener.result, timeout]);
    } finally {
        clearTimeout(timer);
        listener.close();
    }
    if ('error' in callback) {
        throw new LoginError(callback.error);
    }

    let tokens: ExchangeResponse;
    try {
        const response = await axios.post(`${config.serverUrl}/v1/auth/oidc/exchange`, {
            code: callback.code,
            codeVerifier,
            ephemeralPublicKey: encodeBase64(ephemeral.publicKey),
            deviceName: opts.deviceName.slice(0, 100),
        }, {
            timeout: EXCHANGE_TIMEOUT_MS,
            signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
            headers: { 'X-Happy-Client': 'cli-control-plane/0.1.0' },
        });
        tokens = response.data as ExchangeResponse;
    } catch (error) {
        // Only status and the server's error code; never the request config (it holds the code verifier).
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        const serverError = axios.isAxiosError(error) ? (error.response?.data as { error?: unknown } | undefined)?.error : undefined;
        const detail = `${status ?? 'no response'}${typeof serverError === 'string' ? ` ${serverError}` : ''}`;
        throw new LoginError(`Sign-in failed: the server rejected the code exchange (${detail}).`);
    }

    const secret = decryptBoxBundle(decodeBase64(tokens.keyBundle), ephemeral.secretKey);
    if (!secret || secret.length !== 32) {
        throw new LoginError('Received an invalid key bundle from the server.');
    }
    const credentials: StoredCredentials = { token: tokens.accessToken, refreshToken: tokens.refreshToken, secret };
    ensureCredentialsDir(config);
    await withFileLock(credentialsLockFile(config), async () => writeCredentials(config, credentials), CREDENTIALS_LOCK_OPTIONS);
    return credentials;
}
```

Run: `pnpm --filter happy-agent exec vitest run src/loopbackLogin.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Write the failing auth command tests**

Replace `packages/happy-agent/src/auth.test.ts` entirely:

```ts
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config';
import { writeCredentials } from './credentials';
import { encodeBase64, getRandomBytes } from './encryption';
import { makeJwt, startFakeServer } from './testing/fakeServer';

vi.mock('./loopbackLogin', () => ({
    loopbackLogin: vi.fn(async () => ({ token: 'access-token', refreshToken: 'refresh-token', secret: new Uint8Array(32) })),
}));

import { loopbackLogin } from './loopbackLogin';
import { authLogin, authLogout, authStatus } from './auth';

let homeDir: string;
let server: Awaited<ReturnType<typeof startFakeServer>> | null = null;
let logs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'happy-agent-auth-'));
    logs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
});
afterEach(async () => {
    logSpy.mockRestore();
    vi.mocked(loopbackLogin).mockClear();
    await server?.close();
    server = null;
    rmSync(homeDir, { recursive: true, force: true });
});

function configFor(serverUrl = 'http://127.0.0.1:9'): Config {
    return { serverUrl, homeDir, credentialPath: join(homeDir, 'agent.key') };
}

describe('authLogin', () => {
    it('signs in as happy-agent@<host> and reports success without printing tokens', async () => {
        const config = configFor();
        await authLogin(config);
        const call = vi.mocked(loopbackLogin).mock.calls[0][0];
        expect(call.config).toBe(config);
        expect(call.deviceName).toMatch(/^happy-agent@.+/);
        expect(logs).toContain('- Status: Authenticated');
        expect(logs.join('\n')).not.toContain('access-token');
    });
});

describe('authLogout', () => {
    it('revokes the device on the server, then deletes the credentials', async () => {
        server = await startFakeServer({ 'POST /v1/auth/logout': () => ({ status: 200, body: { success: true } }) });
        const config = configFor(server.url);
        const token = makeJwt(900);
        writeCredentials(config, { token, refreshToken: 'refresh-1', secret: getRandomBytes(32) });
        await authLogout(config);
        expect(server.calls.map((c) => [c.path, c.authorization])).toEqual([['/v1/auth/logout', `Bearer ${token}`]]);
        expect(existsSync(config.credentialPath)).toBe(false);
        expect(existsSync(`${config.credentialPath}.lock`)).toBe(false);
        expect(logs).toContain('- Status: Logged out');
        expect(logs).toContain('- Server session: Revoked');
        expect(logs).toContain('- Credentials: Cleared');
    });

    it('still deletes the credentials when the server is unreachable', async () => {
        const config = configFor('http://127.0.0.1:9');
        writeCredentials(config, { token: makeJwt(900), refreshToken: 'refresh-1', secret: getRandomBytes(32) });
        await authLogout(config);
        expect(existsSync(config.credentialPath)).toBe(false);
        expect(logs).toContain('- Server session: Not revoked (server unreachable or session already ended)');
    });

    it('deletes pre-OIDC credentials without contacting the server', async () => {
        server = await startFakeServer({});
        const config = configFor(server.url);
        writeFileSync(config.credentialPath, JSON.stringify({ token: 'old', secret: encodeBase64(getRandomBytes(32)) }));
        await authLogout(config);
        expect(server.calls).toEqual([]);
        expect(existsSync(config.credentialPath)).toBe(false);
    });

    it('succeeds without credentials or a home directory', async () => {
        const config = { serverUrl: 'http://127.0.0.1:9', homeDir: join(homeDir, 'missing'), credentialPath: join(homeDir, 'missing', 'agent.key') };
        await expect(authLogout(config)).resolves.toBeUndefined();
        expect(logs).toContain('- Status: Logged out');
    });
});

describe('authStatus', () => {
    it('shows the signed-in state, server and public key without printing tokens', async () => {
        const config = configFor('https://happy.example.test');
        writeCredentials(config, { token: 'access-secret-value', refreshToken: 'refresh-secret-value', secret: getRandomBytes(32) });
        await authStatus(config);
        expect(logs).toContain('## Authentication');
        expect(logs).toContain('- Status: Authenticated');
        expect(logs).toContain('- Server: https://happy.example.test');
        expect(logs.some((l) => l.startsWith('- Public Key: `'))).toBe(true);
        const output = logs.join('\n');
        expect(output).not.toContain('access-secret-value');
        expect(output).not.toContain('refresh-secret-value');
    });

    it('treats pre-OIDC credentials as not authenticated', async () => {
        const config = configFor();
        writeFileSync(config.credentialPath, JSON.stringify({ token: 't', secret: encodeBase64(getRandomBytes(32)) }));
        await authStatus(config);
        expect(logs).toContain('- Status: Not authenticated');
        expect(logs).toContain('- Action: Run `happy-agent auth login` to authenticate.');
    });
});
```

Run: `pnpm --filter happy-agent exec vitest run src/auth.test.ts`
Expected: FAIL. The old `auth.ts` imports `qrcode-terminal` and calls `writeCredentials(config, token, secret)`, and the assertions do not match.

- [ ] **Step 8: Rewrite `auth.ts`**

```ts
// packages/happy-agent/src/auth.ts
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import axios from 'axios';
import type { Config } from './config';
import {
    CREDENTIALS_LOCK_OPTIONS,
    clearCredentials,
    credentialsLockFile,
    readCredentials,
    type Credentials,
} from './credentials';
import { encodeBase64 } from './encryption';
import { withFileLock } from './fileLock';
import { loopbackLogin } from './loopbackLogin';

const LOGOUT_TIMEOUT_MS = 5_000;

export async function authLogin(config: Config): Promise<void> {
    await loopbackLogin({
        config,
        deviceName: `happy-agent@${hostname()}`,
        io: { print: (line) => console.log(line) },
    });
    console.log('');
    console.log('## Authentication');
    console.log('- Status: Authenticated');
}

/** Best effort: the local logout proceeds whatever happens here. */
async function revokeOnServer(config: Config, creds: Credentials): Promise<boolean> {
    try {
        await axios.post(`${config.serverUrl}/v1/auth/logout`, {}, {
            headers: { Authorization: `Bearer ${creds.token}`, 'X-Happy-Client': 'cli-control-plane/0.1.0' },
            timeout: LOGOUT_TIMEOUT_MS,
            signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
        });
        return true;
    } catch {
        return false;
    }
}

export async function authLogout(config: Config): Promise<void> {
    const creds = readCredentials(config);
    const revoked = creds ? await revokeOnServer(config, creds) : null;
    if (existsSync(config.credentialPath)) {
        await withFileLock(credentialsLockFile(config), async () => clearCredentials(config), CREDENTIALS_LOCK_OPTIONS);
    }
    console.log('## Authentication');
    console.log('- Status: Logged out');
    if (revoked !== null) {
        console.log(revoked
            ? '- Server session: Revoked'
            : '- Server session: Not revoked (server unreachable or session already ended)');
    }
    console.log('- Credentials: Cleared');
}

export async function authStatus(config: Config): Promise<void> {
    const creds = readCredentials(config);
    console.log('## Authentication');
    if (creds) {
        console.log('- Status: Authenticated');
        console.log(`- Server: ${config.serverUrl}`);
        console.log(`- Public Key: \`${encodeBase64(creds.contentKeyPair.publicKey)}\``);
    } else {
        console.log('- Status: Not authenticated');
        console.log('- Action: Run `happy-agent auth login` to authenticate.');
    }
}
```

Run: `pnpm --filter happy-agent exec vitest run src/auth.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 9: Wire the commands and fix fixtures**

In `packages/happy-agent/src/index.ts`, replace the `login` and `logout` sub-commands of `auth`:

```ts
    .addCommand(
        new Command('login')
            .description('Sign in through your browser (prints a URL to open)')
            .option('--no-browser', 'Only print the sign-in URL (happy-agent never opens a browser itself)')
            .action(async () => {
                const config = loadConfig();
                await authLogin(config);
            })
    )
    .addCommand(
        new Command('logout').description('Revoke this device and clear stored credentials').action(async () => {
            const config = loadConfig();
            await authLogout(config);
        })
    )
```

In `packages/happy-agent/src/cli-smoke.test.ts`:
- Replace `expect(stdout).toContain('Authenticate via QR code');` with these two lines:

```ts
            expect(stdout).toContain('Sign in through your browser');
            expect(stdout).toContain('--no-browser');
```

- In `makeCredentials()`, change `return { token: 'test-jwt-token', secret, contentKeyPair };` to `return { token: 'test-jwt-token', refreshToken: 'test-refresh-token', secret, contentKeyPair };`.

In `packages/happy-agent/src/api.test.ts` `makeCredentials()`, make the same change: `return { token: 'test-jwt-token', refreshToken: 'test-refresh-token', secret, contentKeyPair };`.

- [ ] **Step 10: Drop `qrcode-terminal` and refresh the lockfile**

Run: `grep -rn "qrcode" packages/happy-agent/src`
Expected: no output.

In `packages/happy-agent/package.json`, delete the `"qrcode-terminal": "^0.12.0",` line from `dependencies` and the `"@types/qrcode-terminal": "^0.12.2",` line from `devDependencies`.

Run:

```bash
pnpm --version            # must print 10.11.0
pnpm install
git diff -U0 pnpm-lock.yaml | grep '^[-+][^-+]'
```

Expected: only `-` lines, which remove `qrcode-terminal` and `'@types/qrcode-terminal'` (specifier/version) under `packages/happy-agent:`. Package entries stay because happy-cli still uses them. If anything else changes, run `rm -rf node_modules packages/*/node_modules && pnpm install` (stale `node_modules` have caused churn before) and diff again. If unrelated churn persists, stop and report.

- [ ] **Step 11: Update the README**

In `packages/happy-agent/README.md`, replace the `## Authentication` section (heading through the "Credentials are stored at" line) with:

````markdown
## Authentication

Happy Agent signs in with your organization's identity provider through the Happy server (OIDC, loopback redirect). It receives the account key, so it can read sessions created on any of your machines.

```bash
# Prints a sign-in URL; open it in a browser on this machine. Waits up to 5 minutes.
happy-agent auth login

# Check authentication status (never prints tokens)
happy-agent auth status

# Revoke this device on the server and clear stored credentials
happy-agent auth logout
```

Credentials are stored at `~/.happy/agent.key` (mode 0600). Access tokens refresh automatically; if the device is revoked or the session reaches its maximum age, run `happy-agent auth login` again.
````

In the requirements list near the end, replace `- A Happy mobile app account for authentication` with `- An account at your organization's identity provider`.

- [ ] **Step 12: Typecheck, full suite, commit**

Run: `pnpm --filter happy-agent typecheck && pnpm --filter happy-agent test`
Expected: no type errors and all tests pass, including `cli-smoke.test.ts` and `index.test.ts` against the rebuilt `dist/`.

```bash
git add packages/happy-agent/src/fileLock.ts packages/happy-agent/src/fileLock.test.ts packages/happy-agent/src/testing/fakeServer.ts \
  packages/happy-agent/src/credentials.ts packages/happy-agent/src/credentials.test.ts \
  packages/happy-agent/src/loopbackLogin.ts packages/happy-agent/src/loopbackLogin.test.ts \
  packages/happy-agent/src/auth.ts packages/happy-agent/src/auth.test.ts packages/happy-agent/src/index.ts \
  packages/happy-agent/src/api.test.ts packages/happy-agent/src/cli-smoke.test.ts \
  packages/happy-agent/package.json packages/happy-agent/README.md pnpm-lock.yaml
git commit -m "feat: sign in to happy-agent with loopback OIDC"
```

---

### Task 3: happy-agent token store, 401 retry and socket auth

**Files:**
- Create: `packages/happy-agent/src/jwt.ts`, `packages/happy-agent/src/jwt.test.ts`
- Create: `packages/happy-agent/src/tokenStore.ts`, `packages/happy-agent/src/tokenStore.test.ts`
- Modify: `packages/happy-agent/src/api.ts`, `packages/happy-agent/src/api.test.ts`
- Modify: `packages/happy-agent/src/session.ts`, `packages/happy-agent/src/session.test.ts`
- Modify: `packages/happy-agent/src/machineRpc.ts`
- Modify: `packages/happy-agent/src/index.ts`
- Modify: `packages/happy-agent/src/auth.ts`, `packages/happy-agent/src/auth.test.ts`

**Interfaces:**
- Consumes (Task 2): `readCredentials`, `writeCredentials`, `clearCredentialsIfRefreshToken`, `credentialsLockFile`, `CREDENTIALS_LOCK_OPTIONS`, `StoredCredentials`, `Credentials`, `withFileLock`, `startFakeServer`, `makeJwt`.
- Produces:
  ```ts
  // jwt.ts
  function decodeJwtExpiry(token: string): number | null      // exp * 1000, or null
  // tokenStore.ts
  class LoggedOutError extends Error {}                         // message: 'Logged out. Run `happy-agent auth login` to sign in again.'
  interface TokenSource { getAccessToken(): Promise<string>; refresh(rejectedToken: string): Promise<string> }
  class TokenStore implements TokenSource { constructor(config: Config, credentials: { token: string; secret: Uint8Array }) }
  function withAuthRetry<T>(tokens: TokenSource, serverUrl: string, url: string, send: (token: string) => Promise<T>): Promise<T>
  type SocketAuthCallback = (cb: (data: object) => void) => void
  function socketAuth(tokens: Pick<TokenSource, 'getAccessToken'>, extra: Record<string, unknown>, onLoggedOut?: (error: LoggedOutError) => void): SocketAuthCallback
  // api.ts: every exported request function takes `tokens: TokenSource` right after `creds`
  listSessions(config, creds, tokens); listMachines(config, creds, tokens); listActiveSessions(config, creds, tokens)
  createSession(config, creds, tokens, opts); deleteSession(config, creds, tokens, sessionId)
  getSessionMessages(config, creds, tokens, sessionId, encryption)
  // session.ts: SessionClientOptions.token: string  →  tokens: Pick<TokenSource, 'getAccessToken'>
  // machineRpc.ts: spawnSessionOnMachine(config, machine, tokens: TokenSource, options)
  //                resumeSessionOnMachine(config, machine, tokens: TokenSource, sessionId)
  ```

- [ ] **Step 1: Copy `jwt.ts` and test it**

```bash
cp packages/happy-cli/src/api/jwt.ts packages/happy-agent/src/jwt.ts
```

```ts
// packages/happy-agent/src/jwt.test.ts
import { describe, expect, it } from 'vitest';
import { decodeJwtExpiry } from './jwt';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('decodeJwtExpiry', () => {
    it('returns exp in milliseconds', () => {
        expect(decodeJwtExpiry(`${b64({ alg: 'HS256' })}.${b64({ exp: 1_800_000_000 })}.sig`)).toBe(1_800_000_000_000);
    });
    it('returns null for non-JWTs and a missing exp', () => {
        expect(decodeJwtExpiry('fake-token')).toBeNull();
        expect(decodeJwtExpiry(`${b64({})}.${b64({ sub: 'x' })}.sig`)).toBeNull();
        expect(decodeJwtExpiry('a.%%%.c')).toBeNull();
    });
});
```

Run: `pnpm --filter happy-agent exec vitest run src/jwt.test.ts`
Expected: PASS.

- [ ] **Step 2: Write the failing token store test**

```ts
// packages/happy-agent/src/tokenStore.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AxiosError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config';
import { readCredentials, writeCredentials, type StoredCredentials } from './credentials';
import { getRandomBytes } from './encryption';
import { makeJwt, startFakeServer } from './testing/fakeServer';
import { LoggedOutError, TokenStore, socketAuth, withAuthRetry } from './tokenStore';

const secret = getRandomBytes(32);
let homeDir: string;
let server: Awaited<ReturnType<typeof startFakeServer>> | null = null;

beforeEach(() => { homeDir = mkdtempSync(join(tmpdir(), 'happy-agent-tokens-')); });
afterEach(async () => {
    await server?.close();
    server = null;
    rmSync(homeDir, { recursive: true, force: true });
});

function configFor(serverUrl: string): Config {
    return { serverUrl, homeDir, credentialPath: join(homeDir, 'agent.key') };
}

function seed(config: Config, token: string, refreshToken = 'rt-1', seedSecret = secret): StoredCredentials {
    const creds = { token, refreshToken, secret: seedSecret };
    writeCredentials(config, creds);
    return creds;
}

describe('TokenStore', () => {
    it('returns a fresh token without calling the server', async () => {
        server = await startFakeServer({});
        const config = configFor(server.url);
        const token = makeJwt(900);
        const store = new TokenStore(config, seed(config, token));
        expect(await store.getAccessToken()).toBe(token);
        expect(server.calls).toEqual([]);
    });

    it('refreshes a token that expires within two minutes and persists the rotation', async () => {
        const next = makeJwt(900);
        server = await startFakeServer({
            'POST /v1/auth/refresh': (body) => body.refreshToken === 'rt-1'
                ? { status: 200, body: { accessToken: next, refreshToken: 'rt-2' } }
                : { status: 401, body: { error: 'invalid_grant', reason: 'invalid' } },
        });
        const config = configFor(server.url);
        const store = new TokenStore(config, seed(config, makeJwt(90)));
        expect(await store.getAccessToken()).toBe(next);
        const stored = readCredentials(config)!;
        expect(stored.token).toBe(next);
        expect(stored.refreshToken).toBe('rt-2');
        expect(Buffer.from(stored.secret).equals(Buffer.from(secret))).toBe(true);
    });

    it('adopts a token another process already rotated instead of refreshing', async () => {
        server = await startFakeServer({});
        const config = configFor(server.url);
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));
        const rotated = makeJwt(900);
        seed(config, rotated, 'rt-2');
        expect(await store.refresh(stale)).toBe(rotated);
        expect(server.calls).toEqual([]);
    });

    it('never adopts or refreshes credentials that belong to another account', async () => {
        server = await startFakeServer({});
        const config = configFor(server.url);
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));
        seed(config, makeJwt(30), 'rt-other', getRandomBytes(32));
        await expect(store.refresh(stale)).rejects.toThrow('different account');
        expect(server.calls).toEqual([]);
        expect(readCredentials(config)?.refreshToken).toBe('rt-other');
    });

    it('single-flights concurrent refreshes', async () => {
        let calls = 0;
        server = await startFakeServer({
            'POST /v1/auth/refresh': async () => {
                calls++;
                await new Promise((r) => setTimeout(r, 50));
                return { status: 200, body: { accessToken: makeJwt(900), refreshToken: `rt-${calls + 1}` } };
            },
        });
        const config = configFor(server.url);
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));
        const results = await Promise.all([store.refresh(stale), store.refresh(stale), store.getAccessToken()]);
        expect(new Set(results).size).toBe(1);
        expect(calls).toBe(1);
    });

    it('clears the credentials and reports logged out on invalid_grant', async () => {
        server = await startFakeServer({
            'POST /v1/auth/refresh': () => ({ status: 401, body: { error: 'invalid_grant', reason: 'revoked' } }),
        });
        const config = configFor(server.url);
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));
        await expect(store.refresh(stale)).rejects.toBeInstanceOf(LoggedOutError);
        expect(readCredentials(config)).toBeNull();
        await expect(store.getAccessToken()).rejects.toBeInstanceOf(LoggedOutError);
    });

    it('keeps a newer login when invalid_grant arrives for the old refresh token', async () => {
        let config!: Config;
        server = await startFakeServer({
            'POST /v1/auth/refresh': () => {
                seed(config, makeJwt(900), 'rt-new-login');
                return { status: 401, body: { error: 'invalid_grant', reason: 'revoked' } };
            },
        });
        config = configFor(server.url);
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));
        await expect(store.refresh(stale)).rejects.toBeInstanceOf(LoggedOutError);
        expect(readCredentials(config)?.refreshToken).toBe('rt-new-login');
    });

    it('keeps credentials on network errors and never puts tokens in the error', async () => {
        const config = configFor('http://127.0.0.1:9');
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));
        const error = await store.refresh(stale).catch((e: Error) => e);
        expect(error).not.toBeInstanceOf(LoggedOutError);
        expect(error.message).toMatch(/^Token refresh failed: /);
        expect(error.message).not.toContain('rt-1');
        expect(error.message).not.toContain(stale);
        expect(readCredentials(config)?.token).toBe(stale);
    });
});

describe('withAuthRetry', () => {
    const failure = (status: number) => new AxiosError('Request failed', String(status), undefined, undefined, { status } as never);
    const tokensFor = () => ({ getAccessToken: vi.fn(async () => 'old'), refresh: vi.fn(async () => 'new') });

    it('retries once with a refreshed token after a 401 from the configured server', async () => {
        const tokens = tokensFor();
        const send = vi.fn().mockRejectedValueOnce(failure(401)).mockResolvedValueOnce('ok');
        await expect(withAuthRetry(tokens, 'https://api.test', 'https://api.test/v1/sessions', send)).resolves.toBe('ok');
        expect(tokens.refresh).toHaveBeenCalledWith('old');
        expect(send.mock.calls).toEqual([['old'], ['new']]);
    });

    it('gives up after the second 401', async () => {
        const tokens = tokensFor();
        const send = vi.fn().mockRejectedValue(failure(401));
        await expect(withAuthRetry(tokens, 'https://api.test', 'https://api.test/v1/sessions', send)).rejects.toBeInstanceOf(AxiosError);
        expect(send).toHaveBeenCalledTimes(2);
        expect(tokens.refresh).toHaveBeenCalledTimes(1);
    });

    it('does not retry requests to another origin', async () => {
        const tokens = tokensFor();
        const send = vi.fn().mockRejectedValue(failure(401));
        await expect(withAuthRetry(tokens, 'https://api.test', 'https://api.test:4443/v1/sessions', send)).rejects.toBeInstanceOf(AxiosError);
        expect(tokens.refresh).not.toHaveBeenCalled();
    });

    it('does not retry other failures', async () => {
        const tokens = tokensFor();
        const send = vi.fn().mockRejectedValue(failure(500));
        await expect(withAuthRetry(tokens, 'https://api.test', 'https://api.test/v1/sessions', send)).rejects.toBeInstanceOf(AxiosError);
        expect(tokens.refresh).not.toHaveBeenCalled();
    });
});

describe('socketAuth', () => {
    it('awaits a fresh token on every handshake', async () => {
        const tokens = { getAccessToken: vi.fn().mockResolvedValueOnce('t1').mockResolvedValueOnce('t2') };
        const auth = socketAuth(tokens, { clientType: 'session-scoped', sessionId: 's1' });
        const first = await new Promise((resolve) => auth(resolve));
        const second = await new Promise((resolve) => auth(resolve));
        expect(first).toEqual({ clientType: 'session-scoped', sessionId: 's1', token: 't1' });
        expect(second).toEqual({ clientType: 'session-scoped', sessionId: 's1', token: 't2' });
    });

    it('hands logged-out errors to onLoggedOut instead of completing the handshake', async () => {
        const onLoggedOut = vi.fn();
        const cb = vi.fn();
        socketAuth({ getAccessToken: () => Promise.reject(new LoggedOutError()) }, {}, onLoggedOut)(cb);
        await new Promise((r) => setTimeout(r, 0));
        expect(onLoggedOut).toHaveBeenCalledWith(expect.any(LoggedOutError));
        expect(cb).not.toHaveBeenCalled();
    });

    it('sends an empty token on other failures so the server rejects the handshake', async () => {
        const payload = await new Promise((resolve) => {
            socketAuth({ getAccessToken: () => Promise.reject(new Error('network')) }, { clientType: 'x' })(resolve);
        });
        expect(payload).toEqual({ clientType: 'x', token: '' });
    });
});
```

Run: `pnpm --filter happy-agent exec vitest run src/tokenStore.test.ts`
Expected: FAIL (cannot resolve `./tokenStore`).

- [ ] **Step 3: Implement `tokenStore.ts`**

```ts
// packages/happy-agent/src/tokenStore.ts
import axios, { AxiosError } from 'axios';
import type { Config } from './config';
import {
    CREDENTIALS_LOCK_OPTIONS,
    clearCredentialsIfRefreshToken,
    credentialsLockFile,
    readCredentials,
    writeCredentials,
    type StoredCredentials,
} from './credentials';
import { withFileLock } from './fileLock';
import { decodeJwtExpiry } from './jwt';

const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 10_000;

export class LoggedOutError extends Error {
    constructor() {
        super('Logged out. Run `happy-agent auth login` to sign in again.');
        this.name = 'LoggedOutError';
    }
}

export interface TokenSource {
    getAccessToken(): Promise<string>;
    refresh(rejectedToken: string): Promise<string>;
}

function isFresh(token: string): boolean {
    const exp = decodeJwtExpiry(token);
    return exp !== null && exp - Date.now() > REFRESH_MARGIN_MS;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return Buffer.from(a).equals(Buffer.from(b));
}

/**
 * Access token for one happy-agent process. Refreshes on demand (2 minutes before
 * expiry, or after a 401), single-flight within the process and under the credentials
 * file lock across processes; adopts a token another process already rotated.
 */
export class TokenStore implements TokenSource {
    private token: string | null;
    private readonly secret: Uint8Array;
    private inflight: Promise<string> | null = null;

    constructor(private readonly config: Config, credentials: { token: string; secret: Uint8Array }) {
        this.token = credentials.token;
        this.secret = credentials.secret;
    }

    async getAccessToken(): Promise<string> {
        if (this.token === null) {
            throw new LoggedOutError();
        }
        const token = this.token;
        return isFresh(token) ? token : this.refresh(token);
    }

    refresh(rejectedToken: string): Promise<string> {
        if (!this.inflight) {
            this.inflight = this.adoptOrRefresh(rejectedToken)
                .then((token) => {
                    this.token = token;
                    return token;
                })
                .catch((error) => {
                    if (error instanceof LoggedOutError) {
                        this.token = null;
                    }
                    throw error;
                })
                .finally(() => {
                    this.inflight = null;
                });
        }
        return this.inflight;
    }

    private adoptOrRefresh(rejectedToken: string): Promise<string> {
        return withFileLock(credentialsLockFile(this.config), async () => {
            const credentials = readCredentials(this.config);
            if (!credentials) {
                throw new LoggedOutError();
            }
            if (!sameBytes(credentials.secret, this.secret)) {
                // Someone signed in as a different account meanwhile; keep their login untouched.
                throw new Error('Stored credentials now belong to a different account. Re-run the command.');
            }
            if (credentials.token !== rejectedToken && isFresh(credentials.token)) {
                return credentials.token;
            }
            let data: { accessToken: string; refreshToken: string };
            try {
                const response = await axios.post(
                    `${this.config.serverUrl}/v1/auth/refresh`,
                    { refreshToken: credentials.refreshToken },
                    {
                        // `timeout` only bounds inactivity after connect; the abort signal is a hard
                        // wall-clock deadline (DNS + connect + response) so the lock is never held long.
                        timeout: REFRESH_TIMEOUT_MS,
                        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
                        headers: { 'X-Happy-Client': 'cli-control-plane/0.1.0' },
                    },
                );
                data = response.data as { accessToken: string; refreshToken: string };
            } catch (error) {
                if (
                    error instanceof AxiosError
                    && error.response?.status === 401
                    && (error.response.data as { error?: unknown } | undefined)?.error === 'invalid_grant'
                ) {
                    clearCredentialsIfRefreshToken(this.config, credentials.refreshToken);
                    throw new LoggedOutError();
                }
                // Status or error code only: the axios error carries the request body (refresh token).
                const status = error instanceof AxiosError ? error.response?.status : undefined;
                const code = error instanceof AxiosError ? error.code : undefined;
                throw new Error(`Token refresh failed: ${status ?? code ?? 'unknown'}`);
            }
            const rotated: StoredCredentials = { token: data.accessToken, refreshToken: data.refreshToken, secret: credentials.secret };
            writeCredentials(this.config, rotated);
            return rotated.token;
        }, CREDENTIALS_LOCK_OPTIONS);
    }
}

function sameOrigin(url: string, serverUrl: string): boolean {
    try {
        return new URL(url).origin === new URL(serverUrl).origin;
    } catch {
        return false;
    }
}

/** Sends with the current token; on a 401 from the configured server, refreshes and retries once. */
export async function withAuthRetry<T>(
    tokens: TokenSource,
    serverUrl: string,
    url: string,
    send: (token: string) => Promise<T>,
): Promise<T> {
    const token = await tokens.getAccessToken();
    try {
        return await send(token);
    } catch (error) {
        if (!(error instanceof AxiosError) || error.response?.status !== 401 || !sameOrigin(url, serverUrl)) {
            throw error;
        }
        const fresh = await tokens.refresh(token);
        return send(fresh);
    }
}

export type SocketAuthCallback = (cb: (data: object) => void) => void;

/**
 * socket.io `auth` callback: awaits a fresh token at every (re)connect. A logged-out
 * store goes to `onLoggedOut` (nothing will fix it, so the caller stops reconnecting);
 * other failures send an empty token so the server refuses the handshake.
 */
export function socketAuth(
    tokens: Pick<TokenSource, 'getAccessToken'>,
    extra: Record<string, unknown>,
    onLoggedOut?: (error: LoggedOutError) => void,
): SocketAuthCallback {
    return (cb) => {
        tokens.getAccessToken().then(
            (token) => cb({ ...extra, token }),
            (error) => {
                if (error instanceof LoggedOutError && onLoggedOut) {
                    onLoggedOut(error);
                    return;
                }
                cb({ ...extra, token: '' });
            },
        );
    };
}
```

Run: `pnpm --filter happy-agent exec vitest run src/tokenStore.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 4: Update the API tests (failing first)**

In `packages/happy-agent/src/api.test.ts`:

1. Add `import type { TokenSource } from './tokenStore';` below the other type imports.
2. In `describe('api', …)`, declare and reset the token source. `vi.resetAllMocks()` wipes mock implementations, so create it after that call:

```ts
describe('api', () => {
    let config: Config;
    let creds: Credentials;
    let tokens: TokenSource & { getAccessToken: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        config = makeConfig();
        creds = makeCredentials();
        vi.resetAllMocks();
        tokens = {
            getAccessToken: vi.fn(async () => 'test-jwt-token'),
            refresh: vi.fn(async () => 'fresh-jwt-token'),
        };
    });
```

3. Thread `tokens` through every call:

```bash
perl -pi -e 's/\(config, creds\b/(config, creds, tokens/g' packages/happy-agent/src/api.test.ts
grep -c "(config, creds, tokens" packages/happy-agent/src/api.test.ts   # expect 19
```

4. In the `deleteSession` block's `it('throws on 401 with re-authenticate message', …)`, change `mockedAxios.delete.mockRejectedValueOnce(err);` to `mockedAxios.delete.mockRejectedValue(err);`. The retry calls `delete` a second time, and a reset mock would resolve `undefined`.
5. Replace the `listSessions` block's `it('throws on 401 with re-authenticate message', …)` (the one using `mockedAxios.get`) with:

```ts
        it('refreshes and retries once after a 401', async () => {
            const { AxiosError } = await import('axios');
            mockedAxios.get
                .mockRejectedValueOnce(new (AxiosError as any)('Unauthorized', { response: { status: 401 } }))
                .mockResolvedValueOnce({ data: { sessions: [] } });

            await expect(listSessions(config, creds, tokens)).resolves.toEqual([]);

            expect(tokens.refresh).toHaveBeenCalledWith('test-jwt-token');
            expect(mockedAxios.get).toHaveBeenLastCalledWith(
                'https://test-server.example.com/v1/sessions',
                { headers: { ...authHeader, Authorization: 'Bearer fresh-jwt-token' } },
            );
        });

        it('throws on a second 401 with re-authenticate message', async () => {
            const { AxiosError } = await import('axios');
            mockedAxios.get.mockRejectedValue(new (AxiosError as any)('Unauthorized', { response: { status: 401 } }));

            await expect(listSessions(config, creds, tokens)).rejects.toThrow(
                'Authentication expired. Run `happy-agent auth login` to re-authenticate.',
            );
            expect(mockedAxios.get).toHaveBeenCalledTimes(2);
        });

        it('surfaces a logged-out token store', async () => {
            const { LoggedOutError } = await import('./tokenStore');
            tokens.getAccessToken.mockRejectedValueOnce(new LoggedOutError());

            await expect(listSessions(config, creds, tokens)).rejects.toThrow('happy-agent auth login');
            expect(mockedAxios.get).not.toHaveBeenCalled();
        });
```

Run: `pnpm --filter happy-agent exec vitest run src/api.test.ts`
Expected: FAIL (api functions ignore `tokens`; no retry).

- [ ] **Step 5: Implement token use in `api.ts`**

In `packages/happy-agent/src/api.ts`:

1. Add `import { withAuthRetry, type TokenSource } from './tokenStore';`.
2. Replace everything from `function authHeaders(creds: Credentials)` to the end of the file with:

```ts
function authHeaders(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        'X-Happy-Client': 'cli-control-plane/0.1.0',
    };
}

// --- API functions ---

export async function listSessions(
    config: Config,
    creds: Credentials,
    tokens: TokenSource,
): Promise<DecryptedSession[]> {
    const url = `${config.serverUrl}/v1/sessions`;
    let data: { sessions: RawSession[] };
    try {
        const resp = await withAuthRetry(tokens, config.serverUrl, url, (token) => axios.get(url, { headers: authHeaders(token) }));
        data = resp.data as { sessions: RawSession[] };
    } catch (err) {
        handleApiError(err, 'listing sessions');
    }

    return data.sessions.map(raw => decryptSession(raw, creds));
}

export async function listMachines(
    config: Config,
    creds: Credentials,
    tokens: TokenSource,
): Promise<DecryptedMachine[]> {
    const url = `${config.serverUrl}/v1/machines`;
    let data: RawMachine[];
    try {
        const resp = await withAuthRetry(tokens, config.serverUrl, url, (token) => axios.get(url, { headers: authHeaders(token) }));
        data = resp.data as RawMachine[];
    } catch (err) {
        handleApiError(err, 'listing machines');
    }

    return data.map(raw => decryptMachine(raw, creds));
}

export async function listActiveSessions(
    config: Config,
    creds: Credentials,
    tokens: TokenSource,
): Promise<DecryptedSession[]> {
    const url = `${config.serverUrl}/v2/sessions/active`;
    let data: { sessions: RawSession[] };
    try {
        const resp = await withAuthRetry(tokens, config.serverUrl, url, (token) => axios.get(url, { headers: authHeaders(token) }));
        data = resp.data as { sessions: RawSession[] };
    } catch (err) {
        handleApiError(err, 'listing active sessions');
    }

    return data.sessions.map(raw => decryptSession(raw, creds));
}

export async function createSession(
    config: Config,
    creds: Credentials,
    tokens: TokenSource,
    opts: { tag: string; metadata: unknown },
): Promise<DecryptedSession & { sessionKey: Uint8Array }> {
    // Generate random 32-byte per-session AES key
    const sessionKey = getRandomBytes(32);

    // Encrypt session key with content public key, prepend version byte
    const encryptedKey = libsodiumEncryptForPublicKey(sessionKey, creds.contentKeyPair.publicKey);
    const withVersion = new Uint8Array(1 + encryptedKey.length);
    withVersion[0] = 0x00; // version byte
    withVersion.set(encryptedKey, 1);
    const dataEncryptionKeyBase64 = encodeBase64(withVersion);

    // Encrypt metadata with the session key
    const encryptedMetadata = encryptWithDataKey(opts.metadata, sessionKey);
    const metadataBase64 = encodeBase64(encryptedMetadata);

    const url = `${config.serverUrl}/v1/sessions`;
    const body = {
        tag: opts.tag,
        metadata: metadataBase64,
        dataEncryptionKey: dataEncryptionKeyBase64,
    };
    let data: { session: RawSession };
    try {
        const resp = await withAuthRetry(tokens, config.serverUrl, url, (token) => axios.post(url, body, { headers: authHeaders(token) }));
        data = resp.data as { session: RawSession };
    } catch (err) {
        handleApiError(err, 'creating session');
    }

    const decrypted = decryptSession(data.session, creds);
    return { ...decrypted, sessionKey: decrypted.encryption.key };
}

export async function deleteSession(
    config: Config,
    creds: Credentials,
    tokens: TokenSource,
    sessionId: string,
): Promise<void> {
    const url = `${config.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}`;
    try {
        await withAuthRetry(tokens, config.serverUrl, url, (token) => axios.delete(url, { headers: authHeaders(token) }));
    } catch (err) {
        handleApiError(err, `deleting session ${sessionId}`);
    }
}

export async function getSessionMessages(
    config: Config,
    creds: Credentials,
    tokens: TokenSource,
    sessionId: string,
    encryption: SessionEncryption,
): Promise<DecryptedMessage[]> {
    const url = `${config.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}/messages`;
    let data: { messages: RawMessage[] };
    try {
        const resp = await withAuthRetry(tokens, config.serverUrl, url, (token) => axios.get(url, { headers: authHeaders(token) }));
        data = resp.data as { messages: RawMessage[] };
    } catch (err) {
        handleApiError(err, `session ${sessionId} messages`);
    }

    return data.messages.map(msg => ({
        id: msg.id,
        seq: msg.seq,
        content: decryptField(msg.content.c, encryption),
        localId: msg.localId ?? null,
        createdAt: msg.createdAt,
        updatedAt: msg.updatedAt,
    }));
}
```

`handleApiError` rethrows non-axios errors unchanged, so a `LoggedOutError` reaches the CLI's top-level handler with its own message.

Run: `pnpm --filter happy-agent exec vitest run src/api.test.ts`
Expected: PASS.

- [ ] **Step 6: Session socket auth callback (test first)**

In `packages/happy-agent/src/session.test.ts`:

1. Replace `token: 'test-jwt-token',` in `makeOptions` with `tokens: { getAccessToken: async () => 'test-jwt-token' },`.
2. Replace the body of `it('creates socket with correct auth parameters', …)` with:

```ts
            const opts = makeOptions();
            const client = new SessionClient(opts);

            expect(mockSocketInstance).not.toBeNull();
            const socketOpts = mockSocketInstance!.opts as Record<string, unknown>;
            const auth = socketOpts.auth as (cb: (data: Record<string, unknown>) => void) => void;
            const payload = await new Promise<Record<string, unknown>>((resolve) => auth(resolve));
            expect(payload).toEqual({ token: 'test-jwt-token', clientType: 'session-scoped', sessionId: 'test-session-id' });
            expect(socketOpts.path).toBe('/v1/updates');

            client.close();
```

and make that test `async`.

3. Add after it:

```ts
        it('asks the token source again on every handshake', async () => {
            let n = 0;
            const client = new SessionClient(makeOptions({ tokens: { getAccessToken: async () => `token-${++n}` } }));
            const auth = (mockSocketInstance!.opts as Record<string, unknown>).auth as (cb: (data: Record<string, unknown>) => void) => void;
            const first = await new Promise<Record<string, unknown>>((resolve) => auth(resolve));
            const second = await new Promise<Record<string, unknown>>((resolve) => auth(resolve));
            expect([first.token, second.token]).toEqual(['token-1', 'token-2']);
            client.close();
        });

        it('reports logged out as a connect error and stops the socket', async () => {
            const { LoggedOutError } = await import('./tokenStore');
            const client = new SessionClient(makeOptions({ tokens: { getAccessToken: () => Promise.reject(new LoggedOutError()) } }));
            const errors: unknown[] = [];
            client.on('connect_error', (error) => errors.push(error));
            const auth = (mockSocketInstance!.opts as Record<string, unknown>).auth as (cb: (data: object) => void) => void;
            const cb = vi.fn();
            auth(cb);
            await new Promise((r) => setTimeout(r, 0));
            expect(cb).not.toHaveBeenCalled();
            expect(errors[0]).toBeInstanceOf(LoggedOutError);
            expect(mockSocketInstance!.connected).toBe(false);
        });
```

Run: `pnpm --filter happy-agent exec vitest run src/session.test.ts`
Expected: FAIL (`auth` is an object; `tokens` is not an option).

In `packages/happy-agent/src/session.ts`:
- Add `import { socketAuth, type TokenSource } from './tokenStore';`.
- In `SessionClientOptions`, replace `token: string;` with `tokens: Pick<TokenSource, 'getAccessToken'>;`.
- In the constructor, replace the `auth: { token: opts.token, clientType: 'session-scoped' as const, sessionId: opts.sessionId, },` object with:

```ts
            auth: socketAuth(
                opts.tokens,
                { clientType: 'session-scoped', sessionId: opts.sessionId },
                (error) => {
                    // Nothing will refresh a logged-out store: surface it and stop reconnecting.
                    this.emit('connect_error', error);
                    this.socket.close();
                },
            ),
```

Run: `pnpm --filter happy-agent exec vitest run src/session.test.ts`
Expected: PASS.

- [ ] **Step 7: Machine RPC sockets**

In `packages/happy-agent/src/machineRpc.ts`:

1. Add `import { socketAuth, type TokenSource } from './tokenStore';`.
2. Add below `waitForConnect`:

```ts
async function connectMachineSocket(config: Config, tokens: TokenSource): Promise<Socket> {
    // Fail fast (LoggedOutError, refresh failure) before opening a socket.
    await tokens.getAccessToken();
    const socket = io(config.serverUrl, {
        auth: socketAuth(tokens, {}),
        path: '/v1/updates',
        transports: ['websocket'],
        autoConnect: false,
        reconnection: false,
    });
    socket.connect();
    try {
        await waitForConnect(socket);
    } catch (error) {
        socket.close();
        throw error;
    }
    return socket;
}
```

3. In `spawnSessionOnMachine`, change the parameter `token: string,` to `tokens: TokenSource,`. Then replace everything from `const socket = io(config.serverUrl, {` through `await waitForConnect(socket);` (inclusive; the `try {` line in between is replaced too) with:

```ts
    const socket = await connectMachineSocket(config, tokens);

    try {
```

4. Make the identical two changes in `resumeSessionOnMachine`.

- [ ] **Step 8: Thread tokens through `index.ts`**

In `packages/happy-agent/src/index.ts`:

1. Add the imports `import { TokenStore } from './tokenStore';` and `import type { TokenSource } from './tokenStore';`.
2. Replace the helpers `resolveSession`, `resolveMachine` and `createClient` with:

```ts
function openAuth(config: Config): { creds: Credentials; tokens: TokenStore } {
    const creds = requireCredentials(config);
    return { creds, tokens: new TokenStore(config, creds) };
}

async function resolveSession(config: Config, creds: Credentials, tokens: TokenSource, sessionId: string): Promise<DecryptedSession> {
    const sessions = await listSessions(config, creds, tokens);
    return resolveByPrefix(sessions, sessionId, 'Session ID');
}

async function resolveMachine(config: Config, creds: Credentials, tokens: TokenSource, machineId: string): Promise<DecryptedMachine> {
    const machines = await listMachines(config, creds, tokens);
    return resolveByPrefix(machines, machineId, 'Machine ID');
}

function createClient(session: DecryptedSession, tokens: TokenSource, config: Config): SessionClient {
    return new SessionClient({
        sessionId: session.id,
        encryptionKey: session.encryption.key,
        encryptionVariant: session.encryption.variant,
        tokens,
        serverUrl: config.serverUrl,
        initialAgentState: session.agentState ?? null,
    });
}
```

3. Update the command actions:

```bash
perl -pi -e '
s/const creds = requireCredentials\(config\);/const { creds, tokens } = openAuth(config);/g;
s/resolveSession\(config, creds, sessionId\)/resolveSession(config, creds, tokens, sessionId)/g;
s/resolveMachine\(config, creds, (opts\.machine|machineId)\)/resolveMachine(config, creds, tokens, $1)/g;
s/await listMachines\(config, creds\);/await listMachines(config, creds, tokens);/g;
s/\? await listActiveSessions\(config, creds\)/? await listActiveSessions(config, creds, tokens)/g;
s/: await listSessions\(config, creds\);/: await listSessions(config, creds, tokens);/g;
s/createSession\(config, creds, \{/createSession(config, creds, tokens, {/g;
s/getSessionMessages\(config, creds, session\.id/getSessionMessages(config, creds, tokens, session.id/g;
s/createClient\(session, creds, config\)/createClient(session, tokens, config)/g;
s/OnMachine\(config, machine, creds\.token,/OnMachine(config, machine, tokens,/g;
' packages/happy-agent/src/index.ts
grep -rn "creds\.token\|opts\.token" packages/happy-agent/src --include=*.ts | grep -v '\.test\.ts'
grep -n "token: string" packages/happy-agent/src/machineRpc.ts packages/happy-agent/src/session.ts
```

Expected: both greps print nothing.

- [ ] **Step 9: Logout refreshes an expired token before revoking (test first)**

Add to `describe('authLogout', …)` in `packages/happy-agent/src/auth.test.ts`:

```ts
    it('refreshes an expired access token before revoking', async () => {
        const fresh = makeJwt(900);
        server = await startFakeServer({
            'POST /v1/auth/refresh': () => ({ status: 200, body: { accessToken: fresh, refreshToken: 'refresh-2' } }),
            'POST /v1/auth/logout': () => ({ status: 200, body: { success: true } }),
        });
        const config = configFor(server.url);
        writeCredentials(config, { token: makeJwt(-60), refreshToken: 'refresh-1', secret: getRandomBytes(32) });
        await authLogout(config);
        expect(server.calls.map((c) => c.path)).toEqual(['/v1/auth/refresh', '/v1/auth/logout']);
        expect(server.calls[1].authorization).toBe(`Bearer ${fresh}`);
        expect(existsSync(config.credentialPath)).toBe(false);
    });
```

Run: `pnpm --filter happy-agent exec vitest run src/auth.test.ts`
Expected: FAIL (logout posts the expired token, so no refresh call).

In `packages/happy-agent/src/auth.ts`:
- Add `import { TokenStore } from './tokenStore';`.
- Replace `revokeOnServer` with:

```ts
/** Best effort: the local logout proceeds whatever happens here (refresh ≤10 s, logout ≤5 s). */
async function revokeOnServer(config: Config, creds: Credentials): Promise<boolean> {
    try {
        // An expired access token cannot identify the device; refresh first.
        const token = await new TokenStore(config, creds).getAccessToken();
        await axios.post(`${config.serverUrl}/v1/auth/logout`, {}, {
            headers: { Authorization: `Bearer ${token}`, 'X-Happy-Client': 'cli-control-plane/0.1.0' },
            timeout: LOGOUT_TIMEOUT_MS,
            signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
        });
        return true;
    } catch {
        return false;
    }
}
```

Run: `pnpm --filter happy-agent exec vitest run src/auth.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 10: Typecheck, full suite, commit**

Run: `pnpm --filter happy-agent typecheck && pnpm --filter happy-agent test`
Expected: no type errors; all tests pass.

```bash
git add packages/happy-agent/src/jwt.ts packages/happy-agent/src/jwt.test.ts \
  packages/happy-agent/src/tokenStore.ts packages/happy-agent/src/tokenStore.test.ts \
  packages/happy-agent/src/api.ts packages/happy-agent/src/api.test.ts \
  packages/happy-agent/src/session.ts packages/happy-agent/src/session.test.ts \
  packages/happy-agent/src/machineRpc.ts packages/happy-agent/src/index.ts \
  packages/happy-agent/src/auth.ts packages/happy-agent/src/auth.test.ts
git commit -m "feat: refresh happy-agent access tokens and retry once on 401"
```

---

### Task 4: `happy resume` reads the new `agent.key`

**Files:**
- Modify: `packages/happy-cli/src/resume/localHappyAgentAuth.ts` (`AgentCredentialsSchema`)
- Test: `packages/happy-cli/src/resume/localHappyAgentAuth.test.ts`

**Interfaces:**
- Consumes: the agent.key format from Task 2: `{token, refreshToken, secret}`.
- Produces: `readLocalHappyAgentCredentials(home)` returns `null` for a file without `refreshToken`. Signatures and the `LocalHappyAgentCredentials` type are unchanged, so `hasLocalHappyAgentAuth` / `detectResumeSupport` report it as not authenticated.

- [ ] **Step 1: Write the failing test**

```ts
// packages/happy-cli/src/resume/localHappyAgentAuth.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectResumeSupport, hasLocalHappyAgentAuth, readLocalHappyAgentCredentials } from './localHappyAgentAuth';

const rawSecret = Buffer.alloc(32, 7);
const secret = rawSecret.toString('base64');
let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'happy-agent-key-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('local happy-agent credentials', () => {
    it('reads the OIDC agent.key format', () => {
        writeFileSync(join(home, 'agent.key'), JSON.stringify({ token: 'access', refreshToken: 'refresh', secret }));
        const creds = readLocalHappyAgentCredentials(home);
        expect(creds).not.toBeNull();
        expect(Buffer.from(creds!.secret).equals(rawSecret)).toBe(true);
        expect(creds!.contentKeyPair.publicKey).toHaveLength(32);
        expect(hasLocalHappyAgentAuth(home)).toBe(true);
        expect(detectResumeSupport(home)).toMatchObject({ rpcAvailable: true, happyAgentAuthenticated: true });
    });

    it('treats a pre-OIDC agent.key without a refresh token as signed out', () => {
        writeFileSync(join(home, 'agent.key'), JSON.stringify({ token: 'access', secret }));
        expect(readLocalHappyAgentCredentials(home)).toBeNull();
        expect(hasLocalHappyAgentAuth(home)).toBe(false);
        expect(detectResumeSupport(home)).toMatchObject({ rpcAvailable: false, happyAgentAuthenticated: false });
    });

    it('returns null when agent.key is missing', () => {
        expect(readLocalHappyAgentCredentials(home)).toBeNull();
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy exec vitest run --project unit src/resume/localHappyAgentAuth.test.ts`
Expected: FAIL. In "treats a pre-OIDC agent.key…", `readLocalHappyAgentCredentials` returns credentials instead of null.

- [ ] **Step 3: Require the refresh token**

In `packages/happy-cli/src/resume/localHappyAgentAuth.ts`:

```ts
// Written by `happy-agent auth login`. Files without a refresh token predate OIDC and count as signed out.
const AgentCredentialsSchema = z.object({
    token: z.string().min(1),
    refreshToken: z.string().min(1),
    secret: z.string().min(1),
});
```

- [ ] **Step 4: Run it to verify it passes, then the full unit suite**

Run: `pnpm --filter happy exec vitest run --project unit src/resume/localHappyAgentAuth.test.ts`
Expected: PASS (3 tests).

Run: `pnpm --filter happy test`
Expected: all unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/resume/localHappyAgentAuth.ts packages/happy-cli/src/resume/localHappyAgentAuth.test.ts
git commit -m "fix: treat pre-OIDC happy-agent credentials as signed out in resume"
```

---

### Task 5: happy-agent integration test through oidc-mock

**Files:**
- Modify: `packages/happy-agent/src/happy-agent.integration.test.ts`

**Interfaces:**
- Consumes:
  - `happy-agent auth login --no-browser`, which prints a line matching `https?://…/v1/auth/oidc/login?…` (Task 2).
  - The server loopback target (Task 1).
  - `HttpBrowser` / `pickerFields` from `packages/happy-server/sources/testing/httpBrowser.ts`.
  - `pnpm env:up:authenticated`, which seeds the CLI as `alice` via oidc-mock; this is unchanged.
- Produces: nothing for later tasks.

The test keeps its existing `beforeAll`/`afterAll`, which runs `pnpm env:up:authenticated`. It needs `docker compose up -d oidc-mock`. The server runs from source (`pnpm standalone serve`), so Task 1 is live.

- [ ] **Step 1: Replace the QR approval helpers with the loopback flow**

In `packages/happy-agent/src/happy-agent.integration.test.ts`:

1. Change the fs import to `import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';` and delete `import { decodeBase64, encodeBase64, libsodiumEncryptForPublicKey } from './encryption';`.
2. Delete `readSeededCliCredentials`, `approveAgentLogin` and the old `runAgentAuthLogin`.
3. Add below the `keepIntegrationEnv` constant:

```ts
const oidcIssuer = process.env.HAPPY_ENV_OIDC_ISSUER ?? 'http://localhost:8180';
const oidcUser = process.env.HAPPY_ENV_OIDC_USER ?? 'alice';
const httpBrowserPath = join(repoRoot, 'packages', 'happy-server', 'sources', 'testing', 'httpBrowser.ts');

type BrowserResponse = { url: string; status: number; body: string; location: string | null };
type HttpBrowserModule = {
    HttpBrowser: new () => {
        get(url: string): Promise<BrowserResponse>;
        postForm(url: string, fields: Record<string, string>): Promise<BrowserResponse>;
    };
    pickerFields(html: string, sub: string): Record<string, string>;
};
```

The module is loaded with a dynamic import of a path variable, because `rootDir: "src"` forbids static imports from outside the package.

4. Add in the helpers section:

```ts
/** Plays the user's browser: oidc-mock's user picker, then the redirects back into the agent's loopback listener. */
async function completeBrowserLogin(loginUrl: string): Promise<BrowserResponse> {
    const { HttpBrowser, pickerFields } = await import(/* @vite-ignore */ httpBrowserPath) as HttpBrowserModule;
    const browser = new HttpBrowser();
    const picker = await browser.get(loginUrl);
    if (!picker.url.startsWith(`${oidcIssuer}/authorize`)) {
        throw new Error(`Expected the oidc-mock user picker, got ${picker.status} at ${picker.url}`);
    }
    return browser.postForm(`${oidcIssuer}/authorize/callback`, pickerFields(picker.body, oidcUser));
}

async function runAgentAuthLogin(env: NodeJS.ProcessEnv): Promise<{ output: string; callback: BrowserResponse }> {
    return await new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, [
            '--no-warnings',
            '--no-deprecation',
            binPath,
            'auth',
            'login',
            '--no-browser',
        ], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let browserRun: Promise<BrowserResponse> | null = null;

        const timeout = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            child.kill('SIGKILL');
            rejectPromise(new Error(`Timed out waiting for happy-agent auth login.\n${stdout}\n${stderr}`));
        }, 60_000);

        const finish = (error?: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            if (error || !browserRun) {
                rejectPromise(error ?? new Error(`happy-agent auth login printed no sign-in URL\n${stdout}\n${stderr}`));
                return;
            }
            browserRun.then((callback) => resolvePromise({ output: stdout, callback }), rejectPromise);
        };

        child.stdout.on('data', (chunk: Buffer | string) => {
            stdout += chunk.toString();
            const match = /(https?:\/\/\S+\/v1\/auth\/oidc\/login\?\S+)/.exec(stdout);
            if (match && !browserRun) {
                browserRun = completeBrowserLogin(match[1]);
                browserRun.catch((error) => {
                    try {
                        child.kill('SIGTERM');
                    } catch {
                        // ignore
                    }
                    finish(error instanceof Error ? error : new Error(String(error)));
                });
            }
        });

        child.stderr.on('data', (chunk: Buffer | string) => {
            stderr += chunk.toString();
        });

        child.on('error', error => {
            finish(error);
        });

        child.on('close', code => {
            if (code !== 0) {
                finish(new Error(`happy-agent auth login exited with code ${code}\n${stdout}\n${stderr}`));
                return;
            }
            finish();
        });
    });
}
```

- [ ] **Step 2: Add the sign-in test and trim the first spawn test**

Insert as the first test inside `describe('happy-agent integration', …)`:

```ts
    it('signs in through the loopback OIDC flow and decrypts account data', async () => {
        if (!integrationConfig || !agentHomeDir) {
            throw new Error('Integration environment not initialized');
        }
        const agentEnv = agentEnvVars(integrationConfig.serverPort, agentHomeDir);

        const { output, callback } = await runAgentAuthLogin(agentEnv);
        expect(callback.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\?code=/);
        expect(callback.status).toBe(200);
        expect(callback.body).toContain('You can close this tab');
        expect(output).toContain('- Status: Authenticated');

        const credentialPath = join(agentHomeDir, 'agent.key');
        expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
        const stored = JSON.parse(readFileSync(credentialPath, 'utf-8')) as { token?: string; refreshToken?: string; secret?: string };
        expect(stored.token).toBeTruthy();
        expect(stored.refreshToken).toBeTruthy();
        expect(stored.secret).toBeTruthy();
        expect(output).not.toContain(stored.token!);
        expect(output).not.toContain(stored.refreshToken!);

        const status = runAgentCli(['auth', 'status'], agentEnv);
        expect(status).toContain('- Status: Authenticated');
        expect(status).not.toContain(stored.token!);
        expect(status).not.toContain(stored.refreshToken!);

        // Machine metadata was encrypted by the seeded CLI daemon for the account's content key.
        await waitFor(async () => {
            const machines = parseJson<Array<{ metadata?: { homeDir?: unknown } | null }>>(runAgentCli(['machines', '--json'], agentEnv));
            return machines.some(machine => typeof machine.metadata?.homeDir === 'string');
        }, 20_000, 'a machine whose metadata happy-agent can decrypt');

        // Round-trip a session through the server: encrypted by `create`, decrypted by `list` and `history`.
        const tag = `agent-it-${Date.now()}`;
        const created = parseJson<{ id: string }>(runAgentCli(['create', '--tag', tag, '--path', agentHomeDir, '--json'], agentEnv));
        const sessions = parseJson<Array<{ id: string; metadata?: { tag?: string } }>>(runAgentCli(['list', '--json'], agentEnv));
        expect(sessions.find(session => session.id === created.id)?.metadata?.tag).toBe(tag);
        expect(parseJson<unknown[]>(runAgentCli(['history', created.id, '--json'], agentEnv))).toEqual([]);
    });
```

In the next test (formerly `'authenticates, lists machines, and spawns a session through the real daemon RPC path'`):
- Rename it to `'lists machines and spawns a session through the real daemon RPC path'`.
- Delete these lines: `const serverUrl = …;`, `const seededCredentials = …;`, the `const authOutput = await runAgentAuthLogin(agentEnv, {…});` call, and the two `expect`s on `authOutput` / `agent.key`.
- Keep `const agentEnv = agentEnvVars(…);` and everything from `const machineOutput = …` on.

- [ ] **Step 3: Typecheck and run the sign-in test**

Run: `pnpm --filter happy-agent typecheck`
Expected: no errors.

Run:

```bash
docker compose up -d oidc-mock
pnpm --filter happy-agent test:integration -t "signs in through the loopback OIDC flow"
```

Expected: PASS for that test; the others are skipped. The remaining tests spawn real Claude/Codex sessions, need those agents installed and configured on the host, and are unchanged apart from the removed auth step. Run them with `pnpm --filter happy-agent test:integration` where that holds.

- [ ] **Step 4: Commit**

```bash
git add packages/happy-agent/src/happy-agent.integration.test.ts
git commit -m "test: sign happy-agent in through oidc-mock in the integration suite"
```

---

### Task 6: Remove happy-mobile-gym and the app's harness mode

**Files:**
- Delete: `packages/happy-mobile-gym/` (whole directory)
- Delete: `docs/core-demo-recording.md`, `scripts/app-store/seed-multiplayer.mjs`
- Modify: `package.json` (script + workspace entry), `pnpm-workspace.yaml`, `pnpm-lock.yaml`
- Modify: `packages/happy-app/sources/sync/serverConfig.ts` (`getServerUrl`)
- Modify: `environments/environments.ts:123-124, 356`
- Modify: `scripts/app-store/README.md`, `scripts/app-store/ANDROID.md`, `scripts/app-store/android-capture.mjs:359`

**Interfaces:**
- Consumes: nothing.
- Produces: `getServerUrl()` always resolves through `resolveServerUrl({ deployUrl, buildUrl })`.

- [ ] **Step 1: Delete the package and its references in workspace config**

```bash
git rm -r -q packages/happy-mobile-gym
rm -rf packages/happy-mobile-gym   # untracked node_modules/dist left behind
```

- In root `package.json`, delete the line `"mobile-gym": "pnpm --filter happy-mobile-gym cli",` from `scripts`, and the line `"packages/happy-mobile-gym",` from `workspaces.packages`.
- In `pnpm-workspace.yaml`, delete the line `  - "packages/happy-mobile-gym"`.

- [ ] **Step 2: Regenerate the lockfile and verify only the gym importer disappears**

```bash
pnpm --version            # must print 10.11.0
pnpm install
git diff -U0 pnpm-lock.yaml | grep '^[-+][^-+]'
```

Expected: only `-` lines, namely the `packages/happy-mobile-gym:` importer block (its `devDependencies` for `@types/node`, `tsx`, `typescript`). There should be no `+` lines and no package-entry removals, because those packages are used elsewhere. If anything else changed, run `rm -rf node_modules packages/*/node_modules && pnpm install` and diff again. If it still differs, stop and report the diff.

Run: `pnpm install --frozen-lockfile`
Expected: succeeds ("Lockfile is up to date").

- [ ] **Step 3: Drop the harness branch from the app**

In `packages/happy-app/sources/sync/serverConfig.ts`, replace `getServerUrl` with:

```ts
/** Deploy-time `window.__HAPPY_CONFIG__.serverUrl`, else build-time EXPO_PUBLIC_HAPPY_SERVER_URL. */
export function getServerUrl(): string {
    return resolveServerUrl({
        deployUrl: (globalThis as any).__HAPPY_CONFIG__?.serverUrl,
        buildUrl: process.env.EXPO_PUBLIC_HAPPY_SERVER_URL,
    });
}
```

`sources/utils/harnessCatalog.ts`, which lists agent harnesses, is unrelated and stays.

Run:

```bash
grep -rn "HARNESS_MODE\|HARNESS_DEV" packages/happy-app --include=*.ts --include=*.tsx --include=*.js --exclude-dir=node_modules
pnpm --filter happy-app exec vitest run sources/sync/serverUrl.test.ts sources/auth/signIn.test.ts
pnpm --filter happy-app typecheck
```

Expected: the grep prints nothing, the tests pass, and there are no type errors. No test sets `EXPO_PUBLIC_HARNESS_MODE`, as the grep shows.

- [ ] **Step 4: Environment messages**

In `environments/environments.ts`, replace:

```ts
            `Environment "${config.name}" is isolated; generic ${operation} is disabled. `
            + "Use packages/happy-mobile-gym for a new private integration run.",
```

with:

```ts
            `Environment "${config.name}" is isolated; generic ${operation} is disabled. `
            + `It was created by the removed mobile gym; delete it with: pnpm env:remove ${config.name}`,
```

Also replace `console.log("  Isolated environment; new private integration runs use packages/happy-mobile-gym.");` with `console.log("  Isolated environment: generic env commands are disabled for it.");`.

Run: `pnpm env:list`
Expected: it runs without a TypeScript error (tsx compiles the file).

- [ ] **Step 5: Docs and scripts that depended on the gym**

```bash
git rm -q docs/core-demo-recording.md scripts/app-store/seed-multiplayer.mjs
```

`scripts/app-store/README.md`:

- Replace the three-line step 1 (from `1. Start \`happy-mobile-gym\` from current mobile main…` through `…then complete ordinary encrypted pairing.`) with:

```markdown
1. Start the local compose stack (`docker compose up -d --build`) and sign the
   app in through oidc-mock as a test user from `deploy/oidc-mock/config.yaml`;
   create sample history through the real local server/Agent APIs.
```

- Replace the whole paragraph starting `` `node --import tsx scripts/app-store/seed-multiplayer.mjs `` (through `It never patches the app's archive filter or fabricates Agent metadata.`) with:

```markdown
The multiplayer card's fictional Alex/Maya/Jamie conversation came from a seed
script that depended on the removed mobile gym. Until a producer that signs in
through the compose stack exists, that card cannot be regenerated; reuse the
existing export or drop the card. It never demonstrated authenticated
multi-account sharing, invite flows, or Agent-integrated team transport.
```

- Replace `dedicated devices, private ADB server, gym connection, and cleanup.` with `dedicated devices, private ADB server, compose-stack connection, and cleanup.`.

`scripts/app-store/ANDROID.md`:

- Replace `AVDs afterward; start the mobile gym and isolated Agent/scenario separately.` with `AVDs afterward; start the compose stack and isolated Agent/scenario separately.`.
- Replace everything from the heading `## Connect the separately staged gym` up to (not including) `## Appearance and repeat capture` with:

````markdown
## Connect the local compose stack

Start the server and IdP from the repository root with `docker compose up -d --build`
(server on port 3005, oidc-mock on 8180) and Metro for the development build
separately. Stage the isolated Agent and sample scenario using
[the screenshot guide](README.md). Do not use production authentication.

For each verified serial, map the server, IdP and Metro ports. These examples
use Metro 8081; change both sides together if yours differs:

```sh
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" reverse --no-rebind tcp:3005 tcp:3005
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" reverse --no-rebind tcp:8180 tcp:8180
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" reverse --no-rebind tcp:8081 tcp:8081
```

On reuse, inspect existing mappings with the same explicit host/port/serial and
`reverse --list`; reuse identical mappings and stop on unexpected ones instead
of overwriting them.

Install the verified APK on each new owned device, then open its local client:

```sh
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" install "$CAPTURE_APK"
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" shell am start \
 -a android.intent.action.VIEW \
 -d 'exp+happy://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081' \
 com.slopus.happy.dev
```

Sign in through the app's normal OIDC flow. An unchanged installed development
client does not need reinstallation for every JS capture. Updating a rebuilt APK
is a deliberate action on the same verified owned device; do not uninstall or
clear its account data as routine setup.

````

- Replace `install, reset devices, start adb/the gym, or seed sessions.` with `install, reset devices, start adb/the compose stack, or seed sessions.`.
- Replace ``the owned scenario/Agent and gym through their normal controller `stop()` or`` with ``the owned scenario/Agent through its normal controller `stop()` (and the compose stack with `docker compose down`) or``.

`scripts/app-store/android-capture.mjs` line 359: replace the string `"Real native Android app on an explicitly owned emulator; debug-only loopback mobile gym startup/auth. No screenshot-only UI patches."` with `"Real native Android app on an explicitly owned emulator; debug build signed in through the local compose stack (oidc-mock). No screenshot-only UI patches."`.

Run: `node --check scripts/app-store/android-capture.mjs`
Expected: no output (syntax OK).

- [ ] **Step 6: Verify no references remain**

```bash
grep -rn "mobile-gym\|mobile gym\|happy-mobile-gym\|seed-multiplayer\|core-demo-recording" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude=pnpm-lock.yaml . | grep -v '^./docs/superpowers/'
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
# the deletions are already staged by the `git rm` calls above
git add scripts/app-store package.json pnpm-workspace.yaml pnpm-lock.yaml \
  packages/happy-app/sources/sync/serverConfig.ts environments/environments.ts
git status --short   # expect only staged changes (D/M), nothing unstaged
git commit -m "chore: remove happy-mobile-gym and the app harness mode"
```

## Execution notes

The following rulings in this plan/ledger were reversed during execution;
the plan body above is left as written and is not authoritative on these
points:

- `pendingRotation` (described as dropped) was restored in the agent's
  `tokenStore.ts`, so an unpersisted rotation can be retried instead of
  burning a second refresh token.
- The browser for login is opened via `open`, not left to print-URL-only.
- The loopback and mobile confirmation pages (`/v1/auth/oidc/loopback/confirm`,
  `/v1/auth/oidc/mobile/confirm`) were added as a CSRF-protected gate, where
  the plan did not call for them.
- The no-response retry inside the refresh lock (one immediate retry on a
  lost response, still under the lock) was added to `tokenStore.ts`.
