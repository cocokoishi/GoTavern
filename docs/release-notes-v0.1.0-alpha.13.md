# GoTavern v0.1.0-alpha.13

**This is the stable-channel release of the 0.1.0 line.** The tag keeps the historical `-alpha.13` spelling, but the
channel is `stable`: the GitHub Release is published without the prerelease flag, `releases/latest` points at it, the
bare `install.sh` / `install.ps1` fetch it, and the container image is tagged `latest`.
`scripts/classify-version-tag.sh` extends its documented equality list from two graduations
(`v0.1.0-alpha.9`, `v0.1.0-alpha.12`) to three; it remains an equality list, never a pattern, and the table test pins
that `v0.1.0-alpha.14`, `v0.1.0-alpha.130`, `v0.1.0-alpha.13-rc1` and every other version-shaped neighbour stay
prereleases.

## The headline: a real third-party extension corpus

Before this release, the repository's extension evidence was two pinned canaries and a synthetic fixture. That proves
the deep helper path and the static-serving surface, but both extensions were our choice. alpha.13 replaces that with
an **external compatibility corpus**:

- **Exactly 20 real, popular, SFW, third-party SillyTavern client extensions**, selected from a 101-repository
  candidate pool captured from the GitHub API at one recorded snapshot. The ranking is documented (stars → forks →
  recent maintenance → official/community listing), every exclusion is recorded with its reason, and the selection
  methodology is in [`docs/compatibility/extension-selection.md`](compatibility/extension-selection.md).
- **Tavern Helper / 酒馆助手 is excluded in every form**, as are first-party `SillyTavern/*` organisation extensions,
  NSFW projects, projects with obvious security risk, non-client/server-plugin projects, and projects that need a
  credential or an external server just to load.
- **Every extension is pinned by a full commit** in
  [`tests/browser/third-party-extensions.lock.json`](../tests/browser/third-party-extensions.lock.json). CI checks out
  that exact commit into a temporary data root; it never reads a moving branch, and the extension's `origin` is frozen
  to a local mirror so the pinned frontend's own auto-update cannot advance it mid-measurement.
- **Every extension runs on BOTH subjects** — stock SillyTavern 1.19.0 and GoTavern — with the same probe, the same
  data-root shape, the same `config.yaml` bytes, the same browser and the same timeouts. The lifecycle is install →
  activate → change the extension's own setting → **restart the server** → setting persisted → disable → re-enable →
  uninstall through `/api/extensions/delete`, with the extension's assets, `/api/*` requests, page errors, console
  errors and final DOM state recorded on both legs.
- **Generation-capable extensions additionally run the proven generation drive** (non-stream, stream, cancel) with the
  extension installed, and the provider-bound request is compared byte-for-byte (method, raw target, length, SHA-256),
  so an extension's prompt mutation must reach the model identically on both servers.
- The gate is a **same-SHA release requirement**: `Third-party extension compatibility` must have a successful
  `workflow_dispatch` run at the release commit **and** that run must carry the `extension-compat-evidence` artifact;
  the verifier refuses a green conclusion whose artifact is missing or expired. The aggregator requires the observed
  set to be exactly the lock's 20 — no missing shard, no duplicate, no unexpected name — with one lock SHA-256 and one
  head SHA.

The methodology, the taxonomy (`PASS` / `FAIL` / `UPSTREAM_FAIL` / `N/A`) and the limitations are in
[`docs/compatibility/third-party-extensions.md`](compatibility/third-party-extensions.md). This release does **not**
claim that every SillyTavern extension works; it claims the 20 pinned workloads in the covered scenarios.

## What changed since v0.1.0-alpha.12

- **The extension differential harness was rebuilt around the failures alpha.12 found.** Readiness is now
  identity-bound: the subject is ready only when the process the harness spawned is alive, `/version` answers 200 with
  the pinned baseline, **and** the port's listener PID is that child (`ss`/`lsof`/PowerShell). A 404, a 500, a TCP
  connect, a leftover server or a peer that took the port is a named refusal. `bind(0)` + close + spawn-later is
  replaced by a controlled-range port lease with collision retry.
- **Leg failures are preserved and classified.** A Go leg that did not measure is a `FAIL`; a stock leg that did not
  measure is `UPSTREAM_FAIL`, not a Go defect; every comparator verdict is a taxonomy, not a boolean. The harness
  self-test mutates each guard (wrong product identity, 404-as-ready, port collision, listener ownership, forced Go
  failure, forced stock failure, missing artifact, changed status, missing/duplicated extension, stale lock hash,
  unknown artifact schema) and requires each to go red.
- **Representative cross-platform coverage.** The same two-extension lifecycle differential runs on `windows-latest`,
  `macos-15-intel` and `macos-14`, because path handling, extension directories, filesystem casing, executable naming,
  browser startup and user-data locations are properties a Linux-only run cannot observe. The full 20-extension corpus
  stays on Linux as the reference.
- **Release governance is stricter.** `docs/release-manifest.json` gains the third-party gate with a required artifact;
  `scripts/release-governance/gates.mjs` checks that the artifact is attached to the same successful same-SHA run and
  is not expired; the published evidence table gained an artifact column.
- **Generated facts, matrix and coverage were re-emitted** for the new workflow (18 workflows / 46 jobs), with the
  checkers green.

## Verification of this release

- The release body carries the same-SHA required-gate table generated by the publish job. Every named workflow must
  have a successful `workflow_dispatch` run whose `head_sha` is the commit this tag points at; a push-triggered run
  cannot satisfy the manifest.
- The third-party gate's aggregator writes `summary.json`, `matrix.json`, `junit.xml` and `matrix.md` from the same
  data it judged, and the run must carry that artifact for publication.
- The published archives are additionally executed by the release workflow: linux/amd64 and windows/amd64 by the
  packaged drop-in and release-qualification gates; linux/arm64 under QEMU; darwin/amd64 and darwin/arm64 on native
  macOS runners.
- The post-publication smoke workflow downloads the published assets, verifies their checksums, unpacks them and boots
  against a stock tree, and a published-extension smoke installs the pinned corpus against the **published** artifact.

## Known limitations

These are stated rather than implied; the same boundaries are recorded in the compatibility matrix and in
`docs/compatibility/third-party-extensions.md`.

- **The corpus is 20 extensions, not the ecosystem.** A green gate supports the 20 pinned workloads and the surfaces
  they exercise; it does not support "all extensions work".
- **windows/arm64 is built and structurally inspected, not executed.** No windows/arm64 hosted runner exists; the
  release workflow fails if that boundary ever stops being stated.
- **Extensions are client-side only.** SillyTavern server plugins remain the explicit ecosystem exclusion; the corpus
  does not emulate or fake their endpoints.
- **Remote embedding sources are a declared exclusion for this release.** Every provider-backed source answers an
  explicit 501 naming the reason; webllm/koboldcpp and caller-supplied vectors remain supported.
- **Local in-process ML is excluded by architecture** (`/api/extra/{caption,classify}`, `/api/speech/*`, local
  embeddings inside `/api/vector/*`): it would require an ONNX runtime, contradicting the static, no-extra-runtime
  distribution rule.
- **The Q7 background paint half is `partial`**: background files and tiles are served and render, but pixel-exact
  paint parity is not claimed. Avatar/thumbnail/APNG/AVIF codecs are pure-Go and claim the observable contract, not
  Jimp byte equality.
- **No credentialed provider run is recorded in this repository.** The live canary exercises a real provider in its
  anonymous mode and records the provider's own decision; a credentialed end-to-end run is not claimed.
- **酒馆助手's rendering path and rendered DOM URLs remain unproven**; its state, variables, preset mutation and
  generation APIs are covered second-order by the helper-state differential and the combination journey.
- **Preset secondary features** (world-info secondary keys/recursion/probability/outlets/scan depth/budget,
  text-completion instruct/context template consumption, preset-varying group chats) remain narrowed rather than
  closed; the measured per-field server contract is documented in `docs/preset-semantics.md`.
- **Multi-user contention** (two users writing the same world/preset tree concurrently) is untested.
- **Inherited pinned behaviour is reproduced, not fixed** where a drop-in must match the oracle (for example the
  content-import host substring classification and the absence of a settings.json answering 500 on the backup/settings
  routes); these are recorded in the matrix rows rather than silently hardened.
- **Per-extension multi-turn verbs are not all re-driven.** The lifecycle differential covers activation, settings
  persistence across a restart, disable/re-enable and uninstall per extension; generation-capable extensions cover
  send/stream/cancel with the extension installed. Edit, swipe, regenerate, continue and group chat are covered as
  composed journeys by the existing whole-session, combination-journey and group-chat gates, not inside the
  per-extension probe.
- **One generation window shape is accepted with a recorded exception.** When an extension starts its own dry run
  inside the send window and its tail lands after the window closes, the shared generation comparator reports an
  incomplete window. The runner accepts that ONE guard only when the incompleteness is identical on both subjects, the
  real send is complete on both, and the provider wire is byte-equal, and it records the exception and counters in the
  artifact; every other guard failure still fails the leg.
- **The cross-platform job is representative, not the full corpus.** Two pinned extensions run on Windows and both
  macOS architectures; the 20-extension matrix is judged on Linux.

## Artifacts

Six prebuilt archives are published, with `checksums.txt` beside them:

- `gotavern-linux-amd64.tar.gz`
- `gotavern-linux-arm64.tar.gz`
- `gotavern-darwin-amd64.tar.gz`
- `gotavern-darwin-arm64.tar.gz`
- `gotavern-windows-amd64.zip`
- `gotavern-windows-arm64.zip`

The container image is `ghcr.io/cocokoishi/gotavern:v0.1.0-alpha.13` (linux/amd64) with `latest` moved to it by this
stable release. Install by unpacking an archive and running `./start.sh` / `Start.cmd`, or through the bare
installers, which resolve `releases/latest`. No Go or Node is needed on the target host.
