# alpha.17 — program contract, audit index and release record

**Status: DRAFT (program in progress, 2026-11-07).** This file is the index and the rules for the
`v0.1.0-alpha.17` round. It is a plan while work is running; each deliverable below names its own state
(`DRAFT`/`PROPOSED`/`EXECUTED`) and only an `EXECUTED` row may be cited as evidence. A document that
claims ahead of a run is a report defect, not progress (`AGENTS.md` rule 36).

## 1. Verified baseline (re-measured, not quoted)

| fact | measured value | how it was checked |
|---|---|---|
| repository | `cocokoishi/GoTavern` | `git remote -v` |
| default branch / HEAD | `main` @ `c02eed109ceba32ba710948a0420425f8ce58b1f` | `git rev-parse HEAD` |
| published release | `v0.1.0-alpha.16`, `draft=false`, `prerelease=false`, published `2026-11-07T08:01:36Z`, 7 assets | `gh api repos/cocokoishi/GoTavern/releases?per_page=5` |
| alpha.16 tag | annotated tag object `b7d81cd1296e842d79997ea70c49dabeed04da31`, peeling to commit `c1886d70db0342e09c6fdd3225909cae900c15c9` | `git rev-parse v0.1.0-alpha.16`, `git rev-parse v0.1.0-alpha.16^{commit}` |
| main after the tag | exactly two documentation commits (`00828eb`, `c02eed1`); zero product-code files changed since the tag | `git log --oneline v0.1.0-alpha.16..HEAD`, `git diff --stat` |
| pinned oracle | SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127` in `../SillyTavern` | `git -C ../SillyTavern rev-parse HEAD` |
| Go toolchain | `go1.27.3 windows/arm64` from `go.mod` | `go version`, `go.mod` |
| tree census | 2,376 git-tracked files: `internal/` 556, `tests/` 619, `docs/` 97, `upstream/` 828, `tools/` 186, `scripts/` 40, `.github/` 22, `cmd/` 10 | `git ls-files | Measure-Object -Line` and per-directory counts |
| Go suite census (recomputed at the round-start tree) | 618 tracked `*.go` files outside `upstream/`; 321 `*_test.go` files; 978 top-level `Test|Benchmark|Fuzz` functions, plus the 33 new alpha.17 niche test functions in this round | `git ls-files '*.go'`, `Select-String '^func (Test|Benchmark|Fuzz)[A-Z]'` |
| required release gates | 13 entries in `docs/release-manifest.json` (`requiredGates`), all `requiredEvent: workflow_dispatch` | `node -e "…requiredGates.length"` |

**Version discipline.** `v0.1.0-alpha.16` is a published GitHub Release and its tag must never be
re-created, moved, overwritten or deleted. The next version is `v0.1.0-alpha.17`, and it is published on
the **stable channel** (`draft=false`, `prerelease=false`, `latest=true`) only when §7 holds on one commit.

## 2. What this round is, and is not

This round is a **deep niche qualification, evidence-driven maintenance and performance** round on top of
the alpha.16 synthetic adversarial qualification. It is not a redesign: the do-not-rewrite list in
`GOAL.md` §15.4 stays intact, no pinned frontend or `upstream/**` byte changes, production stays one
`CGO_ENABLED=0` Go binary, and the four `GOAL.md` §14 conditions are not claimed.

The round adds, and each addition has a named gate:

1. a refreshed read-only M0 audit (`source-audit.md`, `ownership-map.json`, `source-graph.json`,
   `defect-reconfirmation.md`), so every claim rests on the current tree rather than on alpha.16's;
2. a deduplicated catalogue of **≥150** extreme/rare/boundary/interaction scenarios
   (`niche-scenario-catalog.md`) and the computed coverage gap matrix (`test-gap-matrix.md`);
3. new, deterministic, negative-controlled tests for the highest-value gaps
   (`new-test-evidence.md`), wired into the existing `go test ./...` gate;
4. an evidence-based argument for architecture: R1–R6 are re-evaluated against the current tree and stay
   `REFUSE` unless a new red exists (`architecture-decisions.md`);
5. a process-level performance baseline and one measured same-input optimization
   (`performance-plan.md`, `perf/`, `perf-hotspot.md`), reported in both directions;
6. a 10–14 KB README, a detailed `docs/performance.md`, and a performance-documentation checker with
   teeth (`readme-restructure.md`);
7. a unified machine-verifiable release evidence contract and a narrowed-dispatch refusal rail
   (`evidence-contract.md`), with negative tests;
8. a full same-SHA gate wave, published archives and a post-publication verification
   (`release-bar.md`, `same-sha-evidence.md`, `handoff-ledger.md`).

## 3. Hard rules for every lane

1. **Read-only M0.** Before product code changes, the audit is read-only: no fix while reading; every
   defect gets a hypothesis row with `file:line` and a reproducer plan.
2. **Cite or it did not happen.** Every claim carries a `file:line` against the current tree and/or a
   `workflow name + run id + conclusion`. A `run id` without its workflow name is not evidence
   (`AGENTS.md` rule 55).
3. **No fabricated evidence.** A failed, skipped, narrowed or unexecuted check is recorded as
   `FAILED`/`SKIPPED`/`UNEXECUTED`/`UNPROVEN`; `PASS` exists only for an executed run. No run id is invented
   and no measurement is predicted.
4. **Local is not CI.** `go test`, benchmarks and probes run on this Windows/arm64 host are labelled
   `LOCAL (Windows arm64)` triage. A release claim cites the Linux GitHub Actions run.
5. **No mutation left behind.** A planted defect used to show teeth is reverted through the file's bytes and
   the restored green is observed; `-count=1` is used so the Go test cache cannot answer for a run.
6. **Deduplicate.** One behaviour is one scenario; enumerated parameter sweeps are a table inside one
   scenario, not ten rows.
7. **A new gate needs teeth.** Every new assertion/comparator is shown to fail on a planted defect and pass
   on the correct input; a test that cannot fail is not a gate.
8. **Do not weaken.** No existing test, gate, fixture or negative control is deleted, skipped or widened to
   obtain green. A changed expectation cites the observation that legitimately changed.
9. **Preserve user data.** Unknown files and unknown fields survive every write; writes keep the existing
   lock and atomic-replace semantics; the do-not-rewrite list stays.
10. **No private data.** No real user card/preset/chat content, key, screenshot or DOM dump in any commit,
    log or artifact; desensitised derivations only, through the generator and watermark check.

## 4. Lanes and write scopes (advisory, one owner per area)

| lane | area | write scope |
|---|---|---|
| Lead | program contract, architecture decisions, release bar, decision log, GOAL/HANDOFF/release notes/classifier, integration, gate dispatch and publication | `docs/alpha17/README.md`, `architecture-decisions.md`, `release-bar.md`, `decision-log.md`, `handoff-ledger.md`, `same-sha-evidence.md`, `GOAL.md`, `HANDOFF.md`, `docs/release-notes-v0.1.0-alpha.17.md`, `scripts/classify-version-tag.sh`, `scripts/test-classify-version-tag.sh` |
| audit | M0 audit refresh: source graph, ownership map, findings, 16-item residual reconfirmation | `docs/alpha17/source-audit.md`, `ownership-map.json`, `source-graph.json`, `defect-reconfirmation.md`, `docs/alpha17/audit/**` |
| scenarios | ≥150 deduplicated scenario catalogue + computed gap matrix | `docs/alpha17/niche-scenario-catalog.md`, `catalog/**`, `test-gap-matrix.md` |
| tests | new negative-controlled tests for the top gaps | `tests/e2e/niche_*.go`, `docs/alpha17/new-test-evidence.md` |
| perf | process-level baseline, hotspot, same-input before/after | `docs/alpha17/performance-plan.md`, `perf/**`, `perf-hotspot.md`, `tests/perf/**`, `tools/perf/**` |
| docs | README restructure, `docs/performance.md`, perf-doc checker | `README.md`, `docs/performance.md`, `docs/alpha17/readme-restructure.md`, `tools/check-perf-docs.mjs`, `tests/docs/**`, `docs/assets/**`, `docs/perf-baseline.md` |
| ci | evidence contract + verifier rails | `scripts/verify-release-gates.mjs`, `scripts/release-governance/**`, `scripts/release-governance.test.mjs`, `docs/release-governance.md`, `docs/alpha17/evidence-contract.md` |

A lane may not modify another lane's files. A product-code change is the Lead's integration decision from
a written finding and its red evidence; tests, docs and governance changes are the lanes' own.

## 5. Deliverables and states

| artefact | owner | state (updated as work executes) |
|---|---|---|
| `source-audit.md`, `ownership-map.json`, `source-graph.json`, `defect-reconfirmation.md` | audit | **EXECUTED** (map/graph at `c02eed1`, 1,007 citations validated; source audit and 16-item reconfirmation written at the candidate; `defect-reconfirmation.md` consolidated into `source-audit.md` §10 + `SEMANTIC-COMPATIBILITY.md` §18 where the item became a recorded divergence) |
| `niche-scenario-catalog.md`, `test-gap-matrix.md` | scenarios | **EXECUTED** — 176 unique scenario IDs assembled from 12 part files; gap matrix computed from the tree |
| `new-test-evidence.md` + `tests/e2e/niche_*.go` | tests | **EXECUTED locally (Windows arm64) and re-run by GoTavern CI on Linux**; 33 test functions + 5 subtests + 20 planted-defect teeth; two Linux-only failures found and fixed/recorded |
| `architecture-decisions.md` | Lead | **EXECUTED** — R1–R6 REFUSE with HEAD measurements |
| `performance-plan.md`, `perf/**`, `perf-hotspot.md` | perf | **PARTIALLY EXECUTED** — runner fingerprint + process-level baseline (LOCAL Windows arm64) and artifacts executed; the hotspot candidate is measured but the product change is **UNEXECUTED** (no patch, no before/after) |
| `readme-restructure.md`, `docs/performance.md`, checker | docs | **EXECUTED** — README 34,541 -> 13,993 B; 15 checker negative-control tests; local commands green |
| `evidence-contract.md`, verifier rails | ci | **EXECUTED** — new optional rails (83/83 tests) and a real alpha.16 wave PASS 13/13; the manifest-row wiring is proposed, not applied |
| `release-bar.md`, `decision-log.md`, `handoff-ledger.md`, `same-sha-evidence.md` | Lead | **EXECUTED** — the candidate `9b99fde` passed 13/13 same-SHA required gates, the pre-tag rehearsal was green, and the publication record is `handoff-ledger.md` §5 with `same-sha-evidence.md` §3 |
| `v0.1.0-alpha.17` release | Lead | **PUBLISHED 2026-11-07T17:11:18Z** — `draft=false`, `prerelease=false`, `latest=true`, 7 assets, `GoTavern Release` 42394884973 success; published bytes, checksums, container digest and post-publication smokes verified (`handoff-ledger.md` §5) |

## 6. Order of work (M0–M8)

M0 read-only audit → M1 catalogue/CLI revalidation → M2 performance baseline → M3 first hotspot (RED →
minimal fix → same-input before/after) → M4 architecture re-evaluation (REFUSE unless a new red exists) →
M5 big-data/concurrency → M6 long-term stability and streaming cancellation → M7 README/documentation →
M8 acceptance and release. A milestone is closed by an executed gate, not by a document. A parity
regression is red at every point on the ladder.

## 7. Release bar for `v0.1.0-alpha.17`

The release is published only when **all** of the following hold on ONE commit, otherwise it is recorded
`BLOCKED` with the reason and not published. The full, checkable form is `release-bar.md`.

1. every required gate in `docs/release-manifest.json` has a completed/success `workflow_dispatch` run whose
   `head_sha` is the candidate, with its required jobs present and its fixed-name evidence artifact
   attached, unexpired and internally consistent;
2. the new evidence contract validates all 13 rows and refuses a narrowed dispatch by name;
3. M1/M2/M7 evidence is green at the same commit, and the README performance numbers and figure come from
   the recorded artifact whose provenance commit is the code-complete commit the release descends from, with
   the same-SHA `GoTavern smoke metrics` gate also green;
4. `scripts/classify-version-tag.sh` classifies `v0.1.0-alpha.17` stable and the neighbouring version-shaped
   tags stay prerelease, with the classifier test proving both;
5. `docs/release-notes-v0.1.0-alpha.17.md` is generated from / checked against the evidence, names every
   boundary and every unproven item, and claims nothing ahead of a gate;
6. six canonical archives plus `checksums.txt` are published, `draft=false`, `prerelease=false`,
   `latest=true`, and the release body carries the same-SHA evidence table;
7. Docker `:v0.1.0-alpha.17` and `:latest` resolve to the same digest;
8. after publication the published bytes are independently verified (checksums, binary `version`, install
   smoke, published-extension smoke), the alpha.16 tag is unchanged and no force push or `--no-verify` was
   used;
9. `GOAL.md` §14 remains **NOT MET** and is not upgraded by this release.

## 8. Current limitations that travel with every claim

- The qualification is **synthetic/adversarial**. `GOAL.md` §14 (a real, long-used user directory with a
  byte census and hand-back) remains **NOT MET**; the private channel was not run.
- darwin/arm64 runtime execution and the macOS arm64 extension lifecycle are **UNVERIFIED** (recorded
  platform limitation); windows/arm64 is **BUILD-ONLY**.
- The 8-user latency row is **REPORT-ONLY**; the soak's real-leak question is **UNPROVEN**; a true kernel
  `ENOSPC` is **UNPROVEN**; page-init egress hermeticity for browser probes is **OPEN**.
- Local Windows/arm64 measurements in this directory are triage, not release evidence.
