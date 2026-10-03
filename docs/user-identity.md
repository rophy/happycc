# User Identity Across Systems

How a single Happy user is identified across every external service.

## Primary ID: Happy Account CUID

- **Type:** CUID (collision-resistant unique ID, string)
- **Created:** Account upsert by (oidcIssuer, oidcSubject) on first OIDC login
- **Stored:** `Account.id` in Prisma, JWT payload (`{ user: CUID }`)
- **In code:** `request.userId` on server, `sync.serverID` on mobile
- **Visible in app:** Settings > Developer > Purchases page shows `sync.serverID`

## Identity Map

```
Happy Account CUID (e.g. cm4x7k2...)
│
├─► RevenueCat ── Same CUID, passed directly as appUserID
│                 Set once on mobile: RevenueCat.configure({ appUserID: serverID })
│                 Server queries RevenueCat API with the same CUID
│
├─► GitHub ────── External GitHub integer ID → stored in Account.githubUserId
│                 Linked via OAuth in githubConnect.ts
│                 Also stores encrypted access token in GithubUser.token
│
└─► AI Vendors ── ServiceAccountToken { accountId: CUID, vendor, token }
   (OpenAI,       User's own API keys, encrypted at rest.
    Anthropic,    connectRoutes.ts: POST /v1/connect/:vendor/register
    Gemini)
```

## Auth Flow

Accounts are created on first OIDC login and keyed by `(oidcIssuer, oidcSubject)`.
The server generates each account's 32-byte root secret, stores it wrapped
(`keyVault`, KeyTree from `HANDY_MASTER_SECRET`), and derives `Account.publicKey`
from it. Content encryption formats are unchanged; the server can decrypt.

```
CLI:     POST /v1/auth/device/start → user opens /activate, signs in with the IdP, approves
         POST /v1/auth/device/token → { accessToken, refreshToken, keyBundle = box([0|contentPublicKey]) }
Web:     GET /v1/auth/oidc/login?client=web&code_challenge=… → IdP → /v1/auth/oidc/callback
         → WEBAPP_URL/auth/callback#code=… → POST /v1/auth/oidc/exchange
         → { accessToken, refreshToken, keyBundle = box(rootSecret) }
Mobile:  GET /v1/auth/oidc/login?client=mobile&code_challenge=…&redirect_uri=<custom-scheme>
         → IdP → /v1/auth/oidc/callback → confirmation page (/v1/auth/oidc/mobile/confirm)
         → redirect_uri?code=… → POST /v1/auth/oidc/exchange
Agent:   GET /v1/auth/oidc/login?client=loopback&code_challenge=…&redirect_uri=http://127.0.0.1:<port>/callback
         (happy-agent, RFC 8252 loopback flow) → IdP → /v1/auth/oidc/callback
         → confirmation page (/v1/auth/oidc/loopback/confirm) → redirect_uri?code=…
         → POST /v1/auth/oidc/exchange
All:     POST /v1/auth/refresh (rotating refresh tokens, reuse → device revoked)
         POST /v1/auth/logout
```

Mobile and agent logins stop at a CSRF-protected confirmation page before a
code is ever issued, so a crafted login link can't deliver a code straight
to an attacker's redirect URI.

Access tokens are 15-minute JWTs `{ sub: accountId, did: deviceId }`.
Sockets check the device (revoked, disabled, max session age) at connect and are
closed 60 s after their access token expires.
Local IdP for development and tests: `docker compose up -d oidc-mock` (users alice, bob).
See `docs/superpowers/specs/2026-09-30-oidc-auth-design.md`.

## Key Design Decisions

| System | ID Type | Why |
|--------|---------|-----|
| RevenueCat | Pass-through | Direct correlation needed for subscription API calls |
| GitHub | Stored foreign key | Enables profile linking and account recovery via OAuth |
| AI vendors | Stored encrypted | User-owned keys, need to be retrievable |
