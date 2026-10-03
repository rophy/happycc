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

## Bumping a pinned version

Edit the matching `ARG` in `Dockerfile.cli`, rebuild (`docker compose up -d --build cli`), then run `npm test`.
