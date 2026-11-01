# The combination journey

**Lane:** alpha11 Lane H (GOAL §9's highest-priority combination; GOAL §12's "character × preset × helper passes as
a combination"). **Subject:** GoTavern. **Oracle:** pinned SillyTavern `1.19.0` @
`06bde939fb1e9c4c8d8641d810f0a916b5bce127` via `tests/browser/run-against-pinned.mjs`. **Extension:** pinned 酒馆助手 /
JS-Slash-Runner `837a6288…`, used only through its own `replaceScriptTrees` iframe and `window.TavernHelper` bridge.

**Verdict of this round: the reload phase is now measured against the preconditions a user has (active saved chat,
its history, the character's prompt collection, the persisted world selection, the injected prompts), and those
preconditions are GREEN on both subjects — but the send that follows them still produces a generation request with
NO chat history on BOTH subjects, so the comparator verdict remains `mismatch`.** The remaining red is named and
evidenced (§"The remaining anomaly"), it is identical on GoTavern and pinned Node, and it is a harness-faithfulness
alarm (AGENTS 10), not a product divergence. The combination-coverage claim stays OUT of the matrix row.

## What this round fixed

1. **Reload phase order, asserted instead of assumed.** After the reload the journey now: re-selects the armed preset
   through the frontend control, restores the world book through `updateWorldInfoSettings` and polls the persisted
   `world_info.globalSelect`, opens the character, lets the CHARACTER OPEN ITS OWN CHAT (the saved journey chat is the
   character's last chat; an explicit `openCharacterChat` is only used when the active chat is a different one), waits
   for a 1.5 s stability window on the active chat id + history + last regex-rewritten assistant message, re-asserts the
   persona binding AFTER the character open (opening a character clears it — the 31-byte control-arm mismatch), and
   re-applies the connection LAST. All of these are recorded as steps: `reload-chat-reopened`, `reload-preserved-history`,
   `reload-world-info-persisted-from-disk`, `reload-ready-to-send` are green on both.
2. **Prompt-manager armed precondition.** The normal post-reload send was assembling the DUMMY prompt order (4 prompts)
   while a dry run 1.3 s later assembled 39 on the same page. The journey now waits (bounded, with a 2.5 s stability
   window) until the prompt manager's own `getPromptCollection('normal')` holds the character's collection
   (`chatHistory`, `worldInfoBefore`, `main` present; measured 56 prompts) before it clicks send:
   `reload-prompt-manager-armed` is green on both, and the same precondition is applied to the restart and hand-back
   turns (`restart-prompt-manager-armed`, `handback-prompt-manager-armed`).
3. **Persona/history-prefix byte equality.** The user name is set through the product's own `setUserName` (a namespace
   assignment silently no-ops) and `power_user.allow_name1_display` is set on both; the name is re-asserted after every
   character open. Measured: the comparator's per-capture byte comparison now has **zero mismatched common cases** —
   armed turn 1, turn 2, swipe, regenerate, continue and both control arms are byte-identical between subjects.
4. **Helper page error.** The installed helper script tree re-runs on every page load; without an injection payload it
   threw `Cannot read properties of undefined (reading 'runId')`, which the harness recorded as a page error. The tree
   now records the auto-run and returns without touching state; the restart and hand-back legs (which loaded the
   guarded tree) report **zero page errors**.
5. **Restart-phase comparator guard** passed both subjects explicitly, so it no longer manufactures a false asymmetry.
6. **Auto-run guard and page-error fix** are harness-side; they change no assertion.

## Measured state (Windows host, Layer A; branch not pushed)

| leg | steps | failed steps |
|---|---|---|
| GoTavern drive | 63 | 6 |
| pinned drive | 63 | 6 |
| GoTavern restart (same tree) | 18 | 6 |
| pinned restart (same tree) | 18 | 6 |
| pinned hand-back (over the GoTavern tree) | 12 | 1 |

The failed steps are the SAME names on both subjects:
`after-reload-turn-captured`, `after-reload-request-carries-surviving-state`,
`after-reload-request-carries-preset-and-regex`, `after-reload-request-carries-variables-and-qr`,
`group-turn-produced-request`, `final-turn-earned-request`; the restart legs add the six `after-restart-*` steps and
the hand-back leg adds `handback-continued-and-reached-provider`. Every step that asserts a page PRECONDITION
(chat reopened and stable, world selection persisted, prompt manager armed, injections active, history on disk) is
green on both.

**Comparator (81 guards): verdict `mismatch`, 17 failed guards, 0 asymmetries, 0 mismatched common capture cases.**
Teeth: **5/5 mutations produced their named red** (QR injection dropped, preset pieces dropped, variable scopes
dropped, one subject missing a turn, durable chat emptied), each with its target guard proved green first.

## The remaining anomaly (named, with evidence)

After the reload/restart/hand-back **both subjects** send a generation whose provider request contains only FOUR
messages — a system prompt, one preset user prompt, the chat-history prompt rendered as `[Start new chat]`, and the
jailbreak prompt — with **no chat history, no world-info slots, no author's note, no helper variables and no QR
injection**. The exact assembly is 11864 bytes, sha256
`01c99711bc87ec8a486512dd8855d63d4cb4c326c66bfa1863b80422e2e97920`, attribution `system-or-other` (no user message
carries the turn marker), and it is byte-identical across both subjects, both reload attempts, and the restart legs.
At the moment of the click the page reports the opposite state, all asserted green immediately before the send:

* the saved chat is active (`chatId` equal to the saved id, `chatLength: 9`, last message the regex-rewritten
  assistant reply) and stayed stable for 1.5 s;
* the prompt manager's `getPromptCollection('normal')` held 56 prompts including `chatHistory`, `worldInfoBefore`,
  `main`, stably for 2.5 s;
* `settings.world_info.globalSelect` held the journey book on disk;
* the helper prompt and the QR-injected prompt were present in the page's extension prompts.

A dry-run generation (`promptManager.tryGenerate()` -> `Generate('normal', {}, true)`) that fires ~1.3 s after the
same click assembles **39** messages on the same page — so the frontend can build the full assembly; the normal send
path used the four-prompt skeleton. The generation events confirm a real `GENERATION_STARTED` with `chatLength: 9`,
and the chat grows by user+assistant after it, i.e. this is not a missing click and not an empty page. This is a
frontend state inconsistency in the generation entry path triggered by opening an existing chat and immediately
sending; it reproduces identically under pinned Node, so it is a HARNESS-FAITHFULNESS ALARM and the named red stays.

## What is still OPEN (explicit)

- The post-reload/restart/hand-back generation entry anomaly above; until it is understood, the comparator cannot
  reach `match` and the combination coverage claim stays out of the matrix row.
- Streaming: only the honour-wire SSE path with `stream_openai=true` is exercised; other streaming variants are not.
- Helper scope: only the `replaceScriptTrees` script-tree path plus `insertOrAssignVariables` / `getVariables` /
  `injectPrompts` are driven; the rest of the TavernHelper API surface is not.
- The group turn's fan-out count is recorded, not asserted.
- No real provider (recording peer; AGENTS 22), no multi-user, no real user card/preset prose (derivations only,
  AGENTS 56).

## Commands (Layer A)

```bash
node tests/browser/combination-journey-probe.mjs --data-root <go-tree> --report go.json --nonce cke
node tests/browser/run-against-pinned.mjs combination-journey-probe.mjs -- --data-root <pinned-tree> --report pinned.json --nonce cke
node tests/browser/combination-journey-probe.mjs --data-root <go-tree> --report go-restart.json --nonce cke --after-restart
node tests/browser/run-against-pinned.mjs combination-journey-probe.mjs -- --data-root <pinned-tree> --report pinned-restart.json --nonce cke --after-restart
node tests/browser/run-against-pinned.mjs combination-journey-probe.mjs -- --data-root <go-tree> --report handback.json --nonce cke --handback
node tests/browser/compare-combination-journey.mjs go.json pinned.json --restart go-restart.json pinned-restart.json --handback handback.json --out comparison.json
node tests/browser/combination-journey-gate-selftest.mjs go.json pinned.json
```

The workflow `.github/workflows/combination-journey.yml` runs these same five legs on `ubuntu-24.04` (60-minute
bound), compares with `--restart` + `--handback`, runs the teeth, and uploads the `combination-journey` artefact.
