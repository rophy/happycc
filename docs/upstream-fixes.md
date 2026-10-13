# Fixes for upstream

Bugs fixed in this fork that also affect upstream (slopus/happy), whether or not an issue or PR was filed. Upstream reviews slowly, so the fork does not wait on these; this list is what to offer back if that changes.

Issues and PRs follow upstream's `docs/CONTRIBUTING.md`: a one-paragraph summary first, and proof from a running app.

## Filed

| Fix | Fork commit | Upstream | Status (2026-10-13) |
|---|---|---|---|
| Re-attach session handlers registered while offline after reconnecting | c5bb1440 | issue #1857, PR #1858 | merged |
| Send messages added outside the session (`claude --resume`) when resuming it | 2ba03d30 | issue #1861, PR #1862 | open, no review |
| Mock the navigation hook in the session presentation test | 749f12be | PR #1864 | open, no review |
| Size the web app to the visible viewport on mobile browsers (tab bar hidden on Android Chrome) | be2c284d | PR #1882 | open, no review |
| Run the remote-mode agent inside the sandbox (remote mode skipped prompts without a sandbox) | 296c0689 | issue #1894, PR #1895 | open, no review |

Upstream branches for open PRs are on rophy/happycc under the same names (`fix/resume-outside-messages`, `fix/session-presentation-test-mock`, `fix/web-visible-viewport`, `fix/remote-mode-sandbox`).

## Not filed

Fixed here, and upstream has the same code; not reproduced on upstream yet.

| Fix | Fork commit | Upstream evidence |
|---|---|---|
| Order sent messages by the server's time (a device clock running ahead sorted messages below their replies until the app restarted) | 99d7fe16 | `messageSortKey` and the send-time `Date.now()` stamp are the same on upstream `main` |

## To check

Fork fixes that look generic but have not been compared with upstream. Several touch code the fork has reworked, so they may not apply.

| Fix | Fork commit |
|---|---|
| End ACP turns on the prompt response, not on pauses in the output | 05560f50 |
| Keep the ACP queue open after a user abort | e1a55666 |
| End the remote turn after its reply and after a denied tool | 0d081616 |
| Keep the SDK message uuid so the session history matches the conversation file | 87b53be8 |
| Reconnect the app's sync socket after the server cuts it | c02599c5 |
| Reconnect happy-agent sockets after the server cuts them | 08664c89 |
| Catch up on messages missed while the agent was disconnected | 7e383c2c |
| Only let a session's own socket register its RPC methods | f550abaa |
| Reject session sockets for sessions the account does not own | 88fb3b62 |
| Normalise the mermaid script URL before injecting it | b2088443 |
| Leave class instances untouched when sanitizing log values | ff8ab663 |
