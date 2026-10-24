# Pinned Node oracle fixture

`sillytavern-1.19.0-fresh-start.json` is produced by starting the exact pinned Node server in a temporary clone with an empty config and data root. The probe records the root page, `/version`, generated `/lib.js`, the resulting data-root path/size/hash inventory, parsed `user:*` records with only the generated `created` timestamp normalized, and the actual pinned public/per-user directory paths.

Regenerate the Webpack asset, inventories, and fresh-start oracle from a clean pinned checkout with:

```sh
node tools/build-generated-lib.mjs /path/to/SillyTavern-at-06bde939
```

The tool clones from that local checkout, installs the pinned package lock in a temporary clone, and deletes the temporary clone and runtime directories after recording observations. It does not install dependencies into or write to the supplied checkout.

## Which probe owns a fixture, and which change re-records it

Ownership is a DECLARATION, not a filename convention: the line
`// @gotavern-oracle: fixture=<name> label="<label>" [args=...] [sharedWrite=true]` in the probe that
writes the fixture. `tools/oracle/manifest.mjs` parses those declarations exactly as
`tools/build-generated-lib.mjs` does, and derives per declaration what the probe actually reads: its own
script, `tools/lib/` when it imports the harness, `tests/provider-wire/scenarios/` when it reads them,
every `tools/<helper>/` directory it references (`go run ./tools/image-metadata-roundtrip` and friends),
and a `go-product` edge when it drives the GoTavern binary or a repository Go helper. A declaration may
add `inputs=a,b`, which REPLACES the derivation for that probe and must still name its own script.

`node tools/oracle/manifest.mjs --validate` refuses a tree in which a committed fixture has no owner
(unless it is explicitly classified `external` or `generated`), a declaration names a missing script or
fixture, a fixture has two writers that are not declared in `SHARED_FIXTURES`, or a `probe-*.mjs` declares
nothing. `--dump` prints the whole graph for review.

`tools/oracle/plan.mjs` is the only thing that decides which probes re-record for a change:

```sh
node tools/oracle/plan.mjs --run-type push --changed changed-files.txt
# {"recordPinned":true,"full":false,"probes":["probe-heartbeat.mjs"],"stabilityMode":"single",...}
```

It fails closed. `recordPinned: false` (no oracle run at all) is possible only when every changed path is
on its explicit irrelevant list (`docs/**`, workflow files other than `ci.yml`/`lane.yml`,
`tests/browser/**`, fixture documentation and tests, the planner itself, `scripts/**`, top-level markdown,
`LICENSE`). A change to `ci.yml`/`lane.yml` or to the probe execution primitive is a FULL sweep instead:
a change to the gate that selects work is not evidence that the selection is right, so it is proven against
the real corpus. `internal/**` and `cmd/**` select the probes that record Go output rather than skipping
the job; a path nothing declares forces a full sweep and the reason says `unresolved dependency: <path>`.
`tests/oracle/plan.test.mjs` is the gate on both files: `node --test "tests/oracle/*.test.mjs"`.

**The residual risk, stated rather than papered over:** a Go change that moves a fixture through a
dependency the derivation cannot see (a package a helper imports in a way the text does not show, a new
input directory) cannot be attributed per push, so it is caught only by the nightly full sweep.

The fresh-start fixture is a Node oracle capture. Go tests compare `/`, `/version`, `/lib.js`, the initial account-store record, the pinned public/per-user directory template, and the seeded content paths/bytes/content logs. `TestInitializeDataStartupMatchesPinnedNodeFreshStartInventory` compares the complete `dataRoot` inventory produced by the Go startup coordinator, including the cookie secret, account store, uploads staging, settings backup, statistics, system-prompt marker, and seeded files. It excludes only `_webpack`, which is produced by the separate Node Webpack middleware compiler. The `seededContent` projection excludes the stats file, settings backup, and `.migrated` marker because the whole-tree comparison covers them. Provider and browser-event observers are explicitly marked unobserved for this startup-only scenario. Nondeterministic fields are listed in the fixture and normalized only there.

`sillytavern-1.19.0-config-init.json` captures pinned `addMissingConfigValues()` output for a missing config, a legacy YAML config with unknown fields, and a deprecated environment variable. It stores exact output YAML so Go config initialization can compare startup writes byte-for-byte.

`sillytavern-1.19.0-commandline-paths.json` captures pinned `CommandLineParser` standalone/global config and data-root selection, config initialization, data-root creation or warning behavior, every returned server option, config-derived pre-listener startup settings, and the derived listen/browser URL helper results. Scenarios cover CLI flags, config values (including per-type thumbnail dimensions), `SILLYTAVERN_*` overrides, deprecated browser-launch aliases, invalid protocol fallbacks, ignored global path arguments, and forced global mode. Global paths are normalized under a fixture root; `env-paths@3.0.0` OS-specific directory layout is checked separately against the pinned package behavior.

`sillytavern-1.19.0-user-storage-roundtrip.json` is produced with the pinned `node-persist@4.0.4` package and Go. It checks Node-written user/avatar records survive Go initialization byte-for-byte and remain readable by Node, then checks Node can read Go-created default-user and avatar records, observe a Go-removed user record, read a Go password update with unknown account fields intact, and read an account created through the Go `/api/users/create` route while the original Node-written admin record remains byte-identical. The asset/oracle rebuild job requires both Node and Go for this round-trip probe.

`sillytavern-1.19.0-account-mutations.json` captures pinned private account name, avatar, and password mutation routes, including authorization and validation errors, password hashing, session version refresh, stale-session invalidation, and Node-persist readback.

`sillytavern-1.19.0-account-admin.json` captures pinned admin account listing, self/default-user protections, enable/disable and promote/demote updates, deletion with and without data-directory purge, and the resulting account store and list. The large admin-list response includes pinned Express gzip headers; Go tests compare its body and route headers while leaving the known compression middleware gap visible.

`sillytavern-1.19.0-account-create.json` captures admin account creation and slugification, including lodash transliteration/coercion cases, duplicate normalized handles, password and passwordless records, node-persist shape, complete user-directory creation, global defaults, and every seeded user-content file digest.

`sillytavern-1.19.0-account-reset-settings.json` captures protected and passwordless settings resets, authentication and password errors, repeated resets, forced default-settings reseeding when normal content checks are disabled, exact per-user tree/file digests, shared content-log effects, and unchanged account records. The oracle pins unrelated startup state for deterministic filesystem comparisons.

`sillytavern-1.19.0-account-data-reset.json` captures authenticated reset-code issuance and replacement, protected/passwordless code validation, per-IP attempt throttling and lockout, complete user-directory removal/recreation, default-content reseeding, global content state, and unchanged account records. Startup settings-backup names and stats timestamps are normalized for deterministic trees.

`sillytavern-1.19.0-account-backup.json` captures full-account ZIP backups for admin and passwordless self-service accounts, authorization/configuration errors, hidden files and empty directories, default secret exclusions and the `allowKeysExposure` override, archive entry paths and file digests, and unchanged source trees/account records.

`sillytavern-1.19.0-settings-snapshots.json` captures authenticated settings snapshot listing, loading, creation, and restoration; user-prefix checks; path separator rejection; retention; missing source/settings cases; restored file bytes; and normalized change times. Its round trip verifies that Node reads a Go-created snapshot and Go restores a Node-created snapshot.

`sillytavern-1.19.0-settings-get.json` captures the authenticated `/api/settings/get` aggregate, including raw settings text, provider preset file contents and names, sorted world names, parsed theme/UI/Quick Reply/instruct/context/system/reasoning presets, request-compression configuration, missing-settings errors, and unchanged user/account files. It retains pinned gzip/chunked response headers so Go tests can isolate the known response-compression difference.

`sillytavern-1.19.0-settings-save.json` captures authenticated `/api/settings/save` responses, JavaScript's four-space JSON serialization including integer-key ordering, exponent and negative-zero normalization, atomic settings bytes, the immediate autosnapshot, a second save inside the ten-minute throttle window, and unchanged account data. Its round trip sends a settings save through GoTavern and reads it back through the pinned Node `/api/settings/get` route.

`sillytavern-1.19.0-quick-replies.json` captures authenticated Quick Replies save/delete responses, JavaScript JSON formatting, filename coercion and sanitization, Unicode truncation, deprecated method-preserving redirects, overwrite/removal file states, and unchanged account data. Its round trip writes through GoTavern and reads the preset through pinned Node `/api/settings/get`.

`sillytavern-1.19.0-themes.json` captures authenticated theme save/delete responses, JSON formatting, filename coercion and sanitization, Unicode truncation, the legacy save redirect, overwrite/removal state including the missing-file 404, unchanged account data, and a Go-to-Node theme readback through `/api/settings/get`.

`sillytavern-1.19.0-moving-ui.json` captures authenticated moving UI preset saves, JSON formatting, filename coercion and sanitization, Unicode truncation, the legacy save redirect, overwrite state, unchanged account data, and a Go-to-Node readback through `/api/settings/get`.

`sillytavern-1.19.0-avatars-get.json` captures authenticated user-avatar listing responses, MIME-based image filtering, locale collation, hidden-file and directory behavior, unchanged avatar files/account data, and the legacy 308 redirect.

`sillytavern-1.19.0-avatars-delete.json` captures authenticated/CSRF-protected persona-avatar deletion, filename validation/sanitization, thumbnail invalidation, 404 and legacy 308 responses, file/account state after each operation, and a Go deletion read back by the pinned Node /api/avatars/get route.

`sillytavern-1.19.0-sprites-get.json` captures authenticated Expressions sprite listing, MIME-based filtering, labels and modification-time paths, character subfolders, missing and invalid paths, and unchanged character/account data.

`sillytavern-1.19.0-sprites-delete.json` captures authenticated and CSRF-protected Expressions sprite deletion, exact basename matching across extensions, label fallback, nested character folders, no-match success, missing/invalid input responses, and remaining file/account state after every operation.

`sillytavern-1.19.0-image-metadata-index-reads.json` captures authenticated and CSRF-protected background virtual-folder listing, `/api/image-metadata/folders/get`, and `/api/image-metadata/all`; folder passthrough, image filename assignments and basename collisions, JavaScript prefix coercion/filtering, malformed-index fallback and shape errors, wrong-method 404s, and unchanged metadata/account files.

`sillytavern-1.19.0-image-metadata-folder-create.json` captures authenticated/CSRF-protected folder creation, UUIDv4 and JavaScript name trimming, input/index errors, exact metadata-index bytes and file state, unknown-field retention, and a Go create operation read back by pinned Node.

`sillytavern-1.19.0-image-metadata-set-thumbnails.json` captures authenticated/CSRF-protected folder thumbnail batches, validation and strict ID matching, duplicate updates, missing-folder skips, malformed-index errors, exact metadata-index bytes and file state, unknown-field retention, and a Go update read back by pinned Node.

`sillytavern-1.19.0-image-metadata-folder-update.json` captures authenticated/CSRF-protected folder rename and cover updates, field assignment, ID validation, not-found and malformed-index errors, exact metadata-index bytes and file state, unknown-field retention, and a Go update read back by pinned Node. Express body-parser syntax errors for primitive JSON remain a documented response difference.

`sillytavern-1.19.0-image-metadata-folder-delete.json` captures authenticated/CSRF-protected folder deletion, duplicate folder and assignment IDs, object/array image collections, validation, not-found and malformed-index errors, exact metadata-index bytes and file state, unknown-field retention, and a Go delete read back by pinned Node. Its captured OPTIONS response is compared against the shared CORS oracle.

`sillytavern-1.19.0-image-metadata-folder-assignments.json` captures authenticated/CSRF-protected assign and unassign operations, path normalization and traversal validation, missing-file skips, deduplicated and one-at-a-time folder IDs, malformed metadata errors, exact index bytes and file state, and Go mutations read back by pinned Node. Its captured OPTIONS responses are compared against the shared CORS oracle.

`sillytavern-1.19.0-image-metadata-cleanup.json` captures authenticated/CSRF-protected orphan cleanup, missing and out-of-root paths, array/object image indexes, exact removal order and file bytes, no-write mtime preservation, and Go cleanup read back by pinned Node. Its captured OPTIONS response is compared against the shared CORS oracle.

`sillytavern-1.19.0-cors-middleware.json` captures pinned `cors@2.8.5` configured-origin allow/deny behavior for actual requests and preflights, wildcard origins with credentials (with and without Origin), custom methods/headers/exposed headers/max-age, origin-less preflights, preflight handling on an unregistered route, and disabled-CORS automatic OPTIONS responses for POST-only and GET API routes.

`sillytavern-1.19.0-image-metadata-get.json` captures authenticated/CSRF-protected single and batch metadata reads, cached-value passthrough, generated PNG/JPEG/GIF/24-bit BMP metadata, custom per-type thumbnail resolutions from YAML, large hexadecimal and invalid numeric-string coercion, rejected hexadecimal-float syntax, decimal underflow, ECMAScript whitespace, non-array and short-array dimension handling, stale-entry replacement, folder-ID retention, atomic index persistence, and a Go-write/Node-readback round trip. It also records missing/outside paths, request validation, trailing-slash and unknown-subpath routing, unchanged account state, and the default OPTIONS response.

`sillytavern-1.19.0-cookie-secret.json` captures the pinned `getCookieSecret()` behavior for missing, empty, existing, and legacy-config secret files. Generated secret bytes are omitted; the fixture retains their length and decoded random-byte count.

`sillytavern-1.19.0-system-prompt-migration.json` captures fresh marker creation and legacy instruct-template migration, including backups, duplicate built-in prompt filtering, and existing system-prompt precedence.

`sillytavern-1.19.0-user-data-migration.json` captures the pinned legacy `public/` data migration after directory initialization, including destination merging, dated backups, deletion of successfully moved sources, and the no-legacy fast path.

`sillytavern-1.19.0-public-overrides-migration.json` captures pinned error-page and user-CSS override migration, including existing data-root precedence and legacy-source retention.

`sillytavern-1.19.0-security-settings.json` records pinned security-gate warnings and exit behavior for listen, whitelist, Basic Auth, account, password, and override combinations, along with the exact Node-persist records that supplied each scenario's users. Go startup tests read the captured Node records before evaluating the security gate.

`sillytavern-1.19.0-group-metadata-migration.json` captures legacy group metadata migration, per-chat headers, existing chat-header precedence, and backup files.

`sillytavern-1.19.0-character-disk-cache.json` captures pinned character-cache creation and verification behavior for disabled, empty, valid-PNG, stale, and non-PNG entries, including the hashed-filename removal behavior.

`sillytavern-1.19.0-flat-secrets.json` captures pinned legacy secrets migration, backups, idempotence, JavaScript property/value edge cases, per-user error continuation, and a Node-to-Go-to-Node check that SillyTavern reads Go-migrated secrets.

`sillytavern-1.19.0-upload-cleanup.json` captures pinned pre-listen upload-directory handling for absent, empty, dirty, nested-directory, and non-directory paths.

`sillytavern-1.19.0-access-log-migration.json` captures pinned legacy access-log moves, destination precedence, same-path no-op, directory sources, and caught move failures.

`sillytavern-1.19.0-settings-backup.json` captures the `settings.init()` startup snapshots, duplicate suppression, backup retention by modification time, and the caught missing-backups-directory error.

`sillytavern-1.19.0-stats-init.json` captures valid stats loading, missing/invalid-file recreation, JSONL chat aggregation, memory state, the five-minute save interval, the caught missing-character-directory error, and a Node-created chat directory → Go-created stats file → Node-readback round trip.

Observer captures use the `http`, `provider`, `providerResponse`, `browserEvents`, and `filesystem` top-level fields. Compare two captures with:

```sh
node tools/compare-observations.mjs node-capture.json gotavern-capture.json
```

The comparator checks field presence and values, preserves array order, ignores JSON object-key order, and skips an observer only when both captures explicitly mark it unobserved. It does not delete or normalize fields globally.
