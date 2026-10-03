# compat

Pinned agent compatibility suite. It drives the real agent CLIs (Claude Code, OpenCode, Pi) inside the compose
stack against a mock model server; no real model is ever called.

## Prerequisites

- Docker with the compose plugin, Node >= 20.11 on the host.
- Start the stack from the repo root: `docker compose up -d --build`

## Run

```bash
cd compat
npm ci
npm test
```

Global setup waits for the server and aimock, signs the `cli` and `app` devices in as `alice` through the OIDC
mock (skipped when they are already signed in), and writes `.versions.json` with the pinned tool versions.

Outputs land in `compat/`: `results.json` (vitest JSON), `report.md`, `logs/`, `.versions.json` (all git-ignored).

## Unit tests only

`COMPAT_UNIT_ONLY=1 npx vitest run src/stack.test.ts` skips global setup, so no stack is needed.

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

1. Edit the matching `ARG` in `Dockerfile.cli`.
2. Rebuild: `docker compose up -d --build`.
3. Run `npm test`, then `npm run report`.
4. If a cell changes, update `CAPABILITIES.md` (and `src/agents.ts` for N/A or known-bug entries).
