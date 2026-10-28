# The evidence ledger: one row per user question, five classes, and a manifest of the runs it cites

Describes: commit `035cdf2` (`main`, 2026-10-27). Every run cited below
is checked against that commit: the run's `head_sha` must be an ancestor of it, which is what makes a
citation a statement about THIS code rather than about a branch that has not merged.

`GOAL.md` §7 asks twenty-two questions and says that answering them with test counts is a failure to
answer. This file answers them. It is the ONLY ledger: there is no parallel scorecard, and a second one
would be a second source of truth for the same question — the failure mode `AGENTS.md` rule 54 records.

Three things live here, and all three are machine-checked by `internal/fixtures/documents_test.go`:

1. **The twenty-two rows.** Per question: the state, and the ARTEFACT a reader can open — a workflow run
   quoted as `workflow name + run id + conclusion`, the step inside it, and the assertion or field the
   claim rests on, or a committed file. A row with no artefact says `unproven` **in those words**.
2. **The five-class ledger** (§2). Every open item belongs to exactly one class, because "there are some
   gaps" is not a statement anyone can act on.
3. **Why a red run can prove something.** Some cited runs have a run-level conclusion of `failure` or
   `cancelled`. Each row says so IN PLACE and names the step the citation rests on, which is green inside
   that run. The gate REQUIRES the mark: a row that cites a red run without naming its conclusion is
   refused, because a reader who opens the run must not have been told it passed.

The states are a closed set. `proven`, `partial`, `unproven`, `blocked`, `unsupported`,
`inherited-pinned-behavior`. Anything else is refused by the gate, and so is a `proven` row whose
citation names neither a run id nor a committed file, a run id that is not in
`tests/docs/run-manifest.json`, a run id recorded under the wrong workflow name, a run whose commit is
not an ancestor of the commit named above, a question that appears twice, and a question that is missing.

## 1. The rows

| # | Question | State | Evidence |
|---|---|---|---|
| Q1 | A long-lived SillyTavern directory starts directly | proven | `GoTavern drop-in qualification` 40438192579 (success) and `GoTavern CI` 40438192589 (success) on `a5660b61f549`; `tests/e2e/longlived_test.go` synthesises the tree in Go and asserts every planted file byte-identical after boot, plus `/characters/<card>.png` with the card's own length, `/thumbnail?type=avatar&file=<card>`, `/api/worldinfo/get` (30 entries), `/api/chats/get` (12 messages), `/api/backgrounds/all` and `/User%20Avatars/user-default.png`. The tree is a SYNTHESIS, not the user's directory — see §3 |
| Q2 | GoTavern did not touch my extensions | proven | the long-lived leg hashes the extension tree before and after boot and asserts it unchanged; the update path resolves to OFF for every ambiguous input (`AGENTS.md` rule 26, `internal/commandline/autoupdate_test.go`), and `docs/startup-state-machine.md` records the measured boot mutations |
| Q3 | Character-list avatars are correct | proven | `Browser differential` 40325398585 (success), step `Compare the asset legs`: `imagesFailed: 0`, `consoleFailedToLoad: 0`, every list avatar decoded on both subjects (`tests/browser/compare-asset-legs.mjs`) |
| Q4 | An opened complex card's image is correct | proven | `Browser differential` 40325398585 (success), steps `Record the asset legs` / `Compare the asset legs`: the derived card is staged and OPENED on both subjects, 490 book entries and 5 alternate greetings required equal |
| Q5 | The avatar inside a chat is correct | proven | `Browser differential` 40325398585 (success), same steps: every message avatar decoded on both subjects |
| Q6 | Personas are correct | proven | `Browser differential` 40325398585 (success): the persona picker lists, a non-current row is clicked, `.selected` and `user_avatar` both change, and the persona thumbnail decodes at 96x144 |
| Q7 | Backgrounds display as in the original | partial | The asset half is unchanged: `Browser differential` 40325398585 (success), `Compare the asset legs` -- the gallery RENDERS 24 tiles with the staged tile present on both subjects, and the PAINT assertion is still not made (`initBackgrounds()` bindings absent IDENTICALLY on both subjects). **THE SECOND HALF IS NOW MEASURED, and the pass it replaced is WITHDRAWN IN PLACE.** The first four-viewport run PASSED over 28 rows that all said `covered-at-centre` on BOTH subjects at ALL FOUR sizes -- a shape no real layout produces, since the send button and the navigation toggles do not share a footprint. The coverer-naming added for exactly that reason found it: `dialog.popup.wider_dialogue_popup[750x544@265,178]`, a modal nobody had dismissed. Three refusals later the measurement is real, and `Browser differential` 40476300686 (success) is the citation -- steps `Record the UI layout legs` and `Compare the UI layout legs`, on `f3be322`, an ancestor of the commit this ledger describes: `everySizeWasMeasurable: true`, `disagreeingReachability: 0`, `unreachableOnGotavernOnly: 0`, `harnessNotReady: 0`, `unmatchedRenderState: 0`, `rosterDifferences: 0`, `observedElements: 40`, verdict PASS. So at 1280x900, 800x600, 390x844 and 320x568 the two subjects agree on the reachability of forty elements. **`equallyUnreachable: 13` is reported and NEVER counted as a pass**: those are controls unreachable on BOTH subjects, which is a fact about pinned's own layout (a closed panel has no area), not evidence of parity. **LIMITS, kept in the row on purpose.** (1) The pass is about REACHABILITY -- box, non-zero area, hidden style, centre inside the viewport, what `elementFromPoint` puts on top of that centre, right-edge overflow, document overflow -- and not about whether the control WORKS; the paint/behaviour half is still unmeasured. (2) A render-state difference is a REFUSAL, not a layout finding: the comparator returns `HARNESS_STATE_MISMATCH` when the two pages' containers differ in state, which is what the roster-timing difference between the subjects produced before the probe was made to wait on the product's own roster. (3) One selector this lane invented (`#persona_button`) does not exist in pinned's markup; the real control is `#persona-management-button` (`public/index.html:5833`) |
| Q8 | The JS-Slash-Runner iframe really works | proven | `Browser differential` 40325398585 (success), steps `Record the helper legs` / `Compare the helper legs`: the iframe boots, the bridge reaches the host modules, and the leg fails itself if helper-off and helper-on produce identical captures (`AGENTS.md` rule 50) |
| Q9 | 酒馆助手's generation APIs work | proven | `Browser differential` 40378609525 — RUN VERDICT FAILURE, and the citation rests on the step `first-turn-saved: ok` inside it plus `listenerTimings` carrying `message_sent` 3 / `message_received` 4; the `generateRaw` request is byte-identical to pinned's. The run failed LATER, at the reload step, which is why Q20 stayed `partial` until `Browser differential` 40387864205 (success) covered reload and swipe |
| Q10 | 酒馆助手's variables work | proven | TWO HALVES, and both are now measured. **(1) PERSISTENCE:** `Browser differential` 40250495167 (success), step `Compare the helper legs` -- a variable set by the helper persists to the chat file and survives a reload. **(2) THE WIRE, which is the half that matters for the goal:** `Browser differential` 40493990375 -- RUN VERDICT FAILURE, cited for the guards that went GREEN inside it, `valueOnWire` and `changeChangesTheWire` (the only failures are `globalScopeReachesWire`, a harness scope gap, and `survivesRestart`, which is red on the provenance side). A variable written with `insertOrAssignVariables({hv_preset: ...}, {type:'chat'})` reaches the FINAL PROVIDER REQUEST as its RESOLVED VALUE, in a preset-prompt position, with `bodyHasRawMacroSyntax: false` -- the raw `{{getvar::}}` form is absent from every captured body -- and CHANGING THE VALUE CHANGES THE WIRE: `HV-PRESET-CHAT=HV-ALPHA-7c31` for `chat-alpha` and `HV-PRESET-CHAT=HV-BETA-9d42` in the same slot for `chat-beta`. `mismatches=[]` on FOUR runs, and each value appears three times across the captured bodies (both subjects plus the restart leg). **LIMITS, kept in the row on purpose.** The vehicle stages the marker into a PRESET PROMPT, which is the path a real user's preset takes, and that path is substituted BY THE EXTENSION before `generateRaw` sees it (`generate/index.ts:178-189`); a caller-supplied `ordered_prompts` entry is substituted by NOBODY (`generateRaw.ts:492-497`), which is a fact about pinned recorded in its own right and was the first vehicle's defect. `globalScopeReachesWire` is UNPROVEN rather than failed: the staged identity prompt carries `HV-PRESET-CHAT`, so a `{{getglobalvar::hv_global}}` clause in that slot was never reachable, and the body shows `HV-PRESET-CHAT=` (empty) rather than the raw macro, so the resolver ran and the global lookup is the miss. The DISK half (`survivesFreshPage`, `survivesRestart`) is unproven for this vehicle |
| Q11 | Injection changes the model context | proven | `Browser differential` 40378609525 -- RUN VERDICT FAILURE, same run and reason as Q9: the depth-0 injected text is present in the captured provider request on both subjects and absent when injection is off, recorded in the helper generation steps BEFORE the reload step failed. The same run's provider-wire evidence is what Q10's wire half extends: a variable's RESOLVED value occupies a slot in the captured body, and the wire changes when the variable changes | **AND REGEX SCRIPT INJECTION, measured on its own surface:** `Browser differential` 40520896730 (success), steps `Record the regex legs (three variants, both subjects)`, `Compare the regex legs` and `Prove the regex gate has teeth` -- all three green in one run on `1b9cd81`. The comparator returns `verdict: match` with `failedGuards: []` and 17/17 guards, and the two subjects' captured `chat/completions` bodies are IDENTICAL (**3630 B, sha256 `6c839423759e` on BOTH**), in all three variants (baseline, disabled-rewrite, swap-chain). Eight falsifiable cases, each named: case1 rewrite reaches the request both ways, case2 display-only changes the DOM and not the request, case3 prompt-only changes the request and not the display, case4 the A->B chain with order observable, case5 the three negatives (disabled flag, depth, no-match) each saying WHY, case6 JS substitution semantics with the BROWSER as the oracle (`[$&,$$,RXQ_JS_A7,RXQ_JS_A7] beta`, with the separators written as commas here so the table cell stays intact -- the real output uses the JS replacement separators) identical on both pages; **Go RE2 was never consulted**), case7 old messages re-processed while the display is not written back, case8 the STORED chat file holds the rewritten text, read from `default-user/chats/<id>.jsonl`. Teeth are demonstrated by 12 mutations each dying at its named guard. **WHAT THIS DOES NOT PROVE, kept here on purpose:** the committed real presets' OWN regex rules are not covered -- preset A carries 0 `regex_scripts` and preset B's 27 are desensitised to MARK_ bodies whose `findRegex`/`replaceString` mostly do not sit in a triggerable position -- so the claim is the MECHANISM (engine entry point `engine.js:334-381`, the placement enum at `:281-292`, the three call shapes, the depth guard, rule order, and JS substitution), not those presets' semantics. Also unexercised: preset-scoped rules (`readPresetExtensionField`, `engine.js:121-127`), character-scoped (`SCRIPT_TYPES.SCOPED`) rules and their consent prompt, placements `SLASH_COMMAND` (3) / `WORLD_INFO` (5) / `REASONING` (6), `substituteRegex` RAW/ESCAPED (`:397-409`), `trimStrings` (`:457-464`), and a real provider (the peer captures and answers). The regex surface runs only in `regex` or `all` mode (dispatch or nightly), never on a push: 40507798604 is cited only for its step 41/42 GREEN legs, its run-level verdict was FAILURE at step 43, which is the self-test that 1b9cd81 then fixed.
| Q12 | Mutating `in_use` affects generation immediately | proven | `Browser differential` 40277640647 (success): before/after pairs identical across subjects and different from each other (preset A `0716543c` -> `5bf90078`; preset B `61276bf1` -> `4ee6b389`) |
| Q13 | Switching presets produces genuinely different context | proven | `Browser differential` 40274214952 (success), `Compare the preset legs`: `goATavernDiffersFromGoB` true, `aSharedMarkers: 25` |
| Q14 | For each preset, Node context == Go context | proven | `Browser differential` 40274214952 (success) and 40387864205 (success): the preset-leg guards read true, `Node(A)==Go(A)`, `Node(B)==Go(B)` over the real preset derivations |
| Q15 | A complex card's semantics inside the context are the same | proven | `Browser differential` 40325398585 (success), asset legs: the derived card is opened on both subjects and its assembled request is compared byte for byte. The card is a COMMITTED DERIVATION — the original never entered the repository (`AGENTS.md` rule 56) |
| Q16 | World-info activation is the same | proven | `GoTavern CI` 40398345829 (success): the `verify` job `Test` step replays the provider-wire captures including the world-info routes' recorded requests, and the `oracle` job's `Verify generated results are committed` step proves the re-record was byte-identical. The long-lived tree serves a 30-entry book |
| Q17 | Author's Note depth is the same | proven | `Browser differential` 40465631698 -- RUN VERDICT FAILURE, and the citation rests on steps 26/27/28 inside it, all SUCCESS: step 28 printed `q17 sweep: PASS (6/6 cases PASS)`. Step 29 `Prove the Q17 gate has teeth` was SUCCESS too (`authors-note gate self-test: 15 mutations caught, baseline green`), and step 40 `Prove the Q17 artefact verifier has teeth` was SUCCESS (`OK: every mutation of the artefact is caught by name`). The run's ONLY failure is step 35 `Judge the hand-back`, which is Q21's card fixture defect and not this lane. The six cases are parity, depth 0, depth 4, depth 8, disabled and IN_PROMPT, and on each the two subjects produced byte-identical provider requests with identical note layouts. **LIMITS, kept in the row on purpose.** (1) `pastHistoryInsideBudget` is `null`, not measured: at this fixture's keep context no depth both passes the oldest declared turn and delivers the note, because raising the insertion point makes the trimmer (`populateChatHistory`, `public/scripts/openai.js:949-1075`) release older turns, which frees tokens, which lets the frontend emit more messages, which moves the list the injection is indexed against (`injectIdx = Math.min(depth + totalInserted, messages.length)`, `:866-868`). The unmeasured region is a PROPERTY OF THE PRODUCT'S OWN ASSEMBLY, and the honest response is `null` with the mechanism rather than a fixture change that manufactures reachability. (2) A depth BEYOND the budget is a truncation fact, not a depth fact |
| Q18 | Token truncation is the same | proven | Exact tokenization is pinned (`internal/tokenizers/context_boundary_test.go`: `TestContextBoundaryTailStability`, `TestContextBoundarySameCountDifferentTokens`). The observable half: `Browser differential` 40465631698 -- RUN VERDICT FAILURE, cited for step 25 `Q18 token truncation -- Node and Go keep and drop the same turns`, which was SUCCESS; the run's only failure is step 35, Q21's fixture defect. `tests/browser/truncation-set-gate.mjs` measures NOTHING itself: it INHERITS the pair `preset-boundary-search.mjs` found by driving the pinned leg with the same program, arguments and clean state as the compared legs, and then asserts the oldest history turn PRESENT at `keep` and ABSENT at `keep-1` on the pinned leg, both subjects agreeing on the kept history SET and its relative order at BOTH contexts, equal request bytes at both, exactly one turn dropped across the pair and it being the SAME turn on both subjects, and exactly one provider POST per leg so "no request" cannot read as "no difference". **LIMIT, kept in the row on purpose**: this is "proven AT THIS BOUNDARY" -- the sizes the search covered around the capture's hint -- never "truncation proven in general", because pinned's own note says the TOTAL message count is not monotone in `openai_max_context` |
| Q19 | Streaming and helper events are the same | partial | NO CITATION FROM THIS COMMIT, and that is the gate's verdict rather than a gap in this table. The cut/abort legs and the workflow run that exercised them live on an UNMERGED lane branch: that run judged commit `88cb99b`, which is not an ancestor of `a5660b6`. The ancestry rule refuses such a citation as evidence about `main` — correctly, because the code it judged has never merged — so the run id is deliberately NOT recorded here. What was observed on that branch (identical request bytes and 15 frame terminators across a real TCP middle) cannot be cited until those legs land with a run whose `head_sha` is on `main`. A buffering-hop RENDER claim is not provable by that harness at all and is named in the artefact's `notCompared` |
| Q20 | Reload, swipe, regenerate, continue preserve equality | partial | **TWO OF THE FOUR VERBS ARE NOW PROVEN, and the split is the row.** (1) SAVE -> RELOAD -> SWIPE: `Browser differential` 40387864205 (success), steps `Record the Q20 legs` and `Compare the Q20 legs` -- every guard true, requests byte-identical across subjects. That run is STRUCTURE-ONLY (the page streamed against a JSON peer, so the reply text was empty on both sides); the later SSE work restored the content condition and `Compare the Q20 legs` has since been green FIVE consecutive times, most recently in the run recorded as PENDING below. (2) REGENERATE: the same pending run, step `Compare the Q20 regenerate legs` -- SUCCESS with 13/13 guards and `verdict=match`, the FIRST CI-SOURCED equality for a verb (the earlier 13/13 was measured by replaying downloaded legs locally, which rule 75 permits for fixing a reader but not for a claim). Its negative beside the equality is recorded too: `goRegenerateCarries: {"replacedText":"Q20G_Q20_REPLY_2", "carriesIt":false, "sameAsPrecedingTurn":true}` -- the requests agree AND the replaced reply is absent, which is the property that makes the agreement mean the verb rebuilt the right thing (rule 84). (3) CONTINUE: **UNPROVEN, and further along than before** -- the leg DROVE and RECORDED for the first time in that run, but every red in it was ONE missing argument in the harness (a producer/consumer signature mismatch that fed both legs the literal `Q20_REPLY_undefined`, rule 85), so the comparator has still never executed. **CITATION STATUS, stated because it is the point:** both results above were measured on `b354b8c`, a LANE commit, so no run id is cited here until the lane merges and the commit becomes an ancestor of main -- rule 61. The run is in `tests/docs/run-manifest.json` and in the pending section; the moment the lane merges, this row can carry it. **LIMITS kept in the row:** the `40387864205` citation remains valid only for structure, which the committed artefact states in `priorCitationLimitation`, and continue's comparator has never executed CONTINUE, MEASURED AFTER THE LANE'S OWN WORK (this is the added fact, not a replacement of the above): the go and pinned legs each then drove every remaining step green and the comparator EXECUTED, but reported guards red -- and measured directly from the two leg files of `Browser differential` 40608845921 (head `5346851`), the two subjects produced a **byte-identical continuation request (`gotavern a1e050cbfa0f` vs `pinned a1e050cbfa0f`)**. The equality the verb is judged by therefore EXISTED while four guards could not see it: each located the continue request by positional index (`requests[requests.length - 3]`), valid only when a leg drove exactly two setup turns, and the pinned leg -- correctly starting from the handoff, which already carried them -- drove zero. `4aefd83` selects the request by the product's own `continueNudgePrompt` marker instead; **no CI run has yet reported continue green**, so the verb stays unproven and the remaining gap is INSTRUMENT-SIDE, not product-side. Across nine runs in this lane there is **no known product defect in any of the three verbs**; every red was the harness. |
| Q21 | Data written by GoTavern can be handed back to Node | unproven | `tests/browser/q21-data-handback.mjs` exists and the workflow runs it, and it is RED for a faithful reason. The unmerged `lane/q21-work` run reproduces the original report byte for byte on a fresh branch with no product change, so the probe is stable and the discrepancy is not a flake: `characterStaged: wanting "MARK_000466测测测测测测测测"; roster ["MARK_002794测测测测测测测测","Seraphina"]`. Both strings were then located in the committed bytes by `internal/server/characters_pr t test): the committed derivation carries DIFFERENT documents in its `chara` and `ccv3` chunks — `chara: data.name="MARK_000466…"`, `ccv3: data.name="MARK_002794…"` — while pinned gives `ccv3` precedence (`src/character-card-parser.js:54-78`) and both servers therefore answer `…794`. So the precondition failure is a FIXTURE/GENERATOR defect, not a product one: `tools/build-real-fixtures.mjs` derives each chunk independently with a running marker counter, producing a card pinned's own `write` (`character-card-parser.js:15-40`: `ccv3` ← `JSON.parse` of the same data) cannot emit. FOUR reported "product defects" in this area resolved to PARITY once a capture was consulted and are recorded in §2: the chat-directory key (`characters_card.go:307` matches pinned `characters.js:419`), the `chats` member (pinned never assigns it; the frontend derives it at `public/script.js:567-574`), the `{overflow:false,error:true}` shape (it IS the recorded `responses.allMissingDirectory` body at 500), and the roster `chat` name (pinned regenerates the timestamp at write: `unsetPrivateFields` `characters.js:498-502` then `:585-590`). The hand-back itself has therefore never been judged past its precondition, and this row claims nothing about it |
| Q22 | CPU/RAM are measurably lower than Node's | proven | `GoTavern smoke metrics` 40394799325 (success) and 40396669521 (success), runner `ubuntu26`: boot 14,355 ms vs 61 ms, steady RSS 912 MB vs 37 MB, `GET /version` 62.7 ms vs 0.43 ms, 10-minute soak on both. Cite that runner and those runs only; no multiplier is claimed |

## 1a. Runs that exist on unmerged branches, and why they are not cited above

Runs that support statements in this ledger and CANNOT be cited, because their `head_sha` is not an ancestor of
the commit this file describes. They are named here as a record, outside the rows, and each becomes a citation in
its row on the day its lane merges:

| run | branch | what it showed |
|---|---|---|
| `40444636900` | `lane/q21-work` | The Q21 precondition failure reproduces byte for byte on a fresh branch with no product change, so the probe is stable and the mismatch is not a flake. |
| `40446833206` | `lane/q21-work` | The committed card's `chara` and `ccv3` chunks carry different documents (`MARK_000466…` vs `MARK_002794…`), which is a fixture/generator defect rather than a product one. |
| `40447689701` | `lane/q17-q18` | The Q18 token-truncation step passed: same kept SETS and order at both contexts on both subjects, equal bytes, the same single dropped turn, one provider POST per leg. |
| `40451173262` | `lane/q17-q18` | The Q17 depth-14 re-record: pinned legs produced the SAME numbers as depth 20 with the note absent, which is what retired the deeper-than-history class instead of tuning it a third time. |
| `40453196861` | `lane/q17-q18` | The Q17 judge passed on six cases (`q17 sweep: PASS (6/6 cases PASS)`) and Q18 passed again; the run went red at the lane's own teeth self-test, fixed in the same branch. Its golden and PASS artefact are committed. |
| `40457987209` | `lane/q17-q18` | Re-run after the preset-identity guard and the artefact-`inputs` fix: Q18 and the Q17 preparation/legs/judge steps SUCCESS; the lane report carries its run-level conclusion. |
| `40450382265` | `lane/ui-viewport` | The first four-viewport layout run. Its PASS is WITHDRAWN as a reachability result because every row said `covered-at-centre` on BOTH subjects at all four sizes; the probe now names the coverer and the comparator refuses a viewport-spanning one. |

The ancestry rule exists because a lane's green says nothing about merged code: this repository has already
cited a green run from the wrong workflow once, and an unmerged branch is the same defect one layer down.
| `40453196861`, `40451173262`, `40447689701`, `40460865082` (SUPERSEDED BY 40465631698, which judged a commit that IS an ancestor of the one this ledger describes) | `lane/q17-q18` (REBASED afterwards) | The Q17 six-case sweep, the Q17 teeth self-test (15 mutations, baseline green), the Q18 boundary step, and a `mode=preset` run from the lane tip. Each was green at the step it is named for. NONE is citable: the lane was rebased after these runs, so every `head_sha` they judged is unreachable from `main` and the ancestry gate refuses them -- including the commits that were on the branch BEFORE the rebase, because a rebase rewrites their identities. The first run whose `head_sha` is on `main` is the one that will close Q17 and Q18 |

| run | branch | why it is not cited |
|---|---|---|
| `40508390830` (`Browser differential`, workflow_dispatch, `mode=preset`, `b354b8c`, FAILURE) | `lane/regen-continue` | It carries the regenerate verb's FIRST CI-SOURCED equality (13/13, `verdict=match`) and the fifth consecutive green `Compare the Q20 legs`, and the continue leg's first record. Its head is a LANE commit, so under rule 61 it becomes citable when the lane merges and the commit becomes an ancestor of main. Cited for nothing until then; recorded here so the id is not lost |

## 2. The five classes

Every open item in this repository belongs to exactly one of these. The classes have DIFFERENT owners and
different next actions, and a document that mixes them lets an unproven row look like a boundary and a
harness defect look like a product defect.

### 2.1 Verified and kept this round

What the latest evidence still supports on `a5660b61f549`, with the artefacts intact:

| Item | Artefact |
|---|---|
| the long-lived tree boots and serves its assets unchanged | `GoTavern CI` 40438192589 (success), `tests/e2e/longlived_test.go` |
| the visual asset surface renders in a browser | `Browser differential` 40325398585 (success) |
| the real preset derivations reach the same provider request from both subjects | `Browser differential` 40274214952 (success), 40387864205 (success) |
| the packaged artifact boots against a stock tree | `GoTavern drop-in qualification` 40438192579 (success) |
| persistence survives save -> reload -> swipe | `Browser differential` 40387864205 (success) |

### 2.2 Current defect

A product behaviour that is wrong NOW, with a reproducer. **None open** at this ledger's date: the three
P0s the second pass found (P0-D helper, P0-E visual assets, P0-F preset semantics) each have a green
browser or packaged gate, and their `GOAL.md` §6 rows are closed against those gates. An entry is added
here the moment a gate goes red naming an assertion, and the row that cites it is demoted in the same
change (`AGENTS.md` rule 36).

### 2.3 Unproven

Evidence the repository cannot produce yet, with the missing thing named:

| Item | What is missing |
|---|---|
| continue equality (Q20) | the comparator to REPORT the equality it already measured. `tests/browser/q20-continue-probe.mjs` drives the verb on both subjects (24/24 and 23/23 steps green) and `compare-q20-continue-legs.mjs` executed; run 40608845921 shows a byte-identical continuation request (`a1e050cbfa0f` on both) while four guards located that request by positional index. `4aefd83` selects it by the product own nudge marker and no run has yet confirmed green. The missing thing is a green comparator run, NOT a probing capability |
| handing a GoTavern-written tree back to pinned Node (Q21) | a green `q21-data-handback` leg; the leg currently stages the card under a name pinned does not list |
| Author's Note depth sweep (Q17) | a workflow step running `authors-note-sweep.mjs`; the probe exists and has never executed |
| truncation past the context boundary (Q18) | a leg comparing the truncated request on both subjects |
| background PAINT (Q7) | the pinned frontend's own binding is absent on both subjects, so the differential is silent rather than negative |

### 2.4 Harness failure

The measurement, not the product, is wrong. Separate because a harness defect read as a product finding
sends a lane to change correct code (`AGENTS.md` rule 10):

| Item | Diagnosed as |
|---|---|
| `Browser differential` 40438262854, step `Judge the hand-back` | driver staging: the card is written but pinned's roster does not list the name the leg asks for. The archive digest in the same report proves the file exists, so the product did not lose it |
| `Browser differential` 40438192617 (cancelled) | superseded by 40438262854 for the same `headSha`; a cancellation is never evidence either way |
| the earlier `Browser differential` runs whose preset or asset legs were `skipped` | narrowing by path, not red product behaviour: the workflow selects surfaces by the files a push touches, so a skipped leg proves nothing about its surface (`AGENTS.md` doctrine 8) |

### 2.5 Explicit boundary

A behaviour the product will not have, decided rather than pending. Each has its own reason and is never
folded into a `partial`:

| Boundary | Reason |
|---|---|
| arbitrary Node server plugins | `AGENTS.md` hard rule 16 and architecture boundary 1; not emulated, ever |
| in-process ONNX inference (`/api/extra/{caption,classify,classify/labels}`, `/api/speech/*`, local embedding sources) | architecture boundary 2: there is nothing to intercept, so no differential can exist |
| image re-encoding that claims Jimp byte equality | architecture boundary 3: `/thumbnail` serves the OBSERVABLE contract; `/api/avatars/upload` keeps the boundary until a user requirement reaches it |
| private third-party wire formats inside npm packages (`/api/google/generate-voice`, `/api/translate/*`) | architecture boundary 4: ownership of an undocumented protocol, reversible by a user requirement |
| inherited substring hostname matching in content import | architecture boundary 5: reproduced AND recorded, because "safer but different" breaks parity as badly as "different and worse" |
| the originals themselves as test inputs | `AGENTS.md` rule 56: only a derivation enters the repository. The originals are read-only local inputs, and `docs/development-loop.md` §4 is the channel that permits executing them and forbids transmitting them |

## 3. Boundaries a reader of the rows above could misread

- **Q1's tree is synthesised, not the user's.** `tests/e2e/longlived_test.go` builds it in Go because CI
  must run without the originals. It is a faithful SHAPE and it is not the user's directory. A claim
  about the user's directory rests on the local qualification channel in `docs/development-loop.md` §4,
  whose result is recorded as an observation here — never as an upload.
- **Q15's card is a derivation.** Same reason; the generator refuses the original by name.
- **A `success` conclusion is about the run, not about every step.** Two runs cited above have a
  run-level `failure` and are cited for a step that was green inside them; both say so in place, and the
  manifest records the conclusion so the reader is told before they click.
- **`skipped` is not `success`.** The browser workflow narrows itself by the paths a push touches. A
  skipped leg's surface is unverified for that run, and no row above cites a skipped step.

## 4. Why a row is allowed to cite a red run

Q9 and Q11 cite `Browser differential` 40378609525, whose conclusion is `failure`. That is legitimate for
one reason: a browser leg is a sequence of independent steps, and the step the citation rests on ran and
asserted BEFORE the LATER step (the reload) failed. `AGENTS.md` rule 55 is what makes it legal rather
than sloppy — the workflow name, the run id and the conclusion are quoted TOGETHER, so the reader is never
told "this run passed". Dropping the citation because the run is red would discard the only execution
those steps have ever had and make the row `unproven` for a reason that is not true.

The gate enforces the discipline rather than trusting it: a row that cites a run whose recorded
conclusion is `failure` or `cancelled` must contain that word. That is what keeps a red-run citation
honest.

**A THIRD rule this discipline needed, and it was found by running the gate rather than by reasoning.**
Marking a red run in place is not enough when the run ALSO judged a commit that has never merged: Q19's
cited run was red and its commit was not an ancestor of this one, so no amount of in-place marking could
rescue it as evidence about `main`. The first version of this file marked it and kept the id; the ancestry
check refused it, and the row lost its citation. That is the right outcome — the marker makes a red run
readable, the ancestry rule decides whether it is admissible at all.

**A deadline on the Q19 gap, stated so it cannot be quietly forgotten.** The lane branch carrying the
streaming legs is unmerged, which means the product on `main` has no evidence for Q19 at all. The next
change that touches streaming either lands those legs with a run whose `head_sha` is on `main`, or the
row stays `partial` with this paragraph as its reason. It must not become `proven` by an edit to this
file.


A FURTHER CASE, 2026-10-27: `Browser differential` 40453196861 was red at `Prove the Q17 gate has teeth` — the lane's own comparator self-test — after every step that produces or judges evidence had succeeded. Q17 cites steps 26-28 inside it and Q18 cites step 25, and both rows say the run was red. The distinction that makes this citeable is the one Q9 and Q11 already rely on: the claim rests on a NAMED STEP, never on the run-level conclusion.
## 5. The manifest

`tests/docs/run-manifest.json` carries `{runId, workflow, headSha, conclusion, createdAt}` for every run
this file cites, seeded from `gh run list` and `gh run view` rather than from memory. It exists because:

- a run id alone is ambiguous — one commit produces several workflows, and `Browser differential` and
  `GoTavern CI` are created in the same second (rule 55);
- a stale conclusion is worse than no conclusion: if a run is re-run and its conclusion changes, the
  manifest is what disagrees, and a disagreement is a repair rather than a silent rewrite.

`node tools/docs-check-manifest.mjs --check` re-reads the live list through `gh` and prints any entry
whose recorded conclusion no longer matches, any entry whose workflow name has drifted, and any cited id
that does not exist. It is advisory locally (the host is weak and `gh` may be unauthenticated) and fatal
in CI when a token is present; the Go gate over the manifest runs unconditionally.
