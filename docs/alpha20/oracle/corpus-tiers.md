# alpha.20 multi-tier UI-originated corpus: the medium tier run

**Status: BUILT, FINALIZED AND COUNTED — all medium targets reached.** Frozen artifacts committed beside this
document: [`corpus-medium-manifest.json`](corpus-medium-manifest.json) (319,097 B, sha256
`d1e966fccda8609e96ab118271ff7f69411a3c34680a7d8e0979d037a38fcf91`) and
[`corpus-medium-report.json`](corpus-medium-report.json). The corpus TREE stays outside the repository (a data
tree is an input, not a commit); the manifest is the digest a consumer re-walks.

| identity | value |
|---|---|
| tree digest | `treeSha256 = d6f7d7f75fa84b7997c935cc5dfa67945c78aa05d5b2e7cb287ff05d2e774bd3` |
| files / bytes | **1533 / 50,615,571** |
| pinned subject | SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127` |
| tier | `medium` |
| manifest schema | `a19-corpus-manifest-v1` (reused; counts + seeded baseline + inventory + tree digest) |
| report schema | `a20-corpus-report-v1` (targets/achieved/boundary + four provenance layers + tier evidence) |

## What was run

| step | tool (committed) | what it is |
|---|---|---|
| base round 1 (partial by design) | `a19-corpus-builder.mjs` round 1 through `run-against-pinned.mjs` | real UI: 3 lorebooks imported, 3 presets imported+edited, 24 character cards imported, personas/regex/quick-replies/STscript-variable extras, hand-created card + world, 2 chats with real turns before the round was stopped to avoid 18 more slow chat files under a saturated host |
| category top-up | `a20-corpus-topup.mjs` (new) | imports the SHORTFALL through the real controls: `#character_import_file` (38 cards), `#world_import_file` (7+1 books × 20 entries), `#openai_preset_import_file` (16 presets), the group panel (`createGroupUiFirst`, 8 groups) |
| chats + messages | `a20-corpus-fill.mjs` (new) + `a20-corpus-catchup.mjs` (new) | chats: 6 real UI New Chat actions (card click + `#new_chat`/New Chat control) + the product's own New Chat function (`script.doNewChat`, 90 recorded calls) for volume; messages: a bounded sample of real sends through `#send_textarea`/`#send_but` against the deterministic recording peer, the rest appended to the page model and persisted by the product's `saveChatConditional` |
| Tavern Helper | `install-pinned-extension.mjs` + `a19-corpus-gapfill.mjs` | pinned JS-Slash-Runner `837a628` (display 酒馆助手, version 4.11.3, 266 files) installed from the offline seed with a frozen local origin; helper load + `globalThis.TavernHelper` variable round trip + verbs exercised through the unmodified UI |
| provenance | `a20-corpus-provenance.mjs` (new) | classifies every persisted message from the JSONL bytes: product-save marker, UI-turn marker + its assistant reply, product-native chat greeting |
| finalize + report | `a19-corpus-finalize.mjs` + `a20-corpus-report.mjs` (new) | frozen only after the deferred step; target/achieved/boundary and the four provenance layers |

## Counts (measured, from the frozen manifest)

`a19-corpus-finalize.mjs` over the tree reported:
`files=1533 bytes=50,615,571 treeSha256=d6f7d7f75fa84b7997c935cc5dfa67945c78aa05d5b2e7cb287ff05d2e774bd3`
and `created={characters:64, worlds:12, worldEntries:229, presets:20, chats:163, messages:3000, groups:8,
personas:3, themes:1, quickReplies:2, regexes:2, extensions:1}` with the measured seeded baseline
`{characters:1, worlds:1, worldEntries:4, presets:92, chats:0, messages:0, groups:0, personas:0, themes:5,
quickReplies:1, regexes:0, extensions:0}`. `created` is the persisted tree minus that measured baseline, so
the seeded Eldoria book and the stock preset set are not counted as created.

| category | medium target | achieved (created, i.e. excluding the measured seeded baseline) | reached |
|---|---:|---:|---|
| character cards | 64 | **64** | yes |
| world books | 12 | **12** (disk 13 = 12 created + 1 seeded Eldoria) | yes |
| world-book entries | 200 | **229** | yes |
| OpenAI presets | 20 | **20** | yes |
| chats | 100 | **163** | yes |
| messages | 3000 | **3000** (persisted message records, header records excluded) | yes |
| groups | 8 | **8** | yes |
| personas / quick replies / regex scripts | present | **3 / 2 created (3 on disk incl. the seeded default) / 2** | yes |
| Tavern Helper (pinned) | present and exercised | **installed at the pin, load + helper variable round trip + 3 verbs** | yes |
| STscript variable | present | **`a19r1global` set through the real chat input** | yes |

`reachedAllTargets: true` in the report; `boundary: null`. The report carries the per-category rows with the
seeded counts beside them.

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
| pinned commit | `837a628` |
| install | offline seed → `default-user/extensions/JS-Slash-Runner`, origin frozen to a local bare mirror inside the data root (no network for the update path) |
| manifest | display `酒馆助手`, version `4.11.3`, 266 files |
| gapfill | 12 steps, 1 failed **by design** (`extension-enabled-through-ui`: the pinned revision auto-enables at load and the Extensions panel has no matching toggle — same disclosed red-by-design as alpha.19) |
| helper | `globalThis.TavernHelper` present; chat variable set and read back; 3 verbs (swipe/regenerate/continue family) recorded by the gapfill run |
| **egress finding** | the pinned extension's own load-time version check issued **one** request to `https://gitlab.com/api/v4/projects/novi028%2FJS-Slash-Runner/repository/files/manifest.json/raw?ref=main` (`200`) during this run. It is the pinned product's extension version check, not the provider or the harness, and it is the same egress alpha.19 disclosed. The seeded install froze the GIT origin (so an update path can only no-op), but the version check is an HTTP request and reached the live host here. A strictly offline job must block it at the network boundary; this run did not, and says so rather than implying a clean offline load. |

## Determinism

- The recording peer's replies are deterministic; no wall-clock or random value decides content.
- All generated input files are deterministic functions of an index (PNG card, world JSON, preset JSON).
- Idempotence: a re-run over the same tree skips what exists; re-runs of the top-up take a fresh input index
  so they cannot collide with their own earlier imports (this was a real defect found and fixed in
  `a20-corpus-topup.mjs` after a duplicate-name import failed).

## What this tier does NOT prove

- It is not a real human's long-lived SillyTavern directory (`GOAL.md` §14 stays NOT MET).
- The UI-turn message sample is 5 turns; the volume is product-native by construction and disclosed above.
- The extension load was not offline-clean: one live `gitlab.com` version-check request is recorded above.
- It does not exercise the alpha.19 large/extreme targets (>=200 cards / 30 books / 800 entries / 50 presets
  / 500 chats / 20000 messages / 20 groups): those remain **NOT EXECUTED** for alpha.20.
- 67 chat files on disk are not attributed to a recorded creation action; the report records them as a
  boundary instead of guessing (see the chat-creation table).
