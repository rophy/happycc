# Agent Compatibility Suite — Design

Status: approved in brainstorming, pending spec review
Scope: sub-project B of the corporate fork (see `2026-09-30-oidc-auth-design.md`).

## Goal

Prove, on demand, that the `happycc` CLI works with the **pinned** versions of the
coding agents we support, by driving real agents end to end through the real
server, with a mock model (aimock) instead of a real LLM.

## Decisions

| Topic | Decision |
|---|---|
| Purpose | Gate pinned versions only. No "latest" tracking. Version bumps are deliberate changes. |
| Agents | Claude Code, OpenCode (`happycc acp opencode`), Pi (`happycc acp -- pi-acp`). Codex, Gemini, Agy, OpenClaw out of scope. |
| Scenarios | Round trip, tool use with permission approve/deny, lifecycle (abort, kill, offline start, resume), start from phone. |
| Start from phone | Claude Code only. N/A for OpenCode/Pi until the daemon can spawn ACP agents (upstream slopus/happy#1840 or similar). |
| App-side driver | `happycc-agent` CLI, extended with the commands it lacks. |
| Approach | Compose-based: reuse the root `docker-compose.yaml` stack; standalone `compat/` test project drives it. |
| Pins | `Dockerfile.cli` build args stay the single source of truth; the suite records the installed versions in its report. |
| CI | New `.github/workflows/compat.yml`, `workflow_dispatch` only. |
| Model | aimock only. No real model is ever called. |

## Architecture

```
compat/  (standalone test project on the host / CI runner)
  │  vitest — one scenario list × [claude, opencode, pi]
  │
  ├── docker compose exec cli  happycc …        ← "computer" (agent side)
  └── docker compose exec app  happycc-agent …  ← "phone" (app side)

docker compose stack (root docker-compose.yaml):
  oidc-mock ─ postgres ─ server ─ aimock
  cli : Dockerfile.cli image — packed happycc + pinned Claude Code / OpenCode / Pi
  app : same image, also with packed happycc-agent; own volumes (separate device)
```

- **Two devices, one account.** `cli` signs in as alice with `happycc auth login`
  (device flow); `app` signs in as alice with `happycc-agent auth login` (loopback flow).
- **`app` service** reuses `Dockerfile.cli`, which additionally packs and globally
  installs `happycc-agent` the way a release would. One image, two services, separate
  volumes and credentials.
- **`compat/`** is a standalone npm project like `e2e/` (own `package.json`, not in the
  pnpm workspace). It only runs commands and parses their output (`--json` where
  available) — black-box testing of the shipped tools; no imports from our packages.
- **Report:** a pass/fail matrix of agent × scenario plus the agent versions read back
  from the image (`claude --version`, `opencode --version`, `pi --version`,
  `pi-acp` package version, `happycc --version`). Not-applicable cells are shown as
  **N/A** with a reason, never silently missing.

## Scenarios

Each prompt carries a marker (e.g. `compat:hello`) that aimock fixtures match on.
Each scenario starts a fresh session and uses its own marker file name, so leftovers
from a previous scenario cannot produce a false pass.

| # | Scenario | Steps | Pass when |
|---|---|---|---|
| 1 | Round trip | `send "compat:hello"` → `wait` | The fixed reply is in `history`; the session returns to idle. |
| 2 | Tool, allowed | `send "compat:write <file>"` → poll `permissions --json` → `approve` | `/workspace/<file>` exists with the expected content; the closing reply arrives. |
| 3 | Tool, denied | as #2, then `deny` | No file; the turn ends cleanly; a following #1 still works. |
| 4 | Abort | `send "compat:slow"` (slow streamed reply) → `abort` mid-turn | Session idle without the full reply; a following #1 works. |
| 5 | Kill | `stop` | The agent's CLI process on the device exits; the session is reported ended. |
| 6 | Offline start | stop `server` → start the session on `cli` → start `server` → wait for reconnect → #1 | #1 passes. |
| 7 | Resume | stop the CLI process → `resume` from `app` | The resumed session answers #1 and earlier history is present. |
| 8 | Start from phone | `spawn` on the device's machine from `app` → #1 | #1 passes. |

Expected matrix ("verify" = confirm support during implementation; if unsupported,
the cell becomes N/A with the reason recorded in the suite and the report):

| | Claude Code | OpenCode | Pi |
|---|---|---|---|
| 1 Round trip | ✓ | ✓ | ✓ |
| 2–3 Permissions | ✓ | ✓ | verify (Pi appears to have no permission prompts by design) |
| 4 Abort | ✓ | ✓ | ✓ |
| 5 Kill | ✓ | ✓ | ✓ |
| 6 Offline start | ✓ | ✓ | ✓ |
| 7 Resume | ✓ | verify | verify |
| 8 Start from phone | ✓ | N/A (no ACP spawn) | N/A (no ACP spawn) |

Agent-side session starts on `cli` (scenarios 1–7): Claude Code with `happycc` in remote
mode (the app is the input), OpenCode with `happycc acp opencode`, Pi with
`happycc acp -- pi-acp`, each run detached with stdin closed and output captured to a
per-scenario log file.

## aimock fixtures

New `deploy/aimock/compat.json`, loaded alongside the existing catch-all fixture
(which stays last so manual use keeps working).

- **Per-agent model names** so fixtures can return agent-specific tool calls:
  `compat-claude`, `compat-opencode`, `compat-pi`, configured in each agent's settings
  (Claude via its model setting, OpenCode via a custom model under its provider config,
  Pi via `deploy/aimock/agents/pi-models.json`).
- **`compat:hello`** → fixed text reply.
- **`compat:write <file>`**
  - `hasToolResult: false` → call the agent's write tool with its own name and
    argument schema (Claude Code `Write{file_path, content}`, OpenCode
    `write{filePath, content}`, Pi `write{path, content}`), matched by `model`.
  - `hasToolResult: true` → closing text reply.
- **`compat:slow`** → a long reply streamed slowly enough to abort mid-turn. Whether
  aimock supports per-fixture latency or only server-wide latency is verified during
  implementation; if only server-wide, use a long reply with small chunks instead.

Agent config changes: OpenCode's `permission` config sets edits to `ask` so it raises
an ACP permission request.

## `happycc-agent` additions

Mirror the app's calls exactly (same RPC methods and payloads), so the suite exercises
the same path the phone uses:

| Command | Behavior | App equivalent |
|---|---|---|
| `permissions <session> [--json]` | List pending permission requests from the session's agent state (`requests`): id, tool, arguments. | permission prompt UI |
| `approve <session> <request-id> [--for-session]` | Session RPC `permission` with `approved: true`; `--for-session` sends `decision: 'approved_for_session'`. | `sessionAllow` (`happy-app/sources/sync/ops.ts`) |
| `deny <session> <request-id>` | Session RPC `permission` with `approved: false`, `decision: 'denied'`. | `sessionDeny` |
| `abort <session>` | Session RPC `abort` with the same payload the app sends. | `sessionAbort` |

- New `src/sessionRpc.ts` next to `machineRpc.ts`, reusing its socket and encryption
  handling. Session and request ids accept unique prefixes like existing commands.
- Unit tests per command (payload and output). The README documents the new commands.
- No dedicated "wait for permission" command; the suite polls `permissions --json`.

## Sign-in automation

`happycc-agent` uses the loopback flow: the final redirect goes to
`127.0.0.1:<random port>` inside its container, unreachable from a host browser.

- **Sign-in helper** `compat/scripts/signin.mjs` (Node, `fetch` + cookie jar), executed
  **inside** the container that is signing in, so loopback redirects reach the CLI.
- It takes the sign-in URL the CLI prints, follows redirects to oidc-mock, selects the
  user, submits our confirmation page (Approve / Allow, with its CSRF token), and
  follows the final redirect.
- Works for both the device flow (`happycc auth login`) and the loopback flow
  (`happycc-agent auth login`); both CLIs print the URL when no browser can be opened.
- The exact form fields of oidc-mock's user selection and our confirmation pages are
  confirmed during implementation.

## Running

- **Locally:** `docker compose up -d --build`, then `cd compat && npm ci && npm test`.
  Reuses a running stack, like `e2e/`.
- The suite's setup signs both devices in (skipped if already signed in) and records
  versions.
- The whole suite runs **serially** (the offline-start scenario stops and starts the
  server).

## CI (`.github/workflows/compat.yml`, `workflow_dispatch`)

1. `docker compose up -d --build`; wait for health of server, oidc-mock, aimock.
2. `cd compat && npm ci && npm test`.
3. Write the agent × scenario matrix and versions to `$GITHUB_STEP_SUMMARY`.
4. On failure, upload the CLI/daemon logs from the device, the aimock request log, and
   the server log.
5. `docker compose down -v`.

## Out of scope

- Codex, Gemini, Agy, OpenClaw.
- Starting OpenCode/Pi from the phone (until ACP spawn exists).
- Real models; tracking latest agent releases; running on every PR.
- Claude Code local-mode (terminal TUI + transcript sync) testing — it needs a TTY
  driver and is a separate effort.
