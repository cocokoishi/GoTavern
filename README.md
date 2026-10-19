# GoTavern

GoTavern is a work-in-progress **standalone Go reimplementation of the SillyTavern server/backend**. The goal is to run the unmodified upstream SillyTavern frontend with the same data, browser URLs and frontend-extension ecosystem while using substantially less server memory and requiring no Node.js runtime in production.

## Status

**Pre-release. Do not use this repository as a working SillyTavern replacement yet.** The Phase 0 asset/oracle foundation is in place and Phase 1 is underway. `gotavern` and `gotavern start` now run command-line/config resolution, ordered data startup, protocol selection, and the HTTP/HTTPS listener path. Pinned Node probes cover the root page, generated `lib.js`, `/version`, the final 404, IP and host whitelists, global and per-user Basic Auth responses/rate limiting, and per-user session auto-login. Account login/session behavior and both Basic Auth modes are partially implemented. Most SillyTavern routes and shared middleware remain absent.

The initial compatibility baseline is:

```text
SillyTavern 1.19.0
06bde939fb1e9c4c8d8641d810f0a916b5bce127
```

Implementation must satisfy the compatibility gates in [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`docs/SEMANTIC-COMPATIBILITY.md`](docs/SEMANTIC-COMPATIBILITY.md). A server that merely opens the UI or returns chat text is not considered compatible.

The exact pinned upstream `public/**` and `default/**` trees are under [`upstream/`](upstream/), with per-file SHA-256 manifests. The root `LICENSE` is copied from the pinned SillyTavern source. Inventory generation and the isolated generated-library build are documented in the tooling under [`tools/`](tools/).

## Intended user experience

Stable releases will be consumed as **prebuilt binaries**. End users should not need Go, Node.js, npm or a compiler.

Planned installation paths:

- `install.sh` on Linux/macOS;
- `install.ps1` on Windows;
- manual GitHub Release archives;
- a multi-architecture container image.

The installer scripts are already present to define the release contract, but there is currently no published GoTavern Release for them to download. They intentionally fail instead of compiling source when no release exists.

See [`docs/INSTALLATION.md`](docs/INSTALLATION.md).

## Compatibility target

GoTavern keeps SillyTavern's frontend and data model rather than designing substitutes:

- pinned upstream `public/**` frontend, unchanged;
- pinned upstream default content/scaffold for fresh installs;
- same HTTP routes, auth, CSRF, uploads, redirects, errors and streaming semantics;
- same `config.yaml` behavior, including upstream startup migrations/default insertion;
- same data-root layout and file formats;
- same characters/cards, chats, groups, world info, presets/templates, Quick Replies, settings and secrets;
- equivalent provider requests for complex prompt/preset workflows;
- frontend extension installation/loading/update and runtime compatibility;
- read-only copy migration from existing SillyTavern installs plus direct-use mode;
- ability to return to a data-compatible SillyTavern baseline without data conversion.

Arbitrary **Node.js server plugins** are the explicit ecosystem exception.

## Compatibility validation

The project uses the pinned Node SillyTavern server as an oracle and compares more than response JSON:

1. browser -> backend contract;
2. backend -> model-provider wire request;
3. provider stream/error -> browser behavior;
4. filesystem/startup side effects and browser event/final state.

Real pinned extension probes include Tavern Helper / JS-Slash-Runner and the standard-SillyTavern-API portion of LittleWhiteBox. See [`docs/extension-route-coverage.md`](docs/extension-route-coverage.md).

## Development

Read [`AGENTS.md`](AGENTS.md) before making implementation changes. Phase 0 inventory/differential infrastructure is mandatory before broad endpoint implementation.

Production runtime must not depend on Node.js. Node/npm may be used in CI/development to run the pinned reference server and reproduce upstream-generated frontend assets.

## License

GoTavern is intended to be released under **AGPL-3.0**, consistent with its use of the SillyTavern frontend. The repository must include the complete license/notices before the first distributable release.
