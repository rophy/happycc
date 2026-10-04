# happycc Roadmap

Future work for this fork. Upstream's own roadmap is [roadmap.md](roadmap.md).

## Session titles

### Rename a session from the app

The app can show a session's title but not change it. A user rename should stay in step with the agent:

- The app sends a session RPC (`rename`) to the running session, like `abort` and `permission`. Session-scoped,
  so it fits the server's RPC registration rules.
- The CLI applies it with the same code as the `change_title` MCP tool (`claude/utils/startHappyServer.ts`), so
  there is one writer of `metadata.summary`.
- The CLI tells the agent: it prefixes the next prompt with a note such as
  `(The user renamed this chat to "X".)`. Without it, the agent only knows the title it last set itself and may
  retitle as if the old one were current.
- Works for every runner (Claude Code, Codex, Gemini, ACP).
- Tests: CLI unit (RPC handler, prompt note), compat-suite rename scenario via `happycc-agent`, e2e for the
  Rename UI.

### Use the agent's own title

Claude Code and OpenCode title sessions themselves (a separate small-model request), but happycc ignores those
titles: Claude Code's `summary` transcript entries are dropped (`claude/utils/sessionProtocolMapper.ts`), and
nothing reads an ACP agent's title. Only Claude Code is instructed to call `change_title`, so OpenCode and Pi
sessions usually stay "New Chat". Options: forward the agent's native title, or add the `change_title`
instruction to ACP prompts.

## Workstation resume for OpenCode and Pi

`happycc resume <id>` reattaches Claude Code (and Codex) sessions on the workstation; ACP sessions fail with
`unsupported flavor`. Supporting them needs the agent's own session restore (ACP `session/load`, if the agent
offers it) wired into the resume launch, plus the compat `workstation-resume` scenario for each agent.

## Known agent bugs

Tracked by the compatibility suite ([compat/CAPABILITIES.md](../compat/CAPABILITIES.md)):

5. ACP: turn end is detected by a 500 ms idle heuristic.

## Declined

- **New session from the app** (including a bounded "new session in this session's folder"). happycc keeps one
  model: one `happycc` started in a workstation terminal is one session in the app. The daemon stays disabled, so
  nothing runs on the workstation that the user did not start there or approve through the agent's permission
  prompt. Asking the agent to run `happycc` elsewhere remains possible, behind that prompt, as with Claude Code
  Remote Control.
