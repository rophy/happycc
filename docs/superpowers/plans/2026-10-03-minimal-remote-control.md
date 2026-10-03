# Minimal Remote Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app can control sessions started with `happycc` on a workstation but can never start sessions itself; the daemon (remote spawn/resume/fork and unrestricted machine-wide shell/files) is disabled.

**Architecture:** Disable at the boundary: the daemon is never started (so no machine RPC ever exists), the server binds RPC registration to the registering session socket, the app hides session-creation UI behind one build-time flag, and permission-mode changes from the app are capped at the session's starting mode. Session-scoped features stay untouched.

**Tech Stack:** TypeScript, vitest, socket.io (server + CLI), Expo/React Native (app), Playwright (web e2e), docker compose + `compat/` suite.

**Spec:** `docs/superpowers/specs/2026-10-03-minimal-remote-control-design.md`

## Global Constraints

- Keep every session-scoped RPC and session feature (chat, permissions, questions, abort/end, git status, diffs, file viewer, file suggestions).
- Remove only session creation from the app and the daemon (machine-level RPCs).
- Disable at the boundary with small targeted edits; do not delete disabled code. Every removed path is unreachable and covered by a test.
- All agent runners stay (Claude, Codex, Gemini, Agy, OpenClaw, ACP).
- The app may lower but never raise a session's permission mode above its starting mode. Ranking (lower = safer): `plan`=0, `read-only`=0, `default`=1, `auto`=1, `acceptEdits`=2, `safe-yolo`=2, `bypassPermissions`=3, `yolo`=3; unranked modes requested by the app are ignored.
- Server: only `clientType === 'session-scoped'` sockets may `rpc-register`, and only `<socket.data.sessionId>:<method>`; refused with `rpc-error {type:'register', error:'RPC method not allowed'}`.
- `happycc-agent` is internal: `"private": true`; commands unchanged.
- Commit messages: `<type>: <description>` (feat/fix/refactor/chore/docs/build/test), 1–5 lines, no mention of "Claude" or "Happy" in any case (lowercase `happycc` ok), no co-author lines. GPG signing automatic; never disable.
- Never write private hostnames (jsgr.net, rophyinc.com, jsgr.xyz).
- Known pre-existing failures that may be left: app `sessionPresentation`; CLI `claude_version_utils` (host `/tmp/package.json`).

## Evidence (from the code, 2026-10-03)

- Machine RPCs (spawn/resume/stop-session/stop-daemon/fork/duplicate/rewind + unrestricted common handlers) are registered only by the daemon (`packages/happy-cli/src/api/apiMachine.ts`, constructed only from `daemon/run.ts:1029`).
- Daemon auto-start: `ensureDaemonRunning` (`daemon/ensureDaemonRunning.ts`) called from `index.ts:345,381,423,456,761` and `commands/codexCommand.ts:32`; `happycc daemon <sub>` dispatch at `index.ts:484-591`; `notifyDaemonSessionStarted` failures tolerated at every call site.
- Permission-mode application points: Claude `claude/runClaude.ts:672-683` (`resolveRemoteClaudePermissionMode`); Codex `codex/runCodex.ts:302` (`remoteModeState.resolve`, `codex/remoteModeState.ts:52-60`); Gemini `gemini/runGemini.ts:224-233`; Agy `agy/runAgy.ts:204-207`; ACP `agent/acp/runAcp.ts:853-854` → `switchPermissionModeIfRequested` (:606-621). Starting modes: Claude `runClaude.ts:107-108`; Codex default `'auto'` (`runCodex.ts:93,162`); Gemini undefined; Agy `'default'` (`runAgy.ts:125`); ACP undefined (`runAcp.ts:525`). Mode type `api/types.ts:41`.
- Server: `packages/happy-server/sources/app/api/socket/rpcHandler.ts` `rpc-register` (130-143) accepts any non-empty method from any socket of the account; handler gets `socket` (`socket.data.clientType`, `socket.data.sessionId` set in `app/api/socket.ts:66-120`). No existing relay tests; fake-socket patterns in `app/api/routes/v3SessionRoutes.test.ts`.
- App entry points that create sessions or use machines (paths under `packages/happy-app/sources/`):
  - Routes: `app/(app)/new/index.tsx`, `app/(app)/machine/[id].tsx`.
  - New-session buttons: `components/EmptyMainScreen.tsx:126`, `HomeHeader.tsx:91`, `MainView.tsx:211` + HomeDock `MainView.tsx:390` (spawns via `hooks/useStartSessionFromDraft.ts`), `SidebarView.tsx:100`, `ProjectHomeList.tsx:458`, `EmptySessionsTablet.tsx:70`, `ProjectGroup.tsx:106`, `ActiveSessionsGroupCompact.tsx:88`, `CommandPalette/CommandPaletteProvider.tsx:54,150`, `WorktreeTabStrip.tsx:113`.
  - Machine links: `app/(app)/session/[id]/info.tsx:249`, `troubleshoot.tsx:111`, `settings/agents.tsx:215`, `SessionsList.tsx:284`, `ActiveSessionsGroupCompact.tsx:153`.
  - Resume/fork/duplicate/rewind/side chat: `hooks/useSessionQuickActions.ts:339-346` (rendered via `SessionActionsPopover.tsx:163`), `info.tsx:252,265,274`, `components/DuplicateSheet.tsx`, `-session/SessionView.tsx:285` (side chat).
  - Daemon shell use: `utils/worktree.ts` (`machineBash`) from `HomeDock.tsx:963`, `new/index.tsx:1042`, `hooks/useWorktreeCleanup.ts:45`, `info.tsx:142,173`, `useSessionQuickActions.ts:270`.
  - Mode picker: `components/AgentInput.tsx` (list :1828, Shift+Tab :1437-1440, handler :1222); `SessionView.tsx:907` → `sessionSetAgentModes`; sent as `meta.permissionMode` (`sync/sync.ts:868`).
  - Build-time flag pattern: `expoConfig.cjs:139` (`features.claudeConnect`) → `extra` (:399) → `sync/appConfig.ts:8` → `config.*`.

---

### Task 1: No daemon

**Files:** Modify `packages/happy-cli/src/daemon/ensureDaemonRunning.ts`, `packages/happy-cli/src/index.ts`; Create `packages/happy-cli/src/daemon/daemonDisabled.test.ts`.

- [ ] **Step 1: Failing tests** — (a) `ensureDaemonRunning()` resolves without spawning: mock the module that exports `spawnHappyCLI` and assert it was never called; (b) the built CLI run as `happycc daemon start` (and `status`, `list`, `stop`, `install`) prints `The background daemon is not available in this build.` to stderr and exits 1 — run the built bin the way existing CLI tests that spawn `bin/happy.mjs` do (build first).
- [ ] **Step 2:** Run `cd packages/happy-cli && pnpm run build && npx vitest run --project unit src/daemon/daemonDisabled.test.ts` → FAIL.
- [ ] **Step 3: Implement** — in `ensureDaemonRunning.ts` add `export const DAEMON_ENABLED = false;` with a comment (the workstation-only build never runs the background daemon: no remote spawn/resume and no machine-wide RPCs) and at the top of `ensureDaemonRunning` add `if (!DAEMON_ENABLED) { logger.debug('[daemon] not started: not available in this build'); return; }`, leaving the original body below. In `index.ts`, at the start of the `daemon` subcommand branch (~484), print the message to stderr and `process.exit(1)`. Do not touch the six `ensureDaemonRunning` call sites.
- [ ] **Step 4:** Tests pass; `npx tsc --noEmit` clean; `npx vitest run --project unit` (known failure only). Check `happycc doctor` and any command that reads daemon state still runs without error (report what it prints).
- [ ] **Step 5: Commit** `feat: never start the background daemon`.

---

### Task 2: Permission-mode ceiling (CLI)

**Files:** Create `packages/happy-cli/src/utils/permissionModeCeiling.ts`, `permissionModeCeiling.test.ts`; Modify `claude/runClaude.ts`, `codex/runCodex.ts` (or `codex/remoteModeState.ts`), `gemini/runGemini.ts`, `agy/runAgy.ts`, `agent/acp/runAcp.ts`.

**Interfaces:** `export function permissionModeRank(mode: string): number | undefined`; `export function capPermissionMode(requested: string, ceiling: string | undefined): { mode: string; capped: boolean }`.

- [ ] **Step 1: Failing tests** (table-driven):

```ts
import { describe, it, expect } from 'vitest';
import { capPermissionMode, permissionModeRank } from './permissionModeCeiling';

describe('capPermissionMode', () => {
    it.each([
        ['yolo', 'default', 'default', true],
        ['bypassPermissions', 'default', 'default', true],
        ['acceptEdits', 'auto', 'auto', true],
        ['safe-yolo', 'read-only', 'read-only', true],
        ['default', 'bypassPermissions', 'default', false],
        ['read-only', 'yolo', 'read-only', false],
        ['acceptEdits', 'acceptEdits', 'acceptEdits', false],
        ['turbo', 'yolo', 'yolo', true],
        ['acceptEdits', undefined, 'default', true],
        ['plan', undefined, 'plan', false],
    ])('requested %s with ceiling %s → %s (capped=%s)', (requested, ceiling, mode, capped) => {
        expect(capPermissionMode(requested, ceiling)).toEqual({ mode, capped });
    });
    it('ranks known modes and not unknown ones', () => {
        expect(permissionModeRank('plan')).toBe(0);
        expect(permissionModeRank('yolo')).toBe(3);
        expect(permissionModeRank('turbo')).toBeUndefined();
    });
});
```

- [ ] **Step 2:** Run → FAIL. **Step 3: Implement:**

```ts
/**
 * Permission modes ranked from safest to most permissive, across agent families.
 * A session's starting mode is its ceiling: the app may lower it, never raise it.
 */
const RANK: Record<string, number> = {
    plan: 0, 'read-only': 0,
    default: 1, auto: 1,
    acceptEdits: 2, 'safe-yolo': 2,
    bypassPermissions: 3, yolo: 3,
};

export function permissionModeRank(mode: string): number | undefined {
    return RANK[mode];
}

export function capPermissionMode(requested: string, ceiling: string | undefined): { mode: string; capped: boolean } {
    const limit = ceiling ?? 'default';
    const requestedRank = permissionModeRank(requested);
    const limitRank = permissionModeRank(limit) ?? RANK.default;
    if (requestedRank === undefined || requestedRank > limitRank) {
        return { mode: limit, capped: true };
    }
    return { mode: requested, capped: false };
}
```

- [ ] **Step 4: Apply at each runner** (Evidence lines): pass the app's requested mode through `capPermissionMode(requested, startingMode)` where it becomes the session's new mode. When `capped`, keep the session's current mode (not the ceiling, if current is lower) — i.e. ignore the request — and print once per request via the runner's existing user-facing output: `Ignored a request from the app to raise the permission mode to <requested>.` `startingMode` is the mode resolved at session start; for runners whose starting mode is undefined use `'default'`. For ACP the app's raw string is only applied if `capped === false`.
- [ ] **Step 5: Tests per runner** where an existing harness makes it cheap (e.g. `resolveRemoteClaudePermissionMode` tests, `remoteModeState` tests, gemini/agy/acp permission tests); list any call site left without a direct test in the report.
- [ ] **Step 6:** tsc clean; unit suite. **Commit** `feat: never let the app raise a session's permission mode`.

---

### Task 3: Server — bind RPC registration to the session socket

**Files:** Create `packages/happy-server/sources/app/api/socket/rpcRegistration.ts`, `rpcRegistration.spec.ts`, `rpcHandler.spec.ts`; Modify `rpcHandler.ts`.

**Interfaces:** `export function canRegisterRpc(method: string, socketData: { clientType?: string; sessionId?: string }): boolean`.

- [ ] **Step 1: Failing tests** — `canRegisterRpc`: true for session-scoped `s1` registering `s1:permission`, `s1:bash`, `s1:goal-action`; false for `s2:permission` from `s1`, for a method with no `:` prefix, for machine-scoped (`m1:spawn-happy-session`), for user-scoped (`s1:permission`), for missing sessionId. Handler test with a fake `socket`/`io` capturing `socket.on` handlers: refused register → no `socket.join`, emits `rpc-error` `{ type: 'register', error: 'RPC method not allowed' }`; allowed → joins `rpc:<userId>:<method>` and emits `rpc-registered` as today.
- [ ] **Step 2:** Run `cd packages/happy-server && npx vitest run sources/app/api/socket/` → FAIL.
- [ ] **Step 3: Implement**:

```ts
// rpcRegistration.ts
/**
 * Only a CLI session socket may register RPC methods, and only for its own
 * session. Machine-scoped (daemon) and user-scoped (app) sockets may not, so a
 * client cannot register — and intercept — another session's methods.
 */
export function canRegisterRpc(method: string, socketData: { clientType?: string; sessionId?: string }): boolean {
    if (socketData.clientType !== 'session-scoped' || !socketData.sessionId) {
        return false;
    }
    return method.startsWith(`${socketData.sessionId}:`) && method.length > socketData.sessionId.length + 1;
}
```

In `rpcHandler.ts` `rpc-register`, after the existing non-empty check: `if (!canRegisterRpc(method, socket.data)) { socket.emit('rpc-error', { type: 'register', error: 'RPC method not allowed' }); return; }`. `rpc-unregister` unchanged. `rpc-call` unchanged.
- [ ] **Step 4:** Server typecheck + full server tests pass. Also confirm the CLI session socket connects with `clientType: 'session-scoped'` and `sessionId` (cite the CLI code) so real registrations still work.
- [ ] **Step 5: Commit** `fix: only let a session's own socket register its RPC methods`.

---

### Task 4: App — hide session creation and machine features; cap the mode picker

**Files:** `packages/happy-app/expoConfig.cjs` (+ tests), `sources/sync/appConfig.ts`, `deploy/app-config/org.example.json`, `docs/deploy-app.md`, the components in Evidence, new `sources/utils/permissionModeRank.ts` (+ test).

- [ ] **Step 1: Flag** — `features.workstationOnly: 'boolean'` in `APP_CONFIG_SCHEMA`, default **true** when absent, exposed as `extra.app.workstationOnly`, typed in `AppConfig`; example config + docs ("When true (default), the app only controls sessions started with `happycc` on a workstation; it cannot start, resume, fork or duplicate sessions"). expoConfig tests: default true; explicit false respected.
- [ ] **Step 2: Hide when `config.workstationOnly`** — routes `new/index.tsx` and `machine/[id].tsx` render a short "Not available in this build" screen; all new-session buttons, machine links, resume/fork/duplicate/rewind actions (`useSessionQuickActions` omits them; `info.tsx` entries hidden), `DuplicateSheet`, side chat (`SessionView.tsx:285`) hidden or no-op. The empty state (`EmptyMainScreen`) keeps the install/sign-in instructions and says: "Start `happycc` in a folder on your workstation; the session appears here."
- [ ] **Step 3: Worktree shell calls** — guard the functions in `utils/worktree.ts` / `useWorktreeCleanup.ts` that call `machineBash` so they do nothing when the flag is true (one guard per RPC-issuing function, covering all callers).
- [ ] **Step 4: Mode picker** — `sources/utils/permissionModeRank.ts` with the same ranking table (Global Constraints) and a test; `AgentInput` offers only modes ranked ≤ the session's starting mode (from session metadata as the app knows it; unknown → `default`), and Shift+Tab cycles within that set. Session files/diffs/git status/suggestions are NOT changed.
- [ ] **Step 5: Tests** — component/hook tests following existing patterns for quick actions and the mode list; tsc clean; app vitest (known `sessionPresentation` only).
- [ ] **Step 6: Commit** `feat: the workstation-only app cannot start sessions or use machines`.

---

### Task 5: happycc-agent private + compatibility suite

**Files:** `packages/happy-agent/package.json`; `compat/src/agents.ts`, `compat/src/globalSetup.ts`, `compat/src/session.ts`, `compat/src/report.ts` (+ test), `compat/tests/remote-control.test.ts`, new `compat/tests/boundary.test.ts`, `compat/CAPABILITIES.md`, `compat/README.md`.

- [ ] **Step 1:** `"private": true` in `packages/happy-agent/package.json`.
- [ ] **Step 2:** globalSetup no longer runs `happycc daemon start`; remove other daemon dependencies in the suite.
- [ ] **Step 3:** `resume` and `spawn` become N/A for all agents: "Removed in the workstation-only build: the app cannot start or resume sessions."
- [ ] **Step 4: New scenario `blocked-spawn`** (`compat/tests/boundary.test.ts`, add to `Scenario`, report row after `kill`): with a live session on `cli`, `happycc-agent spawn <cli machine id> --path /workspace --agent claude` fails (exit non-zero, message contains "not available" or "offline"), `happycc-agent resume <session id>` fails likewise, and afterwards `compat:hello` still gets `COMPAT-HELLO-OK`.
- [ ] **Step 5:** Rebuild (`docker compose up -d --build`), run the full suite + `npm run report`: every cell ✅ / N/A / known bug; 0 FAILED. Update CAPABILITIES.md (scenarios 7–8 → N/A by design; new boundary section) and README.
- [ ] **Step 6: Commit** `test: prove the app cannot start sessions in the compat suite`.

---

### Task 6: Web e2e + docs

**Files:** new `e2e/tests/workstation-only.spec.ts`; `docs/deploy-app.md`, `docs/deployment.md`, `packages/happy-cli/README.md`.

- [ ] **Step 1:** Playwright (compose `e2e` profile): signed in as alice, `/new` and `/machine/x` show "Not available in this build"; the home screen has no "New session"/"Start New Session" control.
- [ ] **Step 2:** Docs: CLI README (no daemon; `happycc daemon` unavailable; sessions are started from the workstation), deployment docs (server binds RPC registration to the session socket), deploy-app (the flag).
- [ ] **Step 3: Commit** `docs: describe the workstation-only build` (and `test:` for the e2e file).
