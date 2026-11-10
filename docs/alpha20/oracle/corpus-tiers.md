# alpha.20 multi-tier UI-originated corpus: the medium tier run

**Status: BUILT AND COUNTED; the FINAL manifest/report were deferred by the Lead's quiet window and are NOT
claimed yet.** The numbers below come from a real run of the committed drivers against the pinned server.
Where a number is derived from two measured artifacts rather than one frozen manifest, the row says so; no
count here is copied from a builder log.

## What was run

| step | tool (committed) | what it is |
|---|---|---|
| base round 1 (partial by design) | `a19-corpus-builder.mjs` round 1 through `run-against-pinned.mjs` | real UI: 3 lorebooks imported, 3 presets imported+edited, 24 character cards imported, personas/regex/quick-replies/STscript-variable extras, hand-created card + world, 2 chats with real turns before the round was stopped to avoid 18 more slow chat files under a saturated host |
| category top-up | `a20-corpus-topup.mjs` (new) | imports the SHORTFALL through the real controls: `#character_import_file` (38 cards), `#world_import_file` (7+1 books × 20 entries), `#openai_preset_import_file` (16 presets), the group panel (`createGroupUiFirst`, 8 groups) |
| chats + messages | `a20-corpus-fill.mjs` (new) + `a20-corpus-catchup.mjs` (new) | chats: 6 real UI New Chat actions (card click + `#new_chat`/New Chat control) + the product's own New Chat function (`script.doNewChat`, 90 recorded calls) for volume; messages: a bounded sample of real sends through `#send_textarea`/`#send_but` against the deterministic recording peer, the rest appended to the page model and persisted by the product's `saveChatConditional` |
| Tavern Helper | `install-pinned-extension.mjs` + `a19-corpus-gapfill.mjs` | pinned JS-Slash-Runner `837a6288135cde61522a9279173b98020f08807e` (display 酒馆助手, version 4.11.3, 266 files) installed from the offline seed with a frozen local origin; helper load + `globalThis.TavernHelper` variable round trip + verbs exercised through the unmodified UI |
| provenance | `a20-corpus-provenance.mjs` (new) | classifies every persisted message from the JSONL bytes: product-save marker, UI-turn marker + its assistant reply, product-native chat greeting |
| finalize + report | `a19-corpus-finalize.mjs` + `a20-corpus-report.mjs` (new) | frozen only after the deferred step; target/achieved/boundary and the four provenance layers |

## Counts (measured)

Pre-finalize `a19-corpus-finalize.mjs` run over the tree (before the last one-book top-up) reported:
`files=1531 bytes=50,538,282 treeSha256=a78bb427317de17f08fff04fe785f7c3005bd42fbe8d6c8bbd5f153bced5e380`
and `created={characters:64, worlds:11, worldEntries:209, presets:20, chats:163, messages:3000, groups:8,
personas:3, themes:1, quickReplies:2, regexes:2, extensions:1}` with the measured seeded baseline
`{characters:1, worlds:1, worldEntries:4, presets:92, chats:0, messages:0, groups:0, personas:0, themes:5,
quickReplies:1, regexes:0, extensions:0}`. A follow-up `a20-corpus-topup.mjs` run (fresh input index) imported
**one more world book with 20 entries** (`before:12 after:13`, `entriesOnDisk:20`).

| category | medium target | achieved (created, i.e. excluding the measured seeded baseline) | reached |
|---|---:|---:|---|
| character cards | 64 | **64** | yes |
| world books | 12 | **12** (disk 13 = 12 created + 1 seeded Eldoria) | yes |
| world-book entries | 200 | **229** (209 + 20 from the last book) | yes |
| OpenAI presets | 20 | **20** | yes |
| chats | 100 | **163** | yes |
| messages | 3000 | **3000** (persisted records, header records excluded) | yes |
| groups | 8 | **8** | yes |
| personas / quick replies / regex scripts | present | **3 / 2 created (3 on disk incl. seeded default) / 2** | yes |
| Tavern Helper (pinned) | present and exercised | **installed at the pin, load + helper variable round trip + 3 verbs** | yes |
| STscript variable | present | **`a19r1global` set through the real chat input** | yes |

The world/entry counts are the sum of the frozen-manifest row and the recorded follow-up import; the FINAL
manifest digest will replace this derivation when the deferred finalize runs, and will be the authority.

## Message provenance (mandatory disclosure, not merged)

Derived by `a20-corpus-provenance.mjs` from the 163 persisted chat JSONL files (3000 message records,
163 header records, 0 unparseable lines):

| layer | messages | how |
|---|---:|---|
| real UI turns | **10** (5 pairs) | `#send_textarea` + `#send_but` against the deterministic recording peer; a successful turn persists the user message and the assistant reply |
| product-native save path | **2826** | appended to the page chat model and persisted by the product's own `saveChatConditional`; NOT UI turns |
| product-native chat creation | **164** | the character greeting(s) the product writes when its New Chat function creates a chat; NOT a send and NOT a save-path fill |
| **total** | **3000** | |

## Chat-creation provenance (mandatory disclosure, not merged)

| layer | count | how |
|---|---:|---|
| real UI control actions | **6** recorded New Chat actions | card click + New Chat control, confirmed chatId change and a persisted .jsonl |
| product-function New Chat | **90** recorded calls | `script.doNewChat()`, the product function the confirmed New Chat click handler invokes |
| chats on disk | **163** | the manifest's chat count |
| **unattributed** | **67** | the difference between the recorded actions/calls and the disk count is NOT attributed to a behaviour this run instrumented (a New Chat call can also persist the outgoing chat). Recorded as a boundary, not guessed |

## Extension provenance

| field | value |
|---|---|
| pinned commit | `837a6288135cde61522a9279173b98020f08807e` |
| install | offline seed → `default-user/extensions/JS-Slash-Runner`, origin frozen to a local bare mirror inside the data root (no network for the update path) |
| manifest | display `酒馆助手`, version `4.11.3`, 266 files |
| gapfill | 12 steps, 1 failed **by design** (`extension-enabled-through-ui`: the pinned revision auto-enables at load and the Extensions panel has no matching toggle — same disclosed red-by-design as alpha.19) |
| helper | `globalThis.TavernHelper` present; chat variable set and read back; 3 verbs (swipe/regenerate/continue family) recorded by the gapfill run |

## Determinism

- The recording peer's replies are deterministic; no wall-clock or random value decides content.
- All generated input files are deterministic functions of an index (PNG card, world JSON, preset JSON).
- Idempotence: a re-run over the same tree skips what exists; re-runs of the top-up take a fresh input index
  so they cannot collide with their own earlier imports (this was a real defect found and fixed in
  `a20-corpus-topup.mjs` after a duplicate-name import failed).

## What this tier does NOT prove

- It is not a real human's long-lived SillyTavern directory (`GOAL.md` §14 stays NOT MET).
- It is not frozen yet: the final manifest/tree digest is pending the deferred finalize; the numbers above
  are measured but the digest will move with the last import.
- The UI-turn message sample is 5 turns; the volume is product-native by construction and disclosed above.
- It does not exercise the alpha.19 large/extreme targets (>=200 cards / 30 books / 800 entries / 50 presets
  / 500 chats / 20000 messages / 20 groups): those remain NOT EXECUTED for alpha.20.
