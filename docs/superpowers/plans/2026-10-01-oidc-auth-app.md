# OIDC Auth — App Implementation Plan (Plan 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web and mobile app (packages/happy-app) sign in only through the server's OIDC flow, keep 15-minute access tokens fresh across tabs, remove keypair creation, QR pairing, secret-key restore and the server picker, make every build identity configurable, and cover the web flow with a Playwright e2e suite in CI.

**Architecture:** A pure `TokenStore` owns `{token, refreshToken, secret}`: it refreshes 2 minutes before expiry with single-flight, runs the refresh under `navigator.locks` on the web (re-reading storage inside the lock and adopting another tab's rotation), and turns `invalid_grant` into the normal logout path. One `authFetch` wrapper attaches the current token to every request for the server origin and retries once on 401; the socket's `auth` callback awaits a fresh token. Login is PKCE + an ephemeral libsodium box key: web does a full-page redirect to `/v1/auth/oidc/login?client=web`, returns to the new `/auth/callback` route and redeems the `#code`; mobile uses `WebBrowser.openAuthSessionAsync` with `<scheme>://auth/callback`.

**Tech Stack:** Expo SDK 55 / React Native / expo-router, TypeScript, libsodium (`@/encryption/libsodium.lib`), expo-crypto, expo-web-browser, Vitest 3 (node environment), Docker Compose, Playwright 1.63, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-30-oidc-auth-design.md` (§2 "Web app", "Mobile", "Refresh", "Logout", "Removed from clients"; §3 "Mobile builds", "Local deployment"; §4 Testing)

**Depends on:** Plan 1 (server) and plan 2 (CLI), both on this branch.

## Global Constraints

- Server contract (implemented in plan 1; see `packages/happy-server/sources/app/api/routes/oidcRoutes.ts`, `tokenRoutes.ts`):
  - `GET /v1/auth/oidc/login?client=web&code_challenge=<S256>` or `?client=mobile&code_challenge=<S256>&redirect_uri=<uri>`; `code_challenge` must match `/^[A-Za-z0-9_-]{43,128}$/`; `redirect_uri` must be listed in the server's `MOBILE_REDIRECT_URIS` (comma-separated). 503 `{error:'idp_unavailable'}` while the IdP is down.
  - After the IdP: web → `302 ${WEBAPP_URL}/auth/callback#code=<exchangeCode>`; mobile → `302 ${redirect_uri}?code=<exchangeCode>`. Exchange codes are single-use, 60 s TTL.
  - `POST /v1/auth/oidc/exchange {code, codeVerifier, ephemeralPublicKey: base64(32 bytes), deviceName?: string ≤100}` → `200 {accountId, accessToken, refreshToken, keyBundle}` or `400 {error:'invalid_request'|'invalid_grant'}`. The server checks `base64url(sha256(codeVerifier)) === code_challenge`. `keyBundle` = base64 of `[ephPub(32) | nonce(24) | box(rootSecret(32))]` (same layout the CLI opens with `decryptWithEphemeralKey`; the app's `decryptBox` in `sources/encryption/libsodium.ts` opens it).
  - `POST /v1/auth/refresh {refreshToken}` → `200 {accessToken, refreshToken}` or `401 {error:'invalid_grant', reason}`. Replaying a rotated refresh token revokes the device, except one retry of the immediately previous token within `AUTH_REFRESH_REUSE_GRACE` (default 60s).
  - `POST /v1/auth/logout` with `Authorization: Bearer <access token>` and no body → `200 {success: true}`; revokes the device.
  - Access tokens are HS256 JWTs `{sub: accountId, did: deviceId, typ: 'access', exp}` (default 15 min). HTTP requests accept an unexpired token even after revocation; sockets are refused for revoked devices and disconnected at `exp` + 60 s.
- App credentials: `{ token, refreshToken, secret }` stored under key `auth_credentials` (localStorage on web, SecureStore on native). `secret` is the 32-byte root secret, base64url. Stored credentials without a non-empty `refreshToken` are treated as logged out and removed.
- Proactive refresh margin: 2 minutes before `exp`. Retry after a non-auth refresh failure: 30 s. Refresh request timeout: 10 s. Logout steps (push unregister, server logout): 5 s each, best-effort.
- Web refresh lock name: `happy-auth-refresh` (`navigator.locks.request`). When `navigator.locks` is missing, single-flight only.
- `authFetch` attaches `Authorization` and retries once on 401 only when the request URL's origin equals the configured server's origin; other URLs (S3 presigned, CDN) are passed through untouched.
- Server URL: deploy-time `window.__HAPPY_CONFIG__.serverUrl`, else build-time `EXPO_PUBLIC_HAPPY_SERVER_URL`, else `http://localhost:3005` (local development only). No user-facing picker and no stored override.
- Never log or display tokens or the root secret.
- New UI copy is English-only literals (the fork has no translations for it); existing `t()` keys are neither added nor removed, so the 11 translation files stay untouched.
- `happy-agent` and `happy-mobile-gym` still use removed endpoints / harness credentials; they are migrated in a later plan.
- Commit messages: `<type>: <short description>`; types feat/fix/refactor/chore/docs/build/test; no AI attribution, no `Co-Authored-By`, no mention of Claude. Commits are GPG-signed automatically — never disable signing.
- App unit tests: `pnpm --filter happy-app exec vitest run <files>` (paths relative to `packages/happy-app`); full suite: `pnpm --filter happy-app exec vitest run`. Typecheck: `pnpm --filter happy-app typecheck` (`tsc --noEmit`, includes test files).
- Baseline on this branch before any change (commit `7dd0971c`): typecheck passes; the full vitest suite has exactly one failing file, `sources/components/sessionPresentation.test.ts` (`ReferenceError: __DEV__ is not defined` inside `expo-modules-core` at import time, before any test runs). "Suite green" below means: no failures other than that file. Do not try to fix it in this plan.
- Vitest runs in a `node` environment and cannot import `react-native`, `react-native-mmkv` or `expo-secure-store`. Modules under test that must stay importable (`tokenStore.ts`, `authFetch.ts`, `jwt.ts`, `callbackUrls.ts`, `oidcLogin.ts`, `serverUrl.ts`) must not import them.

## Rulings on open points

- **Dev fallback server URL = `http://localhost:3005`.** The upstream default (`https://api.cluster-fluster.com`) would send a corporate user's sign-in and data to a third-party server if a build forgot its URL. `localhost:3005` is where the repo's `docker-compose.yaml` and `pnpm env:*` servers listen, so `expo start --web` works out of the box for development, and a misconfigured build fails closed (nothing listening) instead of leaking. Production native builds cannot reach the fallback (app.config fails without `HAPPY_SERVER_URL`), and `Dockerfile.webapp` builds with `APP_ENV=production`, so it needs `HAPPY_SERVER_URL` too.
- **Placeholder identities for development/preview with no env set:** development = name `Happy (dev)`, bundle id `com.example.happy.dev`, scheme `happy-dev`; preview = `Happy (preview)`, `com.example.happy.preview`, `happy-preview`. `example.com` is reserved (RFC 2606), so these never collide with a real app. Production has no defaults. `APP_BUNDLE_ID` is used verbatim for every variant (the "suffix only when explicitly configured" rule: set a different `APP_BUNDLE_ID` per EAS profile if you want one).
- **Harness mode:** `EXPO_PUBLIC_HARNESS_MODE` is used by `happy-mobile-gym` for two things: injecting debug credentials (`_layout.tsx`, removed here) and pinning the server URL to a loopback origin (`serverConfig.ts`, unrelated to credentials, kept unchanged). `EXPO_PUBLIC_DEV_TOKEN/SECRET`, the `?dev_token=&dev_secret=` query login and `EXPO_PUBLIC_HARNESS_DEV_TOKEN/SECRET` are removed.
- **Voice:** `apiVoice.ts` used the upstream hosted server with a keypair token for voice unless "use custom server for voice" was set. That path needs `authGetToken` (removed) and would talk to upstream; voice now always uses the configured server with `authFetch`.
- **i18n:** no key is trivially dead in the sense of removable without editing all 11 translation files (the `TranslationStructure` type requires every key in every file), so none are removed. Keys that become unused are left in place. The logout confirmation text still mentions backing up a secret key; changing it is a translation change and is left for a copy pass.
- **Upstream links** in help menus, "Report issue", EAS `submit` ids in `eas.json` and release scripts are out of scope (spec: distribution out of scope).
- **CI unit tests:** the app's full vitest suite is not green on this branch (baseline above), so CI runs the auth-related app test files explicitly rather than the whole suite. The pre-existing failure is flagged, not masked.

## File Structure

```
packages/happy-app/
  index.ts                                        modify: import the web callback capture before expo-router
  expoConfig.cjs                                  create: pure buildExpoConfig(env, buildMetadata)
  app.config.js                                   modify: thin wrapper around expoConfig.cjs; HAPPY_SERVER_URL → EXPO_PUBLIC_HAPPY_SERVER_URL
  sources/appConfig.test.ts                       create
  sources/auth/jwt.ts (+ .test.ts)                create: decodeJwtPayload, decodeJwtExpiry (base64url)
  sources/auth/tokenStore.ts (+ .test.ts)         create: StoredCredentials, parseStoredCredentials, LoggedOutError, AccessTokenProvider,
                                                          TokenStore (single-flight, lock, adopt, pending rotation), withTimeout
  sources/auth/authFetch.ts (+ .test.ts)          create: setAccessTokenProvider, getAccessToken, authFetch, headersToRecord, staticAccessTokenProvider
  sources/auth/callbackUrls.ts (+ .test.ts)       create: parseWebCallbackHash, parseMobileCallbackUrl, isAuthCallbackPath
  sources/auth/oidcLogin.ts (+ .test.ts)          create: PendingLogin, createPendingLogin, buildLoginUrl, exchangeCode, (de)serializePendingLogin
  sources/auth/tokenStorage.ts (+ .test.ts)       rewrite: AuthCredentials = StoredCredentials; refresh token required; removeCredentialsIfRefreshToken
  sources/auth/tokenStoreRuntime.ts               create: startTokenStore (platform wiring, web lock, storage-event sync), getRuntimeTokenStore
  sources/auth/logout.ts                          create: wipeLocalSessionAndReload
  sources/auth/signIn.ts                          create: signIn() (web redirect / native auth session), completeWebSignIn(code)
  sources/auth/webCallback.ts                     create: captures and strips #code at startup; takeWebCallbackCode()
  sources/auth/AuthContext.tsx                    modify: login(credentials), logout() with server logout
  sources/app/+native-intent.tsx                  create: route OS deep links for auth/callback to '/'
  sources/app/_layout.tsx                         modify: drop dev/harness credentials; start the token store before syncRestore
  sources/app/(app)/_layout.tsx                   modify: register auth/callback; drop restore/* and terminal/* screens
  sources/app/(app)/auth/callback.tsx             create: web callback screen
  sources/app/(app)/index.tsx                     modify: "Sign in" replaces create/restore account
  sources/utils/parseToken.ts (+ .test.ts)        modify: decode the JWT payload as base64url
  sources/sync/api{Artifacts,Attachments,Feed,Friends,Github,Kv,Projects,Push,Services,Usage,Voice}.ts, sessionAvatars.ts, sync.ts
                                                  modify: fetch → authFetch, drop hand-built Authorization headers
  sources/sync/apiSocket.ts (+ apiSocket.auth.test.ts)  modify: request() via authFetch; auth callback awaits getAccessToken(); config has no token
  sources/sync/serverUrl.ts (+ .test.ts)          create: resolveServerUrl (pure)
  sources/sync/serverConfig.ts                    modify: no stored override, no voice/custom-server helpers; getServerLabel()
  sources/components/{SettingsView,EmptyMainScreen,MainView,HomeHeader}.tsx, HomeHeader.test.ts,
    onboarding/LinkComputer.tsx, CommandPalette/CommandPaletteProvider.tsx,
    app/(app)/settings/account.tsx, app/(app)/onboarding/settings.tsx, app/(app)/dev/index.tsx
                                                  modify: remove QR/secret-key/server-picker UI; hint to run `happy auth login`
  delete: sources/auth/{authChallenge,authGetToken,authQRStart,authQRWait,authApprove,authAccountApprove,secretKeyBackup}.ts,
          sources/auth/secretKeyBackup.spec.ts, sources/hooks/useConnectTerminal.ts, sources/hooks/useConnectAccount.ts,
          sources/app/(app)/restore/{index,manual}.tsx, sources/app/(app)/terminal/{index,connect}.tsx,
          sources/app/(app)/server.tsx, sources/components/ConnectButton.tsx
Dockerfile.webapp                                 modify: APP_BUNDLE_ID / APP_SCHEME / HAPPY_SERVER_URL build args
docker-compose.yaml                               modify: webapp service (profile e2e); server MOBILE_REDIRECT_URIS, AUTH_REFRESH_REUSE_GRACE override
environments/environments.ts                      modify: MOBILE_REDIRECT_URIS for dev/preview schemes
e2e/                                              create: standalone Playwright project (package.json, package-lock.json, playwright.config.ts,
                                                          globalSetup.ts, tests/helpers.ts, tests/auth.spec.ts)
.gitignore                                        modify: e2e artifacts
.github/workflows/web-e2e.yml                     create
.github/workflows/typecheck.yml                   modify: run the app auth unit tests
```

---

### Task 1: Token store and `authFetch`

**Files:**
- Create: `packages/happy-app/sources/auth/jwt.ts`, `sources/auth/tokenStore.ts`, `sources/auth/authFetch.ts`
- Modify: `packages/happy-app/sources/utils/parseToken.ts:12`
- Test: `sources/auth/jwt.test.ts`, `sources/auth/tokenStore.test.ts`, `sources/auth/authFetch.test.ts`, `sources/utils/parseToken.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // jwt.ts
  function decodeJwtPayload(token: string): Record<string, unknown> | null
  function decodeJwtExpiry(token: string): number | null          // exp * 1000, or null
  // tokenStore.ts
  const REFRESH_MARGIN_MS = 120_000; const RETRY_AFTER_ERROR_MS = 30_000;
  interface StoredCredentials { token: string; refreshToken: string; secret: string }
  function parseStoredCredentials(raw: string | null | undefined): StoredCredentials | null
  class LoggedOutError extends Error {}
  interface AccessTokenProvider { serverUrl(): string; getAccessToken(): Promise<string>; refresh(rejectedToken: string): Promise<string> }
  interface TokenStoreDeps {
    serverUrl(): string;
    read?(): Promise<StoredCredentials | null>;     // omitted on native: memory is the source of truth
    write(credentials: StoredCredentials): Promise<void>;   // must throw when it could not persist
    clearIfRefreshToken(refreshToken: string): Promise<void>;
    onLoggedOut(): void;
    withLock?<T>(fn: () => Promise<T>): Promise<T>;
    fetch?: typeof fetch; clientId?(): string; now?(): number; refreshTimeoutMs?: number;
  }
  class TokenStore implements AccessTokenProvider {
    constructor(initial: StoredCredentials, deps: TokenStoreDeps)   // schedules the proactive refresh
    current(): StoredCredentials
    hasPendingRotation(): boolean
    getAccessToken(): Promise<string>
    refresh(rejectedToken: string): Promise<string>
    applyExternalChange(raw: string | null): 'reload' | 'adopted' | 'ignored'
    logoutOnServer(timeoutMs?: number): Promise<void>   // best-effort; never calls onLoggedOut; stops the store
    stop(): void
  }
  function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>
  // authFetch.ts
  function setAccessTokenProvider(provider: AccessTokenProvider | null): void
  function getAccessToken(): Promise<string>                        // rejects LoggedOutError without a provider
  function authFetch(url: string, init?: RequestInit): Promise<Response>
  function headersToRecord(headers?: HeadersInit): Record<string, string>
  function staticAccessTokenProvider(token: string, serverUrl: string): AccessTokenProvider   // tests
  ```

- [ ] **Step 1: Write the failing JWT and parseToken tests**

```ts
// packages/happy-app/sources/auth/jwt.test.ts
import { describe, expect, it } from 'vitest';
import { decodeJwtExpiry, decodeJwtPayload } from './jwt';

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('decodeJwtPayload / decodeJwtExpiry', () => {
    it('decodes base64url payloads, including "-" and "_" and missing padding', () => {
        const payload = { sub: 'cmacc123', did: 'dev', typ: 'access', note: '???>>>~~~', exp: 1_800_000_000 };
        const segment = b64url(payload);
        expect(segment).toMatch(/[-_]/);
        const token = `${b64url({ alg: 'HS256' })}.${segment}.sig`;
        expect(decodeJwtPayload(token)).toEqual(payload);
        expect(decodeJwtExpiry(token)).toBe(1_800_000_000_000);
    });

    it('returns null for non-JWTs and tokens without a numeric exp', () => {
        expect(decodeJwtExpiry('not-a-jwt')).toBeNull();
        expect(decodeJwtExpiry(`${b64url({})}.${b64url({ sub: 'x' })}.sig`)).toBeNull();
        expect(decodeJwtExpiry('a.%%%.c')).toBeNull();
        expect(decodeJwtPayload('a..c')).toBeNull();
    });
});
```

```ts
// packages/happy-app/sources/utils/parseToken.test.ts
import { describe, expect, it } from 'vitest';
import { parseToken } from './parseToken';

describe('parseToken', () => {
    it('reads sub from a server access token whose payload uses base64url characters', () => {
        const payload = Buffer.from(JSON.stringify({ sub: 'cmacc123', did: 'dev', typ: 'access', note: '???>>>~~~' })).toString('base64url');
        expect(payload).toMatch(/[-_]/);
        expect(parseToken(`eyJhbGciOiJIUzI1NiJ9.${payload}.sig`)).toBe('cmacc123');
    });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter happy-app exec vitest run sources/auth/jwt.test.ts sources/utils/parseToken.test.ts`
Expected: FAIL — `./jwt` cannot be resolved; `parseToken` throws `Invalid token: failed to decode payload` (standard base64 decoding rejects `-`/`_`).

- [ ] **Step 3: Implement `jwt.ts` and fix `parseToken`**

```ts
// packages/happy-app/sources/auth/jwt.ts
import { decodeBase64 } from '@/encryption/base64';
import { decodeUTF8 } from '@/encryption/text';

/** Reads a JWT payload without verifying it (the server verifies). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) {
        return null;
    }
    try {
        const payload = JSON.parse(decodeUTF8(decodeBase64(parts[1], 'base64url')));
        return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    } catch {
        return null;
    }
}

/** `exp` in milliseconds, or null when the token is not a JWT with a numeric exp. */
export function decodeJwtExpiry(token: string): number | null {
    const payload = decodeJwtPayload(token);
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
}
```

In `packages/happy-app/sources/utils/parseToken.ts` line 12, change `decodeBase64(payload)` to `decodeBase64(payload, 'base64url')` (JWT segments are base64url; the `base64url` mode of `decodeBase64` also accepts plain base64).

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --filter happy-app exec vitest run sources/auth/jwt.test.ts sources/utils/parseToken.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing token store test**

```ts
// packages/happy-app/sources/auth/tokenStore.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    LoggedOutError,
    TokenStore,
    parseStoredCredentials,
    type StoredCredentials,
    type TokenStoreDeps,
} from './tokenStore';

const SERVER = 'https://happy.test';

function makeJwt(expSecondsFromNow: number): string {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'acc_1', did: 'dev_1', typ: 'access', exp })}.sig`;
}

function creds(token: string, refreshToken = 'rt-1'): StoredCredentials {
    return { token, refreshToken, secret: 'root-secret' };
}

type Handler = (path: string, body: any) => { status: number; body: unknown };

function fakeServer(handler: Handler) {
    const calls: Array<{ path: string; body: any; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = new URL(String(input)).pathname;
        const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ path, body, headers: (init.headers ?? {}) as Record<string, string> });
        const result = handler(path, body);
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** A refresh endpoint that rotates like the server: only the latest refresh token is accepted. */
function rotatingServer() {
    let valid = 'rt-1';
    let n = 1;
    return fakeServer((path, body) => {
        if (path !== '/v1/auth/refresh') return { status: 404, body: {} };
        if (body.refreshToken !== valid) return { status: 401, body: { error: 'invalid_grant', reason: 'reused' } };
        n += 1;
        valid = `rt-${n}`;
        return { status: 200, body: { accessToken: makeJwt(900), refreshToken: valid } };
    });
}

function memoryStorage(initial: StoredCredentials | null) {
    const state = { value: initial };
    return {
        state,
        read: vi.fn(async () => state.value),
        write: vi.fn(async (c: StoredCredentials) => { state.value = c; }),
        clearIfRefreshToken: vi.fn(async (refreshToken: string) => {
            if (state.value?.refreshToken === refreshToken) state.value = null;
        }),
    };
}

function mutex() {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(fn: () => Promise<T>): Promise<T> => {
        const run = tail.then(fn);
        tail = run.then(() => undefined, () => undefined);
        return run;
    };
}

const stores: TokenStore[] = [];
function track(store: TokenStore): TokenStore {
    stores.push(store);
    return store;
}
afterEach(() => {
    stores.splice(0).forEach((store) => store.stop());
    vi.useRealTimers();
});

function deps(storage: ReturnType<typeof memoryStorage>, fetchImpl: typeof fetch, extra: Partial<TokenStoreDeps> = {}): TokenStoreDeps {
    return {
        serverUrl: () => SERVER,
        read: storage.read,
        write: storage.write,
        clearIfRefreshToken: storage.clearIfRefreshToken,
        onLoggedOut: vi.fn(),
        fetch: fetchImpl,
        clientId: () => 'web/test',
        ...extra,
    };
}

describe('parseStoredCredentials', () => {
    it('accepts complete credentials and rejects legacy or broken values', () => {
        expect(parseStoredCredentials(JSON.stringify(creds('t')))).toEqual(creds('t'));
        expect(parseStoredCredentials(JSON.stringify({ token: 't', secret: 's' }))).toBeNull();
        expect(parseStoredCredentials(JSON.stringify({ token: 't', refreshToken: '', secret: 's' }))).toBeNull();
        expect(parseStoredCredentials('{nope')).toBeNull();
        expect(parseStoredCredentials(null)).toBeNull();
    });
});

describe('TokenStore', () => {
    it('returns a fresh token without calling the server', async () => {
        const token = makeJwt(900);
        const server = rotatingServer();
        const storage = memoryStorage(creds(token));
        const store = track(new TokenStore(creds(token), deps(storage, server.fetchImpl)));
        await expect(store.getAccessToken()).resolves.toBe(token);
        expect(server.calls).toHaveLength(0);
    });

    it('refreshes an expiring token once for concurrent callers and persists the rotation', async () => {
        const stale = makeJwt(60);
        const server = rotatingServer();
        const storage = memoryStorage(creds(stale));
        const store = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl)));
        const results = await Promise.all([store.getAccessToken(), store.getAccessToken(), store.refresh(stale)]);
        expect(new Set(results).size).toBe(1);
        expect(results[0]).not.toBe(stale);
        expect(server.calls).toHaveLength(1);
        expect(server.calls[0]).toMatchObject({ path: '/v1/auth/refresh', body: { refreshToken: 'rt-1' } });
        expect(server.calls[0].headers['X-Happy-Client']).toBe('web/test');
        expect(storage.state.value).toEqual({ token: results[0], refreshToken: 'rt-2', secret: 'root-secret' });
        expect(store.current().refreshToken).toBe('rt-2');
    });

    it('adopts a token another tab already rotated instead of refreshing', async () => {
        const stale = makeJwt(60);
        const server = rotatingServer();
        const rotatedElsewhere = creds(makeJwt(900), 'rt-9');
        const storage = memoryStorage(rotatedElsewhere);
        const store = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl)));
        await expect(store.refresh(stale)).resolves.toBe(rotatedElsewhere.token);
        expect(server.calls).toHaveLength(0);
        expect(store.current()).toEqual(rotatedElsewhere);
    });

    it('redeems the refresh token once when two tabs refresh under a shared lock', async () => {
        const stale = makeJwt(60);
        const server = rotatingServer();
        const storage = memoryStorage(creds(stale));
        const lock = mutex();
        const onLoggedOut = vi.fn();
        const tabA = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl, { withLock: lock, onLoggedOut })));
        const tabB = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl, { withLock: lock, onLoggedOut })));
        const [a, b] = await Promise.all([tabA.getAccessToken(), tabB.getAccessToken()]);
        expect(a).toBe(b);
        expect(server.calls).toHaveLength(1);
        expect(onLoggedOut).not.toHaveBeenCalled();
    });

    it('logs out on invalid_grant: clears storage, notifies once, then rejects', async () => {
        const stale = makeJwt(60);
        const server = fakeServer(() => ({ status: 401, body: { error: 'invalid_grant', reason: 'revoked' } }));
        const storage = memoryStorage(creds(stale));
        const onLoggedOut = vi.fn();
        const store = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl, { onLoggedOut })));
        await expect(store.getAccessToken()).rejects.toBeInstanceOf(LoggedOutError);
        expect(storage.state.value).toBeNull();
        expect(onLoggedOut).toHaveBeenCalledTimes(1);
        await expect(store.getAccessToken()).rejects.toBeInstanceOf(LoggedOutError);
        expect(onLoggedOut).toHaveBeenCalledTimes(1);
    });

    it('keeps credentials on network errors and 5xx', async () => {
        const stale = makeJwt(60);
        const failing = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
        const storage = memoryStorage(creds(stale));
        const onLoggedOut = vi.fn();
        const store = track(new TokenStore(creds(stale), deps(storage, failing, { onLoggedOut })));
        const error = await store.refresh(stale).catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(LoggedOutError);

        const server = fakeServer(() => ({ status: 503, body: {} }));
        const store2 = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl, { onLoggedOut })));
        await expect(store2.refresh(stale)).rejects.toThrow('HTTP 503');
        expect(storage.state.value?.refreshToken).toBe('rt-1');
        expect(onLoggedOut).not.toHaveBeenCalled();
    });

    it('never re-sends a refresh token the server already rotated when persisting fails', async () => {
        const stale = makeJwt(60);
        const server = rotatingServer();
        const storage = memoryStorage(creds(stale));
        storage.write.mockRejectedValueOnce(new Error('quota exceeded'));
        const onLoggedOut = vi.fn();
        const store = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl, { onLoggedOut })));

        const first = await store.getAccessToken();
        expect(store.current().refreshToken).toBe('rt-2');
        expect(store.hasPendingRotation()).toBe(true);
        expect(storage.state.value?.refreshToken).toBe('rt-1');

        await store.refresh(first);
        expect(server.calls.map((call) => call.body.refreshToken)).toEqual(['rt-1', 'rt-2']);
        expect(storage.state.value?.refreshToken).toBe('rt-3');
        expect(store.hasPendingRotation()).toBe(false);
        expect(onLoggedOut).not.toHaveBeenCalled();
    });

    it('refreshes proactively two minutes before expiry', async () => {
        vi.useFakeTimers();
        const token = makeJwt(600);
        const server = rotatingServer();
        const storage = memoryStorage(creds(token));
        const store = track(new TokenStore(creds(token), deps(storage, server.fetchImpl)));
        await vi.advanceTimersByTimeAsync(470_000);
        expect(server.calls).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(server.calls.map((call) => call.path)).toEqual(['/v1/auth/refresh']);
        expect(store.current().refreshToken).toBe('rt-2');
    });

    it('follows other tabs through storage changes', () => {
        const token = makeJwt(900);
        const storage = memoryStorage(creds(token));
        const store = track(new TokenStore(creds(token), deps(storage, rotatingServer().fetchImpl)));
        expect(store.applyExternalChange(JSON.stringify(creds(token)))).toBe('ignored');
        const rotated = creds(makeJwt(900), 'rt-7');
        expect(store.applyExternalChange(JSON.stringify(rotated))).toBe('adopted');
        expect(store.current()).toEqual(rotated);
        expect(store.applyExternalChange(JSON.stringify({ ...rotated, refreshToken: 'rt-8', secret: 'other-account' }))).toBe('reload');
    });

    it('reloads when another tab logs out, without calling onLoggedOut', async () => {
        const token = makeJwt(900);
        const onLoggedOut = vi.fn();
        const store = track(new TokenStore(creds(token), deps(memoryStorage(creds(token)), rotatingServer().fetchImpl, { onLoggedOut })));
        expect(store.applyExternalChange(null)).toBe('reload');
        await expect(store.getAccessToken()).rejects.toBeInstanceOf(LoggedOutError);
        expect(onLoggedOut).not.toHaveBeenCalled();
    });

    it('logs out on the server best-effort and stops', async () => {
        const token = makeJwt(900);
        const server = fakeServer((path) => (path === '/v1/auth/logout' ? { status: 200, body: { success: true } } : { status: 404, body: {} }));
        const onLoggedOut = vi.fn();
        const store = track(new TokenStore(creds(token), deps(memoryStorage(creds(token)), server.fetchImpl, { onLoggedOut })));
        await store.logoutOnServer(1000);
        expect(server.calls).toHaveLength(1);
        expect(server.calls[0].path).toBe('/v1/auth/logout');
        expect(server.calls[0].headers.Authorization).toBe(`Bearer ${token}`);
        expect(server.calls[0].headers['Content-Type']).toBeUndefined();
        expect(onLoggedOut).not.toHaveBeenCalled();
        await expect(store.getAccessToken()).rejects.toBeInstanceOf(LoggedOutError);
    });

    it('gives up on a hanging server logout after the timeout', async () => {
        const token = makeJwt(900);
        const hanging = vi.fn((_input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch;
        const store = track(new TokenStore(creds(token), deps(memoryStorage(creds(token)), hanging)));
        const started = Date.now();
        await store.logoutOnServer(50);
        expect(Date.now() - started).toBeLessThan(2000);
    });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter happy-app exec vitest run sources/auth/tokenStore.test.ts`
Expected: FAIL — cannot resolve `./tokenStore`.

- [ ] **Step 7: Implement `tokenStore.ts`**

```ts
// packages/happy-app/sources/auth/tokenStore.ts
/**
 * Access-token lifecycle: proactive refresh 2 minutes before expiry, single-flight,
 * an optional cross-tab lock, adopt-if-rotated, and invalid_grant → logged out.
 *
 * Pure (no React Native / Expo imports) so it runs under vitest; platform wiring
 * lives in tokenStoreRuntime.ts.
 */
import { decodeJwtExpiry } from './jwt';

export const REFRESH_MARGIN_MS = 2 * 60 * 1000;
export const RETRY_AFTER_ERROR_MS = 30_000;
const MIN_TIMER_MS = 5_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 10_000;
const DEFAULT_LOGOUT_TIMEOUT_MS = 5_000;

export interface StoredCredentials {
    token: string;
    refreshToken: string;
    /** Root secret, base64url (32 bytes). */
    secret: string;
}

/** Stored JSON → credentials. Anything without a token, refresh token and secret is "logged out". */
export function parseStoredCredentials(raw: string | null | undefined): StoredCredentials | null {
    if (!raw) {
        return null;
    }
    try {
        const value = JSON.parse(raw);
        if (
            typeof value?.token === 'string' && value.token.length > 0 &&
            typeof value.refreshToken === 'string' && value.refreshToken.length > 0 &&
            typeof value.secret === 'string' && value.secret.length > 0
        ) {
            return { token: value.token, refreshToken: value.refreshToken, secret: value.secret };
        }
    } catch {
        // fall through
    }
    return null;
}

export class LoggedOutError extends Error {
    constructor() {
        super('Signed out. Please sign in again.');
        this.name = 'LoggedOutError';
    }
}

export interface AccessTokenProvider {
    serverUrl(): string;
    getAccessToken(): Promise<string>;
    refresh(rejectedToken: string): Promise<string>;
}

export interface TokenStoreDeps {
    serverUrl(): string;
    /** Latest persisted credentials (web: another tab may have rotated them). Omit on native. */
    read?(): Promise<StoredCredentials | null>;
    /** Persist credentials; must throw when they could not be persisted. */
    write(credentials: StoredCredentials): Promise<void>;
    /** Remove persisted credentials only if they still hold `refreshToken`. */
    clearIfRefreshToken(refreshToken: string): Promise<void>;
    /** The server rejected the refresh token: run the app's logout path. */
    onLoggedOut(): void;
    /** Cross-tab mutual exclusion for refresh (web: navigator.locks). */
    withLock?<T>(fn: () => Promise<T>): Promise<T>;
    fetch?: typeof fetch;
    clientId?(): string;
    now?(): number;
    refreshTimeoutMs?: number;
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); },
        );
    });
}

export class TokenStore implements AccessTokenProvider {
    private credentials: StoredCredentials;
    /** A rotation the server already issued but storage rejected. Never re-send the older refresh token. */
    private pendingRotation: StoredCredentials | null = null;
    private inflight: Promise<string> | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;
    /** Set during an intentional logout so a failing refresh does not trigger a second logout. */
    private silent = false;

    constructor(initial: StoredCredentials, private readonly deps: TokenStoreDeps) {
        this.credentials = initial;
        this.schedule();
    }

    serverUrl(): string {
        return this.deps.serverUrl();
    }

    current(): StoredCredentials {
        return this.credentials;
    }

    hasPendingRotation(): boolean {
        return this.pendingRotation !== null;
    }

    getAccessToken(): Promise<string> {
        if (this.stopped) {
            return Promise.reject(new LoggedOutError());
        }
        if (this.inflight) {
            return this.inflight;
        }
        const token = this.credentials.token;
        return this.isFresh(token) ? Promise.resolve(token) : this.refresh(token);
    }

    refresh(rejectedToken: string): Promise<string> {
        if (this.stopped) {
            return Promise.reject(new LoggedOutError());
        }
        if (!this.inflight) {
            this.inflight = this.runRefresh(rejectedToken)
                .then(
                    (credentials) => {
                        this.credentials = credentials;
                        // A pending rotation still needs to reach storage; retry soon.
                        this.schedule(this.pendingRotation ? RETRY_AFTER_ERROR_MS : undefined);
                        return credentials.token;
                    },
                    (error: unknown) => {
                        if (error instanceof LoggedOutError) {
                            this.signOut();
                        } else {
                            this.schedule(RETRY_AFTER_ERROR_MS);
                        }
                        throw error;
                    },
                )
                .finally(() => {
                    this.inflight = null;
                });
        }
        return this.inflight;
    }

    /** Another tab changed the stored credentials (`storage` event). `raw` is the new value. */
    applyExternalChange(raw: string | null): 'reload' | 'adopted' | 'ignored' {
        if (this.stopped) {
            return 'ignored';
        }
        if (raw === null) {
            this.silent = true;
            this.stop();
            return 'reload';
        }
        const next = parseStoredCredentials(raw);
        if (!next || next.refreshToken === this.credentials.refreshToken) {
            return 'ignored';
        }
        if (next.secret !== this.credentials.secret) {
            // A different account signed in elsewhere; this tab's keys are stale.
            this.silent = true;
            this.stop();
            return 'reload';
        }
        this.credentials = next;
        this.pendingRotation = null;
        this.schedule();
        return 'adopted';
    }

    /** Best-effort `POST /v1/auth/logout`, then stop. Never triggers onLoggedOut. */
    async logoutOnServer(timeoutMs = DEFAULT_LOGOUT_TIMEOUT_MS): Promise<void> {
        this.silent = true;
        try {
            const token = await withTimeout(this.getAccessToken(), timeoutMs);
            await this.fetchWithTimeout(`${this.deps.serverUrl()}/v1/auth/logout`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, ...this.clientHeader() },
            }, timeoutMs);
        } catch {
            // Best effort: the local wipe happens regardless.
        } finally {
            this.stop();
        }
    }

    stop(): void {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private signOut(): void {
        const notify = !this.stopped && !this.silent;
        this.stop();
        if (notify) {
            this.deps.onLoggedOut();
        }
    }

    private runRefresh(rejectedToken: string): Promise<StoredCredentials> {
        const work = () => this.adoptOrRefresh(rejectedToken);
        return this.deps.withLock ? this.deps.withLock(work) : work();
    }

    private async adoptOrRefresh(rejectedToken: string): Promise<StoredCredentials> {
        if (this.pendingRotation) {
            const pending = this.pendingRotation;
            try {
                await this.deps.write(pending);
                this.pendingRotation = null;
            } catch {
                // Still pending; keep serving it from memory.
            }
            if (pending.token !== rejectedToken && this.isFresh(pending.token)) {
                return pending;
            }
            return this.redeem(pending);
        }
        const stored = this.deps.read ? await this.deps.read() : this.credentials;
        if (!stored) {
            throw new LoggedOutError();
        }
        if (stored.token !== rejectedToken && this.isFresh(stored.token)) {
            return stored;
        }
        return this.redeem(stored);
    }

    private async redeem(base: StoredCredentials): Promise<StoredCredentials> {
        let response: Response;
        try {
            response = await this.fetchWithTimeout(`${this.deps.serverUrl()}/v1/auth/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this.clientHeader() },
                body: JSON.stringify({ refreshToken: base.refreshToken }),
            }, this.deps.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS);
        } catch (error) {
            throw new Error(`Token refresh failed: ${error instanceof Error ? error.message : 'network error'}`);
        }
        if (response.status === 401) {
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (body?.error === 'invalid_grant') {
                try {
                    await this.deps.clearIfRefreshToken(base.refreshToken);
                } catch {
                    // The logout path wipes storage anyway.
                }
                throw new LoggedOutError();
            }
        }
        if (!response.ok) {
            throw new Error(`Token refresh failed: HTTP ${response.status}`);
        }
        const data = await response.json() as { accessToken?: unknown; refreshToken?: unknown };
        if (typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string') {
            throw new Error('Token refresh failed: invalid response');
        }
        const rotated: StoredCredentials = { ...base, token: data.accessToken, refreshToken: data.refreshToken };
        try {
            await this.deps.write(rotated);
            this.pendingRotation = null;
        } catch {
            this.pendingRotation = rotated;
        }
        return rotated;
    }

    private schedule(delayOverrideMs?: number): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.stopped) {
            return;
        }
        const exp = decodeJwtExpiry(this.credentials.token);
        if (exp === null && delayOverrideMs === undefined) {
            return;
        }
        const delay = delayOverrideMs ?? Math.max(MIN_TIMER_MS, exp! - this.now() - REFRESH_MARGIN_MS);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.refresh(this.credentials.token).catch(() => {
                // refresh() already rescheduled or signed out.
            });
        }, delay);
    }

    private isFresh(token: string): boolean {
        const exp = decodeJwtExpiry(token);
        return exp !== null && exp - this.now() > REFRESH_MARGIN_MS;
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    private clientHeader(): Record<string, string> {
        return this.deps.clientId ? { 'X-Happy-Client': this.deps.clientId() } : {};
    }

    private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const fetchImpl = this.deps.fetch ?? ((input: RequestInfo | URL, options?: RequestInit) => fetch(input, options));
            return await fetchImpl(url, { ...init, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm --filter happy-app exec vitest run sources/auth/tokenStore.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 9: Write the failing `authFetch` test**

```ts
// packages/happy-app/sources/auth/authFetch.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authFetch, getAccessToken, headersToRecord, setAccessTokenProvider, staticAccessTokenProvider } from './authFetch';
import { LoggedOutError, type AccessTokenProvider } from './tokenStore';

const SERVER = 'https://happy.test';

afterEach(() => {
    setAccessTokenProvider(null);
    vi.unstubAllGlobals();
});

function stubFetch(...statuses: number[]) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: statuses.shift() ?? 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('authFetch', () => {
    it('attaches the current access token to server requests and keeps other headers', async () => {
        setAccessTokenProvider(staticAccessTokenProvider('tok-1', SERVER));
        const fetchMock = stubFetch(200);
        await authFetch(`${SERVER}/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        expect(fetchMock).toHaveBeenCalledWith(`${SERVER}/v1/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-1' },
            body: '{}',
        });
    });

    it('retries a 401 once with a refreshed token', async () => {
        const refresh = vi.fn(async () => 'tok-new');
        const provider: AccessTokenProvider = { serverUrl: () => SERVER, getAccessToken: async () => 'tok-old', refresh };
        setAccessTokenProvider(provider);
        const fetchMock = stubFetch(401, 200);
        const response = await authFetch(`${SERVER}/v1/machines`);
        expect(response.status).toBe(200);
        expect(refresh).toHaveBeenCalledWith('tok-old');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect((fetchMock.mock.calls[1] as any)[1].headers.Authorization).toBe('Bearer tok-new');
    });

    it('returns the second 401 without retrying again', async () => {
        setAccessTokenProvider(staticAccessTokenProvider('tok-1', SERVER));
        const fetchMock = stubFetch(401, 401, 200);
        const response = await authFetch(`${SERVER}/v1/machines`);
        expect(response.status).toBe(401);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('passes requests to other origins through untouched and never retries them', async () => {
        const refresh = vi.fn(async () => 'tok-new');
        setAccessTokenProvider({ serverUrl: () => SERVER, getAccessToken: async () => 'tok-1', refresh });
        const fetchMock = stubFetch(401);
        const response = await authFetch('https://files.test/blob?sig=1');
        expect(response.status).toBe(401);
        expect(fetchMock).toHaveBeenCalledWith('https://files.test/blob?sig=1', undefined);
        const other = stubFetch(200);
        await authFetch('https://happy.test:444/v1/x', { headers: { A: 'b' } });
        expect(other).toHaveBeenCalledWith('https://happy.test:444/v1/x', { headers: { A: 'b' } });
        expect(refresh).not.toHaveBeenCalled();
    });

    it('rejects with LoggedOutError when nobody is signed in', async () => {
        stubFetch(200);
        await expect(authFetch(`${SERVER}/v1/x`)).rejects.toBeInstanceOf(LoggedOutError);
        await expect(getAccessToken()).rejects.toBeInstanceOf(LoggedOutError);
    });
});

describe('headersToRecord', () => {
    it('accepts Headers, tuples and plain objects', () => {
        expect(headersToRecord(new Headers({ 'X-A': '1' }))).toEqual({ 'x-a': '1' });
        expect(headersToRecord([['X-B', '2']])).toEqual({ 'X-B': '2' });
        expect(headersToRecord({ 'X-C': '3' })).toEqual({ 'X-C': '3' });
        expect(headersToRecord(undefined)).toEqual({});
    });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm --filter happy-app exec vitest run sources/auth/authFetch.test.ts`
Expected: FAIL — cannot resolve `./authFetch`.

- [ ] **Step 11: Implement `authFetch.ts`**

```ts
// packages/happy-app/sources/auth/authFetch.ts
/**
 * The one place that attaches the access token to HTTP requests. Pure (no React
 * Native imports): the runtime registers the TokenStore via setAccessTokenProvider.
 */
import { LoggedOutError, type AccessTokenProvider } from './tokenStore';

let provider: AccessTokenProvider | null = null;

export function setAccessTokenProvider(next: AccessTokenProvider | null): void {
    provider = next;
}

export function getAccessToken(): Promise<string> {
    return provider ? provider.getAccessToken() : Promise.reject(new LoggedOutError());
}

export function headersToRecord(headers?: HeadersInit): Record<string, string> {
    if (!headers) {
        return {};
    }
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        const record: Record<string, string> = {};
        headers.forEach((value, key) => { record[key] = value; });
        return record;
    }
    if (Array.isArray(headers)) {
        return Object.fromEntries(headers);
    }
    return { ...(headers as Record<string, string>) };
}

function sameOrigin(url: string, serverUrl: string): boolean {
    try {
        return new URL(url).origin === new URL(serverUrl).origin;
    } catch {
        return false;
    }
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
    return { ...init, headers: { ...headersToRecord(init?.headers), Authorization: `Bearer ${token}` } };
}

/**
 * fetch() for the Happy server: attaches `Authorization: Bearer <access token>` and
 * retries once after a 401 with a refreshed token. Other origins (presigned storage
 * URLs, CDNs) are passed through untouched. Bodies must be re-sendable (string,
 * ArrayBuffer, Blob, FormData), which every caller in this app uses.
 */
export async function authFetch(url: string, init?: RequestInit): Promise<Response> {
    const current = provider;
    if (!current) {
        throw new LoggedOutError();
    }
    if (!sameOrigin(url, current.serverUrl())) {
        return fetch(url, init);
    }
    const token = await current.getAccessToken();
    const response = await fetch(url, withBearer(init, token));
    if (response.status !== 401) {
        return response;
    }
    const fresh = await current.refresh(token);
    return fetch(url, withBearer(init, fresh));
}

/** A provider with a fixed token, for tests. */
export function staticAccessTokenProvider(token: string, serverUrl: string): AccessTokenProvider {
    return {
        serverUrl: () => serverUrl,
        getAccessToken: async () => token,
        refresh: async () => token,
    };
}
```

- [ ] **Step 12: Run the new tests, the suite and typecheck**

Run: `pnpm --filter happy-app exec vitest run sources/auth sources/utils/parseToken.test.ts`
Expected: PASS (all tests in `jwt`, `tokenStore`, `authFetch`, `parseToken`).

Run: `pnpm --filter happy-app exec vitest run` — suite green (only the baseline `sessionPresentation.test.ts` failure).
Run: `pnpm --filter happy-app typecheck` — exit 0.

- [ ] **Step 13: Commit**

```bash
git add packages/happy-app/sources/auth/jwt.ts packages/happy-app/sources/auth/jwt.test.ts \
  packages/happy-app/sources/auth/tokenStore.ts packages/happy-app/sources/auth/tokenStore.test.ts \
  packages/happy-app/sources/auth/authFetch.ts packages/happy-app/sources/auth/authFetch.test.ts \
  packages/happy-app/sources/utils/parseToken.ts packages/happy-app/sources/utils/parseToken.test.ts
git commit -m "feat: add app token store with single-flight refresh"
```

---

### Task 2: OIDC login primitives

**Files:**
- Create: `packages/happy-app/sources/auth/callbackUrls.ts`, `packages/happy-app/sources/auth/oidcLogin.ts`
- Test: `sources/auth/callbackUrls.test.ts`, `sources/auth/oidcLogin.test.ts`

**Interfaces:**
- Consumes: `StoredCredentials` (Task 1); `generatePKCE` from `@/utils/oauth` (`{ verifier, challenge }`, S256, base64url); `decryptBox` from `@/encryption/libsodium`; `sodium.crypto_box_keypair()` from `@/encryption/libsodium.lib`; `encodeBase64` / `decodeBase64` from `@/encryption/base64`.
- Produces:
  ```ts
  // callbackUrls.ts (no imports)
  function parseWebCallbackHash(hash: string): string | null
  function parseMobileCallbackUrl(url: string, redirectUri: string): string | null
  function isAuthCallbackPath(path: string): boolean
  // oidcLogin.ts
  interface PendingLogin { codeVerifier: string; codeChallenge: string; publicKey: string; secretKey: string }  // keys base64
  class OidcLoginError extends Error {}
  function createPendingLogin(): Promise<PendingLogin>
  function buildLoginUrl(opts: { serverUrl: string; pending: PendingLogin } & ({ client: 'web' } | { client: 'mobile'; redirectUri: string })): string
  function serializePendingLogin(pending: PendingLogin): string
  function deserializePendingLogin(raw: string): PendingLogin | null
  function exchangeCode(opts: { serverUrl: string; code: string; pending: PendingLogin; deviceName: string; fetchImpl?: typeof fetch }): Promise<StoredCredentials>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/happy-app/sources/auth/callbackUrls.test.ts
import { describe, expect, it } from 'vitest';
import { isAuthCallbackPath, parseMobileCallbackUrl, parseWebCallbackHash } from './callbackUrls';

describe('parseWebCallbackHash', () => {
    it('reads the exchange code from the fragment', () => {
        expect(parseWebCallbackHash('#code=abc_DEF-123')).toBe('abc_DEF-123');
        expect(parseWebCallbackHash('code=a%2Bb')).toBe('a+b');
    });
    it('returns null without a code', () => {
        expect(parseWebCallbackHash('')).toBeNull();
        expect(parseWebCallbackHash('#error=access_denied')).toBeNull();
        expect(parseWebCallbackHash('#code=')).toBeNull();
    });
});

describe('parseMobileCallbackUrl', () => {
    const redirect = 'corpapp://auth/callback';
    it('reads the code from the configured redirect URI', () => {
        expect(parseMobileCallbackUrl('corpapp://auth/callback?code=xyz', redirect)).toBe('xyz');
    });
    it('ignores other URLs and missing codes', () => {
        expect(parseMobileCallbackUrl('evil://auth/callback?code=xyz', redirect)).toBeNull();
        expect(parseMobileCallbackUrl('corpapp://auth/callback', redirect)).toBeNull();
        expect(parseMobileCallbackUrl('corpapp://auth/callback?state=1', redirect)).toBeNull();
    });
});

describe('isAuthCallbackPath', () => {
    it('matches the callback as a URL or a router path', () => {
        expect(isAuthCallbackPath('corpapp://auth/callback?code=1')).toBe(true);
        expect(isAuthCallbackPath('/auth/callback?code=1')).toBe(true);
        expect(isAuthCallbackPath('auth/callback')).toBe(true);
    });
    it('does not match other paths', () => {
        expect(isAuthCallbackPath('/session/abc')).toBe(false);
        expect(isAuthCallbackPath('/auth/callbacks')).toBe(false);
        expect(isAuthCallbackPath('corpapp://session/auth/callback')).toBe(false);
    });
});
```

```ts
// packages/happy-app/sources/auth/oidcLogin.test.ts
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('expo-crypto', () => ({
    getRandomBytes: (size: number) => new Uint8Array(randomBytes(size)),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256', SHA512: 'SHA-512' },
    digest: (algorithm: string, bytes: Uint8Array) => webcrypto.subtle.digest(algorithm, bytes),
}));
vi.mock('@/encryption/libsodium.lib', () => ({ default: sodium }));

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import {
    OidcLoginError,
    buildLoginUrl,
    createPendingLogin,
    deserializePendingLogin,
    exchangeCode,
    serializePendingLogin,
} from './oidcLogin';

const SERVER = 'https://happy.test';

beforeAll(async () => {
    await sodium.ready;
});

function exchangeServer(respond: (body: any) => { status: number; body: unknown }) {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const body = JSON.parse(String(init.body));
        calls.push({ url: String(input), body, headers: init.headers });
        const result = respond(body);
        return new Response(JSON.stringify(result.body), { status: result.status });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
}

describe('createPendingLogin', () => {
    it('creates an S256 challenge the server accepts and a 32-byte box keypair', async () => {
        const pending = await createPendingLogin();
        // Mirrors happy-server redeemExchangeCode.
        expect(createHash('sha256').update(pending.codeVerifier).digest('base64url')).toBe(pending.codeChallenge);
        expect(pending.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
        expect(decodeBase64(pending.publicKey)).toHaveLength(32);
        expect(decodeBase64(pending.secretKey)).toHaveLength(32);
        const other = await createPendingLogin();
        expect(other.codeVerifier).not.toBe(pending.codeVerifier);
        expect(other.publicKey).not.toBe(pending.publicKey);
    });

    it('round-trips through sessionStorage serialization', async () => {
        const pending = await createPendingLogin();
        expect(deserializePendingLogin(serializePendingLogin(pending))).toEqual(pending);
        expect(deserializePendingLogin('{"codeVerifier":1}')).toBeNull();
        expect(deserializePendingLogin('nope')).toBeNull();
    });
});

describe('buildLoginUrl', () => {
    it('builds web and mobile login URLs', async () => {
        const pending = await createPendingLogin();
        const web = new URL(buildLoginUrl({ serverUrl: SERVER, pending, client: 'web' }));
        expect(web.origin + web.pathname).toBe(`${SERVER}/v1/auth/oidc/login`);
        expect(web.searchParams.get('client')).toBe('web');
        expect(web.searchParams.get('code_challenge')).toBe(pending.codeChallenge);
        expect(web.searchParams.has('redirect_uri')).toBe(false);

        const mobile = new URL(buildLoginUrl({ serverUrl: SERVER, pending, client: 'mobile', redirectUri: 'corpapp://auth/callback' }));
        expect(mobile.searchParams.get('client')).toBe('mobile');
        expect(mobile.searchParams.get('redirect_uri')).toBe('corpapp://auth/callback');
    });
});

describe('exchangeCode', () => {
    it('redeems the code and opens the key bundle', async () => {
        const pending = await createPendingLogin();
        const rootSecret = new Uint8Array(randomBytes(32));
        const server = exchangeServer((body) => ({
            status: 200,
            body: {
                accountId: 'acc_1',
                accessToken: 'access-1',
                refreshToken: 'refresh-1',
                keyBundle: encodeBase64(encryptBox(rootSecret, decodeBase64(body.ephemeralPublicKey))),
            },
        }));
        const credentials = await exchangeCode({ serverUrl: SERVER, code: 'code-1', pending, deviceName: 'Web', fetchImpl: server.fetchImpl });
        expect(credentials).toEqual({ token: 'access-1', refreshToken: 'refresh-1', secret: encodeBase64(rootSecret, 'base64url') });
        expect(server.calls[0].url).toBe(`${SERVER}/v1/auth/oidc/exchange`);
        expect(server.calls[0].body).toEqual({
            code: 'code-1',
            codeVerifier: pending.codeVerifier,
            ephemeralPublicKey: pending.publicKey,
            deviceName: 'Web',
        });
    });

    it('explains an expired or reused code', async () => {
        const pending = await createPendingLogin();
        const server = exchangeServer(() => ({ status: 400, body: { error: 'invalid_grant' } }));
        await expect(exchangeCode({ serverUrl: SERVER, code: 'c', pending, deviceName: 'Web', fetchImpl: server.fetchImpl }))
            .rejects.toThrow(/expired or was already used/);
    });

    it('rejects a key bundle that was not sealed to this login', async () => {
        const pending = await createPendingLogin();
        const stranger = sodium.crypto_box_keypair();
        const server = exchangeServer(() => ({
            status: 200,
            body: {
                accessToken: 'a', refreshToken: 'r',
                keyBundle: encodeBase64(encryptBox(new Uint8Array(32), stranger.publicKey)),
            },
        }));
        const error = await exchangeCode({ serverUrl: SERVER, code: 'c', pending, deviceName: 'Web', fetchImpl: server.fetchImpl }).catch((e) => e);
        expect(error).toBeInstanceOf(OidcLoginError);
        expect(error.message).toMatch(/key bundle/i);
    });

    it('reports network failures', async () => {
        const pending = await createPendingLogin();
        const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
        await expect(exchangeCode({ serverUrl: SERVER, code: 'c', pending, deviceName: 'Web', fetchImpl }))
            .rejects.toThrow(/reach the server/);
    });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter happy-app exec vitest run sources/auth/callbackUrls.test.ts sources/auth/oidcLogin.test.ts`
Expected: FAIL — cannot resolve `./callbackUrls` / `./oidcLogin`.

- [ ] **Step 3: Implement `callbackUrls.ts`**

```ts
// packages/happy-app/sources/auth/callbackUrls.ts
/** Parsing for the OIDC sign-in return URLs. No imports: loaded before the router starts. */

/** Web: the server redirects to `${WEBAPP_URL}/auth/callback#code=<exchangeCode>`. */
export function parseWebCallbackHash(hash: string): string | null {
    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    return params.get('code') || null;
}

/** Mobile: the server redirects to `${redirectUri}?code=<exchangeCode>`. */
export function parseMobileCallbackUrl(url: string, redirectUri: string): string | null {
    if (!url.startsWith(`${redirectUri}?`)) {
        return null;
    }
    return new URLSearchParams(url.slice(redirectUri.length + 1)).get('code') || null;
}

/** `scheme://auth/callback…`, `/auth/callback…` or `auth/callback…`. */
export function isAuthCallbackPath(path: string): boolean {
    return /^(?:[a-z][a-z0-9+.-]*:\/\/|\/)?auth\/callback(?:[?#]|$)/i.test(path);
}
```

- [ ] **Step 4: Implement `oidcLogin.ts`**

```ts
// packages/happy-app/sources/auth/oidcLogin.ts
/**
 * App side of the server-brokered OIDC login (spec §2 "Web app" / "Mobile"):
 * a PKCE pair binds the exchange code to this app instance, and an ephemeral box
 * keypair receives the root secret sealed by the server.
 */
import sodium from '@/encryption/libsodium.lib';
import { decryptBox } from '@/encryption/libsodium';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { generatePKCE } from '@/utils/oauth';
import type { StoredCredentials } from './tokenStore';

export interface PendingLogin {
    codeVerifier: string;
    codeChallenge: string;
    /** Ephemeral box public key, base64. */
    publicKey: string;
    /** Ephemeral box secret key, base64. Lives only until the exchange. */
    secretKey: string;
}

export class OidcLoginError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OidcLoginError';
    }
}

export async function createPendingLogin(): Promise<PendingLogin> {
    const { verifier, challenge } = await generatePKCE();
    const keypair = sodium.crypto_box_keypair();
    return {
        codeVerifier: verifier,
        codeChallenge: challenge,
        publicKey: encodeBase64(keypair.publicKey),
        secretKey: encodeBase64(keypair.privateKey),
    };
}

export function buildLoginUrl(
    opts: { serverUrl: string; pending: PendingLogin } & ({ client: 'web' } | { client: 'mobile'; redirectUri: string }),
): string {
    const params = new URLSearchParams({ client: opts.client, code_challenge: opts.pending.codeChallenge });
    if (opts.client === 'mobile') {
        params.set('redirect_uri', opts.redirectUri);
    }
    return `${opts.serverUrl}/v1/auth/oidc/login?${params.toString()}`;
}

export function serializePendingLogin(pending: PendingLogin): string {
    return JSON.stringify(pending);
}

export function deserializePendingLogin(raw: string): PendingLogin | null {
    try {
        const value = JSON.parse(raw);
        const fields = ['codeVerifier', 'codeChallenge', 'publicKey', 'secretKey'] as const;
        if (value && fields.every((field) => typeof value[field] === 'string' && value[field].length > 0)) {
            return {
                codeVerifier: value.codeVerifier,
                codeChallenge: value.codeChallenge,
                publicKey: value.publicKey,
                secretKey: value.secretKey,
            };
        }
    } catch {
        // fall through
    }
    return null;
}

export async function exchangeCode(opts: {
    serverUrl: string;
    code: string;
    pending: PendingLogin;
    deviceName: string;
    fetchImpl?: typeof fetch;
}): Promise<StoredCredentials> {
    const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    let response: Response;
    try {
        response = await fetchImpl(`${opts.serverUrl}/v1/auth/oidc/exchange`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: opts.code,
                codeVerifier: opts.pending.codeVerifier,
                ephemeralPublicKey: opts.pending.publicKey,
                deviceName: opts.deviceName.slice(0, 100),
            }),
        });
    } catch {
        throw new OidcLoginError('Could not reach the server. Check your connection and try again.');
    }
    if (response.status === 400) {
        throw new OidcLoginError('This sign-in link has expired or was already used. Please sign in again.');
    }
    if (!response.ok) {
        throw new OidcLoginError(`Sign-in failed (HTTP ${response.status}). Please try again.`);
    }
    const data = await response.json() as { accessToken?: unknown; refreshToken?: unknown; keyBundle?: unknown };
    if (typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string' || typeof data.keyBundle !== 'string') {
        throw new OidcLoginError('The server returned an invalid sign-in response.');
    }
    // 'base64url' decoding also accepts standard base64 (what the server sends).
    const secret = decryptBox(decodeBase64(data.keyBundle, 'base64url'), decodeBase64(opts.pending.secretKey));
    if (!secret || secret.length !== 32) {
        throw new OidcLoginError('The server returned an invalid key bundle.');
    }
    return {
        token: data.accessToken,
        refreshToken: data.refreshToken,
        secret: encodeBase64(secret, 'base64url'),
    };
}
```

- [ ] **Step 5: Run them to verify they pass**

Run: `pnpm --filter happy-app exec vitest run sources/auth/callbackUrls.test.ts sources/auth/oidcLogin.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter happy-app typecheck` — exit 0. (If `crypto_box_keypair()`'s TypeScript type for the RN libsodium binding names the secret half differently, check `sources/encryption/libsodium.ts:encryptBox`, which uses `.privateKey` on the same call.)

```bash
git add packages/happy-app/sources/auth/callbackUrls.ts packages/happy-app/sources/auth/callbackUrls.test.ts \
  packages/happy-app/sources/auth/oidcLogin.ts packages/happy-app/sources/auth/oidcLogin.test.ts
git commit -m "feat: add OIDC login primitives for the app"
```

---

### Task 3: Sign in with OIDC (web callback, mobile auth session, credentials, logout)

**Files:**
- Rewrite: `packages/happy-app/sources/auth/tokenStorage.ts`
- Create: `sources/auth/tokenStoreRuntime.ts`, `sources/auth/logout.ts`, `sources/auth/signIn.ts`, `sources/auth/webCallback.ts`, `sources/app/(app)/auth/callback.tsx`, `sources/app/+native-intent.tsx`
- Modify: `packages/happy-app/index.ts`, `sources/auth/AuthContext.tsx`, `sources/app/_layout.tsx:9,39,185-250,280-322`, `sources/app/(app)/_layout.tsx:186,202-220`, `sources/app/(app)/index.tsx:1-20,52-114,131,148`
- Delete: `sources/app/(app)/restore/index.tsx`, `sources/app/(app)/restore/manual.tsx`
- Modify fixtures: `sources/sync/apiAttachments.test.ts`, `apiProjects.test.ts`, `apiGithub.spec.ts`, `sessionAvatars.test.ts`, `projects.test.ts`, `sync.send.test.ts`, `sync.preload.test.ts` (add `refreshToken`)
- Test: `sources/auth/tokenStorage.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 (`TokenStore`, `parseStoredCredentials`, `StoredCredentials`, `withTimeout`, `setAccessTokenProvider`, `createPendingLogin`, `buildLoginUrl`, `exchangeCode`, `(de)serializePendingLogin`, `OidcLoginError`, `parseWebCallbackHash`, `parseMobileCallbackUrl`, `isAuthCallbackPath`); `getServerUrl` (`@/sync/serverConfig`), `getHappyClientId` (`@/sync/apiSocket`), `syncCreate`/`syncRestore` (`@/sync/sync`), `clearPersistence`/`loadRegisteredPushToken` (`@/sync/persistence`), `unregisterPushToken` (`@/sync/apiPush`).
- Produces:
  ```ts
  // tokenStorage.ts
  const AUTH_KEY = 'auth_credentials';
  type AuthCredentials = StoredCredentials;
  const TokenStorage: {
    getCredentials(): Promise<AuthCredentials | null>;       // removes and returns null for values without a refresh token
    setCredentials(c: AuthCredentials): Promise<boolean>;
    removeCredentials(): Promise<boolean>;
    removeCredentialsIfRefreshToken(refreshToken: string): Promise<void>;
  }
  // tokenStoreRuntime.ts
  function startTokenStore(credentials: AuthCredentials): TokenStore   // replaces any previous store; registers it with authFetch
  function getRuntimeTokenStore(): TokenStore | null
  // logout.ts
  function wipeLocalSessionAndReload(): Promise<void>
  // signIn.ts
  function getAppScheme(): string
  function signIn(): Promise<AuthCredentials | null>                   // web: navigates away (null); native: credentials or null on cancel
  function completeWebSignIn(code: string): Promise<AuthCredentials>
  // webCallback.ts
  function takeWebCallbackCode(): string | null
  // AuthContext.tsx
  login(credentials: AuthCredentials): Promise<void>;  logout(): Promise<void>
  ```

- [ ] **Step 1: Write the failing token storage test**

```ts
// packages/happy-app/sources/auth/tokenStorage.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-secure-store', () => ({}));

import { AUTH_KEY, TokenStorage } from './tokenStorage';

let store: Map<string, string>;
let throwOnSet = false;

beforeEach(() => {
    store = new Map();
    throwOnSet = false;
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
            if (throwOnSet) throw new Error('QuotaExceededError');
            store.set(key, String(value));
        },
        removeItem: (key: string) => { store.delete(key); },
    });
});

const creds = { token: 'access-1', refreshToken: 'refresh-1', secret: 'secret-1' };

describe('TokenStorage (web)', () => {
    it('round-trips credentials', async () => {
        await expect(TokenStorage.setCredentials(creds)).resolves.toBe(true);
        await expect(TokenStorage.getCredentials()).resolves.toEqual(creds);
    });

    it('treats pre-OIDC credentials as logged out and removes them', async () => {
        store.set(AUTH_KEY, JSON.stringify({ token: 'legacy', secret: 'legacy-secret' }));
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
        expect(store.has(AUTH_KEY)).toBe(false);
    });

    it('removes credentials only when they still hold the given refresh token', async () => {
        await TokenStorage.setCredentials(creds);
        await TokenStorage.removeCredentialsIfRefreshToken('other');
        expect(store.has(AUTH_KEY)).toBe(true);
        await TokenStorage.removeCredentialsIfRefreshToken('refresh-1');
        expect(store.has(AUTH_KEY)).toBe(false);
    });

    it('reports a failed write', async () => {
        throwOnSet = true;
        await expect(TokenStorage.setCredentials(creds)).resolves.toBe(false);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy-app exec vitest run sources/auth/tokenStorage.test.ts`
Expected: FAIL — `AUTH_KEY` / `removeCredentialsIfRefreshToken` are not exported, and legacy credentials are returned.

- [ ] **Step 3: Rewrite `tokenStorage.ts`**

```ts
// packages/happy-app/sources/auth/tokenStorage.ts
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { parseStoredCredentials, type StoredCredentials } from './tokenStore';

export const AUTH_KEY = 'auth_credentials';

/** `{ token, refreshToken, secret }`; see tokenStore.ts. */
export type AuthCredentials = StoredCredentials;

async function readRaw(): Promise<string | null> {
    if (Platform.OS === 'web') {
        return localStorage.getItem(AUTH_KEY);
    }
    return SecureStore.getItemAsync(AUTH_KEY);
}

export const TokenStorage = {
    /** Null when nothing usable is stored. Pre-OIDC values (no refresh token) are removed. */
    async getCredentials(): Promise<AuthCredentials | null> {
        let raw: string | null;
        try {
            raw = await readRaw();
        } catch (error) {
            console.error('Error getting credentials:', error);
            return null;
        }
        const credentials = parseStoredCredentials(raw);
        if (raw && !credentials) {
            await TokenStorage.removeCredentials();
        }
        return credentials;
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        const json = JSON.stringify(credentials);
        try {
            if (Platform.OS === 'web') {
                localStorage.setItem(AUTH_KEY, json);
            } else {
                await SecureStore.setItemAsync(AUTH_KEY, json);
            }
            return true;
        } catch (error) {
            console.error('Error setting credentials:', error);
            return false;
        }
    },

    async removeCredentials(): Promise<boolean> {
        try {
            if (Platform.OS === 'web') {
                localStorage.removeItem(AUTH_KEY);
            } else {
                await SecureStore.deleteItemAsync(AUTH_KEY);
            }
            return true;
        } catch (error) {
            console.error('Error removing credentials:', error);
            return false;
        }
    },

    /** Leaves newer credentials (another tab's fresh sign-in) alone. */
    async removeCredentialsIfRefreshToken(refreshToken: string): Promise<void> {
        const current = await TokenStorage.getCredentials();
        if (current?.refreshToken === refreshToken) {
            await TokenStorage.removeCredentials();
        }
    },
};
```

Run: `pnpm --filter happy-app exec vitest run sources/auth/tokenStorage.test.ts` — expected PASS (4 tests).

- [ ] **Step 4: Create the logout helper and the runtime wiring**

```ts
// packages/happy-app/sources/auth/logout.ts
import { Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { clearPersistence } from '@/sync/persistence';
import { TokenStorage } from './tokenStorage';

/**
 * Local half of every logout: wipe persisted state and credentials, then restart the app.
 * The web restarts at `/`: there is no route guard, so reloading a deep link such as
 * /settings/account would render it without an account instead of the sign-in screen.
 */
export async function wipeLocalSessionAndReload(): Promise<void> {
    clearPersistence();
    await TokenStorage.removeCredentials();
    if (Platform.OS === 'web') {
        window.location.replace('/');
        return;
    }
    try {
        await Updates.reloadAsync();
    } catch (error) {
        // In dev builds reloadAsync throws ERR_UPDATES_DISABLED.
        console.log('Reload failed (expected in dev mode):', error);
    }
}
```

```ts
// packages/happy-app/sources/auth/tokenStoreRuntime.ts
/**
 * Platform wiring for the TokenStore: storage, the web refresh lock
 * (navigator.locks 'happy-auth-refresh'), cross-tab sync via the `storage`
 * event, and the invalid_grant → logout path.
 */
import { Platform } from 'react-native';
import { getServerUrl } from '@/sync/serverConfig';
import { getHappyClientId } from '@/sync/apiSocket';
import { setAccessTokenProvider } from './authFetch';
import { wipeLocalSessionAndReload } from './logout';
import { AUTH_KEY, TokenStorage, type AuthCredentials } from './tokenStorage';
import { TokenStore } from './tokenStore';

const REFRESH_LOCK_NAME = 'happy-auth-refresh';

let store: TokenStore | null = null;
let storageListenerInstalled = false;

function webRefreshLock(): (<T>(fn: () => Promise<T>) => Promise<T>) | undefined {
    if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !navigator.locks) {
        return undefined; // single-flight only
    }
    return <T>(fn: () => Promise<T>) => navigator.locks.request(REFRESH_LOCK_NAME, fn) as Promise<T>;
}

function installStorageListener(): void {
    if (storageListenerInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        return;
    }
    storageListenerInstalled = true;
    window.addEventListener('storage', (event: StorageEvent) => {
        // key === null means localStorage.clear() in another tab.
        if (event.key !== AUTH_KEY && event.key !== null) {
            return;
        }
        const result = store?.applyExternalChange(event.key === null ? null : event.newValue);
        if (result === 'reload') {
            // Signed out (or into another account) in another tab: restart at home.
            window.location.replace('/');
        }
    });
}

export function startTokenStore(credentials: AuthCredentials): TokenStore {
    store?.stop();
    const isWeb = Platform.OS === 'web';
    const next = new TokenStore(credentials, {
        serverUrl: getServerUrl,
        read: isWeb ? () => TokenStorage.getCredentials() : undefined,
        write: async (value) => {
            if (!(await TokenStorage.setCredentials(value))) {
                throw new Error('Failed to persist credentials');
            }
        },
        clearIfRefreshToken: (refreshToken) => TokenStorage.removeCredentialsIfRefreshToken(refreshToken),
        onLoggedOut: () => {
            void wipeLocalSessionAndReload();
        },
        withLock: webRefreshLock(),
        clientId: getHappyClientId,
    });
    store = next;
    setAccessTokenProvider(next);
    if (isWeb) {
        installStorageListener();
    }
    return next;
}

export function getRuntimeTokenStore(): TokenStore | null {
    return store;
}
```

- [ ] **Step 5: Rewrite `AuthContext.tsx` login/logout**

In `packages/happy-app/sources/auth/AuthContext.tsx`:
1. Replace the import block (lines 1–8) with:
   ```tsx
   import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
   import { TokenStorage, AuthCredentials } from '@/auth/tokenStorage';
   import { syncCreate } from '@/sync/sync';
   import { loadRegisteredPushToken } from '@/sync/persistence';
   import { unregisterPushToken } from '@/sync/apiPush';
   import { trackLogout } from '@/track';
   import { getRuntimeTokenStore, startTokenStore } from '@/auth/tokenStoreRuntime';
   import { withTimeout } from '@/auth/tokenStore';
   import { wipeLocalSessionAndReload } from '@/auth/logout';

   const LOGOUT_STEP_TIMEOUT_MS = 5_000;
   ```
2. In `AuthContextType`, change `login: (token: string, secret: string) => Promise<void>;` to `login: (credentials: AuthCredentials) => Promise<void>;`.
3. Replace the `login` and `logout` functions with:
   ```tsx
    const login = async (newCredentials: AuthCredentials) => {
        const success = await TokenStorage.setCredentials(newCredentials);
        if (!success) {
            throw new Error('Failed to save credentials');
        }
        startTokenStore(newCredentials);
        await syncCreate(newCredentials);
        setCredentials(newCredentials);
        setIsAuthenticated(true);
    };

    const logout = async () => {
        trackLogout();
        const registeredPushToken = credentials ? loadRegisteredPushToken() : null;
        if (credentials && registeredPushToken) {
            try {
                await withTimeout(unregisterPushToken(credentials, registeredPushToken), LOGOUT_STEP_TIMEOUT_MS);
            } catch (error) {
                console.log('Failed to unregister push token during logout:', error);
            }
        }
        // Revokes this device on the server (best-effort), then wipe and restart.
        await getRuntimeTokenStore()?.logoutOnServer(LOGOUT_STEP_TIMEOUT_MS);
        setCredentials(null);
        setIsAuthenticated(false);
        await wipeLocalSessionAndReload();
    };
   ```
   The old imports of `expo-updates`, `Platform` and `clearPersistence` are no longer used in this file; they were removed with the import block.

- [ ] **Step 6: Sign-in entry points**

```ts
// packages/happy-app/sources/auth/webCallback.ts
/**
 * Captures the `#code` of the web OIDC callback at startup, before the router
 * reads the URL, and removes it from the address bar (spec §2 "Web app").
 * Imported from packages/happy-app/index.ts ahead of expo-router.
 */
import { parseWebCallbackHash } from './callbackUrls';

let captured: string | null = null;

function capture(): void {
    if (typeof window === 'undefined' || !window.location || typeof window.location.pathname !== 'string' || !window.history) {
        return; // native
    }
    if (!window.location.pathname.endsWith('/auth/callback')) {
        return;
    }
    captured = parseWebCallbackHash(window.location.hash);
    if (window.location.hash) {
        window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    }
}

capture();

/** The captured exchange code, once. */
export function takeWebCallbackCode(): string | null {
    const code = captured;
    captured = null;
    return code;
}
```

```ts
// packages/happy-app/sources/auth/signIn.ts
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as WebBrowser from 'expo-web-browser';
import { getServerUrl } from '@/sync/serverConfig';
import { parseMobileCallbackUrl } from './callbackUrls';
import {
    OidcLoginError,
    buildLoginUrl,
    createPendingLogin,
    deserializePendingLogin,
    exchangeCode,
    serializePendingLogin,
} from './oidcLogin';
import type { AuthCredentials } from './tokenStorage';

const PENDING_LOGIN_KEY = 'happy-oidc-pending';

/** The build's URL scheme (app.config `scheme`, from APP_SCHEME). */
export function getAppScheme(): string {
    const scheme = Constants.expoConfig?.scheme;
    const value = Array.isArray(scheme) ? scheme[0] : scheme;
    if (!value) {
        throw new OidcLoginError('This build has no URL scheme configured.');
    }
    return value;
}

/**
 * Starts sign-in. Web: stores the PKCE verifier and ephemeral key in sessionStorage
 * and navigates to the server (resolves null; the page unloads). Native: runs the
 * system auth session and resolves credentials, or null if the user cancelled.
 */
export async function signIn(): Promise<AuthCredentials | null> {
    const serverUrl = getServerUrl();
    const pending = await createPendingLogin();
    if (Platform.OS === 'web') {
        window.sessionStorage.setItem(PENDING_LOGIN_KEY, serializePendingLogin(pending));
        window.location.assign(buildLoginUrl({ serverUrl, pending, client: 'web' }));
        return null;
    }
    const redirectUri = `${getAppScheme()}://auth/callback`;
    const result = await WebBrowser.openAuthSessionAsync(
        buildLoginUrl({ serverUrl, pending, client: 'mobile', redirectUri }),
        redirectUri,
    );
    if (result.type !== 'success') {
        return null;
    }
    const code = parseMobileCallbackUrl(result.url, redirectUri);
    if (!code) {
        throw new OidcLoginError('Sign-in did not return a code. Please try again.');
    }
    return exchangeCode({ serverUrl, code, pending, deviceName: Device.modelName ?? Platform.OS });
}

/** Web: finishes the sign-in started by signIn() after the server redirected back. */
export async function completeWebSignIn(code: string): Promise<AuthCredentials> {
    const raw = window.sessionStorage.getItem(PENDING_LOGIN_KEY);
    window.sessionStorage.removeItem(PENDING_LOGIN_KEY);
    const pending = raw ? deserializePendingLogin(raw) : null;
    if (!pending) {
        throw new OidcLoginError('This sign-in was started in another tab or has expired. Please sign in again.');
    }
    return exchangeCode({ serverUrl: getServerUrl(), code, pending, deviceName: 'Web' });
}
```

In `packages/happy-app/index.ts`, insert as the first line:
```ts
import './sources/auth/webCallback';
```

```tsx
// packages/happy-app/sources/app/+native-intent.tsx
import { isAuthCallbackPath } from '@/auth/callbackUrls';

/**
 * The sign-in auth session consumes `<scheme>://auth/callback?code=…` itself
 * (sources/auth/signIn.ts). If the OS also hands that link to the router
 * (Android Custom Tabs), stay on the home screen instead of opening a route.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
    return isAuthCallbackPath(path) ? '/' : path;
}
```

- [ ] **Step 7: The web callback screen and route registration**

```tsx
// packages/happy-app/sources/app/(app)/auth/callback.tsx
import * as React from 'react';
import { ActivityIndicator, Platform, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { completeWebSignIn } from '@/auth/signIn';
import { takeWebCallbackCode } from '@/auth/webCallback';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';

/**
 * `/auth/callback#code=…`: where the server sends the browser after the IdP.
 * Not behind the sign-in screen, so it can finish signing in.
 */
export default function AuthCallbackScreen() {
    const auth = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const [error, setError] = React.useState<string | null>(null);
    const started = React.useRef(false);

    React.useEffect(() => {
        if (started.current) {
            return;
        }
        started.current = true;
        if (Platform.OS !== 'web' || auth.isAuthenticated) {
            router.replace('/');
            return;
        }
        const code = takeWebCallbackCode();
        if (!code) {
            setError('This sign-in link is incomplete. Please sign in again.');
            return;
        }
        (async () => {
            try {
                const credentials = await completeWebSignIn(code);
                await auth.login(credentials);
                router.replace('/');
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Sign-in failed. Please try again.');
            }
        })();
    }, []);

    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: theme.colors.groupped.background }}>
            {error ? (
                <>
                    <Text style={{ ...Typography.default(), fontSize: 17, textAlign: 'center', color: theme.colors.text, marginBottom: 24 }}>
                        {error}
                    </Text>
                    <View style={{ width: 280, maxWidth: '100%' }}>
                        <RoundButton title="Back to sign in" onPress={() => router.replace('/')} />
                    </View>
                </>
            ) : (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            )}
        </View>
    );
}
```

In `packages/happy-app/sources/app/(app)/_layout.tsx`:
1. Delete the two `<Stack.Screen name="restore/index" …/>` and `<Stack.Screen name="restore/manual" …/>` blocks (lines 202–220).
2. Right after the `onboarding/settings` screen block (starts at line 186), add:
   ```tsx
            <Stack.Screen
                name="auth/callback"
                options={{
                    headerShown: false,
                    headerTitle: '',
                }}
            />
   ```

Delete `packages/happy-app/sources/app/(app)/restore/index.tsx` and `packages/happy-app/sources/app/(app)/restore/manual.tsx`.

- [ ] **Step 8: Root layout: start the token store, drop dev credentials**

In `packages/happy-app/sources/app/_layout.tsx`:
1. Delete the functions `isHarnessDevStartup`, `hasHarnessDevCredentials`, `assertLoopbackHarnessServer`, `getDevEnvironmentCredentials`, `getDevWebQueryCredentials` (lines ~185–250) and the `import { getServerUrl } from '@/sync/serverConfig';` line (39).
2. Add `import { startTokenStore } from '@/auth/tokenStoreRuntime';` next to the `AuthProvider` import.
3. Replace the body of the init `try { … }` block (from `await loadFonts();` through `setInitState({ credentials });`) with:
   ```tsx
                await loadFonts();
                await sodium.ready;

                const credentials = await TokenStorage.getCredentials();
                if (credentials) {
                    startTokenStore(credentials);
                    await syncRestore(credentials);
                }

                setInitState({ credentials });
   ```

- [ ] **Step 9: Sign-in screen**

In `packages/happy-app/sources/app/(app)/index.tsx`:
1. Delete imports on lines 6 (`encodeBase64`), 7 (`authGetToken`), 8 (`useRouter`), 10 (`getRandomBytesAsync`), 13 (`trackAccountCreated, trackAccountRestored`). Add:
   ```tsx
   import { signIn } from "@/auth/signIn";
   import { Modal } from "@/modal";
   ```
2. In `NotAuthenticated`, delete `const router = useRouter();` and `const isMobile = …;`, and replace `createAccount`, `openRestore`, the comment above `actions` and the whole `const actions = isMobile ? (…) : (…);` expression (lines 60–114) with:
   ```tsx
    const signInWithOrganization = async () => {
        try {
            const credentials = await signIn();
            if (credentials) {
                await auth.login(credentials);
            }
        } catch (error) {
            console.error('Sign-in failed', error);
            Modal.alert(t('common.error'), error instanceof Error ? error.message : 'Sign-in failed. Please try again.');
        }
    };

    const actions = (
        <View style={styles.buttonContainer}>
            <RoundButton title="Sign in" action={signInWithOrganization} />
        </View>
    );
   ```
3. Replace both `{t('onboarding.tagline')}` occurrences (lines 131, 148) with `{'Sign in with your organization account.'}` (the old tagline claims end-to-end encryption, which the fork does not provide).

- [ ] **Step 10: Test fixtures gain a refresh token**

`AuthCredentials` now requires `refreshToken`. Add `refreshToken: 'refresh-1',` to every credentials literal in: `sources/sync/apiAttachments.test.ts` (`credentials`), `apiProjects.test.ts` (`credentials`), `apiGithub.spec.ts` (`mockCredentials`), `sessionAvatars.test.ts` (both inline `{ token, secret }` objects), `projects.test.ts`, `sync.send.test.ts`, `sync.preload.test.ts` (wherever they build `{ token, secret }`). Then:

Run: `pnpm --filter happy-app typecheck`
Expected: exit 0. Any remaining `Property 'refreshToken' is missing` error points at another fixture — fix it the same way. Any error mentioning `auth.login` means a caller still uses `(token, secret)`; the only callers were `index.tsx` and the deleted restore screens.

- [ ] **Step 11: Run tests and commit**

Run: `pnpm --filter happy-app exec vitest run sources/auth` — PASS.
Run: `pnpm --filter happy-app exec vitest run` — suite green.

```bash
git add -A packages/happy-app/index.ts packages/happy-app/sources/auth packages/happy-app/sources/app packages/happy-app/sources/sync
git commit -m "feat: sign in to the app with OIDC"
```

---

### Task 4: Route every server request through `authFetch`

**Files:**
- Modify: `packages/happy-app/sources/sync/apiArtifacts.ts:16,40,71,104,136`, `apiFeed.ts:33`, `apiFriends.ts:30,69,123,166,199`, `apiGithub.ts:34,63,88`, `apiKv.ts:79,121,156,195`, `apiProjects.ts:13-19,142-146`, `apiPush.ts:26,50,71`, `apiServices.ts:20,48`, `apiUsage.ts:37`, `apiAttachments.ts:46-53,169-175,238-245,280-286`, `apiVoice.ts` (whole file), `sessionAvatars.ts:31-44`, `sync.ts:1264-1270,1683-1689,1933-1945,2003-2009,2049-2055,3330`, `apiSocket.ts:4,38-41,116-124,270-305`
- Modify tests: `sources/sync/apiAttachments.test.ts`, `apiProjects.test.ts`, `apiGithub.spec.ts`, `sessionAvatars.test.ts`
- Test: `sources/sync/apiSocket.auth.test.ts`

**Interfaces:**
- Consumes: `authFetch`, `getAccessToken`, `headersToRecord`, `setAccessTokenProvider`, `staticAccessTokenProvider` (Task 1).
- Produces: `SyncSocketConfig = { endpoint: string }` (no `token`); `apiSocket.updateToken` removed. Every API helper keeps its `credentials: AuthCredentials` parameter (callers unchanged) but no longer reads `credentials.token`.

- [ ] **Step 1: Write the failing socket test**

```ts
// packages/happy-app/sources/sync/apiSocket.auth.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ io: vi.fn() }));

vi.mock('socket.io-client', () => ({ io: mocks.io }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { currentState: 'active' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.2.3' } } }));
vi.mock('./encryption/encryption', () => ({ Encryption: class {} }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ localSettings: { verboseLogging: false } }) } }));

import { apiSocket } from './apiSocket';
import { setAccessTokenProvider, staticAccessTokenProvider } from '@/auth/authFetch';
import type { AccessTokenProvider } from '@/auth/tokenStore';

function fakeSocket() {
    return { on: vi.fn(), onAny: vi.fn(), disconnect: vi.fn() };
}

afterEach(() => {
    apiSocket.disconnect();
    setAccessTokenProvider(null);
    vi.unstubAllGlobals();
    mocks.io.mockReset();
});

describe('apiSocket authentication', () => {
    it('asks for a fresh access token on every (re)connect', async () => {
        let current = 'token-1';
        const provider: AccessTokenProvider = {
            serverUrl: () => 'https://happy.test',
            getAccessToken: async () => current,
            refresh: async () => current,
        };
        setAccessTokenProvider(provider);
        mocks.io.mockReturnValue(fakeSocket());
        apiSocket.initialize({ endpoint: 'https://happy.test' }, {} as never);

        const options = mocks.io.mock.calls[0][1];
        expect(typeof options.auth).toBe('function');
        const first = await new Promise<any>((resolve) => options.auth(resolve));
        current = 'token-2';
        const second = await new Promise<any>((resolve) => options.auth(resolve));
        expect(first).toMatchObject({ token: 'token-1', clientType: 'user-scoped', happyClient: 'ios/1.2.3', appState: 'active' });
        expect(second.token).toBe('token-2');
    });

    it('sends REST requests through authFetch', async () => {
        setAccessTokenProvider(staticAccessTokenProvider('token-9', 'https://happy.test'));
        mocks.io.mockReturnValue(fakeSocket());
        apiSocket.initialize({ endpoint: 'https://happy.test' }, {} as never);
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        await apiSocket.request('/v1/things', { method: 'POST', headers: { 'Content-Type': 'application/json' } });

        expect(fetchMock).toHaveBeenCalledWith('https://happy.test/v1/things', expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
                Authorization: 'Bearer token-9',
                'X-Happy-Client': 'ios/1.2.3',
                'Content-Type': 'application/json',
            }),
        }));
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy-app exec vitest run sources/sync/apiSocket.auth.test.ts`
Expected: FAIL — the auth callback sends `this.config.token` (undefined), and `request()` reads `TokenStorage` (react-native import through `@/auth/tokenStorage` is not mocked).

- [ ] **Step 3: Update `apiSocket.ts`**

1. Replace `import { TokenStorage } from '@/auth/tokenStorage';` (line 4) with `import { authFetch, getAccessToken, headersToRecord } from '@/auth/authFetch';`.
2. `SyncSocketConfig` (lines 38–41) becomes:
   ```ts
   export interface SyncSocketConfig {
       endpoint: string;
   }
   ```
3. Replace the `auth: (cb) => cb({ … }),` property in `connect()` with:
   ```ts
            // A callback, not an object literal: socket.io re-invokes it on every
            // connect AND reconnect, so appState and the access token are read fresh
            // each time (the server disconnects sockets whose token expired).
            auth: (cb) => {
                const send = (token: string) => cb({
                    token,
                    clientType: 'user-scoped' as const,
                    happyClient: getHappyClientId(),
                    appState: getCurrentAppState(),
                });
                getAccessToken().then(send, (error) => {
                    // Signed out: the logout path reloads the app. Let the server refuse this attempt.
                    console.log('[apiSocket] No access token for socket auth:', error instanceof Error ? error.message : error);
                    send('');
                });
            },
   ```
4. Replace `request()` with:
   ```ts
    async request(path: string, options?: RequestInit): Promise<Response> {
        if (!this.config) {
            throw new Error('SyncSocket not initialized');
        }
        return authFetch(`${this.config.endpoint}${path}`, {
            ...options,
            headers: {
                'X-Happy-Client': getHappyClientId(),
                ...headersToRecord(options?.headers),
            },
        });
    }
   ```
5. Delete `updateToken()` (it has no callers).

In `sources/sync/sync.ts` line 3330: `apiSocket.initialize({ endpoint: API_ENDPOINT }, encryption);`.

Run: `pnpm --filter happy-app exec vitest run sources/sync/apiSocket.auth.test.ts` — expected PASS (2 tests).

- [ ] **Step 4: Switch every Bearer fetch to `authFetch`**

The rule for each call site listed under **Files**: add `import { authFetch } from '@/auth/authFetch';`, change `fetch(` to `authFetch(`, and delete the `'Authorization': \`Bearer ${…token}\`` header line. `authFetch` decides by origin whether to attach the token, so remove the hand-written "is this our server?" header logic too. Leave `credentials` parameters in place. Example (`apiPush.ts:23-31`):

```ts
// before
        const response = await fetch(`${API_ENDPOINT}/v1/push-tokens`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            },
            body: JSON.stringify({ token })
        });
// after
        const response = await authFetch(`${API_ENDPOINT}/v1/push-tokens`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            },
            body: JSON.stringify({ token })
        });
```

Special cases:
- `apiProjects.ts` `authHeaders()` (lines 13–19): drop the `Authorization` entry (keep the function for `Content-Type` / `X-Happy-Client`) and use `authFetch` at every call that uses it. `downloadProjectAvatar` (lines 142–146) becomes:
  ```ts
    const init = isServerHostedUrl(downloadUrl, serverUrl)
        ? { headers: { 'X-Happy-Client': getHappyClientId() } }
        : undefined;
    const response = await authFetch(downloadUrl, init);
  ```
- `apiAttachments.ts`: `requestAttachmentUpload` (46–53) and `downloadEncryptedAttachment`'s request-download (238–245) → `authFetch`, header line removed. The PUT upload (169–175) becomes `const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };` (delete `isServerUrl` and its `if`) with `authFetch(upload.uploadUrl, { method: 'PUT', headers, body })`. The blob download (280–286) becomes `blobRes = await authFetch(downloadUrl, { headers: {} });` (delete `isServerUrl` and its `if`). The multipart POST branch before the PUT uploads to presigned storage without a token; leave it on plain `fetch`.
- `sessionAvatars.ts` (31–44): delete the `Authorization` entry from `headers`, and use `authFetch` for both the request-download POST and the avatar download (keep `redirect: 'error'` and `signal`).
- `sync.ts`: the five `fetch(\`${API_ENDPOINT}/v1/…\`` calls at 1264, 1683, 1933, 2003, 2049 → `authFetch`, header line removed. Leave the unauthenticated `/v1/version` call (≈2098) on plain `fetch`.
- `apiVoice.ts`: replace the imports and `getVoiceEndpoint` so the file reads:
  ```ts
  import {
      VoiceConversationResponseSchema,
      VoiceUsageResponseSchema,
      type VoiceConversationResponse,
      type VoiceUsageResponse,
  } from '@slopus/happy-wire';
  import { AuthCredentials } from '@/auth/tokenStorage';
  import { authFetch } from '@/auth/authFetch';
  import { getServerUrl } from './serverConfig';
  import { getHappyClientId } from './apiSocket';
  import { config } from '@/config';

  export type { VoiceConversationResponse, VoiceUsageResponse };

  export async function fetchVoiceCredentials(
      _credentials: AuthCredentials,
      sessionId: string
  ): Promise<VoiceConversationResponse> {
      const agentId = config.elevenLabsAgentId;

      if (!agentId) {
          throw new Error('Agent ID not configured');
      }

      const response = await authFetch(`${getServerUrl()}/v1/voice/conversations`, {
          method: 'POST',
          headers: {
              'Content-Type': 'application/json',
              'X-Happy-Client': getHappyClientId(),
          },
          body: JSON.stringify({
              agentId
          })
      });

      if (!response.ok) {
          throw new Error(`Voice token request failed: ${response.status}`);
      }

      return VoiceConversationResponseSchema.parse(await response.json());
  }

  export async function fetchVoiceUsage(
      _credentials: AuthCredentials
  ): Promise<VoiceUsageResponse> {
      const response = await authFetch(`${getServerUrl()}/v1/voice/usage`, {
          method: 'GET',
          headers: {
              'X-Happy-Client': getHappyClientId(),
          },
      });

      if (!response.ok) {
          throw new Error(`Voice usage request failed: ${response.status}`);
      }

      return VoiceUsageResponseSchema.parse(await response.json());
  }
  ```
  (`sessionId` was never sent by the old code either; keep the signature so `RealtimeSession.ts` and `settings/voice.tsx` are unchanged.)

- [ ] **Step 5: Verify no hand-built bearer tokens remain**

```bash
cd packages/happy-app
grep -rn "Bearer \${\|credentials\.token\|credentials!\.token\|this\.credentials\.token" sources --include=*.ts --include=*.tsx | grep -v "\.test\.ts\|\.spec\.ts"
```
Expected: only `sources/auth/authFetch.ts` and `sources/auth/tokenStore.ts` (and `sources/auth/authApprove.ts` / `authAccountApprove.ts` / `hooks/useConnectTerminal.ts` / `hooks/useConnectAccount.ts`, which Task 5 deletes).

- [ ] **Step 6: Point the API tests at a token provider**

In each of `sources/sync/apiAttachments.test.ts`, `apiProjects.test.ts`, `apiGithub.spec.ts`, `sessionAvatars.test.ts`:
1. Add `import { setAccessTokenProvider, staticAccessTokenProvider } from '@/auth/authFetch';`.
2. In the top-level `beforeEach` (create one in `sessionAvatars.test.ts`), register the fixture token for the mocked server URL:
   - apiAttachments: `setAccessTokenProvider(staticAccessTokenProvider('test-token', 'https://api.cluster-fluster.com'));`
   - apiProjects: `setAccessTokenProvider(staticAccessTokenProvider('token-1', 'https://api.example.test'));`
   - apiGithub: `setAccessTokenProvider(staticAccessTokenProvider('test-token', 'https://api.test.com'));`
   - sessionAvatars: `setAccessTokenProvider(staticAccessTokenProvider('private-token', 'https://happy.test'));`
   and add `setAccessTokenProvider(null);` to the `afterEach`.

The assertions keep their meaning (the token now comes from the provider). Where an assertion compared a whole `init` object whose shape changed only because `authFetch` builds `{ ...init, headers }` (e.g. an extra `headers: {}` on a storage download in `apiAttachments.test.ts`), update the expected object to the new shape; do not weaken assertions about `Authorization` being absent for non-server URLs.

- [ ] **Step 7: Run tests, typecheck, commit**

Run: `pnpm --filter happy-app exec vitest run sources/sync sources/auth` — PASS. If `sync.send.test.ts` or `sync.preload.test.ts` fail with `LoggedOutError`, register a provider in their `beforeEach`: `setAccessTokenProvider(staticAccessTokenProvider('token', 'https://example.invalid'));` (their mocked server URL).
Run: `pnpm --filter happy-app exec vitest run` — suite green.
Run: `pnpm --filter happy-app typecheck` — exit 0.

```bash
git add -A packages/happy-app/sources/sync packages/happy-app/sources/auth
git commit -m "feat: send app server requests through authFetch"
```

---

### Task 5: Remove keypair pairing, secret-key backup and the server picker

**Files:**
- Delete: `packages/happy-app/sources/auth/authChallenge.ts`, `authGetToken.ts`, `authQRStart.ts`, `authQRWait.ts`, `authApprove.ts`, `authAccountApprove.ts`, `secretKeyBackup.ts`, `secretKeyBackup.spec.ts`; `sources/hooks/useConnectTerminal.ts`, `useConnectAccount.ts`; `sources/app/(app)/terminal/index.tsx`, `terminal/connect.tsx`; `sources/app/(app)/server.tsx`; `sources/components/ConnectButton.tsx` (not imported anywhere)
- Create: `packages/happy-app/sources/sync/serverUrl.ts`, test `sources/sync/serverUrl.test.ts`
- Modify: `sources/sync/serverConfig.ts`, `sources/app/(app)/_layout.tsx:173-184`, `sources/components/SettingsView.tsx:14,17,96,102,231-261`, `sources/components/EmptyMainScreen.tsx`, `sources/components/onboarding/LinkComputer.tsx`, `sources/components/CommandPalette/CommandPaletteProvider.tsx:88-97`, `sources/app/(app)/settings/account.tsx`, `sources/app/(app)/onboarding/settings.tsx`, `sources/app/(app)/dev/index.tsx:15,32-53,440-445`, `sources/components/HomeHeader.tsx:6,72-80,103-122`, `sources/components/HomeHeader.test.ts:45-48,180-185`, `sources/components/MainView.tsx:28,151,239-251,276`

**Interfaces:**
- Produces:
  ```ts
  // serverUrl.ts (pure)
  const DEV_FALLBACK_SERVER_URL = 'http://localhost:3005';
  function resolveServerUrl(sources: { deployUrl?: unknown; buildUrl?: string }): string
  // serverConfig.ts (kept exports)
  getServerUrl(): string; rewriteLoopbackHost(url): string; getServerInfo(): { hostname: string; port?: number };
  getServerLabel(): string; getLogServerUrl(); setLogServerUrl(); validateServerUrl()
  // removed: setServerUrl, isUsingCustomServer, shouldUseCustomServerForVoice, setUseCustomServerForVoice, getVoiceServerUrl
  ```

- [ ] **Step 1: Write the failing server URL test**

```ts
// packages/happy-app/sources/sync/serverUrl.test.ts
import { describe, expect, it } from 'vitest';
import { DEV_FALLBACK_SERVER_URL, resolveServerUrl } from './serverUrl';

describe('resolveServerUrl', () => {
    it('prefers the deploy-time URL over the build-time URL', () => {
        expect(resolveServerUrl({ deployUrl: 'https://deploy.example', buildUrl: 'https://build.example' })).toBe('https://deploy.example');
    });
    it('uses the build-time URL when no deploy-time URL exists', () => {
        expect(resolveServerUrl({ deployUrl: undefined, buildUrl: 'https://build.example/' })).toBe('https://build.example');
        expect(resolveServerUrl({ deployUrl: '  ', buildUrl: 'https://build.example' })).toBe('https://build.example');
        expect(resolveServerUrl({ deployUrl: 42, buildUrl: 'https://build.example' })).toBe('https://build.example');
    });
    it('falls back to the local development server, never an upstream host', () => {
        expect(resolveServerUrl({})).toBe(DEV_FALLBACK_SERVER_URL);
        expect(DEV_FALLBACK_SERVER_URL).toBe('http://localhost:3005');
    });
});
```

Run: `pnpm --filter happy-app exec vitest run sources/sync/serverUrl.test.ts` — expected FAIL (module missing).

- [ ] **Step 2: Implement `serverUrl.ts` and rewrite `serverConfig.ts`**

```ts
// packages/happy-app/sources/sync/serverUrl.ts
/**
 * Used only when neither a deploy-time (`window.__HAPPY_CONFIG__.serverUrl`) nor a
 * build-time (`EXPO_PUBLIC_HAPPY_SERVER_URL`) URL exists, i.e. local development
 * against the repo's docker-compose / `pnpm env` server. Deliberately not the
 * upstream hosted server: a misconfigured corporate build must fail closed.
 */
export const DEV_FALLBACK_SERVER_URL = 'http://localhost:3005';

export function resolveServerUrl(sources: { deployUrl?: unknown; buildUrl?: string }): string {
    const deployUrl = typeof sources.deployUrl === 'string' ? sources.deployUrl.trim() : '';
    const buildUrl = sources.buildUrl?.trim() ?? '';
    return (deployUrl || buildUrl || DEV_FALLBACK_SERVER_URL).replace(/\/+$/, '');
}
```

Replace `packages/happy-app/sources/sync/serverConfig.ts` with:

```ts
import { MMKV } from 'react-native-mmkv';
import { resolveServerUrl } from './serverUrl';

// Device-local developer settings that persist across logouts (remote log server).
const serverConfigStorage = new MMKV({ id: 'server-config' });

const LOG_SERVER_KEY = 'log-server-url';

// Upstream let users override the server URL; the corporate fork has no picker.
// Drop any override an older build stored so it can never be read again.
serverConfigStorage.delete('custom-server-url');
serverConfigStorage.delete('use-custom-server-for-voice');

/** Deploy-time `window.__HAPPY_CONFIG__.serverUrl`, else build-time EXPO_PUBLIC_HAPPY_SERVER_URL. */
export function getServerUrl(): string {
    // happy-mobile-gym harness: pin the run to its explicit loopback server.
    // Production ignores this path.
    if (__DEV__ && process.env.EXPO_PUBLIC_HARNESS_MODE === '1') {
        const configured = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        if (!configured) throw new Error('Harness startup requires its explicit server URL.');
        const parsed = new URL(configured);
        if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)
            || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
            throw new Error('Harness startup requires a plain loopback HTTP origin.');
        }
        return parsed.origin;
    }
    return resolveServerUrl({
        deployUrl: (globalThis as any).__HAPPY_CONFIG__?.serverUrl,
        buildUrl: process.env.EXPO_PUBLIC_HAPPY_SERVER_URL,
    });
}

export function rewriteLoopbackHost(url: string): string {
    try {
        const target = new URL(url);
        if (target.hostname !== 'localhost' && target.hostname !== '127.0.0.1' && target.hostname !== '::1') {
            return url;
        }
        const reachable = new URL(getServerUrl());
        target.protocol = reachable.protocol;
        target.host = reachable.host;
        return target.toString();
    } catch {
        return url;
    }
}

export function getLogServerUrl(): string | null {
    return serverConfigStorage.getString(LOG_SERVER_KEY) ||
           process.env.EXPO_PUBLIC_LOG_SERVER_URL ||
           null;
}

export function setLogServerUrl(url: string | null): void {
    if (url && url.trim()) {
        serverConfigStorage.set(LOG_SERVER_KEY, url.trim());
    } else {
        serverConfigStorage.delete(LOG_SERVER_KEY);
    }
}

export function getServerInfo(): { hostname: string; port?: number } {
    const url = getServerUrl();
    try {
        const parsed = new URL(url);
        return { hostname: parsed.hostname, port: parsed.port ? parseInt(parsed.port) : undefined };
    } catch {
        return { hostname: url, port: undefined };
    }
}

/** `host[:port]` of the configured server, for headers and settings rows. */
export function getServerLabel(): string {
    const info = getServerInfo();
    return info.hostname + (info.port ? `:${info.port}` : '');
}

export function validateServerUrl(url: string): { valid: boolean; error?: string } {
    if (!url || !url.trim()) {
        return { valid: false, error: 'Server URL cannot be empty' };
    }
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, error: 'Server URL must use HTTP or HTTPS protocol' };
        }
        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }
}
```

Run: `pnpm --filter happy-app exec vitest run sources/sync/serverUrl.test.ts` — expected PASS (3 tests).

- [ ] **Step 3: Delete the pairing modules and screens**

```bash
cd packages/happy-app/sources
git rm auth/authChallenge.ts auth/authGetToken.ts auth/authQRStart.ts auth/authQRWait.ts auth/authApprove.ts \
  auth/authAccountApprove.ts auth/secretKeyBackup.ts auth/secretKeyBackup.spec.ts \
  hooks/useConnectTerminal.ts hooks/useConnectAccount.ts \
  "app/(app)/terminal/index.tsx" "app/(app)/terminal/connect.tsx" "app/(app)/server.tsx" components/ConnectButton.tsx
```

In `sources/app/(app)/_layout.tsx`, delete the `<Stack.Screen name="terminal/connect" …/>` and `<Stack.Screen name="terminal/index" …/>` blocks (lines 173–184).

In `sources/components/CommandPalette/CommandPaletteProvider.tsx`, delete the `{ id: 'connect', title: 'Connect Device', … router.push('/terminal/connect') … }` entry (lines 88–97).

- [ ] **Step 4: Settings screens**

`sources/components/SettingsView.tsx`: delete the imports of `useConnectTerminal` (line 14) and `isUsingCustomServer` (line 17), the lines `const isCustomServer = isUsingCustomServer();` (96) and `const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();` (102), and the whole `{/* Connect Terminal - Only show on native platforms */}` block through its closing `)}` (lines 231–260, ending right before `{/* Support Us */}`).

`sources/app/(app)/settings/account.tsx`:
1. Delete imports: `expo-clipboard` (line 5), `formatSecretKeyForBackup` (8), `useConnectAccount` (19), `Typography` (7), `layout` (14); change line 2 to import only what the file still uses from `react-native` (`View` and `Platform` if still referenced; `Text` and `Pressable` were only used by the secret key display).
2. Delete state/derived values: `showSecret`, `copiedRecently` (106–107), `const { connectAccount, isLoading: isConnecting } = useConnectAccount();` (109), `currentSecret` / `formattedSecret` and their comment (120–122).
3. Delete `handleShowSecret` and `handleCopySecret` (200–213).
4. Delete the `{Platform.OS !== 'web' && ( <Item title={t('settingsAccount.linkNewDevice')} … /> )}` block (334–343).
5. Delete the `{/* Backup Section */}` `ItemGroup` and the `{/* Secret Key Display */}` block (426–480).

`sources/app/(app)/onboarding/settings.tsx`:
1. Replace `import { getServerInfo } from '@/sync/serverConfig';` with `import { getServerLabel } from '@/sync/serverConfig';`; change `import { Stack, useRouter, useSegments } from 'expo-router';` to `import { Stack } from 'expo-router';`.
2. Delete `const router = useRouter();`, `useSegments(); …`, `const serverInfo = …` and `const serverLabel = …`.
3. Update the doc comment's first sentence to: `The gear on the link-your-computer screen: which server this account lives on, and a way to throw the account away and start again.`
4. The server `Item` becomes:
   ```tsx
                    <Item
                        title={t('onboarding.settingsServer')}
                        detail={getServerLabel()}
                        icon={<Ionicons name="server-outline" size={28} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
   ```

`sources/app/(app)/dev/index.tsx`: change the serverConfig import (line 15) to `import { getServerUrl, validateServerUrl, getLogServerUrl, setLogServerUrl } from '@/sync/serverConfig';`, delete `handleEditServerUrl` (32–53), and remove `onPress={handleEditServerUrl}` from the "API Endpoint" `Item` (≈443) so it is read-only.

- [ ] **Step 5: Headers without the server picker**

`sources/components/HomeHeader.tsx`:
1. Replace `const serverInfo = getServerInfo();` and the `subtitle={serverInfo.isCustom ? … : undefined}` expression in `HomeHeaderNotAuth` with `subtitle={formatServer(getServerInfo())}` and remove the `headerRight={() => <HeaderRightNotAuth />}` prop. Add below the imports:
   ```tsx
   function formatServer(info: { hostname: string; port?: number }): string {
       return info.hostname + (info.port ? `:${info.port}` : '');
   }
   ```
2. Delete the `HeaderRightNotAuth` function (it only opened `/server`). Update the `HomeHeaderNotAuth` doc comment to: `The sign-in screen's header: no title, logo or socket status; only the server this build signs in to.`

`sources/components/HomeHeader.test.ts`:
1. The serverConfig mock (lines 45–48) becomes `vi.mock('@/sync/serverConfig', () => ({ getServerInfo: () => ({ hostname: '192.168.0.108', port: 3005 }) }));`.
2. Replace the test `'opens server settings from a gear, not a server-rack glyph'` with:
   ```ts
    it('offers no server picker', () => {
        const renderer = render(React.createElement(HomeHeaderNotAuth));
        const header = renderer.root.findByType('Header' as any);
        expect(header.props.headerRight).toBeUndefined();
    });
   ```

`sources/components/MainView.tsx`: delete the `isUsingCustomServer` import (28) and `const isCustomServer = …` (151); the `activeTab === 'settings'` branch of `HeaderRight` (239–251) becomes `return Platform.OS === 'web' ? <View style={styles.headerButton} /> : null;`; line 276 becomes `const showHeaderRight = activeTab !== 'settings';`.

- [ ] **Step 6: "Link your computer" becomes a `happy auth login` hint**

`sources/components/EmptyMainScreen.tsx`:
1. Change the react-native import to `import { View, Text, Platform, Pressable, ScrollView } from 'react-native';`, and delete the imports of `useConnectTerminal` and `Modal`.
2. Replace the whole `EmptyMainScreen` function with:
   ```tsx
   /** Commands that link a computer in the corporate fork (OIDC device login, no QR pairing). */
   const LINK_COMMANDS = ['$ npm install -g happy', '$ happy auth login', '$ happy'];

   export function EmptyMainScreen({
       hasArchivedSessions = false,
       onShowArchived,
   }: {
       hasArchivedSessions?: boolean;
       onShowArchived?: () => void;
   }) {
       const { theme } = useUnistyles();
       const styles = stylesheet;
       const router = useRouter();
       const machines = useAllMachines({ includeOffline: true });
       const machineChoices = React.useMemo(() => collectMachineChoices(machines), [machines]);
       const showArchivedAction = hasArchivedSessions && onShowArchived ? (
           <Pressable
               onPress={onShowArchived}
               accessibilityRole="button"
               style={({ pressed }) => [
                   styles.secondaryAction,
                   pressed && styles.secondaryActionPressed,
               ]}
           >
               <Text style={styles.secondaryActionText}>{t('sidebar.showArchived')}</Text>
           </Pressable>
       ) : null;

       // A linked computer with nothing on it yet. The all-offline case never
       // reaches here: the list wrapper shows the offline checklist for it.
       if (machineChoices.length > 0) {
           return (
               <View style={styles.container}>
                   <Ionicons name="terminal-outline" size={56} color={theme.colors.textSecondary} style={styles.stateIcon} />
                   <Text style={styles.stateTitle}>No sessions yet</Text>
                   <Text style={styles.stateDescription}>Start one on a connected machine.</Text>
                   <RoundButton title="Start New Session" size="large" onPress={() => router.navigate('/new')} />
                   {showArchivedAction}
               </View>
           );
       }

       return (
           <ScrollView contentContainerStyle={[styles.container, { flexGrow: 1, flex: undefined, paddingVertical: 24 }]}>
               <Text style={styles.title}>{t('components.emptyMainScreen.connectComputer')}</Text>
               <Text style={styles.stateDescription}>
                   Install the Happy CLI on your computer, sign in with your organization account, and start it.
                   Your computer shows up here as soon as it connects.
               </Text>
               <View style={styles.terminalBlock}>
                   {LINK_COMMANDS.map((line, index) => (
                       <Text
                           key={line}
                           style={[styles.terminalText, index < LINK_COMMANDS.length - 1 && styles.terminalTextFirst]}
                       >
                           {line}
                       </Text>
                   ))}
               </View>
               {showArchivedAction}
           </ScrollView>
       );
   }
   ```

`sources/components/onboarding/LinkComputer.tsx`:
1. Imports: `import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';` (drop `Linking`, `Platform`); delete the `useConnectTerminal` and `trackConnectAttempt` imports; replace `import { getServerInfo } from '@/sync/serverConfig';` with `import { getServerLabel } from '@/sync/serverConfig';`.
2. Delete `DESKTOP_URL` and `MACHINE_ARRIVAL_TIMEOUT_MS` (and their comments). Add after `HELP_LINKS`:
   ```tsx
   // Corporate fork: a computer links itself by signing in with `happy auth login`
   // (OIDC device flow). English-only copy until it goes through translation.
   const SIGN_IN_STEP_TITLE = 'Sign in on your computer';
   const SIGN_IN_STEP_BODY = 'Run this in a terminal and approve the sign-in in your browser.';
   const SIGN_IN_COMMAND = 'happy auth login';
   const START_STEP_TITLE = 'Start Happy';
   const START_STEP_BODY = 'This screen updates as soon as your computer connects.';
   ```
3. Delete `useScanActions` entirely.
4. Replace `LinkComputerChecklist` with:
   ```tsx
   /**
    * The link-your-computer checklist. `link` is the first run: nothing is linked
    * yet. `offline` is the same list once a computer is linked but none can be
    * reached: the job is to get Happy running again.
    */
   export const LinkComputerChecklist = React.memo(function LinkComputerChecklist({
       variant,
       onShowArchived,
       bottomInset = 0,
   }: {
       variant: 'link' | 'offline';
       /** Archive-only accounts keep a way to their archive while offline. */
       onShowArchived?: () => void;
       /** Extra room under the content for anything floating over it. */
       bottomInset?: number;
   }) {
       const router = useRouter();
       const machines = useAllMachines({ includeOffline: true });
       const choices = React.useMemo(() => collectMachineChoices(machines), [machines]);
       const [ticked, setTicked] = useLocalSettingMutable('linkComputerChecklist');

       const toggle = React.useCallback((key: 'install' | 'open') => {
           setTicked({ ...ticked, [key]: !ticked[key] });
       }, [setTicked, ticked]);

       if (variant === 'offline') {
           const title = choices.length === 1
               ? t('onboarding.offlineTitleOne', { name: choices[0].name })
               : t('onboarding.offlineTitleMany');
           const linked = choices.length === 1
               ? t('onboarding.offlineLinkedStep', { name: choices[0].name })
               : t('onboarding.offlineLinkedStepMany', { count: choices.length });
           return (
               <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: SCROLL_BOTTOM_PADDING + bottomInset }]} keyboardShouldPersistTaps="handled">
                   <View style={styles.content}>
                       <Text style={styles.title}>{title}</Text>
                       <ChecklistRow checked title={linked} />
                       <ChecklistRow checked={false} title={t('onboarding.offlineOpenStep')}>
                           <Text style={styles.body}>{t('onboarding.offlineOpenBody')}</Text>
                           <TerminalBlock
                               style={styles.terminal}
                               lines={[{ kind: 'command', text: t('onboarding.terminalRun') }]}
                           />
                       </ChecklistRow>
                       <View style={styles.actions}>
                           <View style={styles.button}>
                               <RoundButton
                                   title={t('onboarding.offlineTroubleshoot')}
                                   onPress={() => router.push('/troubleshoot')}
                               />
                           </View>
                           {onShowArchived ? (
                               <View style={styles.button}>
                                   <RoundButton
                                       size="normal"
                                       display="inverted"
                                       title={t('sidebar.showArchived')}
                                       onPress={onShowArchived}
                                   />
                               </View>
                           ) : null}
                       </View>
                   </View>
               </ScrollView>
           );
       }

       return (
           <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: SCROLL_BOTTOM_PADDING + bottomInset }]} keyboardShouldPersistTaps="handled">
               <View style={styles.content}>
                   <ChecklistRow
                       checked={!!ticked.install}
                       title={t('onboarding.installStep')}
                       onToggle={() => toggle('install')}
                   >
                       <TerminalBlock
                           style={styles.terminal}
                           lines={[{ kind: 'command', text: t('onboarding.terminalInstall') }]}
                       />
                   </ChecklistRow>
                   <ChecklistRow
                       checked={!!ticked.open}
                       title={SIGN_IN_STEP_TITLE}
                       onToggle={() => toggle('open')}
                   >
                       <Text style={styles.body}>{SIGN_IN_STEP_BODY}</Text>
                       <TerminalBlock style={styles.terminal} lines={[{ kind: 'command', text: SIGN_IN_COMMAND }]} />
                   </ChecklistRow>
                   <ChecklistRow checked={false} title={START_STEP_TITLE}>
                       <Text style={styles.body}>{START_STEP_BODY}</Text>
                       <TerminalBlock
                           style={styles.terminal}
                           lines={[{ kind: 'command', text: t('onboarding.terminalRun') }]}
                       />
                   </ChecklistRow>
               </View>
           </ScrollView>
       );
   });
   ```
5. In `OnboardingLinkComputer`, delete `const serverInfo = getServerInfo();` and set `subtitle={getServerLabel()}`.

- [ ] **Step 7: Verify nothing references the removed features**

```bash
cd packages/happy-app
grep -rn "authChallenge\|authGetToken\|authQRStart\|authQRWait\|authApprove\|authAccountApprove\|useConnectTerminal\|useConnectAccount\|secretKeyBackup\|setServerUrl\|isUsingCustomServer\|getVoiceServerUrl\|UseCustomServerForVoice\|happy://terminal\|happy:///account\|/terminal/connect\|'/server'\|'/restore'\|EXPO_PUBLIC_DEV_TOKEN\|EXPO_PUBLIC_DEV_SECRET\|HARNESS_DEV_TOKEN\|HARNESS_DEV_SECRET\|dev_token\|api.cluster-fluster.com" sources --include=*.ts --include=*.tsx | grep -v "\.test\.ts\|\.spec\.ts"
```
Expected: no output. (`sources/sync/apiAttachments.test.ts` keeps `api.cluster-fluster.com` as an arbitrary fixture host; that is fine.)

- [ ] **Step 8: Run tests, typecheck, commit**

Run: `pnpm --filter happy-app exec vitest run sources/components/HomeHeader.test.ts sources/sync/serverUrl.test.ts` — PASS.
Run: `pnpm --filter happy-app exec vitest run` — suite green.
Run: `pnpm --filter happy-app typecheck` — exit 0.

```bash
git add -A packages/happy-app/sources
git commit -m "refactor: remove keypair pairing and server picker from the app"
```

---

### Task 6: Rebrandable app config

**Files:**
- Create: `packages/happy-app/expoConfig.cjs`
- Rewrite: `packages/happy-app/app.config.js`
- Test: `packages/happy-app/sources/appConfig.test.ts`
- Modify: `Dockerfile.webapp:31-44`, `environments/environments.ts:806,850`

**Interfaces:**
- Produces: `buildExpoConfig(env: Record<string, string | undefined>, buildMetadata?: { commitSha?: string; commitTimestamp?: string }): { expo: ExpoConfig }` (CommonJS, `module.exports = { buildExpoConfig, VARIANTS, PRODUCTION_REQUIRED }`); throws `Error('Production builds require …')` or `Error('Unknown APP_ENV …')`. The app reads the scheme from `Constants.expoConfig.scheme` (Task 3 `getAppScheme()`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/happy-app/sources/appConfig.test.ts
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildExpoConfig } = require('../expoConfig.cjs') as {
    buildExpoConfig: (env: Record<string, string | undefined>, meta?: Record<string, string>) => { expo: any };
};

const production = {
    APP_ENV: 'production',
    APP_BUNDLE_ID: 'com.acme.happy',
    APP_SCHEME: 'acmehappy',
    HAPPY_SERVER_URL: 'https://happy.acme.example',
};

const UPSTREAM_IDENTIFIERS = ['com.slopus', 'com.ex3ndr', 'bulkacorp', '4558dd3d', 'app.happy.engineering', 'google-services.json'];

describe('buildExpoConfig', () => {
    it('builds development with placeholder identities and no upstream identifiers', () => {
        const { expo } = buildExpoConfig({});
        expect(expo.name).toBe('Happy (dev)');
        expect(expo.scheme).toBe('happy-dev');
        expect(expo.ios.bundleIdentifier).toBe('com.example.happy.dev');
        expect(expo.android.package).toBe('com.example.happy.dev');
        expect(expo.updates).toBeUndefined();
        expect(expo.owner).toBeUndefined();
        expect(expo.extra.eas).toBeUndefined();
        expect(expo.ios.associatedDomains).toBeUndefined();
        expect(expo.android.intentFilters).toEqual([]);
        expect(expo.android.googleServicesFile).toBeUndefined();
        const serialized = JSON.stringify(expo);
        for (const id of UPSTREAM_IDENTIFIERS) {
            expect(serialized).not.toContain(id);
        }
    });

    it('builds preview with its own placeholders', () => {
        const { expo } = buildExpoConfig({ APP_ENV: 'preview' });
        expect(expo.name).toBe('Happy (preview)');
        expect(expo.scheme).toBe('happy-preview');
        expect(expo.ios.bundleIdentifier).toBe('com.example.happy.preview');
    });

    it.each(['APP_BUNDLE_ID', 'APP_SCHEME', 'HAPPY_SERVER_URL'])('fails a production build without %s', (name) => {
        expect(() => buildExpoConfig({ ...production, [name]: undefined })).toThrow(new RegExp(`Production builds require .*${name}`));
        expect(() => buildExpoConfig({ ...production, [name]: '   ' })).toThrow(/Production builds require/);
    });

    it('lists every missing production variable at once', () => {
        expect(() => buildExpoConfig({ APP_ENV: 'production' })).toThrow('APP_BUNDLE_ID, APP_SCHEME, HAPPY_SERVER_URL');
    });

    it('uses the configured identity in production', () => {
        const { expo } = buildExpoConfig({ ...production, APP_NAME: 'Acme Happy' });
        expect(expo.name).toBe('Acme Happy');
        expect(expo.scheme).toBe('acmehappy');
        expect(expo.ios.bundleIdentifier).toBe('com.acme.happy');
        expect(expo.android.package).toBe('com.acme.happy');
        expect(expo.ios.infoPlist.NSAppTransportSecurity).toEqual({ NSAllowsLocalNetworking: true });
        expect(expo.extra.app.consoleLoggingDefault).toBe(false);
    });

    it('emits associated domains and intent filters only with APP_LINKS_HOST', () => {
        const { expo } = buildExpoConfig({ ...production, APP_LINKS_HOST: 'links.acme.example' });
        expect(expo.ios.associatedDomains).toEqual(['applinks:links.acme.example']);
        expect(expo.android.intentFilters).toEqual([{
            action: 'VIEW',
            autoVerify: true,
            data: [{ scheme: 'https', host: 'links.acme.example', pathPrefix: '/' }],
            category: ['BROWSABLE', 'DEFAULT'],
        }]);
    });

    it('configures EAS updates, project and owner only when set', () => {
        const { expo } = buildExpoConfig({ ...production, EAS_PROJECT_ID: 'proj-123', EAS_OWNER: 'acme' });
        expect(expo.updates).toEqual({ url: 'https://u.expo.dev/proj-123', requestHeaders: { 'expo-channel-name': 'production' } });
        expect(expo.extra.eas).toEqual({ projectId: 'proj-123' });
        expect(expo.owner).toBe('acme');
    });

    it('takes the Google services file and assets directory from the environment', () => {
        const { expo } = buildExpoConfig({ ...production, GOOGLE_SERVICES_FILE: './acme/google-services.json', APP_ASSETS_DIR: './acme/assets/' });
        expect(expo.android.googleServicesFile).toBe('./acme/google-services.json');
        expect(expo.icon).toBe('./acme/assets/icon.png');
        expect(expo.android.adaptiveIcon.foregroundImage).toBe('./acme/assets/icon-adaptive.png');
        expect(expo.web.favicon).toBe('./acme/assets/favicon.png');
    });

    it('rejects an unknown APP_ENV', () => {
        expect(() => buildExpoConfig({ APP_ENV: 'staging' })).toThrow(/Unknown APP_ENV "staging"/);
    });

    it('passes build metadata through', () => {
        const { expo } = buildExpoConfig({}, { commitSha: 'abc', commitTimestamp: '2026-10-01T00:00:00Z' });
        expect(expo.extra.app.buildCommitSha).toBe('abc');
        expect(expo.extra.app.buildCommitTimestamp).toBe('2026-10-01T00:00:00Z');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy-app exec vitest run sources/appConfig.test.ts`
Expected: FAIL — `Cannot find module '../expoConfig.cjs'`.

- [ ] **Step 3: Implement `expoConfig.cjs`**

```js
// packages/happy-app/expoConfig.cjs
/**
 * Builds the Expo config from environment variables. Pure: app.config.js passes
 * process.env and git metadata; sources/appConfig.test.ts passes fixtures.
 *
 * Every identity value is build-time configuration (spec §3 "Mobile builds").
 * Production refuses to build without its own identity; development and preview
 * fall back to placeholders under the reserved example.com namespace, never to
 * upstream identifiers.
 */
const VARIANTS = {
    development: { name: 'Happy (dev)', bundleId: 'com.example.happy.dev', scheme: 'happy-dev', consoleLoggingDefault: true },
    preview: { name: 'Happy (preview)', bundleId: 'com.example.happy.preview', scheme: 'happy-preview', consoleLoggingDefault: true },
    production: { name: 'Happy', bundleId: null, scheme: null, consoleLoggingDefault: false },
};

const PRODUCTION_REQUIRED = ['APP_BUNDLE_ID', 'APP_SCHEME', 'HAPPY_SERVER_URL'];
const DEFAULT_ASSETS_DIR = './sources/assets/images';
const ELEVENLABS_AGENT_ID = 'agent_6701k211syvvegba4kt7m68nxjmw';

function value(env, name) {
    const raw = env[name];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function buildExpoConfig(env, buildMetadata = {}) {
    const variant = value(env, 'APP_ENV') || 'development';
    const defaults = VARIANTS[variant];
    if (!defaults) {
        throw new Error(`Unknown APP_ENV "${variant}". Use development, preview or production.`);
    }
    if (variant === 'production') {
        const missing = PRODUCTION_REQUIRED.filter((name) => !value(env, name));
        if (missing.length > 0) {
            throw new Error(`Production builds require ${missing.join(', ')}. Set them to your organization's values; there is no fallback to upstream identifiers.`);
        }
    }

    const name = value(env, 'APP_NAME') || defaults.name;
    const bundleId = value(env, 'APP_BUNDLE_ID') || defaults.bundleId;
    const scheme = value(env, 'APP_SCHEME') || defaults.scheme;
    const linksHost = value(env, 'APP_LINKS_HOST');
    const easProjectId = value(env, 'EAS_PROJECT_ID');
    const easOwner = value(env, 'EAS_OWNER');
    const googleServicesFile = value(env, 'GOOGLE_SERVICES_FILE');
    const assetsDir = (value(env, 'APP_ASSETS_DIR') || DEFAULT_ASSETS_DIR).replace(/\/+$/, '');
    const asset = (file) => `${assetsDir}/${file}`;

    const expo = {
        name,
        slug: 'happy',
        version: '1.8.0',
        runtimeVersion: '21',
        orientation: 'default',
        icon: asset('icon.png'),
        scheme,
        userInterfaceStyle: 'automatic',
        ios: {
            supportsTablet: true,
            bundleIdentifier: bundleId,
            config: {
                usesNonExemptEncryption: false,
            },
            infoPlist: {
                NSMicrophoneUsageDescription: 'Allow $(PRODUCT_NAME) to access your microphone for voice conversations with AI.',
                NSLocalNetworkUsageDescription: 'Allow $(PRODUCT_NAME) to find and connect to local devices on your network.',
                NSBonjourServices: ['_http._tcp', '_https._tcp'],
                // ATS: NSAllowsLocalNetworking lets HTTP reach LAN addresses; dev/preview
                // also allow arbitrary HTTP loads for a developer's own server.
                NSAppTransportSecurity: variant === 'production'
                    ? { NSAllowsLocalNetworking: true }
                    : { NSAllowsLocalNetworking: true, NSAllowsArbitraryLoads: true },
            },
            ...(linksHost ? { associatedDomains: [`applinks:${linksHost}`] } : {}),
        },
        android: {
            adaptiveIcon: {
                foregroundImage: asset('icon-adaptive.png'),
                monochromeImage: asset('icon-monochrome.png'),
                backgroundColor: '#000000',
            },
            permissions: [
                'android.permission.RECORD_AUDIO',
                'android.permission.MODIFY_AUDIO_SETTINGS',
                'android.permission.ACCESS_NETWORK_STATE',
                'android.permission.POST_NOTIFICATIONS',
            ],
            blockedPermissions: [
                'android.permission.ACTIVITY_RECOGNITION',
                // Not using external storage/media access — blocks Google Play photo/video permission declaration
                'android.permission.READ_EXTERNAL_STORAGE',
                'android.permission.WRITE_EXTERNAL_STORAGE',
                'android.permission.READ_MEDIA_IMAGES',
                'android.permission.READ_MEDIA_VIDEO',
            ],
            package: bundleId,
            ...(googleServicesFile ? { googleServicesFile } : {}),
            intentFilters: linksHost ? [
                {
                    action: 'VIEW',
                    autoVerify: true,
                    data: [{ scheme: 'https', host: linksHost, pathPrefix: '/' }],
                    category: ['BROWSABLE', 'DEFAULT'],
                },
            ] : [],
        },
        web: {
            bundler: 'metro',
            output: 'single',
            favicon: asset('favicon.png'),
        },
        plugins: [
            require('./plugins/withEinkCompatibility.js'),
            ['expo-router', { root: './sources/app' }],
            'expo-updates',
            'expo-asset',
            'expo-localization',
            'expo-mail-composer',
            'expo-secure-store',
            'expo-web-browser',
            'react-native-vision-camera',
            '@more-tech/react-native-libsodium',
            'react-native-audio-api',
            '@livekit/react-native-expo-plugin',
            '@config-plugins/react-native-webrtc',
            ['expo-audio', {
                microphonePermission: 'Allow $(PRODUCT_NAME) to access your microphone for voice conversations.',
            }],
            ['expo-location', {
                locationAlwaysAndWhenInUsePermission: 'Allow $(PRODUCT_NAME) to improve AI quality by using your location.',
                locationAlwaysPermission: 'Allow $(PRODUCT_NAME) to improve AI quality by using your location.',
                locationWhenInUsePermission: 'Allow $(PRODUCT_NAME) to improve AI quality by using your location.',
            }],
            ['expo-calendar', {
                calendarPermission: 'Allow $(PRODUCT_NAME) to access your calendar to improve AI quality.',
            }],
            ['expo-camera', {
                cameraPermission: 'Allow $(PRODUCT_NAME) to access your camera to scan QR codes and share photos with AI.',
                microphonePermission: 'Allow $(PRODUCT_NAME) to access your microphone for voice conversations.',
                recordAudioAndroid: true,
            }],
            ['expo-notifications', {
                enableBackgroundRemoteNotifications: true,
                icon: asset('icon-notification.png'),
            }],
            ['expo-splash-screen', {
                ios: {
                    backgroundColor: '#F2F2F7',
                    dark: { backgroundColor: '#000000' },
                },
                android: {
                    image: asset('splash-android-light.png'),
                    backgroundColor: '#F5F5F5',
                    dark: {
                        image: asset('splash-android-dark.png'),
                        backgroundColor: '#000000',
                    },
                },
            }],
        ],
        ...(easProjectId ? {
            updates: {
                url: `https://u.expo.dev/${easProjectId}`,
                requestHeaders: { 'expo-channel-name': 'production' },
            },
        } : {}),
        experiments: {
            typedRoutes: true,
        },
        extra: {
            router: { root: './sources/app' },
            ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
            app: {
                postHogKey: env.EXPO_PUBLIC_POSTHOG_API_KEY,
                revenueCatAppleKey: env.EXPO_PUBLIC_REVENUE_CAT_APPLE,
                revenueCatGoogleKey: env.EXPO_PUBLIC_REVENUE_CAT_GOOGLE,
                revenueCatStripeKey: env.EXPO_PUBLIC_REVENUE_CAT_STRIPE,
                elevenLabsAgentId: ELEVENLABS_AGENT_ID,
                consoleLoggingDefault: defaults.consoleLoggingDefault,
                buildCommitSha: buildMetadata.commitSha,
                buildCommitTimestamp: buildMetadata.commitTimestamp,
            },
        },
        ...(easOwner ? { owner: easOwner } : {}),
    };
    return { expo };
}

module.exports = { buildExpoConfig, VARIANTS, PRODUCTION_REQUIRED };
```

- [ ] **Step 4: Rewrite `app.config.js`**

```js
// packages/happy-app/app.config.js
const { execFileSync } = require('node:child_process');
const { buildExpoConfig } = require('./expoConfig.cjs');

function git(args) {
    try {
        return execFileSync('git', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || undefined;
    } catch {
        return undefined;
    }
}

function loadBuildMetadata() {
    const commitSha =
        process.env.HAPPY_BUILD_COMMIT_SHA ||
        process.env.EAS_BUILD_GIT_COMMIT_HASH ||
        process.env.GITHUB_SHA ||
        git(['rev-parse', 'HEAD']);
    const commitTimestamp =
        process.env.HAPPY_BUILD_COMMIT_TIMESTAMP ||
        (commitSha
            ? git(['show', '-s', '--format=%cI', commitSha])
            : git(['show', '-s', '--format=%cI', 'HEAD']));

    return {
        commitSha,
        commitTimestamp,
    };
}

// HAPPY_SERVER_URL is the build's server (spec §3); the app reads it as
// EXPO_PUBLIC_HAPPY_SERVER_URL, which Expo inlines when bundling.
if (process.env.HAPPY_SERVER_URL && process.env.HAPPY_SERVER_URL.trim()) {
    process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = process.env.HAPPY_SERVER_URL.trim();
}

export default buildExpoConfig(process.env, loadBuildMetadata());
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter happy-app exec vitest run sources/appConfig.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Check the config through the Expo CLI**

```bash
cd packages/happy-app
pnpm exec expo config --type public --json | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(c.name,c.scheme,c.ios.bundleIdentifier)"
APP_ENV=production pnpm exec expo config --type public --json; echo "exit=$?"
APP_ENV=production APP_BUNDLE_ID=com.acme.happy APP_SCHEME=acmehappy HAPPY_SERVER_URL=https://happy.acme.example \
  pnpm exec expo config --type public --json | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(c.name,c.scheme,c.ios.bundleIdentifier)"
```
Expected: `Happy (dev) happy-dev com.example.happy.dev`; then an error containing `Production builds require APP_BUNDLE_ID, APP_SCHEME, HAPPY_SERVER_URL` and a non-zero exit; then `Happy acmehappy com.acme.happy`.

Then confirm the `HAPPY_SERVER_URL` → `EXPO_PUBLIC_HAPPY_SERVER_URL` mapping reaches the bundle:
```bash
cd packages/happy-app
rm -rf /tmp/happy-web-export
APP_ENV=production APP_BUNDLE_ID=com.acme.happy APP_SCHEME=acmehappy HAPPY_SERVER_URL=https://happy-mapping-check.example \
  pnpm exec expo export --platform web --output-dir /tmp/happy-web-export
grep -rl "happy-mapping-check.example" /tmp/happy-web-export/_expo/static/js/web | head -1
```
Expected: one bundle path printed. If nothing is printed, Expo inlined `EXPO_PUBLIC_*` before `app.config.js` ran; in that case keep the mapping in `app.config.js` and also document in `Dockerfile.webapp` (Step 7) that it sets `EXPO_PUBLIC_HAPPY_SERVER_URL` itself — which it already does — and record the result in the commit message body.

- [ ] **Step 7: Web image and dev environments**

`Dockerfile.webapp` (builder stage, lines 31–44): after `ARG HAPPY_SERVER_URL=""` add
```dockerfile
# Required by the production app config (spec §3 "Mobile builds"); no defaults.
ARG APP_BUNDLE_ID=""
ARG APP_SCHEME=""
```
and after `ENV EXPO_PUBLIC_HAPPY_SERVER_URL=$HAPPY_SERVER_URL` add
```dockerfile
ENV HAPPY_SERVER_URL=$HAPPY_SERVER_URL
ENV APP_BUNDLE_ID=$APP_BUNDLE_ID
ENV APP_SCHEME=$APP_SCHEME
```

`environments/environments.ts`: in `buildEnvVars`, after `OIDC_ALLOW_INSECURE_ISSUER: "true",` (line 806) add
```ts
        MOBILE_REDIRECT_URIS: "happy-dev://auth/callback,happy-preview://auth/callback",
```
and in `buildEnvSh`, after the `OIDC_ALLOW_INSECURE_ISSUER` export (line 850) add
```ts
    lines.push(`export MOBILE_REDIRECT_URIS="${vars.MOBILE_REDIRECT_URIS}"`);
```

Run: `pnpm --filter happy-app typecheck` — exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/happy-app/expoConfig.cjs packages/happy-app/app.config.js packages/happy-app/sources/appConfig.test.ts \
  Dockerfile.webapp environments/environments.ts
git commit -m "build: make the app identity configurable at build time"
```

---

### Task 7: Web app compose service

**Files:**
- Modify: `docker-compose.yaml`

**Interfaces:**
- Consumes: `Dockerfile.webapp` build args (Task 6).
- Produces: `docker compose --profile e2e up -d --build` serves the web app at `http://localhost:8080` (built for API `http://localhost:3005`), the server at `http://localhost:3005` with `WEBAPP_URL=http://localhost:8080`, oidc-mock at `http://localhost:8180`. `AUTH_REFRESH_REUSE_GRACE` on the compose server is overridable from the shell (default `60s`).

The server shares oidc-mock's network namespace, which publishes 3005; the browser (on the host) reaches the API at `http://localhost:3005`, so that is the URL baked into the web bundle. `WEBAPP_URL` is already `http://localhost:8080`. `deploy/oidc-mock/config.yaml` needs no change: its only redirect URI is the server's `/v1/auth/oidc/callback`; the web app never talks to the IdP directly.

- [ ] **Step 1: Add the service and server settings**

In `docker-compose.yaml`:
1. Replace the header comment with:
   ```yaml
   # Local corporate deployment: oidc-mock (IdP) + Postgres + happy-server (+ web app).
   # The server shares oidc-mock's network namespace so that "localhost:8180" is the
   # same issuer URL for the server and for the browser on the host.
   #
   #   docker compose up -d oidc-mock                   # IdP only (for integration tests)
   #   docker compose up -d --build                     # server stack; open http://localhost:3005/activate
   #   docker compose --profile e2e up -d --build       # + web app on http://localhost:8080 (Playwright e2e)
   #
   # Users (no password, pick in the UI): alice, bob.
   # AUTH_REFRESH_REUSE_GRACE=0s in the shell disables the server's lost-response
   # retry window, so the e2e suite can prove that tabs never replay a refresh token.
   ```
2. In `server.environment`, after `OIDC_ALLOW_INSECURE_ISSUER: "true"` add:
   ```yaml
      MOBILE_REDIRECT_URIS: happy-dev://auth/callback,happy-preview://auth/callback
      AUTH_REFRESH_REUSE_GRACE: ${AUTH_REFRESH_REUSE_GRACE:-60s}
   ```
3. Add a service after `server`:
   ```yaml
  webapp:
    profiles: [e2e]
    build:
      context: .
      dockerfile: Dockerfile.webapp
      args:
        # As seen by the browser on the host (oidc-mock publishes the server's port).
        HAPPY_SERVER_URL: http://localhost:3005
        # Placeholder identity for the production app config; unused on the web.
        APP_BUNDLE_ID: com.example.happy.web
        APP_SCHEME: happy-web
    depends_on:
      server: { condition: service_started }
    ports:
      - "8080:80"     # must match the server's WEBAPP_URL
   ```

Validate: `docker compose --profile e2e config >/dev/null && echo ok` → `ok`.

- [ ] **Step 2: Build and smoke-test the stack**

```bash
cd /home/rophy/projects/happy
docker compose --profile e2e up -d --build
for url in http://localhost:8180/.well-known/openid-configuration http://localhost:3005/health http://localhost:8080/; do
  for i in $(seq 1 120); do curl -sf -o /dev/null "$url" && break; sleep 1; done; curl -sf -o /dev/null "$url" && echo "up: $url"
done
curl -s http://localhost:8080/auth/callback | grep -c '<div id="root"'
BUNDLE=$(curl -s http://localhost:8080/ | grep -o '/_expo/static/js/web/[^"]*\.js' | head -1)
curl -s "http://localhost:8080${BUNDLE}" | grep -c 'localhost:3005'
CH=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "http://localhost:3005/v1/auth/oidc/login?client=web&code_challenge=$CH"
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:3005/v1/auth/oidc/login?client=mobile&code_challenge=$CH&redirect_uri=happy-dev://auth/callback"
```
Expected: three `up:` lines; `1` (the SPA shell is served for `/auth/callback`); a count ≥ 1 (the API URL is in the bundle); `302 http://localhost:8180/authorize?…`; `302` (the dev scheme is an allowed mobile redirect).

Leave the stack running for Task 8, or stop it with `docker compose --profile e2e down`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yaml
git commit -m "build: add web app compose service for e2e"
```

---

### Task 8: Playwright e2e for web sign-in

**Files:**
- Create: `e2e/package.json`, `e2e/package-lock.json` (generated), `e2e/playwright.config.ts`, `e2e/globalSetup.ts`, `e2e/tests/helpers.ts`, `e2e/tests/auth.spec.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: the compose stack (Task 7); the sign-in button text `Sign in` (Task 3); the signed-in empty state containing `happy auth login` (Task 5); localStorage key `auth_credentials` (Task 3); the account screen at `/settings/account` with the item `Logout` and the web confirm modal whose confirm button is also `Logout`; the oidc-mock picker (one `<form>` per user with a submit `<button>` labelled with the user's name, e.g. "Alice Example").

`e2e/` is standalone: it is not listed in `pnpm-workspace.yaml` or the root `package.json` `workspaces`, and it uses npm with its own lockfile.

- [ ] **Step 1: Project scaffolding**

```json
// e2e/package.json
{
  "name": "happy-e2e",
  "private": true,
  "description": "Playwright end-to-end tests against the docker compose stack (docker compose --profile e2e up -d --build).",
  "scripts": {
    "test": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "1.63.0"
  }
}
```

```ts
// e2e/playwright.config.ts
import { defineConfig } from '@playwright/test';

// The stack is started outside Playwright: docker compose --profile e2e up -d --build.
// For the two-tab test to prove there is no refresh-token replay, start the server
// with AUTH_REFRESH_REUSE_GRACE=0s (CI does).
export default defineConfig({
    testDir: './tests',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 120_000,
    expect: { timeout: 30_000 },
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    globalSetup: './globalSetup.ts',
    use: {
        baseURL: process.env.HAPPY_WEBAPP_URL ?? 'http://localhost:8080',
        // Phone-sized viewport: the phone layout shows the empty state with the CLI hint.
        viewport: { width: 375, height: 667 },
        browserName: 'chromium',
        trace: 'retain-on-failure',
    },
});
```

```ts
// e2e/globalSetup.ts
const ISSUER = process.env.HAPPY_OIDC_ISSUER ?? 'http://localhost:8180';
const SERVER = process.env.HAPPY_SERVER_URL ?? 'http://localhost:3005';
const WEBAPP = process.env.HAPPY_WEBAPP_URL ?? 'http://localhost:8080';

export default async function globalSetup(): Promise<void> {
    const deadline = Date.now() + 180_000;
    for (const url of [`${ISSUER}/.well-known/openid-configuration`, `${SERVER}/health`, `${WEBAPP}/`]) {
        for (;;) {
            try {
                const response = await fetch(url);
                if (response.ok) break;
            } catch {
                // not up yet
            }
            if (Date.now() > deadline) {
                throw new Error(`${url} is not reachable. Start the stack: docker compose --profile e2e up -d --build`);
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
}
```

Append to `.gitignore`:
```
# Playwright e2e
e2e/test-results/
e2e/playwright-report/
```

Run:
```bash
cd e2e && npm install && npx playwright install chromium
```
Expected: `package-lock.json` created; Chromium downloaded.

- [ ] **Step 2: Helpers**

```ts
// e2e/tests/helpers.ts
import { expect, type Page } from '@playwright/test';

export const SERVER_URL = process.env.HAPPY_SERVER_URL ?? 'http://localhost:3005';
const WEBAPP_URL = process.env.HAPPY_WEBAPP_URL ?? 'http://localhost:8080';
const AUTH_KEY = 'auth_credentials';

export interface Credentials {
    token: string;
    refreshToken: string;
    secret: string;
}

export async function readCredentials(page: Page): Promise<Credentials | null> {
    return page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    }, AUTH_KEY);
}

export async function writeCredentials(page: Page, credentials: Credentials): Promise<void> {
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [AUTH_KEY, JSON.stringify(credentials)] as const);
}

/** Same access token, but already expired: the app must refresh before using it. */
export function expireAccessToken(token: string): string {
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    claims.exp = Math.floor(Date.now() / 1000) - 60;
    return `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
}

export function accessTokenExpiry(token: string): number {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return claims.exp * 1000;
}

/** POST /v1/auth/refresh from the page; returns the HTTP status. */
export async function redeemRefreshToken(page: Page, refreshToken: string): Promise<number> {
    return page.evaluate(async ([url, token]) => {
        const response = await fetch(`${url}/v1/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: token }),
        });
        return response.status;
    }, [SERVER_URL, refreshToken] as const);
}

export async function expectSignedIn(page: Page): Promise<void> {
    await expect(page.getByText('happy auth login').first()).toBeVisible();
    await expect(page.getByText('Sign in', { exact: true })).toHaveCount(0);
    const credentials = await readCredentials(page);
    expect(credentials?.refreshToken).toBeTruthy();
    expect(page.url()).not.toContain('#code');
}

export async function expectSignedOut(page: Page): Promise<void> {
    await expect(page.getByText('Sign in', { exact: true })).toBeVisible();
    expect(await readCredentials(page)).toBeNull();
}

/** Sign-in button → server → oidc-mock picker → server → /auth/callback → home. */
export async function signIn(page: Page, user = 'Alice Example'): Promise<void> {
    await page.goto('/');
    await page.getByText('Sign in', { exact: true }).click();
    await page.getByRole('button', { name: new RegExp(user) }).click();
    await page.waitForURL((url) => url.origin === new URL(WEBAPP_URL).origin && url.pathname === '/');
    await expectSignedIn(page);
}
```

- [ ] **Step 3: The tests**

```ts
// e2e/tests/auth.spec.ts
import { expect, test, type Request } from '@playwright/test';
import {
    SERVER_URL,
    accessTokenExpiry,
    expectSignedIn,
    expectSignedOut,
    expireAccessToken,
    readCredentials,
    redeemRefreshToken,
    signIn,
    writeCredentials,
} from './helpers';

test('signs in through the identity provider', async ({ page }) => {
    await signIn(page);
    // Reloading keeps the session (credentials persisted, no second login).
    await page.reload();
    await expectSignedIn(page);
});

test('logout returns to sign-in and revokes the device', async ({ page }) => {
    await signIn(page);
    const before = (await readCredentials(page))!;

    await page.goto('/settings/account');
    await page.getByText('Logout', { exact: true }).first().click();
    // The web confirm modal renders after the page, so its "Logout" button is the last match.
    await page.getByText('Logout', { exact: true }).last().click();

    await page.waitForURL((url) => url.pathname === '/');
    await expectSignedOut(page);
    expect(await redeemRefreshToken(page, before.refreshToken)).toBe(401);
});

test('a revoked session returns to sign-in', async ({ page }) => {
    await signIn(page);
    const credentials = (await readCredentials(page))!;

    const status = await page.evaluate(async ([url, token]) => {
        const response = await fetch(`${url}/v1/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        return response.status;
    }, [SERVER_URL, credentials.token] as const);
    expect(status).toBe(200);

    // Force the next request to refresh: the revoked device's refresh token is rejected.
    await writeCredentials(page, { ...credentials, token: expireAccessToken(credentials.token) });
    await page.reload();
    await expectSignedOut(page);
});

test('two tabs share one refresh without revoking the device', async ({ context }) => {
    const tabA = await context.newPage();
    await signIn(tabA);
    const tabB = await context.newPage();
    await tabB.goto('/');
    await expectSignedIn(tabB);

    const refreshes: Request[] = [];
    for (const tab of [tabA, tabB]) {
        tab.on('request', (request) => {
            if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/auth/refresh') {
                refreshes.push(request);
            }
        });
    }

    // Both tabs start from an expired access token and must refresh at the same time.
    const credentials = (await readCredentials(tabA))!;
    await writeCredentials(tabA, { ...credentials, token: expireAccessToken(credentials.token) });
    await Promise.all([tabA.reload(), tabB.reload()]);
    await expectSignedIn(tabA);
    await expectSignedIn(tabB);

    // One tab refreshed; the other adopted its rotation inside the lock.
    expect(refreshes).toHaveLength(1);
    const after = (await readCredentials(tabA))!;
    expect(after.refreshToken).not.toBe(credentials.refreshToken);
    expect(accessTokenExpiry(after.token)).toBeGreaterThan(Date.now() + 2 * 60 * 1000);

    // The device survived: its current refresh token still redeems.
    expect(await redeemRefreshToken(tabA, after.refreshToken)).toBe(200);
});
```

- [ ] **Step 4: Run the suite**

```bash
cd /home/rophy/projects/happy
AUTH_REFRESH_REUSE_GRACE=0s docker compose --profile e2e up -d --build
cd e2e && npx playwright test
```
Expected: 4 passed. On failure, open the trace (`npx playwright show-trace test-results/<test>/trace.zip`). If a text selector does not match because the rendered DOM differs from the assumptions under **Interfaces**, fix the selector against the trace's DOM snapshot, not by adding waits.

Tear down: `cd .. && docker compose --profile e2e down`.

- [ ] **Step 5: Commit**

```bash
git add e2e/package.json e2e/package-lock.json e2e/playwright.config.ts e2e/globalSetup.ts e2e/tests .gitignore
git commit -m "test: add Playwright e2e for web sign-in"
```

---

### Task 9: CI

**Files:**
- Create: `.github/workflows/web-e2e.yml`
- Modify: `.github/workflows/typecheck.yml`

- [ ] **Step 1: Web e2e workflow**

```yaml
# .github/workflows/web-e2e.yml
name: Web E2E

on:
  push:
    branches: [ main ]
    paths:
      - 'packages/happy-app/**'
      - 'packages/happy-server/**'
      - 'packages/happy-wire/**'
      - 'e2e/**'
      - 'Dockerfile.webapp'
      - 'Dockerfile.server'
      - 'docker-compose.yaml'
      - 'deploy/oidc-mock/**'
      - 'package.json'
      - 'pnpm-lock.yaml'
      - 'pnpm-workspace.yaml'
      - 'patches/**'
      - '.github/workflows/web-e2e.yml'
  pull_request:
    branches: [ main ]
    paths:
      - 'packages/happy-app/**'
      - 'packages/happy-server/**'
      - 'packages/happy-wire/**'
      - 'e2e/**'
      - 'Dockerfile.webapp'
      - 'Dockerfile.server'
      - 'docker-compose.yaml'
      - 'deploy/oidc-mock/**'
      - 'package.json'
      - 'pnpm-lock.yaml'
      - 'pnpm-workspace.yaml'
      - 'patches/**'
      - '.github/workflows/web-e2e.yml'
  workflow_dispatch:

jobs:
  web-e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 45

    # No lost-response grace on the compose server: a refresh-token replay between
    # tabs revokes the device, so the two-tab test proves the refresh lock works.
    env:
      AUTH_REFRESH_REUSE_GRACE: 0s

    steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Setup Node
      uses: actions/setup-node@v4
      with:
        node-version: 20
        cache: npm
        cache-dependency-path: e2e/package-lock.json

    - name: Start stack
      run: docker compose --profile e2e up -d --build

    - name: Wait for services
      run: |
        for url in http://localhost:8180/.well-known/openid-configuration http://localhost:3005/health http://localhost:8080/; do
          ok=0
          for i in $(seq 1 120); do
            if curl -sf -o /dev/null "$url"; then ok=1; echo "up: $url"; break; fi
            sleep 1
          done
          if [ "$ok" != "1" ]; then
            echo "Error: $url did not come up"
            docker compose --profile e2e ps
            docker compose --profile e2e logs
            exit 1
          fi
        done

    - name: Install e2e dependencies
      working-directory: e2e
      run: npm ci

    - name: Install Chromium
      working-directory: e2e
      run: npx playwright install --with-deps chromium

    - name: Playwright
      working-directory: e2e
      run: npx playwright test

    - name: Upload Playwright report
      if: failure()
      uses: actions/upload-artifact@v4
      with:
        name: playwright-report
        path: |
          e2e/playwright-report
          e2e/test-results
        retention-days: 7

    - name: Stack logs on failure
      if: failure()
      run: docker compose --profile e2e logs

    - name: Stop stack
      if: always()
      run: docker compose --profile e2e down -v || true
```

- [ ] **Step 2: App auth unit tests in the existing app workflow**

In `.github/workflows/typecheck.yml`, after the `TypeScript typecheck` step add:
```yaml
            # The auth-related unit tests (spec §4 "Unit (app)"). The full app suite
            # is not green upstream (sessionPresentation.test.ts fails at import), so
            # these files run explicitly.
            - name: App auth unit tests
              run: >-
                  pnpm --filter happy-app exec vitest run
                  sources/auth
                  sources/appConfig.test.ts
                  sources/utils/parseToken.test.ts
                  sources/sync/serverUrl.test.ts
                  sources/sync/apiSocket.auth.test.ts
```

- [ ] **Step 3: Validate and commit**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/web-e2e.yml')); yaml.safe_load(open('.github/workflows/typecheck.yml')); print('ok')"
pnpm --filter happy-app exec vitest run sources/auth sources/appConfig.test.ts sources/utils/parseToken.test.ts sources/sync/serverUrl.test.ts sources/sync/apiSocket.auth.test.ts
```
Expected: `ok`; all listed test files pass.

```bash
git add .github/workflows/web-e2e.yml .github/workflows/typecheck.yml
git commit -m "build: run web e2e and app auth tests in CI"
```

---

## Manual verification (mobile, spec §4)

Not automated in v1. With the compose stack up and a dev client build (`APP_ENV=development`, scheme `happy-dev`) pointed at a server reachable from the device (`HAPPY_SERVER_URL`):

1. Tap **Sign in** → the system browser opens the IdP → pick a user → the browser closes and the app shows the link-your-computer checklist with `happy auth login`.
2. Kill and reopen the app → still signed in.
3. Account → Logout → back to **Sign in**; the old refresh token is rejected by `/v1/auth/refresh`.
4. On Android, confirm the app does not open a blank `/auth/callback` screen after sign-in (the `+native-intent` redirect).

## Self-Review

**Spec coverage:**
- §2 Web app: login URL with PKCE challenge → Task 2 (`buildLoginUrl`), Task 3 (`signIn`); `#code` callback, fragment removed before exchange → Task 3 (`webCallback.ts`, `auth/callback.tsx`); exchange with `codeVerifier` + `ephemeralPublicKey`, `keyBundle` opened → Task 2 (`exchangeCode`); credentials `{token, refreshToken, secret}`, missing refresh token = logged out → Tasks 1, 3; verifier and ephemeral key in sessionStorage → Task 3.
- Token handling: 2-minute proactive refresh, single-flight → Task 1; `authFetch` with one 401 retry → Tasks 1, 4; socket auth awaits a fresh token → Task 4; `navigator.locks` `happy-auth-refresh`, re-read + adopt → Tasks 1, 3; `storage` event follow/logout → Tasks 1, 3; `invalid_grant` → logout path → Tasks 1, 3; pending-rotation safeguard → Task 1.
- Server URL only from `EXPO_PUBLIC_HAPPY_SERVER_URL` / `__HAPPY_CONFIG__.serverUrl` → Task 5.
- §2 Mobile: system browser auth session, build scheme callback → Task 3 (`signIn`, `+native-intent`), Task 6 (scheme from `APP_SCHEME`).
- §2 Logout: server revoke + local wipe → Tasks 1, 3; covered by e2e → Task 8.
- §2 Removed from clients (app) → Tasks 3 (restore screens, dev credentials), 5 (everything else); `happy-agent`/`happy-mobile-gym` deferred (Global Constraints).
- §3 Mobile builds: all env vars, production fail-fast, links/EAS only when set, dev/preview placeholders → Task 6; `MOBILE_REDIRECT_URIS` lists the scheme callbacks → Tasks 6–7.
- §3 Local deployment: web app compose service behind a profile, built with the compose server URL → Task 7.
- §4 Unit (app): callback parsing, exchange, token storage, refresh, app.config fail-fast → Tasks 1, 2, 3, 6. E2E (web): login, logout, revoked session, two tabs → Task 8. CI → Task 9. Mobile manual → section above.

**Placeholder scan:** every code step has complete code; edits to existing files name the lines and give the replacement. The one conditional (Task 6 Step 6, if Expo inlines before the config maps `HAPPY_SERVER_URL`) states what to keep and what to record; the web image is unaffected either way because `Dockerfile.webapp` sets `EXPO_PUBLIC_HAPPY_SERVER_URL` directly.

**Type consistency:** `StoredCredentials` (Task 1) = `AuthCredentials` (Task 3); `TokenStore.getAccessToken/refresh/applyExternalChange/logoutOnServer/stop/current/hasPendingRotation` are used with those names in Tasks 3–4; `setAccessTokenProvider`, `getAccessToken`, `authFetch`, `headersToRecord`, `staticAccessTokenProvider` (Task 1) match Tasks 3–4; `PendingLogin`, `createPendingLogin`, `buildLoginUrl`, `exchangeCode`, `serializePendingLogin`, `deserializePendingLogin`, `OidcLoginError` (Task 2) match `signIn.ts` (Task 3); `parseWebCallbackHash`, `parseMobileCallbackUrl`, `isAuthCallbackPath` (Task 2) match `webCallback.ts`, `signIn.ts`, `+native-intent.tsx`; `getServerLabel` / `getServerInfo` (Task 5) match their consumers; `SyncSocketConfig = { endpoint }` matches `sync.ts`.
