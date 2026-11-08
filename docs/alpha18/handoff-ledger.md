# alpha.18 handoff ledger — candidate, gates, publication

**Live state.** This file is the working record for the alpha.18 release. `PENDING` rows are open obligations;
the release does not happen while any of them is open. Post-release rows are filled in a documentation commit
after publication, which does not move the tag.

## 1. Candidate

| fact | value |
|---|---|
| product commits | `481d6ee` CORS proxy, `eb46485` chat backups, `ef2f69a` streaming coverage + moved gate, `5aef3db` 10,000-card performance fix, `e40314f` release-evidence rails applied |
| docs/candidate commit | the commit that contains this file (frozen after push; see `docs/alpha18/release-bar.md`) |
| baseline | SillyTavern 1.19.0 @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127` (unchanged) |
| previous releases | `v0.1.0-alpha.16` (tag object `b7d81cd…` → `c1886d7…`), `v0.1.0-alpha.17` (tag object `7eed8ee…` → `9b99fde…`) — both immutable, neither moved |

## 2. Product changes and their evidence

| commit | change | local evidence |
|---|---|---|
| `5aef3db` | 10,000-card request + startup: listing-supplied card cache identity, ctime from the read handle, direct differentially-pinned JSON string escaper, allocation-free UTF-16 length, listing metadata in `DiskCache.verify`, one chats-root listing in statistics | paired in-process ABBA 24 rows (`docs/alpha18/perf/abba-inprocess.json`): 10,000-card p50 −60.0%, B/op −40.3%, allocs −59.0%; 1,000/100 cards −33.7%/−26.0%; boot attribution table `docs/alpha18/perf/README.md` §3; full `internal/server` + `internal/startup` suites green |
| `481d6ee` | real CORS proxy enabled branch (+`outbound.UserURLDialContext`/`UserURLProxy` so requestProxy/privateAddressWhitelist apply); disabled branch unchanged; bounded timeouts, metadata refusal, DNS-rebinding closure, brotli retry policy | 35 local-upstream tests green; mutation returning `"{}"` produced a named RED and was restored |
| `eb46485` | pinned chat auto-backups (config, key, timestamp, atomic write, retention, throttle, shutdown flush) | 49 tests green incl. pinned-Node `getBackupKey` oracle; two mutation REDs restored |
| `ef2f69a` | 13 real-socket streaming/cancellation tests; moved the always-skipping gzip gate to `internal/outbound` where it executes | 13/13 green; three mutation REDs (context dropped, flush removed, truncation hold removed) restored |
| `e40314f` | applied release-evidence rails (requiredJobs/requiredSelection/pinnedSha/digest/freshness), release-chain evidence emission, run-name selection proof | Docker full-selection run accepted (verifier PASS 1/1); `-f size=small` long-lived dispatch refused for skipped `medium-corpus`; alpha.17 wave re-judged 11/13; local governance suite 87/87 |

## 3. Verification matrix (local, pre-freeze)

| check | command | result |
|---|---|---|
| full server package | `go test ./internal/server -count=1` | green (153 s) |
| startup package | `go test ./internal/startup -count=1` | green (26 s) |
| CORS proxy | `go test ./internal/server -run TestCorsProxy -count=1` | 35/35 |
| chat backups | `go test ./internal/server -run TestChatBackup -count=1` | 49/49 |
| streaming sockets | `go test ./tests/e2e -run TestStreaming -count=1` | 13/13 |
| outbound (moved gzip gate) | `go test ./internal/outbound -run TestUnsolicitedGzip -count=1` | pass |
| vet | `go vet ./internal/server ./internal/outbound` | clean |
| version classifier | `bash scripts/test-classify-version-tag.sh` | 74/74 |
| governance | `node --test scripts/release-governance.test.mjs` | 87/87 |
| perf docs | `node tools/check-perf-docs.mjs` + `node --test tests/docs/check-perf-docs.test.mjs` | green, 15/15 |
| full e2e package | `go test ./tests/e2e -count=1 -timeout 25m` | green, 678 s on this host (96 top-level tests incl. the crash matrix and the 13 socket tests). The Go default per-package timeout is 10 m and this host exceeds it; Linux CI ran the same package in 150 s at alpha.17, so the CI `go test ./...` step is unaffected — recorded rather than silently widened. |
| race | `go test -race` on this host | **UNEXECUTED — unsupported on windows/arm64**; the Linux CI `race` job is the gate |

## 4. Same-SHA 13-gate wave

PENDING. Filled from `scripts/verify-release-gates.mjs` output in `docs/alpha18/same-sha-evidence.md` (one row
per gate: workflow name, run id, event, head SHA, conclusion, required jobs, artifact digest, selection proof).

## 5. Release rehearsal, tag and publication

PENDING: rehearsal run id, the annotated tag object and its peeled commit, `GoTavern Release` run id,
publication timestamp and flags, asset list, Docker digest, and the post-publication verification (checksums
6/6 re-downloaded, published binary `version`, unpacked run with a real data request and a write/read closure,
install smoke, published-extension smoke, `releases/latest`, alpha.16/alpha.17 tags unchanged).

## 6. Post-release evidence (added after publication, tag untouched)

PENDING: 60-minute soak artifact, process-level paired ABBA artifact, and the same-SHA table copied into
`docs/alpha18/same-sha-evidence.md`.

## 7. Residual, stated rather than implied

`GOAL.md` §14 NOT MET; darwin/arm64 runtime + macOS arm64 extension lifecycle UNVERIFIED; windows/arm64
BUILD-ONLY; the 10,000-card and startup numbers are LOCAL; the soak's leak verdict is UNPROVEN by construction;
`chat_metadata.integrity` and group-save backup scheduling are unimplemented; no brotli decoder; provider-relay
p99, streaming-cancellation latency, the 20-extension page-load matrix and page-init egress remain
UNEXECUTED/OPEN with their reasons in the repository records.
