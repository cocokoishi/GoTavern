# Alpha.19 Node-UI-Originated Complex User Corpus (provenance)

**Role of this document.** It is the human-readable provenance for the corpus that the alpha.19 oracle and
release report consume. The machine-readable form is committed beside it:

| file | what it is |
|---|---|
| [`corpus-manifest-v2.json`](corpus-manifest-v2.json) | `a19-corpus-manifest-v1` manifest: full inventory (`path`, `sha256`, `bytes`), `treeSha256`, created-vs-seeded counts, message split, action-log filenames/record count |
| [`corpus-report-v2.json`](corpus-report-v2.json) | report: counts, split, extension provenance, verb coverage, measured costs, hygiene, explicit unproven list |

The corpus **tree itself is outside the repository** and is not committed: a data tree contains the
pinned server's seeded defaults, user-authored cards/lorebooks/chats and a 20 MB+ extension checkout, none
of which belong in the repo. What is committed is paths, hashes and counts, which is enough to re-verify a
copy without holding it here.

## Corpus identity

| field | value |
|---|---|
| root (producer) | `C:\Users\koishi\Desktop\GoTavern\a19-oracle\corpus` |
| origin / tier | `ui` / `full` |
| pinned subject | SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a9165b5bce127` |
| manifest file | `corpus-manifest-v2.json`, 198,074 bytes, sha256 `25caa60c871cde4348c22ed24baac18aaf6911ebc065d3e6ba74d95fcc61b1d9` |
| tree digest | `treeSha256 = 06d68e057085abad28d4e3bfc19df71cf91d9ea612ad6907bd67b38784d3a2ba` |
| files / bytes | 978 / 49,898,769 |
| frozen since | 2026-11-09T05:31:59Z (no file written after the gap-fill leg; the copy-run below never touched it) |

## The digest algorithm (the contract, and the trap)

```
treeSha256 = sha256( UTF-8( join("\n", [
    "<sha256>  <path>" for each inventory entry, INVENTORY SORTED BY PATH (ordinal, not locale)
]) ) )          # no trailing newline
```

- Producer (`tests/browser/a19-corpus-finalize.mjs`) sorts by path with ordinal comparison before joining.
- **Trap measured:** a verifier that sorts with a culture-aware comparator (PowerShell `Sort-Object`, or
  sorting the *lines* instead of the inventory by path) reports a **false mismatch** on a correct corpus.
  The Lead's independent verification sorted the inventory by path and matched **978/978 file hashes**,
  `files`/`bytes` and the tree digest exactly; an earlier "mismatch" was the verifier's sort, recorded and
  corrected.
- The manifest is re-read after writing and the tree digest/files are compared in-process, so a manifest
  that disagrees with what was just computed is refused rather than published.

## Counts: created vs seeded vs disk

`created` = persisted tree minus the **measured fresh-install baseline** (a fresh pinned data root is not
empty: one default character card, one Eldoria lorebook with four entries, the stock preset/theme/
background/QR sets). Every import through a product import control counts as **created**, because the
control, not a file copy, produced it.

| category | created | seeded | disk |
|---|---:|---:|---:|
| characters / cards | **32** | 1 | 33 |
| world books | **9** | 1 | 10 |
| world-book entries | **154** | 4 | 158 |
| presets (OpenAI Settings) | **10** | 92 | 102 |
| chats (character) | **51** | 0 | 51 |
| group chats | **5** | 0 | 5 |
| messages (chats + group chats) | **1168** | 0 | 1168 |
| groups | **5** | 0 | 5 |
| personas | **3** | 0 | 3 |
| themes | **1** | 5 | 6 |
| Quick Reply sets | **2** | 1 | 3 |
| regex scripts | **2** | 0 | 2 |
| extensions | **1** | 0 | 1 |

Messages are counted from the persisted `.jsonl` files (header record excluded) in **both** `chats/`
and `group chats/`; the user's minimum is about persisted messages, and a group message is one.

## Message provenance split (mandatory disclosure)

| source | pairs | how |
|---|---:|---|
| UI turns | **396** | real sends through `#send_textarea` + `#send_but`, replies stored by the product |
| product save path | **772** | appended to the page's chat model and persisted through the product's own `saveChatConditional` |

No JSONL was hand-written or copied. The split is in the manifest (`messageSplit`) and must be quoted
downstream: the corpus is **not** 100% UI-turn-originated for messages.

## Action logs (evidence, outside the repo)

The manifest records the filenames and the record count; the logs stay in the producer scratch:

`C:\Users\koishi\Desktop\GoTavern\a19-oracle\`

```
round1/actions-round1.jsonl
round0/actions-round0.jsonl
round9/actions-message-topup.jsonl
round9/actions-message-topup2.jsonl
round11/actions-gapfill.jsonl
round11/actions-gapfill2.jsonl
round11/actions-gapfill3.jsonl        (7 files / 121 records)
```

Each record names the page, the control (a real selector or product function), the field, the action and
the **observed result**; failures are recorded as failures, not dropped.

## Rounds actually executed (all over the same root, each in a FRESH pinned process)

1. **Round 1** — bulk imports through the product import controls (cards, lorebooks, presets), a
   hand-created character and an entry-by-entry lorebook, chats and groups through the UI.
2. **Top-up** — imports to the minimums, groups, chats and real turns.
3. **Message top-up ×2** — proven send path plus the disclosed product-save-path fill.
4. **Gap-fill** — created minima (`+1` card, `+2` entries through the real World Info editor), the pinned
   Tavern Helper extension, and the verb matrix.

Because each later process reopened chats written by an earlier one, chat persistence across process
restarts is evidenced by construction. The explicit `--use` / `--restart` short phases are **not** part of
the frozen root's tree (they would mutate it); they were run against a byte copy, below. The copy-run
`--restart` leg independently confirms the resume half: a NEW pinned process over the copy reopened and
matched three persisted chats (`restart-resumed-persisted-chats` PASS).

## Rounds on a copy (`copy-verify/corpus`, the root was never touched)

`--use` and `--restart` were executed by the builder against a `robocopy /MIR` copy so the release-admissible
root stays byte-identical. Results:

| phase | result |
|---|---|
| `--use` preset edit through `#settings_preset_openai` + `#temp_openai` + `#update_oai_preset` | **PASS** (preset `A19Preset r1 1`, temperature 0.77) |
| `--use` card edit through the character-edit panel | **PASS** (`A19R1 The Quiet Archive 3`, `editMode=editcharacter`) |
| `--use` card duplicate through the character panel | **FAIL** — `roster did not grow after Duplicate` (before 33); the pinned Duplicate control did not add a roster entry in this state |
| `--use` reload persistence | **PASS** (card + chat reopened, chatId restored) |
| `--restart` (new pinned process over the copy) | **resume PASS** — `restart-resumed-persisted-chats` reopened and matched three chats written by another process (`round31/round31.json`); `restart-continued-generation` **FAIL** (5 sends, ~15 s each, no reply) because the copy's stored `custom_url` is the stopped recorder and the short-phase code does not reconfigure the connection |
| copy-run chat turns | the copy's stored `custom_url` pointed at the stopped recorder from the corpus build and the short phases do not call `ensureConnection`, so their chat turns reached **no provider** and added no messages. This is a named harness limitation of `runUsePhase`/`runRestartPhase`, recorded rather than hidden; it does not affect the frozen root, whose numbers come from the manifest. A follow-up fix is to start a recorder and call `ensureConnection` in both phases before the send loop. |

## Extension provenance (Tavern Helper / JS-Slash-Runner)

| field | value |
|---|---|
| pinned commit | `837a6288135cde61522a9279173b98020f08807e` (from `tests/browser/pinned-extensions.mjs`) |
| install path | `default-user/extensions/JS-Slash-Runner` |
| source | **offline seed**: `GOTAVERN_EXTENSION_SEED_ROOT=.private-fixtures/run/tree-gotavern-a/default-user/extensions` (a checkout already at the pin) |
| origin freeze | `ensureFrozenOrigin` replaces the remote with a local bare mirror inside the data root; a page-triggered `autoUpdateExtensions` fetch/pull can only be a no-op and no request leaves the process for the update path |
| version / display | `4.11.3` / 酒馆助手 (manifest `display_name`) |
| loading | unmodified frontend fetched `manifest.json`, `dist/index.js`, `dist/index.css` — all `200` |
| helper API | `globalThis.TavernHelper` present; chat variable `A19_GAPFILL_VAR` set and read back through the helper API (`before: {}`, `after: {A19_GAPFILL_VAR: "gapfill-1794204371385"}`) |
| iframes | **0** — this revision runs in-page; iframe evidence is 0 by design, not missing |
| enablement | **auto-enabled at load**; the Extensions panel had no matching toggle, so the step `extension-enabled-through-ui` is recorded **FAILED by design** while load + API are green |
| **egress finding** | during load the pinned extension itself issued **one** request to `https://gitlab.com/api/v4/projects/novi028%2FJS-Slash-Runner/repository/files/manifest.json/raw?ref=main` (`200`) — the pinned product's extension version check, not the provider or the harness. A strictly offline CI job must block this at its network boundary, or the load will attempt it. |

## Verb coverage (three existing chats, live recorder, proven send path)

| verb | result |
|---|---|
| send | 3/3 |
| swipe | 3/3 |
| regenerate | 3/3 |
| continue | 3/3 |
| edit | **2/3** |
| delete | 3/3 |
| save + reopen | 3/3 |

Two measured traps fixed while producing this: pinned edits the message in a **contenteditable
`.mes_text`**, not a textarea (so every "edit" failed while the panel was visibly in edit mode), and delete
must click a **visible** confirm because `#dialogue_popup_ok` is a permanent hidden element (the same trap
as New Chat).

## Storage hygiene

- The corpus's stored `oai_settings.custom_url` is `http://127.0.0.1:53115/v1`; **verified not listening**
  after the build (TCP connect refused), so the frozen tree carries a dead recorder endpoint, not a live one.
- No provider, pinned server or headless-browser process was left behind after the final leg.
- Every browser leg was headless chromium in its own context, closed at the end of the invocation.

## What this document does NOT prove

- It does not prove the corpus is 100% UI-turn-originated: **772 of 1168 messages** came from the product
  save path (disclosed above).
- It does not prove every verb on every chat: edit is 2/3.
- It does not prove LittleWhiteBox: only the Tavern Helper canary is installed.
- It does not prove a clean offline extension load until the gitlab.com version-check request is blocked at
  the CI boundary.
- It does not prove the pinned Duplicate control works in every state: the copy-run duplicate attempt
  failed with a named reason and is recorded, not hidden.
