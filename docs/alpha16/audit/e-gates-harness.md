# Lane E — gates, harness and corpora: inventory, negative controls, and the first E03+E04 design

**Read at commit `c256f21`** (`lane/alpha16-program`, 2026-11-06). Pinned
oracle: `../SillyTavern` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127` (read-only, not booted).
M0 rules: read-only, no fix-while-reading, every claim cited, negative findings queried directly
(`docs/alpha16/README.md:11-34`). This lane wrote only
`docs/alpha16/audit/e-gates-harness.md` and `docs/alpha16/audit/fragments/e.json`.

## 0. Counts, and how each count was obtained

| quantity | value | how |
|---|---|---|
| workflow files | 20 | `Get-ChildItem .github/workflows -Filter *.yml \| Measure-Object` |
| workflows named as required same-SHA gates | **13** | `(Get-Content docs/release-manifest.json -Raw \| ConvertFrom-Json).requiredGates \| Measure-Object` |
| required gates with a `requiredArtifact` | 3 | same query, `.requiredArtifact` non-null (third-party, long-lived, node-stock-tree) |
| required gates with `requiredJobs` | 2 | long-lived (`medium-corpus`), node-stock-tree (`node-stock-tree`) |
| required gates with `requiredEvidence` | 2 | long-lived, node-stock-tree |
| first-party scripts | 35 top-level + 3 under `scripts/release-governance/` = 38 | `Get-ChildItem scripts -File \| Measure-Object` plus the subdirectory |
| files under `tools/` | 183 | `Get-ChildItem tools -Recurse -File \| Measure-Object` |
| files under `tests/browser/` excluding `node_modules` (528), `.pinned-run`, `test-results`, `.tmp-artifacts` | 195 | recursive file count with those paths filtered out (the 739 in the task brief is the unfiltered count) |
| files under `tests/oracle/` | 131 | 123 `*.json` fixtures + 8 other files (5 `*.test.mjs`, README, 3 in `q21/`) |
| files under `tests/e2e/` | 25 | recursive count |
| files under `tests/perf/` | 11 | recursive count |
| `tools/probe-*.mjs` | 118 | `Get-ChildItem tools -File -Filter 'probe-*.mjs' \| Measure-Object` |
| provider-wire scenario files | 258 | `Get-ChildItem tests/provider-wire/scenarios -File \| Measure-Object` |
| `internal/mockprovider` package named in the task brief | **does not exist** | `Get-ChildItem internal -Directory` lists 18 packages, none is `mockprovider`; the recording peer is `tests/mockprovider/` (4 Go files) and `tools/mock-provider/main.go` |
| guards in `compare-combination-journey.mjs` | 83 | 18 literal `add('` calls + 21+12+7+12+13 names routed through `observed()` at `tests/browser/compare-combination-journey.mjs:103-136,141-145` |
| mutation cases in `combination-journey-gate-selftest.mjs` | 5 | `tests/browser/combination-journey-gate-selftest.mjs:62,73,78,83,92` |
| mutation cases in `whole-session-gate-selftest.mjs` | 19 | 19 `expected:` entries in `MUTATIONS` (`tests/browser/whole-session-gate-selftest.mjs:89-255`); the file header says "eleven" and lists A–P, which is stale |
| mutation cases in `extension-corpus-selftest.mjs` | 12 | header list `tests/browser/extension-corpus-selftest.mjs:9-22` |
| mutation cases in `helper-state-gate-selftest.mjs` | 5 | `tests/browser/helper-state-gate-selftest.mjs:9-14` |
| probes with no CI reference | see §3.3 | filename grep across `.github/workflows/*.yml` |

## 1. Gate inventory

### 1.1 The 20 workflows, with trigger, budget and artifacts

`timeout-minutes` is the declared duration budget of each job (a backstop, not a measurement); "artifact"
is every `actions/upload-artifact` name in the file.

| workflow (`name:` / file) | jobs | trigger(s) | job budgets | artifacts |
|---|---|---|---|---|
| GoTavern CI `ci.yml` | changes, oracle, browser-evidence, verify, crash-gate, race | push `main`; schedule `17 4 * * *`; dispatch (`probes`, `oracle_concurrency`) | 10 / 240 / 10 / 30 / 25 / 30 | `oracle-linux-rerecord`, `provider-wire-captures` |
| Browser differential `browser-differential.yml` | differential, handback-stability, publish-preset | push narrow path set; schedule `43 5 * * *`; dispatch (`mode`, `sources`, `commit_artifacts`, `stability_runs`) | 150 / 150 / 5 | `preset-evidence`, `extension-assets-reports`, `browser-differential-<run_id>`, `q21-handback-stability-<run_id>` |
| Combination journey differential `combination-journey.yml` | combination-journey | dispatch (no inputs); push on harness paths | 60 | `combination-journey` |
| GoTavern whole-session differential `whole-session.yml` | whole-session | dispatch (no inputs); push on harness paths | 75 | `whole-session-<run_id>` |
| GoTavern world-info slot ordering `worldinfo-slots.yml` | worldinfo-slots | dispatch (no inputs); push on harness paths | 40 | `worldinfo-slots-<run_id>` |
| Helper state differential `helper-state.yml` | helper-state | dispatch (no inputs); push on paths | 45 | `helper-state-differential` |
| Third-party extension compatibility `third-party-extension-compat.yml` | selftest, sentinel, shard×4, aggregate, cross-platform×3, corpus, soak, overhead | pull_request/push on harness paths; schedule `41 5 * * *`; dispatch (`mode`) | 15 / 60 / 150 / 20 / 90 / 120 / 90 / 75 | `extension-compat-sentinel`, `extension-compat-shard-<n>`, `extension-compat-evidence`, `extension-compat-<platform>`, `extension-compat-corpus`, `extension-compat-soak`, `extension-compat-overhead` |
| GoTavern long-lived corpus qualification `longlived.yml` | small-corpus, medium-corpus, large-corpus | dispatch (`size`, default small); push on generator paths; schedule | 45 / 90 / 90 | `longlived-small-<run_id>`, `longlived-pinned-extensions-<run_id>`, `longlived-medium-<run_id>`, `longlived-medium-evidence`, `longlived-large-<run_id>` |
| GoTavern Node stock tree round trip `node-stock-tree.yml` | node-stock-tree | push `main`/`lane/**`; dispatch | 45 | `node-stock-tree-evidence` |
| GoTavern drop-in qualification `dropin-qualification.yml` | dropin-current-head, windows-inputs, dropin-windows | push `main`/`lane/**`; dispatch | 25 / 15 / 30 | `node-stock-tree-inputs`, `dropin-failure-evidence`, `dropin-windows-inputs`, `dropin-windows-failure-evidence` |
| GoTavern release qualification `release-qualification.yml` | qualify-linux-amd64, qualify-windows-amd64, qualify-upgrade-rollback, qualify-published-alpha9-upgrade, qualify-dropin-linux | push tags `v*`; dispatch (`baseline_ref`, default empty) | 60 / 60 / 60 / 45 / 25 | `published-alpha9-upgrade-<run_id>`, `dropin-failure-logs` |
| GoTavern smoke metrics `smoke-metrics.yml` | measure-linux-amd64, paired-linux-amd64 | dispatch (`requests`, default 50); schedule `23 5 * * 1` | 20 / 45 | `smoke-metrics`, `q22-paired-benchmark` |
| GoTavern Docker image `docker.yml` | docker | push `main` on image paths, push tags `v*`; schedule `0 6 * * 1`; dispatch (`push_image` default false, `image_tag`) | 45 | (none) |
| GoTavern bench profiles `bench-profiles.yml` | bench-profiles-linux-amd64 | dispatch (`rounds`); schedule `41 6 * * 2` | 45 | `bench-profiles` |
| Group-chat differential `group-chat-differential.yml` | group-chat | dispatch; push on harness paths | 15 | `group-chat-differential-<run_id>` |
| GoTavern Lane CI `lane.yml` | lane | push `lane/**`; dispatch | 30 | `gotavern-lane-binaries` |
| GoTavern live provider + proxy canary `live-provider-canary.yml` | live-canary | dispatch (`mode` default `skip`) | 15 | `live-provider-canary-report` |
| GoTavern published-extension smoke `published-extension-smoke.yml` | published-linux-artifact, published-container | dispatch (`tag`, required) | 120 / 30 | `published-extension-smoke-linux` |
| GoTavern published-release install smoke `release-install-smoke.yml` | smoke-published-linux-amd64, smoke-published-windows-amd64 | dispatch (`version`); schedule | 8 / 20 | (none named) |
| GoTavern Release `release.yml` | build, execute-linux-arm64, execute-darwin-amd64, execute-darwin-arm64, windows-arm64-boundary, prepublish-qualification, publish, post-release-facts | push tags `v*`; dispatch (`ref`, `candidate_version`) | 45 / 20 / 20 / 20 / 5 / 20 / 15 / 20 | one per archive |

### 1.2 The 13 alpha.15 same-SHA required gates

Every entry in `docs/release-manifest.json:5-88` requires (a) `sameShaRequired: true`
(`docs/release-manifest.json:3`, enforced at `scripts/release-governance/gates.mjs:46-48`), (b) a
completed/success run whose `head_sha` equals the tag commit, and (c) `requiredEvent: workflow_dispatch`
because a push/PR run narrows its selection by changed paths (`docs/release-manifest.json:4`,
`gates.mjs:258-266`).

| # | gate (manifest `workflow`) | file | required jobs | artifact / embedded evidence | what a green can actually support |
|---|---|---|---|---|---|
| 1 | GoTavern CI | `ci.yml` | — | — | gofmt, generated facts, compat matrix, classifier table, Go suite, vet, build, assets verify, race, browser-evidence self-tests, and the oracle re-record zero-diff, **for the probes this dispatch selected** (`ci.yml:91-125`, `319-326`) |
| 2 | GoTavern whole-session differential | `whole-session.yml` | — | — | one stock tree per subject, one browser lineage, one restart, 3 journeys judged by `compare-whole-session-legs.mjs` with 19 planted-mutation teeth on this run's artefacts (`whole-session.yml:230-310`) |
| 3 | GoTavern world-info slot ordering | `worldinfo-slots.yml` | — | — | before/after/atDepth world-info slots reach the provider request in pinned's order, plus a zero-diff of the fresh comparison against the committed one (`worldinfo-slots.yml:156-190`) |
| 4 | GoTavern drop-in qualification | `dropin-qualification.yml` | — | — | the packaged archive boots against a stock SillyTavern tree on Linux and (via `dropin-windows`) Windows, four scenarios each (`dropin-qualification.yml:114-139`, `774-782`) |
| 5 | Browser differential | `browser-differential.yml` | — | — | the pinned frontend's recorded journeys (generation, stream, cancel, preset, regex, assets, helper, helper generation, helper variables, framing, Q17, Q18, Q20 save/regen/continue, Q21 hand-back) judged per capture, **for the `mode` this dispatch selected** (`browser-differential.yml:190-226`, `264`) |
| 6 | GoTavern release qualification | `release-qualification.yml` | — | — | fresh install from the extracted archive, idempotence, update, rollback, cross-baseline survival, installer execution on Linux and Windows (`release-qualification.yml:57-669`) |
| 7 | GoTavern smoke metrics | `smoke-metrics.yml` | — | — | the paired benchmark **ran**: both subjects answered every round, sample counts matched, cold start under 60 s, soak completed; the performance *numbers* are recorded, not asserted (`smoke-metrics.yml:62-193`, `scripts/smoke-metrics.mjs:403-405`) |
| 8 | GoTavern Docker image | `docker.yml` | — | — | the image builds, `assets verify` passes inside it and one pinned route smokes; on a tag push it also publishes and pulls back (`docker.yml:93-221`, `323-339`) |
| 9 | Helper state differential | `helper-state.yml` | — | — | 酒馆助手 second-order state (scoped variables, in-use preset mutation, lifecycle events, iframe→bridge→disk→next-request closure) on both subjects with a 30-guard judge and 5 planted mutations (`helper-state.yml:110-166`) |
| 10 | Combination journey differential | `combination-journey.yml` | — | — | one composed session (card × preset × helper × world info × variables × regex × QR × streaming × verbs × reload × restart × group × hand-back), byte-equal per capture, 83 guards, 5 mutation teeth, on both subjects (`combination-journey.yml:136-194`) |
| 11 | Third-party extension compatibility | `third-party-extension-compat.yml` | — | `extension-compat-evidence` (no `requiredEvidence`) | exactly 20 pinned extensions each install→activate→persist→restart→disable→re-enable→uninstall on both subjects, aggregator checks the observed set = lock, lock SHA, head SHA, run id (`third-party-extension-compat.yml:205-336`); artifact content not re-validated at publish |
| 12 | GoTavern long-lived corpus qualification | `longlived.yml` | `medium-corpus` | `longlived-medium-evidence` + `gotavern-longlived-corpus-evidence` (`kind`, tier `size: medium`, embedded `headSha`, `ok`, `comparatorTeeth.ok`, `pinnedExtensions.manifestSha256`, `corpus.treeSha256`) | a ~50 MB / 2400-message synthetic history boots as two subject copies, is driven through resume→send→swipe→switch→reload→restart→resume→continue, the 20 pinned extensions are installed on the complex instance, and the comparator's teeth are required truthy (`longlived.yml:285-480`; `docs/release-manifest.json:62-75`) |
| 13 | GoTavern Node stock tree round trip | `node-stock-tree.yml` | `node-stock-tree` | `node-stock-tree-evidence` + `gotavern-node-stock-tree-evidence` (`ok`, `roundTripOk`, `treeSha256`, `manifestSha256`, embedded `headSha`) | a tree recorded **by pinned Node** is read/mutated by GoTavern, restarted, handed back to pinned Node which continues it, and read by GoTavern again, with whole-tree preservation assertions (`node-stock-tree.yml:133-229`; `docs/node-stock-tree.md:128-196`) |

The six workflows that are **not** release gates: `bench-profiles.yml`, `group-chat-differential.yml`,
`lane.yml`, `live-provider-canary.yml`, `published-extension-smoke.yml`, `release-install-smoke.yml`; plus
`release.yml` itself, which cannot be its own precondition (`docs/release-manifest.json:4`).

### 1.3 What the same-SHA verifier can and cannot check

`scripts/verify-release-gates.mjs` → `scripts/release-governance/gates.mjs` is the whole enforcement.

It **can** check, per gate, one candidate run:

- `head_sha === sha`, `status: completed`, `conclusion: success`, `event === requiredEvent`
  (`gates.mjs:256-267`);
- the named jobs are completed/success *in that run* (`gates.mjs:162-189`);
- the named artifact is attached and not expired (`gates.mjs:191-207`);
- the artifact's `release-evidence.json` member: `schemaVersion`, `kind`, embedded `headSha === sha`, a
  tier marker at a dotted path, `requireTruthy` fields exactly `true`, `requireSha256` fields as lowercase
  64-hex (`scripts/release-governance/artifact-evidence.mjs:115-153`; the member is read out of the ZIP at
  `artifact-evidence.mjs:62-101`).

It **cannot** check, from the Actions runs API and the manifest as written:

- **dispatch inputs.** `recordOf()` copies only `name, id, head_sha, status, conclusion, event,
  created_at, html_url` (`gates.mjs:142-153`). `ci.yml` narrows the oracle when `inputs.probes` is non-empty
  (`ci.yml:124` → `tools/oracle/plan.mjs:222-250`), and `browser-differential.yml` narrows its whole surface
  set when `inputs.mode` is not `all` (`browser-differential.yml:190-197`, `264`, per-surface `if:` gates).
  Both still produce a completed/success `workflow_dispatch` run, so **both satisfy the gate while proving a
  subset**. The manifest's own comment claims the opposite ("dispatched with the full selection",
  `docs/release-manifest.json:4`), and the `requiredEvent` rail was added for exactly this class
  (`gates.mjs:256-262` records run 41210334467 as the motivating measurement) — but the rail only checks the
  event, not the selection.
- **the content of the other 10 gates' artifacts.** Only 3 gates name an artifact and only 2 name
  `requiredEvidence`; the evidence table prints `-` for the rest (`verify-release-gates.mjs:108-112`).
- **freshness of committed browser artifacts.** `browser-differential.yml:2202-2250` records
  committed-vs-fresh as a `continue-on-error: true` report and says in prose that a stale artifact "is not a
  failure of this job by itself".

The rails are themselves tested with teeth: `scripts/release-governance.test.mjs` is described as 34
fabricated-API rows / 55 checks (`docs/audit-v0.1.0-alpha.15.md:189`), and it runs in `ci.yml#verify`
(`ci.yml:555`). The `requiredJobs` rail exists because the default long-lived dispatch is green with
`medium-corpus` SKIPPED (`docs/release-manifest.json:64`; `longlived.yml:285-286`).

## 2. Harness inventory

Each row states what the harness proves, what it does **not** prove, and its negative-control state
("teeth" = a step that plants a defect and requires a named red on every run).

### 2.1 Oracle and provider-wire

| harness | proves | does not prove | teeth |
|---|---|---|---|
| 118 `tools/probe-*.mjs`, discovered by `@gotavern-oracle: fixture=` declarations (`scripts/dev-verify.mjs:84-97`) | pinned-Node observations re-recorded to 123 fixtures under `tests/oracle/`; the zero-diff step fails when a probe's output moves (`ci.yml:319-326`) | a probe that did not run: a narrowed run leaves its fixture byte-identical and the zero-diff cannot see it (`ci.yml:78-82`) | the red is the normal failure mode (a changed recording); the planner/graph has unit tests `tests/oracle/plan.test.mjs` run in `verify` (`ci.yml:527`). No planted-defect step per probe |
| `tools/oracle/manifest.mjs` + `plan.mjs` + `execution.mjs` | selection is code, not YAML: one dependency graph, a dispatch with no probe list is a full sweep (`tools/oracle/plan.mjs:222-231`), an unknown requested probe is a hard error (`plan.mjs:233-246`) | the selection is not re-derived from the run's own inputs at release time (§1.3) | `tests/oracle/plan.test.mjs` (34 KB) is the table test; `FULL_TRIGGERS` forces a full sweep on control-plane changes (`plan.mjs:84-85`) |
| `tools/mock-provider` (`main.go`) + `tests/mockprovider` (sequential `Recorder`, `KeyedRecorder`) | a controlled peer for provider-wire capture; records raw target/headers/body; `KeyedRecorder` handles concurrent/redirect shapes (`tests/mockprovider/keyed.go:1-30`) | not a browser peer and not the in-process capture peer the browser legs use | — (test infrastructure; no self-test of its own; correctness is enforced by the committed scenario fixtures) |
| 258 scenario files in `tests/provider-wire/scenarios/` | the E/streaming/cancel/preset matrix is computed from committed artefacts, not prose (`docs/development-loop.md:104-107`; `GOAL.md:195-221`) | "coverage is computed" is only as good as the catalogue; a new source with no scenario is visible only if the generator is re-run (`ci.yml:495`) | `tools/generate-coverage-matrix.mjs --check` and the preset-knob A/B tests run in `browser-evidence` (`ci.yml:364-374`) |

### 2.2 Browser differential surfaces

`browser-differential.yml` is one 150-minute job with ~40 steps; the per-surface record → compare → teeth
triplet is the pattern.

| surface | driver / comparator | proves | does not prove | teeth |
|---|---|---|---|---|
| generation / stream / cancel | `generation-probe.mjs`, `compare-generation-legs.mjs`, `compare-streaming-legs.mjs` | per-capture method+target+length+sha256 equality on both subjects | a real provider (in-process peer, `AGENTS 22`) | framing/streaming selftests (`streaming-framing-selftest.mjs`, `-hop-`, `-verifier-`) at `browser-differential.yml:710`, `1824-1850` |
| assets / thumbnails / persona / backgrounds | `asset-probe.mjs`, `compare-asset-legs.mjs` | URL/status/MIME/length/sha256, DOM `complete`/`naturalWidth`, CSS background, console | paint is only claimed where the binding exists (`docs/goal-scorecard.md:55`) | `asset-gate-selftest.mjs` (synthesised broken legs; runs in `ci.yml:379` and the browser job) |
| complex preset (A/B, KEEP/DROP, boundary, real-preset) | `capture-preset.mjs`, `preset-boundary-search.mjs`, `real-preset-probe.mjs`, `compare-preset-legs.mjs` | `Node(X)==Go(X)` and `X!=Y`; truncation set identity | committed presets are 105 and 119 prompts (§4.1) | `preset-gate-selftest.mjs` (3 mutations, in-memory, `browser-differential.yml:1988`) |
| regex | `regex-probe.mjs`, `compare-regex-legs.mjs` | prompt/display placement, disabled control, swap chain, JS substitution, write-back | — | `regex-gate-selftest.mjs` (9 mutations, green-first; `browser-differential.yml:2116`) |
| Q17 author's note | `authors-note-sweep.mjs`, `compare-authors-note-legs.mjs` | at-depth parity across cases; one case declared `null` (unmeasurable) | — | `authors-note-gate-selftest.mjs` + `tools/authors-note-surface-selftest.mjs` (`browser-differential.yml:1475`, `2198`) |
| Q20 verbs (save/reload/swipe, regenerate, continue) | `q20-persistence-probe.mjs`, `q20-regenerate-probe.mjs`, `q20-continue-probe.mjs` + comparators | the verb's request bytes equal pinned's; the continue request is selected by the product's own nudge marker | a controlled differential gives both subjects the same inputs, so equality under arbitrary differing state is not shown (`docs/goal-scorecard.md:68`) | `q20-continue-comparator-selftest.mjs` (48 KB) at `browser-differential.yml:1805` |
| Q21 hand-back | `q21-data-handback.mjs`, external judge | both directions, non-zero counts | the card is the committed derivation, not the user's | re-judge / stability mode (`browser-differential.yml:1900-1977`, `2314+`); `docs/browser-stability.md` records a real flake and its fix |
| extension asset serving | `extension-assets-probe.mjs`, `-compare.mjs` | every extension asset request status/shape | that the extension's code ran | `extension-assets-compare` runs after; no dedicated mutation step found in the workflow |

### 2.3 Extension harnesses

| harness | proves | does not prove | teeth |
|---|---|---|---|
| `extension-lifecycle-probe.mjs` + `compare-extension-lifecycle.mjs`, run per extension in 4 shards by `third-party-extensions-run.mjs` | install → activate → change own setting → real restart → persistence → disable → re-enable → uninstall on both subjects; verdict taxonomy PASS/FAIL/UPSTREAM_FAIL/N/A (`compare-extension-lifecycle.mjs:7-11`); pinned revision asserted by `install-pinned-extension.mjs` | the 20 are **not** installed together here — one fresh data root per extension (`third-party-extensions-run.mjs:463-468`) | `third-party-extensions-selftest.mjs` (identity, 404-is-not-ready, port collision, listener ownership, forced leg failure, comparator mismatch, missing artifact, aggregator set, lock validation; `third-party-extension-compat.yml:109-116`) |
| `extension-corpus-run.mjs --mode all20/clusters/soak` + `extension-corpus-probe.mjs` + `compare-extension-corpus.mjs` | the whole pinned set in ONE data root per subject (`extension-corpus-run.mjs:202-219`), page loads with every extension's first asset served, same API status/shape, same final page state, no Go-only browser error, and a 30-min soak with RSS/p95 guards (`compare-extension-corpus.mjs:85-354`) | **that any extension's code executed or changed anything.** `loaded` is set by the first successful request under `/scripts/extensions/third-party/<name>/` (`extension-corpus-probe.mjs:340-360`), and the per-extension rows carry `{name, loaded, firstFailingUrl}` only (`extension-corpus-probe.mjs:653-660`, `689`) | `extension-corpus-selftest.mjs` (12 cases incl. empty corpus, Go-only page error, status/shape, final state, soak regressions, live-egress exemption) |
| `extension-overhead.mjs` | four conditions (Go clean, Go+20, stock clean, stock+20): bootMs, RSS, `/version` p50, browser readiness and the all-20 asset-load moment, with deltas and explicit "unmeasured" fields | asserts nothing about speedup/regression by design (`extension-overhead.mjs:1-35`) | none; descriptive only |
| canaries | `tests/browser/pinned-extensions.mjs:11-24` pins JS-Slash-Runner `837a6288…` and LittleWhiteBox `9e71caef…` verbatim (`AGENTS.md` rule 15) | only Tavern Helper is installed by the combination journey; LittleWhiteBox has no browser journey in the release gates | pin immutability is asserted: the origin is frozen to a local bare mirror and the revision is checked at start and end (`install-pinned-extension.mjs:64-102`) |

### 2.4 Corpora and the shared schema

| harness | proves | does not prove | teeth |
|---|---|---|---|
| `internal/longlivedfixture` (Go generator; 782 lines) | a deterministic complex tree: v2/v3 cards with alternate greetings + embedded character books, 2400-message chats with swipes/branches, **recursive world books with `keysecondary`, `excludeRecursion`, `preventRecursion`, `delayUntilRecursion`** (`longlivedfixture.go:312-318`), a **120-prompt preset** (`longlivedfixture.go:339-345`) | not the browser tree: the browser cannot import Go (§2.4 next row) | `longlivedfixture_test.go`; determinism tests via the schema |
| `tools/build-longlived-corpus.mjs` (JS generator) | deterministic browser/Node data root: 3 sizes, manifests, `--verify-deterministic`, world books, presets incl. `preset-b.json` copied verbatim as "Long-Lived Complex" (`tools/build-longlived-corpus.mjs:99-101`) | **no 120+ prompt preset**: generated presets are `promptCount: index === 0 ? 40 : 60 + index` (`:586`), i.e. ≤66 for the large profile, and the copied `preset-b` is 119 (`tests/browser/fixtures/real/real-fixture-manifest.json:67`); world entries carry `keysecondary: []` (`:243`) and recursion flags all false (`:255-257`) | `tools/longlived/verify.mjs`, `verify-corpus-schema.mjs`, and `--verify-deterministic` in-workflow (`longlived.yml:340-364`) |
| shared schema (`internal/longlivedfixture/corpus_schema.go`, `tools/longlived/corpus-schema.mjs`) | ONE schema (`gotavern-corpus-schema` v1) with `counts`, `features`, `markers`, `tree`, `files`, verified byte-for-byte against a tree; two corpora are **not** one corpus (`corpus_schema.go:1-45`, `corpus-schema.mjs:35-39,163-246`) | identity: `compare-corpora.mjs` reports `ONE_CORPUS_BYTE_IDENTICAL` only when every sha256 matches; the measured answer is `TWO_CORPORA_SHARED_SCHEMA` (`tools/longlived/compare-corpora.mjs:1-25`) | `corpus_schema_test.go` (Go) + `verify-corpus-schema.mjs` (JS); comparison cannot claim equality |

### 2.5 Persistence, concurrency and soak (Go e2e)

| harness | proves | does not prove | teeth |
|---|---|---|---|
| `tests/e2e/a15_concurrent_writers_test.go` | two real binaries on one data root: every request inside the lock bound, final file exactly one writer's bytes, parseable, visible to the other process (`a15_concurrent_writers_test.go:1-30`) | throughput/latency under 8 users (no performance numbers) | the alpha.15 audit records the M9 mutation (`docs/audit-v0.1.0-alpha.15.md:78`) |
| `a15_corrupt_data_test.go`, `a15_migrate_crash_test.go`, `a15_settings_crash_test.go`, `chat_crash_test.go`, `a15_efbig_linux_test.go` | kill-mid-write / corrupt-input / migration-interruption / EFBIG invariants | ENOSPC (policy: no elevation), Windows equivalents (declared skips) | each has a recorded mutation in the audit ledger (`docs/audit-v0.1.0-alpha.15.md:72-92`) |
| `tests/browser/extension-corpus-run.mjs --mode soak` | 30 minutes of send/cancel/reload/toggle on the all-20 page with RSS/p95/orphan guards (`third-party-extension-compat.yml:541-624`) | no login churn, no per-phase timing | comparator guards `soak-rss-not-regressed-3x` / `soak-p95-not-regressed-3x` are mutated in `extension-corpus-selftest.mjs:14-15` |

### 2.6 Performance harnesses

| harness | measures | committed artifact | notes |
|---|---|---|---|
| `tests/perf/q22-paired-benchmark.mjs` + `scripts/smoke-metrics.mjs` | boot, RSS, `/version` and `/` p50/p95, 10-min soak, paired medians | `tests/perf/q22-baseline.json` (wrapper: provenance + verbatim report) | method and limits: `docs/perf-baseline.md:54-68`; the paired medians are "evidence for a report, not a release gate" (`:66-68`) |
| `scripts/bench-profiles.mjs` | in-process benchmarks at 100/1,000/10,000 cards, large JSONL, 229-asset page load, provider assemble/marshal; **captures `-cpuprofile`, `-memprofile`, `-blockprofile`, `-mutexprofile` and a bounded `-trace`, and writes `pprof-*-top.txt`** (`bench-profiles.mjs:3-12`, `431-463`, `485-500`) | `tests/perf/bench-baseline.txt` (+ uploaded raw run/profiles/trace) | `bench-profiles.yml:88-111`; self-test at `:73` |
| `scripts/a15-bench-suite.mjs` + `tests/perf/fixturegen` + `tests/perf/procstat` | process-level `smoke` (cold+warm boot, RSS, peak RSS, CPU user+system, gctrace, P50/P95), `scale` (100/1k/10k cards, 10×2 MB chats, one 2,000-message JSONL, 1,000 worlds, 1,100 settings, complex preset, mixed), `concurrency` (32/128 in-flight), `assets` (229 calls), `soak` (10 min), `paired` | `tests/perf/out/a15/*.json` (gitignored, Layer A) | documented in `docs/perf-baseline.md:233-347`; **no workflow runs it** (grep: no reference in `.github/workflows`) |
| `tests/browser/extension-overhead.mjs` | 20-extension page-load cost on both subjects | `extension-compat-overhead` | in the non-required `overhead` job of the third-party workflow, only on `mode=full` dispatch/schedule (`third-party-extension-compat.yml:630-707`) |
| `tools/record-perf-baseline.mjs` + `tools/check-perf-docs.mjs` | provenance/digest coupling of the README table, both SVG figures and the artifact | README + `docs/assets/benchmark*.svg` | the docs gate has observed teeth (`docs/perf-baseline.md:165-185`) |

Measurement coverage is stated by the repository itself in `docs/perf-baseline.md:91-127`: CPU time,
GC count/pause, throughput, `benchstat` multi-round comparison and execution trace are `missing`;
peak RSS, p99, file descriptors, long-run drift are `partial`; the workload table marks 100/1,000/10,000
cards, large JSONL perf, complex-preset perf, multi-user concurrency and provider stream/cancel latency
`missing`.

### 2.7 `internal/mockprovider` does not exist

The task brief lists `internal/mockprovider/**`. There is no such package: `internal/` contains
`adversarial, app, assetmanifest, commandline, configinit, faultinject, fixtures, fsretry, httpx,
lockacquire, longlivedfixture, migrate, outbound, server, startup, tokenizers, userdata`. The recording
peers are `tests/mockprovider/` (Go, used by `tools/mock-provider/main.go`, provider-wire only) and the
in-process HTTP peers inside the browser harness (`startCapturePeer` at `tests/browser/q20-leg-runtime.mjs:87`,
`startCorpusPeer` at `tests/browser/extension-corpus-probe.mjs:45`). This is a query result, not a bounded
listing: the path does not resolve.

## 3. Negative controls: what can demonstrably fail

### 3.1 Per required gate

"Continuous" = a step inside the gate's own workflow plants a defect in this run's artefacts and requires a
named red. "Recorded" = a mutation was executed against an earlier commit and its run id/assertion is
written down; it is not re-demonstrated on every release.

| gate | continuous teeth | recorded teeth | assessment |
|---|---|---|---|
| GoTavern CI | yes, for the artefact-verifier family: asset / verifier-guards / tokenizer / fixture-gate / streaming-framing / release-governance / a15 selftests run in `browser-evidence` and `verify` (`ci.yml:375-430`, `555`) | oracle zero-diff reds are the normal failure mode; no planted-defect step per probe | strong for the verifier; the oracle's own gate is proved by the re-record, not by a mutation |
| whole-session | yes, 19 mutations across three journeys, baseline green required first (`whole-session-gate-selftest.mjs:1-44`, `whole-session.yml:265-299`) | — | strong |
| world-info slots | yes, named-red mutations plus a fresh-vs-committed artefact zero-diff (`worldinfo-slots.yml:156-190`) | — | strong |
| drop-in qualification | no in-workflow step | two red runs recorded in `docs/dropin-qualification.md:318-465` | adequate at alpha.15, not re-proved per release |
| Browser differential | yes, for assets (16+ synthesised cases), preset (3), regex (9), Q17 verifier, Q20-continue (48 KB selftest), framing (3 selftests), verifier guards, tokenizer (`browser-differential.yml:710,1475,1805,1824-1850,1988,2116,2198`) | — | broad, but per-surface: surfaces without a selftest (extension asset serving, Q18 truncation, Q20 save/regen judges) rely on the comparator only |
| release qualification | no in-workflow mutation step | rollback mutation run 39998226861 recorded in `docs/INSTALLATION.md:508`; docker publish-path hole recorded in `docker.yml:323-331` | recorded once |
| smoke metrics | **none found** | none found | only structural assertions; no mutation of a metric or threshold anywhere |
| Docker image | no in-workflow step | the "pushed-but-unverified" hole was found by a mutation and closed (`docker.yml:323-331`) | recorded once |
| helper state | yes, 5 mutations with baseline-green precondition (`helper-state-gate-selftest.mjs:42-58`) | — | strong |
| combination journey | yes, 5 mutations with per-guard green precondition (`combination-journey-gate-selftest.mjs:47-60`) | — | **thin relative to 83 guards, and the world-info slot guard is explicitly not demonstrated** (`:66-70`) |
| third-party extensions | yes, `third-party-extensions-selftest.mjs` (lock/identity/port/ownership/comparator/aggregator) + `extension-corpus-selftest.mjs` (12 cases), both before any expensive drive (`third-party-extension-compat.yml:83-116`) | — | strong |
| long-lived corpus | yes, comparator teeth computed from this run and **embedded as a required truthy field** (`longlived.yml:439-479`, `docs/release-manifest.json:72`) | — | the best-designed gate in the manifest |
| Node stock tree | no in-workflow step | two product mutations with named assertions and run ids (`docs/node-stock-tree.md:171-196`) | recorded once; generator determinism self-check in-workflow (`node-stock-tree.yml:107-131`) |

Count: **8/13 gates re-demonstrate a negative control on every run**; **4/13** have a recorded mutation
at an earlier commit (drop-in, release qualification, Docker, node stock-tree); **1/13** (smoke metrics) has
none found. This is a search result for the last row, but §3.3 records the assertion read that explains why:
`scripts/smoke-metrics.mjs:403-405` lists exactly four asserted properties, none of them a performance
number, and no self-test file for it exists in the tree (`Get-ChildItem scripts/tools/tests -Filter '*smoke*'`
finds only the harness and the workflow).

### 3.2 What a self-test can and cannot demonstrate here

Every comparator selftest in this tree mutates the **artefacts** (in memory), not the product. That is the
correct subject for a comparator's teeth (`AGENTS.md` differential doctrine 4) but it is weaker than a
product mutation: it proves the judge can reject a bad observation, not that the product path that produces
the observation is exercised. Product mutation evidence exists separately and is recorded in
`docs/audit-v0.1.0-alpha.15.md:200-229` and `docs/node-stock-tree.md:171-196`.

The self-tests that require the **baseline to be green first** are the honest shape and should be the
template for the new scenario: `helper-state-gate-selftest.mjs:42-49`, `whole-session-gate-selftest.mjs:68-70`,
`combination-journey-gate-selftest.mjs:47-53`, `worldinfo-slots-gate-selftest.mjs:3-18`,
`regex-gate-selftest.mjs:9-17`.

Two vacuity classes worth recording, neither currently load-bearing:

- `compare-combination-journey.mjs:60` computes `(steps ?? []).every(ok)` — vacuously true for an empty
  report. The comparator cannot pass on an empty report only because `nodeEqualsGo-per-capture` requires
  `common.length >= 5` (`:97`) and the 83 `observed` guards require named steps.
- `third-party-extensions-aggregate.mjs:122` sets `stock: observation?.row ? 'PASS' : 'NOT-OBSERVED'`, so the
  release-notes matrix's Stock column is derived from row existence, not from the pinned leg's verdict. It
  cannot reach a published release (any row whose verdict is not PASS fails the aggregator at `:99`), so the
  only consequence is a misleading artifact on a red run.

### 3.3 Gates/workflows that only assert their own success

- **smoke metrics** (§3.1). Its own documentation says the paired median "is evidence for a report, not a
  release gate" (`docs/perf-baseline.md:66-68`) while the manifest requires it as a release gate
  (`docs/release-manifest.json:36-40`).
- **browser-differential freshness** is `continue-on-error: true` and prose-declared non-failing
  (`browser-differential.yml:2202-2250`).
- **combination-journey leg failures**: the "Record the five legs" step writes `failures=1` to
  `$GITHUB_OUTPUT` (`combination-journey.yml:142-145`) but `set -uo pipefail` (no `-e`) and a trailing `echo`
  (`:139`, `:177`) keep the step green, and **no step in the file reads `steps.legs.outputs.failures`**
  (grep: the only `failures` references are `:142` and `:145`). `whole-session.yml:232,304-310` shows the
  correct consumption shape in the sibling workflow. The comparator catches most of the consequences
  (missing report → `read()` throws; a step marked not-ok → guard `both-legs-have-no-failed-step` at
  `compare-combination-journey.mjs:60`), so this is a defence-in-depth hole, not an open false green.
- **Docker dispatch**: `workflow_dispatch` with the default `push_image=false` publishes nothing
  (`docker.yml:168-217`), so a same-SHA dispatch can satisfy the Docker gate without exercising the publish
  path the release bar claims (`GOAL.md:565`).

### 3.4 "No mutation evidence found" vs "cannot fail"

Stated separately on purpose (`docs/alpha16/README.md:19-20`): the smoke-metrics row is a *search result*
plus the read assertion list that explains what it can fail on; the browser-freshness row is an *assertion
read* (`continue-on-error: true`); the narrowed-dispatch row is a *code read* of what the verifier receives
(`gates.mjs:142-153`) and of how the workflows narrow (`ci.yml:124`, `browser-differential.yml:264`).

## 4. The first E03+E04 combined scenario: reuse plan

Target (plan §M0/§1 last paragraph; GOAL §9): **real pinned Tavern Helper/JS-Slash-Runner + Quick
Replies/STscript + regex + nested world books + a complex preset at the 120+ prompt stress profile, all
changing ONE recorded provider request, driven through the unmodified frontend in one browser session, on
both subjects, with a comparator and a capable self-test.**

### 4.1 What exists today against that target

| ingredient | exists | evidence | gap for E03+E04 |
|---|---|---|---|
| one session, unmodified frontend, both subjects | yes | `combination-journey-probe.mjs:1-40`; 5 legs recorded by `combination-journey.yml:155-176` (drive/restart per subject + pinned hand-back) | — |
| real pinned Tavern Helper | yes | installed from the pinned commit and its API surface asserted (`combination-journey-probe.mjs:794-800`); variables written through the iframe bridge and injected (`:945-988`) | — |
| LittleWhiteBox canary | **no browser journey in any release gate** | only the pin (`tests/browser/pinned-extensions.mjs:18-23`); `AGENTS.md` rule 15 requires the canary | add to the same session |
| Quick Replies / STscript | yes, shallow | one QR created through `quickReplyApi` and executed, injecting `/inject … depth=4` (`combination-journey-probe.mjs:194-215`); marker asserted on the wire (`:1029`) | nested QR / STscript that writes a variable, which the helper then reads |
| character regex | yes | one card-scoped regex, placement 2, allow-listed through the extension's own state (`combination-journey-kit.mjs:105-124`, probe `:874-894`), asserted on the next request (`:1040`, `:1029`-adjacent) | — |
| nested world books | **no** | journey stages a 3-entry global book (before/after/depth) (`worldinfo-slots-kit.mjs:99-156`) and the journey card has **no** `character_book` (`combination-journey-kit.mjs:85-129`); the assertion is exactly 3 slots (`:1027`) | add (a) a card with an embedded character book, (b) a global book with secondary keys + recursion + regex keys, (c) a group-scoped book; markers per book, and a recursive-trigger marker that only appears when entry A's content activates entry B |
| complex preset | yes, 105 prompts | `fixtures/real/preset-a.json` = 105 prompts / 109 order rows / 0 helper bytes / 0 regex scripts (`real-fixture-manifest.json:36-37`, `:6-48`) | **120+ stress profile with 115+ order rows, reasoning/tool/schema members, custom stops, nested injection positions** |
| 20 pinned third-party extensions coexisting | yes, but in a different harness | `extension-corpus-run.mjs --mode all20` installs all 20 into ONE root per subject (`:202-219`) and drives load/send/cancel/reload/toggle; it does not drive a preset/world/QR journey | merge: the journey must load 22 extensions (20 + 2 canaries) in the session that produces the E03 request |
| ONE recorded request carrying all markers | yes, partially | `classifyCapture` extracts world slots, variables, QR, regex, preset markers from one body (`combination-journey-probe.mjs:746-774`); `turn-1-*` guards require them simultaneously (`:1024-1030`) | extend the extractor and the guards to the new markers, and require **order** for the world-info slots and the injection chain |

### 4.2 The scenario contract (what one run must produce)

1. One data root per subject, staged before boot: V3 card **with `character_book`** (nested book: 3+
   entries, one with secondary keys and `excludeRecursion:false`, one with a regex key), a global book with
   recursion depth 2 and a group book; the **stress preset** (≥120 prompts, ≥115 `prompt_order` rows, mixed
   roles, `injection_position`/`depth`/`order`, reasoning/tool members, ≥8 stop strings); 22 extension
   checkouts (Tavern Helper, LittleWhiteBox, the 20 from `third-party-extensions.lock.json`), each origin
   frozen to a local mirror.
2. One browser session on the unmodified pinned frontend: open the card, select the preset through the
   frontend control, select the world books through the product's own persisted selection, run the Tavern
   Helper script that writes chat/global/character variables and injects prompts, execute a **nested QR**
   that writes a variable the helper reads, let the character regex rewrite the previous reply, and send.
3. The recording peer captures exactly one POST whose body must contain, in one request and in order:
   preset markers (≥3), the global book's before/after/atDepth markers in pinned's order, the
   **character-book** marker, the **recursive-trigger** marker (only present because the secondary key
   matched), the three variable scopes, the helper `injectPrompts` marker, the QR/STscript marker, the
   author's-note marker, the regex-rewritten history text, and at least one marker contributed by a
   **third-party corpus extension** whose capability is `prompt-injection`.
4. Control turns in the same session that remove each knob (preset → default, world books deselected,
   helper off, regex disallowed) and prove the request bytes move (AGENTS 50); then reload → turn; restart →
   turn; hand-back to pinned Node.
5. Every step id, marker and capture digest written into the report; absent legs are REFUSED, not passed.

### 4.3 Exact files to extend, and exactly what must be added

**A. `tests/browser/extensions/combination-journey-kit.mjs` (fixture staging)**

- add `journeyCardDocument()` options so the card carries `data.character_book` with 3+ entries (one
  `secondary_keys`, one regex `key`, one constant), and stage the extra books beside the existing
  `stageJourneyWorldBook` (`combination-journey-kit.mjs:85-168`);
- add a `stageStressPreset(dir)` that writes the 120+ prompt preset into `default-user/OpenAI Settings/`
  (the journey already plants `preset-a` this way at `combination-journey-probe.mjs:783-790`);
- add the per-marker constants for the new books to `JOURNEY` (`:40-52`).

**B. `tools/build-longlived-corpus.mjs` (or a new `tools/alpha16/scenario-preset.mjs`)**

- emit the stress preset once, deterministically, and record it in the corpus schema. Current generated
  presets cap at 66 prompts (`:586`) and `preset-b` is 119 (`real-fixture-manifest.json:67`); the 120-prompt
  shape exists only in Go (`internal/longlivedfixture/longlivedfixture.go:339-345`) and must be reproduced
  on the JS side, or the schema gains an optional `interaction` block (plan §3) and the Go generator's shape
  is the contract. Prefer a generator, not a committed 1 MB file (`AGENTS.md` rule 56).

**C. `tests/browser/worldinfo-slots-kit.mjs`**

- generalise `buildWorldBook` (`:110-156`) to accept nested/recursive entries and to export a recursive
  marker; keep `extractLayout` the single reader of slot positions (`:210-247`).

**D. `tests/browser/combination-journey-probe.mjs`**

- install the 22 extensions in the pre-boot phase next to the existing helper install (`:786-803`), reusing
  `ensurePinnedExtensionInstalled` + `loadLock`/`shard` from `install-pinned-extension.mjs:108-161` and
  `third-party-extensions.mjs:146-149`; stage the stress preset instead of `preset-a` (`:783-790`);
- add steps: `stress-preset-selected` (structure ≥120 prompts), `character-book-marker-on-wire`,
  `recursive-trigger-marker-on-wire`, `nested-qr-wrote-variable`, `helper-read-the-qr-variable`,
  `corpus-extension-loaded` and `corpus-extension-marker-on-wire` (proves one of the 20 executed code, not
  that its manifest was served — see §4.4);
- extend `classifyCapture` (`:746-774`) with `books: {global, card, recursive, group}`, `qrChain`,
  `corpusExtensionMarkers`, and a `slotOrder` from `extractLayout`;
- extend `turn()`'s attribution (`:657-744`) only if a new non-user marker is needed; attribution by content
  is already correct.

**E. `tests/browser/compare-combination-journey.mjs`**

- add the new step names to the `observed()` list (`:103-136`) and add three structural guards:
  `nested-books-all-present-on-wire`, `recursive-trigger-fires-only-when-armed` (compare the armed turn to
  the control turn), `preset-stress-profile-has-120-prompts` (from the report's own fixture block);
- add the new markers to the capture-equality projection without canonicalising: the wire guard is already
  `sha256` of the raw body (`:83-101`), which is the correct contract (`AGENTS.md` differential doctrine 2).

**F. `tests/browser/combination-journey-gate-selftest.mjs`**

- add one mutation per new guard, each requiring the **target guard green in the unmutated pair first**
  (`:47-60`): drop the character-book marker, drop the recursive marker, move a world-info slot, drop the
  QR-chain variable, drop the corpus-extension marker, drop the 120th prompt from the recorded preset
  structure. Also repair the stale header (mutation 1 is documented as world-info but implemented as
  Quick Reply at `:62-64`; the world-info mutation is explicitly deferred at `:66-70`). Target: every guard
  the E03 claim rests on has one mutation, and the world-info slot guard is demonstrated on a pair where it
  is green first.

**G. `.github/workflows/combination-journey.yml`**

- add a seed step that materialises the 22 extension checkouts once (`GOTAVERN_EXTENSION_SEED_ROOT`), so the
  legs copy instead of fetching (§5 of this list is why); add the stress preset to the push path filter; add
  the extension lock to the push path filter; pass `--extensions <lock>`/`--preset <stress>` to the probe;
- consume the `failures` output (§3.3): add a step `if: steps.legs.outputs.failures != '0'` that exits 1;
- add a fixed-name `release-evidence.json` to the artifact (kind, headSha, pinnedSha, extension lock SHA-256,
  preset SHA-256, guard count, teeth count) so the manifest can later add `requiredEvidence` — proving the
  oracle leg, comparator and negative controls first (plan §8).

**H. `docs/release-manifest.json`** — only after G has been green at one SHA with teeth and an oracle leg:
add `requiredArtifact: combination-journey-evidence` and `requiredEvidence {kind, requireTruthy:["ok",
"comparatorTeeth.ok","extensionSetOk"], requireSha256:["extensionsLockSha256","presetSha256"]}`. Do not add
it before the assertion has been observed red.

**I. Reuse, not new frameworks.** Do not create a third fixture system: the session driver stays
`combination-journey-probe.mjs`; the extension installation stays `install-pinned-extension.mjs` + the lock;
the corpus stays the shared schema; the in-process recording peer stays
`q20-leg-runtime.startCapturePeer` (`:87`), extended only if a corpus extension needs a marker injected into
the reply (that is a peer script change, not a new peer).

### 4.4 Why the current harness could pass E04 without executing extension code

`extension-corpus-probe.mjs` sets `loaded` from the first successful request under
`/scripts/extensions/third-party/<name>/` (`:340-360`) and reports `{name, loaded, firstFailingUrl}` per
extension (`:653-660`, `:689`). `compare-extension-corpus.mjs` then asserts the expected set is present on
both subjects (`:93-100`), the API status/shape sets agree (`:218-220`), the final page state is equal
(`:288`) and there is no Go-only browser error (`:276`). None of those requires the extension's own
JavaScript to run, to register a slash command, to add a DOM node, or to alter a request. A GoTavern page
that serves every manifest and executes nothing would be equal to a stock page that also executed nothing —
so the differential is silent, and the run is green. The plan's own rule is stricter ("Evidence must show
that actual extension code executed, actual prompt markers reached provider wire and the intended
persistent mutation occurred", plan §8 line 128). The combination journey proves this for **Tavern Helper,
the QR API and the regex engine** (variables + injection + QR marker on the wire, `:1024-1030`); E04 must
add the same marker discipline for at least the prompt-injection-capable members of the 20.

### 4.5 Cost and order

1. Build the stress preset + nested books (generator + fixtures) — no browser.
2. Extend the cheap selftests first (comparator mutations against synthetic reports) — proves the new
   guards can fail before any expensive run.
3. One local/CI drive of the new scenario on GoTavern only, then both subjects; the oracle leg is the
   pinned drive + restart + hand-back, already wired (`combination-journey.yml:162-171`).
4. Estimate: the current five legs are ~5-7 min each (`combination-journey.yml:63-66`); adding 22 extension
   installs (one seed, copied) and a 120-prompt request adds minutes, not an hour. Keep the 60-minute
   backstop.

## 5. Baseline measurement plan

Goal (plan §M0 bullet 5, §M5; GOAL §11 M2): same-input before/after numbers with provenance, raw artifacts,
pprof and benchstat, and a gate that fails when the docs and the artifact disagree.

### 5.1 Matrix: measurement → existing capability → gap

| measurement | existing capability (read in this lane, or documented at the cited line) | gap | proposed run |
|---|---|---|---|
| cold boot / warm restart | `scripts/smoke-metrics.mjs:212-266` (cold asserted, warm not); `scripts/a15-bench-suite.mjs` `smoke`; `tests/perf/q22-paired-benchmark.mjs` boot | no p99; CI q22 does one pair of cold starts | keep `smoke-metrics` as the release record; run `a15-bench-suite --mode smoke --rounds 3` in a new scheduled job |
| 100 / 1,000 / 10,000 cards | `scripts/bench-profiles.mjs` in-process (`bench_test.go`); `a15-bench-suite` `scale`; `tests/perf/fixturegen` | no CI process-level run; docs mark workload B `missing` (`docs/perf-baseline.md:120`) | add `bench-profiles` process-level variants or run `a15-bench-suite --mode scale` in the bench workflow |
| large JSONL chats | `a15-bench-suite` `scale` (10×2 MB chats, 2,000-message JSONL); `bench-profiles` chat benchmarks | docs mark workload C `missing` for perf (`:121`) | same run as above; record p50/p95/p99 and RSS |
| 20-extension page load | `tests/browser/extension-overhead.mjs` (4 conditions, browser readiness + all-20 asset-load moment); `extension-corpus-run --mode soak` (RSS/p95) | runs only on `mode=full` dispatch/schedule (`third-party-extension-compat.yml:630-632`); no p99, no committed baseline artifact | schedule the overhead job weekly and commit a baseline wrapper (like `q22-baseline.json`) |
| 8-user concurrent writes | correctness only: `tests/e2e/a15_concurrent_writers_test.go` (two processes); `a15-bench-suite --mode concurrency` (32/128 in-flight on one route) | no multi-user (8 accounts) write load; no numbers | add `concurrency` mode over 8 per-user settings/chats saves with 32 in-flight; assert bytes + record p50/p95/p99, CPU, lock waits |
| provider assembly | `bench-profiles.mjs` (assemble/marshal benchmarks at largest recorded preset) | no streamed/cancelled assembly; no process-level TTFB | add a provider-wire latency mode to `a15-bench-suite` |
| 30-60 min soak | `extension-corpus-run --mode soak 30` (browser, both subjects); `a15-bench-suite --mode soak` (10 min); q22 10-min `/version` soak | no 30-60 min process soak with file changes / logins | add `--soak-minutes 45` to a scheduled job; keep RSS/p95 guard broad (3x) as the corpus comparator does |
| pprof CPU/heap/block/mutex | **exists for the in-process benchmark only**: `bench-profiles.mjs:431-463` captures all four + trace and writes `pprof-*-top.txt` | `docs/perf-baseline.md:111` calls it `missing` (stale, see E-H12); **no `/debug/pprof` in the product** (grep for `net/http/pprof|runtime/pprof` across `.go` outside vendor/node_modules = 0 hits), and `extension-corpus-probe.mjs` attempts `/debug/pprof/goroutine` and records `null` (`docs/perf-baseline.md:106`) | add a build-tag-gated (`pprof`) listener started only with `--profile-addr`, bound to 127.0.0.1, off by default and out of the release binary's default path; then capture CPU/heap/block/mutex + `go tool trace` from the running server in the bench job. Alternative if a listener is unacceptable: keep in-process pprof and state that server-process profiles are unavailable |
| benchstat | **none** (`docs/perf-baseline.md:110`; `bench-profiles.mjs` compares medians itself with tolerances) | no statistical aggregation across rounds | run `go test -bench . -count 5` and pipe to `benchstat` in the bench job; commit the benchstat output as the artifact and let the comparison gate read it |
| env provenance | `a15-bench-suite` `environment` (commit/branch/dirty, Go, Node, OS/arch/release, CPU model, cores, RAM, GOMAXPROCS, build flags, `--load-label`); `q22-baseline.json` `provenance`; `bench-profiles` `environment.txt` | CI bench artifact has no committed wrapper; Go toolchain/GOMAXPROCS named not measured in the release baseline (`docs/perf-baseline.md:37-40`) | extend `tools/record-perf-baseline.mjs` to wrap the bench artifact, or add a `benchstat`/`environment` wrapper and a `check-*` gate |

### 5.2 Which existing workflow produces the gate run, and what must be added

- **Existing:** `bench-profiles.yml` (`bench-profiles-linux-amd64`, 45 min, dispatch + weekly schedule) is
  the only workflow that captures profiles and a trace (`:88-111`), and `smoke-metrics.yml`
  (`measure-linux-amd64` + `paired-linux-amd64`) is the required release gate for performance.
- **Must be added to `bench-profiles.yml`:** (a) a `benchstat` multi-round job (or extend the script) with
  the output uploaded and compared; (b) a process-level job running `scripts/a15-bench-suite.mjs --mode
  scale,concurrency,assets,soak` against `tests/perf/fixturegen` trees; (c) a committed baseline wrapper
  (`tests/perf/bench-baseline.json`) plus a `tools/check-bench-docs.mjs`-style gate, mirroring
  `q22-baseline.json`/`check-perf-docs.mjs`; (d) the 8-user write load and the 20-extension page load as
  named rows in the same artifact; (e) env provenance asserted non-empty and host-identical between the
  baseline and the current run (the existing script already refuses a cross-host comparison,
  `bench-profiles.yml:10-18`).
- **Must be added to `docs/release-manifest.json` (later, after teeth):** if performance is to be a real
  release claim, `GoTavern bench profiles` becomes a gate with `requiredEvent: workflow_dispatch`,
  `requiredJobs`, `requiredArtifact: bench-profiles-evidence` and `requiredEvidence` requiring
  `headSha`, `hostFingerprint`, `benchstatRun` digests, and truthy `withinTolerance`. Until then the
  documented position (bench numbers are a report) stays truthful.
- **Threshold policy:** derive per-metric tolerances from run-to-run noise measured on the same runner, and
  record them before optimization (plan §M5). The existing `bench-profiles.mjs` already refuses a two-sided
  change beyond tolerance, including a large speedup (`bench-profiles.yml:10-18`), which is the right
  starting rule.

## 6. Hypotheses

Classification is exactly one of `confirmed-defect | verified-risk | untested-hypothesis |
intentional-parity | out-of-scope` (README §1.5). Strength 1-5 per README §3.

| id | title | class | surface | strength | summary + key evidence | falsifier / cheapest test |
|---|---|---|---|---|---|---|
| E-H1 | A narrowed `workflow_dispatch` satisfies 10/13 release gates | verified-risk | release state | 4 | the verifier reads only `head_sha/status/conclusion/event` (`release-governance/gates.mjs:142-153`) and queries no dispatch inputs; `ci.yml` narrows on `inputs.probes` (`ci.yml:124` → `plan.mjs:222-250`) and Browser differential narrows its whole surface set on `inputs.mode` (`browser-differential.yml:190-197,264`) — both stay green. The manifest claims the full selection (`release-manifest.json:4`). | a synthetic run pair cannot express the difference, so the test is: add a `selection` field to each gate's `release-evidence.json` and a `requiredEvidence` rail that asserts `all`/`full`; or drop the claim that dispatch means full. |
| E-H2 | The smoke-metrics release gate cannot fail on a performance regression | verified-risk | performance | 4 | its asserted properties are exactly 4 (`scripts/smoke-metrics.mjs:403-405`): cold start ≤60 s, finite numbers, pinned `/version` record, fresh-install files >0. The docs call the paired median "evidence for a report, not a release gate" (`docs/perf-baseline.md:66-68`) while the manifest requires it (`release-manifest.json:36-40`). No mutation case for any metric exists. | mutate a recorded metric ×2 and re-run the gate: still green. Then add a noise-derived tolerance and a failing test. |
| E-H3 | The combination-journey leg-failure counter is never consumed | verified-risk | harness | 3 | `record_failure` writes `failures=1` to `$GITHUB_OUTPUT` (`combination-journey.yml:142-145`), the step can still exit 0 (`:139,177`), and no step reads the output. Correct shape exists in the sibling (`whole-session.yml:232,304-310`). | a leg that exits non-zero after writing a syntactically valid report with all-step-ok: job stays green. Add the missing `if:` step. |
| E-H4 | The 20-extension corpus can pass without executing extension code | verified-risk | browser DOM/provider wire | 4 | `loaded` = first successful asset fetch under the extension prefix (`extension-corpus-probe.mjs:340-360`); the per-extension rows carry only `{name, loaded, firstFailingUrl}` (`:653-660`); the comparator guards are set/API/state/error equality (`compare-extension-corpus.mjs:85-139,218-220,276-288`). Plan §8 requires evidence that code executed. | a page that serves 20 manifests and runs none would pass; prove it by serving the assets from a static directory and asserting the corpus gate is still green — then add a per-extension behavioural marker. |
| E-H5 | 83 combination-journey guards, 5 demonstrated mutations, and the world-info-slot guard is explicitly undemonstrated | verified-risk | negative controls | 4 | `compare-combination-journey.mjs:103-111` lists 21 observed guards including the three-slot one; the selftest has 5 cases (`combination-journey-gate-selftest.mjs:62-92`) and says the world-info mutation "is already red in this pair because the pinned leg's pre-boot selection write did not survive the pinned boot" (`:66-70`). The file header's mutation list disagrees with the code (`:11-17` vs `:62`). | take one green pair and drop a world-info slot: if the guard fires, the teeth exist but were not recorded; if the guard is red on a green pair, the gate cannot be green at all — which is a release-blocking question. |
| E-H6 | There is no 120+ prompt preset on the browser side, so E03's stress profile cannot be met as specified | verified-risk | fixture/capability | 5 | `preset-a` = 105 prompts (`fixtures/real/real-fixture-manifest.json:36`), `preset-b` = 119 (`:67`); the browser corpus generates ≤66 (`tools/build-longlived-corpus.mjs:586`); the 120-prompt preset exists only in Go (`internal/longlivedfixture/longlivedfixture.go:339-345`). | count `prompts` in every committed preset and in the generated corpus: none ≥120. Build the generator (E03 step 1). |
| E-H7 | Nested/recursive world books are absent from the browser journey | verified-risk | provider wire | 5 | journey book is 3 global entries (`worldinfo-slots-kit.mjs:99-156`), the journey card has no `character_book` (`combination-journey-kit.mjs:85-129`), and the assertion is exactly three slots (`combination-journey-probe.mjs:1027`); secondary keys/recursion exist only in `card-a`'s 490 entries and the Go fixture (`longlivedfixture.go:312-318`). | stage a card with a character book and a recursive book, then assert their markers: today they cannot appear because the fixture does not carry them. |
| E-H8 | 10/13 same-SHA gates upload claims the release verifier never reads; the extension-compat artifact has no root head SHA | verified-risk | release state | 3 | only 3 gates name an artifact, 2 name `requiredEvidence` (`release-manifest.json:56-87`); the evidence table prints `-` (`verify-release-gates.mjs:108-112`); `third-party-extensions-aggregate.mjs:130-145` has no top-level `headSha` (only per-shard). Intentional per `release-manifest.json:4` — recorded so a reader is not surprised. | read the publish-time table for those gates: the claim is carried by exit status only. Add an evidence document to each gate that already produces a verdict. |
| E-H9 | The browser gates fetch extension pins from github.com at gate time; the seed path exists but no workflow populates it | verified-risk | hermeticity | 3 | `install-pinned-extension.mjs:147-161` fetches `origin <sha>` when no seed; `GOTAVERN_EXTENSION_SEED_ROOT` is set to the empty string only (`helper-state.yml:49`) and to nothing elsewhere (grep across workflows). The file's own header claims a local immutable mirror with "NO REQUEST LEAVES THE PROCESS" (`:74-81`). `source: 'remote'` is recorded, so the artifact can say so. | set the seed root from a cached checkout and assert `source: 'seed'`; today a GitHub outage is a red gate with no product meaning. |
| E-H10 | Committed browser evidence can be stale while the gate is green | verified-risk | release state | 3 | freshness is `continue-on-error: true` and prose-declared non-failing (`browser-differential.yml:2202-2250`); the scorecard cites runs whose own verdict was CANCELLED for their steps (`docs/goal-scorecard.md:60-66`). | read the freshness report of any green run: `stale > 0` is allowed. The release bar does not require `stale == 0`. |
| E-H11 | The Docker gate can be green at the tag SHA without the publish path being exercised | verified-risk | release state | 4 | dispatch default `push_image=false` publishes nothing (`docker.yml:168-217`); the release bar claims `:v…` and `:latest` published (`GOAL.md:565`). | a `workflow_dispatch` at the candidate SHA satisfies the manifest gate; publication happens only on a tag push, which the manifest cannot name as evidence for itself. |
| E-H12 | `docs/perf-baseline.md` says pprof capture is missing while the bench workflow captures it; server-process pprof is genuinely absent | verified-risk | performance | 4 | `docs/perf-baseline.md:111` vs `bench-profiles.mjs:3-12,431-463` and `bench-profiles.yml:88-111`; no `net/http/pprof`/`runtime/pprof` in the product (grep = 0 hits outside vendor) and the corpus probe records `null` (`docs/perf-baseline.md:106`). | run `bench-profiles` and observe the four `pprof-*-top.txt`; then correct the ledger row to `partial` and keep the server-process gap explicit. |
| E-H13 | 8-user concurrent-write performance has no harness | untested-hypothesis | performance | 3 | correctness only: two-process test (`tests/e2e/a15_concurrent_writers_test.go:1-30`); `a15-bench-suite --mode concurrency` is 32/128 in-flight on one route (`docs/perf-baseline.md:256`); workload E is `missing` (`:123`). | add the load and measure; until then the E06 concurrency claim is correctness, not cost. |
| E-H14 | The whole-session self-test header undercounts its own mutations | verified-risk | negative controls | 2 | header says "eleven mutations" and lists A–P (`whole-session-gate-selftest.mjs:1,16-39`); the array has 19 entries A–Q (`:89-255`). It cannot cause a false green (it claims less), but it is the same drift class as A15-05. | read the run summary line: `${applicable.length}/${applicable.length}` (e.g. 19/19), which contradicts the header. Fix the header. |

## 7. Questions this lane could not decide

1. **Whether the alpha.15 release actually ran the full selection.** The publish-time evidence table is in
   the published release body, not the tree. Deciding E-H1 empirically needs the run ids of the 13 gates at
   `v0.1.0-alpha.15` and their dispatch inputs, which are not in the runs API. Owner: Lead, from the release
   body — and the fix is a rail, not a reading.
2. **Whether `turn-1-world-info-three-slots-placed` is green on the current pair.** The selftest comment
   says the pinned leg's pre-boot selection write did not survive its boot. If that is still true, the
   combination-journey gate cannot be green and the E03 design's first step is a harness fix. Deciding
   needs one browser run of `combination-journey-probe.mjs` on both subjects (not allowed in M0). Owner:
   Lane E in M1, or whoever runs the next dispatch.
3. **Which of the 20 corpus extensions can contribute a provider-wire marker.** The capability vocabulary
   (`third-party-extensions.mjs:29-34`) says which are `prompt-injection`/`generation`, but whether any of
   them injects a *deterministic, marker-bearing* prompt through the pinned API must be read from their
   pinned source, which is not in this checkout. Owner: M1 scenario factory, against the pinned commits.
4. **Whether a build-tag-gated pprof listener is acceptable to the product.** `CGO_ENABLED=0` allows it, but
   an always-on listener is a security surface; the decision (default off, `--profile-addr`, 127.0.0.1 only)
   is a product decision for the Lead, not an audit fact.
5. **The real cost of the combined scenario.** The current five legs are measured at ~5-7 min each in the
   workflow comment (`combination-journey.yml:63-66`); the 22-extension install and the 120-prompt assembly
   add unknown minutes. Only a run decides it; the 60-minute backstop stays until measured.
