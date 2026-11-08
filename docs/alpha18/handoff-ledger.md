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

## 4. Same-SHA 13-gate wave — PASS 13/13 at `a417721`

Official verifier at `a41772152a76cd3c42c52b63f2a377e2963de6fd` (output archived as
`docs/alpha18/release-evidence.json` / `.md`, full table in `docs/alpha18/same-sha-evidence.md`):

| # | required workflow | run | event | conclusion | required jobs |
|---|---|---|---|---|---|
| 1 | GoTavern CI | 42465368654 | workflow_dispatch | success | changes, browser-evidence, verify, crash-gate, race, oracle |
| 2 | GoTavern whole-session differential | 42465370968 | workflow_dispatch | success | whole-session |
| 3 | GoTavern world-info slot ordering | 42465373081 | workflow_dispatch | success | worldinfo-slots |
| 4 | GoTavern drop-in qualification | 42465375433 | workflow_dispatch | success | dropin-current-head, windows-inputs, dropin-windows |
| 5 | Browser differential | 42465378269 | workflow_dispatch | success | differential |
| 6 | GoTavern release qualification | 42465380701 | workflow_dispatch | success | qualify-linux-amd64, qualify-windows-amd64, qualify-dropin-linux, qualify-published-alpha9-upgrade, qualify-upgrade-rollback |
| 7 | GoTavern smoke metrics | 42465383084 | workflow_dispatch | success | measure-linux-amd64, paired-linux-amd64 |
| 8 | GoTavern Docker image | 42465385438 | workflow_dispatch | success | docker |
| 9 | Helper state differential | 42465387697 | workflow_dispatch | success | helper state differential (ubuntu, bounded) |
| 10 | Combination journey differential | 42465389791 | workflow_dispatch | success | combination-journey + embedded evidence |
| 11 | Third-party extension compatibility | 42465391902 | workflow_dispatch | success | selftest, aggregate, corpus, soak, overhead, macos-arm64-recorded-limitation + embedded evidence |
| 12 | GoTavern long-lived corpus qualification | 42465394362 | workflow_dispatch | success | medium-corpus + embedded evidence |
| 13 | GoTavern Node stock tree round trip | 42465396530 | workflow_dispatch | success | node-stock-tree + embedded evidence |

Verifier verdict: **PASS: 13/13 required workflow(s) are green at this SHA.** The selection rails were
satisfied by the run names (`GoTavern CI probes=full`, `Browser differential mode=all`) and the four
artifact gates were digest/freshness/pinned-member checked from these runs.

**The first wave at `2216617` was refused and is recorded, not hidden.** 12/13 were green; `GoTavern CI`
run `42444382437` failed in `oracle` because the new chat auto-backup's timestamped filename made the
runtime-round-trip probe non-deterministic across its double run (exact paths in
`docs/alpha18/same-sha-evidence.md` §4), and `Browser differential` run `42444390807` failed with an
identical-on-both-subjects driver fault in the asset leg (helper/Q20 legs could not drive). The oracle probe
was fixed and the fixture re-recorded in `a417721` (test infrastructure only; the shipped binary is
unchanged), all thirteen gates were re-dispatched, and the full wave is green there. No product claim rests
on the refused wave.

## 5. Release rehearsal, tag and publication

- **Pre-tag rehearsal.** `GoTavern Release` **42465398892** (workflow_dispatch, completed/success) built and
  archive-inspected the six archives, executed the linux/arm64 and darwin/amd64 legs, recorded the
  darwin/arm64 limitation and the windows/arm64 boundary, and passed `prepublish-qualification`; it
  published nothing (a dispatch cannot publish). It ran at the same frozen candidate `a417721`.
- **Benchmark comparison.** `GoTavern bench profiles` **42465401011** (workflow_dispatch, success) compared
  the candidate against the regenerated committed baseline: `comparison: passed`, `failures: 0`.
- **Tag.** PENDING — annotated tag `v0.1.0-alpha.18` created at `a417721` only after this PASS.
- **Publication.** PENDING — `GoTavern Release` tag-push run, release flags, assets and body.
- **Post-publication verification.** PENDING — see §6.

## 5. Release rehearsal, tag and publication

PENDING: rehearsal run id, the annotated tag object and its peeled commit, `GoTavern Release` run id,
publication timestamp and flags, asset list, Docker digest, and the post-publication verification (checksums
6/6 re-downloaded, published binary `version`, unpacked run with a real data request and a write/read closure,
install smoke, published-extension smoke, `releases/latest`, alpha.16/alpha.17 tags unchanged).

## 6. Post-release evidence

- **60-minute soak (clean run, frozen candidate).** `docs/alpha18/perf/soak-60min.json`: 60.0 min,
  28,932 requests, **0 errors**, p50 28.87 ms / p95 254.12 ms / p99 271.05 ms / max 825.47 ms, peak RSS
  122.6 MB, five restarts, saved-chat integrity 6/6 across restarts, 59/59 external-modification probes,
  239/239 availability checks, no orphan process. Leak verdict **UNPROVEN** (RSS-only; the segment growth is
  consistent with a bounded cache fill and is not claimed as leak-free). The first attempt
  (`soak-60min-attempt1.json`) is kept because its single failure was an unrelated leftover `gotavern.exe`
  from an earlier local e2e run that the harness correctly refused to ignore.
- **Process-level paired ABBA.** `docs/alpha18/perf/abba-process.json` (published alpha.17 binary vs this
  candidate, four alternating rounds): 10,000-card boot 28,017 -> 351 ms, list median 5,744 -> 2,739 ms
  (-52.3%), 1,000 cards 2,956 -> 192 ms / 533 -> 247 ms, mixed-large 3,132 -> 804 ms / 529 -> 257 ms.
- **In-process ABBA.** `docs/alpha18/perf/abba-inprocess.json`: 10,000-card list -60.0% ns/op, -40.3%
  B/op, -59.0% allocs/op; 1,000 cards -33.7%; 100 cards -26.0%.
- **CI benchmark gate.** The regenerated `tests/perf/bench-baseline.txt` was produced by `bench profiles`
  run 42441324943 at `5aef3db` (Linux CI: 10,000-card row 1,398.7 -> 664.8 ms), and run 42465401011
  compares the candidate against it with `comparison: passed`.

## 7. Residual, stated rather than implied

`GOAL.md` §14 NOT MET; darwin/arm64 runtime + macOS arm64 extension lifecycle UNVERIFIED; windows/arm64
BUILD-ONLY; the 10,000-card and startup numbers are LOCAL; the soak's leak verdict is UNPROVEN by construction;
`chat_metadata.integrity` and group-save backup scheduling are unimplemented; no brotli decoder; provider-relay
p99, streaming-cancellation latency, the 20-extension page-load matrix and page-init egress remain
UNEXECUTED/OPEN with their reasons in the repository records.
