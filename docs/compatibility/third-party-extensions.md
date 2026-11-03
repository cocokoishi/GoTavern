# Third-party extension compatibility

This document describes the **external compatibility corpus** added in `v0.1.0-alpha.13`: exactly
20 real, popular, SFW, third-party SillyTavern **client** extensions, pinned by commit, driven through
a stock-vs-GoTavern differential, and required as a same-SHA release gate.

It is not a claim that every SillyTavern extension works. The claim the gate supports is narrow and
checkable: **the 20 pinned extensions in [`tests/browser/third-party-extensions.lock.json`](../../tests/browser/third-party-extensions.lock.json)
activate, persist a setting across a real server restart, disable, re-enable and uninstall the same way
on stock SillyTavern 1.19.0 and on GoTavern, and the extensions whose capabilities touch generation
produce the same provider-bound request.** See [Known limitations](#known-limitations) for what is
outside that claim.

## Why a corpus instead of more fixtures

The repository already had two pinned canaries (Tavern Helper / JS-Slash-Runner and LittleWhiteBox) and a
synthetic extension-asset fixture. Those prove the deep helper path and the static-serving surface, but
they are *our* choices of extension. Real third-party code reaches the server through whatever APIs its
author happened to use, in whatever order, with whatever manifest. The corpus turns that into an
external workload: 20 independent codebases, none written for GoTavern, pinned so the measurement
cannot change under the release.

The corpus selection is documented separately in
[`extension-selection.md`](extension-selection.md): the candidate pool (101 repositories), the exact
GitHub API queries and snapshot time, the ranking (stars → forks → recent maintenance → official/community
listing), and every exclusion (Tavern Helper in all its forms, NSFW, unsafe projects, non-client/server
plugins, first-party SillyTavern organisation extensions, and repos without a root `manifest.json` or
that need credentials/an external server just to load).

## What is pinned

`tests/browser/third-party-extensions.lock.json` is the single source of truth:

* exactly **20 selected** extensions, each with a full 40-hex commit, default branch, stars/forks snapshot,
  snapshot timestamp, licence, capability list, install method, `networkRequired`/`credentialsRequired`
  booleans, a concrete safety review and a selection reason;
* **101 candidates**, including the excluded ones and why they were excluded;
* the snapshot timestamp and the methodology paragraph.

The loader (`tests/browser/third-party-extensions.mjs`) validates the lock before anything boots:
20 entries, unique names/repos/commits, 40-hex commits, every selected repo present in the candidate
pool, known capabilities only, no Tavern Helper row, a substantive safety review. A malformed lock is a
named error, not a shard that silently runs a subset.

CI never reads a moving branch: each pinned commit is fetched once into a local seed checkout, then
copied into each subject's data root. The extension's `origin` is frozen to a local bare mirror inside
the data root (the same mechanism the pinned canaries use), so the pinned frontend's own
auto-update path cannot advance the checkout mid-measurement and no request leaves the process.

## The differential

For every extension the runner (`tests/browser/third-party-extensions-run.mjs`) prepares **two fresh
data roots with the same content**, seeds the same `config.yaml` bytes into both, and drives the
**same probe** against each subject:

1. **before-restart phase** — install at the pinned commit; load the unmodified pinned frontend in a
   real Chromium; wait for the extension's own asset request (an installed extension that never
   requests its module did not load); record every request (method, path, status, content type, body
   length, SHA-256, JSON shape), page errors, console errors, failed requests and final DOM state;
   then change the extension's own `extension_settings` entry through the frontend's own
   `saveSettings()` and save it.
2. **restart** — the runner kills the subject and boots a **new process** on the same data root. This is
   a restart, not a page reload: the second phase cannot be reading the first phase's memory.
3. **after-restart phase** — assert the setting survived; disable the extension through the frontend's
   own `extension_settings.disabledExtensions` mechanism and assert it produces no request; re-enable it
   and assert it loads again; uninstall through `POST /api/extensions/delete` and assert the directory is
   gone and a fresh page still reaches a usable state (no stale code, no startup failure).

The two legs are judged by `tests/browser/compare-extension-lifecycle.mjs`, a pure function of the four
leg files. It records, per capability, a taxonomy verdict:

| verdict | meaning |
|---|---|
| `PASS` | every applicable Go leg matches the stock oracle |
| `FAIL` | a Go-only divergence: the same drive succeeded on stock and did not on GoTavern |
| `UPSTREAM_FAIL` | stock itself deterministically failed, so the pair cannot support a Go claim |
| `N/A` | the capability does not apply (recorded with the reason, never silently skipped) |

Request rows are compared by method+path membership and status sets; JSON bodies by bounded **shape**
(one run per leg cannot distinguish a real difference from a nondeterministic body, which is why no body
digest is asserted). A route **both** drives issued with different statuses is a server response
difference and fails. A one-sided page-load request is recorded with its reason; a one-sided **extension
asset** fails, because that is the "the extension looks dead" failure this surface exists for. Browser
errors produced only on GoTavern fail; errors both legs produce are the extension's own and are recorded
as upstream. Live-egress routes (the pinned handlers that call a third-party service, e.g. `/api/horde/`)
keep their status and membership but their bodies are not asserted, with the reason named.

### Generation-capable extensions

Extensions whose capabilities include `generation`, `prompt-injection` or `prompt-format` additionally
run the proven generation drive with the extension installed: a send (non-stream), a streaming reply and
a cancel against the recording peer, on both subjects. The comparator compares the provider wire
byte-for-byte (`method`, raw target, `bodyLength`, `bodySha256`), the message-by-message chat-completions
body, the generation event window and the post-send DOM. This is the strongest available statement that
an extension's prompt mutation reaches the model identically on both servers.

## Harness hardening in this surface

The new harness reuses the lessons that cost alpha.12 a red run, and extends them:

* **Identity-bound readiness.** A subject is ready only when the process this harness spawned is alive,
  `/version` answers 200 with `pkgVersion: 1.19.0`, **and** the port's listener PID is that child
  (`ss`/`lsof`/PowerShell). A 404, a 500, a TCP connect, a leftover server of the other product, or a peer
  that took the port is a named refusal. This replaces `bind(0)` + close + spawn in the pinned wrapper
  and the new runner with a controlled-range port lease (`tests/browser/port-lease.mjs`).
* **Leg failure preservation.** Every leg writes its own failure into its report; the comparator's guards
  refuse to judge a pair whose Go leg did not measure, and reports a stock failure as `UPSTREAM_FAIL`
  rather than as a Go defect.
* **No silent skips.** The runner declares the extensions its shard must run; the aggregator
  (`tests/browser/third-party-extensions-aggregate.mjs`) requires the union of observed extensions to be
  exactly the lock's 20, with one lock SHA-256, one head SHA, one run id and one shard count, and every
  capability verdict `PASS` or `N/A`.
* **Tests of the tests.** `tests/browser/third-party-extensions-selftest.mjs` mutates the guards and
  requires each mutation to go red: wrong product identity, 404-as-ready, port collision, listener
  ownership, a subject that exits before answering, a changed status, a forced Go failure, a forced stock
  failure, a missing leg file, a missing/duplicated/unexpected extension, a stale lock hash, an unknown
  artifact schema, a shard from another commit, and a malformed lock.

## The release gate

`Third-party extension compatibility` (`.github/workflows/third-party-extension-compat.yml`) is a
`workflow_dispatch` gate in [`docs/release-manifest.json`](../../docs/release-manifest.json) and carries
the `extension-compat-evidence` artifact. `scripts/verify-release-gates.mjs` requires a completed,
successful, same-SHA dispatched run **and** that the artifact is attached to that run and not expired;
`scripts/release-governance/gates.mjs` refuses a green conclusion whose artifact is missing or expired.
The workflow shards the 20 extensions across four jobs with `fail-fast: false` so a run reports how many
broke, then aggregates in a job that checks the set rather than the shards' conclusions.

The aggregator writes `summary.json`, `matrix.json`, `junit.xml` and `matrix.md` from the same data it
judged, so a release-notes table cannot be assembled from a different run.

The same workflow runs two more surfaces that the per-extension shards cannot express:

* **all-20 simultaneous and capability clusters** — one browser loads every extension at once (boot,
  all modules, settings page, character load, new chat, send, cancel, reload, restart) and then one
  representative pair per capability cluster (prompt mutation, render/DOM, files/network,
  settings/events, character/world, misc), so extensions interact instead of being judged in isolation;
* **a 30-minute all-20 soak and a clean-vs-20 overhead measurement** — the soak repeats send / cancel /
  reload / setting-toggle and records subject RSS, API failure rate, latency p50/p95/p99, browser errors
  and an orphan scan on both subjects, with a broad regression guard (Go RSS or p95 more than 3x stock,
  or a Go-only 5xx) rather than a tight threshold runner noise would turn red. The overhead measurement
  reports server boot, RSS and latency plus browser time-to-settings-ready for GoTavern-clean,
  GoTavern-20, stock-clean and stock-20, and makes no speedup or regression assertion.

## Reproducing it locally

```bash
# build the subject and the recording peer
go build -trimpath -o .browser-bin/gotavern ./cmd/gotavern
go build -trimpath -o .browser-bin/mock-provider ./tools/mock-provider
export GOTAVERN_BINARY="$PWD/.browser-bin/gotavern"
export GOTAVERN_MOCK_PROVIDER_BINARY="$PWD/.browser-bin/mock-provider"
# stock oracle checkout (read-only): ../SillyTavern or .reference/SillyTavern

# cheap teeth (seconds, no browser)
node tests/browser/third-party-extensions-selftest.mjs

# one extension, full lifecycle + generation legs
node tests/browser/third-party-extensions-run.mjs \
  --shard-index 1 --shard-count 1 --names <extension-name> \
  --work-root "$TMPDIR/alpha13-one"

# the whole corpus, sharded and aggregated
node tests/browser/third-party-extensions-run.mjs --shard-index 1 --shard-count 4 --work-root "$TMPDIR/alpha13-shard1"
node tests/browser/third-party-extensions-aggregate.mjs --shards "$TMPDIR/alpha13-shards"
```

On a Windows development host with `core.autocrlf=true` the working-tree lock file is CRLF, so its
sha256 differs from the committed (LF) blob. CI hashes the committed bytes; an artifact records the hash
it measured.

## Known limitations

* The corpus is 20 extensions, not the ecosystem. A green gate supports the 20 pinned workloads and the
  surfaces they exercise; it does not support "all extensions work".
* Extensions are client-side only. SillyTavern **server plugins** remain the explicit ecosystem exclusion
  (`AGENTS.md` hard rule 16); the corpus does not emulate or fake their endpoints.
* The lifecycle differential drives the extension's own settings entry when the extension keeps one in
  `extension_settings`. An extension that keeps no such entry gets `settings: N/A` with that reason, and
  the other lifecycle phases still run.
* Multi-turn verbs (edit, swipe, regenerate, continue, group chat) are covered per extension by the
  before/after-restart drives where the frontend exposes them without a chat, and as composed journeys by
  the existing whole-session, combination-journey and group-chat gates. They are not all re-driven inside
  the per-extension probe.
* Extensions that need a provider credential or a self-hosted service just to initialise were excluded at
  selection time; the gate does not fabricate credentials.
* A live-egress route's body is recorded but not asserted (see above); the status and membership are.
* The pinned checkout's auto-update path is disabled by freezing `origin` to a local mirror. That is a
  harness property, not a product claim about update behaviour.
* **A generation window may hold an extension-triggered dry run whose tail lands after the send window
  closes, or an extension may start its own generation inside the window.** The shared generation
  comparator refuses such windows (`bothWindowsHoldCompleteGenerations`,
  `sendWindowHoldsExactlyOneRealSendAndNoDryAssembly`), because for a plain source those shapes mean the
  probe missed the send or compared the wrong window. An extension may legitimately run its own counting
  or stepped generation. The runner accepts only those guards, only when the window integrity and the
  normalised invocation trail are identical on both subjects, at least one real invocation assembled on
  each, and the provider wire is byte-equal, and it records the exception, the window counters and both
  invocation trails in the artifact. A Go-only difference in the trail or the wire still fails the leg.
  Measured: rpg-companion-sillytavern (dry tail after the window) and st-stepped-thinking (its own
  generation inside the window).
