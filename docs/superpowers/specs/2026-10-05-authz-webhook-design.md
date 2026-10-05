# Authorization Webhook — Design

Status: draft for review (2026-10-05)
Scope: an opt-in server hook that decides, per user, whether the app, web app and `happycc-agent` may
be used. Authentication stays OIDC; this adds authorization.

## Goal

OIDC answers "who is this". Today anyone the identity provider lets through can use every client.
Organizations need to decide who may use the remote clients, from their own systems (directory
groups, licences, training, offboarding), and change it without the user signing in again.

## Decisions

| Topic | Decision |
|---|---|
| Opt-in | `AUTHZ_WEBHOOK_URL` unset: behaviour unchanged, nobody is checked. |
| Who is checked | Every device that is not `cli`: `web`, `mobile` and `loopback` (`happycc-agent`). These receive the account's root secret and can read every session. |
| CLI | Never checked. A `cli` device holds only the account's public key, acts on its own workstation, and cannot read other sessions. Anyone who can reach the server and authenticate may run sessions. |
| Decision | `{ allowed: boolean, reason?: string }` from the webhook. |
| Denied | HTTP 403 `{ error: 'forbidden', reason }` (reason omitted if the webhook gave none). The device is not revoked: access resumes when the webhook allows it again. |
| Dynamic | Each decision is cached per account and client kind for `AUTHZ_WEBHOOK_CACHE_TTL` (default `60s`); a change at the webhook takes effect within that time. |
| Webhook failure | Error status, timeout (`AUTHZ_WEBHOOK_TIMEOUT`, default `5s`) or malformed reply: **deny** (fail closed) with a generic reason. Failures are not cached, so the next request asks again. A fail-open option is planned (Future), not built. |
| Webhook auth | `Authorization: Bearer <AUTHZ_WEBHOOK_SECRET>`; HTTPS required unless `AUTHZ_WEBHOOK_ALLOW_INSECURE=true` (local development). |
| Claims | The server forwards the ID token's claims (e.g. `groups`) so the webhook can decide without a directory lookup. They are stored per account at each sign-in and refreshed when the IdP re-check returns a new ID token. |

## Request

```http
POST <AUTHZ_WEBHOOK_URL>
Authorization: Bearer <AUTHZ_WEBHOOK_SECRET>
Content-Type: application/json

{
  "user": {
    "accountId": "...",
    "issuer": "https://idp.example.com",
    "subject": "...",
    "email": "user@example.com",
    "name": "...",
    "claims": { "groups": ["..."], "...": "..." }
  },
  "client": { "kind": "web" | "mobile" | "agent", "deviceName": "..." }
}
```

`client.kind` maps the device kind: `loopback` is sent as `agent`. Response: `200` with
`{ "allowed": true }` or `{ "allowed": false, "reason": "Ask IT for access to happycc" }`. `reason` is
plain text, shown to the user, truncated to 500 characters.

## Enforcement points

| Point | Behaviour when denied |
|---|---|
| Sign-in exchange (`POST /v1/auth/oidc/exchange`, non-`cli` clients) | 403 with the reason; no device is created and no key is delivered. |
| Authenticated HTTP requests (`app.authenticate`) from a non-`cli` device | 403 with the reason. |
| Socket handshake from a non-`cli` device | Refused with an error carrying the reason. |
| Open sockets | Re-checked when the cached decision expires (on the next event, at most every TTL); a denial disconnects them with the reason. |
| Token refresh (`/v1/auth/refresh`) | Not checked: a denial is not a sign-out, so the device keeps its tokens. |

The decision is looked up through one function (`authorizeDevice(device) → Decision`), backed by the
per-account cache; every enforcement point calls it.

## Clients

- **App and web app:** a full-screen "Not authorized" view on 403 `forbidden` (HTTP) or the socket's
  denial: the reason when given, a retry button, and sign out. Retrying re-asks the server (the cache
  expires within the TTL). At sign-in, the denial is shown on the same view.
- **`happycc-agent`:** prints `Not authorized: <reason>` and exits with a non-zero code.
- **CLI:** unchanged.

## Data

`Account.idpClaims` (JSON, nullable): the latest ID token claims, minus `iss`, `sub`, `aud`, `exp`,
`iat`, `nonce`, `at_hash` and `auth_time`. Written at each sign-in and when the IdP re-check returns
an ID token. Migration adds the column.

## Error handling

- The webhook is called by the server only; its URL and secret are never sent to clients.
- Logged per call: account id, client kind, decision, latency; never the secret or claims.
- A burst of requests for the same account and kind shares one in-flight webhook call.

## Testing

- Server unit: decision cache (TTL, single flight, failures not cached), request shape, claim
  filtering, reason truncation, fail closed on status/timeout/malformed body, `loopback` → `agent`.
- Server routes: exchange, an authenticated route and the socket handshake, for `cli` (never called)
  and `web`/`mobile`/`loopback` (allowed and denied); unset URL calls nothing.
- App: the "Not authorized" view on 403 and on socket denial; retry; sign out.
- Agent: exits non-zero with the reason.
- End to end: the compose stack gets a small mock webhook; the web e2e checks deny, then allow without
  signing in again.

## Future

- `AUTHZ_WEBHOOK_FAILURE=deny|allow` (fail open), once there is a need and a clear audit story.
- Roles in the decision (e.g. admin), for an admin console.
