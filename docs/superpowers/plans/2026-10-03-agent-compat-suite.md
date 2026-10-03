# Agent Compatibility Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An on-demand suite that proves the `happycc` CLI works end to end with the pinned Claude Code, OpenCode and Pi, using `happycc-agent` as the app side and aimock as the model.

**Architecture:** Reuse the root `docker-compose.yaml` stack (oidc-mock, postgres, server, aimock, `cli` device). Add an `app` service from the same image that also has `happycc-agent`. A standalone `compat/` vitest project drives both containers with `docker compose exec` and asserts on CLI output; aimock fixtures script per-agent replies and tool calls.

**Tech Stack:** Docker Compose, Node 22, vitest 3, TypeScript, commander (happycc-agent), socket.io-client, aimock 1.43.0.

**Spec:** `docs/superpowers/specs/2026-10-03-agent-compat-suite-design.md`

## Global Constraints

- Pinned versions stay in `Dockerfile.cli` build args: `CLAUDE_CODE_VERSION=2.1.288`, `OPENCODE_VERSION=1.18.34`, `PI_VERSION=1.0.0` (`@earendil-works/pi-coding-agent`), `PI_ACP_VERSION=0.0.34`. aimock image `ghcr.io/copilotkit/aimock:1.43.0`.
- No real model is ever called. Every agent talks to `http://aimock:4010`.
- `compat/` is a standalone npm project (own `package.json` + `package-lock.json`), NOT part of the pnpm workspace, and imports nothing from `packages/*`.
- `happycc-agent` new commands mirror the app exactly: session RPC method `${sessionId}:permission` with `{ id, approved, decision? }`; `${sessionId}:abort` with `{ reason }` (the app's non-rig reason text, copied verbatim from `packages/happy-app/sources/sync/ops.ts` `sessionAbort`). Params encrypted with the session's `{ key, variant }` exactly like `machineRpc.ts`.
- Commit messages: `<type>: <description>` (feat/fix/refactor/chore/docs/build/test), 1–5 lines, no mention of "Claude" or "Happy" (lowercase `happycc` is fine), no co-author lines. Commits are GPG-signed automatically; never disable signing.
- Never write private hostnames (jsgr.net, rophyinc.com, jsgr.xyz) anywhere; tests and docs use `localhost`/`example.com`.
- The suite runs serially (`fileParallelism: false`, one worker): scenario 6 stops/starts the server.
- Known pre-existing unrelated failures that may be left: happy-app `sessionPresentation`; happy-cli `claude_version_utils` (host `/tmp/package.json`).

## File Structure

| File | Responsibility |
|---|---|
| `packages/happy-agent/src/sessionRpc.ts` (new) | Encrypted session RPC call + `permission` / `abort` helpers |
| `packages/happy-agent/src/sessionRpc.test.ts` (new) | Payload/encryption/error tests with a fake socket |
| `packages/happy-agent/src/index.ts` | New `permissions`, `approve`, `deny`, `abort` commands |
| `packages/happy-agent/src/output.ts` | `formatPermissionRequests` |
| `packages/happy-agent/README.md` | Document new commands |
| `Dockerfile.cli` | Also pack + install `happycc-agent` |
| `docker-compose.yaml` | New `app` service; aimock loads compat fixtures; agent configs |
| `deploy/aimock/compat.json` (new) | Scenario fixtures |
| `deploy/aimock/agents/opencode.json`, `pi-models.json`, `pi-settings.json` | Per-agent compat model names; OpenCode `edit: ask` |
| `compat/package.json`, `vitest.config.ts`, `tsconfig.json` (new) | Test project |
| `compat/scripts/signin.mjs` (new) | Headless OIDC sign-in helper run inside a container |
| `compat/src/stack.ts` (new) | `docker compose exec` wrappers, polling, JSON parsing |
| `compat/src/agents.ts` (new) | Per-agent start commands, model names, tool shapes, capability table (N/A reasons) |
| `compat/src/globalSetup.ts` (new) | Health wait, sign-in of both devices, version capture |
| `compat/src/report.ts` (new) | Matrix → markdown (`compat/report.md`) |
| `compat/tests/*.test.ts` (new) | Scenarios |
| `compat/README.md` (new) | How to run |
| `.github/workflows/compat.yml` (new) | Manual CI run |

---

### Task 1: `happycc-agent` session RPC + permission/abort commands

**Files:**
- Create: `packages/happy-agent/src/sessionRpc.ts`, `packages/happy-agent/src/sessionRpc.test.ts`
- Modify: `packages/happy-agent/src/index.ts`, `packages/happy-agent/src/output.ts`, `packages/happy-agent/src/output.test.ts`, `packages/happy-agent/README.md`

**Interfaces:**
- Consumes: `encrypt`, `decrypt`, `encodeBase64`, `decodeBase64` from `./encryption`; `socketAuth`, `TokenSource` from `./tokenStore`; `DecryptedSession` from `./api`; existing `resolveSession`, `openAuth`, `loadConfig` in `index.ts`.
- Produces (used by Task 5+ through the CLI only):
  - `happycc-agent permissions <session> [--json]` → JSON array `[{ id, tool, arguments, createdAt? }]`
  - `happycc-agent approve <session> <request-id> [--for-session]`
  - `happycc-agent deny <session> <request-id>`
  - `happycc-agent abort <session>`
  - TS: `export async function callSessionRpc(socket: RpcSocket, session: Pick<DecryptedSession,'id'|'encryption'>, method: string, params: unknown): Promise<unknown>`; `export function pendingPermissionRequests(agentState: unknown): PermissionRequest[]`; `export const ABORT_REASON: string`.

- [ ] **Step 1: Write the failing tests** — `packages/happy-agent/src/sessionRpc.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { callSessionRpc, pendingPermissionRequests, ABORT_REASON } from './sessionRpc';
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
        expect(ABORT_REASON).toMatch(/^The user doesn't want to proceed with this tool use\./);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/happy-agent && npx vitest run src/sessionRpc.test.ts`
Expected: FAIL — cannot resolve `./sessionRpc`.

- [ ] **Step 3: Implement** — `packages/happy-agent/src/sessionRpc.ts`

```ts
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
```

- [ ] **Step 4: Run tests** — `cd packages/happy-agent && npx vitest run src/sessionRpc.test.ts` → PASS (6 tests).

- [ ] **Step 5: Add the CLI commands** in `packages/happy-agent/src/index.ts` (after the `stop` command). Open the socket the same way `machineRpc.ts` `connectMachineSocket` does — export that function from `machineRpc.ts` as `connectRpcSocket` (rename, keep behavior) and reuse it:

```ts
program
    .command('permissions')
    .description('List pending permission requests of a session')
    .argument('<session-id>', 'Session ID or prefix')
    .option('--json', 'Output as JSON')
    .action(async (sessionId: string, opts: { json?: boolean }) => {
        const config = loadConfig();
        const { creds, tokens } = openAuth(config);
        const session = await resolveSession(config, creds, tokens, sessionId);
        const requests = pendingPermissionRequests(session.agentState);
        console.log(opts.json ? formatJson(requests) : formatPermissionRequests(session.id, requests));
    });

for (const [name, approved] of [['approve', true], ['deny', false]] as const) {
    const command = program
        .command(name)
        .description(approved ? 'Approve a pending permission request' : 'Deny a pending permission request')
        .argument('<session-id>', 'Session ID or prefix')
        .argument('<request-id>', 'Permission request ID or prefix');
    if (approved) command.option('--for-session', 'Approve this tool for the rest of the session');
    command.action(async (sessionId: string, requestId: string, opts: { forSession?: boolean }) => {
        const config = loadConfig();
        const { creds, tokens } = openAuth(config);
        const session = await resolveSession(config, creds, tokens, sessionId);
        const request = resolveByPrefix(pendingPermissionRequests(session.agentState), requestId, 'Request ID');
        const decision = approved ? (opts.forSession ? 'approved_for_session' : 'approved') : 'denied';
        const socket = await connectRpcSocket(config, tokens);
        try {
            await callSessionRpc(socket, session, 'permission', { id: request.id, approved, decision });
        } finally {
            socket.close();
        }
        console.log(`${approved ? 'Approved' : 'Denied'} ${request.tool} (${request.id}) in session ${session.id}`);
    });
}

program
    .command('abort')
    .description('Abort the current turn of a session (the session keeps running)')
    .argument('<session-id>', 'Session ID or prefix')
    .action(async (sessionId: string) => {
        const config = loadConfig();
        const { creds, tokens } = openAuth(config);
        const session = await resolveSession(config, creds, tokens, sessionId);
        const socket = await connectRpcSocket(config, tokens);
        try {
            await callSessionRpc(socket, session, 'abort', { reason: ABORT_REASON });
        } finally {
            socket.close();
        }
        console.log(`Aborted the current turn of session ${session.id}`);
    });
```

Add `formatPermissionRequests(sessionId, requests)` to `output.ts` (markdown list: `- \`<id>\` <tool>: <JSON.stringify(arguments)>`, or `No pending permission requests.`) with a test in `output.test.ts` covering both branches.

- [ ] **Step 6: Wiring test** — extend `cliWiring.test.ts` (or `index.test.ts`, whichever lists commands) to assert `permissions`, `approve`, `deny`, `abort` appear in `--help` and that `approve` without args exits non-zero.

- [ ] **Step 7: README** — add the four commands with one example each to `packages/happy-agent/README.md`.

- [ ] **Step 8: Verify** — `cd packages/happy-agent && npx tsc --noEmit && pnpm run build && npx vitest run` → all pass (previous 284 + new).

- [ ] **Step 9: Commit**

```bash
git add packages/happy-agent
git commit -m "feat: add permissions, approve, deny and abort to happycc-agent"
```

---

### Task 2: Stack — `app` device, compat fixtures, agent configs

**Files:**
- Modify: `Dockerfile.cli`, `docker-compose.yaml`, `deploy/aimock/agents/opencode.json`, `deploy/aimock/agents/pi-models.json`, `deploy/aimock/agents/pi-settings.json`
- Create: `deploy/aimock/compat.json`

**Interfaces:**
- Produces: compose services `cli` and `app` (both from `Dockerfile.cli`; `app` has `happycc-agent` on PATH), model names `compat-claude` / `compat-opencode` / `compat-pi`, fixture markers `compat:hello`, `compat:write <file>`, `compat:slow`, reply texts `COMPAT-HELLO-OK`, `COMPAT-WRITE-DONE`, written file content `COMPAT-FILE-CONTENT`.

- [ ] **Step 1: Pack `happycc-agent` in `Dockerfile.cli`.** In the `deps` stage copy `packages/happy-agent/package.json` and install with `--filter happycc... --filter happycc-agent...`; in `builder` copy `packages/happy-agent`, build it (`pnpm --filter happycc-agent --fail-if-no-match build`) and `pnpm --filter happycc-agent pack --pack-destination /pack && mv /pack/happycc-agent-*.tgz /pack/happycc-agent.tgz`; in `runner` install both tarballs: `npm install -g /pack/happycc.tgz /pack/happycc-agent.tgz`. Pre-create `/home/node/.happycc-agent` if the agent uses its own home (check `packages/happy-agent/src/config.ts`; mirror whatever default dir it uses).

- [ ] **Step 2: `app` service** in `docker-compose.yaml`, next to `cli`:

```yaml
  app:
    build:
      context: .
      dockerfile: Dockerfile.cli
    # The "phone" for the compatibility suite: happycc-agent signed in as its own device.
    network_mode: "service:oidc-mock"
    depends_on:
      server: { condition: service_started }
    environment:
      HAPPY_SERVER_URL: http://localhost:3005
      HAPPY_WEBAPP_URL: http://localhost:8080
      HEADLESS: "1"
    volumes:
      - app-home:/home/node
    command: ["sleep", "infinity"]
```

and add `app-home:` under `volumes:`. Set `ANTHROPIC_MODEL: compat-claude` on the `cli` service (Claude Code honors it; the catch-all fixture still answers manual use).

- [ ] **Step 3: Agent configs.** `deploy/aimock/agents/opencode.json` becomes:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "anthropic": {
      "options": { "baseURL": "http://aimock:4010/v1", "apiKey": "aimock" },
      "models": { "compat-opencode": { "name": "compat-opencode" } }
    }
  },
  "model": "anthropic/compat-opencode",
  "small_model": "anthropic/compat-opencode",
  "permission": { "edit": "ask", "bash": "ask" }
}
```

`pi-models.json`: rename model id `mock-model` → `compat-pi`; `pi-settings.json`: `"defaultModel": "compat-pi"`.

- [ ] **Step 4: Fixtures** — `deploy/aimock/compat.json` (aimock loads every `*.json` with a top-level `fixtures` key under `/fixtures`, walking the directory; `compat.json` sorts before `fixtures.json`, so the catch-all stays last):

```json
{
  "fixtures": [
    { "match": { "userMessage": "compat:hello" }, "response": { "content": "COMPAT-HELLO-OK" } },

    { "match": { "userMessage": "compat:write", "model": "compat-claude", "hasToolResult": false },
      "response": { "toolCalls": [{ "name": "Write", "arguments": { "file_path": "/workspace/compat-write.txt", "content": "COMPAT-FILE-CONTENT" } }] } },
    { "match": { "userMessage": "compat:write", "model": "compat-opencode", "hasToolResult": false },
      "response": { "toolCalls": [{ "name": "write", "arguments": { "filePath": "/workspace/compat-write.txt", "content": "COMPAT-FILE-CONTENT" } }] } },
    { "match": { "userMessage": "compat:write", "model": "compat-pi", "hasToolResult": false },
      "response": { "toolCalls": [{ "name": "write", "arguments": { "path": "/workspace/compat-write.txt", "content": "COMPAT-FILE-CONTENT" } }] } },
    { "match": { "userMessage": "compat:write", "hasToolResult": true }, "response": { "content": "COMPAT-WRITE-DONE" } },

    { "match": { "userMessage": "compat:slow" },
      "response": { "content": "COMPAT-SLOW-START this reply streams slowly so the test can abort it before it completes. ... COMPAT-SLOW-END" },
      "latency": 1500, "chunkSize": 4 }
  ]
}
```

Fixed file path `/workspace/compat-write.txt`: each scenario deletes it before running, so a leftover cannot pass a test.

- [ ] **Step 5: Validate fixtures** — `docker compose up -d --force-recreate aimock && docker compose logs aimock | grep -i "fixture"`. Expected: a line reporting **7** loaded fixtures (6 compat + 1 catch-all) and no warning lines; `agents/*.json` files are skipped as non-fixture files.

- [ ] **Step 6: Bring up and smoke** — `docker compose up -d --build`; then:
  - `docker compose exec -T app happycc-agent --help | grep -E "permissions|abort"` → both present.
  - `docker compose exec -T cli sh -c 'cd /workspace && opencode run compat:hello < /dev/null'` → prints `COMPAT-HELLO-OK`.
  - `docker compose exec -T cli sh -c 'cd /workspace && pi -p compat:hello < /dev/null'` → `COMPAT-HELLO-OK`.
  - `docker compose exec -T cli sh -c 'cd /workspace && claude -p compat:hello < /dev/null'` → `COMPAT-HELLO-OK`.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile.cli docker-compose.yaml deploy/aimock
git commit -m "build: add the app device and compat fixtures to the compose stack"
```

---

### Task 3: `compat/` project skeleton + sign-in helper + global setup

**Files:**
- Create: `compat/package.json`, `compat/tsconfig.json`, `compat/vitest.config.ts`, `compat/.gitignore`, `compat/scripts/signin.mjs`, `compat/src/stack.ts`, `compat/src/stack.test.ts`, `compat/src/globalSetup.ts`, `compat/README.md`

**Interfaces:**
- Produces:
  - `exec(service: 'cli'|'app', cmd: string, opts?: { timeoutMs?: number; allowFail?: boolean }): Promise<{ stdout: string; stderr: string; code: number }>` — `docker compose exec -T <service> sh -lc <cmd>` from the repo root.
  - `execDetached(service, cmd: string): Promise<void>` — `docker compose exec -d`.
  - `agentJson<T>(args: string): Promise<T>` — `exec('app', 'happycc-agent ' + args + ' --json')` then `JSON.parse`.
  - `poll<T>(fn: () => Promise<T | undefined>, opts: { timeoutMs: number; intervalMs?: number; what: string }): Promise<T>` — throws `Timed out waiting for <what>` with the last error.
  - `compose(args: string): Promise<void>` — `docker compose <args>`.
  - `globalSetup` writes `compat/.versions.json`: `{ happycc, happyccAgent, claude, opencode, pi, piAcp }`.

- [ ] **Step 1: `compat/package.json`**

```json
{
  "name": "happycc-compat",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run" },
  "devDependencies": { "typescript": "^5.9.2", "vitest": "^3.2.4", "@types/node": "^22.0.0" }
}
```

Run `npm install` to create `package-lock.json`. `.gitignore`: `node_modules/`, `.versions.json`, `report.md`, `results.json`, `logs/`.

- [ ] **Step 2: `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
        globalSetup: ['./src/globalSetup.ts'],
        fileParallelism: false,
        maxWorkers: 1,
        minWorkers: 1,
        testTimeout: 180_000,
        hookTimeout: 300_000,
        reporters: ['default', ['json', { outputFile: 'results.json' }]],
    },
});
```

- [ ] **Step 3: Write the failing unit test** `compat/src/stack.test.ts` for the pure helpers (`poll`, and `extractUrl(text, pattern)` used by sign-in):

```ts
import { describe, it, expect } from 'vitest';
import { poll, extractUrl } from './stack';

describe('poll', () => {
    it('returns the first defined value', async () => {
        let n = 0;
        await expect(poll(async () => (++n === 3 ? 'ok' : undefined), { timeoutMs: 1000, intervalMs: 1, what: 'x' })).resolves.toBe('ok');
    });
    it('times out naming what it waited for', async () => {
        await expect(poll(async () => undefined, { timeoutMs: 20, intervalMs: 5, what: 'the reply' })).rejects.toThrow('Timed out waiting for the reply');
    });
});

describe('extractUrl', () => {
    it('finds the first URL matching a pattern', () => {
        expect(extractUrl('open\n  http://localhost:3005/activate?code=AB-CD\nthen', /\/activate\?code=/)).toBe('http://localhost:3005/activate?code=AB-CD');
    });
});
```

Run `cd compat && npx vitest run src/stack.test.ts` with `globalSetup` temporarily irrelevant — the test file must not need the stack: make `globalSetup` skip when `COMPAT_UNIT_ONLY=1` (document it). Expected: FAIL (module missing).

- [ ] **Step 4: Implement `compat/src/stack.ts`**

```ts
/** Thin wrappers over `docker compose` used by every scenario. */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
export type Service = 'cli' | 'app';
export type ExecResult = { stdout: string; stderr: string; code: number };

function run(args: string[], timeoutMs: number): Promise<ExecResult> {
    return new Promise((done) => {
        execFile('docker', ['compose', ...args], { cwd: REPO_ROOT, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
            (error, stdout, stderr) => done({ stdout, stderr, code: error ? (typeof error.code === 'number' ? error.code : 1) : 0 }));
    });
}

export async function exec(service: Service, cmd: string, opts: { timeoutMs?: number; allowFail?: boolean } = {}): Promise<ExecResult> {
    const result = await run(['exec', '-T', service, 'sh', '-lc', cmd], opts.timeoutMs ?? 120_000);
    if (result.code !== 0 && !opts.allowFail) {
        throw new Error(`[${service}] ${cmd}\nexit ${result.code}\n${result.stdout}\n${result.stderr}`);
    }
    return result;
}

export async function execDetached(service: Service, cmd: string): Promise<void> {
    const result = await run(['exec', '-d', service, 'sh', '-lc', cmd], 30_000);
    if (result.code !== 0) throw new Error(`[${service}] detached ${cmd} failed: ${result.stderr}`);
}

export async function compose(args: string): Promise<void> {
    const result = await run(args.split(' '), 300_000);
    if (result.code !== 0) throw new Error(`docker compose ${args} failed: ${result.stderr}`);
}

export async function agentJson<T>(args: string): Promise<T> {
    const { stdout } = await exec('app', `happycc-agent ${args} --json`);
    return JSON.parse(stdout) as T;
}

export async function poll<T>(fn: () => Promise<T | undefined>, opts: { timeoutMs: number; intervalMs?: number; what: string }): Promise<T> {
    const deadline = Date.now() + opts.timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            const value = await fn();
            if (value !== undefined) return value;
        } catch (error) {
            lastError = error;
        }
        await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1000));
    }
    throw new Error(`Timed out waiting for ${opts.what}${lastError ? `: ${String(lastError)}` : ''}`);
}

export function extractUrl(text: string, pattern: RegExp): string | undefined {
    return text.match(/https?:\/\/\S+/g)?.find((url) => pattern.test(url));
}
```

Run the unit test → PASS.

- [ ] **Step 5: Sign-in helper** `compat/scripts/signin.mjs` (copied into the container with `docker compose cp`, run with `node`):

```js
// Usage: node signin.mjs <url> <user>
// Completes the OIDC sign-in a CLI printed: follows redirects with a cookie jar,
// submits oidc-mock's user form for <user>, then our confirmation page
// (decision=approve for the device flow, decision=allow for loopback).
const [startUrl, user] = process.argv.slice(2);
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function request(url, init = {}) {
    for (let hops = 0; hops < 15; hops++) {
        const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...init.headers, cookie: cookieHeader() } });
        for (const c of res.headers.getSetCookie?.() ?? []) {
            const [pair] = c.split(';');
            const i = pair.indexOf('=');
            jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
        }
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
            url = new URL(location, url).toString();
            init = {};
            continue;
        }
        return { url, status: res.status, body: await res.text() };
    }
    throw new Error('Too many redirects');
}

const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '';
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
function forms(html) {
    return [...html.matchAll(/<form[^>]*>[\s\S]*?<\/form>/g)].map(([f]) => ({
        action: decode(attr(f.match(/<form[^>]*>/)[0], 'action')),
        fields: Object.fromEntries([...f.matchAll(/<input[^>]*>/g)].map(([i]) => [attr(i, 'name'), decode(attr(i, 'value'))]).filter(([n]) => n)),
        decisions: [...f.matchAll(/<button[^>]*name="decision"[^>]*value="([^"]*)"/g)].map((m) => m[1]),
    }));
}

let page = await request(startUrl);
for (let step = 0; step < 6; step++) {
    const all = forms(page.body);
    const userForm = all.find((f) => f.fields.sub === user);
    const confirm = all.find((f) => f.fields.csrf && f.decisions.some((d) => d === 'approve' || d === 'allow'));
    const form = userForm ?? confirm;
    if (!form) break;
    const fields = { ...form.fields };
    if (form === confirm) fields.decision = form.decisions.find((d) => d === 'approve' || d === 'allow');
    page = await request(new URL(form.action, page.url).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
    });
}
if (page.status >= 400) {
    console.error(`Sign-in ended with HTTP ${page.status} at ${page.url}`);
    process.exit(1);
}
console.log(`Sign-in finished at ${page.url}`);
```

- [ ] **Step 6: Global setup** `compat/src/globalSetup.ts`:
  1. If `COMPAT_UNIT_ONLY=1`, return.
  2. `poll` `curl -sf http://localhost:3005/health` (via `exec('cli', ...)`) up to 120 s; same for `http://aimock:4010/health` if aimock exposes it, otherwise `curl -s -o /dev/null http://aimock:4010/` must connect.
  3. Copy the helper into both containers: `docker compose cp compat/scripts/signin.mjs cli:/tmp/signin.mjs` (and `app`).
  4. **cli sign-in** unless `happycc auth status` contains `Authenticated`: `execDetached('cli', 'happycc auth login > /tmp/compat-login.log 2>&1')`; `poll` the log for a URL matching `/activate\?code=/` (`extractUrl`); `exec('cli', 'node /tmp/signin.mjs "<url>" alice')`; `poll` `happycc auth status` for `Authenticated`; then `happycc daemon start` (ignore "already running").
  5. **app sign-in** unless `happycc-agent auth status` reports signed in: detached `happycc-agent auth login --no-browser > /tmp/compat-login.log 2>&1`; `poll` for a URL matching `/\/v1\/auth\/oidc\/login\?/`; run the helper in **app**; `poll` status.
  6. Write `compat/.versions.json` from `exec('cli', 'happycc --version; claude --version; opencode --version; pi --version; npm ls -g pi-acp --depth=0')` and `exec('app', 'happycc-agent --version')`, parsing each line.

- [ ] **Step 7: Run** — with the stack up: `cd compat && npx vitest run src/stack.test.ts` → setup signs both in, unit tests pass; `cat compat/.versions.json` shows all six versions. Re-run → setup skips sign-in (already signed in).

- [ ] **Step 8: README** `compat/README.md`: prerequisites (Docker), `docker compose up -d --build`, `cd compat && npm ci && npm test`, where the report lands, `COMPAT_UNIT_ONLY`, how to bump a pinned version (edit `Dockerfile.cli` ARG, rebuild, run).

- [ ] **Step 9: Commit**

```bash
git add compat
git commit -m "test: scaffold the agent compatibility suite with headless sign-in"
```

---

### Task 4: Agent definitions + capability verification

**Files:**
- Create: `compat/src/agents.ts`, `compat/src/session.ts`, `compat/CAPABILITIES.md`

**Interfaces:**
- Consumes: `exec`, `execDetached`, `agentJson`, `poll` from `./stack`.
- Produces:
  - `type AgentId = 'claude' | 'opencode' | 'pi'`; `type Scenario = 'roundtrip'|'tool-allow'|'tool-deny'|'abort'|'kill'|'offline-start'|'resume'|'spawn'`.
  - `AGENTS: Record<AgentId, { label: string; start: string; unsupported: Partial<Record<Scenario, string>> }>` — `start` is the shell command run detached in `/workspace` on `cli`; `unsupported` maps a scenario to the N/A reason.
  - `startSession(agent: AgentId, logFile: string): Promise<string>` → session id (detects the new active session via `happycc-agent list --json`, filtering `metadata.machineId` of the `cli` device and ids seen before the start).
  - `sendAndWait(sessionId: string, text: string, timeoutS?: number): Promise<void>`; `historyText(sessionId: string): Promise<string>` (JSON-stringified `history --json`).
  - `stopSession(sessionId)`; `cleanupAgentProcesses()` (kills `happycc` runner processes on `cli` except the daemon).

- [ ] **Step 1: Start commands** (in `agents.ts`):

```ts
export const AGENTS = {
    claude:   { label: 'Claude Code', start: 'happycc --happy-starting-mode remote', unsupported: {} },
    opencode: { label: 'OpenCode',    start: 'happycc acp opencode',              unsupported: { spawn: 'The daemon cannot spawn ACP agents yet.' } },
    pi:       { label: 'Pi',          start: 'happycc acp -- pi-acp',             unsupported: { spawn: 'The daemon cannot spawn ACP agents yet.' } },
} as const;
```

`startSession` runs `execDetached('cli', \`cd /workspace && exec ${start} > ${logFile} 2>&1 < /dev/null\`)`.

`compat/src/session.ts`:

```ts
/** Starting agent sessions on the cli device and talking to them from the app device. */
import { AGENTS, type AgentId } from './agents';
import { agentJson, exec, execDetached, poll } from './stack';

type Session = { id: string; active: boolean; createdAt: number; metadata?: { machineId?: string; host?: string } };
type Machine = { id: string; metadata?: { host?: string } };

async function cliMachineId(): Promise<string> {
    const host = (await exec('cli', 'hostname')).stdout.trim();
    const machines = await agentJson<Machine[]>('machines');
    const machine = machines.find((m) => m.metadata?.host === host);
    if (!machine) throw new Error(`No machine registered for cli host ${host}`);
    return machine.id;
}

export async function startDetached(agent: AgentId, logFile: string): Promise<void> {
    await execDetached('cli', `cd /workspace && exec ${AGENTS[agent].start} > ${logFile} 2>&1 < /dev/null`);
}

export async function newestSessionSince(sinceMs: number): Promise<string> {
    const machineId = await cliMachineId();
    return poll(async () => {
        const sessions = await agentJson<Session[]>('list --active');
        return sessions
            .filter((s) => s.active && s.createdAt >= sinceMs && s.metadata?.machineId === machineId)
            .sort((a, b) => b.createdAt - a.createdAt)[0]?.id;
    }, { timeoutMs: 60_000, what: 'the new session to appear' });
}

export async function startSession(agent: AgentId, logFile: string): Promise<string> {
    const since = Date.now() - 1000;
    await startDetached(agent, logFile);
    return newestSessionSince(since);
}

export async function sendAndWait(sessionId: string, text: string, timeoutS = 120): Promise<void> {
    await exec('app', `happycc-agent send ${sessionId} ${JSON.stringify(text)}`);
    await exec('app', `happycc-agent wait ${sessionId} --timeout ${timeoutS}`, { timeoutMs: (timeoutS + 30) * 1000 });
}

export async function historyText(sessionId: string): Promise<string> {
    return JSON.stringify(await agentJson<unknown>(`history ${sessionId}`));
}

export async function stopSession(sessionId: string): Promise<void> {
    await exec('app', `happycc-agent stop ${sessionId}`);
}

/** Kill leftover agent runners (never the daemon) so scenarios don't leak into each other. */
export async function cleanupAgentProcesses(): Promise<void> {
    await exec('cli', `pkill -f "happycc (acp|--happy-starting-mode)" || true; pkill -f "opencode acp" || true; pkill -f pi-acp || true`, { allowFail: true });
}
```

Check while implementing: the exact flag of `happycc-agent list` for active sessions and the `createdAt` units in its JSON (ms expected — `DecryptedSession.createdAt`); the machine `metadata.host` field name (`happycc-agent machines --json`). Adjust field names to the real output; do not change the logic.

- [ ] **Step 2: Verify each "verify" cell of the spec by hand** using the new commands, and record evidence in `compat/CAPABILITIES.md` (command output excerpts, versions):
  - Claude remote mode starts without a TTY via `--happy-starting-mode remote` and answers `compat:hello`. If it requires a TTY, wrap with `script -qec "<cmd>" /dev/null` and record that.
  - Permission request appears in `happycc-agent permissions <id> --json` for `compat:write` on Claude and OpenCode; `approve` writes the file.
  - **Pi**: does `compat:write` raise a permission request, or does Pi write directly? If directly → `unsupported['tool-allow'|'tool-deny'] = 'Pi has no permission prompts; it runs tools without asking.'` and record that the file is still written.
  - **Resume** for OpenCode and Pi: stop the CLI runner process, run `happycc-agent resume <id>`; record success or the exact error; set `unsupported.resume` with that error as the reason when it fails.
  - **Abort** works mid `compat:slow` for each agent.
  Update `AGENTS[...].unsupported` to match the evidence. Every N/A must cite evidence in `CAPABILITIES.md`.

- [ ] **Step 3: Commit**

```bash
git add compat/src/agents.ts compat/src/session.ts compat/CAPABILITIES.md
git commit -m "test: define compat agents and record their verified capabilities"
```

---

### Task 5: Scenarios 1–3 (round trip, tool allowed, tool denied)

**Files:**
- Create: `compat/tests/conversation.test.ts`, `compat/src/matrix.ts`

**Interfaces:**
- Consumes: `AGENTS`, `startSession`, `sendAndWait`, `historyText`, `stopSession`, `cleanupAgentProcesses`, `agentJson`, `exec`, `poll`.
- Produces: `forEachAgent(scenario: Scenario, body: (agent: AgentId) => Promise<void>)` in `matrix.ts` — registers one vitest test per agent named `<agent> › <scenario>`; when `AGENTS[agent].unsupported[scenario]` is set it registers `it.skip` with the title suffixed ` (N/A: <reason>)` so the report shows N/A.

- [ ] **Step 1: `matrix.ts`**

```ts
import { it } from 'vitest';
import { AGENTS, type AgentId, type Scenario } from './agents';

export function forEachAgent(scenario: Scenario, body: (agent: AgentId) => Promise<void>): void {
    for (const agent of Object.keys(AGENTS) as AgentId[]) {
        const reason = AGENTS[agent].unsupported[scenario];
        if (reason) it.skip(`${agent} › ${scenario} (N/A: ${reason})`, () => {});
        else it(`${agent} › ${scenario}`, () => body(agent));
    }
}
```

- [ ] **Step 2: Tests** `compat/tests/conversation.test.ts`

```ts
import { afterEach, describe, expect } from 'vitest';
import { forEachAgent } from '../src/matrix';
import { startSession, sendAndWait, historyText, stopSession, cleanupAgentProcesses } from '../src/session';
import { agentJson, exec, poll } from '../src/stack';

type Request = { id: string; tool: string };
let sessionId: string | undefined;

afterEach(async () => {
    if (sessionId) await stopSession(sessionId).catch(() => {});
    sessionId = undefined;
    await cleanupAgentProcesses();
});

async function pendingRequest(id: string): Promise<Request> {
    return poll(async () => (await agentJson<Request[]>(`permissions ${id}`))[0], { timeoutMs: 60_000, what: 'a permission request' });
}

describe('conversation', () => {
    forEachAgent('roundtrip', async (agent) => {
        sessionId = await startSession(agent, `/tmp/compat-${agent}-roundtrip.log`);
        await sendAndWait(sessionId, 'compat:hello');
        expect(await historyText(sessionId)).toContain('COMPAT-HELLO-OK');
    });

    forEachAgent('tool-allow', async (agent) => {
        await exec('cli', 'rm -f /workspace/compat-write.txt');
        sessionId = await startSession(agent, `/tmp/compat-${agent}-tool-allow.log`);
        await exec('app', `happycc-agent send ${sessionId} "compat:write"`);
        const request = await pendingRequest(sessionId);
        await exec('app', `happycc-agent approve ${sessionId} ${request.id}`);
        await exec('app', `happycc-agent wait ${sessionId} --timeout 120`);
        expect((await exec('cli', 'cat /workspace/compat-write.txt')).stdout).toBe('COMPAT-FILE-CONTENT');
        expect(await historyText(sessionId)).toContain('COMPAT-WRITE-DONE');
    });

    forEachAgent('tool-deny', async (agent) => {
        await exec('cli', 'rm -f /workspace/compat-write.txt');
        sessionId = await startSession(agent, `/tmp/compat-${agent}-tool-deny.log`);
        await exec('app', `happycc-agent send ${sessionId} "compat:write"`);
        const request = await pendingRequest(sessionId);
        await exec('app', `happycc-agent deny ${sessionId} ${request.id}`);
        await exec('app', `happycc-agent wait ${sessionId} --timeout 120`);
        expect((await exec('cli', 'test -e /workspace/compat-write.txt', { allowFail: true })).code).not.toBe(0);
        await sendAndWait(sessionId, 'compat:hello');
        expect(await historyText(sessionId)).toContain('COMPAT-HELLO-OK');
    });
});
```

- [ ] **Step 3: Run** — `cd compat && npx vitest run tests/conversation.test.ts`. Expected: 9 results; all pass except cells marked N/A in Task 4 (shown as skipped with reason). Fix fixtures/agent configs (not assertions) if an agent's tool shape differs; record any change in `CAPABILITIES.md`.

- [ ] **Step 4: Commit** — `git add compat && git commit -m "test: cover round trip and tool permissions per agent"`

---

### Task 6: Scenarios 4–6 (abort, kill, offline start)

**Files:**
- Create: `compat/tests/lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 4/5 helpers, `compose`.

- [ ] **Step 1: Tests**

```ts
import { afterEach, describe, expect } from 'vitest';
import { forEachAgent } from '../src/matrix';
import { startSession, startDetached, newestSessionSince, sendAndWait, historyText, stopSession, cleanupAgentProcesses } from '../src/session';
import { agentJson, compose, exec, poll } from '../src/stack';

let sessionId: string | undefined;
afterEach(async () => {
    if (sessionId) await stopSession(sessionId).catch(() => {});
    sessionId = undefined;
    await compose('start server');
    await cleanupAgentProcesses();
});

describe('lifecycle', () => {
    forEachAgent('abort', async (agent) => {
        sessionId = await startSession(agent, `/tmp/compat-${agent}-abort.log`);
        await exec('app', `happycc-agent send ${sessionId} "compat:slow"`);
        await poll(async () => ((await historyText(sessionId!)).includes('COMPAT-SLOW-START') ? true : undefined),
            { timeoutMs: 60_000, what: 'the slow reply to start streaming' });
        await exec('app', `happycc-agent abort ${sessionId}`);
        await exec('app', `happycc-agent wait ${sessionId} --timeout 60`);
        expect(await historyText(sessionId)).not.toContain('COMPAT-SLOW-END');
        await sendAndWait(sessionId, 'compat:hello');
        expect(await historyText(sessionId)).toContain('COMPAT-HELLO-OK');
    });

    forEachAgent('kill', async (agent) => {
        const log = `/tmp/compat-${agent}-kill.log`;
        sessionId = await startSession(agent, log);
        await exec('app', `happycc-agent stop ${sessionId}`);
        await poll(async () => {
            const { code } = await exec('cli', `pgrep -f "${log}" >/dev/null`, { allowFail: true });
            return code !== 0 ? true : undefined;
        }, { timeoutMs: 60_000, what: 'the agent process to exit' });
        const status = await agentJson<{ active: boolean }>(`status ${sessionId}`);
        expect(status.active).toBe(false);
        sessionId = undefined;
    });

    forEachAgent('offline-start', async (agent) => {
        await compose('stop server');
        const log = `/tmp/compat-${agent}-offline.log`;
        // startSession cannot list sessions while the server is down: start detached, then resolve the id after reconnect.
        const startedAt = Date.now();
        await startDetached(agent, log);
        await poll(async () => ((await exec('cli', `cat ${log}`, { allowFail: true })).stdout.includes('offline mode') ? true : undefined),
            { timeoutMs: 30_000, what: 'the CLI to report offline mode' });
        await compose('start server');
        await poll(async () => ((await exec('cli', `cat ${log}`)).stdout.includes('Reconnected') ? true : undefined),
            { timeoutMs: 120_000, what: 'the CLI to reconnect' });
        sessionId = await newestSessionSince(startedAt);
        await sendAndWait(sessionId, 'compat:hello');
        expect(await historyText(sessionId)).toContain('COMPAT-HELLO-OK');
    });
});
```

- [ ] **Step 2: Run** — `npx vitest run tests/lifecycle.test.ts` → all non-N/A pass. `offline-start` exercises the reconnect fix from commit `c5bb1440`; if it fails, capture the CLI log, do not weaken the assertion.

- [ ] **Step 3: Commit** — `git commit -am "test: cover abort, kill and offline start per agent"` (add the new file explicitly).

---

### Task 7: Scenarios 7–8 (resume, start from phone)

**Files:**
- Create: `compat/tests/remote-control.test.ts`

- [ ] **Step 1: Tests**
  - **resume** (`forEachAgent('resume', …)`): start, `sendAndWait('compat:hello')`, kill the runner process on `cli` with `pkill -f <log>` (session stays in the account), `happycc-agent resume <id>` → `poll` until `status --json` reports `active: true` (resume may create a new session id — if the command prints a new id, use it), then `sendAndWait('compat:hello')` and assert the history of the resumed session contains `COMPAT-HELLO-OK` **twice** (earlier history preserved).
  - **spawn** (`forEachAgent('spawn', …)`; N/A for OpenCode/Pi): `machines --json` → the cli device's machine id; `happycc-agent spawn <machine> --path /workspace --agent claude --json` → session id; `sendAndWait('compat:hello')` → contains `COMPAT-HELLO-OK`.

- [ ] **Step 2: Run** — `npx vitest run tests/remote-control.test.ts` → non-N/A pass.

- [ ] **Step 3: Commit** — `git add compat/tests/remote-control.test.ts && git commit -m "test: cover resume and start from the app side"`

---

### Task 8: Report + CI workflow + docs

**Files:**
- Create: `compat/src/report.ts`, `compat/src/report.test.ts`, `.github/workflows/compat.yml`
- Modify: `compat/package.json` (`"report": "node --experimental-strip-types src/report.ts"`), `compat/README.md`

**Interfaces:**
- Consumes: vitest JSON results `compat/results.json`, `compat/.versions.json`.
- Produces: `renderMatrix(results: VitestJson, versions: Record<string,string>): string` → markdown; writes `compat/report.md`.

- [ ] **Step 1: Failing test** `report.test.ts`: given a minimal vitest JSON with tests titled `claude › roundtrip` (passed), `opencode › spawn (N/A: …)` (skipped), `pi › abort` (failed), `renderMatrix` returns a table whose rows are scenarios, columns Claude Code / OpenCode / Pi, cells `✅` / `N/A` / `❌`, plus a versions list. Run → FAIL.

- [ ] **Step 2: Implement `report.ts`** — parse `testResults[].assertionResults[]` (`title`, `status`), split title on ` › ` and `(N/A: `; build the table in scenario order of `Scenario`; footnote each N/A reason once. Main block: read the two files, write `report.md`, print it. Run → PASS.

- [ ] **Step 3: Workflow** `.github/workflows/compat.yml`

```yaml
name: Agent compatibility

on:
  workflow_dispatch:

jobs:
  compat:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: compat/package-lock.json
      - name: Start stack
        run: docker compose up -d --build
      - name: Install suite
        working-directory: compat
        run: npm ci
      - name: Run suite
        working-directory: compat
        run: npm test
      - name: Report
        if: always()
        working-directory: compat
        run: npm run report && cat report.md >> "$GITHUB_STEP_SUMMARY"
      - name: Collect logs
        if: failure()
        run: |
          mkdir -p compat/logs
          docker compose logs > compat/logs/compose.log 2>&1 || true
          docker compose exec -T cli sh -c 'tar czf - /tmp/compat-*.log ~/.happycc/logs 2>/dev/null' > compat/logs/cli.tgz || true
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: compat-logs
          path: compat/logs
          retention-days: 7
      - name: Stop stack
        if: always()
        run: docker compose down -v || true
```

- [ ] **Step 4: Full local run** — `docker compose down -v && docker compose up -d --build && cd compat && npm ci && npm test; npm run report` → `report.md` shows the matrix; every cell is ✅ or N/A with a reason (no ❌).

- [ ] **Step 5: Docs** — extend `compat/README.md` with: where `report.md` and the CI job summary show the matrix, what N/A means (evidence in `CAPABILITIES.md`), and how to bump a pin (edit the `Dockerfile.cli` ARG → `docker compose up -d --build` → `npm test` → update `CAPABILITIES.md` if a cell changes).

- [ ] **Step 6: Commit**

```bash
git add compat .github/workflows/compat.yml
git commit -m "ci: run the agent compatibility suite on demand and report the matrix"
```
