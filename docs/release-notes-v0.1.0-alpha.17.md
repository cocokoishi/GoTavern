# GoTavern v0.1.0-alpha.17 — the niche qualification, evidence and performance release

`v0.1.0-alpha.17` keeps the same SillyTavern `1.19.0` baseline (`06bde939fb1e9c4c8d8641d810f0a916b5bce127`),
the same compatibility contract and the same `CGO_ENABLED=0` single-binary distribution as alpha.16. It is a
deep qualification and maintenance release: a refreshed read-only audit of the current tree, a 176-scenario
deduplicated niche catalogue with a computed gap matrix, 33 new deterministic tests with 20 planted-defect
controls, two deliberate divergences from pinned behaviour found by *executing* those tests on Linux, one
bounded parity fix (the pinned `/proxy/:url(*)` surface), a unified machine-verifiable release-evidence
contract, a README reduced from 34,541 to 13,993 bytes with the detailed performance method moved to
`docs/performance.md`, and a process-level performance baseline measured on the development host and
labelled LOCAL.

The strongest claim this release makes remains the **synthetic adversarial qualification** with its scope
stated. `GOAL.md` section 14 — a real, long-used user directory qualifying the drop-in claim — is **NOT MET**
at this release and is not claimed by any sentence here. See Known limitations.

## What changed

### M0 — the audit was re-run, not quoted

`docs/alpha17/source-audit.md` re-reads the current tree: package dependency graph (18 internal packages / 20
first-party import edges), request/startup lifecycles, the persistence writer graph, the concurrency and
cache ownership graphs, the provider request path and the browser→server→provider observability graph, with
`file:line` citations verified at HEAD. `docs/alpha17/ownership-map.json` (285,876 bytes) is the refreshed
machine-readable union; its **1,007 `path:line` citations were re-validated** against the current tree and
`../SillyTavern` (0 failures, 4 named basename fixups recorded by
`docs/alpha17/audit/refresh-ownership-map.mjs`), and `docs/alpha17/source-graph.json` (787,604 bytes) is the
regenerated AST fact set at commit `c02eed1`. The 16 residual items the previous rounds left open are
re-confirmed one by one in `source-audit.md` §11 with their current state, evidence, missing test and this
round's action; every unexecuted item says so.

### M1/M2 — 176 niche scenarios, a computed gap matrix, and executed tests

`docs/alpha17/niche-scenario-catalog.md` (assembled deterministically from 12 part files by
`docs/alpha17/catalog/assemble.mjs`) carries **176 unique scenario IDs** after deduplication — FS 24, DATA 18,
WRITE 16, HTTP 18, PROVIDER 15, SSE 4, STREAM 10, PROMPT 16, EXT 10, CONC 8, SEC 14, CLI 13, PERF 6, CACHE 4
— each with the fifteen required fields (risk, preconditions, inputs, operations, pinned basis, expected
pinned/GoTavern behaviour, negative control, test file, command, CI workflow, status, residual risk). The
dedup rule is explicit and the status taxonomy is honest: 56 rows are COVERED by a test that exists, 8 are
EXECUTED in this round, 115 are DESIGNED and 3 are UNEXECUTED; nothing unexecuted is presented as a pass.
`docs/alpha17/test-gap-matrix.md` recomputes the counts from the tree (2,376 tracked files; 619 files under
`tests/`; 321 tracked Go test files; 978 + 33 test functions; 262 provider-wire scenarios; 40 browser
comparison artefacts; 13 required gates) and ranks the top-30 highest-value gaps.

`tests/e2e/niche_*.go` (seven new files, 33 top-level test functions plus 5 subtests and 20 planted-defect
cases) turns the highest-value part of that catalogue into executed evidence through the existing
subprocess harness and `tests/mockprovider`: filesystem/name extremes (CJK, emoji, zero-width, NFC vs NFD,
reserved names, external replace), JSON/JSONL extremes (BOM, CRLF, duplicate keys, 2^53 rounding, deep
nesting, truncated lines), HTTP boundaries (method matrix, body shapes, CSRF/CORS, ETag/Range/304), SSE
chunk-boundary torture (frames split across chunks, UTF-8 and CRLF splits, missing `[DONE]`, truncation,
client cancel reaching the mock), persistence crash stages through the real fault seam, and a teeth file in
which every comparator is silent on correct data and 20 planted defects each produce their NAMED failure
through the same helper. The suite was green locally (Windows arm64) and is run by `GoTavern CI` on Linux;
the Linux run found two host-semantics differences, both handled honestly rather than skipped (below).

### M3/M4 — one bounded parity fix, and the architecture stays REFUSE

The M0 audit ranked the pinned `/proxy/:url(*)` mount (always registered by `src/server-main.js:257-265`) as
the one surface a client could observe as missing: the disabled branch answers `404` with an exact message on
pinned and answered the server's generic 404 here, while the enabled branch was indistinguishable from it.
`internal/server/cors_proxy.go` now registers the domain: the disabled branch reproduces pinned's exact 404
body (`text/html; charset=utf-8`), and the enabled branch answers **501** with a named "not implemented"
reason — never a fabricated proxy — so the policy refusal and the unimplemented branch stay distinguishable
(AGENTS.md rule 17). The route-domain goldens move 54→55 with the reason, the surface-coverage gate
classifies the route `unsupported-with-reason`, and three tests pin both branches (the RED was observed by
removing the registry row: the test named the missing pinned body, then restored green).

R1–R6 are re-evaluated against the current tree in `docs/alpha17/architecture-decisions.md` and all six stay
**REFUSE**: no new replayable RED exists inside a proposed ownership boundary, the measured coupling is not
smaller (115 production files / 1,290 ordered-JSON references / 1,284 private-member reads; 18 packages /
20 first-party edges), and the alpha.16 bounded fixes are verified present. The four reopening conditions and
their falsifiers are recorded as measurements, not prose.

### Two divergences found by executing tests (recorded, not silently changed)

- `POST /api/settings/save` with an empty body: pinned's body-parser yields `{}` and `write-file-atomic`
  **wipes settings.json**; GoTavern answers 400 and leaves the file intact. A JSON number that overflows
  float64 (`{"f":1e400}`) is stored as `null` by pinned and rejected with 400 here. Both are deliberate,
  recorded safer-than-pinned divergences (`docs/SEMANTIC-COMPATIBILITY.md` §18).
- a `settings.json` symlink whose target is **outside** the user root: pinned writes through the link;
  GoTavern's containment guard refuses with 500 and leaves the link and target byte-identical. Found by the
  FS-008 test on its first Linux run (the test had asserted pinned's behaviour), then pinned by the test and
  recorded as a deliberate containment divergence.

### M8 — the release path is machine-checked, and the contract is now unified

`scripts/release-governance/` gains a unified evidence emitter
(`release-evidence.json`, schemaVersion 1) covering `headSha`, `pinnedSha`, event, per-gate required
jobs/artifacts/digests, embedded evidence and `overall`, plus **optional** declarative rails the verifier now
supports: per-gate required pinned commit, artifact digest binding, artifact freshness and a
`requiredSelection` narrowed-dispatch refusal that never silently accepts an unprovable selection. The rails
are backward compatible and unused by the current manifest, so the alpha.16 wave still passes: against the
real Actions API the verifier prints `PASS: 13/13 required workflow(s) are green at this SHA`, the emitter
records `overall PASS / 13 gates`, and `node --test scripts/release-governance.test.mjs` is 83/83 (up from
69). Fields the Actions API cannot answer (dispatch inputs, selected/executed test counts) are written as
`null` with `derived:false` and the reason — never invented. `docs/alpha17/evidence-contract.md` records the
contract, the refusals, the validation, and the exact manifest rows proposed for the next round (not applied
here).

### M7 — README and performance documentation

`README.md` is **13,993 bytes / 149 lines** (was 34,541 / 229), names `v0.1.0-alpha.17` as the release this
tree ships, rewrites the install/Docker/upgrade and compatibility sections without duplication, and keeps
every important fact: synthetic adversarial qualification, `GOAL.md` §14 NOT MET, macOS arm64 runtime
UNVERIFIED, windows/arm64 BUILD-ONLY, the 8-user row REPORT-ONLY, soak real-leak UNPROVEN, real-kernel ENOSPC
UNPROVEN, the do-not-rewrite boundaries and the no-Node/Go/Python-on-production-hosts contract. The detailed
method, artifact identity, before/after arms, resource analysis and UNPROVEN table moved to
`docs/performance.md`. `tools/check-perf-docs.mjs` now validates **both** documents (artifact recomputation,
units/p95/run/commit/soak, stale release text, README byte/line budget, broken links, duplicate sections,
alt text, dark/light consistency, WCAG contrast and the 12 px floor, regression disclosure) and
`tests/docs/check-perf-docs.test.mjs` adds 15 node:test cases (positive control + 14 tampered-copy negative
controls asserting the named assertion).

### Performance — a measured process-level baseline, and what is not claimed

`docs/alpha17/performance-plan.md`, `docs/alpha17/perf/` and `docs/alpha17/perf-hotspot.md` record a
process-level baseline of a release-style binary on this host: runner fingerprint (Windows 11 24H2, 2 logical
cores, 12.88 GB RAM, GOMAXPROCS 2, `go1.27.3 windows/arm64`, `-trimpath -ldflags="-s -w"`, binary sha256
`7ae4929…`, sync-write fingerprint p50 2.889 ms / p95 7.218 ms over 12 samples), scale rows from 100 to
10,000 cards, large chat trees, 2,400-message history, 1,000 world-info entries, 1,100 settings and a mixed
large tree, with thresholds derived from repeated smoke records. The largest measured signal is the 10,000-card
shape (boot 27,099 ms, RSS 925 MB, `/api/characters/all` p50 5,481 ms); the candidate cost sites are named at
`file:line`, and the product change is explicitly **UNEXECUTED** — no patch, no before/after. Every number in
that record is **LOCAL (Windows arm64)** triage, not Linux CI evidence, and the release's performance claim
remains the same-SHA `GoTavern smoke metrics` gate.

## Performance

The release's graded performance record is the paired `GoTavern smoke metrics` run at this candidate SHA,
which boots both subjects on one runner and records boot latency, steady RSS, request latency and the soak
series (the same-SHA evidence table appended to this release names the run). The README table and both figure
variants are generated from the committed artifact `tests/perf/q22-baseline.json` (run `42012475880` at
`f1396ce`: cold start 14,515 ms → 165 ms, steady RSS 915 MB → 40.5 MB, `GET /version` 65.55 ms → 0.429 ms,
`GET /` 13.78 ms → 8.59 ms; medians of three alternating rounds on one shared runner) and are recomputed by
`tools/check-perf-docs.mjs` in CI. Read them as a same-machine comparison, not a promise. The process-level
baseline described above is local triage and is deliberately not spliced into this table.

## Compatibility

The compatibility contract is unchanged: pinned SillyTavern `1.19.0` at
`06bde939fb1e9c4c8d8641d810f0a916b5bce127` is the only oracle; the unmodified upstream frontend and the
SillyTavern `data/` layout are used directly; there is no conversion layer and no private database; unknown
fields and unknown files are preserved; sensitive writes keep the existing lock and atomic-replace
semantics. alpha.17 adds one parity surface (`/proxy/`'s disabled branch) and records six deliberate
divergences/unsupported surfaces in `docs/SEMANTIC-COMPATIBILITY.md` §18 rather than absorbing them into a
"compatible" claim: the settings/save empty-body refusal, the write-failure 500, the 1e400 refusal, the
escaping-symlink refusal, per-chat backups (not implemented; pinned default ON), and the enabled CORS proxy
(501, unimplemented). It also corrects a stale project claim: pinned's extension-version route fetches twice,
so GoTavern's two fetches are parity, not a defect.

## Known limitations

- **`GOAL.md` §14 remains NOT MET.** No real, long-used user directory has been qualified; the private
  channel's disposition is `PRIVATE_NOT_RUN`. Everything this release claims is synthetic/adversarial.
- **darwin/arm64 runtime is UNVERIFIED.** The archive is built, archive-inspected and proved a thin arm64
  Mach-O, and its runtime execution is a recorded platform limitation; the macOS arm64 extension lifecycle is
  likewise UNVERIFIED. **windows/arm64 is BUILD-ONLY.**
- The **8-user latency row is REPORT-ONLY** (its same-code spread tracks host storage tail); the **soak's
  real-leak question is UNPROVEN** (the per-third rule is a detection floor); a **true kernel ENOSPC is
  UNPROVEN** (EFBIG is the proven substitute and is not relabelled).
- **Page-init egress hermeticity** for browser probes remains OPEN (recorded decision: a pinned-version
  allowlist, not a behaviour change). **Provider-relay p99**, **streaming-cancellation latency**, the
  **20-extension page-load timing matrix**, the **cold-cache guard** and the **process-level rows on Linux
  CI** are UNEXECUTED in this round with their reasons named in `docs/alpha17/performance-plan.md` §9 and
  `docs/alpha17/source-audit.md` §11.
- The alpha.16 tag is unchanged; no tag was moved, no force push and no `--no-verify` were used.

## Artifacts

The release publishes the six canonical archives and their `checksums.txt`:

- `gotavern-linux-amd64.tar.gz`
- `gotavern-linux-arm64.tar.gz`
- `gotavern-darwin-amd64.tar.gz`
- `gotavern-darwin-arm64.tar.gz`
- `gotavern-windows-amd64.zip`
- `gotavern-windows-arm64.zip`

Verify them with `sha256sum -c checksums.txt` in the download directory. The container image is published as
`:v0.1.0-alpha.17` and `:latest` as the same digest. Runtime qualification is recorded by the publish run's
own execution jobs and the appended evidence table: linux/amd64 and windows/amd64 are native, linux/arm64
runs under QEMU, darwin/amd64 runs on a native macOS runner, darwin/arm64 is built and archive-inspected but
not executed, and windows/arm64 is build-only, for the reasons in Known limitations.

## Evidence

The same-commit required-gate table is appended to this body by the publish job, so every claim above is
checkable against the runs that judged this candidate. The publish job refuses to create the release unless
`scripts/verify-release-gates.mjs` passes all 13 gates, including every required job and the embedded evidence
document inside each required artifact. The working record for this candidate is
`docs/alpha17/handoff-ledger.md` and `docs/alpha17/same-sha-evidence.md` (one row per gate, run ids recorded
only when read by the verifier); the audit is `docs/alpha17/source-audit.md` with
`docs/alpha17/ownership-map.json` and `docs/alpha17/source-graph.json`; the scenario/coverage record is
`docs/alpha17/niche-scenario-catalog.md`, `docs/alpha17/test-gap-matrix.md` and
`docs/alpha17/new-test-evidence.md`; the performance record is `docs/alpha17/performance-plan.md`,
`docs/alpha17/perf/` and `docs/alpha17/perf-hotspot.md`; the evidence contract is
`docs/alpha17/evidence-contract.md`. `docs/goal-scorecard.md` is the per-question ledger and `HANDOFF.md` is
the current checkpoint.
