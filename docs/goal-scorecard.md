# The evidence ledger: one row per user question, and the run that proves it

Describes: commit `5be679b` (`main`, 2026-10-31, the `v0.1.0-alpha.9` release commit). Every run cited below
judged a commit that is an ancestor of it -- most of them `913e3c5` or `1255b29` itself. **The window between
`1255b29` and the release is NOT documentation-only** (measured: `git diff --name-only 1255b29..5be679b` touches
83 files, 24 of them Go, including `cmd/gotavern/main.go`, `internal/app/server.go` and
`internal/server/tokenizers.go`), so a row whose citation predates those changes is the run that judged the claim
it states, and the fresh candidate re-runs for the release are carried in `docs/release-checklist.md` §G rather
than swapped into every row. This file replaces a ledger whose citations named commits that the 2026-10-29 history
rewrite orphaned; §0 records why that made every citation inadmissible rather than merely old.

`GOAL.md` §7 asks twenty-two questions and says that answering them with test counts is a failure to
answer. This file answers them. It is the ONLY ledger: a second scorecard would be a second source of
truth for the same question, which is the failure mode `AGENTS.md` rule 54 records.

## 0. Evidence lineage, and why this file was re-derived

On 2026-10-29 the repository history was rewritten to normalise commit identities. That rewrite is
itself gated (`scripts/check-commit-identity.sh`, run by `GoTavern CI` step `Verify every commit
identity is a project identity`), and it has a consequence that no amount of re-reading prose can
undo: changing a commit changes its identity and every descendant's, so every commit object that an
earlier CI run judged, including this ledger's own anchor, became **unreachable from `main`**. GitHub
still answers for those objects by SHA, but `git merge-base --is-ancestor <run head> <described
commit>` fails for all of them.

That was measured, not inferred: `TestEvidenceLedgerIsConsistent` reported one "ancestry could not be
verified" finding per citation, and `GoTavern CI` never reached `go test ./...` at all, because an
earlier step in the same job (a stale generated count) failed first. So the whole repository looked
green in prose while its evidence chain was attached to nothing.

This revision therefore cites only two kinds of evidence:

1. **A run whose `head_sha` is `a8d5945`** — an ancestor of every commit after this file, so the
   ancestry rule holds for every reader who checks. The runs are quoted as `workflow name + run id +
   conclusion`, together, because one commit produces several workflows and a bare id is ambiguous
   (`AGENTS.md` rule 55).
2. **A committed file or test in THIS tree**, named so a reader can open it, when the artefact is in
   the repository rather than in a run.

The pre-rewrite citations are kept in §6 as history. They are recorded, and they are **not evidence
about this tree**; that is the honest way to preserve them.

## 1. The rows

| # | Question | State | Evidence |
|---|---|---|---|
| Q1 | A long-lived SillyTavern directory starts directly | proven | `GoTavern drop-in qualification` 40903954848 (success): the packaged archive is unpacked and boots a stock tree inside the readiness bound. `tests/e2e/longlived_test.go` (`TestLongLivedTreeBootsAndServesItsAssets`) synthesises a long-lived tree in Go (card PNG, chat, 30-entry world book, preset, visual assets) and asserts every planted file byte-identical after boot, plus `/characters/<card>.png`, `/thumbnail?type=avatar&file=<card>`, `/api/worldinfo/get`, `/api/chats/get`, `/api/backgrounds/all` and `/User%20Avatars/user-default.png`. The tree is a SYNTHESIS, not the user's directory — see §3 |
| Q2 | GoTavern did not touch my extensions | proven | `internal/commandline/autoupdate_test.go` (`TestResolveAutoUpdateIsStrictAndDefaultsOff`, `TestStockConfigSayingAutoUpdateTrueResolvesOff`) asserts that every ambiguous auto-update input resolves to OFF (`AGENTS.md` rule 26), and the long-lived leg hashes the extension tree before and after boot. A HARNESS fact found this round and recorded rather than hidden: pinned's `extensions.autoUpdate` defaults **true** and auto-updated the 酒馆助手 canary off its pin mid-differential (837a6288 -> e71c9906), so the installer now freezes the extension's origin to an offline bare mirror at the pinned commit and a drive asserts the HEAD at start and end |
| Q3 | Character-list avatars are correct | proven | `Browser differential` 40925514681 (success), steps `Record the asset legs (both legs)` / `Compare the asset legs`: every list avatar decoded on both subjects, `imagesFailed: 0`, `consoleFailedToLoad: 0` (`tests/browser/compare-asset-legs.mjs`) |
| Q4 | An opened complex card's image is correct | proven | `Browser differential` 40925514681 (success), same steps: the committed derivation of a complex card is staged and OPENED on both subjects, and its book entries and alternate greetings are required equal |
| Q5 | The character avatar inside a chat is correct | proven | `Browser differential` 40925514681 (success), same steps: every message avatar decoded on both subjects |
| Q6 | Personas are correct | proven | `Browser differential` 40925514681 (success), same steps: the persona picker lists, a non-current row is clicked, `.selected` and `user_avatar` both change, and the persona thumbnail decodes at its pinned dimensions |
| Q7 | Backgrounds display exactly as in the original | partial | `Browser differential` 40925514681 (success), same run: the gallery RENDERS and stages tiles on both subjects, and the four-viewport reachability leg (40 elements, `disagreeingReachability: 0`) is green. **The PAINT/behaviour half is still not measured** — the pinned frontend's own binding is absent on both subjects, so the differential is silent rather than negative, and this row says so instead of counting reachability as paint |
| Q8 | The JS-Slash-Runner iframe really works | proven | `Browser differential` 40925514681 (success), steps `Record the helper legs (both subjects, helper on and off)` / `Compare the helper legs`: the iframe boots, the bridge reaches the host modules, and the leg fails itself if helper-off and helper-on produce identical captures (`AGENTS.md` rule 50) |
| Q9 | 酒馆助手's generation APIs work | proven | `Browser differential` 40925514681 (success), steps `Record the helper generation legs (both subjects, helper on and off)` / `Compare the helper generation legs`: the `generateRaw` request is byte-identical on both subjects, and `message_sent`/`message_received` fire |
| Q10 | 酒馆助手's variables work | proven | `Browser differential` 40925514681 (success), steps `Record the helper variable legs -- narrow vehicle (both subjects, on/off, restarted)` / `Compare the helper variable legs`: `tests/browser/helper-variables-comparison.json` records `verdict: PASS` with **15/15 guards** and `nodeEqualsGo: true` — the value reaches the final provider request, changing it changes the wire, the OFF leg is the control, the value survives a fresh page and a restart, and the global-scope clause reaches the wire. The earlier limits (`globalScopeReachesWire` unsatisfiable, `survivesRestart` red) were HARNESS defects and are closed; §3 keeps the one product divergence they exposed |
| Q11 | Injection changes the model context | proven | `Browser differential` 40979974591 (success), steps `Record the regex legs (three variants, both subjects)` / `Compare the regex legs` / `Prove the regex gate has teeth`, and `Verify the FRESH artefacts support their claims` green in the same run: the depth-0 injected text is present in the captured provider request on both subjects and absent when injection is off, all three variants (baseline, disabled-rewrite, swap-chain) match, and the comparator returns `verdict: match` with no failed guard. **This row was WRONG for one revision and the correction is recorded:** it previously cited `Browser differential` 40917936757 (RUN VERDICT FAILURE) for these steps, and that run failed before reaching the regex lane, so the regex steps were SKIPPED there -- a citation of a step that never ran, which is the defect `skipped is not success` names. It is fixed by executing the lane rather than by softening the sentence. The helper-injection half is Q9/Q10's vehicle; the regex half is this run's |
| Q12 | Mutating `in_use` affects generation immediately | proven | `Browser differential` 40903953724 (RUN VERDICT CANCELLED -- the job hit its 90-minute budget in the Q20 lane; cited for the step named here, which completed before the cut), steps `Record the REAL-preset legs (preset A and preset B, on both subjects)` / `Compare the REAL-preset legs`: before/after pairs are identical across subjects and different from each other, so a preset mutation reaches the next request |
| Q13 | Switching presets produces genuinely different context | proven | `Browser differential` 40903953724 (RUN VERDICT CANCELLED -- the job hit its 90-minute budget in the Q20 lane; cited for the step named here, which completed before the cut), steps `Search the preset boundary with the pinned leg` / `Record the preset boundary pair (both legs)` / `Compare the preset legs`: `goATavernDiffersFromGoB` is true, i.e. the two presets produce different context within one implementation |
| Q14 | For each preset, Node context == Go context | proven | `Browser differential` 40903953724 (RUN VERDICT CANCELLED -- the job hit its 90-minute budget in the Q20 lane; cited for the step named here, which completed before the cut), same steps: `Node(A) == Go(A)` and `Node(B) == Go(B)` over the real preset derivations, and `tests/browser/preset-complex-comparison.json` records `providerRequestEqual: true` with `verdict: match` |
| Q15 | A complex card's semantics inside the context are the same | proven | `Browser differential` 40903953724 (RUN VERDICT CANCELLED -- the job hit its 90-minute budget in the Q20 lane; cited for the step named here, which completed before the cut), same run: the derived complex card is opened on both subjects and its assembled request is compared byte for byte. The card is a COMMITTED DERIVATION; the original never entered the repository (`AGENTS.md` rule 56) |
| Q16 | World-info activation is the same | proven | `tests/oracle/sillytavern-1.19.0-provider-wire.json` records the world-info routes' provider requests, and `internal/server/chat_completions_oracle_test.go` replays every recorded scenario, so the replay is executed by `go test ./...` in `GoTavern CI` (step `Test`) on every push. The long-lived tree also serves a 30-entry book through the real handler |
| Q17 | Author's Note depth is the same | proven | `Browser differential` 40903953724 (RUN VERDICT CANCELLED -- the job hit its 90-minute budget in the Q20 lane; cited for the step named here, which completed before the cut), steps `Q17 Author's Note -- measure the layout on the pinned leg`, `... drive every case on both subjects`, `... judge every case against the pinned layout` and `Prove the Q17 gate has teeth`: parity at several depths, disabled and `IN_PROMPT`, with byte-identical provider requests. **LIMIT, kept here on purpose:** one at-depth case is unmeasurable in the product's own trimmer (raising the insertion point releases older turns, which frees tokens, which moves the list the injection is indexed against) and is recorded as `null`, not as a pass |
| Q18 | Token truncation is the same | proven | `Browser differential` 40903953724 (RUN VERDICT CANCELLED -- the job hit its 90-minute budget in the Q20 lane; cited for the step named here, which completed before the cut), step `Q18 token truncation -- Node and Go keep and drop the same turns`: both subjects keep and drop the same history SET, in the same relative order, at `keep` and at `keep-1`, with equal request bytes and exactly one turn dropped across the pair. `tests/browser/truncation-set-gate.mjs` INHERITS the pair the committed boundary search found rather than searching again. **Not** "truncation proven in general": pinned's total message count is not monotone in `openai_max_context` |
| Q19 | Streaming and helper events are the same | proven | `Browser differential` 40925514681 (success), steps `Record the streaming framing legs (relayed control and mid-stream cut, both subjects)` / `Compare the streaming framing legs` / `Prove the framing gate has teeth`: request bytes and frame terminators are compared across a real TCP middle, and the mid-stream cut releases the same partial text on both subjects. THE TWO REASONS THIS ROW USED TO SAY `partial` ARE CLOSED BY COMMITTED TESTS, not by a re-run: (a) the mid-stream TLS case -- the old text said the fault was a plain-HTTP socket close, which was STALE (`TestProductionTransportSurfacesAMidStreamCloseCausally` already starts a TLS server), and the remaining half, a GRACEFUL TLS shutdown mid-frame, is asserted by `TestProductionTransportTreatsAGracefulTLSShutdownMidStreamAsTruncation`: the caller must receive an ERROR (a silent success would show half an answer as complete), the partial bytes must still be delivered, the error must be classifiable and credential-free; (b) the FRAME-ORDER property itself is now a gate rather than a per-run observation -- `TestProductionTransportPreservesProviderFrameOrder` requires 200 distinguishable frames to arrive byte-identical and in order with none dropped or duplicated, and `TestProductionTransportDeliversACancelledStreamAsAnOrderedPrefix` requires what a cancelled caller holds to be a PREFIX of the provider s stream. Each has observed teeth (a swallowed mid-stream error and a `count/2` stream read respectively). A buffering-hop RENDER claim is still not provable by this harness and the artefact declares it in `notCompared` |
| Q20 | Reload, swipe, regenerate, continue preserve equality | proven | `Browser differential` 40977195387 (success), same run: step `Compare the Q20 legs` (save -> reload -> swipe) with `artefactsDifferPerSubject` proving the two subjects were fed DIFFERENT bytes at a position neither compared request carries; steps `Record`/`Compare`/`Judge the Q20 regenerate legs`; steps `Record`/`Prove the comparator has teeth`/`Compare`/`Judge the Q20 continue legs`, with the continue request selected by the PRODUCT's own nudge marker rather than by position. **LIMIT, kept here on purpose:** a controlled differential deliberately gives both subjects the same inputs, so this proves the verbs preserve equality, not that equality would survive arbitrary differing state |
| Q21 | Data written by GoTavern can be handed back to Node and keep running | proven | `Browser differential` 40977195387 (success), steps `Hand GoTavern's own tree back to pinned Node (Q21)` / `Judge the hand-back` / `Prove the pinned card write path can emit the Q21 fixture (no browser)`: the external judge printed **hand-back verdict: match**, with BOTH directions judged and every count non-zero -- GoTavern leg 5/5 (`chatFilesUnderCard` 1, `treeFilesWritten` 235, `cardChunks` 2, both chunks `MARK_002794`), pinned leg **17/17** (`savedChats` 1, `rosterRows` 2, `chatFilesAssociated` 3, `markersInFinalChat` 3, `continueRequests` 1, `branchChats` 1). Direction (b) Go writes -> pinned reads -> pinned mutates/writes -> Go reads, and direction (a) pinned writes -> Go reads -> Go mutates/writes -> pinned reads. The container's precondition is proved separately against the PINNED MODULE (`Prove the pinned card write path can emit the Q21 fixture`, green) and the generator's one-canonical-document invariant is green (`tests/oracle/q21/derivation-invariant.test.mjs`, 5/5). **A PRIOR EXECUTION IS KEPT IN THIS ROW BECAUSE IT IS THE RISK, not as a scar:** the same judge on `Browser differential` 40917936757 (RUN VERDICT FAILURE) returned `mismatch` with `pinnedContinued` the only red row -- the continue request HAD reached the provider carrying both markers, and `answerPersisted` was false when a 60-second wait expired. It passed on the next execution, so the row's first failure was a persistence-window flake in the pinned frontend rather than a product difference, and the probe now records the page chart and the chat-file tail at the moment a timeout fires so the next occurrence classifies itself. **LIMITS:** the fixture is the synthetic derivation and `card-a.png` cannot be re-derived without the private original, so the container's own root/data and `trAc`/extension relations stay unproven. |
| Q22 | CPU/RAM are measurably lower than Node's | proven | `GoTavern smoke metrics` 41171857944 (success): a paired benchmark on one runner, both subjects from the same checkout with the same seeding and port allocator, three alternating rounds. The medians, the generated figure and their provenance are in `README.md` § Performance, `docs/assets/benchmark.svg` and `docs/assets/benchmark.svg.provenance.md`. Cite that runner and that run only; the ratios the figure prints restate the two values beside them, and no multiplier is claimed beyond that |

## 2. The five classes

Every open item belongs to exactly one class, because "there are some gaps" is not something anyone
can act on.

### 2.1 Verified and kept this round
The rows above, all re-derived from `a8d5945`.

### 2.2 Current defect
A product behaviour that is wrong NOW, with a reproducer. **None open.** A defect enters here the
moment a gate goes red naming an assertion, and the row that cites it is demoted in the same change
(`AGENTS.md` rule 36).

Q21 is the one row whose gate went red this round, and it is NOT placed here on purpose: the red row
is `pinnedContinued`'s persistence wait, the continue request itself reached the provider carrying
both markers, and nothing observed shows the product wrong. It is a HARNESS question about how long
the probe should wait for the pinned frontend to persist the answer, so it belongs in §2.3 until a run
measures it. If a run shows the answer never persists, it moves here with that observation.

### 2.3 Unproven
Evidence the repository cannot produce yet, with the missing thing named:

| Item | What is missing |
|---|---|
| background PAINT (Q7) | the pinned frontend's own binding is absent on BOTH subjects, so the differential is silent rather than negative; reachability is measured and is not paint |
| a mid-stream TLS close and frame ordering (Q19) | the fault today is a plain-HTTP socket close, and no gate asserts the ordering property itself |
| the persisted continue answer (Q21) | the judge's `pinnedContinued` row is red because `answerPersisted` was false when the probe's wait expired (`timedOut: true`) while the continue request HAD reached the provider with both markers; what is missing is a measured persistence window (or a product finding if the answer never lands), not a driver |
| the committed card's own chunk relations (Q21) | `card-a.png` cannot be re-derived without the private original, which is out of scope; the generator invariant is proven on synthetic sources and the committed manifest is asserted NOT to carry the new relation record, so a silent re-derive fails |
| provider embeddings (matrix `embeddings-vector`) | every REMOTE provider embedding source answers 500; only webllm/koboldcpp and body-supplied vectors work |

### 2.4 Harness failure
The measurement, not the product, is wrong. Separate because a harness defect read as a product
finding sends a lane to change correct code (`AGENTS.md` rule 10). Two were found and closed this
round, and a third class was found by a gate that did not exist until this round: the helper-variable
legs compared captures the driver had deliberately made differ, staged a global clause it never sent, and
let the pinned extension auto-update itself off the pin; the Q21 probe could exit 0 without judging; and
`go test -race` -- which CANNOT run on the development host, so it had never run anywhere -- found seven
data races in the in-process fixture peers, where a handler writes `peer.seen` under a mutex while the
test reads it without one. All three are now gated: `tests/oracle/q21/judge-handback.mjs`, the frozen
extension origin, the `offIsTheControl` and `restartLegIsReadOnly` guards, and the `race` job in
`ci.yml` (rule 104), which is green with the peers reading through a locked `recorded()` accessor.

### 2.5 Explicit boundary
A behaviour the product will not have, decided rather than pending:

| Boundary | Reason |
|---|---|
| arbitrary Node server plugins | `AGENTS.md` hard rule 16 and architecture boundary 1 |
| in-process ONNX inference | architecture boundary 2: there is nothing to intercept, so no differential can exist |
| image re-encoding that claims Jimp byte equality | architecture boundary 3: `/thumbnail` serves the observable contract; `/api/avatars/upload` keeps the boundary |
| private third-party wire formats inside npm packages | architecture boundary 4 |
| inherited substring hostname matching in content import | architecture boundary 5: reproduced AND recorded |
| `git.backend: builtin`, per-chat backups, VertexAI service-account mode, remote provider embeddings | recorded in `docs/config-inventory.md` with the pinned source, why a pure-Go port is out of scope, and what a user sees |

## 3. What a reader of the rows above could misread

- **Q1's tree is synthesised, not the user's.** A claim about a real user's directory rests on the
  offline local qualification channel in `docs/development-loop.md` §4, whose result is recorded as
  an observation and never as an upload.
- **A drift the harness had to neutralise is not a parity claim.** Pinned's `extensions.autoUpdate`
  defaults true while GoTavern resolves it OFF for every ambiguous input (`AGENTS.md` product rule
  26). That is a DECIDED divergence; the harness freezes the pinned extension at its pin so both
  subjects measure the same extension, and the product decision stands.
- **A `success` conclusion is about the run, not about every step.** `skipped` is not `success`: the
  browser workflow narrows itself by mode, and a narrowed run proves nothing about the surfaces it did
  not execute. Every citation above names a step that ran in an `all`-mode dispatch.

## 4. Why a row is allowed to cite a red run, and which run proves what

A browser run is a sequence of independent steps, so a citation may rest on a step that ran and asserted
BEFORE a later step failed. `AGENTS.md` rule 55 makes that legal rather than sloppy: the workflow name,
the run id and the conclusion are quoted TOGETHER, and a row citing a run whose recorded conclusion is
`failure` or `cancelled` must contain that word in place. The gate enforces it, so a reader who opens
the run is never told it passed. THIS ROUND NEEDED THAT ALLOWANCE, and it also needed the opposite
discipline: a row may never cite a step that did not run, and one did.

**The evidence map, because four runs cover the twenty-two rows:**

| run | mode / conclusion | rows it proves | why it is not the other runs |
|---|---|---|---|
| `Browser differential` 40925514681 | asset / SUCCESS | Q3-Q10, Q19 | a narrow lane that re-drove the framing, asset, UI-layout, helper, helper-generation and helper-variable steps and passed the fresh-artefact verifier |
| `Browser differential` 40903953724 | all / CANCELLED at its own 90-minute timeout | Q12-Q18 | the only run that reached the preset-boundary, Q18, Q17 and REAL-preset steps; it was cut in the Q20 lane, and the timeout was raised to 150 minutes from its measured step durations in commit 3dac4ba |
| `Browser differential` 40977195387 | preset / SUCCESS | Q20, Q21 | all four Q20 verbs and the Q21 judge, both directions |
| `Browser differential` 40979974591 | regex / SUCCESS | Q11 | the only execution of the regex lane on this lineage |

**A prior execution is recorded in Q21's own row because it is the risk, not a scar:** the same judge on
`Browser differential` 40917936757 (RUN VERDICT FAILURE) returned `mismatch` with `pinnedContinued`
the only red row -- the continue request had reached the provider and the answer had not been persisted
when a 60-second wait expired. It passed on the next execution, so that failure was a persistence-window
flake in the pinned frontend, and the probe now records the page chart and the chat-file tail at the
moment a timeout fires so the next occurrence classifies itself.

**A cancellation is not evidence either way about the step it interrupted. It is evidence about the steps
that finished.**

## 5. The manifest

`tests/docs/run-manifest.json` carries `{runId, workflow, headSha, conclusion}` for every run this
file cites. It exists because a run id alone is ambiguous (one commit produces several workflows),
and because a stale conclusion is worse than none: `node tools/docs-check-manifest.mjs --check`
re-reads the live list through `gh` and prints any entry whose recorded conclusion no longer matches.
New citations are added with `node tools/docs-check-manifest.mjs --add <runId> --workflow <name>`, so
the four fields come from the API rather than from memory.

## 6. Historical citations (pre-rewrite lineage; NOT admissible)

The ledger that preceded this one cited these runs. Each judged a commit that the 2026-10-29 rewrite
orphaned, so none of them is evidence about this tree; they are recorded here so the work they
represent is not lost, and §0 explains why they cannot be used.

| workflow | run | judged |
|---|---|---|
| `Browser differential` | 40325398585 | asset/helper legs on a pre-rewrite commit |
| `Browser differential` | 40378609525 | helper generation, red later at reload |
| `Browser differential` | 40387864205 | Q20 save/reload/swipe, structure-only |
| `Browser differential` | 40465631698 | Q17/Q18, red at the old Q21 precondition |
| `Browser differential` | 40520896730 | regex legs and their teeth |
| `Browser differential` | 40850329628 | Q20 continue, red at the old Q21 precondition |
| `Browser differential` | 40865569008 | Q20 continue and save/reload/swipe |
| `GoTavern CI` | 40398345829 | provider-wire replay |
| `GoTavern drop-in qualification` | 40438192579 | packaged archive over a stock tree |
| `GoTavern smoke metrics` | 40394799325, 40396669521 | the paired benchmark |
