# alpha.16 handoff ledger (plan section 9.E)

**Status: PUBLISHED. The alpha.16 release bar is MET at the final candidate `c1886d7` within the synthetic
adversarial qualification scope, and `v0.1.0-alpha.16` was tagged and published from it. Sections 1-10 record
the programme as it stood at the earlier candidate `6e96959` (a rehearsal target that the final engineering
pass superseded); section 11 records that pass and section 12 records the final 13/13 gate wave, the tag, the
release and the post-release verification.** This ledger is documentation only: no workflow is dispatched by
writing it. Tree read: `6e96959`
(`main`, the frozen candidate, 2026-11-06); program base `c256f21`. Pinned oracle: SillyTavern `1.19.0` @
`06bde939fb1e9c4c8d8641d810f0a916b5bce127` (`upstream/SILLYTAVERN_COMMIT`; `docs/alpha16/README.md:4`).

It is built from the committed program documents: `docs/alpha16-agent-execution-plan.md`,
`docs/alpha16/README.md`, `docs/alpha16/source-audit.md`, `docs/alpha16/ownership-map.json`,
`docs/alpha16/source-graph.json`, `docs/alpha16/baseline/README.md`, `docs/alpha16/first-scenario-design.md`,
`docs/alpha16/m3-chaos-evidence.md`, `docs/alpha16/m4-refactor-decisions.md`,
`docs/alpha16/m5-measurement-plan.md`, `docs/alpha16/m5-evidence.md`, `docs/alpha16/m6-rehearsal.md`,
`docs/alpha16/m6-release-bar.md`, `docs/alpha16/same-sha-evidence.md`,
`docs/release-notes-v0.1.0-alpha.16.md`, `docs/release-manifest.json`, `docs/release-governance.md`, and the
git history that records the fix commits and their red-first evidence. It applies the plan's own handoff
requirement (`docs/alpha16-agent-execution-plan.md:143`): for each changed area, the original `file:line`,
the observed red, the root cause, the patch, the green run, parity impact, data-safety result, benchmark in
both directions and residual limits.

`6e96959` is the seven-character form used throughout. The document gate in `internal/fixtures` refuses a
forty-character commit that is not the pinned oracle, so the candidate is never written as a full SHA; the
committed verifier table resolves it (`docs/alpha16/same-sha-evidence.md:15-18`).

## 0. Run-id integrity rule (read this before quoting any id below)

Every run id is quoted **together with its workflow name and its conclusion** (`AGENTS.md` rule 55). Ids are
taken from the committed documents or git history named beside them; the final release-gate table is the
verifier's own output, committed verbatim at `docs/alpha16/same-sha-evidence.md:23-45`, and every gate row in
this ledger is a reference to that table.

**Convention:** a run id that appears inside a reproduce command, a same-SHA-status table or a superseded-wave
note is a cross-reference to the row that states its workflow and conclusion; a run id introduced as evidence
always carries all three here. When this ledger and an evidence document with the artifact disagree, the
evidence document wins.

**Earlier revisions of this ledger.** The first revision (`0cf17cb`) honestly recorded an IN PROGRESS
conclusion because the release-rehearsal verdicts were not yet durable, and it disclosed two uncommitted
working-tree artefacts (the alpha.16 tag-classifier graduation and the alpha.16 release note). Both are now
committed (`a54db37`), so the drift note is retired: there is no uncommitted evidence in this ledger's scope.
The first rehearsal wave (at `9f6a76e`/`a54db37`) and a second wave at `97e8cde` were **superseded** when the
candidate moved; they are recorded in `docs/alpha16/m6-rehearsal.md:56-64`, and §6.5 records why. The final
wave at `6e96959` is the evidence of record, and the rehearsal record itself is now a COMPLETE document
(`docs/alpha16/m6-rehearsal.md:3-12`).

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
That is enough for a **synthetic adversarial qualification with precise scope** - which is what the release
bar at `6e96959` is MET for - and it is **not** the `GOAL.md` section 14 strong drop-in bar, which remains
**NOT MET** ("Current state, dated 2026-11-05 (`v0.1.0-alpha.15`): NOT MET for the strong form",
`GOAL.md:452`; repeated at `docs/alpha16-agent-execution-plan.md:131`,
`docs/release-notes-v0.1.0-alpha.16.md:193-196` and `docs/alpha16/m6-release-bar.md:436-445`). The closer for
that bar is a separately authorised real private tree and its byte census, which no synthetic environment
supplies (`docs/alpha16/source-audit.md:236`). **The claim ceiling for alpha.16 is therefore: a synthetic
adversarial qualification was executed, replayed at one frozen candidate and verified by the release program
itself; universal drop-in parity was not proven and was not attempted.**

**Program shape.** M0 read-only audit, M1 scenario-factory schema, M2 E03+E04 interacting-scenario
qualification, M3 differential/mutation evidence (including the M3b ENOSPC/EFBIG chaos proof), M4 refactor
decisions (all refused), M5 performance evidence (including the two new rows), M6 release-bar implementation
and the final rehearsal. The program base is `c256f21`; the frozen candidate is `6e96959`,
`v0.1.0-alpha.16`. The audit census at M0/M0b is: 603 Go files parsed, **296 production**, **106 deep-read**,
**236 named by a lane**, and **0 unnamed product-logic files** after the M0b family pass
(`docs/alpha16/source-audit.md:18-49`); **72 hypotheses** (5 confirmed-defect, 37 verified-risk, 15
untested-hypothesis, 13 intentional-parity, 2 out-of-scope), **67 writer rows**, **66 concurrency entries**,
**33 cache rows**, **45 request-path stages** (`docs/alpha16/source-audit.md:24-28`;
`docs/alpha16/ownership-map.json`).

**Current state (the honest summary).** Source audit complete; M1-M6 artefacts committed; five M0 findings
closed by minimal fixes; M2 is green at the release-admissible full tier and its embedded evidence contract is
read by the gate; M3b proves ENOSPC/EFBIG are not conflated; M4 refused all six refactor candidates; M5 has
both new rows run (see the unratified-threshold finding in §5.3); M6 has all 13 required gates
completed/success at one candidate, the fail-closed verifier's `PASS 13/13`, and a green release dry run with
the recorded darwin/arm64 platform downgrade. One confirmed defect (D-H1) and several bounded risks remain
open (§8). **No tag and no publication**: the rehearsal proves the publish gate can publish, and the program
stopped at qualification. The acceptance rule's remaining preconditions are exclusively the publication act
and the real-private-tree bar (`docs/alpha16-agent-execution-plan.md:145`).

---

## 2. Milestone ledger M0-M6

### 2.1 Milestone table

| # | Milestone | Artefacts produced (committed) | Key evidence (workflow + run + conclusion) | Fixed here | Refused / left open |
|---|---|---|---|---|---|
| **M0** | Read-only source/ownership/behaviour audit, baseline, first-scenario design | `docs/alpha16/README.md`; `source-audit.md`; `ownership-map.json`; `source-graph.json`; `audit/a-request-path.md` + fragments `a`-`e` + `lead.json`; `baseline/README.md`; `first-scenario-design.md` | `GoTavern Lane CI` **42160006720** success at `c8472c1`; `GoTavern CI` **42159888005** success at `26aaa33`; `GoTavern Lane CI` **42159064025** failure at `c256f21` (the plan document's own pin citation, i.e. the gate working); **the baseline bench run is red and is finding L-H1**: `GoTavern bench profiles` **42160109620** failure; product record `GoTavern smoke metrics` **42160114658** success (`docs/alpha16/source-audit.md:158-172`; `docs/alpha16/baseline/README.md:95-120`) | nothing in M0 (read-only); the red M0 bench record became finding L-H1 | M0 fixed nothing by rule (`docs/alpha16/README.md:20-23`) |
| **M1** | Scenario-recipe schema half of the factory: optional `scenario` block in both corpora, named refusals, determinism and drift teeth, E02 prototype | corpus schema changes in `internal/longlivedfixture/scenario.go`, `tests/e2e/longlived_schema_test.go`, `tools/longlived/corpus-schema.mjs`, `tools/build-longlived-corpus.mjs` (commit `86df528`) | **No run id recorded in the tree for the M1 commit.** The commit records LOCAL triage and states "CI is the verdict" (commit `86df528`); the M2 commit that extended the same corpora is covered by the M2 runs | corpus schema/verifier/teeth | **EVIDENCE GAP: M1's own commit has no recorded CI run id**; its consumer evidence is the M2 gate |
| **M2** | E03+E04 interacting-scenario harness: deterministic 120-block preset + 3 nested books, 22-extension install batch, five browser legs, comparator + artifact identity, tier wiring, and the M2m deterministic-swipe fix | `tests/browser/combination-journey-probe.mjs`, `compare-combination-journey.mjs`, `extensions/e03e04-profile-kit.mjs`, `extensions/extension-install-batch.mjs`, `combination-journey-gate-selftest.mjs`, `.github/workflows/combination-journey.yml`; `first-scenario-design.md`; commits `71dd7b8`..`97e8cde` | **release-admissible full tier at the candidate: `Combination journey differential` **42294155456** completed/success** with `combination-journey-evidence` (tier full; truthy interactingScenario/ok/legs.allRecorded/teeth.ok/kit.ok) (`docs/alpha16/same-sha-evidence.md:39,53-55`); durable credentialed full-tier gate `Combination journey differential` **42234426258** - **match** (failedGuards [], 0 capture mismatches, durable equal, restart differences [], teeth 49/49, kit ok); fast-tier narrowed proof `Combination journey differential` **42184268652** match (`docs/alpha16/m6-release-bar.md:339`) | thirteen test/workflow-only commits (M2..M2m: `71dd7b8`, `0b3021b`, `375dc8e`, `6332ef2`, `f22cd1b`, `5262039`, `0b577de`, `d5e84e5`, `9be10f4`, `2e36302`, `924d71a`, `6936291`, `97e8cde`); no product code changed | no product defect was found by the full-tier journey; the recorded failures were harness defects (overlays, quiet-generation attribution, group fan-out, branch metadata, swipe readiness); page-init egress still open |
| **M3** | Differential/mutation evidence: four provider-wire scenarios discriminating D-H3 and D-H2, re-recorded on Linux; adversarial ratchet port-race rework; soak-gate teeth; **M3b ENOSPC/EFBIG chaos proof** | `tests/oracle/sillytavern-1.19.0-provider-wire.json` (258 -> 262 scenarios), four `tests/provider-wire/scenarios/*.json`, `docs/config-parity.md` + `tools/inventories/config-parity.json`; `internal/adversarial/*` (commit `98400d6`); `.github/workflows/m5-measurements.yml` soak verdict (commit `9f6a76e`); `docs/alpha16/m3-chaos-evidence.md`, `internal/fsretry/fsretry_errno_test.go`, `internal/startup/atomic_errno_test.go` (commit `53af81c`) | `GoTavern CI` **42187779109** narrowed `probes=probe-provider-wire.mjs`, failure only at the intended "Verify generated results are committed" step, closed by the re-record (commit `fa5385f`); ratchet: `GoTavern Lane CI` **42162940621** failure, same code **42163485576** success, then test-only rework `98400d6`; **M3b: `GoTavern Lane CI` **42244117651** success at `53af81c`**, ENOSPC/EFBIG named tests green locally and two mutation reds observed (`docs/alpha16/m3-chaos-evidence.md:199-227,231-247`) | ratchet harness defect fixed test-only; soak statistic corrected; M3b proves ENOSPC/EFBIG are not conflated (neither retried, identity survives the wrappers) | real kernel ENOSPC remains **UNPROVEN by policy** and is not relabelled as EFBIG (`m3-chaos-evidence.md:9-41`); no exhaustive chaos campaign beyond the named items |
| **M4** | Evidence-based refactor decisions for plan section 6 R1-R6 | `docs/alpha16/m4-refactor-decisions.md` | **No run**: a documentation decision whose evidence base is the M0 union (`ownership-map.json`, base `c8472c1`) plus the lane reports; its 104 file:line citations were range-checked (`m4-refactor-decisions.md:457-468`) | nothing (decision only) | **R1-R6 all REFUSED** with per-candidate evidence and bounded alternatives (`m4-refactor-decisions.md:49-62`) |
| **M5** | Performance evidence: row contract, thresholds recorded before optimization, both-direction reporting, the two new rows (8-user, soak), an evidence document from downloaded artifacts, and the same-candidate re-runs | `docs/alpha16/m5-measurement-plan.md`; `docs/alpha16/m5-evidence.md`; `tests/perf/m5-eight-users.mjs`; `.github/workflows/m5-measurements.yml` (commits `521ec8c`, `6077405`, `2b87703`, `9f6a76e`) | `GoTavern bench profiles` **42200357353** success; `GoTavern smoke metrics` **42200361137** success; 8-user BEFORE `M5 measurements` **42212715040** success; soak `M5 measurements` **42209244735** failure and **42226780977** failure under the retired LS rule (both flat under the corrected per-thirds rule); L-H1 closure `GoTavern bench profiles` **42164978648** success -> **42165562517** success (`docs/alpha16/m5-evidence.md:16-24`; `docs/alpha16/baseline/README.md:182-186`); **same-candidate soak `M5 measurements` **42247845380** completed/success under the corrected GC-robust rule; 8-user AFTER `M5 measurements` **42247840229** fail-closed red under the BEFORE x1.25 ceiling (see §5.3)** | L-H1 closed by deliberate regeneration; soak statistic corrected (M5b) | **M5 provisional rows remain NOT RATIFIED** (`m5-evidence.md:444-451`); the 8-user AFTER red is an **unratified-threshold repeatability finding, not a product regression** (§5.3) |
| **M6** | Release bar: the 13-gate reconstruction, the fail-closed verifier contract, the combination-gate rails, the darwin/arm64 recorded downgrade and the macos-arm64 extension-gate limitation, the release notes + tag graduation, and the frozen-candidate rehearsal | `docs/alpha16/m6-release-bar.md`; `docs/alpha16/m6-rehearsal.md`; `docs/alpha16/same-sha-evidence.md`; `docs/release-notes-v0.1.0-alpha.16.md`; `docs/release-manifest.json` gate #10 rails (commit `27bf5f0`); `.github/workflows/combination-journey.yml` rails (commit `27bf5f0`); `scripts/classify-version-tag.sh` + test (commit `a54db37`); `release.yml` darwin downgrade (commit `75ea96e`); third-party macos-arm64 limitation (commit `c509471`) | **All 13 required gates completed/success at `6e96959` (table in §6.2); official verifier exit 0 with `**PASS**: 13/13 required workflow(s) are green at this SHA.` (`docs/alpha16/same-sha-evidence.md:19-45`; template `scripts/verify-release-gates.mjs:122`); release dry run `GoTavern Release` **42294172571** completed/success** | combination-gate rails implemented (M6b, refusal-only); darwin/arm64 downgrade + macos-arm64 limitation markers implemented with release-governance tests; tag classifier graduated; notes committed | gate #6 evidence-schema gap remains; narrowed-dispatch rail (E-H1) remains; darwin/arm64 **runtime** UNPROVEN (recorded downgrade, not waived); macos-arm64 extension lifecycle UNPROVEN |

### 2.2 What each milestone's evidence can and cannot carry

- **M0's runs are program-tree evidence, not release evidence.** `source-audit.md` records why: the
  drop-in and node-stock-tree runs are docs-only-tree successes whose event/rails are not release evidence, and
  no run is a release dispatch at the candidate (`docs/alpha16/source-audit.md:168-172`;
  `docs/alpha16/m6-release-bar.md:125-139`).
- **M1 is the one milestone whose own commit has no recorded run id** (M4 has no run by design). Its consumer
  evidence is the M2 full-tier gate, which exercises the corpora; the gap is recorded rather than implied.
- **M2's final evidence is the release-admissible full tier at the candidate** (`Combination journey
  differential` **42294155456**, completed/success), plus the comparator's durable **match** record
  (`Combination journey differential` **42234426258**). The fast tier is narrowed and cannot carry a release
  claim (`docs/alpha16/m6-release-bar.md:339,392-403`).
- **M3's oracle re-record is the gate-first pattern working**: four scenarios added first (red), then
  recorded, with a semantic diff proving exactly four additions and zero changes to 258 existing captures
  (commit `fa5385f`). **M3b** proves a property (no conflation, identity preserved) and explicitly does not
  claim a real kernel ENOSPC (`m3-chaos-evidence.md:39-41`).
- **M4 is a decision, not a change.** No product code moved for R1-R6.
- **M5's numbers are a summary of artifacts**; the artifacts are the record and are retained 30 days
  (`docs/alpha16/m5-evidence.md:526-531`). The two final M5 runs are recorded in §5.
- **M6's 13/13 is the verifier's own committed output**, not a checklist: every row carries event, status,
  conclusion, and - where the manifest names them - the required job, artifact and embedded evidence
  (`docs/alpha16/same-sha-evidence.md:47-62`).

---

## 3. The five strongest M0 findings and their current state

The M0 ranking is fixed by `docs/alpha16/source-audit.md:174-192` (full rows in
`docs/alpha16/audit/lead.json` -> `fiveStrongest`). State below is **at `6e96959`**, not the M0 snapshot; the
fix commits and their red-first evidence are in section 3.2.

### 3.1 State table

| rank | id | class | finding (M0) | state at `6e96959` | evidence |
|---|---|---|---|---|---|
| 1 | **D-H3** | confirmed-defect, provider-wire | `claude.enableAdaptiveThinking` had no Go reader while the shipped default is `false`, so a stock install with claude-opus-4-6/sonnet-4-6 sent a different `thinking` payload than pinned | **FIXED by minimal change** (commit `60454bc`), with the discriminating oracle pair recorded | `source-audit.md:182`; `m4-refactor-decisions.md:360`; fixture `tests/oracle/sillytavern-1.19.0-provider-wire.json:7795,7994` |
| 2 | **D-H1** | confirmed-defect, provider-wire | chat-path config readers derive `config.yaml` from the data root and its parent, so `--configPath` (and a non-adjacent `--dataRoot`) silently default every provider-visible key | **OPEN - no fix commit.** The bounded follow-up is to thread the resolved config path into the readers; it was not fixed in this program | `source-audit.md:183`; `internal/server/pinned_chat_config.go:35-45`; `m4-refactor-decisions.md:105-135` |
| 3 | **D-H2** | confirmed-defect, provider-wire | `gemini.apiVersion` was never read by the MAKERSUITE chat route or its status arm; `docs/config-parity.md` claimed it implemented | **FIXED by minimal change** (commit `1a7b914`), with generate+status scenarios recorded and config-parity regenerated | `source-audit.md:184`; `m4-refactor-decisions.md:361`; fixtures `...provider-wire.json:22219,22400` |
| 4 | **B-H3** | verified-risk, persisted-bytes | `gotavern migrate --force` backed up only `config.yaml` and `data/`; pre-existing `certs/` and the global extension overlay were overwritten in place | **FIXED by minimal change** (commit `7f91192`) with three red-first tests | `source-audit.md:185`; `m4-refactor-decisions.md:362`; `internal/migrate/migrate_test.go:645,743` |
| 5 | **L-H1** | confirmed-defect, performance | the committed benchmark baseline predated the alpha.15 card cache, so the M2/M5 bench gate was red at the program base on unchanged product code | **CLOSED as an evidence-machinery defect** by deliberate regeneration and a green comparison; the cold-guard row and the soak pair ratification remain open | `source-audit.md:186`; `docs/alpha16/baseline/README.md:174-197` |

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
| **L-H1** | `tests/perf/bench-baseline.txt` at `ed75eee` (2026-11-03), predating the card cache `cc72384` (2026-11-05) | `GoTavern bench profiles` **42160109620** failure: eight comparisons out of tolerance (-46.8% to -84.3% ns/op, B/op -78.4%), B/op being host-independent proof it was not noise (`docs/alpha16/baseline/README.md:95-120`) | a committed gate input predated an accepted product change; `47da1de`'s "no scheduled gate is left red" was false | CI gains explicit `update_baseline` dispatch input (`05479fa`); baseline regenerated on the Linux host with its raw run and committed (`39cec62`); no code change | `GoTavern bench profiles` **42164978648** success (regeneration) -> **42165562517** success, `comparison: passed`, `failures: 0`, all 31 benchmarks within -8.1%..+1.6% (`docs/alpha16/baseline/README.md:182-186`) | no product change; the gate now describes the tree it names | none | the accepted card-cache win is IN the baseline: `cards_100_640KB_image` B/op 181,622,014 -> 41,035,550 (-77.4%), ns/op 97,246,124 -> 27,743,964 (-71.5%) (`baseline/README.md:185`); the cold-request half is NOT in any artifact (§5.4) |
| **adversarial ratchet** (beyond the five; recorded because it is a fixed M0-observed flake) | `internal/adversarial/startup_cases_test.go` judge + port reservation (M0 tree) | `GoTavern Lane CI` **42162940621** failure: `TestAdversarialInvariants` listener-in-use; same code **42163485576** success | the harness reserved a port before handing it to the product, and the judge blamed the product for a listener precondition | commit `98400d6` (test-only): `freePort` returns 0 so the kernel assigns at bind (`internal/adversarial/support_test.go:55`); `judgeRelativeDataRootFailure` judges the data-root invariant first (`startup_cases_test.go:568`); five new tests | local `go test ./internal/adversarial -count=1`: 35 cases / 29 held / 0 violated / 6 n/a, four consecutive runs green (commit message) | no product change; a real split under a forced collision is still red | none | none |

### 3.3 What was deliberately not refactored (M4)

`docs/alpha16/m4-refactor-decisions.md:49-62` refuses **all six** plan section 6 candidates with the evidence
for and against each: R1 configuration composition, R2 runtime lifecycle, R3 persistence consistency, R4
extension execution/isolation, R5 cache framework, R6 domain split. The rule was: implement only if a named
red test or capture demonstrates a defect whose cause is the boundary being moved; none did. The actionable
residue was routed to bounded fixes (D-H1 threading; C-H6/C-H7/C-H1/C-H8; B-H4 probe; A-H1/A-H2/A-H3/A-H5
probes; C-H11 per-cache witness; D-H17 atomic write) and is carried in section 8.

### 3.4 M3b - the ENOSPC/EFBIG chaos proof (new in this program)

The M3 item "do not label EFBIG as ENOSPC" is closed as a **property proof**, not as a kernel-fault test
(`docs/alpha16-agent-execution-plan.md:99`):

- **Finding first:** the persistence path has no ENOSPC/EFBIG classifier at all; the only transient predicate
  retries a Windows sharing violation and is documented always-false elsewhere
  (`docs/alpha16/m3-chaos-evidence.md:19-41`; `internal/fsretry/fsretry_windows.go:22-34`,
  `internal/fsretry/fsretry_other.go:4-6`).
- **Tests added (commit `53af81c`, test-only):**
  `TestENOSPCAndEFBIGAreNotConflatedInTheRetryPredicate` (`internal/fsretry/fsretry_errno_test.go`) and
  `TestENOSPCAndEFBIGAreNotConflatedInTheAtomicWrite` (`internal/startup/atomic_errno_test.go`); the evidence
  document records the exact code path (write seam `internal/startup/content.go:333-336` called at `:374`,
  fsync `:379-382`, publish `:387` inside `fsretry.Do`, wrapper `internal/startup/user_content_file.go:51-68`)
  and proves neither errno is retried, their identity survives every wrapper (`errors.Is`), and atomicity is
  identical for both (`m3-chaos-evidence.md:45-120`).
- **Mutation teeth:** two temporary mutations were made and restored byte-identically (SHA-256 and
  `git diff --exit-code` recorded): a retry-widening mutation and an error-rewriting mutation each went red at
  the named test (`m3-chaos-evidence.md:123-183`).
- **Gate:** `GoTavern Lane CI` **42244117651** completed/success at `53af81c` (the commit that added the
  tests). The document itself records only local validation (`m3-chaos-evidence.md:3-7`), so the CI id is the
  gate that makes it durable.
- **Residual:** a real kernel ENOSPC remains **UNPROVEN by policy** and is not relabelled as EFBIG; the HTTP
  layer deliberately flattens both to the pinned generic 500 (pinned parity), which is an operator-diagnosis
  gap recorded as residual (`.m3-chaos-evidence.md:186-195,199-227`).

---

## 4. M2 qualification state (the E03+E04 interacting scenario)

### 4.1 Tier state and the final dispatch

The scenario is the `profile=e03e04` form of `.github/workflows/combination-journey.yml`: one browser session,
both subjects, a deterministic 120-block preset, three nested world books, 22 pinned extensions, helper + QR +
regex + variables + group + restart + hand-back, and byte-oriented comparison per capture
(`docs/alpha16/first-scenario-design.md:20-32,73-96`). Only the **full** tier (120 blocks / 22 extensions /
all three books) is release-admissible; fast (12/3) and medium (60/10) are explicitly narrowed
(`docs/alpha16/first-scenario-design.md:119-132`; `docs/alpha16/m6-release-bar.md:392-403`).

**Final state at the candidate:** `Combination journey differential` **42294155456** completed/success with
`profile=e03e04` / `tier=full`, carrying the fixed-name `combination-journey-evidence` artifact whose root
`release-evidence.json` satisfies the manifest rail - `tier: full` and truthy `interactingScenario`, `ok`,
`legs.allRecorded`, `teeth.ok`, `kit.ok`, with the five leg digests
(`docs/alpha16/same-sha-evidence.md:39,47-55`; `docs/release-manifest.json:52-64`). The run includes the M2m
swipe-readiness fix, with `swipe-ready` and `swipe-frontend-race-handled` green and no `endSwipe` page error in
either leg (commit `97e8cde`).

**Durable full-tier record:** `Combination journey differential` **42234426258** (lane `6936291`) recorded
**verdict=match** with `failedGuards []`, 0 capture mismatches, durable chats equal, `restart differences []`,
teeth 49/49 and kit ok. That is the full-tier comparator proof; the final-candidate run above is the
release-admissible one.

**Narrowed fast-tier proof:** `Combination journey differential` **42184268652** **match** - PROVEN for the
fast tier (12 blocks, 3 extensions, all three books) and explicitly not release-admissible
(`docs/alpha16/m6-release-bar.md:339`).

**Superseded full-tier attempts (all harness defects, no product finding):** `42186322374` failure
(`narrative-agent` prompt takeover), `42193009501` failure (ST-Copilot overlay), `42198916430` failure (second
stacked overlay), `42203249658` failure, `42207738114` failure (quiet-generation attribution), `42226736120`
failure (group fan-out), `42230495689` failure (chat projection), `42262745594` and `42267350955` failure
(the M2m swipe race - see §4.3 item 5). Every fix at each cause is one of the thirteen test/workflow-only
commits listed in §2.1.

### 4.2 Evidence rails for the gate, now satisfied

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
- **SHA pinned**: the in-workflow verifier (C5) re-derives the five leg digests and asserts
  `headSha === $GITHUB_SHA`, with SEVEN planted cases run on every e03e04 dispatch (accepts the correct
  document; refuses a well-formed wrong SHA, a malformed SHA, profile=none, fast tier, ok:false and missing
  digests);
- **concurrency**: `cancel-in-progress` is true only for the legacy/push run and false for evidence runs (C6);
- **tier ladder documented** (fast/medium narrowed; full release-admissible; no scheduled trigger) (C7) and the
  kit selftest is executed in-workflow with its log shipped and `kit.ok` feeding the rail (C9).

The final verifier table shows all of these rails satisfied in run `42294155456`
(`docs/alpha16/same-sha-evidence.md:39,47-55`).

### 4.3 Disclosed harness decisions (installed-but-configured-off, overlays, determinism)

These are recorded because they change what the journey measures, and because the alternative (a harness that
silently ignores a takeover) would prove nothing (`docs/alpha16/m6-release-bar.md:314-331`):

1. **`narrative-agent` installed but configured off after wire-proof.** In the full tier the extension hooks
   the prompt-ready event and replaces the chat with its own relay prompt; both subjects behaved identically.
   The journey records the takeover (`extensionTakeover {detected:true, narrative-agent, disabled:true,
   intact:true}`) and disables it through its own settings, keeping the 22-extension install count intact
   (commit `5262039`; `m6-release-bar.md:325-326,340-341`).
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
4. **Group and branch save-timing determinism.** The group turn waits for the full fan-out to quiesce before
   persisting and reading (`924d71a`, M2k), and the branch metadata is persisted before the reload so the
   durable chat projection is deterministic (`6936291`, M2l); the guards are `group-chat-persisted-parity`
   and the chat-projection guard (`m6-release-bar.md:338`).
5. **M2m deterministic-swipe fix.** The full gate failed twice at the frozen-precursor candidate `c509471`
   (`42262745594`, `42267350955`; `Combination journey differential` failures) on exactly one flaky
   client-side page error while every other guard was green: the GoTavern drive leg recorded
   `TypeError: Cannot read properties of undefined (reading 'swipe_id') at endSwipe`, caused by clicking
   `.swipe_right` while the rendered chat and the chat array were incoherent. Commit `97e8cde` adds
   `waitForSwipeReadiness(page)` (bounded 45 s; product state: no active generation, >2 s quiet after the last
   GENERATION_ENDED, numeric swipe_id, DOM count == chat length, single last-mes swipe target, stable signature
   for 1.2 s) and `clickSwipeControl(page)` (re-checks coherence, dispatches the product's own delegated handler
   with the chat-array id). New steps `swipe-ready` and `swipe-frontend-race-handled` are green in
   `42294155456`, with no `endSwipe` error in either leg.
6. **Disclosed limitation:** the configure-off decisions mean the full tier proves the 22-extension
   *coexistence* plus the documented extension effects, not that every installed extension's takeover is
   exercised by the journey (`docs/release-notes-v0.1.0-alpha.16.md:234-237`).

### 4.4 M2 open prerequisites (a full-tier green alone is not the whole claim)

- **Page-init egress is STILL OPEN.** The scenario's hermeticity prerequisite (stage `main_api` + an egress
  allowlist asserted per probe) is recorded as open and no M6 change touched browser egress
  (`docs/alpha16/first-scenario-design.md:143-151`; `docs/alpha16/source-audit.md:233`;
  `docs/release-notes-v0.1.0-alpha.16.md:240-242`). The release claim inherits this open prerequisite.
- The kit's selftest previously existed without an execution step; M6b wired it (C9), so "kit ok" is a real
  executed result in the artifact.
- The live mutation suite must be observed in the same green run, not only the synthetic teeth
  (`m6-release-bar.md:383-384`); the final run's artifact carries the teeth and kit results and the verifier
  requires them (`docs/alpha16/same-sha-evidence.md:53-55`).

---

## 5. M5 performance summary (both directions)

`docs/alpha16/m5-evidence.md` is the M5 evidence document: one row per required metric, every number traced to
a workflow + run + conclusion and an artifact field, improvements and regressions reported both ways, and an
explicit unproven list. It is not the artifacts and not a release gate (`m5-evidence.md:549-556`). This
section adds the two final-candidate runs and points at the M5 document for the numbers.

### 5.1 What was measured (run identities)

| row | workflow | run | conclusion | artifact |
|---|---|---|---|---|
| in-process scale/JSONL/provider assembly (100/1k/10k cards, large JSONL, assemble/marshal) | `GoTavern bench profiles` | **42200357353** | success; `comparison: passed`, `failures: 0`, all **31** benchmarks PASS | `bench-profiles` |
| cold+warm boot, `/version` + `/` latency, RSS, fresh install | `GoTavern smoke metrics` | **42200361137** | success | `smoke-metrics`, `q22-paired-benchmark` |
| same row's M0 "before" | `GoTavern smoke metrics` | **42160114658** | success | `smoke-metrics`, `q22-paired-benchmark` |
| 8-user concurrent writes (BEFORE) | `M5 measurements` | **42212715040** | success; `report.json` `ok:true`, errorRate 0, 144 ops, throughput 287.425 ops/s | `m5-eight-users-evidence` |
| 8-user concurrent writes (AFTER) | `M5 measurements` | **42247840229** | **fail-closed red under the BEFORE x1.25 ceiling - unratified-threshold repeatability finding, not a product regression (§5.3)** | `m5-eight-users-evidence` |
| 30-60 min soak, retired-statistic runs | `M5 measurements` | **42209244735**, **42226780977** | both completed/failure under the retired LS rule; both flat under the corrected per-thirds rule | `m5-soak-evidence` |
| 30-60 min soak, same-candidate run | `M5 measurements` | **42247845380** | **completed/success** under the corrected GC-robust rule | `m5-soak-evidence` |

All rows and the artifact fields are tabulated at `docs/alpha16/m5-evidence.md:16-24`; the two final runs are
recorded in `docs/alpha16/m5-evidence.md:558-599` (the same-candidate additions, both directions).

### 5.2 Both directions (summary; numbers live in m5-evidence.md)

- **Bench rows (31/31 PASS):** improvements e.g. `BenchmarkStaticPageLoad` -10.8%, `ChatCompletion
  Assemble/scaled_1MB` -6.8%, `CharactersAllScale/cards_1000_32KB_image` -3.7%; regressions are all small and
  inside the ratified two-sided tolerances, e.g. `BenchmarkFrontendIndex` +0.7%, `BenchmarkFrontendAsset`
  +0.5% (`m5-evidence.md:51-84`; `docs/release-notes-v0.1.0-alpha.16.md:130-142`). The comparison is against the
  regenerated baseline at `05479fa`, so the alpha.15 card-cache win is **in the baseline** and is not re-earned
  by this run (`m5-evidence.md:99-113`).
- **Product row (new vs M0):** cold start -> `/version` **-70.2%** (917.25 -> 273.59 ms), cold -> listener
  **-78.6%**, warm start -7.9%, fresh-install seeding byte-identical (203 files / 16,169,121 B). **Regressions
  are reported too:** `/version` p50 **+25.7%**, p95 **+14.2%**, max **+95.6%**, `/` p50 **+23.3%**, warm
  start-to-listen +4.6%, warm RSS +5.5%; the two p50s exceed the PROVISIONAL ceilings but those are not
  ratified gates (`m5-evidence.md:131-160`; `docs/release-notes-v0.1.0-alpha.16.md:143-153`).
- **8-user BEFORE:** per-route p95 `/api/settings/save` 65.3 ms, `/api/settings/get` 38.9 ms, `/api/chats/save`
  87.7 ms; throughput 287.425 ops/s; isolation checks green (each account wrote/read its own marker only)
  (`m5-evidence.md:224-236`; `docs/release-notes-v0.1.0-alpha.16.md:154-161`). The AFTER exists now and is
  discussed in §5.3.
- **Soak:** two real 45-minute runs produced LS slopes +39.8 B/s and +885.1 B/s on flat data (22x apart),
  because the LS slope is phase-aliased to GC boundaries; the corrected gate fails on per-third mean/GC-floor
  (`m5-soak/mean-rise`, `m5-soak/floor-rise`), passes both real runs and fails a synthetic monotone leak by
  name while passing a provably flat sawtooth (`m5-evidence.md:271-358`;
  `docs/release-notes-v0.1.0-alpha.16.md:162-177`). The same-candidate soak `42247845380` is **success** under
  the corrected rule, the row's first same-commit green (`m5-evidence.md:565-576`). The real-leak question
  remains **UNPROVEN**: the tolerance is a detection floor, not a leak-free certificate
  (`m5-evidence.md:360-378,540-547`).

### 5.3 The 8-user AFTER red: an unratified-threshold repeatability finding, not a product regression

`M5 measurements` **42247840229** is a **fail-closed red** under the BEFORE x1.25 ceiling: the job fails by
name (`threshold/settingsSave-p95`, `threshold/chatsSave-p95`) and exits non-zero (the workflow's fail-closed
threshold gate, `.github/workflows/m5-measurements.yml:29-34,83-84,171-222`). The measured AFTER values against
the BEFORE ceilings, as recorded in `docs/alpha16/m5-evidence.md:577-599` (BEFORE artifact from run
`42212715040`; 48 routes each, 6 waves, error rate 0 both sides):

| route | BEFORE p95 | AFTER p50 / p95 | AFTER vs BEFORE x1.25 ceiling | verdict |
|---|---|---|---|---|
| settings save (`settingsSave`) | 65.35 ms | 111.26 / **339.31 ms** | 81.68 ms | **FAIL** `threshold/settingsSave-p95` (~4.15x ceiling) |
| settings get (`settingsGet`) | 38.93 ms | 25.17 / 36.13 ms | 48.66 ms | inside |
| chat save (`chatsSave`) | 87.73 ms | 278.20 / **614.83 ms** | 109.66 ms | **FAIL** `threshold/chatsSave-p95` (~5.61x ceiling) |
| throughput | 287.425 ops/s | **49.844 ops/s** | - | ~17% of BEFORE (-82.7%) |

**How to read it (the honest reading):**

- It is **not** a product regression claim. The threshold it failed is **UNRATIFIED**: it is one BEFORE record
  from one shared-runner instance, and M5's own evidence document already records that no provisional row is
  ratified (`docs/alpha16/m5-evidence.md:437-470,444-451`; `docs/release-notes-v0.1.0-alpha.16.md:203-204`).
  A single cross-instance comparison cannot separate a product change from runner contention, load, or a cold
  cache; the candidate differs from the BEFORE commit only in tests, harness and documentation.
- It is a **repeatability finding**: the absolute gap (2-7x the BEFORE p95s) is far outside the +-25% band the
  row was designed to detect, and the row's own lesson is that a threshold derived from one unratified run is
  not a gate. The red is kept as the fail-closed evidence that the threshold mechanism works, not suppressed or
  re-run until green (`m5-evidence.md:592-599`).
- What closes it: a **same-image, repeated-pair measurement** - multiple BEFORE runs on quiet runners at the
  base commit, then the AFTER run against the spread, enough to estimate the row's own noise, then ratify or
  re-derive the ceiling before any ratio is read as a product signal. Until then the row stays
  **PARTIAL/UNPROVEN for the pair** (`m5-evidence.md:240-260,388-389`).
- The release notes carry the pre-AFTER wording ("The 8-user AFTER run has not been made",
  `docs/release-notes-v0.1.0-alpha.16.md:203-204`); the note must be refreshed to this finding before
  publication (a content edit, not a gate failure).

### 5.4 M5 gaps (named, not implied)

Streaming-cancellation performance (no TTFB/inter-frame/cancel metric); real provider-relay p99 under load;
20-extension page load has no gate and no baseline; the 8-user AFTER is a **red under an unratified threshold**
(§5.3) and needs the repeated pair; the soak's same-commit pair is still not ratified even though a
same-candidate run passed; no `benchstat`; p99 for row 1 not collected; process-level scale row not
dispatched; cold-guard benchmark row absent from the committed baseline; `ENOSPC` unproven; all absolute
numbers runner-relative and same-image only (`docs/alpha16/m5-evidence.md:471-511`; residual risks
`:513-547`; the two final runs are recorded in `:558-599`). Artifact retention is **30 days** for every cited
artifact, which is why this document exists as the durable summary (`m5-evidence.md:526-531`).

---

## 6. M6 release state

### 6.1 Candidate, tag state, and the bar

- **Candidate:** `6e96959` (`main`, the frozen candidate, 2026-11-06), version `v0.1.0-alpha.16`. It is the
  tree that includes the M3b chaos tests (`53af81c`), the darwin/arm64 recorded downgrade (`75ea96e`,
  `b548687`), the macos-arm64 extension-gate limitation (`c509471`), the M2m deterministic-swipe fix
  (`97e8cde`) and the regenerated compatibility matrix (`6e96959`).
- **Tag state: NO alpha.16 tag exists and none was moved.** The rehearsal is a qualification, not a
  publication: `git tag --list 'v0.1.0-alpha.16*'` is empty and the newest tag is `v0.1.0-alpha.15`. The tag
  classifier graduation is committed (`scripts/classify-version-tag.sh:92` now includes
  `v0.1.0-alpha.16`, commit `a54db37`), so a future authorized tag will classify as stable rather than
  prerelease, but no tag object was created.
- **No release was published.** The `GoTavern Release` dry run (`42294172571`, completed/success) is a
  dispatch: its tag-only publish steps were skipped and no release was created
  (`docs/alpha16/same-sha-evidence.md:68-72`). The rehearsal proves the publish gate **can** publish; the
  program stopped at qualification.
- **The bar:** thirteen required same-SHA gates in `docs/release-manifest.json` (`requiredGates`, lines 5-97;
  `sameShaRequired: true` line 3), each `workflow_dispatch`-only, verified by the fail-closed verifier, which
  requires the run's `head_sha` to equal the tag target and - where the rails exist - the required jobs,
  fixed-name artifact and embedded `release-evidence.json` (`m6-release-bar.md:103-123`). Alpha.15 proved the
  mechanism (13/13 at `95638da`, `PASS 13/13`; `HANDOFF.md:45-66`); alpha.16 has now produced the evidence at
  its own candidate.

### 6.2 The thirteen required-gate dispatches at `6e96959` - all completed/success

Every row is a `workflow_dispatch` at the candidate, completed/success, and the arrangement is the verifier's
own committed table (`docs/alpha16/same-sha-evidence.md:28-45`). Selections are recorded because the verifier
cannot see dispatch inputs (`docs/alpha16/m6-release-bar.md:253-256`; M0 finding E-H1 still open); the
rehearsal's own row-by-row selections are at `docs/alpha16/m6-rehearsal.md:37-51`.

| # | gate (manifest) | workflow name | final run id | selection | required rails | verdict |
|---|---|---|---|---|---|---|
| 1 | GoTavern CI | `GoTavern CI` | **42294114075** | empty `probes` = full oracle | - | **completed/success** |
| 2 | whole-session | `GoTavern whole-session differential` | **42294118964** | no inputs | - | **completed/success** |
| 3 | world-info slot ordering | `GoTavern world-info slot ordering` | **42294123412** | no inputs | - | **completed/success** |
| 4 | drop-in qualification | `GoTavern drop-in qualification` | **42294127433** | no inputs | - | **completed/success** |
| 5 | Browser differential | `Browser differential` | **42294131712** | `mode=all` | - | **completed/success** |
| 6 | release qualification | `GoTavern release qualification` | **42294137094** | dispatch (not tag push) | - (gate #6 evidence-rails gap remains, §8 row 21) | **completed/success** |
| 7 | smoke metrics | `GoTavern smoke metrics` | **42294141379** | `requests=50` | - | **completed/success** |
| 8 | Docker image | `GoTavern Docker image` | **42294146024** | no publish input required | - | **completed/success** |
| 9 | Helper state differential | `Helper state differential` | **42294150962** | no inputs | - | **completed/success** |
| 10 | Combination journey differential | `Combination journey differential` | **42294155456** | `profile=e03e04`, `tier=full`, extension tier follows | `combination-journey` job; `combination-journey-evidence`; tier full + truthy interactingScenario/ok/legs.allRecorded/teeth.ok/kit.ok + five digests | **completed/success** |
| 11 | Third-party extension compatibility | `Third-party extension compatibility` | **42294159806** | `mode=full` | `extension-compat-evidence` carrying `macos-arm64-platform-limitation.json` | **completed/success** |
| 12 | long-lived corpus | `GoTavern long-lived corpus qualification` | **42294164369** | `size=medium` | `medium-corpus` job; `longlived-medium-evidence` (tier medium, embedded truthy fields + digests) | **completed/success** |
| 13 | Node stock-tree round trip | `GoTavern Node stock tree round trip` | **42294168373** | no inputs | `node-stock-tree` job; `node-stock-tree-evidence` | **completed/success** |

The verifier table's `required jobs`/`evidence` columns confirm the four artifact-bearing gates
(`docs/alpha16/same-sha-evidence.md:39-42`), and the committed document states what the table proves and does
not prove (`:47-62`).

### 6.3 The verifier: command, recorded output, and what it can and cannot see

The publish job runs the same verifier the rehearsal ran (`docs/alpha16/same-sha-evidence.md:6-19`;
`docs/alpha16/m6-rehearsal.md:17-54`):

```bash
node scripts/verify-release-gates.mjs \
  --sha 6e96959 \
  --manifest docs/release-manifest.json \
  --evidence-out <path>
```

Recorded outcome: **exit status `0`**, the full 13-row table, and the exact line
`**PASS**: 13/13 required workflow(s) are green at this SHA.`
(`docs/alpha16/same-sha-evidence.md:19-45`; the exact string also at
`scripts/verify-release-gates.mjs:122`). The committed copy at `docs/alpha16/same-sha-evidence.md` is the
authoritative table; this ledger cites it rather than restating it as a hand-written checklist.

**What the verifier cannot see:** dispatch inputs (`gates.mjs:142-153`), and - for the gates that name no
artifact/evidence - anything inside the run (`m6-release-bar.md:118-123,249-256`). The selections are
therefore recorded in §6.2, and the narrowed-dispatch rail (M0 E-H1) remains an open bar improvement.

### 6.4 The release dry run and the notes/checksums scope

`GoTavern Release` **42294172571** completed/success at the same candidate: six build jobs green, and
`execute-darwin-amd64`, `execute-linux-arm64`, `windows-arm64-boundary`,
`darwin-arm64-recorded-downgrade`, `prepublish-qualification` and `publish` all green with every tag-only
publish step skipped (no release created); `post-release-facts` skipped because nothing was published; the
`darwin-arm64-platform-limitation` artifact present (`docs/alpha16/same-sha-evidence.md:64-72`;
`docs/alpha16/m6-rehearsal.md:66-93`). A dry run is the release path exercised without a tag, so the
fail-closed verifier, the notes/checksums validation and the prepublish qualification ran; the tag-only
publish act itself did not.

The release note is committed (`docs/release-notes-v0.1.0-alpha.16.md`, commit `a54db37`; 278 lines) in the
alpha.15 shape with a non-empty performance section (`:125-177`), compatibility (`:179-187`), known
limitations (`:189-249`), artifacts (`:251-266`) and evidence (`:268-278`). It passed the note validation in
the green dry run, including the graduated-tag classifier (suite 64/64) and the darwin/arm64 + macos-arm64
limitation lines the publish gate requires (`docs/alpha16/m6-rehearsal.md:95-106`). **It predates the final
M5 AFTER/soak results and the release verdicts**, so before an authorized publication it must be refreshed to
cite the final run ids and the §5.3 finding (a content edit, not a gate failure) - that refresh is a
publication-scope item, not part of this qualification.

### 6.5 The superseded waves, and why the candidate moved

- **First wave (at `9f6a76e`/`a54db37`) and second wave (at `97e8cde`)**: both are recorded in
  `docs/alpha16/m6-rehearsal.md:56-64`. In the first wave 8 gates were green before the candidate moved; the
  second was superseded by the compatibility-matrix regenerate because its GoTavern CI verify job correctly
  refused a stale derived-count claim.
- The candidate moved because the program landed, after those waves: the M3b ENOSPC/EFBIG tests (`53af81c`),
  the darwin/arm64 recorded downgrade (`75ea96e`, `b548687`), the macos-arm64 extension-gate limitation
  (`c509471`), the M2m deterministic-swipe fix (`97e8cde`) and the regenerated compatibility matrix
  (`6e96959`). A same-SHA gate cannot be inherited across a candidate move, so the final wave at `6e96959`
  is the only one that counts.

### 6.6 Recorded platform limitations (disclosed, not waived)

1. **darwin/arm64 runtime execution is UNPROVEN; the release path records a platform limitation.** The
   platform stopped provisioning the arm64 macOS runner configuration: `The configuration
   'macos-14-arm64-us-default' is not supported` (the same label succeeded five times on 2026-11-05). Commit
   `75ea96e` replaced `release.yml`'s `execute-darwin-arm64` with `darwin-arm64-recorded-downgrade`
   (ubuntu-latest), which proves a thin arm64 Mach-O and the build contract, records the platform refusal and
   emits the fixed-name `darwin-arm64-platform-limitation` marker; `publish` requires the marker **and** a
   curated notes line stating darwin/arm64 is NOT runtime-qualified, and refuses `missing-marker`,
   `mach-o-not-arm64`, `archive-sha-mismatch` and `notes-limitation-missing` by name
   (`docs/release-governance.md:143-253`; `docs/alpha16/m6-release-bar.md:428`;
   `docs/release-notes-v0.1.0-alpha.16.md:211-222`). No `continue-on-error` exists.
2. **macos-arm64 extension lifecycle is UNPROVEN; recorded as a limitation inside the extension gate.**
   Commit `c509471` replaced `third-party-extension-compat.yml`'s `macos-14` leg with
   `macos-arm64-recorded-limitation`, whose machine-readable marker is carried inside
   `extension-compat-evidence` (the artifact named in the verifier row for gate #11) and which the aggregate
   job refuses to omit or contradict; the representative cross-platform legs that still run are
   windows-amd64 and macos-amd64 (`docs/release-governance.md:143-253`;
   `docs/release-notes-v0.1.0-alpha.16.md:223-231`). The release-governance suites that police both markers
   pass 69/69 (commit `c509471`; `scripts/release-governance.test.mjs`).
3. **windows/arm64 remains build-only** (no hosted runner), asserted as a boundary
   (`docs/release-notes-v0.1.0-alpha.16.md:232-233`).

The final dry run's `darwin-arm64-recorded-downgrade` green plus the marker artifact is the positive evidence
that the downgrade path is what executes; the runtime itself is not executed and no claim says otherwise.

---

## 7. Final release conclusion

**MET - the alpha.16 release bar is met at candidate `6e96959` within the synthetic adversarial qualification
scope.** Concretely, and each element is evidenced above:

- all **13 required same-SHA gates** are completed/success at `6e96959` (verifier table,
  `docs/alpha16/same-sha-evidence.md:28-45`);
- the **official fail-closed verifier** returned exit `0` and printed
  `**PASS**: 13/13 required workflow(s) are green at this SHA.` (`docs/alpha16/same-sha-evidence.md:19-45`);
- the **release dry run** `GoTavern Release` **42294172571** is completed/success with the publish path green
  and the darwin/arm64 recorded-downgrade marker present, and no release created
  (`docs/alpha16/same-sha-evidence.md:64-72`);
- the **notes/checksums scope** ran in that dry run (`docs/alpha16/m6-rehearsal.md:95-106`), and the committed
  note carries a non-empty performance section and every disclosed limitation
  (`docs/release-notes-v0.1.0-alpha.16.md:125-177,189-249`).

**The limits of the conclusion, stated in the same breath:**

- **`GOAL.md` section 14 - the real private-tree drop-in claim - remains NOT MET.** The release bar met here
  is the synthetic adversarial qualification; it is not universal drop-in proof (`GOAL.md:452`;
  `docs/release-notes-v0.1.0-alpha.16.md:193-196`).
- **macOS arm64 runtime execution remains UNPROVEN.** The path records a platform limitation and refuses to
  publish without it; it does not execute darwin/arm64 and does not claim to (`§6.6`;
  `docs/release-notes-v0.1.0-alpha.16.md:211-222`). The macos-arm64 extension lifecycle is likewise UNPROVEN
  and disclosed (`:223-231`).
- **NO tag was created or moved, and NO release was published.** The rehearsal proves the publish gate can
  publish; the program stopped at qualification. Publication is a separate, authorized act: refresh the
  release note to the final M5 facts (§5.3, §6.4), create and push `v0.1.0-alpha.16` at `6e96959` (the publish
  job re-runs the same verifier against the tag target), then run the post-publication checks (archive
  re-download + checksums, container digest equality, install smoke, published-extension smoke, post-release
  CI) and confirm the tag did not move.
- **What may be claimed today:** a synthetic adversarial qualification of the alpha.16 candidate, evidenced
  by 13 same-SHA gates, a fail-closed verifier PASS, a green dry run, five M0 defects fixed by minimal change,
  a full-surface audit, and both-direction performance evidence with its limitations named.
- **What may not be claimed:** a published alpha.16 release, universal drop-in parity, any real-private-tree
  qualification, or darwin/arm64 runtime qualification.

---

## 8. Residual risk register and follow-ups

Open items at `6e96959`. Each names its evidence and what closes it; none is a refactor (M4 refused all six,
§3.3).

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
| 14 | **Streaming-cancel performance** has no TTFB/inter-frame/cancel-to-idle metric (functional gates only) | `docs/alpha16/m5-evidence.md:471-474,390`; `docs/release-notes-v0.1.0-alpha.16.md:197-198` | a provider peer that streams slowly, then a threshold recorded before measuring |
| 15 | **Real provider-relay p99 under load** is unmeasured (bench rows are in-process assemble/marshal) | `docs/alpha16/m5-evidence.md:475-476`; `docs/release-notes-v0.1.0-alpha.16.md:199-200` | a relay through `internal/outbound` under concurrency with a controlled peer |
| 16 | **macOS arm64 runtime UNPROVEN** (recorded downgrade) and **macos-arm64 extension lifecycle UNPROVEN** (recorded limitation); windows/arm64 build-only | `docs/alpha16/m6-release-bar.md:428`; `docs/release-notes-v0.1.0-alpha.16.md:211-233`; `docs/release-governance.md:143-253` | a real arm64 macOS runner restores execution mode and its evidence is then required; the limitation markers refuse omission in the meantime |
| 17 | **Soak pair NOT RATIFIED**: the same-candidate soak `42247845380` succeeded under the corrected rule as the row's first same-commit green, but the row's two-run ratification procedure is still not performed; a leak below the +10% mean / +4 MiB floor over 45 min is invisible | `docs/alpha16/m5-evidence.md:360-378,437-470,540-547,565-576`; `docs/release-notes-v0.1.0-alpha.16.md:205-208`; `docs/alpha16/m6-rehearsal.md:128-131` | two same-SHA clean-tree soak dispatches with the corrected rule; report both ids |
| 18 | **8-user AFTER red under an UNRATIFIED threshold** - a repeatability finding, not a product regression (§5.3) | `M5 measurements` **42247840229** failure (`threshold/settingsSave-p95`, `threshold/chatsSave-p95`); BEFORE artifact run `42212715040`; `docs/alpha16/m5-evidence.md:240-260,577-599`; `docs/alpha16/m6-rehearsal.md:128-131` | same-image repeated BEFORE/AFTER pairs, then ratify or re-derive the ceiling; no product conclusion before that |
| 19 | **Evidence-artifact retention is 30 days** for every cited artifact; this ledger and the M5/M6 documents are the durable summary | `docs/alpha16/m5-evidence.md:526-531`; `.github/workflows/bench-profiles.yml:117,128`, `smoke-metrics.yml:194`, `m5-measurements.yml:228,414,533` | re-download artifacts into durable evidence documents before expiry |
| 20 | **Publication-scope items**: release note refresh to the final M5/rehearsal facts; tag creation + push by an authorized actor; post-publication checks (checksums re-download, container digest equality, install smoke, published-extension smoke, post-release CI, tag immovability) | `docs/release-notes-v0.1.0-alpha.16.md:203-204` (AFTER wording stale); this ledger §6.4/§7; `docs/alpha16/m6-release-bar.md:260-280` | the authorized release act; none of it was performed by the rehearsal |
| 21 | **M6 bar improvements still open**: gate #6 (`GoTavern release qualification`) has no fixed-name evidence contract, so the verifier sees only the conclusion; ten gates cannot be checked for narrowed dispatch by the verifier (E-H1) | `docs/alpha16/m6-release-bar.md:154-172,253-256`; `docs/alpha16/same-sha-evidence.md:47-62` | release-evidence contract for gate #6; selection marker in each gate's evidence (both documented, both out of this qualification's scope) |
| 22 | **M1's own commit still has no recorded CI run id**; the M5 AFTER ratio and the soak pair remain unratified | §2.2; §5.3-§5.4 | cite a Linux CI run for M1; ratify the two M5 rows |
| 23 | **Page-init egress hermeticity is OPEN**; the scenario's browser page initialisation can reach the live network | `docs/alpha16/first-scenario-design.md:143-151`; `docs/alpha16/source-audit.md:233`; `docs/release-notes-v0.1.0-alpha.16.md:240-242` | stage it away or record an explicit allowlist; the decision is still pending |

---

## 9. How to reproduce every cited run family and find its artifacts

Dispatch commands are the committed documents' own; nothing below was executed by this task.
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
gh workflow run combination-journey.yml --ref main \
  -f profile=e03e04 -f tier=full -f extension_tier=full
# artifacts: combination-journey-evidence (legs/*.json, extension-seed.json, release-evidence.json at root,
#            e03e04-kit-selftest.log) - retention 30 days
gh run download <id> -n combination-journey-evidence -D /tmp/cj
# the gate's synthetic teeth and the kit contract (also executed in-workflow since M6b)
node tests/browser/combination-journey-gate-selftest.mjs
node tests/browser/extensions/e03e04-kit-selftest.mjs
```

Sources: `docs/alpha16/first-scenario-design.md:55-72,112-117`; `docs/alpha16/m6-release-bar.md:293-308,350-390`;
`.github/workflows/combination-journey.yml:29-72,77-79,246-257,293-358`. The final run is `42294155456`; the
durable full-tier comparator record is `42234426258` (§4.1).

### 9.4 M3 differential / oracle re-record / ratchet / soak-gate teeth / M3b chaos

```bash
# narrowed one-probe oracle dispatch used to re-record the four provider-wire scenarios
gh workflow run ci.yml --ref <ref> -f probes=probe-provider-wire.mjs
# adversarial ratchet
go test ./internal/adversarial -count=1
# M3b: the two named chaos tests (exact names, -count=1)
go test ./internal/fsretry  -count=1 -run '^TestENOSPCAndEFBIGAreNotConflatedInTheRetryPredicate$' -v
go test ./internal/startup  -count=1 -run '^TestENOSPCAndEFBIGAreNotConflatedInTheAtomicWrite$' -v
go test ./internal/fsretry ./internal/startup -count=1
# soak verdict teeth (local validation; the workflow change is commit 9f6a76e)
gh run download 42209244735 -n m5-soak-evidence -D /tmp/soak1
gh run download 42226780977 -n m5-soak-evidence -D /tmp/soak2
```

Sources: commit `fa5385f` (the re-record closes the `GoTavern CI` **42187779109** narrowed dispatch);
`98400d6`; `docs/alpha16/m3-chaos-evidence.md:231-247`; `docs/alpha16/m5-evidence.md:346-358,26-33`.

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
# row 5: 8-user BEFORE (42212715040) and the AFTER under its ceiling (42247840229, red - §5.3)
gh workflow run m5-measurements.yml --ref <branch> -f which=eight-users -f users=8 -f waves=6
gh workflow run m5-measurements.yml --ref <branch> -f which=eight-users -f users=8 -f waves=6 \
  -f thresholds_from_run=42212715040 -f load_label="M5 after: <who/what>"
# row 8: soak (corrected per-thirds gate; the candidate run is 42247845380)
gh workflow run m5-measurements.yml --ref <branch> -f which=soak -f soak_minutes=45
# artifacts: bench-profiles, smoke-metrics, q22-paired-benchmark, m5-eight-users-evidence, m5-soak-evidence,
#            m5-scale-evidence; every one 30-day retention (m5-evidence.md:526-531)
```

Sources: `docs/alpha16/m5-measurement-plan.md:284-315`; `docs/alpha16/m5-evidence.md:26-33,240-260,444-469`;
`.github/workflows/m5-measurements.yml:29-34,83-84,171-222`. A before/after pair must share runner image
label+version, Go version and GOMAXPROCS; a moved image version is NOT-COMPARABLE and the before is re-taken
(`docs/alpha16/m5-measurement-plan.md:339-342`).

### 9.6 M6 release qualification: gates, verifier, dry run, and (later) the authorized publication

```bash
candidate=6e96959          # the seven-character candidate form; the gate refuses a non-pinned 40-hex
# 1) the 13 required gates, deliberately dispatched at the candidate with full selections
gh workflow run ci.yml                      --ref main -f probes=
gh workflow run whole-session.yml           --ref main
gh workflow run worldinfo-slots.yml         --ref main
gh workflow run dropin-qualification.yml    --ref main
gh workflow run browser-differential.yml    --ref main -f mode=all
gh workflow run release-qualification.yml   --ref main
gh workflow run smoke-metrics.yml           --ref main -f requests=50
gh workflow run docker.yml                  --ref main
gh workflow run helper-state.yml            --ref main
gh workflow run combination-journey.yml     --ref main -f profile=e03e04 -f tier=full -f extension_tier=full
gh workflow run third-party-extension-compat.yml --ref main -f mode=full
gh workflow run longlived.yml               --ref main -f size=medium
gh workflow run node-stock-tree.yml         --ref main
# 2) the same verifier the publish job runs (recorded PASS in docs/alpha16/same-sha-evidence.md)
node scripts/verify-release-gates.mjs --sha 6e96959 \
  --manifest docs/release-manifest.json --evidence-out /tmp/same-sha-evidence.md
# expected: exit 0 and "**PASS**: 13/13 required workflow(s) are green at this SHA."
#           (scripts/verify-release-gates.mjs:122)
# 3) the dry run (a dispatch never publishes)
gh workflow run release.yml --ref main -f ref=6e96959 -f candidate_version=v0.1.0-alpha.16
# 4) the platform-limitation suites that police the darwin/arm64 and macos-arm64 markers
node --test scripts/release-governance.test.mjs            # 69/69 (commit c509471)
node scripts/release-notes.mjs --check docs/release-notes-v0.1.0-alpha.16.md   # (the publish path's notes check)
# 5) only after an authorized refresh of the note and a re-run of 1-4: tag push (the publish job re-runs the
#    verifier at the tag target; no override exists)
git tag -a v0.1.0-alpha.16 -m "GoTavern v0.1.0-alpha.16" 6e96959 && git push origin v0.1.0-alpha.16
# 6) post-publication
gh run download <install-smoke-run> -n smoke-metrics-out
gh run download <published-extension-run> -n published-extension-smoke-linux
git rev-parse v0.1.0-alpha.16^{commit}      # must equal 6e96959 (no tag move)
```

Sources: `docs/alpha16/m6-rehearsal.md:17-106`; `docs/alpha16/same-sha-evidence.md:6-19,64-72`;
`docs/alpha16/m6-release-bar.md:199-280`; `docs/release-governance.md:143-253`. The final run ids per gate
are in §6.2; the earlier waves are superseded (§6.5). Artifact locations are the fixed-name artifacts named in
`docs/release-manifest.json` (combination, extension-compat, longlived-medium, node-stock-tree) and the
downloads named in §9.5; all CI artifacts have 30-day retention, so a release evidence document must be
committed from them before they expire.

---

## 10. How this revision was validated

- **Document gates:** `go test ./internal/fixtures -count=1` (the gate that pins commit citations, the pinned
  oracle and the document contract).
- **Generated facts:** `node tools/generate-doc-facts.mjs --check` (the derived facts must match the tree).
- **Encoding and hash rules:** strict UTF-8 decode, no BOM, no replacement characters, and no forty-character
  commit other than the pinned oracle (`06bde939…`); the candidate appears only as `6e96959`.
- **Patch hygiene:** `git diff --check` (no whitespace errors). No git commit was made by this task; the Lead
  commits. No workflow was dispatched by this task; all run ids cited here are recorded from the committed
  verifier table and the run records named beside them.

## 11. The final engineering pass (2026-11-07): five defects closed, one qualification lane added

Sections 1-10 record the alpha.16 programme as a qualification that stopped before publication. This section
records the final pass that closed the defects the M0 audit had left as bounded follow-ups, added the seeded
E06 state-machine lane, and produced the candidate that was released. Every fix below was red-first in its
own lane worktree; the merges are on `main` and the per-lane commits are named.

### 11.1 Confirmed defects closed

| id | file:line (pre-fix) | observed red (test, exact failure) | fix | green | residual |
|---|---|---|---|---|---|
| D-H1 | `internal/server/pinned_chat_config.go:35-45` derived config.yaml from the data root | `TestChatCompletionProviderConfigFollowsTheStartupResolvedConfigPath` 7 subtests red with the old derivation: decoy placeholder in the claude body, `thinking {"type":"enabled","budget_tokens":1024}` instead of adaptive, google target `/v1beta/` instead of `/v1/`, spurious `reasoning_details`, no `cache_control`, no mistral `prefix:true`, no OpenAI uuid; `...IgnoresADecoyAtTheDerivedLocation` red with "carries the DECOY config.yaml" | thread `commandline.Paths.ConfigFile` through `HTTPHandlerOptions.ConfigPath` -> `chatCompletionRequest.configPath` -> the config-reading planners; a non-empty resolved path is the ONLY file read; second registry adapter feeds claude+mistral, google/openrouter/openai read `request.config()`; claude caching knobs take the same view | commit `acad078`; `go test ./internal/server ./internal/app -count=1` green (217.0 s / 79.2 s) | `requestOverrides` still reads the directory view, but it serves the text-completion backends, not the chat route |
| C-H1 | `internal/server/accounts.go:115-200` never evicted a limiter key | `TestMemoryLoginLimiterEvictsExpiredWindows` red: "after all 10000 windows expired, the limiter still holds 10001 entries"; pinned's `rate-limiter-flexible` MemoryStorage deletes each key with a per-key timeout (`node_modules/rate-limiter-flexible/lib/component/MemoryStorage/MemoryStorage.js:30-50,68-82`) | expiry FIFO swept on consume/exceeded (amortised O(1), stale-record safe); consume/exceeded/clear return values and timing unchanged | commit `a2fc2e5`; 10k-key bound + honest-window/clear regression green | eviction is lazy: a process with no further limiter traffic keeps one expired window set until the next operation (bounded by the previous window's key set, no timer or goroutine added) |
| C-H6 | `internal/app/heartbeat.go:68-85` `stop()` took the IO mutex and joined with no bound | `TestHeartbeatStopIsBounded` red: "RunningServer.Close blocked for more than 2s on a heartbeat write stuck in fsync: the shutdown wait is unbounded"; pinned writes heartbeat.json synchronously with an unref'd interval and its SIGINT path is `process.exit()` with no join (`src/server-main.js:316-331,397-417`), so the join was a GoTavern addition | atomic stopped flag published before the stop signal; `stop(ctx)` never takes the write mutex, joins under the caller's shutdown context and returns the named `ErrHeartbeatStopTimeout`; `RunningServer.Close` passes its ctx and joins the error; no write starts after stop reports success | commit `a2fc2e5`; bounded named failure + 20-cycle prompt stop + fast double-stop + goroutine bound + no-write-after-stop, all green | a truly wedged fsync still pins the single writer goroutine; shutdown now reports it by name and ends instead of hanging |
| C-H7 | `cmd/gotavern/main.go:355-382` message overclaimed | `TestSecondSignalDuringDrainForcesExit130` red: "still claims closing listeners aborts in-flight requests"; `TestListenerCloseDoesNotAbortInFlightRequest` shows the keep-alive request completes after listener.Close, `TestProcessExitAbortsInFlightRequest` shows the exit 130 aborts it | message corrected to say listeners close now, requests continue until the up-to-10 s drain, then exit 130 aborts them; behaviour (forcedShutdown/130) unchanged | commit `a2fc2e5`; all three tests green | a second Ctrl+C still does not shorten the deferred 10 s drain; the fix is the message, not an invented behaviour |
| C-H8 | `.github/workflows/ci.yml:683` race package list | the list omitted the two packages that own shared state | `./internal/app` and `./internal/lockacquire` added | commit `a2fc2e5`; both packages' tests pass; `-race` runs on linux/amd64 only (this host answers "-race is not supported on windows/arm64"), so the Linux CI race job is the gate | none |
| D-H17 | `internal/server/tokenizers.go:371-390` wrote the cache in place | `TestTokenizerCacheWriteFailureLeavesThePreviousCacheOrNothing` red: "a failed tokenizer cache write left a 2377322-byte file ...; the complete payload is 4754645 bytes"; `...PreservesThePreviousCompleteFile` red: "replaced the previous complete 33-byte file with 32768 bytes"; `...ReaderNeverObservesPartialBytes` red: "a concurrent reader observed 65536 cache bytes that are not a complete payload"; pinned uses `write-file-atomic` (`src/endpoints/tokenizers.js:9,116,136,140`) | unique same-directory temp O_CREATE|O_EXCL -> seam write -> fsync -> close -> rename (via fsretry) -> directory fsync; destination never opened for truncation; a cache-write failure falls back to llama3 exactly where pinned's `getPathToTokenizer` catch does (`:144-146`) | commits `2b43f33` (fix) and `0e3bec1` (B-H4 probe); tokenizer suite 27.4 s green, full `internal/server` 283.6 s green | Windows-only: the pinned console.error on the fallback is not emitted (the tokenizer path carries no logger); `.gz` unlink failure is ignored instead of falling back (both documented in source) |

### 11.2 The B-H4 probe: no lock added, because no Go-only divergence was shown

`internal/server/account_reset_save_race_test.go` races eight settings/chats writer goroutines for two users
against the real `/api/users/reset-step2` over three seeds, with a concurrent reader (opened with Node's own
share modes after the first probe version manufactured the very reset failure it measured) and out-of-tree
sentinels. Result: no torn or corrupt JSON/JSONL during or after the storm, no cross-user data, the account
store and unrelated files byte-identical, only the reset user's tree removed, every save answered 200 or 500,
post-reset saves 200 for both users. Pinned's reset is `await fsPromises.rm(root,{recursive:true,force:true})`
plus reseed (`src/endpoints/users-private.js:288-292`) while saves are synchronous atomic writes
(`settings.js:206-214`, `chats.js:541,545-566`), so the same rm-then-repopulate window exists upstream: verdict
**pinned-parity interleaving, NO locking added** (R3's bar is a Go-only data-destruction difference).
`docs/alpha16/storage-probe.md` records the design, citations, numbers, the probe-faithfulness correction and
the residuals (a Windows-only reset 500 while an in-flight save temp is open, because Go opens without
`FILE_SHARE_DELETE` while Node's rm succeeds; not data destruction; Linux CI unaffected).

### 11.3 The seeded E06 state-machine qualification

Commit `f8d0ae3` adds the lane the plan's M1/M2 asked for, at a size the normal suite can run:

- `internal/longlivedfixture/recipe.go` - a recipe is a pure function of its seed: E06, tier bounds, 8 users,
  declared extension points, a 10-operation plan, declared faults, observables, a canonical preboot-tree
  SHA-256 and per-role artefact digests, with a tested v1 backward-compatible read and named refusals.
- `tests/e2e/scenario_state_machine_test.go` - the REAL server object through `internal/app.Start` on a
  generated 8-account data root: seeds 1601-1700 x 10 declared operations, executed twice = **2,000
  reproducible operation sequences**; settings save/get, chat save/load/append/rename/delete, ordered messages
  from BOTH the HTTP response and the disk bytes, cross-account reads every seed, unknown-file SHA-256 after
  every operation and after restart, JSON/JSONL validity after every operation, and four restarts on the same
  data root. Every operation appends a machine-readable action-log entry. 18.8 s on the development host, so
  `go test ./...` runs it in CI.
- `tests/e2e/scenario_state_machine_teeth_test.go` - 14 planted defects through the SAME comparators, each
  producing its named red (message order swapped/dropped/extra, restart identity and data root, cross-user and
  settings-marker leaks, unknown-file mutation, invalid JSONL, preboot chat loss/order, non-reproducible
  sequence, plan mismatch); correct data stays green first.
- `docs/alpha16/e-series-coverage.md` - the honest E01-E09 table: E06 executed here (isolation + per-account
  state machine, NOT concurrent overlapping writes/streams), E08 partial (clean object restart, not SIGKILL /
  EFBIG / hand-back), E05/E01 partial, E02/E03/E04/E07/E09 unexecuted by this lane.

### 11.4 The 8-user performance row: a measured report-only conclusion, not a graded green

The 2026-11-06 red AFTER under a single-run x1.25 ceiling was investigated with a repeat series. Commits
`535072b`, `078172f`, `58d9291` and `985eed5` add a sync-write disk fingerprint to every report, refuse a
non-comparable host by name (`threshold/host-disk`), and derive each route's ceiling from the WORST p95 across
the repeated baselines widened by that route's measured baseline spread (floored at 25%). Three repeated
same-tree baselines recorded disk medians 0.35-8.67 ms with settingsSave p95 112.3-117.6 ms and chatsSave p95
87.6-115.4 ms. Three AFTER runs of the final code candidate then produced settingsSave p95 115.2/191.8/225.1 ms
and chatsSave p95 116.3/175.6/265.9 ms on hosts whose sync-write tails were 30.5/80.9/138.0 ms, with the read
route stable at 41.4-56.5 ms and correctness/isolation green in every run. The same-code spread (1.95x/2.29x)
exceeds every tolerance that still detects a regression and tracks the host storage tail, so the row is
**REPORT-ONLY for alpha.16**: no graded 8-user latency number is claimed, the measured routes' handlers are
untouched by the release diff, and the named next step is a same-host paired design. Full tables:
`docs/alpha16/m5-evidence.md` sections 10-12. Two 45-minute soak runs at the final code candidate
(`42331166962` at `93f5f59`, `42332431109` at `8e151ce`; zero non-test product files differ from the release
candidate) both pass the GC-robust per-third rule (section 12); the real-leak question remains UNPROVEN
because the rule is a detection floor.
## 12. Publication (2026-11-07): `v0.1.0-alpha.16`

### 12.1 The final candidate and the 13-gate wave

The final candidate is `c1886d7` (`c1886d7`): `main` with the final
engineering pass (section 11), the seeded E06 lane, the measurement changes and the two harness-integrity fixes.
Every one of the 13 required workflows was DISPATCHED AGAIN at that commit; the same-SHA rule allowed no run
from the earlier candidates to carry over. The official fail-closed verifier (the program the publish job
itself runs) printed **PASS: 13/13 required workflow(s) are green at this SHA** with exit status 0; the
committed table is `docs/alpha16/same-sha-evidence.md`.

| # | required workflow | run id | event | conclusion | required job / artifact rail |
|---|---|---|---|---|---|
| 1 | GoTavern CI | 42340290230 | workflow_dispatch | success | verify, race, oracle full sweep, crash-gate, browser-evidence, changes |
| 2 | GoTavern whole-session differential | 42340292267 | workflow_dispatch | success | - |
| 3 | GoTavern world-info slot ordering | 42340294045 | workflow_dispatch | success | - |
| 4 | GoTavern drop-in qualification | 42340295948 | workflow_dispatch | success | - |
| 5 | Browser differential | 42340297957 | workflow_dispatch | success | mode=all |
| 6 | GoTavern release qualification | 42340299880 | workflow_dispatch | success | - |
| 7 | GoTavern smoke metrics | 42340301718 | workflow_dispatch | success | requests=50 |
| 8 | GoTavern Docker image | 42340303463 | workflow_dispatch | success | - |
| 9 | Helper state differential | 42340305321 | workflow_dispatch | success | - |
| 10 | Combination journey differential | 42340307249 | workflow_dispatch | success | combination-journey + combination-journey-evidence (full tier, embedded evidence) |
| 11 | Third-party extension compatibility | 42340309242 | workflow_dispatch | success | mode=full + extension-compat-evidence (20 extensions, macos-arm64 limitation marker) |
| 12 | GoTavern long-lived corpus qualification | 42340311363 | workflow_dispatch | success | medium-corpus + longlived-medium-evidence |
| 13 | GoTavern Node stock tree round trip | 42340313131 | workflow_dispatch | success | node-stock-tree + node-stock-tree-evidence |
| - | GoTavern Release (dry run, dispatch) | 42340315205 | workflow_dispatch | success | six archives built/archive-inspected, execution legs, darwin-arm64 recorded downgrade, prepublish qualification; publish steps skipped, no release created |

The runs that FAILED on the road to this wave are recorded rather than hidden: `GoTavern CI` `42332590427` at
`bb34788` failed `verify` on a cross-package loopback port collision in
`TestTwoProcessesOneDataRootSettingsWritesStayWhole` (fixed by commit `654a7fe`, a named-only retry plus a
classification teeth test); `GoTavern CI` `42335401136` at `654a7fe` failed `verify` on a stale derived
`goTestFunctions` count (947 committed vs 948 measured after that fix's teeth test; fixed by regeneration in
commit `c1886d7`). Both failures were fixed at their cause and the whole wave was re-dispatched, not retried
until green.
### 12.2 The tag and the published release

- **Tag**: annotated `v0.1.0-alpha.16`, object `b7d81cd`, peeling to
  `c1886d7`. Created only after the verifier PASS, and not moved.
  `scripts/classify-version-tag.sh` classifies it **stable** (the graduated equality list), so the release path
  published WITHOUT `--prerelease`, WITH `--latest`, and `releases/latest` now resolves to it.
- **Release**: https://github.com/cocokoishi/GoTavern/releases/tag/v0.1.0-alpha.16 - `draft=false`,
  `prerelease=false`, published `2026-11-07T08:01:36Z`, **7 assets**: the six canonical archives plus
  `checksums.txt` (linux/amd64 61,292,084 B; linux/arm64 60,537,075 B; darwin/amd64 61,386,764 B;
  darwin/arm64 61,102,292 B; windows/amd64 61,413,379 B; windows/arm64 60,594,549 B).
- **Publication run**: `GoTavern Release` **42353529322** (tag push, completed/success). Its jobs:
  six `build` legs, `execute-linux-arm64`, `execute-darwin-amd64`, `windows-arm64-boundary`,
  `darwin-arm64-recorded-downgrade`, `prepublish-qualification`, `publish`, `post-release-facts` - all success.
  The publish job ran the fail-closed verifier (13/13) and the notes/marker checks before `gh release create`;
  the release body carries the generated same-SHA qualification table (`## Qualification evidence (same-SHA
  required gates)`, 13 rows, measured from the Actions API at publish time).
- **Platform limitation, recorded not waived**: darwin/arm64 was built, archive-inspected and proved a thin
  arm64 Mach-O, and its runtime execution is a recorded platform limitation (`macos-14-arm64-us-default` is not
  supported by the platform); windows/arm64 is BUILD-ONLY. The release notes state both.

### 12.3 Post-release independent verification (not the publish job's own claims)

- **Downloaded every asset again** and verified the release's own `checksums.txt`: 6/6 archives OK,
  0 failures.
- **Executed the published binary**: the `windows-amd64` archive unpacked on this host; `gotavern version
  --json` printed `gotavern_version: v0.1.0-alpha.16`, `sillytavern_version: 1.19.0`, `sillytavern_commit:
  06bde939...`; `BUILD-INFO.txt` names `GoTavern release v0.1.0-alpha.16` / `target windows`; the extracted
  `src/tokenizers` tree carries 10 files; a fresh-install boot of the published exe answered `GET /version`
  200 with the pinned SillyTavern identity and `GET /` 200 (734,837 bytes).
- **Installer path**: `GoTavern published-release install smoke` **42354487423** completed/success - it
  installs the published artifacts over real TLS with `install.sh` (linux-amd64) and `install.ps1`
  (windows-amd64), boots them, and asserts the tag, the tokenizers layout and real tokenizer route ids.
- **Published artifact + container extension journey**: `GoTavern published-extension smoke` **42354438296**
  completed/success - it resolves `releases/latest` over public HTTPS to this tag, unpacks the archive, runs
  `gotavern version`, pulls BOTH the `:v0.1.0-alpha.16` and `:latest` container manifests and proves they are
  the same image, boots it, and drives the published-extension journey.
- **Container identity**: GHCR reports digest
  `sha256:37a7f69f7fee090c58bbfd859ffbbd2ce50e9b3ec69482f91c95e5ef47eb1ea3` carrying BOTH tags
  `v0.1.0-alpha.16` and `latest` (one image, one digest); alpha.15's digest `28fd03f4...` is unchanged. The
  tag-triggered `GoTavern Docker image` run **42353529367** (completed/success) built, pushed, pulled back and
  re-verified it, and a dispatch **42354440669** re-ran the build verification.
- **Tag target unchanged**: `git ls-remote origin` still answers tag object
  `b7d81cd` peeling to `c1886d7`; there is no second tag object for this name.
- **Post-release facts**: the release workflow's `post-release-facts` job regenerated the generated facts for
  the published tag and committed `00828eb` ("chore(docs): regenerate the generated facts for the published
  v0.1.0-alpha.16 tag") to `main`, and dispatched `GoTavern CI` **42353714945** at that commit.

### 12.4 Residuals after publication (unchanged, restated)

- `GOAL.md` section 14 (a real, long-used private user tree) remains **NOT MET**; alpha.16 claims a synthetic
  adversarial qualification with the scope in `docs/alpha16/e-series-coverage.md`, not universal drop-in proof.
- darwin/arm64 runtime execution and the macos-arm64 extension lifecycle remain **UNPROVEN** (recorded platform
  limitation); windows/arm64 remains BUILD-ONLY.
- The 8-user latency row is **report-only** (not ratifiable on the shared runner pool; `docs/alpha16/m5-evidence.md`
  sections 10-12); the soak's real-leak question remains **UNPROVEN** (detection floor).
- A real kernel ENOSPC remains **UNPROVEN** (M3b proves only that ENOSPC and EFBIG are not conflated).
- Page-init egress hermeticity for browser probes remains **OPEN**; the E-series browser/real-extension legs
  beyond the re-run gates were not newly executed.
- The Windows-only account-reset-vs-save sharing-violation 500 (`docs/alpha16/storage-probe.md`) remains a
  recorded residual, not data destruction and not reproduced on Linux.