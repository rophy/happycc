# Deploying the server

The server (`packages/happy-server`) signs users in through your identity provider, holds their keys,
and syncs sessions between workstations and apps. Each organization runs its own; the apps and the
CLI have no default server. Building the apps is covered in [deploy-app.md](deploy-app.md).

## What it needs

| Dependency | Required | Notes |
|---|---|---|
| Postgres | yes | `DATABASE_URL` |
| OIDC identity provider | yes | One confidential client for the server (below) |
| Object storage (S3-compatible) | no | Uploaded images and avatars. Without `S3_HOST`, files are stored on local disk under `DATA_DIR` (default `./data`). |
| Redis | no | Used only when `REDIS_URL` is set |
| Push (Expo) | on by default | `PUSH_ENABLED=false` turns it off |

## Identity provider

Register one confidential OIDC client (authorization code flow) for the server:

- **Redirect URI:** `<PUBLIC_URL>/v1/auth/oidc/callback`. It is the only one: the CLI, the apps and
  `happycc-agent` all sign in through the server.
- **Scopes:** `openid profile email offline_access` (the default, `OIDC_SCOPES`). `offline_access` lets
  the server re-check users with the provider; without a refresh token from the provider, removing a
  user there does not cut off their existing sign-ins.
- **Issuer:** must be `https` (`OIDC_ALLOW_INSECURE_ISSUER=true` is for local development only).

Users are matched by issuer and subject, and their account is created on first sign-in. Who may use
happycc is decided in the provider, for example by assigning users or groups to the client.

## Configuration

**Required**

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `HANDY_MASTER_SECRET` | Protects every user's keys and the server's tokens; at least 32 characters. Keep it secret and backed up: without it, stored content cannot be read. |
| `PUBLIC_URL` | The server's external URL |
| `WEBAPP_URL` | The web app's URL (sign-in returns there) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | The identity provider client |

**Sign-in**

| Variable | Default | Purpose |
|---|---|---|
| `MOBILE_REDIRECT_URIS` | none | Comma-separated `<scheme>://auth/callback` of your mobile app builds ([deploy-app.md](deploy-app.md)) |
| `MOBILE_APP_NAME` | `the happycc app` | Name shown on the mobile sign-in confirmation page |
| `AUTH_ACCESS_TOKEN_TTL` | `15m` | Lifetime of an access token |
| `AUTH_MAX_SESSION_AGE` | `30d` | A sign-in ends this long after it started; the user signs in again |
| `AUTH_REFRESH_REUSE_GRACE` | `60s` | Window in which a retried refresh is not treated as token theft |

**Optional**

| Variable | Purpose |
|---|---|
| `PORT` | Listen port (default `3005`) |
| `S3_HOST`, `S3_PORT`, `S3_USE_SSL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`, `S3_REGION` | Object storage |
| `DATA_DIR` | Local file storage when S3 is not configured |
| `REDIS_URL` | Redis |
| `PUSH_ENABLED` | `false` disables push notifications |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URL` | GitHub integration; off unless all three are set |
| `METRICS_ENABLED`, `METRICS_PORT` | Prometheus metrics on a separate port (default `9090`) |
| `APP_STORE_URL`, `PLAY_STORE_URL` | Where outdated apps are sent to update |

Setting only some of the three GitHub variables is a startup error. Push notifications go through Expo's push
service and carry no session content: a fixed title, the body "Open the session to continue." and the
session id. Delivering them to your own app builds needs your EAS project, APNs key and FCM credentials.

## Running it

Build the image from `Dockerfile.server`. Apply database migrations before each start or upgrade,
then start the server:

```bash
pnpm exec prisma migrate deploy && pnpm run start
```

This is what the repository's `docker-compose.yaml` does; it is a complete local example with a mock
identity provider. Migrations must stay compatible with the release that is still running during a
rolling update.

## Managing access

- **Remove a user** in the identity provider. When their access token is next refreshed, the server
  re-checks them with the provider (at most once every 15 minutes per user) and revokes all their
  devices.
- **Disable an account** directly: set `disabledAt` on the user's row in the `Account` table (matched by
  `email` or `oidcSubject`). It takes effect at the device's next refresh or reconnect. There is no
  admin console yet.
- **Sign-ins expire** after `AUTH_MAX_SESSION_AGE`. Users sign out a device with `happycc auth logout`
  (or `happycc-agent auth logout`), which revokes it on the server.

## What the app can do on a workstation

A session's remote calls are registered by the CLI process that runs it, and the server lets only that
process register them, under its own session id. Workstations run no background service, so nothing
can start a session remotely. The calls the app makes into a session are limited to what its views need:
the git commands in `packages/happy-wire/src/sessionCommands.ts` (run without a shell, in the session
folder) and read-only file access inside that folder. Anything that changes the workstation goes
through the agent and its permission prompts.
