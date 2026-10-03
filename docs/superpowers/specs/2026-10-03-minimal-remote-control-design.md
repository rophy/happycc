# Minimal Remote Control — Design

Status: approved in brainstorming, pending spec review
Scope: tighten happycc's security surface to two features, by removing (disabling) everything else.

## Goal

happycc does exactly two things:

1. A user starts `happycc` (any agent) in a folder on their workstation; that terminal process **is** the session.
2. The user controls **that running session** from the mobile/web app.

Nothing else is reachable remotely: the app cannot start, resume, fork or rewind sessions, pick folders,
run shell commands, or read/write files. This is close to Claude Code Remote Control
(https://code.claude.com/docs/en/remote-control.md), whose remote clients are confined to sessions
started on the workstation and have no remote shell or file access.

## Decisions

| Topic | Decision |
|---|---|
| Control in a session | Chat (send, read replies), answer permission prompts and agent questions, abort the current turn, end the session. No file browsing, shell, or diff/changes view. |
| Daemon | Removed: never started, `happycc daemon …` disabled. No machine-level RPCs exist. |
| Agents | All runners stay (Claude Code, Codex, Gemini, Agy, OpenClaw, ACP incl. OpenCode/Pi). No re-architecture. |
| Removal method | Disable at the boundary with small targeted edits; dead code stays in tree so upstream merges stay easy. Removed paths must be unreachable and proven so by tests. |
| Permission mode | The app may lower a session's permission mode but never raise it above the mode the session started with. |
| `happycc-agent` | Internal test tool only: `"private": true`, never published. Keeps its `spawn`/`resume`/`machines`/`create` commands as probes for negative tests. |

## Remote surface: the RPC allowlist

Every remote action is an `rpc-call` that the server relays to the CLI. Allowed session methods:

| Method | Purpose |
|---|---|
| `permission` | Approve or deny a permission prompt |
| `abort` | Abort the current turn |
| `killSession` | End the session |
| `switch` | Claude Code: hand control between terminal and app (required for the app to drive the session) |
| `communication` | Answer or dismiss an agent question (form) |

Everything else is not allowed, including (non-exhaustive) `bash`, `readFile`, `writeFile`, `listDirectory`,
`getDirectoryTree`, `ripgrep`, `difftastic`, `spawn-happy-session`, `resume-happy-session`, `stop-session`,
`stop-daemon`, `claude-fork-session`, `claude-duplicate-session`, `claude-list-rewind-points`,
`codex-fork-thread`, `codex-duplicate-thread`, `codex-list-rewind-points`, `goal-action`, `setAvatar`,
`openclaw-retry-pairing`.

The allowlist is enforced in two places (defense in depth):

1. **CLI** — session RPC registration only accepts allowlisted methods: a single filter at the point where
   a session's handlers are registered (the per-runner `registerHandler` calls stay as they are; disallowed
   ones become no-ops with a debug log). With no daemon, no machine handlers are ever registered.
2. **Server** — the `rpc-call` relay (`packages/happy-server/sources/app/api/socket/rpcHandler.ts`) accepts only
   `<sessionId>:<allowlisted method>` where `<sessionId>` is a session of the caller's account; any other
   method, including anything addressed to a machine id, is answered with the existing
   "RPC method not available" error without being relayed.

The allowlist is one shared constant per package (CLI, server), with a test in each asserting its exact contents.

## Workstation (CLI)

- **No daemon:** `happycc` (all agents) no longer auto-starts the daemon; `happycc daemon <anything>` prints
  "The background daemon is not available in this build." and exits non-zero. Session start no longer waits on
  or notifies a daemon (those calls are already best-effort).
- **Allowlisted session RPCs** as above.
- **Permission-mode ceiling:** the mode a session starts with (default, or set by a CLI flag) is its ceiling.
  When a message from the app requests a more permissive mode, the session keeps its current mode and logs
  "Ignored a request from the app to raise the permission mode to <mode>." Lowering is honored. The ordering is
  defined per agent family where modes differ (Claude: `plan` < `default` < `acceptEdits` < `bypassPermissions`;
  other agents map their modes onto the same scale; exact mapping recorded in the plan from the code).
- Local terminal mode, offline reconnection, and every runner otherwise unchanged.

## App (mobile + web)

Hidden (gated like the earlier voice removal, not deleted):

- New session (from the app), the machine picker and machine screens.
- File browser, changes/diff views, terminal/shell views.
- Fork, duplicate, rewind.
- Goal actions, avatar setting, OpenClaw pairing retry.
- Prompts to start an agent "on your computer" from the app.
- Permission-mode options above the session's current mode.

The empty state tells the user to run `happycc` on their workstation. The session list shows sessions started
from workstations as before.

## happycc-agent

- `packages/happy-agent/package.json`: `"private": true`; it is not part of any release workflow.
- Command set unchanged. `spawn`, `resume`, `machines`, `create` remain as probes, so tests can assert the
  removed features are refused (server: "RPC method not available"). Session creation by
  non-CLI clients stays allowed (open question 1, resolved).

## Testing

- **CLI unit:** the registered session handlers equal the allowlist exactly; `happycc daemon` is disabled;
  permission-mode ceiling (raise ignored, lower honored).
- **Server unit:** the relay rejects every non-allowlisted method and machine-addressed calls, and relays
  allowlisted ones.
- **Compatibility suite:** `resume` and `spawn` become N/A by design ("removed in the minimal build").
  New negative scenario `blocked-rpc` per agent: with a live session, the app side attempts a blocked call
  (e.g. `bash` through a session RPC probe, and `spawn` via `happycc-agent spawn`) and must get a refusal;
  the session keeps working afterwards.
- **Web e2e:** the hidden screens do not render (new session, machine picker, file browser).

## Open questions (resolved in the plan, with evidence from the code)

1. ~~Session creation from non-CLI clients~~ — **resolved: leave as is.** A session created without an agent
   (e.g. `happycc-agent create`) is inert: nothing runs it and no RPC reaches a workstation.
2. **To be settled in the plan from the code:** whether any app screen relies on `bash`/`readFile` for read-only display that users would miss (e.g. CLI
   version detection uses `bash` with cwd `/`); if so, list it and confirm removal.

## Out of scope

- Workspace roots/allowed folders (unnecessary: the app cannot start sessions).
- Trusted-device enrollment, periodic re-authentication, admin on/off switch.
- Permission-prompt expiry.
- Deleting the disabled code.
