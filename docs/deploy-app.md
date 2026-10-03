# Deploying the app (web, iOS, Android)

Every identity value of the app is build-time configuration: one JSON file per
organization, read and strictly validated by `packages/happy-app/expoConfig.cjs`.
There is no fallback to upstream identifiers: production builds refuse to start
without their own.

## Build configuration

Two environment variables drive a build; everything else is in the app config file:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `APP_ENV` | no | `development` | `development`, `preview` or `production`. Picks the defaults below. |
| `APP_CONFIG` | production | none | Path of the app config JSON. A relative path resolves against `packages/happy-app`, wherever the command runs. Development and preview builds run without one on built-in placeholders. |

Build metadata for the Settings version row is not configuration: it comes from
`HAPPY_BUILD_COMMIT_SHA` / `HAPPY_BUILD_COMMIT_TIMESTAMP` (the `Dockerfile.webapp`
build args of the same name), else from CI (`EAS_BUILD_GIT_COMMIT_HASH`,
`GITHUB_SHA`) or `git`.

### App config file

Unknown keys, wrong types and invalid values fail the build with a message naming
each key. Relative paths inside the file resolve against the file's own directory.

| Key | Required | Default | Purpose |
|---|---|---|---|
| `name` | no | `brand.name`, plus ` (dev)` / ` (preview)` outside production | Display name (home screen, web page title). |
| `slug` | no | `happy` | Expo slug (lowercase, digits, dashes). Must match the slug of your EAS project. |
| `bundleId` | production | `com.example.happy.dev` / `.preview` | iOS bundle id and Android package. |
| `scheme` | production | `happy-dev` / `happy-preview` | URL scheme. Native sign-in returns to `<scheme>://auth/callback`. |
| `serverUrl` | production | `http://localhost:3005` (runtime fallback for development and preview) | The server this build talks to, e.g. `https://happy-api.example.com`. Users cannot change it. Production requires `https://` (`http://localhost` is allowed for local test builds); development and preview also accept `http://` to any host. |
| `linksHost` | no | none | Bare host for iOS associated domains and Android app links, e.g. `happy.example.com`. Without it, none are emitted. |
| `eas.projectId` | no | none | EAS project id. Also enables EAS Updates (`https://u.expo.dev/<id>`). |
| `eas.owner` | no | none | EAS account that owns the project. |
| `googleServicesFile` | no | none | Path to your Firebase `google-services.json` (Android push). The file in the repo is not used unless this points to it. |
| `assetsDir` | no | `packages/happy-app/sources/assets/images` | Directory with your icons and splash images (same file names). |
| `links.github` | no | `https://github.com/rophy/happycc` | Settings › GitHub. `null` hides the row. |
| `links.issues` | no | none | Issue tracker, e.g. `https://example.com/issues`. Settings › Report an Issue and the onboarding Get help button. |
| `links.privacy` | no | none | Settings › Privacy Policy. |
| `links.terms` | no | none | Settings › Terms of Service. |
| `links.help` | no | none | Setup help, linked from the new-session dock when no agent is available and from the Troubleshoot screen. |
| `analytics.posthogKey` | no | none | PostHog project key. Without it the app sends no analytics and hides the Analytics setting. |
| `analytics.posthogHost` | no | `https://us.i.posthog.com` | PostHog instance, e.g. your self-hosted `https://posthog.example.com`. Only used with a key. `https://`, or `http://localhost`/`http://127.0.0.1`. |
| `features.claudeConnect` | no | `false` | `true` shows the Claude.ai account connect screen, which talks to claude.ai directly. |
| `features.workstationOnly` | no | `true` | When true (default), the app only controls sessions started with `happycc` on a workstation; it cannot start, resume, fork or duplicate sessions, and hides machine screens. `false` restores session creation from the app. |
| `mermaidScriptUrl` | no | none | `https://` URL of a `mermaid.min.js` build, used by the native (iOS/Android) mermaid diagram renderer. Without it, native renders mermaid blocks as plain code instead of loading any script. There is no default CDN. Recommended: host an exact-version build yourself (e.g. `https://assets.example.com/mermaid@11.3.0/mermaid.min.js`). Web always uses the bundled `mermaid` package and ignores this key. |
| `logServerUrl` | no | none | Development tooling: `http://` or `https://` receiver for the app's remote console logs (`pnpm app-logs`). Rejected in production builds. |
| `brand.name` | no | `happycc` | Short product name. Replaces the whole word `Happy` in the app's UI text. |
| `brand.fullName` | no | `Happy Corporate Coder` | Full product name. Replaces the whole words `Happy Coder` in the app's UI text. |
| `brand.logo` | no | none | Path to a `.png`, `.jpg` or `.webp` wordmark (at most 256 KB) shown on the sign-in screen and in Settings, in a 300×90 box. It is embedded in the build as a data URI. Without it, `brand.name` is shown as text. Use an image that reads on both light and dark backgrounds. |

The `brand` names are substituted when text is displayed, in every language,
after any values (session or machine names) are filled in: a capitalized
standalone `Happy` in such a value is replaced too. Lowercase `happy` (commands,
URLs) and words that only contain `Happy` are left alone.

Links (`links.*`) must be `https://` (`http://localhost`/`http://127.0.0.1` is
accepted outside production). An absent link hides its row; there is no fallback
to upstream URLs.

Example, also committed as `deploy/app-config/org.example.json` (a test keeps it valid):

```json
{
    "name": "Acme Happy",
    "slug": "acme-happy",
    "bundleId": "com.example.happy",
    "scheme": "acmehappy",
    "serverUrl": "https://happy-api.example.com",
    "linksHost": "happy.example.com",
    "eas": {
        "projectId": "00000000-0000-0000-0000-000000000000",
        "owner": "example"
    },
    "assetsDir": "../../packages/happy-app/sources/assets/images",
    "links": {
        "github": "https://github.com/rophy/happycc",
        "issues": "https://example.com/happy/issues",
        "privacy": "https://example.com/privacy",
        "terms": "https://example.com/terms",
        "help": "https://example.com/happy/help"
    },
    "analytics": {
        "posthogKey": "phc_example",
        "posthogHost": "https://posthog.example.com"
    },
    "features": {
        "claudeConnect": false,
        "workstationOnly": true
    },
    "mermaidScriptUrl": "https://assets.example.com/mermaid@11.3.0/mermaid.min.js",
    "brand": {
        "name": "Acme Coder",
        "fullName": "Acme Corporate Coder"
    }
}
```

Example production build:

```bash
cd packages/happy-app
APP_ENV=production APP_CONFIG=../../deploy/app-config/acme.json eas build --platform all
```

For EAS cloud builds, the file must be part of the uploaded project, and
`APP_CONFIG` set in the `eas.json` build profile's `env` or as an EAS environment
variable.

`eas.json` carries no submit credentials. Add your own Apple account to the
`submit` profiles you use (`appleId`, `ascAppId`, `appleTeamId` under `ios`), or
pass them to `eas submit`.

## What's New

Settings › What's New shows the release notes bundled into the app. To publish your own:

1. Edit `packages/happy-app/CHANGELOG.md`. Each release is a `# <Date> - <Title>` section, newest first. An optional first plain line is the summary; the rest (usually `- ` bullets) is Markdown. A trailing `![alt](images/<file>)` on the heading line adds a title image.
2. Put title images in `packages/happy-app/sources/changelog/images/` and register each path in `CHANGELOG_IMAGES` in `sources/app/(app)/changelog.tsx` (Metro needs a static `require`).
3. Run `pnpm --filter happy-app changelog`. It regenerates `sources/changelog/changelog.json`, which is what the app bundles; commit both files.

The newest section's title marks the notes unread: when it changes, existing installs flag What's New until it is opened. A fresh install starts with them read.

## Server settings that pair with the build

- `MOBILE_REDIRECT_URIS` (comma-separated) must list `<scheme>://auth/callback`
  for every native build, e.g. `acmehappy://auth/callback`. The server rejects any
  other redirect URI.
- `MOBILE_APP_NAME` (optional) is the app name shown on the sign-in confirmation
  page phones see before a code is issued, e.g. `Acme Happy`. Defaults to
  `the happycc app`.
- `WEBAPP_URL` is the origin the web app is served from, e.g.
  `https://happy.example.com`. Web sign-in returns to `${WEBAPP_URL}/auth/callback`.
- `AUTH_ACCESS_TOKEN_TTL` must stay well above the clients' 2-minute refresh margin
  (5m or more; default 15m). At 2 minutes or less, clients refresh on every request.
- GitHub connect and push are server decisions. The app reads `GET /v1/features` after sign-in and hides the GitHub connect rows and push registration for anything the server has off.
  - Turn them on with `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` + `GITHUB_REDIRECT_URL`, and `PUSH_ENABLED` (default `true`). See `docs/deployment.md`.
- Voice is removed from the app: no mic button, voice settings, ElevenLabs/LiveKit SDKs, or microphone/camera permissions. There is nothing to configure.
- Push also needs your own EAS project (`eas.projectId`), APNs key and FCM credentials (`googleServicesFile`). Notifications carry only a fixed title per event, a generic body, and the session id.

## Web app

- Serve it over HTTPS (or `localhost`). Sign-in needs `crypto.subtle`, which browsers
  only expose in a secure context. On plain HTTP the app shows "This web app must be
  served over HTTPS (or localhost)." and does not start sign-in.
- `Dockerfile.webapp` builds a production web image from one build arg, `APP_CONFIG`: the config file's path in the build context, under `deploy/app-config/` (e.g. `--build-arg APP_CONFIG=deploy/app-config/acme.json`). Only `deploy/app-config/` and `packages/happy-app/` are copied into the build, so an `assetsDir` must point inside one of them. `bundleId` and `scheme` are unused on the web but required by the production config. The e2e stack builds with `deploy/app-config/e2e.json`.
- A deploy-time `window.__HAPPY_CONFIG__.serverUrl` overrides the build-time
  `serverUrl`. The standalone server injects it when it serves the web app
  itself, from `HAPPY_INJECT_HTML_CONFIG` (JSON, e.g. `{"serverUrl":"https://happy-api.example.com"}`).
- The image serves `/.well-known/` from the web root, but ships no files there. To
  enable universal links / app links for `linksHost`, add your own
  `apple-app-site-association` and `assetlinks.json` to `packages/happy-app/public/.well-known/`.
