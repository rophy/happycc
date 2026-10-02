# Happy Agent

CLI client for controlling Happy Coder agents remotely.

Unlike `happy-cli` which both runs and controls agents, `happyco-agent` only controls them — listing machines, spawning sessions on a machine, creating sessions, sending messages, reading history, monitoring state, and stopping sessions.

## Installation

From the monorepo:

```bash
yarn workspace happyco-agent build
```

Or link globally:

```bash
cd packages/happy-agent && npm link
```

## Authentication

Happy Agent signs in with your organization's identity provider through the Happy server (OIDC, loopback redirect). It receives the account key, so it can read sessions created on any of your machines.

```bash
# Opens the sign-in URL in your default browser (and prints it too). Waits up to 5 minutes.
happyco-agent auth login

# Only print the sign-in URL; do not open a browser
happyco-agent auth login --no-browser

# Check authentication status (never prints tokens)
happyco-agent auth status

# Revoke this device on the server and clear stored credentials
happyco-agent auth logout
```

Credentials are stored at `~/.happyco/agent.key` (mode 0600). Access tokens refresh automatically; if the device is revoked or the session reaches its maximum age, run `happyco-agent auth login` again.

## Commands

### List sessions

```bash
# List all sessions
happyco-agent list

# List only active sessions
happyco-agent list --active

# Output as JSON
happyco-agent list --json
```

### List machines

```bash
# List all machines
happyco-agent machines

# List only active machines
happyco-agent machines --active

# Output as JSON
happyco-agent machines --json
```

### Spawn on a machine

```bash
# Spawn a session on a specific machine
happyco-agent spawn --machine <machine-id> --path ~/project

# Let the daemon create the directory if needed
happyco-agent spawn --machine <machine-id> --path ~/new-project --create-dir

# Choose a specific agent
happyco-agent spawn --machine <machine-id> --path ~/project --agent codex

# Output as JSON
happyco-agent spawn --machine <machine-id> --path ~/project --json
```

### Session status

```bash
# Get live session state (supports ID prefix matching)
happyco-agent status <session-id>

# Output as JSON
happyco-agent status <session-id> --json
```

### Create a session

```bash
# Create a new session with a tag
happyco-agent create --tag my-project

# Specify a working directory
happyco-agent create --tag my-project --path /home/user/project

# Output as JSON
happyco-agent create --tag my-project --json
```

### Send a message

```bash
# Send a message to a session
happyco-agent send <session-id> "Fix the login bug"

# Send with yolo permissions
happyco-agent send <session-id> "Ship it" --yolo

# Send and wait for the agent to finish
happyco-agent send <session-id> "Run the tests" --wait

# Output as JSON
happyco-agent send <session-id> "Hello" --json
```

### Message history

```bash
# View message history
happyco-agent history <session-id>

# Limit to last N messages
happyco-agent history <session-id> --limit 10

# Output as JSON
happyco-agent history <session-id> --json
```

### Stop a session

```bash
happyco-agent stop <session-id>
```

### Wait for idle

```bash
# Wait for agent to become idle (default 300s timeout)
happyco-agent wait <session-id>

# Custom timeout
happyco-agent wait <session-id> --timeout 60
```

Exit code 0 when agent becomes idle, 1 on timeout.

## Environment Variables

- `HAPPY_SERVER_URL` - Your Happy server URL. Required: there is no default.
- `HAPPY_HOME_DIR` - Home directory for credential storage (default: `~/.happyco`)

## Session ID Matching

All commands that accept a `<session-id>` support prefix matching. You can provide the first few characters of a session ID and the CLI will resolve the full ID.

Machine-aware commands such as `spawn --machine <machine-id>` also support ID prefix matching.

## Encryption

All machine and session data is end-to-end encrypted. New records use AES-256-GCM with per-record keys. Existing records created by other clients are decrypted using the appropriate key scheme (AES-256-GCM or legacy NaCl secretbox).

## Requirements

- Node.js >= 20.0.0
- An account at your organization's identity provider

## Publishing to npm

Maintainers can publish a new version:

```bash
yarn release               # From repo root: choose library to release
# or directly:
yarn workspace happyco-agent release
```

This flow:
- runs tests/build checks via `prepublishOnly`
- creates a release commit and `happyco-agent-vX.Y.Z` tag
- creates a GitHub release with generated notes
- publishes `happyco-agent` to npm

## License

MIT
