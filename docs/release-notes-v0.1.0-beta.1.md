# GoTavern v0.1.0-beta.1 — the install-first Beta

`v0.1.0-beta.1` is the first **Beta** of the 0.1.0 line, and the first release published on the
**prerelease channel** since the alpha series began. Its subject is the thing a new user meets before any
SillyTavern feature: the product page and the install path. The README now opens with a proven **drop-in
install** — copy the binary and the archive's `src/tokenizers/` data into the SillyTavern folder you already
run, start it, and keep your `config.yaml`, `data/`, cards, chats, presets and third-party extensions — and
the machine gate that polices the README was re-wired to enforce that shape instead of a manual-sized page.

**This release contains no product-behaviour change.** The Go sources, the pinned `public/**` bytes and the
pinned baseline (SillyTavern `1.19.0` at `06bde939fb1e9c4c8d8641d810f0a916b5bce127`) are identical to
`v0.1.0-alpha.20`; the shipped binary differs only in the version stamped into it. The fourteen required
gates all ran at this release's own commit, so alpha.20's compatibility evidence still describes this build.
Because the tag is a prerelease, `releases/latest` and Docker `:latest` keep serving the newest stable
release, and installing this Beta is an explicit, version-pinned decision.

## What changed

- **The product page is installation-first, and short.** The README leads with `## Install`: the drop-in
  recipe for an existing SillyTavern tree (two pieces, both platforms), then the one-line installer, Docker
  and copy migration. The compatibility scope and the unmet `GOAL.md` §14 claim sit beside the install path;
  the performance figure and its recomputed table remain, below install; every other detail links out to
  `docs/`. Nothing about the server changed to make this possible — the page was describing the product in
  the wrong order.
- **The README gate now enforces install-first, and no longer passes a stale README.** `tools/check-perf-docs.mjs`
  derives the newest published release from `docs/generated/facts.json` instead of a hardcoded version, refuses
  a README that lags it, refuses a first-screen release token older than it, requires the literal drop-in
  pieces and the post-copy `assets verify`, and checks the figure's alt text wherever the figure appears. The
  defect this replaces was measured, not hypothesised: the previous README still said `v0.1.0-alpha.19` while
  `v0.1.0-alpha.20` was the published release, and the gate compared it against a hardcoded `v0.1.0-alpha.19`
  default, so it passed the stale text. `tests/docs/check-perf-docs.test.mjs` gains a named negative control
  per new refusal, and the untampered tree remains the positive control.
- **The drop-in path was verified before it was documented.** The Windows recipe was executed end-to-end
  against a copy of a stock pinned tree: the server answered the pinned `/version` body, served `/` bytes
  identical to the upstream `public/index.html`, read the existing `config.yaml` without rewriting it,
  modified or deleted zero pre-existing files, created a character and a chat through the browser-facing
  routes, and kept both across an abrupt kill and restart. First start added the pinned fresh-install
  scaffold to `data/` (additions only). Two draft claims were found FALSE and were removed rather than
  softened: a binary-only copy leaves a stock tree with 9 of the 23 tokenizer files (silent empty token
  counts, and `assets verify` refuses), and extracting the archive in place collides with the tree's
  existing files. The Linux/macOS recipe copies the same two archive members and is layout-verified by the
  release gates; it was not executed on the development host. The full record is
  [`docs/beta1/install-verification.md`](beta1/install-verification.md).

## Compatibility and platform

The SillyTavern baseline (`1.19.0`, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`) and the compatibility
contract are unchanged. The required gate set is the same fourteen gates as alpha.20 — no gate was added,
removed, renamed, skipped or weakened — and they all ran at this release's commit. An alpha.20 data directory
continues to work unchanged; a Beta closes no `PARTIAL` capability row, and the generated
[`docs/compatibility-matrix.md`](compatibility-matrix.md) remains the authority for what is closed and what is
not.

## Known limitations

- **`GOAL.md` §14 remains NOT MET.** No real, long-used user directory has been qualified; the private
  channel's disposition is `PRIVATE_NOT_RUN`. Everything this release claims is synthetic or agent-generated.
- **darwin/arm64 runtime is NOT runtime-qualified**: the archive is built and archive-inspected, not executed,
  and the macOS arm64 extension lifecycle is UNVERIFIED. **windows/arm64 is build-only** (no hosted runner of
  that architecture).
- **The drop-in verification is Layer A local evidence** (Windows/arm64 host; the windows/amd64 binary was
  additionally executed under emulation). The Linux/macOS drop-in recipe was not executed here; its archive
  layout and launcher are what the release gates inspect. The packaged, published-bytes installation is
  asserted by the release qualification, drop-in qualification and published-release install smoke gates, not
  by this local record.
- **A Beta closes no remaining gap.** The disclosed differences from alpha.20 are unchanged: no Brotli decoder
  (a `br`-only client receives identity; one safe retry for a mutating request is refused), the pinned derived
  `_cache/characters` read/write cache is not implemented (rebuildable, no user byte), thumbnail
  `dominantColor` can differ by ±1 per channel on 7 of 24 recorded JPEGs, and pinned's `console.error` line
  for a failed backup is not reproduced. Other `PARTIAL` rows remain as the compatibility matrix records them.
- **First start writes to `data/`.** It adds the pinned fresh-install scaffold (default profiles, themes,
  presets, seed content, user data) and touches no existing file; this is upstream startup behaviour, is
  documented in `docs/INSTALLATION.md` §7.1, and is why the README says to take a backup before pointing a
  Beta at data you cannot lose.
- **This tag identifier has history.** A release named `v0.1.0-beta.1` was published once on 2026-10-31 and
  then retracted and reissued as `v0.1.0-alpha.10`; that tag was deleted from the origin and this release is a
  new tag object for the same version name. The compatibility matrix, the gate evidence and the archives on
  this release are the ones this page describes.

## Checksums

`checksums.txt` is authoritative for the six canonical archives (`gotavern-linux-amd64.tar.gz`,
`gotavern-linux-arm64.tar.gz`, `gotavern-darwin-amd64.tar.gz`, `gotavern-darwin-arm64.tar.gz`,
`gotavern-windows-amd64.zip`, `gotavern-windows-arm64.zip`). It is published beside the archives, and the
notes deliberately do not repeat digests so a transcription cannot disagree with the authoritative file.

## Artifacts

- `gotavern-linux-amd64.tar.gz`, `gotavern-linux-arm64.tar.gz`
- `gotavern-darwin-amd64.tar.gz`, `gotavern-darwin-arm64.tar.gz`
- `gotavern-windows-amd64.zip`, `gotavern-windows-arm64.zip`
- `checksums.txt`

Installers (`install.sh`, `install.ps1`) download these prebuilt archives and verify `checksums.txt`; they
never fall back to building from source. On the prerelease channel they install this Beta only when given its
version explicitly — `install.sh --version v0.1.0-beta.1`, `install.ps1 -Version v0.1.0-beta.1` — because
`releases/latest` must keep resolving to the stable release. The same-SHA qualification table is appended to
this release body at publication from the verifier that gates it, and the round's record (same-SHA evidence,
published-release verification, install verification) lives under `docs/beta1/`.
