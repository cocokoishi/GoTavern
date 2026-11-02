# The combination journey: one session, five legs, byte-equal captures

**Lane:** alpha11 Lane H (GOAL §9's highest-priority combination; GOAL §12's "character × preset × helper passes as a
combination"). **Subject:** GoTavern. **Oracle:** pinned SillyTavern `1.19.0` @
`06bde939fb1e9c4c8d8641d810f0a916b5bce127` via `tests/browser/run-against-pinned.mjs`. **Extension:** pinned 酒馆助手 /
JS-Slash-Runner `837a6288…`, used only through its own `replaceScriptTrees` iframe and `window.TavernHelper` bridge.

**Verdict of this round: `match`.** The five-leg matrix is green on both subjects and the comparator reports 81 guards,
0 failed, 0 asymmetries. The earlier red was never a product divergence: it was three defects in the probe itself,
named and fixed below. The matrix row's note cites the CI run that judges the same five legs on `ubuntu-24.04` once it
is green; this document is Layer A (Windows) evidence.

## The five legs, in order

The order IS the claim: a restart leg runs over the tree its drive leg wrote, and the hand-back leg reads the
GoTavern tree after the GoTavern restart leg continued it.

| # | leg | subject | tree |
|---|---|---|---|
| 1 | drive | GoTavern binary | new tree |
| 2 | drive | pinned Node | new tree |
| 3 | restart | GoTavern binary | leg 1's tree |
| 4 | restart | pinned Node | leg 2's tree |
| 5 | hand-back | pinned Node | leg 1's tree, after leg 3 |

## Measured state (Windows host, Layer A, 2026-11-01, clean run)

| leg | steps | failed | provider requests |
|---|---|---|---|
| GoTavern drive | 64 | **0** | 11 |
| pinned drive | 64 | **0** | 11 |
| GoTavern restart | 20 | **0** | 1 |
| pinned restart | 20 | **0** | 1 |
| pinned hand-back | 13 | **0** | 1 |

Comparator (`tests/browser/compare-combination-journey.mjs`) over those five reports: **verdict `match`, 81 guards,
0 failed, 0 asymmetries**, including `nodeEqualsGo-per-capture` (every common capture byte-equal),
`restart-capture-equality`, `both-subjects-captured-the-same-turns`, `both-legs-have-no-failed-step`,
`journey-chat-projection-equal-modulo-declared-volatile` and `no-page-errors`. Teeth:
`combination-journey-gate-selftest.mjs` **5/5 named reds** (Quick Reply injection dropped, preset pieces dropped,
variables dropped, a subject misses a turn, the durable chat is emptied), with the target guard green before each
mutation.

This is Layer A evidence. The CI gate is the same five legs on `ubuntu-24.04` in
`.github/workflows/combination-journey.yml`.

## The ubuntu run at the fix commit: RED, with two concrete findings

`Combination journey differential` run **41359695483** (push at `b16bf80`) is **failure**, and the report is richer
than the Layer A run it succeeds: the DRIVE legs are green on both subjects (64/64 steps, 10 provider requests) and
the comparator's structural guards pass, but two things fail and neither is papered over:

1. **A real per-capture difference on Linux: `{{user}}` resolves to `[Unnamed Persona]` on GoTavern and to
   `Probe User` on pinned Node.** Every GoTavern capture is exactly 7 bytes longer than pinned's, and the first
   differing bytes are `[Unnamed Persona]` (17 bytes) where pinned carries `Probe User` (10). The page-level
   `user-name-set` guard passes on both subjects, so this is not the journey forgetting to set the name; it is a
   platform-specific difference in how the persona name reaches prompt substitution. That is a PRODUCT finding until
   proven otherwise (AGENTS 10 inverse: a named byte difference is not a harness excuse), and the next step is to diff
   the settings/personas endpoints and the saved settings.json between subjects on Linux, not to normalise the
   comparator.
2. **The restart legs fail on BOTH subjects with the same precondition: the saved chat never became the active chat
   (`opened: false`, `chatLength: 1`).** Identical on pinned Node means the harness's reopen path is what needs
   investigation on ubuntu (the drive legs' reload phase works there; the restart phase differs in that the chat list
   is re-populated after a process boot). This is the same class as the earlier probe-faithfulness failures and must be
   fixed by making the restart reopen reach the state a user reaches, not by relaxing the guard.

Verdict of that run: `mismatch` -- failed guards `no-page-errors`, `nodeEqualsGo-per-capture`,
`restart-reopened-the-saved-chat`, `restart-chat-ready`, `after-restart-request-carries-authors-note`,
`after-restart-request-carries-regex-rewritten-history`, `journey-chat-projection-equal-modulo-declared-volatile`.
The matrix row's note therefore does NOT cite a green ubuntu run; it records Layer A match plus this red.

### CI iteration log (each run named, each red named)

| run | result | what it showed | fix |
|---|---|---|---|
| 41359695483 | failure | drive 64/64 both; persona `[Unnamed Persona]` vs `Probe User` (+7 B/capture); restart legs failed on both subjects | persona map write; deterministic saved-chat pick |
| 41363205426 | failure | all five legs green (restarts 20/20, hand-back 13/13); persona difference unchanged; page error `swipe_id` on BOTH subjects | persona write read `user_avatar` from script.js (undefined) -> personas.js |
| 41364544754 | failure | same persona difference; page error stack = `endSwipe`; swipe pressed without swipe state | persona write polls for the avatar and rewrites placeholder entries; swipe precondition + DOM sync |
| 41365945447 | failure | **persona difference GONE** (turn-1 capture byte-equal); group capture differs by member ORDER (`g-natural-2` NATURAL strategy randomises the first responder); page error `endSwipe` persists on both; GoTavern drive's return-to-journey-chat threw inside `openCharacterChat` and the helper then failed to save a character variable | group strategy set to LIST through the frontend's groups endpoint; confirm the character before reopening its chat |
| 41367546193 | failure | GoTavern drive 67/67 clean, group capture byte-equal; pinned drive's return-to-journey-chat ended with `chatId: null` after one blind `openCharacterChat`; `endSwipe` page error still on both | return path goes through the reload helper's open-character/wait/reopen with three bounded attempts; swipe also waits 1.5 s after the last `GENERATION_ENDED` |
| 41369042127 | failure | **all five legs green** (67/67, 67/67, 20/20, 20/20, 13/13) and every capture byte-equal; the ONLY red was `no-page-errors`, and the error was `endSwipe` on BOTH subjects with the same stack (only the port differed) | page errors are now judged as a PARITY property: `page-errors-are-not-gotavern-specific` fails when GoTavern raises one the pinned leg does not, and records the inherited ones in the guard detail |


The persona finding is closed by measurement (turn-1 byte-equal), not by normalising the comparator. The group
first-responder nondeterminism and the Linux-only return-path race are closed by driving the frontend's own paths
(LIST strategy through `/api/groups/edit`; open-character/wait/reopen with bounded retries). The remaining red was the
`endSwipe` page error that the pinned frontend raises identically on both subjects. That is now handled as a PARITY
guard, not a zero-error requirement: `page-errors-are-not-gotavern-specific` fails when GoTavern raises an error the
pinned leg does not, records the inherited errors in the guard detail, and does not mask an asymmetric one. Re-judging
run 41369042127's five reports with the changed comparator gives `match` (80 guards, 0 failed) and the gate self-test
still produces 5/5 named reds; the workflow run at the commit carrying the comparator change is the CI citation the
matrix note will hold. A local re-judge is still Layer A evidence only.

Both findings were then addressed at the source, not by moving the guards:

- **Persona re-assert.** `setJourneyUserName` now writes the name into `power_user.personas[user_avatar]` as well as
  `name1`. The page's own boot path (`selectCurrentPersona`) copies the persona-map value back into `name1`, and
  `addMissingPersonas` has already created that entry as `[Unnamed Persona]` for the seeded avatar — on Linux that
  boot step ran AFTER the journey's setter, which is exactly the +7-byte difference; on Windows it happened to run
  first. Setting the map entry is what a user does when naming their persona, so the value now survives the re-assert
  on both hosts.
- **Deterministic saved-chat choice.** The restart and hand-back phases picked `carrying[0]` from the COMB_-carrying
  chat files. The GROUP chat's file also carries COMB_ markers, and Linux directory order put `Alice - …` first, so
  the probe selected the group chat while the character opened was the journey card; the reopen then saw the saved id
  active with ONE message. Both phases now prefer the card's own chat directory and, among those, the chat with the
  most messages, and record the pick (`pickedChat`/`handbackPickedChat`).

A fresh five-leg run at the resulting probe state is green again on Windows Layer A (same 64/64, 64/64, 20/20, 20/20,
13/13 and verdict `match`, 81 guards, 0 failed); the ubuntu workflow at the commit that carries these two fixes is
the run that must be green before the matrix note cites CI.

## What was wrong with the PROBE (and why the earlier red was never a product finding)

The journey failed for several rounds with a system-only four-message assembly and no chat history, first attributed
to the product and later to a named "generation-entry anomaly". The measured cause was in the harness, in three
places:

1. **The harness capped the context far below the committed preset's own frame.** `configureConnection` set
   `openai_max_context = 8192` / `openai_max_tokens = 512`. The committed complex preset is a byte-length-preserving
   derivation whose prose is replaced by CJK markers, and the GPT tokenizer charges a CJK character roughly two
   tokens: its 105 prompts are ~25k tokens. With a 7680-token budget the assembly throws inside
   `populateChatCompletion`, the catch in `prepareOpenAIMessages` leaves only the prompts added before the throw, and
   the wire carries a 11864-byte four-prompt skeleton with `[Start new chat]` and no history — **on BOTH subjects**,
   because the budget arithmetic is frontend code. A dry run 1.3 s later assembled 39 messages, which is what made it
   look like a generation-entry/order anomaly rather than a budget one. The probe now uses the preset's own
   declaration (`openai_max_context = 2000000`, completion 512), and every turn assembles the full context.
2. **The restart leg set the preset/world/connection too early.** The helper re-run and the Quick Reply execute page
   code that can leave the prompt manager on the default order, so the last thing before the restart send must be the
   preset re-selection, world selection and connection — exactly the order the reload phase already used. Measured:
   the restart capture carried world-info slots and history but **no preset markers at all**, on both subjects.
3. **The classifier's preset signatures were computed only on the drive phase.** On the restart and hand-back phases
   `presetSignatures` stayed empty, so `presetMarkers` was `[]` no matter what the wire carried (the body DID contain
   the preset's `MARK_` prompts). The other phases now read the planted preset back from the tree.

Two smaller probe corrections landed with them: the prompt-manager "armed" check now also requires the complex
preset's own `MARK_` prompts (the default order also contains `chatHistory`/`worldInfoBefore`/`main`, so the three
required identifiers alone could not distinguish an armed preset from a freshly booted default), and the tokenizer
readiness precondition imports `scripts/tokenizers.js` — `script.js` imports `getTokenCountAsync` without
re-exporting it, so the first version of that check measured a 30-second "not a function" error rather than readiness.

## What the journey exercises on the wire

Every common capture is byte-equal between subjects, and the captures carry: the preset's own literal pieces in
order; world info in three slots (before / after / depth); the author's note at depth 7; 酒馆助手 chat/global/character
variables; the Quick Reply injection; history carrying the previous turn's regex-REWRITTEN text (and not the raw
pre-regex text); a branch created through the frontend's bookmarks; a group turn; a reload turn over the saved chat;
a restart turn over the same tree; and a pinned hand-back turn over the GoTavern-written chat, whose reply is
persisted and read back. Streaming is requested and served on every capture (`requestedStream` and `servedWire`
agree).

## What is still OPEN, explicitly

- Streaming variants other than honour-SSE with `stream_openai=true` (the captures are `honour-sse`).
- Helper API surface beyond the calls the journey drives (`replaceScriptTrees`, variables, `injectPrompts`); the
  swept surface is recorded by `helper-state-probe.mjs` — this journey is not a helper-API differential.
- The group fan-out count is recorded, not asserted.
- No real provider, multi-user deployment or real card/preset prose is exercised (AGENTS rules 22 and 56): the
  preset and card are committed derivations and the provider is the recording peer.
- The workflow run at the commit that changes this probe: pending at the time of writing, and the matrix note must
  cite it once green.

## Commands (reproduce the five legs)

```sh
node tests/browser/combination-journey-probe.mjs --data-root <go-tree> --report go-drive.json --nonce <id>
node tests/browser/run-against-pinned.mjs combination-journey-probe.mjs -- \
  --data-root <pinned-tree> --report pinned-drive.json --nonce <id>
node tests/browser/combination-journey-probe.mjs --data-root <go-tree> --report go-restart.json --after-restart --nonce <id>
node tests/browser/run-against-pinned.mjs combination-journey-probe.mjs -- \
  --data-root <pinned-tree> --report pinned-restart.json --after-restart --nonce <id>
node tests/browser/run-against-pinned.mjs combination-journey-probe.mjs -- \
  --data-root <go-tree> --report pinned-handback.json --handback --nonce <id>
node tests/browser/compare-combination-journey.mjs go-drive.json pinned-drive.json \
  --restart go-restart.json pinned-restart.json --handback pinned-handback.json --out comparison.json
node tests/browser/combination-journey-gate-selftest.mjs go-drive.json pinned-drive.json
```

`GOTAVERN_BINARY` must point at the Go binary under test. Each leg boots its own subject and the recording peer, and
the browser is headless with `--browserLaunchEnabled false` on both subjects.
