# Happy

Code on the go — control AI coding agents from your phone, browser, or terminal.

Free. Open source. Code anywhere.

## Installation

```bash
npm install -g @happycc/cli
```

## Usage

### Claude Code (default)

```bash
happycc
# or
happycc claude
```

This will:
1. Start a Claude Code session
2. Prompt you to sign in on first run (see Authentication below) and print a link to connect from your mobile device or browser
3. Allow real-time session control — all communication is end-to-end encrypted
4. Start new sessions directly from your phone or web while your computer is online

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
> Happy only chooses which flag is passed to agy: the default modes use
> `--sandbox`, and the bypass/yolo-style modes (including `acceptEdits`) use
> `--dangerously-skip-permissions`. Neither adds a per-tool approval gate
> inside Happy, so selecting "default" for an agy session does **not** give
> you an approval prompt the way it does for Claude Code.

## Daemon

This build has no background daemon. `happycc daemon …` exits with code 1 and prints "The background daemon is not available in this build." Sessions are started from the workstation: run `happycc` in a project folder and the session appears in the app, where you can watch and control it. The app cannot start, resume or fork sessions.

## Authentication

```bash
happycc auth login
happycc auth logout
```

`happycc auth login` prints a short-lived sign-in link — open it in a browser, approve the device, and the CLI picks up the new credentials automatically. All session data is end-to-end encrypted before leaving your device.

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
| `HAPPY_SERVER_URL` | Your Happy server URL. Required: there is no default (or set `serverUrl` in `~/.happycc/settings.json`) |
| `HAPPY_WEBAPP_URL` | Your web app URL (no default) |
| `HAPPY_HOME_DIR` | Custom home directory for Happy data (default: `~/.happycc`) |
| `HAPPY_DISABLE_CAFFEINATE` | Disable macOS sleep prevention |
| `HAPPY_EXPERIMENTAL` | Enable experimental features |

### Sandbox (experimental)

Happy can run agents inside an OS-level sandbox to restrict file system and network access.

```bash
happycc sandbox configure
happycc sandbox status
happycc sandbox disable
```

### Building from source

```bash
git clone https://github.com/slopus/happy
cd happy-cli
yarn install
yarn workspace @happycc/cli cli --help
```

## Requirements

- Node.js >= 20.0.0
- For Claude: `claude` CLI installed & logged in
- For Codex: `codex` CLI installed & logged in
- For agy: install the Antigravity CLI (`agy`) and log in
- For Gemini (**deprecated** — use agy): `npm install -g @google/gemini-cli` + `happycc connect gemini`

## License

MIT
