# Pinned Node oracle fixture

`sillytavern-1.19.0-fresh-start.json` is produced by starting the exact pinned Node server in a temporary clone with an empty config and data root. The probe records the root page, `/version`, generated `/lib.js`, the resulting data-root path/size/hash inventory, parsed `user:*` records with only the generated `created` timestamp normalized, and the actual pinned public/per-user directory paths.

Regenerate the Webpack asset, inventories, and fresh-start oracle from a clean pinned checkout with:

```sh
node tools/build-generated-lib.mjs /path/to/SillyTavern-at-06bde939
```

The tool clones from that local checkout, installs the pinned package lock in a temporary clone, and deletes the temporary clone and runtime directories after recording observations. It does not install dependencies into or write to the supplied checkout.

The fresh-start fixture is a Node oracle capture. Go tests compare `/`, `/version`, `/lib.js`, the initial account-store record, the pinned public/per-user directory template, and the seeded content paths/bytes/content logs. The `seededContent` projection excludes the stats file, settings backup, and `.migrated` system-prompt marker because those come from separate startup paths; the complete `dataRoot` inventory retains them. The rest of the startup filesystem still needs comparison. Provider and browser-event observers are explicitly marked unobserved for this startup-only scenario. Nondeterministic fields are listed in the fixture and normalized only there.

`sillytavern-1.19.0-config-init.json` captures pinned `addMissingConfigValues()` output for a missing config, a legacy YAML config with unknown fields, and a deprecated environment variable. It stores exact output YAML so Go config initialization can compare startup writes byte-for-byte.

`sillytavern-1.19.0-user-storage-roundtrip.json` is produced with the pinned `node-persist@4.0.4` package and the Go startup package. It checks Node-written user/avatar records survive Go initialization byte-for-byte and remain readable by Node, then checks Node can read the Go-created default-user record. The asset/oracle rebuild job requires both Node and Go for this round-trip probe.

`sillytavern-1.19.0-cookie-secret.json` captures the pinned `getCookieSecret()` behavior for missing, empty, existing, and legacy-config secret files. Generated secret bytes are omitted; the fixture retains their length and decoded random-byte count.

`sillytavern-1.19.0-system-prompt-migration.json` captures fresh marker creation and legacy instruct-template migration, including backups, duplicate built-in prompt filtering, and existing system-prompt precedence.

`sillytavern-1.19.0-user-data-migration.json` captures the pinned legacy `public/` data migration after directory initialization, including destination merging, dated backups, deletion of successfully moved sources, and the no-legacy fast path.

`sillytavern-1.19.0-public-overrides-migration.json` captures pinned error-page and user-CSS override migration, including existing data-root precedence and legacy-source retention.

`sillytavern-1.19.0-security-settings.json` records pinned security-gate warnings and exit behavior for listen, whitelist, Basic Auth, account, password, and override combinations.

`sillytavern-1.19.0-group-metadata-migration.json` captures legacy group metadata migration, per-chat headers, existing chat-header precedence, and backup files.

`sillytavern-1.19.0-character-disk-cache.json` captures pinned character-cache creation and verification behavior for disabled, empty, valid-PNG, stale, and non-PNG entries, including the hashed-filename removal behavior.

`sillytavern-1.19.0-flat-secrets.json` captures pinned legacy secrets migration, backups, idempotence, JavaScript property/value edge cases, per-user error continuation, and a Node-to-Go-to-Node check that SillyTavern reads Go-migrated secrets.

`sillytavern-1.19.0-upload-cleanup.json` captures pinned pre-listen upload-directory handling for absent, empty, dirty, nested-directory, and non-directory paths.

`sillytavern-1.19.0-access-log-migration.json` captures pinned legacy access-log moves, destination precedence, same-path no-op, directory sources, and caught move failures.

Observer captures use the `http`, `provider`, `providerResponse`, `browserEvents`, and `filesystem` top-level fields. Compare two captures with:

```sh
node tools/compare-observations.mjs node-capture.json gotavern-capture.json
```

The comparator checks field presence and values, preserves array order, ignores JSON object-key order, and skips an observer only when both captures explicitly mark it unobserved. It does not delete or normalize fields globally.
