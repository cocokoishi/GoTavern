# Character imports: CharX, BYAF and RisuAI, plus avatar crop and browser create/read-back

Lane `alpha11/imports` (G2, "character card imports long tail"). The matrix's `characters` row carried three named gaps:
CharX/BYAF/RisuAI imports unimplemented, avatar crop unprobed, and no browser create/read-back. This file records what
was decided, what was measured, and what remains.

## Verdict in one line

**All three formats are implemented in Go and compared against the PINNED import path, not against a hand-written
expectation**: same response bytes, same stored card JSON, same avatar dimensions/pixels, same auxiliary sprite /
background / icon files, same BYAF chat `.jsonl` text and same RisuAI sprite side effects, including the malformed,
truncated, wrong-bytes and oversized inputs. Uploaded-avatar crop/resize is now probed against pinned's observable
geometry (512x768 want_resize, cover-not-stretch, and the non-resize branch). A headless browser probe drives the
unmodified frontend's own New Character panel, reads the card back through the product's export route (which re-decodes
the STORED PNG), and has a tamper teeth mode.

## Per-format decision, from the pinned source

| Format | Pinned entry point | What the pinned server accepts and produces | Decision |
|---|---|---|---|
| CharX (`.charx`, ZIP) | `importFromCharX`, `src/charx.js` `CharXParser` + `persistCharXAssets` | First ZIP entry whose name ends with `card.json` (a self-extracting prefix is skipped by starting at the first local header); `spec` must be present; `data.assets[]` entries with `embeded://`/`embedded://`/`__asset:` URIs; avatar = icon asset named `main` (else first image icon); non-icon image assets map to `sprite` (characters/`<name>`/), `background` (characters/`<name>`/backgrounds/) or `misc` (user/images/`<name>`/) with lower-cased, separator-collapsed names; `readFromV2` + private-field stripping + fresh `create_date`; aux-asset failures are swallowed. | IMPLEMENTED |
| BYAF (`.byaf`, ZIP) | `importFromByaf`, `src/byaf.js` `ByafParser` | `manifest.json` (suffix match) with `characters[]` (first only) and `scenarios[]`; character JSON with `name`/`displayName`/`persona`/`isNSFW`/`loreItems`/`images`; scenario JSON with narrative/firstMessages/exampleMessages/formattingInstructions/messages/backgrounds/model settings; card is a v2 document whose `create_date` is fresh and whose `character_book`/`extensions.display_name` exist only when defined; chats, backgrounds and alternate icons are written only when no `preserved_name` was supplied; chat `.jsonl` reproduces both the interleaved and sequential message branches with `swipes[]`/`swipe_id` from the newest output. | IMPLEMENTED |
| RisuAI | `importFromJson`/`importFromPng` spec branches + `importRisuSprites` (`src/endpoints/sprites.js`) | A spec JSON or PNG card with `data.extensions.risuai.{additionalAssets,emotions}` writes each `[label, base64]` to characters/`<raw data.name>`/`<label>.png` (skipping a label that already has a file), then DELETES those two arrays from the imported card data. | IMPLEMENTED (both the JSON and PNG branches) |

The three formats are pure local conversions: no network, no provider, so unlike the excluded remote-embedding routes
there is no oracle-side blocker.

## Evidence, not status codes

The oracle is the pinned checkout at `06bde939…` driven through its real multer route (`tools/probe-characters-import.mjs`,
refreshed). Every scenario records the response bytes plus the WHOLE USER TREE the import touched:
`characters/` cards and their sprite/background/alt-icon subfolders, `chats/` `.jsonl` files, and `user/images/`
gallery entries. Go replays the identical multipart request and must reproduce that snapshot entry by entry
(`TestPinnedNodeCharactersImport`, user-tree half in `characters_import_usertree_test.go`).

Recorded scenarios, all green against pinned:

- CharX: full archive (105-prompt-style card with book, alternate greetings, tags, unknown top-level/data fields,
  icon/sprite/background/misc assets) → `{"file_name":"CharX Hero"}`, `characters/CharX Hero.png`,
  `characters/CharX Hero/{happy,sad-face}.png`, `characters/CharX Hero/backgrounds/bg_1.png`,
  `user/images/CharX Hero/note_image.png`; no-icon card → default avatar; ZIP without `card.json`; card without `spec`;
  truncated archive; wrong bytes; a 128 KiB asset archive (oversized input).
- BYAF: full archive → `{"file_name":"Byaf Display"}`, card name `ByafHero`, `character_book` entries,
  `alternate_greetings`, `tags: ["nsfw"]`, `extensions.display_name`, two chats under `chats/Byaf Display/`, one
  deduplicated background `user/images/Byaf Display/Byaf Display_bg (1).png` referenced by BOTH chats, one alternate
  icon `characters/ByafHero/Alt Look (1).png`; minimal archive; missing manifest; empty `characters[]`; truncated
  archive.
- RisuAI: JSON spec and PNG spec cards → both write `characters/<name>/{happy,sad,angry}.png` and strip the two arrays
  from the stored card.
- Avatar crop: `POST /api/characters/edit-avatar?crop=…` scenarios for the `want_resize: true` 512x768 branch (pixel
  digest omitted BY DESIGN — the codec is a documented divergence — and geometry proven by sampled colours at
  cover-vs-stretch discriminating points), the `want_resize: false` 4x4 branch (exact pixels), and a malformed `crop`
  query. The source image is a white 1px border around a solid red 6x6 interior: on the 512x768 cover branch the
  border is cropped away, so `(30,384)` and `(256,384)` are red; a stretch would keep the border and read white.

Response-text and header equality is asserted for every scenario by the existing oracle test; the user tree is compared
by path, card JSON (create-date/humanized-name normalized), image dimensions + sampled RGBA + pixel digest (except the
one declared codec-divergence case), and sha256 for auxiliary bytes.

Local result: `go test ./internal/server -run TestPinnedNodeCharactersImport -count=1` → **ok, 34 subtests**.

## Avatar crop / resize

Go's crop path already existed (`cardImageBytes` → `reencodeImage` → `cropImage`/`coverImage`, with the pinned
512x768 `want_resize` branch and cover-not-stretch geometry). What was missing was EVIDENCE, so it is now in the oracle
snapshot above: the pinned Jimp output and the Go output agree on dimensions, and the sampled colours prove the border
was cropped away rather than stretched in. Full RGBA equality is NOT claimed for the want_resize branch (Jimp's
resampler vs `x/image/draw`), exactly as ARCHITECTURE.md boundary 3 records; the no-resize branch, where both write the
same 4x4 pixels, is compared exactly.

## Browser create / read-back

`tests/browser/character-create-probe.mjs` (headless, server booted with `--browserLaunchEnabled false`):

1. opens the unmodified frontend, clicks the real `#rm_button_create` control and fills `#character_name_pole`,
   `#description_textarea`, `#firstmessage_textarea`, `#personality_textarea`, `#mes_example_textarea`;
2. submits `#form_create` and waits for the frontend's own roster to list the new card;
3. reads the STORED PNG from `characters/<avatar>` and decodes its `chara` tEXt chunk (bytes check);
4. reads the card back through `POST /api/characters/export?format=json`, a route that re-decodes the stored PNG, and
   requires name/description/first_mes/personality/mes_example to equal what the panel typed;
5. teeth (`--self-test`): rewrites the stored card's `description` in BOTH text carriers (`chara` and `ccv3`; the
   product prefers `ccv3`), boots a second process over the same tree (the product caches the card in-process), and
   requires the read-back to report `TAMPERED-BY-PROBE` and the expectation to go RED; the original bytes are restored
   in a `finally`.

Local result: 5/5 steps green with teeth caught:
`created-through-the-create-panel`, `stored-png-carries-the-typed-card`, `read-back-through-the-product-matches-what-was-typed`,
`mutating-the-stored-field-turns-the-read-back-red`.

## Mutations (named red, then restored green)

Three mutations of the implementation, each applied to a FILE COPY (`.tmp-artifacts/characters_import_formats.backup.go`,
never `git checkout`), run with `-count=1`, then restored and byte-verified:

| # | Mutation | Named red |
|---|---|---|
| M1 | drop `data.setMember("character_book", …)` | `TestPinnedNodeCharactersImport/importByaf` — stored card differs (character_book missing) |
| M2 | `alternate_greetings` written as `[]` | `TestPinnedNodeCharactersImport/importByaf` — stored card differs (alternate greeting missing) |
| M3 | CharX avatar forced to the default avatar (`icon = nil`) | `TestPinnedNodeCharactersImport/importCharX` — stored image is the 512x768 default, pinned has the 2x2 icon |

Restore: source sha256 `EE28418A…7048C92E` before and after, restored run `ok 9.109s`. Evidence:
`.tmp-artifacts/mutation-evidence.txt` and `.tmp-artifacts/mutation-M{1,2,3}-*.txt` (local scratch, gitignored).

## Commands

```powershell
# re-record the pinned oracle (boots pinned with --browserLaunchEnabled false)
node tools/probe-characters-import.mjs <pinned-checkout> <gotavern-root>
# the oracle replay (all scenarios, response bytes + stored tree)
go test ./internal/server -run TestPinnedNodeCharactersImport -count=1
# the browser create/read-back probe (needs tests/browser/node_modules and a built binary)
$env:GOTAVERN_BINARY = "<repo>\.tmp-artifacts\gotavern.exe"
node tests/browser/character-create-probe.mjs --data-root <empty data root> --report <report.json> --self-test
# checkers
node tools/compat-matrix/render.mjs --emit
node tools/compat-matrix/check.mjs
node tools/check-fixture-watermarks.mjs
node tools/verify-browser-comparisons.mjs
```

## What is NOT done, stated rather than implied

- **The browser probe is not yet wired into a CI workflow.** It was executed locally (Layer A) and its probe is
  committed; CI currently gates the route-level oracle only. `data-domain-drive.mjs` already records a
  frontend create+read-back interaction on BOTH subjects with a committed, verified comparison artefact — that surface
  is the pinned-vs-GoTavern equality claim today; the new probe adds the stored-bytes read-back and the teeth, but not
  a CI trigger.
- **AVIF/APNG/AVIF avatar bytes are not decoded by the pure-Go path.** CharX accepts png/jpg/jpeg/webp/gif/bmp/tiff
  avatars (Go's decoders); an AVIF-encoded `icon` asset would fail to re-encode on Go while Jimp's wasm decoder accepts
  it. This is the same codec boundary as `ARCHITECTURE.md` boundary 3 and is NOT claimed as parity.
- **Jimp-exact pixels are never claimed.** Dimensions, sampled geometry and the non-resize branch are the observable;
  the want_resize branch's resampled RGBA digest is deliberately recorded as null with that reason.
- **BYAF imports only the first character** of a multi-character manifest — pinned does the same (it warns), so this is
  parity, not a gap.
- **Auxiliary-asset write failures are swallowed** for CharX, as they are on pinned (it warns and continues).
- **The historical private-run caveat from the persistence lane is unrelated** to these formats; no private card or
  preset was used here — every input is synthetic, built by the probe, and the watermark checker runs clean.
