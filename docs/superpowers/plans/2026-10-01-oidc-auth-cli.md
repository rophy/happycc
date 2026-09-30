# OIDC Auth — CLI Implementation Plan (Plan 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `happy` (packages/happy-cli) sign in with the server-brokered OIDC device flow, keep 15-minute access tokens fresh across all CLI processes, and remove the keypair/QR, desktop-import and local-server paths.

**Architecture:** A process-wide `tokenStore` owns the access token: HTTP clients and sockets read it synchronously; it refreshes proactively before expiry and reactively via one global axios 401 interceptor. Refresh runs under a cross-process file lock on `~/.happy/access.key` and adopts a token another process already rotated. Login is a device flow (`/v1/auth/device/start` → user approves at `/activate` → poll `/v1/auth/device/token`), delivering the same `[0 | contentPublicKey]` key bundle the CLI already consumes.

**Tech Stack:** TypeScript (ESM), axios, tweetnacl, socket.io-client, Vitest 3 (`unit` project), node:http fake servers in tests, oidc-mock + happy-server for integration.

**Spec:** `docs/superpowers/specs/2026-09-30-oidc-auth-design.md` (§2 "CLI and daemon", "Refresh", "Sockets", "Logout", "Removed from clients")

**Depends on:** Plan 1 (server) merged on `main`.

## Global Constraints

- Server contract (implemented in plan 1):
  - `POST /v1/auth/device/start {ephemeralPublicKey: base64(32 bytes), clientInfo: {host, os, cliVersion}}` → `200 {deviceCode, userCode, verifyUrl, verifyUrlComplete, interval, expiresIn}`.
  - `POST /v1/auth/device/token {deviceCode}` → `400 {error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | 'invalid_grant'}` or `200 {accountId, accessToken, refreshToken, keyBundle}`; `keyBundle` = base64 `[ephPub(32) | nonce(24) | box([0x00 | contentPublicKey(32)])]`.
  - `POST /v1/auth/refresh {refreshToken}` → `200 {accessToken, refreshToken}` or `401 {error: 'invalid_grant', reason}`. Replaying a rotated refresh token revokes the device.
  - `POST /v1/auth/logout` with `Authorization: Bearer <access token>` → `200 {success: true}`.
  - Access tokens are HS256 JWTs with `exp` (default 15 min). Sockets are disconnected at `exp` + 60 s.
- Credentials file `configuration.privateKeyFile` (`~/.happy/access.key`): `{ token, refreshToken, encryption: { publicKey: base64, machineKey: base64 } }`, written atomically (temp + rename) with mode `0o600`, only while holding the lock `access.key.lock`. A file without `refreshToken` is treated as logged out.
- Proactive refresh margin: 2 minutes before `exp`. Retry after a non-auth refresh failure: 30 s. At most one 401-triggered retry per HTTP request, only for requests to the configured server's origin.
- Login output must contain a line with the full `verifyUrlComplete` URL (tests and env seeding parse `https?://…/activate?code=XXXX-XXXX`).
- Do not print tokens or key material anywhere (logs, status output).
- `happy-agent` and `happy-mobile-gym` are out of scope (later plan).
- Commit messages: `<type>: <short description>`; types feat/fix/refactor/chore/docs/build/test; no AI attribution, no `Co-Authored-By`, no mention of Claude. Commits are GPG-signed automatically — never disable signing.
- CLI unit tests: `pnpm --filter happy exec vitest run --project unit <files>`; full: `pnpm --filter happy test` (builds first). Typecheck: `pnpm --filter happy typecheck` if the script exists, otherwise `pnpm --filter happy build`.

## File Structure

```
packages/happy-cli/
  src/utils/fileLock.ts (+ .test.ts)        create: withFileLock(lockPath, fn) (extracted from updateSettings)
  src/persistence.ts                         modify: updateSettings uses withFileLock; Credentials gains refreshToken;
                                                     writeCredentials (atomic, 0600); clearCredentialsIfRefreshToken;
                                                     remove writeCredentialsLegacy / writeCredentialsDataKey (Task 5)
  src/persistence.credentials.test.ts        create
  src/api/jwt.ts (+ .test.ts)                create: decodeJwtExpiry
  src/api/tokenStore.ts (+ .test.ts)         create: tokenStore singleton, LoggedOutError, credentialsLockFile
  src/testing/fakeAuthServer.ts              create: node:http fake for /v1/auth/* in unit tests
  src/api/api.ts                             modify: tokenStore.init + token getters
  src/api/apiSession.ts, apiMachine.ts       modify: token source (string | () => string), socket auth callback
  src/api/pushNotifications.ts               modify: token source
  src/daemon/run.ts                          modify: fresh token in fetchServerSessionMetadata; shutdown on logout
  src/resume/resolveHappySession.ts, src/resume/localResumeStore.ts   modify: tokenStore.getAccessToken()
  src/ui/auth.ts                             rewrite: device flow (deviceLogin, doAuth), authAndSetupMachineIfNeeded
  src/ui/auth.test.ts                        create
  src/ui/qrcode.ts                           modify: title text
  src/commands/auth.ts                       modify: logout calls server; status without token preview; drop desktop
  src/index.ts                               modify: remove `server` subcommand
  delete: src/ui/ink/AuthSelector.tsx, src/api/webAuth.ts, src/api/auth.ts, src/commands/desktopAuth.ts,
          src/commands/desktopAuth.test.ts, src/commands/server.ts (+ any server tests)
.github/workflows/cli-smoke-test.yml         modify: drop self-host build/pack/install and "Test packaged server"
environments/environments.ts                 modify: OIDC env for the server, device-flow seeding via `happy auth login`
```

---

### Task 1: Shared file lock

**Files:**
- Create: `packages/happy-cli/src/utils/fileLock.ts`
- Test: `packages/happy-cli/src/utils/fileLock.test.ts`
- Modify: `packages/happy-cli/src/persistence.ts` (`updateSettings`)

**Interfaces:**
- Produces: `withFileLock<T>(lockPath: string, fn: () => Promise<T>, opts?: { retryIntervalMs?: number; maxAttempts?: number; staleAfterMs?: number }): Promise<T>` — exclusive lock via `open(lockPath, O_CREAT|O_EXCL|O_WRONLY)`; retries every 100 ms up to 50 times (5 s); removes a lock file older than 10 s as stale; always releases (close + unlink) in `finally`; throws `Error('Failed to acquire lock <lockPath>')` when exhausted.

- [ ] **Step 1: Write the failing test**

```ts
// packages/happy-cli/src/utils/fileLock.test.ts
import { mkdtempSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFileLock } from './fileLock';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'happy-lock-')); });
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

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy exec vitest run --project unit src/utils/fileLock.test.ts`
Expected: FAIL — cannot resolve `./fileLock`.

- [ ] **Step 3: Implement**

```ts
// packages/happy-cli/src/utils/fileLock.ts
import { constants } from 'node:fs';
import { open, stat, unlink } from 'node:fs/promises';

export async function withFileLock<T>(
    lockPath: string,
    fn: () => Promise<T>,
    opts: { retryIntervalMs?: number; maxAttempts?: number; staleAfterMs?: number } = {},
): Promise<T> {
    const retryIntervalMs = opts.retryIntervalMs ?? 100;
    const maxAttempts = opts.maxAttempts ?? 50;
    const staleAfterMs = opts.staleAfterMs ?? 10_000;

    let handle;
    for (let attempt = 0; attempt < maxAttempts && !handle; attempt++) {
        try {
            handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        } catch (err: any) {
            if (err.code !== 'EEXIST') {
                throw err;
            }
            try {
                const stats = await stat(lockPath);
                if (Date.now() - stats.mtimeMs > staleAfterMs) {
                    await unlink(lockPath).catch(() => { });
                    continue;
                }
            } catch { }
            await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
        }
    }
    if (!handle) {
        throw new Error(`Failed to acquire lock ${lockPath}`);
    }
    try {
        return await fn();
    } finally {
        await handle.close();
        await unlink(lockPath).catch(() => { });
    }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter happy exec vitest run --project unit src/utils/fileLock.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Use it in `updateSettings`**

In `packages/happy-cli/src/persistence.ts`, replace the body of `updateSettings` (the lock constants, the acquire loop, and the `try/finally`) with:

```ts
export async function updateSettings(
  updater: (current: Settings) => Settings | Promise<Settings>
): Promise<Settings> {
  const tmpFile = configuration.settingsFile + '.tmp';
  return withFileLock(configuration.settingsFile + '.lock', async () => {
    const current = await readSettings() || { ...defaultSettings };
    const updated = await updater(current);
    if (!existsSync(configuration.happyHomeDir)) {
      await mkdir(configuration.happyHomeDir, { recursive: true });
    }
    await writeFile(tmpFile, JSON.stringify(updated, null, 2));
    await rename(tmpFile, configuration.settingsFile); // Atomic on POSIX
    return updated;
  });
}
```

Add `import { withFileLock } from '@/utils/fileLock';` and remove imports that become unused (`open`, `stat`, `constants`) only if nothing else in the file uses them.

- [ ] **Step 6: Run the CLI unit suite and commit**

Run: `pnpm --filter happy test`
Expected: all unit tests pass.

```bash
git add packages/happy-cli/src/utils/fileLock.ts packages/happy-cli/src/utils/fileLock.test.ts packages/happy-cli/src/persistence.ts
git commit -m "refactor: extract cross-process file lock from settings updates"
```

---

### Task 2: Credentials with refresh token

**Files:**
- Modify: `packages/happy-cli/src/persistence.ts` (Authentication section)
- Test: `packages/happy-cli/src/persistence.credentials.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type Credentials = {
    token: string,
    refreshToken: string,
    encryption: { type: 'legacy', secret: Uint8Array } | { type: 'dataKey', publicKey: Uint8Array, machineKey: Uint8Array }
  }
  function readCredentials(): Promise<Credentials | null>        // null when file missing, invalid, or without refreshToken
  function writeCredentials(credentials: Credentials): Promise<void>  // dataKey only; atomic; 0600; caller holds the lock
  function clearCredentialsIfRefreshToken(refreshToken: string): Promise<boolean>
  ```
  `writeCredentialsLegacy` / `writeCredentialsDataKey` stay until Task 5 deletes their only caller.

- [ ] **Step 1: Write the failing test**

```ts
// packages/happy-cli/src/persistence.credentials.test.ts
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfiguration = vi.hoisted(() => ({ happyHomeDir: '', privateKeyFile: '', settingsFile: '' }));
vi.mock('@/configuration', () => ({ configuration: mockConfiguration }));

import { clearCredentialsIfRefreshToken, readCredentials, writeCredentials } from './persistence';

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-creds-'));
    mockConfiguration.happyHomeDir = dir;
    mockConfiguration.privateKeyFile = join(dir, 'access.key');
    mockConfiguration.settingsFile = join(dir, 'settings.json');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const creds = () => ({
    token: 'access-1',
    refreshToken: 'refresh-1',
    encryption: { type: 'dataKey' as const, publicKey: new Uint8Array(32).fill(1), machineKey: new Uint8Array(32).fill(2) },
});

describe('credentials', () => {
    it('round-trips token, refresh token and keys', async () => {
        await writeCredentials(creds());
        const read = await readCredentials();
        expect(read).toEqual(creds());
    });

    it('writes the file with mode 0600 and no temp file left behind', async () => {
        await writeCredentials(creds());
        expect(statSync(mockConfiguration.privateKeyFile).mode & 0o777).toBe(0o600);
        expect(existsSync(mockConfiguration.privateKeyFile + '.tmp')).toBe(false);
    });

    it('treats credentials without a refresh token as logged out', async () => {
        writeFileSync(mockConfiguration.privateKeyFile, JSON.stringify({
            token: 'old', encryption: { publicKey: Buffer.alloc(32).toString('base64'), machineKey: Buffer.alloc(32).toString('base64') },
        }));
        expect(await readCredentials()).toBeNull();
        writeFileSync(mockConfiguration.privateKeyFile, JSON.stringify({ token: 'old', secret: Buffer.alloc(32).toString('base64') }));
        expect(await readCredentials()).toBeNull();
    });

    it('refuses to write legacy credentials', async () => {
        await expect(writeCredentials({ token: 't', refreshToken: 'r', encryption: { type: 'legacy', secret: new Uint8Array(32) } }))
            .rejects.toThrow('Only dataKey credentials can be written');
    });

    it('clears credentials only when they still hold the given refresh token', async () => {
        await writeCredentials(creds());
        expect(await clearCredentialsIfRefreshToken('other')).toBe(false);
        expect(await readCredentials()).not.toBeNull();
        expect(await clearCredentialsIfRefreshToken('refresh-1')).toBe(true);
        expect(await readCredentials()).toBeNull();
    });

    it('never writes the token into anything but the credentials file', async () => {
        await writeCredentials(creds());
        expect(readFileSync(mockConfiguration.privateKeyFile, 'utf8')).toContain('"refreshToken": "refresh-1"');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy exec vitest run --project unit src/persistence.credentials.test.ts`
Expected: FAIL — `writeCredentials` / `clearCredentialsIfRefreshToken` are not exported.

- [ ] **Step 3: Implement**

In `packages/happy-cli/src/persistence.ts`, Authentication section:

1. Add `refreshToken: z.string().nullish(),` to `credentialsSchema` after `token`.
2. Add `refreshToken: string,` to the `Credentials` type after `token`.
3. In `readCredentials`, right after `const credentials = credentialsSchema.parse(...)`, add `if (!credentials.refreshToken) { return null; }`, and include `refreshToken: credentials.refreshToken,` in both returned objects.
4. Add below `writeCredentialsDataKey`:

```ts
/** Atomic write (temp + rename, 0600). Callers hold the credentials lock (see tokenStore). */
export async function writeCredentials(credentials: Credentials): Promise<void> {
  if (credentials.encryption.type !== 'dataKey') {
    throw new Error('Only dataKey credentials can be written');
  }
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true, mode: 0o700 })
  }
  const tmpFile = configuration.privateKeyFile + '.tmp';
  await writeFile(tmpFile, JSON.stringify({
    token: credentials.token,
    refreshToken: credentials.refreshToken,
    encryption: {
      publicKey: encodeBase64(credentials.encryption.publicKey),
      machineKey: encodeBase64(credentials.encryption.machineKey),
    },
  }, null, 2), { mode: 0o600 });
  await rename(tmpFile, configuration.privateKeyFile);
}

/** Clears the credentials only if they still carry `refreshToken` (a newer login is kept). */
export async function clearCredentialsIfRefreshToken(refreshToken: string): Promise<boolean> {
  const current = await readCredentials();
  if (!current || current.refreshToken !== refreshToken) {
    return false;
  }
  await clearCredentials();
  return true;
}
```

5. `writeCredentialsLegacy` / `writeCredentialsDataKey` return types reference `Credentials`-shaped objects without `refreshToken`; make them compile by leaving their bodies unchanged (they don't use the `Credentials` type). Fix any other compile error caused by the new required `refreshToken` field in the smallest way (test fixtures that build `Credentials` literals: add `refreshToken: 'test-refresh'`).

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter happy exec vitest run --project unit src/persistence.credentials.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Full unit suite + commit**

Run: `pnpm --filter happy test` — expected green (fix fixtures as described if any break).

```bash
git add packages/happy-cli/src/persistence.ts packages/happy-cli/src/persistence.credentials.test.ts
git add -u packages/happy-cli/src
git commit -m "feat: store refresh tokens in CLI credentials"
```

---

### Task 3: Token store

**Files:**
- Create: `packages/happy-cli/src/api/jwt.ts`, `packages/happy-cli/src/api/tokenStore.ts`, `packages/happy-cli/src/testing/fakeAuthServer.ts`
- Test: `packages/happy-cli/src/api/jwt.test.ts`, `packages/happy-cli/src/api/tokenStore.test.ts`

**Interfaces:**
- Consumes: `withFileLock` (Task 1); `readCredentials`, `writeCredentials`, `clearCredentialsIfRefreshToken`, `Credentials` (Task 2); `configuration.serverUrl`, `configuration.privateKeyFile`, `configuration.currentCliVersion`.
- Produces:
  ```ts
  // jwt.ts
  function decodeJwtExpiry(token: string): number | null   // exp * 1000, or null if not a JWT with numeric exp
  // tokenStore.ts
  class LoggedOutError extends Error {}
  function credentialsLockFile(): string                   // configuration.privateKeyFile + '.lock'
  const tokenStore: {
    init(credentials: Credentials): void                   // idempotent; schedules proactive refresh; installs the axios 401 interceptor once
    current(): string                                      // sync; throws if not initialized
    getAccessToken(): Promise<string>                      // loads credentials if needed; refreshes if expiring
    refresh(rejectedToken: string): Promise<string>        // single-flight; adopt-or-refresh under the lock
    onLoggedOut(listener: (error: LoggedOutError) => void): () => void
    resetForTests(): void
  }
  // fakeAuthServer.ts (tests only)
  function startFakeAuthServer(handlers: Partial<Record<string, (body: any, req: IncomingMessage) => { status: number; body: unknown }>>): Promise<{ url: string; calls: Array<{ path: string; body: any; authorization?: string }>; close(): Promise<void> }>
  function makeJwt(expSecondsFromNow: number, sub?: string): string   // unsigned-looking JWT with exp (signature not checked by the CLI)
  ```

- [ ] **Step 1: Write the failing JWT test**

```ts
// packages/happy-cli/src/api/jwt.test.ts
import { describe, expect, it } from 'vitest';
import { decodeJwtExpiry } from './jwt';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('decodeJwtExpiry', () => {
    it('returns exp in milliseconds', () => {
        expect(decodeJwtExpiry(`${b64({ alg: 'HS256' })}.${b64({ exp: 1_800_000_000 })}.sig`)).toBe(1_800_000_000_000);
    });
    it('returns null for non-JWTs and missing exp', () => {
        expect(decodeJwtExpiry('fake-token')).toBeNull();
        expect(decodeJwtExpiry(`${b64({})}.${b64({ sub: 'x' })}.sig`)).toBeNull();
        expect(decodeJwtExpiry('a.%%%.c')).toBeNull();
    });
});
```

- [ ] **Step 2: Implement `jwt.ts`**

```ts
// packages/happy-cli/src/api/jwt.ts
/** Reads `exp` from a JWT without verifying it (the server verifies). Milliseconds, or null. */
export function decodeJwtExpiry(token: string): number | null {
    const parts = token.split('.');
    if (parts.length !== 3) {
        return null;
    }
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
    } catch {
        return null;
    }
}
```

Run: `pnpm --filter happy exec vitest run --project unit src/api/jwt.test.ts` — expected PASS.

- [ ] **Step 3: Create the fake auth server helper**

```ts
// packages/happy-cli/src/testing/fakeAuthServer.ts
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

type Handler = (body: any, req: IncomingMessage) => { status: number; body: unknown };

export async function startFakeAuthServer(handlers: Partial<Record<string, Handler>>) {
    const calls: Array<{ path: string; body: any; authorization?: string }> = [];
    const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : undefined;
            const path = (req.url ?? '').split('?')[0];
            calls.push({ path, body, authorization: req.headers.authorization });
            const handler = handlers[`${req.method} ${path}`];
            const result = handler ? handler(body, req) : { status: 404, body: { error: 'not found' } };
            res.writeHead(result.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result.body));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

export function makeJwt(expSecondsFromNow: number, sub = 'acc_test'): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, did: 'dev_test', typ: 'access', exp })}.sig`;
}
```

- [ ] **Step 4: Write the failing token store test**

```ts
// packages/happy-cli/src/api/tokenStore.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeJwt, startFakeAuthServer } from '@/testing/fakeAuthServer';

const mockConfiguration = vi.hoisted(() => ({
    happyHomeDir: '', privateKeyFile: '', settingsFile: '', serverUrl: '', currentCliVersion: 'test',
}));
vi.mock('@/configuration', () => ({ configuration: mockConfiguration }));

import { readCredentials, writeCredentials, type Credentials } from '@/persistence';
import { LoggedOutError, tokenStore } from './tokenStore';

let dir: string;
let server: Awaited<ReturnType<typeof startFakeAuthServer>> | null = null;

const keys = { type: 'dataKey' as const, publicKey: new Uint8Array(32).fill(1), machineKey: new Uint8Array(32).fill(2) };

async function seed(token: string, refreshToken = 'rt-1'): Promise<Credentials> {
    const creds: Credentials = { token, refreshToken, encryption: keys };
    await writeCredentials(creds);
    return creds;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-tokens-'));
    mockConfiguration.happyHomeDir = dir;
    mockConfiguration.privateKeyFile = join(dir, 'access.key');
    mockConfiguration.settingsFile = join(dir, 'settings.json');
    tokenStore.resetForTests();
});
afterEach(async () => {
    tokenStore.resetForTests();
    await server?.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
});

describe('tokenStore', () => {
    it('returns a fresh token without refreshing', async () => {
        const token = makeJwt(900);
        tokenStore.init(await seed(token));
        expect(tokenStore.current()).toBe(token);
        expect(await tokenStore.getAccessToken()).toBe(token);
    });

    it('refreshes an expiring token and persists the rotation', async () => {
        const next = makeJwt(900);
        server = await startFakeAuthServer({
            'POST /v1/auth/refresh': (body) => body.refreshToken === 'rt-1'
                ? { status: 200, body: { accessToken: next, refreshToken: 'rt-2' } }
                : { status: 401, body: { error: 'invalid_grant', reason: 'invalid' } },
        });
        mockConfiguration.serverUrl = server.url;
        tokenStore.init(await seed(makeJwt(30)));
        expect(await tokenStore.getAccessToken()).toBe(next);
        expect(tokenStore.current()).toBe(next);
        expect((await readCredentials())?.refreshToken).toBe('rt-2');
    });

    it('adopts a token another process already rotated instead of refreshing', async () => {
        server = await startFakeAuthServer({});
        mockConfiguration.serverUrl = server.url;
        const stale = makeJwt(30);
        tokenStore.init(await seed(stale));
        const rotatedElsewhere = makeJwt(900);
        await seed(rotatedElsewhere, 'rt-2');
        expect(await tokenStore.refresh(stale)).toBe(rotatedElsewhere);
        expect(server.calls).toEqual([]);
    });

    it('single-flights concurrent refreshes', async () => {
        let calls = 0;
        server = await startFakeAuthServer({
            'POST /v1/auth/refresh': () => { calls++; return { status: 200, body: { accessToken: makeJwt(900), refreshToken: `rt-${calls + 1}` } }; },
        });
        mockConfiguration.serverUrl = server.url;
        const stale = makeJwt(30);
        tokenStore.init(await seed(stale));
        const results = await Promise.all([tokenStore.refresh(stale), tokenStore.refresh(stale), tokenStore.getAccessToken()]);
        expect(new Set(results).size).toBe(1);
        expect(calls).toBe(1);
    });

    it('logs out on invalid_grant, clears credentials and notifies listeners', async () => {
        server = await startFakeAuthServer({
            'POST /v1/auth/refresh': () => ({ status: 401, body: { error: 'invalid_grant', reason: 'revoked' } }),
        });
        mockConfiguration.serverUrl = server.url;
        const stale = makeJwt(30);
        tokenStore.init(await seed(stale));
        const listener = vi.fn();
        tokenStore.onLoggedOut(listener);
        await expect(tokenStore.refresh(stale)).rejects.toBeInstanceOf(LoggedOutError);
        expect(await readCredentials()).toBeNull();
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('keeps credentials on network errors', async () => {
        mockConfiguration.serverUrl = 'http://127.0.0.1:9'; // closed port
        const stale = makeJwt(30);
        tokenStore.init(await seed(stale));
        await expect(tokenStore.refresh(stale)).rejects.not.toBeInstanceOf(LoggedOutError);
        expect((await readCredentials())?.token).toBe(stale);
    });

    it('retries a 401 once with a refreshed token via the axios interceptor', async () => {
        const fresh = makeJwt(900);
        const stale = makeJwt(600);
        server = await startFakeAuthServer({
            'POST /v1/auth/refresh': () => ({ status: 200, body: { accessToken: fresh, refreshToken: 'rt-2' } }),
            'GET /v1/whoami': (_body, req) => req.headers.authorization === `Bearer ${fresh}`
                ? { status: 200, body: { ok: true } }
                : { status: 401, body: { error: 'Invalid token' } },
        });
        mockConfiguration.serverUrl = server.url;
        tokenStore.init(await seed(stale));
        const res = await axios.get(`${server.url}/v1/whoami`, { headers: { Authorization: `Bearer ${stale}` } });
        expect(res.data).toEqual({ ok: true });
        expect(server.calls.filter((c) => c.path === '/v1/whoami')).toHaveLength(2);
    });

    it('does not retry requests to other hosts', async () => {
        const other = await startFakeAuthServer({ 'GET /x': () => ({ status: 401, body: {} }) });
        server = await startFakeAuthServer({});
        mockConfiguration.serverUrl = server.url;
        tokenStore.init(await seed(makeJwt(900)));
        await expect(axios.get(`${other.url}/x`, { headers: { Authorization: 'Bearer abc' } })).rejects.toThrow();
        expect(other.calls).toHaveLength(1);
        await other.close();
    });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm --filter happy exec vitest run --project unit src/api/tokenStore.test.ts`
Expected: FAIL — cannot resolve `./tokenStore`.

- [ ] **Step 6: Implement `tokenStore.ts`**

```ts
// packages/happy-cli/src/api/tokenStore.ts
import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { configuration } from '@/configuration';
import { clearCredentialsIfRefreshToken, readCredentials, writeCredentials, type Credentials } from '@/persistence';
import { withFileLock } from '@/utils/fileLock';
import { logger } from '@/ui/logger';
import { decodeJwtExpiry } from './jwt';

const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const RETRY_AFTER_ERROR_MS = 30_000;
const MIN_TIMER_MS = 5_000;

export class LoggedOutError extends Error {
    constructor() {
        super('Logged out: run "happy auth login" to sign in again');
        this.name = 'LoggedOutError';
    }
}

export function credentialsLockFile(): string {
    return configuration.privateKeyFile + '.lock';
}

function isFresh(token: string): boolean {
    const exp = decodeJwtExpiry(token);
    return exp !== null && exp - Date.now() > REFRESH_MARGIN_MS;
}

type RetriableConfig = InternalAxiosRequestConfig & { _happyAuthRetried?: boolean };

/** Same origin as the configured Happy server (a prefix check would match :4000 vs :40001). */
function isHappyServerUrl(url: string): boolean {
    try {
        return new URL(url).origin === new URL(configuration.serverUrl).origin;
    } catch {
        return false;
    }
}

function readAuthorization(config: RetriableConfig): string | undefined {
    const headers: any = config.headers;
    const value = headers?.get?.('Authorization') ?? headers?.Authorization ?? headers?.authorization;
    return typeof value === 'string' ? value : undefined;
}

function writeAuthorization(config: RetriableConfig, value: string): void {
    const headers: any = config.headers;
    if (typeof headers?.set === 'function') {
        headers.set('Authorization', value);
    } else {
        config.headers = { ...(headers ?? {}), Authorization: value } as any;
    }
}

class TokenStore {
    private token: string | null = null;
    private timer: NodeJS.Timeout | null = null;
    private inflight: Promise<string> | null = null;
    private interceptorId: number | null = null;
    private readonly listeners = new Set<(error: LoggedOutError) => void>();

    init(credentials: Credentials): void {
        if (this.token !== null) {
            return;
        }
        this.token = credentials.token;
        this.schedule();
        this.installInterceptor();
    }

    current(): string {
        if (this.token === null) {
            throw new Error('Token store is not initialized');
        }
        return this.token;
    }

    async getAccessToken(): Promise<string> {
        if (this.token === null) {
            const credentials = await readCredentials();
            if (!credentials) {
                throw new LoggedOutError();
            }
            this.init(credentials);
        }
        const token = this.token!;
        return isFresh(token) ? token : this.refresh(token);
    }

    refresh(rejectedToken: string): Promise<string> {
        if (!this.inflight) {
            this.inflight = this.adoptOrRefresh(rejectedToken)
                .then((token) => {
                    this.token = token;
                    this.schedule();
                    return token;
                })
                .catch((error) => {
                    if (error instanceof LoggedOutError) {
                        this.notifyLoggedOut(error);
                    }
                    throw error;
                })
                .finally(() => {
                    this.inflight = null;
                });
        }
        return this.inflight;
    }

    onLoggedOut(listener: (error: LoggedOutError) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    resetForTests(): void {
        if (this.timer) clearTimeout(this.timer);
        if (this.interceptorId !== null && axios.interceptors) {
            axios.interceptors.response.eject(this.interceptorId);
        }
        this.token = null;
        this.timer = null;
        this.inflight = null;
        this.interceptorId = null;
        this.listeners.clear();
    }

    private async adoptOrRefresh(rejectedToken: string): Promise<string> {
        return withFileLock(credentialsLockFile(), async () => {
            const credentials = await readCredentials();
            if (!credentials) {
                throw new LoggedOutError();
            }
            if (credentials.token !== rejectedToken && isFresh(credentials.token)) {
                logger.debug('[AUTH] Adopted access token rotated by another process');
                return credentials.token;
            }
            let data: { accessToken: string; refreshToken: string };
            try {
                const response = await axios.post(
                    `${configuration.serverUrl}/v1/auth/refresh`,
                    { refreshToken: credentials.refreshToken },
                    { timeout: 15_000, headers: { 'X-Happy-Client': `cli/${configuration.currentCliVersion}` } },
                );
                data = response.data;
            } catch (error) {
                if (axios.isAxiosError(error) && error.response?.status === 401) {
                    await clearCredentialsIfRefreshToken(credentials.refreshToken);
                    throw new LoggedOutError();
                }
                throw error;
            }
            await writeCredentials({ ...credentials, token: data.accessToken, refreshToken: data.refreshToken });
            logger.debug('[AUTH] Access token refreshed');
            return data.accessToken;
        });
    }

    private schedule(delayOverrideMs?: number): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const token = this.token;
        const exp = token ? decodeJwtExpiry(token) : null;
        if (!token || exp === null) {
            return;
        }
        const delay = delayOverrideMs ?? Math.max(MIN_TIMER_MS, exp - Date.now() - REFRESH_MARGIN_MS);
        this.timer = setTimeout(() => {
            this.refresh(token).catch((error) => {
                if (!(error instanceof LoggedOutError)) {
                    logger.debug('[AUTH] Background refresh failed; retrying', error instanceof Error ? error.message : error);
                    this.schedule(RETRY_AFTER_ERROR_MS);
                }
            });
        }, delay);
        this.timer.unref?.();
    }

    private installInterceptor(): void {
        if (this.interceptorId !== null || !axios.interceptors) {
            return;
        }
        this.interceptorId = axios.interceptors.response.use(undefined, async (error: AxiosError) => {
            const config = error.config as RetriableConfig | undefined;
            const authorization = config ? readAuthorization(config) : undefined;
            const url = String(config?.url ?? '');
            if (
                !config ||
                config._happyAuthRetried ||
                error.response?.status !== 401 ||
                !authorization?.startsWith('Bearer ') ||
                !isHappyServerUrl(url)
            ) {
                throw error;
            }
            config._happyAuthRetried = true;
            const fresh = await this.refresh(authorization.slice('Bearer '.length));
            writeAuthorization(config, `Bearer ${fresh}`);
            return axios.request(config);
        });
    }

    private notifyLoggedOut(error: LoggedOutError): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        for (const listener of this.listeners) {
            try {
                listener(error);
            } catch { }
        }
    }
}

export const tokenStore = new TokenStore();
```

- [ ] **Step 7: Run it to verify it passes**

Run: `pnpm --filter happy exec vitest run --project unit src/api/tokenStore.test.ts src/api/jwt.test.ts`
Expected: PASS. If the "network error" case is slow because of connect timeouts, keep the closed-port URL (`127.0.0.1:9` refuses immediately on Linux/macOS).

- [ ] **Step 8: Commit**

```bash
git add packages/happy-cli/src/api/jwt.ts packages/happy-cli/src/api/jwt.test.ts packages/happy-cli/src/api/tokenStore.ts \
  packages/happy-cli/src/api/tokenStore.test.ts packages/happy-cli/src/testing/fakeAuthServer.ts
git commit -m "feat: add shared CLI token store with locked refresh"
```

---

### Task 4: Route every token consumer through the token store

**Files:**
- Modify: `packages/happy-cli/src/api/api.ts`, `src/api/apiSession.ts`, `src/api/apiMachine.ts`, `src/api/pushNotifications.ts`, `src/daemon/run.ts`, `src/resume/resolveHappySession.ts`, `src/resume/localResumeStore.ts`
- Modify tests as needed: `src/api/apiSession.test.ts`, `src/api/apiMachine*.test.ts`, `src/api/api.test.ts`
- Test: `packages/happy-cli/src/api/tokenSource.test.ts`

**Interfaces:**
- Consumes: `tokenStore`, `LoggedOutError` (Task 3).
- Produces: `type AccessTokenSource = string | (() => string)` and `resolveAccessToken(source): string` in `src/api/tokenSource.ts`. `ApiSessionClient`, `ApiMachineClient`, `PushNotificationClient` constructors accept `AccessTokenSource` (strings still work, so existing tests keep constructing with `'fake-token'`). `ApiClient.create(credentials)` calls `tokenStore.init(credentials)` and passes `() => tokenStore.current()` everywhere.

- [ ] **Step 1: Write the failing test for the token source and socket auth**

```ts
// packages/happy-cli/src/api/tokenSource.test.ts
import { describe, expect, it } from 'vitest';
import { resolveAccessToken } from './tokenSource';

describe('resolveAccessToken', () => {
    it('supports fixed strings and live getters', () => {
        let current = 'a';
        expect(resolveAccessToken('fixed')).toBe('fixed');
        const source = () => current;
        expect(resolveAccessToken(source)).toBe('a');
        current = 'b';
        expect(resolveAccessToken(source)).toBe('b');
    });
});
```

Also add to `src/api/apiMachine.test.ts` (reuse its existing `mockIo`/`makeMachine` helpers and the way existing tests trigger `connect()`) a test named `'reads the current token on every (re)connect'`:

```ts
    it('reads the current token on every (re)connect', async () => {
        let current = 'token-1';
        const client = new ApiMachineClient(() => current, makeMachine());
        // trigger the connection the same way the neighbouring tests do (e.g. client.connect(...))
        // then:
        const options = mockIo.mock.calls.at(-1)![1];
        expect(typeof options.auth).toBe('function');
        const first = await new Promise<any>((resolve) => options.auth(resolve));
        current = 'token-2';
        const second = await new Promise<any>((resolve) => options.auth(resolve));
        expect(first.token).toBe('token-1');
        expect(second.token).toBe('token-2');
        expect(second.clientType).toBe('machine-scoped');
    });
```

Add the equivalent test to `src/api/apiSession.test.ts` for `ApiSessionClient` (`clientType: 'session-scoped'`, constructed with `() => current`).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter happy exec vitest run --project unit src/api/tokenSource.test.ts src/api/apiMachine.test.ts src/api/apiSession.test.ts`
Expected: FAIL — module missing; `options.auth` is an object.

- [ ] **Step 3: Implement**

Create `packages/happy-cli/src/api/tokenSource.ts`:

```ts
/** A fixed token (tests, one-shot commands) or a live getter (tokenStore.current). */
export type AccessTokenSource = string | (() => string);

export function resolveAccessToken(source: AccessTokenSource): string {
    return typeof source === 'function' ? source() : source;
}
```

`src/api/apiSession.ts`:
1. `import { type AccessTokenSource, resolveAccessToken } from './tokenSource';`
2. Replace the field `private readonly token: string;` with:
   ```ts
   private readonly tokenSource: AccessTokenSource;
   private get token(): string {
       return resolveAccessToken(this.tokenSource);
   }
   ```
3. Constructor signature `constructor(token: AccessTokenSource, session: Session)`, and `this.token = token;` → `this.tokenSource = token;`.
4. In the `io(configuration.serverUrl, { auth: {...} })` call, replace the `auth` object with a callback so each (re)connect reads the current token:
   ```ts
   auth: (cb: (data: object) => void) => cb({
       token: this.token,
       clientType: 'session-scoped' as const,
       sessionId: this.sessionId,
       happyClient: `cli-coding-session/${configuration.currentCliVersion}`
   }),
   ```
   All other `this.token` uses (REST headers) now read the live value through the getter — leave them as they are.

`src/api/apiMachine.ts`: same pattern — constructor `private token: string` → `tokenSource: AccessTokenSource` field + `private get token()` getter; the `io(serverUrl, { auth: {...} })` object becomes the callback form with `clientType: 'machine-scoped'`, `machineId: this.machine.id`, `happyClient: \`cli-daemon/${configuration.currentCliVersion}\``.

`src/api/pushNotifications.ts`: `private readonly token: string` → `tokenSource` + getter; constructor param `token: AccessTokenSource`.

`src/api/api.ts`:
1. `import { tokenStore } from './tokenStore';`
2. In the private constructor: `tokenStore.init(credential);` then `this.pushClient = new PushNotificationClient(() => tokenStore.current(), configuration.serverUrl)`.
3. Add `private get token(): string { return tokenStore.current(); }` and replace every `this.credential.token` with `this.token`.
4. `sessionSyncClient` / `machineSyncClient`: pass `() => tokenStore.current()` instead of `this.credential.token`.

`src/daemon/run.ts`:
1. Import `tokenStore`, `LoggedOutError` from `@/api/tokenStore`.
2. In `fetchServerSessionMetadata`, replace `Authorization: \`Bearer ${credentials.token}\`` with `Authorization: \`Bearer ${await tokenStore.getAccessToken()}\``.
3. Right after `const api = await ApiClient.create(credentials);`, add:
   ```ts
   tokenStore.onLoggedOut((error) => {
     logger.debug('[DAEMON RUN] Credentials rejected by the server; shutting down');
     console.error(error.message);
     requestShutdown('exception', error.message);
   });
   ```

`src/resume/resolveHappySession.ts` and `src/resume/localResumeStore.ts`: where they build `Authorization: Bearer ${credentials.token}`, use `await tokenStore.getAccessToken()` instead (keep the surrounding `readCredentials()` null-check for the logged-out case; catch `LoggedOutError` the same way a missing-credentials case is handled today).

Update existing tests that assert the socket `auth` object shape (e.g. `apiMachine.test.ts` `expect(mockIo).toHaveBeenCalledWith('ws://127.0.0.1:3005', expect.objectContaining({ auth: ... }))`) to assert `auth: expect.any(Function)` and, where they checked fields, call the callback as in Step 1. `api.test.ts` builds `mockCredential` — add `refreshToken: 'test-refresh'`; since `axios` is mocked there without `interceptors`, `tokenStore.init` must not throw (the implementation guards on `axios.interceptors`). Call `tokenStore.resetForTests()` in that file's `afterEach` if tests create several `ApiClient`s with different tokens.

- [ ] **Step 4: Verify no stale token capture remains**

```bash
cd packages/happy-cli
grep -rn "credentials\.token\|credential\.token" src --include=*.ts | grep -v "\.test\.ts"
```
Expected: only `src/api/tokenStore.ts`-internal uses and `src/persistence.ts`. Anything else must go through `tokenStore`.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm --filter happy test`
Expected: green.

```bash
git add -A packages/happy-cli/src
git commit -m "feat: read access tokens from the token store in all CLI clients"
```

---

### Task 5: Device-flow login, logout and status

**Files:**
- Rewrite: `packages/happy-cli/src/ui/auth.ts`
- Modify: `packages/happy-cli/src/ui/qrcode.ts`, `packages/happy-cli/src/commands/auth.ts`, `packages/happy-cli/src/persistence.ts` (delete `writeCredentialsLegacy`, `writeCredentialsDataKey`)
- Delete: `packages/happy-cli/src/ui/ink/AuthSelector.tsx`, `src/api/webAuth.ts`, `src/api/auth.ts`, `src/commands/desktopAuth.ts`, `src/commands/desktopAuth.test.ts` (and any test files of the deleted modules)
- Test: `packages/happy-cli/src/ui/auth.test.ts`

**Interfaces:**
- Consumes: `startFakeAuthServer`, `makeJwt` (Task 3); `writeCredentials`, `readCredentials`, `clearCredentials`, `updateSettings` (Tasks 1–2); `withFileLock`, `credentialsLockFile`, `tokenStore` (Tasks 1, 3); `displayQRCode`; `decodeBase64`, `encodeBase64` from `@/api/encryption`.
- Produces:
  ```ts
  class DeviceLoginError extends Error {}
  interface DeviceLoginIO { print(line: string): void; showQr(url: string): void; sleep(ms: number): Promise<void> }
  function deviceLogin(opts: { serverUrl: string; clientInfo: { host: string; os: string; cliVersion: string }; io: DeviceLoginIO }): Promise<Credentials>
  function doAuth(): Promise<Credentials | null>          // console IO + SIGINT handling
  function authAndSetupMachineIfNeeded(): Promise<{ credentials: Credentials; machineId: string }>  // unchanged signature; inits tokenStore
  function decryptWithEphemeralKey(bundle: Uint8Array, secretKey: Uint8Array): Uint8Array | null  // unchanged
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/happy-cli/src/ui/auth.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeJwt, startFakeAuthServer } from '@/testing/fakeAuthServer';

const mockConfiguration = vi.hoisted(() => ({
    happyHomeDir: '', privateKeyFile: '', settingsFile: '', serverUrl: '', currentCliVersion: '9.9.9',
}));
vi.mock('@/configuration', () => ({ configuration: mockConfiguration }));

import { readCredentials } from '@/persistence';
import { DeviceLoginError, deviceLogin } from './auth';

let dir: string;
let server: Awaited<ReturnType<typeof startFakeAuthServer>> | null = null;
const clientInfo = { host: 'dev-42', os: 'linux', cliVersion: '9.9.9' };

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-login-'));
    mockConfiguration.happyHomeDir = dir;
    mockConfiguration.privateKeyFile = join(dir, 'access.key');
    mockConfiguration.settingsFile = join(dir, 'settings.json');
});
afterEach(async () => {
    await server?.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
});

function io() {
    const lines: string[] = [];
    const qrs: string[] = [];
    const sleeps: number[] = [];
    return {
        lines, qrs, sleeps,
        io: { print: (l: string) => lines.push(l), showQr: (u: string) => qrs.push(u), sleep: async (ms: number) => { sleeps.push(ms); } },
    };
}

/** Fake server: `responses` are returned by /device/token in order. */
async function fakeDeviceServer(responses: Array<(ephemeralPublicKey: Uint8Array) => { status: number; body: unknown }>) {
    let ephemeral = new Uint8Array();
    let polls = 0;
    return startFakeAuthServer({
        'POST /v1/auth/device/start': (body) => {
            ephemeral = new Uint8Array(Buffer.from(body.ephemeralPublicKey, 'base64'));
            return {
                status: 200,
                body: {
                    deviceCode: 'dc-1', userCode: 'BCDF-GHJK',
                    verifyUrl: 'https://happy.test/activate',
                    verifyUrlComplete: 'https://happy.test/activate?code=BCDF-GHJK',
                    interval: 5, expiresIn: 600,
                },
            };
        },
        'POST /v1/auth/device/token': () => responses[Math.min(polls++, responses.length - 1)](ephemeral),
    });
}

function approved(contentPublicKey: Uint8Array, accessToken: string) {
    return (ephemeralPublicKey: Uint8Array) => {
        const plain = new Uint8Array(33);
        plain.set(contentPublicKey, 1);
        const sender = tweetnacl.box.keyPair();
        const nonce = tweetnacl.randomBytes(24);
        const boxed = tweetnacl.box(plain, nonce, ephemeralPublicKey, sender.secretKey);
        const bundle = Buffer.concat([sender.publicKey, nonce, boxed]).toString('base64');
        return { status: 200, body: { accountId: 'acc_1', accessToken, refreshToken: 'rt-1', keyBundle: bundle } };
    };
}

const pending = () => ({ status: 400, body: { error: 'authorization_pending' } });

describe('deviceLogin', () => {
    it('prints the URL and code, polls until approved, and stores credentials', async () => {
        const contentPublicKey = new Uint8Array(32).fill(7);
        const token = makeJwt(900);
        server = await fakeDeviceServer([pending, pending, approved(contentPublicKey, token)]);
        const t = io();
        const creds = await deviceLogin({ serverUrl: server.url, clientInfo, io: t.io });

        expect(t.lines.join('\n')).toContain('https://happy.test/activate?code=BCDF-GHJK');
        expect(t.lines.join('\n')).toContain('BCDF-GHJK');
        expect(t.qrs).toEqual(['https://happy.test/activate?code=BCDF-GHJK']);
        expect(t.sleeps).toEqual([5000, 5000, 5000]);
        expect(server.calls[0].body.clientInfo).toEqual(clientInfo);

        expect(creds.token).toBe(token);
        expect(creds.refreshToken).toBe('rt-1');
        expect(creds.encryption.type).toBe('dataKey');
        if (creds.encryption.type !== 'dataKey') return;
        expect(Buffer.from(creds.encryption.publicKey).equals(Buffer.from(contentPublicKey))).toBe(true);
        expect(creds.encryption.machineKey).toHaveLength(32);
        expect(await readCredentials()).toEqual(creds);
    });

    it('slows down when asked', async () => {
        server = await fakeDeviceServer([
            () => ({ status: 400, body: { error: 'slow_down' } }),
            approved(new Uint8Array(32), makeJwt(900)),
        ]);
        const t = io();
        await deviceLogin({ serverUrl: server.url, clientInfo, io: t.io });
        expect(t.sleeps).toEqual([5000, 10000]);
    });

    it.each([
        ['access_denied', 'denied'],
        ['expired_token', 'expired'],
        ['invalid_grant', 'failed'],
    ])('stops on %s', async (error, message) => {
        server = await fakeDeviceServer([() => ({ status: 400, body: { error } })]);
        const t = io();
        await expect(deviceLogin({ serverUrl: server.url, clientInfo, io: t.io })).rejects.toThrow(DeviceLoginError);
        await expect(deviceLogin({ serverUrl: server.url, clientInfo, io: io().io })).rejects.toThrow(new RegExp(message, 'i'));
        expect(await readCredentials()).toBeNull();
    });

    it('rejects a key bundle that is not [0 | contentPublicKey]', async () => {
        server = await fakeDeviceServer([(eph) => {
            const bad = approved(new Uint8Array(32), makeJwt(900))(eph);
            (bad.body as any).keyBundle = Buffer.alloc(80).toString('base64');
            return bad;
        }]);
        await expect(deviceLogin({ serverUrl: server.url, clientInfo, io: io().io })).rejects.toThrow(/key bundle/i);
        expect(await readCredentials()).toBeNull();
    });

    it('never prints tokens', async () => {
        const token = makeJwt(900);
        server = await fakeDeviceServer([approved(new Uint8Array(32), token)]);
        const t = io();
        await deviceLogin({ serverUrl: server.url, clientInfo, io: t.io });
        expect(t.lines.join('\n')).not.toContain(token);
        expect(t.lines.join('\n')).not.toContain('rt-1');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy exec vitest run --project unit src/ui/auth.test.ts`
Expected: FAIL — `deviceLogin` / `DeviceLoginError` not exported.

- [ ] **Step 3: Rewrite `src/ui/auth.ts`**

```ts
// packages/happy-cli/src/ui/auth.ts
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from '@/api/encryption';
import { configuration } from '@/configuration';
import { readCredentials, updateSettings, writeCredentials, type Credentials } from '@/persistence';
import { credentialsLockFile, tokenStore } from '@/api/tokenStore';
import { withFileLock } from '@/utils/fileLock';
import { delay } from '@/utils/time';
import { displayQRCode } from './qrcode';
import { logger } from './logger';

export class DeviceLoginError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DeviceLoginError';
    }
}

export interface DeviceLoginIO {
    print(line: string): void;
    showQr(url: string): void;
    sleep(ms: number): Promise<void>;
}

interface DeviceStart {
    deviceCode: string;
    userCode: string;
    verifyUrl: string;
    verifyUrlComplete: string;
    interval: number;
    expiresIn: number;
}

interface DeviceTokens {
    accountId: string;
    accessToken: string;
    refreshToken: string;
    keyBundle: string;
}

const TERMINAL_ERRORS: Record<string, string> = {
    access_denied: 'Sign-in was denied in the browser.',
    expired_token: 'The sign-in code expired. Run "happy auth login" again.',
    invalid_grant: 'Sign-in failed. Run "happy auth login" again.',
};

export async function deviceLogin(opts: {
    serverUrl: string;
    clientInfo: { host: string; os: string; cliVersion: string };
    io: DeviceLoginIO;
}): Promise<Credentials> {
    const { serverUrl, clientInfo, io } = opts;
    const ephemeral = tweetnacl.box.keyPair();

    const start = (await axios.post<DeviceStart>(`${serverUrl}/v1/auth/device/start`, {
        ephemeralPublicKey: encodeBase64(ephemeral.publicKey),
        clientInfo,
    }, { timeout: 15_000 })).data;

    io.print('');
    io.print('To sign in, open this URL in a browser:');
    io.print('');
    io.print(`  ${start.verifyUrlComplete}`);
    io.print('');
    io.print(`and confirm the code: ${start.userCode}`);
    io.print('');
    io.showQr(start.verifyUrlComplete);
    io.print('Waiting for approval...');

    let intervalMs = start.interval * 1000;
    const deadline = Date.now() + start.expiresIn * 1000;
    let tokens: DeviceTokens | null = null;
    while (!tokens) {
        if (Date.now() > deadline) {
            throw new DeviceLoginError(TERMINAL_ERRORS.expired_token);
        }
        await io.sleep(intervalMs);
        try {
            tokens = (await axios.post<DeviceTokens>(`${serverUrl}/v1/auth/device/token`, {
                deviceCode: start.deviceCode,
            }, { timeout: 15_000 })).data;
        } catch (error) {
            const code = axios.isAxiosError(error) && error.response?.status === 400
                ? (error.response.data as { error?: string } | undefined)?.error
                : undefined;
            if (code === 'slow_down') {
                intervalMs += 5000;
            } else if (code && TERMINAL_ERRORS[code]) {
                throw new DeviceLoginError(TERMINAL_ERRORS[code]);
            } else if (code !== 'authorization_pending') {
                logger.debug('[AUTH] Device token poll failed; retrying', error instanceof Error ? error.message : error);
            }
        }
    }

    const bundle = decryptWithEphemeralKey(decodeBase64(tokens.keyBundle), ephemeral.secretKey);
    if (!bundle || bundle.length !== 33 || bundle[0] !== 0) {
        throw new DeviceLoginError('Received an invalid key bundle from the server.');
    }
    const credentials: Credentials = {
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        encryption: {
            type: 'dataKey',
            publicKey: bundle.slice(1, 33),
            machineKey: new Uint8Array(randomBytes(32)),
        },
    };
    await withFileLock(credentialsLockFile(), () => writeCredentials(credentials));
    io.print('✓ Signed in');
    return credentials;
}

export async function doAuth(): Promise<Credentials | null> {
    const handleInterrupt = () => {
        console.log('\n\nAuthentication cancelled.');
        process.exit(0);
    };
    process.on('SIGINT', handleInterrupt);
    try {
        return await deviceLogin({
            serverUrl: configuration.serverUrl,
            clientInfo: { host: os.hostname(), os: process.platform, cliVersion: configuration.currentCliVersion },
            io: { print: (line) => console.log(line), showQr: displayQRCode, sleep: delay },
        });
    } catch (error) {
        console.log(`\n${error instanceof Error ? error.message : 'Sign-in failed.'}\n`);
        return null;
    } finally {
        process.off('SIGINT', handleInterrupt);
    }
}

export function decryptWithEphemeralKey(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    const ephemeralPublicKey = encryptedBundle.slice(0, 32);
    const nonce = encryptedBundle.slice(32, 32 + tweetnacl.box.nonceLength);
    const encrypted = encryptedBundle.slice(32 + tweetnacl.box.nonceLength);
    return tweetnacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey) ?? null;
}

/**
 * Ensure authentication and machine setup
 */
export async function authAndSetupMachineIfNeeded(): Promise<{
    credentials: Credentials;
    machineId: string;
}> {
    logger.debug('[AUTH] Starting auth and machine setup...');

    let credentials = await readCredentials();
    let newAuth = false;

    if (!credentials) {
        logger.debug('[AUTH] No credentials found, starting authentication flow...');
        const authResult = await doAuth();
        if (!authResult) {
            throw new Error('Authentication failed or was cancelled');
        }
        credentials = authResult;
        newAuth = true;
    } else {
        logger.debug('[AUTH] Using existing credentials');
    }
    tokenStore.init(credentials);

    const settings = await updateSettings(async s => {
        if (newAuth || !s.machineId) {
            return { ...s, machineId: randomUUID() };
        }
        return s;
    });

    logger.debug(`[AUTH] Machine ID: ${settings.machineId}`);
    return { credentials, machineId: settings.machineId! };
}
```

Check `delay`'s actual export name/signature in `src/utils/time.ts` (the old file imported `delay` from there) and `encodeBase64`/`decodeBase64` names in `@/api/encryption` (the old file used them); adapt imports if they differ.

- [ ] **Step 4: Update the QR title, commands and persistence**

`src/ui/qrcode.ts`: change the title line to `'📱 Or scan this QR code to open the sign-in page on your phone:'`.

`src/commands/auth.ts`:
1. Remove the `desktop` case, the `handleDesktopAuth` import, and the desktop line in help (if any). Replace the three gray "PS: Your master secret…" help lines with `${chalk.gray('Sign-in uses your organization\'s identity provider in a browser.')}`.
2. In `handleAuthLogout`, inside the confirmed branch, before `clearCredentials()`:
   ```ts
   try {
     const accessToken = await tokenStore.getAccessToken();
     await axios.post(`${configuration.serverUrl}/v1/auth/logout`, {}, {
       headers: { Authorization: `Bearer ${accessToken}` },
       timeout: 5000,
     });
   } catch (error) {
     logger.debug('Server-side logout failed (continuing with local logout):', error);
   }
   ```
   and wrap the local clear in the credentials lock: `await withFileLock(credentialsLockFile(), () => clearCredentials());`. Add imports: `axios`, `tokenStore`/`credentialsLockFile` from `@/api/tokenStore`, `withFileLock` from `@/utils/fileLock`.
3. In `handleAuthStatus`, replace the token preview lines with:
   ```ts
   const expiresAt = decodeJwtExpiry(credentials.token);
   console.log(chalk.gray(`  Access token ${expiresAt && expiresAt > Date.now() ? `valid until ${new Date(expiresAt).toLocaleString()}` : 'expired (refreshed automatically on next use)'}`));
   ```
   (`import { decodeJwtExpiry } from '@/api/jwt';`)

`src/persistence.ts`: delete `writeCredentialsLegacy` and `writeCredentialsDataKey`.

Delete files: `src/ui/ink/AuthSelector.tsx`, `src/api/webAuth.ts`, `src/api/auth.ts`, `src/commands/desktopAuth.ts`, `src/commands/desktopAuth.test.ts`, plus any `*.test.ts` that only tests those modules. Then:

```bash
cd packages/happy-cli
grep -rn "AuthSelector\|webAuth\|generateWebAuthUrl\|desktopAuth\|handleDesktopAuth\|authGetToken\|writeCredentialsLegacy\|writeCredentialsDataKey\|v1/auth/request\|happy://terminal" src
```
Expected: no output. Fix remaining references (e.g. `src/index.ts` help text for `auth desktop`).

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `pnpm --filter happy exec vitest run --project unit src/ui/auth.test.ts` (PASS), then `pnpm --filter happy test` (green; the `test` script builds, which typechecks).

```bash
git add -A packages/happy-cli/src
git commit -m "feat: sign in the CLI with the OIDC device flow"
```

---

### Task 6: Remove `happy server`

**Files:**
- Delete: `packages/happy-cli/src/commands/server.ts` (+ its tests if any)
- Modify: `packages/happy-cli/src/index.ts`, `packages/happy-cli/src/configuration.ts` (comment only), `.github/workflows/cli-smoke-test.yml`, CLI docs/README mentions

- [ ] **Step 1: Remove the command**

In `src/index.ts` delete `import { handleServerCommand } from './commands/server'` and the `else if (subcommand === 'server') { ... }` branch, plus any `server` entry in the CLI help output. Delete `src/commands/server.ts` and any `src/commands/server*.test.ts`.

```bash
cd packages/happy-cli
grep -rn "commands/server\|handleServerCommand\|happy server\|'server'" src README.md docs 2>/dev/null
```
Expected after edits: no references to the removed command (unrelated uses of the word "server" are fine). Update the comment in `src/configuration.ts` that mentions `happy server` so it no longer references the command.

- [ ] **Step 2: Update the Linux smoke test**

In `.github/workflows/cli-smoke-test.yml`, job `smoke-test-linux`:
1. Delete the steps "Install Bun", "Build happy-server-self-host runtime + bundle webapp", and "Test packaged server (happy server)" (with their comments).
2. In "Pack packages", delete the `happy-server-self-host ... pack` line.
3. In the install step, drop the `SERVER_PACKAGE_FILE` variable and its argument from `npm install -g` so only the wire and CLI tarballs are installed.
4. In both `on.push.paths` and `on.pull_request.paths`, remove `'packages/happy-server-self-host/**'` and `'packages/happy-server/**'`.

Validate: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/cli-smoke-test.yml'))"` → no error.

- [ ] **Step 3: Build, test, commit**

Run: `pnpm --filter happy test` — green.

```bash
git add -A packages/happy-cli .github/workflows/cli-smoke-test.yml
git commit -m "feat: remove the local happy server command"
```

---

### Task 7: Environments — OIDC server env and device-flow seeding

**Files:**
- Modify: `environments/environments.ts`
- Verify with: `packages/happy-cli` project `integration-authenticated` (`daemon.integration.test.ts`)

**Interfaces:**
- Consumes: CLI `happy auth login` output (Task 5: a line containing `verifyUrlComplete`); `HttpBrowser`, `pickerFields` from `packages/happy-server/sources/testing/httpBrowser.ts` (plan 1); oidc-mock (`docker compose up -d oidc-mock`, issuer `http://localhost:8180`, users `alice`/`bob`, client `happy-server` / `happy-dev-secret`).

- [ ] **Step 1: Server env**

In `buildEnvVars`:
1. Change the default master secret to one that satisfies the server's 32-character minimum: `HANDY_MASTER_SECRET: options.masterSecret || "happy-dev-master-secret-change-me-000000",`.
2. Add after `METRICS_ENABLED`:
   ```ts
   PUBLIC_URL: `http://localhost:${serverPort}`,
   WEBAPP_URL: `http://localhost:${expoPort}`,
   OIDC_ISSUER: OIDC_ISSUER,
   OIDC_CLIENT_ID: "happy-server",
   OIDC_CLIENT_SECRET: "happy-dev-secret",
   OIDC_ALLOW_INSECURE_ISSUER: "true",
   ```
   with module-level constants near the top of the file:
   ```ts
   const OIDC_ISSUER = process.env.HAPPY_ENV_OIDC_ISSUER ?? "http://localhost:8180";
   const OIDC_USER = process.env.HAPPY_ENV_OIDC_USER ?? "alice";
   ```
3. Remove `readDevAuth` and the `...(devAuth ? { EXPO_PUBLIC_DEV_TOKEN, EXPO_PUBLIC_DEV_SECRET } : {})` spread (legacy web dev login; the app moves to OIDC in plan 3), and remove `const devAuth = readDevAuth(envDir);`.

In `buildEnvSh`, add under `# Server`:
```ts
lines.push(`export PUBLIC_URL="${vars.PUBLIC_URL}"`);
lines.push(`export WEBAPP_URL="${vars.WEBAPP_URL}"`);
lines.push(`export OIDC_ISSUER="${vars.OIDC_ISSUER}"`);
lines.push(`export OIDC_CLIENT_ID="${vars.OIDC_CLIENT_ID}"`);
lines.push(`export OIDC_CLIENT_SECRET="${vars.OIDC_CLIENT_SECRET}"`);
lines.push(`export OIDC_ALLOW_INSECURE_ISSUER=${vars.OIDC_ALLOW_INSECURE_ISSUER}`);
```
and delete the `EXPO_PUBLIC_DEV_TOKEN`/`EXPO_PUBLIC_DEV_SECRET` block.

In `startEnvironmentServices`, before spawning the server, fail early with a clear hint when the IdP is down:
```ts
await ensureOidcIssuerReachable();
```
```ts
async function ensureOidcIssuerReachable(): Promise<void> {
    try {
        const res = await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`);
        if (res.ok) return;
    } catch {}
    throw new Error(`OIDC issuer ${OIDC_ISSUER} is not reachable. Start it with: docker compose up -d oidc-mock`);
}
```

- [ ] **Step 2: Seeding through `happy auth login`**

Replace the body of `seedEnvironment` from the `const { publicKey, privateKey } = crypto.generateKeyPairSync(...)` line through the `writeEnvironmentConfig({ ...config, authenticatedWebUrl });` line with the code below (keep the server-reachability check before it and the daemon start / machine registration code after it, but make the machine check read the token from the new credentials file as shown). Delete `buildAuthenticatedWebUrl`. Keep the `authenticatedWebUrl?` field in `EnvironmentConfig` (older configs may have it) but stop setting it.

```ts
    await ensureOidcIssuerReachable();

    const cliHome = path.join(envDir, "cli", "home");
    fs.mkdirSync(cliHome, { recursive: true });
    fs.writeFileSync(
        path.join(cliHome, "settings.json"),
        JSON.stringify({ schemaVersion: 2, onboardingCompleted: true }, null, 2),
    );

    const envVars = buildEnvVars(envDir, config.serverPort, config.expoPort);
    const cliEnv: Record<string, string | undefined> = { ...process.env, ...envVars };
    delete cliEnv.CLAUDECODE;
    const happyBin = path.join(REPO_ROOT, "packages", "happy-cli", "bin", "happy.mjs");

    const login = spawn("node", [happyBin, "auth", "login"], { env: cliEnv, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    login.stdout.on("data", (chunk) => { output += chunk.toString(); });
    login.stderr.on("data", (chunk) => { output += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => login.on("exit", (code) => resolve(code)));

    let verifyUrl = "";
    await waitFor(() => {
        const match = /(https?:\/\/\S+\/activate\?code=[A-Z]{4}-[A-Z]{4})/.exec(output);
        if (match) verifyUrl = match[1];
        return !!match;
    }, 30_000, "device login URL").catch(() => {
        login.kill();
        throw new Error(`happy auth login did not print a sign-in URL:\n${output}`);
    });

    const { HttpBrowser, pickerFields } = await import("../packages/happy-server/sources/testing/httpBrowser");
    const browser = new HttpBrowser();
    const picker = await browser.get(verifyUrl);
    const confirm = await browser.postForm(`${OIDC_ISSUER}/authorize/callback`, pickerFields(picker.body, OIDC_USER));
    const csrf = /name="csrf" value="([^"]+)"/.exec(confirm.body)?.[1];
    if (!csrf) {
        login.kill();
        throw new Error(`Activation page did not render a confirmation form (status ${confirm.status})`);
    }
    const userCode = new URL(verifyUrl).searchParams.get("code")!;
    await browser.postForm(`${serverUrl}/activate`, { code: userCode, csrf, decision: "approve" });

    const exitCode = await Promise.race([
        exited,
        new Promise<number | null>((resolve) => setTimeout(() => resolve(-1), 60_000)),
    ]);
    if (exitCode !== 0) {
        login.kill();
        throw new Error(`happy auth login failed (exit ${exitCode}):\n${output}`);
    }
    const { token } = JSON.parse(fs.readFileSync(path.join(cliHome, "access.key"), "utf-8")) as { token: string };
```

In the remaining daemon code, reuse `cliEnv` (instead of rebuilding `envVars`/`daemonEnv`) and keep the `Authorization: Bearer ${token}` machine check. Replace the final `Auth URL` log line with `console.log(\`  Signed in as ${OIDC_USER} via ${OIDC_ISSUER}\`);`. Update the two places that print `config.authenticatedWebUrl ?? …` only if they break compilation (they don't need to change).

Remove the now-unused `crypto` import only if nothing else in the file uses it.

- [ ] **Step 3: Verify end-to-end**

```bash
cd /home/rophy/projects/happy
docker compose up -d oidc-mock
pnpm --filter happy exec vitest run --project integration-authenticated src/daemon/daemon.integration.test.ts
docker compose down
```
Expected: the environment starts, seeding signs in through `happy auth login` + oidc-mock, and the daemon integration test passes. If it fails for reasons unrelated to auth (e.g. it needs an agent binary or network that isn't available), record the exact failure; the seeding itself must succeed (the log shows "Signed in as alice").

Also run once by hand: `pnpm env:up --template authenticated-empty` (or the repo's equivalent command listed in the file's usage text), confirm "Signed in as alice", then tear it down with the corresponding down/remove command.

- [ ] **Step 4: Commit**

```bash
git add environments/environments.ts
git commit -m "test: seed dev environments through the CLI device login"
```

---

## Self-Review

**Spec coverage (spec §2 CLI):**
- Device flow login with URL, code and QR of the URL → Task 5.
- Credentials `{token, refreshToken, encryption}`; missing refresh token = logged out → Task 2.
- Process-wide token store, proactive refresh (2 min), 401 retry → Task 3; every consumer + sockets reading the token at each (re)connect → Task 4.
- Refresh under a cross-process lock with adopt-if-rotated, atomic 0600 writes → Tasks 1–3.
- `invalid_grant` → clear credentials if unchanged, daemon shuts down with a message → Tasks 3–4.
- Logout calls the server best-effort, then clears → Task 5.
- `happy auth desktop` and `happy server` removed → Tasks 5–6; smoke test updated → Task 6.
- Removed-from-clients list (QR `happy://terminal`, method picker, web-auth URL, legacy `/v1/auth`, `/v1/auth/request` polling) → Task 5.
- Local development with oidc-mock (`pnpm env:*`) → Task 7.

**Known follow-ups:** `happy-agent` and `happy-mobile-gym` still call removed endpoints (later plan); the web app's dev auto-login env (`EXPO_PUBLIC_DEV_TOKEN/SECRET`) is gone until plan 3 adds OIDC login to the app.
