# Preset semantics: the measured capability and its inventory

This document answers the `presets-and-ui-content` row's gap rank 2: *"preset features outside the measured
contract are unasserted: instruct/context templates, secondary world-info keys, recursion/probability/outlets and
group-chat presets."* It replaces prose with a feature inventory, a per-knob A/B differential, and an explicit list
of what is still unmeasured.

## 1. The ownership model that decides where a defect can live

A SillyTavern preset reaches the model through two stages:

1. **Frontend assembly** — the pinned browser script (`public/scripts/openai.js`, `PromptManager.js`,
   `world-info.js`, `authors-note.js`, `instruct-mode.js`) turns the preset, the settings, the card, the chat,
   the world book and the Author's Note into a `messages` array and a generate request body.
2. **Server request shaping** — `src/endpoints/backends/chat-completions.js` maps that request body onto the
   provider body (samplers, stops, limits, tools, response format, reasoning, provider-specific fields).

GoTavern serves the **unmodified pinned frontend** (AGENTS hard rule 3), so stage 1 is byte-identical between the
subjects by construction; a divergence can only come from a storage round trip that changes the frontend's input
(a preset/settings/world-info GET or POST that drops or reshapes a field), or from Go's stage 2. The existing
browser differentials (`tests/browser/preset-complex-comparison.json`, `worldinfo-slots-comparison.json`,
`authors-note-comparison.json`, `group-chat-comparison.json`) compare stage 1 end to end, and the provider-wire
differential compares stage 2 byte for byte. A "feature" is only measured when one of those has an assertion that
can fail for it.

## 2. The inventory

Classification vocabulary, exactly three values plus an owner column:

- `implemented` — the capability exists and a named gate can fail if it breaks;
- `measured-noop` — the pinned implementation ignores the field on this path, and an A/B differential proves it
  (the equality is the evidence, not an absence of tests);
- `unmeasured` — the capability is present in the shared frontend/pinned server but NO differential asserts it for
  this feature; the user effect is stated.

| # | Feature (preset / settings field) | Owner | Classification | Proving gate / evidence | Gap |
|---|---|---|---|---|---|
| 1 | System prompt (main prompt content) | frontend | implemented | `preset-complex-comparison.json` `PRESET_MAIN_7F` marker + ordering guards | — |
| 2 | `use_sysprompt` on a chat-completion source | server | measured-noop | knob `use-sysprompt` A/B (provider-wire): bodies byte-equal; pinned reads it only in `sendClaudeRequest` | Claude path has its own scenarios |
| 3 | Post-history jailbreak (`jailbreak` prompt) | frontend | implemented | `preset-complex-comparison.json` `PRESET_JAIL_7F` + "last in prompt block" guard | — |
| 4 | Character description | frontend | implemented | `preset-complex-comparison.json` `PRESET_DESC_7F`; kit sets the card field | — |
| 5 | Character personality | frontend | implemented | `PRESET_PERS_7F` marker + `personality_format` | — |
| 6 | Character scenario | frontend | implemented | `PRESET_SCEN_7F` marker + `scenario_format` | — |
| 7 | Example messages (dialogueExamples) | frontend | implemented | `PRESET_EXAMPLE_7F` marker; the boundary case drops it at the context budget on both subjects | — |
| 8 | Chat history inclusion toggles / depth | frontend | implemented | history markers + keep/drop boundary pair (24 vs 26 messages) in `preset-complex-comparison.json` | — |
| 9 | Prompt-manager entry enabled/disabled | frontend | implemented | kit asserts the scenario's prompts are enabled; disabled-prompt handling is indirectly exercised by Author's Note cases `disabled-interval0` | direct disabled-entry A/B absent |
| 10 | Prompt-manager relative order | frontend | implemented | `preset-complex-comparison.json` ordering guards (main/nsfw/jailbreak block positions) | — |
| 11 | Prompt-manager injection position / role / depth | frontend | implemented | `authors-note-comparison.json` sweep (`parity`, `depth0`, `depth4`, `depth8`, `in-prompt-depth6`, `disabled-interval0`) | — |
| 12 | Author's Note position | frontend | implemented | authors-note sweep cases | — |
| 13 | Author's Note depth | frontend | implemented | authors-note sweep cases | — |
| 14 | Author's Note role | frontend | implemented | authors-note sweep (`role` re-derived and compared) | — |
| 15 | Author's Note interval | frontend | implemented | authors-note sweep `disabled-interval0` (interval 0 disables) | — |
| 16 | World info position before/after/atDepth | frontend | implemented | `worldinfo-slots-comparison.json` (21 guards, slot order `[1,2,4]`) | — |
| 17 | World info depth / role | frontend | implemented | worldinfo-slots (depth@4 user at 1 from the end) | — |
| 18 | World info secondary keys (`keysecondary`, logic) | frontend | **unmeasured** | slots kit sets `keysecondary: []`; no case varies it | G-WI-LONGTAIL |
| 19 | World info recursion (`preventRecursion`/`excludeRecursion`/recursion steps) | frontend | **unmeasured** | slots kit sets defaults only | G-WI-LONGTAIL |
| 20 | World info activation probability (`useProbability`/`probability`) | frontend | **unmeasured** | kit sets probability 100 / useProbability false | G-WI-LONGTAIL |
| 21 | World info outlets (`position: outlet`) | frontend | **unmeasured** | slots cases cover before/after/atDepth only | G-WI-LONGTAIL |
| 22 | World info scan depth / context % / budget / min activations | frontend | **unmeasured** | worldinfo-slots varies slots, not the activation settings | G-WI-LONGTAIL |
| 23 | Instruct template (system/user prefixes/suffixes, story string, wrap) | frontend | measured-noop for chat-completion; **unmeasured** for text-completion | knob `instruct-template` A/B proves the chat-completion request is unchanged on both subjects; the preset kit also sets a non-default template and its request is compared; no leg drives a text-completion API through the browser | G-TEXTGEN |
| 24 | Context template (story string, chat start, example separator) | frontend | measured-noop for chat-completion; **unmeasured** for text-completion | knob `context-template` A/B | G-TEXTGEN |
| 25 | Sampler `temperature` | server | implemented | knob `temperature` A/B + provider-wire byte equality; `TestPinnedNodePresetRoutes` for the document | — |
| 26 | `top_p`, `top_k` | server | implemented | knobs `top-p`, `top-k` A/B | — |
| 27 | `presence_penalty`, `frequency_penalty` | server | implemented | knobs `presence-penalty`, `frequency-penalty` A/B | — |
| 28 | `max_tokens` | server | implemented | knob `max-tokens` A/B | — |
| 28b | `max_completion_tokens` (absent vs present) | server | implemented, not A/B'd in this lane | covered by the same fixed-member path (`chat_completions.go:607`) and existing per-source scenarios; a dedicated pair was not added | knob-level A/B gap |
| 29 | `seed` | server | implemented | knob `seed` A/B | — |
| 30 | `n` | server | implemented | knob `n` A/B | — |
| 31 | Stops (`stop[]`) | server | implemented | knob `stop` A/B; existing `mistral-seed-and-stop` | — |
| 32 | `logit_bias` | server | implemented | knob `logit-bias` A/B | — |
| 33 | `logprobs` / `top_logprobs` shape | server | implemented, not A/B'd in this lane | `openai-custom-prompt-post-processing` and per-source logprob scenarios; the adjustment lives at `chat_completions.go:849-860` and was not given a knob pair here | knob-level A/B gap |
| 34 | `tools` / `tool_choice` | server | implemented | knob `tools` A/B; per-source tools scenarios | — |
| 35 | `json_schema` / `response_format` | server | implemented | knob `json-schema` A/B; per-source json-schema scenarios | — |
| 36 | `reasoning_effort` (model-gated mapping) | server | implemented | knob `reasoning-effort` A/B; `openai-reasoning-effort-map/fixed/outside-table` | — |
| 37 | `verbosity` (gpt-5 prefix gate) | server | implemented | knob `verbosity` A/B | — |
| 38 | `assistant_prefill` on a chat-completion source | server | measured-noop by source reading + Claude consume-path scenario | pinned consumes it only in `sendClaudeRequest`/`convertClaudeMessages` (`claude-prefill` scenario); the generic OpenAI body never reads it. Not A/B'd in this lane's catalogue | knob-level A/B gap |
| 39 | `names_behavior` message-name shaping | frontend | measured-noop at the server wire | knob `names-behavior` A/B; `preset-complex-comparison.json` records the shape with `namesBehavior: 1` | — |
| 40 | Custom include/exclude body and include headers | server | implemented | existing `custom-include-body*`, `custom-exclude-body`, `custom-include-body-overrides-assembled` scenarios | — |
| 41 | `custom_prompt_post_processing` (merge/semi/strict variants) | server | implemented | existing `openai-custom-prompt-post-processing`; Go comment `chat_completions.go:202-211` | — |
| 42 | Provider-specific fields (per source) | server | implemented | the per-source provider-wire scenarios (222 scenarios across 15 sources) | — |
| 43 | Truncation / context budget | frontend | implemented | `preset-complex-comparison.json` boundary pair, measured from the pinned leg itself | — |
| 44 | Group-chat presets | frontend | **unmeasured** for *preset* semantics | `group-chat-comparison.json` compares a group-chat turn (verdict `match`) but does not vary preset fields; the `groups` row is PARTIAL | G-GROUP-PRESET |
| 45 | Quick replies / themes / moving UI / system prompts as documents | server | implemented | `TestPinnedNodePresetRoutes`, `TestPinnedNodeThemesSaveAndDelete`, `TestPinnedNodeMovingUISave`, `TestPinnedNodeSystemPromptMigration`; `node-stock-tree.yml` preset round trip | — |

The A/B knobs (rows 25–39) are the new measured differential; rows 1–17 and 23–24 are already covered by committed
browser differentials; rows 18–22 and 44–45's preset half are declared gaps below, not silently promoted.

## 3. The A/B differential (provider wire)

Catalogue: `tests/provider-wire/preset-knobs.mjs`. Scenario files:
`tests/provider-wire/scenarios/preset-knob-<knob>-a.json` / `-b.json`, generated by
`tools/generate-preset-knob-scenarios.mjs` (drift is itself tested).

For every knob the four relations are established:

| relation | where it is enforced |
|---|---|
| Node(A) == Go(A) | `tools/probe-provider-wire.mjs`, byte-oriented (`bodySha256`, `bodyLength`, raw target/method) for every scenario, in the oracle job |
| Node(B) == Go(B) | same |
| Node(A) != Node(B) | `tests/provider-wire/preset-knobs.test.mjs`, from the committed pinned captures |
| Go(A) != Go(B) | follows from the three equalities and is asserted as a composition in the same test |

The comparison is byte-oriented: equality is decided on `bodySha256`/`bodyLength`/raw target/method and headers,
never on the `bodyText` projection. `changedPaths` are computed from `bodyText` for **diagnostics only** (which
member moved, and that nothing else moved). A knob whose `-a`/`-b` bodies collide fails as:

```text
HARNESS NON-DISCRIMINATING: the -a and -b provider bodies are byte-identical, so this knob is not measured by the pair
```

A `measured-noop` knob must have byte-equal A/B bodies; if its bodies differ the classification is false and the
test fails. A discriminating knob whose declared change path did not move, or whose pair moved an undeclared path,
also fails.

Commands:

```text
node tools/generate-preset-knob-scenarios.mjs --check
node --test tests/provider-wire/preset-knobs.test.mjs
node tests/provider-wire/preset-knobs.test.mjs --summary      # one JSON line
go test ./internal/server -run '^TestChatCompletionGenerateMatchesProviderWireCapture$' -count=1
```

## 4. Results

Measured on this lane's worktree (`alpha11/preset`) on 2026-10-31, pinned oracle
`06bde939fb1e9c4c8d8641d810f0a916b5bce127`:

- **18 knobs / 36 provider-wire scenarios**; **14 discriminating** (temperature, top_p, top_k, max_tokens,
  presence_penalty, frequency_penalty, seed, n, stop, logit_bias, json_schema/response_format, tools/tool_choice,
  reasoning_effort, verbosity) and **4 measured-noop** (instruct template, context template, use_sysprompt,
  names_behavior).
- **Node==Go for all 36 scenarios** in the live narrowed differential
  (`tools/probe-provider-wire.mjs`, `GOTAVERN_PROVIDER_WIRE_SCENARIOS='^preset-knob-'`): every scenario printed
  `http, provider, providerResponse compared` with no mismatch, and the Go replay of the same 36 captures
  (`TestChatCompletionGenerateMatchesProviderWireCapture/preset-knob-*`) passed. **No Go divergence was found in
  the measured knobs**, so no implementation change was needed for them.
- **Node(A)!=Node(B) for all 14 discriminating knobs** (each pair differs exactly at its declared path and nowhere
  else) and **Node(A)==Node(B) byte-equal for all 4 measured-noop knobs**
  (`node --test tests/provider-wire/preset-knobs.test.mjs`: 3/3 pass; summary `ok: true`, `passed 18/18`).
- The fixture update is **purely additive**: the existing 222 captures are byte-identical to `HEAD`, the 36 new
  entries are appended in the same sorted order a full re-record writes (`added 36, removed 0, changed 0,
  metaSame true`), so the Linux oracle re-record has no reshuffled file to explain and no existing scenario moved.
- Recorded in the fixture: `tests/oracle/sillytavern-1.19.0-provider-wire.json` (258 scenarios), plus the new
  scenarios under `tests/provider-wire/scenarios/preset-knob-*.json`.

**Layer-A caveat.** The pinned capture for the 36 new scenarios was recorded on this Windows host by the same
probe that records the Linux oracle fixture; the existing 222 entries re-recorded byte-identically against the
committed Linux fixture, which is the evidence that the recording path is host-independent here. The Linux oracle
job remains the only run whose green covers the fixture, and it re-records all 258 scenarios.


## 5. Teeth

The gates are shown to be able to fail by mutating the Go implementation (restored from file copies, then re-run
green):

| mutation | named red |
|---|---|
| ordering: move `seed` before `temperature` in the fixed provider-member order | `TestChatCompletionGenerateMatchesProviderWireCapture/preset-knob-seed-*` and the temperature pair fail on `body digest` |
| stop: delete the `stop` member from the fixed provider body | `TestChatCompletionGenerateMatchesProviderWireCapture/preset-knob-stop-*` fails on `body digest` |
| role mapping: change the `response_format.json_schema.strict` default | `.../preset-knob-json-schema-*` fails on `body digest` |
| reasoning mapping: change the reasoning-effort table | `.../preset-knob-reasoning-effort-*` fails on `body digest` |

## 6. What this does NOT establish

- The provider-wire half is stage 2 only. The frontend half of each knob is covered by the browser differentials
  named in the inventory, not by these scenarios. A green pair here does not by itself prove prompt assembly.
- Text-completion providers are not browser-driven; instruct/context template consumption for those APIs is
  unmeasured (G-TEXTGEN).
- World-info secondary keys, recursion, probability, outlets, scan depth and budget are unmeasured (G-WI-LONGTAIL).
- Group-chat *presets* are unmeasured (G-GROUP-PRESET); the group-chat turn itself is compared.
- The mock provider defines nothing: every expectation is a pinned capture. The local capture in this lane was
  recorded on Windows and must be confirmed by the Linux oracle re-record (the probe's own comment records this
  exact loop); the live equality in this lane was observed on both subjects on the same host.

## 7. Gaps, with user effect

| id | gap | user effect | next step |
|---|---|---|---|
| G-WI-LONGTAIL | no A/B for world-info secondary keys, `selectiveLogic`, recursion (`preventRecursion`/`excludeRecursion`/recursion steps), `useProbability`/`probability`, `position: outlet`, `scanDepth`, `context_percent`/budget | a user whose lorebook relies on any of these can have a final request that differs from pinned's with no gate noticing | extend the world-info kit to cases that vary these per entry and in `power_user`/`world_info_settings`, with the same two-leg comparator |
| G-TEXTGEN | instruct/context template consumption for text-completion APIs is unmeasured in the browser | a text-completion user with a custom instruct template can diverge without a gate | add a text-completion leg to the preset differential (browser + provider-wire) |
| G-GROUP-PRESET | group-chat presets are not varied | a preset used by a group chat may assemble differently without a gate | extend `group-chat-comparison.json` with a preset-varying case |
| — | tools/json-schema/reasoning knobs are measured for the OpenAI-compatible source here; the other 14 sources have their own single-purpose scenarios, not an A/B per preset field | a provider-specific mapping difference outside the scenarios is possible | extend the knob catalogue per source where a preset field has a source-specific transform |
