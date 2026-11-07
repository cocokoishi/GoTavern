# alpha.17 handoff ledger

**Status: DRAFT until publication.** This is the working record for the `v0.1.0-alpha.17` round: inputs,
decisions, executed work, the same-SHA gate wave and the post-publication verification. Rows record what was
observed, with the command or run that produced it. `PENDING` means the observation has not happened yet;
nothing here is a PASS until its evidence exists.

## 1. Baseline and inputs

| fact | value | evidence |
|---|---|---|
| repository / branch | `cocokoishi/GoTavern` / `main` | `git remote -v`, `git branch --show-current` |
| round-start HEAD | `c02eed109ceba32ba710948a0420425f8ce58b1f` (two documentation commits after the alpha.16 release commit) | `git rev-parse HEAD` at M0 |
| alpha.16 release | published `2026-11-07T08:01:36Z`, `draft=false`, `prerelease=false`, 7 assets; tag object `b7d81cd1…` peeling to `c1886d70…` | `gh api repos/cocokoishi/GoTavern/releases`; `git rev-parse v0.1.0-alpha.16` |
| pinned oracle | SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127` | `../SillyTavern` checkout |
| toolchain | `go1.27.3 windows/arm64`; Node `v24.19.0` | `go version`, `node --version` |
| declared round target | `v0.1.0-alpha.17`, stable channel | `docs/alpha17/release-bar.md` |
| release candidate | `9b99fde0b0a9be0665cd93bc2143a3f495af31c2` (no code commit after it before the tag) | wave dispatch at `gh run list --event workflow_dispatch` |

## 2. What this round changed (one line each, with its gate)

| change | commit(s) | evidence |
|---|---|---|
| alpha.17 program contract, verified baseline, release bar, decision log, architecture decisions | `2e1a4b4`, later doc commits | `docs/alpha17/README.md`, `release-bar.md`, `decision-log.md`, `architecture-decisions.md` |
| refreshed M0 ownership map (1,007 citations validated) + regenerated source graph at the round-start tree | `2e1a4b4` | `docs/alpha17/audit/refresh-ownership-map.mjs` output: 1,007 checked / 0 failed / 4 named fixups |
| M0 findings audit + 16-item residual reconfirmation | later doc commits | `docs/alpha17/source-audit.md` §9-§11 |
| 176-scenario deduplicated catalogue + assembler + computed gap matrix | `e959526`, follow-up | `docs/alpha17/niche-scenario-catalog.md`, `docs/alpha17/catalog/assemble.mjs`, `docs/alpha17/test-gap-matrix.md` |
| 33 niche test functions + 5 subtests + 20 planted-defect teeth (new files only) | `e621f9d` + `fd40ef7` (gofmt) + `db7d87d` (Linux fix) | `tests/e2e/niche_*.go`, `docs/alpha17/new-test-evidence.md`; local `go test ./tests/e2e -run 'TestNiche' -count=1` -> `ok … 219.845s` |
| pinned `/proxy/:url(*)` disabled-branch parity + distinguishable 501 enabled branch | `ab5d723` | `internal/server/cors_proxy.go`, `cors_proxy_test.go`; RED observed by removing the registry row, restored green `ok internal/server 1.007s` |
| recorded deliberate divergences (settings empty body/1e400/escaping symlink, per-chat backups, enabled proxy, page-init egress) | `1b099e9`, `db7d87d` | `docs/SEMANTIC-COMPATIBILITY.md` §18; decision log AL17-D004/D010-D012 |
| unified release-evidence contract + optional narrowed-dispatch rails (83/83 tests; real alpha.16 wave PASS 13/13) | `205b36d` | `docs/alpha17/evidence-contract.md`, `evidence-contract-sample.json` |
| README 34,541 -> 13,993 B; `docs/performance.md`; hardened perf-doc checker with 15 negative controls | `69b5f01` | `docs/alpha17/readme-restructure.md`; `node tools/check-perf-docs.mjs` -> OK; `node --test tests/docs/check-perf-docs.test.mjs` -> 15/15 |
| process-level baseline + fingerprint + hotspot record (LOCAL Windows arm64; product change UNEXECUTED) | `ea46747`, `b9bc8c2` | `docs/alpha17/performance-plan.md`, `docs/alpha17/perf/`, `docs/alpha17/perf-hotspot.md` |
| tag classifier graduates `v0.1.0-alpha.17`; 69/69 classifier cases | `eaf8c22` | `bash scripts/test-classify-version-tag.sh` -> 69/69 (Git bash local) |
| GOAL.md §1c/§14/§16/§12.1 updated to alpha.17; §14 remains NOT MET | `2e1a4b4` | `GOAL.md` |

## 3. The failures found and what fixed them

| # | failure | root cause | fix | evidence |
|---|---|---|---|---|
| 1 | `GoTavern CI` 42375014354 `verify` failed `Verify Go formatting` | `tests/e2e/niche_teeth_test.go` was not gofmt-formatted (composite literals needed multi-line form) | `fd40ef7` (whitespace only) | next push's `verify` green |
| 2 | `GoTavern CI` 42375608180 `verify` failed `Test` — `TestNicheFSSymlinkedSettingsFileIsFollowedForReadAndReplacedOnWrite` | the test asserted pinned's semantics (write through the link); GoTavern deliberately refuses a link whose target escapes the user root (500) | `db7d87d`: renamed test pins the containment refusal; recorded as a deliberate divergence (SEMANTIC-COMPATIBILITY §18) | next push's `verify` green |
| 3 | `GoTavern CI` 42377499811 `verify` failed `TestPinnedCommitStringsMatchThePin` | `docs/alpha17/performance-plan.md` cites the local baseline commit `fd40ef7e…` (40-hex) which was not a declared measurement anchor | `b9bc8c2`: declared it in `declaredOtherPins` with its reason; added `docs/alpha17/evidence-contract.md` to the contract-document list | `go test ./internal/fixtures -count=1` -> ok; next push's `verify` green |
| 4 | `GoTavern drop-in qualification` 42375608158 failed the Q21 packaged hand-back judge (`pinnedReadGotavernsTurn`: `chatId: null`) | harness/browser race, not product: the same workflow passed at `1b099e9` and at `db7d87d`, and the only change in between was a gofmt-only test edit the workflow does not use | no code change; the gate is re-dispatched at the candidate SHA (see §4) | 42375608158 (failure) vs 42376248471 / 42373831363 (success) |
| 5 | local process-level harness aborted after 7 scales (`scripts/a15-bench-suite.mjs` complex-preset entry has no `scaleArgs`) | harness defect; `scripts/**` was outside the perf lane's write scope | recorded as reported, not patched; the baseline covers the 7 measured scales and names the missing ones | `docs/alpha17/perf/README.md`, `perf-hotspot.md` |

## 4. The same-SHA gate wave — PASS 13/13 (EXECUTED)

The thirteen required workflows were dispatched at `9b99fde0b0a9be0665cd93bc2143a3f495af31c2` with their
full selections; every one reached `completed`/`success`. The official verifier (the same script the publish
job runs) read them and printed:

```
**PASS**: 13/13 required workflow(s) are green at this SHA.
```

Run ids, the verifier table (`docs/alpha17/same-sha-verifier-table.md`) and the unified evidence document
(`docs/alpha17/release-evidence.json`, overall PASS) are in `docs/alpha17/same-sha-evidence.md` §2-§3. The
wave is the gate: a run that was not dispatched at that SHA, that is not completed/success, or whose required
job or embedded evidence is missing is a refusal, and the release does not happen.

The first pre-tag rehearsal (`GoTavern Release` 42378606389) was dispatched before the curated notes were on
`main` and was refused by the darwin/arm64 limitation rail (a downgrade that is not stated in the note is
refused); a dispatch never publishes, so no release state was touched. The rehearsal was re-dispatched after
the notes commit and its result is recorded in §5.

## 5. Release publication and post-publication verification (EXECUTED)

- **Tag.** Annotated `v0.1.0-alpha.17` object `7eed8eed49515176e210b2c30b63bac5380c5b70`, peeling to
  `9b99fde0b0a9be0665cd93bc2143a3f495af31c2` (the frozen candidate every gate judged). Created only after
  the verifier PASS and the pre-tag rehearsal, and not moved.
- **Release.** https://github.com/cocokoishi/GoTavern/releases/tag/v0.1.0-alpha.17 — `draft=false`,
  `prerelease=false`, published `2026-11-07T17:11:18Z`, **7 assets**: the six canonical archives plus
  `checksums.txt`. `releases/latest` now resolves to `v0.1.0-alpha.17`.
- **Publication run.** `GoTavern Release` **42394884973** (tag push, completed/success): six build legs,
  `execute-linux-arm64`, `execute-darwin-amd64`, `windows-arm64-boundary`,
  `darwin-arm64-recorded-downgrade`, `prepublish-qualification`, `publish`, `post-release-facts` all
  success. The publish job ran the fail-closed verifier at the tag target and the notes/marker checks before
  `gh release create`; the release body carries the generated same-SHA qualification table.
- **Pre-tag rehearsal (re-run).** `GoTavern Release` **42394446263** (dispatch, success) built and
  archive-inspected the six archives, executed the arm64-Linux and darwin/amd64 legs, passed
  `prepublish-qualification` and the darwin/arm64 limitation+notes gate, and published nothing. The two
  earlier rehearsal attempts are recorded with their refusals in `same-sha-evidence.md` §4.
- **Published bytes verified independently (not the publish job's own claims).**
  - all seven assets downloaded again; the release's own `checksums.txt` verified **6/6 archives OK, 0
    failures** (sha256 of each downloaded archive compared locally);
  - the published `windows-amd64` archive unpacked and executed: `gotavern version --json` prints
    `gotavern_version: v0.1.0-alpha.17`, `sillytavern_version: 1.19.0`, `sillytavern_commit: 06bde939…`;
    `BUILD-INFO.txt` names `GoTavern release v0.1.0-alpha.17` / `target windows`; the extracted
    `src/tokenizers` tree carries 10 files;
  - a fresh-install boot of the published `.exe` answered `GET /version` 200 with the pinned SillyTavern
    identity and `GET /` 200 (734,837 bytes);
  - **installer path**: `GoTavern published-release install smoke` **42395444168** (dispatch,
    completed/success) installs the published artifacts over real TLS with `install.sh`/`install.ps1`, boots
    them, and asserts the tag, the tokenizer layout and real tokenizer route ids;
  - **published artifact + container extension journey**: `GoTavern published-extension smoke`
    **42395446647** (dispatch, completed/success) resolves `releases/latest` over HTTPS to this tag,
    unpacks the archive, runs `gotavern version`, pulls BOTH the `:v0.1.0-alpha.17` and `:latest` container
    manifests and proves they are the same image, boots it, and drives the published-extension journey.
- **Container identity.** GHCR reports digest `sha256:2b029cc2c361240303e0abc36f40d31e805c3a6e798508854639848224f30fc1`
  carrying BOTH tags `v0.1.0-alpha.17` and `latest` (one image, one digest); alpha.16's digest
  `sha256:37a7f69f…` and alpha.15's `sha256:28fd03f4…` are unchanged. The tag-triggered `GoTavern Docker
  image` run **42394885111** (completed/success) built, pushed and re-verified it.
- **Tag target unchanged.** `git ls-remote origin refs/tags/v0.1.0-alpha.17` answers tag object `7eed8ee`;
  the alpha.16 tag still answers object `b7d81cd1296e842d79997ea70c49dabeed04da31` (target unchanged); no
  force push and no `--no-verify` were used.
- **Post-release facts.** the release workflow's `post-release-facts` job regenerated the generated facts
  for the published tag and committed `3cf519b` ("chore(docs): regenerate the generated facts for the
  published v0.1.0-alpha.17 tag") to `main`, and dispatched `GoTavern CI` **42395084857** at that commit.

## 6. Residuals (unchanged or newly recorded)

- `GOAL.md` §14 remains **NOT MET** (`PRIVATE_NOT_RUN`); no real user tree was qualified.
- darwin/arm64 runtime and the macOS arm64 extension lifecycle remain **UNVERIFIED** (recorded platform
  limitation); windows/arm64 is **BUILD-ONLY**.
- The 8-user latency row is **REPORT-ONLY**; the soak real-leak question is **UNPROVEN**; true kernel
  **ENOSPC is UNPROVEN**; page-init egress hermeticity is **OPEN**; provider-relay p99,
  streaming-cancellation latency, the 20-extension page-load matrix, the cold-cache guard and Linux-CI
  process-level rows are **UNEXECUTED** with reasons in `performance-plan.md` §9 and `source-audit.md` §11.
- The new evidence rails are implemented and validated but their manifest rows are **not applied** (proposed
  in `evidence-contract.md` §5); dispatch inputs and selected-test counts are not exposed by the Actions API.
- The `scripts/a15-bench-suite.mjs` complex-preset harness defect is reported, not patched.

## 7. Reproduce the record

```bash
go test ./tests/e2e -run 'TestNiche' -count=1                  # 33 niche tests + teeth (Linux is the gate)
go test ./internal/fixtures -count=1                          # contract documents/pins encoding
node tools/check-perf-docs.mjs                                # README + docs/performance.md + figure
node --test tests/docs/check-perf-docs.test.mjs               # 15 checker controls
node --test scripts/release-governance.test.mjs               # 83 governance rails
node docs/alpha17/audit/refresh-ownership-map.mjs .           # 1,007 citations re-validated
node docs/alpha17/catalog/assemble.mjs                        # rebuild the assembled catalogue
node scripts/verify-release-gates.mjs --sha 9b99fde… --manifest docs/release-manifest.json
bash scripts/test-classify-version-tag.sh                     # 69/69 classifier cases
```
