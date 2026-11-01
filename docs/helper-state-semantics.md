# Helper second-order state semantics

**Lane:** alpha11 Lane D (Tavern Helper second-order state). **Subject:** GoTavern. **Oracle:** pinned SillyTavern
`1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127`, booted through `tests/browser/run-against-pinned.mjs` with
`--browserLaunchEnabled false`. **Extension:** 酒馆助手 / JS-Slash-Runner pinned at
`N0VI028/JS-Slash-Runner@837a6288135cde61522a9279173b98020f08807e` (manifest `4.11.3`), driven only through its own
`replaceScriptTrees` iframe and `window.parent.TavernHelper` bridge.

This document records what the leg proves, what it does not, and the one host-side settle step it performs. It is
written **after** the runs it describes; every number/name below comes from the reports and the comparison artefact,
not from a plan.

## What was already proven before this lane

| claim | evidence |
|---|---|
| an unsandboxed script iframe with `parent.TavernHelper` reachable; static host imports; `generateRaw` byte-identical; depth-0 injection visible | `tests/browser/extension-tavern-helper-comparison.json` (canary, CI-produced) |
| chat/global variables reach the FINAL provider request; a value on disk; survives a fresh page and a restart; message scope stored-not-surfaced | `tests/browser/helper-variables-comparison.json` (narrow legs) |
| the UI-select vehicle for the preset scope (narrow) | `helper-vars-probe.mjs` + `compare-helper-vars-legs.mjs` |

## What this leg adds

One probe (`helper-state-probe.mjs`) drives BOTH subjects with the SAME fixture and the SAME nonce and installs its
script through the extension's own `replaceScriptTrees`; one comparator (`compare-helper-state-legs.mjs`) judges the
two reports. The provider is an in-process capture peer that records `sha256`/`byteLength`/raw body per request.

1. **Variables by scope.** `chat`, `global`, `character`, `preset`, `script` (per-script in-iframe store) and
   `message` (per-message, at `chat[message_id].variables[swipe_id]`). Writes are read back through the bridge; the
   persisted projections are read from disk: `chat_metadata.variables`, `settings.json
   extension_settings.variables.global`, the card's `data.extensions.tavern_helper.variables`, the in-use preset
   file's `extensions.tavern_helper.variables`.
2. **Semantics, not just values.** an object with nested members and an array (type-preserving round trip), three
   un-awaited `updateVariablesWith` increments plus two concurrent inserts (a lost update is `hs_counter != 3`), and
   a set-then-delete that must be absent from the readback.
3. **Persistence observed by a LATER generation, not by the writer.** after a page reload, a fresh script iframe
   re-reads every scope and performs a generation whose injected prompt carries the values it read; the comparator
   requires the exact values in the provider bytes.
4. **Switch isolation.** a chat switch (same character, second chat), a character switch (a second, synthetic card),
   and a preset switch (`hs-state-preset-b`) each re-read the scopes in a NEW iframe.
5. **Preset mutation (Q12).** the helper changes the IN-USE preset through `updatePresetWith`: (a) appends a prompt
   carrying a marker, (b) changes a sampler (`temperature` 0.42), (c) removes the prompt and restores the sampler.
   Four `generate()` calls produce four captured requests; the NEXT request must carry (a)/(b) and the restored one
   must not.
6. **Events (Q19).** `message_sent`, `message_received`, the host `generation_*` family, the helper's
   `js_generation_*` family, `preset_changed`, `oai_preset_changed_after` and `chat_id_changed` are subscribed
   through the iframe global `eventOn`; order and the state visible at event time are recorded.
7. **Closure.** every mutation above is executed by a script inside the extension's iframe
   (`closure.insideIframe === true`, the bridge functions it called are listed), so the observed chain is
   iframe → bridge → host API → host store → disk → next provider request. "The iframe loaded" is never a claim here.

## The one host-side settle step (stated, not hidden)

After the write phase the probe calls the HOST's own `SillyTavern.getContext().saveMetadata()` once and records
`phases.metadataSaveSettled`. Reason, measured: the helper's chat-scope write calls `saveMetadataDebounced`; pinned
skips a pending metadata save when the character id changed between scheduling and firing, and on the pinned leg the
debounce alone left `chat_metadata.variables` unflushed for the whole 30 s bounded poll while the same write against
GoTavern flushed. The write itself is still performed by the helper through the bridge; the settle step only flushes
the host's live metadata object, so the artefact can separate "the helper wrote the store" from "the host saved it".
With the flush, BOTH subjects persist the chat scope and survive the reload. This is a drive-fidelity aid, not a
product fix, and it is visible in the report.

## Taxonomy / residuals (not turned green)

- **Simulated provider** (AGENTS 22): the peer captures and answers but defines nothing; the expected bytes are the
  pinned leg's own captured bytes, compared by `sha256`. For production transport this leg is `unverified`.
- **Not driven:** streaming and cancellation of a helper generation; the `extension` variable scope; swipe /
  regenerate / continue lifecycle events; `character_page_loaded`; helper update-disabled persistence; a restart leg
  in the local run (the workflow runs `--after-restart`; if a restart pair is not supplied the comparator reports
  `survivesRestart` as not evinced rather than green).
- **Character scope after a switch** can still show the PREVIOUS character's variables on both subjects (the helper's
  character store refreshes on its own selection path). The guard therefore claims EQUALITY with the oracle's
  observation (`characterSwitchReadbackEquivalent`), not `{}` — the empty form would be our derivation, not the
  oracle.
- **`CHAT_CHANGED` through a pre-switch iframe listener** is not asserted: the extension re-creates script iframes on
  chat change. The chat-switch claim is the state isolation, the event sequence is recorded, and the absence is
  listed in `unproven`.
- **The second character is synthetic**: a 1×1 PNG carrying a `ccv3` tEXt payload written by the probe, with a
  distinct name. No user prose is copied (AGENTS 56); the committed card fixture is used only for the primary card's
  image chunks.
- **The shared fixture card was flat** (no nested `data`), which makes the helper's character-scope write throw on
  `character.data.extensions`. This leg stages its own Spec-V3-shaped card instead and records the shape; the shared
  `stageProbeCard` was not edited (other lanes' artefacts depend on it).

## Files

| file | role |
|---|---|
| `tests/browser/helper-state-probe.mjs` | drives one subject (GoTavern or pinned) through the browser, writes one report JSON |
| `tests/browser/extensions/helper-state-script.js` | the in-iframe half: writes/reads scopes, mutates the preset, subscribes to events |
| `tests/browser/extensions/helper-state-kit.mjs` | fixture (second preset, second synthetic card, chats), persisted projections per scope, bounded disk waits |
| `tests/browser/compare-helper-state-legs.mjs` | guards + taxonomy + byte capture comparison |
| `tests/browser/helper-state-gate-selftest.mjs` | five mutations, each required to turn a NAMED guard red |
| `.github/workflows/helper-state.yml` | bounded ubuntu job: both subjects, both restart legs, comparator, teeth, artefact upload |

## Commands

```bash
# GoTavern leg (built binary, pinned extension from a local seed, no network)
GOTAVERN_BINARY=.browser-bin/gotavern \
GOTAVERN_EXTENSION_SEED_ROOT=/path/to/extensions \
node tests/browser/helper-state-probe.mjs --data-root /tmp/go-tree --report go.json --variant on --nonce <shared>

# pinned leg
node tests/browser/run-against-pinned.mjs helper-state-probe.mjs -- \
  --data-root /tmp/pinned-tree --report pinned.json --variant on --nonce <shared>

# judge + teeth
node tests/browser/compare-helper-state-legs.mjs go.json pinned.json --out comparison.json
node tests/browser/helper-state-gate-selftest.mjs go.json pinned.json
```

The workflow passes `--nonce ${GITHUB_RUN_ID}`-derived value to BOTH legs: without a shared nonce the two subjects'
bodies legitimately differ by the marker text and `nodeEqualsGo` would be red for a harness reason.


### The CI job: new, portability-fixed twice, still RED (named residual, 2026-11-01)

The capability evidence above is Layer A (Windows host). The bounded ubuntu workflow
[`.github/workflows/helper-state.yml`](../.github/workflows/helper-state.yml) exists to make it a Linux gate, and its
first runs failed for reasons that were all job portability, not the differential:

- `41281023252`: `Chart` -- actions/checkout refused `path: ../SillyTavern` ("not under the workspace"); the pinned
  oracle now checks out to `.reference/SillyTavern`, which `run-against-pinned.mjs` already resolves first.
- `41282119167`: `Install Playwright chromium` failed with "Playwright does not support chromium on ubuntu26.04-x64";
  the Playwright workflows are pinned to `ubuntu-24.04` rather than relying on a warm browser cache.
- `41283416152` and `41293935148`: the Go leg runs green (23/23 steps), but the pinned leg fails at
  `character-opened` with "no roster card with that name" -- the synthetic probe card is staged into the Go data root
  but is not visible in the pinned leg's data root on Linux. That is the remaining defect in the JOB (the local
  two-subject run and the comparator pass), not evidence of a product difference.

Until that is fixed the helper row stays PARTIAL and the release notes/HANDOFF say the helper evidence is Layer A
only. The workflow is NOT part of `docs/release-manifest.json`.
