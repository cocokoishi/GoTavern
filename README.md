# GoTavern

[![GoTavern CI](https://github.com/cocokoishi/GoTavern/actions/workflows/ci.yml/badge.svg)](https://github.com/cocokoishi/GoTavern/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/cocokoishi/GoTavern?include_prereleases&label=release)](https://github.com/cocokoishi/GoTavern/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

**SillyTavern's backend, rewritten in Go. One binary. Same frontend, same data folder.**

## TL;DR

- **What it is:** a drop-in replacement for the SillyTavern 1.19.0 server. It serves the unmodified upstream frontend over the same routes, the same `config.yaml` and the same on-disk layout. Your characters, chats, groups, world info, presets, Quick Replies, secrets, themes and frontend extensions keep working. No conversion, no private database.
- **What you need:** nothing. No Node.js, no npm, no compiler. Download, unpack, run.
- **Why bother:** it starts in milliseconds and uses a fraction of the memory (table below).
- **Status:** `v0.1.0-alpha.8` plus an unreleased round. **This is an alpha.** Back up any data directory you can't afford to lose.
- **What doesn't work:** arbitrary Node server plugins, and SillyTavern's local in-process ML (captioning, classification, speech). Full list in [What won't work](#what-wont-work).

| | SillyTavern (Node) | GoTavern |
|---|---|---|
| Cold start to first `/version` 200 | 12,985 ms | **136 ms** |
| Steady-state memory (RSS) | 926 MB | **37 MB** |
| `GET /version` latency (median) | 34.05 ms | **0.42 ms** |
| `GET /` latency (median) | 12.18 ms | **1.67 ms** |

One GitHub runner, both servers from the same checkout. Details and caveats in [Performance](#performance).

## Install

Everything below downloads a **prebuilt archive**. Nothing compiles on your machine.

> **Pass the version explicitly.** The newest release is a prerelease, and GitHub's `releases/latest` only points at stable releases, so an unpinned install 404s. That's deliberate: an alpha should never be what a bare `curl | sh` hands a stranger. Once a stable tag exists, the flag becomes optional.

> **Both installers install into the current directory.** Create a folder, `cd` into it, run the installer. `--dir` / `-InstallDir` exist as an advanced override. The script comes from `main` because that is where the current-directory default lives; `--version v0.1.0-alpha.8` still pins the release that is downloaded.

**Linux / macOS**

```sh
mkdir GoTavern
cd GoTavern

curl -fsSL https://raw.githubusercontent.com/cocokoishi/GoTavern/main/install.sh | sh -s -- --version v0.1.0-alpha.8
./start.sh
```

**Windows (PowerShell)**

```powershell
mkdir GoTavern
cd GoTavern

irm https://raw.githubusercontent.com/cocokoishi/GoTavern/main/install.ps1 -OutFile install.ps1
.\install.ps1 -Version v0.1.0-alpha.8
.\Start.cmd
```

To install somewhere else: `.\install.ps1 -Version v0.1.0-alpha.8 -InstallDir "D:\Servers\GoTavern"`. `Start.cmd` finds its own location, so you can launch it from any shell.

**Docker**

```bash
docker pull ghcr.io/cocokoishi/gotavern:v0.1.0-alpha.8
```

`:latest` lags on purpose. It only moves when a **stable** tag is published, so it can't silently upgrade you onto an alpha.

**Manual:** download `gotavern-<os>-<arch>.tar.gz` (`.zip` on Windows) from the [releases page](https://github.com/cocokoishi/GoTavern/releases), check it against `checksums.txt`, unpack anywhere writable, run `./start.sh` / `Start.cmd`.

**Requirements:** a 64-bit Linux, macOS or Windows machine. The frontend, default content and tokenizer manifest are embedded in the binary. The tokenizer *data* ships in `src/tokenizers/` (the same path upstream uses), because token counts have to be exact rather than estimated.

### Updating and rolling back

Re-run the installer, or unpack a newer archive over the old install. The binary, the launcher and `src/tokenizers/` get replaced. `config.yaml`, `data/`, `extensions/` and `certs/` are never touched. Rolling back is the same operation with an older archive, and CI tests it across baselines.

### Migrating from an existing SillyTavern

Point GoTavern at your existing directory and start it. Auto-update resolves to OFF for every ambiguous input, and CI hashes the extension tree before and after boot to check nothing was modified.

## Performance

![GoTavern against pinned SillyTavern (Node), paired benchmark on one GitHub runner](docs/assets/benchmark.svg)

| Metric | Pinned Node SillyTavern | GoTavern | How it was measured |
|---|---|---|---|
| Cold start to first `/version` 200 | 12,985 ms | **136 ms** | median of 3 rounds, fresh data root each round, no `config.yaml` |
| Steady-state RSS (`VmRSS` from `/proc`) | 926 MB | **37 MB** | median of 6 samples, after readiness and 30 requests per round |
| `GET /version` latency | 34.05 ms | **0.42 ms** | median of 90 sequential requests (p95: 41.67 / 0.72) |
| `GET /` latency (HTML shell) | 12.18 ms | **1.67 ms** | median of 90 sequential requests |

**Read these as a same-machine comparison, not a promise.** They come from `GoTavern smoke metrics` run `40898332226` (success) on one shared GitHub runner: both servers booted from the same pinned checkout, same seeding, same port allocator. Expect different absolute numbers on your hardware. The ratios in the figure just restate the two values in each panel. A fast server that assembles a different prompt would be a bug, which is why the compatibility gates run on the same commit.

### A profile-driven fix

The paired benchmark says "cheaper than Node". It can't say "which function allocates". `internal/server/bench_test.go` can: it builds a real handler, does the product's own CSRF and login handshake, and measures a tiny route, the HTML shell, a static asset, settings aggregation and the character list.

The first profile found a real problem. Serving `/script.js` (497,669 bytes) allocated 1,010,107 B/op, and 66% of that was one `embed.FS.ReadFile` per request. A page load asks for about 229 assets, so the server was copying every asset into the heap every time. Static serving now resolves content lazily and streams the slice it already declared, with a re-read fallback so a failure can't send a short body under a declared `Content-Length`. Two benchmarks were added with teeth: `BenchmarkFrontendAsset` (one asset) and `BenchmarkManyFrontendAssets` (a page load's worth), plus `BenchmarkVersion` as the control.

| Benchmark | `ns/op` before → after | `B/op` before → after | `B/op` change |
|---|---:|---:|---:|
| `GET /script.js` (497,669 B) | 478,654 → **170,644** | 1,010,107 → **43,347** | **−95.7%** |
| `GET /` (HTML shell) | 662,703 → **408,641** | 773,647 → **68,060** | **−91.2%** |
| five assets (one page load) | 2,339,272 → **1,791,303** | 1,909,012 → **219,880** | **−88.5%** |
| `GET /version` (control, no asset) | 315,372 → 310,424 | 25,145 → 25,145 | 0% |

These are local, single-machine numbers (Windows/arm64, Go 1.27), before and after on the same machine, from `go test ./internal/server/ -run '^$' -bench Benchmark -benchmem -benchtime 300x`. They're an engineering baseline, not a product comparison. The `/version` row is the control: it serves no asset and didn't move, so the change was confined to static serving.

A second round removed per-request work from the authenticated path: the user record was re-read and re-parsed from disk on every request (40.4% of a request's CPU in the profile), so it is now cached against the file's own identity (absolute path, mtime, size — never a timeout) and re-read whenever that identity changes. Measured on the same host and session: `BenchmarkManyFrontendAssets` 1,888,743 → **1,288,362 ns/op** (−32%) and 1,116 → **900 allocs/op** (−19%).

## Compatibility

**Upstream is the oracle.** Baseline: SillyTavern `1.19.0`, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. Every claim below is checked against a pinned Node SillyTavern, never against memory or a mock of our own.

This table states only what a fresh run on the current commit shows. The repository history was rewritten on 2026-10-29 to normalise commit identities, which orphaned every commit that earlier CI runs had judged, so older evidence can't be attached to this tree. Everything here is anchored to [`docs/goal-scorecard.md`](docs/goal-scorecard.md), re-derived against the rewritten lineage.

| Question | State | Evidence |
|---|---|---|
| Does a long-lived SillyTavern directory start directly? | **verified** | packaged archive over a stock tree (`GoTavern drop-in qualification` 40903954848, success); a synthesised long-lived tree asserted file-identical after boot (`tests/e2e/longlived_test.go`) |
| Are my data and extensions left alone? | **verified** | auto-update resolves OFF for every ambiguous input; the long-lived leg hashes the extension tree before and after boot |
| Do avatars, card images, in-chat avatars, personas and thumbnails show up? | **verified** | `Browser differential` 40925514681: every image decoded on both subjects, no failed request, no console load failure. `/thumbnail` serves real thumbnails at pinned paths and dimensions from a pure-Go codec. **Byte equality with Jimp is not claimed.** |
| Do backgrounds display as in the original? | **partially verified** | the gallery renders and stages tiles on both subjects, and 40 UI elements are reachable identically across four viewport sizes. **Paint/behaviour is not measured:** the pinned frontend's own binding is absent on both subjects, so the differential is silent rather than negative. |
| Does 酒馆助手 / JS-Slash-Runner work? | **verified** | the same run's helper, helper-generation, helper-variable and REAL-preset legs: the iframe boots, the bridge reaches host modules, `generateRaw` is byte-identical on both subjects, a variable's resolved value reaches the final request and survives a restart, and a preset mutated in `in_use` changes the next request identically |
| Does *every* feature of that extension work? | **partially verified** | only the interactions above are proven. Its own UI, script editor and anything implemented purely inside the iframe aren't covered. |
| Does a complex preset change the model context exactly as upstream does? | **verified** | `Node(A) == Go(A)`, `Node(B) == Go(B)`, and A ≠ B within one implementation: the three conditions that make a preset differential mean something |
| World info, Author's Note depth, token truncation? | **verified** (truncation: at the measured boundary) | provider-wire replay for world info; the Q17 sweep for Author's Note; both subjects keep and drop the same turns in the same order. Truncation is **not** proven in general: upstream's total message count isn't monotone in `openai_max_context`. |
| Streaming and cancellation? | **partially verified** | request bytes and frame terminators across a real TCP middle, and a mid-stream cut releases the same partial text on both subjects. A mid-stream **TLS** close is unobserved, and no gate asserts the frame-ordering property itself. |
| Reload, swipe, regenerate, continue? | **verified** | `Browser differential` 40977195387 (success). Four verbs, each with its own comparator. The save/reload/swipe leg proves the two subjects were fed *different* bytes at a position neither compared request carries (in a separate sweep, run 40903953724, cancelled at its own timeout budget after that step had already passed). The continue request is selected by the product's own nudge marker, not by position. |
| Can I hand a GoTavern-written tree back to Node, and back again? | **verified** | `Browser differential` 40977195387: the external judge printed **hand-back verdict: match** in both directions with every count non-zero (GoTavern leg 5/5, pinned leg 17/17). One earlier execution of the same judge failed with `pinnedContinued` red (`answerPersisted: false` at a 60 s wait while the continue request had reached the provider) and passed on the next run. That was a persistence-window flake in the pinned frontend, not a product difference. The probe now records the page and chat-file tails when a timeout fires. **Limit:** the fixture is a synthetic derivation, so its own chunk relations are unproven. |
| Is it cheaper to run than Node? | **verified** | `GoTavern smoke metrics` 40898332226, see [Performance](#performance) |

### Coverage numbers

These are computed from the tree by `tools/generate-doc-facts.mjs` on every CI run. A mismatch fails the build.

| Area | State |
|---|---|
| Chat-completion providers | Every implemented pinned source except COMETAPI has recorded provider-wire captures (pinned itself refuses COMETAPI before sending any request). <!-- BEGIN GENERATED: provider-wire.summary -->`25` sources with recorded provider-wire captures; `222` recorded scenarios.<!-- END GENERATED: provider-wire.summary --> |
| Provider wire | Each claimed source is compared against captures: target, method, header set, body bytes (SHA-256), chunked framing, client disconnect. A control test fails if a source is claimed without a capture. |
| Browser legs | **<!-- BEGIN GENERATED: browser.sources -->`15`<!-- END GENERATED: browser.sources --> sources** carry both a generation and a streaming comparison artefact, enforced by `tools/verify-browser-comparisons.mjs`. |
| Startup | Differential over <!-- BEGIN GENERATED: startup.requests -->`353`<!-- END GENERATED: startup.requests --> requests. Characters, chats, groups, world info, settings and secrets have replay fixtures. |
| Release path | Fresh install, idempotent re-install, tampered-archive refusal, update and cross-baseline rollback run in CI against the real `install.sh` / `install.ps1`, plus the Windows-only installer behaviours. |

## What won't work

These are decisions, not bugs waiting to be fixed. Each one is `not implemented` for a stated reason. Full reasons live in [`docs/config-inventory.md`](docs/config-inventory.md) and `AGENTS.md`.

- **Arbitrary Node.js server plugins.** The one explicit ecosystem exclusion. Not emulated, not faked.
- **Local in-process ML** (`/api/extra/{caption,classify}`, `/api/speech/*`, local embeddings). It would need an ONNX runtime, which contradicts the single-binary, `CGO_ENABLED=0` design. Captioning, classification and speech via SillyTavern's built-in local models won't work.
- **Remote provider embeddings.** Every remote embedding source answers an "unimplemented" status instead of returning an empty vector. The routes exist, and local or body-supplied vectors work.
- **Jimp byte-equal image re-encoding.** `/thumbnail` serves the observable contract (real images at pinned dimensions); `/api/avatars/upload` keeps the bounded pixel path.
- **Wire formats inside third-party npm packages** (Google voice `batchexecute`, `/api/translate/{google,bing}`). Owning an undocumented protocol is a product decision, not an accident.
- **`git.backend: builtin`.** Upstream's builtin backend means isomorphic-git semantics, and a pure-Go equivalent is a large dependency with its own divergence. The value is accepted, the system-git path is used, and you get a clear error if git is absent.
- **Per-chat backups** (`backups.chat.*`). Upstream's throttled snapshot/prune subsystem isn't reproduced. Chat writes are atomic and whole-file, so a corrupt write isn't the risk, but there's no per-chat restore safety net.
- **VERTEXAI service-account ("full") mode.** Answers the pinned error shape rather than fabricating a credential.
- **Inherited upstream weaknesses are reproduced, not silently fixed.** Content-import host matching uses the same substring test upstream does, so `chub.ai.attacker.example` is treated as chub. A "safer but different" backend would break parity as badly as a worse one.

## How we decide something is compatible

"It opens and chats" doesn't count. Every claim is checked against a pinned Node SillyTavern on five surfaces: browser→server HTTP, server→provider request bytes, provider stream→browser, filesystem/startup side effects, and browser final state. Anything verified only against our own mock is `unverified`, whatever the fixture says.

Four rules, each born from a green check that proved nothing:

1. **Upstream is the oracle.** When outputs differ, check in this order: pinned capture → is the probe faithful → is the fixture discriminating → does the gate have teeth → only then suspect the Go code.
2. **Citations are ancestry-checked.** A run proves something only about the commit it judged. `internal/fixtures/documents_test.go` rejects a citation whose `head_sha` isn't an ancestor of the described commit, and a run id that isn't in `tests/docs/run-manifest.json`.
3. **Every gate has teeth.** Each comparator has a self-test that mutates what it guards and requires the named assertion to go red. `tools/verify-browser-comparisons.mjs` rejects an artefact whose required guards are false, missing or contradicted by its own `unproven` list.
4. **Tests come from upstream's own lists.** Every `router.use(...)` mount, endpoint router and frontend-built URL is an inventory row, diffed against the Go registrations. Per-route discovery is how three mounts stayed missing through months of green runs.

Where something can't be observed, the row says so instead of going green by omission. That's what `partial` and `unproven` mean.

### Where the status words live

One machine truth per fact:

| Layer | File | Granularity |
|---|---|---|
| User questions | [`docs/goal-scorecard.md`](docs/goal-scorecard.md) | 22 rows. `proven` means a cited run on the current lineage, or a committed artefact, shows it. |
| Capability matrix | [`docs/compatibility-matrix.md`](docs/compatibility-matrix.md) (generated) | 22 capability areas: `PASS` / `PARTIAL` / `FAIL` / `NOT_APPLICABLE`. A `PASS` row can't carry an evidence gap. |
| Per-route ledgers | [`docs/api-inventory.md`](docs/api-inventory.md), [`docs/surface-coverage.md`](docs/surface-coverage.md), [`docs/compat-matrix.md`](docs/compat-matrix.md) | every route / provider / fixture, with the fixture that pins it |

A capability can be `proven` for a narrow question and `PARTIAL` as an area; that's not a contradiction. If two layers disagree about the *same* fact, one is wrong, and that's a defect.

## Development

See `docs/development-loop.md` for tiers and measurements. `AGENTS.md`'s "Working mode" lists host artefacts to exclude first (a `gofmt -l` that flags the whole tree under `core.autocrlf=true`, and a Windows-only environment-variable case difference).

```bash
node scripts/dev-verify.mjs          # ~7 s: gofmt + build + the tests your change can break
node scripts/dev-verify.mjs --full   # ~2 min: the whole Go suite, including every fixture replay
```

CI keeps the expensive gates: the full Go suite, `go vet`, `go test -race` over the packages that own shared mutable state, cross-compiles, the browser comparison, the packaged-artifact drop-in qualification, and the Linux oracle that re-records every fixture and requires a zero diff.

## License

**AGPL-3.0**, consistent with the SillyTavern frontend it serves. The root `LICENSE` is copied from the pinned SillyTavern source, and `THIRD_PARTY_NOTICES.txt` ships in every release archive.
