# npm releases

Two packages are published to the public npm registry under the `@happycc` organization:

| Package | Command | Workflow | Tag |
|---|---|---|---|
| `@happycc/cli` | `happycc` | `.github/workflows/release-happy-cli.yml` | `cli/X.Y.Z` |
| `@happycc/agent` | `happycc-agent` | `.github/workflows/release-happy-agent.yml` | `agent/X.Y.Z` |

`@slopus/happy-wire` is bundled into both and is not published. The server, web app and mobile
apps are not published to npm: each organization builds them with its own app config (see
`deploy-app.md`, `deployment.md`).

Versions are this fork's own, starting at 0.1.0, and do not follow upstream's. The app gates
features on the CLI version a session reports (`MINIMUM_CLI_VERSION`, `CLI_VERSION_WITH_AUTO`,
any `sinceCliVersion`): when an upstream merge adds such a gate, change its version to the
`@happycc/cli` release that first ships the feature.

The published CLI has no default server. Users set `HAPPY_SERVER_URL` or `serverUrl` in
`~/.happycc/settings.json`.

## Releasing

1. Bump `version` in the package's `package.json` in a normal commit (`X.Y.Z` for npm's `latest`,
   `X.Y.Z-beta.N` for `beta`). It must be newer than the current `latest`.
2. When the commit reaches `main`, the package's workflow sees a version that has no tag and is not on
   npm. It tests and builds the package, smoke-tests the packed tarball in a clean install, stages
   that exact tarball on npm with provenance (`npm stage publish`, trusted publishing), and pushes the
   `cli/X.Y.Z` or `agent/X.Y.Z` tag. The workflow never commits.
3. The staged version is not installable yet. A maintainer checks it against the integrity shown in
   the workflow run's summary, then approves it with 2FA: on npmjs.com, or with
   `npm stage list <package>` and `npm stage approve <stage-id>`. `npm stage reject <stage-id>` drops it;
   to stage again, bump the version (or delete the tag).

Pushes that do not change the version do nothing: the tag or the npm version already exists.

## First publish of a package

npm only lets a package that already exists name a trusted publisher, so the first version of
each package is published by hand:

```bash
npm login --auth-type=web
pnpm --filter @slopus/happy-wire build
pnpm --filter @happycc/cli run prepublishOnly        # or @happycc/agent
pnpm --filter @happycc/cli pack --pack-destination /tmp/release
npm publish /tmp/release/happycc-cli-0.1.0.tgz --access public
```

Then, on npmjs.com, open the package's Settings, Trusted Publisher: GitHub Actions, repository
`rophy/happycc`, the workflow file name above, environment `npm`. Later versions are released
from the workflow. In GitHub, the repository needs an environment named `npm`.
