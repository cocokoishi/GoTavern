# README restructure and performance-documentation gate (alpha.17)

**Status: DRAFT (lane report; commands below were EXECUTED locally on this Windows/arm64 host and their output is quoted. CI has NOT run this change, and no GitHub Actions run id exists for it — see §8.)**

This is the working record for deliverable M7's documentation lane of the `v0.1.0-alpha.17` round: the README
restructure to 10–14 KB, the new `docs/performance.md`, the extended `tools/check-perf-docs.mjs`, its negative
controls, and the small `docs/perf-baseline.md` pointer edit that keeps one source of truth. It is a report, not
evidence of a product claim: the performance numbers it discusses are the same committed artifact the previous
release used, restated and re-checked, not a new measurement.

## 1. Before / after

| surface | before | after | limit |
|---|---|---|---|
| `README.md` bytes | 34,541 | **13,993** | 10,000–14,000 (gate-enforced) |
| `README.md` raw lines (`split("\n")`) | 311 | **149** | 100–160 (gate-enforced; "~100–150" target) |
| `README.md` non-blank lines | 229 | **104** | 100–150 (gate-enforced; matches the "229 lines" measurement used before) |
| `README.md` `##` sections | 21 | **10** | — |
| `docs/performance.md` | absent | **new, ~16 KB** | no size cap (detail lives here) |
| `tools/check-perf-docs.mjs` | 512 lines / 3 surfaces | extended: README + `docs/performance.md` + figures + provenance + baseline doc, stable named assertions | — |
| `tests/docs/check-perf-docs.test.mjs` | absent | **new, 15 tests** (14 negative controls + positive control) | — |

Measurement commands (PowerShell 7, UTF-8 no BOM; first byte `23` = `#`, so no BOM):

```text
(Get-Item README.md).Length                        -> 13993
([System.IO.File]::ReadAllText("README.md")) -split "`n"  -> 149
(Get-Content README.md | Measure-Object -Line).Lines      -> 104
(Get-Item docs/performance.md).Length              -> ~16,100
```

The "before" row is the tree state at `c02eed1` (alpha.16 documentation tip): 34,541 bytes and 229 non-blank lines,
still naming `v0.1.0-alpha.15` as the current release, quoting `v0.1.0-alpha.13` as the stable install/Docker tag,
and carrying the performance prose from the alpha.15 round.

## 2. Section map

| before (21 headings) | after (10 headings) | what happened |
|---|---|---|
| `# GoTavern` | `# GoTavern` | kept; identity line now also carries "one prebuilt binary, no Node.js on the host, unmodified frontend, same `data/` layout" |
| — | figure + 2-line caption | kept the dark/light `<picture>` pair and its artifact-recomputed alt text; caption shortened and the "Learn more" section replaced by one nav line to `#compatibility` `#performance` `#install` `#development` |
| `## Start in 30 seconds` | `## Start in 30 seconds` | kept verbatim as the shortest start block (Linux/macOS + Windows PowerShell); the duplicate install blocks below were removed |
| `## Where compatibility stands`, `## What it is`, `## Compatibility`, `## How we decide something is compatible`, `## Where the status words live` | `## Compatibility` | merged into one section: GOAL §14 NOT MET + synthetic scope paragraph; pinned oracle/five observer surfaces; three rules; executed-scope bullets; an 8-row honest-limits table; one links line to the four ledgers and `SEMANTIC-COMPATIBILITY.md` |
| `## Learn more` | — | replaced by the first-screen nav line |
| `## Release status` | `## Release status` | kept below the first screen (the gate's boundary); now names `v0.1.0-alpha.17` as the release this tree ships, links `releases/latest`, records the channel rule and the previous release as history only. The alpha.13/alpha.15 "current/stable" text is gone |
| `## Install` + `### Updating and rolling back` + `### Migrating from an existing SillyTavern` | `## Install` | commands no longer duplicated (they point at the quickstart); kept the six-archive matrix with per-platform execution status, Docker, manual, update/rollback, migration and the "unknown fields/files preserved / no conversion layer / do-not-rewrite boundaries" sentence; details link to `docs/INSTALLATION.md` |
| `## Performance` + `### The optimization this release ships…` + `### A profile-driven fix` | `## Performance` | kept the four-row artifact-generated table, its "How it was measured" column, p95, unit rule, run id + short commit, soak drifts and the regression disclosure. The optimization on/off arms, the alpha.14 comparison, the profile-driven local tables, the resource-coverage matrix and the UNPROVEN rows moved to `docs/performance.md` |
| `### Coverage numbers`, `### Third-party extension corpus` | inside `## What works…` | compressed to a capability table plus three `BEGIN GENERATED` fragments (`provider-wire.summary`, `browser.sources`, `startup.requests`) that `tools/generate-doc-facts.mjs` still owns; the 20-pinned-extension fact is kept in one bullet; methodology stays in the existing compatibility docs |
| `## What won't work` | `## What works, what is partial, what is not implemented` | converted the prose list to an 8-row exclusion table (each with its reason) + one sentence on inherited upstream weaknesses |
| `## Development` | `## Development` | kept the local quick loop and the CI-gates paragraph; added the local-vs-CI warning and one line linking all detailed documents |
| `## License` | `## License` | kept verbatim |

## 3. Facts deliberately preserved in the README

The restructure was size-driven, not claim-driven. Every one of these is still stated in the README:

- identity: SillyTavern 1.19.0's server in Go, one prebuilt binary, no Node.js on the host, unmodified upstream
  frontend, same `data/` layout, no conversion layer, no private database;
- pinned baseline `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127` and "upstream is the oracle" on five
  observer surfaces, with the "it opens and chats is not evidence" rule;
- **the strong drop-in bar in `GOAL.md` §14 is NOT MET**, the evidence is **synthetic/adversarial**, the private
  channel is `PRIVATE_NOT_RUN`; the limits table names macOS ARM64 `UNVERIFIED`, `windows/arm64` `BUILD-ONLY`,
  the 8-user row `REPORT-ONLY`, the soak real-leak question `UNPROVEN`, real-kernel ENOSPC `UNPROVEN`,
  streaming-cancellation/provider-relay p99 `UNPROVEN`, page-init egress `OPEN`;
- the four recorded performance rows with units, sample rule, p95, run id, short measured commit, the ten-minute
  soak drifts, the gzip-CPU regression disclosure and the "no headline improvement is claimed" statement;
- the six archives and which ones are executed vs built-only, Docker `:latest` semantics, update/rollback and
  migration restrictions, auto-update OFF for ambiguous input, unknown fields/files preserved, do-not-rewrite
  boundaries;
- the 20 pinned third-party extensions, provider-wire coverage and startup differential (generated fragments);
- the by-decision exclusions: Node server plugins, local in-process ML, remote embeddings, Jimp byte equality,
  package-owned wire formats, `git.backend: builtin`, per-chat backups, VERTEXAI full mode, inherited substring
  host matching.

What was removed was *duplication and stale repetition*, not facts: the 22-row evidence table (one source of truth
is `docs/goal-scorecard.md`), the long release history, the second install block, the 34-line compatibility table
duplicated as prose, and the detailed benchmark narrative now living in `docs/performance.md`.

## 4. Artifact provenance used (unchanged, no new measurement)

The README, `docs/performance.md` and both figure variants restate the SAME committed artifact as before:

| field | value |
|---|---|
| artifact | `tests/perf/q22-baseline.json` (wrapper; q22 report embedded verbatim) |
| workflow / job | `GoTavern smoke metrics` / `paired-linux-amd64` |
| run id | `42012475880` (success, `workflow_dispatch`, `main`) |
| measured commit | `f1396cec6a26719501801846577f26d0cca0156b` |
| runner | `ubuntu26` `20261026.180.1`, Linux/X64, 4 vCPU, 16,759,443,456 B RAM |
| units | decimal MB (1e6 B); milliseconds elsewhere |
| figures | `docs/assets/benchmark.svg`, `docs/assets/benchmark-light.svg` — regenerated from the artifact and byte-compared, NOT edited by this lane |
| provenance note | `docs/assets/benchmark.svg.provenance.md` — unchanged |

No number was fabricated, no run id was invented, and no SVG was hand-edited. The local engineering numbers quoted
in `docs/performance.md` §4-§5 (previous record `41777492725` @ `4fd8ed7`, the 10k/100-card on/off arms) were
already recorded in `docs/perf-baseline.md` §1 and §10.4; they moved there from the README, they were not invented
here. `docs/performance.md` marks them local, states that the paired CI record does not drive that route, and
states that the release claims no headline-metric improvement.

## 5. Checker contract

`tools/check-perf-docs.mjs` now checks the README, the new `docs/performance.md`, both figures, the provenance note,
the baseline document and the generator. Every problem prints a **stable named assertion** and the process exits
non-zero; a green run prints one line. The assertions are grouped as follows (✓ = has a dedicated negative test in
`tests/docs/check-perf-docs.test.mjs`; the rest are fail-closed structural checks already exercised by the previous
round's recorded teeth in `docs/perf-baseline.md` §7 or by the checks they depend on):

| assertion id(s) | check | negative test |
|---|---|---|
| `ARTIFACT-READ`, `ARTIFACT-SHAPE`, `ARTIFACT-RUN-ID`, `ARTIFACT-COMMIT`, `ARTIFACT-RUNNER`, `ARTIFACT-SOAK`, `ARTIFACT-ASSERTED` | baseline is parseable, has an embedded report with both summaries, a GitHub run id, a full 40-char commit, a consistent runner image, complete soak series and asserted structural flags | — (fail-closed on malformed artifact) |
| `README-FIRST-SCREEN-BOUNDARY`, `README-FIGURE-PAIR`, `README-ALT-TEXT`, `README-ALT-TEXT-VALUE`, `README-START-BLOCK`, `README-FIRST-SCREEN-LINKS`, `README-FIRST-SCREEN-SCOPE`, `README-FIRST-SCREEN-VERSION`, `README-WORDING` | GOAL §15.6 first screen: `<picture>` + `prefers-color-scheme` + both variants, alt text recomputed from the artifact (4 pinned × 4 GoTavern × 4 ratios), shortest start block, three detail anchors, `GOAL.md`/`not met`/`synthetic` in the same place, no release version above the boundary, no "perfectly compatible" wording | `README-ALT-TEXT` ✓; the rest are the previous round's teeth (§7) |
| `README-BUDGET` | 10,000–14,000 B, 100–160 raw lines, 100–150 non-blank lines | ✓ over-budget README |
| `README-RELEASE-TOKEN`, `README-RELEASES-LATEST`, `README-STALE-VERSION` | names `v0.1.0-alpha.17`, links `releases/latest`, and refuses the known-stale tokens (`alpha.13`, `alpha.15`) and any other release token presented with current/latest wording | ✓ stale token |
| `README-LINK` | every relative link and every `#anchor` in the README resolves (files and heading slugs) | ✓ broken link |
| `README-DUPLICATE-SECTION`, `README-DUPLICATE-PARAGRAPH` | no repeated heading, no repeated long paragraph | ✓ duplicate section |
| `README-SECTION-PERFORMANCE`, `README-UNIT`, `README-TABLE-ROW`, `README-TABLE-PINNED`, `README-TABLE-GOTAVERN`, `README-TABLE-HOW`, `README-P95`, `README-RSS-SAMPLING`, `README-RUN`, `README-COMMIT`, `README-SOAK`, `README-REGRESSION` | the four recorded rows recomputed from `report.summary`, the measurement column, `p95: 70.33 / 0.596`, "30 requests per path (60 per round)", run id, short commit, all three soak drifts, the gzip-CPU/no-improvement regression disclosure | ✓ wrong table cell; ✓ tampered baseline copy |
| `PERF-DOC-READ`, `PERF-DOC-STATUS`, `PERF-DOC-RUN`, `PERF-DOC-COMMIT`, `PERF-DOC-ROUNDS`, `PERF-DOC-UNITS`, `PERF-DOC-P95`, `PERF-DOC-RSS-SAMPLING`, `PERF-DOC-SOAK` | the detailed document carries the artifact identity (status line, run, full commit, rounds × requests, decimal-MB rule, p95, `VmRSS` sampling rule, soak drifts) | ✓ wrong table cell (same recomputation path) |
| `PERF-DOC-TABLE-ROW`, `PERF-DOC-TABLE-PINNED`, `PERF-DOC-TABLE-GOTAVERN`, `PERF-DOC-TABLE-HOW` | the §2 recorded table is recomputed cell by cell; the §4 before/after table is NOT read as a second claim (it carries a previous record's value in a different column) | ✓ wrong table cell |
| `PERF-DOC-RATIOS` | 87.97x, 22.60x, 152.9x, 1.60x are recomputed from the artifact's two values | — |
| `PERF-DOC-BEFORE-AFTER` | names the previous recorded run id and commit it compares against | — |
| `PERF-DOC-REGRESSION` | states the cold-first-request cost, the `+21%` figure and the gzip CPU cost — wins cannot be reported without costs | — |
| `PERF-DOC-LOCAL-LABEL` | the local engineering baseline stays labelled "These are local, single-machine numbers" | — |
| `PERF-DOC-UNPROVEN` | `GOAL.md`, `NOT MET`, `REPORT-ONLY`, `detection floor`, `macOS ARM64`, `UNVERIFIED`, `windows/arm64`, `BUILD-ONLY`, `ENOSPC`, `UNPROVEN` are all present | ✓ dropped `REPORT-ONLY` |
| `PERF-DOC-COLD-GUARD` | names the cold-guard row; while `docs/alpha17/perf/` does not exist the document must say the record is **pending**, and once the perf lane produces artifacts it must point at `docs/alpha17/perf/` instead | ✓ "pending" removed |
| `PERF-DOC-LINK`, `PERF-DOC-DUPLICATE-SECTION`, `PERF-DOC-DUPLICATE-PARAGRAPH`, `PERF-DOC-STALE-VERSION` | the detailed document gets the same link/duplicate/stale-token checks as the README | ✓ broken link; ✓ duplicate section |
| `PROVENANCE-*` | run id, full commit, rounds × requests, soak shape, runner image, decimal-MB unit, both figure filenames, 1200 canvas, contrast audit, 12 px floor, `--out-light` regeneration | — (unchanged from the previous round) |
| `BASELINE-DOC-*` | `docs/perf-baseline.md` identity only: run/commit/rounds/CPU/RAM/unit, metric matrix, update procedure, no second hand-copied table before §7, and a pointer to `docs/performance.md` | — |
| `GENERATOR-VERSION`, `GENERATOR-COMMIT` | `tools/benchmark-svg.mjs` hardcodes no release version and no measured commit (the pinned oracle commit is the one allowed literal) | — |
| `FIGURE-REGEN`, `FIGURE-DETERMINISTIC`, `FIGURE-BYTES-DARK`, `FIGURE-BYTES-LIGHT`, `FIGURE-CANVAS`, `FIGURE-ATTRIBUTES`, `FIGURE-UNITS`, `FIGURE-VERDICT`, `FIGURE-EXTERNAL` | both variants are regenerated twice from the artifact, byte-identical to each other and to the committed files; 1200×675; `role="img"`/`<title>`/`<desc>`; run/commit/unit; per-metric `faster`/`lighter`; no external reference | — (previous round's teeth) |
| `FIGURE-CONTRAST-DARK`, `FIGURE-CONTRAST-LIGHT`, `FIGURE-TYPE-FLOOR-DARK`, `FIGURE-TYPE-FLOOR-LIGHT` | WCAG 2.1 contrast recomputed from the COMMITTED palette (text 4.5:1, bar fills 3:1) and every declared type size ≥ 12 px | ✓ low-contrast fill |
| `FIGURE-PAIR-CONSISTENT` | the dark and light `<desc>` (the accessible data surface) must be identical — one recording, two palettes | ✓ light description tampered |

## 6. Commands executed and observed output

All commands were run from the repository root on the Windows/arm64 host, one at a time:

```text
(Get-Item README.md).Length                              -> 13993
(Get-Content README.md | Measure-Object -Line).Lines     -> 104
node tools/check-perf-docs.mjs                           -> exit 0
  perf-evidence: OK (tests/perf/q22-baseline.json run 42012475880 at f1396ce: README + docs/performance.md + figure bytes + provenance agree)
node --test tests/docs/*.test.mjs                        -> exit 0
  tests 15 / suites 0 / pass 15 / fail 0 / cancelled 0 / skipped 0 / todo 0
```

Three manual negative controls (copies written with Node `fs`, never with shell redirection, so bytes are exact; the
repository itself was never mutated, and the restored tree was re-run green):

```text
tamper README cell 14,515 -> 14,516
  [README-TABLE-PINNED] ...README-table.md:5: row "Cold start to first `/version` 200": pinned cell is "14,516 ms",
  the artifact gives "14,515 ms" (report.summary.*.bootMsMedian (14515 / 165))
tamper release token v0.1.0-alpha.17 -> v0.1.0-alpha.15
  [README-STALE-VERSION] ...README-stale.md:127: contains the known-stale release token "v0.1.0-alpha.15";
  it may not appear on a current release surface
tamper docs/performance.md REPORT-ONLY -> fine
  [PERF-DOC-UNPROVEN] ...performance-unproven.md: does not contain "REPORT-ONLY"
  (must state that the 8-user latency row is report-only)
restore -> node tools/check-perf-docs.mjs -> perf-evidence: OK (exit 0)
```

`git status` after the runs showed only the intended files modified/added by this lane (`README.md`,
`docs/perf-baseline.md`, `tools/check-perf-docs.mjs`, `docs/performance.md`, `tests/docs/check-perf-docs.test.mjs`,
`docs/alpha17/readme-restructure.md`); the temporary copies lived under `%TEMP%` and were deleted. No mutation was
left in the tree.

## 7. Files touched by this lane

| file | change |
|---|---|---|
| `README.md` | rewritten to 13,993 B / 149 raw / 104 non-blank lines, 10 sections, alpha.17 release identity |
| `docs/performance.md` | new detailed performance document (artifact identity, method, before/after, resource coverage, reproduction, UNPROVEN rows, gate contract) |
| `tools/check-perf-docs.mjs` | extended: named assertions, README budget/stale/link/duplicate checks, `docs/performance.md` checks, figure contrast + pair consistency |
| `tests/docs/check-perf-docs.test.mjs` | new: 15 node:test cases (14 negative controls + positive control) |
| `docs/perf-baseline.md` | §4 pointer to `docs/performance.md` only; identity/method/update procedure unchanged |
| `docs/alpha17/readme-restructure.md` | this report |

## 8. Residual risks and UNEXECUTED items

- **This change has not run in CI.** Every command above is local Windows/arm64 evidence. The checker is Node-only,
  so the Linux `verify` job should behave the same, but a green local run is not the CI gate (`AGENTS.md` working
  mode). UNEXECUTED: a GitHub Actions `verify` run at this change's commit.
- **No new performance measurement was taken.** The numbers are the committed `42012475880` artifact's, and the
  figures were regenerated/byte-compared, not re-rendered or re-measured. The alpha.17 code-complete commit's own
  same-SHA `GoTavern smoke metrics` gate is a release-bar item (`docs/alpha17/README.md` §7.3) and is NOT executed
  or claimed here.
- **The cold-guard row is pending.** `docs/alpha17/perf/` does not exist in this tree at the time of writing; the
  document says so explicitly, and the checker refuses rows that silently claim it. If the perf lane publishes a
  cold-guard record, `docs/performance.md` must be updated to point at it (the checker enforces the pointer branch).
- **`v0.1.0-alpha.17` is this tree's ship identity, not a published release.** The README says the releases page is
  authoritative for what is published right now and does not claim publication; `docs/alpha17/README.md` records
  the release as NOT PUBLISHED. No tag was created or moved by this lane.
- **Not every new assertion has its own negative test.** The highest-value classes (artifact consistency, budget,
  stale tokens, links, duplicates, alt text, contrast, pair consistency, UNPROVEN disclosure, cold-guard state) do;
  the remaining fail-closed checks inherit the previous round's recorded teeth and are exercised on every green run.
  Extending the suite to one test per assertion would triple its runtime on this host; recorded here as a known
  coverage limit rather than implied completeness.
- **`docs/generated/facts.json` was not regenerated by this lane.** The README retains its three
  `BEGIN GENERATED` fragments unchanged; the file is generated by `tools/generate-doc-facts.mjs` and the Lead
  regenerates it. `node tools/generate-doc-facts.mjs --check` was not run here (read-only, but out of this lane's
  resource budget); if a generated block moved, that step would catch it.
- **Browser/Playwright/npm were not run** (environment resource limit). The figure rendering at 420/640 CSS px and
  the GitHub theme selection are generator/provenance properties from the previous round, not re-measured here.
- **Alignment with the alpha.17 release bar:** this lane supplies §7.3's "README performance numbers and figure come
  from the recorded artifact" half and §7.5's "release notes name every unproven item" is the Lead's document; the
  version-classifier and published-artifact items are not this lane's.
