# Persistence and resume: what a resumed turn must carry, and how the harness attributes it

Task: `task-1` (Beta 1, the OPEN item recorded in `HANDOFF.md` §"Accepted risks and open items" #1 and in
`docs/release-checklist.md` item 28). This file answers the question with oracle-backed evidence, records the
classification taxonomy that replaces the boolean assertion, and states what remains unproven.

## Verdict in one line

**The OPEN observation was a PROBE MEASUREMENT DEFECT, not a Go defect and not the user's preset.** The probe selected
"the resumed turn's request" as `completions().at(-1)` — the LAST completion when it looked — so any later completion
(a helper/extension quiet `generateRaw`, a title or summary request) was recorded as the resumed turn. The recorded
shape (exactly one `system` message, no restored history, no typed user turn) is precisely what the frontend's own
quiet path produces for a one-system-message prompt. Measured with the same journey, the same restart and the committed
derivation of the complex preset, the request the resumed SEND actually issues is a 12-message request that carries the
restored history, and it is **byte-identical between GoTavern and pinned Node**.

The leading hypothesis recorded when the item was opened — that the user's preset omits `chatHistory` from its runtime
prompt order, so a history-free request is legitimate — **is disproven for the committed derivation**. `preset-a.json`
is the derivation of that preset (manifest: 105 prompts, 109 order rows; the runtime row reports 98 rows / 56 enabled,
matching the audit), and its runtime row has `chatHistory` **present and enabled**. The classification taxonomy below
covers the omission branch anyway, because it is a real user-toggleable configuration and must be judged, not assumed.

## The question, stated so it can be falsified

After a real user closes the tab, restarts the server on the same data tree, and reopens the same chat, does the next
turn's provider request carry the conversation the page shows — and is that request equal to pinned Node SillyTavern's
for the same tree, chat, preset and input?

The version of it that was OPEN: the resumed turn's captured completion "was a single-system-message request that did
not carry the restored history markers". A single `system` message cannot be the send's request for this journey (the
send has a typed user turn and, when the prompt order enables `chatHistory`, the restored conversation), so the
observation was either a product defect or a request that was not the send's.

## What pinned does (oracle), read from the pinned source and measured

Every fact below is from the pinned baseline `06bde939fb1e9c4c8d8641d810f0a916b5bce127` (read-only oracle) and is
reproduced by the pinned leg of the run.

1. The chat-completion prompt manager is configured with the GLOBAL prompt-order strategy and `dummyId: 100001`
   (`public/scripts/openai.js:696-699`). Under that strategy the active character is `{ id: dummyId }`
   (`public/scripts/PromptManager.js:438`, `:1131-1132`), so the order a generation actually walks is the
   `prompt_order` row whose `character_id` is **100001** — not the 100000 row some presets also carry.
2. The prompt collection is built by walking that row and keeping entries whose `enabled` flag is true
   (`PromptManager.js:1516-1541`).
3. `populateChatHistory` returns **immediately** when the collection has no `chatHistory`
   (`public/scripts/openai.js:885-888`). So a runtime row without an enabled `chatHistory` produces a request with **no
   restored history**. That is correct pinned behaviour, and the same rule exists in the ported GoTavern path — it is
   the frontend that assembles the request, so the branch is shared, not re-derived per backend.
4. `chatHistory` is user-toggleable (`PromptManager.js:1099-1112` lists it in `forceTogglePrompts`), so "a preset whose
   runtime row disables it" is a configuration a real user can produce, not a synthetic state.
5. `generateRaw` (`public/script.js:4122`) with a one-system-message prompt posts through
   `/api/backends/chat-completions/generate` (`public/scripts/openai.js:3138-3154`) and its `createRawPrompt`
   (`public/script.js:3924-3963`) unshifts the system prompt. That is the shape a helper/extension quiet completion
   takes, and it is exactly the shape the OPEN observation recorded.

### Measured provider requests (local, Layer A; both subjects)

| configuration | runtime row observed | resumed SEND's request at the armed ordinal | Go == pinned |
|---|---|---|---|
| fresh install (`default` journey) | `chatHistory` present, enabled; 12 prompts / 12 runtime rows / 11 enabled | carries `WS_TURN_ONE`, `WS_TURN_TWO`, every restored reply and `WS_RESUMED` | yes, 47/47 guards |
| committed derivation `preset-a` selected, restart on the same tree | `chatHistory` present, **enabled**; 105 prompts / 98 runtime rows / 56 enabled | ordinal 1: 17 222 bytes, `sha256 770629b718e6504b1b62adadfba1c29f8f1a0df1aba761c1dad0d9f7c8fc7f06`, 12 messages (`system,system,assistant,user,assistant,user,assistant,user,system,user,system,assistant`), all restored markers present | yes, byte-identical |
| derived control: same bytes, runtime row's `chatHistory.enabled` set false | `chatHistory` present, **enabled=false**; 105 prompts / 98 rows / 55 enabled | ordinal 1: 16 041 bytes, `sha256 64e86f17e7af440eb8f0f60eb87e84404c8d8a388e83e3db925e7ac5380d93da`, 4 messages (`system,user,system,assistant`), **no restored history** | yes, byte-identical |
| helper quiet completion injected after the send (preset journeys) | n/a | ordinal 2: 199 bytes, `sha256 443842753fa8cb2e215f1f4ef2087cc47e4a9841b2ef402bc47caa59da86c327`, exactly 1 `system` message — the OPEN shape | yes, byte-identical |

The derived control is generated at run time from the committed bytes (`--preset-chat-history omit`), never committed:
it is a structural control, not a user's preset, and the artefact records the source digest, the one rewritten path,
and the before/after value. Its measured request shows what "history omitted by the preset" really looks like: the
restored conversation is absent, while the typed user turn can still reach the model through another enabled preset
prompt. That is why the assertion in that arm is about the **restored history**, not about the user's own message.

## Root cause of the OPEN observation

`tests/browser/whole-session-probe.mjs` read the resumed turn as:

```js
const resumedCompletion = completions().at(-1);
```

That answers "which completion was last when I looked". It is not "which completion did my send produce", and it
cannot be: the peer records any request that reaches it, so a later quiet/helper/title request becomes "the resumed
turn". The probe now arms the peer's completion ORDINAL immediately before the click (the click is what issues the
request), records the request at that ordinal, and records every later completion separately. The same selection defect
was in the comparator's `restart-completion-equal` guard (`at(-1)` on both legs), which compared whichever requests
happened to be last; it now compares the attributed ordinal.

The preset hypothesis is disproven for the committed derivation, as the table shows. What remains **unproven** is which
later request the historical private-tree run captured: that tree is the maintainer's own data and is not committed,
uploaded or printed (AGENTS rule 51/56), and the artefacts retained locally are from different qualification runs. The
mechanism is proven deterministically (the injected helper completion is that shape, it lands after the send, and the
old selection captures it), and the probe can no longer conflate the two — but the historical request is not attributed
to a named extension, and this document does not claim it is.

## The classification taxonomy (replaces the boolean)

Computed from the FRONTEND'S OWN prompt-order observation for the restart process, not from a journey label. The probe
records the observation; the comparator recomputes the classification from the artefact (the probe's verdict is an
observation, never the judge).

| runtime-row observation (character_id 100001) | classification reason | `historyExpected` | what the resumed request must show |
|---|---|---|---|
| `chatHistory` entry present, `enabled: true` | `prompt-order-row-enables-chatHistory` | `true` | both restored user turns, every restored reply, AND the typed resumed turn |
| `chatHistory` entry present, `enabled: false` | `prompt-order-row-disables-chatHistory` | `false` | none of the restored history, and Go == pinned bytes |
| `chatHistory` entry absent from the row | `prompt-order-row-omits-chatHistory` | `false` | none of the restored history, and Go == pinned bytes |
| observation missing/unreadable | `prompt-order-observation-missing` | `null` | the guards refuse: no arm is claimed |

The guards that consume it (all in `tests/browser/compare-whole-session-legs.mjs`):

- `resumed-request-attributed-to-the-send` — the request at the peer ordinal armed before the click exists, was sent
  after a real click, settled, and its digest matches the request at that ordinal.
- `resumed-classification-follows-the-prompt-order` — the recorded classification equals the rule's answer for the
  leg's own recorded observation.
- `restart-turn-carried-the-restored-history` — ONE guard, TWO arms: required-history legs must carry it; omission legs
  must not carry the restored history AND must carry one of the two omission reasons. Neither arm can pass silently.
- `restart-history-omission-is-preset-attributable` — red for an omission leg whose observed row does not explain the
  omission, or whose request nevertheless carries restored history.
- `resumed-request-ordinal-equal` — the two subjects were driven the same way, so the send's ordinal is the same on
  both.
- `restart-preset-restored-without-selection` — the new process read the preset the drive leg wrote, with the same
  structure, without the restart leg selecting anything.
- `restart-completion-equal` — byte equality (method, raw target, body digest, length) between the two subjects'
  attributed resumed requests.
- `restart-completion-count-equal`, `restart-helper-completion-equal`,
  `helper-completion-was-not-the-resumed-request` — the injected helper completion exists, has the single-system shape,
  is byte-equal across subjects, and is a DIFFERENT request from the send's.

## Evidence commands

Local (Layer A only; the Linux CI run is the gate). Worktree
`C:\Users\koishi\Desktop\GoTavern\gotavern-beta-persistence`, binary built with `CGO_ENABLED=0 go build -trimpath -o
.tmp-artifacts/bin/gotavern.exe ./cmd/gotavern`, `GOTAVERN_REFERENCE=..\SillyTavern`.

```powershell
# one journey = four legs: drive and restart, on each subject, over the same tree
#   default:     no --preset
#   preset:      --preset tests/browser/fixtures/real/preset-a.json --preset-name preset-a --helper-request-after-send
#   preset-omit: --preset tests/browser/fixtures/real/preset-a.json --preset-name preset-a-no-chat-history
#                --preset-chat-history omit --helper-request-after-send
node tests/browser/whole-session-probe.mjs --phase drive   --data-root <tree> --reply-prefix WSG_ --report <go-drive.json> [...journey args]
node tests/browser/run-against-pinned.mjs whole-session-probe.mjs -- --phase drive --data-root <tree> --reply-prefix WSP_ --report <pinned-drive.json> [...journey args]
# ... the same two commands for --phase restart over the SAME trees, then:
node tests/browser/compare-whole-session-legs.mjs --drive-go <...> --drive-pinned <...> --restart-go <...> --restart-pinned <...> --out <comparison.json>
node tests/browser/whole-session-gate-selftest.mjs --drive-go <...> --drive-pinned <...> --restart-go <...> --restart-pinned <...> --out <teeth.json>
```

Local report paths (gitignored, not committed): `.tmp-artifacts/ws-default-v2/`, `.tmp-artifacts/ws-preset-v2/`,
`.tmp-artifacts/ws-omit-v5/`, each holding `legs/whole-session-<phase>-<subject>.json`, `whole-session-comparison.json`
and `whole-session-teeth.json`; the mutation/restore evidence is in `.tmp-artifacts/ws-mutation/` and
`.tmp-artifacts/ws-restored/`.

Local results: default journey **match, 47 guards, 0 failed**, teeth **14/14 applicable** (4 mutations not applicable
because that journey carries no preset/helper); preset journey **match, 47 guards, 0 failed**, teeth **18/18
applicable**; omit control **match, 47 guards, 0 failed**, teeth **17/17 applicable** (`K`/`L` need the
history-required arm and are reported not-applicable there). The mutation run's reports and the byte-verified restore
are in `.tmp-artifacts/ws-mutation/`, `.tmp-artifacts/ws-restored/` and `.tmp-artifacts/mutation-restore.log`. Provider-
wire digests for the resumed requests are in the table above and are identical between subjects in every arm.

CI (the gate; the Lead dispatches it after merge — no inputs):

- workflow: **`GoTavern whole-session differential`** (`.github/workflows/whole-session.yml`), event `workflow_dispatch`
  (it also self-triggers on pushes touching the probe, the comparator, the teeth proof, the derivation fixtures or the
  workflow itself);
- the job records **12 legs** (3 journeys × 2 subjects × drive+restart), runs **3 comparator invocations** (one per
  journey) and **2 teeth proofs** (preset journey and fresh-install journey);
- artefact: `whole-session-<run id>` containing `whole-session-comparison.json` plus
  `whole-session-preset-comparison.json`, `whole-session-preset-omission-comparison.json`,
  `whole-session-teeth-preset.json`, `whole-session-teeth-default.json` and every leg report.

## Mutation evidence (the exact guard, in a file copy)

The mutation is applied to a FILE COPY of the probe (`.tmp-artifacts/probe-backup.mjs`), never via git, and the
restore is byte-verified before the green run:

1. pre-mutation bytes: `sha256 02143930fb0f177bd6fdc957381ec10fe360db9e07ab0eff53cb944acaba47`;
2. the mutation reintroduces the PRE-FIX shape in that copy: the resumed completion is selected with
   `completions().at(-1)` and recorded with `ordinal: completions().length`, and the capture block is moved AFTER the
   helper-completion block — i.e. the request that becomes "the resumed turn" is whatever was last when the leg looked,
   which is the defect of the OPEN observation. The copy's own digest is
   `sha256 2bc2463792b9feefe6aefe2402c2dd342533571d653e98d4c7dfcbe22b6d78e5`;
3. the mutated probe is driven through the preset journey (the one that injects the helper completion). Result: the
   comparator's verdict is **mismatch**, and the failed guards include the two the fix exists for —
   `resumed-request-attributed-to-the-send` and `restart-turn-carried-the-restored-history` — with
   `restart-completion-equal`, `restart-helper-completion-equal`, `helper-completion-was-not-the-resumed-request`,
   `restart-completion-count-equal` and `restart-disk-growth-equal` as collateral reds (the pre-fix ordering leaves the
   restart leg's own request record unpopulated, so it also fails with a named `TypeError` in the leg report: the
   pre-fix shape cannot even describe the send's request). The teeth program correctly REFUSES a mutation baseline
   ("there is no green to mutate away from");
4. restore from the same file copy, verified: probe `sha256 02143930…47` again, equal to (1);
5. the SAME journey, same probe bytes: comparator **match, 47 guards, 0 failed**, teeth **18/18 applicable mutations**
   produce their named red on that green baseline (`Q` is not applicable there — it needs the omission-control leg,
   whose own run shows 17/17 applicable with `K`/`L` not applicable).

Log: `.tmp-artifacts/mutation-restore.log`; reports: `.tmp-artifacts/ws-mutation/` and `.tmp-artifacts/ws-restored/`.

## What remains unproven, stated rather than implied

- **A real provider.** The peer answers with markers; the requests are real, the model is not (AGENTS rule 22).
- **The maintainer's real tree and real preset.** Only the committed derivation is used; the original file never enters
  the repository and was not read, printed or uploaded here (rules 51/56). The historical private run's captured request
  is therefore not attributed to a named helper/extension (see "Root cause").
- **A real helper extension's own generateRaw path.** The deterministic reproduction uses the frontend's own
  `generateRaw` with a synthetic one-system prompt — the same entry and shape a helper uses, but not the user's helper
  scripts. An extension-assisted journey is a candidate follow-up, not a claim of this change.
- **Group chats, branches/checkpoints, multi-user trees** remain outside this surface, as its header records.
- **Local green is Layer A.** Everything above was measured on the Windows host with the pinned checkout at the
  baseline; the Linux CI run has not yet happened for this branch and is the gate.
- **A local host artefact found while doing this work, recorded here so it is not rediscovered.** A reload-phase read
  once measured `chatLength: 3, domMessages: 0` on one subject while the other rendered 3 (the record phase raced the
  renderer). The probe now waits for the DOM to have rendered the chat before recording that state; the comparator
  still requires the DOM count to equal pinned's, so this removed a probe-created difference, not a product assertion.
  Separately, the pinned server's 90 s readiness bound was exceeded locally under concurrent load from other lanes; the
  local runner raises it (`PINNED_READY_MS`), while CI keeps the default bound — that is a local-contention artefact, not
  a startup finding (no product claim is made from it).
