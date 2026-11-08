# GoTavern v0.1.0-alpha.18 — the deep product-engineering release

`v0.1.0-alpha.18` keeps the same SillyTavern `1.19.0` baseline
(`06bde939fb1e9c4c8d8641d810f0a916b5bce127`), the same compatibility contract and the same
`CGO_ENABLED=0` single-binary distribution as alpha.17. It is a **product** release, not another audit
round: the 10,000-card performance hotspot alpha.17 profiled and left unchanged is fixed with a paired
measurement, the two product capability gaps alpha.17 recorded are implemented (the real CORS proxy and the
pinned chat auto-backups), the streaming/cancellation path was verified with real sockets and real
cancellations, a 60-minute soak ran on the candidate, and the release-evidence rails alpha.17 designed are
now applied to the release chain.

The strongest claim this release makes remains the **synthetic qualification** with its scope stated.
`GOAL.md` §14 — a real, long-used user directory qualifying the drop-in claim — is **NOT MET** at this
release and is not claimed by any sentence here. See Known limitations.

## What changed

### The 10,000-card hotspot: measured root cause → production change → paired result

alpha.17 recorded 10,000-card `/api/characters/all` at p50 5,481 ms and boot at 27,099 ms on its local host
and changed no code. alpha.18 profiled it (`-cpuprofile`/`-memprofile`, 3 iterations): 5,069 ms/op,
1,038.7 MB/op, 7.80 M allocs/op, with the route's CPU in `processCharacter` (17.0 s of 21.5 s, `os.Stat`
4.8 s) and allocations in per-string `encoding/json` + two `bytes.ReplaceAll` passes (0.45 GB), a
`[]rune`+`[]uint16` pair per field (0.37 GB) and the per-card decode (0.36 GB). Controlled boots over
identical generated trees attributed the startup cost to per-card filesystem metadata access (30,000
avoidable file touches: `DiskCache.verify`'s `Info`+`Stat` and `InitializeStatistics`' per-character `stat`
plus a symlink-resolution walk) — the same 96 MB tree copied to a new directory booted in 887 ms, so the
time was first-touch work, not an algorithm the profiler had missed.

The change removes that work instead of caching around it: `/api/characters/all` takes each card's pre-read
cache identity from the `os.ReadDir` entry and the ctime from the one handle a miss already opens (symlinks
keep the stat path, on purpose), the JSON string encoding is a direct escaper that is byte-identical to the
previous encoder (differentially pinned over every single byte, controls, U+2028/29, astral runes and
invalid UTF-8), the JS string length no longer materialises rune/UTF-16 arrays, and startup uses the
directory listing's own metadata in `DiskCache.verify` and ONE chats-root listing instead of a
per-character stat plus symlink walk in statistics. The response bytes are unchanged by construction and the
existing character differential fixtures and the full `internal/server` suite were run against the change.

Measured on the same host with an isolated alpha.17 worktree (three paired rounds, subject order flipped):
10,000-card list **5,734.9 → 2,295.9 ms/op (−60.0%)**, **1,038.7 → 619.9 MB/op (−40.3%)**, **7.80 → 3.19 M
allocs/op (−59.0%)**; 1,000 cards −33.7%; 100 cards −26.0%; the cold-cache arm's allocations −56.4% (its
timing is inside the arm's noise and is not claimed). Every candidate observation was below every baseline
observation. 10,000-card boot went from 30,757 ms cold to 3,661 ms and 633 ms warm to 165 ms on the same
generation protocol. Raw rows: `docs/alpha18/perf/abba-inprocess.json`, profiles:
`docs/alpha18/perf/profiles/`, root-cause record: `docs/alpha18/perf-hotspot.md`.

### CORS proxy: the enabled branch is real

`/proxy/:url(*)` answered `501` when enabled in alpha.17. It now proxies. The disabled branch keeps pinned's
exact 404 message and content type byte-for-byte. The enabled branch reproduces the pinned middleware's
observables — the 13-name request-header removal list, forced `accept-encoding: gzip, deflate, br`,
`JSON.stringify(req.body)` for POST/PUT/PATCH only, NO upstream response headers copied, upstream 401 mapped
to 400, error bodies as text with Content-Length, 2xx bodies streamed and flushed, the circular-request 400,
node-fetch's redirect contract (max 20, method rewrite rules, sensitive-header strip, no Referer), and
gzip/deflate decoding. Those observables were established by mounting the PINNED middleware (express 4.22.1,
body-parser 1.20.4, node-fetch 3.3.2 from the pinned `node_modules`) against a local upstream, not by
guessing, and are encoded in 35 tests whose upstream records the method, escaped target, Host, headers and
body bytes it actually received.

Deliberate divergences, recorded in `docs/SEMANTIC-COMPATIBILITY.md` §18 and tested: bounded
connect/TLS/response-header/idle/body-silence timeouts (node-fetch has none); no brotli decoder, so a `br`
reply to GET/HEAD is retried once with `gzip, deflate` while a side-effecting request answers the
pinned-shaped 500 and is never re-sent; the cloud metadata endpoints are always refused (pinned proxies
them); loopback/RFC1918 stay allowed and the operator's `requestProxy.*` and `privateAddressWhitelist.*`
apply through the new `outbound.UserURLDialContext`/`UserURLProxy`, so enabling the private filter no longer
leaves `/proxy` as a bypass; DNS rebinding is closed by resolving once and dialling only a checked address.

### Chat auto-backups: pinned semantics, not an empty directory

alpha.17 recorded pinned's throttled chat backup as an unimplemented gap. It is implemented
(`internal/server/chat_backup.go`): config read once at boot with `getConfigValue` precedence (env >
`config.yaml` > pinned default; `backups.chat.enabled` true, `throttleInterval` 10 s, `maxTotalBackups` -1,
`backups.common.numberOfBackups` 50), `getBackupKey` with pinned's sanitize-filename step, UTF-16 code-unit
underscore replacement and `_<sha256(name)[:8]>` suffix for non-ASCII names, local
`YYYYMMDD-HHmmss` filenames, atomic writes carrying exactly the saved JSONL bytes, per-chat retention then a
global `chat_` prune only when `maxTotalBackups >= 0`, a lodash-throttle equivalent (leading synchronous, one
trailing edge with the latest bytes, per `${handle} ${cardName}`), and a graceful-shutdown flush. A backup
failure never changes the save response and never leaves a partial file; unknown files and other chats are
never pruned. 49 focused tests cover the pinned-Node `getBackupKey` oracle (45 key rows), retention
(including pinned's fractional comparison), failure injection, restart, multi-user isolation, concurrency
and the flush. Two deliberate records: `chat_metadata.integrity` verification is still NOT implemented
(pinned answers 400 `{"error":"integrity"}`), and pinned also schedules a backup on
`/api/chats/group/save` which this release does not wire.

### Streaming and cancellation: real sockets, real cancels, no invented defect

`tests/e2e/streaming_cancel_socket_test.go` drives the production generate route through a real HTTP server
and real TCP provider peers: 46 upstream write-boundary shapes (every byte offset, coalesced, one-chunk) stay
byte-identical with no U+FFFD; each chunk is flushed incrementally; gzip streams decode and cancel still
closes the upstream; a missing `[DONE]` ends cleanly at EOF; a mid-frame provider death forwards the partial
bytes and holds the response open (pinned capture `driverTimedOut:true`) until the client cancels; client
cancel and body close close the provider connection within 10-21 ms with goroutines back at baseline; 50
sequential and 8 concurrent cancels leak no goroutine or socket; and a slow client stops upstream transfer
with zero buffer growth. No production defect was proven, so no production streaming code changed — the
honest outcome — and two coverage defects were fixed: the suite lives in `tests/e2e` because
`internal/server`'s test binary pins the wire-exact client (so a test there measures the oracle instrument,
not the production transport), and `TestUnsolicitedGzipIsDecodedByTheTransportAndTheConnectionIsReleased`
was moved to `internal/outbound`, where it now executes instead of skipping on every run.

### Release evidence rails: applied, and proven to refuse

alpha.17 designed the rails; alpha.18 applies them. `docs/release-manifest.json` now carries, per gate,
`requiredJobs` (a skipped job is refused), `requiredSelection` (the CI `probes=full` and Browser `mode=all`
run names, and the full-job selections of the multi-job gates), `pinnedSha`
(`06bde939…`), `requiredPinnedSha` where the evidence writes it as `pinnedCommit`, and API artifact
digest/freshness checks on the four artifact-bearing gates. `release.yml` emits the unified
`release-evidence.json`/`.md` before publishing, asserts the publish checkout is the tag target and uploads
the contract. The rails were validated with REAL runs: a full-selection Docker dispatch was accepted
(verifier PASS 1/1) while a `long-lived … -f size=small` dispatch that concluded success was refused
(`job-not-green … required job "medium-corpus" is completed/skipped`), and the alpha.17 wave re-judged under
the applied manifest is 11/13 with the two pre-run-name titles refused and all four artifact rails green.

## Performance

The release's graded performance record remains the same-SHA `GoTavern smoke metrics` gate (paired and soak
jobs) required by `docs/release-manifest.json`; the same-SHA evidence table appended to this release names
the run. The README's four-row Go-vs-Node table and both figure variants still restate the committed
paired artifact `tests/perf/q22-baseline.json` (run `42012475880` at `f1396ce`, an ancestor of this
candidate) and are recomputed by `tools/check-perf-docs.mjs` in CI; alpha.18 does not reseed those four
metrics and does not splice its own numbers into them.

alpha.18's own performance evidence is card-scale and is LOCAL (Windows arm64, 2 cores), recorded in
`docs/alpha18/perf/`:

| scale / metric | alpha.17 | alpha.18 | change | round spread (baseline → candidate) |
|---|---:|---:|---:|---|
| 10,000 cards, list ns/op | 5,734.9 ms | **2,295.9 ms** | **−60.0%** | 4,963.9-9,126.7 → 2,246.7-3,029.2 |
| 10,000 cards, list B/op | 1,038.7 MB | **619.9 MB** | **−40.3%** | deterministic |
| 10,000 cards, list allocs/op | 7,797,016 | **3,193,667** | **−59.0%** | deterministic |
| 1,000 cards, ns/op | 606.8 ms | **402.3 ms** | **−33.7%** | 605.1-696.7 → 347.9-417.0 |
| 100 cards, ns/op | 75.1 ms | **55.6 ms** | **−26.0%** | 69.5-138.2 → 51.6-58.7 |
| 10,000-card cold-cache allocs/op | 8,030,352 | **3,500,341** | **−56.4%** | deterministic (cold TIME not claimed) |
| 10,000-card boot, freshly generated tree | 30,757 ms | **3,661 ms** | −88.1% | first-touch host cost, see below |
| 10,000-card warm boot | 633 ms | **165 ms** | −73.9% | single/few observations |

The process-level paired run (published alpha.17 archive vs this candidate, four alternating rounds per
scale, a fresh identical tree each round) measured boot and `/api/characters/all` on the same host:

| scale | boot → first `/version` 200 | `/api/characters/all` median | steady RSS |
|---|---:|---:|---:|
| 10,000 cards | 28,017 → **351 ms** | 5,744 → **2,739 ms** (−52.3%) | 1,023.5 → 986.2 MB |
| 1,000 cards | 2,956 → **192 ms** | 533 → **247 ms** (−53.7%) | 94.4 → 100.6 MB |
| 100 cards | 454 → **183 ms** | 86 → **70 ms** (−18.6%) | 29.5 → 31.3 MB |
| mixed large | 3,132 → **804 ms** | 529 → **257 ms** (−51.4%) | 90.4 → 98.1 MB |

The graded 20% bar is met by the key-request p50 (52.3% process-level, 60.0% in-process). Peak RSS did NOT
improve (median 1,040.0 → 1,107.6 MB at 10,000 cards) and both subjects span roughly the same 1.0-1.15 GB
range, so memory is reported as not improved rather than as noise-flattered parity; the steady-RSS changes
are likewise inside the four-sample spread. The cold-boot gain is the removed per-card startup access.
The boot row is attributed, not just observed: the identical tree copied to a new directory booted in
887 ms under alpha.17 code, a tree with the cards moved out of the listing booted in 3,955 ms, and a boot
delayed by 60 s was still slow — so the cost was the product's per-card file access on a freshly written
tree (the host's on-access scanner charges kernel time for it), and the change removes those accesses. The
process-level paired A/B (published alpha.17 archive vs this candidate, four alternating rounds per scale,
boot/RSS/peak/RSS/HTTP latency) and the 60-minute soak are recorded in `docs/alpha18/perf/abba-process.json`
and `docs/alpha18/perf/soak-60min.json`; like the table above they are LOCAL Layer A evidence, not the CI
gate.

## Compatibility

The compatibility contract is unchanged: pinned SillyTavern `1.19.0` at `06bde939…` is the only oracle; the
unmodified upstream frontend and the `data/` layout are used directly; there is no conversion layer and no
private database; unknown fields and unknown files are preserved; sensitive writes keep the existing lock and
atomic-replace semantics. alpha.18 adds two implemented surfaces (`/proxy/` enabled, per-chat backups) and
records their divergences/limits in `docs/SEMANTIC-COMPATIBILITY.md` §18 instead of absorbing them into a
"compatible" claim, alongside the still-open `chat_metadata.integrity` gap and the group-save backup
scheduling gap.

## Known limitations

- **`GOAL.md` §14 remains NOT MET.** No real, long-used user directory has been qualified; the private
  channel's disposition is `PRIVATE_NOT_RUN`. Everything this release claims is synthetic/generated.
- **darwin/arm64 runtime is UNVERIFIED** (the archive is built and archive-inspected, not executed, and the
  macOS arm64 extension lifecycle is UNVERIFIED). **windows/arm64 is BUILD-ONLY.**
- **The 10,000-card and startup numbers are LOCAL** Windows-arm64 Layer A evidence, measured with the subject
  binaries named in `docs/alpha18/perf/README.md`; the CI release claim is the same-SHA `smoke metrics` gate.
- `chat_metadata.integrity` is NOT enforced, so an overwrite of a chat another client changed is not refused
  with pinned's 400; group saves do not schedule backups; `/proxy`'s brotli policy is a retry for GET/HEAD
  and a refusal for mutating methods (no brotli decoder, no new dependency allowed).
- The **soak cannot prove absence of a leak**: handles/FDs and live heap are not observable on this host, so
  the artifact reports `UNPROVEN` instead of inferring one from RSS; the soak drives storage/settings routes
  and does NOT exercise provider streaming (covered by the socket suite instead).
- **8-user latency is REPORT-ONLY**, a **true kernel ENOSPC is UNPROVEN**, **page-init egress hermeticity**
  remains OPEN, and provider-relay p99 / streaming-cancellation latency / the 20-extension page-load matrix
  are UNEXECUTED, all with their reasons in the repository's performance and audit records.
- No tag was moved, no force push and no `--no-verify` were used; the alpha.16 and alpha.17 tags are
  unchanged.

## Artifacts

The release publishes the six canonical archives and their `checksums.txt`:

- `gotavern-linux-amd64.tar.gz`
- `gotavern-linux-arm64.tar.gz`
- `gotavern-darwin-amd64.tar.gz`
- `gotavern-darwin-arm64.tar.gz`
- `gotavern-windows-amd64.zip`
- `gotavern-windows-arm64.zip`

Verify them with `sha256sum -c checksums.txt` in the download directory. The container image is published as
`:v0.1.0-alpha.18` and `:latest` as the same digest. Runtime qualification is recorded by the publish run's
own execution jobs and the appended evidence table: linux/amd64 and windows/amd64 are native, linux/arm64
runs under QEMU, darwin/amd64 runs on a native macOS runner, darwin/arm64 is built and archive-inspected but
not executed, and windows/arm64 is build-only, for the reasons in Known limitations.

## Evidence

The same-commit required-gate table is appended to this body by the publish job, so every claim above is
checkable against the runs that judged this candidate. The publish job refuses to create the release unless
`scripts/verify-release-gates.mjs` passes all 13 gates, including every required job, the applied selection
rails and the embedded evidence document inside each required artifact. The working record for this
candidate is `docs/alpha18/handoff-ledger.md` and `docs/alpha18/same-sha-evidence.md`; the performance record
is `docs/alpha18/perf/`, `docs/alpha18/perf-hotspot.md` and `docs/performance.md`; the evidence contract is
`docs/alpha18/evidence-contract.md`; the release-governance changes are recorded in the same document and in
`scripts/release-governance.test.mjs`. `docs/goal-scorecard.md` is the per-question ledger and `HANDOFF.md`
is the current checkpoint.
