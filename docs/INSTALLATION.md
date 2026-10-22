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

> **STATUS: `gotavern migrate` IS NOT IMPLEMENTED.** This section previously described it as "the
> long-term canonical migration command" and listed its flags. A release audit found that the binary
> has no such subcommand -- `gotavern` accepts only `start`, `version` and `assets verify` -- so the
> text was promising a command a user cannot run. That is the same class of defect as a stale negative:
> a documented capability with no implementation behind it. The corrected status is stated here rather
> than removed, because the capabilities below remain REQUIRED for release and are tracked as their own
> increment. Until then, migration is done by the transitional shell helper
> (`scripts/migrate-from-sillytavern.sh`), which is itself not yet executed by any test.

The planned canonical migration command is cross-platform:

```text
gotavern migrate
```

The shell migration helper is transitional until this command covers the complete source matrix.

### Typical standalone clone

Planned flow (see the status note above -- step 3 has no implementation today):

```text
1. Download/install GoTavern into a different directory.
2. Stop SillyTavern (Node) or prepare a filesystem snapshot.
3. Run GoTavern migration against the old SillyTavern root.
4. Review migration report, especially server-plugin warnings.
5. Start GoTavern.
6. Verify login, one character, one chat, worlds/presets and extensions.
7. Keep the original source intact until satisfied.
```

### Migration forms that must be supported

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

If the source has `plugins/`, migration reports them clearly. Arbitrary Node server plugins are not supported and are not counted as successfully migrated functionality.

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

A native release is not ready merely because cross-compilation succeeded. CI must install/use artifacts as a user would and verify:

- archive extracts and executable starts;
- installer latest/version-pinned download path works;
- checksum verification rejects tampering;
- re-install preserves an existing runtime fixture;
- fresh empty runtime seeds the same pinned defaults as Node;
- migrated standalone fixture boots;
- custom/absolute data-root migration boots;
- login and representative chat work;
- semantic/provider-wire suite passes;
- pinned Tavern Helper deep workflow passes;
- supported LittleWhiteBox standard-API workflow passes;
- Docker image passes the same smoke path;
- resource benchmark is recorded.

Only then is the release suitable for ordinary deployment.