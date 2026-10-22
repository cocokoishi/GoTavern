# Five-surface coverage

`AGENTS.md` requires five observer surfaces to be equivalent before an area can be called
`compatible`:

1. **B**rowser -> **S**erver HTTP
2. **S**erver -> **P**rovider wire
3. **F**ilesystem / startup side effects
4. **E**vents / final browser state
5. **C**ancel / streaming

This file exists because "partial" hid which surface was missing. A row can now be read as
"B ✓, P ✓, F ✗, E ✗, C ✗" instead of a word. It is the working list for promoting areas, not a
claim about them: an empty cell means NO EVIDENCE, which is different from "not applicable" and
has to be argued per area.

## How to read a cell

- ✓ — a committed artifact in this repository proves it, named in the Evidence column.
- — (empty) — no evidence recorded. Treat as unproven even if the behaviour looks right.
- n/a — the surface genuinely does not apply to that area, and the reason is stated.

## Current state

| Area | B | P | F | E | C | Status | Evidence |
|---|---|---|---|---|---|---|---|
| Chat-completions generation, custom/OpenAI-compatible source | ✓ | ✓ | ✓ | ✓ | ✓ | **compatible** | `tests/oracle/sillytavern-1.19.0-backends.json`; `tests/browser/generation-comparison.json`; `tests/browser/streaming-comparison.json` |
| Chat-completions generation, OPENROUTER and CLAUDE | ✓ | ✓ | ✓ |  |  | partial | `tests/oracle/sillytavern-1.19.0-provider-wire.json` (27 scenarios). **OPENROUTER is browser-measured end to end** (`tests/browser/generation-openrouter-comparison.json`, read by the gate): both legs send the same provider request bytes (7525 B, sha `ff6906de`), the same per-invocation milestones and the same post-send DOM state, with `sendWindowHoldsExactlyOneRealSendAndNoDryAssembly` judged PER INVOCATION -- a dry pass belonging to the real send still fails, while an independent counting invocation is recorded and not attributed, because on three consecutive drives the same correct count came with that invocation starting 11 ms after the send, then 401 ms before it, then not at all (a race, not a contract). E is therefore measured for OPENROUTER; **C is not** (streamed + abort needs its own drive and artifact against the paced SSE peer). **CLAUDE has P only**: no browser capture yet. |
| Tokenizers (encode/decode/count/openai) | ✓ | n/a |  |  | n/a | partial | `tests/oracle/sillytavern-1.19.0-tokenizers.json` (1022 cases). F is empty **and it matters**: a browser capture once measured the FALLBACK path because `tokenizers/` was missing beside the binary, which is now a hard failure in `assets verify`. The corpus was BLIND to the call every browser makes -- `counterWrapperOpenAIAsync` posts `[{content: text}]` with NO role -- and 908 role-ful cases could not see it; the role-less bodies are now recorded, and adding them is what proved the route itself was always correct (the apparent 10-vs-9 was the probe staging the assets into its own dataRoot rather than beside the executable it was handed). The corpus can only be recorded on Linux: re-recording it on the Windows host alters pre-existing `chunks` by decoding UTF-8 as Latin-1, so the oracle job now publishes its re-recording as `oracle-linux-rerecord` for an author to apply |
| Secrets (all 8 routes) | ✓ | n/a | ✓ | ✓* | n/a | partial | `tests/oracle/sillytavern-1.19.0-secrets.json`; *E from the startup scenario: `/api/secrets/read` and `/write` observed EQUAL on both legs |
| Assets / backups / sprites (user data) | ✓ | n/a | ✓ |  | n/a | partial | `tests/oracle/sillytavern-1.19.0-{assets-download,assets,backups,sprites}.json`. E stays empty because neither browser drive reaches this domain: `startup-calls.mjs` and `data-domain-drive.mjs` issue no `/api/assets/*`, `/api/backups/*` or `/api/sprites/*` request, so no browser interaction with it has been driven on either leg. Thumbnails do NOT gain E: `/thumbnail/<computed: Identifier>` is `not implemented` |
| SD non-generate routes | ✓ | ✓ | ✓ | ✓* | n/a | partial | `tests/oracle/sillytavern-1.19.0-sd-{routes,workflows}.json`; *E for the startup scenario only (`/api/sd/comfy/workflows` equal) |
| SD generate (8 sources) | ✓ | ✓ | ✓ |  |  | partial | `tests/oracle/sillytavern-1.19.0-sd-generate.json` |
| Horde domain | ✓ | ✓ | n/a |  |  | partial | `tests/oracle/sillytavern-1.19.0-horde.json`. **F is n/a by argument, not by omission**: the pinned `src/endpoints/horde.js` contains no `writeFile`/`appendFile`/`mkdir`/`unlink`/`createWriteStream`/`fs.` call at all, and the Go routes likewise write nothing -- the domain keeps only the 60-second `models`/`workers` caches in memory. One prompt/one response, no persisted state to compare |
| Speech / images | ✓ | ✓ | ✓ |  | n/a | partial | `tests/oracle/sillytavern-1.19.0-{speech,images}.json` |
| Content import (importURL/importUUID) | ✓ | ✓ | ✓ |  | n/a | partial | `tests/oracle/sillytavern-1.19.0-content{,-uuid}.json` |
| Providers / tokenization / streaming at the SERVER level | ✓ | ✓ | ✓ |  | ✓ | partial | `tests/oracle/sillytavern-1.19.0-provider-wire.json` (stream + abort scenarios) |
| Startup / boot sequence | ✓ | n/a | ✓ | ✓ | n/a | partial | `tests/browser/startup-comparison.json`: 353 startup requests, 349 equal, 4 different-status ALL known (2 thumbnails are `not implemented`, `__transparent.png` and `user.css` are `cosmetic`), **0 unexpected**; final page state equal across 15 fields |
| Characters (list, card read, create/edit/delete) | ✓ | n/a | ✓ | ✓ | n/a | partial | `tests/oracle/sillytavern-1.19.0-characters-{read,write,import}.json`; **E**: `tests/browser/data-domain-comparison.json` — the drive opens the real create panel, submits the form, reads the list and the card back through `/api/characters/get`, deletes, and re-reads the list; every in-domain request, its write payload and the final browser values are equal on both legs |
| Chats (save, get, `.jsonl` framing) | ✓ | n/a | ✓ | ✓ | n/a | partial | `tests/oracle/sillytavern-1.19.0-chats-{save-get,mutations,import,search-recent}.json`; **E**: `tests/browser/data-domain-comparison.json` — `/api/chats/save` then `/api/chats/get` with the message array compared element by element, then `/api/chats/export` for the raw line framing; equal on both legs |
| Settings (save then re-read) | ✓ | n/a | ✓ | ✓ | n/a | partial | `tests/oracle/sillytavern-1.19.0-settings-{get,save}.json`; **E**: `tests/browser/data-domain-comparison.json` — the `/api/settings/save` write payload and the `/api/settings/get` re-read body are compared by digest and the final settings values by value; equal on both legs. The value the drive flips does not survive the round trip on EITHER leg (recorded as `writeReflected: false`), so this cell rests on the write payload, the re-read body and the final state, not on value reflection |
| Backgrounds (upload then list) | ✓ | n/a | ✓ | ✓ | n/a | **compatible** | `tests/oracle/sillytavern-1.19.0-backgrounds-{all,upload,delete,rename}.json`; `tests/browser/data-domain-comparison.json` -- the drive opens the Backgrounds panel (`#backgrounds-drawer-toggle`, the drawer a user clicks), ASSERTS the frontend has bound the upload handler (`jQuery._data(#add_bg_button, "events")`) and returns `not-driven` naming that gate if it has not, then observes the upload in `/api/backgrounds/all` AND at `/backgrounds/<name>` (200, 110 bytes) on BOTH legs, twice per leg. The gate assertion is the fix: the old drive dispatched into an unbound handler and reported a silent no-op as "the upload never reached the server" |
| Quick replies (save then reload) | ✓ | n/a | ✓ | ✓ | n/a | **compatible** | `tests/oracle/sillytavern-1.19.0-quick-replies.json`; `tests/browser/data-domain-comparison.json` -- the drive reads and ASSERTS `globalThis.quickReplyApi` (published by the extension's `hooks.activate -> init()`, not a static the drive can import), creates a set and a quick reply through that API, persists, RELOADS and re-reads, and both survive on BOTH legs, twice per leg. The unconditional `not-driven` return was deleted rather than kept as a fallback |

`✓*` means the cell is covered for a NAMED SCENARIO only. The startup differential drives the page
at boot, so it gives characters (`/api/characters/all`), chats (`recent`, `get`, `save`),
backgrounds (`all`, `folders`), extensions (`discover` plus the built-in extension files), quick
replies (`save`) and SD workflows (`comfy/workflows`) an E for that scenario and nothing more. Do
not read it as "the area was driven end to end".

The data-domain rows above replace that prose for four of those areas with a measured interaction
(`tests/browser/data-domain-drive.mjs`, compared by `tests/browser/compare-data-domain-legs.mjs`).
Each row's E is a WRITE followed by a RE-READ performed on both legs from the same action sequence,
and it moves only when the comparison would fail if the Go leg differed. The comparison refuses to
promote an interaction that was not driven on both legs, that issued no write request, or whose
observed values were not stable across two runs of each leg — so a cell cannot move on a rerun of
boot, on a read-only drive, or on a value that changes between two identical drives.

## What promotion actually requires

The chat-completions row became `compatible` only after the fifth surface was MEASURED, and that
measurement overturned three earlier conclusions:

- the probe buffered every streamed response with an unconditional `clone().text()`, so every
  capture in that directory was the streamed path mislabelled as non-streaming. A **non-stream
  control** (different body length and SHA) is now required before any streaming claim;
- aborting "after N render snapshots" is a race. Abort on an EXACT rendered prefix, and assert the
  provider observed the disconnect (`clientDisconnected: true` on both legs), not just that the
  browser stopped rendering;
- a sequential mock script starves the real request once an extra call (Connect's `GET /models`)
  is added to the flow. Script per-endpoint, not per-order.

## What CI checks about these artifacts

The `browser-evidence` job runs `tools/verify-browser-comparisons.mjs` over the three committed
comparison artifacts. It cannot recompute them from their legs and does not pretend to: the per-run legs
are gitignored deliberately, and `tests/browser/.gitignore` says why -- "a committed leg invites someone
to treat a known divergence as the expected value". A first version of this job did recompute and failed
with `ENOENT`; it had passed when tried by hand only because the untracked legs were on that machine,
which is the working tree rather than the repository.

What the committed artifacts can support is a coherence check, and that is what the job does:

- a comparison may not record an UNEXPLAINED divergence -- every non-equal row and every body
  difference must carry a reason;
- the faithfulness guards must still hold, because a differential that never reached the state it
  compares proves nothing;
- a `compatible` row may not rest on an artifact whose core claim is false -- for generation that is
  `providerRequestEqual`, which is the provider wire this project promises to reproduce.

**THE GATE'S FIRST FINDING IS RESOLVED, and it was a probe defect rather than a product
difference.** `generation-comparison.json` recorded `milestoneEqual: false` with no reason, counters
`dryAfterData` gotavern 1 / pinned 2, inside the area this table calls `compatible`. The cause was the
observation WINDOW: the probe attached its recorder a few statements before the send click, so on the
slower leg the tail of the prompt-manager dry generation that the drive itself starts landed inside the
window. The proof is not "the numbers look nicer now" -- it is that the pinned record held a dry
`GENERATE_AFTER_DATA` with NO dry `GENERATION_STARTED`, which `script.js:4299/5318/5320` make impossible
for an invocation the window contains; that both legs' own frontend logs recorded the same whole-drive
count (4 invocations, 3 dry + 1 real); and that the same asymmetry moved to whichever leg was slower
across the gen, cancel, stream and non-stream pairs. The probe now waits for quiescence before the send
and closes the window at `GENERATION_ENDED` instead of a fixed sleep (a second, separately measured
race: the pinned leg had rendered the reply but not yet emitted the event), the counters are equal, and
the window is recorded under `surrounding` with the whole-drive count. `compare-generation-legs.mjs`
now EXITS 1 on a false window guard, and this gate checks those guards in the COMMITTED artifact --
without that second half a false guard could be committed and CI would stay green, which is the same
"an artifact that cannot fail" shape as the finding itself.

## Extension E2E (both pinned canaries)

`tests/browser/extension-tavern-helper-comparison.json` is committed and gated. On a RELEASE-FAITHFUL
install (no `public/` on disk, binary from the lane's own CI run, both legs given the same explicit
config): 21 rows ALL equal, both drives ended on the page's own network-quiet signal (5,886 ms / 359
requests on GoTavern against 6,791 ms / 359 on pinned), discovery identical (14 system names, same
order, from the embedded tree), `/lib.js` byte-identical, and exactly one non-row path difference with
a recorded reason (`/thumbnail`, the Jimp codec boundary).

LittleWhiteBox @9e71caef is COMMITTED AND GATED too: `tests/browser/extension-littlewhitebox-comparison.json`,
452 rows ALL equal, same single non-row difference (`/thumbnail`, the Jimp boundary). It was withheld for
one round ON PURPOSE, and the reason is the rule: its one real difference was
`/user/files/LittleWhiteBox_User.json` answering 404 on GoTavern against 200 on pinned, because
`/user/files/*` and `/user/images/*` DID NOT EXIST (pinned `users.js:1217-1218`). Writing that as a
`knownReason` would have recorded a product defect as the expected value; instead the routes were
implemented, the pair re-recorded, and the artifact committed. What the extension WROTE is compared too:
`writtenUserFiles` records size and JSON skeleton and classifies the digest `shape` with the measured
reason (the file carries a per-run `tx-<uuid>`, so two runs of the SAME server differ at the same 626
bytes), while Tavern Helper writes nothing and its artifact says so rather than passing vacuously.
Two harness hazards were found by recording rather than by review, and both would have invalidated the
artifact silently: `/api/extensions/update` really runs `git fetch` and once MOVED the checkout off the
pinned revision (seeded installs now point `origin` at the local seed and the revision is asserted
afterwards), and the comparison was writing absolute leg paths into a committed file.
## The cheapest next promotions

Ordered by missing work, not by route count. The list is kept honest by striking items when they
close: two of the three below were ALREADY closed when this list was last written, which is the
stale-negative problem this file keeps warning about.

1. ~~**Horde F**~~ -- CLOSED BY ARGUMENT, and the argument was already in the Horde row above: the
   pinned `src/endpoints/horde.js` contains ZERO filesystem calls (swept for `fs.`, `writeFile`,
   `appendFile`, `mkdir`, `unlink`, `createWriteStream`, `rename`, `rmSync`) and the Go handlers write
   nothing either -- only their test fixtures seed state. The domain keeps two 60-second in-memory
   caches, so there is no persisted side effect to compare. F is n/a, not unmeasured.
2. **Chat-completions P and E/C for the other sources** -- IN FLIGHT. The generator has a transport
   for OPENAI/CUSTOM only and answers 501 for everything else; a lane is implementing OPENROUTER
   provider-wire-first, which is the prerequisite for any E/C claim about that source. Until it lands,
   the other sources have neither P nor E, and saying they have "provider-wire only" was wrong: they
   have neither.
3. ~~**E for every data domain**~~ -- CLOSED. All five domains (`settings`, `characters`, `chats`,
   `backgrounds`, `quickReplies`) are promotable in `tests/browser/data-domain-comparison.json` with
   all five guards true, and backgrounds and quick replies are now `compatible` rows. BOTH blockers
   turned out to be DRIVE gates rather than product gaps, which is why they survived two earlier
   rounds: the backgrounds drive dispatched `change` into a handler the frontend had not bound yet
   (the panel was never opened), and the quick-replies drive read a static instance the extension
   never sets instead of `globalThis.quickReplyApi`. Each drive now ASSERTS its gate and names it
   when absent, so the next failure says which precondition is missing instead of looking like a
   silent no-op.
**The data-domain comparison IS covered by the gate**, and this paragraph used to say it was not.
`a1fc22a` added the comparison artifact and the artifact's own hand-written block in
`tools/verify-browser-comparisons.mjs` in the SAME commit, so the earlier note ("it has none for
`data-domain-comparison.json`") was stale from the moment it was written and would have pushed the
next reader into rebuilding a check that already ran. What the block enforces, over and above the
shared coherence rules: `unexpectedCount` must be 0 with an empty `unexpected[]`; all five guards
(`faithful`, `gotavernReachedUserState`, `pinnedReachedUserState`, `bothLegsCompletedDrive`,
`observedStableAcrossTwoRunsPerLeg`) must be true; every row marked `promotable` must ALSO carry
`writeDemonstrated: true`, so a read-only drive cannot move a cell on the strength of "nothing went
wrong"; and the number of domains named in `promotable[]` must equal the number of promotable rows,
so a claim of promotion cannot outlive its evidence. A hand-edited or refreshed-without-re-driving
artifact fails these before a reviewer sees it. Its per-run legs stay gitignored like the others, per
the reason in `tests/browser/.gitignore`.
