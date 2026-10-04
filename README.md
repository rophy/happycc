# Happy Corporate Coder (happycc)

An unofficial fork of [Happy Coder](https://github.com/slopus/happy) for organizations.

## How it differs from Happy Coder

- **Central sign-in.** Users sign in with the organization's identity provider, not QR pairing.
- **Self-hosted.** The organization runs the server and builds the apps; nothing calls upstream.
- **Server-managed keys.** The organization's server holds the encryption keys, not end-to-end.
- **Policy-controlled features.** Remote capabilities are kept minimal and can be limited to fit
  corporate policy.

## Getting started

- Operators: [server](docs/deployment.md), [apps](docs/deploy-app.md), [releases](docs/npm-release.md)
- Developers: `npm install -g @happycc/cli`, then run `happycc` where you'd run `claude`
- [Roadmap](docs/happycc-roadmap.md) · [Contributing](docs/CONTRIBUTING.md)

MIT, as upstream. See [LICENSE](LICENSE).
