# The long-lived corpus and the Beta 1 qualification

Beta 1's question is not "does a fresh install work" — it is "does a user who has been using SillyTavern for years
keep working after swapping the backend, and does an update from the published `v0.1.0-alpha.9` leave them able to
continue?" This document describes the three instruments built for that question, what they measure, what they
deliberately exclude, and the exact commands that run them.

Nothing here contains private data. The corpus is **synthetic and deterministic** (`AGENTS.md` 51/56); the one
in-tree real-derived artefact it consumes is the committed complex-preset derivation
`tests/browser/fixtures/real/preset-b.json`, copied byte-for-byte into the corpus.

## 1. `tools/build-longlived-corpus.mjs` — the generator

```text
node tools/build-longlived-corpus.mjs --size <small|medium|large> --out <dir> \
     [--seed corpus-v1] [--force] [--verify-deterministic] [--quiet]
```

It emits a directory that is BOTH a SillyTavern data root and the shape the harness boots:

```text
<out>/config.yaml                     pinned fresh-install config VERBATIM + unknown/legacy keys appended
<out>/default-user/characters/        PNG cards: unicode/CJK/emoji names, unusual filenames, long content,
                                      a committed v3 card per character and a legacy v2 card
          /chats/<card>/              four chats per character: a LONG one (the card's `chat` binding),
                                      a short one, and a BRANCH PAIR whose first 24 messages are identical
                                      byte-for-byte before they diverge; swipes[] and swipe_id persist the
                                      edit/swipe history, and deleted turns are absent (all pinned persists)
          /groups/ + /group chats/    a group definition and its transcript
          /worlds/                    multiple world books (incl. a legacy-shaped one and unicode names)
          /OpenAI Settings/           the committed complex derivation verbatim + upstream presets + generated
                                      legacy presets
          /themes /backgrounds /User Avatars /assets /QuickReplies
          /settings.json              active preset/world/character, personas, unknown top-level and
                                      extension_settings carriers
          /content.log                the file a long-lived install HAS and a fresh one does not: without it both
                                      servers re-seed default content into a user's directory
          /backups /thumbnails /user/{files,images} /stats.json   stale-but-valid long-lived debris
<out>/manifest.json                   counts + file inventory + tree digest
```

### Determinism is a measurement

- A seeded mulberry32 PRNG (seed = sha256 of `seed|size`) replaces `Math.random`; no clock, no environment.
- PNGs are written by this generator with zlib **stored blocks** (`level: 0`), which is byte-stable across zlib
  versions; a compressed stream is not, and a digest that moves with the runner's zlib would not be an identity.
- Paths are relative and sorted, forward-slash, and nothing carries an mtime.
- `--verify-deterministic` rebuilds the same `(seed, size)` into scratch and requires the **same tree digest**; the
  Go gate requires that flag to have reported `identical: true`, and `tools/longlived/verify.mjs --rebuild` does the
  same check independently.

Measured locally (Windows, Node 24.19.0):

| size | files | bytes | deterministic rebuild |
|---|---|---|---|
| small | 69 | 3,337,355 (3.18 MiB) | BYTE-IDENTICAL |
| medium | 174 | 51,663,539 (~49 MiB) | BYTE-IDENTICAL |
| large | 248 | 115,975,443 (~110 MiB) | generation only (nightly job asserts the rebuild) |

The tree digest is sha256 over sorted `<sha256>  <path>` lines, excluding `manifest.json` itself (it contains the
digest, so including it would make the identity self-referential).

## 2. `tools/longlived/verify.mjs` — the loader with teeth

```text
node tools/longlived/verify.mjs --corpus <dir> [--rebuild]
```

It re-walks the tree and re-derives the digest (never trusts the manifest), compares the inventory **both ways**
(missing and unexpected files are both failures), measures the size class, and asserts the long-lived surfaces by
name — characters/CJK/emoji, ≥3 chats per character, a ≥100-message chat, `swipes[]` with an edited message, a
byte-identical branch prefix, declared deletions, groups, worlds, presets (the complex one compared byte-for-byte to
its committed source), themes, backgrounds, personas, assets, Quick Replies, `content.log`, unknown config/settings
keys, and the decoded card JSON for the unicode names (a PNG's name lives base64 inside the image — searching the
PNG bytes for it would fail even when it is perfectly preserved).

It prints one JSON line and exits non-zero on any failed check. The check names are the teeth: the Go gate mutates
one byte of a chat copy and requires `tree-digest-equals-manifest` **and** `inventory-no-changed-files` to be the
named failures.

## 3. The browser qualification — `tests/browser/longlived-*.mjs`

```text
node tests/browser/longlived-qualify.mjs --size small|medium --corpus <generated-corpus> --out-dir <dir>
# env: GOTAVERN_BINARY=<candidate binary>  GOTAVERN_REFERENCE=<pinned checkout>  PINNED_READY_MS=180000
```

The driver:

1. generates (or accepts) the corpus and runs the loader;
2. **copies** it once per subject — the qualification input is never booted in place (`AGENTS` 14/51);
3. runs four legs sequentially: GoTavern drive → GoTavern restart (same tree) → pinned drive → pinned restart (same
   tree), using `q20-leg-runtime.mjs` and `q20-persistence-drive.mjs` (the existing browser harness) rather than a
   parallel universe;
4. judges them with `longlived-compare-legs.mjs`;
5. proves the judge has teeth with `longlived-gate-selftest.mjs`;
6. writes `longlived-verdict.json` (machine-readable; `ok` is the verdict).

**Measured locally (small corpus, both subjects, Windows host, headless Chromium):** four green legs (GoTavern drive
86 s, pinned drive 99 s, GoTavern restart 23 s, pinned restart 35 s), comparison `match` — 46 checks: **43 match, 0
mismatch, 0 harness-error, 3 recorded `decided-exclusion`** — and teeth **12/12 killed**. The verdict file:
`long-lived qualification (small): PASS`.

### The journey (`longlived-corpus-probe.mjs`)

The page loads over the corpus, the roster lists every corpus card, and the probe **resumes the existing long chat**
the card binds (waiting on the product's own `chatId` and chat length — a 118-message load is asynchronous and an
early read would have compared an empty page). Then: provider connection through the frontend's own controls; turn
one; **swipe** that reply (which is also how the per-subject discriminator leaves the compared provider wire); turn
two; switch the preset through `#settings_preset_openai`, the world through `#world_info` (whose option VALUES are
indices, not names), and the temperature through `#temp_openai` — each waiting for the frontend's own preset
promise and for the change to reach `settings.json`; switch character and back; **two full page reloads**, reopening
the card after each; save through the frontend's conditional save and wait for the product's write; then a **new
server process and a new browser** that resume the same chat, `continue` the last reply, save, and read the result
back. A failed step is named in the leg's `steps`/`failure`; a leg that cannot drive still writes its report, so the
comparator says "the leg failed by name" rather than treating absent evidence as a pass.

Fact classes (`AGENTS` 7), all three compared:

1. **browser observable** — readiness, roster, resumed chat identity/length/markers, reply texts, the changed
   preset/world/temperature and their persistence, character switch, reload states, restart read-back, continue
   reaching the provider.
2. **provider wire** — every completion request in order: method, raw target, byte length, sha256 and raw body.
   Byte-oriented: no canonicalising, no re-marshalling, no dropped members.
3. **disk state** — the planted corpus's manifest inventory versus after the journey: changed/deleted/added paths,
   the final message sequence of the resumed chat, the settings the user changed.

### Normalisation, with field paths and reasons

There is no global normalisation. These are the only accommodations, and the comparison artefact carries the same
table under `normalisations`:

| field | reason |
|---|---|
| `disk.chatsAfter[].messages[].swipes[]` | `AGENTS` 50 per-subject discriminator: one reply is stamped with the subject prefix, the user **swipes it away** (so no later provider request carries it), and the text survives on disk in `swipes[]`. The two subjects MUST differ here; the prefix is replaced with `<REPLY_PREFIX>`. |
| `disk.chatsAfter[].messages[].send_date` | recorded nowhere: each server stamps its own wall clock. Omitted, not compared. |
| `browser.turnOne.last.mes` | the discriminator is stamped into the FIRST reply, and that reply **is** turn one; compared with the prefix replaced. |
| `disk.changed[] (config.yaml)` | harness-seeded, not corpus data: both browser legs are handed the same pinned fresh-install config; startup config mutation is the startup differential's subject. |
| `disk.changed[] (default-user/stats.json)` | GoTavern writes the boot timestamp at startup, pinned writes it through its stats routes. Recorded as a `decided-exclusion` with both legs' digests; the startup write is `docs/startup-inventory.md`'s subject. |
| `disk.added[] (settings_default-user_<timestamp>.json, cookie-secret.txt, _storage/<id>, thumbnails/**)` | wall-clock names, random secrets and image-codec output are compared by normalised PATH/PRESENCE, not bytes. |
| `disk.added[] (excluding _webpack/**, _cache/**, default-user/backups/**)` | pinned compiles its frontend into `<dataRoot>/_webpack` and writes its character cache under `_cache` (build/cache artefacts; the cache has its own probe); automatic backup housekeeping belongs to the backup surface. Counted in a `decided-exclusion` entry, never asserted away. |
| `assets[]` thumbnail entries | the recorded pure-Go codec decision (`ARCHITECTURE` §35.2): status/content-type/presence compared, bytes not claimed. |
| settings (selected paths only) | comparison SCOPE: the user-visible changed state (active preset, temperature, selected worlds, world list, unknown-key presence). |

### Teeth

`longlived-gate-selftest.mjs` mutates **this run's own** leg artefacts and requires each NAMED check to go red:
provider body byte, provider request count, roster name, resumed chat length, preset switch, changed-file set,
resumed chat message text, persisted temperature, leg completeness, added-file set, restart process identity, and the
discriminator's disappearance from its own disk data. Measured locally: **12/12 killed**, baseline green.

```text
node tests/browser/longlived-gate-selftest.mjs \
  --drive-go <legs>/longlived-drive-gotavern.json --drive-pinned <legs>/longlived-drive-pinned.json \
  --restart-go <legs>/longlived-restart-gotavern.json --restart-pinned <legs>/longlived-restart-pinned.json \
  --out <run>/longlived-teeth.json
# long-lived gate teeth: ALL MUTATIONS KILLED (12/12)
```

The generator and the loader were mutated as well, and each mutation was restored **from a file copy** (never
`git checkout`):

| mutation | named guard that went red |
|---|---|
| `tools/build-longlived-corpus.mjs`: `if (!isUser && turn % 5 === 2)` → never emit `swipes[]` | `FAIL chat-swipes-present` and `FAIL chat-edited-message-persisted` in `tools/longlived/verify.mjs`; the Go gate failed with `no served message carries a swipes[] array, so the swipe/edit history a user had is not served` |
| `tools/longlived/verify.mjs`: make `tree-digest-equals-manifest` unconditionally true | the Go gate's loader subtest failed: `the drifted tree failed without the named check "tree-digest-equals-manifest"` |

Both files were restored byte-identically (sha256 compared against the backup) and the loader reran green.

## 4. The Go gate — `tests/e2e/longlived_corpus_test.go`

Runs in the normal `go test ./...` (so `ci.yml`'s `verify` job sees it) and in the long-lived workflow. It generates
the small corpus (or consumes `GOTAVERN_LONGLIVED_CORPUS`; `GOTAVERN_LONGLIVED_SIZE` selects medium/large), asserts
the generator's determinism report, proves the loader refuses a one-byte drift **by name**, then boots the shipped
binary over a corpus COPY and asserts: every card listed incl. unicode, the card's `chat` binding, the long chat with
its swipes through `/api/chats/get` (an ARRAY whose first record is the header), world entries, preset/world/theme/
Quick-Reply listings, unknown settings keys, groups, and image/persona/background/asset/thumbnail routes on
unusual filenames — and that not one planted byte changed (`AGENTS` 27/28). A machine without `node` skips with a
named reason; the workflow always provides it.

```text
go test ./tests/e2e -run '^TestLongLivedCorpus$' -count=1 -v
```

## 5. CI

`.github/workflows/longlived.yml` (new; it does **not** touch `ci.yml`, `whole-session.yml`,
`browser-differential.yml`, `release.yml` or `docker.yml`):

| job | when | what |
|---|---|---|
| `small-corpus` | push to the corpus/harness paths, or dispatch `size=small` (default) | both browser subjects, comparator, teeth, Go gate |
| `medium-corpus` | dispatch `size=medium` | the full qualification over ~50 MB / 2400-message chats |
| `large-corpus` | nightly schedule, or dispatch `size=large` | generator determinism, loader, Go boot over >100 MB (no browser drive, declared) |

Every job has a `timeout-minutes`; the small/medium jobs upload `longlived-verdict.json`, the four leg reports, the
comparison and the teeth report (`longlived-*-<run-id>`).

**The exact dispatches** (replace `<ref>` with the candidate branch/SHA ref and run after the lane is merged or from
the lane's ref):

```text
gh workflow run longlived.yml -R cocokoishi/GoTavern --ref <ref> -f size=small
gh workflow run longlived.yml -R cocokoishi/GoTavern --ref <ref> -f size=medium
gh workflow run longlived.yml -R cocokoishi/GoTavern --ref <ref> -f size=large
```

## 6. Upgrade qualification — published `v0.1.0-alpha.9` → Beta 1

```text
bash scripts/qualify-upgrade-rollback.sh --published-alpha9 <candidate.tar.gz>
# CI: .github/workflows/release-qualification.yml job `qualify-published-alpha9-upgrade` builds the candidate
# archive from the dispatched commit and runs exactly that command.
```

Unlike the existing cross-commit mode (two archives built in one run), this mode starts from the **real published
release**:

1. downloads `gotavern-linux-amd64.tar.gz` and `checksums.txt` for `v0.1.0-alpha.9` from the public GitHub release
   (`gh`, or `curl` against the release URL) and verifies the archive's sha256 **against the published checksums**;
2. derives both tags from the binaries inside the archives and builds a loopback mirror for both releases;
3. installs alpha.9 through the real `install.sh` seam and verifies the installed binary is byte-identical to the
   published archive's;
4. generates and seeds the long-lived corpus into that install and **boots alpha.9 over it**, asserting the
   published release itself reads the corpus chat;
5. backs up `config.yaml`, `data/`, `extensions/`, `certs/`, updates to the candidate through the same installer,
   and requires the user tree to survive the update byte for byte;
6. boots Beta 1 over the corpus and **uses** it: CSRF session, card list, opens the existing long chat (message count
   preserved), appends a continuation through `/api/chats/save`, serves the character image and thumbnail, serves
   the world book and the settings (including the unknown keys), then **restarts** and reads the continuation back;
7. exercises the **backup path** for real: restores the pre-update backup into a fresh prefix, boots alpha.9 over it,
   and requires the restored tree to serve the pre-upgrade chat and NOT contain the Beta 1 continuation;
8. classifies **every** runtime path Beta 1 changed/added/removed during boot + journey and fails on anything that is
   not an enumerated artefact shape. That classification is the measurement behind "no undocumented manual
   migration": the tree boots as-is, the chat opens, the continuation saves and survives a restart, and the writes
   are listed — not merely presumed harmless.

Failure handling: on any failure the script restores the pre-update backup into the prefix and reports it, and it
writes `published-alpha9-verdict.json` (`ok`, baseline tag + asset sha256, candidate tag, corpus tree, journey facts,
migration facts, or the failure) into `$QUALIFY_REPORT_DIR`, which the workflow uploads as an artifact.

### What has been measured, and where

- **Locally (Windows), through the download+checksum stage:** the real published asset was fetched from
  `https://github.com/cocokoishi/GoTavern/releases/download/v0.1.0-alpha.9/gotavern-linux-amd64.tar.gz`
  (60,510,564 bytes) and its sha256 matched the published `checksums.txt`:
  `3ba419435c70df79f30f2a63c6858983a8892b5cb10adcf577a1588408594574  gotavern-linux-amd64.tar.gz`.
  The mode then refuses to continue on Windows by name (`requires Linux`) because the remaining stages boot the
  published **linux-amd64** binary.
- **In CI (ubuntu), the whole mode:** `release-qualification.yml` job `qualify-published-alpha9-upgrade` builds the
  candidate archive from the dispatched commit and runs the full sequence above; its verdict is uploaded and the job
  fails when the verdict is absent or not `ok`.

**Dispatch** (after the lane is merged or from the lane ref):

```text
gh workflow run release-qualification.yml -R cocokoishi/GoTavern --ref <ref>
```

This is the **release-blocking** gate for Beta 1: the claim it supports is "a user on the published alpha.9 updates
to this build and continues working with no undocumented manual migration", with the migration writes enumerated.

## 7. What none of this proves (stated, not implied)

- The provider is a recording peer, not a real provider (`AGENTS` 22); a real completion is out of scope on this
  gate.
- The corpus is synthetic: no private card, preset or chat is used. The committed complex-preset DERIVATION is the
  only real-derived document, and it is structure-preserving and already in-tree.
- The large corpus is generated/loaded/booted but not browser-driven (time without added assertions).
- The browser gate needs the pinned checkout with its `node_modules`; without it the pinned legs are recorded
  `not-observed` and the verdict is **not** a pass.
- Backup **housekeeping** (automatic chat/settings backup creation) is outside this gate's comparison; the backup
  surface has its own routes/probes and is recorded `partial` in `docs/compat-matrix.md`.
