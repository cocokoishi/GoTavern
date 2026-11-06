# alpha.16 handoff ledger (plan section 9.E)

**Status: alpha.16 is IN PROGRESS, not SHIPPED. No alpha.16 tag has been created or moved.** This ledger is
documentation only: no workflow was dispatched, no product/test/fixture/config file was changed, and no git
operation was run by the task that wrote it. Tree read: `9f6a76e` (`lane/alpha16-program`, 2026-11-06);
program base `c256f21`. Pinned oracle: SillyTavern `1.19.0` @ `0`
(`upstream/SILLYTAVERN_COMMIT`; `docs/alpha16/README.md:4`).

It is built from the committed program documents: `docs/alpha16-agent-execution-plan.md`,
`docs/alpha16/README.md`, `docs/alpha16/source-audit.md`, `docs/alpha16/ownership-map.json`,
`docs/alpha16/source-graph.json`, `docs/alpha16/baseline/README.md`, `docs/alpha16/first-scenario-design.md`,
`docs/alpha16/m4-refactor-decisions.md`, `docs/alpha16/m5-measurement-plan.md`,
`docs/alpha16/m5-evidence.md`, `docs/alpha16/m6-release-bar.md`, `docs/release-manifest.json`, and the git
history that records the fix commits and their red-first evidence. It applies the plan's own handoff
requirement (`docs/alpha16-agent-execution-plan.md:143`): for each changed area, the original `file:line`,
the observed red, the root cause, the patch, the green run, parity impact, data-safety result, benchmark in
both directions and residual limits.

## 0. Run-id integrity rule (read this before quoting any id below)

Every run id is quoted **together with its workflow name and its conclusion** (`AGENTS.md` rule 55). Ids are
taken from the committed documents or git history named beside them. Two groups are **not yet recorded in the
tree** and are therefore marked REPORTED / PENDING rather than given a verdict:

- the M2 full-tier green `42234426258` (reported in the handoff brief; no committed document or commit
  message carries it at `9f6a76e`), and
- the thirteen M6 rehearsal dispatch ids `42237652240`..`42237711904` (reported in the handoff brief for
  candidate `9f6a76e`; no committed document carries them at this tree).

A PENDING row is not a green, not a red and not a claim: it says "dispatched per the brief, verdict not yet in
the durable record". **Convention:** a run id that appears inside a reproduce command or a same-SHA-status
table is a cross-reference to the row that states its workflow and conclusion; a run id introduced as evidence
always carries both here. The command that turns a PENDING row into evidence is in section 6.4. When this ledger
and a later evidence document disagree, the evidence document with the artifact wins.

**Working-tree drift observed at this ledger's write time (not committed, not authored by this ledger).** The
committed tree described below is `9f6a76e`; concurrently, two files sit uncommitted in the working tree as part
of the next alpha.16 step: `scripts/classify-version-tag.sh` + `scripts/test-classify-version-tag.sh` (adding
`v0.1.0-alpha.16` to the equality list - the resolution of section 7 item 6) and
`docs/release-notes-v0.1.0-alpha.16.md` (a drafted release note - the resolution of section 7 item 2). They are
invisible to the release verifier and to every run cited here until committed. If they land, items 2 and 6 of
section 7 close and the same-SHA release record must cite their commit; this ledger must not be read as saying
those files are absent from the programme, only from the committed tree it reads.

---

## 1. Program summary, scope, and the synthetic limitation (stated first)

**What alpha.16 is.** An evidence-driven qualification program for GoTavern, the release-grade drop-in
replacement for the SillyTavern server/backend. The program's one sentence is `GOAL.md` section 3: for a given
character, chat, world book, preset, helper script, variable state and user input, the final request that
reaches the model backend, and the persisted and browser state afterwards, must be equal between pinned Node
SillyTavern and GoTavern (`GOAL.md:96-104`). The plan's invariants keep the unmodified pinned frontend, the
same `config.yaml`/`data/` layout, unknown-field preservation, migration and hand-back, and the same provider
wire (`docs/alpha16-agent-execution-plan.md:9-14`).

**The oracle is one pinned commit, and nothing else.** Evidence precedence is an observation of pinned
running, then pinned source at `06bde939…`, then a recorded fixture, then a source-derived test, then labelled
inference (`GOAL.md:106-119`). Program-tree runs, fixtures and the Node stock-tree round trip all descend from
that one commit; current upstream, memory of SillyTavern and "how Go normally does it" are forbidden bases
(`GOAL.md:118-119`).

**The synthetic limitation, up front.** Every environment this program built is **synthetic and agent-built**:
generated cards, derivations of real presets, a marker-answering provider peer, synthetic multi-user trees.
That is enough for a **synthetic adversarial qualification with precise scope**; it is **not** the
`GOAL.md` section 14 strong drop-in bar, which remains **NOT MET** ("Current state, dated 2026-11-05
(`v0.1.0-alpha.15`): NOT MET for the strong form", `GOAL.md:452`; repeated at
`docs/alpha16-agent-execution-plan.md:131` and `docs/alpha16/m6-release-bar.md:436-445`). The closer for that
bar is a separately authorised real private tree and its byte census, which no synthetic environment supplies
(`docs/alpha16/source-audit.md:236`). Any alpha.16 release note that omits this is a claim ahead of evidence
(rule 36). **The honest claim ceiling for alpha.16 is therefore: a synthetic adversarial qualification was
executed and evidenced; universal drop-in parity was not proven and was not attempted.**

**Program shape.** M0 read-only audit, M1 scenario-factory schema, M2 E03+E04 interacting-scenario
qualification, M3 differential/mutation evidence, M4 refactor decisions (all refused), M5 performance evidence,
M6 release-bar preparation and rehearsal. The program base is `c256f21`; the current candidate is `9f6a76e`
(the commit the M6 rehearsal was dispatched at). The audit census at M0/M0b is: 603 Go files parsed, **296
production**, **106 deep-read**, **236 named by a lane**, and **0 unnamed product-logic files** after the M0b
family pass (`docs/alpha16/source-audit.md:18-49`); **72 hypotheses** (5 confirmed-defect, 37 verified-risk, 15
untested-hypothesis, 13 intentional-parity, 2 out-of-scope), **67 writer rows**, **66 concurrency entries**, **33
cache rows**, **45 request-path stages** (`docs/alpha16/source-audit.md:24-28`;
`docs/alpha16/ownership-map.json`).

**Current state.** Source audit complete; M1-M6 artefacts committed; five M0 findings closed by minimal fixes;
one confirmed defect (D-H1) and several bounded risks remain open; M5 evidence recorded but not ratified; M6
rehearsal dispatched but its verdicts are not yet in the tree; no release notes, checksums, dry run, macOS
ARM64 resolution or tag exist. The acceptance rule is explicit: until the plan section 9.E preconditions hold,
the status is **IN PROGRESS, not SHIPPED** (`docs/alpha16-agent-execution-plan.md:145`).

---

## 2. Milestone ledger M0-M6

### 2.1 Milestone table

| # | Milestone | Artefacts produced (committed) | Key evidence (workflow + run + conclusion) | Fixed here | Refused / left open |
|---|---|---|---|---|---|
| **M0** | Read-only source/ownership/behaviour audit, baseline, first-scenario design | `docs/alpha16/README.md`; `source-audit.md`; `ownership-map.json`; `source-graph.json`; `audit/a-request-path.md` + fragments `a`-`e` + `lead.json`; `baseline/README.md`; `first-scenario-design.md` | `GoTavern Lane CI` **42160006720** success at `c8472c1`; `GoTavern CI` **42159888005** success at `26aaa33`; `GoTavern Lane CI` **42159064025** failure at `c256f21` (the plan document's own pin citation, i.e. the gate working); **the baseline bench run is red and is finding L-H1**: `GoTavern bench profiles` **42160109620** failure; product record `GoTavern smoke metrics` **42160114658** success (`docs/alpha16/source-audit.md:158-172`; `docs/alpha16/baseline/README.md:95-120`) | nothing in M0 (read-only); the red M0 bench record became finding L-H1 | M0 fixed nothing by rule (`docs/alpha16/README.md:20-23`) |
| **M1** | Scenario-recipe schema half of the factory: optional `scenario` block in both corpora, named refusals, determinism and drift teeth, E02 prototype | corpus schema changes in `internal/longlivedfixture/scenario.go`, `tests/e2e/longlived_schema_test.go`, `tools/longlived/corpus-schema.mjs`, `tools/build-longlived-corpus.mjs` (commit `86df528`) | **No run id recorded in the tree.** The commit records LOCAL triage and states "CI is the verdict" (commit `86df528`); E03+E04 ingredients were committed separately (`71dd7b8`) and probe wiring is M2 | corpus schema/verifier/teeth | **EVIDENCE GAP: M1 has no recorded CI run id**; treat as unverified for release evidence until a Linux run id is committed |
| **M2** | E03+E04 interacting-scenario harness: deterministic 120-block preset + 3 nested books, 22-extension install batch, five browser legs, comparator + artifact identity, tier wiring | `tests/browser/combination-journey-probe.mjs`, `compare-combination-journey.mjs`, `extensions/e03e04-profile-kit.mjs`, `extensions/extension-install-batch.mjs`, `combination-journey-gate-selftest.mjs`, `.github/workflows/combination-journey.yml`; `first-scenario-design.md` | fast tier `Combination journey differential` **42184268652** **match** (recorded in commit `5262039`; `docs/alpha16/m6-release-bar.md:339`). Full tier history: **42186322374** failure, **42193009501** failure, **42198916430** failure (each a named harness defect; `docs/alpha16/m6-release-bar.md:340-343`) and later dispatches `42203249658`, `42207738114`, `42226736120`, `42230495689` recorded in commits `9be10f4`, `2e36302`, `924d71a`, `6936291`. Reported final full-tier **match** `42234426258` - **REPORTED, durable record PENDING** (section 4) | twelve test/workflow-only commits (`71dd7b8`, `0b3021b`, `375dc8e`, `6332ef2`, `f22cd1b`, `5262039`, `0b577de`, `d5e84e5`, `9be10f4`, `2e36302`, `924d71a`, `6936291`; per-commit check: nothing outside `tests/browser/**` and `.github/workflows/combination-journey.yml`); no product code changed | no product defect was found by the full-tier journey; the harness defects are named and fixed; page-init egress prerequisite still open |
| **M3** | Differential/mutation evidence: four provider-wire scenarios that discriminate D-H3 and D-H2, re-recorded on Linux with the derived docs regenerated; adversarial ratchet port-race rework; soak-gate teeth | `tests/oracle/sillytavern-1.19.0-provider-wire.json` (258 -> 262 scenarios), four `tests/provider-wire/scenarios/*.json`, `docs/config-parity.md` + `tools/inventories/config-parity.json`; `internal/adversarial/*` (commit `98400d6`); `.github/workflows/m5-measurements.yml` soak verdict (commit `9f6a76e`) | `GoTavern CI` **42187779109** workflow_dispatch, narrowed `probes=probe-provider-wire.mjs`, failure only at the intended "Verify generated results are committed" step; the re-record closed it with zero changes to the 258 existing captures (commit `fa5385f`). Ratchet: `GoTavern Lane CI` **42162940621** failure (flake), same code **42163485576** success, then test-only rework `98400d6` (four consecutive local runs green). Soak teeth: synthetic leak fails by name, synthetic flat sawtooth passes (local validation, `docs/alpha16/m5-evidence.md:346-358`) | ratchet harness defect fixed test-only; soak statistic corrected (a measurement-methodology defect in a gate the program authored) | no exhaustive chaos/fault-injection campaign was executed; ENOSPC remains unproven (`docs/alpha16/source-audit.md:235`); streaming-cancel performance evidence absent (section 5) |
| **M4** | Evidence-based refactor decisions for plan section 6 R1-R6 | `docs/alpha16/m4-refactor-decisions.md` | **No run**: a documentation decision. Evidence base = the M0 union (`ownership-map.json`, base `c8472c1`) plus the lane reports; the doc's 104 file:line citations were range-checked (`m4-refactor-decisions.md:457-468`) | nothing (decision only) | **R1-R6 all REFUSED** with per-candidate evidence and bounded alternatives (`m4-refactor-decisions.md:49-62`) |
| **M5** | Performance evidence: row contract, thresholds recorded before optimization, both-direction reporting, the two new rows (8-user, soak), an evidence document from downloaded artifacts | `docs/alpha16/m5-measurement-plan.md`; `docs/alpha16/m5-evidence.md`; `tests/perf/m5-eight-users.mjs`; `.github/workflows/m5-measurements.yml` (commits `521ec8c`, `6077405`, `2b87703`, `9f6a76e`) | `GoTavern bench profiles` **42200357353** success; `GoTavern smoke metrics` **42200361137** success; `M5 measurements` 8-user BEFORE **42212715040** success; soak **42209244735** failure and **42226780977** failure under the retired LS rule (both flat under the corrected per-thirds rule) - each workflow+run+conclusion in `docs/alpha16/m5-evidence.md:16-24`. L-H1 closure: **42164978648** regenerate -> **42165562517** green comparison (`docs/alpha16/baseline/README.md:182-186`) | L-H1 closed by deliberate regeneration; the soak statistic corrected (M5b) | **no provisional row is ratified** (`m5-evidence.md:444-451`); 8-user AFTER pending; soak NOT RATIFIED; gaps in section 5.4 |
| **M6** | Release bar: the 13-gate reconstruction, the fail-closed verifier contract, the combination-gate conditions, the rails for gate #10, and the candidate rehearsal | `docs/alpha16/m6-release-bar.md`; `docs/release-manifest.json` gate #10 rails (commit `27bf5f0`); `.github/workflows/combination-journey.yml` evidence + SHA-pinned verifier (commit `27bf5f0`); candidate `9f6a76e` | **Thirteen rehearsal dispatches at `9f6a76e`, ids in section 6.2, all PENDING (verdicts not in the tree at this write)**; the verifier command/expected output and the gate-#10 rails in section 6 | combination-gate rails implemented (M6b, refusal-only: it cannot manufacture a green) | release conclusion IN PROGRESS (section 7); gate #6 evidence rails still missing; macOS ARM64 unresolved |

### 2.2 What each milestone's evidence can and cannot carry

- **M0's runs are program-tree evidence, not release evidence.** `source-audit.md` records why: the drop-in and
  node-stock-tree runs are docs-only-tree successes whose event/rails are not release evidence, and no run is a
  release dispatch at HEAD (`docs/alpha16/source-audit.md:168-172`; `docs/alpha16/m6-release-bar.md:125-136`).
- **M1 is the one milestone whose code change has no recorded run id** (M4 has no run by design: it is a
  decision whose evidence base is the M0 union). The gap is recorded here rather than implied; M1's gate is the
  Linux CI run that must be cited before M1 is called release evidence.
- **M2 harness history is long on purpose.** Seven full-tier dispatches found only harness defects; each was
  fixed at its cause and each fix carries its run id (section 4.1). No product difference was found by the
  journey.
- **M3's oracle re-record is the gate-first pattern working**: the four scenarios were added first (red), then
  recorded, with a semantic diff proving exactly four additions and zero changes to 258 existing captures
  (commit `fa5385f`).
- **M4 is a decision, not a change.** The program's own preference (refuse unless the audit proves a defect) is
  satisfied; no product code moved for R1-R6.
- **M5's numbers are a summary of artifacts.** The artifacts are the record and are retained 30 days
  (`docs/alpha16/m5-evidence.md:526-531`).

---

## 3. The five strongest M0 findings and their current state

The M0 ranking is fixed by `docs/alpha16/source-audit.md:174-192` (full rows in
`docs/alpha16/audit/lead.json` -> `fiveStrongest`). State below is **at `9f6a76e`**, not the M0 snapshot; the
fix commits and their red-first evidence are in section 3.2.

### 3.1 State table

| rank | id | class | finding (M0) | state at `9f6a76e` | evidence |
|---|---|---|---|---|---|
| 1 | **D-H3** | confirmed-defect, provider-wire | `claude.enableAdaptiveThinking` had no Go reader while the shipped default is `false`, so a stock install with claude-opus-4-6/sonnet-4-6 sent a different `thinking` payload than pinned | **FIXED by minimal change** (commit `60454bc`), with the discriminating oracle pair now recorded | `source-audit.md:182`; `m4-refactor-decisions.md:360`; fixture `tests/oracle/sillytavern-1.19.0-provider-wire.json:7795,7994` |
| 2 | **D-H1** | confirmed-defect, provider-wire | chat-path config readers derive `config.yaml` from the data root and its parent, so `--configPath` (and a non-adjacent `--dataRoot`) silently default every provider-visible key | **OPEN - no fix commit.** The bounded follow-up is to thread the resolved config path into the readers; the defect was not fixed in this program | `source-audit.md:183`; `internal/server/pinned_chat_config.go:35-45`; `m4-refactor-decisions.md:105-135` |
| 3 | **D-H2** | confirmed-defect, provider-wire | `gemini.apiVersion` was never read by the MAKERSUITE chat route or its status arm; `docs/config-parity.md` claimed it implemented | **FIXED by minimal change** (commit `1a7b914`), with generate+status scenarios recorded and config-parity regenerated | `source-audit.md:184`; `m4-refactor-decisions.md:361`; fixtures `...provider-wire.json:22219,22400` |
| 4 | **B-H3** | verified-risk, persisted-bytes | `gotavern migrate --force` backed up only `config.yaml` and `data/`; pre-existing `certs/` and the global extension overlay were overwritten in place | **FIXED by minimal change** (commit `7f91192`) with three red-first tests | `source-audit.md:185`; `m4-refactor-decisions.md:362`; `internal/migrate/migrate_test.go:645,743` |
| 5 | **L-H1** | confirmed-defect, performance | the committed benchmark baseline predated the alpha.15 card cache, so the M2/M5 bench gate was red at the program base on unchanged product code | **CLOSED as an evidence-machinery defect** by deliberate regeneration and a green comparison (runs below); the cold-guard row and the 30-60 min soak remain open | `source-audit.md:186`; `docs/alpha16/baseline/README.md:174-197` |

Beyond the five, the M0 map also carries the named follow-ups in section 8 (`C-H6`, `C-H1`, `A-H3`, `A-H1`,
`B-H4`, `E-H1`/`E-H2`, `L-H4`, `D-H4`/`D-H5`/`D-H6`/`D-H17`/`D-H18`; `source-audit.md:188-192`).

### 3.2 The minimal fixes: red first, then patch, then gate

Each row is a **minimal fix with its own failing gate**, not a refactor (M4 selected none; section 3.3). Every
patch is 21-35 changed lines in one product file, plus tests/fixtures/CI. The original `file:line`, the
observed red, root cause, patch and parity impact are recorded in `docs/alpha16/m4-refactor-decisions.md:352-365`
and repeated here with the run evidence that exists.

| id | original file:line | observed red (red FIRST) | root cause | exact patch | green / closing evidence | parity impact | data safety | benchmark both directions |
|---|---|---|---|---|---|---|---|---|
| **D-H3** | `internal/server/claude_chat.go:119-121` (M0) hardcoded the `true` branch; pinned read is `chat-completions.js:112`, used `:260` | detached-worktree reproduction at `ef41eec`: `TestChatCompletionClaudeAdaptiveThinkingFollowsTheConfig` failed 4 subtests (`thinking {"type":"adaptive"}` sent; want `{"type":"enabled","budget_tokens":1024}`); operator-true control passed | no Go reader for the config key; shipped default is false (`default/config.yaml:376`) | commit `60454bc`: `pinnedClaudeAdaptiveThinking` (`internal/server/claude_chat.go:570`) gates ONLY the 4-6 clause; base adaptive/fable/claude5 unchanged | test green 6/6; broad provider set and `go test ./internal/server -count=1` green locally (CI is the gate); oracle pair recorded in `...provider-wire.json:7795,7994` (commits `dbd32aa`, `fa5385f`) | stock install now matches pinned's provider-visible `thinking` payload for 4-6 models | none (no persisted bytes) | no performance claim; bodySha256 is the observable |
| **D-H2** | `internal/server/google_chat.go:67-68` (M0) returned the default constant; pinned read at `chat-completions.js:679,730,1911` | detached-worktree at `ef41eec`: `TestGoogleChatAPIVersionFollowsTheConfig` failed with `/v1beta/...` target, want `/v1/...`, for generate AND status, config and env cases | no reader; docs claimed implemented | commit `1a7b914`: `pinnedGoogleAPIVersion` (`internal/server/google_chat.go:75`) through the same `pinned_chat_config` path; both URL builders take it; VERTEXAI untouched | 3x2 cases pass; `docs/config-parity.md` regenerated from `tools/inventories/config-parity.json`; scenarios `...provider-wire.json:22219,22400` | operator `gemini.apiVersion`/`SILLYTAVERN_GEMINI_APIVERSION` now reaches the provider URL; parity doc agrees with code | none | no performance claim |
| **B-H3** | `internal/migrate/migrate.go:432-436,191-209` (M0) conflict set `{config.yaml, data/}`; `copyFile` used `O_TRUNC` | `TestForcedMigrationMovesDestinationCertsAndOverlayIntoTheBackup` (`internal/migrate/migrate_test.go:645`) and `TestMigrationRefusesDestinationCertsAndOverlayWithoutForce` (`:743`) failed pre-fix: destination bytes replaced, no `.migrate-backup` | the replaced-path set omitted the two conditional copies | commit `7f91192`: the replaced-path set is every path the run replaces (`internal/migrate/migrate.go:441-458`), so `--force` moves them aside; the dry-run plan names the same set; nested overlay rename creates parents | three tests red-first then green; `go test ./internal/migrate -count=1` 13 PASS / 1 SKIP; `docs/INSTALLATION.md` updated | product command now honours "existing user data wins" (AGENTS rule 28) | **fixed a silent overwrite of user-owned bytes** | none |
| **L-H1** | `tests/perf/bench-baseline.txt` at `ed75eee` (2026-11-03), predating the card cache `cc72384` (2026-11-05) | `GoTavern bench profiles` **42160109620** failure: eight comparisons out of tolerance (-46.8% to -84.3% ns/op, B/op -78.4%), B/op being host-independent proof it was not noise (`docs/alpha16/baseline/README.md:95-120`) | a committed gate input predated an accepted product change; `47da1de`'s "no scheduled gate is left red" was false | CI gains explicit `update_baseline` dispatch input (`05479fa`); baseline regenerated on the Linux host with its raw run and committed (`39cec62`); no code change | `GoTavern bench profiles` **42164978648** success (regeneration) -> **42165562517** success, `comparison: passed`, `failures: 0`, all 31 benchmarks within -8.1%..+1.6% (`docs/alpha16/baseline/README.md:182-186`) | no product change; the gate now describes the tree it names | none | the accepted card-cache win is IN the baseline: `cards_100_640KB_image` B/op 181,622,014 -> 41,035,550 (-77.4%), ns/op 97,246,124 -> 27,743,964 (-71.5%) (`baseline/README.md:185`); the cold-request half is NOT in any artifact (section 5.4) |
| **adversarial ratchet** (beyond the five; recorded because it is a fixed M0-observed flake) | `internal/adversarial/startup_cases_test.go` judge + port reservation (M0 tree) | `GoTavern Lane CI` **42162940621** failure: `TestAdversarialInvariants` listener-in-use; same code **42163485576** success | the harness reserved a port before handing it to the product, and the judge blamed the product for a listener precondition | commit `98400d6` (test-only): `freePort` returns 0 so the kernel assigns at bind (`internal/adversarial/support_test.go:55`); `judgeRelativeDataRootFailure` judges the data-root invariant first (`startup_cases_test.go:568`); five new tests | local `go test ./internal/adversarial -count=1`: 35 cases / 29 held / 0 violated / 6 n/a, four consecutive runs green (commit message) | no product change; a real split under a forced collision is still red | none | none |

### 3.3 What was deliberately not refactored (M4)

`docs/alpha16/m4-refactor-decisions.md:49-62` refuses **all six** plan section 6 candidates with the evidence
for and against each: R1 configuration composition, R2 runtime lifecycle, R3 persistence consistency, R4
extension execution/isolation, R5 cache framework, R6 domain split. The rule was: implement only if a named
red test or capture demonstrates a defect whose cause is the boundary being moved; none did. The
actionable residue was routed to bounded fixes (D-H1 threading; C-H6/C-H7/C-H1/C-H8; B-H4 probe; A-H1/A-H2/
A-H3/A-H5 probes; C-H11 per-cache witness; D-H17 atomic write) and is carried in section 8. The M0
dispositions were `DECLINE`/`HOLD` (`source-audit.md:194-209`); M4 resolved the two HOLDs to REFUSE because
the pending Lane C evidence arrived and removed their premises (`m4-refactor-decisions.md:186-192,209-220`).

---

## 4. M2 qualification state (the E03+E04 interacting scenario)

### 4.1 Tier state and dispatch history

The scenario is the `profile=e03e04` form of `.github/workflows/combination-journey.yml`: one browser session,
both subjects, a deterministic 120-block preset, three nested world books, 22 pinned extensions, helper + QR +
regex + variables + group + restart + hand-back, and byte-oriented comparison per capture
(`docs/alpha16/first-scenario-design.md:20-32,73-96`). Only the **full** tier (120 blocks / 22 extensions / all
three books) is release-admissible; fast (12/3) and medium (60/10) are explicitly narrowed
(`docs/alpha16/first-scenario-design.md:119-132`; `docs/alpha16/m6-release-bar.md:392-403`).

| dispatch | workflow + run | conclusion | what it established |
|---|---|---|---|
| fast tier | `Combination journey differential` **42184268652** | **match** | **PROVEN for the fast tier**: ordered markers reach the provider body; 12 blocks, 3 extensions, all three books (`docs/alpha16/m6-release-bar.md:339`; recorded in commit `5262039`) |
| full attempt 1 | `Combination journey differential` **42186322374** | failure | symmetric failure on BOTH subjects; verdict not produced; `narrative-agent` prompt takeover was the cause (commit `5262039`) |
| full attempt 2 | `Combination journey differential` **42193009501** | failure | `extensionTakeover {detected:true, narrative-agent, disabled:true, intact:true}`; embedded book bound; the new send-blocking-overlay guard was red on both because ST-Copilot's changelog overlay covered `#send_but` (commit `0b577de`; `m6-release-bar.md:341`) |
| full attempt 3 | `Combination journey differential` **42198916430** | failure | the first overlay was dismissed, a second layered overlay (`rpg-deprecation-modal`) was not; hit-test-authoritative dismissal implemented (commit `d5e84e5`, M2g; `m6-release-bar.md:342`) |
| full attempt 4 | `Combination journey differential` **42203249658** | failure (M2h context) | after overlay fix: both subjects dismissed four layers, turn-1 request captured, GoTavern leg 85 steps, all preset/world/variable/QR/AN markers green; two remaining failures (commit `9be10f4`) |
| full attempt 5 | `Combination journey differential` **42207738114** | failure (M2j context) | journey still captured the extension's quiet generation as the user turn; root cause named and fixed (commit `2e36302`) |
| full attempt 6 | `Combination journey differential` **42226736120** | failure (M2k context) | journey otherwise green: five legs, zero leg failures, all ten capture pairs byte-equal, nodeEqualsGo per capture, all listed guards green; one group-chat guard failed (commit `924d71a`) |
| full attempt 7 | `Combination journey differential` **42230495689** | failure (M2l context) | group fan-out quiesced; one remaining failed guard on the chat projection (commit `6936291`) |
| **full green (reported)** | `Combination journey differential` **42234426258** | **REPORTED match** (handoff brief) | reported evidence ok, teeth 49/49, kit ok, five legs. **Durable record PENDING**: no committed document or git commit at `9f6a76e` carries this id or its artifact (`git log --all --grep=42234426258` is empty). Until the evidence document is committed, the M2 full-tier state is **REPORTED, not yet a recorded green** |

The red history is not a product finding: each attempt's root cause was a harness defect at the harness's own
cause (overlay handling, extension-generated quiet request attribution, group fan-out timing, branch metadata
persistence). The run ids above are the record that the fixes were driven by observed reds, not by preference.

### 4.2 Evidence rails for the gate (M6b), so a green can carry a release claim

Gate #10 is in the manifest (`docs/release-manifest.json:52-64`): `requiredJobs: ["combination-journey"]`,
`requiredArtifact: "combination-journey-evidence"`, and `requiredEvidence { kind:
"combination-journey-evidence", tierField: "tier", tier: "full", requireTruthy: [interactingScenario, ok,
legs.allRecorded, teeth.ok, kit.ok], requireSha256: five document digests }`. Commit `27bf5f0` (M6b)
implements the conditions the M6 document named (C2-C10):

- **root evidence**: for `profile=e03e04` the workflow always writes `release-evidence.json` at the artifact
  root (kind/schemaVersion/headSha/pinnedSha/profile/interactingScenario/tier/seed/extensionTier/run/verdict/
  guard counts/five leg digests/legs.allRecorded/teeth/kit/ok), uploaded inside the fixed-name artifact
  `combination-journey-evidence`;
- **legacy-vs-e03e04 separation**: the legacy `profile=none` path neither writes nor uploads the document, so
  its artifact stays byte-identical; a legacy run therefore yields `missing-evidence` and cannot satisfy the
  rail even if it reached the artifact (C3);
- **SHA pinned**: the in-workflow verifier re-derives the five leg digests and asserts `headSha === $GITHUB_SHA`,
  with SEVEN planted cases run on every e03e04 dispatch (accepts the correct document; refuses a well-formed
  wrong SHA, a malformed SHA, profile=none, fast tier, ok:false and missing digests) (C5);
- **concurrency**: `cancel-in-progress` is true only for the legacy/push run and false for evidence runs, so a
  qualification dispatch cannot be cancelled by a later push (C6);
- **tier ladder documented** (fast/medium narrowed; full release-admissible; no scheduled trigger) (C7) and the
  kit selftest is now executed in-workflow with its log shipped and `kit.ok` feeding the rail (C9).

These rails are **refusal-only**: they cannot manufacture a green, and at the time of the M6b commit the full
tier had never been green (commit `27bf5f0`). The reported 42234426258 would be the first test of the rails.

### 4.3 Disclosed harness decisions (installed-but-configured-off, overlays, save-timing)

These are recorded because they change what the journey measures, and because the alternative (a harness that
silently ignores a takeover) would prove nothing (`docs/alpha16/m6-release-bar.md:314-331`):

1. **`narrative-agent` installed but configured off after wire-proof.** In the full tier the extension hooks
   the prompt-ready event and replaces the chat with its own relay prompt; both subjects behaved identically.
   The journey records the takeover (`extensionTakeover {detected:true, narrative-agent, disabled:true,
   intact:true}`) and disables it through its own settings, keeping the 22-extension install count intact
   (commit `5262039`; `m6-release-bar.md:340-341,325-326`).
2. **`st-stepped-thinking` installed but configured off after a local wire-proof.** It starts a QUIET
   generation per configured thinking prompt, and the probe had been capturing that quiet request as the user
   turn; the quiet body was byte-identical to the CI capture on both subjects (sha `4564c5bc...`). The fix
   records source evidence and disables it through the extension's OWN setting control `#stepthink_is_enabled`
   (`tests/browser/combination-journey-probe.mjs:2143-2192`), records `installed/before/disabled/after/via`, and
   adds the guard `quiet-generation-extension-handled` (`:2439`) plus a generation-event trail and
   streaming-normal request attribution (commit `2e36302`, M2j).
3. **Overlay dismissal (two commits, two classes of defect).** M2f dismissed ST-Copilot's startup changelog
   through its own control (`0b577de`); M2g replaced class/role heuristics with hit-test-authoritative
   discovery (the element painted at the send button and its ancestors are blocking by construction), a
   scored control chooser, a six-round budget and a named undismissable refusal (commit `d5e84e5`). Both
   subjects showed three stacked startup layers, so the defect was the harness's, not the product's.
4. **Save-timing determinism.** The group turn must wait for the full fan-out to quiesce before persisting and
   reading (`924d71a`, M2k), and the branch metadata must be persisted before the reload so the durable chat
   projection is deterministic (`6936291`, M2l); the guards are `group-chat-persisted-parity` and the
   chat-projection guard (`m6-release-bar.md:338`).
5. **Disclosed limitation:** these configure-off decisions mean the full tier proves the 22-extension
   *coexistence* plus the documented extension effects, not that every installed extension's takeover is
   exercised by the journey. That is why the tier statement and the journey's `no-wire-effect` records are part
   of the artifact (`first-scenario-design.md:87-91,134-141`).

### 4.4 M2 open prerequisites (a full-tier green alone is not the whole claim)

- **Page-init egress is STILL OPEN.** The scenario's hermeticity prerequisite (stage `main_api` + an egress
  allowlist asserted per probe) is recorded as open in the baseline and M6b did not change browser egress
  (`docs/alpha16/first-scenario-design.md:143-151`; `docs/alpha16/source-audit.md:233`; commit `27bf5f0` did
  not change browser egress). A full-tier release dispatch
  inherits this open prerequisite and it must be reported beside the gate, not hidden by it.
- The kit's selftest previously existed without an execution step; M6b wired it (C9), so the reported
  "kit ok" is now a real executed result in the artifact.
- The live mutation suite (as opposed to the synthetic selftest) must be observed in the same green run, not
  only the synthetic teeth (`m6-release-bar.md:383-384`).

---

## 5. M5 performance summary (both directions)

`docs/alpha16/m5-evidence.md` is the M5 evidence document: one row per required metric, every number traced to
a workflow + run + conclusion and an artifact field, improvements and regressions reported both ways, and an
explicit unproven list. It is not the artifacts and not a release gate (`m5-evidence.md:549-556`). This
section summarises it and points there; do not quote a number from here that is not also in the M5 document.

### 5.1 What was measured (run identities)

| row | workflow | run | conclusion | artifact |
|---|---|---|---|---|
| in-process scale/JSONL/provider assembly (100/1k/10k cards, large JSONL, assemble/marshal) | `GoTavern bench profiles` | **42200357353** | success; `comparison: passed`, `failures: 0`, all **31** benchmarks PASS | `bench-profiles` |
| cold+warm boot, `/version` + `/` latency, RSS, fresh install | `GoTavern smoke metrics` | **42200361137** | success | `smoke-metrics`, `q22-paired-benchmark` |
| same row's M0 "before" | `GoTavern smoke metrics` | **42160114658** | success | `smoke-metrics`, `q22-paired-benchmark` |
| 8-user concurrent writes (BEFORE only) | `M5 measurements` | **42212715040** | success; `report.json` `ok:true`, errorRate 0, 144 ops | `m5-eight-users-evidence` |
| 30-60 min soak, first run | `M5 measurements` | **42209244735** | completed/failure under the retired LS rule; flat under the corrected per-thirds rule | `m5-soak-evidence` |
| 30-60 min soak, re-run | `M5 measurements` | **42226780977** | completed/failure under the retired LS rule; flat under the corrected per-thirds rule | `m5-soak-evidence` |

All rows and the artifact fields are tabulated at `docs/alpha16/m5-evidence.md:16-24`.

### 5.2 Both directions (summary; numbers live in m5-evidence.md)

- **Bench rows (31/31 PASS):** improvements e.g. `BenchmarkStaticPageLoad` -10.8% ns/op, `ChatCompletion
  Assemble/scaled_1MB` -6.8%, `CharactersAllScale/cards_1000_32KB_image` -3.7%; regressions are all small and
  inside tolerance, e.g. `BenchmarkFrontendIndex` +0.7%, `BenchmarkFrontendAsset` +0.5%
  (`m5-evidence.md:51-84`). The comparison is against the regenerated baseline at `05479fa`, so the alpha.15
  card-cache win is **in the baseline** and is not re-earned by this run (`m5-evidence.md:99-113`).
- **Product row (new vs M0):** cold start -> `/version` **-70.2%** (917.2 -> 273.6 ms), cold -> listener
  **-78.6%**, warm -> version -7.9%, cold RSS flat, fresh-install seeding byte-identical (203 files /
  16,169,121 B). **Regressions are reported too:** `/version` p50 **+25.7%**, p95 **+14.2%**, max **+95.6%**,
  `/` p50 **+23.3%**, warm start-to-listen +4.6%, warm RSS +5.5%; the two p50s exceed the PROVISIONAL ceilings
  but those are not ratified gates (`m5-evidence.md:131-160`).
- **8-user BEFORE:** per-route p95 `/api/settings/save` 65.3 ms, `/api/settings/get` 38.9 ms, `/api/chats/save`
  87.7 ms; isolation checks green (each account wrote/read its own marker only) (`m5-evidence.md:224-236`).
  **The AFTER does not exist yet** - it is a second dispatch with `thresholds_from_run=42212715040`
  (`m5-evidence.md:240-260`).
- **Soak:** two real 45-minute runs produced LS slopes +39.8 B/s and +885.1 B/s on flat data (22x apart),
  because the LS slope is phase-aliased to GC boundaries; the corrected gate fails on per-third mean/GC-floor
  (`m5-soak/mean-rise`, `m5-soak/floor-rise`), passes both real runs and fails a synthetic monotone leak by
  name (`m5-evidence.md:271-358`; workflow change commit `9f6a76e`). The real-leak question is **UNPROVEN**:
  the tolerance is a detection floor, not a leak-free certificate (`m5-evidence.md:360-378,540-547`).

### 5.3 Same-SHA ratification caveats (explicit)

The plan's rule is two dispatches at the SAME commit; no provisional row is ratified by this evidence set
(`docs/alpha16/m5-evidence.md:444-451`):

| row | runs available | same commit? | status |
|---|---|---|---|
| 1 (smoke) | 42160114658 (`c8472c1`) vs 42200361137 (`0b577de`) | no (same image label+version) | **NOT RATIFIED** |
| 5 (8-user) | 42212715040 (`2b87703`) only | - | **NOT RATIFIED - BEFORE only** |
| 8 (soak) | 42209244735 (`6077405`) + 42226780977 (`2b87703`); both PASS corrected rule | no | **NOT RATIFIED** |
| 4 (20-extension) | none in this set | - | **NOT RATIFIED, no baseline** |

The only performance number any current release gate asserts is the 60 s cold ceiling
(`m5-evidence.md:432-435`); the smoke-metrics gate asserts only structural properties (M0 E-H2). A speedup
beyond +-60% is itself a failure (it means the benchmark stopped measuring the same work).

### 5.4 M5 gaps (named, not implied)

Streaming-cancellation performance (no TTFB/inter-frame/cancel metric); real provider-relay p99 under load;
20-extension page load has no gate and no baseline; 8-user AFTER not run; soak not a same-SHA pair and a
sub-tolerance leak would be invisible; no `benchstat`; p99 for row 1 not collected; process-level scale row
not dispatched; cold-guard benchmark row absent from the committed baseline; `ENOSPC` unproven; all absolute
numbers runner-relative and same-image only (`docs/alpha16/m5-evidence.md:471-511`; residual risks
`:513-547`). Artifact retention is **30 days** for every cited artifact, which is why this document exists as
the durable summary (`m5-evidence.md:526-531`).

---

## 6. M6 release state

### 6.1 Candidate, tag state, and the bar

- **Candidate:** `9f6a76e` (HEAD of `lane/alpha16-program`, 2026-11-06). The last change before the rehearsal
  is the soak-statistic CI correction (`9f6a76e`), which is part of the candidate.
- **Tag state:** **no alpha.16 tag exists** (`git tag --list 'v0.1.0-alpha.16*'` is empty); the newest tag is
  `v0.1.0-alpha.15`. The tag classifier still ends at alpha.15
  (`scripts/classify-version-tag.sh:92`), so an alpha.16 tag today would classify **prerelease** - the
  one-commit classification change is an open release item (`m6-release-bar.md:451-454`).
- **Alpha.15 tag immutability record:** the alpha.15 tag target `95638da-` was not moved; the publish-path
  exception (macOS ARM64 runner unsupported, publish job skipped, workflow's own programs re-run against the
  run's artifacts) is recorded (`m6-release-bar.md:424`; `HANDOFF.md:101`). No equivalent alpha.16 tag exists to
  move; "no tag move" is an obligation to exercise at release time, not a result already achieved.
- **The bar:** thirteen required same-SHA gates in `docs/release-manifest.json` (`requiredGates`, lines 5-97;
  `sameShaRequired: true` line 3), each `workflow_dispatch`-only, verified by a fail-closed verifier that
  requires the run's `head_sha` to equal the tag target and, where the rails exist, the required jobs,
  fixed-name artifact and embedded `release-evidence.json` (`m6-release-bar.md:103-123`). Alpha.15 proved the
  mechanism (13/13 at `95638da`, `PASS 13/13`; `HANDOFF.md:45-66`); alpha.16 has not yet produced the evidence
  at its own candidate (`m6-release-bar.md:125-136,413-434`).

### 6.2 The thirteen rehearsal dispatches at `9f6a76e` - all PENDING

Each row is a **dispatch performed for the rehearsal** per the handoff brief; **no verdict is recorded in the
tree at this write**, so each is **PENDING** and must not be read as green. The dispatch selection matters and
is recorded because the verifier cannot see dispatch inputs (`m6-release-bar.md:249-256`).

| # | gate (manifest) | workflow name | rehearsal run id | dispatch selection to confirm | status |
|---|---|---|---|---|---|
| 1 | GoTavern CI | `GoTavern CI` | **42237652240** | empty `probes` = full oracle | **PENDING** |
| 2 | whole-session | `GoTavern whole-session differential` | **42237657487** | no inputs | **PENDING** |
| 3 | world-info slot ordering | `GoTavern world-info slot ordering` | **42237662677** | no inputs | **PENDING** |
| 4 | drop-in qualification | `GoTavern drop-in qualification` | **42237667805** | no inputs | **PENDING** |
| 5 | Browser differential | `Browser differential` | **42237672610** | `mode=all` | **PENDING** |
| 6 | release qualification | `GoTavern release qualification` | **42237676939** | dispatch (not tag push); this gate still has **no evidence rails** (`m6-release-bar.md:154-171`) | **PENDING** |
| 7 | smoke metrics | `GoTavern smoke metrics` | **42237682002** | `requests=50` | **PENDING** |
| 8 | Docker image | `GoTavern Docker image` | **42237686752** | default `push_image=false` publishes nothing (`m6-release-bar.md:93`) | **PENDING** |
| 9 | Helper state differential | `Helper state differential` | **42237692314** | no inputs | **PENDING** |
| 10 | Combination journey differential | `Combination journey differential` | **42237697117** | **`profile=e03e04 tier=full extension_tier=full`**; a legacy `profile=none` or narrowed fast/medium dispatch is refused by the manifest rail (`docs/release-manifest.json:52-63`) | **PENDING** |
| 11 | Third-party extension compatibility | `Third-party extension compatibility` | **42237701919** | `mode=full` (the fixed artifact is not uploaded for `mode=sentinel`) | **PENDING** |
| 12 | long-lived corpus | `GoTavern long-lived corpus qualification` | **42237707075** | `size=medium` (medium-corpus + `longlived-medium-evidence`) | **PENDING** |
| 13 | Node stock-tree round trip | `GoTavern Node stock tree round trip` | **42237711904** | no inputs; the event rail is load-bearing because a push run also uploads the artifact | **PENDING** |

Plus the non-gate release dry run (`GoTavern Release`, a dispatch never publishes) - not yet dispatched for
alpha.16 (`m6-release-bar.md:232-238,455-469`).

### 6.3 The verifier: command, expected output, and what it can and cannot see

The publish job runs the same verifier the rehearsal must run (`m6-release-bar.md:224-229`):

```bash
GITHUB_REPOSITORY=cocokoishi/GoTavern GITHUB_TOKEN=<token> \
  node scripts/verify-release-gates.mjs --sha "$candidate" \
    --manifest docs/release-manifest.json --evidence-out /tmp/same-sha-evidence.md
```

Expected on success, verbatim from the program: `**PASS**: 13/13 required workflow(s) are green at this SHA.`
(`scripts/verify-release-gates.mjs:122`) plus the generated evidence table. A non-success exits non-zero and
publication does not happen (`m6-release-bar.md:115-116`; `scripts/verify-release-gates.mjs:140-143`); there is
no override flag (`m6-release-bar.md:116`). The verifier's refusal conditions are enumerated at
`m6-release-bar.md:173-197` (`missing`, `not-green`, `missing-job`, `job-not-green` - a SKIPPED job is not
green, `missing-artifact`, `missing-evidence`, `evidence-mismatch`, manifest refusals).

**What the verifier cannot see:** dispatch inputs (`gates.mjs:142-153`), and - for the ten gates that name no
artifact/evidence - anything inside the run (`m6-release-bar.md:118-123,249-256`). Therefore the run-id record
must state the inputs (section 6.2 does), and M0 finding E-H1 (narrowed dispatch) remains open.

### 6.4 How to turn a PENDING rehearsal row into evidence

```bash
for id in 42237652240 42237657487 42237662677 42237667805 42237672610 42237676939 42237682002 \
          42237686752 42237692314 42237697117 42237701919 42237707075 42237711904; do
  gh run view "$id" --json name,id,conclusion,event,headSha,createdAt,jobs
done
# then, after all thirteen are completed/success at one SHA:
GITHUB_REPOSITORY=cocokoishi/GoTavern GITHUB_TOKEN=<token> \
  node scripts/verify-release-gates.mjs --sha 9 \
    --manifest docs/release-manifest.json --evidence-out /tmp/same-sha-evidence.md
# expected: "**PASS**: 13/13 required workflow(s) are green at this SHA." (scripts/verify-release-gates.mjs:122)
```

Gate #10 is only satisfied if run `42237697117` is `profile=e03e04 tier=full extension_tier=full`, carries the
`combination-journey-evidence` artifact, and its root `release-evidence.json` states `interactingScenario:
true`, `tier: full`, the candidate head SHA and the five leg digests (`docs/release-manifest.json:52-63`).

---

## 7. Honest release conclusion

**alpha.16 is IN PROGRESS. The release bar is NOT MET at `9f6a76e`, and no alpha.16 tag has been created or
moved.** This is the default the task states and the evidence supports: the mechanism is proven at alpha.15,
the program's artefacts are committed, but the alpha.16 candidate has no recorded verdict set.

The exact missing items (all recorded in the M6 document or observed at this tree):

1. **Rehearsal verdicts.** The thirteen dispatches in section 6.2 are PENDING; there is no committed evidence
   document with their workflow+run+conclusion, and the verifier has not printed `PASS 13/13` at `9f6a76e`.
   Until then every "program tree" row in `m6-release-bar.md:413-434` stays UNPROVEN/BLOCKED.
2. **Release notes, checksums and the dry run.** No committed `docs/release-notes-v0.1.0-alpha.16.md` exists at
   `9f6a76e` (`m6-release-bar.md:455-459`); a draft is present in the working tree uncommitted (section 0
   drift note), and neither it nor any released version has passed `node scripts/verify-release-notes.mjs`.
   `scripts/release-assemble-checksums.sh` and
   `node scripts/verify-release-notes.mjs` have not been run for alpha.16; the `GoTavern Release` dry run
   (`-f ref=<candidate> -f candidate_version=v0.1.0-alpha.16`) has not been dispatched
   (`m6-release-bar.md:231-238`). The alpha.15 note's empty `## Performance` section is the anti-pattern to
   avoid (`m6-release-bar.md:425`).
3. **macOS ARM64.** The platform still refuses the configured runner and a tag run's publish job would skip
   exactly as at alpha.15; the fix (supported runner or explicit recorded downgrade, never
   `continue-on-error`) is not made (`m6-release-bar.md:428,460-463`; `HANDOFF.md:101`). darwin/arm64 is built
   and archive-inspected, not executed.
4. **`GOAL.md` section 14 real private tree: NOT MET.** Synthetic agent-built environments do not establish
   the "actually-used real private tree" claim (`GOAL.md:452`; `docs/alpha16-agent-execution-plan.md:131`;
   `m6-release-bar.md:436-445`). The alpha.16 release may legitimately claim a **synthetic adversarial
   qualification** with precise scope; it may **not** claim universal drop-in proof.
5. **Two structural gaps that the rehearsal alone cannot close:** gate #6 (`GoTavern release qualification`)
   still uploads no fixed-name `release-evidence.json`, so the verifier cannot see which qualification jobs
   ran (`m6-release-bar.md:154-171,464-466`); and the narrowed-dispatch rail (M0 E-H1) is open for ten gates
   whose inputs the verifier cannot read (`m6-release-bar.md:470-473`).
6. **Tag classification.** At the read tree `9f6a76e`, `v0.1.0-alpha.16` is not in `GRADUATED_STABLE_TAGS`
   (`scripts/classify-version-tag.sh:92`); without a one-commit change plus its neighbour test, an alpha.16 tag
   publishes as prerelease (`m6-release-bar.md:451-454`). **Observed at write time, not committed, not
   authored by this ledger:** the working tree carries an uncommitted change to `scripts/classify-version-tag.sh`
   and `scripts/test-classify-version-tag.sh` that adds `v0.1.0-alpha.16` to the equality list with the
   neighbour assertions. If it lands as a commit, this item closes; the release notes and the same-SHA
   candidate record must then cite that commit.
7. **M2 full-tier durable record.** The reported full-tier match `42234426258` is not yet committed with its
   artifact; gate #10 cannot be called green from this tree (section 4.1).
8. **Page-init egress.** The full-tier hermeticity prerequisite is still OPEN (`first-scenario-design.md:143-151`;
   `source-audit.md:233`; commit `27bf5f0` did not change browser egress), and the full-tier release dispatch
   inherits it.

What may be claimed today, precisely: a **synthetic adversarial qualification** of the E03+E04 interacting
scenario at the fast tier (run `42184268652`, match) with a full-tier green reported but not yet durable;
five M0 defects fixed by minimal change with red-first gates; an audit of the whole Go product surface; and an
M5 evidence record that reports improvements and regressions both ways without ratification. What may **not**
be claimed: a passed alpha.16 release bar, any universal drop-in parity, any real-private-tree qualification,
or any tag/publication action.

---

## 8. Residual risk register and follow-ups

Open items at `9f6a76e`. Each names its evidence and what closes it; none is a refactor (M4 refused all six,
section 3.3).

| # | item | evidence / state | closed by |
|---|---|---|---|
| 1 | **D-H1** chat-path config readers ignore the resolved config path (`--configPath`, non-adjacent `--dataRoot`) - confirmed-defect | `docs/alpha16/source-audit.md:183`; `internal/server/pinned_chat_config.go:35-45`; open | thread the resolved config path into the readers; one provider-wire scenario that shows the override reaching the peer (`m4-refactor-decisions.md:105-135`) |
| 2 | **C-H1** rate-limit maps never evict (remembered keys grow for the process lifetime; pinned evicts per key) | `docs/alpha16/audit/c-concurrency-lifecycle.md:424-452`; `internal/server/accounts.go:115-200`; no eviction test | 10k-distinct-key test asserting the map returns to the active set, then a bounded sweep |
| 3 | **C-H6** graceful shutdown has an unbounded wait: `heartbeat.stop` waits on the writer mutex and `<-done` outside the Close context | `docs/alpha16/audit/c-concurrency-lifecycle.md:524-533`; `internal/app/heartbeat.go:77-85,127` | blocking-FS/fault-injected seam, then a bounded `stop` |
| 4 | **C-H7** the second-SIGINT message promises "in-flight requests are aborted" but only listeners are closed | `docs/alpha16/audit/c-concurrency-lifecycle.md:535-548`; `cmd/gotavern/main.go:367-373` | close connections or correct the message; a test with a blocked handler |
| 5 | **C-H8** the `-race` gate omits `internal/app` and `internal/lockacquire` | `docs/alpha16/audit/c-concurrency-lifecycle.md:550-563`; `.github/workflows/ci.yml:683` | add both packages to the race list (bounded CI change) |
| 6 | **B-H4** the two recursive destructive routes run outside the shared content lock | `docs/alpha16/audit/b-persistence-writers.md:338-354`; `internal/server/account_data_reset.go:107-137`; no probe | crash/concurrency probe on both subjects; lock only if a Go-only corrupted tree is shown |
| 7 | **A-H1** no app-level body-parser stage (media-type/charset/limit/error-order divergence) | `docs/alpha16/audit/a-request-path.md:326-354`; verified-risk | one account/CORS probe extension; then fix or record a product decision |
| 8 | **A-H2** `cors.enabled` with a falsy `cors.origin` loses the Express automatic OPTIONS answer | `docs/alpha16/audit/a-request-path.md:355-377`; verified-risk | the same probe extension, one pinned OPTIONS recording |
| 9 | **A-H3** `/api/settings/save` empty-body/failure semantics differ from pinned (file wipe vs 400; 200 vs 500) | `docs/alpha16/audit/a-request-path.md:378-397`; verified-risk | settings-save probe extension; a product decision if the safer divergence is kept |
| 10 | **A-H5** with CSRF disabled and accounts off, `/api/users/login` answers 500 (nil session) | `docs/alpha16/audit/a-request-path.md:419-438`; untested | one pinned recording with the same config; then fix or record |
| 11 | **C-H11** identity-cache residual: same-size + same-mtime replacement is invisible to the settings/world/card caches on Unix (the account cache added ctime) | `docs/alpha16/audit/c-concurrency-lifecycle.md:592-605`; documented + pinned by tests | per-cache change-stamp witness, measured before adoption |
| 12 | **D-H17** tokenizer cache materialization is non-atomic where pinned uses an atomic write | `docs/alpha16/audit/b-persistence-writers.md:377-390`; `internal/server/tokenizers.go:377-390` | atomic write for the derived cache; no user-visible contract to preserve |
| 13 | **L-H4 / A-H13** `/proxy/:url(*)` is absent from the route-domain table and unimplemented, while the CSRF layer special-cases it | `docs/alpha16/source-audit.md:190-192,239`; `docs/alpha16/audit/a-request-path.md:565-577`; `internal/server/csrf_session.go:192` | assign an owning milestone; the inventory gate must see direct `server-main.js` routes, and an unimplemented route must answer a distinguishable status |
| 14 | **Streaming-cancel performance** has no TTFB/inter-frame/cancel-to-idle metric (functional gates only) | `docs/alpha16/m5-evidence.md:471-474,390`; plan section 8 R5 | a provider peer that streams slowly, then a threshold recorded before measuring |
| 15 | **Real provider-relay p99 under load** is unmeasured (bench rows are in-process assemble/marshal) | `docs/alpha16/m5-evidence.md:475-476`; `docs/alpha16/baseline/README.md:64-65` | a relay through `internal/outbound` under concurrency with a controlled peer |
| 16 | **macOS ARM64** runner unresolved; tag-run publish skips as at alpha.15 | `docs/alpha16/m6-release-bar.md:428,460-463`; `HANDOFF.md:101` | supported runner or explicit recorded downgrade, never `continue-on-error` |
| 17 | **Soak is NOT RATIFIED**: two real runs are flat under the corrected per-third rule but are at different commits; a leak below +10% mean / +4 MiB floor over 45 min is invisible | `docs/alpha16/m5-evidence.md:360-378,444-451,540-547` | two same-SHA clean-tree soak dispatches with the corrected rule; report both ids |
| 18 | **8-user AFTER is pending** (only the BEFORE row exists; the +25% per-route p95 ceiling is untested) | `docs/alpha16/m5-evidence.md:240-260,480-481` | a second dispatch with `thresholds_from_run=42212715040` at the change under test |
| 19 | **Evidence-artifact retention is 30 days** for every cited artifact; this ledger is the durable summary | `docs/alpha16/m5-evidence.md:526-531`; `.github/workflows/bench-profiles.yml:117,128`, `smoke-metrics.yml:194`, `m5-measurements.yml:228,414,533` | re-download artifacts into durable evidence documents (the M5 precedent) before expiry |
| 20 | **M1 has no recorded CI run id**; M2 full-tier durable record and the 13 M6 verdicts are pending (sections 2.1, 4.1, 6.2) | this ledger | commit the run-id + artifact record per `m6-release-bar.md:260-280` |

Two further known-open items from the M0 residual table that are not product risks but are tracked there:
stale documentation claims (`translate.go`, `stats.go` header, four `api-inventory.md` search rows, the
`claude_chat.go` cache comment) and the per-chat-backups product decision
(`docs/alpha16/source-audit.md:220-239`).

---

## 9. How to reproduce every cited run family and find its artifacts

Dispatch commands are the ones the committed documents already own; nothing below was executed by this task.
`workflow_dispatch` only fires for workflows present on the default branch (`m6-release-bar.md:249-252`).

### 9.1 M0 audit artefacts and the generated graphs

```bash
# re-derive the machine-readable union (checks every lane citation at assembly)
node tools/alpha16-graph/assemble.mjs --out docs/alpha16/ownership-map.json
# re-derive the AST facts for the tree being audited
go run ./tools/alpha16-graph -root . -out docs/alpha16/source-graph.json -commit "$(git rev-parse HEAD)"
node tools/alpha16-graph/assemble.mjs | head -20      # coverage census
```

Source: `docs/alpha16/source-audit.md:241-247`. M0 baseline runs and downloads:
`docs/alpha16/baseline/README.md:84-93` (`gh workflow run bench-profiles.yml -f rounds=3`,
`gh workflow run smoke-metrics.yml -f requests=50`, then `gh run download <id> -n bench-profiles-artifacts`
and `-n smoke-metrics`).

### 9.2 M1 corpus schema

M1 has no run id; the change is commit `86df528` and the record is its commit message plus the corpus
validators (`node tools/longlived/verify-corpus-schema.mjs`, `internal/longlivedfixture` tests). A Linux CI
run must be cited before M1 is called release evidence.

### 9.3 M2 E03+E04 qualification

```bash
# the release-admissible dispatch (fast/medium are narrowed and not release evidence)
gh workflow run combination-journey.yml --ref <ref> \
  -f profile=e03e04 -f tier=full -f extension_tier=full
# artifacts: combination-journey-evidence (legs/*.json, extension-seed.json, release-evidence.json at root,
#            e03e04-kit-selftest.log) - retention 30 days
gh run download <id> -n combination-journey-evidence -D /tmp/cj
# the gate's synthetic teeth and the kit contract (also executed in-workflow since M6b)
node tests/browser/combination-journey-gate-selftest.mjs
node tests/browser/extensions/e03e04-kit-selftest.mjs
```

Sources: `docs/alpha16/first-scenario-design.md:55-72,112-117`; `docs/alpha16/m6-release-bar.md:293-308,350-390`;
`.github/workflows/combination-journey.yml:29-72,77-79,246-257,293-358`. The full-tier history's run ids are in
section 4.1; the reported final green's confirmation command is in 6.4.

### 9.4 M3 differential / oracle re-record / ratchet / soak-gate teeth

```bash
# narrowed one-probe oracle dispatch used to re-record the four provider-wire scenarios
gh workflow run ci.yml --ref <ref> -f probes=probe-provider-wire.mjs
# the re-record artifact is a patch with the fixture changes; apply/commit with its semantic diff
gh run download <id> -n <artifact> -D /tmp/oracle
# adversarial ratchet
go test ./internal/adversarial -count=1
# soak verdict teeth (local validation; the workflow change is commit 9f6a76e)
gh run download 42209244735 -n m5-soak-evidence -D /tmp/soak1
gh run download 42226780977 -n m5-soak-evidence -D /tmp/soak2
```

Sources: commit `fa5385f` (the re-record closes the `GoTavern CI` **42187779109** narrowed dispatch); commit
`98400d6`; `docs/alpha16/m5-evidence.md:346-358,26-33`.

### 9.5 M5 performance rows

```bash
# rows 2/3/6: in-process scale/JSONL/assembly - before/after; NEVER pass update_baseline for a comparison
gh workflow run bench-profiles.yml --ref <branch> -f rounds=3
#   regenerate only when the observation legitimately changed, then a normal comparison (L-H1 precedent)
gh workflow run bench-profiles.yml --ref <branch> -f rounds=3 -f update_baseline=true
# rows 1: cold/warm boot + paired product record
gh workflow run smoke-metrics.yml --ref <branch> -f requests=50
# rows 4/8: full extension dispatch (sentinel runs none of these)
gh workflow run third-party-extension-compat.yml --ref <branch> -f mode=full
# row 5: 8-user BEFORE (already exists as 42212715040) and the AFTER it enables
gh workflow run m5-measurements.yml --ref <branch> -f which=eight-users -f users=8 -f waves=6
gh workflow run m5-measurements.yml --ref <branch> -f which=eight-users -f users=8 -f waves=6 \
  -f thresholds_from_run=42212715040 -f load_label="M5 after: <who/what>"
# row 8: soak (corrected per-thirds gate)
gh workflow run m5-measurements.yml --ref <branch> -f which=soak -f soak_minutes=45
# artifacts: bench-profiles, smoke-metrics, q22-paired-benchmark, m5-eight-users-evidence, m5-soak-evidence,
#            m5-scale-evidence; every one 30-day retention (m5-evidence.md:526-531)
```

Sources: `docs/alpha16/m5-measurement-plan.md:284-315`; `docs/alpha16/m5-evidence.md:26-33,240-260,444-469`.
A before/after pair must share runner image label+version, Go version and GOMAXPROCS; a moved image version is
NOT-COMPARABLE and the before is re-taken (`m5-measurement-plan.md:339-342`).

### 9.6 M6 release rehearsal, verifier, dry run and (later) the tag

```bash
candidate="$(git rev-parse HEAD)"   # 9f6a76e… for this rehearsal
# 1) the 13 required gates, deliberately dispatched at the candidate with full selections
gh workflow run ci.yml                      --ref <ref> -f probes=
gh workflow run whole-session.yml           --ref <ref>
gh workflow run worldinfo-slots.yml         --ref <ref>
gh workflow run dropin-qualification.yml    --ref <ref>
gh workflow run browser-differential.yml    --ref <ref> -f mode=all
gh workflow run release-qualification.yml   --ref <ref>
gh workflow run smoke-metrics.yml           --ref <ref> -f requests=50
gh workflow run docker.yml                  --ref <ref>
gh workflow run helper-state.yml            --ref <ref>
gh workflow run combination-journey.yml     --ref <ref> -f profile=e03e04 -f tier=full -f extension_tier=full
gh workflow run third-party-extension-compat.yml --ref <ref> -f mode=full
gh workflow run longlived.yml               --ref <ref> -f size=medium
gh workflow run node-stock-tree.yml         --ref <ref>
# 2) the same verifier the publish job runs
GITHUB_REPOSITORY=cocokoishi/GoTavern GITHUB_TOKEN=<token> \
  node scripts/verify-release-gates.mjs --sha "$candidate" \
    --manifest docs/release-manifest.json --evidence-out /tmp/same-sha-evidence.md
# 3) artefact-side programs the publish job also runs
bash scripts/release-assemble-checksums.sh dist
node scripts/verify-release-notes.mjs docs/release-notes-v0.1.0-alpha.16.md v0.1.0-alpha.16 \
  --checksums dist/checksums.txt
# 4) the dry run (a dispatch never publishes)
gh workflow run release.yml --ref <ref> -f ref="$candidate" -f candidate_version=v0.1.0-alpha.16
# 5) only after 1-4 are green: tag push (the publish job re-runs the verifier; no override exists)
git tag -a v0.1.0-alpha.16 -m "GoTavern v0.1.0-alpha.16" "$candidate" && git push origin v0.1.0-alpha.16
# 6) post-publication
gh run download <install-smoke-run> -n smoke-metrics-out
gh run download <published-extension-run> -n published-extension-smoke-linux
git rev-parse v0.1.0-alpha.16^{commit}      # must equal $candidate (no tag move)
```

Sources: `docs/alpha16/m6-release-bar.md:199-258` (commands; the expected verifier line at `:229`, exact text
from `scripts/verify-release-gates.mjs:122`), `:260-280` (what each run-id record must contain), `:436-445`
(the section 14 statement the notes must carry). Artifact locations are the fixed-name artifacts named per gate
in `docs/release-manifest.json` (combination, extension-compat, longlived-medium, node-stock-tree) and the
downloads named in section 9.5; all CI artifacts have 30-day retention, so a release evidence document must be
committed from them before they expire.
