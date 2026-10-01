# Third-Party Defaults and Content-Free Push Implementation Plan (Plan 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every third-party integration off unless the deployment configures it. Remove RevenueCat. Tell clients which server integrations are on through `GET /v1/features`. Strip content from push notifications. Give the CLI and happy-agent no built-in upstream server.

**Architecture:**
- **Server:** a new `featuresConfig` module parses integration env once at startup, with all-or-none validation. `integrationRoutes` registers `/v1/features` and, only when configured, the GitHub and voice routes. Voice takes its agent id and optional monthly cap from server env and no longer checks subscriptions. `/push-event` builds a fixed title per kind, a generic body and `{sessionId, kind, url}` data itself, and skips Expo when `PUSH_ENABLED=false`.
- **App:** it fetches the features after sign-in into sync state and hides the mic, the voice settings row, the GitHub connect UI and push registration when they are off. Build-time flags gate PostHog (`EXPO_PUBLIC_POSTHOG_API_KEY` / `_HOST`) and Claude.ai connect (`EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT=1`).
- **CLI:** it sends only the event kind. It exits with an error naming `HAPPY_SERVER_URL` when no server is configured. happy-agent follows the same rule.

**Tech Stack:** TypeScript, Fastify 5 + fastify-type-provider-zod (zod 4), Vitest, Expo / React Native (web via Metro), posthog-react-native, axios, pnpm 10.11.0 workspace, Playwright e2e against the docker compose stack.

**Spec:** `docs/superpowers/specs/2026-09-30-oidc-auth-design.md`, section "### Third-party integrations" (binding). Its "Decisions" table row "Third-party SaaS" gives the intent.

**Depends on:** Plans 1–3 and the happy-agent plan, as committed on branch `corp/third-party-off` (HEAD `37cf6ef0`).

## Global Constraints

- Third-party services are **off unless explicitly configured**. There is no fallback to upstream hosts, keys or agent ids anywhere.
- Server env (exact names):
  - Voice: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, and optionally `VOICE_MONTHLY_LIMIT_MINUTES`. Unset means no cap.
  - GitHub connect: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URL`.
  - Push: `PUSH_ENABLED` (default `true`).
  - The GitHub callback returns to `WEBAPP_URL`.
- App build env (exact names): `EXPO_PUBLIC_POSTHOG_API_KEY`, `EXPO_PUBLIC_POSTHOG_HOST`, `EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT=1`.
- `GET /v1/features` is authenticated and returns exactly `{ voice: boolean, githubConnect: boolean, push: boolean }`.
- Push payload data is exactly `{ sessionId, kind, url }`, with `url = /session/<encodeURIComponent(sessionId)>`. Titles are fixed per kind: `done` → `It's ready!`, `permission` → `Permission request`, `question` → `Clarification needed`. The body is always `Open the session to continue.`
- CLI and happy-agent: without `HAPPY_SERVER_URL` (or `serverUrl` in `~/.happy/settings.json` for the CLI), exit 1 with a message that starts with `HAPPY_SERVER_URL is not set`.
- Never log tokens, secrets, API keys, OAuth `state` values, or `Authorization` headers. Never log an axios error object, because it carries request headers; log `error.message`.
- Lockfile changes only remove packages. Every task that touches `pnpm-lock.yaml` runs the lockfile check in its steps, and the expected package@version set is listed there.
- Repo is pinned to `pnpm@10.11.0`; check with `pnpm --version` before any `pnpm add/remove/install`.
- Commit messages: `<type>: <short description>`, types feat/fix/refactor/chore/docs/build/test. No AI attribution, no `Co-Authored-By`, never mention Claude. Commits are GPG-signed automatically; never pass `--no-gpg-sign` or `-c commit.gpgsign=false`. Do not push.
- Docker: only ever touch compose project `happy` (run compose from the repo root). Never stop, remove or restart any other container, especially `oidc-mock-oidc-mock-1`. If a port is taken by another project, stop and report instead of freeing it.
- Commands:
  - **Wire:** build `pnpm --filter @slopus/happy-wire build`. Server and app resolve the built `dist/`, so rebuild after every wire change.
  - **Server:** unit `pnpm --filter happy-server exec vitest run <files>`; full `pnpm --filter happy-server test`; typecheck `pnpm --filter happy-server typecheck`.
  - **App:** unit `pnpm --filter happy-app exec vitest run <files>`; full `pnpm --filter happy-app exec vitest run`; typecheck `pnpm --filter happy-app typecheck`.
  - **CLI:** unit `pnpm --filter happy exec vitest run --project unit <files>`; full `pnpm --filter happy test` (builds first); typecheck `pnpm --filter happy typecheck`.
  - **Agent:** unit `pnpm --filter happy-agent exec vitest run <files>`; full `pnpm --filter happy-agent test` (builds first); typecheck `pnpm --filter happy-agent typecheck`.
  - **Web e2e (from repo root):**
    ```bash
    AUTH_REFRESH_REUSE_GRACE=0s AUTH_ACCESS_TOKEN_TTL=3m docker compose --profile e2e up -d --build
    (cd e2e && npx playwright test)
    docker compose --profile e2e down
    ```
    The two env values match CI (`.github/workflows/web-e2e.yml`); without them the socket test skips.
- Known pre-existing failures. Do not fix them and do not count them as regressions:
  - app `sources/**/sessionPresentation.test.ts`;
  - CLI `scripts/claude_version_utils.test.ts` (a stray `/tmp/package.json` on this host);
  - an occasional server `testDb.test.ts` timeout under load (re-run once).

**Lockfile check** (used by Tasks 3 and 6; run from the repo root after the `pnpm remove`, before committing):

```bash
lockkeys() { awk '/^packages:/{p=1;next} /^snapshots:/{p=0} p && /^  [^ ]/' | sed -e 's/^  //' -e 's/:$//' -e "s/'//g" | sort; }
LOCKCHK=$(mktemp -d)
git show HEAD:pnpm-lock.yaml | lockkeys > "$LOCKCHK/before.txt"
lockkeys < pnpm-lock.yaml > "$LOCKCHK/after.txt"
diff "$LOCKCHK/before.txt" "$LOCKCHK/after.txt" | grep -E '^[<>]'
git diff -U0 pnpm-lock.yaml | grep -E '^\+[^+]' || echo "lockfile: deletions only"
```

The first command must print only `<` lines, exactly the set the task lists. The second must print `lockfile: deletions only`. If either differs, do not commit; investigate and report the extra entries.

## Rulings

- **Feature config lives in `packages/happy-server/sources/app/features/featuresConfig.ts`.** It follows the `authConfig.ts` pattern: a pure `loadFeaturesConfig(env)`, called once in `startApi`.
  - Partial configuration is a startup error that names the missing variables, e.g. only one of `ELEVENLABS_API_KEY` / `ELEVENLABS_AGENT_ID`, or one or two of the three GitHub OAuth settings. Silently half-enabling an integration is worse than failing fast. The error lists variable names, never values.
  - `VOICE_MONTHLY_LIMIT_MINUTES` must be a positive whole number.
  - `PUSH_ENABLED` accepts `true/false/1/0`, case-insensitive. Anything else is a startup error.
- **GitHub routes move to a new `githubRoutes.ts`.** The four `/v1/connect/github*` routes move out of `connectRoutes.ts`. `connectRoutes` keeps the global JSON content-type parser (other routes rely on its empty-body handling and `rawBody`) and the vendor-token routes (`happy connect`), and stays registered unconditionally.
  - "GitHub OAuth settings" means `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` + `GITHUB_REDIRECT_URL`, the three the OAuth handlers read. The GitHub App settings (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_REDIRECT_URI`) still only drive `initGithub()` for webhooks.
  - The webhook route is part of the GitHub route group.
- **Conditional registration goes through `integrationRoutes(app, features, { webappUrl })`.** A route test can then prove "not configured → 404" without starting the whole API.
- **"Monthly" voice cap uses the existing accounting window**, the rolling 30 days queried from ElevenLabs by `user_id`. No local usage table is added.
  - With no cap, `/v1/voice/conversations` does not query usage at all.
  - With a cap, two denials remain. `voice_monthly_limit_reached` applies when the used seconds reach the cap. `voice_conversation_limit_reached` applies at 100 conversations, because ElevenLabs returns at most 100 per query and usage past that cannot be counted, so the route fails closed.
  - The upstream 20-minute free tier, the 5-hour hard cap and the subscription check are removed.
  - ElevenLabs usage-query failures still count as zero usage (existing fail-open behavior, unchanged).
- **Wire voice schema changes.**
  - Denied reasons become `['voice_monthly_limit_reached', 'voice_conversation_limit_reached']`.
  - Granted `limitSeconds` and usage `limitSeconds` / `conversationLimit` become nullable (`null` = no cap).
  - The request body is ignored (old apps that still send `{agentId}` keep working; the server uses `ELEVENLABS_AGENT_ID`).
- **The voice-upsell experiment is removed with RevenueCat.**
  - Removed: `voiceExperiment.ts`, the `voiceUpsellOverride` local setting, the soft paywall, the paid-onboarding prompt, the soft-paywall and onboarding counters, and the voice developer group in voice settings. All of it existed only to sell the subscription.
  - The `voice_message_count` runtime counter stays, because realtime tools still use it.
- **Voice limit message.** The app shows one new string, `errors.voiceMonthlyLimitReached`, for both denials. It is added to `_default.ts` and all ten translation files, because translations are type-checked against `TranslationStructure`. Translation keys that become unused (support/paywall/subscription copy) are left in place to avoid churn in ten files; nothing renders them.
- **App features state.**
  - `features` lives in the Zustand `storage` with all-false defaults and is not persisted. UI that depends on it stays hidden until the first fetch completes.
  - A 404 from `/v1/features` (a server without the endpoint) maps to all-false.
  - Push registration waits for the features fetch, then registers only when `push` is true.
  - The account screen hides its push groups when `push` is off. Its GitHub profile row stays visible (it is profile data) but loses its disconnect action when `githubConnect` is off, since the route is not registered.
- **Mic hiding covers every voice entry point.** The composer mic in `SessionView` and the "Voice Assistant" settings row are hidden when `voice` is off. `VoiceAssistantStatusBar` only renders during a live call. The bring-your-own-agent path (app → ElevenLabs directly) is only reachable through the mic, so it is off too. The BYO settings themselves are upstream behavior and stay.
- **Claude.ai connect is a build flag.**
  - Without it the settings "Claude Code" row and the dev-menu "Claude OAuth Test" row are hidden, and `/settings/connect/claude` redirects to `/settings`.
  - `utils/oauth.ts` stays because OIDC login uses its `generatePKCE`.
  - The account screen's "Connected Services" list (server vendor tokens from `happy connect`) is not Claude.ai connect and is unchanged.
- **PostHog.**
  - On only with a non-blank key. The host defaults to `https://us.i.posthog.com` when only the key is set. `EXPO_PUBLIC_POSTHOG_HOST` selects a self-hosted instance, with any trailing slash removed.
  - The existing kill switches (`EXPO_PUBLIC_DISABLE_ANALYTICS`, `window.__HAPPY_CONFIG__.disableAnalytics`) still win.
  - The legacy `EXPO_PUBLIC_POSTHOG_KEY` override is dropped, leaving one name.
  - Env overrides are read with literal `process.env.EXPO_PUBLIC_*` accesses, because Metro only inlines literal accesses; passing `process.env` as an object is empty on web.
- **Push.**
  - The server ignores client `title`/`body`/`data` (zod strips them), so old CLIs keep working. The socket `session-event` ephemeral carries the same fixed copy.
  - `PUSH_ENABLED=false` skips Expo and answers `result: 'disabled'`. The socket ephemeral (in-app tab counter, no third party) is still emitted.
  - Push-token endpoints stay.
- **CLI push fallback.**
  - `sendToAllDevices` sent arbitrary text straight to Expo from the CLI. Its only caller is `happy notify`, so the command is removed with it. `fetchPushTokens` and `expo-server-sdk` then have no users and are removed.
  - `sendSessionNotification({ kind, sessionId })` always goes through the server, and its "missing sessionId → direct Expo" fallback disappears with the parameter change.
- **CLI URL guard.**
  - `configuration.serverUrl` becomes a getter that throws `MissingServerUrlError`.
  - `index.ts` checks up front and exits 1 for every command except `--help/-h/--version/-v`, `doctor`, `bye`, and the local daemon subcommands `status/stop/list/stop-session/logs/uninstall`. So the CI smoke test (`--help`, `--version`, `doctor`, `daemon status`) needs no env.
  - `webappUrl` loses its default and becomes `string | null`. Nothing reads it, so it is not required; the spec's "no built-in web app URL" is satisfied by having no default.
- **happy-agent** defaulted to `https://api.cluster-fluster.com`, so it gets the same rule: `loadConfig()` throws `HAPPY_SERVER_URL is not set…`. The agent has no settings file.
- **Docs.** Operator docs are updated: `docs/deployment.md`, `docs/deploy-app.md`, the CLI and agent READMEs, and server `.env.dev`. Historical or upstream-only docs are deliberately left unchanged: `PRIVACY.md`, `docs/paid-voice.md`, `docs/product-analytics.md`, `docs/user-identity.md`, `docs/3dparty.md`, `docs/plans/*`, `packages/happy-app/Stores.md`, `.agents/skills/release/SKILL.md`. The upstream k8s manifest `packages/happy-server/deploy/handy.yaml` loses its `/handy-revenuecat` secret.

## File Structure

```
packages/happy-wire/src/
  features.ts                                  create: FeaturesResponseSchema
  voice.ts                                     modify: new denial reasons, nullable limits
  index.ts                                     modify: export features
packages/happy-server/sources/app/
  features/featuresConfig.ts (+ .test.ts)      create: loadFeaturesConfig, publicFeatures, describeFeatures
  api/routes/featuresRoutes.ts                 create: GET /v1/features
  api/routes/githubRoutes.ts (+ .spec.ts)      create: GitHub routes moved from connectRoutes; WEBAPP_URL redirects
  api/routes/integrationRoutes.ts (+ .spec.ts) create: conditional registration
  api/routes/connectRoutes.ts                  modify: drop GitHub routes
  api/routes/voiceRoutes.ts (+ .spec.ts)       rewrite: VoiceConfig, no RevenueCat, optional cap
  api/routes/pushRoutes.ts, pushRoutes.spec.ts modify: kind-only body, fixed copy, PUSH_ENABLED
  push/pushCopy.ts (+ .test.ts)                create: buildSessionEventPush
  push/pushDispatch.ts                         modify: build copy from kind
  api/api.ts                                   modify: load features, integrationRoutes, pushRoutes opts
packages/happy-server/.env.dev, deploy/handy.yaml   modify
packages/happy-app/
  package.json                                 modify: drop RevenueCat deps
  expoConfig.cjs                               modify: drop ElevenLabs/RevenueCat; add postHogHost, enableClaudeConnect
  sources/appConfig.test.ts                    modify
  sources/sync/appConfig.ts                    modify: fields + applyAppConfigEnv
  sources/sync/appConfigEnv.ts (+ .test.ts)    create
  sources/sync/apiFeatures.ts (+ .test.ts)     create: fetchServerFeatures
  sources/sync/apiVoice.ts (+ .test.ts)        modify: no agent id
  sources/sync/storage.ts                      modify: drop purchases, add features
  sources/sync/sync.ts                         modify: drop purchases/paywall, add featuresSync, gate push
  sources/sync/persistence.ts                  modify: drop purchases + paywall counters
  sources/sync/localSettings.ts                modify: drop voiceUpsellOverride
  delete: sources/sync/revenueCat/, sources/sync/purchases.ts, sources/app/(app)/dev/purchases.tsx,
          sources/realtime/voiceExperiment.ts
  sources/realtime/RealtimeSession.ts          modify: no paywall/upsell
  sources/realtime/voiceSystemPrompt.ts (+ .test.ts)  modify: no paid onboarding
  sources/track/postHogConfig.ts (+ .test.ts)  create
  sources/track/tracking.ts, track/index.ts    modify
  sources/components/SettingsView.tsx          modify
  sources/app/(app)/settings/voice.tsx         rewrite
  sources/app/(app)/settings/account.tsx       modify
  sources/app/(app)/settings/connect/claude.tsx modify: redirect when disabled
  sources/app/(app)/dev/index.tsx              modify
  sources/app/_layout.tsx                      modify
  sources/-session/SessionView.tsx             modify
  sources/text/_default.ts, sources/text/translations/*.ts  modify: errors.voiceMonthlyLimitReached
  sources/sync/{sync.preload,sync.send,rigComposer,sessionArchiving}.test.ts  modify: drop purchase mocks
packages/happy-cli/
  src/serverUrl.ts (+ .test.ts)                create
  src/configuration.ts, src/index.ts, src/ui/doctor.ts   modify
  src/api/pushNotifications.ts (+ .test.ts)    rewrite
  src/api/api.ts, src/claude/claudeRemoteLauncher.ts, src/claude/utils/permissionHandler.ts (+ .test.ts),
  src/gemini/runGemini.ts, src/codex/runCodex.ts          modify: sendSessionNotification({kind, sessionId})
  package.json, README.md                      modify
packages/happy-agent/src/config.ts, config.test.ts, cli-smoke.test.ts, index.test.ts, README.md   modify
Dockerfile.webapp, docs/deploy-app.md, docs/deployment.md                     modify
e2e/tests/integrations.spec.ts                 create
pnpm-lock.yaml                                 modify (deletions only)
```

---

### Task 1: Server features config, `GET /v1/features`, conditional GitHub routes

**Files:**
- Create: `packages/happy-wire/src/features.ts`
- Modify: `packages/happy-wire/src/index.ts`
- Create: `packages/happy-server/sources/app/features/featuresConfig.ts`
- Test: `packages/happy-server/sources/app/features/featuresConfig.test.ts`
- Create: `packages/happy-server/sources/app/api/routes/featuresRoutes.ts`
- Create: `packages/happy-server/sources/app/api/routes/githubRoutes.ts`
- Test: `packages/happy-server/sources/app/api/routes/githubRoutes.spec.ts`
- Create: `packages/happy-server/sources/app/api/routes/integrationRoutes.ts`
- Test: `packages/happy-server/sources/app/api/routes/integrationRoutes.spec.ts`
- Modify: `packages/happy-server/sources/app/api/routes/connectRoutes.ts`
- Modify: `packages/happy-server/sources/app/api/api.ts:106-124`
- Modify: `docs/deployment.md` ("Optional integrations")

**Interfaces:**
- Produces (wire):
  ```ts
  const FeaturesResponseSchema: z.ZodObject<{ voice: z.ZodBoolean; githubConnect: z.ZodBoolean; push: z.ZodBoolean }>
  type FeaturesResponse = { voice: boolean; githubConnect: boolean; push: boolean }
  ```
- Produces (server `featuresConfig.ts`):
  ```ts
  interface VoiceConfig { apiKey: string; agentId: string; monthlyLimitSeconds: number | null }
  interface GithubOAuthConfig { clientId: string; clientSecret: string; redirectUrl: string }
  interface FeaturesConfig { voice: VoiceConfig | null; github: GithubOAuthConfig | null; pushEnabled: boolean }
  type PublicFeatures = FeaturesResponse
  function loadFeaturesConfig(env?: NodeJS.ProcessEnv): FeaturesConfig   // throws on partial/invalid config
  function publicFeatures(config: FeaturesConfig): PublicFeatures
  function describeFeatures(config: FeaturesConfig): string               // e.g. "voice=on (cap 60 min/30 days) githubConnect=off push=on"
  ```
- Produces (routes):
  ```ts
  function featuresRoutes(app: Fastify, features: PublicFeatures): void
  function webappRedirectUrl(webappUrl: string, params: Record<string, string>): string
  function githubRoutes(app: Fastify, opts: { github: GithubOAuthConfig; webappUrl: string }): void
  function integrationRoutes(app: Fastify, features: FeaturesConfig, opts: { webappUrl: string }): void
  ```
  In this task `integrationRoutes` calls the existing `voiceRoutes(app)`. Task 2 changes it to `voiceRoutes(app, features.voice)`.

- [ ] **Step 1: Add the wire schema**

```ts
// packages/happy-wire/src/features.ts
import * as z from 'zod';

/** GET /v1/features: which server-side integrations this deployment has turned on. */
export const FeaturesResponseSchema = z.object({
    voice: z.boolean(),
    githubConnect: z.boolean(),
    push: z.boolean(),
});

export type FeaturesResponse = z.infer<typeof FeaturesResponseSchema>;
```

In `packages/happy-wire/src/index.ts`, add after `export * from './voice';`:

```ts
export * from './features';
```

Run: `pnpm --filter @slopus/happy-wire build`
Expected: build succeeds.

- [ ] **Step 2: Write the failing config test**

```ts
// packages/happy-server/sources/app/features/featuresConfig.test.ts
import { describe, expect, it } from 'vitest';
import { describeFeatures, loadFeaturesConfig, publicFeatures } from './featuresConfig';

const voiceEnv = { ELEVENLABS_API_KEY: 'xi-key', ELEVENLABS_AGENT_ID: 'agent_corp' };
const githubEnv = {
    GITHUB_CLIENT_ID: 'gh-client',
    GITHUB_CLIENT_SECRET: 'gh-secret',
    GITHUB_REDIRECT_URL: 'https://happy.corp.example/v1/connect/github/callback',
};

describe('loadFeaturesConfig', () => {
    it('turns every integration off except push by default', () => {
        const cfg = loadFeaturesConfig({});
        expect(cfg).toEqual({ voice: null, github: null, pushEnabled: true });
        expect(publicFeatures(cfg)).toEqual({ voice: false, githubConnect: false, push: true });
    });

    it('enables voice only when both ElevenLabs settings are set', () => {
        expect(loadFeaturesConfig(voiceEnv).voice).toEqual({ apiKey: 'xi-key', agentId: 'agent_corp', monthlyLimitSeconds: null });
        expect(() => loadFeaturesConfig({ ELEVENLABS_API_KEY: 'xi-key' })).toThrow('ELEVENLABS_AGENT_ID');
        expect(() => loadFeaturesConfig({ ELEVENLABS_AGENT_ID: 'agent_corp' })).toThrow('ELEVENLABS_API_KEY');
    });

    it('treats blank values as unset', () => {
        expect(loadFeaturesConfig({ ELEVENLABS_API_KEY: '  ', ELEVENLABS_AGENT_ID: '' }).voice).toBeNull();
    });

    it('parses VOICE_MONTHLY_LIMIT_MINUTES as a positive whole number', () => {
        expect(loadFeaturesConfig({ ...voiceEnv, VOICE_MONTHLY_LIMIT_MINUTES: '90' }).voice?.monthlyLimitSeconds).toBe(5400);
        for (const bad of ['0', '-5', '1.5', 'lots']) {
            expect(() => loadFeaturesConfig({ ...voiceEnv, VOICE_MONTHLY_LIMIT_MINUTES: bad })).toThrow('VOICE_MONTHLY_LIMIT_MINUTES');
        }
    });

    it('enables GitHub connect only when all OAuth settings are set', () => {
        expect(loadFeaturesConfig(githubEnv).github).toEqual({
            clientId: 'gh-client',
            clientSecret: 'gh-secret',
            redirectUrl: 'https://happy.corp.example/v1/connect/github/callback',
        });
        expect(() => loadFeaturesConfig({ GITHUB_CLIENT_ID: 'gh-client' })).toThrow('GITHUB_CLIENT_SECRET');
        expect(() => loadFeaturesConfig({ GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret' })).toThrow('GITHUB_REDIRECT_URL');
    });

    it('parses PUSH_ENABLED', () => {
        for (const off of ['false', 'FALSE', '0']) {
            expect(loadFeaturesConfig({ PUSH_ENABLED: off }).pushEnabled).toBe(false);
        }
        for (const on of ['true', 'True', '1']) {
            expect(loadFeaturesConfig({ PUSH_ENABLED: on }).pushEnabled).toBe(true);
        }
        expect(() => loadFeaturesConfig({ PUSH_ENABLED: 'nope' })).toThrow('PUSH_ENABLED');
    });

    it('never puts values into errors or the startup summary', () => {
        expect(() => loadFeaturesConfig({ ELEVENLABS_API_KEY: 'xi-very-secret' })).toThrow(/^(?!.*xi-very-secret)/);
        const text = describeFeatures(loadFeaturesConfig({ ...voiceEnv, ...githubEnv, VOICE_MONTHLY_LIMIT_MINUTES: '60', PUSH_ENABLED: 'false' }));
        expect(text).toBe('voice=on (cap 60 min/30 days) githubConnect=on push=off');
        expect(text).not.toContain('secret');
        expect(describeFeatures(loadFeaturesConfig({}))).toBe('voice=off githubConnect=off push=on');
    });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter happy-server exec vitest run sources/app/features/featuresConfig.test.ts`
Expected: FAIL, `./featuresConfig` cannot be resolved.

- [ ] **Step 4: Implement the config**

```ts
// packages/happy-server/sources/app/features/featuresConfig.ts
import type { FeaturesResponse } from '@slopus/happy-wire';

export interface VoiceConfig {
    apiKey: string;
    agentId: string;
    /** null = no cap. Counted over the rolling 30 days ElevenLabs reports. */
    monthlyLimitSeconds: number | null;
}

export interface GithubOAuthConfig {
    clientId: string;
    clientSecret: string;
    redirectUrl: string;
}

export interface FeaturesConfig {
    voice: VoiceConfig | null;
    github: GithubOAuthConfig | null;
    pushEnabled: boolean;
}

export type PublicFeatures = FeaturesResponse;

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
    const value = env[name]?.trim();
    return value ? value : null;
}

/** All of `names` set → their values; none set → null; some set → startup error (names only, never values). */
function allOrNone(env: NodeJS.ProcessEnv, names: string[], label: string): string[] | null {
    const values = names.map((name) => optional(env, name));
    const present = names.filter((_, i) => values[i] !== null);
    if (present.length === 0) {
        return null;
    }
    if (present.length !== names.length) {
        const missing = names.filter((_, i) => values[i] === null);
        throw new Error(`${label} is partially configured: set ${missing.join(' and ')} too, or unset ${present.join(' and ')}`);
    }
    return values as string[];
}

function parseMonthlyLimitSeconds(value: string | null): number | null {
    if (value === null) {
        return null;
    }
    if (!/^\d+$/.test(value) || parseInt(value, 10) <= 0) {
        throw new Error(`VOICE_MONTHLY_LIMIT_MINUTES must be a positive whole number of minutes, got "${value}"`);
    }
    return parseInt(value, 10) * 60;
}

function parsePushEnabled(value: string | null): boolean {
    if (value === null) {
        return true;
    }
    const normalized = value.toLowerCase();
    if (normalized === 'true' || normalized === '1') {
        return true;
    }
    if (normalized === 'false' || normalized === '0') {
        return false;
    }
    throw new Error(`PUSH_ENABLED must be true or false, got "${value}"`);
}

export function loadFeaturesConfig(env: NodeJS.ProcessEnv = process.env): FeaturesConfig {
    const voice = allOrNone(env, ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID'], 'Voice');
    const github = allOrNone(env, ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_REDIRECT_URL'], 'GitHub connect');
    const monthlyLimitSeconds = parseMonthlyLimitSeconds(optional(env, 'VOICE_MONTHLY_LIMIT_MINUTES'));
    return {
        voice: voice ? { apiKey: voice[0], agentId: voice[1], monthlyLimitSeconds } : null,
        github: github ? { clientId: github[0], clientSecret: github[1], redirectUrl: github[2] } : null,
        pushEnabled: parsePushEnabled(optional(env, 'PUSH_ENABLED')),
    };
}

export function publicFeatures(config: FeaturesConfig): PublicFeatures {
    return {
        voice: config.voice !== null,
        githubConnect: config.github !== null,
        push: config.pushEnabled,
    };
}

export function describeFeatures(config: FeaturesConfig): string {
    const voice = config.voice
        ? `on${config.voice.monthlyLimitSeconds !== null ? ` (cap ${config.voice.monthlyLimitSeconds / 60} min/30 days)` : ''}`
        : 'off';
    return `voice=${voice} githubConnect=${config.github ? 'on' : 'off'} push=${config.pushEnabled ? 'on' : 'off'}`;
}
```

Run: `pnpm --filter happy-server exec vitest run sources/app/features/featuresConfig.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing GitHub route test**

```ts
// packages/happy-server/sources/app/api/routes/githubRoutes.spec.ts
import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const { authMock, githubConnectMock } = vi.hoisted(() => ({
    authMock: {
        createGithubToken: vi.fn(async () => 'state-1'),
        verifyGithubToken: vi.fn(async (state: string) => (state === 'state-1' ? { userId: 'user-1' } : null)),
    },
    githubConnectMock: vi.fn(async () => undefined),
}));

vi.mock("@/app/auth/auth", () => ({ auth: authMock }));
vi.mock("@/app/github/githubConnect", () => ({ githubConnect: githubConnectMock }));
vi.mock("@/app/github/githubDisconnect", () => ({ githubDisconnect: vi.fn(async () => undefined) }));
vi.mock("@/context", () => ({ Context: { create: (uid: string) => ({ uid }) } }));

import { githubRoutes, webappRedirectUrl } from "./githubRoutes";

const github = {
    clientId: 'gh-client',
    clientSecret: 'gh-secret',
    redirectUrl: 'https://happy.corp.example/v1/connect/github/callback',
};
const WEBAPP = 'https://app.corp.example';

async function buildApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => { request.userId = 'user-1'; });
    githubRoutes(typed, { github, webappUrl: WEBAPP });
    await typed.ready();
    return typed;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('webappRedirectUrl', () => {
    it('appends query parameters to WEBAPP_URL', () => {
        expect(webappRedirectUrl('https://app.corp.example', { error: 'invalid_state' })).toBe('https://app.corp.example/?error=invalid_state');
        expect(webappRedirectUrl('https://corp.example/happy', { github: 'connected', user: 'a b' })).toBe('https://corp.example/happy/?github=connected&user=a+b');
    });
});

describe('GitHub routes', () => {
    it('builds the authorize URL from server configuration', async () => {
        const app = await buildApp();
        const res = await app.inject({ method: 'GET', url: '/v1/connect/github/params' });
        expect(res.statusCode).toBe(200);
        const url = new URL(res.json().url);
        expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
        expect(url.searchParams.get('client_id')).toBe('gh-client');
        expect(url.searchParams.get('redirect_uri')).toBe(github.redirectUrl);
        expect(url.searchParams.get('state')).toBe('state-1');
        await app.close();
    });

    it('returns to WEBAPP_URL with an error for an unknown state', async () => {
        const app = await buildApp();
        const res = await app.inject({ method: 'GET', url: '/v1/connect/github/callback?code=c&state=forged' });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('https://app.corp.example/?error=invalid_state');
        await app.close();
    });

    it('returns to WEBAPP_URL after connecting the account', async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
            const url = String(input);
            if (url === 'https://github.com/login/oauth/access_token') {
                return new Response(JSON.stringify({ access_token: 'gho_test' }), { status: 200 });
            }
            if (url === 'https://api.github.com/user') {
                return new Response(JSON.stringify({ id: 1, login: 'octocat' }), { status: 200 });
            }
            return new Response('unexpected', { status: 500 });
        }));
        const app = await buildApp();
        const res = await app.inject({ method: 'GET', url: '/v1/connect/github/callback?code=c&state=state-1' });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('https://app.corp.example/?github=connected&user=octocat');
        expect(githubConnectMock).toHaveBeenCalledOnce();
        await app.close();
    });

    it('returns GitHub OAuth errors to WEBAPP_URL', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 })));
        const app = await buildApp();
        const res = await app.inject({ method: 'GET', url: '/v1/connect/github/callback?code=c&state=state-1' });
        expect(res.headers.location).toBe('https://app.corp.example/?error=bad_verification_code');
        await app.close();
    });
});
```

Run: `pnpm --filter happy-server exec vitest run sources/app/api/routes/githubRoutes.spec.ts`
Expected: FAIL, `./githubRoutes` cannot be resolved.

- [ ] **Step 6: Create `githubRoutes.ts` and slim `connectRoutes.ts`**

```ts
// packages/happy-server/sources/app/api/routes/githubRoutes.ts
import { z } from "zod";
import { type Fastify, GitHubProfile } from "../types";
import { auth } from "@/app/auth/auth";
import { log } from "@/utils/log";
import { githubConnect } from "@/app/github/githubConnect";
import { githubDisconnect } from "@/app/github/githubDisconnect";
import { Context } from "@/context";
import type { GithubOAuthConfig } from "@/app/features/featuresConfig";

/** `${WEBAPP_URL}/?<params>`; WEBAPP_URL may carry a path. */
export function webappRedirectUrl(webappUrl: string, params: Record<string, string>): string {
    const url = new URL(`${webappUrl}/`);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }
    return url.toString();
}

/**
 * GitHub account connect. Registered only when GITHUB_CLIENT_ID,
 * GITHUB_CLIENT_SECRET and GITHUB_REDIRECT_URL are all set. The OAuth
 * callback always returns to WEBAPP_URL.
 */
export function githubRoutes(app: Fastify, opts: { github: GithubOAuthConfig; webappUrl: string }) {
    const { github, webappUrl } = opts;
    const backToWebapp = (params: Record<string, string>) => webappRedirectUrl(webappUrl, params);

    app.get('/v1/connect/github/params', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({ url: z.string() }),
            },
        },
    }, async (request, reply) => {
        // Ephemeral state token (5 minutes TTL)
        const state = await auth.createGithubToken(request.userId);
        const params = new URLSearchParams({
            client_id: github.clientId,
            redirect_uri: github.redirectUrl,
            scope: 'read:user,user:email,read:org,codespace',
            state,
        });
        return reply.send({ url: `https://github.com/login/oauth/authorize?${params.toString()}` });
    });

    app.get('/v1/connect/github/callback', {
        schema: {
            querystring: z.object({
                code: z.string(),
                state: z.string(),
            }),
        },
    }, async (request, reply) => {
        const { code, state } = request.query;

        const tokenData = await auth.verifyGithubToken(state);
        if (!tokenData) {
            // Never log the state value: it is a bearer token for this flow.
            log({ module: 'github-oauth' }, 'Invalid or expired GitHub OAuth state');
            return reply.redirect(backToWebapp({ error: 'invalid_state' }));
        }

        try {
            const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    client_id: github.clientId,
                    client_secret: github.clientSecret,
                    code,
                }),
            });
            const tokenResponseData = await tokenResponse.json() as {
                access_token?: string;
                error?: string;
                error_description?: string;
            };
            if (tokenResponseData.error) {
                return reply.redirect(backToWebapp({ error: tokenResponseData.error }));
            }
            const accessToken = tokenResponseData.access_token;

            const userResponse = await fetch('https://api.github.com/user', {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/vnd.github.v3+json',
                },
            });
            const userData = await userResponse.json() as GitHubProfile;
            if (!userResponse.ok) {
                return reply.redirect(backToWebapp({ error: 'github_user_fetch_failed' }));
            }

            const ctx = Context.create(tokenData.userId);
            await githubConnect(ctx, userData, accessToken!);
            return reply.redirect(backToWebapp({ github: 'connected', user: userData.login }));
        } catch (error) {
            log({ module: 'github-oauth' }, `Error in GitHub GET callback: ${error instanceof Error ? error.message : String(error)}`);
            return reply.redirect(backToWebapp({ error: 'server_error' }));
        }
    });

    app.post('/v1/connect/github/webhook', {
        schema: {
            headers: z.object({
                'x-hub-signature-256': z.string(),
                'x-github-event': z.string(),
                'x-github-delivery': z.string().optional(),
            }).passthrough(),
            body: z.any(),
            response: {
                200: z.object({ received: z.boolean() }),
                401: z.object({ error: z.string() }),
                500: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const signature = request.headers['x-hub-signature-256'];
        const eventName = request.headers['x-github-event'];
        const deliveryId = request.headers['x-github-delivery'];
        // Set by the JSON content-type parser registered in connectRoutes.
        const rawBody = (request as any).rawBody;

        if (!rawBody) {
            log({ module: 'github-webhook', level: 'error' }, 'Raw body not available for webhook signature verification');
            return reply.code(500).send({ error: 'Server configuration error' });
        }

        const { getWebhooks } = await import("@/modules/github");
        const webhooks = getWebhooks();
        if (!webhooks) {
            log({ module: 'github-webhook', level: 'error' }, 'GitHub webhooks not initialized');
            return reply.code(500).send({ error: 'Webhooks not configured' });
        }

        try {
            await webhooks.verifyAndReceive({
                id: deliveryId || 'unknown',
                name: eventName,
                payload: typeof rawBody === 'string' ? rawBody : JSON.stringify(request.body),
                signature,
            });
            return reply.send({ received: true });
        } catch {
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });

    app.delete('/v1/connect/github', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({ success: z.literal(true) }),
                500: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        try {
            await githubDisconnect(ctx);
            return reply.send({ success: true });
        } catch {
            return reply.code(500).send({ error: 'Failed to disconnect GitHub account' });
        }
    });
}
```

In `packages/happy-server/sources/app/api/routes/connectRoutes.ts`, delete everything from the comment `// GitHub OAuth parameters` through the end of the `app.delete('/v1/connect/github', …)` handler (the four GitHub routes now in `githubRoutes.ts`). Keep the content-type parser and everything from `// Inference endpoints` on. Then set the imports to exactly:

```ts
import { z } from "zod";
import { type Fastify } from "../types";
import { debug } from "@/utils/log";
import { decryptString, encryptString } from "@/modules/encrypt";
import { db } from "@/storage/db";
```

Run: `pnpm --filter happy-server exec vitest run sources/app/api/routes/githubRoutes.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Write the failing registration test**

```ts
// packages/happy-server/sources/app/api/routes/integrationRoutes.spec.ts
import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

vi.mock("@/app/auth/auth", () => ({
    auth: { createGithubToken: vi.fn(async () => 'state-1'), verifyGithubToken: vi.fn(async () => null) },
}));
vi.mock("@/app/github/githubConnect", () => ({ githubConnect: vi.fn() }));
vi.mock("@/app/github/githubDisconnect", () => ({ githubDisconnect: vi.fn() }));

import { integrationRoutes } from "./integrationRoutes";
import { loadFeaturesConfig } from "@/app/features/featuresConfig";

const AUTH = { authorization: 'Bearer t' };

async function buildApp(env: Record<string, string>): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any, reply: any) => {
        if (!request.headers.authorization) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        request.userId = 'user-1';
    });
    integrationRoutes(typed, loadFeaturesConfig(env), { webappUrl: 'https://app.corp.example' });
    await typed.ready();
    return typed;
}

const savedMasterSecret = process.env.HANDY_MASTER_SECRET;

beforeEach(() => {
    process.env.HANDY_MASTER_SECRET = 'x'.repeat(32);
    // No test may reach ElevenLabs or GitHub.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
});

afterEach(() => {
    vi.unstubAllGlobals();
    if (savedMasterSecret === undefined) {
        delete process.env.HANDY_MASTER_SECRET;
    } else {
        process.env.HANDY_MASTER_SECRET = savedMasterSecret;
    }
});

describe('integrationRoutes', () => {
    it('reports integrations off and registers no voice or GitHub routes by default', async () => {
        const app = await buildApp({});
        const features = await app.inject({ method: 'GET', url: '/v1/features', headers: AUTH });
        expect(features.statusCode).toBe(200);
        expect(features.json()).toEqual({ voice: false, githubConnect: false, push: true });

        const unregistered = [
            ['POST', '/v1/voice/conversations'],
            ['GET', '/v1/voice/usage'],
            ['GET', '/v1/connect/github/params'],
            ['GET', '/v1/connect/github/callback?code=c&state=s'],
            ['POST', '/v1/connect/github/webhook'],
            ['DELETE', '/v1/connect/github'],
        ] as const;
        for (const [method, url] of unregistered) {
            const res = await app.inject({ method, url, headers: AUTH });
            expect(res.statusCode, `${method} ${url}`).toBe(404);
        }
        await app.close();
    });

    it('requires authentication for /v1/features', async () => {
        const app = await buildApp({});
        const res = await app.inject({ method: 'GET', url: '/v1/features' });
        expect(res.statusCode).toBe(401);
        await app.close();
    });

    it('registers voice and GitHub routes when configured', async () => {
        const app = await buildApp({
            ELEVENLABS_API_KEY: 'xi-key',
            ELEVENLABS_AGENT_ID: 'agent_corp',
            GITHUB_CLIENT_ID: 'gh-client',
            GITHUB_CLIENT_SECRET: 'gh-secret',
            GITHUB_REDIRECT_URL: 'https://happy.corp.example/v1/connect/github/callback',
            PUSH_ENABLED: 'false',
        });
        const features = await app.inject({ method: 'GET', url: '/v1/features', headers: AUTH });
        expect(features.json()).toEqual({ voice: true, githubConnect: true, push: false });

        const usage = await app.inject({ method: 'GET', url: '/v1/voice/usage', headers: AUTH });
        expect(usage.statusCode).not.toBe(404);
        const params = await app.inject({ method: 'GET', url: '/v1/connect/github/params', headers: AUTH });
        expect(params.statusCode).toBe(200);
        await app.close();
    });
});
```

Run: `pnpm --filter happy-server exec vitest run sources/app/api/routes/integrationRoutes.spec.ts`
Expected: FAIL, `./integrationRoutes` cannot be resolved.

- [ ] **Step 8: Implement `featuresRoutes`, `integrationRoutes`, and wire them into `api.ts`**

```ts
// packages/happy-server/sources/app/api/routes/featuresRoutes.ts
import { FeaturesResponseSchema } from "@slopus/happy-wire";
import { type Fastify } from "../types";
import type { PublicFeatures } from "@/app/features/featuresConfig";

export function featuresRoutes(app: Fastify, features: PublicFeatures) {
    app.get('/v1/features', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: FeaturesResponseSchema,
            },
        },
    }, async (_request, reply) => {
        return reply.send(features);
    });
}
```

```ts
// packages/happy-server/sources/app/api/routes/integrationRoutes.ts
import { type Fastify } from "../types";
import { type FeaturesConfig, publicFeatures } from "@/app/features/featuresConfig";
import { featuresRoutes } from "./featuresRoutes";
import { githubRoutes } from "./githubRoutes";
import { voiceRoutes } from "./voiceRoutes";

/**
 * Third-party integrations are off unless configured: their routes are not
 * registered at all (404), and GET /v1/features tells clients what is on.
 */
export function integrationRoutes(app: Fastify, features: FeaturesConfig, opts: { webappUrl: string }) {
    featuresRoutes(app, publicFeatures(features));
    if (features.github) {
        githubRoutes(app, { github: features.github, webappUrl: opts.webappUrl });
    }
    if (features.voice) {
        voiceRoutes(app);
    }
}
```

In `packages/happy-server/sources/app/api/api.ts`:
- Remove the import `import { voiceRoutes } from "./routes/voiceRoutes";`.
- Add the imports:
  ```ts
  import { integrationRoutes } from "./routes/integrationRoutes";
  import { describeFeatures, loadFeaturesConfig } from "@/app/features/featuresConfig";
  ```
- Replace the line `const oidcRuntime = getOidcRuntime();` with:
  ```ts
      const oidcRuntime = getOidcRuntime();
      // Fails fast on partial or invalid integration settings.
      const features = loadFeaturesConfig();
      log({ module: 'features' }, `Integrations: ${describeFeatures(features)}`);
  ```
- Delete the line `voiceRoutes(typed);`.
- Directly after `connectRoutes(typed);`, add:
  ```ts
      integrationRoutes(typed, features, { webappUrl: oidcRuntime.config.webappUrl });
  ```

Run:
```bash
pnpm --filter happy-server exec vitest run sources/app/api/routes/integrationRoutes.spec.ts sources/app/api/routes/githubRoutes.spec.ts sources/app/features/featuresConfig.test.ts
pnpm --filter happy-server typecheck
```
Expected: PASS (3 + 5 + 7 tests); typecheck clean.

- [ ] **Step 9: Document the server settings**

In `docs/deployment.md`, replace these three lines:

```
**Optional integrations**
- GitHub OAuth/App: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, plus redirect URL/URI.
  - `GITHUB_REDIRECT_URL` is used by the OAuth callback handler.
  - `GITHUB_REDIRECT_URI` is used by the GitHub App initializer.
```

with:

```
**Optional integrations** (all off unless configured; setting only part of a group is a startup error)
- Clients read `GET /v1/features` (authenticated) → `{ voice, githubConnect, push }` and hide what is off.
- GitHub connect: set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `GITHUB_REDIRECT_URL` together to register the `/v1/connect/github/*` routes. The OAuth callback returns to `WEBAPP_URL`.
  - The GitHub App settings `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` and `GITHUB_REDIRECT_URI` only initialize webhook handling.
```

- [ ] **Step 10: Full server suite and commit**

Run: `pnpm --filter happy-server test`
Expected: all pass (only the known `testDb.test.ts` timeout may flake; re-run once).

```bash
git add packages/happy-wire/src/features.ts packages/happy-wire/src/index.ts \
  packages/happy-server/sources/app/features \
  packages/happy-server/sources/app/api/routes/featuresRoutes.ts \
  packages/happy-server/sources/app/api/routes/githubRoutes.ts packages/happy-server/sources/app/api/routes/githubRoutes.spec.ts \
  packages/happy-server/sources/app/api/routes/integrationRoutes.ts packages/happy-server/sources/app/api/routes/integrationRoutes.spec.ts \
  packages/happy-server/sources/app/api/routes/connectRoutes.ts packages/happy-server/sources/app/api/api.ts docs/deployment.md
git commit -m "feat: register integrations only when configured and add /v1/features"
```

---

### Task 2: Voice without subscriptions: server agent id and optional monthly cap

**Files:**
- Modify: `packages/happy-wire/src/voice.ts`
- Rewrite: `packages/happy-server/sources/app/api/routes/voiceRoutes.ts`
- Test: `packages/happy-server/sources/app/api/routes/voiceRoutes.spec.ts`
- Modify: `packages/happy-server/sources/app/api/routes/integrationRoutes.ts`
- Modify: `packages/happy-server/.env.dev`, `packages/happy-server/deploy/handy.yaml`, `docs/deployment.md`
- Modify: `packages/happy-app/sources/sync/apiVoice.ts`, `packages/happy-app/sources/sync/apiVoice.test.ts`
- Modify: `packages/happy-app/sources/sync/appConfig.ts`, `packages/happy-app/expoConfig.cjs`, `packages/happy-app/sources/appConfig.test.ts`
- Modify: `packages/happy-app/sources/realtime/RealtimeSession.ts` (denied branch)
- Modify: `packages/happy-app/sources/app/(app)/settings/voice.tsx` (usage block)
- Modify: `packages/happy-app/sources/text/_default.ts` and all ten files in `packages/happy-app/sources/text/translations/`

**Interfaces:**
- Consumes: `VoiceConfig` from Task 1.
- Produces:
  ```ts
  function voiceRoutes(app: Fastify, voice: VoiceConfig): void
  // wire
  VoiceConversationDenied.reason: 'voice_monthly_limit_reached' | 'voice_conversation_limit_reached'
  VoiceConversationGranted.limitSeconds: number | null
  VoiceUsageResponse.limitSeconds: number | null; VoiceUsageResponse.conversationLimit: number | null
  // app
  fetchVoiceCredentials(_credentials: AuthCredentials, sessionId: string): Promise<VoiceConversationResponse>  // POST without body
  t('errors.voiceMonthlyLimitReached'): string
  ```

- [ ] **Step 1: Change the wire schema**

Replace the body of `packages/happy-wire/src/voice.ts` with:

```ts
import * as z from 'zod';

export const VoiceConversationGrantedSchema = z.object({
    allowed: z.literal(true),
    conversationToken: z.string(),
    conversationId: z.string(),
    agentId: z.string(),
    elevenUserId: z.string(),
    usedSeconds: z.number(),
    /** null when the server sets no monthly cap */
    limitSeconds: z.number().nullable(),
});

export const VoiceConversationDeniedSchema = z.object({
    allowed: z.literal(false),
    reason: z.enum(['voice_monthly_limit_reached', 'voice_conversation_limit_reached']),
    usedSeconds: z.number(),
    limitSeconds: z.number(),
    agentId: z.string(),
});

export const VoiceConversationResponseSchema = z.discriminatedUnion('allowed', [
    VoiceConversationGrantedSchema,
    VoiceConversationDeniedSchema,
]);

export type VoiceConversationResponse = z.infer<typeof VoiceConversationResponseSchema>;

export const VoiceUsageResponseSchema = z.object({
    usedSeconds: z.number(),
    /** null when the server sets no monthly cap */
    limitSeconds: z.number().nullable(),
    conversationCount: z.number(),
    /** null when the server sets no monthly cap (nothing is enforced) */
    conversationLimit: z.number().nullable(),
    elevenUserId: z.string(),
});

export type VoiceUsageResponse = z.infer<typeof VoiceUsageResponseSchema>;
```

Run: `pnpm --filter @slopus/happy-wire build`
Expected: build succeeds.

- [ ] **Step 2: Write the failing voice route test**

```ts
// packages/happy-server/sources/app/api/routes/voiceRoutes.spec.ts
import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";
import { voiceRoutes } from "./voiceRoutes";
import type { VoiceConfig } from "@/app/features/featuresConfig";

const base: VoiceConfig = { apiKey: 'xi-key', agentId: 'agent_corp', monthlyLimitSeconds: null };

function conversationToken(conversationId: string): string {
    const payload = Buffer.from(JSON.stringify({ video: { room: `room_${conversationId}` } })).toString('base64url');
    return `header.${payload}.signature`;
}

/** Fakes ElevenLabs; returns the list of requested URLs. */
function stubElevenLabs(durations: number[] = []): string[] {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.startsWith('https://api.elevenlabs.io/v1/convai/conversations?')) {
            return new Response(JSON.stringify({ conversations: durations.map((s) => ({ call_duration_secs: s })) }), { status: 200 });
        }
        if (url.startsWith('https://api.elevenlabs.io/v1/convai/conversation/token?')) {
            return new Response(JSON.stringify({ token: conversationToken('conv_abc123') }), { status: 200 });
        }
        return new Response('unexpected', { status: 500 });
    }));
    return calls;
}

async function buildApp(voice: VoiceConfig): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => { request.userId = 'user-1'; });
    voiceRoutes(typed, voice);
    await typed.ready();
    return typed;
}

const savedMasterSecret = process.env.HANDY_MASTER_SECRET;
beforeAll(() => { process.env.HANDY_MASTER_SECRET = 'x'.repeat(32); });
afterAll(() => {
    if (savedMasterSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
    else process.env.HANDY_MASTER_SECRET = savedMasterSecret;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('POST /v1/voice/conversations', () => {
    it('uses the server agent id, ignores the client one, and skips accounting without a cap', async () => {
        const calls = stubElevenLabs();
        const app = await buildApp(base);
        const res = await app.inject({ method: 'POST', url: '/v1/voice/conversations', payload: { agentId: 'agent_from_client' } });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
            allowed: true,
            agentId: 'agent_corp',
            conversationId: 'conv_abc123',
            usedSeconds: 0,
            limitSeconds: null,
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('agent_id=agent_corp');
        expect(calls.join(' ')).not.toContain('agent_from_client');
        await app.close();
    });

    it('accepts a request without a body', async () => {
        stubElevenLabs();
        const app = await buildApp(base);
        const res = await app.inject({ method: 'POST', url: '/v1/voice/conversations' });
        expect(res.statusCode).toBe(200);
        expect(res.json().allowed).toBe(true);
        await app.close();
    });

    it('grants under the cap and reports it', async () => {
        stubElevenLabs([120]);
        const app = await buildApp({ ...base, monthlyLimitSeconds: 600 });
        const res = await app.inject({ method: 'POST', url: '/v1/voice/conversations' });
        expect(res.json()).toMatchObject({ allowed: true, usedSeconds: 120, limitSeconds: 600 });
        await app.close();
    });

    it('denies once the monthly cap is used up, without minting a token', async () => {
        const calls = stubElevenLabs([400, 200]);
        const app = await buildApp({ ...base, monthlyLimitSeconds: 600 });
        const res = await app.inject({ method: 'POST', url: '/v1/voice/conversations' });
        expect(res.json()).toEqual({
            allowed: false,
            reason: 'voice_monthly_limit_reached',
            usedSeconds: 600,
            limitSeconds: 600,
            agentId: 'agent_corp',
        });
        expect(calls.some((url) => url.includes('/conversation/token'))).toBe(false);
        await app.close();
    });

    it('denies when usage can no longer be counted (100 conversations)', async () => {
        stubElevenLabs(Array(100).fill(1));
        const app = await buildApp({ ...base, monthlyLimitSeconds: 600 });
        const res = await app.inject({ method: 'POST', url: '/v1/voice/conversations' });
        expect(res.json()).toMatchObject({ allowed: false, reason: 'voice_conversation_limit_reached' });
        await app.close();
    });
});

describe('GET /v1/voice/usage', () => {
    it('reports usage with no limits when no cap is set', async () => {
        stubElevenLabs([30, 30]);
        const app = await buildApp(base);
        const res = await app.inject({ method: 'GET', url: '/v1/voice/usage' });
        expect(res.json()).toMatchObject({ usedSeconds: 60, limitSeconds: null, conversationCount: 2, conversationLimit: null });
        await app.close();
    });

    it('reports the cap when set', async () => {
        stubElevenLabs([30]);
        const app = await buildApp({ ...base, monthlyLimitSeconds: 600 });
        const res = await app.inject({ method: 'GET', url: '/v1/voice/usage' });
        expect(res.json()).toMatchObject({ usedSeconds: 30, limitSeconds: 600, conversationLimit: 100 });
        await app.close();
    });
});
```

Run: `pnpm --filter happy-server exec vitest run sources/app/api/routes/voiceRoutes.spec.ts`
Expected: FAIL. The current `voiceRoutes` takes no config, requires a `{agentId}` body (400), and answers 500 without `REVENUECAT_API_KEY`.

- [ ] **Step 3: Rewrite `voiceRoutes.ts`**

```ts
// packages/happy-server/sources/app/api/routes/voiceRoutes.ts
import { z } from "zod";
import * as crypto from "crypto";
import { VoiceConversationResponseSchema, VoiceUsageResponseSchema } from "@slopus/happy-wire";
import { type Fastify } from "../types";
import { log } from "@/utils/log";
import type { VoiceConfig } from "@/app/features/featuresConfig";

// ElevenLabs returns at most 100 conversations per query, so usage past that cannot be counted.
const VOICE_MAX_CONVERSATIONS = 100;
const ELEVEN_LABS_API = "https://api.elevenlabs.io/v1/convai";

function deriveElevenUserId(happyUserId: string): string {
    const hmac = crypto.createHmac("sha256", process.env.HANDY_MASTER_SECRET!);
    hmac.update(happyUserId);
    const digest = hmac.digest();
    const base64url = digest
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return `u_${base64url}`;
}

/**
 * A user's voice usage over the last 30 days, queried from ElevenLabs by
 * user_id (set via participant_name when the token is minted). A failed query
 * counts as zero usage.
 */
async function getVoiceUsage(
    elevenLabsApiKey: string,
    elevenUserId: string,
): Promise<{ usedSeconds: number; conversationCount: number }> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const res = await fetch(
        `${ELEVEN_LABS_API}/conversations?user_id=${elevenUserId}&created_after=${thirtyDaysAgo}&page_size=${VOICE_MAX_CONVERSATIONS}`,
        { headers: { "xi-api-key": elevenLabsApiKey } }
    );
    if (!res.ok) {
        log({ module: 'voice' }, `ElevenLabs conversations query failed: ${res.status}`);
        return { usedSeconds: 0, conversationCount: 0 };
    }
    const data = (await res.json()) as { conversations?: Array<{ call_duration_secs: number }> };
    const conversations = data.conversations || [];
    let usedSeconds = 0;
    for (const c of conversations) {
        usedSeconds += c.call_duration_secs ?? 0;
    }
    return { usedSeconds, conversationCount: conversations.length };
}

/**
 * Registered only when ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are set.
 * Voice is available to every user; VOICE_MONTHLY_LIMIT_MINUTES optionally
 * caps each user's usage over the rolling 30-day window.
 */
export function voiceRoutes(app: Fastify, voice: VoiceConfig) {
    app.post('/v1/voice/conversations', {
        preHandler: app.authenticate,
        schema: {
            // No body: the agent id is server configuration. Older apps still send
            // { agentId }; it is ignored.
            response: {
                200: VoiceConversationResponseSchema,
                500: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const elevenUserId = deriveElevenUserId(userId);
        const limitSeconds = voice.monthlyLimitSeconds;
        let usedSeconds = 0;

        log({ module: 'voice' }, `Voice token request from user ${userId}`);

        if (limitSeconds !== null) {
            const usage = await getVoiceUsage(voice.apiKey, elevenUserId);
            usedSeconds = usage.usedSeconds;
            log({ module: 'voice' }, `User ${userId}: ${usedSeconds}s of ${limitSeconds}s used, ${usage.conversationCount} conversations`);
            if (usage.conversationCount >= VOICE_MAX_CONVERSATIONS) {
                return reply.send({
                    allowed: false as const,
                    reason: 'voice_conversation_limit_reached' as const,
                    usedSeconds,
                    limitSeconds,
                    agentId: voice.agentId,
                });
            }
            if (usedSeconds >= limitSeconds) {
                return reply.send({
                    allowed: false as const,
                    reason: 'voice_monthly_limit_reached' as const,
                    usedSeconds,
                    limitSeconds,
                    agentId: voice.agentId,
                });
            }
        }

        try {
            const tokenRes = await fetch(
                `${ELEVEN_LABS_API}/conversation/token?agent_id=${encodeURIComponent(voice.agentId)}&participant_name=${elevenUserId}`,
                { headers: { 'xi-api-key': voice.apiKey } }
            );
            if (!tokenRes.ok) {
                log({ module: 'voice' }, `Failed to get conversation token for user ${userId}: ${tokenRes.status}`);
                return reply.code(500).send({ error: 'Failed to get voice credentials' });
            }
            const { token: conversationToken } = (await tokenRes.json()) as { token: string };

            // The LiveKit room name inside the JWT carries the conversation id.
            const jwtPayload = JSON.parse(Buffer.from(conversationToken.split('.')[1], 'base64').toString());
            const conversationId = (jwtPayload.video?.room || '').match(/(conv_[a-zA-Z0-9]+)/)?.[0];
            if (!conversationId) {
                log({ module: 'voice' }, `No conversation_id in JWT for user ${userId}`);
                return reply.code(500).send({ error: 'Failed to get conversation ID' });
            }

            log({ module: 'voice' }, `Voice token issued for user ${userId}, conv=${conversationId}`);
            return reply.send({
                allowed: true as const,
                conversationToken,
                conversationId,
                agentId: voice.agentId,
                elevenUserId,
                usedSeconds,
                limitSeconds,
            });
        } catch (error) {
            log({ module: 'voice' }, `ElevenLabs request error for user ${userId}: ${error instanceof Error ? error.message : String(error)}`);
            return reply.code(500).send({ error: 'Failed to get voice credentials' });
        }
    });

    app.get('/v1/voice/usage', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: VoiceUsageResponseSchema,
                500: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const elevenUserId = deriveElevenUserId(userId);
        try {
            const { usedSeconds, conversationCount } = await getVoiceUsage(voice.apiKey, elevenUserId);
            return reply.send({
                usedSeconds,
                limitSeconds: voice.monthlyLimitSeconds,
                conversationCount,
                conversationLimit: voice.monthlyLimitSeconds === null ? null : VOICE_MAX_CONVERSATIONS,
                elevenUserId,
            });
        } catch (error) {
            log({ module: 'voice' }, `Failed to get voice usage for user ${userId}: ${error instanceof Error ? error.message : String(error)}`);
            return reply.code(500).send({ error: 'Failed to get voice usage' });
        }
    });
}
```

In `packages/happy-server/sources/app/api/routes/integrationRoutes.ts`, change `voiceRoutes(app);` to:

```ts
        voiceRoutes(app, features.voice);
```

Run:
```bash
pnpm --filter happy-server exec vitest run sources/app/api/routes/voiceRoutes.spec.ts sources/app/api/routes/integrationRoutes.spec.ts
pnpm --filter happy-server typecheck
```
Expected: PASS (7 + 3 tests); typecheck clean.

- [ ] **Step 4: Server config files and docs**

In `packages/happy-server/.env.dev`, replace:

```
# Voice — 11Labs API key (secret, not checked in)
# ELEVENLABS_API_KEY=
```

with:

```
# Voice — off unless both are set (11Labs API key is a secret, not checked in)
# ELEVENLABS_API_KEY=
# ELEVENLABS_AGENT_ID=
# Optional per-user cap over the rolling 30 days; unset = no cap
# VOICE_MONTHLY_LIMIT_MINUTES=
```

In `packages/happy-server/deploy/handy.yaml`, delete these two lines from the `handy-secrets` ExternalSecret:

```yaml
    - extract:
        key: /handy-revenuecat
```

In `docs/deployment.md`, replace:

```
- Voice: `ELEVENLABS_API_KEY` (required for `/v1/voice/conversations` in production).
- Subscriptions: `REVENUECAT_API_KEY` (server-side RevenueCat key, required for voice subscription checks).
```

with:

```
- Voice: set `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` together to register `/v1/voice/*`.
  - The agent id is server configuration; apps do not carry one.
  - Voice is available to every signed-in user. There are no subscriptions.
  - Optional `VOICE_MONTHLY_LIMIT_MINUTES` caps each user over the rolling 30 days ElevenLabs reports. Unset means no cap.
```

- [ ] **Step 5: Update the app's voice client test (failing)**

Replace `packages/happy-app/sources/sync/apiVoice.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessTokenProvider, staticAccessTokenProvider } from '@/auth/authFetch';
import type { AuthCredentials } from '@/auth/tokenStorage';

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://api.test.com',
}));

vi.mock('./apiSocket', () => ({
    getHappyClientId: () => 'test-client',
}));

import { fetchVoiceCredentials, fetchVoiceUsage } from './apiVoice';

const credentials: AuthCredentials = {
    token: 'test-token',
    refreshToken: 'refresh-1',
    secret: 'test-secret',
};

describe('apiVoice', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        setAccessTokenProvider(staticAccessTokenProvider('test-token', 'https://api.test.com'));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        setAccessTokenProvider(null);
    });

    it('requests a conversation without supplying an agent id', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            allowed: true,
            conversationToken: 'conv-token',
            conversationId: 'conv-1',
            agentId: 'agent-from-server',
            elevenUserId: 'user-1',
            usedSeconds: 0,
            limitSeconds: null,
        }), { status: 200 }));

        const response = await fetchVoiceCredentials(credentials, 'session-1');

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.test.com/v1/voice/conversations',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'X-Happy-Client': 'test-client',
                }),
            }),
        );
        expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
        expect(response).toMatchObject({ allowed: true, agentId: 'agent-from-server', limitSeconds: null });
    });

    it('parses a monthly-limit denial', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            allowed: false,
            reason: 'voice_monthly_limit_reached',
            usedSeconds: 600,
            limitSeconds: 600,
            agentId: 'agent-from-server',
        }), { status: 200 }));
        const response = await fetchVoiceCredentials(credentials, 'session-1');
        expect(response).toMatchObject({ allowed: false, reason: 'voice_monthly_limit_reached' });
    });

    it('fetches voice usage from the configured server with a Bearer token', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            usedSeconds: 10,
            limitSeconds: null,
            conversationCount: 1,
            conversationLimit: null,
            elevenUserId: 'user-1',
        }), { status: 200 }));

        const usage = await fetchVoiceUsage(credentials);

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.test.com/v1/voice/usage',
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'X-Happy-Client': 'test-client',
                }),
            }),
        );
        expect(usage.limitSeconds).toBeNull();
    });
});
```

In `packages/happy-app/sources/appConfig.test.ts`, add inside `describe('buildExpoConfig', …)`:

```ts
    it('does not bake an ElevenLabs agent id into the app', () => {
        const { expo } = buildExpoConfig({});
        expect(expo.extra.app).not.toHaveProperty('elevenLabsAgentId');
        expect(JSON.stringify(expo)).not.toContain('agent_6701k211syvvegba4kt7m68nxjmw');
    });
```

Run: `pnpm --filter happy-app exec vitest run sources/sync/apiVoice.test.ts sources/appConfig.test.ts`
Expected: FAIL. The current client sends a body, and expo extra still has `elevenLabsAgentId`.

- [ ] **Step 6: Update the app voice client and config**

Replace `fetchVoiceCredentials` in `packages/happy-app/sources/sync/apiVoice.ts` and delete the `import { config } from '@/config';` line:

```ts
export async function fetchVoiceCredentials(
    _credentials: AuthCredentials,
    sessionId: string
): Promise<VoiceConversationResponse> {
    // The server owns the ElevenLabs agent id (ELEVENLABS_AGENT_ID); the app sends none.
    const response = await authFetch(`${getServerUrl()}/v1/voice/conversations`, {
        method: 'POST',
        headers: {
            'X-Happy-Client': getHappyClientId(),
        },
    });

    if (!response.ok) {
        throw new Error(`Voice token request failed: ${response.status}`);
    }

    return VoiceConversationResponseSchema.parse(await response.json());
}
```

In `packages/happy-app/expoConfig.cjs`, delete the line `const ELEVENLABS_AGENT_ID = 'agent_6701k211syvvegba4kt7m68nxjmw';` and the line `elevenLabsAgentId: ELEVENLABS_AGENT_ID,`.

In `packages/happy-app/sources/sync/appConfig.ts`, delete `elevenLabsAgentId?: string;` from `AppConfig`.

- [ ] **Step 7: Add the limit message and update the voice UI**

Insert `errors.voiceMonthlyLimitReached` directly after `voiceLimitReachedTitle` in every translation file:

```bash
cd /home/rophy/projects/happy/packages/happy-app/sources/text
node --input-type=module <<'EOF'
import fs from 'node:fs';
const text = {
    '_default.ts': 'You have reached the monthly voice limit set by your administrator.',
    'translations/en.ts': 'You have reached the monthly voice limit set by your administrator.',
    'translations/ca.ts': 'Has arribat al límit mensual de veu establert pel teu administrador.',
    'translations/es.ts': 'Has alcanzado el límite mensual de voz establecido por tu administrador.',
    'translations/it.ts': 'Hai raggiunto il limite vocale mensile impostato dal tuo amministratore.',
    'translations/ja.ts': '管理者が設定した月間の音声利用上限に達しました。',
    'translations/pl.ts': 'Osiągnięto miesięczny limit głosu ustalony przez administratora.',
    'translations/pt.ts': 'Você atingiu o limite mensal de voz definido pelo seu administrador.',
    'translations/ru.ts': 'Вы достигли месячного лимита голосового режима, установленного администратором.',
    'translations/zh-Hans.ts': '您已达到管理员设置的每月语音使用上限。',
    'translations/zh-Hant.ts': '您已達到管理員設定的每月語音使用上限。',
};
for (const [path, value] of Object.entries(text)) {
    const src = fs.readFileSync(path, 'utf8');
    const anchor = /^(\s*)voiceLimitReachedTitle: .*$/m;
    const match = src.match(anchor);
    if (!match) throw new Error(`no voiceLimitReachedTitle in ${path}`);
    fs.writeFileSync(path, src.replace(anchor, `${match[0]}\n${match[1]}voiceMonthlyLimitReached: ${JSON.stringify(value)},`));
}
EOF
grep -c "voiceMonthlyLimitReached" _default.ts translations/*.ts
```
Expected: every file reports `1`.

In `packages/happy-app/sources/realtime/RealtimeSession.ts`, replace the whole `if (!response.allowed) { … }` block (from `if (!response.allowed) {` through the `return null;` + `}` after the must-pay paywall) with:

```ts
        if (!response.allowed) {
            storage.getState().setRealtimeStatus('disconnected');
            // Voice is not sold: a denial only means the server's monthly cap is used up.
            Modal.alert(t('errors.voiceLimitReachedTitle'), t('errors.voiceMonthlyLimitReached'));
            return null;
        }
```

In `packages/happy-app/sources/app/(app)/settings/voice.tsx`, replace the usage `ItemGroup` (from `<ItemGroup\n                    title={t('settingsVoice.usageTitle')}` through its closing `</ItemGroup>`) with:

```tsx
                <ItemGroup title={t('settingsVoice.usageTitle')}>
                    <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                        {usage.limitSeconds !== null && (
                            <UsageBar
                                label={t('settingsVoice.usageLabel')}
                                value={usage.usedSeconds}
                                maxValue={usage.limitSeconds}
                                color={usage.usedSeconds >= usage.limitSeconds ? '#FF3B30' : '#007AFF'}
                            />
                        )}
                        <Text style={{ fontSize: 13, color: '#8E8E93', marginTop: 4 }}>
                            {usage.limitSeconds !== null
                                ? `${formatVoiceTime(usage.usedSeconds)} / ${formatVoiceTime(usage.limitSeconds)}`
                                : formatVoiceTime(usage.usedSeconds)}
                        </Text>
                        {usage.conversationLimit !== null && (
                            <>
                                <UsageBar
                                    label={t('settingsVoice.conversationsLabel')}
                                    value={usage.conversationCount}
                                    maxValue={usage.conversationLimit}
                                    color={usage.conversationCount >= usage.conversationLimit ? '#FF3B30' : '#007AFF'}
                                />
                                <Text style={{ fontSize: 13, color: '#8E8E93', marginTop: 4 }}>
                                    {usage.conversationCount} / {usage.conversationLimit}
                                </Text>
                            </>
                        )}
                    </View>
                </ItemGroup>
```

(The old footer described the upstream free tier and subscription, so it is dropped.)

- [ ] **Step 8: Run app tests and typecheck**

Run:
```bash
pnpm --filter happy-app exec vitest run sources/sync/apiVoice.test.ts sources/appConfig.test.ts
pnpm --filter happy-app typecheck
grep -rn "REVENUECAT\|subscription_required\|elevenLabsAgentId" packages/happy-server/sources packages/happy-app/sources packages/happy-app/expoConfig.cjs packages/happy-wire/src \
  | grep -v "sources/appConfig.test.ts"
```
Expected: tests PASS; typecheck clean; grep prints nothing. (`appConfig.test.ts` names the key only to assert its absence.)

- [ ] **Step 9: Full suites and commit**

Run:
```bash
pnpm --filter happy-server test
pnpm --filter happy-app exec vitest run
```
Expected: all pass except the known pre-existing failures.

```bash
git add packages/happy-wire/src/voice.ts packages/happy-server/sources/app/api/routes/voiceRoutes.ts \
  packages/happy-server/sources/app/api/routes/voiceRoutes.spec.ts packages/happy-server/sources/app/api/routes/integrationRoutes.ts \
  packages/happy-server/.env.dev packages/happy-server/deploy/handy.yaml docs/deployment.md \
  packages/happy-app/sources/sync/apiVoice.ts packages/happy-app/sources/sync/apiVoice.test.ts \
  packages/happy-app/sources/sync/appConfig.ts packages/happy-app/expoConfig.cjs packages/happy-app/sources/appConfig.test.ts \
  packages/happy-app/sources/realtime/RealtimeSession.ts "packages/happy-app/sources/app/(app)/settings/voice.tsx" \
  packages/happy-app/sources/text
git commit -m "feat: serve voice without subscriptions using the server agent id"
```

---

### Task 3: Remove RevenueCat, the paywall and the voice upsell from the app

**Files:**
- Modify: `packages/happy-app/package.json`, `pnpm-lock.yaml` (via `pnpm remove`)
- Delete: `packages/happy-app/sources/sync/revenueCat/` (4 files), `packages/happy-app/sources/sync/purchases.ts`, `packages/happy-app/sources/app/(app)/dev/purchases.tsx`, `packages/happy-app/sources/realtime/voiceExperiment.ts`
- Modify: `sources/sync/storage.ts`, `sources/sync/persistence.ts`, `sources/sync/sync.ts`, `sources/sync/localSettings.ts`, `sources/sync/appConfig.ts`, `expoConfig.cjs`
- Modify: `sources/track/index.ts`, `sources/components/SettingsView.tsx`, `sources/app/(app)/dev/index.tsx`, `sources/app/_layout.tsx`, `sources/-session/SessionView.tsx`
- Modify: `sources/realtime/RealtimeSession.ts`, `sources/realtime/voiceSystemPrompt.ts`
- Test: `sources/realtime/voiceSystemPrompt.test.ts` (create)
- Rewrite: `sources/app/(app)/settings/voice.tsx`
- Modify tests: `sources/sync/sync.preload.test.ts`, `sources/sync/sync.send.test.ts`, `sources/sync/rigComposer.test.ts`, `sources/sync/sessionArchiving.test.ts`, `sources/appConfig.test.ts`
- Modify: `Dockerfile.webapp`

(All app paths are under `packages/happy-app/`.)

**Interfaces:**
- Consumes: `t('errors.voiceMonthlyLimitReached')` from Task 2.
- Produces:
  ```ts
  // voiceSystemPrompt.ts
  const VOICE_FIRST_MESSAGE = 'Hi, Happy here'
  function buildVoiceSystemPrompt(options: { initialContext?: string; voiceMessageCount: number }): string
  // persistence.ts keeps only getVoiceMessageCount / incrementVoiceMessageCount for voice
  ```
  Removed: `sync.presentPaywall`, `sync.purchaseProduct`, `sync.getOfferings`, `sync.refreshPurchases`, `sync.revenueCatInitialized`, `storage.purchases`, `applyPurchases`, `useEntitlement`, `KnownEntitlements`, all `trackPaywall*`, `voiceExperiment.*`, `localSettings.voiceUpsellOverride`.

- [ ] **Step 1: Write the failing voice prompt test**

```ts
// packages/happy-app/sources/realtime/voiceSystemPrompt.test.ts
import { describe, expect, it } from 'vitest';
import { VOICE_FIRST_MESSAGE, VOICE_SYSTEM_PROMPT_BASE, buildVoiceSystemPrompt } from './voiceSystemPrompt';

describe('buildVoiceSystemPrompt', () => {
    it('contains no paid onboarding or upgrade copy', () => {
        const prompt = buildVoiceSystemPrompt({ voiceMessageCount: 3 });
        expect(prompt.startsWith(VOICE_SYSTEM_PROMPT_BASE)).toBe(true);
        expect(prompt).toContain('- voice_message_count: 3');
        expect(prompt).not.toContain('Paid voice onboarding');
        expect(prompt).not.toContain('upgrade');
        expect(prompt).not.toContain('onboarding_prompt_load_count');
    });

    it('appends the conversation history when given', () => {
        const prompt = buildVoiceSystemPrompt({ voiceMessageCount: 0, initialContext: '  user asked for tests  ' });
        expect(prompt.endsWith('# Conversation history so far\nuser asked for tests')).toBe(true);
    });

    it('greets the same way for everyone', () => {
        expect(VOICE_FIRST_MESSAGE).toBe('Hi, Happy here');
    });
});
```

In `packages/happy-app/sources/appConfig.test.ts`, add inside `describe('buildExpoConfig', …)`:

```ts
    it('carries no RevenueCat keys', () => {
        const { expo } = buildExpoConfig({ EXPO_PUBLIC_REVENUE_CAT_APPLE: 'appl_x', EXPO_PUBLIC_REVENUE_CAT_GOOGLE: 'goog_x', EXPO_PUBLIC_REVENUE_CAT_STRIPE: 'strp_x' });
        for (const key of ['revenueCatAppleKey', 'revenueCatGoogleKey', 'revenueCatStripeKey']) {
            expect(expo.extra.app).not.toHaveProperty(key);
        }
    });
```

Run: `pnpm --filter happy-app exec vitest run sources/realtime/voiceSystemPrompt.test.ts sources/appConfig.test.ts`
Expected: FAIL. `VOICE_FIRST_MESSAGE` is not exported, and the RevenueCat keys are present.

- [ ] **Step 2: Simplify the voice prompt**

In `packages/happy-app/sources/realtime/voiceSystemPrompt.ts`, keep `VOICE_SYSTEM_PROMPT_BASE` exactly as it is. Delete `PAID_VOICE_ONBOARDING_PROMPT`, `buildVoiceSystemPrompt` and `buildVoiceFirstMessage`, and append:

```ts
export const VOICE_FIRST_MESSAGE = 'Hi, Happy here';

export function buildVoiceSystemPrompt(options: {
    initialContext?: string;
    voiceMessageCount: number;
}): string {
    const sections = [
        VOICE_SYSTEM_PROMPT_BASE,
        ['# Runtime counters', `- voice_message_count: ${options.voiceMessageCount}`].join('\n'),
    ];
    if (options.initialContext?.trim()) {
        sections.push(`# Conversation history so far\n${options.initialContext.trim()}`);
    }
    return sections.join('\n\n');
}
```

- [ ] **Step 3: Remove the dependencies**

```bash
cd /home/rophy/projects/happy
pnpm --version   # must print 10.11.0
pnpm --filter happy-app remove react-native-purchases react-native-purchases-ui @revenuecat/purchases-js
```

Run the **Lockfile check** from Global Constraints. The expected `<` lines, in any order, are exactly:

```
< @revenuecat/purchases-js-hybrid-mappings@17.52.0
< @revenuecat/purchases-js@1.28.0
< @revenuecat/purchases-typescript-internal@17.52.0
< react-native-purchases-ui@9.14.0
< react-native-purchases@9.14.0
```

The check must also print `lockfile: deletions only`.

- [ ] **Step 4: Delete the RevenueCat and upsell modules**

```bash
cd /home/rophy/projects/happy/packages/happy-app
git rm -r sources/sync/revenueCat sources/sync/purchases.ts "sources/app/(app)/dev/purchases.tsx" sources/realtime/voiceExperiment.ts
```

- [ ] **Step 5: Storage, persistence and local settings**

`sources/sync/storage.ts`:
- Delete `import { Purchases, customerInfoToPurchases } from "./purchases";` and `import type { CustomerInfo } from './revenueCat/types';`.
- In the `./persistence` import, remove `loadPurchases, savePurchases, `.
- Delete `// Known entitlement IDs` and `export type KnownEntitlements = 'pro';`.
- In `interface StorageState`, delete `purchases: Purchases;` and `applyPurchases: (customerInfo: CustomerInfo) => void;`.
- In `create<StorageState>()`, delete `let purchases = loadPurchases();`, the `purchases,` property, and the whole `applyPurchases: … }),` entry.
- Delete `export function useEntitlement(…) { … }`.

`sources/sync/persistence.ts`:
- Delete `import { Purchases, purchasesDefaults, purchasesParse } from './purchases';`.
- Delete the constants `VOICE_SOFT_PAYWALL_SHOWN_KEY` and `VOICE_ONBOARDING_PROMPT_LOAD_COUNT_KEY`.
- Delete the functions `loadPurchases`, `savePurchases`, `getVoiceSoftPaywallShownCount`, `incrementVoiceSoftPaywallShown`, `getVoiceOnboardingPromptLoadCount`, `incrementVoiceOnboardingPromptLoadCount`, `getVoiceLocalCounters` and `resetVoiceLocalCounters`.
- Keep `VOICE_MESSAGE_COUNT_KEY`, `getVoiceMessageCount` and `incrementVoiceMessageCount`.

`sources/sync/localSettings.ts`: delete the `voiceUpsellOverride: z.enum([...])…` schema line and `voiceUpsellOverride: null,` from the defaults. Stored values with the old key are ignored, because the parser is `passthrough().partial()`.

- [ ] **Step 6: `sync.ts`**

In `packages/happy-app/sources/sync/sync.ts`:
- Delete `import * as Device from 'expo-device';`, `import { RevenueCat, LogLevel, PaywallResult } from './revenueCat';` and `import { config } from '@/config';`. Before deleting the last two, confirm with `grep -n "Device\.\|config\." sources/sync/sync.ts` that `syncPurchases` is their only user.
- In the `@/track` import, remove `trackPaywallCancelled`, `trackPaywallError`, `trackPaywallPresented`, `trackPaywallPurchased` and `trackPaywallRestored`.
- Delete the field `private purchasesSync: InvalidateSync;` and the field `revenueCatInitialized = false;`.
- Constructor:
  - Delete `this.purchasesSync = new InvalidateSync(this.syncPurchases);`.
  - Change the comment `// Listen for app state changes to refresh purchases` to `// Listen for app state changes`.
  - In the `'active'` branch, delete `this.purchasesSync.invalidate();`.
- `create()`: delete `// Await purchases sync to have fresh purchases` and `await this.purchasesSync.awaitQueue();`.
- `restore()`: delete `// Purchases sync is invalidated in #init() and will complete asynchronously`.
- `#init()`: delete `this.purchasesSync.invalidate();`.
- Delete the methods `refreshPurchases`, `purchaseProduct`, `getOfferings`, `presentPaywall` and `syncPurchases` entirely.

Run: `grep -n -i "purchase\|paywall\|revenuecat" packages/happy-app/sources/sync/sync.ts`
Expected: no output.

- [ ] **Step 7: Tracking, settings UI and dev menu**

`sources/track/index.ts`: delete the `/** * Paywall events */` block, which holds the six `trackPaywall*` functions.

`sources/components/SettingsView.tsx`:
- Change `import { useEntitlement, useLocalSettingMutable, useSetting } from '@/sync/storage';` to `import { useLocalSettingMutable, useSetting } from '@/sync/storage';`.
- Change `import { trackPaywallButtonClicked, trackWhatsNewClicked } from '@/track';` to `import { trackWhatsNewClicked } from '@/track';`.
- Delete `const isPro = __DEV__ || useEntitlement('pro');`.
- Delete the whole `const handleSubscribe = async () => { … };` function.
- Delete the `{/* Support Us */}` comment and its `<ItemGroup>…</ItemGroup>`, which holds the `t('settings.supportUs')` item.

`sources/app/(app)/dev/index.tsx`: delete the `<Item title="Purchases" … onPress={() => router.push('/dev/purchases')} />` element. The "System" group keeps "Expo Constants".

`sources/app/_layout.tsx`:
- Delete the four-line RevenueCat comment and `LogBox.ignoreLogs([/\[RevenueCat\]/]);`.
- Change `import { View, Platform, AppState, LogBox } from 'react-native';` to `import { View, Platform, AppState } from 'react-native';`.
- Delete `import { applyVoiceUpsellOverride } from '@/realtime/voiceExperiment';`.
- Delete `const devModeEnabled = __DEV__ || useLocalSetting('devModeEnabled');` and `const voiceUpsellOverride = useLocalSetting('voiceUpsellOverride');`.
- Delete the `React.useEffect(() => { if (!devModeEnabled || !voiceUpsellOverride) { return; } applyVoiceUpsellOverride(voiceUpsellOverride); }, [devModeEnabled, voiceUpsellOverride]);` block.

`sources/-session/SessionView.tsx`:
- Change `import { getVoiceMessageCount, getVoiceOnboardingPromptLoadCount } from '@/sync/persistence';` to `import { getVoiceMessageCount } from '@/sync/persistence';`.
- Replace

```ts
                if (conversationId) {
                    const hasPro = storage.getState().purchases.entitlements['pro'] ?? false;
                    tracking?.capture('voice_session_started', {
                        session_id: sessionId,
                        elevenlabs_conversation_id: conversationId,
                        has_pro: hasPro,
                        onboarding_prompt_load_count: getVoiceOnboardingPromptLoadCount(),
                        voice_message_count: getVoiceMessageCount(),
                    });
                }
```

with

```ts
                if (conversationId) {
                    tracking?.capture('voice_session_started', {
                        session_id: sessionId,
                        elevenlabs_conversation_id: conversationId,
                        voice_message_count: getVoiceMessageCount(),
                    });
                }
```

- [ ] **Step 8: `RealtimeSession.ts` without paywall or upsell**

In `packages/happy-app/sources/realtime/RealtimeSession.ts`, set the imports to:

```ts
import type { VoiceSession } from './types';
import { fetchVoiceCredentials } from '@/sync/apiVoice';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/tokenStorage';
import { t } from '@/text';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { storage } from '@/sync/storage';
import { getVoiceMessageCount } from '@/sync/persistence';
import { VOICE_FIRST_MESSAGE, buildVoiceSystemPrompt } from './voiceSystemPrompt';
```

Then replace everything from `const hasPro = storage.getState().purchases.entitlements['pro'] ?? false;` through the line `currentVoiceSessionStartedAt = Date.now();` that follows `incrementVoiceOnboardingPromptLoadCount();` + `}` with:

```ts
        currentSessionId = sessionId;
        const systemPrompt = buildVoiceSystemPrompt({
            initialContext,
            voiceMessageCount: getVoiceMessageCount(),
        });

        const startedConversationId = await voiceSession.startSession({
            sessionId,
            initialContext,
            systemPrompt,
            firstMessage: VOICE_FIRST_MESSAGE,
            conversationToken: response.conversationToken,
            agentId: response.agentId,
            userId: response.elevenUserId,
        });
        currentVoiceConversationId = response.conversationId ?? startedConversationId;
        currentVoiceSessionStartedAt = Date.now();
```

The lines `voiceSessionStarted = true; return currentVoiceConversationId;` that follow stay. Then check: `grep -n "sync\.\|hasPro\|Upsell\|Paywall\|Onboarding" sources/realtime/RealtimeSession.ts` prints nothing.

- [ ] **Step 9: Rewrite the voice settings screen**

```tsx
// packages/happy-app/sources/app/(app)/settings/voice.tsx
import React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { UsageBar } from '@/components/usage/UsageBar';
import { useSettingMutable } from '@/sync/storage';
import { useAuth } from '@/auth/AuthContext';
import { findLanguageByCode, getLanguageDisplayName, LANGUAGES } from '@/constants/Languages';
import { fetchVoiceUsage, type VoiceUsageResponse } from '@/sync/apiVoice';
import { t } from '@/text';
import { Modal } from '@/modal';

function formatVoiceTime(totalSeconds: number): string {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}m ${secs}s`;
}

export default React.memo(function VoiceSettingsScreen() {
    const router = useRouter();
    const auth = useAuth();
    const [voiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');
    const [voiceCustomAgentId, setVoiceCustomAgentId] = useSettingMutable('voiceCustomAgentId');
    const [voiceBypassToken, setVoiceBypassToken] = useSettingMutable('voiceBypassToken');

    const [usage, setUsage] = React.useState<VoiceUsageResponse | null>(null);
    const [usageLoading, setUsageLoading] = React.useState(true);

    React.useEffect(() => {
        if (!auth.credentials) return;
        fetchVoiceUsage(auth.credentials)
            .then(setUsage)
            .catch(() => {})
            .finally(() => setUsageLoading(false));
    }, [auth.credentials]);

    // Find current language or default to first option
    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];

    const handleCustomAgentId = React.useCallback(async () => {
        const value = await Modal.prompt(
            t('settingsVoice.customAgentId'),
            t('settingsVoice.customAgentIdDescription'),
            {
                defaultValue: voiceCustomAgentId ?? '',
                placeholder: t('settingsVoice.customAgentIdPlaceholder'),
            }
        );
        if (value !== null) {
            const trimmed = value.trim() || null;
            setVoiceCustomAgentId(trimmed);
            // Auto-toggle bypass when setting/clearing agent ID
            setVoiceBypassToken(trimmed !== null);
        }
    }, [voiceCustomAgentId, setVoiceCustomAgentId, setVoiceBypassToken]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Voice Usage */}
            {usageLoading ? (
                <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                    <ActivityIndicator />
                </View>
            ) : usage ? (
                <ItemGroup title={t('settingsVoice.usageTitle')}>
                    <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                        {usage.limitSeconds !== null && (
                            <UsageBar
                                label={t('settingsVoice.usageLabel')}
                                value={usage.usedSeconds}
                                maxValue={usage.limitSeconds}
                                color={usage.usedSeconds >= usage.limitSeconds ? '#FF3B30' : '#007AFF'}
                            />
                        )}
                        <Text style={{ fontSize: 13, color: '#8E8E93', marginTop: 4 }}>
                            {usage.limitSeconds !== null
                                ? `${formatVoiceTime(usage.usedSeconds)} / ${formatVoiceTime(usage.limitSeconds)}`
                                : formatVoiceTime(usage.usedSeconds)}
                        </Text>
                        {usage.conversationLimit !== null && (
                            <>
                                <UsageBar
                                    label={t('settingsVoice.conversationsLabel')}
                                    value={usage.conversationCount}
                                    maxValue={usage.conversationLimit}
                                    color={usage.conversationCount >= usage.conversationLimit ? '#FF3B30' : '#007AFF'}
                                />
                                <Text style={{ fontSize: 13, color: '#8E8E93', marginTop: 4 }}>
                                    {usage.conversationCount} / {usage.conversationLimit}
                                </Text>
                            </>
                        )}
                    </View>
                </ItemGroup>
            ) : null}

            {/* Language Settings */}
            <ItemGroup
                title={t('settingsVoice.languageTitle')}
                footer={t('settingsVoice.languageDescription')}
            >
                <Item
                    title={t('settingsVoice.preferredLanguage')}
                    subtitle={t('settingsVoice.preferredLanguageSubtitle')}
                    icon={<Ionicons name="language-outline" size={29} color="#007AFF" />}
                    detail={getLanguageDisplayName(currentLanguage)}
                    onPress={() => router.push('/settings/voice/language')}
                />
            </ItemGroup>

            {/* Bring Your Own Agent */}
            <ItemGroup
                title={t('settingsVoice.byoTitle')}
                footer={t('settingsVoice.byoDescription')}
            >
                <Item
                    title={t('settingsVoice.customAgentId')}
                    subtitle={voiceCustomAgentId ?? t('settingsVoice.customAgentIdNotSet')}
                    icon={<Ionicons name="key-outline" size={29} color="#FF9500" />}
                    onPress={handleCustomAgentId}
                />
                <Item
                    title={t('settingsVoice.bypassToken')}
                    subtitle={t('settingsVoice.bypassTokenSubtitle')}
                    icon={<Ionicons name="flash-outline" size={29} color="#FF3B30" />}
                    rightElement={
                        <Switch
                            value={voiceBypassToken}
                            onValueChange={setVoiceBypassToken}
                        />
                    }
                />
            </ItemGroup>

            {/* Prompt Guide — shown when custom agent is configured */}
            {voiceCustomAgentId && (
                <ItemGroup
                    title={t('settingsVoice.promptGuideTitle')}
                    footer={t('settingsVoice.promptGuideDescription')}
                >
                    <Item
                        title={t('settingsVoice.customAgentId')}
                        subtitle={voiceCustomAgentId}
                        copy={voiceCustomAgentId}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
});
```

- [ ] **Step 10: Build config, Dockerfile and test mocks**

`packages/happy-app/expoConfig.cjs`: delete the three lines `revenueCatAppleKey: …`, `revenueCatGoogleKey: …` and `revenueCatStripeKey: …` from `extra.app`.

`packages/happy-app/sources/sync/appConfig.ts`:
- Delete `revenueCatAppleKey?`, `revenueCatGoogleKey?` and `revenueCatStripeKey?` from `AppConfig`.
- Delete the three `if (process.env.EXPO_PUBLIC_REVENUE_CAT_… ) { … }` override blocks.

`Dockerfile.webapp`: delete `ARG REVENUE_CAT_STRIPE=""` and `ENV EXPO_PUBLIC_REVENUE_CAT_STRIPE=$REVENUE_CAT_STRIPE`.

Test mocks:
- `sources/sync/sync.preload.test.ts` and `sources/sync/sync.send.test.ts`: delete the line `vi.mock('@/sync/revenueCat', () => ({ RevenueCat: {}, LogLevel: {}, PaywallResult: {} }));`.
- `sources/sync/rigComposer.test.ts` and `sources/sync/sessionArchiving.test.ts`: remove `loadPurchases: () => null, savePurchases: vi.fn(), ` from the persistence mock object.

- [ ] **Step 11: Verify nothing references RevenueCat**

Run:
```bash
cd /home/rophy/projects/happy
grep -rniE "revenuecat|paywall|entitlement|purchase|voiceUpsell|voiceExperiment" packages/happy-app/sources --include=*.ts --include=*.tsx \
  | grep -v "sources/appConfig.test.ts"
grep -niE "revenue|purchases" packages/happy-app/package.json packages/happy-app/expoConfig.cjs Dockerfile.webapp
pnpm --filter happy-app typecheck
pnpm --filter happy-app exec vitest run
```
Expected: both greps print nothing; typecheck clean; tests pass except the known `sessionPresentation.test.ts`.

- [ ] **Step 12: Commit**

```bash
git add -A packages/happy-app pnpm-lock.yaml Dockerfile.webapp
git status --short   # only the files listed in this task
git commit -m "feat: remove RevenueCat, the paywall and the voice upsell"
```

---

### Task 4: App reads server features; hide disabled integrations and Claude.ai connect

**Files:**
- Create: `packages/happy-app/sources/sync/apiFeatures.ts`
- Test: `packages/happy-app/sources/sync/apiFeatures.test.ts`
- Create: `packages/happy-app/sources/sync/appConfigEnv.ts`
- Test: `packages/happy-app/sources/sync/appConfigEnv.test.ts`
- Modify: `packages/happy-app/sources/sync/appConfig.ts`, `packages/happy-app/expoConfig.cjs`, `packages/happy-app/sources/appConfig.test.ts`
- Modify: `packages/happy-app/sources/sync/storage.ts`, `packages/happy-app/sources/sync/sync.ts`
- Modify: `packages/happy-app/sources/-session/SessionView.tsx`, `packages/happy-app/sources/components/SettingsView.tsx`
- Modify: `packages/happy-app/sources/app/(app)/settings/account.tsx`, `packages/happy-app/sources/app/(app)/settings/connect/claude.tsx`, `packages/happy-app/sources/app/(app)/dev/index.tsx`

**Interfaces:**
- Consumes: wire `FeaturesResponseSchema` (Task 1).
- Produces:
  ```ts
  // apiFeatures.ts
  type ServerFeatures = { voice: boolean; githubConnect: boolean; push: boolean }
  const serverFeaturesDefaults: ServerFeatures            // all false
  function fetchServerFeatures(): Promise<ServerFeatures>   // 404 → defaults; other non-OK → throws
  // storage.ts
  StorageState.features: ServerFeatures; StorageState.applyFeatures(features: ServerFeatures): void
  function useServerFeature(name: keyof ServerFeatures): boolean
  // appConfig.ts / appConfigEnv.ts
  AppConfig.postHogKey?: string; AppConfig.postHogHost?: string; AppConfig.enableClaudeConnect?: boolean
  type AppConfigEnv = { EXPO_PUBLIC_POSTHOG_API_KEY?: string; EXPO_PUBLIC_POSTHOG_HOST?: string; EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT?: string; EXPO_PUBLIC_SERVER_URL?: string }
  function applyAppConfigEnv(config: Partial<AppConfig>, env: AppConfigEnv): AppConfig
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/happy-app/sources/sync/apiFeatures.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessTokenProvider, staticAccessTokenProvider } from '@/auth/authFetch';

vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://api.test.com' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'test-client' }));

import { fetchServerFeatures, serverFeaturesDefaults } from './apiFeatures';

describe('fetchServerFeatures', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        setAccessTokenProvider(staticAccessTokenProvider('test-token', 'https://api.test.com'));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        setAccessTokenProvider(null);
    });

    it('reads /v1/features with a Bearer token', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ voice: true, githubConnect: false, push: true }), { status: 200 }));
        await expect(fetchServerFeatures()).resolves.toEqual({ voice: true, githubConnect: false, push: true });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.test.com/v1/features',
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer test-token', 'X-Happy-Client': 'test-client' }),
            }),
        );
    });

    it('treats a server without the endpoint as having every integration off', async () => {
        fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
        await expect(fetchServerFeatures()).resolves.toEqual({ voice: false, githubConnect: false, push: false });
        expect(serverFeaturesDefaults).toEqual({ voice: false, githubConnect: false, push: false });
    });

    it('throws on other failures so the sync retries', async () => {
        fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
        await expect(fetchServerFeatures()).rejects.toThrow('500');
    });

    it('rejects a malformed response', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ voice: 'yes' }), { status: 200 }));
        await expect(fetchServerFeatures()).rejects.toThrow();
    });
});
```

```ts
// packages/happy-app/sources/sync/appConfigEnv.test.ts
import { describe, expect, it } from 'vitest';
import { applyAppConfigEnv } from './appConfigEnv';

describe('applyAppConfigEnv', () => {
    it('keeps the manifest values when nothing is set', () => {
        expect(applyAppConfigEnv({ postHogKey: 'phc_manifest', enableClaudeConnect: false }, {}))
            .toEqual({ postHogKey: 'phc_manifest', enableClaudeConnect: false });
    });

    it('overrides from EXPO_PUBLIC_* values and ignores blanks', () => {
        const config = applyAppConfigEnv({}, {
            EXPO_PUBLIC_POSTHOG_API_KEY: ' phc_env ',
            EXPO_PUBLIC_POSTHOG_HOST: 'https://posthog.corp.example',
            EXPO_PUBLIC_SERVER_URL: '  ',
        });
        expect(config).toEqual({ postHogKey: 'phc_env', postHogHost: 'https://posthog.corp.example' });
    });

    it('enables Claude connect only for "1"', () => {
        expect(applyAppConfigEnv({}, { EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT: '1' }).enableClaudeConnect).toBe(true);
        expect(applyAppConfigEnv({ enableClaudeConnect: true }, { EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT: 'true' }).enableClaudeConnect).toBe(false);
        expect(applyAppConfigEnv({}, {}).enableClaudeConnect).toBeUndefined();
    });
});
```

In `packages/happy-app/sources/appConfig.test.ts`, add inside `describe('buildExpoConfig', …)`:

```ts
    it('carries analytics and Claude connect settings only when set', () => {
        const off = buildExpoConfig({}).expo.extra.app;
        expect(off.postHogKey).toBeUndefined();
        expect(off.postHogHost).toBeUndefined();
        expect(off.enableClaudeConnect).toBe(false);

        const on = buildExpoConfig({
            EXPO_PUBLIC_POSTHOG_API_KEY: 'phc_test',
            EXPO_PUBLIC_POSTHOG_HOST: 'https://posthog.corp.example',
            EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT: '1',
        }).expo.extra.app;
        expect(on).toMatchObject({ postHogKey: 'phc_test', postHogHost: 'https://posthog.corp.example', enableClaudeConnect: true });
    });
```

Run: `pnpm --filter happy-app exec vitest run sources/sync/apiFeatures.test.ts sources/sync/appConfigEnv.test.ts sources/appConfig.test.ts`
Expected: FAIL. The new modules are missing, and `extra.app` has no `postHogHost` / `enableClaudeConnect`.

- [ ] **Step 2: Implement `apiFeatures.ts`**

```ts
// packages/happy-app/sources/sync/apiFeatures.ts
import { FeaturesResponseSchema, type FeaturesResponse } from '@slopus/happy-wire';
import { authFetch } from '@/auth/authFetch';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

/** Server-side integrations this deployment turned on (GET /v1/features). */
export type ServerFeatures = FeaturesResponse;

/** Everything off until the server says otherwise. */
export const serverFeaturesDefaults: ServerFeatures = Object.freeze({
    voice: false,
    githubConnect: false,
    push: false,
});

export async function fetchServerFeatures(): Promise<ServerFeatures> {
    const response = await authFetch(`${getServerUrl()}/v1/features`, {
        headers: {
            'X-Happy-Client': getHappyClientId(),
        },
    });
    if (response.status === 404) {
        // A server without the endpoint offers no optional integrations.
        return { ...serverFeaturesDefaults };
    }
    if (!response.ok) {
        throw new Error(`Failed to fetch features: ${response.status}`);
    }
    return FeaturesResponseSchema.parse(await response.json());
}
```

- [ ] **Step 3: Implement `appConfigEnv.ts` and use it**

```ts
// packages/happy-app/sources/sync/appConfigEnv.ts
import type { AppConfig } from './appConfig';

/**
 * EXPO_PUBLIC_* values the bundle was built with. Callers must pass literal
 * `process.env.EXPO_PUBLIC_X` reads: Metro only inlines literal accesses, so
 * `process.env` as a whole is empty on web.
 */
export type AppConfigEnv = {
    EXPO_PUBLIC_POSTHOG_API_KEY?: string;
    EXPO_PUBLIC_POSTHOG_HOST?: string;
    EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT?: string;
    EXPO_PUBLIC_SERVER_URL?: string;
};

function present(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

/** Native manifests are baked at prebuild; inlined EXPO_PUBLIC_* values win when set. */
export function applyAppConfigEnv(config: Partial<AppConfig>, env: AppConfigEnv): AppConfig {
    const result: Partial<AppConfig> = { ...config };
    const postHogKey = present(env.EXPO_PUBLIC_POSTHOG_API_KEY);
    if (postHogKey) {
        result.postHogKey = postHogKey;
    }
    const postHogHost = present(env.EXPO_PUBLIC_POSTHOG_HOST);
    if (postHogHost) {
        result.postHogHost = postHogHost;
    }
    const claudeConnect = present(env.EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT);
    if (claudeConnect !== undefined) {
        result.enableClaudeConnect = claudeConnect === '1';
    }
    const serverUrl = present(env.EXPO_PUBLIC_SERVER_URL);
    if (serverUrl) {
        result.serverUrl = serverUrl;
    }
    return result as AppConfig;
}
```

In `packages/happy-app/sources/sync/appConfig.ts`:
- Add `import { applyAppConfigEnv } from './appConfigEnv';`.
- Set the interface to:

```ts
export interface AppConfig {
    postHogKey?: string;
    postHogHost?: string;
    enableClaudeConnect?: boolean;
    consoleLoggingDefault?: boolean;
    serverUrl?: string;
    buildCommitSha?: string;
    buildCommitTimestamp?: string;
}
```

- Replace the remaining override section (the comment `// Override with EXPO_PUBLIC_* env vars …` through `return config as AppConfig;`) with:

```ts
    return applyAppConfigEnv(config, {
        EXPO_PUBLIC_POSTHOG_API_KEY: process.env.EXPO_PUBLIC_POSTHOG_API_KEY,
        EXPO_PUBLIC_POSTHOG_HOST: process.env.EXPO_PUBLIC_POSTHOG_HOST,
        EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT: process.env.EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT,
        EXPO_PUBLIC_SERVER_URL: process.env.EXPO_PUBLIC_SERVER_URL,
    });
```

In `packages/happy-app/expoConfig.cjs`, replace `postHogKey: env.EXPO_PUBLIC_POSTHOG_API_KEY,` with:

```js
                postHogKey: value(env, 'EXPO_PUBLIC_POSTHOG_API_KEY') || undefined,
                postHogHost: value(env, 'EXPO_PUBLIC_POSTHOG_HOST') || undefined,
                enableClaudeConnect: value(env, 'EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT') === '1',
```

Run: `pnpm --filter happy-app exec vitest run sources/sync/apiFeatures.test.ts sources/sync/appConfigEnv.test.ts sources/appConfig.test.ts`
Expected: PASS.

- [ ] **Step 4: Features in storage and sync; gate push registration**

`packages/happy-app/sources/sync/storage.ts`:
- Add `import { type ServerFeatures, serverFeaturesDefaults } from './apiFeatures';`.
- In `interface StorageState`, after `profile: Profile;`, add `features: ServerFeatures;`. After `applyProfile: (profile: Profile) => void;`, add `applyFeatures: (features: ServerFeatures) => void;`.
- In the initial state, after `profile,`, add `features: serverFeaturesDefaults,`.
- Next to `applyProfile`, add:

```ts
        applyFeatures: (features: ServerFeatures) => set((state) => ({
            ...state,
            features,
        })),
```

- Next to the other hooks at the end of the file, add:

```ts
export function useServerFeature(name: keyof ServerFeatures): boolean {
    return storage((state) => state.features[name]);
}
```

`packages/happy-app/sources/sync/sync.ts`:
- Add `import { fetchServerFeatures } from './apiFeatures';`.
- Add the field `private featuresSync: InvalidateSync;` after `private profileSync: InvalidateSync;`.
- In the constructor, after `this.profileSync = new InvalidateSync(this.fetchProfile);`, add `this.featuresSync = new InvalidateSync(this.fetchFeatures);`.
- In the AppState `'active'` branch and in `#init()`, add `this.featuresSync.invalidate();` directly after `this.profileSync.invalidate();`. In `#init` it must come before `this.pushTokenSync.invalidate();`.
- Add after `fetchProfile`:

```ts
    private fetchFeatures = async () => {
        if (!this.credentials) return;
        storage.getState().applyFeatures(await fetchServerFeatures());
    }
```

- At the top of `registerPushToken`'s body, before `const result = await syncCurrentPushToken(...)` and inside the `try`, add:

```ts
            // Push is a server decision (PUSH_ENABLED): never register a token it will not use.
            await this.featuresSync.awaitQueue();
            if (!storage.getState().features.push) {
                log.log('Push disabled by the server; skipping push token registration');
                return;
            }
```

- [ ] **Step 5: Hide the mic and the voice and GitHub UI**

`packages/happy-app/sources/-session/SessionView.tsx`:
- Add `useServerFeature` to the existing `import { storage, useIsDataReady, … } from '@/sync/storage';` line.
- Directly before `const voiceSessionActive = realtimeStatus === 'connected' || realtimeStatus === 'connecting';`, add:

```ts
    // No voice on this server: no mic, so no voice entry point at all.
    const voiceEnabled = useServerFeature('voice');
```

- Change the two composer props to:

```tsx
                onMicPress={(embedded || isDisconnected || !voiceEnabled) ? undefined : micButtonState.onMicPress}
                isMicActive={(embedded || isDisconnected || !voiceEnabled) ? false : micButtonState.isMicActive}
```

`packages/happy-app/sources/components/SettingsView.tsx`:
- Change the storage import to `import { useLocalSettingMutable, useServerFeature, useSetting } from '@/sync/storage';` and add `import { config } from '@/config';`.
- After `const experiments = useSetting('experiments');`, add:

```ts
    const voiceEnabled = useServerFeature('voice');
    const githubConnectEnabled = useServerFeature('githubConnect');
    const claudeConnectEnabled = config.enableClaudeConnect === true;
```

- Replace the whole `<ItemGroup title={t('settings.connectedAccounts')}> … </ItemGroup>` with:

```tsx
            {(claudeConnectEnabled || githubConnectEnabled) && (
                <ItemGroup title={t('settings.connectedAccounts')}>
                    {claudeConnectEnabled && (
                        <Item
                            title="Claude Code"
                            subtitle={isAnthropicConnected
                                ? t('settingsAccount.statusActive')
                                : t('settings.connectAccount')
                            }
                            icon={
                                <Image
                                    source={require('@/assets/images/icon-claude.png')}
                                    style={{ width: 29, height: 29 }}
                                    contentFit="contain"
                                />
                            }
                            onPress={isAnthropicConnected ? handleDisconnectAnthropic : connectAnthropic}
                            loading={connectingAnthropic || disconnectingAnthropic}
                            showChevron={false}
                        />
                    )}
                    {githubConnectEnabled && (
                        <Item
                            title={t('settings.github')}
                            subtitle={isGitHubConnected
                                ? t('settings.githubConnected', { login: profile.github?.login! })
                                : t('settings.connectGithubAccount')
                            }
                            icon={
                                <Ionicons
                                    name="logo-github"
                                    size={29}
                                    color={isGitHubConnected ? theme.colors.status.connected : theme.colors.textSecondary}
                                />
                            }
                            onPress={isGitHubConnected ? handleDisconnectGitHub : connectGitHub}
                            loading={connectingGitHub || disconnectingGitHub}
                            showChevron={false}
                        />
                    )}
                </ItemGroup>
            )}
```

- Wrap the Voice Assistant item:

```tsx
                {voiceEnabled && (
                    <Item
                        title={t('settings.voiceAssistant')}
                        subtitle={t('settings.voiceAssistantSubtitle')}
                        icon={<Ionicons name="mic-outline" size={29} color="#34C759" />}
                        onPress={() => router.push('/settings/voice')}
                    />
                )}
```

`packages/happy-app/sources/app/(app)/settings/account.tsx`:
- Change `import { useSettingMutable, useProfile } from '@/sync/storage';` to `import { useSettingMutable, useProfile, useServerFeature } from '@/sync/storage';`.
- After `const profile = useProfile();`, add:

```ts
    const githubConnectEnabled = useServerFeature('githubConnect');
    const pushEnabled = useServerFeature('push');
```

- On the GitHub profile `<Item title={t('settingsAccount.github')} …>`, change `subtitle={t('settingsAccount.tapToDisconnect')}` to `subtitle={githubConnectEnabled ? t('settingsAccount.tapToDisconnect') : undefined}` and `onPress={handleDisconnectGitHub}` to `onPress={githubConnectEnabled ? handleDisconnectGitHub : undefined}`.
- Wrap the two push groups, the `<ItemGroup title="Push Notifications" …>…</ItemGroup>` and the following ``<ItemGroup title={`Registered Tokens (${pushTokens.length})`} …>…</ItemGroup>``, in `{pushEnabled && (<>` … `</>)}`.

- [ ] **Step 6: Claude.ai connect behind the build flag**

`packages/happy-app/sources/app/(app)/settings/connect/claude.tsx`:
- Change `import { useRouter } from 'expo-router';` to `import { Redirect, useRouter } from 'expo-router';` and add `import { config } from '@/config';`.
- Make these the first statements of `export default function ClaudeOAuth()`. The function calls no hooks, so the early return is safe:

```tsx
    // Claude.ai account connect talks to claude.ai directly; off unless the build opts in.
    if (!config.enableClaudeConnect) {
        return <Redirect href="/settings" />;
    }
```

`packages/happy-app/sources/app/(app)/dev/index.tsx`:
- Add `import { config } from '@/config';`.
- Wrap the `<Item title="Claude OAuth Test" … />` in `{config.enableClaudeConnect && ( … )}`.

- [ ] **Step 7: Typecheck, tests, commit**

Run:
```bash
pnpm --filter happy-app typecheck
pnpm --filter happy-app exec vitest run
```
Expected: clean; all tests pass except the known `sessionPresentation.test.ts`.

```bash
git add packages/happy-app/sources/sync/apiFeatures.ts packages/happy-app/sources/sync/apiFeatures.test.ts \
  packages/happy-app/sources/sync/appConfigEnv.ts packages/happy-app/sources/sync/appConfigEnv.test.ts \
  packages/happy-app/sources/sync/appConfig.ts packages/happy-app/expoConfig.cjs packages/happy-app/sources/appConfig.test.ts \
  packages/happy-app/sources/sync/storage.ts packages/happy-app/sources/sync/sync.ts \
  packages/happy-app/sources/-session/SessionView.tsx packages/happy-app/sources/components/SettingsView.tsx \
  "packages/happy-app/sources/app/(app)/settings/account.tsx" "packages/happy-app/sources/app/(app)/settings/connect/claude.tsx" \
  "packages/happy-app/sources/app/(app)/dev/index.tsx"
git commit -m "feat: hide voice, GitHub, push and Claude connect unless enabled"
```

---

### Task 5: PostHog only when configured, deploy docs, and web e2e

**Files:**
- Create: `packages/happy-app/sources/track/postHogConfig.ts`
- Test: `packages/happy-app/sources/track/postHogConfig.test.ts`
- Modify: `packages/happy-app/sources/track/tracking.ts`
- Modify: `packages/happy-app/sources/app/(app)/settings/account.tsx` (Analytics group)
- Modify: `Dockerfile.webapp`, `docs/deploy-app.md`
- Create: `e2e/tests/integrations.spec.ts`

**Interfaces:**
- Consumes: `AppConfig.postHogKey`, `AppConfig.postHogHost` (Task 4).
- Produces:
  ```ts
  const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'
  function resolvePostHogConfig(input: { apiKey?: string | null; host?: string | null; disabled?: boolean }): { apiKey: string; host: string } | null
  const tracking: PostHog | null   // unchanged export; null whenever analytics is off
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/happy-app/sources/track/postHogConfig.test.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_POSTHOG_HOST, resolvePostHogConfig } from './postHogConfig';

describe('resolvePostHogConfig', () => {
    it('is off without an API key', () => {
        expect(resolvePostHogConfig({})).toBeNull();
        expect(resolvePostHogConfig({ apiKey: '   ', host: 'https://posthog.corp.example' })).toBeNull();
    });

    it('uses PostHog cloud when only the key is set', () => {
        expect(resolvePostHogConfig({ apiKey: 'phc_test' })).toEqual({ apiKey: 'phc_test', host: DEFAULT_POSTHOG_HOST });
    });

    it('uses a self-hosted instance from EXPO_PUBLIC_POSTHOG_HOST', () => {
        expect(resolvePostHogConfig({ apiKey: 'phc_test', host: 'https://posthog.corp.example/' }))
            .toEqual({ apiKey: 'phc_test', host: 'https://posthog.corp.example' });
    });

    it('stays off when analytics is disabled', () => {
        expect(resolvePostHogConfig({ apiKey: 'phc_test', disabled: true })).toBeNull();
    });
});
```

Run: `pnpm --filter happy-app exec vitest run sources/track/postHogConfig.test.ts`
Expected: FAIL, `./postHogConfig` cannot be resolved.

- [ ] **Step 2: Implement and use it**

```ts
// packages/happy-app/sources/track/postHogConfig.ts
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * PostHog runs only when the build sets EXPO_PUBLIC_POSTHOG_API_KEY.
 * EXPO_PUBLIC_POSTHOG_HOST selects a self-hosted instance.
 */
export function resolvePostHogConfig(input: {
    apiKey?: string | null;
    host?: string | null;
    disabled?: boolean;
}): { apiKey: string; host: string } | null {
    const apiKey = input.apiKey?.trim();
    if (input.disabled || !apiKey) {
        return null;
    }
    const host = input.host?.trim().replace(/\/+$/, '') || DEFAULT_POSTHOG_HOST;
    return { apiKey, host };
}
```

Replace `packages/happy-app/sources/track/tracking.ts` with:

```ts
import { config } from '@/config';
import PostHog from 'posthog-react-native';
import { resolvePostHogConfig } from './postHogConfig';

const postHog = resolvePostHogConfig({
    apiKey: config.postHogKey,
    host: config.postHogHost,
    disabled:
        process.env.EXPO_PUBLIC_DISABLE_ANALYTICS === '1' ||
        process.env.EXPO_PUBLIC_DISABLE_ANALYTICS === 'true' ||
        (globalThis as any).__HAPPY_CONFIG__?.disableAnalytics === true,
});

/** null unless the build configured PostHog; every caller must handle null. */
export const tracking = postHog ? new PostHog(postHog.apiKey, {
    host: postHog.host,
    captureAppLifecycleEvents: true,
}) : null;
```

In `packages/happy-app/sources/app/(app)/settings/account.tsx`, add `import { tracking } from '@/track';` and wrap the `{/* Analytics Section */}` `<ItemGroup title={t('settingsAccount.privacy')} …>…</ItemGroup>` in `{tracking && ( … )}`.

Run:
```bash
pnpm --filter happy-app exec vitest run sources/track/postHogConfig.test.ts
pnpm --filter happy-app typecheck
```
Expected: PASS (4 tests); typecheck clean.

- [ ] **Step 3: Build args and deploy docs**

In `Dockerfile.webapp`, after `ARG POSTHOG_API_KEY=""`, add:

```dockerfile
ARG POSTHOG_HOST=""
ARG ENABLE_CLAUDE_CONNECT=""
```

After `ENV EXPO_PUBLIC_POSTHOG_API_KEY=$POSTHOG_API_KEY`, add:

```dockerfile
ENV EXPO_PUBLIC_POSTHOG_HOST=$POSTHOG_HOST
ENV EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT=$ENABLE_CLAUDE_CONNECT
```

In `docs/deploy-app.md`, append these rows to the "Build environment" table, after `APP_ASSETS_DIR`:

```
| `EXPO_PUBLIC_POSTHOG_API_KEY` | no | none | PostHog project key. Without it the app sends no analytics and hides the Analytics setting. |
| `EXPO_PUBLIC_POSTHOG_HOST` | no | `https://us.i.posthog.com` | PostHog instance, e.g. your self-hosted `https://posthog.example.com`. Only used with a key. |
| `EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT` | no | off | `1` shows the Claude.ai account connect screen, which talks to claude.ai directly. Hidden otherwise. |
```

At the end of "Server settings that pair with the build", add:

```
- Voice, GitHub connect and push are server decisions. The app reads `GET /v1/features` after sign-in and hides the mic and voice settings, the GitHub connect rows, and push registration for anything the server has off.
  - Turn them on with `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` (optional `VOICE_MONTHLY_LIMIT_MINUTES`), `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` + `GITHUB_REDIRECT_URL`, and `PUSH_ENABLED` (default `true`). See `docs/deployment.md`.
- Push also needs your own EAS project (`EAS_PROJECT_ID`), APNs key and FCM credentials (`GOOGLE_SERVICES_FILE`). Notifications carry only a fixed title per event, a generic body, and the session id.
```

In the "Web app" list, replace the bullet that starts with `` `Dockerfile.webapp` builds a production web image`` with:

```
- `Dockerfile.webapp` builds a production web image. Pass `HAPPY_SERVER_URL`, `APP_BUNDLE_ID` and `APP_SCHEME` as build args (the last two are unused on the web but required by production config). Optional build args: `POSTHOG_API_KEY`, `POSTHOG_HOST` and `ENABLE_CLAUDE_CONNECT`, which map to the `EXPO_PUBLIC_*` variables above.
```

- [ ] **Step 4: Write the e2e test**

```ts
// e2e/tests/integrations.spec.ts
import { expect, test } from '@playwright/test';
import { SERVER_URL, readCredentials, signIn } from './helpers';

// The compose stack configures no voice, GitHub, PostHog or Claude connect; push keeps its default.

test('the server reports its integrations to signed-in clients only', async ({ page }) => {
    await signIn(page);
    const credentials = (await readCredentials(page))!;
    const result = await page.evaluate(async ([url, token]) => {
        const anonymous = await fetch(`${url}/v1/features`);
        const signedIn = await fetch(`${url}/v1/features`, { headers: { Authorization: `Bearer ${token}` } });
        return { anonymous: anonymous.status, status: signedIn.status, body: await signedIn.json() };
    }, [SERVER_URL, credentials.token] as const);
    expect(result).toEqual({ anonymous: 401, status: 200, body: { voice: false, githubConnect: false, push: true } });
});

test('settings hide integrations that are not configured', async ({ page }) => {
    await signIn(page);

    await page.goto('/settings');
    await expect(page.getByText('Appearance', { exact: true })).toBeVisible();
    await expect(page.getByText('Support us', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Voice Assistant', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Claude Code', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/^connected accounts$/i)).toHaveCount(0);

    await page.goto('/settings/account');
    await expect(page.getByText('Logout', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Analytics', { exact: true })).toHaveCount(0);
});

test('the Claude.ai connect screen is unreachable without the build flag', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings/connect/claude');
    await page.waitForURL((url) => url.pathname === '/settings');
});
```

- [ ] **Step 5: Run the web e2e suite**

From the repo root:
```bash
AUTH_REFRESH_REUSE_GRACE=0s AUTH_ACCESS_TOKEN_TTL=3m docker compose --profile e2e up -d --build
(cd e2e && npx playwright test)
docker compose --profile e2e down
```
Expected: all tests pass, including the three new ones in `integrations.spec.ts` and the existing `auth.spec.ts` / `socket.spec.ts`. Only compose project `happy` is started and stopped. If a port is already in use by another project, stop and report; do not touch other containers.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-app/sources/track/postHogConfig.ts packages/happy-app/sources/track/postHogConfig.test.ts \
  packages/happy-app/sources/track/tracking.ts "packages/happy-app/sources/app/(app)/settings/account.tsx" \
  Dockerfile.webapp docs/deploy-app.md e2e/tests/integrations.spec.ts
git commit -m "feat: run PostHog only when configured and allow a self-hosted host"
```

---

### Task 6: Content-free push

**Files:**
- Create: `packages/happy-server/sources/app/push/pushCopy.ts`
- Test: `packages/happy-server/sources/app/push/pushCopy.test.ts`
- Modify: `packages/happy-server/sources/app/push/pushDispatch.ts`
- Modify: `packages/happy-server/sources/app/api/routes/pushRoutes.ts`, `pushRoutes.spec.ts`
- Modify: `packages/happy-server/sources/app/api/api.ts`
- Rewrite: `packages/happy-cli/src/api/pushNotifications.ts`, `packages/happy-cli/src/api/pushNotifications.test.ts`
- Modify: `packages/happy-cli/src/api/api.ts`, `src/claude/claudeRemoteLauncher.ts`, `src/claude/utils/permissionHandler.ts`, `src/claude/utils/permissionHandler.test.ts`, `src/gemini/runGemini.ts`, `src/codex/runCodex.ts`
- Modify: `packages/happy-cli/src/index.ts` (remove `happy notify`), `packages/happy-cli/README.md`, `packages/happy-cli/package.json`, `pnpm-lock.yaml`
- Modify: `docs/deployment.md`

**Interfaces:**
- Consumes: `FeaturesConfig.pushEnabled` (Task 1).
- Produces (server):
  ```ts
  type SessionEventKind = 'done' | 'permission' | 'question'
  const SESSION_EVENT_PUSH_BODY = 'Open the session to continue.'
  function buildSessionEventPush(sessionId: string, kind: SessionEventKind): { title: string; body: string; data: { sessionId: string; kind: SessionEventKind; url: string } }
  function dispatchSessionEventPush(params: { userId: string; sessionId: string; kind: SessionEventKind }): Promise<PushOutcome>
  function pushRoutes(app: Fastify, opts: { pushEnabled: boolean }): void
  // POST /v1/sessions/:id/push-event body: { kind }; 200 result adds 'disabled'
  ```
- Produces (CLI):
  ```ts
  class PushNotificationClient {
    constructor(token: AccessTokenSource, baseUrl: string)
    sendSessionNotification(params: { kind: SessionNotificationKind; sessionId: string }): Promise<void>  // never rejects
  }
  ```
  Removed: `sendToAllDevices`, `sendPushNotifications`, `fetchPushTokens`, `PushToken`, `getSessionNotification{Title,Body,Copy}`, the `happy notify` command, and the `expo-server-sdk` dependency.

- [ ] **Step 1: Write the failing server tests**

```ts
// packages/happy-server/sources/app/push/pushCopy.test.ts
import { describe, expect, it } from 'vitest';
import { SESSION_EVENT_PUSH_BODY, buildSessionEventPush } from './pushCopy';

describe('buildSessionEventPush', () => {
    it('uses a fixed title per kind, a generic body and minimal data', () => {
        expect(buildSessionEventPush('sess-1', 'done')).toEqual({
            title: "It's ready!",
            body: SESSION_EVENT_PUSH_BODY,
            data: { sessionId: 'sess-1', kind: 'done', url: '/session/sess-1' },
        });
        expect(buildSessionEventPush('sess-1', 'permission').title).toBe('Permission request');
        expect(buildSessionEventPush('sess-1', 'question').title).toBe('Clarification needed');
        expect(SESSION_EVENT_PUSH_BODY).toBe('Open the session to continue.');
    });

    it('encodes the session id in the url', () => {
        expect(buildSessionEventPush('a/b c', 'done').data.url).toBe('/session/a%2Fb%20c');
    });
});
```

In `packages/happy-server/sources/app/api/routes/pushRoutes.spec.ts`:
- Change the `sent` element type in `state` to `Array<Record<string, unknown>>`, and type `pushSendMock`'s parameter as `messages: Array<Record<string, unknown> & { to: string }>`.
- Change `buildApp` to take the flag:

```ts
async function buildApp(pushEnabled = true): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => { request.userId = USER; });
    pushRoutes(typed, { pushEnabled });
    await typed.ready();
    return typed;
}
```

- Change `postPushEvent` so it behaves like an old CLI that still sends content:

```ts
async function postPushEvent(app: Fastify, sessionId = SESSION, kind: 'done' | 'permission' | 'question' = 'done') {
    return app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/push-event`,
        headers: { authorization: 'Bearer t' },
        payload: {
            kind,
            title: 'Fix the payroll export',
            body: '/home/alice/secret-project',
            data: { path: '/home/alice/secret-project', tool: 'Bash', sessionTitle: 'payroll' },
        },
    });
}
```

- Add these tests inside the `describe`:

```ts
    it('sends fixed, content-free copy and ignores client text', async () => {
        const res = await postPushEvent(app);
        expect(res.statusCode).toBe(200);
        expect(state.sent).toEqual([{
            to: 'ExponentPushToken[aaa]',
            title: "It's ready!",
            body: 'Open the session to continue.',
            data: { sessionId: SESSION, kind: 'done', url: `/session/${SESSION}` },
            sound: 'default',
            channelId: 'messages',
        }]);
        expect(JSON.stringify(state.sent)).not.toMatch(/payroll|alice|secret|Bash/);
    });

    it('uses the permission title for permission events', async () => {
        await postPushEvent(app, SESSION, 'permission');
        expect(state.sent[0].title).toBe('Permission request');
    });

    it('accepts a body with only the kind', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/v1/sessions/${SESSION}/push-event`,
            headers: { authorization: 'Bearer t' },
            payload: { kind: 'question' },
        });
        expect(res.statusCode).toBe(200);
        expect(state.sent[0]).toMatchObject({ title: 'Clarification needed' });
    });

    it('sends the same fixed copy to connected clients', async () => {
        const emit = vi.spyOn(eventRouter, 'emitEphemeral');
        await postPushEvent(app);
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ type: 'session-event', title: "It's ready!", body: 'Open the session to continue.' }),
        }));
        emit.mockRestore();
    });

    it('skips Expo entirely when PUSH_ENABLED is false', async () => {
        const disabled = await buildApp(false);
        const res = await postPushEvent(disabled);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ success: true, result: 'disabled' });
        expect(state.sent).toHaveLength(0);
        expect(dbMock.accountPushToken.findMany).not.toHaveBeenCalled();
        await disabled.close();
    });
```

Run: `pnpm --filter happy-server exec vitest run sources/app/push/pushCopy.test.ts sources/app/api/routes/pushRoutes.spec.ts`
Expected: FAIL. `pushCopy` is missing, and `pushRoutes` still forwards client text and ignores the options.

- [ ] **Step 2: Implement the server side**

```ts
// packages/happy-server/sources/app/push/pushCopy.ts
export type SessionEventKind = 'done' | 'permission' | 'question';

const TITLES: Record<SessionEventKind, string> = {
    done: "It's ready!",
    permission: 'Permission request',
    question: 'Clarification needed',
};

/** Pushes never carry session titles, paths, tool names or message text. */
export const SESSION_EVENT_PUSH_BODY = 'Open the session to continue.';

export interface SessionEventPush {
    title: string;
    body: string;
    data: { sessionId: string; kind: SessionEventKind; url: string };
}

export function buildSessionEventPush(sessionId: string, kind: SessionEventKind): SessionEventPush {
    return {
        title: TITLES[kind],
        body: SESSION_EVENT_PUSH_BODY,
        data: { sessionId, kind, url: `/session/${encodeURIComponent(sessionId)}` },
    };
}
```

In `packages/happy-server/sources/app/push/pushDispatch.ts`:
- Add `import { buildSessionEventPush, type SessionEventKind } from "@/app/push/pushCopy";`.
- Replace `dispatchSessionEventPush` with:

```ts
export async function dispatchSessionEventPush(params: {
    userId: string;
    sessionId: string;
    kind: SessionEventKind;
}): Promise<PushOutcome> {
    const { userId, sessionId, kind } = params;
    const push = buildSessionEventPush(sessionId, kind);

    try {
        try {
            if (await isUserActive(userId)) {
                log({ module: 'push' }, `Suppressed session-event push for user ${userId} session ${sessionId}: user active`);
                return { result: 'suppressed', reason: 'active-ui-client' };
            }
        } catch (presenceError) {
            // Fail open: if we cannot prove the user is watching, notify them.
            log({ module: 'push', level: 'error' }, `Presence check failed, sending push anyway: ${presenceError}`);
        }

        return await fetchTokensAndSend({
            userId,
            sessionId,
            title: push.title,
            body: push.body,
            data: push.data,
            channelId: 'messages'
        });
    } catch (error) {
        log({ module: 'push', level: 'error' }, `Session-event push dispatch failed: ${error}`);
        return { result: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
}
```

- In the file's header comment, change `rich session-event ("It's ready!", permission, question)` to `content-free session-event (fixed copy per kind, see pushCopy.ts)`.

In `packages/happy-server/sources/app/api/routes/pushRoutes.ts`:
- Add `import { buildSessionEventPush } from "@/app/push/pushCopy";`.
- Change the signature to `export function pushRoutes(app: Fastify, opts: { pushEnabled: boolean }) {`.
- In the `/v1/sessions/:sessionId/push-event` route, set the body schema to:

```ts
            body: z.object({
                // Older CLIs also send title, body and data. zod strips them: pushes
                // carry only fixed copy built from the kind (see pushCopy.ts).
                kind: z.enum(['done', 'permission', 'question']),
            }),
```

- In the 200 response schema, change `result: z.enum(['sent', 'partial', 'suppressed', 'no_tokens', 'failed'])` to `result: z.enum(['sent', 'partial', 'suppressed', 'no_tokens', 'failed', 'disabled'])`.
- Replace the handler body from `const { kind, title, body, data } = request.body;` to the end with:

```ts
        const { kind } = request.body;

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
            select: { id: true }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Web tabs use this to bump the tab-title unread counter; same fixed copy as the push.
        const push = buildSessionEventPush(sessionId, kind);
        eventRouter.emitEphemeral({
            userId,
            payload: buildSessionEventEphemeral(sessionId, kind, push.title, push.body),
            recipientFilter: { type: 'all-interested-in-session', sessionId }
        });

        if (!opts.pushEnabled) {
            return reply.send({ success: true, result: 'disabled' as const });
        }

        // Awaited so the response can report the real outcome. The CLI sends
        // this fire-and-forget, so the extra latency never blocks a turn.
        const outcome = await dispatchSessionEventPush({ userId, sessionId, kind });
        return reply.send({ success: true, ...outcome });
```

In `packages/happy-server/sources/app/api/api.ts`, change `pushRoutes(typed);` to `pushRoutes(typed, { pushEnabled: features.pushEnabled });`. This line must come after `const features = loadFeaturesConfig();`; move the `pushRoutes` call below it if needed.

Run:
```bash
pnpm --filter happy-server exec vitest run sources/app/push/pushCopy.test.ts sources/app/api/routes/pushRoutes.spec.ts
pnpm --filter happy-server typecheck
```
Expected: PASS (2 + 13 tests); typecheck clean.

- [ ] **Step 3: Write the failing CLI test**

Replace `packages/happy-cli/src/api/pushNotifications.test.ts` with:

```ts
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/configuration', () => ({ configuration: { currentCliVersion: '9.9.9' } }));
// The real logger opens a log file under configuration.logsDir at import time.
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

import { PushNotificationClient } from './pushNotifications';

type Captured = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };

async function startServer(status = 200) {
    const requests: Captured[] = [];
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            requests.push({ method: req.method, url: req.url, headers: req.headers, body });
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, result: 'sent', tokens: 1 }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

describe('PushNotificationClient.sendSessionNotification', () => {
    let close: (() => Promise<void>) | null = null;
    afterEach(async () => {
        await close?.();
        close = null;
    });

    it('sends only the event kind to the session push-event endpoint', async () => {
        const server = await startServer();
        close = server.close;
        const client = new PushNotificationClient('token-1', server.url);

        await client.sendSessionNotification({ kind: 'permission', sessionId: 'sess/1' });

        expect(server.requests).toHaveLength(1);
        const [request] = server.requests;
        expect(request.method).toBe('POST');
        expect(request.url).toBe('/v1/sessions/sess%2F1/push-event');
        expect(request.headers.authorization).toBe('Bearer token-1');
        expect(request.headers['x-happy-client']).toBe('cli-daemon/9.9.9');
        expect(JSON.parse(request.body)).toEqual({ kind: 'permission' });
    });

    it('never rejects when the server fails', async () => {
        const server = await startServer(500);
        close = server.close;
        const client = new PushNotificationClient('token-1', server.url);
        await expect(client.sendSessionNotification({ kind: 'done', sessionId: 's1' })).resolves.toBeUndefined();
    });
});
```

In `packages/happy-cli/src/claude/utils/permissionHandler.test.ts`, replace the two `expect(sendSessionNotification).toHaveBeenNthCalledWith(…data: expect.objectContaining({ requestId: … })…)` assertions with:

```ts
        expect(sendSessionNotification).toHaveBeenCalledTimes(2);
        expect(sendSessionNotification).toHaveBeenNthCalledWith(1, { kind: 'permission', sessionId: 'happy-session-1' });
        expect(sendSessionNotification).toHaveBeenNthCalledWith(2, { kind: 'permission', sessionId: 'happy-session-1' });
```

Run: `pnpm --filter happy exec vitest run --project unit src/api/pushNotifications.test.ts src/claude/utils/permissionHandler.test.ts`
Expected: FAIL. The client still posts title/body/data, and the handler still passes metadata.

- [ ] **Step 4: Rewrite the CLI push client and update callers**

Replace `packages/happy-cli/src/api/pushNotifications.ts` with:

```ts
import axios from 'axios'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'
import { type AccessTokenSource, resolveAccessToken } from './tokenSource'

export type SessionNotificationKind = 'done' | 'permission' | 'question'

/**
 * Asks the server to notify the user's devices about a session event. Only the
 * kind and the session id leave this machine: the server sends fixed,
 * content-free copy, applies presence suppression, and honors PUSH_ENABLED.
 */
export class PushNotificationClient {
    private readonly tokenSource: AccessTokenSource
    private readonly baseUrl: string

    constructor(token: AccessTokenSource, baseUrl: string) {
        this.tokenSource = token
        this.baseUrl = baseUrl
    }

    private get token(): string {
        return resolveAccessToken(this.tokenSource)
    }

    /** Fire-and-forget: the returned promise never rejects, so callers need not await it. */
    sendSessionNotification(params: { kind: SessionNotificationKind; sessionId: string }): Promise<void> {
        return (async () => {
            try {
                const response = await axios.post<{
                    result?: string
                    tokens?: number
                    delivered?: number
                    reason?: string
                }>(
                    `${this.baseUrl}/v1/sessions/${encodeURIComponent(params.sessionId)}/push-event`,
                    { kind: params.kind },
                    {
                        headers: {
                            'Authorization': `Bearer ${this.token}`,
                            'Content-Type': 'application/json',
                            'X-Happy-Client': `cli-daemon/${configuration.currentCliVersion}`,
                        },
                        timeout: 15000,
                    }
                )
                const { result, tokens, delivered, reason } = response.data ?? {}
                const detail = [
                    tokens !== undefined ? `tokens=${tokens}` : null,
                    delivered !== undefined ? `delivered=${delivered}` : null,
                    reason ? `reason=${reason}` : null,
                ].filter(Boolean).join(' ')
                logger.debug(
                    result
                        ? `[PUSH] sendSessionNotification ${result} (kind=${params.kind})${detail ? ` ${detail}` : ''}`
                        : `[PUSH] sendSessionNotification accepted by server (kind=${params.kind})`
                )
            } catch (error) {
                // Message only: an axios error object carries the Authorization header.
                logger.debug(`[PUSH] sendSessionNotification failed: ${error instanceof Error ? error.message : String(error)}`)
            }
        })()
    }
}
```

Update the five call sites to pass only `{ kind, sessionId }`:
- `src/claude/claudeRemoteLauncher.ts`, AskUserQuestion loop: `session.api.push().sendSessionNotification({ kind: 'question', sessionId: session.client.sessionId });`
- `src/claude/claudeRemoteLauncher.ts`, `onReady`: `session.api.push().sendSessionNotification({ kind: 'done', sessionId: session.client.sessionId });`
- `src/claude/utils/permissionHandler.ts`: `this.session.api.push().sendSessionNotification({ kind: 'permission', sessionId: this.session.client.sessionId });`
- `src/gemini/runGemini.ts`, `sendReady`: `api.push().sendSessionNotification({ kind: 'done', sessionId: session.sessionId });`
- `src/codex/runCodex.ts`, `sendReady`: `api.push().sendSessionNotification({ kind: 'done', sessionId: session.sessionId });`

Each replaces the whole `sendSessionNotification({ kind, metadata, data: {…} })` call. Surrounding `try/catch` blocks stay.

- [ ] **Step 5: Remove `happy notify` and `expo-server-sdk`**

In `packages/happy-cli/src/index.ts`:
- Delete the `} else if (subcommand === 'notify') { … return; }` branch.
- Delete the help line `  happy notify            Send push notification`.
- Delete the whole `handleNotifyCommand` function together with its `/** Handle notification command */` comment.
- Then run `grep -n "readCredentials\|ApiClient" packages/happy-cli/src/index.ts`. If the top-level `import { readCredentials, readSettings } from './persistence'` and `import { ApiClient } from './api/api'` are only used by the deleted code (other uses are dynamic `await import(...)`), drop `readCredentials` from the first import and delete the second.

In `packages/happy-cli/README.md`, delete the table row `| \`happy notify\` | Send push notification to your devices |`.

```bash
cd /home/rophy/projects/happy
grep -rn "expo-server-sdk\|sendToAllDevices\|fetchPushTokens\|getSessionNotification" packages/happy-cli/src   # expect no output
pnpm --version   # must print 10.11.0
pnpm --filter happy remove expo-server-sdk
```

Run the **Lockfile check** from Global Constraints. The expected `<` lines, in any order, are exactly:

```
< err-code@2.0.3
< expo-server-sdk@3.15.0
< promise-retry@2.0.1
< retry@0.12.0
```

The check must also print `lockfile: deletions only`.

- [ ] **Step 6: Document push and run the suites**

In `docs/deployment.md`, add after the Voice bullets (from Task 2):

```
- Push notifications: Expo push, on by default; `PUSH_ENABLED=false` turns it off. Pushes are content-free: a fixed title per event (`It's ready!`, `Permission request`, `Clarification needed`), the body `Open the session to continue.`, and data `{ sessionId, kind, url }`. Client-supplied text is ignored. Delivery to your own app builds needs your EAS project, APNs key and FCM credentials.
```

Run:
```bash
pnpm --filter happy-server test
pnpm --filter happy typecheck
pnpm --filter happy test
```
Expected: all pass, except the known `testDb.test.ts` flake (server) and `scripts/claude_version_utils.test.ts` (CLI).

- [ ] **Step 7: Commit**

```bash
git add packages/happy-server/sources/app/push packages/happy-server/sources/app/api/routes/pushRoutes.ts \
  packages/happy-server/sources/app/api/routes/pushRoutes.spec.ts packages/happy-server/sources/app/api/api.ts \
  packages/happy-cli/src/api/pushNotifications.ts packages/happy-cli/src/api/pushNotifications.test.ts \
  packages/happy-cli/src/claude/claudeRemoteLauncher.ts packages/happy-cli/src/claude/utils/permissionHandler.ts \
  packages/happy-cli/src/claude/utils/permissionHandler.test.ts packages/happy-cli/src/gemini/runGemini.ts \
  packages/happy-cli/src/codex/runCodex.ts packages/happy-cli/src/index.ts packages/happy-cli/README.md \
  packages/happy-cli/package.json pnpm-lock.yaml docs/deployment.md
git commit -m "feat: send content-free push notifications and honor PUSH_ENABLED"
```

---

### Task 7: No upstream default URLs in the CLI and happy-agent; final verification

**Files:**
- Create: `packages/happy-cli/src/serverUrl.ts`
- Test: `packages/happy-cli/src/serverUrl.test.ts`
- Modify: `packages/happy-cli/src/configuration.ts:13-16,52-64`, `packages/happy-cli/src/index.ts`, `packages/happy-cli/src/ui/doctor.ts:35,238`, `packages/happy-cli/README.md:128-129`
- Modify: `packages/happy-agent/src/config.ts`, `src/config.test.ts`, `src/cli-smoke.test.ts`, `src/index.test.ts`, `README.md:157`

**Interfaces:**
- Produces (CLI):
  ```ts
  function missingServerUrlMessage(settingsFile: string): string   // first line starts "HAPPY_SERVER_URL is not set"
  class MissingServerUrlError extends Error
  function commandNeedsServerUrl(args: readonly string[]): boolean
  configuration.serverUrl: string        // getter; throws MissingServerUrlError when unset
  configuration.hasServerUrl: boolean
  configuration.webappUrl: string | null
  ```
- Produces (agent):
  ```ts
  const MISSING_SERVER_URL_MESSAGE: string   // starts "HAPPY_SERVER_URL is not set"
  function loadConfig(): Config              // throws Error(MISSING_SERVER_URL_MESSAGE) when unset/blank
  ```

- [ ] **Step 1: Write the failing CLI test**

```ts
// packages/happy-cli/src/serverUrl.test.ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandNeedsServerUrl, missingServerUrlMessage } from './serverUrl';

describe('commandNeedsServerUrl', () => {
    it.each([
        [[]],
        [['codex']],
        [['auth', 'login']],
        [['auth', 'status']],
        [['daemon', 'start']],
        [['daemon', 'start-sync']],
        [['resume', 'abc']],
        [['connect', 'claude']],
    ])('requires a server for %j', (args) => {
        expect(commandNeedsServerUrl(args)).toBe(true);
    });

    it.each([
        [['--help']],
        [['-h']],
        [['--version']],
        [['-v']],
        [['auth', '--help']],
        [['doctor']],
        [['doctor', 'clean']],
        [['bye']],
        [['daemon']],
        [['daemon', 'status']],
        [['daemon', 'stop']],
        [['daemon', 'list']],
        [['daemon', 'logs']],
    ])('runs %j without a server', (args) => {
        expect(commandNeedsServerUrl(args)).toBe(false);
    });

    it('names HAPPY_SERVER_URL and the settings file', () => {
        const message = missingServerUrlMessage('/home/u/.happy/settings.json');
        expect(message.startsWith('HAPPY_SERVER_URL is not set')).toBe(true);
        expect(message).toContain('/home/u/.happy/settings.json');
    });
});

describe('configuration server URL', () => {
    const savedEnv = { ...process.env };
    let home: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'happy-url-'));
        process.env.HAPPY_HOME_DIR = home;
        delete process.env.HAPPY_SERVER_URL;
        delete process.env.HAPPY_WEBAPP_URL;
        vi.resetModules();
    });

    afterEach(() => {
        process.env = { ...savedEnv };
        rmSync(home, { recursive: true, force: true });
    });

    it('has no built-in default', async () => {
        const { configuration } = await import('./configuration');
        expect(configuration.hasServerUrl).toBe(false);
        expect(configuration.webappUrl).toBeNull();
        expect(() => configuration.serverUrl).toThrow('HAPPY_SERVER_URL is not set');
    });

    it('uses HAPPY_SERVER_URL', async () => {
        process.env.HAPPY_SERVER_URL = 'https://happy.corp.example';
        const { configuration } = await import('./configuration');
        expect(configuration.serverUrl).toBe('https://happy.corp.example');
    });

    it('falls back to serverUrl in settings.json', async () => {
        writeFileSync(join(home, 'settings.json'), JSON.stringify({ serverUrl: 'https://from-settings.corp.example' }));
        const { configuration } = await import('./configuration');
        expect(configuration.serverUrl).toBe('https://from-settings.corp.example');
    });
});

describe('happy without a server URL', () => {
    it('exits with an error naming HAPPY_SERVER_URL instead of contacting a default host', () => {
        const home = mkdtempSync(join(tmpdir(), 'happy-url-cli-'));
        try {
            const entry = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
            const result = spawnSync(process.execPath, ['--no-warnings', entry, 'auth', 'status'], {
                env: { ...process.env, HAPPY_HOME_DIR: home, HAPPY_SERVER_URL: '', HAPPY_WEBAPP_URL: '' },
                encoding: 'utf8',
                timeout: 30_000,
            });
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('HAPPY_SERVER_URL is not set');
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});
```

Run: `pnpm --filter happy exec vitest run --project unit src/serverUrl.test.ts`
Expected: FAIL, `./serverUrl` cannot be resolved.

- [ ] **Step 2: Implement the CLI guard**

```ts
// packages/happy-cli/src/serverUrl.ts
/**
 * This build has no built-in server: without HAPPY_SERVER_URL (or serverUrl in
 * settings.json) the CLI refuses to start instead of contacting an upstream host.
 */
export function missingServerUrlMessage(settingsFile: string): string {
    return [
        `HAPPY_SERVER_URL is not set, and ${settingsFile} has no "serverUrl".`,
        'This build has no default server. Point it at your Happy server, for example:',
        '  export HAPPY_SERVER_URL=https://happy.example.com',
    ].join('\n');
}

export class MissingServerUrlError extends Error {
    constructor(settingsFile: string) {
        super(missingServerUrlMessage(settingsFile));
        this.name = 'MissingServerUrlError';
    }
}

const HELP_OR_VERSION = new Set(['--help', '-h', '--version', '-v']);
const LOCAL_COMMANDS = new Set(['doctor', 'bye']);
const LOCAL_DAEMON_SUBCOMMANDS = new Set(['status', 'stop', 'list', 'stop-session', 'logs', 'uninstall']);

/** False for help/version output and purely local commands; true for everything that talks to the server. */
export function commandNeedsServerUrl(args: readonly string[]): boolean {
    if (args.some((arg) => HELP_OR_VERSION.has(arg))) {
        return false;
    }
    const [subcommand, daemonSubcommand] = args;
    if (subcommand !== undefined && LOCAL_COMMANDS.has(subcommand)) {
        return false;
    }
    if (subcommand === 'daemon' && (daemonSubcommand === undefined || LOCAL_DAEMON_SUBCOMMANDS.has(daemonSubcommand))) {
        return false;
    }
    return true;
}
```

In `packages/happy-cli/src/configuration.ts`:
- Add `import { MissingServerUrlError } from './serverUrl'`.
- Replace the two field declarations `public readonly serverUrl: string` and `public readonly webappUrl: string` with:

```ts
  private readonly configuredServerUrl: string | null
  /** No built-in default. Nothing reads it today; kept for settings compatibility. */
  public readonly webappUrl: string | null
```

- Replace the URL block in the constructor (the comment `// URL precedence (both): …` through the `'https://app.happy.engineering'` line) with:

```ts
    // URL precedence (both): HAPPY_*_URL env > settings.<key>. There is no
    // built-in default: this build must never contact an upstream host.
    // Settings are read sync here (avoid circular import with persistence.ts).
    this.configuredServerUrl =
      process.env.HAPPY_SERVER_URL ||
      readSettingsStringSync(this.settingsFile, 'serverUrl') ||
      null
    this.webappUrl =
      process.env.HAPPY_WEBAPP_URL ||
      readSettingsStringSync(this.settingsFile, 'webappUrl') ||
      null
```

- Add these members to the class, after the constructor:

```ts
  get hasServerUrl(): boolean {
    return this.configuredServerUrl !== null
  }

  get serverUrl(): string {
    if (this.configuredServerUrl === null) {
      throw new MissingServerUrlError(this.settingsFile)
    }
    return this.configuredServerUrl
  }
```

In `packages/happy-cli/src/index.ts`:
- Add the imports `import { configuration } from './configuration'` and `import { commandNeedsServerUrl, missingServerUrlMessage } from './serverUrl'`.
- Directly after `const args = process.argv.slice(2)`, add:

```ts
  // No built-in server: refuse to run anything that talks to one until it is configured.
  if (!configuration.hasServerUrl && commandNeedsServerUrl(args)) {
    console.error(chalk.red('Error:'), missingServerUrlMessage(configuration.settingsFile))
    process.exit(1)
  }
```

In `packages/happy-cli/src/ui/doctor.ts`:
- Change `serverUrl: configuration?.serverUrl,` to `serverUrl: configuration.hasServerUrl ? configuration.serverUrl : null,`.
- Change `` console.log(`Server URL: ${chalk.blue(configuration.serverUrl)}`); `` to:

```ts
    console.log(`Server URL: ${configuration.hasServerUrl ? chalk.blue(configuration.serverUrl) : chalk.red('not set (HAPPY_SERVER_URL)')}`);
```

In `packages/happy-cli/README.md`, change the two env rows to:

```
| `HAPPY_SERVER_URL` | Your Happy server URL. Required: there is no default (or set `serverUrl` in `~/.happy/settings.json`) |
| `HAPPY_WEBAPP_URL` | Your web app URL (no default) |
```

Run:
```bash
grep -rn "cluster-fluster\|happy\.engineering" packages/happy-cli/src   # expect no output
pnpm --filter happy typecheck
pnpm --filter happy exec vitest run --project unit src/serverUrl.test.ts
pnpm --filter happy test
```
Expected: no grep output; typecheck clean; `serverUrl.test.ts` passes (the vitest global setup builds `dist/` first, so the spawn test runs the new code). The full suite passes except `scripts/claude_version_utils.test.ts`.

If another unit test now fails with `HAPPY_SERVER_URL is not set`, it reads the real `configuration`. Mock `@/configuration` in it with an explicit `serverUrl`, as its neighbors (`apiSession.test.ts`, `apiMachine.test.ts`) do. Do not add a default.

- [ ] **Step 3: Write the failing happy-agent tests**

Replace `packages/happy-agent/src/config.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config';

describe('config', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env.HAPPY_SERVER_URL = 'https://happy.corp.example';
        delete process.env.HAPPY_HOME_DIR;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    describe('server URL', () => {
        it('has no built-in default', () => {
            delete process.env.HAPPY_SERVER_URL;
            expect(() => loadConfig()).toThrow('HAPPY_SERVER_URL is not set');
        });

        it('treats a blank HAPPY_SERVER_URL as unset', () => {
            process.env.HAPPY_SERVER_URL = '   ';
            expect(() => loadConfig()).toThrow('HAPPY_SERVER_URL is not set');
        });

        it('uses HAPPY_SERVER_URL without trailing slashes', () => {
            process.env.HAPPY_SERVER_URL = 'https://custom-server.example.com//';
            expect(loadConfig().serverUrl).toBe('https://custom-server.example.com');
        });
    });

    describe('home directory', () => {
        it('uses default home directory', () => {
            expect(loadConfig().homeDir).toBe(join(homedir(), '.happy'));
        });

        it('derives credential path from home directory', () => {
            expect(loadConfig().credentialPath).toBe(join(homedir(), '.happy', 'agent.key'));
        });

        it('overrides home directory with HAPPY_HOME_DIR', () => {
            process.env.HAPPY_HOME_DIR = '/tmp/custom-happy';
            const config = loadConfig();
            expect(config.homeDir).toBe('/tmp/custom-happy');
            expect(config.credentialPath).toBe('/tmp/custom-happy/agent.key');
        });

        it('expands a leading ~ in HAPPY_HOME_DIR, same as happy-cli', () => {
            process.env.HAPPY_HOME_DIR = '~/custom-happy';
            const config = loadConfig();
            expect(config.homeDir).toBe(join(homedir(), 'custom-happy'));
            expect(config.credentialPath).toBe(join(homedir(), 'custom-happy', 'agent.key'));
        });

        it('expands a bare ~ in HAPPY_HOME_DIR', () => {
            process.env.HAPPY_HOME_DIR = '~';
            expect(loadConfig().homeDir).toBe(homedir());
        });
    });
});
```

In `packages/happy-agent/src/cli-smoke.test.ts`:
- In `runCli`, change the env to `{ ...process.env, HAPPY_HOME_DIR: '/tmp/nonexistent-happy-acceptance', HAPPY_SERVER_URL: 'http://127.0.0.1:9' }`.
- Replace the test `it('config loads with correct defaults', …)` with:

```ts
    it('config requires HAPPY_SERVER_URL and defaults the home directory', () => {
        const origUrl = process.env.HAPPY_SERVER_URL;
        const origHome = process.env.HAPPY_HOME_DIR;
        delete process.env.HAPPY_HOME_DIR;

        try {
            delete process.env.HAPPY_SERVER_URL;
            expect(() => loadConfig()).toThrow('HAPPY_SERVER_URL is not set');

            process.env.HAPPY_SERVER_URL = 'https://happy.corp.example';
            const config = loadConfig();
            expect(config.serverUrl).toBe('https://happy.corp.example');
            expect(config.homeDir).toContain('.happy');
            expect(config.credentialPath).toContain('agent.key');
        } finally {
            if (origUrl !== undefined) process.env.HAPPY_SERVER_URL = origUrl;
            else delete process.env.HAPPY_SERVER_URL;
            if (origHome !== undefined) process.env.HAPPY_HOME_DIR = origHome;
        }
    });
```

In `packages/happy-agent/src/index.test.ts`:
- In `runCli`, change the env to `{ ...process.env, HAPPY_HOME_DIR: '/tmp/nonexistent-happy-test', HAPPY_SERVER_URL: 'http://127.0.0.1:9' }`. Port 9 is never contacted, because every command under test fails on missing credentials first.
- Add inside `describe('happy-agent CLI', …)`:

```ts
    it('exits with an error naming HAPPY_SERVER_URL when it is not set', () => {
        let stderr = '';
        let status = 0;
        try {
            execFileSync(process.execPath, ['--no-warnings', '--no-deprecation', binPath, 'list'], {
                encoding: 'utf-8',
                env: { ...process.env, HAPPY_HOME_DIR: '/tmp/nonexistent-happy-test', HAPPY_SERVER_URL: '' },
            });
        } catch (err: unknown) {
            const e = err as { stderr?: string; status?: number };
            stderr = e.stderr ?? '';
            status = e.status ?? 1;
        }
        expect(status).not.toBe(0);
        expect(stderr).toContain('HAPPY_SERVER_URL is not set');
    });
```

Run: `pnpm --filter happy-agent exec vitest run src/config.test.ts`
Expected: FAIL. `loadConfig()` still falls back to the upstream URL.

- [ ] **Step 4: Implement the agent rule**

Replace `loadConfig` in `packages/happy-agent/src/config.ts`. Keep the `Config` type and imports.

```ts
export const MISSING_SERVER_URL_MESSAGE =
    'HAPPY_SERVER_URL is not set. This build has no default server; point it at your Happy server, ' +
    'for example: export HAPPY_SERVER_URL=https://happy.example.com';

export function loadConfig(): Config {
    const rawServerUrl = process.env.HAPPY_SERVER_URL?.trim();
    if (!rawServerUrl) {
        throw new Error(MISSING_SERVER_URL_MESSAGE);
    }
    const serverUrl = rawServerUrl.replace(/\/+$/, '');
    // Expand a leading `~` the same way happy-cli's `configuration.ts` does, so
    // `HAPPY_HOME_DIR=~/x` resolves to the same `agent.key` path in both.
    const homeDir = process.env.HAPPY_HOME_DIR
        ? process.env.HAPPY_HOME_DIR.replace(/^~/, homedir())
        : join(homedir(), '.happy');
    const credentialPath = join(homeDir, 'agent.key');
    return { serverUrl, homeDir, credentialPath };
}
```

In `packages/happy-agent/README.md`, change the line `` - `HAPPY_SERVER_URL` - API server URL (default: `https://api.cluster-fluster.com`) `` to:

```
- `HAPPY_SERVER_URL` - Your Happy server URL. Required: there is no default.
```

Run:
```bash
grep -rn "cluster-fluster\|happy\.engineering" packages/happy-agent/src packages/happy-agent/README.md   # expect no output
pnpm --filter happy-agent typecheck
pnpm --filter happy-agent test
```
Expected: no grep output; typecheck clean; all tests pass. `test` builds `dist/` first, which the smoke and index tests run.

- [ ] **Step 5: Confirm environments and integration suites still get a URL**

```bash
cd /home/rophy/projects/happy
grep -n "HAPPY_SERVER_URL" environments/environments.ts packages/happy-cli/src/testing/integrationEnvironment.ts packages/happy-agent/src/happy-agent.integration.test.ts
```

Expected output includes:
- `environments.ts` `buildEnvVars` → `HAPPY_SERVER_URL: \`http://localhost:${serverPort}\``, plus its `env.sh` export;
- `integrationEnvironment.ts` `applyEnvironmentToProcess` → `process.env.HAPPY_SERVER_URL = …`;
- the agent integration env → `HAPPY_SERVER_URL: …`.

No change is needed. Then exercise them, with the IdP from compose project `happy` only:

```bash
docker compose up -d oidc-mock
pnpm --filter happy-agent test:integration
pnpm --filter happy exec vitest run --project integration-authenticated src/daemon/daemon.integration.test.ts
docker compose stop oidc-mock
```

Expected: the environment is seeded through `happy auth login` (log shows "Signed in as alice") and both suites pass. If a failure is unrelated to URLs or auth (e.g. a missing agent binary), record the exact failure and confirm the seeding itself succeeded.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-cli/src/serverUrl.ts packages/happy-cli/src/serverUrl.test.ts packages/happy-cli/src/configuration.ts \
  packages/happy-cli/src/index.ts packages/happy-cli/src/ui/doctor.ts packages/happy-cli/README.md \
  packages/happy-agent/src/config.ts packages/happy-agent/src/config.test.ts packages/happy-agent/src/cli-smoke.test.ts \
  packages/happy-agent/src/index.test.ts packages/happy-agent/README.md
git commit -m "feat: require HAPPY_SERVER_URL instead of defaulting to upstream hosts"
```

- [ ] **Step 7: Final verification across the branch**

```bash
cd /home/rophy/projects/happy
pnpm --filter @slopus/happy-wire build
pnpm --filter happy-server typecheck && pnpm --filter happy-server test
pnpm --filter happy-app typecheck && pnpm --filter happy-app exec vitest run
pnpm --filter happy typecheck && pnpm --filter happy test
pnpm --filter happy-agent typecheck && pnpm --filter happy-agent test
AUTH_REFRESH_REUSE_GRACE=0s AUTH_ACCESS_TOKEN_TTL=3m docker compose --profile e2e up -d --build
(cd e2e && npx playwright test)
docker compose --profile e2e down
```

Expected: everything passes except the three known pre-existing failures listed in Global Constraints.

Leftover check:
```bash
grep -rniE "revenuecat|react-native-purchases|presentPaywall|REVENUECAT_API_KEY|sendToAllDevices|expo-server-sdk|voiceUpsell|cluster-fluster\.com|app\.happy\.engineering" \
  packages/happy-server/sources packages/happy-app/sources packages/happy-app/expoConfig.cjs packages/happy-app/package.json \
  packages/happy-cli/src packages/happy-cli/package.json packages/happy-agent/src Dockerfile.webapp docker-compose.yaml \
  | grep -v "\.test\.ts\|\.spec\.ts"
```

Expected: no output. Test files are filtered out on purpose: `appConfig.test.ts` lists upstream identifiers to assert their absence, and `apiAttachments.test.ts` / `attachmentDiagnostics.test.ts` use the upstream hostname only as sample data. Any other hit is a miss: fix it and commit it under the task it belongs to.

Combined lockfile check against the branch start:

```bash
lockkeys() { awk '/^packages:/{p=1;next} /^snapshots:/{p=0} p && /^  [^ ]/' | sed -e 's/^  //' -e 's/:$//' -e "s/'//g" | sort; }
LOCKCHK=$(mktemp -d)
git show 37cf6ef0:pnpm-lock.yaml | lockkeys > "$LOCKCHK/before.txt"
lockkeys < pnpm-lock.yaml > "$LOCKCHK/after.txt"
diff "$LOCKCHK/before.txt" "$LOCKCHK/after.txt" | grep -E '^[<>]'
git diff -U0 37cf6ef0 -- pnpm-lock.yaml | grep -E '^\+[^+]' || echo "lockfile: deletions only"
```

Expected: exactly the nine `<` entries from Tasks 3 and 6, and `lockfile: deletions only`. Report this set in the final summary.

No commit unless a fix was needed.

---

## Self-Review

**Spec coverage ("### Third-party integrations"):**
- "Off unless explicitly configured" → Task 1 (server registration + `/v1/features`), Task 4 (app hiding), Task 5 (PostHog), Task 7 (CLI/agent URLs).
- RevenueCat removed entirely:
  - app SDKs, paywall UI, purchases state → Task 3;
  - server subscription checks → Task 2;
  - paywall tracking events → Task 3;
  - deploy secret → Task 2.
- Voice routes registered only with `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` → Task 1 (`integrationRoutes`).
- Voice agent id is server configuration → Task 2.
- Voice available to every user → Task 2 (no subscription) + Task 3 (no paywall).
- Optional `VOICE_MONTHLY_LIMIT_MINUTES` → Tasks 1–2.
- GitHub routes registered only when the OAuth settings are present, callback returns to `WEBAPP_URL` → Task 1.
- PostHog only with `EXPO_PUBLIC_POSTHOG_API_KEY`, `EXPO_PUBLIC_POSTHOG_HOST` for self-hosted, analytics row hidden otherwise → Tasks 4–5.
- Claude.ai connect hidden unless `EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT=1` → Task 4, with an e2e check in Task 5.
- `GET /v1/features` (authenticated) `{voice, githubConnect, push}` → Task 1. The app reads it after sign-in and hides the mic, GitHub connect and push registration → Task 4.
- Push content-free:
  - fixed title per kind, generic body, data `{sessionId, kind, url}`, server ignores client text → Task 6;
  - CLI stops sending summaries/paths → Task 6;
  - `PUSH_ENABLED=false` → Tasks 1 (flag) + 6 (enforced);
  - corporate EAS/APNs/FCM requirement documented → Task 5 (`docs/deploy-app.md`) + Task 6 (`docs/deployment.md`).
- CLI has no built-in server or web app URL, exits with an error → Task 7. happy-agent follows the same rule → Task 7.
- Out of scope per spec: static upstream links in the app (privacy, terms, community, docs) and the CLI co-author trailer. Untouched.

**Requirement coverage (task brief):**
- Lockfile deletions only, with package@version sets → Tasks 3, 6, 7.
- `docs/deploy-app.md` → Task 5.
- CLI fallback paths consistent (`sendToAllDevices`, `expo-server-sdk`) → Task 6.
- Tests and environments set the URL → Task 7, Steps 3 and 5.
- Web e2e step → Task 5, Step 5 and Task 7, Step 7.

**Placeholder scan:** none. Every code step has complete code. Deletions name the exact symbols or lines. The one conditional instruction (dropping `readCredentials`/`ApiClient` imports in Task 6) gives the grep to run and the rule to apply.

**Type consistency:**
- `VoiceConfig`, `GithubOAuthConfig`, `FeaturesConfig`, `PublicFeatures` are defined in Task 1 and used unchanged in Tasks 2 and 6 (`features.pushEnabled`).
- `voiceRoutes(app)` (Task 1) becomes `voiceRoutes(app, features.voice)` (Task 2); `integrationRoutes` is the only caller.
- `ServerFeatures` = wire `FeaturesResponse` (Task 1) is used by `apiFeatures.ts`, `storage.features` and `useServerFeature` (Task 4).
- `AppConfig.postHogKey/postHogHost/enableClaudeConnect` are added in Task 4 and consumed in Task 5 (`tracking.ts`) and Task 4 (`SettingsView`, `claude.tsx`, `dev/index.tsx`).
- `buildSessionEventPush` / `SessionEventKind` are shared by `pushRoutes` and `pushDispatch` (Task 6).
- `sendSessionNotification({ kind, sessionId })` matches all five call sites and both tests (Task 6).
- `configuration.serverUrl` stays a `string` getter, so existing call sites and the test mocks that stub it as a plain property still type-check (Task 7).
