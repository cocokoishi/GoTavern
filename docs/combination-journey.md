# The combination journey

**Lane:** alpha11 Lane H (GOAL §9's highest-priority combination; GOAL §12's "character × preset × helper passes as
a combination"). **Subject:** GoTavern. **Oracle:** pinned SillyTavern `1.19.0` @
`06bde939fb1e9c4c8d8641d810f0a916b5bce127` via `tests/browser/run-against-pinned.mjs`. **Extension:** pinned 酒馆助手 /
JS-Slash-Runner `837a6288…`, used only through its own `replaceScriptTrees` iframe and `window.TavernHelper` bridge.

**Current measured state, stated first: the harness is improved by this follow-up but the comparator verdict is still
`mismatch`.** Both subjects drive the same 62 steps; every step before the reload is green on BOTH (only four named
post-reload steps plus the steps that follow them are red), the teeth are 5/5, and the subjects agree step-for-step.
The remaining red is ONE harness anomaly, not a product divergence: **after the page reload, the composer produces no
generation request on either subject.**

## What this follow-up fixed, with the evidence

1. **Control-turn poisoning — FIXED.** A preset carries provider settings; switching the fresh-install preset
   overwrote the custom peer URL/model, the send click set the busy flag and died before any request, and every later
   verb was swallowed as a stop. Fixes, harness-side and recorded in the report: after every preset change the peer
   connection is re-applied (`applyConnectionState`), the world book is re-selected through the product's own
   `updateWorldInfoSettings` path, a stuck composer is recovered the way a user does (stop, then bounded idle wait),
   and each knob-off arm now runs as its own page-reset segment. Measured green on BOTH subjects:
   `preset-off-turn-captured`, `preset-off-request-lacks-preset-markers`, `wi-off-turn-captured`,
   `wi-off-request-lacks-world-info`, `preset-restored-after-control`, `world-info-restored-after-control`, and the
   verbs before them (`swipe`, `regenerate`, `continue`, branch).
2. **World-info staging — FIXED (before the reload).** The pre-boot `settings.world_info.globalSelect` write is
   overwritten by BOTH servers' boot (measured on pinned: `wiPersisted: null`, turn-1 slots 0). The journey now selects
   the world book AFTER boot through the product's own `updateWorldInfoSettings(settings, [name])` path
   (`world-info.js:817-851`), polls the persisted member on disk, and only then proceeds. Measured green on both:
   `world-info-selected-after-boot`, `world-info-persisted-after-boot`, `turn-1-world-info-three-slots-placed`,
   `world-info-selection-persisted-to-disk`.
3. **Variables / Quick Reply in turn 1 — FIXED and now verified before the send.** The helper value reaches the request
   through the bridge's `injectPrompts`; the QR through its `/inject` command. A bounded page-side check now asserts the
   helper prompt is registered (`drive-injections-active-in-page`) before the armed turn; measured green on both, and
   `turn-1-variables-in-request` + `turn-1-quick-reply-in-request` are green on both.
4. **Reload capture attribution — FIXED (the red it produces is now the right red).** `turn()` attributes a capture by
   a marker in a **user** message, not by arrival order or a system-prompt occurrence; the page-load assemblies are
   recorded as `unattributedRequests` with their attribution (`system-or-other`). Measured: the post-reload phase
   reports `noGenerationRequest: true` with the exact assembly sha instead of a shape mismatch.
5. **User identity and history prefix — FIXED for the armed turns.** The product's own `setUserName` (not a namespace
   assignment, which silently no-ops) and `power_user.allow_name1_display = false` are set on both subjects, so the
   armed turns are byte-identical; the remaining 31-byte control-arm difference is the `{{user}}` macro resolving to
   `[Unnamed Persona]` on the GoTavern reset page (the persona binding is cleared when the character is opened after
   the name is set — identified, not yet fixed).
6. **Pinned frontend exception in the return-to-chat step** (a throw, not a finding) is now RECORDED as a named red
   instead of aborting the leg.

## Measured state (Windows host, Layer A; branch not pushed)

| leg | steps | failed steps |
|---|---|---|
| GoTavern drive | 62 | 7 |
| pinned drive | 62 | 9 |

The seven shared reds, all caused by the one anomaly below:
`reload-world-info-persisted-from-disk`, `after-reload-turn-captured`, `after-reload-request-carries-surviving-state`,
`after-reload-request-carries-preset-and-regex`, `after-reload-request-carries-variables-and-qr`,
`group-turn-produced-request`, `final-turn-earned-request`.
Pinned additionally records `returned-to-journey-chat` and `final-helper-reran-and-reinjected-variables` because its
frontend throws inside `openCharacterChat` after the group turn; those are harness records, not product claims.

Comparator (62 guards): **verdict `mismatch`, 14 failed guards, 1 asymmetry** (`returned-to-journey-chat`, the pinned
frontend throw). The only byte-level capture differences are the two control arms (31 bytes: the persona-name
resolution above); all other captured turns — armed turn 1, turn 2, swipe, regenerate, continue — are byte-identical.
Teeth: **5/5 mutations produced their named red** (QR injection dropped, preset pieces dropped, variable scopes
dropped, one subject missing a turn, durable chat emptied), each with the target guard proved green first.

## The remaining anomaly (the one thing standing between this leg and `match`)

After the page reload the composer never reaches the provider on EITHER subject. Each send attempt produces exactly one
deterministic **11864-byte system-only completion** (sha256
`01c99711bc87ec8a486512dd8855d63d4cb4c326c66bfa1863b80422e2e97920`, attribution `system-or-other`, no `user`
message, no chat history), and no generation request; the page's stop/idle recovery is executed, the page is reset and
the chat reopened by id (the same reset that restores the CONTROL segments), and the retry produces the same
system-only body again. The same anomaly then swallows the group turn and the final turn. The reloaded page also
overwrites `settings.world_info.globalSelect` back to null (the disk assertion reads null immediately after the
reload), so the reload does not restore the world selection either. Both subjects behave identically, which makes this
a HARNESS-FAITHFULNESS alarm (AGENTS 10), and the exact assembly bytes are in the report so the next attempt starts
from evidence rather than a hypothesis.

## Not run in this follow-up
The restart pair and the pinned hand-back leg were not run here (each is a separate browser boot and the reload
anomaly blocks a `match` verdict regardless). The workflow runs them; the comparator reports those claims as
NOT-OBSERVED.

## Commands (Layer A)

```bash
node tests/browser/combination-journey-probe.mjs --data-root <go-tree> --report go.json --nonce cjm
node tests/browser/run-against-pinned.mjs combination-journey-probe.mjs -- --data-root <pinned-tree> --report pinned.json --nonce cjm
node tests/browser/compare-combination-journey.mjs go.json pinned.json --out comparison.json
node tests/browser/combination-journey-gate-selftest.mjs go.json pinned.json
```

## Not claimed
A real provider (recording peer, AGENTS 22), multi-user, real user card/preset prose (derivations only, AGENTS 56),
text-completion instruct/context templates on a chat-completion wire, the group fan-out count, and the combination
coverage itself until the ubuntu workflow is green and cited.
