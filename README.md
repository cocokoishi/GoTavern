# GoTavern

[![GoTavern CI](https://github.com/cocokoishi/GoTavern/actions/workflows/ci.yml/badge.svg)](https://github.com/cocokoishi/GoTavern/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/cocokoishi/GoTavern?include_prereleases&label=release)](https://github.com/cocokoishi/GoTavern/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

> **Status: `v0.1.0-alpha.8` — an ALPHA.** Not yet a daily driver for a data directory you cannot restore.
> **No defect that was reported from real use is still open** — the three that were (missing visual assets,
> 酒馆助手 not working, and no proof a real preset changes the model context) each now have a passing gate, and
> [Compatibility](#compatibility) names that gate per surface. What is still unproven is listed there too, rather
> than implied to be finished: backgrounds' paint half, handing a tree back to Node, and the CI verdict for the
> `continue` comparator fix described below. Keep a backup of your data directory.
>
> **What changed in the working tree after alpha.8** (unreleased; no tag names it yet). Two of these are
> user-visible on a fresh install:
>
> - **The browser now opens on startup**, as pinned does. GoTavern shipped the same `default/config.yaml`
>   (`browserLaunch.enabled: true`) and then declined to launch anything; `browserLaunch.browser` was never read.
>   It now honours the key, the named browsers and pinned's non-fatal failure message.
> - **`--help` goes to stdout and documents all 31 options**, as pinned's yargs does. It used to print five lines
>   of subcommands to stderr, so a redirected `--help` was empty and `--port`/`--dataRoot`/`--configPath` were
>   undiscoverable.
> - **The access log is written** when `listen: true` (pinned gates the middleware on that key too — it is *not*
>   default-on for a fresh install, and this README previously implied otherwise via the sweep it came from).
> - **The `continue` comparator defect is fixed.** `Browser differential` run `40837309332` on `292905f` failed at
>   `Compare the Q20 continue legs` with `failedGuards: ["nextRequestClean"]`. That was a **harness** defect, not a
>   product one: the probe's continuation marker embedded the peer's *arrival ordinal*, which is leg-specific by
>   design (the GoTavern leg produces the setup turns, the pinned leg is handed them), and that marker is persisted
>   into the chat and re-sent in the next request — so the two next-turn bodies differed by exactly one byte
>   (`..._3` vs `..._1`, both 4444 B, first and only difference at offset 4250). Both legs now render
>   `verdict: match` with 14/14 guards, verified locally on both subjects; the CI verdict for this commit is
>   pending and is not claimed here.
> - **A Windows-only class of false reds is closed.** A real Winsock errno never matched `errors.Is`, so an
>   occupied port and a refused provider connection both lost their causal error message on Windows; and four
>   tests were red there for host reasons. Details in `docs/local-red-triage.md`.

## TL;DR

GoTavern is a **standalone Go reimplementation of the SillyTavern 1.19.0 server/backend**. It is not a fork and
not a new client: it serves the **unmodified upstream frontend** over the **same HTTP routes, the same
`config.yaml` semantics and the same on-disk data layout**, so your existing characters, chats, groups, world
info, presets, Quick Replies, settings, secrets, themes and frontend extensions keep working without a conversion
step or a private database.

Normal use needs **no Node.js, no npm and no compiler** — releases are prebuilt single binaries with the frontend,
the default content and the tokenizer manifest embedded. Node/npm appear only in development, CI and reference
builds.

The practical gain is operational: in the paired benchmark below GoTavern starts in **61 ms** against Node's
**14,355 ms** and holds **37.3 MB** of steady RSS against **912.2 MB**. Those are one runner's numbers, restated
with their provenance, not a general multiplier.

Baseline: `SillyTavern 1.19.0`, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. Upstream is the oracle: every
compatibility statement in this README is checked against a **pinned Node SillyTavern** rather than against
memory.

## Performance

![GoTavern against pinned SillyTavern (Node), paired benchmark on runner ubuntu26](docs/assets/benchmark.svg)

The figure is generated from the recorded paired run, not drawn: every value below appears in
`docs/assets/benchmark.svg`, and every value in the SVG is from the run named in the provenance line.

| Metric | Pinned Node SillyTavern | GoTavern | Basis |
|---|---|---|---|
| Cold start to first `/version` 200 | 14,355 ms | **61 ms** | median of 3 rounds, empty data root, no `config.yaml` |
| Steady-state RSS (`VmRSS` from `/proc`) | 912.2 MB | **37.3 MB** | median of 6, sampled after readiness and after 60 requests |
| `GET /version` latency | 62.68 ms | **0.431 ms** | median of 90 sequential requests, same client both subjects |
| `GET /` latency (HTML shell, body consumed) | 14.17 ms | **2.20 ms** | median of 90 sequential requests |

**Provenance.** SillyTavern `1.19.0` (pinned commit `06bde939`), booted from the same checkout, with the same
data-root seeding and the same port allocator, on runner `ubuntu26`, three rounds of 30 sequential requests per
path. Workflow: **`GoTavern smoke metrics`, run `40396669521`** (success); the earlier paired run in the same
series is `40394799325` (success). Full methodology: [`docs/assets/benchmark.svg`](docs/assets/benchmark.svg).

These are runner-dependent numbers on a shared GitHub runner, produced so the comparison is same-machine rather
than cross-hardware. They are a restatement of two printed values per panel, not a benchmark suite, and not a
budget you should expect on your own hardware. The ratios printed in the figure are computed from the values in
each panel and are a restatement, not a separate measurement. Reproduce them with the `GoTavern smoke metrics`
workflow.

## Why GoTavern?

- **Drop-in, not a migration.** Point it at an existing SillyTavern directory — or copy one in read-only — and it
  uses the same tree. Return to Node SillyTavern whenever you like; there is no schema and nothing to convert.
- **The real frontend.** Pinned `public/**` is served byte-identically, so themes, extensions, 酒馆助手 /
  JS-Slash-Runner and UI features behave as they do upstream. GoTavern does not maintain a second frontend.
- **One static binary.** No runtime to install on the target machine, no `node_modules`, no build step.
  `CGO_ENABLED=0` and pure-Go dependencies throughout.
- **Cheap to run.** The numbers above are the reason this exists for a long-lived deployment: a small box, a NAS
  or a reverse-proxied VPS behaves differently at 37 MB than at 912 MB.
- **Fidelity as a method, not a slogan.** Compatibility is decided by differential tests against pinned Node on
  five observation surfaces — browser↔server HTTP, server→provider request bytes, provider stream→browser,
  filesystem/startup side effects, and browser final state — and the failures are listed below.

## Compatibility

Each row names what is **proven** and what is **not**. A capability is `proven` only where a committed artefact or
a cited CI run demonstrates it; [`docs/goal-scorecard.md`](docs/goal-scorecard.md) is the ledger those states come
from, row by row.

| Surface | State | Evidence |
|---|---|---|
| Long-lived SillyTavern directory boots and serves its own data | **proven** | `GoTavern drop-in qualification` and `GoTavern CI` boot a packaged archive against a stock tree; `tests/e2e/longlived_test.go` asserts every planted file byte-identical after boot |
| Existing data is not touched | **proven** | auto-update resolves to OFF for every ambiguous input; the long-lived leg hashes the extension tree before and after boot and asserts it unchanged |
| Character-list avatars, opened card image, in-chat avatars, personas, thumbnails | **proven** | `Browser differential` 40325398585 (success), `Compare the asset legs`: `imagesFailed: 0`, `consoleFailedToLoad: 0`, every avatar decoded on both subjects. `/thumbnail` is implemented — it serves real thumbnails from a pure-Go codec at pinned paths and dimensions (160x90 for backgrounds, 96x144 for avatars and personas), gated by `TestPinnedThumbnailServesTheObservableContract`. **Byte equality with Jimp is not claimed** (see boundaries); the images render, which is what a user sees |
| Backgrounds display as in the original | **partial** | the gallery renders and stages tiles on both subjects; the **paint/behaviour half is not measured**. Reachability of 40 UI elements across four viewport sizes is proven separately by `Browser differential` 40476300686 (success) |
| 酒馆助手 / JS-Slash-Runner: the iframe boots and the bridge reaches the host page | **proven** | `Browser differential` 40325398585 (success), `Record`/`Compare the helper legs`: the iframe boots, the bridge reaches the host modules, and the leg fails itself if helper-off and helper-on produce identical captures |
| 酒馆助手: `generateRaw` / `generate` reach the provider identically | **proven** | `Browser differential` 40378609525 (cited for the step `first-turn-saved: ok` inside a run that failed later, at reload): the `generateRaw` request is byte-identical to pinned's, and `message_sent`/`message_received` fire |
| 酒馆助手: variables persist and reach the final request | **proven** | `Browser differential` 40250495167 (success) persistence; 40493990375 (cited for its `valueOnWire` guards, which went green inside it): a variable's resolved value occupies a slot in the captured provider body |
| 酒馆助手: injection changes the model context | **proven** | `Browser differential` 40378609525 (same step-level citation as above): depth-0 injected text appears in the captured request on both subjects and is absent when injection is off |
| 酒馆助手: a preset mutated in `in_use` affects the next generation | **proven** | `Browser differential` 40277640647 (success): before/after pairs identical across subjects and different from each other |
| 酒馆助手: every feature the extension offers | **partial** | what is proven is the list above — boot, generation, variables, injection and `in_use` mutation. The extension's own breadth (its UI surface, its script-editor workflows, anything it implements purely in the iframe) is **not** covered by these legs; a feature the helper reaches through a route or a user file is our obligation and is gated per route in the ledgers, but "the extension works" is a bigger claim than "these five interactions match pinned" |
| A real complex preset changes the model context exactly as pinned does | **proven** | `Browser differential` 40274214952 (success): presets differ from each other **and** `Node(X) == Go(X)`; extended to the real preset derivations by 40387864205 (success) |
| Author's Note depth | **proven** | `Browser differential` 40465631698 (cited for steps 26-28, all success): parity at depths 0/4/8, disabled and `IN_PROMPT`, byte-identical provider requests. **Limit:** one at-depth case is unmeasurable in the product's own trimmer and is recorded as `null`, not as a pass |
| Token truncation at the context boundary | **proven at the measured boundary** | 40465631698 step 25 (success): both subjects keep and drop the same turns at `keep` and `keep-1`. **Not** "truncation proven in general" — pinned's total message count is not monotone in `openai_max_context` |
| World-info activation | **proven** | `GoTavern CI` 40398345829 (success): provider-wire captures including the world-info routes, byte-identical on re-record |
| Streaming and helper events | **partial** | cut/abort is **proven**: `Browser differential` 40682654579 (success) drives the abort leg with a byte-offset cut on a frame boundary, and both subjects render the same partial text. The row stays `partial` for two other reasons the matrix names: a mid-stream TLS close is unobserved, and no gate asserts the ordering property itself. A buffering-hop render claim is not provable by the current harness and the artefact says so |
| Reload, swipe, regenerate, continue | **partial** | save→reload→swipe proven (40387864205, success; five consecutive green runs since). Regenerate proven equality with a negative control. **Continue: the comparator now reports `verdict: match` with 14/14 guards, measured locally on both subjects after the harness defect below was fixed — the CI verdict for this commit is PENDING and the row does not claim it.** The defect was in the harness, not the product: see the status block above, and `tests/browser/q20-continue-comparator-selftest.mjs`, which now kills all 14 guards by name |
| Handing a GoTavern-written tree back to pinned Node | **unproven** | the hand-back leg is red at its own precondition: the committed card derivation carries different names in its `chara` and `ccv3` chunks, which pinned's reader resolves differently. A fixture defect, not a product finding — and therefore not a claim |
| CPU/RAM/startup versus Node | **proven** | `GoTavern smoke metrics` 40394799325 (success), 40396669521 (success) — the figures in [Performance](#performance) |

### Provider and route coverage

| Area | State |
|---|---|
| Chat-completion providers | All implemented pinned sources except COMETAPI carry recorded provider-wire captures (pinned itself refuses COMETAPI before any request). <!-- BEGIN GENERATED: provider-wire.summary -->`25` sources with recorded provider-wire captures; `222` recorded scenarios.<!-- END GENERATED: provider-wire.summary --> |
| Provider wire | Every claimed source is compared against captures: request target, method, header set, body bytes (SHA-256), chunked framing, client-disconnect. A control test fails if a source is claimed without a capture. |
| Browser legs | **<!-- BEGIN GENERATED: browser.sources -->`15`<!-- END GENERATED: browser.sources --> sources** carry both a generation and a streaming comparison artefact, printed and enforced by `tools/verify-browser-comparisons.mjs`. |
| Startup | Startup differential over <!-- BEGIN GENERATED: startup.requests -->`353`<!-- END GENERATED: startup.requests --> requests; characters, chats, groups, world info, settings and secrets have replay fixtures. |
| Release path | Fresh install, idempotent re-install, tampered-archive refusal, update **and cross-baseline rollback** run in CI against the real `install.sh` / `install.ps1`, alongside the Windows-only installer behaviours. |

### Explicit boundaries

**Read this before you migrate.** These are decisions, not gaps waiting to close. Each is `not implemented` for a
stated reason and is never absorbed into a `partial` row:

- **Arbitrary Node.js server plugins** — the one explicit ecosystem exclusion. Not emulated, not faked; a route
  that needs one reports that boundary.
- **Local in-process ML** (`/api/extra/{caption,classify}`, `/api/speech/*`, local embeddings) — it would mean
  adopting an ONNX runtime, which contradicts the single-binary, `CGO_ENABLED=0` distribution. If your workflow
  uses captioning, classification or speech through SillyTavern's built-in local models, it will not work here.
- **Two image-re-encoding routes** (`/api/avatars/upload`'s pixel path and `/thumbnail/<computed>`) — governed by
  a Jimp-compatible codec decision. `/thumbnail` serves real thumbnails at pinned dimensions, so images **do**
  render; what is not claimed is byte equality with Jimp's output. Uploading a persona avatar still goes through
  the bounded pixel path rather than a Jimp-equivalent re-encode.
- **Wire formats that live inside third-party npm packages** (Google voice `batchexecute`,
  `/api/translate/{google,bing}`) — owning an undocumented protocol is a product decision, not an accident.
- **Inherited upstream weaknesses are reproduced and recorded, not silently fixed** — content-import host
  matching is one; a "safer but different" backend would break parity as badly as a worse one. If you relied on
  SillyTavern's behaviour, you get it; if you relied on it being safe, it is not, and never was.

Also stated rather than implied: VERTEXAI service-account ("full") mode carries the pinned error shape rather
than a fabricated credential; `gemini.apiVersion` is a config value that is not projected; COHERE streaming is
recorded as **not measured** because the harness cannot yet speak Cohere's v2 SSE framing; and a prerelease's
`releases/latest` URL is intentionally 404, so **unpinned** installer invocations fail by design until the first
stable release.

## Download / Quick Start

Every path downloads a **prebuilt archive**; nothing is compiled on the target machine.

**[→ All releases](https://github.com/cocokoishi/GoTavern/releases)** — `v0.1.0-alpha.8` is the current
prerelease.

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/cocokoishi/GoTavern/v0.1.0-alpha.8/install.sh | bash -s -- --version v0.1.0-alpha.8
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/cocokoishi/GoTavern/v0.1.0-alpha.8/install.ps1 -OutFile install.ps1
.\install.ps1 -Version v0.1.0-alpha.8
```

**An explicit `--version` / `-Version` IS REQUIRED WHILE THE NEWEST RELEASE IS A PRERELEASE.** Without it the
installers fetch `releases/latest/download/...`, which GitHub resolves to the newest **stable** release — and
there is none yet, so that URL 404s. That is deliberate: a prerelease must never be what an unpinned
`curl | bash` hands a stranger. Once a stable tag exists the flag becomes optional.

**Docker**

```bash
docker pull ghcr.io/cocokoishi/gotavern:v0.1.0-alpha.8
```

`:latest` deliberately lags — it only moves when a **stable** tag is published, so `docker pull ...:latest`
cannot silently upgrade a deployment onto an alpha.

**Manual**, if you prefer an archive: download `gotavern-<os>-<arch>.tar.gz` (or `.zip` on Windows) from the
release page, verify it against `checksums.txt`, unpack it anywhere writable, and run `./start.sh` /
`Start.cmd`.

### Updating

An update is the same archive unpacked over the old install. The binary, the launcher and `src/tokenizers/` are
immutable release files and are replaced; `config.yaml`, `data/`, `extensions/` and `certs/` are never touched.
Rolling back is the same operation with an older archive, and it is exercised cross-baseline in CI.

**Requirements:** a 64-bit Linux, macOS or Windows host. No runtime dependencies. The frontend, the default
content and the tokenizer *manifest* are embedded in the binary; the tokenizer **data** ships as
`<install root>/src/tokenizers/` — the same path upstream SillyTavern keeps, because token counts must be exact
rather than approximated, and a missing tree would silently fall back to estimates while still answering.

## How compatibility is decided

Compatibility here is not "it opens and chats". Every claim is checked against a **pinned Node SillyTavern** on
five observation surfaces: browser→server HTTP, server→provider request bytes (target, method, headers, body
SHA-256), provider stream→browser, filesystem/startup side effects, and browser final state. A behaviour verified
only against our own mock is `unverified`, whatever the fixture says.

Where a surface cannot be observed, the row says so instead of going green by omission — that is what the
`partial` and `unproven` rows above are. The five classes a gap can belong to (verified this round, current
defect, unproven, harness failure, explicit boundary) are enumerated in
[`docs/goal-scorecard.md`](docs/goal-scorecard.md) §2.

The authority, in order: [`docs/goal-scorecard.md`](docs/goal-scorecard.md) for per-question evidence,
[`GOAL.md`](GOAL.md) for the locked goal and its acceptance questions, [`ARCHITECTURE.md`](ARCHITECTURE.md) and
[`docs/SEMANTIC-COMPATIBILITY.md`](docs/SEMANTIC-COMPATIBILITY.md) for the design contracts, and
[`docs/api-inventory.md`](docs/api-inventory.md) / [`docs/compat-matrix.md`](docs/compat-matrix.md) /
[`docs/surface-coverage.md`](docs/surface-coverage.md) for the per-route ledgers. Every partially-covered row
labels its evidence as measured, derived, or not covered. The reachable ceiling is the route count **minus** the
boundaries above, and the ledgers say so per row rather than implying full parity.

## Development

`docs/development-loop.md` lists the tiers and the measurements. **The loop is not limited to CI:** the host can
build (`go build ./...`, 20.7 s), run the whole Go suite (`go test ./...`, 434 s) and drive the browser
differential end to end (both legs plus the comparator), so a failure can be reproduced locally before a CI run is
spent. `AGENTS.md`'s "Working mode" carries those measurements and the two host artefacts to exclude first — a
`gofmt -l` that flags 173 files because `core.autocrlf=true` checks the tree out as CRLF, and a Windows-only
environment-variable case difference that used to make four tests red for host reasons.

```bash
node scripts/dev-verify.mjs          # ~7 s: gofmt + build + the tests your change can break
node scripts/dev-verify.mjs --full   # ~2 min: the whole Go suite, including every fixture replay
```

`node scripts/dev-verify.mjs` classifies your diff against `origin/main` and runs the smallest falsifying set
(measured: 7.2 s for a one-file provider edit). CI keeps the expensive gates: the full suite, `go vet`, the
cross-compiles, the browser comparison gate, and the Linux oracle that re-records every fixture and requires a
zero diff.

Provider work does not wait for the full oracle: a push selects only the probes whose inputs can move, and the
oracle job publishes any re-recorded bytes as a patch — [`docs/oracle-record-loop.md`](docs/oracle-record-loop.md)
and `scripts/apply-oracle-rerecord.mjs` do the mechanical part and refuse on the two hazards that invalidate a
patch.

Read [`AGENTS.md`](AGENTS.md) before changing anything, and [`HANDOFF.md`](HANDOFF.md) for the current
checkpoint. They carry the verification rules this project learned the hard way — mutations that cannot fail,
fixtures that prove only themselves, `go test` caches, and the two ways a run id turns out to belong to a
different workflow.

## License

GoTavern is released under **AGPL-3.0**, consistent with its use of the SillyTavern frontend. The root `LICENSE`
is copied from the pinned SillyTavern source, and `THIRD_PARTY_NOTICES.txt` ships in every release archive.
