# The real-user inputs: what they are, and what they force

Written 2026-10-25 from two read-only audits of the user's actual artifacts and of the pinned
JS-Slash-Runner. It exists so the numbers below do not have to be re-derived, and so the next
implementer cannot substitute a toy fixture for a real one by accident (`GOAL.md` §5, `AGENTS.md`
rule 51).

## 1. The decisive structural fact

In pinned 1.19.0 the **preset → messages assembly is the browser's job**. `prompt_order`,
`PromptManager`, `squash_system_messages`, `names_behavior` and every marker-role override live in
`public/scripts/openai.js` and `public/scripts/PromptManager.js`; `src/endpoints/backends/chat-completions.js`
reads `request.body.messages` and never mentions a preset. GoTavern serves those two files
byte-identically (`openai.js` SHA-256 `0B77C302…` in both trees), so GoTavern must **not** grow a
prompt builder, and a preset divergence is either (a) corrupted data on the way in, (b) a token count
that moved, or (c) a provider adapter. That is where the gates must point.

## 2. The real inputs, measured

| Artifact | Bytes | What it is |
|---|---|---|
| `[REDACTED_PRESET_A].json` | 99,740 | 45 keys, **105 prompts**, `prompt_order` with **two** groups (100000: 11 rows/10 enabled, 100001: 98/56), 8 markers, **zero** in-chat entries, `squash_system_messages=true`, `names_behavior=0`, `wrap_in_quotes=false`, `openai_max_context=2000000`, `extensions={}` |
| `[REDACTED_PRESET_B].json` | 1,428,750 | 47 keys, **119 prompts**, one order group (100001: 115 rows/**39 enabled**), 8 markers with **`role:"user"`**, 27 `regex_scripts` (111,501 B), **`extensions.tavern_helper` = 1,112,202 B** (6 scripts, content 139,951/20,360/13,167/**880,038**/11,295/9,294), `use_sysprompt=true`, `continue_prefill=true` |
| `[REDACTED_CARD]…[REDACTED_CARD].png` | 19,093,535 | real V3 card, `chara` **and** `ccv3` chunks (byte-identical, 6,938,739 JSON bytes each), 5 alternate greetings, **`character_book` with 490 entries / 2,115,466 chars**, 11 regex scripts (269 K chars), 1 helper script, 5 at-depth book entries, plus a non-standard `trAc` chunk |
| `[REDACTED_CARD_B]….png` | 3,069,511 | real V3 card, 15 `data` keys (**no** `group_only_greetings`), 2 alternate greetings, `character_book` 32 entries, 3 regex scripts, **4 helper scripts (462,136 chars in one)**, no at-depth entry |

Both cards carry `data.extensions.tavern_helper` **and** `data.extensions.regex_scripts`, and both
presets are chat-completion presets with `openai_max_context = 2000000`. Nothing about this shape is
reachable from the existing fixture, which is a 12-prompt all-built-in preset with
`squash_system_messages:false` and `names_behavior:1`.

## 3. Two negative findings that must be recorded, not implemented

1. **`wrap_in_quotes` has no reader in pinned 1.19.0.** An exhaustive search of `public/`, `src/` and
   `default/` returns zero hits. Preset A sets it and nothing consumes it. Honouring it would fabricate
   behaviour; the correct test is that a preset with it produces a body identical to one without.
2. **`'in_use'` is not a SillyTavern concept — it is 酒馆助手's name for the live settings object.**
   The pinned tree has no `in_use` key, and `src/endpoints/presets.js` has only save/delete/restore; the
   runtime preset is the browser's in-memory `oai_settings`. The helper resolves it itself:
   `preset.ts:589` does `preset_name === 'in_use' ? oai_settings : getCompletionPresetByName(...)`.

   **`GOAL.md` Q12 therefore has to be answered in the helper's terms**: after a helper script mutates
   `oai_settings.prompts` / `prompt_order` in memory, the *next* `/api/backends/chat-completions/generate`
   body must change, and a reload must not silently restore the on-disk preset unless the pinned
   behaviour does. The observable is the provider request, not a preset route.

## 4. Where the order rows and the prompt flags disagree — the sharpest observable

`PromptManager.js:1516-1541` walks the **order rows** and includes an entry iff **`entry.enabled`**;
`Prompt` never copies its own `enabled` field (`:182-195`), and `getPromptById` is reached only through
an order row. Order-group selection is pinned: `openai.js:696-699` sets `dummyId: 100001` and
`PromptManager.js:1207-1208` matches that id, so preset A's `100000` group is **dead data**.

Therefore, in the real artifacts:

- preset A: **46** enabled order rows point at prompts whose `prompts[].enabled === false`, and 7
  prompts are referenced by no row at all (unreachable);
- preset B: `main`, `nsfw`, `jailbreak` and `enhanceDefinitions` are `enabled:true` in `prompts[]` and
  referenced by **no** order row — and `PromptManager.js:1014/1140/1174` only repairs an **empty** order
  list, so they never reach the request even though they carry content.

A fixture with 12 built-in prompts cannot observe any of that. These three are the first
divergences to prove (order-group selection, `enabled` authority, marker-role override), and the
assertion for each is a marker's **presence or absence in the provider body**, not a field comparison.

## 5. The fixture plan (structure preserved, prose replaced)

Committed under `tests/browser/fixtures/real/`, generated by an idempotent
`tests/browser/real-fixture-desensitise.mjs`, with a `real-fixture-profile.mjs` that **refuses** if any
string longer than 64 characters lacks a marker prefix. The filler must preserve **UTF-8 BYTES**, not
JavaScript string length: the prose here is CJK (three bytes per character) and an `x`-run filler is one
byte per character, so a code-unit budget silently shrinks the document by 54% — measured, 6,938,739 →
3,167,611 JSON bytes — and takes the chunk lengths and the size class with it. A three-byte unit (`测`
runs, remainder padded) preserves the length exactly, and the generator asserts
`Buffer.byteLength(replacement) === Buffer.byteLength(original)` per string and re-serialises the whole
document back to its original byte length before it will write anything. With that filler the 19 MB card
costs about 360 KB of git blob (`chara` base64 deflates to 171,254 B), so the working tree is large, git
is not, and both numbers are stated rather than hidden. Only 990 of the card's 4,323 strings are long
enough to hold a marker at all, so short strings that carry no prose are kept verbatim and the marker
refusal applies to the long population, which is where the prose lives.

- **Preserve exactly:** samplers, `openai_max_*`, array order, `enabled`, `injection_*`, `role`,
  `position`, `depth`, `constant`, `selective`, `use_regex`, `insertion_order`, `probability`,
  `placement`, `minDepth`/`maxDepth`, `spec`/`spec_version`, every `id` (preset B's `e4b97186…`
  contradiction and the 36-character script ids depend on them), and both card chunk payloads' lengths.
- **Replace:** prose → `«MARKER_NNN»` + filler of the same **byte** length; helper `content` → a valid JS
  stub of the same byte length (`/*TH_B_00N*/` + `0;` runs) so the subtree stays **1,148,973 bytes** and
  still evaluates; regex `replaceString` → marker + filler of the same byte length (267,999 must stay
  267,999), because `promptOnly:true` scripts rewrite the outgoing prompt and their markers appearing in
  the body is a real differential; `findRegex` kept when it carries no prose.
- **Cards:** keep both `chara` and `ccv3` (the pinned reader prefers `ccv3`,
  `internal/server/characters_card.go:153-179`), replace only `IDAT` with a solid 512×768 RGBA image so
  the file decodes, keep `trAc` so the reader's tolerance of an unknown chunk is exercised, and record
  the original `IDAT` lengths in the manifest so nobody mistakes it for a picture fixture.
- **Manifest:** `real-fixture-manifest.json` carries every count in §2 plus the SHA-256 of the
  `prompt_order` projection and of the enabled bitmap, per-script content-length vectors, per-chunk
  lengths, and the `provenance.originals` hashes. The originals never enter the repository.

### 5.0 LANDED: the presets are fixtures in this repository (2026-10-25)

`tests/browser/fixtures/real/{preset-a.json,preset-b.json,real-fixture-manifest.json}` are committed, built by
`tools/build-real-fixtures.mjs` from the originals (which never enter the repository). Measured at build
time: preset-a is **72,499 bytes, the original's exact length**, and preset-b is **1,363,947 bytes, also
exact**; the 1.4 MB working tree costs 17,451 bytes of git blob (8,461 for preset-a). Everything the oracle
depends on is compared before and after and must be equal: prompts, `prompt_order` rows, enabled rows,
`enabledRowsPointingAtDisabledPrompt` (46 for A, 0 for B), the regex count, the `prompt_order` projection
sha256 and the enabled-bitmap sha256. Each helper script body becomes a stub of the same **serialised**
length that parses as JavaScript, and the manifest records the raw-length delta with its reason.

`node tools/build-real-fixtures.mjs --check --out tests/browser/fixtures/real` re-derives sha256 and byte
length from the files in the tree and refuses a mismatch; it was shown refusing a one-token edit and then
passing after the file was restored. Cards are refused by this tool with their profiled byte counts until
the chunk re-encoder lands — refused rather than silently skipped.

Two defects in the generator's first version were caught by its own assertions, and both are the shape this
document exists to prevent: a filler that preserved the RAW string length lost 445 bytes because the
document is measured after JSON escaping, and six profile comparisons read nested fields off the top level
and so compared `undefined === undefined`, which cannot fail.
### 5.2 How the real preset must reach the capture leg (decided 2026-10-25)

A real preset is a FILE the frontend's own preset manager reads, so the leg has to LOAD it, not rebuild it.
Measured from `tests/browser/preset-kit.mjs`: `applyPresetKit` installs only three prompts by assigning
`getPromptById(identifier).content` (`:409-427`) and then READS the live order with
`getPromptOrderForCharacter()` to assert ten identifiers are not disabled (`:431-436`). It never sets a row
and never replaces the prompt list, so a spec that carried 109/115 order rows would have no consumer -- the
"artefact field with no producer" shape this project keeps finding, caught before it was written.

Therefore: copy the fixture to `<dataRoot>/default-user/OpenAI Settings/<name>.json` on both legs, select it
through `#settings_preset_openai`, and assert the frontend reports **105 prompts / 109 rows / 66 enabled** for
A and **119 / 115 / 39** for B. Those three numbers are the proof that the real preset is in play; without
them a cross-leg green is a statement about the default preset.
### 5.1 Measured by `tools/real-fixture-profile.mjs`, not copied from §2

The profiler recomputes every number in §2 from the bytes of the originals and is the single definition
the generator and the manifest check both import. Against the originals on 2026-10-25 it printed, among
others: preset A `keys=45 prompts=105 rows=109 enabledRows=66 unreachable=7
enabledRowsPointingAtDisabledPrompt=46`; preset B `keys=47 prompts=119 rows=115 enabledRows=39
unreachable=4` with `promptsEnabledButUnreferenced=[enhanceDefinitions, jailbreak, main, nsfw]`; and the
card's `jsonBytes=6,938,739 reserialiseDelta=0`. The `46` and that exact four-name list reproduce §4
independently, which is the cross-check this table exists to allow.

**A units correction, recorded instead of reconciled away.** §2's `tavern_helper` figures for preset B
were **character** counts. In **bytes** the six script contents are `[150837, 21972, 13709, 899455,
11511, 9708]` and the subtree is **1,148,973 bytes**, not 1,112,202 — a 7.8% uplift from non-ASCII
content. The generator preserves bytes, so the byte figures bind; the manifest carries bytes with the
character counts beside them, so the two records cannot be read as disagreeing when they are measuring
different things.

## 6. 酒馆助手: what the server actually owes

Read at `N0VI028/JS-Slash-Runner@837a6288…` (manifest 4.11.3). `dist/index.js` is an ES module whose 25
static imports are relative URLs five levels up into the host's own `public/` modules, so it only works
when served from exactly `public/scripts/extensions/third-party/<name>/` with a JavaScript MIME type.
User scripts run in **unsandboxed same-origin `srcdoc` iframes**, and the bridge is property injection
at document start (`iframe/predefine.js`), not `postMessage`.

Server-side obligations, and their state after this round's mount work:

| Obligation | State |
|---|---|
| `/scripts/extensions/third-party/*` + pinned MIME | implemented (`.js/.mjs/.json/.css/.html`, charset rule) |
| `/version`, `/api/extensions/version`, `/api/settings/{get,save}`, `/api/presets/{save,delete,restore}`, `/api/characters/*`, `/api/chats/*`, `/api/worldinfo/*`, `/api/tokenizers/*`, `/api/backends/chat-completions/{generate,status}` | implemented |
| `/characters/*`, `/User%20Avatars/*`, `/assets/*` | **fixed this round** (were 404) |
| `/thumbnail` | **open** |
| `POST /api/avatars/upload` | **open** — a persona avatar cannot be created at all |
| `/api/messages/*` | not applicable: no such pinned router exists |

There is no `/api/messages/*` in pinned `server-startup.js`, so the helper's `saveChatConditional`
path is `/api/chats/save` — the earlier assumption that a missing messages router was a gap was wrong.

Two further findings that belong to the extension surface and are scheduled, not fixed:

- **`POST /api/extensions/version` runs `git fetch` twice** (`extensions_git.go:362` and, through
  `checkPinnedRepoIsUpToDate`, `:204`), and the pinned frontend calls it on page load whenever the
  user's persisted `extension_settings.notifyUpdates` is true. That is a network mutation of the user's
  extension repository (`.git/FETCH_HEAD`, objects, remote refs) that no GoTavern setting can turn off,
  and pinned does it once. It needs the same treatment as the pull path: bounded, named, and recorded as
  an inherited property with its opt-in named.
- **The helper persists avatar URLs into the DOM and the chat file** (`displayed_message.ts:124`,
  `persona.ts:304` builds `./User Avatars/<id>`), which is why the missing mounts were a helper defect as
  well as a visual one.

## 7. What a real-browser helper gate must assert

Not "the panel appears". The first falsifiable scenario is a helper **render script**: replace a
message with a 酒馆助手 script that reads and writes a chat variable, then renders one message. Pass
requires the iframe to exist without `sandbox`, `window.parent.TavernHelper` to be reachable from
inside it, the variable write to reach the chat file through `/api/chats/save`, and **every URL the
iframe and the rendered message put into the DOM to answer 200** — `/characters/<avatar>.png`,
`./User Avatars/<persona>`, `/assets/*`, `/thumbnail?type=avatar&file=…`. On the tree as it stood
before this round, that clause failed with four named 404s, which is a product finding rather than a
probe defect. The leg must also fail itself when helper-off and helper-on produce identical captures
(`AGENTS.md` rule 50), and it must serve or explicitly block `testingcf.jsdelivr.net`, because the
iframe heads are blocking `<script>` tags with no `onerror`.
