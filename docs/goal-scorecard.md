# GOAL §7 scorecard — one row per user-facing question, with the evidence this repository can actually cite

GOAL §7 says: "These are the questions the project must be able to answer with evidence. Answering them with test
counts is a failure to answer." So each row below names an ARTEFACT: a workflow run and the step or field inside it,
or a document. A row without such a citation says `unproven`, in those words, rather than being left out.

This file was created because the evidence existed while the ANSWERS did not: HANDOFF recorded work by topic, while
GOAL asks by question, so nine of these were provable but unanswerable without a search.

| # | Question | State | Evidence |
|---|---|---|---|
| Q1 | A long-lived SillyTavern directory starts directly | proven | `GoTavern drop-in qualification` per push, step "Smoke 0/4 -- the ARCHIVE binary against a LONG-LIVED user directory"; `tests/e2e/longlived_test.go` asserts every planted file byte-identical after boot plus `/characters/<card>.png`, `/thumbnail?type=avatar`, `/api/worldinfo/get` (30), `/api/chats/get` (12 messages), `/api/backgrounds/all`, `/User%20Avatars/user-default.png` |
| Q2 | GoTavern did not touch my extensions | proven | auto-update defaults to OFF for every ambiguous input (AGENTS 26); extension lanes assert no silent update; `docs/startup-state-machine.md` |
| Q3 | Character-list avatars are correct | proven | `Browser differential` 40325398585 (#15/#16 asset legs): `imagesFailed: 0`, `consoleFailedToLoad: 0`, every list avatar decoded on both legs |
| Q4 | An opened complex card's image is correct | proven | same run: the real 18.5 MB-derived card staged and OPENED on both subjects, 490 book entries, 5 alternate greetings, structure required equal |
| Q5 | The avatar inside a chat is correct | proven | same run: every message avatar decoded; swiped-message avatar re-renders and decodes |
| Q6 | Personas are correct | proven | same run: persona picker lists, a non-current row is clicked, `.selected` and `user_avatar` both change, thumbnail decodes 96x144 |
| Q7 | Backgrounds display as in the original | partial | gallery RENDERS 24 tiles with the staged tile present on both legs; the PAINT step stays in `unproven[]` because `initBackgrounds()`'s bindings are absent IDENTICALLY on both subjects (not a GoTavern gap) |
| Q8 | The JS-Slash-Runner iframe really works | proven | helper lanes: iframe boots, bridge reaches 25 host modules, `generateRaw` request byte-identical to pinned |
| Q9 | 酒馆助手's generation APIs work | proven | `generateRaw` request equals pinned's byte for byte; `message_sent`/`message_received` fire, observed in `Browser differential` 40378609525 -- THAT RUN JUDGED FAILURE, and the step the citation rests on is `first-turn-saved: ok` plus `listenerTimings` carrying message_sent 3 / message_received 4; the run failed later, at the reload step |
| Q10 | 酒馆助手's variables work | proven | Q10 lane: a variable set by the helper persists to the chat file and survives a reload (`40250495167`) |
| Q11 | Injection changes the model context | proven | depth-0 injection leg: the injected text is present in the captured request on both subjects |
| Q12 | Mutating `'in_use'` affects generation immediately | proven | `Browser differential` 40277640647: before/after pairs identical across subjects, different from each other (preset A 0716543c -> 5bf90078; preset B 61276bf1 -> 4ee6b389) |
| Q13 | Switching presets produces genuinely different context | proven | 40274214952: `goATavernDiffersFromGoB` true, `aSharedMarkers: 25` |
| Q14 | For each preset, Node context == Go context | proven | 40274214952: nine guards true, `Node(A)==Go(A)`, `Node(B)==Go(B)` |
| Q15 | A complex card's semantics inside the context are the same | proven | the real card is opened on both legs and its assembled request is compared byte for byte in the asset+picker legs (40325398585) |
| Q16 | World-info activation is the same | proven | provider-wire 220 scenarios close (`40398345829`), which includes the world-info routes' captures; the long-lived tree serves a 30-entry book |
| Q17 | Author's Note depth is the same | unproven | no leg varies Author's Note depth; the preset legs carry the preset's own depth settings but do not sweep them |
| Q18 | Token truncation is the same | unproven | exact tokenization is pinned (`1022 cases`) but no leg drives a context past the boundary on both subjects |
| Q19 | Streaming and helper events are the same | partial | `Browser differential` 40331271988 -- RUN VERDICT FAILURE (abort surface), cited for its RELAYED step, which passed: the relayed control proves both subjects cross a real TCP middle with identical request bytes and 15 frame terminators; a buffering-hop render claim is NOT provable by this harness and is named in the artefact's `notCompared` |
| Q20 | Reload, swipe, regenerate, continue preserve equality | partial | `40387864205`: save -> fresh-page reload -> second turn -> swipe, 7/7 guards, requests byte-identical across subjects; **regenerate and continue are unproven** and declared in `notCompared` |
| Q21 | Data written by GoTavern can be handed back to Node | unproven | no leg boots pinned Node on a tree GoTavern wrote; the long-lived test asserts byte-identical preservation of planted files, which is necessary and not the same thing |
| Q22 | CPU/RAM are measurably lower than Node's | measured | `GoTavern smoke metrics` 40394799325 + 40396669521, runner `ubuntu26`: boot 14,355 vs 61 ms, steady RSS 912 MB vs 37 MB, `GET /version` 62.7 vs 0.43 ms, 10-minute soak on both. Cite that runner and that run only; no multiplier is claimed |

## What this table changes

Q17, Q18 and Q21 are `unproven` and were not visible as such before: they were simply absent, and absence reads as
"probably covered" in a long handoff. Q7, Q19 and Q20 are `partial` with the unproven half named. Everything else has
a run id or a document a reader can open.

TWO CITATIONS POINT AT RUNS WHOSE VERDICT WAS FAILURE, and both say so in place: 40378609525 (Q9) and
40331271988 (Q19). Their run-level conclusion is red because a LATER step in the same leg failed; the step each row cites is
recorded green inside it. A reader who checks the run id will see ailure and must not read that as a contradiction.