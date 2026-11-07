# alpha.17 — computed test-gap matrix

**Status: PROPOSED (computed from the tree on 2026-11-07; HEAD `eaf8c22` plus the untracked alpha.17 test files).**
This file is a measurement, not a coverage claim: every number was produced by the command printed beside it,
every "covered" cell names a file that exists, and a cell that was not located by the recorded searches says
`NOT LOCATED`, never `covered`. `N/A` is not a pass. The companion catalogue is
`docs/alpha17/niche-scenario-catalog.md` (assembled from `docs/alpha17/catalog/`).

## 1. Counts, recomputed (not quoted)

| measurement | value | command |
|---|---|---|
| git-tracked files | 2,376 | `git ls-files \| Measure-Object -Line` |
| files under `tests/` | 619 | `git ls-files tests \| Measure-Object -Line` |
| tracked Go files (repo, incl. `upstream/`) | 621 | `git ls-files '*.go' \| Measure-Object -Line` |
| tracked Go test files (excluding `upstream/`) | 321 | `git ls-files '*_test.go'` filtered |
| top-level `Test|Benchmark|Fuzz` functions (tracked) | 978 | `Select-String -Pattern '^func (Test|Benchmark|Fuzz)[A-Z]'` over those files |
| **new alpha.17 niche tests** (7 untracked files) | **33** | `Select-String` over `tests/e2e/niche_*.go` |
| provider-wire scenarios | **262** | `node -e "Object.keys(require('./tests/oracle/sillytavern-1.19.0-provider-wire.json').scenarios).length"` |
| committed browser JSON artefacts | 43, of which 40 are comparison artefacts | `node -e` over `tests/browser/*.json` |
| required release gates | **13** | `node -e "require('./docs/release-manifest.json').requiredGates.length"` |
| internal packages / first-party import edges | 18 / 20 | `go list ./internal/...`; `go list -f '{{.ImportPath}} {{range .Imports}}{{.}} {{end}}' ./internal/...` |

Test functions per package (top-level declarations, tracked files only):

| package | test files | test/bench functions |
|---|---|---|
| `internal/server` | 190 | 590 |
| `internal/outbound` | 12 | 59 |
| `tests/e2e` | 24 (+7 new niche files) | 52 (+33 new) |
| `internal/startup` | 22 | 51 |
| `internal/app` | 13 | 35 |
| `cmd/gotavern` | 6 | 30 |
| `internal/commandline` | 9 | 26 |
| `internal/longlivedfixture` | 4 | 18 |
| `tests/egressguard` | 2 | 16 |
| `internal/tokenizers` | 4 | 16 |
| `internal/fixtures` | 2 | 14 |
| `internal/migrate` | 1 | 14 |
| `internal/configinit` | 6 | 14 |
| `internal/adversarial` | 2 | 9 |
| `tests/mockprovider` | 1 | 8 |
| `internal/fsretry` | 4 | 6 |
| `internal/assetmanifest` | 2 | 6 |
| `internal/lockacquire` | 1 | 4 |
| `internal/outbound/proxytest` | 1 | 4 |
| `internal/httpx` | 1 | 4 |
| `internal/userdata` | 1 | 2 |

## 2. Domain matrix

"Real oracle" means a recorded pinned capture/artefact (not a self-written expectation); "negative control"
means a committed test that plants a defect and observes the named failure. `NOT LOCATED` means the searches
recorded in §4 found no such test — it is a prompt to look, not proof of absence (AGENTS rule 11).

| domain | existing coverage (files / count) | real pinned oracle | negative control | wired in CI | gap severity | top gaps |
|---|---|---|---|---|---|---|
| FS / path extremes | `tests/e2e/a15_path_identity_test.go`, `a15_external_modification_test.go`, `a15_reader_during_write_test.go`, `a15_concurrent_writers_test.go`, `startup_data_root_test.go`; 33 new `niche_fs` rows | partial (no pinned capture for name bytes; source-derived from `src/usernames.js`/`sanitize-filename`) | `a15_*` corrupt-tree tests plant damage; new `niche_teeth_test.go` | `go test ./...` in `GoTavern CI verify` | MED | NFC/NFD distinctness on APFS; Windows junction/reparse; NTFS ADS; inode-reuse after external replace |
| DATA / JSON / JSONL | `config_duplicate_key_test.go`, `startup` JSON formatting tests, new `niche_data` rows | source-derived from pinned `JSON.stringify`/JSONL writers; no byte captures for BOM/non-UTF-8 | new `niche_teeth_test.go` (wrong-key/order/truncation cases) | `go test ./...` | MED | non-UTF-8 settings body; duplicate-key precedence pinned capture; huge-int/float round-trip |
| Persistence / crash | `a15_settings_crash_test.go`, `chat_crash_test.go` + harness, `a15_migrate_crash_test.go`, `a15_efbig_linux_test.go`, `scenario_state_machine_test.go` (2,000 sequences) | partial (pinned parity shown by B-H4 probe; EFBIG substitute only) | `scenario_state_machine_teeth_test.go` (14 planted defects), `a15_*` corruption cases | `go test ./...`; `-race` job for selected packages | MED | true kernel ENOSPC (needs privileged small mount); close()-failure seam; Windows sharing residual |
| HTTP boundary | `internal/server` handler tests (590), `whitelist_test.go`, CORS/CSRF/compression suites; new `niche_http` rows | `tests/oracle/sillytavern-1.19.0-*.json` observations for status/shape | planted comparator cases in `internal/server` tests; new `niche_teeth_test.go` | `go test ./...`; browser-evidence job | MED | body exactly at limit vs +1 byte per route; duplicate headers/cookies byte comparison; panic-boundary 500 compression shape |
| Provider wire | **262** recorded scenarios + `chat_completions_oracle_test.go`; `tests/provider-wire/DESIGN.md` | YES (recorded pinned capture, byte-oriented `bodySha256`/raw target) | scenario-count and missing-capture tests; `provider-wire` probe mutation rules in `tools/oracle` | `GoTavern CI oracle` (dispatch); nightly full sweep | LOW | redirect 301/302/303/307/308 credential stripping; proxy auth; IPv4-mapped IPv6; TLS expiry/trust |
| SSE / streaming / cancel | `internal/server` streaming tests, browser streaming artefacts, cancellation legs in browser workflows; new `niche_streaming` rows | YES for provider-wire `data:` framing; browser artefacts for cancel | browser comparator guards + new `niche_teeth_test.go` | `GoTavern CI`, `Browser differential`, long-lived | HIGH | one frame split per TCP chunk; UTF-8 mid-character split; [DONE] missing; goroutine leak after cancel; slow-client backpressure |
| Prompt / tokenizer / WI | preset differential in `Browser differential` (105/119 prompts), `tests/oracle/*tokenizers*.json` | YES (browser artefacts, tokenizer captures) | combined-journey comparator; `harnessDiscriminates` | `Browser differential`, `Combination journey differential` | MED | token budget N-1/N/N+1; 120+ block ordering; recursive secondary keys; zero-width/Unicode regex; tokenizer response BYTES (known fixture limitation) |
| Extensions / browser | 20-extension corpus (lock file), `tests/browser/extension-*-comparison.json`, `extensions_*_test.go` | YES (two pinned canaries + 20-corpus evidence) | corpus aggregator refuses a missing shard/marker; helper-state 30-guard judge | `Third-party extension compatibility`, `Browser differential`, `Helper state differential` | MED | real code execution changing the provider request per extension; update-failure rollback; branch switch; multi-extension event conflicts |
| Concurrency / multi-account | `scenario_state_machine_test.go` (8 accounts), `account_reset_save_race_test.go`, `data_safety_concurrency_test.go`, 8-user perf harness | partial (pinned parity argued from source; no pinned concurrent capture) | reset-vs-save probe asserts isolation; perf correctness checks | `go test ./...`, `M5 measurements` (report-only row) | MED | cross-account read/write under simultaneous reset; cache invalidation races; same chat filename across users |
| Security / SSRF | `internal/commandline/privateaddress_test.go`, `internal/outbound/transport_matrix_test.go`, `whitelist_test.go`, `tests/egressguard` | source-derived from pinned middleware; egress guard proves refusal in the harness | egress-guard refusal cases; transport matrix | `go test ./...`, `GoTavern CI` | MED | redirect SSRF (cross-origin credential stripping); DNS rebinding; compression bomb; ReDoS in user regexes |
| CLI / installer / Docker / OS | `cmd/gotavern/cli_test.go` (30), installer qualification workflows, `release-qualification.yml` | YES (release-qualification executes the artifact; installer mirror) | release-qualification mutation run; classify-tag test (69 cases) | `GoTavern release qualification`, `GoTavern Release`, `GoTavern Docker image` | MED | PowerShell 5.1 vs 7 execution; non-admin/readonly dir; SIGINT twice; heartbeat-writer wedge; macOS arm64 (UNPROVEN) |
| Perf / cache | `internal/server/bench_test.go`, `tests/perf/*` (q22 baseline, m5 harness), `scripts/smoke-metrics.mjs` | YES (recorded paired artifact: run 42012475880 @ f1396ce) | `tests/perf/m5-eight-users.mjs --self-test` (26/26), checker recomputation | `GoTavern smoke metrics`, `GoTavern bench profiles`, `M5 measurements` | MED | cold-cache guard row; process-level scale; provider-relay p99; streaming cancellation latency; 20-extension page load |
| Release governance | `scripts/release-governance.test.mjs` (69 cases), `verify-release-gates.mjs`, `assemble-release-body.mjs` | YES (real alpha.16 wave at c1886d7 validated) | synthetic API responses with named refusals | `GoTavern CI verify` | MED | unified evidence contract; dispatch-selection proof; artifact digest binding; stale-artifact refusal |

## 3. The new alpha.17 tests (33 functions, `tests/e2e/niche_*.go`)

| file | focus | negative-control file |
|---|---|---|
| `niche_fs_test.go` | path/name extremes, unknown-field and external-replacement preservation | `niche_teeth_test.go` |
| `niche_data_test.go` | BOM/CRLF/truncated/duplicate-key/huge-value JSON and JSONL | `niche_teeth_test.go` |
| `niche_http_test.go` | methods, content types, limits, headers, cookies, CSRF/CORS, ETag/304 | `niche_teeth_test.go` |
| `niche_streaming_test.go` | chunk-split frames, multibyte split, missing [DONE], mid-stream abort, cancel | `niche_teeth_test.go` |
| `niche_persistence_test.go` | failure injection across the write stages, old/new integrity | `niche_teeth_test.go` |
| `niche_support_test.go` | shared harness helpers for the suite (documented reuse points) | — |
| `niche_teeth_test.go` | planted-defect cases that must fail by name through the same comparators | — |

## 4. Ranked top-30 highest-value gaps

Ranking: user-visible or data-safety consequence first, then whether a real pinned oracle exists, then cost.
Each row's "coverage" is what the §1/§2 searches located; `NOT LOCATED` means no test was found by those
searches, not that absence is proven.

| # | gap | domain | why high value | coverage located | smallest new evidence | reuse |
|---|---|---|---|---|---|---|
| 1 | SSE frame split across TCP chunks at every boundary | streaming | parser bugs are silent and user-visible as garbled text | NOT LOCATED | chunked mock provider writes + exact downstream bytes | `tests/mockprovider` |
| 2 | UTF-8 multibyte split across chunks | streaming | same, and it corrupts CJK/emoji output | NOT LOCATED | same harness, split inside a 3-byte rune | `tests/mockprovider` |
| 3 | missing `[DONE]` + mid-stream upstream abort | streaming | hangs a chat turn or leaves a half reply | browser cancellation legs only | assert terminal state and goroutine count | `tests/e2e` harness |
| 4 | client cancel propagates to provider and releases the socket | streaming | resource leak class | browser artefacts (cancel) | mock peer observes close; goroutine poll | `tests/mockprovider` |
| 5 | body exactly at a route's limit and +1 byte | HTTP | 413 boundary is easy to get wrong and is user-visible | NOT LOCATED (per-route) | table over the real caps in code | `tests/e2e` |
| 6 | duplicate headers / duplicate cookies / cookie order | HTTP | parsing ambiguity changes auth/CSRF decisions | NOT LOCATED | raw TCP request writer | `tests/e2e` |
| 7 | panic-boundary 500 response shape (compression/Content-Length) | HTTP | a 500 that bypasses wrappers can hang clients | NOT LOCATED | force a panic route, compare headers | `internal/server` tests |
| 8 | same-size + same-mtime external replacement of settings/cards | FS/cache | silent stale reads of user edits | pinned by a test that documents the residual | identity/change-stamp discriminator | `settings_cache_test.go` |
| 9 | NFC vs NFD filename distinctness on the running OS | FS | card/chat names collide on one platform | NOT LOCATED | two files differing only by normalisation | `tests/e2e` |
| 10 | Windows junction/reparse-point handling | FS | traversal / data-root escape | Windows-only kinks in `a15_*` | mklink /J guarded test | `tests/e2e` |
| 11 | true kernel ENOSPC (not EFBIG) | persistence | data-safety under full disk | EFBIG substitute only | needs a privileged small mount (UNEXECUTED) | `a15_efbig_*` |
| 12 | close()-failure and rename()-failure injection | persistence | temp residue / lost write | rename path partly covered | fault seam per syscall | `internal/faultinject` |
| 13 | cross-account read/write during simultaneous reset | concurrency | data isolation | reset-vs-save probe (same user) | two users, one reset, one save, both read | `account_reset_save_race_test.go` |
| 14 | cache invalidation race under external replacement | cache | silent stale value | pinned residual test only | writer + reader + replacement | `settings_cache_test.go` |
| 15 | redirect SSRF + credential stripping on 301/302/303/307/308 | security | leaks provider key to a redirect target | NOT LOCATED | controlled peer + redirect chain | `internal/outbound` |
| 16 | DNS rebinding / IPv4-mapped IPv6 private address | security | SSRF bypass | private-address dial list only | resolver seam + dial filter assertion | `privateaddress_test.go` |
| 17 | compression bomb / deep JSON / ReDoS in user regex | security | CPU/memory exhaustion | NOT LOCATED | bounded-read + timeout assertions | `internal/server` |
| 18 | token budget N-1/N/N+1 around the context boundary | prompt | truncation changes the model context | partial (complex preset boundaries) | three exact-boundary cases per preset | browser differential harness |
| 19 | 120+ prompt-block ordering with disabled/duplicate rows | prompt | preset semantics | combined journey (staged) | ordered marker list assertion | `combination-journey-probe.mjs` |
| 20 | recursive world-info secondary keys + exclude/prevent recursion | prompt/WI | activation differs silently | partial (world-info slots gate) | nested books + ordered activation assertion | `worldinfo-slots.yml` |
| 21 | zero-width/Unicode/backreference regex semantics | prompt | user-visible text corruption | NOT LOCATED | table over generated texts | `internal/server` regex tests |
| 22 | tokenizer response BYTES (not parsed values) | tokenizer | known fixture limitation (U+FFFD + HTML escaping) | fixture documents the gap | record pinned raw bytes into the fixture | `tools/probe-tokenizers.mjs` |
| 23 | extension code execution that changes the provider request | extension | "files load" is not compatibility | helper-state/combination guards | per-extension provider-request delta | `tests/browser` |
| 24 | extension update failure / interrupted install / branch switch rollback | extension | user data + trust | lifecycle legs on the corpus | fault-injected git operation | `third-party-extension-compat.yml` |
| 25 | PowerShell 5.1 installer execution | CLI/installer | Windows user path | pwsh 7 / mirror legs only | Windows runner + PS5.1 | `release-install-smoke.yml` |
| 26 | second SIGINT during drain | CLI/process | shutdown claim | `TestSecondSignal...` exists | assert in-flight request abort | `cmd/gotavern` tests |
| 27 | heartbeat writer wedge during shutdown | CLI/process | hang at exit | `TestHeartbeatStopIsBounded` exists | blocking-FS seam | `internal/app` |
| 28 | cold-cache benchmark guard row | perf | cache regression was measured before and is unguarded | baseline README names it absent | cold/warm bench pair with committed baseline | `tests/perf` |
| 29 | provider-relay p99 and streaming cancellation latency | perf | real tail latency | smoke metrics has boot/RSS/latency only | local controlled peer with p50/p95/p99 | `scripts/smoke-metrics.mjs` |
| 30 | unified release-evidence contract + dispatch-selection proof | release | a narrowed green must not publish | alpha.16 rails (event/job/artifact) | consolidated evidence document + negative tests | `scripts/release-governance` |

## 5. UNVERIFIED (do not read as coverage)

- The absence claims above come from the searches recorded here; a reader may promote any row to `covered`
  by citing a test file:line this file missed, and the row must then move, not be duplicated.
- No pinned capture exists for the filesystem-name scenarios (CJK/emoji/NFC-NFD/Windows reserved names):
  their expectations are source-derived from pinned `sanitize-filename` usage and the OS contract, and are
  labelled as derivations rather than oracles.
- The 8-user performance row and the soak are not coverage: they are REPORT-ONLY / UNPROVEN respectively
  (`docs/alpha16/m5-evidence.md` §11-§12).
- macOS arm64 runtime and extension lifecycle are UNPROVEN (no runner); windows/arm64 is BUILD-ONLY.
- True kernel ENOSPC is UNPROVEN; EFBIG is a substitute and must not be relabelled.
- The new `niche_*` suite runs locally on Windows arm64 and must be re-run by `GoTavern CI` on Linux; the
  local result is triage, not a CI verdict.
