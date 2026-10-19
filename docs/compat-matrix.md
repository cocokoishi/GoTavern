# Compatibility matrix

Pinned oracle: SillyTavern `1.19.0`, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.

Status meanings follow `ARCHITECTURE.md`: `compatible` means no known material difference across tested surfaces; `partial` means a specific known gap; `unsupported` is a deliberate exclusion; `not implemented` means absent. An inventoried contract or matching asset does not establish runtime compatibility.

| Area | Status | Evidence | Remaining work |
|---|---|---|---|
| Pinned upstream `public/**` source bytes | partial | Vendored from the pinned Git tree; `upstream/manifests/public.sha256` records each file. The embedded handler serves the root page and static assets. | MIME/cache/header parity, per-user CSS, middleware/auth behavior, and extension ABI tests. |
| Pinned upstream `default/**` files | partial | Vendored from the pinned Git tree; `upstream/manifests/default.sha256` records each file. Fresh-install content seeding and logs are compared with the pinned Node startup fixture. | Remaining default-content update/backup cases and full startup ordering. |
| Generated frontend `lib.js` | partial | Built with pinned upstream Webpack in an isolated checkout and served from the embedded handler; its HTTP body digest matches the pinned fresh-start oracle. | Match remaining middleware headers/cache behavior and compare browser behavior with the Node baseline. |
| Build identity CLI | partial | `gotavern version` reports GoTavern identity and the pinned SillyTavern baseline. | Release version injection and build metadata/report integration. |
| Asset manifest verification | partial | `gotavern assets verify` and Go tests verify embedded file hashes and tree membership. | CI enforcement and release-archive verification. |
| Pinned Node fresh-start oracle | partial | Go tests compare `/`, `/version`, `/lib.js`, the default-user account record, pinned public/per-user directories, and seeded content bytes/logs against `tests/oracle/sillytavern-1.19.0-fresh-start.json`. | Compare remaining HTTP headers and startup filesystem state. Browser events and provider wire are not part of this startup-only probe. |
| HTTP routes, auth, CSRF, middleware, redirects, error responses | not implemented | Source inventory generated in `docs/api-inventory.md`. | Implement and differentially probe each route and middleware contract. |
| Startup, config, account state, default seeding | partial | `internal/configinit` matches pinned fresh and migrated config bytes. `internal/startup` matches the `node-persist@4.0.4` default-user record, public/per-user directory template, fresh-install seeded content/logs, `getCookieSecret()` behavior, filesystem effects for startup migrations, `verifySecuritySettings()` warning/exit decisions, and `DiskCache.verify()` cache-directory/record observations. | Wire config and startup components into CLI path resolution; capture and implement the remaining startup ordering, cache failure cases, and migrations. |
| Persistent data read/write compatibility | partial | Node→Go→Node probes confirm existing user/avatar records survive unchanged and Node reads the Go-created default-user record; seeded content uses pinned bytes and content logs. | Add round trips for account mutations and implement remaining persistent data families with atomic writes. |
| Providers, tokenization, streaming, cancellation | not implemented | Torture plan in `docs/SEMANTIC-COMPATIBILITY.md`. | Provider-wire recorder, exact tokenizer boundaries, and differential suites. |
| Frontend extensions (including pinned canaries) | not implemented | Static probe revisions and route observations in `docs/extension-route-coverage.md`. | Extension static serving/management and deep browser/provider E2E. |
| Arbitrary Node server plugins | unsupported | Explicit project boundary in `AGENTS.md` and `ARCHITECTURE.md`. | Report plugin-dependent features during migration; do not emulate plugin APIs. |
| Installer, migration, release archives, Docker | partial | Installer/launcher contracts and migration helper exist. | Prebuilt releases, checksum assets, Go migration, real fresh/migration/update/rollback qualification. |

No item in this matrix currently establishes a drop-in-compatible server release.
