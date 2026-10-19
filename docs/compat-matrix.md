# Compatibility matrix

Pinned oracle: SillyTavern `1.19.0`, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.

Status meanings follow `ARCHITECTURE.md`: `compatible` means no known material difference across tested surfaces; `partial` means a specific known gap; `unsupported` is a deliberate exclusion; `not implemented` means absent. An inventoried contract or matching asset does not establish runtime compatibility.

| Area | Status | Evidence | Remaining work |
|---|---|---|---|
| Pinned upstream `public/**` source bytes | partial | Vendored from the pinned Git tree; `upstream/manifests/public.sha256` records each file. | Go HTTP static serving, MIME/cache/header behavior, and extension ABI tests. |
| Pinned upstream `default/**` files | partial | Vendored from the pinned Git tree; `upstream/manifests/default.sha256` records each file. | Fresh-install seeding, precedence, backups, and Node-vs-Go filesystem comparison. |
| Generated frontend `lib.js` | partial | Built with pinned upstream Webpack in an isolated checkout; `upstream/generated/build-info.json` records the toolchain and output digest. | Serve from Go and compare browser behavior with the Node baseline. |
| Build identity CLI | partial | `gotavern version` reports GoTavern identity and the pinned SillyTavern baseline. | Release version injection and build metadata/report integration. |
| Asset manifest verification | partial | `gotavern assets verify` and Go tests verify embedded file hashes and tree membership. | CI enforcement and release-archive verification. |
| HTTP routes, auth, CSRF, middleware, redirects, error responses | not implemented | Source inventory generated in `docs/api-inventory.md`. | Implement and differentially probe each route and middleware contract. |
| Startup, config, account state, default seeding | not implemented | Source inventories in `docs/startup-inventory.md`, `docs/config-inventory.md`, and `docs/data-layout.md`. | Node reference fixtures, ordered Go startup chain, side-effect comparisons. |
| Persistent data read/write compatibility | not implemented | Path templates inventoried in `docs/data-layout.md`; upstream assets are pinned. | Storage modules, atomic writes, and Node→Go→Node round trips. |
| Providers, tokenization, streaming, cancellation | not implemented | Torture plan in `docs/SEMANTIC-COMPATIBILITY.md`. | Provider-wire recorder, exact tokenizer boundaries, and differential suites. |
| Frontend extensions (including pinned canaries) | not implemented | Static probe revisions and route observations in `docs/extension-route-coverage.md`. | Extension static serving/management and deep browser/provider E2E. |
| Arbitrary Node server plugins | unsupported | Explicit project boundary in `AGENTS.md` and `ARCHITECTURE.md`. | Report plugin-dependent features during migration; do not emulate plugin APIs. |
| Installer, migration, release archives, Docker | partial | Installer/launcher contracts and migration helper exist. | Prebuilt releases, checksum assets, Go migration, real fresh/migration/update/rollback qualification. |

No item in this matrix currently establishes a drop-in-compatible server release.
