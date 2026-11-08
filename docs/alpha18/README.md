# alpha.18 program — contract, state and pointers

**Status: PRE-RELEASE at this commit.** Alpha.18 is the deep product-engineering round: it fixes the
10,000-card performance hotspot alpha.17 profiled, implements the two product capability gaps alpha.17
recorded (real CORS proxy, pinned chat auto-backups), verifies streaming cancellation with real sockets, runs
a 60-minute soak, applies the alpha.17 release-evidence rails to the release chain, and publishes through the
same-SHA 13-gate wave. `GOAL.md` §16 is the normative bar; `docs/alpha18/release-bar.md` is its checkable
form; `docs/alpha18/same-sha-evidence.md` and `docs/alpha18/handoff-ledger.md` carry the evidence.

## Baseline (verified at round start)

| fact | value |
|---|---|
| main HEAD at start | `336ba48dab8aa124e0eff55e1cf352c495d8f6eb` (alpha.17 release notes + post-release facts) |
| published alpha.17 | https://github.com/cocokoishi/GoTavern/releases/tag/v0.1.0-alpha.17 — `draft=false`, `prerelease=false`, 7 assets; tag object `7eed8eed…` → `9b99fde`; alpha.16 tag object `b7d81cd…` unchanged |
| pinned oracle | SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127` (unchanged) |
| host | Windows 11 24H2, 2 logical cores, Go 1.27.3 windows/arm64, Node v24.19.0 |

## What this round changed (all committed before this record)

| area | change | evidence |
|---|---|---|
| 10,000-card performance | listing-supplied card cache identity, ctime from the read handle, direct differentially-pinned JSON escaper, allocation-free UTF-16 length, listing metadata in `DiskCache.verify`, one chats-root listing in statistics | `docs/alpha18/perf-hotspot.md`, `docs/alpha18/perf/README.md`, `abba-inprocess.json` (−60.0% p50 at 10,000 cards), `abba-process.json` (−52.3% process-level p50, boot −98.7%) |
| CORS proxy | real enabled branch with pinned observables, bounded timeouts, metadata refusal, DNS-rebinding closure, requestProxy/privateAddressWhitelist applied, brotli retry policy | `internal/server/cors_proxy*.go`, 35 local-upstream tests, `SEMANTIC-COMPATIBILITY.md` §18 |
| chat auto-backups | pinned config/key/timestamp/retention/throttle/atomic-write/shutdown-flush semantics | `internal/server/chat_backup*.go`, 49 tests incl. pinned-Node key oracle |
| streaming/cancellation | 13 real-socket tests (byte transparency, flush, cancel closes upstream, no leaks, backpressure); no production defect proven, so no product change; one dead gate moved into `internal/outbound` | `tests/e2e/streaming_cancel_socket_test.go` |
| release governance | `requiredJobs`/`requiredSelection`/`pinnedSha`/digest/freshness rails applied; release emits unified evidence; workflow-path matching fix for run-name runs | `docs/alpha18/evidence-contract.md`, `scripts/release-governance.test.mjs` 88/88 |
| soak | `tools/perf/a18-soak.mjs` (mixed storage routes, restart integrity, external card modification, honest UNPROVEN leak verdict) | run artifact added post-wave as `docs/alpha18/perf/soak-60min.json` |

## Local verification at this commit

Full `internal/server` and `internal/startup` suites green; `go vet ./...` clean; `internal/fixtures`
document-contract suite green; CORS 35/35; chat-backup 49/49; streaming 13/13; classifier 74/74; governance
88/88; perf-doc checker green with 15/15 negative controls. `-race` is unavailable on windows/arm64 — the
Linux CI `race` job is the concurrency gate.

## Pointers

- Performance: `docs/alpha18/perf/README.md` (method + results + limits), `docs/alpha18/perf-hotspot.md`
  (root cause and change), `docs/alpha18/performance-plan.md` (protocol), `docs/alpha18/perf/` (raw artifacts,
  profiles, ABBA, soak).
- Product compatibility: `docs/SEMANTIC-COMPATIBILITY.md` §18, `docs/compat-matrix.md`, `docs/api-inventory.md`,
  `docs/config-parity.md`, `docs/data-safety.md`.
- Release: `docs/alpha18/release-bar.md`, `docs/alpha18/handoff-ledger.md`,
  `docs/alpha18/same-sha-evidence.md`, `docs/alpha18/evidence-contract.md`,
  `docs/release-notes-v0.1.0-alpha.18.md`, `docs/release-manifest.json`.
- Decisions: `docs/alpha18/decision-log.md`.

## Unproven / not met (stated, not implied)

`GOAL.md` §14 NOT MET (`PRIVATE_NOT_RUN`); darwin/arm64 runtime and macOS arm64 extension lifecycle UNVERIFIED;
windows/arm64 BUILD-ONLY; the card-scale and startup numbers are LOCAL Layer A; peak RSS was NOT improved (the
graded bar is met by p50); the soak cannot prove absence of a leak (handles/live heap unobservable) and does
not exercise provider streaming; `chat_metadata.integrity` and group-save backup scheduling are unimplemented;
no brotli decoder; 8-user latency REPORT-ONLY; true kernel ENOSPC UNPROVEN; page-init egress OPEN; provider-relay
p99, streaming-cancellation latency and the 20-extension page-load matrix UNEXECUTED.
