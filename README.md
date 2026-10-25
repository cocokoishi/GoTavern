# GoTavern

GoTavern is a **standalone Go reimplementation of the SillyTavern 1.19.0 server/backend**. You run the
unmodified upstream frontend against it, with your existing data, browser URLs and frontend extensions — and
production needs no Node.js, npm or compiler.

Baseline: `SillyTavern 1.19.0`, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.

> **Status: `v0.1.0-alpha.1` — an ALPHA.** The server is usable for real chats and the compatibility gates below
> are enforced in CI, but this is not yet a "throw away your SillyTavern" release. Read
> [What is measured](#what-is-measured-and-what-is-not) before you migrate anything you care about, and keep a
> backup of your data directory.

## Install

Every install path downloads a **prebuilt archive**; nothing is compiled on the target machine.

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/cocokoishi/GoTavern/v0.1.0-alpha.1/install.sh | bash -s -- --version v0.1.0-alpha.1
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/cocokoishi/GoTavern/v0.1.0-alpha.1/install.ps1 -OutFile install.ps1
.\install.ps1 -Version v0.1.0-alpha.1
```

**An explicit `--version` / `-Version` IS REQUIRED WHILE THE NEWEST RELEASE IS A PRERELEASE.** Without it the
installers fetch `releases/latest/download/...`, which GitHub resolves to the newest **stable** release — and
there is none yet, so that URL 404s. That is deliberate: a prerelease must never be what an unpinned
`curl | bash` hands a stranger. Once a stable tag exists the flag becomes optional.

**Manual**, if you prefer an archive: download `gotavern-<os>-<arch>.tar.gz` (or `.zip` on Windows) from the
release page, verify it against `checksums.txt`, unpack it anywhere writable, and run `./start.sh` /
`Start.cmd`. An update is the same archive unpacked over the old install: the binary, the launcher and
`src/tokenizers/` are immutable release files and are replaced, while `config.yaml`, `data/`, `extensions/`
and `certs/` are never touched.

**Container**: `docker pull ghcr.io/cocokoishi/gotavern:v0.1.0-alpha.1`. `:latest` deliberately lags — it only
moves when a **stable** tag is published, so an operator's `docker pull ...:latest` cannot silently upgrade a
deployment onto an alpha.

Requirements: a 64-bit Linux, macOS or Windows host. No runtime dependencies. The frontend, the default content
and the tokenizer *manifest* are embedded in the binary; the tokenizer **data** ships as
`<install root>/src/tokenizers/` — the same path upstream SillyTavern keeps, because token counts must be exact
rather than approximated, and a missing tree would silently fall back to estimates while still answering.

## What is measured, and what is not

Compatibility here is not "it opens and chats". The claim is checked against a **pinned Node SillyTavern** on
five observation surfaces, and the numbers below are products of those runs:

| Area | State |
|---|---|
| Chat-completion providers | **All implemented pinned sources except COMETAPI have recorded provider-wire captures** (pinned itself refuses COMETAPI before any request). <!-- BEGIN GENERATED: provider-wire.summary -->`25` sources with recorded provider-wire captures; `219` recorded scenarios.<!-- END GENERATED: provider-wire.summary --> |
| Provider wire (`B`/`P`) | Every claimed source is compared against captures: request target, method, header set, body bytes (SHA-256), chunked framing, client-disconnect. A control test fails if a source is claimed without a capture. |
| Browser legs (`E`/`C`) | **<!-- BEGIN GENERATED: browser.sources -->`15`<!-- END GENERATED: browser.sources --> sources** carry both a generation and a streaming comparison artifact, printed and enforced by `tools/verify-browser-comparisons.mjs`. Streaming covers frames, cancellation and final text. |
| Extensions (`F`) | Tavern Helper / JS-Slash-Runner and the standard-SillyTavern-API part of LittleWhiteBox are driven as real probes. |
| Startup (`F`/`E`) | Startup differential over <!-- BEGIN GENERATED: startup.requests -->`353`<!-- END GENERATED: startup.requests --> requests; characters, chats, groups, world info, settings and secrets have replay fixtures. |
| Release path | Fresh install, idempotent re-install, tampered-archive refusal, update **and cross-baseline rollback** run in CI against the real `install.sh` / `install.ps1` over a loopback mirror, alongside the Windows-only installer behaviours. |

**Not measured, stated rather than implied** — the honest gaps:

- Local in-process ML (`/api/extra/{caption,classify}`, `/api/speech/*`, local embeddings) is **not
  implemented**: it would mean adopting an ONNX runtime, which contradicts the single-binary distribution.
- Two image-re-encoding routes (`/api/avatars/upload`'s pixel path and `/thumbnail/<computed>`) are governed by
  a Jimp-compatible codec decision, not by a missing test.
- Routes whose wire format lives inside a third-party npm package (Google voice `batchexecute`,
  `/api/translate/{google,bing}`) are not ported; owning an undocumented protocol is a product decision.
- VERTEXAI service-account ("full") mode carries the pinned error shape rather than a fabricated credential, and
  `gemini.apiVersion` is a config value that is not projected. COHERE streaming is recorded as **not measured**:
  the harness cannot yet speak Cohere's v2 SSE framing, so its artifact says so instead of claiming a render it
  never saw.
- A prerelease's `releases/latest` URL is intentionally 404, so **unpinned** installer invocations fail by
  design until the first stable release.

Arbitrary **Node.js server plugins** are the one explicit ecosystem exclusion: they are neither emulated nor
faked, and a route that needs one reports that boundary rather than pretending.

## Development

The loop is built for a weak machine; `docs/development-loop.md` lists the tiers and the measurements.

```bash
node scripts/dev-verify.mjs          # ~7 s: gofmt + build + the tests your change can break
node scripts/dev-verify.mjs --full   # ~2 min: the whole Go suite, including every fixture replay
```

`node scripts/dev-verify.mjs` is the **first** step for any change, not a formality: it classifies your diff
against `origin/main` and runs the smallest falsifying set (measured: 7.2 s for a one-file provider edit —
gofmt, the targeted package test, the build). CI keeps the expensive gates: the full suite, `go vet`, the
cross-compiles, the browser comparison gate, and the Linux oracle that re-records every fixture and requires a
zero diff.

Provider work does **not** wait for the full oracle: a push selects only the probes whose inputs can move, and the
oracle job publishes any re-recorded bytes as a patch —
[`docs/oracle-record-loop.md`](docs/oracle-record-loop.md) plus `scripts/apply-oracle-rerecord.mjs` do the
mechanical part and refuse on the two hazards that invalidate a patch.

Read [`AGENTS.md`](AGENTS.md) before changing anything: it carries the verification rules this project learned
the hard way, including the ones about mutations that cannot fail, fixtures that prove only themselves, and
`go test` caches.

## Compatibility target

### Current status (2026-10-25): the three reported defects are fixed and gated; not yet a daily driver

Three defects were found in real use — exactly the kind a route-by-route ledger cannot show. All three are now
fixed, each with a gate that runs on every push, and each gate has been shown to fail:

| # | What a user hit | State, and the gate that holds it |
|---|---|---|
| P0-A | a real provider (DeepSeek) could not be reached: the shared transport had no response timeout, no decompression for the `accept-encoding` it advertised, no proxy support and no redirect handling | **fixed** — user traffic moved to `net/http` (bounded connect/TLS/header waits, env proxies, keep-alive, redirects, gzip/deflate, cancellation) while the byte-exact client is retained behind a test-only seam for the wire oracle. `tests/e2e` drives the shipped binary through the route; `scripts/deepseek-canary.mjs` reaches the real api.deepseek.com with **no credential** (the provider's own rejection proves DNS/TCP/TLS/framing/parsing) |
| P0-B | the release binary placed in a working SillyTavern directory hung in initialisation; every boot lock was unbounded and boot printed no stage | **fixed** — every boot-path lock is bounded with a named error inside one 30 s budget, a slow boot now names its stage (`startup.<stage>`), and the data directory the runtime uses is created even when the working directory differs from the install root. `.github/workflows/dropin-qualification.yml` boots an archive of every push in a stock tree, in four combinations |
| P0-C | extensions/plugins could be updated without being asked, because `extensions.autoUpdate` defaults to true and a stock config can be rewritten with that default on first boot | **fixed** — the inherited keys are reporting-only; the only input is `gotavern.autoUpdateExtensions`, resolved strictly, so missing/null/unparsed/legacy all mean OFF, and `settings/get` reports that value |

What is still NOT claimed, and why this README still does not call it a daily driver:

- **no live completion has been produced with a real provider key.** The canary's reachability half runs on every
  push; the completion half needs a credential this project does not have, so streaming, cancellation and preset
  equivalence against a real provider remain unmeasured;
- the Windows binary and `Start.cmd` **are** executed — the `qualify-windows-amd64` job runs them on a Windows
  runner, refuses an install over a running `gotavern.exe` and asserts the refusal contract — but only into an
  **empty install prefix**. They have never been dropped over a real stock SillyTavern tree, which is what the
  Linux drop-in gate does; that Windows layout is the remaining gap;
- one adversarial violation is open and named: the pinned ten-second legacy migration stage is now announced but
  not shortened;
- the tokenizer fallback reproduces an **inherited weakness** (an inexact count is indistinguishable from an exact
  one, as it is upstream) and says so in the compatibility matrix rather than pretending otherwise.

The release pipeline was last qualified end to end at tag **`v0.1.0-alpha.3`** (2026-10-25): six archives plus
`checksums.txt` published, `qualify-linux-amd64`, `qualify-upgrade-rollback`, `qualify-windows-amd64` and
`qualify-dropin-linux` all green on that commit, including a tampered archive being refused and a rollback
preserving `config.yaml` byte for byte.

The contract and the measurements are in [`docs/network-egress.md`](docs/network-egress.md),
[`docs/startup-state-machine.md`](docs/startup-state-machine.md),
[`docs/dropin-qualification.md`](docs/dropin-qualification.md), [`docs/compatibility-matrix.md`](docs/compatibility-matrix.md),
[`AGENTS.md`](AGENTS.md) rules 21-40 and [`ARCHITECTURE.md`](ARCHITECTURE.md) §34.

GoTavern keeps SillyTavern's frontend and data model rather than designing substitutes:

- pinned upstream `public/**` frontend, unchanged; pinned `default/**` content for fresh installs;
- the same HTTP routes, auth, CSRF, uploads, redirects, errors and streaming semantics;
- the same `config.yaml` behaviour, including upstream startup migrations and default insertion;
- the same data-root layout and file formats — characters/cards, chats, groups, world info,
  presets/templates, Quick Replies, settings and secrets;
- equivalent provider requests for complex prompt/preset workflows (message order and roles, world info, stops,
  token limits, tools/schema, reasoning, provider-specific members);
- extension installation/loading/update and runtime compatibility;
- read-only copy migration from an existing SillyTavern install, plus direct-use mode;
- the ability to return to a data-compatible SillyTavern without converting anything.

The reachable ceiling is the route count **minus** the exclusions above; the ledgers say so per row rather than
implying full parity. [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`docs/SEMANTIC-COMPATIBILITY.md`](docs/SEMANTIC-COMPATIBILITY.md) and
[`docs/api-inventory.md`](docs/api-inventory.md) / [`docs/compat-matrix.md`](docs/compat-matrix.md) /
[`docs/surface-coverage.md`](docs/surface-coverage.md) are the authority, and every partially-covered row labels
its evidence as measured, derived, or not covered.

## License

GoTavern is released under **AGPL-3.0**, consistent with its use of the SillyTavern frontend. The root `LICENSE`
is copied from the pinned SillyTavern source, and `THIRD_PARTY_NOTICES.txt` ships in every release archive.
