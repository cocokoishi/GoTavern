# GoTavern v0.1.0-alpha.9 -- first official stable-channel release

<!--
FINAL BODY for the GitHub Release of `v0.1.0-alpha.9`. This is the human-curated notes file that
`release.yml` publishes for a stable tag; all measurement placeholders have been replaced with values from
the candidate runs, and the placeholder check in `release.yml` refuses to publish while any remain.

One encoding note: this file is deliberately LF-terminated ASCII, with one exception -- the extension's own CJK
name is written once, in its real spelling, because that is how users search for it. No encoding round trip can
change a word of the rest (internal/fixtures/documents_test.go refuses a BOM, invalid UTF-8, U+FFFD and CP1252
mojibake in every markdown file in the tree).
-->

> **The tag keeps the historical `-alpha.9` name while this is intentionally GoTavern's first stable-channel
> release.** The version string is unchanged because renaming the tag would make the release that graduates the
> product the one tag in the series whose name, sort order and citations do not match its neighbours; what
> graduates is the **channel**, not the spelling. From this release onward, `releases/latest` and the Docker
> `:latest` tag point at GoTavern, and a bare installer with no version argument resolves this release.

## What GoTavern is

GoTavern is a release-grade **drop-in replacement for the SillyTavern server/backend**, written in Go: one
prebuilt binary that serves the unmodified SillyTavern frontend over the same routes, reads and writes the same
`config.yaml` and the same on-disk layout, and keeps your existing characters, chats, groups, world info,
presets, Quick Replies, secrets, themes and frontend extensions working. There is no data conversion step and no
private database: your SillyTavern directory is the database.

You do not need Go, Node.js, npm or a compiler on the machine that runs it. The frontend, the default content
and the asset manifests are embedded in the binary; the tokenizer data ships beside it in `src/tokenizers/`, the
same path upstream uses, because token counts have to be exact rather than estimated.

## Pinned compatibility target

- SillyTavern **1.19.0**, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.
- Recorded in `upstream/SILLYTAVERN_VERSION` and `upstream/SILLYTAVERN_COMMIT`, and used as the oracle for every
  behavioural claim in this release: route behaviour, startup mutations, persisted state and the bytes of the
  final provider request are compared against that pinned Node build, not against memory or against a mock of
  our own.

## Why this is the first official release

The eight releases before this one were published honestly as **prereleases**: GitHub marked them
`prerelease=true`, they never became `releases/latest`, the Docker `:latest` alias was never moved onto them, and
an unpinned `install.sh` / `install.ps1` therefore found nothing to download. That was deliberate -- an alpha
must never be what a bare `curl | sh` hands a stranger.

`v0.1.0-alpha.9` is the first tag that is published on the **stable** channel, so all four user-visible
consequences change together, from one decision:

| Surface | Before (`v0.1.0-alpha.8` and earlier) | This release (`v0.1.0-alpha.9`) |
|---|---|---|
| GitHub Release | marked prerelease | **published as a normal release** |
| `releases/latest` | pointed at nothing (404) | **points at this release** |
| Docker `:latest` | never moved | **moved onto this release's image** |
| Bare installer (no version argument) | 404 | **resolves this release** |

Those four are one decision, not four: `release.yml`, `docker.yml` and both installers all consume a single
answer from `scripts/classify-version-tag.sh`, so the GitHub release and the container image cannot disagree
about what a tag means. The graduation is a single documented equality test on a named constant
(`HISTORY_GRADUATION_TAG`) with its reasoning written beside it; the script's table test
(`scripts/test-classify-version-tag.sh`, run by CI) asserts both the graduated tag and the tags an over-eager
exception would wrongly graduate.

## Installation

Everything below downloads a **prebuilt archive** and verifies its SHA-256 against the release's
`checksums.txt`. Nothing compiles on your machine.

**Linux / macOS** -- install into a directory you own:

```sh
mkdir GoTavern
cd GoTavern
curl -fsSL https://raw.githubusercontent.com/cocokoishi/GoTavern/main/install.sh | sh
./start.sh
```

**Windows (PowerShell)**:

```powershell
mkdir GoTavern
cd GoTavern
irm https://raw.githubusercontent.com/cocokoishi/GoTavern/main/install.ps1 -OutFile install.ps1
.\install.ps1
.\Start.cmd
```

Both installers install into the directory you are standing in; `--dir` / `-InstallDir` are the advanced
override. Pinning a version still works and is the right thing for a reproducible deployment:
`sh install.sh --version v0.1.0-alpha.9`.

**Docker**:

```sh
docker pull ghcr.io/cocokoishi/gotavern:latest
```

`ghcr.io/cocokoishi/gotavern:v0.1.0-alpha.9` is the same image addressed by tag. This is the first release for
which `:latest` is not stale.

**Manual**: download `gotavern-<os>-<arch>.tar.gz` (`.zip` on Windows) from the
[releases page](https://github.com/cocokoishi/GoTavern/releases), check it against the release's
`checksums.txt`, unpack it anywhere writable, and run `./start.sh` / `Start.cmd`.

Release asset download size: **362,117,822 bytes (about 345 MiB) across the six archives**, plus `checksums.txt`.

## Migration from SillyTavern

Two supported ways, both of which leave your data in the SillyTavern layout:

1. **Point GoTavern at the directory you already have.** Stop SillyTavern, then start GoTavern with the same
   working directory (or the same `config.yaml`). It reads the existing configuration and user tree as-is.
2. **Copy the runtime, keeping the original untouched.**
   `bash scripts/migrate-from-sillytavern.sh --source /path/to/SillyTavern --dest /path/to/GoTavern` copies the
   configured data root (including `_storage` and `cookie-secret.txt`) and never writes, renames, deletes or
   chmods anything in the source tree. An absolute `dataRoot` in `config.yaml` is refused rather than silently
   re-pointed, because copying the file unchanged would make GoTavern keep using the old source path.

For a consistent copy, stop SillyTavern first or copy from a filesystem snapshot. Node server plugins are the one
explicit ecosystem exclusion: they are not emulated, not faked and not migrated as supported functionality (see
Known limitations).

## Key verified workflows

These are the flows this project considers release-relevant, each with the gate that judges it. Run ids are
filled from the candidate run; a gate that did not run is not evidence and is not claimed here.

- **Startup on a stock SillyTavern tree.** A packaged archive is unpacked over a stock tree and booted, and the
  startup request set is compared against the pinned server. Prebuilt release qualified on Linux amd64:
  `GoTavern drop-in qualification` run 41171613198 (success). Startup differential over the pinned request set:
  `GoTavern CI` run 41171613196 (success), `verify` job.
- **Your data and extensions are left alone.** Auto-update resolves OFF for every ambiguous input (missing key,
  legacy key, `null`, unparsed value, unreadable or migrated config), and the long-lived-tree leg hashes the
  extension tree before and after boot and asserts it is unchanged: `GoTavern CI` run 41171613196 (success), `verify`
  job (`tests/e2e/longlived_test.go`).
- **Browser parity, on both subjects.** Avatars, card images, in-chat images, personas and thumbnails render from
  real served bytes; reload, swipe, regenerate and continue are each compared with their own comparator; a
  GoTavern-written tree is handed back to the pinned Node server and read again:
  `Browser differential` run 41171855911 (success, `mode: all`).
- **One continuous session, not eight experiments.** One stock tree per subject, one page lineage, and one user
  journey: load, settings read/change/save, characters, open an existing chat, send a message, a streamed reply,
  save, **reload the page**, verify the persisted reply, swipe, regenerate, continue, then **restart the server on
  the same tree** and keep working. Browser state, the provider request bytes and the files on disk are all
  compared, and the comparison is proven to have teeth by eleven mutations that each produce a named red:
  `GoTavern whole-session differential` run 41171620691 (success; 39/39 guards, 11/11 named mutations).
- **The 酒馆助手 / JS-Slash-Runner extension (ASCII: "Jiuguan Zhushou").** The extension iframe boots, the bridge
  reaches host modules, `generateRaw` produces a byte-identical request on both subjects, a helper variable's
  resolved value reaches the final request and survives a restart, and a preset mutated through the extension
  changes the next request identically: `Browser differential` run 41171855911 (success), helper legs. Its own UI
  and its in-iframe script editor are not covered.
- **Presets change the model context the way upstream does.** `Node(A) == Go(A)`, `Node(B) == Go(B)`, and A and B
  produce different requests from one implementation -- the three conditions that make a preset differential mean
  anything: `Browser differential` run 41171855911 (success), preset legs of the same `mode: all` run.
- **World info, Author's Note depth and context truncation.** World-info injection and Author's Note depth are
  compared on the provider wire; truncation is proven only at the measured boundary, because upstream's total
  message count is not monotone in `openai_max_context`: `GoTavern CI` run 41171613196 (success). The three
  world-info slot positions (`before`, `after`, `atDepth`) are additionally asserted to reach the final request in
  pinned's order by `GoTavern world-info slot ordering` run 41171073703 (success, 21/21 guards).
- **Streaming and cancellation.** Request bytes, chunk framing and frame terminators across a real TCP middle, and
  a mid-stream cut that releases the same partial text on both subjects:
  `Browser differential` run 41171855911 (success), streaming framing legs; `GoTavern CI` run 41171613196
  (success) asserts the transport properties directly. A graceful TLS shutdown mid-frame, the frame-ordering
  property and the cancelled-prefix property each have their own test rather than a recorded observation.
- **Provider wire.** Each claimed chat-completion source has recorded captures compared on target, method, header
  set, body bytes (SHA-256), chunked framing and client disconnect. Source and scenario counts for this commit:
  25 sources and 222 recorded scenarios (`docs/generated/facts.json`, generated from the tree by
  `tools/generate-doc-facts.mjs` and checked by CI on every run).
- **The release path itself.** Six canonical archives plus `checksums.txt`; both installers executed against a
  release-shaped mirror; an update and a cross-baseline rollback over one data root; and a published-release
  install smoke that resolves a real `github.com` URL over TLS, verifies every published digest, boots the
  installed binary and requires real tokenizer ids. Before publication, `GoTavern Release` run 41171860330
  (success) built and structurally inspected all six archives and ran the pre-publish equivalent: both installers
  with **no version argument** resolved `latest/download`, verified every digest, installed, and the installed
  Linux binary executed and reported `v0.1.0-alpha.9`; a tampered archive was refused. The published-bytes smoke
  runs against the live release after publication, once `releases/latest` points at it.
- **Docker.** The image is built, `assets verify` runs inside it, a pinned compatibility route is smoke-tested,
  and on a version tag the image is published and then **pulled back** and re-verified, because a successful push
  is not the same claim as a registry that serves a verifying image:
  `GoTavern Docker image` run 41170764941 (success) built the image, ran `assets verify` inside it and smoke-tested
  a pinned compatibility route before the tag; the tag-triggered run then publishes `:latest` and pulls both
  `:latest` and the version tag back to compare image IDs.

## Performance

One GitHub runner, both servers booted from the same pinned checkout with the same seeding and the same port
allocator. Read these as a same-machine comparison, not as a promise about your hardware; the ratios in the
figure merely restate the two values in each panel.

| Metric | Pinned Node SillyTavern | GoTavern (this release) | How it was measured |
|---|---|---|---|
| Cold start to first `/version` 200 | 9,941 ms | **32 ms** | median of 3 rounds, fresh data root each round, no `config.yaml` |
| Steady-state RSS (`VmRSS`) | 1,199 MB | **37.5 MB** | median of 6 samples after readiness and 30 requests per round |
| `GET /version` latency (median) | 28.77 ms | **0.32 ms** (p95 0.63 ms) | median of 90 sequential requests |
| `GET /` latency (median) | 10.22 ms | **1.52 ms** | median of 90 sequential requests |

Benchmark workflow run: `GoTavern smoke metrics` run 41171857944 (success; `measure-linux-amd64` and the paired
Node comparison job). A ten-minute soak per subject in the same run reported a GoTavern RSS drift of -1.4 MB and
a p95 drift of -0.06 ms, i.e. no sustained growth. A fast server that assembles a different prompt would be a bug,
not an improvement, which is why the compatibility gates run on the same commit as the benchmark.

## Known limitations

These are decisions, not bugs waiting to be fixed; each is recorded with its reason in `AGENTS.md` and
`docs/config-inventory.md`.

- **Arbitrary Node.js server plugins** are the one explicit ecosystem exclusion. They are not emulated and not
  faked. An extension that needs a plugin endpoint will not work.
- **Local in-process ML** (`/api/extra/caption`, `/api/extra/classify`, `/api/speech/*` and local embedding
  sources) would require an ONNX runtime inside the server, which contradicts the single-binary, no-cgo design.
- **Remote provider embeddings** answer an "unimplemented" status rather than an empty vector. Local or
  body-supplied vectors work.
- **Jimp byte equality** is not claimed for images. `/thumbnail` serves the observable contract -- a real image at
  the pinned path and dimensions -- with a pure-Go codec.
- **Wire formats that live inside third-party npm packages** (Google voice `batchexecute`, `/api/translate/google`
  and `/api/translate/bing`) are a recorded product decision rather than a port.
- **`git.backend: builtin`**: the system-git path is used, and you get a clear error if git is missing.
- **Per-chat backups** (`backups.chat.*`) are not reproduced: chat writes are atomic and whole-file, but there is
  no per-chat snapshot/restore net.
- **VERTEXAI service-account ("full") mode** answers the pinned error shape instead of fabricating a credential.
- **Inherited upstream weaknesses are reproduced, not silently fixed**: content import classifies a provider with
  the same substring host test upstream uses, so `chub.ai.attacker.example` is treated as chub. A "safer but
  different" backend would break parity as badly as a worse one.
- **Backgrounds are partially verified**: the gallery renders and stages tiles on both subjects, but paint and
  interaction behaviour are not measured.
- **Four of the six archives are not runtime-qualified.** The linux/amd64 and windows/amd64 archives are extracted,
  launched and booted against a stock tree in CI. The linux/arm64, darwin/amd64, darwin/arm64 and windows/arm64
  archives are **built and structurally inspected only** -- this project has no runner of those architectures, and
  the release notes do not claim otherwise. The Docker image is linux/amd64.
- **Multi-user contention is not gated.** Concurrent writes from two clients against one tree have not been
  exercised; single-user installations are the supported default.
- **Extension updates use the upstream mechanism.** `git pull` runs in place, exactly as upstream does; a dirty
  worktree is refused rather than forced, but the update itself is not an atomic file replacement.
- **Coverage is a taxonomy, not a boolean.** Where something cannot be observed, the compatibility matrix says
  `partial`, `unsupported` or `not implemented` with the reason, instead of going green by omission.

## Upgrade and rollback

**Upgrade.** Re-run the installer, or unpack a newer archive over the old install. Only immutable release files
are replaced: `gotavern` (`gotavern.exe`), the launcher, `LICENSE`, `THIRD_PARTY_NOTICES.txt`, `BUILD-INFO.txt`
and `src/tokenizers/`. `config.yaml`, `data/`, `extensions/` and `certs/` are never deleted, never rewritten, and
the target directory is never rebuilt. Upgrading from an `-alpha.8` install that carries the old `tokenizers/`
layout is handled: the runtime prefers `src/tokenizers/` and still accepts the legacy directory, so the installer
does not need to migrate your tree.

**Rollback.** The same operation with an older archive; CI executes it across two different commits and asserts
after every step the reported version, the binary's byte identity with the archive it came from, `assets verify`
from the install prefix, and that `config.yaml`, `data/`, `extensions/` and `certs/` survive -- including state the
newer release wrote, which the older release must then boot over and leave unchanged:
`GoTavern release qualification` run 41171862635 (success), `qualify-upgrade-rollback` job.

## Data safety

- **GoTavern reads the SillyTavern data layout directly.** There is no private database and no conversion, so a
  directory GoTavern has written can be handed back to pinned Node SillyTavern -- and back again. That round trip
  is a gate, not a promise: `Browser differential` run 41171855911 (success), hand-back judge in both directions.
- **Installers never touch runtime state.** They replace immutable release files only; `config.yaml`, `data/`,
  `extensions/` and `certs/` are preserved, and a re-install is idempotent.
- **Auto-update is OFF by default and every ambiguous input resolves to OFF.** A missing key, an unknown legacy
  key, `null`, an unparseable value, an unreadable config or a migrated config all mean "do not update".
- **Sensitive writes use the upstream formats and are atomic.** JSON/JSONL and card writes are staged and
  swapped, so an interrupted write leaves the previous file rather than a half-written one.
- **The migration source is read-only.** The copy path in `scripts/migrate-from-sillytavern.sh` never writes to
  the SillyTavern tree it is reading.
- **Back up before you upgrade anyway.** Keep the previous install directory and a copy of `data/`; a rollback is
  then a re-run of the installer with the older version.

## Reporting a problem

Include `gotavern version`, the `BUILD-INFO.txt` from your install directory, the exact installer command you ran,
and any server log lines around the failure. Issues: <https://github.com/cocokoishi/GoTavern/issues>.

## Licence

AGPL-3.0, consistent with the SillyTavern frontend GoTavern serves. The root `LICENSE` is copied from the pinned
SillyTavern source and `THIRD_PARTY_NOTICES.txt` ships in every release archive.

Release published: 2026-10-31.
