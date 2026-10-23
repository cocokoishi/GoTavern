# GoTavern Installation, Update and Migration Contract

This document specifies the **end-user delivery experience**. It is not merely packaging advice: these flows are release gates.

GoTavern targets SillyTavern users, not Go developers. A normal production installation must not require Go, Node.js, npm, pnpm, Python or a compiler.

## 1. Supported ways to obtain GoTavern

Stable releases provide three first-class paths:

1. **One-line installer** (`install.sh` / `install.ps1`): downloads a prebuilt GitHub Release asset and verifies its checksum.
2. **Manual GitHub Release download**: download the archive for the operating system/architecture, extract it, run `start.sh` / `Start.cmd` or the binary directly.
3. **Container image**: the PUBLISH PATH IS EXECUTED and gated, but no release tag has published it. `docker.yml`
pushes to `ghcr.io/cocokoishi/gotavern` on a `v*` tag push (the only event that also moves `:latest`) and on a
`workflow_dispatch` with `push_image=true`, which publishes the named `image_tag` and never `latest`. Dispatch run
39907882256 is green and its last steps are the ones that matter: it pushed, then PULLED the reference back and ran
`assets verify` inside the pulled copy, which makes the registry bytes the subject rather than the local daemon. The
gate is proved to fail when verification cannot follow a push: mutation runs 39908260013 and 39908470507 (tag
`dispatch-mutation-verify`) fail the pull-back step with `manifest unknown`, and after the report step was tightened
the second of them also refuses to report the tag as published. MEASURED: the publish path and its gate, on
linux/amd64. NOT COVERED: no `v*` tag exists (`git tag -l 'v*'` is empty as of 2026-10-23), so `:latest` has never
been published and no user can pull a release image; a multi-architecture index is unexecuted; and the Windows
installer behaviours are covered only by `release-qualification.yml` (see HANDOFF section 3).

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

**Status of the two installers.** BOTH are executed by release qualification, against a loopback mirror serving the archives a release build produced in the same run. scripts/qualify-install.sh qualifies install.sh; scripts/qualify-install.sh --powershell qualifies install.ps1 under pwsh with the SAME mirror builder and the SAME assertion set, so the two cannot drift apart in what they claim. Both are held to: the mirror served the metadata and archive requests (so an ignored seam shows up as a missing request rather than as a successful install from github.com), a tampered archive aborts and installs nothing, 	okenizers/ is installed beside the binary, ssets verify passes from the installed prefix before and after an upgrade, and a re-install and a rollback preserve a user file and config.yaml byte for byte.

Running install.ps1 under pwsh on Linux executes the download, checksum, install, update and rollback logic but cannot reach four Windows-only behaviours. THEY ARE NO LONGER UNEXECUTED: `release-qualification.yml`'s `qualify-windows-amd64` job runs `scripts/qualify-install-windows.ps1` on a Windows runner, and each of those four is now an assertion (release checklist item 14):

- **replacing a RUNNING gotavern.exe**: the job starts the installed server, runs the installer over it, and requires the documented refusal -- non-zero exit, a message naming the replacement step and the running case, the process still alive, the exe byte-identical, no staging file left, and `/version` still answering. It then stops the server and requires the update to replace the binary (`older -> newer`) and `assets verify` to pass afterwards;
- **Windows path separators and drive letters**: the install directory is a real `C:\...` path, so `Join-Path` produces `\` and every later assertion uses that path; a temp path containing a space is a hard failure rather than a silently weakened `cmd.exe` assertion;
- **the registry, shortcuts, `$env:LOCALAPPDATA`, Start Menu entries**: asserted as the NEGATIVE claim, which is what "the installer does none of these" is -- the Uninstall registry subkeys and the Start Menu Programs folder are snapshotted before and after and must be identical;
- **cmd.exe itself**: `Start.cmd` is launched through `cmd /c` with an argument and must report the installed version, which exercises its `cd /d "%~dp0"` and `"%~dp0gotavern.exe" %*`.

What remains unexecuted on Windows, stated so it is not implied: the real `github.com` release URL (every install in the job goes through the loopback mirror seam, and the mirror's request log must contain every request, so a bypass fails rather than silently succeeding), elevation and other-user installs, Windows ARM64 on an x64 runner, proxy/TLS behaviour, and an update across different upstream baselines.

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

Stable release CI does NOT yet publish a multi-arch image (see section 1, path 3); the `Dockerfile` builds locally and `docker.yml` smoke-tests it. Runtime requirements are intentionally small:

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
| 2 | installer latest/version-pinned download path works | GATED for BOTH installers -- `scripts/qualify-install.sh` (`install.sh`) and `scripts/qualify-install.sh --powershell` (`install.ps1` under `pwsh`) install through a loopback mirror in both the latest and the version-pinned form, and require the MIRROR to have served the requests |
| 3 | checksum verification rejects tampering | GATED for BOTH installers -- a tampered archive must ABORT, name the mismatch, and install nothing, under `install.sh` and under `install.ps1` |
| 4 | re-install preserves an existing runtime fixture | GATED for BOTH installers -- a second install over the same prefix must preserve a user file and config.yaml byte for byte, and `assets verify` must still pass after an upgrade, under `install.sh` and under `install.ps1` | an upgrade |
| 5 | fresh empty runtime seeds the same pinned defaults as Node | GATED -- tests/oracle/sillytavern-1.19.0-fresh-start.json |
| 6 | migrated standalone fixture boots | GATED -- `TestMigratedInstallIsEquivalentToPointingAtTheSource` runs `gotavern migrate --from` into a temp destination, then boots BOTH the destination and a pristine copy of the source root through the real startup chain and requires the two data trees to match (path, kind, size, SHA-256, five declared exclusions); `TestDocumentedForms` covers all four documented forms and `TestSourceIsNeverModified` requires the source byte-identical afterwards |
| 7 | custom/absolute data-root migration boots | GATED -- the same test's absolute branch migrates a source whose `dataRoot` is an out-of-tree absolute path, requires `<dest>/data` to hold the copy and `<dest>/config.yaml` to be the source bytes with only that one scalar rewritten (`TestConfigKeepsUnknownKeysAndChangesOnlyDataRoot`), and boots it |
| 8 | login and representative chat work | PARTIAL -- the browser differential covers login and the DOM; generation has provider-wire plus browser evidence for the CUSTOM source only |
| 9 | semantic/provider-wire suite passes | GATED -- the provider-wire, backend, SD and provider fixtures replayed in go test ./... |
| 10 | pinned Tavern Helper deep workflow passes | PARTIAL -- tests/browser/extension-tavern-helper-comparison.json is committed and gated: 21 rows equal on a release-faithful install, one known difference (/thumbnail, the Jimp boundary) |
| 11 | supported LittleWhiteBox standard-API workflow passes | PARTIAL -- tests/browser/extension-littlewhitebox-comparison.json: 452 rows equal, same single known difference; the drive exercises load/discover/storage, not the full feature set |
| 12 | Docker image passes the same smoke path AND is publishable | GATED -- `docker.yml` builds the image, runs `assets verify` inside it and smokes a pinned route; a version `v*` tag then pushes `ghcr.io/<repo>:<tag>` and `:latest`, PULLS THE PUSHED REFERENCE BACK (after removing the local image) and re-runs `assets verify` inside the pulled copy, and no step may claim an image exists unless that verification succeeded. The publish path itself was executed by `workflow_dispatch` with a temporary tag (`ghcr.io/cocokoishi/gotavern:dispatch-lane-release-pipeline`, digest `sha256:756eee538da85afa40cd2daa123973486ec5e71a38dee3be270238a60aa90091`, run 39907882256) which never moves `:latest`. Still an IMAGE, not the archive a user downloads |
| 13 | resource benchmark is recorded | **RECORDED, NOT A GATE** -- `.github/workflows/smoke-metrics.yml` (weekly + dispatch, never on push) builds the release binary and records cold start, warm restart, `/version` and `/` latency samples, seeded file count/bytes, RSS and install footprint into a `smoke-metrics` artefact carrying the runner image identity. Only a 60 s cold-start ceiling is asserted: a slower start is a hang, not a busy runner, and every other number is reported rather than asserted because it moves with the host. Two runs on one commit: cold 177/184 ms, warm 26 ms, `/version` median 0.71/0.75 ms, seed 203 files. The noisy numbers (warm RSS +23%, `GET /` median +15.7% across two runner image builds) are named as noisy in the record instead of being asserted. |
| 14 | Windows installer behaviours: replacing a RUNNING `gotavern.exe`, path separators, registry/shortcuts, `cmd.exe` | GATED -- `release-qualification.yml`'s `qualify-windows-amd64` job runs `scripts/qualify-install-windows.ps1` on `windows-latest` and asserts, over a server IT STARTED: the installer REFUSES to replace a running `gotavern.exe` with a non-zero exit naming both the replacement step and the running case, the server still alive, the exe byte-identical, no `.gotavern.new.*` staging file left and `/version` still answering; then, after the server is stopped, the update DOES replace the binary (`older -> newer`, through the mirror's `latest` form) and `assets verify` passes after it; the install path is a real `\`-separated Windows path; the Uninstall registry key and the Start Menu Programs folder are UNCHANGED (the negative claim, measured); and `Start.cmd` is launched through `cmd /c` and must report the installed version, which exercises its `cd /d "%~dp0"` and `"%~dp0gotavern.exe" %*`. Run 39907640873: 20 assertions, all `ok:` |

Assertion-mutation evidence, recorded so a reader can tell a gate from a claim: run 39908014487 inverted the
running-`gotavern.exe` assertion (it required the installer to SUCCEED over a running server instead of to
refuse, and the job failed with `FAIL: MUTATION: expected the installer to REPLACE a running gotavern.exe
(exit 0) and it refused (exit 1)`), and run 39908260013 broke the Docker pull-back verification (it pulled a
reference that does not exist and the job failed with `manifest unknown`). That second run also exposed a real
defect in this workflow rather than in the product: its summary printed `published: ...` on a run whose
verification had failed, because it asked whether a push happened and not whether the verification passed. A
push with no successful verification is now reported as `PUSHED BUT NOT VERIFIED` and fails the job
(run 39908470507 shows the corrected report under the same mutation).

| 15 | CROSS-BASELINE update and rollback: an older release updated to a newer one, then rolled back, with user state surviving | GATED -- `release-qualification.yml`'s `qualify-upgrade-rollback` job builds TWO archives from TWO DIFFERENT COMMITS (the pinned baseline `d00d99b`, 189 commits behind, and the candidate) and `scripts/qualify-upgrade-rollback.sh` drives the REAL `install.sh` against a loopback mirror: it installs the older release and asserts the version, `assets verify` from the prefix and that the installed binary and `tokenizers/` are byte-identical to the older archive's own manifest; seeds runtime state (config.yaml carrying a key GoTavern does not know, user settings, a card, a chat, an extension, a cert) and boots it; updates to the newer release and asserts the version MOVED, the binary changed and every runtime file survived byte for byte; boots it and WRITES NEW STATE WITH THE NEWER RELEASE; rolls back and asserts the binary is byte-identical to the older archive's, `assets verify` passes and the rolled-back `tokenizers/` matches the older manifest; then asserts the newer release's state survived and BOOTS THE OLDER RELEASE OVER IT, requiring it to start, answer `/version` and change nothing except the pinned timestamped settings backup. Run 39997932741, all `ok:`; the rollback assertion was proved live by a mutation that made the rollback install the newer release (run 39998226861 failed with `FAIL: after the rollback the installed binary reports upg-newer-... , expected the older tag upg-older-...`). MEASURED LIMIT of this pair: the vendored asset trees are identical across those two commits, so the update moves the binary and BUILD-INFO but not the embedded assets; the job prints that measurement rather than implying otherwise, and the `baseline_ref` dispatch input overrides the baseline once an older RELEASE tag exists |

Only then is the release suitable for ordinary deployment.
