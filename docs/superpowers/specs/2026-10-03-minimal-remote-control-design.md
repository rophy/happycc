# Minimal Remote Control — Design

Status: approved in brainstorming (revised 2026-10-03: session features kept; only session creation removed)
Scope: the app can control sessions started on a workstation, but can never start sessions by itself.

## Goal

happycc does exactly two things:

1. A user starts `happycc` (any agent) in a folder on their workstation; that terminal process **is** the session.
2. The user controls **that running session** from the mobile/web app.

The app cannot start sessions: no new session, remote spawn on a machine, resume, fork, duplicate or rewind
(all of which create sessions). Everything a running session offers stays (chat, permission prompts, agent
questions, abort/end, git status, diffs, file viewer, file suggestions) — those are scoped to the session's
folder. This mirrors Claude Code Remote Control's boundary (https://code.claude.com/docs/en/remote-control.md):
remote clients act only on sessions started on the workstation.

## Decisions

| Topic | Decision |
|---|---|
| Session features | Unchanged: all session-scoped RPCs stay (`permission`, `abort`, `killSession`, `switch`, `communication`, `bash`/`readFile`/`writeFile`/`listDirectory`/`getDirectoryTree`/`ripgrep`/`difftastic` scoped to the session path, `goal-action`, `setAvatar`, `openclaw-retry-pairing`). |
| Daemon | Removed: never started, `happycc daemon …` disabled. This removes every machine-level RPC: `spawn-happy-session`, `resume-happy-session`, `stop-session`, `stop-daemon`, fork/duplicate/rewind (`claude-*`, `codex-*`), and the machine-wide, unrestricted `bash`/`readFile`/`writeFile`/`listDirectory`/`getDirectoryTree`/`ripgrep`/`difftastic`. |
| Agents | All runners stay (Claude Code, Codex, Gemini, Agy, OpenClaw, ACP incl. OpenCode/Pi). No re-architecture. |
| Removal method | Disable at the boundary with small targeted edits; dead code stays in tree so upstream merges stay easy. Removed paths must be unreachable and proven so by tests. |
| Permission mode | The app may lower a session's permission mode but never raise it above the mode the session started with. |
| Server RPC registration | Bound to the registering socket: only a session-scoped socket (a CLI session) may register, and only methods prefixed with its own session id. Machine-scoped and user-scoped sockets may not register. |
| `happycc-agent` | Internal test tool only: `"private": true`, never published. Commands unchanged; `spawn`/`resume`/`machines` serve as refusal probes. Session creation by non-CLI clients (`create`) stays allowed — a session with no agent is inert. |

## Workstation (CLI)

- **No daemon:** `happycc` (all agents) never starts the daemon; `happycc daemon <anything>` prints
  "The background daemon is not available in this build." and exits non-zero. Session start no longer depends on
  a daemon (notifying it is already best-effort). With no daemon process, no machine-level RPC is ever registered.
- **Permission-mode ceiling:** the mode a session starts with (default, or a CLI flag) is its ceiling. When a
  message from the app requests a more permissive mode, the session keeps its current mode and prints
  "Ignored a request from the app to raise the permission mode to <mode>." Lowering is honored. Ranking
  (lower = safer): `plan`, `read-only` < `default` < `auto` < `acceptEdits`, `safe-yolo` < `bypassPermissions`, `yolo`
  (`auto` runs tools without prompting, so it ranks above `default`; final-review ruling). For Claude the comparison
  uses the modes as applied (`read-only` and `safe-yolo` run as `default`, `yolo` as `bypassPermissions`).
  Unranked (agent-specific) modes requested by the app are ignored, and so are tool lists the app pre-approves
  (`allowedTools` in message metadata).
- Session-scoped RPCs, local terminal mode, offline reconnection, and every runner otherwise unchanged.

## Server

The `rpc-register` relay currently accepts any method name from any socket of the account, so any client could
register (and, being first in the room, intercept) another session's methods. Registration becomes:

- allowed only for `clientType === 'session-scoped'` sockets, and only for methods `<socket.data.sessionId>:<method>`;
- refused otherwise with `rpc-error {type:'register', error:'RPC method not allowed'}` (the socket does not join).

`rpc-call` is unchanged: a method nobody registered (e.g. any machine method, since there is no daemon) already
returns "RPC method not available".

## App (mobile + web)

One build-time flag, APP_CONFIG `features.workstationOnly` (default **true**), hides (does not delete):

- New session (from the app) and its entry points; the machine picker and machine screens.
- Resume, fork, duplicate, rewind, and side chat (all create sessions).
- Worktree discovery/cleanup, which ran shell commands through the daemon (`machineBash`).
- Permission-mode options above the session's starting mode.

Everything inside a running session stays. The empty state tells the user to run `happycc` on their workstation.

## Testing

- **CLI unit:** `happycc daemon` disabled and `ensureDaemonRunning` never spawns; permission-mode ceiling
  (raise ignored, lower honored, unknown ignored).
- **Server unit:** registration refused for user-/machine-scoped sockets and for another session's prefix;
  allowed for the socket's own session.
- **Compatibility suite:** `resume` and `spawn` become N/A by design. New scenario `blocked-spawn` per agent: with a
  live session, `happycc-agent spawn` and a machine RPC are refused, and the session keeps working.
- **Web e2e:** the new-session and machine screens do not render; the home screen has no new-session control.

## Out of scope

- Restricting session-scoped shell/file access (it stays scoped to the session folder as today).
- Workspace roots/allowed folders, trusted devices, periodic re-authentication, admin on/off switch,
  permission-prompt expiry.
- Deleting the disabled code.
