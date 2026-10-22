# GoTavern Installation, Update and Migration Contract

This document specifies the **end-user delivery experience**. It is not merely packaging advice: these flows are release gates.

GoTavern targets SillyTavern users, not Go developers. A normal production installation must not require Go, Node.js, npm, pnpm, Python or a compiler.

## 1. Supported ways to obtain GoTavern

Stable releases provide three first-class paths:

1. **One-line installer** (`install.sh` / `install.ps1`): downloads a prebuilt GitHub Release asset and verifies its checksum.
2. **Manual GitHub Release download**: download the archive for the operating system/architecture, extract it, run `start.sh` / `Start.cmd` or the binary directly.
3. **Container image**: pull a published multi-architecture GHCR image and mount persistent runtime data.

Building from source is a developer workflow and must never be required as an implicit fallback when a release asset is missing.

Until the first GitHub Release exists, installer scripts should fail clearly instead of compiling source.

---

## 2. Native release matrix

Every stable release must publish these canonical asset names:

```text
gotavern-linux-amd64.tar.gz
gotavern-linux-arm64.tar.gz
gotavern-darwin-amd64.tar.gz
gotavern-darwin-arm64.tar.gz
gotavern-windows-amd64.zip
gotavern-windows-arm64.zip
checksums.txt
```

At minimum Linux amd64/arm64 and Windows amd64 are hard release gates. Other listed targets remain expected unless a documented dependency constraint temporarily blocks them.

Canonical names are important because installers use stable GitHub `releases/latest/download/...` URLs and should not need the GitHub API or `jq` just to discover an asset.

Each archive contains immutable release material such as:

```text
gotavern                 # gotavern.exe on Windows
start.sh                  # Unix archives
Start.cmd                 # Windows archives
LICENSE
THIRD_PARTY_NOTICES.txt   # when needed
BUILD-INFO.txt            # GoTavern version + pinned ST version/SHA
```

**Do not package live `config.yaml`, `data/`, extension repositories or certificates in a way that archive extraction can overwrite an existing installation.** Fresh runtime state is created by the binary from its embedded pinned SillyTavern defaults.

---

## 3. Installer behavior

### Unix-like systems

Intended usage after releases exist:

```sh
curl -fsSL https://raw.githubusercontent.com/cocokoishi/GoTavern/main/install.sh | sh
```

Optional explicit directory/version forms are supported by downloading the script first or passing documented arguments:

```sh
./install.sh --dir "$HOME/servers/GoTavern"
./install.sh --version v0.3.0 --dir "$HOME/servers/GoTavern"
```

Default installation directory:

```text
$HOME/GoTavern
```

### Windows PowerShell

Intended usage after releases exist:

```powershell
irm https://raw.githubusercontent.com/cocokoishi/GoTavern/main/install.ps1 | iex
```

For options, save the script and run for example:

```powershell
.\install.ps1 -InstallDir "$HOME\Servers\GoTavern"
.\install.ps1 -Version v0.3.0 -InstallDir "$HOME\Servers\GoTavern"
```

Default installation directory:

```text
%USERPROFILE%\GoTavern
```

### Required installer properties

Installers must:

- detect supported OS and architecture;
- select the canonical prebuilt archive;
- support latest stable and an explicit release tag;
- download `checksums.txt` from the same release;
- verify SHA-256 before installing anything;
- install `tokenizers/` beside the binary as immutable release data, and refuse an archive that lacks it;
- use a temporary directory for download/extraction;
- replace immutable executable/launcher files only after successful verification;
- preserve user config/data/extensions/certs on re-run;
- not require root/admin by default;
- not modify shell profiles/PATH automatically;
- not install Go/Node/Git automatically;
- not compile source as fallback;
- report an unsupported architecture or missing release clearly;
- clean temporary files on normal/error exit where feasible.

For an executable update, download and verify first and then replace the old executable atomically or with the safest platform-equivalent sequence possible.

### 3.1 Mirrors and air-gapped installs

Both installers accept `GOTAVERN_RELEASES_BASE_URL`. When it is set it **replaces** the computed GitHub release base URL for **both** forms:

- the latest form, which requests `<base>/latest/download/`;
- the explicit-tag form, which requests `<base>/<tag>/`.

A mirror must therefore serve both shapes, with the canonical asset names from §2 and a `checksums.txt` in `sha256sum` format (`<64 hex characters>  <asset name>`, no `./` prefix). For a mirror, the Unix installer drops the `--https-only` flag it uses when downloading from GitHub, because a loopback or intranet mirror is a legitimate plain-http target; the Windows installer's `Invoke-WebRequest` never enforced a scheme, so its only change is the URL.

This is a **mirror / air-gapped install** feature, not a test hook, and it does not weaken any check:

- checksum verification stays mandatory and unconditional, from the same release the archive came from;
- there is **no fallback to compiling source**, with or without a mirror;
- a missing `checksums.txt`, a missing entry for the asset, or a mismatched digest each abort the install and install nothing;
- when the variable is unset, every URL and flag is byte-identical to the previous behaviour.

**Status of the two installers.** `install.sh` is executed by release qualification, which serves the archives a release build produced in the same run on loopback and then installs, runs, verifies, re-installs, upgrades and rolls back through it (`scripts/qualify-install.sh`). `install.ps1` carries the same mirror seam and the same `tokenizers/` requirement, but **nothing executes it**: it needs Windows PowerShell, which the Linux qualification runner does not have. It is therefore `partial` with that reason rather than claimed verified.

---

## 4. First start

The native binary with no subcommand starts the normal server:

```sh
./gotavern
```

or on Windows:

```powershell
.\gotavern.exe
```

Launchers simply execute the adjacent binary while making the installation directory the predictable runtime root:

```sh
./start.sh
```

```cmd
Start.cmd
```

A fresh empty installation must behave like a fresh pinned SillyTavern installation:

- create/migrate `config.yaml` using the pinned `default/config.yaml` semantics;
- create the configured data root;
- initialize account/user storage;
- create required per-user directories;
- seed indexed pinned `default/content/**` and `default/scaffold/**` content according to the upstream content-manager rules;
- provide the pinned frontend and generated `lib.js` without Node/Webpack at runtime;
- print the browser URL and optionally honor upstream-compatible browser-launch configuration;
- expose `/version` as the SillyTavern compatibility version, not the GoTavern product version.

Fresh installation is tested from a genuinely empty directory.

---

## 5. Runtime modes

### 5.1 Familiar standalone mode

The normal portable/server layout is:

```text
GoTavern/
├── gotavern
├── start.sh / Start.cmd
├── config.yaml
└── data/
```

`data/` is only the default. `dataRoot` in `config.yaml` and compatible command-line overrides remain authoritative.

### 5.2 SillyTavern-compatible global/custom paths

GoTavern must support the pinned SillyTavern operational model including global mode and explicit config/data-root overrides. This matters for users who ran SillyTavern through npm/global mode, service managers, custom scripts or containers rather than from a stock clone.

Existing reverse-proxy/service configurations should generally need only an executable/path change when their SillyTavern CLI/config behavior is otherwise compatible.

---

## 6. Migrating an existing SillyTavern installation

> **STATUS: `gotavern migrate` IS IMPLEMENTED**, with the limits named at the end of this section.
> This is GoTavern PRODUCT behaviour, not SillyTavern parity: pinned SillyTavern has no `migrate`
> subcommand, so there is no oracle to replay and nothing here is a compatibility claim about Node. What
> is verified is the contract's own consequences: the source is never written, a migrated install
> behaves like one pointed at the source, `--dry-run` writes nothing, a second run refuses by name,
> plugins are reported and never copied, unknown config keys survive byte for byte, symlinks are
> refused, and every documented form parses.

Copy migration is cross-platform and lives in the binary:

```text
gotavern migrate --from /opt/SillyTavern --dest /opt/GoTavern
gotavern migrate --source-config /path/config.yaml --source-data /mnt/st-data --dest /opt/GoTavern
gotavern migrate --source-global --dest /opt/GoTavern
gotavern migrate --from /opt/SillyTavern --dest /opt/GoTavern --dry-run
```

`scripts/migrate-from-sillytavern.sh` remains the transitional shell helper for hosts where the binary
cannot be run yet. It is not executed by any test; the binary is the tested path.

### Typical standalone clone

Typical flow:

```text
1. Download/install GoTavern into a different directory.
2. Stop SillyTavern (Node) or prepare a filesystem snapshot.
3. Run GoTavern migration against the old SillyTavern root.
4. Review migration report, especially server-plugin warnings.
5. Start GoTavern.
6. Verify login, one character, one chat, worlds/presets and extensions.
7. Keep the original source intact until satisfied.
```

### Migration forms

The final migration tool supports explicit inputs such as:

```text
gotavern migrate --from /opt/SillyTavern --dest /opt/GoTavern
gotavern migrate --source-config /path/config.yaml --source-data /mnt/st-data --dest /opt/GoTavern
gotavern migrate --source-global --dest /opt/GoTavern
gotavern migrate --from /opt/SillyTavern --dest /opt/GoTavern --dry-run
```

Exact CLI may evolve before implementation, but the capabilities may not be dropped.

### What migration copies

Migration copies the complete compatibility state, not selected “important” folders:

- `config.yaml` (destination copy);
- complete configured data root;
- `_storage` account state;
- `cookie-secret.txt`;
- all users, cards, chats, worlds, presets, settings, secrets, media, backups/caches/root compatibility state inside the configured data root;
- per-user extensions already inside user data;
- global frontend-extension overlay when present;
- relative certificate/path assets required by the copied configuration when selected by the migration rules.

It does not copy `node_modules`.

### Absolute/out-of-tree data roots

An absolute or external data root is valid input, not a reason to abandon migration.

The migration tool copies the external source data root into a deliberate destination location (unless the user explicitly selects direct-use mode) and updates **only the destination config copy** to point at that destination. The original source config/data are unchanged.

### Source is strictly read-only during copy migration

The migration process may not write, rename, delete, chmod, clean, “upgrade”, lock or create backup files in the source installation.

This safety rule applies to the migration source. It does not mean a subsequently started GoTavern runtime never changes its destination config/data: normal startup must reproduce pinned SillyTavern migration/default-seeding semantics.

### Symlinks

Preflight symlinks. A copied installation must not silently retain links into the old source tree or arbitrary paths. Internal safe links may be preserved when semantics are understood; escaping links must fail or require an explicit policy.

### Node server plugins

If the source has `plugins/`, migration reports them clearly. Arbitrary Node server plugins are not supported and are not counted as successfully migrated functionality. The command prints one line naming each plugin, never copies the
directory, and creates no endpoint for it.

### What `gotavern migrate` actually writes

The destination layout is fixed, because a migration that guessed where a runtime lives would be a way
to write somewhere the user did not name:

| written | from |
| --- | --- |
| `<dest>/config.yaml` | the source config, with **only** its `dataRoot` changed |
| `<dest>/data/` | the complete configured data root, wherever it lived |
| `<dest>/certs/` | `<source>/certs` when it exists |
| `<dest>/public/scripts/extensions/third-party/` | the global extension overlay when it exists |

Nothing else is created. `node_modules`, `plugins/` and the source's own executable are never copied.

The config copy is a **textual** edit of one scalar: unknown keys, ordering, quoting, comments and the
file's line endings all survive, and the data root becomes `./data`. A parse-and-reserialize would
rewrite the file its author wrote, which is why it is not done; the requirement that unknown keys
survive is compared byte-wise in the tests, not by "it parses".

After copying, every written tree is re-read and hashed against its source, so a short read, a skipped
directory or a stray destination file fails the command instead of being reported as success.

### Running it twice

A second migration into a destination that already holds `config.yaml` or `data/` **refuses**, naming
what is in the way. It does not merge and it does not silently overwrite. `--force` moves that state to
`<dest>/.migrate-backup/` first and then reproduces the tree; a second `--force` refuses while that
backup exists, so no forced run quietly discards the previous destination.

### Preflight refusals

Every one of these is a named error with nothing written to either side: no source, more than one
source form, `--source-config` without `--source-data`, no `--dest`, an unknown flag, a source that is
not a directory or has no `config.yaml`, a destination inside the source, a source inside the
destination, a `dataRoot` that is not a simple scalar, an empty `dataRoot`, a `dataRoot` containing
`..`, and any symlink in the copied trees.

### Limits, stated so they are not mistaken for coverage

- **Symlinks are refused, not resolved.** A preserved link would point back into the source tree the
  user is about to delete, and following one would copy data from outside the tree the user named.
  Dereference the links first if that is what you want.
- **A running source is not detected.** The source is never written, but nothing checks that Node
  SillyTavern is stopped; stop it first, or copy from a snapshot.
- **Plugins are reported, never migrated** (hard rule 16).
- **Not a baseline upgrade.** Migration copies bytes; what the pinned baseline changes on first start
  happens after this command, not in it.
- **Verified against the contract, not against Node.** Pinned SillyTavern has no `migrate`, so these
  are contract derivations, except the equivalence test, which boots GoTavern over a pristine copy of
  the source and over the migrated destination and requires the two data trees to match.

---

## 7. Direct-use mode

Advanced users may point GoTavern directly at a compatible SillyTavern config/data root instead of copying it.

Rules:

- never run Node SillyTavern and GoTavern writable against the same data root simultaneously;
- take a backup/snapshot before first use on valuable data;
- expect normal upstream-compatible startup migrations to occur if the pinned SillyTavern baseline would perform them;
- direct-use is not a way to bypass version compatibility: use a data-compatible baseline.

Copy migration is easier to roll back during initial evaluation; direct-use minimizes disk duplication.

---

## 8. Updating GoTavern

Re-running the installer against the same installation directory is the simple update path.

An update may replace:

- GoTavern executable;
- immutable launcher/documentation files.

It must preserve:

- `config.yaml` as user runtime state (except subsequent normal startup migrations made by the new pinned baseline itself);
- configured data root;
- per-user/global extension repositories;
- certificates;
- logs/backups;
- custom proxy/service configuration.

Before publishing a release that bumps the SillyTavern baseline, migration/startup differential tests must establish what the upstream version itself changes on first start.

---

## 9. Rollback to SillyTavern

Because GoTavern deliberately retains SillyTavern data formats, rollback to an equivalent data-compatible SillyTavern baseline is process-level rather than converter-level:

1. stop GoTavern;
2. back up GoTavern's current config/data;
3. start the matching SillyTavern release against that compatible data, or copy it to a fresh matching SillyTavern runtime;
4. verify authentication, one character/chat and representative presets/world info.

Do not promise safe arbitrary downgrade across upstream migrations that SillyTavern itself does not support.

---

## 10. Docker

Stable release CI publishes a multi-arch image. Runtime requirements are intentionally small:

- GoTavern binary;
- CA certificates/timezone data where needed;
- writable mounted runtime/data;
- **no Node runtime**.

A built-in pure-Go Git implementation is preferred so extension installation does not require system Git in the container either.

Reverse proxies must allow large imports and long-lived streaming responses, preserve cookies/Host/scheme/client headers according to trusted-proxy configuration, and disable buffering for generation streams.

---

## 11. Release acceptance checklist

A native release is not ready merely because cross-compilation succeeded. CI must install/use artifacts as a user would and verify the items below. EACH LINE NOW STATES ITS EVIDENCE, because a checklist whose items are asserted by nothing is how the installer shipped for months without installing tokenizers/ -- and without ever being executed at all.

| # | item | evidence |
|---|---|---|
| 1 | archive extracts and executable starts | GATED -- release-qualification.yml asserts contents and modes, then boots the extracted binary and requires /version |
| 2 | installer latest/version-pinned download path works | GATED -- scripts/qualify-install.sh installs through a loopback mirror in BOTH forms and requires the mirror to have served the requests |
| 3 | checksum verification rejects tampering | GATED -- a tampered archive must ABORT, name the mismatch, and install nothing |
| 4 | re-install preserves an existing runtime fixture | GATED -- a second install over the same prefix must preserve a user file and config.yaml byte for byte, and assets verify must still pass after an upgrade |
| 5 | fresh empty runtime seeds the same pinned defaults as Node | GATED -- tests/oracle/sillytavern-1.19.0-fresh-start.json |
| 6 | migrated standalone fixture boots | GATED -- `TestMigratedInstallIsEquivalentToPointingAtTheSource` runs `gotavern migrate --from` into a temp destination, then boots BOTH the destination and a pristine copy of the source root through the real startup chain and requires the two data trees to match (path, kind, size, SHA-256, five declared exclusions); `TestDocumentedForms` covers all four documented forms and `TestSourceIsNeverModified` requires the source byte-identical afterwards |
| 7 | custom/absolute data-root migration boots | GATED -- the same test's absolute branch migrates a source whose `dataRoot` is an out-of-tree absolute path, requires `<dest>/data` to hold the copy and `<dest>/config.yaml` to be the source bytes with only that one scalar rewritten (`TestConfigKeepsUnknownKeysAndChangesOnlyDataRoot`), and boots it |
| 8 | login and representative chat work | PARTIAL -- the browser differential covers login and the DOM; generation has provider-wire plus browser evidence for the CUSTOM source only |
| 9 | semantic/provider-wire suite passes | GATED -- the provider-wire, backend, SD and provider fixtures replayed in go test ./... |
| 10 | pinned Tavern Helper deep workflow passes | PARTIAL -- tests/browser/extension-tavern-helper-comparison.json is committed and gated: 21 rows equal on a release-faithful install, one known difference (/thumbnail, the Jimp boundary) |
| 11 | supported LittleWhiteBox standard-API workflow passes | PARTIAL -- tests/browser/extension-littlewhitebox-comparison.json: 452 rows equal, same single known difference; the drive exercises load/discover/storage, not the full feature set |
| 12 | Docker image passes the same smoke path | GATED SEPARATELY -- docker.yml builds the image, runs assets verify inside it and smokes a pinned route; that is an IMAGE, not the archive a user downloads |
| 13 | resource benchmark is recorded | **RECORDED, NOT A GATE** -- `.github/workflows/smoke-metrics.yml` (weekly + dispatch, never on push) builds the release binary and records cold start, warm restart, `/version` and `/` latency samples, seeded file count/bytes, RSS and install footprint into a `smoke-metrics` artefact carrying the runner image identity. Only a 60 s cold-start ceiling is asserted: a slower start is a hang, not a busy runner, and every other number is reported rather than asserted because it moves with the host. Two runs on one commit: cold 177/184 ms, warm 26 ms, `/version` median 0.71/0.75 ms, seed 203 files. The noisy numbers (warm RSS +23%, `GET /` median +15.7% across two runner image builds) are named as noisy in the record instead of being asserted. |

Only then is the release suitable for ordinary deployment.
