# GoTavern

[![GoTavern CI](https://github.com/cocokoishi/GoTavern/actions/workflows/ci.yml/badge.svg)](https://github.com/cocokoishi/GoTavern/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/cocokoishi/GoTavern?include_prereleases&label=release)](https://github.com/cocokoishi/GoTavern/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

> **Status: `v0.1.0-alpha.6` — an ALPHA.** Not yet a daily driver for a data directory you cannot restore.
> **No known blocking defect is open against the surfaces below**; what is still unproven is listed explicitly in
> [Compatibility](#compatibility) rather than advertised as finished. Keep a backup of your data directory.

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
**14,355 ms** and holds **37 MB** of steady RSS against **912 MB**. Those are one runner's numbers, restated with
their provenance, not a general multiplier.

Baseline: `SillyTavern 1.19.0`, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. Upstream is the oracle: every
compatibility statement in this README is checked against a **pinned Node SillyTavern** rather than against
memory.

## Performance

<!-- BENCHMARK-BLOCK: owned by the lane producing docs/assets/benchmark.svg. The table below is the
     authoritative structure; numbers already established by `GoTavern smoke metrics` 40394799325
     (success) and 40396669521 (success) on runner ubuntu26, both subjects measured in the same workflow
     with a 10-minute soak: boot 14,355 ms (Node) vs 61 ms (GoTavern); steady RSS 912 MB vs 37 MB;
     GET /version 62.7 ms vs 0.43 ms. Do NOT extend this table with any figure a run does not contain. -->

<!-- BENCHMARK-SVG-SLOT: the lane producing docs/assets/benchmark.svg replaces this comment with
     ![Startup time and steady memory, GoTavern against pinned Node SillyTavern](docs/assets/benchmark.svg)
     once that file exists. It is deliberately NOT referenced yet: an image reference to a missing file
     renders as a broken image on the release page, which is worse than no chart. -->

| Metric | Pinned Node SillyTavern | GoTavern | Basis |
|---|---|---|---|
| Boot to serving | 14,355 ms | **61 ms** | `GoTavern smoke metrics` 40394799325 (success), 40396669521 (success) |
| Steady-state RSS | 912 MB | **37 MB** | same two runs, 10-minute soak on both subjects |
| `GET /version` latency | 62.7 ms | **0.43 ms** | same two runs |

**Provenance.** Runner `ubuntu26`, both subjects measured in the same workflow on the same hardware, each soaked
for ten minutes before the steady figures are taken. These are point measurements from two runs on one runner
class, not a benchmark suite: no multiplier is claimed, and you should expect different absolute numbers on
different hardware. The paired measurement exists so the comparison is same-machine, not to promise a ratio.

Reproduce it with `GoTavern smoke metrics`; the numbers live in that workflow's output, and the compatibility
claim they sit beside is gated by the suites under [Compatibility](#compatibility).

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
| Character-list avatars, opened card image, in-chat avatars, personas | **proven** | `Browser differential` 40325398585 (success), `Compare the asset legs`: `imagesFailed: 0`, `consoleFailedToLoad: 0`, every avatar decoded on both subjects |
| Backgrounds display as in the original | **partial** | the gallery renders and stages tiles on both subjects; the **paint/behaviour half is not measured**. Reachability of 40 UI elements across four viewport sizes is proven separately by `Browser differential` 40476300686 (success) |
| 酒馆助手 / JS-Slash-Runner iframe, generation, variables, injection | **proven** | `Browser differential` 40325398585 (success) helper legs; `generateRaw` request byte-identical to pinned's (40378609525, cited for a step that passed inside a failed run); helper variables reach the final provider request; depth-0 injection appears in the captured request on both subjects |
| A real complex preset changes the model context exactly as pinned does | **proven** | `Browser differential` 40274214952 (success): presets differ from each other **and** `Node(X) == Go(X)`; extended to the real preset derivations by 40387864205 (success) |
| Author's Note depth | **proven** | `Browser differential` 40465631698 (cited for steps 26-28, all success): parity at depths 0/4/8, disabled and `IN_PROMPT`, byte-identical provider requests. **Limit:** one at-depth case is unmeasurable in the product's own trimmer and is recorded as `null`, not as a pass |
| Token truncation at the context boundary | **proven at the measured boundary** | 40465631698 step 25 (success): both subjects keep and drop the same turns at `keep` and `keep-1`. **Not** "truncation proven in general" — pinned's total message count is not monotone in `openai_max_context` |
| World-info activation | **proven** | `GoTavern CI` 40398345829 (success): provider-wire captures including the world-info routes, byte-identical on re-record |
| Streaming and helper events | **partial** | the cut/abort legs that would prove it live on a lane that has not merged, so there is no citation from `main`; a buffering-hop render claim is not provable by the current harness and the artefact says so |
| Reload, swipe, regenerate, continue | **partial** | save→reload→swipe proven (40387864205, success; five consecutive green runs since). Regenerate proven equality with a negative control. **Continue's comparator has never executed** |
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

These are decisions, not gaps waiting to close. Each is `not implemented` for a stated reason and is never
absorbed into a `partial` row:

- **Arbitrary Node.js server plugins** — the one explicit ecosystem exclusion. Not emulated, not faked; a route
  that needs one reports that boundary.
- **Local in-process ML** (`/api/extra/{caption,classify}`, `/api/speech/*`, local embeddings) — it would mean
  adopting an ONNX runtime, which contradicts the single-binary, `CGO_ENABLED=0` distribution.
- **Two image-re-encoding routes** (`/api/avatars/upload`'s pixel path and `/thumbnail/<computed>`) — governed by
  a Jimp-compatible codec decision. `/thumbnail` serves real thumbnails at pinned dimensions; byte equality with
  Jimp is not claimed.
- **Wire formats that live inside third-party npm packages** (Google voice `batchexecute`,
  `/api/translate/{google,bing}`) — owning an undocumented protocol is a product decision, not an accident.
- **Inherited upstream weaknesses are reproduced and recorded, not silently fixed** — content-import host
  matching is one; a "safer but different" backend would break parity as badly as a worse one.

Also stated rather than implied: VERTEXAI service-account ("full") mode carries the pinned error shape rather
than a fabricated credential; `gemini.apiVersion` is a config value that is not projected; COHERE streaming is
recorded as **not measured** because the harness cannot yet speak Cohere's v2 SSE framing; and a prerelease's
`releases/latest` URL is intentionally 404, so **unpinned** installer invocations fail by design until the first
stable release.

## Download / Quick Start

Every path downloads a **prebuilt archive**; nothing is compiled on the target machine.

**[→ All releases](https://github.com/cocokoishi/GoTavern/releases)** — `v0.1.0-alpha.6` is the current
prerelease.

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/cocokoishi/GoTavern/v0.1.0-alpha.6/install.sh | bash -s -- --version v0.1.0-alpha.6
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/cocokoishi/GoTavern/v0.1.0-alpha.6/install.ps1 -OutFile install.ps1
.\install.ps1 -Version v0.1.0-alpha.6
```

**An explicit `--version` / `-Version` IS REQUIRED WHILE THE NEWEST RELEASE IS A PRERELEASE.** Without it the
installers fetch `releases/latest/download/...`, which GitHub resolves to the newest **stable** release — and
there is none yet, so that URL 404s. That is deliberate: a prerelease must never be what an unpinned
`curl | bash` hands a stranger. Once a stable tag exists the flag becomes optional.

**Docker**

```bash
docker pull ghcr.io/cocokoishi/gotavern:v0.1.0-alpha.6
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

The loop is built for a weak machine; [`docs/development-loop.md`](docs/development-loop.md) lists the tiers and
the measurements.

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
