# The combination journey

**Lane:** alpha11 Lane H (GOAL §9's highest-priority combination, GOAL §12's "character × preset × helper passes as
a combination"). **Subject:** GoTavern built from this tree. **Oracle:** pinned SillyTavern `1.19.0` @
`06bde939fb1e9c4c8d8641d810f0a916b5bce127`, booted through `tests/browser/run-against-pinned.mjs`.
**Extension:** pinned 酒馆助手 / JS-Slash-Runner `837a6288…` (manifest `4.11.3`), used only through its own
`replaceScriptTrees` iframe and `window.parent.TavernHelper` bridge.

This document records what was BUILT, what was MEASURED on this host, and what is NOT claimed. It is written after
the runs it cites; the numbers are from the reports, not from the design.

## The deliverable

| file | role |
|---|---|
| `tests/browser/combination-journey-probe.mjs` | one deterministic browser journey, driven on both subjects: staged Spec-V3 card → roster click → committed complex preset planted **before boot** and selected through `#settings_preset_openai` → complex world book (before/after/depth slots) + persisted selection → author's note through `authors-note` module → chat/global/character variables through the helper bridge + injection → Quick Reply created through `quickReplyApi` and EXECUTED → character-scoped regex stored in the card and allowed through the regex extension's own state → streamed turn → second turn (history) → preset/WI knob-off controls → swipe/regenerate/continue/branch → page reload + resumed turn → group turn and back → final turn → disk. `--after-restart` = new process over the same tree; `--handback` (under pinned) = pinned Node over the GoTavern-written tree. |
| `tests/browser/extensions/combination-journey-kit.mjs` | synthetic Spec-V3 card carrying `data.extensions.regex_scripts` (image chunks of the committed fixture only, AGENTS 56), world-book + selection staging, group fixture staging, chat/settings disk readers with the volatile exclusions named. |
| `tests/browser/compare-combination-journey.mjs` | taxonomy judge: per-capture wire equality (method + raw target + byteLength + sha256, no canonicalisation), the journey's facts taken from each subject's OWN observed steps, two-subject asymmetry fails even when both legs' step lists are green, a missing restart/hand-back leg is NOT-OBSERVED (never green). |
| `tests/browser/combination-journey-gate-selftest.mjs` | five mutations against the run's OWN artefacts, each required to be green pre-mutation and RED post-mutation by a NAMED guard. |
| `.github/workflows/combination-journey.yml` | `workflow_dispatch` + path-triggered ubuntu-24.04 job: five legs (two drives, two restart legs over the same trees, one pinned hand-back over the GoTavern tree), comparator, teeth, artefact upload; `timeout-minutes: 60` sized from the measured leg cost. |

## Measured status on this host (Windows, Layer A only)

The journey was executed on both subjects in ONE session each (nonce `cj9`, October 31 2026):

| leg | steps | failed steps |
|---|---|---|
| GoTavern drive | 51 | 12 |
| pinned drive | 51 | 14 |

Both legs reached and recorded, identically: the opened card; the complex preset selection; the author's note; the
helper bridge closure (`insideIframe: true`, bridge functions used); the Quick Reply creation+execution; the armed
streamed turn (SSE requested and served, preset pieces and the two control-plane facts on the wire); the regex
rewrite of the model output (stored text, visible text, next request); the second turn carrying the rewritten reply
and turn 1; branch creation; the group turn; the durable chat carrying the rewritten reply and branch metadata.
Those are the guards that are green on BOTH subjects in `cj9-comparison.json` (verdict `mismatch` overall).

### The reds, named, with the measured cause

1. **Preset/WI knob-off control turns produce no request on EITHER subject** (`preset-off-turn-captured`,
   `wi-off-...`). The send control is clicked (`clicked: true`, textarea consumed) and no request and no message
   appear; every later verb in the same session is also swallowed (`sawBusy: true`, `Generate` cannot be wrapped),
   on pinned Node and GoTavern alike. A page left "busy" by a mid-session preset switch is a HARNESS-FAITHFULNESS
   ALARM (AGENTS rule 10), not a product finding: the two subjects behave the same way because they run the same
   frontend, and the control arm the diversity claim needed could not be driven. **The preset A-vs-B and WI on-vs-off
   discrimination is therefore NOT PROVEN by this run**, and no skip is recorded in its place.
2. **After the reload/resumed turn, the captured request has 4 messages and no history** on both subjects (and on
   pinned also no world info, because pinned's pre-boot selection write did not survive its boot). The same
   4-message system-only request shape is what the knob-off controls produced before the page wedged; it is recorded,
   not explained away.
3. **Pinned's turn-1 world-info slots are absent** (`slotsPresent: 0` while GoTavern has 3). The selection is staged
   pre-boot from `settings.world_info.globalSelect` (the product's own storage, `world-info.js:998`); on the pinned
   leg the boot overwrote it. This is a harness staging difference, not a product divergence, and it also makes
   `nodeEqualsGo-per-capture` red for all five captures (the bodies legitimately differ by the world-info block).
4. **The restart pair and the hand-back leg were not run on this host** (each is a separate browser boot; the local
   budget went to making the drive legs measurable). The comparator reports those claims as NOT-OBSERVED, and the
   verdict is `mismatch` rather than `match`.

### Teeth

`node tests/browser/combination-journey-gate-selftest.mjs go-drive.json pinned-drive.json` → **5/5 mutations produced
their NAMED red**:

| mutation | guard that went red |
|---|---|
| the Quick Reply injection disappears | `turn-1-quick-reply-in-request` |
| the preset pieces vanish | `turn-1-preset-pieces-in-request` |
| the variable scopes vanish | `turn-1-variables-in-request` |
| one subject stops capturing a turn | `both-subjects-captured-the-same-turns` |
| the durable chat is emptied | `both-subjects-wrote-a-journey-chat` |

A sixth intended mutation (drop a world-info slot → `turn-1-world-info-three-slots-placed`) could NOT be
demonstrated because that guard was already red in this pair for reason 3 above; that is recorded here rather than
counted as a tooth.

## Commands (Layer A, this host)

```bash
# GoTavern drive leg (built binary; pinned extension from a local seed; no live network)
GOTAVERN_BINARY=.browser-bin/gotavern \
GOTAVERN_EXTENSION_SEED_ROOT=/path/to/extensions \
node tests/browser/combination-journey-probe.mjs --data-root /tmp/go --report go-drive.json --nonce cj9

# pinned drive leg over its own tree
node tests/browser/run-against-pinned.mjs combination-journey-probe.mjs -- \
  --data-root /tmp/pinned --report pinned-drive.json --nonce cj9

# judge + teeth
node tests/browser/compare-combination-journey.mjs go-drive.json pinned-drive.json --out comparison.json
node tests/browser/combination-journey-gate-selftest.mjs go-drive.json pinned-drive.json
```

The workflow additionally runs `--after-restart` over both trees and `--handback` (pinned) over the GoTavern tree,
and passes the restart/hand-back reports to the comparator.

## What is NOT claimed

- A real provider (the peer is an in-process recording backend; AGENTS 22), multi-user, or a real user's card/preset
  prose (committed derivations only, AGENTS 56).
- Preset A-vs-B and world-info on/off DISCRIMINATION: the control turns could not be driven (red 1).
- Reload/restart survival of preset/WI/variables/QR in the provider request: red 2, and the restart legs did not run
  locally.
- Pinned hand-back continuing the GoTavern-written chat: not run locally; the probe phase and the workflow step
  exist and the comparator refuses the claim until a hand-back report is supplied.
- Text-completion instruct/context templates on a chat-completion wire: recorded from the planted preset file, not
  claimed on the wire.
