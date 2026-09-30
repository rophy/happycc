# OIDC Auth — Server Implementation Plan (Plan 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace keypair/QR authentication in `happy-server` with OIDC: server-brokered CLI device flow, web/mobile code exchange, server-managed root secrets, short-lived access tokens with rotating refresh tokens.

**Architecture:** The server is the only OIDC client (confidential, auth code + PKCE via `openid-client`). On first login it generates the user's 32-byte root secret, stores it wrapped with a KeyTree key, and later hands key material to clients boxed to a client-supplied ephemeral key, in the exact byte formats upstream clients already consume. All new logic lives in `sources/app/auth/oidc/`; routes live in three new route files; legacy auth routes and tables are deleted.

**Tech Stack:** Fastify 5 + zod type provider, Prisma 6 (Postgres / PGlite), `openid-client` 6, `jsonwebtoken`, `tweetnacl`, `privacy-kit` KeyTree, Vitest 3, `oauth2-mock-server` 8 (tests), Keycloak 26 (integration).

**Spec:** `docs/superpowers/specs/2026-09-30-oidc-auth-design.md`

**Follow-up plans (not in this plan):** 2 — CLI device login/refresh; 3 — app OIDC login, QR removal, configurable app identity; 4 — third-party integrations off by default, content-free push.

## Global Constraints

- Node 20.19+ (CI uses 20; `oauth2-mock-server@8` requires `^20.19`).
- pnpm 10.11.0 workspace; run package commands as `pnpm --filter happy-server <script>`.
- Required env: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `PUBLIC_URL`, `WEBAPP_URL`, `HANDY_MASTER_SECRET` (≥ 32 chars). Server refuses to start without them. No fallback auth.
- Optional env: `OIDC_SCOPES` (default `openid profile email offline_access`), `MOBILE_REDIRECT_URIS` (comma-separated), `AUTH_ACCESS_TOKEN_TTL` (default `15m`), `AUTH_MAX_SESSION_AGE` (default `30d`), `OIDC_ALLOW_INSECURE_ISSUER` (`true` only for local dev).
- Device flow: `userCode` 8 chars from `BCDFGHJKLMNPQRSTVWXZ`, shown as `XXXX-XXXX`; `deviceCode` 32 random bytes stored hashed; TTL 600 s; poll interval 5 s; RFC 8628 error codes `authorization_pending`, `slow_down`, `expired_token`, `access_denied`, plus `invalid_grant`.
- Exchange codes: single use, 60 s TTL, bound to the app's PKCE S256 challenge.
- Root secret leaves the server only boxed to a client ephemeral key (`[ephPub(32) | nonce(24) | box]`). Never log it.
- CLI key bundle plaintext is `[0x00 | contentPublicKey(32)]`; web/mobile bundle plaintext is the 32-byte root secret.
- IdP errors are never forwarded to clients.
- Commit messages: `<type>: <short description>`, types feat/fix/refactor/chore/docs/build/test. No AI attribution, no "Claude"/"Happy" mentions beyond code identifiers.

## File Structure

```
packages/happy-server/
  prisma/schema.prisma                                   (modify)
  prisma/migrations/20260930000000_oidc_auth/migration.sql (create)
  vitest.config.ts                                       (modify: exclude integration)
  vitest.integration.config.ts                           (create)
  package.json                                           (modify: deps, test:integration)
  sources/testing/testDb.ts                              (create) PGlite DB for tests
  sources/testing/testDb.test.ts                         (create)
  sources/testing/authTestKit.ts                         (create) env, fake OIDC, app builder
  sources/testing/httpBrowser.ts                         (create) cookie-jar fetch for integration
  sources/app/auth/auth.ts                               (modify) access-token verification
  sources/app/auth/oidc/authConfig.ts (+.test.ts)        env → AuthConfig
  sources/app/auth/oidc/accountKeys.ts (+.test.ts)       root secret, derived keys, boxing
  sources/app/auth/oidc/keyVault.ts (+.test.ts)          wrap/unwrap secrets at rest
  sources/app/auth/oidc/accessTokens.ts (+.test.ts)      JWT access tokens, opaque token helpers
  sources/app/auth/oidc/deviceSockets.ts                 socket rooms per device
  sources/app/auth/oidc/devices.ts (+.test.ts)           device rows, refresh rotation, revoke
  sources/app/auth/oidc/oidcClient.ts (+.test.ts)        openid-client wrapper
  sources/app/auth/oidc/provisioning.ts (+.test.ts)      account upsert by (iss, sub)
  sources/app/auth/oidc/idpCheck.ts (+.test.ts)          periodic IdP re-validation
  sources/app/auth/oidc/browserCookies.ts (+.test.ts)    signed cookies / CSRF values
  sources/app/auth/oidc/exchangeCodes.ts                 one-time web/mobile codes
  sources/app/auth/oidc/deviceAuth.ts (+.test.ts)        device flow state machine
  sources/app/auth/oidc/pages.ts                         server-rendered HTML
  sources/app/auth/oidc/oidcRuntime.ts                   init + singleton
  sources/app/auth/oidc/oidc.integration.test.ts         Keycloak end-to-end
  sources/app/api/types.ts                               (modify) request.deviceId
  sources/app/api/utils/enableAuthentication.ts          (modify)
  sources/app/api/socket.ts                              (modify) device rooms
  sources/app/api/routes/oidcRoutes.ts (+.spec.ts)       login, callback, exchange
  sources/app/api/routes/deviceAuthRoutes.ts (+.spec.ts) device start/token, /activate
  sources/app/api/routes/tokenRoutes.ts (+.spec.ts)      refresh, logout
  sources/app/api/routes/authRoutes.ts                   (delete)
  sources/app/api/api.ts, sources/main.ts, sources/index.ts (modify) wiring
docker-compose.yaml                                      (create) keycloak + postgres + server
deploy/keycloak/happy-realm.json                         (create)
.github/workflows/server.yml                             (modify) integration job
docs/user-identity.md                                    (modify) auth flow
```

---

### Task 1: Test tooling and dependencies

**Files:**
- Modify: `packages/happy-server/package.json`
- Modify: `packages/happy-server/vitest.config.ts`
- Create: `packages/happy-server/vitest.integration.config.ts`
- Create: `packages/happy-server/sources/testing/testDb.ts`
- Test: `packages/happy-server/sources/testing/testDb.test.ts`

**Interfaces:**
- Produces: `createTestDb(): Promise<PrismaClient>` — PGlite database in a temp dir with all migrations applied; sets `DB_PROVIDER=pglite` and `PGLITE_DIR` so `@/storage/db` binds to it. One database per test file (Vitest isolates modules per file); repeated calls in the same file return the same client. Must be called before any module that imports `@/storage/db` is loaded (use dynamic `import()` after it).

- [ ] **Step 1: Install workspace dependencies and confirm the baseline**

```bash
cd /home/rophy/projects/happy
node -v   # must be >= 20.19
pnpm install --frozen-lockfile
pnpm --filter @slopus/happy-wire build
pnpm --filter happy-server test
```
Expected: all existing server tests pass. If any fail, stop and report — do not continue on a red baseline.

- [ ] **Step 2: Add dependencies**

```bash
pnpm --filter happy-server add openid-client@^6.8.8
pnpm --filter happy-server add -D oauth2-mock-server@^8.2.3
```

- [ ] **Step 3: Split unit and integration test configs**

Replace `packages/happy-server/vitest.config.ts` with:

```ts
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
  },
  plugins: [tsconfigPaths()]
});
```

Create `packages/happy-server/vitest.integration.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['sources/**/*.integration.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  plugins: [tsconfigPaths()]
});
```

In `packages/happy-server/package.json` `scripts`, add after `"test"`:

```json
"test:integration": "vitest run --config vitest.integration.config.ts",
```

- [ ] **Step 4: Write the failing test for the test DB helper**

Create `packages/happy-server/sources/testing/testDb.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTestDb } from './testDb';

describe('createTestDb', () => {
    it('creates a migrated database that Prisma can use', async () => {
        const db = await createTestDb();
        const account = await db.account.create({ data: { publicKey: 'test-public-key' } });
        const found = await db.account.findUnique({ where: { id: account.id } });
        expect(found?.publicKey).toBe('test-public-key');
    });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm --filter happy-server exec vitest run sources/testing/testDb.test.ts`
Expected: FAIL — cannot resolve `./testDb`.

- [ ] **Step 6: Implement the helper**

Create `packages/happy-server/sources/testing/testDb.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { PrismaClient } from '@prisma/client';

const migrationsDir = fileURLToPath(new URL('../../prisma/migrations', import.meta.url));

let current: Promise<PrismaClient> | null = null;

/**
 * Creates a PGlite database with all migrations applied and points `@/storage/db`
 * at it. One per test file; call before importing anything that imports `@/storage/db`.
 */
export function createTestDb(): Promise<PrismaClient> {
    current ??= create();
    return current;
}

async function create(): Promise<PrismaClient> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-test-db-'));
    const { runMigrations } = await import('@/standalone');
    await runMigrations({ pgliteDir: dir, migrationsDir });
    process.env.DB_PROVIDER = 'pglite';
    process.env.PGLITE_DIR = dir;
    const { db } = await import('@/storage/db');
    await db.$connect();
    return db;
}
```

- [ ] **Step 7: Run it to verify it passes**

Run: `pnpm --filter happy-server exec vitest run sources/testing/testDb.test.ts`
Expected: PASS (migration log lines are printed; that is fine).

- [ ] **Step 8: Commit**

```bash
git add packages/happy-server/package.json packages/happy-server/vitest.config.ts \
  packages/happy-server/vitest.integration.config.ts packages/happy-server/sources/testing \
  pnpm-lock.yaml
git commit -m "test: add PGlite test database helper and integration config"
```

---

### Task 2: Schema and migration

**Files:**
- Modify: `packages/happy-server/prisma/schema.prisma`
- Create: `packages/happy-server/prisma/migrations/20260930000000_oidc_auth/migration.sql`
- Test: `packages/happy-server/sources/testing/testDb.test.ts`

**Interfaces:**
- Produces Prisma models: `Account` (+ `oidcIssuer`, `oidcSubject`, `email`, `wrappedRootSecret`, `disabledAt`, `idpRefreshToken`, `idpCheckedAt`, compound unique `oidcIssuer_oidcSubject`), `Device`, `DeviceAuthRequest`, `OidcExchangeCode`. Removes `TerminalAuthRequest`, `AccountAuthRequest`.

- [ ] **Step 1: Write the failing test**

Append to `packages/happy-server/sources/testing/testDb.test.ts` inside the `describe`:

```ts
    it('has the OIDC auth tables', async () => {
        const db = await createTestDb();
        const account = await db.account.create({
            data: { publicKey: 'pk-oidc', oidcIssuer: 'https://idp.test', oidcSubject: 'alice', wrappedRootSecret: 'wrapped' },
        });
        const device = await db.device.create({
            data: {
                accountId: account.id, kind: 'cli', name: 'dev-42', host: 'dev-42',
                refreshTokenHash: 'h1', sessionStartedAt: new Date(), lastSeenAt: new Date(),
            },
        });
        const request = await db.deviceAuthRequest.create({
            data: {
                deviceCodeHash: 'dc', userCode: 'BCDF-GHJK', ephemeralPublicKey: 'eph',
                clientInfo: { host: 'dev-42', os: 'linux', cliVersion: '1.2.5' },
                expiresAt: new Date(Date.now() + 600_000),
            },
        });
        const code = await db.oidcExchangeCode.create({
            data: { codeHash: 'ch', accountId: account.id, clientKind: 'web', pkceChallenge: 'c', expiresAt: new Date() },
        });
        expect(device.revokedAt).toBeNull();
        expect(request.status).toBe('pending');
        expect(code.usedAt).toBeNull();
        const byIdentity = await db.account.findUnique({
            where: { oidcIssuer_oidcSubject: { oidcIssuer: 'https://idp.test', oidcSubject: 'alice' } },
        });
        expect(byIdentity?.id).toBe(account.id);
    });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy-server exec vitest run sources/testing/testDb.test.ts`
Expected: FAIL — TypeScript/Prisma errors: `db.device` is undefined.

- [ ] **Step 3: Update the Prisma schema**

In `packages/happy-server/prisma/schema.prisma`:

1. In `model Account`, add after `avatar    Json?`:

```prisma
    // OIDC identity (corporate fork)
    oidcIssuer        String?
    oidcSubject       String?
    email             String?
    /// Root secret wrapped by keyVault (base64)
    wrappedRootSecret String?
    disabledAt        DateTime?
    /// Latest IdP refresh token, KeyTree-encrypted (base64)
    idpRefreshToken   String?
    idpCheckedAt      DateTime?
```

2. In the `Account` relation list, delete the two lines `TerminalAuthRequest TerminalAuthRequest[]` and `AccountAuthRequest  AccountAuthRequest[]`, and add:

```prisma
    Device              Device[]
    DeviceAuthRequest   DeviceAuthRequest[]
    OidcExchangeCode    OidcExchangeCode[]
```

3. At the end of `model Account` (before the closing brace) add:

```prisma

    @@unique([oidcIssuer, oidcSubject])
```

4. Delete `model TerminalAuthRequest { ... }` and `model AccountAuthRequest { ... }` entirely.

5. Add after `model Account`:

```prisma
model Device {
    id                       String    @id @default(cuid())
    accountId                String
    account                  Account   @relation(fields: [accountId], references: [id], onDelete: Cascade)
    kind                     String
    name                     String
    host                     String?
    refreshTokenHash         String    @unique
    previousRefreshTokenHash String?
    sessionStartedAt         DateTime
    lastSeenAt               DateTime
    revokedAt                DateTime?
    createdAt                DateTime  @default(now())
    updatedAt                DateTime  @updatedAt

    @@index([previousRefreshTokenHash])
    @@index([accountId])
}

model DeviceAuthRequest {
    id                 String    @id @default(cuid())
    deviceCodeHash     String    @unique
    userCode           String    @unique
    status             String    @default("pending")
    approvedAccountId  String?
    approvedAccount    Account?  @relation(fields: [approvedAccountId], references: [id], onDelete: SetNull)
    ephemeralPublicKey String
    clientInfo         Json
    lastPolledAt       DateTime?
    expiresAt          DateTime
    createdAt          DateTime  @default(now())
}

model OidcExchangeCode {
    id            String    @id @default(cuid())
    codeHash      String    @unique
    accountId     String
    account       Account   @relation(fields: [accountId], references: [id], onDelete: Cascade)
    clientKind    String
    pkceChallenge String
    expiresAt     DateTime
    usedAt        DateTime?
    createdAt     DateTime  @default(now())
}
```

- [ ] **Step 4: Write the migration**

Create `packages/happy-server/prisma/migrations/20260930000000_oidc_auth/migration.sql`:

```sql
DROP TABLE "TerminalAuthRequest";
DROP TABLE "AccountAuthRequest";

ALTER TABLE "Account"
    ADD COLUMN "oidcIssuer" TEXT,
    ADD COLUMN "oidcSubject" TEXT,
    ADD COLUMN "email" TEXT,
    ADD COLUMN "wrappedRootSecret" TEXT,
    ADD COLUMN "disabledAt" TIMESTAMP(3),
    ADD COLUMN "idpRefreshToken" TEXT,
    ADD COLUMN "idpCheckedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Account_oidcIssuer_oidcSubject_key" ON "Account"("oidcIssuer", "oidcSubject");

CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT,
    "refreshTokenHash" TEXT NOT NULL,
    "previousRefreshTokenHash" TEXT,
    "sessionStartedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Device_refreshTokenHash_key" ON "Device"("refreshTokenHash");
CREATE INDEX "Device_previousRefreshTokenHash_idx" ON "Device"("previousRefreshTokenHash");
CREATE INDEX "Device_accountId_idx" ON "Device"("accountId");
ALTER TABLE "Device" ADD CONSTRAINT "Device_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DeviceAuthRequest" (
    "id" TEXT NOT NULL,
    "deviceCodeHash" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedAccountId" TEXT,
    "ephemeralPublicKey" TEXT NOT NULL,
    "clientInfo" JSONB NOT NULL,
    "lastPolledAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeviceAuthRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeviceAuthRequest_deviceCodeHash_key" ON "DeviceAuthRequest"("deviceCodeHash");
CREATE UNIQUE INDEX "DeviceAuthRequest_userCode_key" ON "DeviceAuthRequest"("userCode");
ALTER TABLE "DeviceAuthRequest" ADD CONSTRAINT "DeviceAuthRequest_approvedAccountId_fkey"
    FOREIGN KEY ("approvedAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "OidcExchangeCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "clientKind" TEXT NOT NULL,
    "pkceChallenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OidcExchangeCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OidcExchangeCode_codeHash_key" ON "OidcExchangeCode"("codeHash");
ALTER TABLE "OidcExchangeCode" ADD CONSTRAINT "OidcExchangeCode_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 5: Regenerate the client and check the migration matches the schema**

```bash
pnpm --filter happy-server generate
cd packages/happy-server
git show HEAD:packages/happy-server/prisma/schema.prisma > /tmp/happy-schema-before.prisma
pnpm exec prisma migrate diff --from-schema-datamodel /tmp/happy-schema-before.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
```
Expected: the printed SQL contains the same tables, columns, indexes and foreign keys as `migration.sql` (statement order and `DropForeignKey` preambles may differ). Fix `migration.sql` if a column or index is missing.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter happy-server exec vitest run sources/testing/testDb.test.ts`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add packages/happy-server/prisma
git commit -m "feat: add OIDC account, device and auth request tables"
```

Note: `authRoutes.ts` still references the dropped models, so `pnpm --filter happy-server typecheck` fails until Task 12 deletes it. Unit tests still run (Vitest does not typecheck).

---

### Task 3: Auth configuration

**Files:**
- Create: `packages/happy-server/sources/app/auth/oidc/authConfig.ts`
- Test: `packages/happy-server/sources/app/auth/oidc/authConfig.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface AuthConfig {
      issuer: string; clientId: string; clientSecret: string; scopes: string;
      publicUrl: string; webappUrl: string; mobileRedirectUris: string[];
      accessTokenTtlSec: number; maxSessionAgeSec: number;
      allowInsecureIssuer: boolean; masterSecret: string;
  }
  function loadAuthConfig(env?: NodeJS.ProcessEnv): AuthConfig
  function parseDuration(value: string): number   // seconds
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/happy-server/sources/app/auth/oidc/authConfig.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadAuthConfig, parseDuration } from './authConfig';

const base = {
    OIDC_ISSUER: 'https://idp.corp.example/realms/main',
    OIDC_CLIENT_ID: 'happy-server',
    OIDC_CLIENT_SECRET: 's3cret',
    PUBLIC_URL: 'https://happy.corp.example/',
    WEBAPP_URL: 'https://app.corp.example/',
    HANDY_MASTER_SECRET: 'x'.repeat(32),
};

describe('parseDuration', () => {
    it('parses s/m/h/d', () => {
        expect(parseDuration('45s')).toBe(45);
        expect(parseDuration('15m')).toBe(900);
        expect(parseDuration('2h')).toBe(7200);
        expect(parseDuration('30d')).toBe(2_592_000);
    });
    it('rejects garbage', () => {
        expect(() => parseDuration('15')).toThrow('Invalid duration');
        expect(() => parseDuration('1w')).toThrow('Invalid duration');
    });
});

describe('loadAuthConfig', () => {
    it('applies defaults and trims trailing slashes', () => {
        const cfg = loadAuthConfig(base);
        expect(cfg).toEqual({
            issuer: 'https://idp.corp.example/realms/main',
            clientId: 'happy-server',
            clientSecret: 's3cret',
            scopes: 'openid profile email offline_access',
            publicUrl: 'https://happy.corp.example',
            webappUrl: 'https://app.corp.example',
            mobileRedirectUris: [],
            accessTokenTtlSec: 900,
            maxSessionAgeSec: 2_592_000,
            allowInsecureIssuer: false,
            masterSecret: 'x'.repeat(32),
        });
    });

    it('parses optional settings', () => {
        const cfg = loadAuthConfig({
            ...base,
            OIDC_SCOPES: 'openid email',
            MOBILE_REDIRECT_URIS: 'corpapp://auth/callback, corpapp-dev://auth/callback',
            AUTH_ACCESS_TOKEN_TTL: '5m',
            AUTH_MAX_SESSION_AGE: '7d',
            OIDC_ALLOW_INSECURE_ISSUER: 'true',
        });
        expect(cfg.scopes).toBe('openid email');
        expect(cfg.mobileRedirectUris).toEqual(['corpapp://auth/callback', 'corpapp-dev://auth/callback']);
        expect(cfg.accessTokenTtlSec).toBe(300);
        expect(cfg.maxSessionAgeSec).toBe(604_800);
        expect(cfg.allowInsecureIssuer).toBe(true);
    });

    it.each(['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'PUBLIC_URL', 'WEBAPP_URL', 'HANDY_MASTER_SECRET'])(
        'fails when %s is missing', (name) => {
            const env: Record<string, string> = { ...base };
            delete env[name];
            expect(() => loadAuthConfig(env)).toThrow(`${name} is required`);
        });

    it('rejects a short master secret', () => {
        expect(() => loadAuthConfig({ ...base, HANDY_MASTER_SECRET: 'short' }))
            .toThrow('HANDY_MASTER_SECRET must be at least 32 characters');
    });

    it('rejects an http issuer unless explicitly allowed', () => {
        expect(() => loadAuthConfig({ ...base, OIDC_ISSUER: 'http://localhost:8180/realms/happy' }))
            .toThrow('OIDC_ISSUER must use https');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/authConfig.test.ts`
Expected: FAIL — cannot resolve `./authConfig`.

- [ ] **Step 3: Implement**

Create `packages/happy-server/sources/app/auth/oidc/authConfig.ts`:

```ts
export interface AuthConfig {
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
    publicUrl: string;
    webappUrl: string;
    mobileRedirectUris: string[];
    accessTokenTtlSec: number;
    maxSessionAgeSec: number;
    allowInsecureIssuer: boolean;
    masterSecret: string;
}

const MIN_MASTER_SECRET_LENGTH = 32;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseDuration(value: string): number {
    const match = /^(\d+)([smhd])$/.exec(value.trim());
    if (!match) {
        throw new Error(`Invalid duration: ${value}`);
    }
    return parseInt(match[1], 10) * UNIT_SECONDS[match[2]];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name]?.trim();
    if (!value) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function trimTrailingSlash(url: string): string {
    return url.replace(/\/+$/, '');
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
    const masterSecret = required(env, 'HANDY_MASTER_SECRET');
    if (masterSecret.length < MIN_MASTER_SECRET_LENGTH) {
        throw new Error(`HANDY_MASTER_SECRET must be at least ${MIN_MASTER_SECRET_LENGTH} characters`);
    }
    const issuer = trimTrailingSlash(required(env, 'OIDC_ISSUER'));
    const allowInsecureIssuer = env.OIDC_ALLOW_INSECURE_ISSUER === 'true';
    if (!allowInsecureIssuer && !issuer.startsWith('https://')) {
        throw new Error('OIDC_ISSUER must use https (set OIDC_ALLOW_INSECURE_ISSUER=true for local development)');
    }
    return {
        issuer,
        clientId: required(env, 'OIDC_CLIENT_ID'),
        clientSecret: required(env, 'OIDC_CLIENT_SECRET'),
        scopes: env.OIDC_SCOPES?.trim() || 'openid profile email offline_access',
        publicUrl: trimTrailingSlash(required(env, 'PUBLIC_URL')),
        webappUrl: trimTrailingSlash(required(env, 'WEBAPP_URL')),
        mobileRedirectUris: (env.MOBILE_REDIRECT_URIS ?? '')
            .split(',')
            .map((uri) => uri.trim())
            .filter((uri) => uri.length > 0),
        accessTokenTtlSec: parseDuration(env.AUTH_ACCESS_TOKEN_TTL ?? '15m'),
        maxSessionAgeSec: parseDuration(env.AUTH_MAX_SESSION_AGE ?? '30d'),
        allowInsecureIssuer,
        masterSecret,
    };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/authConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-server/sources/app/auth/oidc/authConfig*.ts
git commit -m "feat: add OIDC auth configuration loader"
```

---

### Task 4: Account keys and key vault

**Files:**
- Create: `packages/happy-server/sources/app/auth/oidc/accountKeys.ts`
- Create: `packages/happy-server/sources/app/auth/oidc/keyVault.ts`
- Test: `packages/happy-server/sources/app/auth/oidc/accountKeys.test.ts`
- Test: `packages/happy-server/sources/app/auth/oidc/keyVault.test.ts`

**Interfaces:**
- Produces (`accountKeys.ts`):
  ```ts
  function generateRootSecret(): Uint8Array                          // 32 random bytes
  function deriveAccountPublicKeyHex(rootSecret: Uint8Array): string // Account.publicKey value
  function deriveContentPublicKey(rootSecret: Uint8Array): Uint8Array
  function cliKeyBundlePlaintext(rootSecret: Uint8Array): Uint8Array // [0x00 | contentPublicKey]
  function boxForRecipient(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array
  function decodeEphemeralPublicKey(base64: string): Uint8Array | null // null unless exactly 32 bytes
  ```
- Produces (`keyVault.ts`):
  ```ts
  class KeyVaultError extends Error {}
  const keyVault: { wrap(secret: Uint8Array): string; unwrap(wrapped: string): Uint8Array }
  function sealIdpRefreshToken(token: string): string
  function openIdpRefreshToken(sealed: string): string
  ```
- Consumes: `initEncrypt`, `encryptBytes`, `decryptBytes`, `encryptString`, `decryptString` from `@/modules/encrypt` (requires `HANDY_MASTER_SECRET` and `await initEncrypt()` first).

Background: the app derives the content keypair with libsodium `crypto_box_seed_keypair(deriveKey(secret, 'Happy EnCoder', ['content']))`, and signs `/v1/auth` challenges with `crypto_sign_seed_keypair(secret)`. `packages/happy-agent/src/encryption.ts` has an exact Node port (`deriveKey`, `deriveContentKeyPair`, `decryptBoxBundle`); the tests below use it as the reference implementation.

- [ ] **Step 1: Write the failing tests**

Create `packages/happy-server/sources/app/auth/oidc/accountKeys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
// Reference implementation already used by happy-agent against real app data.
import { deriveContentKeyPair, decryptBoxBundle } from '../../../../../happy-agent/src/encryption';
import {
    boxForRecipient,
    cliKeyBundlePlaintext,
    decodeEphemeralPublicKey,
    deriveAccountPublicKeyHex,
    deriveContentPublicKey,
    generateRootSecret,
} from './accountKeys';

const fixedSecret = new Uint8Array(32).map((_, i) => i);

describe('accountKeys', () => {
    it('generates 32 random bytes', () => {
        const a = generateRootSecret();
        const b = generateRootSecret();
        expect(a).toHaveLength(32);
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    });

    it('derives the same content public key as the client implementation', () => {
        expect(Buffer.from(deriveContentPublicKey(fixedSecret)).toString('hex'))
            .toBe(Buffer.from(deriveContentKeyPair(fixedSecret).publicKey).toString('hex'));
    });

    it('derives the account public key the way legacy /v1/auth stored it', () => {
        const expected = privacyKit.encodeHex(tweetnacl.sign.keyPair.fromSeed(fixedSecret).publicKey);
        expect(deriveAccountPublicKeyHex(fixedSecret)).toBe(expected);
    });

    it('builds the CLI bundle as [0 | contentPublicKey]', () => {
        const bundle = cliKeyBundlePlaintext(fixedSecret);
        expect(bundle).toHaveLength(33);
        expect(bundle[0]).toBe(0);
        expect(Buffer.from(bundle.slice(1)).equals(Buffer.from(deriveContentPublicKey(fixedSecret)))).toBe(true);
    });

    it('boxes data so the client box-bundle decoder can open it', () => {
        const recipient = tweetnacl.box.keyPair();
        const boxed = boxForRecipient(fixedSecret, recipient.publicKey);
        expect(boxed.length).toBe(32 + 24 + 32 + 16);
        const opened = decryptBoxBundle(boxed, recipient.secretKey);
        expect(opened && Buffer.from(opened).equals(Buffer.from(fixedSecret))).toBe(true);
    });

    it('accepts only 32-byte ephemeral public keys', () => {
        expect(decodeEphemeralPublicKey(privacyKit.encodeBase64(new Uint8Array(32)))).toHaveLength(32);
        expect(decodeEphemeralPublicKey(privacyKit.encodeBase64(new Uint8Array(31)))).toBeNull();
        expect(decodeEphemeralPublicKey('%%%not-base64%%%')).toBeNull();
    });
});
```

Create `packages/happy-server/sources/app/auth/oidc/keyVault.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { initEncrypt } from '@/modules/encrypt';
import { KeyVaultError, keyVault, openIdpRefreshToken, sealIdpRefreshToken } from './keyVault';

beforeAll(async () => {
    process.env.HANDY_MASTER_SECRET = 'test-master-secret-that-is-long-enough-000';
    await initEncrypt();
});

describe('keyVault', () => {
    it('round-trips a root secret', () => {
        const secret = new Uint8Array(32).fill(7);
        const wrapped = keyVault.wrap(secret);
        expect(typeof wrapped).toBe('string');
        expect(wrapped).not.toContain(Buffer.from(secret).toString('base64'));
        expect(Buffer.from(keyVault.unwrap(wrapped)).equals(Buffer.from(secret))).toBe(true);
    });

    it('throws KeyVaultError on tampered input', () => {
        const wrapped = keyVault.wrap(new Uint8Array(32).fill(1));
        const bytes = Buffer.from(wrapped, 'base64');
        bytes[bytes.length - 1] ^= 0xff;
        expect(() => keyVault.unwrap(bytes.toString('base64'))).toThrow(KeyVaultError);
    });

    it('round-trips an IdP refresh token', () => {
        const sealed = sealIdpRefreshToken('idp-refresh-token');
        expect(sealed).not.toContain('idp-refresh-token');
        expect(openIdpRefreshToken(sealed)).toBe('idp-refresh-token');
    });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/accountKeys.test.ts sources/app/auth/oidc/keyVault.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `accountKeys.ts`**

```ts
import { createHash, createHmac, randomBytes } from 'crypto';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';

export function generateRootSecret(): Uint8Array {
    return new Uint8Array(randomBytes(32));
}

/** Same value legacy `/v1/auth` stored in Account.publicKey (Ed25519 key from the secret). */
export function deriveAccountPublicKeyHex(rootSecret: Uint8Array): string {
    return privacyKit.encodeHex(tweetnacl.sign.keyPair.fromSeed(rootSecret).publicKey);
}

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
    return new Uint8Array(createHmac('sha512', key).update(data).digest());
}

// Mirrors happy-app sources/encryption/deriveKey.ts
function deriveKey(master: Uint8Array, usage: string, path: string[]): Uint8Array {
    let I = hmacSha512(new TextEncoder().encode(usage + ' Master Seed'), master);
    let chainCode = I.slice(32);
    let key = I.slice(0, 32);
    for (const index of path) {
        I = hmacSha512(chainCode, new Uint8Array([0x00, ...new TextEncoder().encode(index)]));
        key = I.slice(0, 32);
        chainCode = I.slice(32);
    }
    return key;
}

export function deriveContentPublicKey(rootSecret: Uint8Array): Uint8Array {
    const seed = deriveKey(rootSecret, 'Happy EnCoder', ['content']);
    // libsodium crypto_box_seed_keypair uses SHA-512(seed)[0:32] as the secret key
    const boxSecretKey = new Uint8Array(createHash('sha512').update(seed).digest()).slice(0, 32);
    return tweetnacl.box.keyPair.fromSecretKey(boxSecretKey).publicKey;
}

/** Plaintext of the v2 terminal pairing response: [0 | contentPublicKey]. */
export function cliKeyBundlePlaintext(rootSecret: Uint8Array): Uint8Array {
    const bundle = new Uint8Array(33);
    bundle[0] = 0;
    bundle.set(deriveContentPublicKey(rootSecret), 1);
    return bundle;
}

/** [ephemeralPublicKey(32) | nonce(24) | box] — the format clients decrypt with decryptWithEphemeralKey. */
export function boxForRecipient(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    const ephemeral = tweetnacl.box.keyPair();
    const nonce = new Uint8Array(randomBytes(tweetnacl.box.nonceLength));
    const encrypted = tweetnacl.box(data, nonce, recipientPublicKey, ephemeral.secretKey);
    const result = new Uint8Array(32 + nonce.length + encrypted.length);
    result.set(ephemeral.publicKey, 0);
    result.set(nonce, 32);
    result.set(encrypted, 32 + nonce.length);
    return result;
}

export function decodeEphemeralPublicKey(base64: string): Uint8Array | null {
    try {
        const bytes = privacyKit.decodeBase64(base64);
        return bytes.length === 32 ? new Uint8Array(bytes) : null;
    } catch {
        return null;
    }
}
```

- [ ] **Step 4: Implement `keyVault.ts`**

```ts
import * as privacyKit from 'privacy-kit';
import { decryptBytes, decryptString, encryptBytes, encryptString } from '@/modules/encrypt';

const ROOT_SECRET_PATH = ['oidc', 'account-root-secret'];
const IDP_REFRESH_TOKEN_PATH = ['oidc', 'idp-refresh-token'];

export class KeyVaultError extends Error {
    constructor(message = 'Failed to unwrap secret') {
        super(message);
        this.name = 'KeyVaultError';
    }
}

function toBytes(base64: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(privacyKit.decodeBase64(base64));
}

/** v1 key vault: KeyTree derived from HANDY_MASTER_SECRET. Swap for a KMS later. */
export const keyVault = {
    wrap(secret: Uint8Array): string {
        return privacyKit.encodeBase64(encryptBytes(ROOT_SECRET_PATH, new Uint8Array(secret)));
    },
    unwrap(wrapped: string): Uint8Array {
        let result: Uint8Array | null;
        try {
            result = decryptBytes(ROOT_SECRET_PATH, toBytes(wrapped));
        } catch {
            throw new KeyVaultError();
        }
        if (!result) {
            throw new KeyVaultError();
        }
        return result;
    },
};

export function sealIdpRefreshToken(token: string): string {
    return privacyKit.encodeBase64(encryptString(IDP_REFRESH_TOKEN_PATH, token));
}

export function openIdpRefreshToken(sealed: string): string {
    const result = decryptString(IDP_REFRESH_TOKEN_PATH, toBytes(sealed));
    if (result === null || result === undefined) {
        throw new KeyVaultError('Failed to open IdP refresh token');
    }
    return result;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/accountKeys.test.ts sources/app/auth/oidc/keyVault.test.ts`
Expected: PASS. If `tsc` later flags `Uint8Array<ArrayBuffer>` generics in `keyVault.ts`, fix with `new Uint8Array(...)` copies — do not change the byte formats.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-server/sources/app/auth/oidc/accountKeys*.ts packages/happy-server/sources/app/auth/oidc/keyVault*.ts
git commit -m "feat: add server-managed account keys and key vault"
```

---

### Task 5: Access tokens and authentication wiring

**Files:**
- Create: `packages/happy-server/sources/app/auth/oidc/accessTokens.ts`
- Create: `packages/happy-server/sources/app/auth/oidc/deviceSockets.ts`
- Modify: `packages/happy-server/sources/app/auth/auth.ts`
- Modify: `packages/happy-server/sources/app/api/types.ts`
- Modify: `packages/happy-server/sources/app/api/utils/enableAuthentication.ts`
- Modify: `packages/happy-server/sources/app/api/socket.ts`
- Test: `packages/happy-server/sources/app/auth/oidc/accessTokens.test.ts`

**Interfaces:**
- Produces (`accessTokens.ts`):
  ```ts
  interface AccessTokenClaims { userId: string; deviceId: string }
  function initAccessTokens(opts: { masterSecret: string; ttlSec: number }): void
  function createAccessToken(claims: AccessTokenClaims): string
  function verifyAccessToken(token: string): AccessTokenClaims | null
  function generateOpaqueToken(): string      // 32 random bytes, base64url
  function hashToken(token: string): string   // sha256 hex
  ```
- Produces (`deviceSockets.ts`): `setSocketServer(io)`, `deviceRoom(deviceId): string`, `disconnectDeviceSockets(deviceId): void`.
- Changes: `auth.verifyToken(token)` now returns `AccessTokenClaims | null`; `auth.createToken` is removed. `request.deviceId: string` is set by `app.authenticate`. `socket.data.deviceId` is set and the socket joins `deviceRoom(deviceId)`.

- [ ] **Step 1: Write the failing test**

Create `packages/happy-server/sources/app/auth/oidc/accessTokens.test.ts`:

```ts
import { beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createAccessToken, generateOpaqueToken, hashToken, initAccessTokens, verifyAccessToken } from './accessTokens';

const masterSecret = 'test-master-secret-that-is-long-enough-000';

beforeAll(() => initAccessTokens({ masterSecret, ttlSec: 900 }));

describe('accessTokens', () => {
    it('round-trips user and device', () => {
        const token = createAccessToken({ userId: 'acc_1', deviceId: 'dev_1' });
        expect(verifyAccessToken(token)).toEqual({ userId: 'acc_1', deviceId: 'dev_1' });
    });

    it('rejects expired tokens', () => {
        vi.useFakeTimers();
        try {
            const token = createAccessToken({ userId: 'acc_1', deviceId: 'dev_1' });
            vi.advanceTimersByTime(901_000);
            expect(verifyAccessToken(token)).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects tokens signed with another key', () => {
        const forged = jwt.sign({ did: 'dev_1', typ: 'access' }, 'other-key', { subject: 'acc_1', algorithm: 'HS256' });
        expect(verifyAccessToken(forged)).toBeNull();
    });

    it('rejects alg=none tokens', () => {
        const unsigned = jwt.sign({ did: 'dev_1', typ: 'access', sub: 'acc_1' }, '', { algorithm: 'none' });
        expect(verifyAccessToken(unsigned)).toBeNull();
    });

    it('rejects garbage', () => {
        expect(verifyAccessToken('not-a-token')).toBeNull();
    });

    it('generates unique opaque tokens and stable hashes', () => {
        const a = generateOpaqueToken();
        expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(generateOpaqueToken()).not.toBe(a);
        expect(hashToken(a)).toBe(hashToken(a));
        expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/accessTokens.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `accessTokens.ts`**

```ts
import { createHash, randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';

export interface AccessTokenClaims {
    userId: string;
    deviceId: string;
}

let signingKey: Buffer | null = null;
let accessTokenTtlSec = 900;

export function initAccessTokens(opts: { masterSecret: string; ttlSec: number }): void {
    signingKey = createHash('sha256').update('happy-access-token:' + opts.masterSecret).digest();
    accessTokenTtlSec = opts.ttlSec;
}

function key(): Buffer {
    if (!signingKey) {
        throw new Error('Access tokens not initialized');
    }
    return signingKey;
}

export function createAccessToken(claims: AccessTokenClaims): string {
    return jwt.sign({ did: claims.deviceId, typ: 'access' }, key(), {
        algorithm: 'HS256',
        subject: claims.userId,
        expiresIn: accessTokenTtlSec,
    });
}

export function verifyAccessToken(token: string): AccessTokenClaims | null {
    try {
        const payload = jwt.verify(token, key(), { algorithms: ['HS256'] });
        if (typeof payload !== 'object' || payload.typ !== 'access') {
            return null;
        }
        if (typeof payload.sub !== 'string' || typeof payload.did !== 'string') {
            return null;
        }
        return { userId: payload.sub, deviceId: payload.did };
    } catch {
        return null;
    }
}

export function generateOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/accessTokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Create `deviceSockets.ts`**

```ts
import type { Server } from 'socket.io';

let io: Server | null = null;

export function setSocketServer(server: Server): void {
    io = server;
}

export function deviceRoom(deviceId: string): string {
    return `device:${deviceId}`;
}

/** Disconnects every socket (on any node, via the adapter) opened with this device's token. */
export function disconnectDeviceSockets(deviceId: string): void {
    io?.in(deviceRoom(deviceId)).disconnectSockets(true);
}
```

- [ ] **Step 6: Switch `auth.ts` to access tokens**

In `packages/happy-server/sources/app/auth/auth.ts`:
1. Delete `TOKEN_CACHE_TTL`, `MAX_CACHE_SIZE`, `CLEANUP_INTERVAL`, `TokenCacheEntry`, the `tokenCache` and `cleanupTimer` fields, the `cleanup()` method and the `setInterval` in `init()`.
2. Remove `generator` and `verifier` from `AuthTokens` and from `init()` (keep `githubGenerator`/`githubVerifier` unchanged).
3. Delete `createToken`. Replace `verifyToken` with:

```ts
    async verifyToken(token: string): Promise<AccessTokenClaims | null> {
        return verifyAccessToken(token);
    }
```

4. Add the import: `import { AccessTokenClaims, verifyAccessToken } from "./oidc/accessTokens";`
5. Delete any `invalidateUserTokens`/cache helper methods that referenced `tokenCache` (search the file for `tokenCache` — no references may remain).

- [ ] **Step 7: Expose the device on requests and sockets**

In `packages/happy-server/sources/app/api/types.ts`, inside `interface FastifyRequest`, add `deviceId: string;` below `userId: string;`.

In `packages/happy-server/sources/app/api/utils/enableAuthentication.ts`, after `request.userId = verified.userId;` add:

```ts
            request.deviceId = verified.deviceId;
```

In `packages/happy-server/sources/app/api/socket.ts`:
1. Add import: `import { deviceRoom, setSocketServer } from "@/app/auth/oidc/deviceSockets";`
2. Right after `const io = new Server(app.server, socketServerOptions);` add `setSocketServer(io);`
3. After `socket.data.userId = verified.userId;` add `socket.data.deviceId = verified.deviceId;`
4. At the top of the `io.on("connection", (socket) => {` handler add:

```ts
        socket.join(deviceRoom(socket.data.deviceId as string));
```

- [ ] **Step 8: Run all unit tests**

Run: `pnpm --filter happy-server test`
Expected: all tests pass (`socket.spec.ts` does not mock `auth.verifyToken`, so it needs no change).

- [ ] **Step 9: Commit**

```bash
git add packages/happy-server/sources/app/auth packages/happy-server/sources/app/api/types.ts \
  packages/happy-server/sources/app/api/utils/enableAuthentication.ts packages/happy-server/sources/app/api/socket.ts
git commit -m "feat: authenticate requests with short-lived device access tokens"
```

---

### Task 6: Devices and refresh-token rotation

**Files:**
- Create: `packages/happy-server/sources/app/auth/oidc/devices.ts`
- Test: `packages/happy-server/sources/app/auth/oidc/devices.test.ts`

**Interfaces:**
- Consumes: `createAccessToken`, `generateOpaqueToken`, `hashToken`, `initAccessTokens` (Task 5); `disconnectDeviceSockets` (Task 5); `createTestDb` (Task 1).
- Produces:
  ```ts
  type DeviceKind = 'cli' | 'web' | 'mobile'
  interface TokenPair { accessToken: string; refreshToken: string }
  function createDevice(input: { accountId: string; kind: DeviceKind; name: string; host?: string | null; now?: Date }): Promise<TokenPair & { deviceId: string }>
  type RefreshFailure = 'invalid' | 'reused' | 'revoked' | 'disabled' | 'expired'
  type RefreshResult = { ok: true; tokens: TokenPair } | { ok: false; reason: RefreshFailure }
  function refreshDevice(refreshToken: string, opts: { maxSessionAgeSec: number; now?: Date; checkIdp?: (accountId: string) => Promise<boolean> }): Promise<RefreshResult>
  function revokeDevice(deviceId: string): Promise<void>
  function revokeAccountDevices(accountId: string): Promise<void>
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/happy-server/sources/app/auth/oidc/devices.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb } from '@/testing/testDb';

let db: PrismaClient;
let devices: typeof import('./devices');
let tokens: typeof import('./accessTokens');

const MAX_AGE = 30 * 86400;

beforeAll(async () => {
    db = await createTestDb();
    tokens = await import('./accessTokens');
    tokens.initAccessTokens({ masterSecret: 'test-master-secret-that-is-long-enough-000', ttlSec: 900 });
    devices = await import('./devices');
});

let counter = 0;
async function newAccount(data: { disabledAt?: Date } = {}) {
    counter++;
    return db.account.create({ data: { publicKey: `pk-devices-${counter}`, ...data } });
}

describe('devices', () => {
    it('creates a device with working tokens', async () => {
        const account = await newAccount();
        const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'dev-42', host: 'dev-42' });
        expect(tokens.verifyAccessToken(created.accessToken)).toEqual({ userId: account.id, deviceId: created.deviceId });
        const row = await db.device.findUniqueOrThrow({ where: { id: created.deviceId } });
        expect(row.refreshTokenHash).toBe(tokens.hashToken(created.refreshToken));
        expect(row.kind).toBe('cli');
    });

    it('rotates refresh tokens', async () => {
        const account = await newAccount();
        const created = await devices.createDevice({ accountId: account.id, kind: 'web', name: 'web' });
        const result = await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.tokens.refreshToken).not.toBe(created.refreshToken);
        expect(tokens.verifyAccessToken(result.tokens.accessToken)?.deviceId).toBe(created.deviceId);
    });

    it('revokes the device when a rotated token is reused', async () => {
        const account = await newAccount();
        const created = await devices.createDevice({ accountId: account.id, kind: 'web', name: 'web' });
        const first = await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE });
        expect(first.ok).toBe(true);
        const reuse = await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE });
        expect(reuse).toEqual({ ok: false, reason: 'reused' });
        if (!first.ok) return;
        const afterReuse = await devices.refreshDevice(first.tokens.refreshToken, { maxSessionAgeSec: MAX_AGE });
        expect(afterReuse).toEqual({ ok: false, reason: 'revoked' });
    });

    it('rejects unknown tokens', async () => {
        expect(await devices.refreshDevice('nope', { maxSessionAgeSec: MAX_AGE })).toEqual({ ok: false, reason: 'invalid' });
    });

    it('rejects revoked devices', async () => {
        const account = await newAccount();
        const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'x' });
        await devices.revokeDevice(created.deviceId);
        expect(await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE }))
            .toEqual({ ok: false, reason: 'revoked' });
    });

    it('rejects disabled accounts', async () => {
        const account = await newAccount({ disabledAt: new Date() });
        const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'x' });
        expect(await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE }))
            .toEqual({ ok: false, reason: 'disabled' });
    });

    it('expires sessions older than the max age', async () => {
        const account = await newAccount();
        const start = new Date('2026-01-01T00:00:00Z');
        const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'x', now: start });
        const later = new Date(start.getTime() + (MAX_AGE + 1) * 1000);
        expect(await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE, now: later }))
            .toEqual({ ok: false, reason: 'expired' });
        const row = await db.device.findUniqueOrThrow({ where: { id: created.deviceId } });
        expect(row.revokedAt).not.toBeNull();
    });

    it('rejects when the IdP check fails', async () => {
        const account = await newAccount();
        const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'x' });
        const result = await devices.refreshDevice(created.refreshToken, {
            maxSessionAgeSec: MAX_AGE,
            checkIdp: async (accountId) => accountId !== account.id,
        });
        expect(result).toEqual({ ok: false, reason: 'disabled' });
    });

    it('revokes all devices of an account', async () => {
        const account = await newAccount();
        const a = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'a' });
        const b = await devices.createDevice({ accountId: account.id, kind: 'web', name: 'b' });
        await devices.revokeAccountDevices(account.id);
        for (const d of [a, b]) {
            expect(await devices.refreshDevice(d.refreshToken, { maxSessionAgeSec: MAX_AGE }))
                .toEqual({ ok: false, reason: 'revoked' });
        }
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/devices.test.ts`
Expected: FAIL — cannot find `./devices`.

- [ ] **Step 3: Implement `devices.ts`**

```ts
import { db } from '@/storage/db';
import { createAccessToken, generateOpaqueToken, hashToken } from './accessTokens';
import { disconnectDeviceSockets } from './deviceSockets';

export type DeviceKind = 'cli' | 'web' | 'mobile';

export interface TokenPair {
    accessToken: string;
    refreshToken: string;
}

export type RefreshFailure = 'invalid' | 'reused' | 'revoked' | 'disabled' | 'expired';
export type RefreshResult = { ok: true; tokens: TokenPair } | { ok: false; reason: RefreshFailure };

export async function createDevice(input: {
    accountId: string;
    kind: DeviceKind;
    name: string;
    host?: string | null;
    now?: Date;
}): Promise<TokenPair & { deviceId: string }> {
    const now = input.now ?? new Date();
    const refreshToken = generateOpaqueToken();
    const device = await db.device.create({
        data: {
            accountId: input.accountId,
            kind: input.kind,
            name: input.name,
            host: input.host ?? null,
            refreshTokenHash: hashToken(refreshToken),
            sessionStartedAt: now,
            lastSeenAt: now,
        },
    });
    return {
        deviceId: device.id,
        refreshToken,
        accessToken: createAccessToken({ userId: input.accountId, deviceId: device.id }),
    };
}

export async function refreshDevice(
    refreshToken: string,
    opts: { maxSessionAgeSec: number; now?: Date; checkIdp?: (accountId: string) => Promise<boolean> },
): Promise<RefreshResult> {
    const now = opts.now ?? new Date();
    const hash = hashToken(refreshToken);
    const device = await db.device.findUnique({ where: { refreshTokenHash: hash }, include: { account: true } });
    if (!device) {
        const reused = await db.device.findFirst({ where: { previousRefreshTokenHash: hash } });
        if (reused) {
            await revokeDevice(reused.id);
            return { ok: false, reason: 'reused' };
        }
        return { ok: false, reason: 'invalid' };
    }
    if (device.revokedAt) {
        return { ok: false, reason: 'revoked' };
    }
    if (device.account.disabledAt) {
        return { ok: false, reason: 'disabled' };
    }
    if (now.getTime() - device.sessionStartedAt.getTime() > opts.maxSessionAgeSec * 1000) {
        await revokeDevice(device.id);
        return { ok: false, reason: 'expired' };
    }
    if (opts.checkIdp && !(await opts.checkIdp(device.accountId))) {
        return { ok: false, reason: 'disabled' };
    }

    const next = generateOpaqueToken();
    // Conditional update: a concurrent refresh with the same token loses and gets 'invalid'.
    const updated = await db.device.updateMany({
        where: { id: device.id, refreshTokenHash: hash, revokedAt: null },
        data: { refreshTokenHash: hashToken(next), previousRefreshTokenHash: hash, lastSeenAt: now },
    });
    if (updated.count !== 1) {
        return { ok: false, reason: 'invalid' };
    }
    return {
        ok: true,
        tokens: {
            refreshToken: next,
            accessToken: createAccessToken({ userId: device.accountId, deviceId: device.id }),
        },
    };
}

export async function revokeDevice(deviceId: string): Promise<void> {
    await db.device.updateMany({ where: { id: deviceId, revokedAt: null }, data: { revokedAt: new Date() } });
    disconnectDeviceSockets(deviceId);
}

export async function revokeAccountDevices(accountId: string): Promise<void> {
    const active = await db.device.findMany({ where: { accountId, revokedAt: null }, select: { id: true } });
    for (const device of active) {
        await revokeDevice(device.id);
    }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/devices.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/happy-server/sources/app/auth/oidc/devices*.ts
git commit -m "feat: add devices with rotating refresh tokens and revocation"
```

---

### Task 7: OIDC client wrapper

**Files:**
- Create: `packages/happy-server/sources/app/auth/oidc/oidcClient.ts`
- Test: `packages/happy-server/sources/app/auth/oidc/oidcClient.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface OidcLoginParams { state: string; nonce: string; codeVerifier: string }
  interface OidcIdentity { issuer: string; subject: string; email: string | null; name: string | null; refreshToken: string | null }
  type IdpRefreshResult = { status: 'ok'; refreshToken: string | null } | { status: 'rejected' } | { status: 'unavailable' }
  interface OidcClient {
      buildLoginUrl(params: OidcLoginParams): Promise<URL>;
      handleCallback(callbackUrl: URL, params: OidcLoginParams): Promise<OidcIdentity>;
      refresh(refreshToken: string): Promise<IdpRefreshResult>;
  }
  function newLoginParams(): OidcLoginParams
  function createOidcClient(cfg: { issuer: string; clientId: string; clientSecret: string; scopes: string; redirectUri: string }, opts?: { allowInsecureRequests?: boolean }): Promise<OidcClient>
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/happy-server/sources/app/auth/oidc/oidcClient.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OAuth2Server } from 'oauth2-mock-server';
import { createOidcClient, newLoginParams, type OidcClient } from './oidcClient';

const redirectUri = 'http://localhost:3005/v1/auth/oidc/callback';
let server: OAuth2Server;
let client: OidcClient;
let nonceForNextToken: string | null = null;

beforeAll(async () => {
    server = new OAuth2Server();
    await server.issuer.keys.generate('RS256');
    await server.start(0, '127.0.0.1');
    server.service.on('beforeTokenSigning', (token) => {
        token.payload.sub = 'alice';
        token.payload.email = 'alice@example.com';
        token.payload.name = 'Alice Example';
        if (nonceForNextToken) token.payload.nonce = nonceForNextToken;
    });
    client = await createOidcClient(
        { issuer: server.issuer.url!, clientId: 'happy-server', clientSecret: 'secret', scopes: 'openid email profile', redirectUri },
        { allowInsecureRequests: true },
    );
});

afterAll(async () => {
    await server.stop();
});

async function authorize(params: ReturnType<typeof newLoginParams>): Promise<URL> {
    const loginUrl = await client.buildLoginUrl(params);
    const response = await fetch(loginUrl, { redirect: 'manual' });
    return new URL(response.headers.get('location')!);
}

describe('oidcClient', () => {
    it('builds a PKCE login URL', async () => {
        const params = newLoginParams();
        const url = await client.buildLoginUrl(params);
        expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('state')).toBe(params.state);
        expect(url.searchParams.get('nonce')).toBe(params.nonce);
        expect(url.searchParams.get('code_challenge')).not.toBe(params.codeVerifier);
    });

    it('completes the code flow and returns the identity', async () => {
        const params = newLoginParams();
        nonceForNextToken = params.nonce;
        const callback = await authorize(params);
        const identity = await client.handleCallback(callback, params);
        expect(identity).toMatchObject({
            issuer: server.issuer.url,
            subject: 'alice',
            email: 'alice@example.com',
            name: 'Alice Example',
        });
        expect(identity.refreshToken).toEqual(expect.any(String));
    });

    it('rejects a nonce mismatch', async () => {
        const params = newLoginParams();
        nonceForNextToken = 'someone-elses-nonce';
        const callback = await authorize(params);
        await expect(client.handleCallback(callback, params)).rejects.toThrow();
    });

    it('rejects a state mismatch', async () => {
        const params = newLoginParams();
        nonceForNextToken = params.nonce;
        const callback = await authorize(params);
        await expect(client.handleCallback(callback, { ...params, state: 'other' })).rejects.toThrow();
    });

    it('refreshes and reports invalid_grant as rejected', async () => {
        const params = newLoginParams();
        nonceForNextToken = params.nonce;
        const identity = await client.handleCallback(await authorize(params), params);
        expect((await client.refresh(identity.refreshToken!)).status).toBe('ok');

        server.service.once('beforeResponse', (response, req) => {
            if (req.body.grant_type === 'refresh_token') {
                response.statusCode = 400;
                response.body = { error: 'invalid_grant' };
            }
        });
        expect(await client.refresh(identity.refreshToken!)).toEqual({ status: 'rejected' });
    });

    it('reports an unreachable IdP as unavailable', async () => {
        server.service.once('beforeResponse', (response, req) => {
            if (req.body.grant_type === 'refresh_token') {
                response.statusCode = 503;
                response.body = { error: 'temporarily_unavailable' };
            }
        });
        expect(await client.refresh('any')).toEqual({ status: 'unavailable' });
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/oidcClient.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `oidcClient.ts`**

```ts
import * as client from 'openid-client';

export interface OidcLoginParams {
    state: string;
    nonce: string;
    codeVerifier: string;
}

export interface OidcIdentity {
    issuer: string;
    subject: string;
    email: string | null;
    name: string | null;
    refreshToken: string | null;
}

export type IdpRefreshResult =
    | { status: 'ok'; refreshToken: string | null }
    | { status: 'rejected' }
    | { status: 'unavailable' };

export interface OidcClient {
    buildLoginUrl(params: OidcLoginParams): Promise<URL>;
    handleCallback(callbackUrl: URL, params: OidcLoginParams): Promise<OidcIdentity>;
    refresh(refreshToken: string): Promise<IdpRefreshResult>;
}

export function newLoginParams(): OidcLoginParams {
    return {
        state: client.randomState(),
        nonce: client.randomNonce(),
        codeVerifier: client.randomPKCECodeVerifier(),
    };
}

export async function createOidcClient(
    cfg: { issuer: string; clientId: string; clientSecret: string; scopes: string; redirectUri: string },
    opts: { allowInsecureRequests?: boolean } = {},
): Promise<OidcClient> {
    const config = await client.discovery(
        new URL(cfg.issuer),
        cfg.clientId,
        cfg.clientSecret,
        undefined,
        opts.allowInsecureRequests ? { execute: [client.allowInsecureRequests] } : undefined,
    );

    return {
        async buildLoginUrl(params) {
            return client.buildAuthorizationUrl(config, {
                redirect_uri: cfg.redirectUri,
                scope: cfg.scopes,
                code_challenge: await client.calculatePKCECodeChallenge(params.codeVerifier),
                code_challenge_method: 'S256',
                state: params.state,
                nonce: params.nonce,
            });
        },

        async handleCallback(callbackUrl, params) {
            const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
                pkceCodeVerifier: params.codeVerifier,
                expectedState: params.state,
                expectedNonce: params.nonce,
                idTokenExpected: true,
            });
            const claims = tokens.claims();
            if (!claims) {
                throw new Error('IdP returned no id_token');
            }
            return {
                issuer: claims.iss,
                subject: claims.sub,
                email: typeof claims.email === 'string' ? claims.email : null,
                name: typeof claims.name === 'string' ? claims.name : null,
                refreshToken: tokens.refresh_token ?? null,
            };
        },

        async refresh(refreshToken) {
            try {
                const tokens = await client.refreshTokenGrant(config, refreshToken);
                return { status: 'ok', refreshToken: tokens.refresh_token ?? null };
            } catch (error) {
                if (error instanceof client.ResponseBodyError && error.error === 'invalid_grant') {
                    return { status: 'rejected' };
                }
                return { status: 'unavailable' };
            }
        },
    };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/oidcClient.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/happy-server/sources/app/auth/oidc/oidcClient*.ts
git commit -m "feat: add OIDC client wrapper with PKCE and refresh"
```

---

### Task 8: Account provisioning and IdP re-validation

**Files:**
- Create: `packages/happy-server/sources/app/auth/oidc/provisioning.ts`
- Create: `packages/happy-server/sources/app/auth/oidc/idpCheck.ts`
- Test: `packages/happy-server/sources/app/auth/oidc/provisioning.test.ts`
- Test: `packages/happy-server/sources/app/auth/oidc/idpCheck.test.ts`

**Interfaces:**
- Consumes: `OidcIdentity`, `OidcClient`, `IdpRefreshResult` (Task 7); `keyVault`, `sealIdpRefreshToken`, `openIdpRefreshToken` (Task 4); `generateRootSecret`, `deriveAccountPublicKeyHex` (Task 4); `revokeAccountDevices`, `createDevice`, `refreshDevice` (Task 6).
- Produces:
  ```ts
  class AccountDisabledError extends Error {}
  function provisionAccount(identity: OidcIdentity, now?: Date): Promise<{ accountId: string }>
  const IDP_CHECK_INTERVAL_MS = 15 * 60 * 1000
  function createIdpCheck(deps: { oidc: Pick<OidcClient, 'refresh'>; now?: () => Date }): (accountId: string) => Promise<boolean>
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/happy-server/sources/app/auth/oidc/provisioning.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb } from '@/testing/testDb';

let db: PrismaClient;
let provisioning: typeof import('./provisioning');
let keys: typeof import('./accountKeys');
let vault: typeof import('./keyVault');

beforeAll(async () => {
    process.env.HANDY_MASTER_SECRET = 'test-master-secret-that-is-long-enough-000';
    db = await createTestDb();
    await (await import('@/modules/encrypt')).initEncrypt();
    provisioning = await import('./provisioning');
    keys = await import('./accountKeys');
    vault = await import('./keyVault');
});

const identity = (subject: string, extra: Partial<import('./oidcClient').OidcIdentity> = {}) => ({
    issuer: 'https://idp.test', subject, email: `${subject}@example.com`, name: 'Alice Example', refreshToken: null, ...extra,
});

describe('provisionAccount', () => {
    it('creates an account with a wrapped root secret on first login', async () => {
        const { accountId } = await provisioning.provisionAccount(identity('p-alice'));
        const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
        const root = vault.keyVault.unwrap(account.wrappedRootSecret!);
        expect(root).toHaveLength(32);
        expect(account.publicKey).toBe(keys.deriveAccountPublicKeyHex(root));
        expect(account).toMatchObject({ email: 'p-alice@example.com', firstName: 'Alice', lastName: 'Example' });
    });

    it('returns the same account on later logins and keeps the secret', async () => {
        const first = await provisioning.provisionAccount(identity('p-bob'));
        const before = await db.account.findUniqueOrThrow({ where: { id: first.accountId } });
        const second = await provisioning.provisionAccount(identity('p-bob', { email: 'bob.new@example.com' }));
        const after = await db.account.findUniqueOrThrow({ where: { id: second.accountId } });
        expect(second.accountId).toBe(first.accountId);
        expect(after.wrappedRootSecret).toBe(before.wrappedRootSecret);
        expect(after.email).toBe('bob.new@example.com');
    });

    it('stores the IdP refresh token sealed', async () => {
        const { accountId } = await provisioning.provisionAccount(identity('p-carol', { refreshToken: 'idp-rt' }));
        const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
        expect(account.idpRefreshToken).not.toBe('idp-rt');
        expect(vault.openIdpRefreshToken(account.idpRefreshToken!)).toBe('idp-rt');
        expect(account.idpCheckedAt).not.toBeNull();
    });

    it('refuses disabled accounts', async () => {
        const { accountId } = await provisioning.provisionAccount(identity('p-dave'));
        await db.account.update({ where: { id: accountId }, data: { disabledAt: new Date() } });
        await expect(provisioning.provisionAccount(identity('p-dave'))).rejects.toBeInstanceOf(provisioning.AccountDisabledError);
    });

    it('keeps issuers separate', async () => {
        const a = await provisioning.provisionAccount(identity('p-same'));
        const b = await provisioning.provisionAccount({ ...identity('p-same'), issuer: 'https://other-idp.test' });
        expect(a.accountId).not.toBe(b.accountId);
    });
});
```

Create `packages/happy-server/sources/app/auth/oidc/idpCheck.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb } from '@/testing/testDb';
import type { IdpRefreshResult } from './oidcClient';

let db: PrismaClient;
let idp: typeof import('./idpCheck');
let provisioning: typeof import('./provisioning');
let devices: typeof import('./devices');
let vault: typeof import('./keyVault');

beforeAll(async () => {
    process.env.HANDY_MASTER_SECRET = 'test-master-secret-that-is-long-enough-000';
    db = await createTestDb();
    await (await import('@/modules/encrypt')).initEncrypt();
    (await import('./accessTokens')).initAccessTokens({ masterSecret: process.env.HANDY_MASTER_SECRET, ttlSec: 900 });
    idp = await import('./idpCheck');
    provisioning = await import('./provisioning');
    devices = await import('./devices');
    vault = await import('./keyVault');
});

function fakeOidc(result: IdpRefreshResult) {
    const calls: string[] = [];
    return { calls, oidc: { refresh: async (token: string) => { calls.push(token); return result; } } };
}

async function accountWithIdpToken(subject: string, checkedAt: Date) {
    const { accountId } = await provisioning.provisionAccount({
        issuer: 'https://idp.test', subject, email: null, name: null, refreshToken: 'idp-rt-1',
    });
    await db.account.update({ where: { id: accountId }, data: { idpCheckedAt: checkedAt } });
    return accountId;
}

const now = new Date('2026-09-30T12:00:00Z');
const stale = new Date(now.getTime() - 15 * 60 * 1000 - 1); // older than IDP_CHECK_INTERVAL_MS

describe('createIdpCheck', () => {
    it('allows accounts without an IdP refresh token without calling the IdP', async () => {
        const { accountId } = await provisioning.provisionAccount({ issuer: 'https://idp.test', subject: 'i-none', email: null, name: null, refreshToken: null });
        const { calls, oidc } = fakeOidc({ status: 'rejected' });
        expect(await idp.createIdpCheck({ oidc, now: () => now })(accountId)).toBe(true);
        expect(calls).toEqual([]);
    });

    it('skips the IdP when checked recently', async () => {
        const accountId = await accountWithIdpToken('i-recent', new Date(now.getTime() - 1000));
        const { calls, oidc } = fakeOidc({ status: 'rejected' });
        expect(await idp.createIdpCheck({ oidc, now: () => now })(accountId)).toBe(true);
        expect(calls).toEqual([]);
    });

    it('stores a rotated IdP token when the check succeeds', async () => {
        const accountId = await accountWithIdpToken('i-ok', stale);
        const { calls, oidc } = fakeOidc({ status: 'ok', refreshToken: 'idp-rt-2' });
        expect(await idp.createIdpCheck({ oidc, now: () => now })(accountId)).toBe(true);
        expect(calls).toEqual(['idp-rt-1']);
        const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
        expect(vault.openIdpRefreshToken(account.idpRefreshToken!)).toBe('idp-rt-2');
        expect(account.idpCheckedAt?.toISOString()).toBe(now.toISOString());
    });

    it('revokes all devices when the IdP rejects the account', async () => {
        const accountId = await accountWithIdpToken('i-rejected', stale);
        const device = await devices.createDevice({ accountId, kind: 'cli', name: 'x' });
        const { oidc } = fakeOidc({ status: 'rejected' });
        expect(await idp.createIdpCheck({ oidc, now: () => now })(accountId)).toBe(false);
        const row = await db.device.findUniqueOrThrow({ where: { id: device.deviceId } });
        expect(row.revokedAt).not.toBeNull();
        const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
        expect(account.idpRefreshToken).toBeNull();
    });

    it('fails open when the IdP is unavailable', async () => {
        const accountId = await accountWithIdpToken('i-down', stale);
        const { oidc } = fakeOidc({ status: 'unavailable' });
        expect(await idp.createIdpCheck({ oidc, now: () => now })(accountId)).toBe(true);
    });

    it('lets only one concurrent caller contact the IdP', async () => {
        const accountId = await accountWithIdpToken('i-race', stale);
        const { calls, oidc } = fakeOidc({ status: 'ok', refreshToken: null });
        const check = idp.createIdpCheck({ oidc, now: () => now });
        const results = await Promise.all([check(accountId), check(accountId), check(accountId)]);
        expect(results).toEqual([true, true, true]);
        expect(calls).toHaveLength(1);
    });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/provisioning.test.ts sources/app/auth/oidc/idpCheck.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `provisioning.ts`**

```ts
import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { separateName } from '@/utils/separateName';
import { deriveAccountPublicKeyHex, generateRootSecret } from './accountKeys';
import { keyVault, sealIdpRefreshToken } from './keyVault';
import type { OidcIdentity } from './oidcClient';

export class AccountDisabledError extends Error {
    constructor() {
        super('Account is disabled');
        this.name = 'AccountDisabledError';
    }
}

export async function provisionAccount(identity: OidcIdentity, now: Date = new Date()): Promise<{ accountId: string }> {
    const where = { oidcIssuer_oidcSubject: { oidcIssuer: identity.issuer, oidcSubject: identity.subject } };
    const idpFields = identity.refreshToken
        ? { idpRefreshToken: sealIdpRefreshToken(identity.refreshToken), idpCheckedAt: now }
        : {};

    const existing = await db.account.findUnique({ where });
    if (existing) {
        if (existing.disabledAt) {
            throw new AccountDisabledError();
        }
        await db.account.update({ where: { id: existing.id }, data: { email: identity.email, ...idpFields } });
        return { accountId: existing.id };
    }

    const rootSecret = generateRootSecret();
    const { firstName, lastName } = separateName(identity.name);
    try {
        const created = await db.account.create({
            data: {
                publicKey: deriveAccountPublicKeyHex(rootSecret),
                wrappedRootSecret: keyVault.wrap(rootSecret),
                oidcIssuer: identity.issuer,
                oidcSubject: identity.subject,
                email: identity.email,
                firstName,
                lastName,
                ...idpFields,
            },
        });
        return { accountId: created.id };
    } catch (error) {
        // Concurrent first login for the same identity: the other request won.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            const winner = await db.account.findUniqueOrThrow({ where });
            return { accountId: winner.id };
        }
        throw error;
    }
}
```

- [ ] **Step 4: Implement `idpCheck.ts`**

```ts
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import { revokeAccountDevices } from './devices';
import { openIdpRefreshToken, sealIdpRefreshToken } from './keyVault';
import type { OidcClient } from './oidcClient';

export const IDP_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Returns a check used on refresh: at most once per interval per account, refresh the
 * stored IdP token. invalid_grant → revoke all devices; IdP unreachable → allow.
 */
export function createIdpCheck(deps: { oidc: Pick<OidcClient, 'refresh'>; now?: () => Date }) {
    return async function checkIdp(accountId: string): Promise<boolean> {
        const account = await db.account.findUnique({
            where: { id: accountId },
            select: { idpRefreshToken: true, idpCheckedAt: true },
        });
        if (!account?.idpRefreshToken) {
            return true;
        }
        const now = deps.now?.() ?? new Date();
        if (account.idpCheckedAt && now.getTime() - account.idpCheckedAt.getTime() < IDP_CHECK_INTERVAL_MS) {
            return true;
        }

        // Claim the check so concurrent refreshes don't all hit the IdP with the same token.
        const claimed = await db.account.updateMany({
            where: { id: accountId, idpCheckedAt: account.idpCheckedAt },
            data: { idpCheckedAt: now },
        });
        if (claimed.count !== 1) {
            return true;
        }

        const result = await deps.oidc.refresh(openIdpRefreshToken(account.idpRefreshToken));
        if (result.status === 'rejected') {
            log({ module: 'auth', level: 'warn' }, `IdP rejected account ${accountId}; revoking devices`);
            await db.account.update({ where: { id: accountId }, data: { idpRefreshToken: null } });
            await revokeAccountDevices(accountId);
            return false;
        }
        if (result.status === 'unavailable') {
            log({ module: 'auth', level: 'warn' }, `IdP unavailable while checking account ${accountId}`);
            return true;
        }
        if (result.refreshToken) {
            await db.account.update({
                where: { id: accountId },
                data: { idpRefreshToken: sealIdpRefreshToken(result.refreshToken) },
            });
        }
        return true;
    };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/provisioning.test.ts sources/app/auth/oidc/idpCheck.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-server/sources/app/auth/oidc/provisioning*.ts packages/happy-server/sources/app/auth/oidc/idpCheck*.ts
git commit -m "feat: provision OIDC accounts and re-validate them with the IdP"
```

---

### Task 9: Web/mobile login routes (login, callback, exchange)

**Files:**
- Create: `packages/happy-server/sources/app/auth/oidc/browserCookies.ts`
- Create: `packages/happy-server/sources/app/auth/oidc/exchangeCodes.ts`
- Create: `packages/happy-server/sources/app/auth/oidc/pages.ts`
- Create: `packages/happy-server/sources/testing/authTestKit.ts`
- Create: `packages/happy-server/sources/app/api/routes/oidcRoutes.ts`
- Test: `packages/happy-server/sources/app/auth/oidc/browserCookies.test.ts`
- Test: `packages/happy-server/sources/app/api/routes/oidcRoutes.spec.ts`

**Interfaces:**
- Produces (`browserCookies.ts`):
  ```ts
  const LOGIN_COOKIE = 'happy_oidc_login'; const SESSION_COOKIE = 'happy_session'
  function initBrowserCookies(opts: { masterSecret: string; secure: boolean }): void
  function signValue(purpose: string, payload: object, ttlSec: number): string
  function verifyValue<T>(purpose: string, token: string | undefined): T | null
  function setCookieHeader(name: string, payload: object, ttlSec: number): string
  function clearCookieHeader(name: string): string
  function readCookie<T>(cookieHeader: string | undefined, name: string): T | null
  ```
- Produces (`exchangeCodes.ts`):
  ```ts
  function createExchangeCode(input: { accountId: string; clientKind: 'web' | 'mobile'; pkceChallenge: string }): Promise<string>
  function redeemExchangeCode(code: string, codeVerifier: string): Promise<{ accountId: string; clientKind: 'web' | 'mobile' } | null>
  ```
- Produces (`pages.ts`): `escapeHtml(s)`, `messagePage(title, message)`, `enterCodePage(opts: { code?: string; error?: string })`, `confirmPage(opts: { userCode; host; os; cliVersion; csrf })` — all return HTML strings.
- Produces (`authTestKit.ts`): `TEST_ENV`, `setupAuthTest(): Promise<{ db; config: AuthConfig; fake: FakeOidc }>`, `buildTestApp(register: (app: Fastify) => void): Promise<Fastify>`, `cookieHeader(res): string`, `createFakeOidc(): FakeOidc` where `FakeOidc = { client: OidcClient; queueIdentity(i: OidcIdentity): void; setRefreshResult(r: IdpRefreshResult): void; refreshCalls: number }`.
- Produces (`oidcRoutes.ts`):
  ```ts
  interface AuthRouteDeps { config: AuthConfig; oidc: OidcClient; checkIdp: (accountId: string) => Promise<boolean> }
  type LoginTarget = { kind: 'web'; appChallenge: string } | { kind: 'mobile'; appChallenge: string; redirectUri: string } | { kind: 'activate'; userCode: string | null }
  function oidcRoutes(app: Fastify, deps: AuthRouteDeps): void
  ```
  Endpoints: `GET /v1/auth/oidc/login`, `GET /v1/auth/oidc/callback`, `POST /v1/auth/oidc/exchange`.

- [ ] **Step 1: Write the failing cookie test**

Create `packages/happy-server/sources/app/auth/oidc/browserCookies.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { clearCookieHeader, initBrowserCookies, readCookie, setCookieHeader, signValue, verifyValue } from './browserCookies';

beforeAll(() => initBrowserCookies({ masterSecret: 'test-master-secret-that-is-long-enough-000', secure: true }));

describe('browserCookies', () => {
    it('sets hardened cookies and reads them back', () => {
        const header = setCookieHeader('happy_session', { accountId: 'acc_1' }, 600);
        expect(header).toMatch(/^happy_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
        const cookie = header.split(';')[0];
        expect(readCookie<{ accountId: string }>(`other=1; ${cookie}`, 'happy_session')?.accountId).toBe('acc_1');
    });

    it('does not accept a cookie under another name', () => {
        const value = setCookieHeader('happy_oidc_login', { accountId: 'acc_1' }, 600).split(';')[0].split('=')[1];
        expect(readCookie(`happy_session=${value}`, 'happy_session')).toBeNull();
    });

    it('rejects tampered values', () => {
        const value = setCookieHeader('happy_session', { accountId: 'acc_1' }, 600).split(';')[0].split('=')[1];
        expect(readCookie(`happy_session=${value}x`, 'happy_session')).toBeNull();
    });

    it('clears cookies', () => {
        expect(clearCookieHeader('happy_session')).toBe('happy_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
    });

    it('binds signed values to a purpose', () => {
        const token = signValue('activate-csrf', { userCode: 'BCDF-GHJK' }, 600);
        expect(verifyValue<{ userCode: string }>('activate-csrf', token)?.userCode).toBe('BCDF-GHJK');
        expect(verifyValue('other-purpose', token)).toBeNull();
        expect(verifyValue('activate-csrf', undefined)).toBeNull();
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/browserCookies.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `browserCookies.ts`**

```ts
import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';

export const LOGIN_COOKIE = 'happy_oidc_login';
export const SESSION_COOKIE = 'happy_session';

let signingKey: Buffer | null = null;
let secureCookies = true;

export function initBrowserCookies(opts: { masterSecret: string; secure: boolean }): void {
    signingKey = createHash('sha256').update('happy-browser-cookie:' + opts.masterSecret).digest();
    secureCookies = opts.secure;
}

function key(): Buffer {
    if (!signingKey) {
        throw new Error('Browser cookies not initialized');
    }
    return signingKey;
}

export function signValue(purpose: string, payload: object, ttlSec: number): string {
    return jwt.sign({ ...payload, pur: purpose }, key(), { algorithm: 'HS256', expiresIn: ttlSec });
}

export function verifyValue<T>(purpose: string, token: string | undefined): T | null {
    if (!token) {
        return null;
    }
    try {
        const payload = jwt.verify(token, key(), { algorithms: ['HS256'] });
        if (typeof payload !== 'object' || payload.pur !== purpose) {
            return null;
        }
        return payload as T;
    } catch {
        return null;
    }
}

function attributes(maxAge: number): string {
    return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
}

export function setCookieHeader(name: string, payload: object, ttlSec: number): string {
    return `${name}=${signValue(`cookie:${name}`, payload, ttlSec)}; ${attributes(ttlSec)}`;
}

export function clearCookieHeader(name: string): string {
    return `${name}=; ${attributes(0)}`;
}

export function readCookie<T>(cookieHeader: string | undefined, name: string): T | null {
    if (!cookieHeader) {
        return null;
    }
    for (const part of cookieHeader.split(';')) {
        const index = part.indexOf('=');
        if (index > 0 && part.slice(0, index).trim() === name) {
            return verifyValue<T>(`cookie:${name}`, part.slice(index + 1).trim());
        }
    }
    return null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/browserCookies.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `exchangeCodes.ts` and `pages.ts`**

`packages/happy-server/sources/app/auth/oidc/exchangeCodes.ts`:

```ts
import { createHash } from 'crypto';
import { db } from '@/storage/db';
import { generateOpaqueToken, hashToken } from './accessTokens';

const EXCHANGE_CODE_TTL_MS = 60_000;

export async function createExchangeCode(input: {
    accountId: string;
    clientKind: 'web' | 'mobile';
    pkceChallenge: string;
}): Promise<string> {
    const code = generateOpaqueToken();
    await db.oidcExchangeCode.create({
        data: {
            codeHash: hashToken(code),
            accountId: input.accountId,
            clientKind: input.clientKind,
            pkceChallenge: input.pkceChallenge,
            expiresAt: new Date(Date.now() + EXCHANGE_CODE_TTL_MS),
        },
    });
    return code;
}

export async function redeemExchangeCode(
    code: string,
    codeVerifier: string,
): Promise<{ accountId: string; clientKind: 'web' | 'mobile' } | null> {
    const row = await db.oidcExchangeCode.findUnique({ where: { codeHash: hashToken(code) } });
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
        return null;
    }
    const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
    if (challenge !== row.pkceChallenge) {
        return null;
    }
    const claimed = await db.oidcExchangeCode.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) {
        return null;
    }
    return { accountId: row.accountId, clientKind: row.clientKind as 'web' | 'mobile' };
}
```

`packages/happy-server/sources/app/auth/oidc/pages.ts`:

```ts
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function page(title: string, body: string): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
input,button{font:inherit;padding:.5rem .75rem;margin:.25rem 0}
.code{font-family:ui-monospace,monospace;font-size:1.5rem;letter-spacing:.1em}
.error{color:#b00020}
</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

export function messagePage(title: string, message: string): string {
    return page(title, `<p>${escapeHtml(message)}</p>`);
}

export function enterCodePage(opts: { code?: string; error?: string }): string {
    const error = opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : '';
    return page('Connect a terminal', `${error}
<p>Enter the code shown in your terminal.</p>
<form method="get" action="/activate">
<input class="code" name="code" autocomplete="off" value="${escapeHtml(opts.code ?? '')}" placeholder="XXXX-XXXX">
<button type="submit">Continue</button>
</form>`);
}

export function confirmPage(opts: { userCode: string; host: string; os: string; cliVersion: string; csrf: string }): string {
    return page('Authorize terminal?', `
<p>A terminal is asking to sign in to your account.</p>
<p class="code">${escapeHtml(opts.userCode)}</p>
<ul>
<li>Host: <strong>${escapeHtml(opts.host)}</strong></li>
<li>OS: ${escapeHtml(opts.os)}</li>
<li>CLI version: ${escapeHtml(opts.cliVersion)}</li>
</ul>
<p>Only approve if this code matches your terminal and you started this sign-in.</p>
<form method="post" action="/activate">
<input type="hidden" name="code" value="${escapeHtml(opts.userCode)}">
<input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`);
}
```

- [ ] **Step 6: Create the route test kit**

Create `packages/happy-server/sources/testing/authTestKit.ts`:

```ts
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '@/app/api/types';
import type { AuthConfig } from '@/app/auth/oidc/authConfig';
import type { IdpRefreshResult, OidcClient, OidcIdentity } from '@/app/auth/oidc/oidcClient';
import { createTestDb } from './testDb';

export const TEST_ENV = {
    OIDC_ISSUER: 'https://idp.test',
    OIDC_CLIENT_ID: 'happy-server',
    OIDC_CLIENT_SECRET: 'secret',
    PUBLIC_URL: 'https://happy.test',
    WEBAPP_URL: 'https://app.test',
    MOBILE_REDIRECT_URIS: 'corpapp://auth/callback',
    HANDY_MASTER_SECRET: 'test-master-secret-that-is-long-enough-000',
};

export interface FakeOidc {
    client: OidcClient;
    queueIdentity(identity: OidcIdentity): void;
    setRefreshResult(result: IdpRefreshResult): void;
    readonly refreshCalls: number;
}

export function createFakeOidc(): FakeOidc {
    const identities: OidcIdentity[] = [];
    let refreshResult: IdpRefreshResult = { status: 'ok', refreshToken: null };
    let refreshCalls = 0;
    return {
        client: {
            async buildLoginUrl(params) {
                const url = new URL('https://idp.test/authorize');
                url.searchParams.set('state', params.state);
                return url;
            },
            async handleCallback(callbackUrl, params) {
                if (callbackUrl.searchParams.get('state') !== params.state) {
                    throw new Error('state mismatch');
                }
                const identity = identities.shift();
                if (!identity) {
                    throw new Error('no identity queued');
                }
                return identity;
            },
            async refresh() {
                refreshCalls++;
                return refreshResult;
            },
        },
        queueIdentity(identity) { identities.push(identity); },
        setRefreshResult(result) { refreshResult = result; },
        get refreshCalls() { return refreshCalls; },
    };
}

/** Test DB + encryption + token/cookie keys, all bound to TEST_ENV. */
export async function setupAuthTest(): Promise<{ db: PrismaClient; config: AuthConfig; fake: FakeOidc }> {
    Object.assign(process.env, TEST_ENV);
    const db = await createTestDb();
    await (await import('@/modules/encrypt')).initEncrypt();
    const { loadAuthConfig } = await import('@/app/auth/oidc/authConfig');
    const config = loadAuthConfig(TEST_ENV);
    (await import('@/app/auth/oidc/accessTokens')).initAccessTokens({ masterSecret: config.masterSecret, ttlSec: config.accessTokenTtlSec });
    (await import('@/app/auth/oidc/browserCookies')).initBrowserCookies({ masterSecret: config.masterSecret, secure: true });
    return { db, config, fake: createFakeOidc() };
}

export async function buildTestApp(register: (app: Fastify) => void): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    const { enableAuthentication } = await import('@/app/api/utils/enableAuthentication');
    enableAuthentication(typed);
    register(typed);
    await typed.ready();
    return typed;
}

/** Turns a response's Set-Cookie headers into a Cookie request header. */
export function cookieHeader(res: { headers: Record<string, unknown> }): string {
    const raw = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [raw as string] : [];
    return list.map((c) => String(c).split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
}
```

- [ ] **Step 7: Write the failing route test**

Create `packages/happy-server/sources/app/api/routes/oidcRoutes.spec.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '../types';
import { buildTestApp, cookieHeader, setupAuthTest, type FakeOidc } from '@/testing/authTestKit';
import type { AuthConfig } from '@/app/auth/oidc/authConfig';

let db: PrismaClient;
let config: AuthConfig;
let fake: FakeOidc;
let app: Fastify;
let keys: typeof import('@/app/auth/oidc/accountKeys');
let vault: typeof import('@/app/auth/oidc/keyVault');

beforeAll(async () => {
    ({ db, config, fake } = await setupAuthTest());
    keys = await import('@/app/auth/oidc/accountKeys');
    vault = await import('@/app/auth/oidc/keyVault');
    const { oidcRoutes } = await import('./oidcRoutes');
    app = await buildTestApp((a) => oidcRoutes(a, { config, oidc: fake.client, checkIdp: async () => true }));
});

function pkce() {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function login(query: string, subject: string) {
    fake.queueIdentity({ issuer: 'https://idp.test', subject, email: `${subject}@example.com`, name: 'Alice Example', refreshToken: null });
    const start = await app.inject({ method: 'GET', url: `/v1/auth/oidc/login?${query}` });
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location as string).searchParams.get('state');
    return app.inject({
        method: 'GET',
        url: `/v1/auth/oidc/callback?code=idp-code&state=${state}`,
        headers: { cookie: cookieHeader(start) },
    });
}

describe('oidcRoutes', () => {
    it('web: login → callback → exchange yields tokens and the root secret', async () => {
        const { verifier, challenge } = pkce();
        const callback = await login(`client=web&code_challenge=${challenge}`, 'r-web');
        expect(callback.statusCode).toBe(302);
        const location = callback.headers.location as string;
        expect(location.startsWith(`${config.webappUrl}/auth/callback#code=`)).toBe(true);
        const code = new URLSearchParams(location.split('#')[1]).get('code')!;

        const ephemeral = tweetnacl.box.keyPair();
        const exchange = await app.inject({
            method: 'POST',
            url: '/v1/auth/oidc/exchange',
            payload: { code, codeVerifier: verifier, ephemeralPublicKey: privacyKit.encodeBase64(ephemeral.publicKey) },
        });
        expect(exchange.statusCode).toBe(200);
        const body = exchange.json();
        expect(body).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String), accountId: expect.any(String) });

        const bundle = privacyKit.decodeBase64(body.keyBundle);
        const root = tweetnacl.box.open(bundle.slice(56), bundle.slice(32, 56), bundle.slice(0, 32), ephemeral.secretKey)!;
        const account = await db.account.findUniqueOrThrow({ where: { id: body.accountId } });
        expect(Buffer.from(root).equals(Buffer.from(vault.keyVault.unwrap(account.wrappedRootSecret!)))).toBe(true);
        expect(account.publicKey).toBe(keys.deriveAccountPublicKeyHex(root));
        const device = await db.device.findFirstOrThrow({ where: { accountId: body.accountId } });
        expect(device.kind).toBe('web');

        const replay = await app.inject({
            method: 'POST',
            url: '/v1/auth/oidc/exchange',
            payload: { code, codeVerifier: verifier, ephemeralPublicKey: privacyKit.encodeBase64(ephemeral.publicKey) },
        });
        expect(replay.statusCode).toBe(400);
        expect(replay.json()).toEqual({ error: 'invalid_grant' });
    });

    it('rejects an exchange with the wrong PKCE verifier', async () => {
        const { challenge } = pkce();
        const callback = await login(`client=web&code_challenge=${challenge}`, 'r-wrong-verifier');
        const code = new URLSearchParams((callback.headers.location as string).split('#')[1]).get('code')!;
        const exchange = await app.inject({
            method: 'POST',
            url: '/v1/auth/oidc/exchange',
            payload: { code, codeVerifier: pkce().verifier, ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(32)) },
        });
        expect(exchange.statusCode).toBe(400);
    });

    it('rejects a malformed ephemeral key', async () => {
        const exchange = await app.inject({
            method: 'POST',
            url: '/v1/auth/oidc/exchange',
            payload: { code: 'x', codeVerifier: 'y', ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(16)) },
        });
        expect(exchange.statusCode).toBe(400);
    });

    it('mobile: redirects to an allowed custom scheme with the code', async () => {
        const { challenge } = pkce();
        const callback = await login(
            `client=mobile&code_challenge=${challenge}&redirect_uri=${encodeURIComponent('corpapp://auth/callback')}`,
            'r-mobile',
        );
        expect(callback.statusCode).toBe(302);
        expect((callback.headers.location as string)).toMatch(/^corpapp:\/\/auth\/callback\?code=/);
    });

    it('mobile: rejects redirect URIs that are not configured', async () => {
        const { challenge } = pkce();
        const res = await app.inject({
            method: 'GET',
            url: `/v1/auth/oidc/login?client=mobile&code_challenge=${challenge}&redirect_uri=${encodeURIComponent('evil://steal')}`,
        });
        expect(res.statusCode).toBe(400);
    });

    it('web: requires a code challenge', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/auth/oidc/login?client=web' });
        expect(res.statusCode).toBe(400);
    });

    it('activate: sets a browser session and returns to /activate', async () => {
        const callback = await login('client=activate&user_code=BCDF-GHJK', 'r-activate');
        expect(callback.statusCode).toBe(302);
        expect(callback.headers.location).toBe('/activate?code=BCDF-GHJK');
        expect(cookieHeader(callback)).toContain('happy_session=');
    });

    it('rejects a callback without the login cookie', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/auth/oidc/callback?code=x&state=y' });
        expect(res.statusCode).toBe(400);
        expect(res.headers['content-type']).toContain('text/html');
    });

    it('does not forward IdP errors', async () => {
        const start = await app.inject({ method: 'GET', url: '/v1/auth/oidc/login?client=activate' });
        const res = await app.inject({
            method: 'GET',
            url: '/v1/auth/oidc/callback?error=access_denied&error_description=%3Cscript%3E',
            headers: { cookie: cookieHeader(start) },
        });
        expect(res.statusCode).toBe(400);
        expect(res.body).not.toContain('<script>');
    });

    it('refuses disabled accounts', async () => {
        const { challenge } = pkce();
        await login(`client=web&code_challenge=${challenge}`, 'r-disabled');
        await db.account.updateMany({ where: { oidcSubject: 'r-disabled' }, data: { disabledAt: new Date() } });
        const again = await login(`client=web&code_challenge=${challenge}`, 'r-disabled');
        expect(again.statusCode).toBe(403);
    });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `pnpm --filter happy-server exec vitest run sources/app/api/routes/oidcRoutes.spec.ts`
Expected: FAIL — cannot find `./oidcRoutes`.

- [ ] **Step 9: Implement `oidcRoutes.ts`**

Create `packages/happy-server/sources/app/api/routes/oidcRoutes.ts`:

```ts
import { z } from 'zod';
import * as privacyKit from 'privacy-kit';
import { type Fastify } from '../types';
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import type { AuthConfig } from '@/app/auth/oidc/authConfig';
import type { OidcClient, OidcLoginParams } from '@/app/auth/oidc/oidcClient';
import { newLoginParams } from '@/app/auth/oidc/oidcClient';
import { AccountDisabledError, provisionAccount } from '@/app/auth/oidc/provisioning';
import { boxForRecipient, decodeEphemeralPublicKey } from '@/app/auth/oidc/accountKeys';
import { keyVault } from '@/app/auth/oidc/keyVault';
import { createDevice } from '@/app/auth/oidc/devices';
import { createExchangeCode, redeemExchangeCode } from '@/app/auth/oidc/exchangeCodes';
import { LOGIN_COOKIE, SESSION_COOKIE, clearCookieHeader, readCookie, setCookieHeader } from '@/app/auth/oidc/browserCookies';
import { messagePage } from '@/app/auth/oidc/pages';

export interface AuthRouteDeps {
    config: AuthConfig;
    oidc: OidcClient;
    checkIdp: (accountId: string) => Promise<boolean>;
}

export type LoginTarget =
    | { kind: 'web'; appChallenge: string }
    | { kind: 'mobile'; appChallenge: string; redirectUri: string }
    | { kind: 'activate'; userCode: string | null };

interface LoginCookie extends OidcLoginParams {
    target: LoginTarget;
}

const LOGIN_COOKIE_TTL_SEC = 600;
export const SESSION_COOKIE_TTL_SEC = 600;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

export function oidcRoutes(app: Fastify, deps: AuthRouteDeps) {
    const { config, oidc } = deps;

    app.get('/v1/auth/oidc/login', {
        schema: {
            querystring: z.object({
                client: z.enum(['web', 'mobile', 'activate']),
                code_challenge: z.string().optional(),
                redirect_uri: z.string().optional(),
                user_code: z.string().max(16).optional(),
            }),
        },
    }, async (request, reply) => {
        const query = request.query;
        let target: LoginTarget;
        if (query.client === 'activate') {
            target = { kind: 'activate', userCode: query.user_code ?? null };
        } else {
            if (!query.code_challenge || !PKCE_CHALLENGE.test(query.code_challenge)) {
                return reply.code(400).send({ error: 'code_challenge is required' });
            }
            if (query.client === 'mobile') {
                if (!query.redirect_uri || !config.mobileRedirectUris.includes(query.redirect_uri)) {
                    return reply.code(400).send({ error: 'redirect_uri is not allowed' });
                }
                target = { kind: 'mobile', appChallenge: query.code_challenge, redirectUri: query.redirect_uri };
            } else {
                target = { kind: 'web', appChallenge: query.code_challenge };
            }
        }

        const params = newLoginParams();
        const loginUrl = await oidc.buildLoginUrl(params);
        const cookie: LoginCookie = { ...params, target };
        reply.header('set-cookie', setCookieHeader(LOGIN_COOKIE, cookie, LOGIN_COOKIE_TTL_SEC));
        return reply.redirect(loginUrl.toString());
    });

    app.get('/v1/auth/oidc/callback', async (request, reply) => {
        const html = (code: number, title: string, message: string) =>
            reply.code(code).type('text/html').header('set-cookie', clearCookieHeader(LOGIN_COOKIE)).send(messagePage(title, message));

        const login = readCookie<LoginCookie>(request.headers.cookie, LOGIN_COOKIE);
        if (!login) {
            return html(400, 'Sign-in expired', 'Your sign-in took too long or was started in another browser. Please start again.');
        }
        const rawQuery = (request.raw.url ?? '').split('?')[1] ?? '';
        if (new URLSearchParams(rawQuery).has('error')) {
            return html(400, 'Sign-in failed', 'Your identity provider did not complete the sign-in. Please try again.');
        }

        let accountId: string;
        try {
            const identity = await oidc.handleCallback(new URL(`${config.publicUrl}/v1/auth/oidc/callback?${rawQuery}`), login);
            ({ accountId } = await provisionAccount(identity));
        } catch (error) {
            if (error instanceof AccountDisabledError) {
                return html(403, 'Account disabled', 'Your account has been disabled. Contact your administrator.');
            }
            log({ module: 'auth', level: 'warn' }, `OIDC callback failed: ${error instanceof Error ? error.message : String(error)}`);
            return html(400, 'Sign-in failed', 'We could not verify your sign-in. Please try again.');
        }

        const target = login.target;
        if (target.kind === 'activate') {
            reply.header('set-cookie', [
                clearCookieHeader(LOGIN_COOKIE),
                setCookieHeader(SESSION_COOKIE, { accountId }, SESSION_COOKIE_TTL_SEC),
            ]);
            return reply.redirect(target.userCode ? `/activate?code=${encodeURIComponent(target.userCode)}` : '/activate');
        }

        const code = await createExchangeCode({ accountId, clientKind: target.kind, pkceChallenge: target.appChallenge });
        reply.header('set-cookie', clearCookieHeader(LOGIN_COOKIE));
        if (target.kind === 'mobile') {
            return reply.redirect(`${target.redirectUri}?code=${encodeURIComponent(code)}`);
        }
        return reply.redirect(`${config.webappUrl}/auth/callback#code=${encodeURIComponent(code)}`);
    });

    app.post('/v1/auth/oidc/exchange', {
        schema: {
            body: z.object({
                code: z.string().max(256),
                codeVerifier: z.string().max(256),
                ephemeralPublicKey: z.string().max(128),
                deviceName: z.string().max(100).optional(),
            }),
        },
    }, async (request, reply) => {
        const ephemeral = decodeEphemeralPublicKey(request.body.ephemeralPublicKey);
        if (!ephemeral) {
            return reply.code(400).send({ error: 'invalid_request' });
        }
        const redeemed = await redeemExchangeCode(request.body.code, request.body.codeVerifier);
        if (!redeemed) {
            return reply.code(400).send({ error: 'invalid_grant' });
        }
        const account = await db.account.findUniqueOrThrow({ where: { id: redeemed.accountId } });
        let rootSecret: Uint8Array;
        try {
            rootSecret = keyVault.unwrap(account.wrappedRootSecret!);
        } catch {
            log({ module: 'auth', level: 'error' }, `ALERT: cannot unwrap root secret for account ${account.id}`);
            return reply.code(500).send({ error: 'server_error' });
        }
        const device = await createDevice({
            accountId: account.id,
            kind: redeemed.clientKind,
            name: request.body.deviceName ?? redeemed.clientKind,
        });
        return reply.send({
            accountId: account.id,
            accessToken: device.accessToken,
            refreshToken: device.refreshToken,
            keyBundle: privacyKit.encodeBase64(boxForRecipient(rootSecret, ephemeral)),
        });
    });
}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `pnpm --filter happy-server exec vitest run sources/app/api/routes/oidcRoutes.spec.ts sources/app/auth/oidc/browserCookies.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/happy-server/sources/app/auth/oidc packages/happy-server/sources/app/api/routes/oidcRoutes* \
  packages/happy-server/sources/testing/authTestKit.ts
git commit -m "feat: add OIDC login, callback and code exchange routes"
```

---

### Task 10: CLI device flow and /activate pages

**Files:**
- Create: `packages/happy-server/sources/app/auth/oidc/deviceAuth.ts`
- Create: `packages/happy-server/sources/app/api/routes/deviceAuthRoutes.ts`
- Test: `packages/happy-server/sources/app/auth/oidc/deviceAuth.test.ts`
- Test: `packages/happy-server/sources/app/api/routes/deviceAuthRoutes.spec.ts`

**Interfaces:**
- Consumes: `AuthRouteDeps` (Task 9); `readCookie`, `SESSION_COOKIE`, `signValue`, `verifyValue` (Task 9); `enterCodePage`, `confirmPage`, `messagePage` (Task 9); `createDevice` (Task 6); `keyVault` (Task 4); `boxForRecipient`, `cliKeyBundlePlaintext`, `decodeEphemeralPublicKey` (Task 4); `generateOpaqueToken`, `hashToken` (Task 5).
- Produces (`deviceAuth.ts`):
  ```ts
  const DEVICE_CODE_TTL_SEC = 600; const POLL_INTERVAL_SEC = 5
  interface ClientInfo { host: string; os: string; cliVersion: string }
  function generateUserCode(): string                 // "XXXX-XXXX"
  function normalizeUserCode(input: string): string | null
  function startDeviceAuth(input: { ephemeralPublicKey: string; clientInfo: ClientInfo }): Promise<{ deviceCode: string; userCode: string }>
  function findPendingRequest(userCode: string): Promise<{ userCode: string; clientInfo: ClientInfo } | null>
  function decideDeviceAuth(userCode: string, accountId: string, decision: 'approve' | 'deny'): Promise<boolean>
  type PollResult = { status: 'pending' | 'slow_down' | 'expired' | 'denied' | 'invalid' } | { status: 'approved'; accountId: string; ephemeralPublicKey: string; clientInfo: ClientInfo }
  function pollDeviceAuth(deviceCode: string, now?: Date): Promise<PollResult>
  ```
- Produces (`deviceAuthRoutes.ts`): `deviceAuthRoutes(app: Fastify, deps: AuthRouteDeps): void` with `POST /v1/auth/device/start`, `POST /v1/auth/device/token`, `GET /activate`, `POST /activate`.

- [ ] **Step 1: Write the failing state-machine test**

Create `packages/happy-server/sources/app/auth/oidc/deviceAuth.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb } from '@/testing/testDb';

let db: PrismaClient;
let flow: typeof import('./deviceAuth');
let accountId: string;
const clientInfo = { host: 'dev-42', os: 'linux', cliVersion: '1.2.5' };

beforeAll(async () => {
    db = await createTestDb();
    flow = await import('./deviceAuth');
    accountId = (await db.account.create({ data: { publicKey: 'pk-device-auth' } })).id;
});

describe('user codes', () => {
    it('uses the unambiguous alphabet in XXXX-XXXX form', () => {
        for (let i = 0; i < 50; i++) {
            expect(flow.generateUserCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
        }
    });

    it('normalizes user input', () => {
        expect(flow.normalizeUserCode(' bcdf ghjk ')).toBe('BCDF-GHJK');
        expect(flow.normalizeUserCode('bcdf-ghjk')).toBe('BCDF-GHJK');
        expect(flow.normalizeUserCode('bcd')).toBeNull();
    });
});

describe('device flow', () => {
    it('pending → approved → consumed', async () => {
        const { deviceCode, userCode } = await flow.startDeviceAuth({ ephemeralPublicKey: 'eph', clientInfo });
        const t0 = new Date();
        expect(await flow.pollDeviceAuth(deviceCode, t0)).toEqual({ status: 'pending' });
        expect(await flow.findPendingRequest(userCode)).toEqual({ userCode, clientInfo });
        expect(await flow.decideDeviceAuth(userCode, accountId, 'approve')).toBe(true);
        const t1 = new Date(t0.getTime() + 6000);
        expect(await flow.pollDeviceAuth(deviceCode, t1)).toEqual({ status: 'approved', accountId, ephemeralPublicKey: 'eph', clientInfo });
        const t2 = new Date(t1.getTime() + 6000);
        expect(await flow.pollDeviceAuth(deviceCode, t2)).toEqual({ status: 'invalid' });
    });

    it('asks fast pollers to slow down', async () => {
        const { deviceCode } = await flow.startDeviceAuth({ ephemeralPublicKey: 'eph', clientInfo });
        const t0 = new Date();
        expect((await flow.pollDeviceAuth(deviceCode, t0)).status).toBe('pending');
        expect((await flow.pollDeviceAuth(deviceCode, new Date(t0.getTime() + 1000))).status).toBe('slow_down');
    });

    it('reports denial', async () => {
        const { deviceCode, userCode } = await flow.startDeviceAuth({ ephemeralPublicKey: 'eph', clientInfo });
        expect(await flow.decideDeviceAuth(userCode, accountId, 'deny')).toBe(true);
        expect((await flow.pollDeviceAuth(deviceCode)).status).toBe('denied');
    });

    it('can only be decided once', async () => {
        const { userCode } = await flow.startDeviceAuth({ ephemeralPublicKey: 'eph', clientInfo });
        expect(await flow.decideDeviceAuth(userCode, accountId, 'approve')).toBe(true);
        expect(await flow.decideDeviceAuth(userCode, accountId, 'deny')).toBe(false);
        expect(await flow.findPendingRequest(userCode)).toBeNull();
    });

    it('expires after the TTL', async () => {
        const { deviceCode, userCode } = await flow.startDeviceAuth({ ephemeralPublicKey: 'eph', clientInfo });
        const later = new Date(Date.now() + (flow.DEVICE_CODE_TTL_SEC + 1) * 1000);
        expect((await flow.pollDeviceAuth(deviceCode, later)).status).toBe('expired');
        await db.deviceAuthRequest.updateMany({ where: { userCode }, data: { expiresAt: new Date(Date.now() - 1000) } });
        expect(await flow.decideDeviceAuth(userCode, accountId, 'approve')).toBe(false);
    });

    it('rejects unknown device codes', async () => {
        expect((await flow.pollDeviceAuth('unknown')).status).toBe('invalid');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/deviceAuth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `deviceAuth.ts`**

```ts
import { randomInt } from 'crypto';
import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { generateOpaqueToken, hashToken } from './accessTokens';

export const DEVICE_CODE_TTL_SEC = 600;
export const POLL_INTERVAL_SEC = 5;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

export interface ClientInfo {
    host: string;
    os: string;
    cliVersion: string;
}

export type PollResult =
    | { status: 'pending' | 'slow_down' | 'expired' | 'denied' | 'invalid' }
    | { status: 'approved'; accountId: string; ephemeralPublicKey: string; clientInfo: ClientInfo };

export function generateUserCode(): string {
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
    }
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizeUserCode(input: string): string | null {
    const letters = input.toUpperCase().replace(/[^A-Z]/g, '');
    return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : null;
}

export async function startDeviceAuth(input: {
    ephemeralPublicKey: string;
    clientInfo: ClientInfo;
}): Promise<{ deviceCode: string; userCode: string }> {
    // Keep the unique userCode space small by removing long-expired requests.
    await db.deviceAuthRequest.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 3600_000) } } });
    const deviceCode = generateOpaqueToken();
    for (let attempt = 0; attempt < 5; attempt++) {
        const userCode = generateUserCode();
        try {
            await db.deviceAuthRequest.create({
                data: {
                    deviceCodeHash: hashToken(deviceCode),
                    userCode,
                    ephemeralPublicKey: input.ephemeralPublicKey,
                    clientInfo: { ...input.clientInfo },
                    expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_SEC * 1000),
                },
            });
            return { deviceCode, userCode };
        } catch (error) {
            if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
                throw error;
            }
        }
    }
    throw new Error('Could not allocate a unique user code');
}

export async function findPendingRequest(userCode: string): Promise<{ userCode: string; clientInfo: ClientInfo } | null> {
    const row = await db.deviceAuthRequest.findUnique({ where: { userCode } });
    if (!row || row.status !== 'pending' || row.expiresAt.getTime() < Date.now()) {
        return null;
    }
    return { userCode: row.userCode, clientInfo: row.clientInfo as unknown as ClientInfo };
}

export async function decideDeviceAuth(userCode: string, accountId: string, decision: 'approve' | 'deny'): Promise<boolean> {
    const updated = await db.deviceAuthRequest.updateMany({
        where: { userCode, status: 'pending', expiresAt: { gt: new Date() } },
        data: decision === 'approve'
            ? { status: 'approved', approvedAccountId: accountId }
            : { status: 'denied' },
    });
    return updated.count === 1;
}

export async function pollDeviceAuth(deviceCode: string, now: Date = new Date()): Promise<PollResult> {
    const row = await db.deviceAuthRequest.findUnique({ where: { deviceCodeHash: hashToken(deviceCode) } });
    if (!row || row.status === 'consumed') {
        return { status: 'invalid' };
    }
    if (row.expiresAt.getTime() < now.getTime()) {
        return { status: 'expired' };
    }
    if (row.status === 'denied') {
        return { status: 'denied' };
    }
    const tooFast = row.lastPolledAt && now.getTime() - row.lastPolledAt.getTime() < POLL_INTERVAL_SEC * 1000;
    await db.deviceAuthRequest.update({ where: { id: row.id }, data: { lastPolledAt: now } });
    if (tooFast) {
        return { status: 'slow_down' };
    }
    if (row.status === 'pending') {
        return { status: 'pending' };
    }
    const claimed = await db.deviceAuthRequest.updateMany({
        where: { id: row.id, status: 'approved' },
        data: { status: 'consumed' },
    });
    if (claimed.count !== 1 || !row.approvedAccountId) {
        return { status: 'invalid' };
    }
    return {
        status: 'approved',
        accountId: row.approvedAccountId,
        ephemeralPublicKey: row.ephemeralPublicKey,
        clientInfo: row.clientInfo as unknown as ClientInfo,
    };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter happy-server exec vitest run sources/app/auth/oidc/deviceAuth.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

Create `packages/happy-server/sources/app/api/routes/deviceAuthRoutes.spec.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '../types';
import { buildTestApp, cookieHeader, setupAuthTest, type FakeOidc } from '@/testing/authTestKit';
import type { AuthConfig } from '@/app/auth/oidc/authConfig';

let db: PrismaClient;
let config: AuthConfig;
let fake: FakeOidc;
let app: Fastify;
let keys: typeof import('@/app/auth/oidc/accountKeys');
let vault: typeof import('@/app/auth/oidc/keyVault');

const clientInfo = { host: 'dev-42', os: 'linux', cliVersion: '1.2.5' };

beforeAll(async () => {
    ({ db, config, fake } = await setupAuthTest());
    keys = await import('@/app/auth/oidc/accountKeys');
    vault = await import('@/app/auth/oidc/keyVault');
    const { oidcRoutes } = await import('./oidcRoutes');
    const { deviceAuthRoutes } = await import('./deviceAuthRoutes');
    const deps = { config, oidc: fake.client, checkIdp: async () => true };
    app = await buildTestApp((a) => { oidcRoutes(a, deps); deviceAuthRoutes(a, deps); });
});

async function startFlow() {
    const ephemeral = tweetnacl.box.keyPair();
    const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/device/start',
        payload: { ephemeralPublicKey: privacyKit.encodeBase64(ephemeral.publicKey), clientInfo },
    });
    expect(res.statusCode).toBe(200);
    return { ephemeral, ...res.json() };
}

/** Browser: /activate → OIDC login → back to /activate with a session cookie. */
async function browserSession(userCode: string, subject: string) {
    const first = await app.inject({ method: 'GET', url: `/activate?code=${userCode}` });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe(`/v1/auth/oidc/login?client=activate&user_code=${userCode}`);
    fake.queueIdentity({ issuer: 'https://idp.test', subject, email: null, name: null, refreshToken: null });
    const login = await app.inject({ method: 'GET', url: first.headers.location as string });
    const state = new URL(login.headers.location as string).searchParams.get('state');
    const callback = await app.inject({
        method: 'GET',
        url: `/v1/auth/oidc/callback?code=c&state=${state}`,
        headers: { cookie: cookieHeader(login) },
    });
    return cookieHeader(callback);
}

function csrfFrom(html: string): string {
    return /name="csrf" value="([^"]+)"/.exec(html)![1];
}

function form(fields: Record<string, string>) {
    return { 'content-type': 'application/x-www-form-urlencoded', payload: new URLSearchParams(fields).toString() };
}

describe('deviceAuthRoutes', () => {
    it('full flow: start → activate → approve → token', async () => {
        const started = await startFlow();
        expect(started).toMatchObject({
            verifyUrl: `${config.publicUrl}/activate`,
            verifyUrlComplete: `${config.publicUrl}/activate?code=${started.userCode}`,
            interval: 5,
            expiresIn: 600,
        });

        const pending = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode: started.deviceCode } });
        expect(pending.statusCode).toBe(400);
        expect(pending.json()).toEqual({ error: 'authorization_pending' });

        const cookie = await browserSession(started.userCode, 'd-alice');
        const confirm = await app.inject({ method: 'GET', url: `/activate?code=${started.userCode}`, headers: { cookie } });
        expect(confirm.statusCode).toBe(200);
        expect(confirm.body).toContain('dev-42');
        expect(confirm.body).toContain(started.userCode);

        const { payload, ...headers } = form({ code: started.userCode, csrf: csrfFrom(confirm.body), decision: 'approve' });
        const decided = await app.inject({ method: 'POST', url: '/activate', headers: { ...headers, cookie }, payload });
        expect(decided.statusCode).toBe(200);
        expect(decided.body).toContain('Return to your terminal');

        await db.deviceAuthRequest.updateMany({ where: { userCode: started.userCode }, data: { lastPolledAt: null } });
        const token = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode: started.deviceCode } });
        expect(token.statusCode).toBe(200);
        const body = token.json();

        const bundle = privacyKit.decodeBase64(body.keyBundle);
        const opened = tweetnacl.box.open(bundle.slice(56), bundle.slice(32, 56), bundle.slice(0, 32), started.ephemeral.secretKey)!;
        const account = await db.account.findUniqueOrThrow({ where: { id: body.accountId } });
        const root = vault.keyVault.unwrap(account.wrappedRootSecret!);
        expect(Buffer.from(opened).equals(Buffer.from(keys.cliKeyBundlePlaintext(root)))).toBe(true);

        const device = await db.device.findFirstOrThrow({ where: { accountId: body.accountId, kind: 'cli' } });
        expect(device).toMatchObject({ name: 'dev-42', host: 'dev-42' });
    });

    it('maps denial and bad codes to RFC 8628 errors', async () => {
        const started = await startFlow();
        const cookie = await browserSession(started.userCode, 'd-bob');
        const confirm = await app.inject({ method: 'GET', url: `/activate?code=${started.userCode}`, headers: { cookie } });
        const { payload, ...headers } = form({ code: started.userCode, csrf: csrfFrom(confirm.body), decision: 'deny' });
        await app.inject({ method: 'POST', url: '/activate', headers: { ...headers, cookie }, payload });
        const denied = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode: started.deviceCode } });
        expect(denied.json()).toEqual({ error: 'access_denied' });

        const unknown = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode: 'nope' } });
        expect(unknown.json()).toEqual({ error: 'invalid_grant' });
    });

    it('rejects a decision with a CSRF token for another code', async () => {
        const a = await startFlow();
        const b = await startFlow();
        const cookie = await browserSession(a.userCode, 'd-carol');
        const confirmA = await app.inject({ method: 'GET', url: `/activate?code=${a.userCode}`, headers: { cookie } });
        const { payload, ...headers } = form({ code: b.userCode, csrf: csrfFrom(confirmA.body), decision: 'approve' });
        const res = await app.inject({ method: 'POST', url: '/activate', headers: { ...headers, cookie }, payload });
        expect(res.statusCode).toBe(403);
    });

    it('rejects a decision without a browser session', async () => {
        const started = await startFlow();
        const { payload, ...headers } = form({ code: started.userCode, csrf: 'x', decision: 'approve' });
        const res = await app.inject({ method: 'POST', url: '/activate', headers, payload });
        expect(res.statusCode).toBe(401);
    });

    it('shows the code entry page for unknown codes', async () => {
        const cookie = await browserSession('ZZZZ-ZZZZ', 'd-dave');
        const res = await app.inject({ method: 'GET', url: '/activate?code=ZZZZ-ZZZZ', headers: { cookie } });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('not found or expired');
    });

    it('rejects malformed ephemeral keys', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/auth/device/start',
            payload: { ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(8)), clientInfo },
        });
        expect(res.statusCode).toBe(400);
    });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter happy-server exec vitest run sources/app/api/routes/deviceAuthRoutes.spec.ts`
Expected: FAIL — cannot find `./deviceAuthRoutes`.

- [ ] **Step 7: Implement `deviceAuthRoutes.ts`**

```ts
import { z } from 'zod';
import * as privacyKit from 'privacy-kit';
import { type Fastify } from '../types';
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import type { AuthRouteDeps } from './oidcRoutes';
import { boxForRecipient, cliKeyBundlePlaintext, decodeEphemeralPublicKey } from '@/app/auth/oidc/accountKeys';
import { keyVault } from '@/app/auth/oidc/keyVault';
import { createDevice } from '@/app/auth/oidc/devices';
import {
    DEVICE_CODE_TTL_SEC, POLL_INTERVAL_SEC,
    decideDeviceAuth, findPendingRequest, normalizeUserCode, pollDeviceAuth, startDeviceAuth,
} from '@/app/auth/oidc/deviceAuth';
import { SESSION_COOKIE, readCookie, signValue, verifyValue } from '@/app/auth/oidc/browserCookies';
import { confirmPage, enterCodePage, messagePage } from '@/app/auth/oidc/pages';

const CSRF_PURPOSE = 'activate-csrf';

export function deviceAuthRoutes(app: Fastify, deps: AuthRouteDeps) {
    const { config } = deps;

    // Browsers post the approval form as application/x-www-form-urlencoded.
    if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
        app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
            done(null, Object.fromEntries(new URLSearchParams(body as string)));
        });
    }

    app.post('/v1/auth/device/start', {
        schema: {
            body: z.object({
                ephemeralPublicKey: z.string().max(128),
                clientInfo: z.object({
                    host: z.string().min(1).max(255),
                    os: z.string().max(64),
                    cliVersion: z.string().max(64),
                }),
            }),
        },
    }, async (request, reply) => {
        if (!decodeEphemeralPublicKey(request.body.ephemeralPublicKey)) {
            return reply.code(400).send({ error: 'invalid_request' });
        }
        const { deviceCode, userCode } = await startDeviceAuth(request.body);
        return reply.send({
            deviceCode,
            userCode,
            verifyUrl: `${config.publicUrl}/activate`,
            verifyUrlComplete: `${config.publicUrl}/activate?code=${userCode}`,
            interval: POLL_INTERVAL_SEC,
            expiresIn: DEVICE_CODE_TTL_SEC,
        });
    });

    app.post('/v1/auth/device/token', {
        schema: { body: z.object({ deviceCode: z.string().max(256) }) },
    }, async (request, reply) => {
        const result = await pollDeviceAuth(request.body.deviceCode);
        switch (result.status) {
            case 'pending': return reply.code(400).send({ error: 'authorization_pending' });
            case 'slow_down': return reply.code(400).send({ error: 'slow_down' });
            case 'expired': return reply.code(400).send({ error: 'expired_token' });
            case 'denied': return reply.code(400).send({ error: 'access_denied' });
            case 'invalid': return reply.code(400).send({ error: 'invalid_grant' });
        }
        const account = await db.account.findUniqueOrThrow({ where: { id: result.accountId } });
        let rootSecret: Uint8Array;
        try {
            rootSecret = keyVault.unwrap(account.wrappedRootSecret!);
        } catch {
            log({ module: 'auth', level: 'error' }, `ALERT: cannot unwrap root secret for account ${account.id}`);
            return reply.code(500).send({ error: 'server_error' });
        }
        const device = await createDevice({
            accountId: account.id,
            kind: 'cli',
            name: result.clientInfo.host,
            host: result.clientInfo.host,
        });
        const ephemeral = decodeEphemeralPublicKey(result.ephemeralPublicKey)!;
        return reply.send({
            accountId: account.id,
            accessToken: device.accessToken,
            refreshToken: device.refreshToken,
            keyBundle: privacyKit.encodeBase64(boxForRecipient(cliKeyBundlePlaintext(rootSecret), ephemeral)),
        });
    });

    app.get('/activate', {
        schema: { querystring: z.object({ code: z.string().max(32).optional() }) },
    }, async (request, reply) => {
        const session = readCookie<{ accountId: string }>(request.headers.cookie, SESSION_COOKIE);
        const rawCode = request.query.code;
        if (!session) {
            const next = rawCode ? `&user_code=${encodeURIComponent(rawCode)}` : '';
            return reply.redirect(`/v1/auth/oidc/login?client=activate${next}`);
        }
        reply.type('text/html');
        if (!rawCode) {
            return reply.send(enterCodePage({}));
        }
        const userCode = normalizeUserCode(rawCode);
        const pending = userCode ? await findPendingRequest(userCode) : null;
        if (!pending) {
            return reply.send(enterCodePage({ code: rawCode, error: 'Code not found or expired. Check your terminal and try again.' }));
        }
        const csrf = signValue(CSRF_PURPOSE, { accountId: session.accountId, userCode: pending.userCode }, 600);
        return reply.send(confirmPage({ userCode: pending.userCode, ...pending.clientInfo, csrf }));
    });

    app.post('/activate', {
        schema: {
            body: z.object({
                code: z.string().max(32),
                csrf: z.string().max(2048),
                decision: z.enum(['approve', 'deny']),
            }),
        },
    }, async (request, reply) => {
        reply.type('text/html');
        const session = readCookie<{ accountId: string }>(request.headers.cookie, SESSION_COOKIE);
        if (!session) {
            return reply.code(401).send(messagePage('Sign-in expired', 'Please open the link from your terminal again.'));
        }
        const csrf = verifyValue<{ accountId: string; userCode: string }>(CSRF_PURPOSE, request.body.csrf);
        if (!csrf || csrf.accountId !== session.accountId || csrf.userCode !== request.body.code) {
            return reply.code(403).send(messagePage('Request rejected', 'This approval form is no longer valid. Please start again.'));
        }
        const ok = await decideDeviceAuth(request.body.code, session.accountId, request.body.decision);
        if (!ok) {
            return reply.send(messagePage('Code expired', 'This code has expired or was already used. Run the login command again.'));
        }
        return request.body.decision === 'approve'
            ? reply.send(messagePage('Terminal authorized', 'Return to your terminal to continue.'))
            : reply.send(messagePage('Request denied', 'The terminal was not signed in.'));
    });
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter happy-server exec vitest run sources/app/api/routes/deviceAuthRoutes.spec.ts sources/app/auth/oidc/deviceAuth.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/happy-server/sources/app/auth/oidc/deviceAuth*.ts packages/happy-server/sources/app/api/routes/deviceAuthRoutes*
git commit -m "feat: add server-brokered CLI device login and activation pages"
```

---

### Task 11: Refresh and logout routes

**Files:**
- Create: `packages/happy-server/sources/app/api/routes/tokenRoutes.ts`
- Test: `packages/happy-server/sources/app/api/routes/tokenRoutes.spec.ts`

**Interfaces:**
- Consumes: `AuthRouteDeps` (Task 9), `refreshDevice`, `revokeDevice`, `createDevice` (Task 6), `app.authenticate` setting `request.deviceId` (Task 5).
- Produces: `tokenRoutes(app: Fastify, deps: AuthRouteDeps): void` with `POST /v1/auth/refresh` → `200 { accessToken, refreshToken }` or `401 { error: 'invalid_grant', reason: RefreshFailure }`; `POST /v1/auth/logout` (authenticated) → `200 { success: true }`.

- [ ] **Step 1: Write the failing test**

Create `packages/happy-server/sources/app/api/routes/tokenRoutes.spec.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '../types';
import { buildTestApp, setupAuthTest } from '@/testing/authTestKit';

let db: PrismaClient;
let app: Fastify;
let devices: typeof import('@/app/auth/oidc/devices');
let idpAllowed = true;

beforeAll(async () => {
    const setup = await setupAuthTest();
    db = setup.db;
    devices = await import('@/app/auth/oidc/devices');
    const { tokenRoutes } = await import('./tokenRoutes');
    app = await buildTestApp((a) => {
        a.get('/whoami', { preHandler: a.authenticate }, async (request) => ({ userId: request.userId, deviceId: request.deviceId }));
        tokenRoutes(a, { config: setup.config, oidc: setup.fake.client, checkIdp: async () => idpAllowed });
    });
});

let n = 0;
async function newDevice() {
    n++;
    const account = await db.account.create({ data: { publicKey: `pk-token-${n}` } });
    return { accountId: account.id, ...(await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'x' })) };
}

describe('tokenRoutes', () => {
    it('refreshes tokens', async () => {
        const d = await newDevice();
        const res = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: d.refreshToken } });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        const who = await app.inject({ method: 'GET', url: '/whoami', headers: { authorization: `Bearer ${body.accessToken}` } });
        expect(who.json()).toEqual({ userId: d.accountId, deviceId: d.deviceId });
    });

    it('returns 401 invalid_grant with a reason', async () => {
        const res = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: 'nope' } });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: 'invalid_grant', reason: 'invalid' });
    });

    it('applies the IdP check', async () => {
        const d = await newDevice();
        idpAllowed = false;
        try {
            const res = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: d.refreshToken } });
            expect(res.json()).toEqual({ error: 'invalid_grant', reason: 'disabled' });
        } finally {
            idpAllowed = true;
        }
    });

    it('logout revokes the calling device', async () => {
        const d = await newDevice();
        const res = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${d.accessToken}` } });
        expect(res.statusCode).toBe(200);
        const refresh = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: d.refreshToken } });
        expect(refresh.json()).toEqual({ error: 'invalid_grant', reason: 'revoked' });
    });

    it('logout requires authentication', async () => {
        const res = await app.inject({ method: 'POST', url: '/v1/auth/logout' });
        expect(res.statusCode).toBe(401);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter happy-server exec vitest run sources/app/api/routes/tokenRoutes.spec.ts`
Expected: FAIL — cannot find `./tokenRoutes`.

- [ ] **Step 3: Implement `tokenRoutes.ts`**

```ts
import { z } from 'zod';
import { type Fastify } from '../types';
import type { AuthRouteDeps } from './oidcRoutes';
import { refreshDevice, revokeDevice } from '@/app/auth/oidc/devices';

export function tokenRoutes(app: Fastify, deps: AuthRouteDeps) {
    app.post('/v1/auth/refresh', {
        schema: { body: z.object({ refreshToken: z.string().max(256) }) },
    }, async (request, reply) => {
        const result = await refreshDevice(request.body.refreshToken, {
            maxSessionAgeSec: deps.config.maxSessionAgeSec,
            checkIdp: deps.checkIdp,
        });
        if (!result.ok) {
            return reply.code(401).send({ error: 'invalid_grant', reason: result.reason });
        }
        return reply.send(result.tokens);
    });

    app.post('/v1/auth/logout', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        await revokeDevice(request.deviceId);
        return reply.send({ success: true });
    });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter happy-server exec vitest run sources/app/api/routes/tokenRoutes.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-server/sources/app/api/routes/tokenRoutes*
git commit -m "feat: add token refresh and logout routes"
```

---

### Task 12: Runtime wiring and legacy auth removal

**Files:**
- Create: `packages/happy-server/sources/app/auth/oidc/oidcRuntime.ts`
- Modify: `packages/happy-server/sources/app/api/api.ts`
- Modify: `packages/happy-server/sources/main.ts`
- Modify: `packages/happy-server/sources/index.ts`
- Delete: `packages/happy-server/sources/app/api/routes/authRoutes.ts`

**Interfaces:**
- Produces:
  ```ts
  interface OidcRuntime extends AuthRouteDeps {}
  function initOidcAuth(env?: NodeJS.ProcessEnv): Promise<OidcRuntime>   // requires initEncrypt() first
  function getOidcRuntime(): OidcRuntime
  ```

- [ ] **Step 1: Implement `oidcRuntime.ts`**

```ts
import type { AuthRouteDeps } from '@/app/api/routes/oidcRoutes';
import { log } from '@/utils/log';
import { loadAuthConfig } from './authConfig';
import { initAccessTokens } from './accessTokens';
import { initBrowserCookies } from './browserCookies';
import { createOidcClient } from './oidcClient';
import { createIdpCheck } from './idpCheck';

export type OidcRuntime = AuthRouteDeps;

let runtime: OidcRuntime | null = null;

/** Loads config, initializes token/cookie keys and discovers the IdP. Call after initEncrypt(). */
export async function initOidcAuth(env: NodeJS.ProcessEnv = process.env): Promise<OidcRuntime> {
    const config = loadAuthConfig(env);
    initAccessTokens({ masterSecret: config.masterSecret, ttlSec: config.accessTokenTtlSec });
    initBrowserCookies({ masterSecret: config.masterSecret, secure: config.publicUrl.startsWith('https://') });
    const oidc = await createOidcClient(
        {
            issuer: config.issuer,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            scopes: config.scopes,
            redirectUri: `${config.publicUrl}/v1/auth/oidc/callback`,
        },
        { allowInsecureRequests: config.allowInsecureIssuer },
    );
    runtime = { config, oidc, checkIdp: createIdpCheck({ oidc }) };
    log({ module: 'auth' }, `OIDC auth ready (issuer ${config.issuer})`);
    return runtime;
}

export function getOidcRuntime(): OidcRuntime {
    if (!runtime) {
        throw new Error('OIDC auth not initialized');
    }
    return runtime;
}
```

- [ ] **Step 2: Wire routes in `api.ts`**

In `packages/happy-server/sources/app/api/api.ts`:
1. Replace `import { authRoutes } from "./routes/authRoutes";` with:

```ts
import { oidcRoutes } from "./routes/oidcRoutes";
import { deviceAuthRoutes } from "./routes/deviceAuthRoutes";
import { tokenRoutes } from "./routes/tokenRoutes";
import { getOidcRuntime } from "@/app/auth/oidc/oidcRuntime";
```

2. Replace the line `    authRoutes(typed);` with:

```ts
    const oidcRuntime = getOidcRuntime();
    oidcRoutes(typed, oidcRuntime);
    deviceAuthRoutes(typed, oidcRuntime);
    tokenRoutes(typed, oidcRuntime);
```

3. In the SPA `setNotFoundHandler`, extend the API prefix check so `/activate` never falls back to the webapp: add `url.startsWith('/activate') ||` to the condition that returns 404.

- [ ] **Step 3: Initialize at startup**

In `packages/happy-server/sources/main.ts` add the import `import { initOidcAuth } from "./app/auth/oidc/oidcRuntime";` and insert `await initOidcAuth();` directly after `await initEncrypt();`.

In `packages/happy-server/sources/index.ts` add the same import and insert `await initOidcAuth();` directly after `await initEncrypt();`.

- [ ] **Step 4: Delete legacy auth**

```bash
git rm packages/happy-server/sources/app/api/routes/authRoutes.ts
grep -rn "authRoutes\|terminalAuthRequest\|accountAuthRequest\|createToken(" packages/happy-server/sources
```
Expected: no output. Fix any remaining references (e.g. dev routes creating tokens should use `createDevice`).

- [ ] **Step 5: Typecheck and run the full suite**

```bash
pnpm --filter happy-server typecheck
pnpm --filter happy-server test
```
Expected: typecheck clean; all tests pass.

- [ ] **Step 6: Verify the server refuses to start without OIDC config**

```bash
cd packages/happy-server
HANDY_MASTER_SECRET=$(openssl rand -hex 32) DATA_DIR=$(mktemp -d) pnpm standalone migrate
HANDY_MASTER_SECRET=$(openssl rand -hex 32) DATA_DIR=$(mktemp -d) timeout 30 pnpm standalone serve; echo "exit=$?"
```
Expected: the serve command exits non-zero with `OIDC_ISSUER is required` in the output.

- [ ] **Step 7: Commit**

```bash
git add -A packages/happy-server/sources
git commit -m "feat: require OIDC auth at startup and remove keypair auth routes"
```

Note for plan 2: `happy server` in the CLI and the `cli-smoke-test.yml` "start server" step call `startServer()` and now need OIDC env. Plan 2 must update them; until then that CI step is expected to fail.

---

### Task 13: Keycloak compose, end-to-end integration test, CI, docs

**Files:**
- Create: `docker-compose.yaml`
- Create: `deploy/keycloak/happy-realm.json`
- Create: `packages/happy-server/sources/testing/httpBrowser.ts`
- Create: `packages/happy-server/sources/app/auth/oidc/oidc.integration.test.ts`
- Modify: `.github/workflows/server.yml`
- Modify: `docs/user-identity.md`

**Interfaces:**
- Consumes: `startServer` (`sources/index.ts`), `runMigrations`, all endpoints above.
- Produces: `HttpBrowser` class — `get(url, opts?: { stopAt?: (url: string) => boolean })`, `postForm(url, fields, opts?)` returning `{ url: string; status: number; body: string; location: string | null }`; keeps cookies per host and follows redirects.

- [ ] **Step 1: Create the Keycloak realm**

Create `deploy/keycloak/happy-realm.json`:

```json
{
  "realm": "happy",
  "enabled": true,
  "sslRequired": "none",
  "registrationAllowed": false,
  "clients": [
    {
      "clientId": "happy-server",
      "name": "Happy server",
      "enabled": true,
      "protocol": "openid-connect",
      "publicClient": false,
      "clientAuthenticatorType": "client-secret",
      "secret": "happy-dev-secret",
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": false,
      "redirectUris": [
        "http://localhost:3005/v1/auth/oidc/callback",
        "http://localhost:3999/v1/auth/oidc/callback"
      ],
      "webOrigins": ["+"],
      "attributes": { "pkce.code.challenge.method": "S256" }
    }
  ],
  "users": [
    {
      "username": "alice",
      "enabled": true,
      "email": "alice@example.com",
      "emailVerified": true,
      "firstName": "Alice",
      "lastName": "Example",
      "credentials": [{ "type": "password", "value": "alice", "temporary": false }]
    },
    {
      "username": "bob",
      "enabled": true,
      "email": "bob@example.com",
      "emailVerified": true,
      "firstName": "Bob",
      "lastName": "Example",
      "credentials": [{ "type": "password", "value": "bob", "temporary": false }]
    }
  ]
}
```

- [ ] **Step 2: Create `docker-compose.yaml` at the repo root**

```yaml
# Local corporate deployment: Keycloak (IdP) + Postgres + happy-server.
# The server shares Keycloak's network namespace so that "localhost:8180" is the
# same issuer URL for the server and for the browser on the host.
#
#   docker compose up -d keycloak          # IdP only (for integration tests)
#   docker compose up -d --build           # full stack; open http://localhost:3005/activate
#
# Test users: alice/alice, bob/bob. Keycloak admin: admin/admin.
services:
  keycloak:
    image: quay.io/keycloak/keycloak:26.4.0
    command: ["start-dev", "--import-realm", "--http-port=8180"]
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: admin
      KC_HEALTH_ENABLED: "true"
    volumes:
      - ./deploy/keycloak:/opt/keycloak/data/import:ro
    ports:
      - "8180:8180"   # Keycloak
      - "3005:3005"   # happy-server (shares this network namespace)
    healthcheck:
      test: ["CMD-SHELL", "exec 3<>/dev/tcp/127.0.0.1/9000 && printf 'GET /health/ready HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && grep -q UP <&3"]
      interval: 5s
      timeout: 5s
      retries: 60

  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: happy
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 30

  server:
    build:
      context: .
      dockerfile: Dockerfile.server
    network_mode: "service:keycloak"
    depends_on:
      keycloak: { condition: service_healthy }
      postgres: { condition: service_healthy }
    environment:
      PORT: "3005"
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/happy
      HANDY_MASTER_SECRET: local-dev-master-secret-change-me-0000000000
      PUBLIC_URL: http://localhost:3005
      WEBAPP_URL: http://localhost:8080
      OIDC_ISSUER: http://localhost:8180/realms/happy
      OIDC_CLIENT_ID: happy-server
      OIDC_CLIENT_SECRET: happy-dev-secret
      OIDC_ALLOW_INSECURE_ISSUER: "true"
    command: ["sh", "-c", "pnpm exec prisma migrate deploy && pnpm run start"]

volumes:
  pgdata:
```

- [ ] **Step 3: Verify the IdP comes up**

```bash
docker compose up -d keycloak
until curl -sf http://localhost:8180/realms/happy/.well-known/openid-configuration >/dev/null; do sleep 2; done
curl -s http://localhost:8180/realms/happy/.well-known/openid-configuration | grep -o '"issuer":"[^"]*"'
```
Expected: `"issuer":"http://localhost:8180/realms/happy"`.

- [ ] **Step 4: Create the cookie-jar HTTP browser**

Create `packages/happy-server/sources/testing/httpBrowser.ts`:

```ts
export interface BrowserResponse {
    url: string;
    status: number;
    body: string;
    location: string | null;
}

/** Minimal browser for integration tests: per-host cookie jar + manual redirect following. */
export class HttpBrowser {
    private jar = new Map<string, Map<string, string>>();

    async get(url: string, opts: { stopAt?: (url: string) => boolean } = {}): Promise<BrowserResponse> {
        return this.request(url, { method: 'GET' }, opts.stopAt);
    }

    async postForm(url: string, fields: Record<string, string>, opts: { stopAt?: (url: string) => boolean } = {}): Promise<BrowserResponse> {
        return this.request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(fields).toString(),
        }, opts.stopAt);
    }

    private async request(url: string, init: RequestInit, stopAt?: (url: string) => boolean): Promise<BrowserResponse> {
        let current = url;
        let currentInit = init;
        for (let hop = 0; hop < 20; hop++) {
            const target = new URL(current);
            const cookie = this.cookieFor(target.host);
            const res = await fetch(current, {
                ...currentInit,
                redirect: 'manual',
                headers: { ...(currentInit.headers as Record<string, string> | undefined), ...(cookie ? { cookie } : {}) },
            });
            this.store(target.host, res.headers.getSetCookie());
            const location = res.headers.get('location');
            if (res.status >= 300 && res.status < 400 && location) {
                const next = new URL(location, current).toString();
                if (stopAt?.(next)) {
                    return { url: current, status: res.status, body: await res.text(), location: next };
                }
                current = next;
                currentInit = { method: 'GET' };
                continue;
            }
            return { url: current, status: res.status, body: await res.text(), location };
        }
        throw new Error(`Too many redirects starting at ${url}`);
    }

    private cookieFor(host: string): string {
        const cookies = this.jar.get(host);
        return cookies ? [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') : '';
    }

    private store(host: string, setCookies: string[]) {
        const cookies = this.jar.get(host) ?? new Map<string, string>();
        for (const header of setCookies) {
            const [pair, ...attrs] = header.split(';');
            const index = pair.indexOf('=');
            const name = pair.slice(0, index).trim();
            const value = pair.slice(index + 1).trim();
            const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '';
            if (expired) cookies.delete(name); else cookies.set(name, value);
        }
        this.jar.set(host, cookies);
    }
}

export function htmlUnescape(value: string): string {
    return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export function formAction(html: string, formId: string): string {
    const match = new RegExp(`<form[^>]*id="${formId}"[^>]*action="([^"]+)"`).exec(html)
        ?? new RegExp(`<form[^>]*action="([^"]+)"[^>]*id="${formId}"`).exec(html);
    if (!match) throw new Error(`form #${formId} not found`);
    return htmlUnescape(match[1]);
}
```

- [ ] **Step 5: Write the integration test**

Create `packages/happy-server/sources/app/auth/oidc/oidc.integration.test.ts`:

```ts
/**
 * Requires Keycloak from the repo docker-compose:  docker compose up -d keycloak
 * Run with:  pnpm --filter happy-server test:integration
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomBytes } from 'crypto';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { HttpBrowser, formAction } from '@/testing/httpBrowser';

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const ISSUER = process.env.IT_OIDC_ISSUER ?? 'http://localhost:8180/realms/happy';

let deriveContentPublicKey: (root: Uint8Array) => Uint8Array;

beforeAll(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-oidc-it-'));
    Object.assign(process.env, {
        OIDC_ISSUER: ISSUER,
        OIDC_CLIENT_ID: 'happy-server',
        OIDC_CLIENT_SECRET: 'happy-dev-secret',
        OIDC_ALLOW_INSECURE_ISSUER: 'true',
        PUBLIC_URL: BASE,
        WEBAPP_URL: BASE,
        DATA_DIR: dataDir, // files.ts uses local storage under DATA_DIR when S3_HOST is unset
    });
    const migrationsDir = fileURLToPath(new URL('../../../../prisma/migrations', import.meta.url));
    const { runMigrations } = await import('@/standalone');
    await runMigrations({ pgliteDir: path.join(dataDir, 'pglite'), migrationsDir });
    const { startServer } = await import('@/index');
    await startServer({ pgliteDir: path.join(dataDir, 'pglite'), masterSecret: 'integration-master-secret-0000000000000000', port: PORT, host: '127.0.0.1' });
    ({ deriveContentPublicKey } = await import('./accountKeys'));
});

async function keycloakLogin(browser: HttpBrowser, startUrl: string, user: string, stopAt?: (url: string) => boolean) {
    const loginPage = await browser.get(startUrl, { stopAt });
    if (!loginPage.body.includes('kc-form-login')) return loginPage; // SSO session already present
    return browser.postForm(formAction(loginPage.body, 'kc-form-login'), { username: user, password: user }, { stopAt });
}

function openBox(bundleBase64: string, secretKey: Uint8Array): Uint8Array {
    const bundle = privacyKit.decodeBase64(bundleBase64);
    const opened = tweetnacl.box.open(bundle.slice(56), bundle.slice(32, 56), bundle.slice(0, 32), secretKey);
    if (!opened) throw new Error('cannot open key bundle');
    return opened;
}

async function post(pathname: string, body: unknown, token?: string) {
    const res = await fetch(`${BASE}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, json: await res.json() as any };
}

describe('OIDC against Keycloak', () => {
    const browser = new HttpBrowser();
    let cliAccountId = '';
    let cliContentKey = new Uint8Array();

    it('CLI device flow: start → Keycloak login → approve → token', async () => {
        const ephemeral = tweetnacl.box.keyPair();
        const start = await post('/v1/auth/device/start', {
            ephemeralPublicKey: privacyKit.encodeBase64(ephemeral.publicKey),
            clientInfo: { host: 'it-host', os: 'linux', cliVersion: 'it' },
        });
        expect(start.status).toBe(200);

        const confirm = await keycloakLogin(browser, start.json.verifyUrlComplete, 'alice');
        expect(confirm.status).toBe(200);
        expect(confirm.body).toContain('it-host');
        const csrf = /name="csrf" value="([^"]+)"/.exec(confirm.body)![1];
        const decided = await browser.postForm(`${BASE}/activate`, { code: start.json.userCode, csrf, decision: 'approve' });
        expect(decided.body).toContain('Return to your terminal');

        await new Promise((r) => setTimeout(r, 5100));
        const token = await post('/v1/auth/device/token', { deviceCode: start.json.deviceCode });
        expect(token.status).toBe(200);
        const plain = openBox(token.json.keyBundle, ephemeral.secretKey);
        expect(plain[0]).toBe(0);
        cliContentKey = plain.slice(1);
        cliAccountId = token.json.accountId;

        const profile = await fetch(`${BASE}/v1/account/profile`, { headers: { authorization: `Bearer ${token.json.accessToken}` } });
        expect(profile.status).toBe(200);
        expect((await profile.json() as any).firstName).toBe('Alice');

        const refreshed = await post('/v1/auth/refresh', { refreshToken: token.json.refreshToken });
        expect(refreshed.status).toBe(200);
        const reused = await post('/v1/auth/refresh', { refreshToken: token.json.refreshToken });
        expect(reused.json).toEqual({ error: 'invalid_grant', reason: 'reused' });
        const afterReuse = await post('/v1/auth/refresh', { refreshToken: refreshed.json.refreshToken });
        expect(afterReuse.json.reason).toBe('revoked');
    });

    it('web exchange: same account, root secret matches the CLI content key', async () => {
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const result = await keycloakLogin(
            browser,
            `${BASE}/v1/auth/oidc/login?client=web&code_challenge=${challenge}`,
            'alice',
            (url) => url.startsWith(`${BASE}/auth/callback`),
        );
        const code = new URLSearchParams(new URL(result.location!).hash.slice(1)).get('code')!;

        const ephemeral = tweetnacl.box.keyPair();
        const exchange = await post('/v1/auth/oidc/exchange', {
            code, codeVerifier: verifier, ephemeralPublicKey: privacyKit.encodeBase64(ephemeral.publicKey),
        });
        expect(exchange.status).toBe(200);
        expect(exchange.json.accountId).toBe(cliAccountId);
        const root = openBox(exchange.json.keyBundle, ephemeral.secretKey);
        expect(Buffer.from(deriveContentPublicKey(root)).equals(Buffer.from(cliContentKey))).toBe(true);

        const logout = await post('/v1/auth/logout', {}, exchange.json.accessToken);
        expect(logout.status).toBe(200);
        const refresh = await post('/v1/auth/refresh', { refreshToken: exchange.json.refreshToken });
        expect(refresh.json.reason).toBe('revoked');
    });

    it('a different user gets a different account', async () => {
        const other = new HttpBrowser();
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const result = await keycloakLogin(
            other,
            `${BASE}/v1/auth/oidc/login?client=web&code_challenge=${challenge}`,
            'bob',
            (url) => url.startsWith(`${BASE}/auth/callback`),
        );
        const code = new URLSearchParams(new URL(result.location!).hash.slice(1)).get('code')!;
        const exchange = await post('/v1/auth/oidc/exchange', {
            code, codeVerifier: verifier, ephemeralPublicKey: privacyKit.encodeBase64(tweetnacl.box.keyPair().publicKey),
        });
        expect(exchange.status).toBe(200);
        expect(exchange.json.accountId).not.toBe(cliAccountId);
    });
});
```

- [ ] **Step 6: Run the integration test**

```bash
docker compose up -d keycloak
pnpm --filter happy-server test:integration
```
Expected: 3 tests PASS. If the Keycloak login page is not found, dump `loginPage.body` and adjust `formAction`'s form id (Keycloak 26 uses `id="kc-form-login"`).

- [ ] **Step 7: Verify the full compose stack by hand**

```bash
docker compose up -d --build
docker compose logs server | grep "OIDC auth ready"
curl -s -X POST http://localhost:3005/v1/auth/device/start -H 'content-type: application/json' \
  -d '{"ephemeralPublicKey":"'"$(head -c32 /dev/urandom | base64)"'","clientInfo":{"host":"manual","os":"linux","cliVersion":"0"}}'
```
Expected: log line present; JSON with `userCode` and `verifyUrlComplete`. Open `verifyUrlComplete` in a browser, log in as alice/alice, see the confirm page with host `manual`. Then `docker compose down`.

- [ ] **Step 8: Add the CI job**

In `.github/workflows/server.yml`, add a job next to the existing test job (copy its checkout / pnpm / node 20 setup steps verbatim), with these steps after `pnpm install --frozen-lockfile`:

```yaml
      - name: Build wire package
        run: pnpm --filter @slopus/happy-wire --fail-if-no-match build

      - name: Start Keycloak
        run: |
          docker compose up -d keycloak
          for i in $(seq 1 90); do
            curl -sf http://localhost:8180/realms/happy/.well-known/openid-configuration >/dev/null && exit 0
            sleep 2
          done
          docker compose logs keycloak
          exit 1

      - name: OIDC integration tests
        run: pnpm --filter happy-server --fail-if-no-match test:integration

      - name: Keycloak logs on failure
        if: failure()
        run: docker compose logs keycloak
```

Name the job `oidc-integration` and give it the same `on:` path filters as the server job (add `deploy/keycloak/**` and `docker-compose.yaml`).

- [ ] **Step 9: Update identity docs**

In `docs/user-identity.md`, replace the `## Auth Flow` section body with:

````markdown
Accounts are created on first OIDC login and keyed by `(oidcIssuer, oidcSubject)`.
The server generates each account's 32-byte root secret, stores it wrapped
(`keyVault`, KeyTree from `HANDY_MASTER_SECRET`), and derives `Account.publicKey`
from it. Content encryption formats are unchanged; the server can decrypt.

```
CLI:  POST /v1/auth/device/start → user opens /activate, signs in with the IdP, approves
      POST /v1/auth/device/token → { accessToken, refreshToken, keyBundle = box([0|contentPublicKey]) }
Web:  GET /v1/auth/oidc/login?client=web&code_challenge=… → IdP → /v1/auth/oidc/callback
      → WEBAPP_URL/auth/callback#code=… → POST /v1/auth/oidc/exchange
      → { accessToken, refreshToken, keyBundle = box(rootSecret) }
All:  POST /v1/auth/refresh (rotating refresh tokens, reuse → device revoked)
      POST /v1/auth/logout
```

Access tokens are 15-minute JWTs `{ sub: accountId, did: deviceId }`.
See `docs/superpowers/specs/2026-09-30-oidc-auth-design.md`.
````

Also update the `Account.upsert by publicKey` line under "Primary ID" to `Account upsert by (oidcIssuer, oidcSubject) on first OIDC login`.

- [ ] **Step 10: Commit**

```bash
git add docker-compose.yaml deploy/keycloak packages/happy-server/sources/testing/httpBrowser.ts \
  packages/happy-server/sources/app/auth/oidc/oidc.integration.test.ts .github/workflows/server.yml docs/user-identity.md
git commit -m "test: add Keycloak compose stack and OIDC integration tests"
```

---

## Self-Review

**Spec coverage (spec §1–§4, server scope):**
- Modules `oidcClient`, `accountProvisioning`, `keyVault`, `deviceAuth`, `sessionTokens` → Tasks 7, 8, 4, 10, 5+6.
- Schema: Account fields, Device, DeviceAuthRequest, OidcExchangeCode, drop AccountAuthRequest (+ TerminalAuthRequest) → Task 2.
- Removed endpoints → Task 12.
- Config table incl. fail-fast and `OIDC_ALLOW_INSECURE_ISSUER` → Tasks 3, 12.
- No 24 h verify cache for access tokens → Task 5.
- CLI flow (start, activate + confirm page, token with `[0|contentPublicKey]` bundle) → Task 10.
- Web/mobile flow with app PKCE binding, mobile redirect allowlist → Task 9.
- Refresh rejection rules incl. max session age and account-level IdP check → Tasks 6, 8, 11.
- Logout → Task 11. Socket disconnect on revoke → Tasks 5, 6.
- Security list: code alphabet/TTL, RFC 8628 errors, state/nonce, no IdP error forwarding, reuse detection, boxed root secret, unwrap failure → 500 alert → Tasks 7, 9, 10, 6.
- Local deployment compose with Keycloak → Task 13. Integration tests → Task 13.
- Out of this plan (by design): CLI/app client changes, removal of app QR code, mobile build identity, third-party integrations, push payloads, web Playwright e2e → plans 2–4.

**Known follow-ups recorded in the plan:** `happy server` / CLI smoke test need OIDC env (plan 2); clients must serialize refresh calls because a concurrent refresh with the same token returns `invalid` (plans 2, 3).
