# Deploying the app (web, iOS, Android)

Every identity value of the app is build-time configuration, read by
`packages/happy-app/expoConfig.cjs`. There is no fallback to upstream identifiers:
production builds refuse to start without their own.

## Build environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `APP_ENV` | no | `development` | `development`, `preview` or `production`. Picks the defaults below. |
| `APP_NAME` | no | `Happy (dev)` / `Happy (preview)` / `Happy` | Display name. |
| `APP_SLUG` | no | `happy` | Expo slug. Must match the slug of your EAS project. |
| `APP_BUNDLE_ID` | production | `com.example.happy.dev` / `.preview` | iOS bundle id and Android package. |
| `APP_SCHEME` | production | `happy-dev` / `happy-preview` | URL scheme. Native sign-in returns to `${APP_SCHEME}://auth/callback`. |
| `HAPPY_SERVER_URL` | production | `http://localhost:3005` (development only) | The server this build talks to, e.g. `https://happy-api.example.com`. Inlined at build time; users cannot change it. |
| `APP_LINKS_HOST` | no | none | Host for iOS associated domains and Android app links, e.g. `happy.example.com`. Without it, none are emitted. |
| `EAS_PROJECT_ID` | no | none | EAS project id. Also enables EAS Updates (`https://u.expo.dev/<id>`). |
| `EAS_OWNER` | no | none | EAS account that owns the project. |
| `GOOGLE_SERVICES_FILE` | no | none | Path to your Firebase `google-services.json` (Android push). The file in the repo is not used unless this points to it. |
| `APP_ASSETS_DIR` | no | `./sources/assets/images` | Directory with your icons and splash images (same file names). |

Example production build:

```bash
APP_ENV=production \
APP_NAME="Acme Happy" \
APP_SLUG=acme-happy \
APP_BUNDLE_ID=com.example.happy \
APP_SCHEME=acmehappy \
HAPPY_SERVER_URL=https://happy-api.example.com \
EAS_PROJECT_ID=<your project id> EAS_OWNER=<your EAS account> \
eas build --platform all
```

## Server settings that pair with the build

- `MOBILE_REDIRECT_URIS` (comma-separated) must list `${APP_SCHEME}://auth/callback`
  for every native build, e.g. `acmehappy://auth/callback`. The server rejects any
  other redirect URI.
- `WEBAPP_URL` is the origin the web app is served from, e.g.
  `https://happy.example.com`. Web sign-in returns to `${WEBAPP_URL}/auth/callback`.
- `AUTH_ACCESS_TOKEN_TTL` must stay well above the clients' 2-minute refresh margin
  (5m or more; default 15m). At 2 minutes or less, clients refresh on every request.

## Web app

- Serve it over HTTPS (or `localhost`). Sign-in needs `crypto.subtle`, which browsers
  only expose in a secure context. On plain HTTP the app shows "This web app must be
  served over HTTPS (or localhost)." and does not start sign-in.
- `Dockerfile.webapp` builds a production web image; pass `HAPPY_SERVER_URL`,
  `APP_BUNDLE_ID` and `APP_SCHEME` as build args (the last two are unused on the web
  but required by production config).
- A deploy-time `window.__HAPPY_CONFIG__.serverUrl` overrides the build-time
  `HAPPY_SERVER_URL`. The standalone server injects it when it serves the web app
  itself, from `HAPPY_INJECT_HTML_CONFIG` (JSON, e.g. `{"serverUrl":"https://happy-api.example.com"}`).
- The image serves `/.well-known/` from the web root, but ships no files there. To
  enable universal links / app links for `APP_LINKS_HOST`, add your own
  `apple-app-site-association` and `assetlinks.json` to `packages/happy-app/public/.well-known/`.
