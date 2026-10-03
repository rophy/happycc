# Verified agent capabilities

Evidence behind `AGENTS[...].unsupported` in `src/agents.ts`. Every N/A cell cites a section here.
Established by hand on 2026-10-03 against the compose stack, using the commands the suite uses.

## Versions

| Tool | Version | How read |
|---|---|---|
| happycc | 1.2.5 | `happycc --version` (cli) |
| happycc-agent | 0.1.0 | `happycc-agent --version` (app) |
| Claude Code | 2.1.288 | `claude --version` (cli) |
| Claude binary used by remote mode | 2.1.288 (`@anthropic-ai/claude-agent-sdk-linux-x64` 0.3.288) | see note below |
| OpenCode | 1.18.34 | `opencode --version` |
| Pi | 1.0.0 | `pi --version` |
| pi-acp | 0.0.34 | `npm ls -g pi-acp` |
| aimock | 1.43.0 | compose image tag |

Note: `happycc --happy-starting-mode remote` does **not** run the globally installed `claude`. It runs the SDK's
bundled binary, `/usr/local/lib/node_modules/happycc/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`
(visible in `ps`). That binary reports `2.1.288 (Claude Code)`, the same as the pin, but it follows happycc's
SDK dependency, not the `Dockerfile.cli` build arg.

## Matrix

| Scenario | Claude Code | OpenCode | Pi |
|---|---|---|---|
| roundtrip | ✓ | ✓ | ✓ |
| tool-allow | ✓ | ✓ | N/A ([Pi permissions](#pi-has-no-permission-prompts)) |
| tool-deny | ✓ (turn not closed, [bug 2](#bugs-found)) | ✓ | N/A ([Pi permissions](#pi-has-no-permission-prompts)) |
| abort | ✓ | runner crashes ([bug 4](#bugs-found)) | runner crashes ([bug 4](#bugs-found)) |
| kill | `stop` leaves the process running ([bug 3](#bugs-found)) | same | same |
| offline-start | fails ([bug 6](#bugs-found)) | ✓ | ✓ |
| resume | ✓ | N/A ([resume](#acp-sessions-cannot-be-resumed)) | N/A ([resume](#acp-sessions-cannot-be-resumed)) |
| spawn | ✓ | N/A ([spawn](#acp-agents-cannot-be-spawned)) | N/A ([spawn](#acp-agents-cannot-be-spawned)) |

Scenarios 1-3 (`tests/conversation.test.ts`). Known-bug cells (`AGENTS[...].knownBugs`) are normal tests titled
`known bug #n`: the body asserts the correct behaviour and throws a `KnownBugSymptom` at the exact point the bug shows
(`src/knownBug.ts`); the cell passes only on that symptom, fails on any other error, and fails with "no longer
reproduces" if the body succeeds. Results on Claude Code (2 full runs of the claude cells, plus the earlier ones):

- roundtrip: [bug 1](#bugs-found), the symptom was seen on every fresh session (reply `COMPAT-HELLO-OK` in history, no
  `turn-end` after 60 s) in 4 test runs and 4 manual runs. One manual run showed a first-turn `turn-end`, but a stray
  second runner was alive then; I could not reproduce that, so I treat bug 1 as deterministic with that caveat.
- tool-allow and tool-deny first run a warm-up turn (`warmUp`: `compat:hello`, tolerating the missing turn-end of
  bug 1) so that the write turn is not the first turn.
- tool-allow on a non-first turn: **passes** (approve, then `turn-end`, file `COMPAT-FILE-CONTENT`, `COMPAT-WRITE-DONE`).
  It is a normal cell, not a known-bug cell. Its earlier failure was only bug 1.
- tool-deny on a non-first turn: reaches [bug 2](#bugs-found) on its own: the request is recorded as `denied`
  (`status --json`), no file is written, and no `turn-end` follows within 30 s. The cell is a known-bug #2 cell.

Tool-allow/deny wait for the `turn-end` in the history (`awaitTurnEnd`) because `happycc-agent wait` returns immediately
(see Harness findings). No agent config was changed for these scenarios.

Only N/A cells are agent limitations. The other non-✓ cells are bugs in happycc / happycc-agent and should fail
in the suite until fixed.

Conventions below: `S` is the session id, commands run with `docker compose exec -T <service> sh -lc '…'`.

## Claude Code remote mode needs no TTY

```
# cli
cd /workspace && exec happycc --happy-starting-mode remote > /tmp/claude1.log 2>&1 < /dev/null   # via exec -d
# app
happycc-agent send S 'compat:hello'
happycc-agent history S --json
  … {"ev": {"t": "text", "text": "COMPAT-HELLO-OK"}} …
```

The session log shows `[claudeRemoteLauncher] TTY available: undefined` and the turn completes. No
`script -qec` wrapper is needed. The `unrecognized_model` warning of `claude -p` does not appear in remote mode.

## Permission prompts: Claude Code and OpenCode

Claude Code (`compat:write`, model `compat-claude`):

```
$ happycc-agent permissions S --json
[ { "id": "toolu_Lfi-J0zbP3jKTgbR", "tool": "Write",
    "arguments": { "file_path": "/workspace/compat-write.txt", "content": "COMPAT-FILE-CONTENT" } } ]
$ happycc-agent approve S toolu_Lfi
Approved Write (toolu_Lfi-J0zbP3jKTgbR) in session …
$ cat /workspace/compat-write.txt            # cli
COMPAT-FILE-CONTENT
history: … {"t": "text", "text": "COMPAT-WRITE-DONE"} … {"t": "turn-end", "status": "completed"}
```

Deny: `happycc-agent deny S <id>` → no file; `completedRequests[<id>].status = "denied"`. The turn is **not** closed
(no `turn-end`, no closing reply) until the next abort or message; see bug 2.

OpenCode (`permission.edit: ask`, model `anthropic/compat-opencode`). The request surfaces as tool `edit` with
ACP diff arguments:

```
$ happycc-agent permissions S --json
[ { "id": "7f01cde9-e6df-43af-ba13-d8d270372dfb", "tool": "edit",
    "arguments": [ { "type": "diff", "path": "/workspace/compat-write.txt", "oldText": "", "newText": "COMPAT-FILE-CONTENT" } ] } ]
$ happycc-agent approve S 7f01
Approved edit (7f01cde9-…) in session …
$ cat /workspace/compat-write.txt
COMPAT-FILE-CONTENT
history: … "COMPAT-WRITE-DONE" … {"t": "turn-end", "status": "completed"}
```

Deny on OpenCode: no file, `send --wait` returns 0, history ends with `turn-end completed`; the CLI log shows
`[opencode] Permission denied for edit` and `The user rejected permission to use this specific tool call.`

## Pi has no permission prompts

```
$ happycc-agent send --wait S 'compat:write'    # while polling `permissions S --json` every second
[] [] [] [] [] []
send-wait-rc=0
$ cat /workspace/compat-write.txt
COMPAT-FILE-CONTENT
history: tool-call-start "edit" … tool-call-end … "COMPAT-WRITE-DONE" … turn-end completed
```

Pi wrote the file without asking. pi-acp 0.0.34 calls `conn.requestPermission` in exactly one place,
`requestExtensionPermission` (`dist/index.js` ~line 1363), for Pi extension UI confirmations only; built-in tools
never ask. → `tool-allow`, `tool-deny`: N/A, "Pi has no permission prompts; it runs tools without asking."

## ACP sessions cannot be resumed

Runner killed on cli (`pkill -f "[h]appycc(/dist/index\.mjs)? acp"`), then from app:

```
$ happycc-agent resume S       # OpenCode session
Failed to resume session: Happy session cmusck9j60046rx3q8jjxli1q uses unsupported flavor "opencode".
$ happycc-agent resume S       # Pi session
Failed to resume session: Happy session cmuscunu0006grx3qq147dsul uses unsupported flavor "acp".
```

Thrown by `packages/happy-cli/src/resume/handleResumeCommand.ts:89`, which only builds launches for `claude` and
`codex`. → `resume`: N/A for OpenCode and Pi.

Claude Code control (same steps): `Session Resumed`, the daemon spawns
`index.mjs claude --happy-starting-mode remote …`, a following `compat:hello` is answered and the earlier reply is
still in history.

Before the `init: true` fix (see [Stack fixes](#stack-fixes)) the same resume returned `Session Resumed` but spawned
nothing: the killed runner was a zombie, so the daemon's `isPidAlive` saw it as running and answered success.

## ACP agents cannot be spawned

`happycc-agent spawn --help` lists `--agent <agent>  Agent to start (claude, codex, gemini, openclaw, agy)`, and the
daemon maps any other value to `claude` (`packages/happy-cli/src/daemon/run.ts:440`). → `spawn`: N/A for OpenCode
and Pi. Claude control: `spawn --machine <cli> --path /workspace --agent claude --json` → `"type": "success"`, and the
session answers `compat:hello`.

## Abort

Claude Code: `send 'compat:slow'`, `abort S` after 6 s → `turn-end` `cancelled`, event `Aborted by user`, no
`COMPAT-SLOW-END` in history, and a following `compat:hello` is answered.

OpenCode and Pi: see bug 4.

## Scenarios 4-6 (`tests/lifecycle.test.ts`)

- abort: Claude passes (`turn-end` after the abort, no `COMPAT-SLOW-END`, a following `compat:hello` is answered).
  OpenCode and Pi are known-bug #4 cells: after `abort`, no `turn-end` within 30 s, the runner pid
  (`metadata.hostPid`) is gone and the session is still `active`. The "started" signal is a 5 s delay after the
  message reaches the session, not the reply text: Pi delivers the whole reply as one text event only when it is
  complete (seen at ~20 s), and Claude's first turn emits no new `turn-start` (bug 1).
- kill: known-bug #3 on all three agents. `stop` returns 0 and the session reports `active: false`, but the runner
  pid from `metadata.hostPid` is still alive 30 s later.
- offline-start: OpenCode and Pi pass (CLI logs `offline mode`, then `Reconnected`, a session appears and answers
  `compat:hello`). Claude fails, see bug 6.

## Stack fixes

Made during this investigation (config of our stack, not product code):

1. **`init: true` on `cli` and `app`** (`docker-compose.yaml`). PID 1 was `sleep infinity`, which never reaps, so
   killed runners stayed `<defunct>`. A zombie still answers `kill(pid, 0)`, so the daemon kept treating killed
   sessions as alive and `resume` returned success without spawning anything.
2. **`compat:slow` streams at 200 ms per chunk** (`deploy/aimock/compat.json`, was 1500 ms). happycc's ACP backend
   ends a turn after 500 ms without a chunk (`DEFAULT_IDLE_TIMEOUT_MS`,
   `packages/happy-cli/src/agent/acp/sessionUpdateHandlers.ts:19`), so at 1500 ms OpenCode/Pi got a `turn-end`
   after the first 4 characters and there was nothing left to abort. The reply is longer now (~20 s total).

Harness findings (in `src/session.ts`):

- `happycc-agent wait` returns as soon as there are no pending permission requests, which is already true before
  the agent picks a message up (it returned in 1.2 s with only the user message in history). `sendAndWait` uses
  `send --wait`, which waits for the turn-end event.
- Runner command lines are `node …/happycc/dist/index.mjs acp …` (`… claude --happy-starting-mode …` when spawned or
  resumed by the daemon), so `pkill -f "happycc (acp|…)"` missed them; and `pkill -f "opencode acp"` matched the
  `sh -lc` running it and killed the cleanup itself. Patterns now use the `[x]` trick.
- The cli machine id is read from `~/.happycc/settings.json`: `machines --json` lists two machines with the same
  `metadata.host` (re-sign-in in the same container registers a new machine).

## Bugs found

1. **Claude: the first turn of a session never gets `turn-end`.** Fresh session, `send --wait S 'compat:hello'` →
   reply `COMPAT-HELLO-OK` arrives, but `timeout 40` exits 124; history has `turn-start` + text, no `turn-end`.
   Later turns are fine. Reproduced on 4 sessions started on cli and 1 spawned from app (the first turn after a
   resume completed normally). Cause: in
   `claudeRemoteLauncher.ts` `onReady` calls `closeClaudeSessionTurn` before the queued assistant message is mapped
   (it only flushes `messageQueue` first when `status === 'failed'`). On the first turn the SDK messages are
   delivered in one burst after `Waiting for session file to be written to disk`, so the close runs while no turn is
   open (no-op) and the assistant message then opens a turn nobody closes.
   Effect on the suite: every Claude scenario's first `sendAndWait` times out.
2. **Claude: denying a permission leaves the turn open.** After `deny`, the log shows
   `[claudeRemote] Tool aborted, exiting claudeRemote`; `claudeRemoteLauncher` only closes the turn when
   `abortController.signal.aborted`, so no `turn-end` is sent and `send --wait` never returns. The stale turn is
   closed (as `cancelled`) by the next abort.
3. **`happycc-agent stop` does not stop the session process.** It emits `session-end` (marks the session inactive)
   instead of the `killSession` session RPC the app uses (`sessionKill` in `happy-app/sources/sync/ops.ts`). After
   `stop` + 15 s: `active: false`, `lifecycleState: running`, the runner is still in `ps`, and a following
   `compat:hello` is still answered. Same for OpenCode (Pi not tried; same code path).
4. **ACP abort mid-reply crashes the runner (OpenCode, Pi).** `abort S` during `compat:slow` →
   `Status: stopped: Cancelled by user`, then an unhandled rejection
   `Error: opencode backend stopped: Cancelled by user at stopRunnerFromBackendStatus`; the process exits, no
   `turn-end` is sent (`send --wait` times out), and the session stays `active` on the server. Same with Pi.
   Cause: `AcpBackend.cancel()` emits `status: 'stopped'` (`packages/happy-cli/src/agent/acp/AcpBackend.ts:1247`),
   which `runAcp` treats as "backend gone" and stops the runner. Aborting after the ACP idle heuristic already ended
   the turn also archives the session (seen with the old 1500 ms fixture).
5. **ACP turn end is a 500 ms silence heuristic** (`DEFAULT_IDLE_TIMEOUT_MS`), not the ACP prompt response. A reply
   that pauses for over 500 ms is split into two turns. Worked around in the fixture (stack fix 2), not fixed.
6. **Claude: `happycc --happy-starting-mode remote` started while the server is down does not become a remote session.**
   `runClaude.ts` (~line 182) handles an unreachable server by running Claude locally (`claudeLocal`, interactive) and
   only mirroring its transcript after reconnect. Without a TTY (the suite's detached start) Claude runs in `--print`
   mode and exits: CLI log `Error: Input must be provided either through stdin or as a prompt argument when using --print`,
   `Error: Process exited with code: 1`, and no `Reconnected`. With a TTY (`script -qec`) it reconnects and a session
   appears, but `send --wait compat:hello` times out (exit 124) and history holds only the user message: the offline
   path never wires incoming app messages to Claude. (Claude's first-run theme prompt was also on screen in that
   experiment, so the second symptom is not isolated from it.) The cell stays a plain failure, not a known-bug cell.
