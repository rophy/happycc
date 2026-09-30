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
├─► ElevenLabs ── u_{base64url(HMAC-SHA256(CUID, MASTER_SECRET))}
│                 Derived on every request, never stored.
│                 voiceRoutes.ts:deriveElevenUserId()
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
CLI:  POST /v1/auth/device/start → user opens /activate, signs in with the IdP, approves
      POST /v1/auth/device/token → { accessToken, refreshToken, keyBundle = box([0|contentPublicKey]) }
Web:  GET /v1/auth/oidc/login?client=web&code_challenge=… → IdP → /v1/auth/oidc/callback
      → WEBAPP_URL/auth/callback#code=… → POST /v1/auth/oidc/exchange
      → { accessToken, refreshToken, keyBundle = box(rootSecret) }
All:  POST /v1/auth/refresh (rotating refresh tokens, reuse → device revoked)
      POST /v1/auth/logout
```

Access tokens are 15-minute JWTs `{ sub: accountId, did: deviceId }`.
Local IdP for development and tests: `docker compose up -d oidc-mock` (users alice, bob).
See `docs/superpowers/specs/2026-09-30-oidc-auth-design.md`.

## Key Design Decisions

| System | ID Type | Why |
|--------|---------|-----|
| ElevenLabs | HMAC-derived | Privacy — raw Happy ID never sent to ElevenLabs |
| RevenueCat | Pass-through | Direct correlation needed for subscription API calls |
| GitHub | Stored foreign key | Enables profile linking and account recovery via OAuth |
| AI vendors | Stored encrypted | User-owned keys, need to be retrievable |

## Local Scripting

To derive an ElevenLabs user ID from a Happy CUID locally:

```python
import hmac, hashlib, base64
digest = hmac.new(MASTER_SECRET.encode(), happy_cuid.encode(), hashlib.sha256).digest()
eleven_id = "u_" + base64.b64encode(digest).decode().replace("+","-").replace("/","_").rstrip("=")
```
