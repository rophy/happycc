# @happycc/cli

The `happycc` command of [Happy Corporate Coder](https://github.com/rophy/happycc): run a coding agent on
your workstation and follow it from your organization's happycc app.

## Installation

```bash
npm install -g @happycc/cli
```

Point it at your organization's server (there is no default):

```bash
export HAPPY_SERVER_URL=https://happy.example.com   # or "serverUrl" in ~/.happycc/settings.json
```

## Usage

```bash
happycc              # Claude Code (or: happycc claude)
```

The first run prints a sign-in link for your organization's identity provider. Once signed in, the
session appears in the app.

### More agents

```
happycc codex
happycc agy        # Antigravity CLI (Gemini's successor)
happycc gemini     # deprecated — use `happycc agy`
happycc openclaw

# or any ACP-compatible CLI
happycc acp opencode
happycc acp -- custom-agent --flag
```

> **Note on agy permissions:** the agy backend runs `agy --print`, which is
> one-shot and has no interactive approval surface — tool calls proceed
> automatically without ever prompting you. The permission mode you pick in
> happycc only chooses which flag is passed to agy: the default modes use
> `--sandbox`, and the bypass/yolo-style modes (including `acceptEdits`) use
> `--dangerously-skip-permissions`. Neither adds a per-tool approval gate
> inside happycc, so selecting "default" for an agy session does **not** give
> you an approval prompt the way it does for Claude Code.

## Sessions

Sessions start on the workstation: run `happycc` in a project folder. There is no background daemon
(`happycc daemon …` exits with an error). `happycc resume <session id>` continues a Claude Code or
Codex session later.

## Authentication

```bash
happycc auth login
happycc auth logout
```

`happycc auth login` prints a short-lived sign-in link — open it in a browser, sign in with your organization's identity provider, approve the device, and the CLI picks up the new credentials automatically.

To connect third-party agent APIs:

```bash
happycc connect gemini
happycc connect claude
happycc connect codex
happycc connect status
```

## Commands

| Command | Description |
|---------|-------------|
| `happycc` | Start Claude Code session (default) |
| `happycc codex` | Start Codex mode |
| `happycc agy` | Start agy (Antigravity CLI) session |
| `happycc gemini` | Start Gemini CLI session (**deprecated** — use `happycc agy`) |
| `happycc openclaw` | Start OpenClaw session |
| `happycc acp` | Start any ACP-compatible agent |
| `happycc resume <id>` | Resume a previous session |
| `happycc doctor` | Diagnostics & troubleshooting |

---

## Advanced

### Environment Variables

| Variable | Description |
|----------|-------------|
| `HAPPY_SERVER_URL` | Your organization's server URL. Required: there is no default (or set `serverUrl` in `~/.happycc/settings.json`) |
| `HAPPY_WEBAPP_URL` | Your web app URL (no default) |
| `HAPPY_HOME_DIR` | Custom home directory for happycc data (default: `~/.happycc`) |
| `HAPPY_DISABLE_CAFFEINATE` | Disable macOS sleep prevention |
| `HAPPY_EXPERIMENTAL` | Enable experimental features |

### Sandbox (experimental)

happycc can run agents inside an OS-level sandbox to restrict file system and network access.

```bash
happycc sandbox configure
happycc sandbox status
happycc sandbox disable
```

### Building from source

```bash
git clone https://github.com/rophy/happycc
cd happycc
pnpm install
pnpm --filter @happycc/cli cli --help
```

## Requirements

- Node.js >= 20.0.0
- For Claude: `claude` CLI installed & logged in
- For Codex: `codex` CLI installed & logged in
- For agy: install the Antigravity CLI (`agy`) and log in
- For Gemini (**deprecated** — use agy): `npm install -g @google/gemini-cli` + `happycc connect gemini`

## License

MIT. A fork of [Happy Coder](https://github.com/slopus/happy).
