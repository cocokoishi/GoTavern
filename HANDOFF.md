# HANDOFF

**There is exactly ONE executable checkpoint in this file, and it is `## Latest checkpoint` below. Every
section after it is HISTORY: a dated record of what was true on the date it names, kept because the
reasoning is worth more than the state. A history section is never evidence for a current claim — check
its date, then check `docs/goal-scorecard.md`, which is the live ledger.**

Baseline: SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. Oracle checkout lives beside
this repository at `../SillyTavern` and is READ-ONLY.

---

## Latest checkpoint — 2026-10-26

| Field | Value |
|---|---|
| **HEAD (main)** | `2a0d897` |
| **Pinned baseline** | SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127` |
| **Live evidence ledger** | `docs/goal-scorecard.md` — twenty-two rows, five classes, and `tests/docs/run-manifest.json` |
| **Milestone ladder** | `GOAL.md` §11: M0 (closed) through M5; M1..M4 open |

### Active lanes (8 slots: one lead, seven lanes, one owner per area)

A lane owns an AREA, and two lanes never own the same area (`AGENTS.md` rule 39, and the collaboration
contract in the same file). The table below is the CURRENT allocation; a lane not listed here has no owner
and is not being worked on.

| Slot | Area | State |
|---|---|---|
| lead | integration, merge into `main`, release decisions | active |
| 1 | documentation, goal, oracle doctrine, evidence ledger | active — `AGENTS.md`/`GOAL.md`/`ARCHITECTURE.md`/`docs/goal-scorecard.md`; gate `internal/fixtures/documents_test.go` |
| 2 | core config/startup boot | active |
| 3 | Q21 data hand-back to pinned Node | active — leg is RED, class `harness failure` (see the ledger) |
| 4 | Q19 streaming/cancel cut legs | active — on an UNMERGED branch, so `main` has no Q19 evidence |
| 5 | Q17 Author's Note sweep | active — probes exist, no workflow invokes them |
| 6 | Q18 truncation past the context boundary | active — no leg drives it yet |
| 7 | visual assets / helper surfaces | active — Q3-Q8 proven on `Browser differential` 40325398585 (success) |

### Key Actions runs at this HEAD

Quoted as `workflow name + run id + conclusion`, because a run id without its workflow name is not
evidence (`AGENTS.md` rule 55). Every id here is in `tests/docs/run-manifest.json` with its `head_sha`.

| Workflow | Run | Conclusion | What it says |
|---|---|---|---|
| `GoTavern CI` | 40438192589 | success | build, vet, gofmt, full Go suite, document-facts and matrix checks |
| `GoTavern drop-in qualification` | 40438192579 | success | the packaged archive boots a stock tree |
| `Browser differential` | 40438262854 | **failure** | assets/helper/preset/Q20 legs passed; the Q21 hand-back step FAILED — driver staging, not a product finding |
| `Browser differential` | 40325398585 | success | asset + helper legs, which is where Q3-Q8 are proven |
| `Browser differential` | 40387864205 | success | Q20 save -> reload -> swipe |

### Next action

Land the documentation-gate change (`internal/fixtures/documents_test.go` plus this file set) and quote
its red and green runs. Then, in order of what the ledger says is missing: (1) fix the Q21 hand-back
leg's card staging so the row can leave `unproven`; (2) merge the Q19 streaming legs so `main` has
streaming evidence at all; (3) wire `authors-note-sweep.mjs` into a workflow for Q17; (4) add a
truncation leg for Q18; (5) add regenerate/continue steps to the Q20 probe.

### Blockers

- **The local qualification channel is NOT YET DEMONSTRATED.** It is written as constraints in
  `AGENTS.md` (collaboration contract, item 5) and `docs/development-loop.md` §4, and nothing may cite it
  as though a run had exercised it.
- **Q19 has no evidence on `main`.** Its runs judged a commit on an unmerged branch; the ancestry check
  refuses such a citation, correctly.
- **Q21 is red for a harness reason.** The product wrote the file; the driver did not stage the card under
  the name pinned lists.

---

## HISTORY

Everything from here down is a DATED RECORD, not current state. Sections keep their original dates and
their original `main` SHAs. Read them for the reasoning; never quote a number from them as a measurement
of today. The line below marks where history begins; the first historical section is the P0 second pass
of 2026-10-25.

## P0 — second pass: the product a user actually sees (2026-10-25, `main` `ec16bda`)

The first pass below closed three defects and gated them. This pass starts from a harder report: after real
use, the product is still not usable — the page opens and the images are missing, 酒馆助手 does not work, and
no test can prove that a real preset changes the model context the way pinned does.

`GOAL.md` is now the locked goal, `AGENTS.md` rules 42-53 are the process contract, `ARCHITECTURE.md` §35 is
the design contract, and `docs/gate-blindspots.md` is the analysis of why the gates could not see any of it
(the short version: a `knownReason` allowlist reported the `/thumbnail` 404 as `differenceCount: 0` while the
same artifact recorded GoTavern's two console 404s beside pinned's empty list). The three defects below are
recorded as **OPEN** until their gates run in CI on the packaged artifact.

### P0-E — core visual assets are missing (root cause found, in source)

Measured against the oracle, not guessed:

- `SillyTavern/src/users.js:1213-1219` mounts **seven** user-data static trees. GoTavern
  (`internal/server/frontend_assets.go:65-73`) registered **three** — `/user/images/*`, `/user/files/*`,
  `/backgrounds/*` — plus `/css/user.css`. Missing: **`/characters/*`**, **`/User%20Avatars/*`**,
  **`/assets/*`**. `/characters/<file>.png` is the URL behind a character's full-size avatar, its sprites and
  its live2d, and it answered 404.
- **`/thumbnail` has no implementation at all.** Pinned serves it from `src/endpoints/thumbnails.js`, mounted
  as `thumbnailRouter` at `src/server-startup.js:21`. The pinned frontend builds *every* avatar URL through
  `getThumbnailUrl` (`public/script.js`: `` `/thumbnail?type=${type}&file=${encodeURIComponent(file)}` ``),
  and the callers include `buildAvatarList` — the character list itself — plus `group-chats.js`,
  `bookmarks.js`, `personas.js` and `backgrounds.js`. There is no `onerror` fallback, so this single missing
  route is why the character list, chat avatars, persona images and background thumbnails are all broken.

Why no gate saw it: the three mounts that *are* implemented were each added because some E2E happened to need
them (`frontend_assets.go`'s own header records the extension E2E finding `/user/files/*`), and `/thumbnail`
was recorded as a *codec boundary* (`AGENTS.md` architecture boundary 3, and the startup differential's two
`/thumbnail` 404 differences) — so the 404 was a documented, accepted value. Nothing in the suite ever loaded
a page and looked at a picture, and no gate compared the mount sets. `AGENTS.md` rules 42-46 are the result.

**The audited surface (2026-10-25, from pinned source; `docs/gate-blindspots.md` for the process side).**
`/thumbnail` is not one of eleven asset URLs — it is the single surface behind *most* of them:

| Frontend surface | URL built by | State before the fix |
|---|---|---|
| character list (every avatar) | `script.js:2565` `buildAvatarList` → `getThumbnailUrl('avatar', …)` | `/thumbnail` **404** |
| **every chat message avatar, both directions** | `script.js:2619` (persona), `:2628` (character) | `/thumbnail` **404** |
| group collage avatars | `group-chats.js:606`,`:885`,`:1686` | `/thumbnail` **404** |
| persona list / persona image / zoomed persona | `personas.js:177`,`:243`,`:580` | `/thumbnail` **404** |
| background gallery tiles and folder covers | `backgrounds.js:860`,`:1434` | `/thumbnail` **404** |
| clicked-character full image | `script.js:12230`,`:12246` → `/characters/<avatar>` | mount **missing** |
| expression sprites | `src/endpoints/sprites.js:142` hands out `/characters/<name>/<file>` | mount **missing** |
| zoomed persona full size | `personas.js:100`,`:137` → `User Avatars/<id>` | mount **missing** |
| Live2D / VRM models | `assets.js:132`,`:148`,`:159` → `/assets/...` | mount **missing** |
| the applied background itself | `backgrounds.js:288` → `/backgrounds/<file>` | implemented |

Three consequences that make this worse than a rendering bug:

- **The defect is written into user data.** The frontend persists `mes.force_avatar` as a literal
  `/thumbnail?type=…` URL inside the chat `.jsonl` (`script.js:5894`, `:6773`, `personas.js:1864`,
  `slash-commands.js:5800`, `bookmarks.js:420`). Old chats saved under pinned Node therefore carry a URL that
  GoTavern answers 404 for, so this cannot be worked around in the frontend and cannot be forgotten by users.
- **The server lists URLs it does not serve** — for the third time in this codebase. `GET /api/sprites/get`
  returns `path: /characters/<name>/<file>` (`internal/startup/user_sprites.go:56`) and `/api/assets/get` /
  `/api/assets/character` return `/assets/…` and `/characters/<name>/<cat>/<file>` (`assets.go:366`); both were
  404s before the mount fix. The `__transparent.png` precedent is already documented at
  `internal/server/frontend_assets.go:17-19`, which is the general form of this defect: *a listing must be
  answerable by the server's own routes.*
- **A persona avatar cannot be created at all.** `POST /api/avatars/upload` is not registered in this server
  (`nanogpt.go:21` is a comment, not a route), so even after `/thumbnail` exists a user can display a persona
  but not set one.

Corrections this audit produced, because the earlier plan would have implemented the wrong contract:
**`forcePng` does not exist** in this baseline (zero hits repo-wide); the pinned handler reads only `file`,
`type` and `animated`; the served MIME comes from the **original filename's extension** while the bytes are the
configured format (`res.sendFile(file, {root: thumbnailFolder})`), so a `.png` original with JPEG bytes is
served `image/png`; animated detection is a **200-byte scan** for `acTL` (APNG) or `ANIM`/`ANMF` (WebP), not a
decode; `thumbnails.quality` is clamped to 1..100 via `parseInt` and `thumbnails.format` is compared as
`String(v).toLowerCase().trim() === 'png'`; `SKIPPED_EXTENSIONS` includes `.gif`, which is also short-circuited
separately; and `invalidateFirefoxCache` only rewrites `Cache-Control` for a Firefox UA on an `image/*` path.

Documents that recorded the 404 as acceptable and are corrected in the same lane, because leaving them is how
the next reader re-closes the defect: `docs/api-inventory.md:348` (which also misnames the route —
`/thumbnail` is a query-parameter URL, not `/thumbnail/<computed>`), `docs/frontend-startup-calls.md:56`
("cosmetic"), `docs/frontend-compatibility-measurement.md:745-753` and `:782`, `docs/surface-coverage.md:85`
and `:172`/`:188`, `docs/compat-matrix.md:61`/`:101`/`:153`, `docs/compatibility-matrix.md:351`/`:555`.

### P0-D — 酒馆助手 / JS-Slash-Runner does not work

The extension is pinned at `N0VI028/JS-Slash-Runner@837a6288…` in `AGENTS.md`, but the audit of what it
actually calls through the host page, against what GoTavern provides, is the deliverable that must precede any
fix. It is a browser-architecture probe (iframe execution, exported functions, events, preset mutation,
variables, injections, generation/cancellation), not a load test: `AGENTS.md` rule 47, `ARCHITECTURE.md` §35.4.

### P0-F — a real complex preset cannot be shown to change the model context

Two real presets supplied by the user are now the qualification inputs (read-only, hashed, never committed
verbatim):

| File | Size | Shape |
|---|---|---|
| `[REDACTED_PRESET_A].json` | 99,740 B | 45 top-level keys, 105 `prompts`, `prompt_order` with two `character_id` groups (100000: 11 entries / 10 enabled; 100001: 98 / 56), no `tavern_helper` |
| `[REDACTED_PRESET_B].json` | 1,428,750 B | 47 keys, 119 `prompts`, one order group (100001: 115 / 39 enabled), `extensions.regex_scripts`, and `extensions.tavern_helper` carrying **6 scripts + a variables object, 1.11 MB of subtree** |

And two real character cards, both genuine V2/V3 PNG cards with `chara` **and** `ccv3` chunks:

| File | Size | Embedded card |
|---|---|---|
| `[REDACTED_CARD][REDACTED_CARD].png` | 19,093,535 B | `chara` 9,251,658 B base64 |
| `[REDACTED_CARD_B].png` | 3,069,511 B | `chara` 1,164,314 B |

The second preset is the exact combination the user described — a complex preset that carries 酒馆助手 scripts
and variables — so "preset works" and "helper works" are provably not enough on their own
(`AGENTS.md` rules 48-50, `ARCHITECTURE.md` §35.3).

### Lanes for this pass

| Lane | Area | First deliverable |
|---|---|---|
| A | docs, goal, oracle doctrine, audit | this section + `GOAL.md` + rules 42-53 (done) |
| B | visual asset surface | the mount-set gate, then `/characters/*`, `/User%20Avatars/*`, `/assets/*`, then `/thumbnail` |
| C | 酒馆助手 | pinned-version clone, dependency map, browser-driveable helper scenario |
| D | preset semantic differential | deterministic simulated backend + Preset A/B/C + real-preset capture |
| E | real character / world info / Author's Note / token budget | semantic skeleton fixtures that keep structure |
| F | long-lived tree, startup, extension immutability | copy-boot qualification on the packaged artifact |
| G | performance | only after B-F hold |

### Where this pass stopped, and exactly how to continue (2026-10-25, `main` `4ec767b`, CI green)

**Landed and validated on `main`:**

- the goal and the process contract: `GOAL.md`, `AGENTS.md` rules 42-55, `ARCHITECTURE.md` §35,
  `docs/gate-blindspots.md` (why the gates could not see this), `docs/real-user-input-audit.md` (the real
  artifacts and the helper dependency map, measured);
- three of the seven pinned user-data mounts, which were absent: `/characters/*`, `/User%20Avatars/*`,
  `/assets/*`. Registered as `/User%20Avatars/{rest...}`; **the escaped spelling is mandatory** — `net/http`
  reads a space in a pattern as a method separator (`src/net/http/pattern.go:96`) and panics at registration,
  which is how a merged commit stopped `main` from opening a port for one cycle (`AGENTS.md` 54);
- two gates with demonstrated teeth: `TestPinnedUserDataMountsAreAllServed` (the set) and
  `TestPinnedFrontendAssetContractMountsServeMarkedBytes` (execution: plants a uniquely-marked file per mount
  and requires exactly those bytes back). Mutation evidence in Lane CI `40197036003` — one deleted row failed
  both, on `…ServeMarkedBytes/characters`. Restored green: `40197317477`.

- **`/thumbnail` is served** (`internal/server/thumbnails.go`, ported from the full 312-line pinned file) with a
  source-derived observable contract as its gate. Red before green: Lane CI `40197908880`. Green: Lane CI
  `40199620820`, with the drop-in qualification for the same commit beside it. This route renders the character
  list, every chat avatar, the persona list, the background gallery tiles and the zoomed persona; the served
  MIME is the ORIGINAL filename's extension even when the bytes are jpeg, because pinned serves
  `sendFile(file, {root: thumbnailFolder})`. The bytes are a declared divergence (`ARCHITECTURE.md` 35.2).
- route accounting moved with the work, generated rather than edited: `10` reasoned exclusions, `329`
  reachable (`tools/generate-doc-facts.mjs`). `main` is green at `c82a9a8` on `GoTavern CI` and
  `GoTavern drop-in qualification` alike.

**Two lanes are open right now.**

- `lane/avatar-upload` (`wt-avatar`) — `POST /api/avatars/upload`, i.e. persona-avatar CREATION, which was not
  registered at all. The gate is landed and RED for the right reason: Lane CI `40201211821` fails six
  assertions, every one a 404, while the drop-in qualification for the same commit is green and meaningless
  there (`AGENTS.md` 55 — second time this session the wrong workflow was the one that looked conclusive).
  Pinned branches already read on that lane: `validateFileName` rejects only `/`, NUL and `\`, and does NOT
  reject `..` (only the sanitizer stops that); multer is app-global with field name `avatar`,
  `fieldSize: 500MB` and NO file-size cap; `applyAvatarCropResize` crops only when x/y/w/h are all numbers,
  `want_resize` yields 512x768 and otherwise the crop's own dimensions, then `cover`; `cacheBuster` is off by
  default, so `Clear-Site-Data` is unasserted while the disk-observable thumbnail invalidation is asserted.
- `lane/asset-browser` (`wt-assets-browser`) — the browser asset differential: the same pinned frontend and the
  same fixture on both legs, recording every image request and every `<img>`'s `complete`/`naturalWidth`, the
  computed `background-image`, and failing on any console 404 GoTavern has that pinned does not. This is the
  gate that answers "open the page and look at the pictures", which nothing in this repository could do.

**酒馆助手 (P0-D) measured state, 2026-10-25, lane `lane/helper` @ `b1a1afa` (NOT merged; main reverted
its first slice as `9e60f48` because it carried a red gate).** The architecture half of Q8 is PROVEN and
EQUAL on both subjects: an unsandboxed script iframe, `window.parent.TavernHelper` with 157 members
reachable inside it, the module's own completion marker, and all 25 static `../../../../../` host imports
served with bytes — so "the files load" is no longer the claim. Q11 (a depth-0 injection reaches the
model context) and Q9 (a `generateRaw({ordered_prompts})` request) are MEASURED: the peer received two
requests per subject, the markers arrived in the asked order and roles, and the request bodies were
byte-identical `Node == Go` (`bodySha256`, length, model, stream, messages). Q10 (variable persistence)
is UNPROVEN with its mechanism named: the drive never produced a saved chat, so `variable-persisted`,
`render-path` and `dom-urls` are red on BOTH subjects and are not evidence for either. Q12 is partial:
`generate({preset_name:'in_use'})` produced an equal request, but no preset mutation was exercised.
Two driver defects cost this lane two rounds and are worth remembering: `getContext` is NOT a
`TavernHelper` member (the child iframe's accessor is `window.SillyTavern.getContext()`, installed by
`iframe/predefine.js`), and a just-clicked character has a greeting PREVIEW and no chat, so
`createChatMessages` had nothing to write into.
**The provider-wire differential closes on all 220 scenarios — 2026-10-26.** `GoTavern CI` 40398345829 (`lane/ai21-auth`,
oracle run to completion in 52 minutes, `oracle` step success) logged `differential closed for` 220 times, once per
scenario, including `ai21-empty-placeholder` which had failed every previous full sweep.

It took FOUR declared transport differences to get there, and every one of them is required by
`tests/e2e/deepseek_generate_test.go:449-482`, which asserts the production transport's fingerprint: `accept-encoding`
exactly `gzip`, NO `Connection`, canonical `Content-Type` casing, and — the fourth — names canonicalised by net/http
where node-fetch writes them lowercase. A previous lane tried to "fix" the first of these by making the PRODUCT send
`Connection: close`; that test rejected the change and the lane was deleted.

THREE findings on the way were real defects in the HARNESS, not the product, and each is now committed:
a credential written to the artefact in the clear because the redaction compared `'authorization'` to `Authorization`
(case); a failing capture that never survived the run (written after the assertion, in a mkdtemp the runner deletes,
and never uploaded); and an assertion that reported `saw authorization undefined` for a request that carried the
correct `Bearer` value. The GoTavern header `Authorization: Bearer synthetic-ai21-key` was right from the first run.
**Q22 (a paired, soaked benchmark of both backends) — MEASURED 2026-10-26, and here is exactly what it may be cited for.**
`GoTavern smoke metrics` 40394799325 (boot/RSS/latency) and 40396669521 (the same plus a ten-minute soak on each
subject), job `paired-linux-amd64`, runner image `ubuntu26`. Three alternating rounds plus a bounded soak, both
subjects booted by the same function over their own mkdtemp data root.

| | pinned Node | GoTavern |
|---|---|---|
| boot -> GET /version 200 (median) | 14,355 ms | 61 ms |
| steady RSS (median) | 912 MB | 37 MB |
| GET /version median | 62.7 ms | 0.43 ms |
| soak RSS first -> last | 1,183 MB -> 330 MB | 36.6 MB -> 34.9 MB |
| soak p95 first -> last | 71.8 -> 47.7 ms | 0.81 -> 1.29 ms |
| soak RSS range | 322-1,183 MB | 34.9-36.6 MB |

WHAT THIS MAY BE CITED FOR: on that runner, in that run, with those inputs. NOTHING ELSE. The two runs disagree about
pinned's own boot time by ~60% (8,777 ms in 40394799325 against 14,355 ms in 40396669521), which is the measured
justification for asserting no threshold and comparing only within one run. No multiplier is claimed, no other runner
is implied, and the soak's p95 on GoTavern rose by 0.48 ms across twenty samples, which is reported and NOT
characterised as drift.

The pinned RSS series is the reason the artefact carries a SERIES rather than a delta: its first-to-last difference is
-853 MB, which a delta alone would have rendered as "pinned uses 853 MB less", when the truth is a start-up
high-water mark that V8 then reclaims.

Asserted (structural only): everyRoundAnswered, sampleCountsMatch, soakCompleted, soakSeriesMatch.
**Q20 (save -> a FRESH page load reading it back -> a second turn -> a swipe, all equal to pinned) — PROVEN 2026-10-26.**
`Browser differential` 40387864205 (`lane/q20-persistence`), steps `Record the Q20 legs (save -> reload -> swipe, on
both subjects)` success and `Compare the Q20 legs` success, verdict `match`, SEVEN of seven guards true:
`legsPresent, legsDrove, saveWroteTheChat, reloadReadsTheChat, nodeEqualsGoAfterReload, goSwipeDiffersFromGoTurn,
nodeEqualsGoAfterSwipe`.

The comparison is byte-exact on both requests, and the pairs differ from each other, so the swipe is not a repeat:
second turn `794bfa4552f8` (4191 B) on BOTH subjects; swipe `9ab9e8c13421` (4192 B) on BOTH subjects.

What made this hard, recorded because each one was a wrong hypothesis measured and discarded before the real one:
a swallowed listener throw, a listener held open, an unreached `processCommands` (`processCommands=[]` means "no slash
command", NOT "never reached"), `pingServer` blocking, `settingsReady` (it was true, 2 ms), and the two silent early
returns at script.js:4323/:4329. The actual cause was an INPUT: `main_api` was `koboldhorde` (the fresh-install
default) because setting `chat_completion_source` does not move the API switch, so `Generate` took the Horde branch and
appended nothing -- on both subjects. `changeMainAPI('openai')` (script.js:7756) fixed it, and `message_sent` /
`message_received` / `user_message_rendered` fired for the first time.

Two follow-on lessons, both now in the code's comments: the switch is PER PAGE (a reload resets it, which is why the
second turn needed it again), and a guard must assert the fact rather than a convenient proxy -- "the last message is
the user's" is false the moment the reply lands, so the second-turn guard now finds the user turn by index.
**Q12 (a helper MUTATING the in-use preset changes the next model context, identically) — PROVEN 2026-10-25.**
`Browser differential` 40277640647, preset mode, four legs, TEN guards all true: legsPresent, legsDrove,
structureMatchesTheOracle, presetAEqualsAcrossLegs, presetBEqualsAcrossLegs, goATavernDiffersFromGoB,
bUnreferencedPromptsAbsentOnBothLegs, aEnabledRowPointingAtDisabledPromptContributes (aSharedMarkers: 25) and
presetMutationChangeRequest, with harnessDiscriminates true.

The mechanism, read from the pinned extension rather than guessed: `setPreset(preset_name, PartialDeep<Preset>,
{render})` (src/function/preset.ts:731-748) deep-merges into the LIVE preset via updatePresetWith -> replacePreset
-> updateOriginalPresetData. The leg generates, calls setPreset('in_use', {prompts:[...]}, {render:'immediate'}),
generates again, and the comparator requires: both subjects produce TWO context requests; GoTavern's two DIFFER
(a backend that ignored the mutation fails); pinned's two differ too (or the leg cannot discriminate); and the
AFTER requests are equal across subjects. Measured pairs, identical on both backends:
preset A 0716543c (201 B) -> 5bf90078 (201 B), preset B 61276bf1 (199 B) -> 4ee6b389 (199 B).

Two of the reds on the way were mine and are worth remembering: the guard that A's provisional text contributes
was scoped PER REQUEST while a leg now sends two, and the first is a minimal single-turn assembly with no marker
(run 40276309696); and `contextRequest` silently took `.at(-1)`, which would have compared only the second request
and lost the half that proves the mutation did anything.
**Q6/Q8 (a real user preset changes the model context, identically on both backends) — PROVEN 2026-10-25.**
`Browser differential` 40274214952, preset mode: four legs (preset A and preset B, GoTavern and pinned Node) each
ran page-loaded -> settings-ready -> real-preset-loaded -> real-preset-structure -> connection-configured ->
character-open -> generation-completed -> peer-reached, and the comparator's nine guards were ALL true:
legsPresent, legsDrove, structureMatchesTheOracle, presetAEqualsAcrossLegs, presetBEqualsAcrossLegs,
goATavernDiffersFromGoB, bUnreferencedPromptsAbsentOnBothLegs, aEnabledRowPointingAtDisabledPromptContributes,
harnessDiscriminates, with `aSharedMarkers: 25`.

What that means precisely: for the user's own 105-prompt and 119-prompt presets, the request that reached the
model backend is byte-identical (bodySha256, length, message array) between GoTavern and pinned, AND the two
presets produce DIFFERENT requests from the same implementation -- rule 48's two halves at once.

Two things had to be right before this green meant anything, and both were my own defects:
- the request must be assembled BY THE PRESET. `generateRaw({ordered_prompts})` takes its own explicit list, so
  run 40272833510 produced equal requests that carried no fixture marker at all. The leg now calls
  `generate({preset_name: 'in_use'})`, the frontend's own assembly.
- a synthetic click on `#send_but` is not a user path in this harness: run 40269030050 recorded
  `messages 2 -> 0`, `textarea "" -> "REAL_PRESET_PROBE_INPUT"`, i.e. the frontend switched session instead of
  sending. The capture goes through the extension's own generation entry.

Declared in the artefact and NOT covered: preset B's helper scripts are stubs and are not executed; a helper
MUTATION changing the next request (Q12); streaming (Q19); reload/swipe/regenerate/continue (Q20); a real provider
(rule 22).

The fixtures themselves are `tests/browser/fixtures/real/{preset-a,preset-b}.json`, desensitised to byte-exact
length with every NAME field replaced by a marker and two six-byte names declared verbatim in the manifest, gated
in CI by tools/check-fixture-watermarks.mjs. The character card is still NOT committed.
**Q10 (酒馆助手 variable persistence) — PROVEN on both subjects, 2026-10-25.** The helper script's chat
variable reaches the chat file on disk on GoTavern AND on pinned Node, with the negative control still
biting (a helper-off leg must NOT persist it). Evidence: `Browser differential` 40250495167 on
`lane/helper-q10` @ a3c1d43 -- every helper step success, and `variablePersisted` has DISAPPEARED from the
artefact's `declared unproven` list, which is the verifier's own rule for a guard that is true on both
subjects (a guard that is false on both must be declared; it is not). The remaining declared gaps in that
artefact are `renderPathProduced` and `domUrlsServed`, and the Q19/Q20 surface.

Getting there took three measured steps, and the three are the durable lesson:
1. `saveChat()` returns before any request when `chatName ?? characters[this_chid]?.chat` is undefined
   (`public/script.js:7407-7417`), so a clicked card on a tree with no chat cannot save at all.
2. A guard of the form "does the chat file exist" is VACUOUS in a long-lived fixture that already contains
   one: `waitForFile()` answered true before any save, which silently disabled the only route that makes
   the frontend create a chat identity. The gate had to become the subject's own state
   (`chatId`/`characterChatName`), not the filesystem.
3. Handing `replaceScriptTrees` the SAME tree list is a no-op the extension detects, so the script is not
   re-instantiated and a variable written before the chat existed stays lost. A re-run must CLEAR first,
   then reinstall, so the write lands in the phase where `chat_metadata` exists.
`lane/preset-real` (`wt-preset`) has committed nothing yet: the real preset/card fixture, where the
packed-blob measurement for the 19 MB card is still the first thing to decide.

**Q20 (save / reload / swipe preserve equality) — PARTIAL, and the blocker is not persistence.** Measured on
`lane/q20-persistence`, `Browser differential` 40317952033 and its four predecessors, on BOTH subjects with identical
verdicts every time (rule 10), so none of what follows is a backend difference:

- The product SAVES: `POST /api/chats/save` 200 and a real file under the right character
  (`chats/default_Seraphina/Seraphina - <date>.jsonl`). The save is judged by the file and the recorded request,
  never by a resolved promise.
- The file contains `[header, greeting]` and NO user turn, so the marker the leg typed never reached the chat.
  That is not a save defect: `Generate('normal')` started and stopped before it could append the turn.
- The stopping point is now a measurement rather than a reading. The leg subscribes to the product's own event bus
  for the send window and records `app_initialized, app_ready, generation_started, GENERATION_AFTER_COMMANDS,
  settings_updated` and nothing else — no `chat_created`, no `message_sent`, no `message_received`. And
  `processCommands=[]`, which is the decisive one: `Generate`'s ONLY exit that appends nothing and requests nothing
  runs at `script.js:4310-4318`, AFTER `await eventSource.emit(GENERATION_STARTED, ...)` at `:4299`. An empty record
  there means `Generate` never reached `:4310`, i.e. it is stopped inside that awaited emission.
- Four earlier drives were driver defects, each fixed and each re-measured: `saveMetadata()`/`saveChatConditional()` issue
  no request without a chat identity (`script.js:7407-7417`); a fresh install renders `.character_select#CharID0`,
  not `.avatar[data-type="character"]`, so the send went to the permanent ASSISTANT chat (`:1760`); script.js has no
  `powerUserSettings` export (`power_user` lives in `scripts/power-user.js`); and the page RELOADED mid-turn, 34 s
  after the send, which `navigations` now records and `drive-stayed-on-one-page` refuses to read through — it is
  gone (`navigationsTotal: 1`), and `Network.loadingFailed` names its likely producer as this harness's own blocked
  CDN script plus its dependent fetch.
- What is NOT yet proven and must not be claimed: `saveWroteTheChat`, `reloadReadsTheChat`,
  `nodeEqualsGoAfterReload`, `goSwipeDiffersFromGoTurn`, `nodeEqualsGoAfterSwipe` are all red, because the second
  turn needs a first turn. Swipe and reload machinery (the frontend's own `swipe()` with
  `SWIPE_SOURCE.SWIPE_PICKER`, `saveChatConditional()` for its save) is written and has never executed.

The next step is the one the record points at: find which `GENERATION_STARTED` listener holds or throws on this
page. `EventEmitter.emit` awaits listeners in order and CATCHES a throw (`public/lib/eventemitter.js:145-151`), so a
throwing first listener both hides its cause and lets `Generate` resolve as though it had run. The instrument that
fits is the one that produced `processCommands`: wrap `eventSource.emit` for the send window and record which
listener index never returned. No product code under `internal/**` is implicated by any of this.

**Next actions, in order:**

1. Finish `lane/avatar-upload` (implementation, mutation, matrix row) and `lane/asset-browser` (probe, CI
   wiring, mutation). Merge each only when its OWN Lane CI is green, and quote the workflow name with the run id.
2. Then the smaller follow-ups the audit named: the returned-URL assertion (`/api/sprites/get` and
   `/api/assets/*` hand out URLs this server must answer — the general form of the bug this pass fixes), and the
   documentation that still calls the thumbnail 404 "cosmetic" (`docs/frontend-startup-calls.md`;
   `docs/surface-coverage.md` is GENERATED from the startup-comparison artefact, so its number moves when that
   artefact is re-recorded against a server that now answers 200, not by editing the markdown).
3. Then Lane C (酒馆助手) per `docs/real-user-input-audit.md` §6-§7: the first browser scenario is a render
   script whose pass condition includes every URL the iframe puts into the DOM answering 200.
4. Then Lane D (real preset fixture), which is started but has committed nothing: `wt-preset` on
   `lane/preset-real`, with the fixture design and the packed-blob measurement for the 19 MB card decided next.
5. Scheduled, not started: `POST /api/extensions/version` issues **two** `git fetch` calls per request
   (`extensions_git.go:362` and `:204`) on a route the pinned frontend calls at page load whenever the user's
   persisted `extension_settings.notifyUpdates` is true — a network mutation of the user's extension repository
   with no GoTavern opt-in, where pinned fetches once.

**Standing rule for whoever picks this up:** quote `workflow name + run id + conclusion` together
(`AGENTS.md` 55 — this pass lost a turn to reading the drop-in workflow's green as a test verdict), and never
merge a lane whose own Lane CI is red.




Recorded at `main` `10314c8`. These outrank every other line in this file: a release that cannot talk to a
provider, cannot boot in a stock directory, and updates extensions unasked is not a replacement product, whatever
the differential suite says. The engineering contract is `AGENTS.md` rules 21-40 and `ARCHITECTURE.md` §34; the
measurements are `docs/network-egress.md` and `docs/startup-state-machine.md`.

### P0-A — a real provider cannot be reached

**Reported:** repeated "cannot connect to the DeepSeek server" with a real DeepSeek key.
**Confirmed in source, not guessed:**

- `internal/outbound/raw.go` is a hand-written HTTP/1.1 client. Chat completions calls it with `timeout 0`
  (`internal/server/chat_completions.go:263`), so `SetDeadline` is never reached (`raw.go:166`) and a stalled
  provider holds the request forever.
- Every planner sends `accept-encoding: gzip, deflate, br` (`chat_completions.go:670` and about ten siblings) and
  `raw.go` decompresses nothing — a responding CDN hands it compressed bytes and the JSON parse fails.
- No `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` support anywhere in `internal/**`; no redirect handling; no
  keep-alive; one goroutine per request waits on `ctx.Done()` indefinitely.
**Not yet proven:** which of these fires first for this user. All four are reproducible against a local HTTPS
mock; that reproducer is the first deliverable, not the fix.
**Unproven assumption to state plainly:** the oracle only ever recorded plain-HTTP, complete, uncompressed,
non-redirecting, non-proxied replies. Every one of those properties is now a required test.

**What now has a gate, and what it still cannot reach (added after the transport merge).** Two gates carry this
P0's evidence; the details are `docs/network-egress.md` §4.

- `go test ./tests/e2e` boots the REAL binary as a subprocess (the `internal/server` test binary pins the
  wire-exact client process-wide, so nothing in that package can observe user traffic), stores the key through
  `POST /api/secrets/write`, drives `POST /api/backends/chat-completions/generate`, and asserts at the peer that
  the captured provider body arrived byte-identically **and** that the request carried the production client's
  fingerprint (`accept-encoding: gzip`, no `Connection`, canonical header casing). Four legs: non-stream content,
  stream ending in `data: [DONE]`, provider error answering as a provider error, and an unreachable provider
  answering as a transport failure.
- `scripts/deepseek-canary.mjs`, run by the lane workflow, is the ONLY gate that touches the real provider. It
  skips with one named line when `DEEPSEEK_API_KEY` is absent, so a reader can always distinguish a pass from a
  non-run.
- **Its limits, which a reader of a green lane must apply:** it exercises one source, one model and one
  non-streamed completion; it cannot say WHICH stage failed when the request never arrives, because DEEPSEEK's
  pinned catch (`response.send({error:true})`, chat-completions.js:1168-1174) discards the cause — so AGENTS.md
  rule 35 is materially unmet on this route, and fixing it means a recorded, named divergence from pinned's body
  rather than a quiet improvement; it proves nothing about streaming, cancellation, presets or tokenization; it
  has no pinned subject, so it is not a parity claim; and it says nothing at all on runs without the credential.

### P0-B — stock-directory startup hangs

**Reported:** copying the release binary into a working `node server.js` tree and running it hangs in
initialisation.
**Confirmed in source:** the boot path takes **eight** `flock.Lock()` call sites with no bound
(`configinit/config.go:169`, `startup/secret.go:85`, `startup/storage.go:440`, `startup/content.go:383`,
`startup/user_data_lock.go:12`, `startup/settings_backup.go:131`, `startup/secrets_state.go`,
`startup/user_presets.go:96`, `startup/statistics.go:87`) and one unbounded `net.LookupIP`
(`app/server.go:161`). `cmd/gotavern/main.go` prints **nothing** until `app.Start` returns, so a hang anywhere
looks identical to the user.
**Not yet proven:** which lock the user hit. The reproducer is two processes on one tree plus a stale lock file,
each with a 30 s bound that dumps goroutines and the stage trace.

### P0-C — extensions/plugins updated without being asked

**Reported:** automatic extension/plugin updates the user never requested.
**Confirmed in source:** boot runs no git — but it does the equivalent damage through defaults.
`internal/commandline/options.go:250` resolves `extensions.autoUpdate` with a default of **true**, and
`internal/server/settings_get.go:70` reports it to the frontend with `optionBooleanDefault(..., true)`; the pinned
defaults it merges in carry `autoUpdate: true` (`upstream/default/config.yaml:301`) and
`enableServerPluginsAutoUpdate: true` (`:396`). Worse, `configinit.Initialize` rewrites any config missing a
defaulted key (`internal/configinit/config.go:123,136`), so a stock tree can have `autoUpdate: true` **written
into it on first boot**.
**Not yet proven:** whether this user's tree was rewritten or merely reported as `true` to the frontend. Both
paths are closed by the same contract: ambiguity resolves to OFF, and boot does not rewrite a parseable config.

### Lane ownership from here

| Lane | Area | First deliverable |
|---|---|---|
| A | `internal/outbound`, providers, streaming | HTTPS/proxy/compression/timeout reproducer, then the production transport |
| B | `internal/app`, `internal/startup`, `internal/configinit`, `internal/commandline` | bounded locks + staged diagnostics + read-only boot reproducer |
| C | extensions/plugins update lifecycle | zero-egress/zero-mutation boot test; OFF-by-default resolution |
| D | pinned upstream inventory, differential, browser E2E | stock-tree + whole-session differential harness |
| E | packaging/release | stock-directory drop-in test of the **unpacked artifact** |
| F | adversarial QA (no production code) | break A-E: stale lock, dirty repo, bad YAML, proxy, TLS, port conflict |

Nothing in this section may be closed by a green unit test. Each closes with the reproducer failing before and
passing after, in GitHub Actions, on the packaged artifact where the gate is a release gate.

## 0. Working mode, and what changed in this checkpoint (2026-10-24)

**The host does not build, test, probe or drive a browser.** Every one of those runs in GitHub Actions;
locally there is editing, `git`, and `node --check` on a file you just wrote. `AGENTS.md` has the full
rule and `docs/development-loop.md` has the loop. There are no pull requests: one lane branch per task,
pushed once, merged into `main` by the lead, branch deleted. That is a reaction to a real failure -- five
concurrent lanes meant five PRs and five duplicate multi-hour oracle sweeps, and the branch namespace had
grown to eighty lanes. Nothing was lost: the deleted history is archived in
`../gotavern-branches-archive-2026-10-24.bundle`.

What has landed since the previous checkpoint (latest first; every count below is from the generated
facts or a named fixture):

0. **`v0.1.0-alpha.2` is published** (annotated tag at `d3198b8`, release run `40149842943`, docker
   `40149842928`, qualification `40149842917`, install smoke `40150649597`). Six canonical archives plus
   `checksums.txt`, all six listed in the checksums, `releases/latest` still 404 for a prerelease, and the
   published `gotavern-linux-amd64.tar.gz` downloaded and SHA-256-matched against the published checksums
   (`2b96d087…`). Its `BUILD-INFO.txt` names the release and the pinned baseline. The tree also gained, in
   the pre-release audit: every recorded provider request compared and its COUNT asserted (the
   `azure-openai-status-ok` capture records a models GET and a 95-byte chat POST, and only the first was ever
   compared), a `timeout-minutes` on all ten jobs in the five workflows (the rule in AGENTS.md was not true
   of three of them), one BOM removed, four CP1252-round-tripped comments repaired, and eleven documentation
   claims corrected — see item 7 for the one measured limit that is still open.

1. **Provider-wire breadth is now <!-- BEGIN GENERATED: provider-wire.scenarios -->`219`<!-- END GENERATED: provider-wire.scenarios --> recorded scenarios** (was 205 before the final sweep). The fixture is `tests/oracle/sillytavern-1.19.0-provider-wire.json`; `TestChatCompletionGenerateMatchesProviderWireCapture` replays every scenario input.
2. **The status fall-through is CLOSED.** AI21, VERTEXAI and PERPLEXITY now answer the pinned closing-else `400 {"error":true}` with ZERO outbound, not 501. The six new observations are `status.{ai21,vertexai,perplexity}.{noBranch,reverseProxy}` in `tests/oracle/sillytavern-1.19.0-backends.json`, which moved from 110 to 116 observations. The route is `internal/server/backends_status.go` (the no-arm set and the shared refusal at `:75-84`).
3. **The route-wide request gaps are recorded.** `custom_prompt_post_processing` is observed by `openai-custom-prompt-post-processing`; the OPENAI reasoning-effort/verbosity tables by `openai-reasoning-effort-{fixed,map,outside-table}`; OpenRouter audio embedding by `openrouter-media-audio-embed` and `-passthrough`; OpenRouter reasoning signatures by `openrouter-reasoning-signatures*`. The Go side is `chat_completions.go:176-219` (post-processing) and `:423-534` (tables), plus `openrouter_media.go`.
4. **ZAI has two per-literal seams.** `GOTAVERN_ZAI_CHAT_URL` targets the common literal and `GOTAVERN_ZAI_CODING_CHAT_URL` the coding literal (`internal/server/zai_chat.go:51-90`); `zai-coding-endpoint` records the path split. A single seam had made the two modes byte-identical.
5. **The replay honours a scenario's `backendConfig`.** `internal/server/chat_completions_oracle_test.go:302-303` writes the scenario config before each leg, and `tools/probe-provider-wire.mjs:211` does the same for the pinned leg. Before this, every config-driven scenario replayed on defaults, so the flag-off reasoning-signature case could not pass for the right reason.
6. **Browser evidence is green and computed.** `tools/verify-browser-comparisons.mjs` reports 0 findings across 30 catalogued source artefacts; the generated matrix in `docs/surface-coverage.md` says 14 of 26 sources have E/streaming/cancellation, 11 have no browser drive and 1 is stale (`workers_ai`, not re-recordable today). The pinned-derived and product source lists are 25 and 25 with no mismatch (`docs/generated/coverage-matrix.json`).
7. **The complex-preset differential is MEASURED.** `tests/browser/fixtures/preset-complex-settings.json` and `tests/browser/preset-complex-comparison.json` (run `40096436669`) record `keepContext` 4260 / `dropContext` 4259, `measuredBy: 'pinned-leg'`, 24 vs 26 total messages, 12 vs 11 history turns, `providerRequestEqual: true`, empty `bodyDifferences` on both variants, verdict `match`. The measured contract does NOT assert instruct/context templates (they are set to ChatML, but the capture notes a chat-completion request must be identical with different templates), secondary WI keys, recursion/probability/outlets, or group chats; the token-budget suite's other boundaries remain unmeasured.
8. **Placeholders, Claude cache and Mistral prefix are recorded; multimodal is recorded.** All four empty-message converters (`ai21`, `claude`, `cohere`, `deepseek`) carry `[Start a new chat]`, because pinned merges `default/config.yaml:324` into the runtime config at startup, not the module's `Let's get started.` fallback. Claude's `promptPlaceholder`, `enableSystemPromptCache`, `cachingAtDepth`, `extendedTTL` and Mistral's `enablePrefix` have fixtures (`claude-*`, `mistral-prefix-*`). Makersuite inline image, video-with-mediaResolution and audio-without-it are recorded by `makersuite-inline-{image,video-resolution,audio}`; every payload is a data URL because a remote media URL is silently dropped by the pinned converter.

Earlier in this checkpoint: `v0.1.0-alpha.1` was released (run `40066449948`), the oracle execution core and planner landed, documentation counts moved to generated blocks, and the chat-completion dispatch moved to one registry row per source. The provider-wire fixture is 219 captured scenarios against 219 declared inputs. **Still open:** the preset features named above, the OpenRouter prompt-cache transform and the gemini `/models` cache probe, and cohere's BROWSER leg is catalogued but never recorded (its ten `cohere-*` provider-wire scenarios ARE recorded, with captures, in `tests/oracle/sillytavern-1.19.0-provider-wire.json`; what is missing is `generation-cohere-comparison.json`/`streaming-cohere-comparison.json`, which `tests/browser/sources.mjs` records by setting both `evidence` fields to `null`).


## 1. Where the project stands

**Route accounting is CLOSED.** <!-- BEGIN GENERATED: routes.accounting -->`339` inventoried routes; `0` bare `not implemented`; `10` reasoned exclusions; `329` reachable.<!-- END GENERATED: routes.accounting --> That is a statement about ROUTES. It is not a release-ready claim: almost every area is still `partial` because the
E (browser events/final state) and C (cancel/streaming) surfaces are measured for few of them, and
because the release path itself has only just begun to be EXECUTED.

The reasoned exclusions, unchanged in kind: five local in-process ML (`/api/extra/{caption,classify,
classify/labels}`, `/api/speech/{recognize,synthesize}`), two Jimp re-encoding (`/api/avatars/upload`,
`/thumbnail/<computed>`), three package-owned protocols (`/api/translate/{google,bing}`,
`/api/google/generate-voice`), and `/api/search/visit` (needs the shared private-address transport
policy; `search_test.go` asserts it stays 404).

`docs/api-inventory.md` is GENERATED (header) but its **status column is hand-maintained**: the generator
reads existing statuses and keeps them. Only the header is generator-owned; a hand-written header
paragraph is silently overwritten and fails the zero-diff gate.

## 2. What the observer surfaces actually have

- **Promotions**: chat-completions generation for the custom/OpenAI-compatible source is `compatible`
  (all five surfaces; its artifact was re-recorded after the `dryAfterData` red was traced to a
  RECORDING WINDOW rather than to the product -- see section 5). **Backgrounds** and **Quick replies**
  are promoted once each browser drive ASSERTED its own gate (the Backgrounds panel that binds the
  upload handler, and `globalThis.quickReplyApi`). Chutes and Electron Hub are `compatible` for the
  flows their own rows measure. A drive that cannot reach its gate reports which precondition is
  missing instead of looking like a product gap.
- **<!-- BEGIN GENERATED: browser.sources -->`15`<!-- END GENERATED: browser.sources --> chat-completions source pairs have committed E/streaming artefacts**: the custom pair plus
  OPENROUTER, CLAUDE, MISTRALAI, GROQ, SILICONFLOW, NANOGPT, WORKERS_AI, DEEPSEEK (`POST
  /beta/chat/completions` asserted on both legs), OPENAI, CHUTES, ELECTRONHUB, AIMLAPI, AI21 and XAI --
  `tests/browser/{generation,streaming}-<source>-comparison.json`. Not all are current: the computed
  matrix in `docs/surface-coverage.md` is authoritative for which rows are current, stale pending the
  browser re-record, or have no browser drive. Cancellation is proved at the provider by
  `clientDisconnected` on both legs in each current streaming artefact; stale artefacts are listed in
  the matrix rather than counted as coverage.
- **E, both canaries**: `tests/browser/extension-littlewhitebox-comparison.json` is committed and gated
  too -- 452 rows all equal, same single non-row difference (`/thumbnail`). It was WITHHELD for one
  round on purpose: its one real difference was `/user/files/LittleWhiteBox_User.json` answering 404
  because `/user/files/*` and `/user/images/*` DID NOT EXIST. Those routes were implemented (pinned
  `users.js:1217-1218`) and the pair re-recorded, which is the rule in action: a defect gets a fix, not a
  `knownReason`. `writtenUserFiles` records what each extension WROTE; LittleWhiteBox's 626-byte JSON is
  compared by size and JSON skeleton and its digest is classified `shape` with the measured reason (a
  per-run `tx-<uuid>`), and Tavern Helper writes none -- stated, rather than passing vacuously over an
  empty list.
- **The rollback direction, newly measured**: `tests/oracle/sillytavern-1.19.0-runtime-roundtrip.json`.
  Pinned boots over a GoTavern-written tree and changes NOTHING (0 added / 0 changed / 0 removed) and
  READS it back (characters, both chat messages, the world entry verbatim). A second boot of either
  subject changes nothing. Exactly ONE comparison exclusion is recorded: `comparisonExclusions` has the
  single key `data/_webpack/**`, because only pinned Node writes that cache, so the PATH SET legitimately
  differs between subjects. The seeded card is not an exclusion at all -- it is a `normalization` entry
  for `data/<handle>/characters/*.png`, whose reason is that the import route rewrites the stored card
  with a generated `chat` name and an ISO `create_date`: the SIZE is recorded, the BYTES are not, and the
  card content is compared by reading it back through pinned.

## 3. Release path: what is now executed, and what still is not

**CUTTING THE FIRST TAG, and what a prerelease does.** `scripts/classify-version-tag.sh` decides a tag's channel
and both release workflows obey it: only a tag that is exactly `v<major>.<minor>.<patch>` is STABLE; anything else
version-shaped (`-alpha.1`, `-beta.2`, `-rc.1`, `+build`) is a PRERELEASE; a name that is not a version tag is
refused rather than guessed. For `v0.1.0-alpha.1` that means `docker.yml` publishes
`ghcr.io/cocokoishi/gotavern:v0.1.0-alpha.1` and leaves `:latest` untouched, and `release.yml` creates the GitHub
Release with `--prerelease --latest=false`, so `releases/latest/download/...` -- the URL both installers fetch --
is never moved onto an alpha. NO STABLE RELEASE EXISTS YET for it to point at: `docs/generated/facts.json`
(`scm.versionTags`) lists exactly one tag, `v0.1.0-alpha.1`, and that tag classifies as a prerelease, so the claim
this repository can actually make is the negative one -- a prerelease is never served as `latest` -- and that is
the assertion `release-install-smoke.yml` makes on the bytes of `releases/latest/download/checksums.txt`.
The rule is covered by `scripts/test-classify-version-tag.sh` in the `verify` job (commit `84648b2`,
run 40056851570 step 6), and the docker decision was exercised in a real runner: dispatch run 40057381696
printed `channel: dispatch` and `it will NOT move ...:latest`. THE PRERELEASE BRANCH HAS RUN SINCE, which this
paragraph used to deny: the tag
push that published `v0.1.0-alpha.1` (release run 40066449948) is a `v*` tag push, which is what `docker.yml`'s
`tags: ['v*']` trigger matches, so the branch is reached by a real tag and no longer waits for a first tag to
confirm it; that tag was cut at `2dde1fa`, which contains the classifier (`84648b2`). What is STILL UNMEASURED is
the ASSERTION rather than the branch: nothing in `release.yml` or `docker.yml` re-reads `releases/latest` or
`:latest` after publishing, and the only byte-level check of `releases/latest` lives in
`release-install-smoke.yml`, which is `schedule` + `workflow_dispatch` only and is therefore NOT tag-triggered --
its runs 40072321355 and 40072470162 are weekly/dispatch runs, not the release run -- and this host has no network,
so the registry's own `:latest` tag cannot be inspected offline.

`.github/workflows/release-qualification.yml` (tag or dispatch) builds TWO archives from the same source
with different version strings, asserts their contents and modes, runs `assets verify` FROM THE EXTRACTED
ARCHIVE, boots it, proves idempotence, extracts archive B over the install directory, then archive A back
again, requiring a user file and `config.yaml` to survive and the server to answer each time.

`scripts/qualify-install.sh` then runs the INSTALLER real users run against the same two archives over a
loopback mirror, asserting: the mirror SERVED the requests (an ignored seam shows as a missing request),
a tampered archive ABORTS and installs nothing, `assets verify` passes from the installed prefix BEFORE
AND AFTER an upgrade, and a re-install and a rollback both preserve a user file and `config.yaml` byte
for byte, and the launcher the installer WRITES starts a server.

**The finding that justified it**: `install.sh`/`install.ps1` never installed `tokenizers/`, so the
documented PRIMARY install path produced a prefix whose own `assets verify` FAILS and whose tokenizer
routes count every prompt ~25% high while still answering. Fixed (staged-and-swapped immutable
directory, and an archive without it is refused).

**MEASURED (2026-10-23)**: `install.ps1` IS executed now, and by two different mechanisms. The
`qualify-windows-amd64` job runs it ON WINDOWS -- step "Qualify install.ps1 ON WINDOWS (running exe,
separators, registry, cmd.exe)", which is the four behaviours no other runner can reach -- and the
`qualify-linux-amd64` job runs it under `pwsh` against a loopback mirror with the same assertion set
`install.sh` is held to. Both jobs are green in run 39907640873, and the gate has teeth: the mutation run
39908014487 fails it.

**NOT COVERED (each with its reason rather than a to-do)**: an existing SillyTavern install migrated IN
PLACE (the cross-baseline job below updates an older GoTavern release, not a SillyTavern tree), and
replacing a binary under a RUNNING server on Linux. `gotavern migrate` EXISTS
(`cmd/gotavern/main.go:103`, `internal/migrate/migrate_test.go:174-611`); it copies to `--dest`, which is
not an in-place migration.

**COVERED SINCE, and it used to be on that list**: proxy/TLS against the real github.com download path.
`release-install-smoke.yml` (weekly + dispatch) resolves the TAG-addressed release URL over TLS, runs
`install.sh --dir … --version <tag>` against it, requires the checksum parse to succeed, boots the
installed prefix, and requires the tokenizer ROUTES to return real ids -- plus a byte-level assertion that
`releases/latest/download/checksums.txt` never serves a prerelease. Runs 40072321355 and 40072470162
(green, 21-26 s). What it still does not reach: the PUBLISHED WINDOWS installer, which is opened and
content-asserted but never executed, because that job runs on Linux.

## 4. The working model (this is what makes the CI budget survivable)

The development host cannot carry the build load and its Go cache once filled a 149 GB disk.

- **Per-lane worktrees and per-lane Actions.** Each lane works in `wt-<name>` on branch `lane/<name>` and
  verifies in `.github/workflows/lane.yml` (`gofmt`, `go build ./...`, `go vet ./...`, `go test ./...`
  with a proof that tests EXECUTED). The Lead merges green lanes and pushes main ONCE per batch, because
  a main push that touches fixtures triggers the oracle.
- **No local Go builds.** Lanes download a CI-built binary (`gotavern-lane-binaries`, linux + windows)
  and pass `GOTAVERN_BINARY`. The oracle job builds its own linux binary.
- **Pinned boots are serialised** by `tools/pinned-boot-lock.mjs run -- <cmd>`; the lock lives in the git
  COMMON directory so it works across worktrees. Without it, concurrent boots run concurrent pruned
  webpack compiles and every other lane dies on a 180 s readiness deadline.
- **The oracle is narrowed**: `GOTAVERN_ORACLE_PROBES` re-records only the probes a push can affect
  (full set on schedule/dispatch and for `tools/lib/**`, `tools/oracle/**`, the generator,
  `upstream/**`, `tests/provider-wire/scenarios/**`). Narrower IS weaker, and the earlier text here
  said the opposite ("the zero-diff check still covers every fixture"): that gate diffs the working
  tree against the commit, so a probe that never ran leaves its fixture byte-identical by
  construction and its movement invisible. A skipped probe is unverified. Do not read a narrowed
  green as covering the oracle; the scheduled or dispatched full sweep is the only one that does.
- Docker runs on its own workflow (Dockerfile/installer paths, weekly, or dispatch), not per push.

## 5. Rules learned the expensive way this session

These are now also in `AGENTS.md`; the instances below are what they cost.

- **A fixed sleep is not a state.** `dryAfterData` gotavern=1 / pinned=2 sat inside a `compatible` row as
  an unexplained red. The cause was the probe attaching its recorder a few statements before the send
  click, so on the slower leg the tail of the prompt-manager dry generation landed inside the window.
  Proof it was a window: the pinned record held a dry `GENERATE_AFTER_DATA` with NO dry
  `GENERATION_STARTED` (impossible per `script.js:4299/5318/5320`), both legs' own logs recorded the same
  invocation count, and the asymmetry moved to whichever leg was slower across four pairs. The drive now
  waits for QUIESCENCE before the send and closes the window at `GENERATION_ENDED`; the compare script
  exits 1 on a false window guard AND the committed-artifact gate checks those guards, because otherwise a
  false guard could be committed with CI green.
- **A gate that is not read is decoration.** `verify-browser-comparisons.mjs` did not read the extension
  artifact until this session. Its first generic version would also have described a real 404-vs-200 as
  "an asset fetched by only one page load"; a status difference where BOTH drives issued the request is
  now `SERVER RESPONSE DIFFERENCE, not decided`, and a reason naming no mechanism is rejected. Proved by
  swapping the LittleWhiteBox comparison into the artifact slot and getting exit 1 with the path named.
- **A red run must be able to name its failing test.** `lane.yml` piped `go test -v` through
  `tee ... >/dev/null` under `set -e`; a failing test aborted at the pipe and printed nothing. Two lanes
  reported it. The status is now captured first and the tail always printed.
- **A shared `%TEMP%` filename is shared mutable state.** One lane's commit message landed on another
  lane's commit through `%TEMP%\lane-commit-msg.txt`; use a lane-unique path.
- **A lib change is a global claim.** `holdOpen` in `tools/lib/pinned-outbound.mjs` was held until its
  author proved the fixture double-recorded byte-identically AND an untouched probe (`probe-nanogpt`)
  re-recorded unchanged with the change in place.
- **Stale negatives are the most expensive doc error.** This session corrected: "extension static serving
  is unimplemented" (its row compared 43 responses), "the data-domain comparison is not gated" (the block
  was added in the same commit as the artifact), "none of the 19 SD generate routes is registered" (all
  were), `INSTALLATION.md` promising `gotavern migrate`, and a malformed matrix row.
- **Disk is a shared resource.** At 0.32 GB free, `go build` failed with a `link.exe` truncate error and a
  pinned boot failed readiness, which reads as a code defect. `go clean -cache` plus stale `%TEMP%`
  sweeps freed 31.5 GB; check free space BEFORE diagnosing a readiness failure.
- **Measure like-for-like.** One lane reported "9,454 ms vs 25 ms" for `/api/backgrounds/all`; it was
  cold-vs-warm. The real numbers were 8,769 vs 4,077 cold. The defect was still real (over the
  frontend's ~5 s window) and the fix (no per-pixel heap allocation) makes it 3,422 ms. Reporting the
  correction rather than the convenient figure is what made the fix trustworthy.

## 6. Next actions, in the order the evidence supports

1. **C for OPENROUTER is measured, not pending.** `tests/browser/streaming-openrouter-comparison.json`
   records `compatibleReady: true` and `clientDisconnected: true` on BOTH legs, with a matching non-stream
   control; `tools/verify-browser-comparisons.mjs` reads it. The remaining browser-breadth work is
   per-source depth (for example Mistral's E evidence is in its streaming artifact), not OpenRouter C.

2. **The next source transports.** All 25 implemented chat-completion sources are real; COMETAPI is the
   one pinned source that is not, because pinned throws before sending a request.
   Each source needs its own provider-wire scenarios, and the first question for each is which KIND it is:
   a base-URL variant, a shared-helper variant, or a branch with its own body AND response transform. Both
   source lanes so far had that answer wrong in the brief (OpenRouter was assumed to be "OpenAI with a
   different URL"; Claude was assumed to be reachable through the generic plan path).

3. **`docs/compat-matrix.md` row by row** is being audited because a docs audit of two OTHER files found
   seven false claims, two of which would have cost a user real time. The matrix is the file that tells a
   reader what is compatible, and a stale row is indistinguishable from a verified one at a glance.

4. **The named gaps inside the two new sources are CLOSED, except two cache probes.** OpenRouter media
   embedding and reasoning signatures, Claude's cache/`promptPlaceholder` branches, Mistral's
   `mistral.enablePrefix`, and makersuite inline media all have recorded fixtures. OpenRouter's
   config-gated prompt-cache transform and the gemini `isOpenRouterModelCacheable()` `/models` probe
   remain open; the `/models` probe is deliberately deferred because it changes the request COUNT.

5. **The Windows-only installer behaviours** -- replacing a RUNNING `gotavern.exe` (the branch Windows
   users actually hit on update), path separators, registry/shortcuts, `cmd.exe` -- are EXECUTED, by the
   `qualify-windows-amd64` job in run 39907640873 (mutation 39908014487 fails it). What that measures is
   `install.ps1` on a clean Windows runner; a host with an antivirus file lock, a non-admin shell or a
   non-NTFS volume is NOT COVERED.

6. **A cross-baseline upgrade** is still unexecuted, and so is a running-server replacement test.

7. **The tokenizer fixture cannot decide response BYTES, and that is measured, not suspected.** The
   fixture records parsed JSON, and `tests/oracle/sillytavern-1.19.0-tokenizers.json` has **26 of 1022**
   cases whose bodies carry **129 U+FFFD** characters: a byte-level BPE tokenizer answers with chunks that
   are fragments of a multi-byte character, so six of the ten `gpt2/encode#cjk` chunks (`chunks` carries 10
   entries, `count: 10`, ten ids) are replacement characters that decode identically from DIFFERENT bytes.
   `chunks` is compared as text, so those cases
   (gpt2 and the HuggingFace `openai` family, plus three `decode#roundtrip_emoji` cases) pass for the wrong
   reason -- a green that cannot fail, and the class rule 7 names. A second, independent byte difference is
   visible in the same file: **222 of 1022** bodies contain `<` or `>` (special tokens such as `<|endoftext|>`
   inside chunks), which `encoding/json` escapes as `\u003c`/`\u003e` while Express does not, so our bytes
   differ from pinned wherever the parsed values agree. Remedy, one slice: record `bodySha256` of the pinned
   RAW bytes in `tools/probe-tokenizers.mjs::request`, assert it in the Go replay (the character-write
   fixture already gates its PNG body that way, via `ResponseSHA256`), and stop HTML-escaping in the
   tokenizer serialization. Until that lands, the tokenizer rows are `partial` on this specific ground and
   must not be read as byte parity.
## 7. Working agreements

- Teammates own their lane branch and push it; the Lead merges and pushes main in batches.
- Compute belongs on GitHub Actions. Locally: `gofmt`, `node --check`, probe recording, and nothing Go.
- Never run `tools/build-generated-lib.mjs` locally.
- When a lane cannot be finished, contribute the READ you did (what you verified, what you corrected,
  what is still unread) rather than a stub. Several of the best findings arrived that way.

## 8. The honest remaining gaps (2026-10-23, re-measured on main `2dde1fa`)

Six items, restated from the tree rather than from the previous checkpoint. Each says what is closed, with
the evidence, and what is still open; none is softened into "in progress".

1. **The gemini body layer (makersuite/vertexai) is CLOSED.** `internal/server/chat_completions.go:575-586`
   routes both names to `pinnedGooglePlan` (`internal/server/google_chat.go:123`); the provider-wire fixture
   holds the `makersuite-*` and `vertexai-*` captures with non-empty `provider.requests`, and
   `internal/server/chat_completions_oracle_test.go:142-159` fails when a scenario has no capture. The
   named boundary that remains is VertexAI's service-account FULL mode (JWT + OAuth), which carries the
   pinned `400 {error:true,message}` shape rather than a fabricated credential.
2. **Moonshot wiring is CLOSED.** `internal/server/chat_completions.go:870-879` wires the plan arm,
   `internal/server/moonshot_chat.go:187` implements the status shape, and the `moonshot-*` captures are in
   the same fixture under the same missing-capture test.
3. **Preset-level equivalence is MEASURED for one complex scenario.** The
   <!-- BEGIN GENERATED: provider-wire.scenarios -->`219`<!-- END GENERATED: provider-wire.scenarios -->
   provider-wire scenarios are per-source request transforms and are NOT preset-level evidence
   (`tests/provider-wire/DESIGN.md:14-19`). The separate complex-preset differential is
   `tests/browser/preset-complex-comparison.json` with settings
   `tests/browser/fixtures/preset-complex-settings.json`: at the pinned-measured boundary
   (`keepContext` 4260 / `dropContext` 4259) both legs produced byte-identical provider requests
   (`providerRequestEqual: true`, empty `bodyDifferences`, verdict `match`), with 24 vs 26 total
   messages and 12 vs 11 history turns. Still OPEN: instruct/context templates, secondary WI keys,
   recursion/probability/outlets, group chats, and token-budget boundaries other than 4260/4259.
4. **Cross-baseline is SPLIT.** GoTavern release-to-release update and rollback IS executed:
   `.github/workflows/release-qualification.yml:383` runs `scripts/qualify-upgrade-rollback.sh` over two
   archives built from two commits (runs 39997932741 and 39998226861, cited in `docs/INSTALLATION.md:469`).
   An existing **SillyTavern** install migrated in place is still OPEN: that job installs an older GoTavern
   archive, and `gotavern migrate` copies to a new `--dest` (`cmd/gotavern/main.go:103`).
5. **The real github.com download path is OPEN.** Every installer run resolves releases from a loopback
   mirror (`GOTAVERN_RELEASES_BASE_URL` pointing at 127.0.0.1; `scripts/qualify-install.sh:275-285`), leaving
   proxy handling, TLS and GitHub's redirect behaviour UNMEASURED. Run 39907640873 proves the installer logic,
   not the path.
6. **Package tags: the tag exists; registry state is unverified here.** `git tag -l 'v*'` returns
   <!-- BEGIN GENERATED: release.versionTags -->`v0.1.0-alpha.1`, `v0.1.0-alpha.2`, `v0.1.0-alpha.3`, `v0.1.0-alpha.4`, `v0.1.0-alpha.5`<!-- END GENERATED: release.versionTags --> at `2dde1fa`, and the release is published (run 40066449948). `:latest` is deliberately
   not moved by a prerelease (`scripts/classify-version-tag.sh`), and this host has no network, so whether the
   registry still carries stale dispatch-only tags cannot be checked offline.
