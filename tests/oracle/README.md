# Pinned Node oracle fixture

`sillytavern-1.19.0-fresh-start.json` is produced by starting the exact pinned Node server in a temporary clone with an empty config and data root. The probe records the root page, `/version`, generated `/lib.js`, and the resulting data-root path/size/hash inventory.

Regenerate the Webpack asset, inventories, and fresh-start oracle from a clean pinned checkout with:

```sh
node tools/build-generated-lib.mjs /path/to/SillyTavern-at-06bde939
```

The tool clones from that local checkout, installs the pinned package lock in a temporary clone, and deletes the generated runtime fixture after recording observations. It does not install dependencies into or write to the supplied checkout.

The fresh-start fixture is a Node oracle capture. Go tests compare `/`, `/version`, and `/lib.js`; startup filesystem comparison remains unimplemented. Provider and browser-event observers are explicitly marked unobserved for this startup-only scenario. Nondeterministic fields are listed in the fixture and normalized only there.

`sillytavern-1.19.0-config-init.json` captures pinned `addMissingConfigValues()` output for a missing config, a legacy YAML config with unknown fields, and a deprecated environment variable. It stores exact output YAML so Go config initialization can compare startup writes byte-for-byte.

Observer captures use the `http`, `provider`, `providerResponse`, `browserEvents`, and `filesystem` top-level fields. Compare two captures with:

```sh
node tools/compare-observations.mjs node-capture.json gotavern-capture.json
```

The comparator checks field presence and values, preserves array order, ignores JSON object-key order, and skips an observer only when both captures explicitly mark it unobserved. It does not delete or normalize fields globally.
