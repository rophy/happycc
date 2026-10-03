# Minimal Remote Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce happycc's remote surface to "start `happycc` on the workstation, control that session from the app" — by disabling (not deleting) the daemon, every non-allowlisted RPC, and the matching app UI.

**Architecture:** One session-RPC allowlist enforced at two choke points — the CLI session's `RpcHandlerManager` and the server's `rpc-register`/`rpc-call` relay. The daemon is never started. The app hides removed features behind one build-time flag (APP_CONFIG `features.workstationOnly`, default true) and stops issuing the implicit RPCs it used. Permission-mode changes from the app are capped at the session's starting mode.

**Tech Stack:** TypeScript, vitest, socket.io (server + CLI), Expo/React Native (app), Playwright (web e2e), docker compose + `compat/` suite.

**Spec:** `docs/superpowers/specs/2026-10-03-minimal-remote-control-design.md`

## Global Constraints

- Allowed session RPC methods — exactly: `permission`, `abort`, `killSession`, `switch`, `communication`.
- Disable at the boundary with small targeted edits; do not delete disabled code (upstream merges stay easy). Every removed path must be unreachable and covered by a test.
- All agent runners stay (Claude, Codex, Gemini, Agy, OpenClaw, ACP).
- The app may lower but never raise a session's permission mode above its starting mode.
- `happycc-agent` (`packages/happy-agent`) is internal: `"private": true`; its commands stay unchanged (used as refusal probes).
- Commit messages: `<type>: <description>` (feat/fix/refactor/chore/docs/build/test), 1–5 lines, no mention of "Claude" or "Happy" in any case (lowercase `happycc` ok), no co-author lines. GPG signing automatic; never disable.
- Never write private hostnames (jsgr.net, rophyinc.com, jsgr.xyz).
- Known pre-existing failures that may be left: app `sessionPresentation`; CLI `claude_version_utils` (host `/tmp/package.json`).

## Evidence (from the code, 2026-10-03)

- CLI session RPC choke point: `packages/happy-cli/src/api/apiSession.ts:271-277` builds the session `RpcHandlerManager` (scope = sessionId) and calls `registerCommonHandlers(..., metadata.path)`; `ApiSessionClient` is only built by `api.sessionSyncClient` (`api/api.ts:284`); the offline stub replays registrations into it (`utils/offlineSessionStub.ts`).
- Machine RPCs exist only in the daemon process (`api/apiMachine.ts`, constructed only from `daemon/run.ts:1029`).
- Daemon auto-start: `ensureDaemonRunning` (`daemon/ensureDaemonRunning.ts`) called from `index.ts:345,381,423,456,761` and `commands/codexCommand.ts:32`; `happycc daemon <sub>` dispatch at `index.ts:484-591`; `notifyDaemonSessionStarted` failures are tolerated at every call site.
- Permission-mode application points: Claude `claude/runClaude.ts:672-683` (`resolveRemoteClaudePermissionMode`); Codex `codex/runCodex.ts:302` (`remoteModeState.resolve`); Gemini `gemini/runGemini.ts:224-233`; Agy `agy/runAgy.ts:204-207`; ACP `agent/acp/runAcp.ts:853-854` (raw string, agent-defined). Starting modes: Claude `runClaude.ts:107-108`; Codex default `'auto'`; Gemini/ACP undefined; Agy `'default'`. Mode type `api/types.ts:41`.
- Server relay: `packages/happy-server/sources/app/api/socket/rpcHandler.ts` — `rpc-register` (130-143) accepts any non-empty method from any socket of the account (no check that `<sessionId>:` matches `socket.data.sessionId`); `rpc-call` (160-256) relays by room `rpc:<userId>:<method>`, error `'RPC method not available'`. `socket.data.clientType` ∈ `session-scoped|user-scoped|machine-scoped`, `socket.data.sessionId` set in `app/api/socket.ts:66-120`. No existing relay tests.
- App: all RPC wrappers in `packages/happy-app/sources/sync/ops.ts`. Implicit blocked calls: git status polling (`sync/gitStatusSync.ts:135-168` via `sessionBash`, triggered from `sync/sync.ts:368,2497,2598`), @-mention autocomplete (`sync/suggestionFile.ts:91` `sessionRipgrep`, from `-session/SessionView.tsx:1012`), worktree discovery (`utils/worktree.ts:127` `machineBash`, from `HomeDock.tsx:963`, `new/index.tsx:1042`), worktree cleanup on archive/kill (`info.tsx:142,173`, `useSessionQuickActions.ts:270`), avatar on session start (`useStartSessionFromDraft.ts:648`). Build-time flag pattern: `expoConfig.cjs:139` (`features.claudeConnect`) → `extra` → `sync/appConfig.ts` → `config.*`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/happy-cli/src/api/rpc/sessionRpcAllowlist.ts` (new) | `ALLOWED_SESSION_RPC_METHODS` + `isAllowedSessionRpcMethod` |
| `packages/happy-cli/src/api/apiSession.ts` | Wrap the session manager's `registerHandler` with the allowlist |
| `packages/happy-cli/src/daemon/ensureDaemonRunning.ts`, `src/index.ts` | Daemon never started; `happycc daemon` disabled |
| `packages/happy-cli/src/utils/permissionModeCeiling.ts` (new) | Mode rank + `capPermissionMode(requested, ceiling)` |
| CLI runners (5 files above) | Apply the cap where the app's mode is applied |
| `packages/happy-server/sources/app/api/socket/rpcAllowlist.ts` (new) | Server allowlist |
| `packages/happy-server/sources/app/api/socket/rpcHandler.ts` | Enforce on register + call |
| `packages/happy-app/expoConfig.cjs`, `sources/sync/appConfig.ts` | `features.workstationOnly` (default true) |
| App components/sync files listed in Task 6–7 | Hide entry points; stop implicit RPCs; cap mode picker |
| `packages/happy-agent/package.json` | `"private": true` |
| `compat/` | N/A for resume/spawn; new `blocked-rpc` scenario; no daemon in setup |
| `e2e/tests/*` | Hidden screens don't render |
| docs | deploy docs + compat README |

---

### Task 1: CLI session RPC allowlist

**Files:** Create `packages/happy-cli/src/api/rpc/sessionRpcAllowlist.ts`, `packages/happy-cli/src/api/rpc/sessionRpcAllowlist.test.ts`; Modify `packages/happy-cli/src/api/apiSession.ts`.

**Interfaces:** Produces `export const ALLOWED_SESSION_RPC_METHODS: readonly ['permission','abort','killSession','switch','communication']` and `export function isAllowedSessionRpcMethod(method: string): boolean`.

- [ ] **Step 1: Failing tests** — `sessionRpcAllowlist.test.ts`: the constant equals exactly the five methods (`toStrictEqual`); `isAllowedSessionRpcMethod` true for each, false for `bash`, `readFile`, `writeFile`, `listDirectory`, `getDirectoryTree`, `ripgrep`, `difftastic`, `goal-action`, `setAvatar`, `openclaw-retry-pairing`, `claude-fork-session`, `''`. Plus an `ApiSessionClient`-level test (follow the existing apiSession test style; build the client the same way existing tests do) asserting that after construction the session manager has registered **none** of the common handlers (`bash`, `readFile`, `writeFile`, `listDirectory`, `getDirectoryTree`, `ripgrep`, `difftastic`) and that registering `permission` works while registering `goal-action` is ignored.
- [ ] **Step 2:** Run `cd packages/happy-cli && npx vitest run --project unit src/api/rpc/sessionRpcAllowlist.test.ts <apiSession test>` → FAIL.
- [ ] **Step 3: Implement.**

```ts
// sessionRpcAllowlist.ts
/**
 * The only session RPCs a remote client may reach in the minimal build:
 * answer prompts, abort a turn, end the session, hand control between
 * terminal and app, answer agent questions. Everything else (shell, files,
 * fork/rewind, extras) is not registered.
 */
export const ALLOWED_SESSION_RPC_METHODS = ['permission', 'abort', 'killSession', 'switch', 'communication'] as const;

export function isAllowedSessionRpcMethod(method: string): boolean {
    return (ALLOWED_SESSION_RPC_METHODS as readonly string[]).includes(method);
}
```

In `apiSession.ts`, right after the session `RpcHandlerManager` is constructed (line ~271) and before `registerCommonHandlers(...)`, wrap its `registerHandler` so disallowed methods are dropped with a debug log:

```ts
const register = this.rpcHandlerManager.registerHandler.bind(this.rpcHandlerManager);
this.rpcHandlerManager.registerHandler = ((method: string, handler: Parameters<typeof register>[1]) => {
    if (!isAllowedSessionRpcMethod(method)) {
        logger.debug(`[rpc] not registering "${method}": not allowed in this build`);
        return;
    }
    register(method, handler);
}) as typeof this.rpcHandlerManager.registerHandler;
```

Keep the `registerCommonHandlers` call (it now registers nothing — dead code stays for upstream merges). Imports at the top of the file.
- [ ] **Step 4:** Tests pass; `npx tsc --noEmit` clean; full `npx vitest run --project unit` (known `claude_version_utils` failure only).
- [ ] **Step 5: Commit** `feat: register only allowlisted session RPCs in the CLI`.

---

### Task 2: No daemon

**Files:** Modify `packages/happy-cli/src/daemon/ensureDaemonRunning.ts`, `packages/happy-cli/src/index.ts`; Test: new `packages/happy-cli/src/daemon/daemonDisabled.test.ts`.

- [ ] **Step 1: Failing tests** — `ensureDaemonRunning()` resolves without spawning anything (spy/mock `spawnHappyCLI` from its module and assert it was never called); the CLI entry, run as `happycc daemon start` (and `status`, `list`, `stop`, `install`), prints `The background daemon is not available in this build.` to stderr and exits with code 1 — test by running the built bin like existing CLI tests do (find the pattern used by existing `index`/`cli` tests that spawn `bin/happy.mjs`; build first).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** — add `export const DAEMON_ENABLED = false;` (with a comment: the workstation-only build never runs the background daemon) in `ensureDaemonRunning.ts`; at the top of `ensureDaemonRunning` add `if (!DAEMON_ENABLED) { logger.debug('[daemon] not started: not available in this build'); return; }` and leave the original body below it unchanged. In `index.ts`, at the start of the `daemon` subcommand branch (line ~484), print the message and `process.exit(1)` before dispatching subcommands. Do not touch the six `ensureDaemonRunning` call sites.
- [ ] **Step 4:** Tests pass; tsc clean; unit suite.
- [ ] **Step 5: Commit** `feat: never start the background daemon`.

---

### Task 3: Permission-mode ceiling

**Files:** Create `packages/happy-cli/src/utils/permissionModeCeiling.ts`, `.test.ts`; Modify `claude/runClaude.ts`, `codex/runCodex.ts`, `gemini/runGemini.ts`, `agy/runAgy.ts`, `agent/acp/runAcp.ts`.

**Interfaces:** `export function permissionModeRank(mode: string): number | undefined`; `export function capPermissionMode(requested: string, ceiling: string | undefined): { mode: string; capped: boolean }`.

Rank (lower = safer): `plan`=0, `read-only`=0, `default`=1, `auto`=1, `acceptEdits`=2, `safe-yolo`=2, `bypassPermissions`=3, `yolo`=3. Unknown modes have no rank.

Rules: `ceiling` undefined → treat as `default`. If `requested` has no rank, or its rank > rank(ceiling) → `{ mode: ceiling ?? 'default', capped: true }`. Otherwise `{ mode: requested, capped: false }`.

- [ ] **Step 1: Failing tests** — table-driven: raise refused (default→yolo, default→bypassPermissions, auto→acceptEdits, read-only→safe-yolo), lower honored (bypassPermissions→default, yolo→read-only), equal honored, unknown requested refused (`'turbo'`), undefined ceiling = default.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement the helper.
- [ ] **Step 4: Apply at each runner** — at the point where the app's `message.meta.permissionMode` is turned into the session's new mode (Evidence lines), pass it through `capPermissionMode(requested, startingMode)`; when `capped`, keep the session's current mode and log to the terminal once per request: `Ignored a request from the app to raise the permission mode to <requested>.` (use the runner's existing user-facing log/print helper). `startingMode` is the mode resolved at session start (Evidence). For ACP, where modes are agent-defined, only the ranked names above can be applied from the app; unranked names are ignored (capped).
- [ ] **Step 5:** Add one focused test per runner where an existing test harness makes it cheap (e.g. Claude `resolveRemoteClaudePermissionMode` tests, Codex `remoteModeState` tests); otherwise rely on the helper tests and list the untested call sites in the report.
- [ ] **Step 6:** tsc clean; unit suite. **Commit** `feat: never let the app raise a session's permission mode`.

---

### Task 4: Server RPC allowlist (register + call)

**Files:** Create `packages/happy-server/sources/app/api/socket/rpcAllowlist.ts`, `rpcHandler.spec.ts`; Modify `rpcHandler.ts` (and `app/api/socket.ts` only if the handler needs `socket.data` passed — it already receives `socket`).

**Interfaces:** `export const ALLOWED_SESSION_RPC_METHODS` (same five) and `export function isAllowedRpc(method: string, socketData: { clientType?: string; sessionId?: string }, mode: 'register' | 'call'): boolean`.

Rules:
- `register`: allowed only when `clientType === 'session-scoped'`, the method is `${socketData.sessionId}:${m}` with `m` allowlisted. Machine-scoped and user-scoped sockets may not register anything.
- `call`: allowed only for `<id>:<m>` with `m` allowlisted (the room lookup already scopes to the caller's account).
- Refused register → emit the existing `rpc-error {type:'register', error:'RPC method not allowed'}` and do not join. Refused call → `callback({ ok: false, error: 'RPC method not available' })` without relaying (same text as an absent method, so callers cannot probe).

- [ ] **Step 1: Failing tests** — unit-test `isAllowedRpc` exhaustively (allowed/denied per clientType; prefix mismatch `otherSession:permission` refused; machine-scoped `m1:spawn-happy-session` refused; user-scoped register refused; call `s1:bash` refused, `s1:abort` allowed). Then handler-level tests with a fake `socket`/`io` that captures `socket.on` handlers (see `app/api/routes/v3SessionRoutes.test.ts` for fake patterns): register refused → no `join`, `rpc-error` emitted; call refused → callback with `'RPC method not available'`, no `fetchSockets`.
- [ ] **Step 2:** Run `cd packages/happy-server && npx vitest run sources/app/api/socket/` → FAIL. **Step 3:** Implement (one check at the top of each of the two handlers).
- [ ] **Step 4:** Server typecheck + full server tests pass.
- [ ] **Step 5: Commit** `feat: relay only allowlisted session RPCs and bind registration to the session`.

---

### Task 5: App flag + hide entry points

**Files:** Modify `packages/happy-app/expoConfig.cjs` (+ its tests), `sources/sync/appConfig.ts`, `deploy/app-config/org.example.json`, `docs/deploy-app.md`, and the components listed below.

- [ ] **Step 1: Flag** — add `features.workstationOnly: 'boolean'` to `APP_CONFIG_SCHEMA` (default **true** when absent), expose as `extra.app.workstationOnly`, add to `AppConfig` and the example config/docs ("When true (default) the app can only control sessions started with `happycc` on a workstation"). Test in expoConfig tests: default true, explicit false respected.
- [ ] **Step 2: Hide entry points when `config.workstationOnly`** (render nothing / early-return the route with a short "Not available in this build" screen for routes):
  - Routes: `app/(app)/new/index.tsx`, `app/(app)/machine/[id].tsx`, `app/(app)/session/[id]/files.tsx`, `.../file.tsx`, `.../changes.tsx`.
  - New-session buttons: `EmptyMainScreen.tsx:126` (keep the install/sign-in instructions; drop the button), `HomeHeader.tsx:91`, `MainView.tsx:211` and HomeDock at `MainView.tsx:390`, `SidebarView.tsx:100`, `ProjectHomeList.tsx:458`, `EmptySessionsTablet.tsx:70`, `ProjectGroup.tsx:106`, `ActiveSessionsGroupCompact.tsx:88`, `CommandPalette/CommandPaletteProvider.tsx:54,150`, `WorktreeTabStrip.tsx:113`.
  - Machine links: `session/[id]/info.tsx:249`, `troubleshoot.tsx:111`, `settings/agents.tsx:215`, `SessionsList.tsx:284`, `ActiveSessionsGroupCompact.tsx:153`.
  - Files/changes: `info.tsx:242`, `SessionView.tsx:1006` (+ the gate at :1133), inline panels `SessionView.tsx:574,593,603`, `FilesSidebar.tsx:252`, `ToolView.tsx:53` (file links become plain text).
  - Resume/fork/duplicate/rewind/side chat: `useSessionQuickActions.ts:339-346` (omit those actions), `info.tsx:252,265,274`, `SessionView.tsx:285`.
  - Goal bar: `SessionView.tsx:1180`.
  The empty state copy: "Start `happycc` in a folder on your workstation; the session appears here."
- [ ] **Step 3: Tests** — component/unit tests where the app already has them for these components (follow existing test patterns, e.g. quick-actions hook tests) asserting the entries are absent when the flag is true; tsc clean; app vitest (known `sessionPresentation` only).
- [ ] **Step 4: Commit** `feat: hide session start, machines, files and fork in the workstation-only app`.

---

### Task 6: App — stop implicit blocked RPCs + cap the mode picker

**Files:** `sources/sync/sync.ts` (git status invalidation sites 368, 2497, 2598), `sources/sync/gitStatusSync.ts`, `sources/sync/suggestionFile.ts`, `sources/components/HomeDock.tsx:963`, `sources/app/(app)/new/index.tsx:1042`, `sources/utils/worktree.ts` callers (`info.tsx:142,173`, `useSessionQuickActions.ts:270`), `sources/hooks/useStartSessionFromDraft.ts:648`, `sources/components/AgentInput.tsx` (mode list :1828, Shift+Tab :1437-1440), `sources/-session/SessionView.tsx:907`.

- [ ] **Step 1:** When `config.workstationOnly`: git status sync never issues `sessionBash` (the store keeps "no git status"); file suggestions return no file results (no `sessionRipgrep`); worktree discovery/cleanup never call `machineBash`; avatar step skipped. Put each guard at the function that issues the RPC (one line each), so all callers are covered.
- [ ] **Step 2:** Mode picker: only offer modes whose rank (same table as Task 3 — copy the table into a small `sources/utils/permissionModeRank.ts` with a test) is ≤ the rank of the session's starting mode (`metadata` starting/current mode as the app knows it; if unknown, `default`). Shift+Tab cycles only within that set.
- [ ] **Step 3: Tests** — unit tests for each guard (RPC wrapper not called when the flag is true; called when false) and the mode filter; tsc; app vitest.
- [ ] **Step 4: Commit** `fix: stop issuing shell and file calls from the workstation-only app`.

---

### Task 7: happycc-agent private + compatibility suite

**Files:** `packages/happy-agent/package.json`; `compat/src/agents.ts`, `compat/src/globalSetup.ts`, `compat/src/session.ts`, `compat/tests/remote-control.test.ts`, new `compat/tests/boundary.test.ts`, `compat/CAPABILITIES.md`, `compat/README.md`.

- [ ] **Step 1:** `"private": true` in `packages/happy-agent/package.json`.
- [ ] **Step 2:** Remove the daemon from the suite: globalSetup no longer runs `happycc daemon start`; anything that relied on the daemon (spawn, resume, machine lookup for spawn) changes accordingly. `cliMachineId` may stay if sessions still record a machine id; otherwise drop its uses.
- [ ] **Step 3:** `resume` and `spawn` become N/A for all agents with reason "Removed in the workstation-only build: the app cannot start or resume sessions."
- [ ] **Step 4: New scenario `blocked-rpc`** (`compat/tests/boundary.test.ts`, `forEachAgent('blocked-rpc', …)`, add `'blocked-rpc'` to `Scenario` and the report row order after `kill`): with a live session, (a) `happycc-agent spawn <any machine id> --path /workspace --agent claude` fails with "not available"/"not allowed"; (b) a session RPC outside the allowlist fails — add an internal `happycc-agent rpc <session-id> <method> [json-params]` command (prints the decrypted result as JSON; exits non-zero with the error message on failure; unit-test its argument parsing) that calls `callSessionRpc`, and assert `happycc-agent rpc <id> bash '{"command":"id"}'` fails with `RPC method not available`; (c) afterwards `compat:hello` still gets `COMPAT-HELLO-OK`.
- [ ] **Step 5:** Update `report.ts` row order/tests for `blocked-rpc`; update CAPABILITIES.md and README.
- [ ] **Step 6:** Rebuild stack (`docker compose up -d --build`), run full suite + report; all cells ✅ / N/A / known-bug, 0 FAILED.
- [ ] **Step 7: Commit** `test: prove the workstation-only boundary in the compat suite`.

---

### Task 8: Web e2e + docs

**Files:** `e2e/tests/*.spec.ts` (new `workstation-only.spec.ts`), `docs/deploy-app.md`, `docs/deployment.md` (server RPC allowlist note), `packages/happy-cli/README.md` (no daemon; `happycc daemon` unavailable).

- [ ] **Step 1:** Playwright: signed in as alice, `/new` and a `/machine/x` URL show "Not available in this build"; the home screen has no "New session"/"Start New Session" control. Run with the compose `e2e` profile.
- [ ] **Step 2:** Docs updated.
- [ ] **Step 3: Commit** `docs: describe the workstation-only build` (and `test:` for the e2e file if separate).
