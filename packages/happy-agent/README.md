# Happy Agent

CLI client for controlling Happy Coder agents remotely.

Unlike `happy-cli` which both runs and controls agents, `happycc-agent` only controls them — listing machines, creating sessions, sending messages, reading history, monitoring state, and stopping or killing sessions.

## Installation

```bash
npm install -g @happycc/agent
```

From the monorepo:

```bash
pnpm --filter @happycc/agent build
cd packages/happy-agent && npm link
```

## Authentication

Happy Agent signs in with your organization's identity provider through the Happy server (OIDC, loopback redirect). It receives the account key, so it can read sessions created on any of your machines.

```bash
# Opens the sign-in URL in your default browser (and prints it too). Waits up to 5 minutes.
happycc-agent auth login

# Only print the sign-in URL; do not open a browser
happycc-agent auth login --no-browser

# Check authentication status (never prints tokens)
happycc-agent auth status

# Revoke this device on the server and clear stored credentials
happycc-agent auth logout
```

Credentials are stored at `~/.happycc/agent.key` (mode 0600). Access tokens refresh automatically; if the device is revoked or the session reaches its maximum age, run `happycc-agent auth login` again.

## Commands

### List sessions

```bash
# List all sessions
happycc-agent list

# List only active sessions
happycc-agent list --active

# Output as JSON
happycc-agent list --json
```

### List machines

```bash
# List all machines
happycc-agent machines

# List only active machines
happycc-agent machines --active

# Output as JSON
happycc-agent machines --json
```

### Spawn on a machine (disabled)

`spawn` and `resume` start a session through the machine's daemon, which this build disables: sessions start on the workstation with `happycc`. Both commands are left out of `--help`, and fail if called.

### Session status

```bash
# Get live session state (supports ID prefix matching)
happycc-agent status <session-id>

# Output as JSON
happycc-agent status <session-id> --json
```

### Create a session

```bash
# Create a new session with a tag
happycc-agent create --tag my-project

# Specify a working directory
happycc-agent create --tag my-project --path /home/user/project

# Output as JSON
happycc-agent create --tag my-project --json
```

### Send a message

```bash
# Send a message to a session
happycc-agent send <session-id> "Fix the login bug"

# Send with yolo permissions
happycc-agent send <session-id> "Ship it" --yolo

# Send and wait for the agent to finish
happycc-agent send <session-id> "Run the tests" --wait

# Output as JSON
happycc-agent send <session-id> "Hello" --json
```

### Message history

```bash
# View message history
happycc-agent history <session-id>

# Limit to last N messages
happycc-agent history <session-id> --limit 10

# Output as JSON
happycc-agent history <session-id> --json
```

### Stop or kill a session

```bash
# End the session: sends a session-end event, so the server marks it inactive.
# The session process on the machine keeps running.
happycc-agent stop <session-id>

# Kill the session process, like the app's kill action: calls the session's
# `killSession` RPC, and the CLI that owns the session exits.
happycc-agent kill <session-id>
```

### Raw session RPC (test probe)

```bash
# Call any session RPC with JSON params and print the JSON result. Used to check
# what the CLI refuses, e.g. a command outside the app's session command list:
happycc-agent rpc <session-id> bash '{"command":"happycc --version"}'
```

### Permissions and abort

```bash
# List pending permission requests (add --json for machine-readable output)
happycc-agent permissions <session-id>

# Approve a request (--for-session approves the tool for the rest of the session)
happycc-agent approve <session-id> <request-id>

# Deny a request
happycc-agent deny <session-id> <request-id>
```

`approve`, `approve --for-session` and `deny` send the same `permission` RPC params as the app's buttons,
chosen by the session's `metadata.flavor`:

| Command | Codex sessions | Other sessions |
|---|---|---|
| `approve` | `{ id, approved: true, decision: 'approved' }` | `{ id, approved: true }` |
| `approve --for-session` | `{ id, approved: true, decision: 'approved_for_session' }` | `{ id, approved: true, allowTools: [tool] }` (`Bash(<command>)` for Bash; refused for Edit/MultiEdit/Write/NotebookEdit/ExitPlanMode, where the app has no such button) |
| `deny` | `{ id, approved: false, decision: 'abort' }` (the app's only Codex deny) | `{ id, approved: false }` |

```bash
# Abort the current turn; the session keeps running
happycc-agent abort <session-id>
```

### Wait for idle

```bash
# Wait for agent to become idle (default 300s timeout)
happycc-agent wait <session-id>

# Custom timeout
happycc-agent wait <session-id> --timeout 60
```

Exit code 0 when agent becomes idle, 1 on timeout.

## Environment Variables

- `HAPPY_SERVER_URL` - Your Happy server URL. Required: there is no default.
- `HAPPY_HOME_DIR` - Home directory for credential storage (default: `~/.happycc`)

## Session ID Matching

All commands that accept a `<session-id>` support prefix matching. You can provide the first few characters of a session ID and the CLI will resolve the full ID.

Machine-aware commands such as `spawn --machine <machine-id>` also support ID prefix matching.

## Encryption

All machine and session data is end-to-end encrypted. New records use AES-256-GCM with per-record keys. Existing records created by other clients are decrypted using the appropriate key scheme (AES-256-GCM or legacy NaCl secretbox).

## Requirements

- Node.js >= 20.0.0
- An account at your organization's identity provider

## Publishing to npm

Releases run from the `Release @happycc/agent` GitHub Actions workflow (`.github/workflows/release-happy-agent.yml`), dispatched from `main` with the version and release notes. It builds and tests the package, smoke-tests the packed tarball, publishes it to npm with provenance (trusted publishing), and creates the `agent-X.Y.Z` tag and GitHub release.

## License

MIT
