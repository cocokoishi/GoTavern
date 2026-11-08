# GoTavern

**SillyTavern 1.19.0's server, rewritten in Go: one prebuilt binary, no Node.js on the host, the unmodified upstream frontend and the same `data/` layout.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/benchmark.svg">
  <img src="docs/assets/benchmark-light.svg" alt="Paired benchmark, one GitHub runner, both servers from the same checkout: GoTavern cold-starts in 165 ms against Node's 14,515 ms (87.97x faster), holds 40.5 MB RSS against 915 MB (22.60x lighter), answers GET /version in 0.429 ms against 65.55 ms (152.9x faster) and GET / in 8.59 ms against 13.78 ms (1.60x faster). Each row has its own zero-based axis whose maximum is printed; method and caveats are in the Performance section." width="1200">
</picture>

Medians of 3 alternating rounds on ONE shared GitHub runner, both servers from the same checkout, regenerated from one recorded artifact. Continue to [Compatibility](#compatibility) · [Performance](#performance) · [Install](#install) · [Development](#development).

## Start in 30 seconds

**Linux / macOS**

```sh
mkdir GoTavern && cd GoTavern
curl -fsSL https://raw.githubusercontent.com/cocokoishi/GoTavern/main/install.sh | sh
./start.sh
```

**Windows (PowerShell 5.1+)**

```powershell
mkdir GoTavern; cd GoTavern
irm https://raw.githubusercontent.com/cocokoishi/GoTavern/main/install.ps1 -OutFile install.ps1
.\install.ps1
.\Start.cmd
```

Both installers download a **prebuilt archive** — nothing compiles on your machine — into the current directory. A production host needs no Go, Node.js, npm, Python or compiler. Docker, manual downloads, updates, rollback and migration are in [Install](#install).

## Compatibility

**The strong drop-in bar in [`GOAL.md` §14](GOAL.md) is NOT MET, and this README does not claim it.** The strongest executed claim is a **synthetic adversarial qualification**: an audit of the production code, a deterministic scenario factory, and real-browser differentials over a Go-synthesised long-lived tree, a stock SillyTavern tree and a packaged archive. No real, long-used user directory has been qualified; that channel's disposition is `PRIVATE_NOT_RUN`.

Upstream is the oracle. Baseline: SillyTavern `1.19.0` at commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. A claim is checked on five observer surfaces, and "it opens and chats" is not evidence:

- browser→server requests and responses, and the provider stream and errors→browser;
- server→provider request bytes;
- filesystem and startup side effects, and the browser final state and events.

Three rules make a green mean something:

1. Upstream capture is the oracle; when outputs differ, check the probe, the fixture and the gate's teeth before suspecting the Go code.
2. A run proves only the commit it judged.
3. Every gate has teeth, shown by a mutation that goes red by name; the test inventory comes from upstream's own route and URL lists, not from whatever a probe happened to touch.

Mock-only observations are `unverified`. What the executed scope covers:

- the unmodified pinned frontend over the pinned route surface (**0** unknown surfaces);
- provider-wire captures for every implemented chat-completion source;
- 20 pinned third-party extensions that each install, activate, persist a setting across a restart and uninstall on both subjects;
- the whole-session and hand-back differentials, plus startup, rollback and migration paths against prebuilt archives.

| Limit | State, dated 2026-11-07 |
|---|---|
| Real, long-used user directory (`GOAL.md` §14) | **NOT MET** — private channel `PRIVATE_NOT_RUN` |
| macOS ARM64 runtime | **UNVERIFIED** — archive built and inspected; the arm64 macOS runner has been unavailable since 2026-11-05 |
| `windows/arm64` | **BUILD-ONLY** — no hosted runner of that architecture exists |
| 8-user concurrent-write latency | **REPORT-ONLY** — same-code spread 1.95x/2.29x tracks each host's sync-write tail; no graded number claimed |
| Soak real-leak question | **UNPROVEN** — the GC-robust rule is a detection floor (10% third-mean rise / 4 MiB floor over 45 min) |
| Real kernel ENOSPC | **UNPROVEN** — the chaos proof covers errno classification, not a real full disk |
| Streaming-cancellation and provider-relay p99 | **UNPROVEN** — no time-to-first-byte, inter-frame or relay-under-load metric exists |
| Page-init egress hermeticity | **OPEN** — some browser page initialisation still reaches the live network |

Machine truth per fact: [docs/goal-scorecard.md](docs/goal-scorecard.md) (22 user questions), [docs/compatibility-matrix.md](docs/compatibility-matrix.md) (22 capability areas, generated), [docs/compat-matrix.md](docs/compat-matrix.md) and [docs/surface-coverage.md](docs/surface-coverage.md) (per-route ledgers). The pass standard is [docs/SEMANTIC-COMPATIBILITY.md](docs/SEMANTIC-COMPATIBILITY.md).

## Performance

| Metric | Pinned Node SillyTavern | GoTavern | How it was measured |
|---|---|---|---|
| Cold start to first `/version` 200 | 14,515 ms | **165 ms** | median of 3 alternating rounds on ONE shared runner, fresh data root each round, no `config.yaml` |
| Steady-state RSS (`VmRSS` from `/proc`) | 915 MB | **40.5 MB** | median of 6 samples after readiness and 30 requests per path (60 per round) |
| `GET /version` latency | 65.55 ms | **0.429 ms** | median of 90 sequential requests (p95: 70.33 / 0.596) |
| `GET /` latency (HTML shell) | 13.78 ms | **8.59 ms** | median of 90 sequential requests; GoTavern's number includes gzip CPU |

Memory is decimal MB (1 MB = 1,000,000 bytes); every other number is milliseconds. One committed artifact, [`tests/perf/q22-baseline.json`](tests/perf/q22-baseline.json), is the source of this table, both figure variants and the [provenance record](docs/assets/benchmark.svg.provenance.md); `tools/check-perf-docs.mjs` recomputes all of them in CI. The record is `GoTavern smoke metrics` run `42012475880` (success) at commit `f1396ce`, one shared runner, both servers booted from the same pinned checkout; read it as a same-machine comparison, not a promise.

- **Regressions are shown, not hidden.** `/` carries gzip CPU because the HTML shell is compressed, and this release does not claim an improvement in these four headline metrics — every delta from the previous record is 1-6%, inside this harness's run-to-run variation.
- A ten-minute soak per subject recorded GoTavern RSS drift `-0.1 MB` and p95 `+0.35 ms` (pinned: `-571 MB` RSS, `-3.29 ms` p95). The methodology, the shipped optimization's on/off arms with the cost beside the gain, the resource analysis, the reproduction commands and the explicit UNPROVEN rows are in **[docs/performance.md](docs/performance.md)**.

## Install

Everything below downloads a **prebuilt archive**; nothing compiles on your machine. The two one-line installs are in [Start in 30 seconds](#start-in-30-seconds) — this section covers the rest.

Six canonical archives are published: linux and darwin (amd64, arm64) and Windows (amd64, arm64), each with `checksums.txt` and `BUILD-INFO.txt`. **Every published archive except `windows/arm64` is executed by release CI**: linux/amd64 and windows/amd64 boot against a stock tree, linux/arm64 runs under QEMU, darwin/amd64 runs on a native macOS runner, and darwin/arm64 is built and archive-inspected but **not executed** (recorded platform limitation). Tokenizer data ships in `src/tokenizers/` so counts are exact, not estimated.

- **Docker:** `docker pull ghcr.io/cocokoishi/gotavern:latest` (linux/amd64). `:latest` moves only when a stable tag is published, and never for a prerelease.
- **Manual:** download `gotavern-<os>-<arch>.tar.gz` (`.zip` on Windows) from the [releases page](https://github.com/cocokoishi/GoTavern/releases), verify it against `checksums.txt`, unpack anywhere writable, run `./start.sh` / `Start.cmd`.
- **Update / rollback:** re-run the installer or unpack a newer archive over the old install. The binary, launchers and `src/tokenizers/` are replaced; `config.yaml`, `data/`, `extensions/` and `certs/` are never touched. Rollback is the same operation with an older archive and is tested across baselines.
- **Migrate an existing SillyTavern:** point GoTavern at the existing directory, or run `gotavern migrate`. The source is strictly read-only during a copy migration, symlinks are refused rather than followed, and a destination holding runtime state is refused unless `--force` moves it to `.migrate-backup/` first. Auto-update resolves to OFF for every ambiguous input. GoTavern reads and writes SillyTavern's own files: unknown fields and unknown files are preserved, there is no conversion layer and no private database, and the do-not-rewrite boundaries in [`GOAL.md` §15.4](GOAL.md) stay intact.

Full platform matrix, installer behaviour, preflight refusals and acceptance evidence: **[docs/INSTALLATION.md](docs/INSTALLATION.md)**.

## What works, what is partial, what is not implemented

| Area | State |
|---|---|
| Pinned frontend, static assets, startup/config/data semantics | implemented and differentially gated |
| World info; streaming SSE framing, incremental render and cancellation | **PASS** in the capability matrix; every other capability row is `PARTIAL` with its gap named in the row, not implied |
| Chat-completion providers | <!-- BEGIN GENERATED: provider-wire.summary -->`25` sources with recorded provider-wire captures; `262` recorded scenarios.<!-- END GENERATED: provider-wire.summary --> |
| Browser differential legs | <!-- BEGIN GENERATED: browser.sources -->`15`<!-- END GENERATED: browser.sources --> source pairs carry both a generation and a streaming comparison artefact |
| Startup differential | over <!-- BEGIN GENERATED: startup.requests -->`353`<!-- END GENERATED: startup.requests --> recorded requests, with replay fixtures for characters, chats, groups, world info, settings and secrets |

**Not implemented, by recorded decision rather than omission:**

| Exclusion | Reason |
|---|---|
| Arbitrary Node.js server plugins | the one explicit ecosystem exclusion; never emulated |
| Local in-process ML (`/api/extra/{caption,classify}`, `/api/speech/*`, local embeddings) | would need an ONNX runtime and break the single-binary, `CGO_ENABLED=0` design |
| Remote provider embeddings | the routes exist and answer an unimplemented status rather than an empty vector |
| Jimp byte-equal image re-encoding | `/thumbnail` serves real images at pinned dimensions; byte equality is not claimed |
| Wire formats owned by third-party npm packages (Google voice `batchexecute`, `/api/translate/{google,bing}`) | owning an undocumented protocol is a product decision, not an accident |
| `git.backend: builtin` | the system-git path is used, with a clear error if git is absent |
| Per-chat backups (`backups.chat.*`) | no per-chat restore safety net; chat writes stay atomic and whole-file |
| VERTEXAI service-account ("full") mode | answers the pinned error shape instead of fabricating a credential |

Inherited upstream weaknesses are reproduced and recorded, not silently fixed — content-import host matching keeps upstream's substring test (`chub.ai.attacker.example` is treated as chub).

## Release status

[![GoTavern CI](https://github.com/cocokoishi/GoTavern/actions/workflows/ci.yml/badge.svg)](https://github.com/cocokoishi/GoTavern/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/cocokoishi/GoTavern?label=release)](https://github.com/cocokoishi/GoTavern/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

**`v0.1.0-alpha.18` is the release this tree ships.** It is built and published by the release workflow from this tree's commit, and the [releases page](https://github.com/cocokoishi/GoTavern/releases/latest) is authoritative for what is published right now. An unpinned install resolves `releases/latest`; pin a version for a reproducible deployment or a rollback target.

- The channel rule is one script, [`scripts/classify-version-tag.sh`](scripts/classify-version-tag.sh), shared by the release workflow, the Docker workflow and both installers: only a stable tag moves `:latest` and `releases/latest`.
- `v0.1.0-alpha.17` was the previous stable-channel release; earlier releases stay downloadable by explicit version. Back up any data directory you cannot afford to lose before upgrading.
- The [release notes](docs/release-notes-v0.1.0-alpha.18.md) carry the same limits; this README states them up front rather than below the fold.

## Development

Development and CI use Go 1.27+ and Node 24; production does not. Quick local loop:

```bash
node scripts/dev-verify.mjs          # ~7 s: gofmt + build + the tests your change can break
node scripts/dev-verify.mjs --full   # ~2 min: the whole Go suite, including every fixture replay
```

CI keeps the expensive gates: the full Go suite, `go vet`, `go test -race` over the packages that own shared mutable state, cross-compiles, the browser comparison, the packaged-artifact drop-in qualification, and the Linux oracle that re-records every fixture and requires a zero diff. A local green is not the CI gate; the two measured Windows host artefacts to exclude first are in [docs/development-loop.md](docs/development-loop.md) and `AGENTS.md` ("Working mode").

Detailed documentation: [docs/performance.md](docs/performance.md) · [docs/SEMANTIC-COMPATIBILITY.md](docs/SEMANTIC-COMPATIBILITY.md) · [docs/goal-scorecard.md](docs/goal-scorecard.md) · [docs/compatibility-matrix.md](docs/compatibility-matrix.md) · [docs/INSTALLATION.md](docs/INSTALLATION.md) · [docs/development-loop.md](docs/development-loop.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [AGENTS.md](AGENTS.md) · [docs/](docs/).

## License

**AGPL-3.0**, consistent with the SillyTavern frontend it serves. The root [`LICENSE`](LICENSE) is copied from the pinned SillyTavern source, and `THIRD_PARTY_NOTICES.txt` ships in every release archive.
