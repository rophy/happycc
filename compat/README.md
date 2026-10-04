# compat

Pinned agent compatibility suite. It drives the real agent CLIs (Claude Code, OpenCode, Pi) inside the compose
stack against a mock model server; no real model is ever called.

## Prerequisites

- Docker with the compose plugin, Node >= 22.6 on the host (`npm run report` uses `--experimental-strip-types`).
- Start the stack from the repo root: `docker compose up -d --build`

## Run

```bash
cd compat
npm ci
npm test
```

Global setup waits for the server and aimock, signs the `cli` and `app` devices in as `alice` through the OIDC
mock (skipped when they are already signed in; no daemon is started, this is the workstation-only build), and writes `.versions.json` with the pinned tool versions.

Outputs land in `compat/`: `results.json` (vitest JSON), `report.md`, `logs/`, `.versions.json` (all git-ignored).

## Unit tests only

`COMPAT_UNIT_ONLY=1 npx vitest run src/` skips global setup, so no stack is needed.

## Reading the matrix

`npm run report` turns `results.json` and `.versions.json` into `compat/report.md`: scenarios as rows, agents as
columns, plus the pinned versions. The CI job (`.github/workflows/compat.yml`, manual `workflow_dispatch`) appends
the same report to the job summary.

| Cell | Meaning |
| --- | --- |
| `✅` | The scenario passed. |
| `N/A` | Not applicable to that agent; the reason is footnoted. Each one is backed by evidence in `CAPABILITIES.md`. |
| `❌ #n` | A known product bug (`CAPABILITIES.md` "Bugs found"). Expected while the bug exists; the suite still exits 0. |
| `⚠️ FAILED` | A real failure, including a known bug that no longer reproduces. The run fails. |
| `—` | No result for that cell. |

## Bumping a pinned version

1. Edit the pin.
   - OpenCode, Pi, pi-acp: the matching `ARG` in `Dockerfile.cli`.
   - Claude Code has two pins that must move together:
     - `@anthropic-ai/claude-agent-sdk` in `packages/happy-cli/package.json` (an exact version, then `pnpm install`).
       Remote mode, which every Claude scenario uses, runs the Claude Code binary bundled with this SDK (reported as
       `claudeSdk`). Check which Claude Code an SDK version bundles with
       `npm view @anthropic-ai/claude-agent-sdk@<version> claudeCodeVersion`. Because the version is exact, it also
       holds for users' `npm install -g @happycc/cli`, which does not use the repo's lockfile.
     - `CLAUDE_CODE_VERSION` in `Dockerfile.cli`: the standalone `claude` used by local mode (reported as `claude`).
       Set it to the version the SDK bundles.
     The report shows a warning line if the two differ.
2. Rebuild: `docker compose up -d --build`.
3. Run `npm test`, then `npm run report`.
4. If a cell changes, update `CAPABILITIES.md` (and `src/agents.ts` for N/A or known-bug entries).

## Boundary

`resume` and `spawn` are N/A for every agent (the app cannot start or resume sessions in this build). The
`blocked-spawn` scenario (`tests/boundary.test.ts`) proves it: `happycc-agent spawn`/`resume` fail while a live
session keeps working. `blocked-shell` proves the session's direct RPCs run only the app's listed git commands
(no arbitrary command, write, or program-running search).
