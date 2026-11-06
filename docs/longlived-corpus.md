# The long-lived corpus and the alpha.10 qualification

alpha.10's question is not "does a fresh install work" — it is "does a user who has been using SillyTavern for years
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

Measured locally (Windows, Node 24.19.0, seed `corpus-v1`):

| size | files | bytes | tree sha256 (prefix) | deterministic rebuild |
|---|---|---|---|---|
| small | 69 | 3,337,391 (3.18 MiB) | `2c175dd35554` | BYTE-IDENTICAL |
| medium | 176 | 51,669,193 (49.3 MiB; 30,264 messages) | `d3a6cf4646ce` | BYTE-IDENTICAL |
| large | 250 | 115,981,097 (110.6 MiB; 62,424 messages) | `d792a5be2d2b` | generation only here (the nightly job runs `--verify-deterministic`) |

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

## 6. Upgrade qualification — published `v0.1.0-alpha.9` → alpha.10

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
6. boots alpha.10 over the corpus and **uses** it: CSRF session, card list, opens the existing long chat (message count
   preserved), appends a continuation through `/api/chats/save`, serves the character image and thumbnail, serves
   the world book and the settings (including the unknown keys), then **restarts** and reads the continuation back;
7. exercises the **backup path** for real: restores the pre-update backup into a fresh prefix, boots alpha.9 over it,
   and requires the restored tree to serve the pre-upgrade chat and NOT contain the alpha.10 continuation;
8. covers the OTHER TWO ARRIVAL PATHS over the same corpus: a **fresh alpha.10 install** through the installer (boots,
   serves the existing corpus chat) and a **SillyTavern-data-copy drop-in** (the release archive laid over a tree that
   already holds the corpus; boots, serves the existing chat and the character image);
9. classifies **every** runtime path alpha.10 changed/added/removed during boot + journey and fails on anything that is
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

This is the **release-blocking** gate for alpha.10: the claim it supports is "a user on the published alpha.9 updates
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

## 8. The shared corpus-schema manifest, and the §0.3 two-corpus decision

Alpha.15 §0.3 asks whether ONE deterministic initial corpus can feed the Go, Node, browser and
provider-wire tests. The answer is implemented and measured rather than asserted:

* **ONE schema.** `internal/longlivedfixture` emits `gotavern-corpus-schema` v1 for the complex Go
  instance (`go run ./cmd/build-longlived <dir> -schema <file>`), and
  `tools/build-longlived-corpus.mjs --schema-out <file>` emits the SAME shape for the browser/Node corpus.
  The manifest records, for every file: relative forward-slash path, byte size, sha256 and a schema class;
  plus derived scenario counts, named capability flags, marker inventories and a tree digest computed over
  sorted `<sha256>  <path>` lines. Nothing reads a clock or an environment variable, so two builds of the
  same input produce byte-identical manifests (this is a test, not a promise:
  `TestCorpusSchemaIsDeterministicAndComplete`, `TestCorpusSchemaRebuildDiffHasTeeth`).
* **ONE verifier for any tree.** `tools/longlived/verify-corpus-schema.mjs --corpus <dir> --schema <file>`
  walks the tree and compares it to the manifest: missing files, extra files, per-file sha256, per-file
  class, class counts, file/byte counts and the tree digest are each a NAMED assertion. A browser leg, a
  Node probe or a Go boot can run this before it drives the tree, so "the tree I am about to drive is the
  tree the manifest describes" stops being an assumption. The verifier is tested with teeth on a real tree:
  `tests/e2e/longlived_schema_test.go` mutates one byte, adds a file, renames a file and tampers with a
  manifest sha256, and asserts the named red (`file-sha256`, `inventory-no-extra-files`,
  `inventory-no-missing-files`) before restoring to green.
* **TWO trees, proven different.** `tools/longlived/compare-corpora.mjs --left <schema> --right <schema>`
  compares the two manifests and NAMES every difference class. The measured result is
  `TWO_CORPORA_SHARED_SCHEMA` with `byteIdentical: false`; it reports `ONE_CORPUS_BYTE_IDENTICAL` only
  when every path exists on both sides with an equal sha256.

Measured on the development host (Go complex-small seed `20261104` vs JS small seed `corpus-v1`;
`TestLongLivedCorpusSchemaBridge` runs the same comparison in CI):

| fact | Go complex-small | JS small |
|---|---|---|
| generator | `internal/longlivedfixture` | `tools/build-longlived-corpus.mjs` |
| files | 47 | 69 |
| bytes | 205,516 | 3,337,391 |
| tree sha256 (prefix) | `6375b7193ea95d85` | `2c175dd355542698` |
| byte-identical shared paths | 0 of 3 | |

| scenario count | Go | JS |
|---|---|---|
| characters | 4 | 5 |
| chats | 5 | 17 |
| messages | 84 | 864 |
| branches | 1 | 8 |
| deleted turns | 0 | 8 |
| swipes | 10 | 4 |
| worlds / entries | 2 / 42 | 4 / 242 |
| presets (chat / text) | 2 / 2 | 4 / 0 |
| groups / group messages | 1 / 30 | 1 / 18 |
| unknown files / legacy assets | 3 / 2 | 2 / 0 |

The comparison reports 67 named difference classes; the ones that decide the question are coverage, not
counts. Each corpus has scenario classes the other does not:

| Go complex instance only | JS long-lived corpus only |
|---|---|
| legacy flat migration input (`public/characters`) | `content.log` (user + global) |
| character sprite folders | stale thumbnails tree |
| extension state directory | more chats/messages/world entries |
| moving-UI layout preset | balanced branch pairs with 24-message shared prefixes |
| `secrets.json`, `stats`, `regex` scripts | `user/files` and `user/images` breadth |
| text-completion presets | |
| chat backups, binary unknown files (`Thumbs.db`) | |
| `is_system` messages, embedded character books, regex world keys | |

Feature flags that differ are reported as `feature:<name>`; the 10 flags present only on the Go side are
`backups`, `binaryUnknownFiles`, `characterSprites`, `extensionState`, `legacyMigrationInput`,
`movingUI`, `secrets`, `systemMessages`, `textPresets`, `worldRegexKeys`, and the 2 present only on the
JS side are `contentLog` and `unicodeNames`. Because the difference set includes files, classes and
capabilities that exist on exactly one side, `separateCorporaJustified` is `true`: choosing either tree as
the only input would drop the other's unique surfaces, which is the coverage reduction the assignment
forbids. The manifest bridge makes the two corpora ONE contract without pretending they are ONE tree.

### What this does NOT claim

The schemas are not semantically equivalent and the corpora are not byte-identical. The bridge proves the
tree a consumer drives matches the manifest it was given, and it proves the two known corpora differ in
measured, named ways. It does not prove the Go complex instance and the JS corpus can be substituted for
one another, and it does not shrink any existing scenario: every JS corpus is still verified by
`tools/longlived/verify.mjs` and every Go complex test still builds the full instance.

The alpha.16 M1 extension (§9) adds ONE optional, independently versioned `scenario` block on top of this
contract — an E02 recipe descriptor, not a new corpus and not a claim that the two blocks are equal.

### Wiring the bridge into CI (owner: workflows lane; proposed patch, not applied here)

The `longlived` workflow already generates ONE JS corpus and shares it between the loader gate, the Go
corpus gate and the browser drive. To put the schema gate in the same path, the Lead applies these minimal
additions (the tools are in this branch, the workflow and `tests/browser` are other lanes' scopes):

```yaml
# after "Generate the small corpus" and before the loader gate:
- name: Emit and verify the shared corpus schema
  run: |
    node tools/build-longlived-corpus.mjs --size small --out "$GOTAVERN_LONGLIVED_CORPUS" \
      --seed corpus-ci --force --schema-out "$RUNNER_TEMP/corpus-schema.json" --quiet
    node tools/longlived/verify-corpus-schema.mjs --corpus "$GOTAVERN_LONGLIVED_CORPUS" \
      --schema "$RUNNER_TEMP/corpus-schema.json" --report "$RUNNER_TEMP/corpus-schema-verification.json"
# after the complex-instance gate:
- name: Emit and verify the complex instance's shared schema
  run: |
    node tools/longlived/verify-corpus-schema.mjs --corpus "$COMPLEX_ROOT" \
      --schema "$RUNNER_TEMP/complex-schema.json"
```

and in `tests/browser/longlived-qualify.mjs`, before the corpus is copied for either subject:

```js
import { loadSchema, verifyCorpusAgainstSchema } from '../../tools/longlived/corpus-schema.mjs';
const schema = await loadSchema(argument('--corpus-schema', path.join(outDir, 'corpus-schema.json')));
const verification = await verifyCorpusAgainstSchema({ corpus: corpusRoot, schema });
if (!verification.ok) throw new Error(`the corpus does not match its shared schema: ${verification.failed.join(',')}`);
verdict.corpus.schemaTreeSha256 = schema.tree.sha256;
```

The generator invocation in that driver gains `--schema-out` pointing OUTSIDE the corpus directory (a
governance manifest is not part of the tree), and the generator's stdout already reports
`corpusSchema.treeSha256` for the verdict.

### Commands

```text
go run ./cmd/build-longlived -small -schema <schema.json> <dir>
node tools/build-longlived-corpus.mjs --size small --out <dir> --seed corpus-v1 --schema-out <schema.json>
node tools/longlived/verify-corpus-schema.mjs --corpus <dir> --schema <schema.json> --report <report.json>
node tools/longlived/compare-corpora.mjs --left <go-schema.json> --right <js-schema.json> \
     --out <comparison.json> --markdown <comparison.md>
go test ./internal/longlivedfixture -run 'TestCorpusSchema' -count=1
go test ./tests/e2e -run 'TestLongLivedCorpusSchemaBridge' -count=1 -v
```

(The Go flags precede the positional target: `flag` stops parsing at the first non-flag argument.)

## 9. The alpha.16 M1 scenario/interaction extension (optional, versioned)

`docs/alpha16-agent-execution-plan.md` §3 and §9.B ask the scenario factory for "a deterministic, hermetic scenario
recipe system **on top of** the existing two corpora and their shared schema", where a scenario declares seed,
environment class, users, cards, chats, prompts, books, extensions, actions, faults, target observables and
resource bounds, and "every scenario requires seeded deterministic manifests, canonical SHA-256 of its preboot
tree, action log, byte census and a replay command". This section records what was implemented against that
requirement, how it was verified, and what is deliberately **not** claimed.

### 9.1 One additive, independently versioned block

The shared `gotavern-corpus-schema` gains ONE OPTIONAL member, `scenario`, appended **after** `files`
(`internal/longlivedfixture/scenario.go`; `tools/longlived/corpus-schema.mjs`):

* `schemaVersion` stays **1**. The block carries its own `scenarioVersion` (currently **1**), so a future
  scenario-shape change does not move the shared manifest contract.
* A manifest that OMITS the block is byte-identical to the pre-M1 v1 shape (it is what
  `BuildCorpusSchema`/`buildSchemaFromTree` without a scenario already emitted) and still parses, loads and
  verifies. `LoadCorpusSchema` and `loadSchema` treat the member as absent when it is missing or `null`.
* A manifest that CARRIES the block has it validated in **both** readers, and a malformed block is refused with a
  NAMED error (`*ScenarioValidationError.Names()` in Go, `invalid corpus schema …: <name>` from
  `loadSchema` in JS), never with prose. The member names are checked on the raw JSON, so an unknown field is a
  named refusal rather than a silently ignored extension.

| field | type | rule (both readers) |
|---|---|---|
| `scenarioVersion` | int | must be `1`; anything else → `scenario-version:<v>` |
| `environmentClass` | string | one of `E01`–`E09`; else `scenario-environment-class:<v>` |
| `seed` | string | non-empty; else `scenario-seed-empty` |
| `recipe` | object | all ten members required; unknown/missing → `scenario-recipe-unknown-field:<k>` / `scenario-recipe-field-missing:<k>` |
| `recipe.users` / `cards` / `chats` | int | `>= 1`; else `scenario-recipe-<name>:<v>` |
| `recipe.prompts` / `books` | int | `>= 0`; else `scenario-recipe-<name>:<v>` |
| `recipe.extensions[]` | `{name, commit}` | name non-empty, commit 40 lowercase hex; `scenario-recipe-extension-<i>-name-empty` / `-commit:<v>` |
| `recipe.actions[]` | string[] | non-empty, non-empty strings; `scenario-recipe-actions-empty` / `scenario-recipe-actions-item-<i>`; must equal `actionLog[].id` in order (`scenario-actions-match-log`) |
| `recipe.faults[]` | string[] | may be empty; items non-empty (`scenario-recipe-faults-item-<i>`) |
| `recipe.observables[]` | string[] | non-empty, sorted and unique (`scenario-recipe-observables-empty` / `-order`) |
| `recipe.resourceBounds` | `{maxFiles, maxBytes, maxProviderRequests, maxWallClockMs}` | ints; `maxFiles`, `maxBytes`, `maxWallClockMs` `>= 1`, `maxProviderRequests` `>= 0` (`scenario-recipe-resource-bounds-<name>:<v>`); bounds must not sit below `byteCensus` (`scenario-resource-bounds-files` / `-bytes`) |
| `prebootTreeSha256` | 64-hex string | equals `tree.sha256`; else `scenario-preboot-tree-sha256-shape` / `scenario-preboot-tree-mismatch` |
| `actionLog[]` | `{index,id,kind,source,observable,target}` | ordered, `index == position`, every string non-empty, ids unique; `scenario-action-<i>-index:<v>`, `…-<field>-empty`, `scenario-action-duplicate-id:<id>` |
| `byteCensus` | `{files, bytes, classes}` | `files`/`bytes` equal the schema's derived counts, `classes` equals its `class.*` counts; `scenario-byte-census-files:<v>` / `-bytes:<v>` / `-class:<name>` |
| `replayCommand` | string | single line without control characters, contains `<out>`, `<schema>` and the scenario seed, and starts with the tool for `generator`; `scenario-replay-command-shape`, `-placeholders`, `-seed`, `-tool:<generator>` |

`scenario-block` (verifier) records the block's presence, or the literal `absent (v1 backward-compatible read
path)`. When a block is present the verifier ALSO compares it to the **walked tree**, which is the reachable
drift case: `scenario-preboot-tree-matches-tree`, `scenario-tree-byte-census-files`, `-bytes` and `-classes`.
Schema-internal inconsistency is refused at load instead, so each check has exactly one owner.

### 9.2 The prototype scenario is E02, derived — not typed in

`internal/longlivedfixture.BuildE02Scenario` declares environment class **E02 (long-lived normal)** for the Go
complex instance, and `buildE02Scenario` does the same for the JS corpus. E02 was chosen because BOTH generators
already build that environment from a seed, so the prototype needs no new content machinery; E01/E03–E09 are
declared in the class enum and are **not** claimed as built.

The block is a pure function of (spec/seed, the builder's manifest, the walked inventory):

* counts come from the builder's declaration (`cards`, `chats`, `prompts` = prompt-bearing preset documents,
  `books`; `users: 1` because both generators stage exactly one `default-user/` tree; `extensions: []` because
  E02 installs no third-party extensions — extension *state* files are not installed extensions; E04 owns that);
* `faults: []` and the three observables are declared, not executed;
* `prebootTreeSha256` is the tree digest, `byteCensus` is the walk's census;
* the action log's targets are derived from the tree (the message-heaviest chat, and seed-selected preset/world),
  so a change in the tree changes the descriptor instead of leaving a stale hand-typed target;
* `replayCommand` rebuilds the same tree from the same seed and parameters, with `<out>`/`<schema>` placeholders:
  `go run ./cmd/build-longlived -seed 20261104 -small -schema <schema> <out>` and
  `node tools/build-longlived-corpus.mjs --size small --out <out> --seed corpus-v1 --schema-out <schema> --force`
  (`cmd/build-longlived` gained a `-seed` flag so the command is parameterised rather than relying on a constant).

The emitted Go block for `complex-small`, seed `20261104` (files 47, bytes 205,516):

```json
{
  "scenarioVersion": 1,
  "environmentClass": "E02",
  "seed": "20261104",
  "recipe": {
    "users": 1, "cards": 4, "chats": 5, "prompts": 4, "books": 2,
    "extensions": [], "faults": [],
    "actions": ["resume-longest-chat", "swipe-last-reply", "switch-preset", "switch-world", "reload-page", "restart-process"],
    "observables": ["browser-state", "disk-bytes", "provider-wire"],
    "resourceBounds": {"maxFiles": 94, "maxBytes": 822064, "maxProviderRequests": 1, "maxWallClockMs": 600000}
  },
  "prebootTreeSha256": "6375b7193ea95d85db955776a0d7acfc030ef9819170fe3111e1daa130e8ab3a",
  "actionLog": [{"index": 0, "id": "resume-longest-chat", "kind": "resume", "source": "browser:character-list", "observable": "chat-identity", "target": "default-user/chats/Seraphina/Seraphina - 2024-02-10 - branch.jsonl"}, "… five more ordered actions …"],
  "byteCensus": {"files": 47, "bytes": 205516, "classes": {"characters": 4, "chats": 5, "…": "…"}},
  "replayCommand": "go run ./cmd/build-longlived -seed 20261104 -small -schema <schema> <out>"
}
```

### 9.3 Determinism is measured, not promised

Two independent builds of the same input were run through each generator and the schema FILE digest compared
(commands: the two generator invocations above into separate directories, then `sha256sum` of each schema):

| generator | seed | two builds' schema sha256 | tree sha256 (preboot) |
|---|---|---|---|
| `go run ./cmd/build-longlived -small` | `20261104` | `f32d5b8a3571cedbebd88a6c718a8bc3dbaf69ccc13f5be1aa3f17073f57695e` (both) | `6375b7193ea95d85db955776a0d7acfc030ef9819170fe3111e1daa130e8ab3a` (both) |
| `node tools/build-longlived-corpus.mjs --size small` | `corpus-v1` | `505514f1ce135c1baae64f832cec91e7d9b57dc0f10cf8c554d3e47965ad8827` (both) | `2c175dd355542698fcb11e1365f359e47358ecd8b020f270d30c289c47f14b24` (both) |

The JS tree digest is still the pre-M1 §1 measurement (`2c175dd35554…`, 69 files, 3,337,391 bytes) and the Go
tree digest is still the §8 measurement (`6375b7193ea95d85…`, 47 files, 205,516 bytes): **declaring the scenario
did not change either tree**, which is the additivity claim. `TestE02ScenarioDescriptorIsDeterministic` and the
bridge test compare the manifest BYTES (not just digests) so a field/order/map change is also caught.

### 9.4 Teeth: the block is refused by name, and drift is named

The exit text below is from actual runs (`node tools/longlived/verify-corpus-schema.mjs --corpus <tree> --schema
<file> --quiet`), and every case restores the input and re-verifies green:

| planted change | observed |
|---|---|
| schema field: `scenario.byteCensus.bytes = 1` | exit 1, `failed: ["schema-valid"]`, `error: "… : scenario-byte-census-bytes:1"` |
| one byte in `default-user/settings.json` | exit 1, `failed: ["file-sha256","tree-digest-equals-schema","scenario-preboot-tree-matches-tree"]` |
| block removed (`delete schema.scenario`) | exit 0, `scenario-block` check `ok: true`, `detail: "absent (v1 backward-compatible read path)"` |

The Go reader refuses the same schema-side cases with the same names: `LoadCorpusSchema` returns a
`*ScenarioValidationError` whose `Names()` include `scenario-byte-census-bytes:…`, `scenario-unknown-field:bogus`,
`scenario-field-missing:recipe`, `scenario-environment-class:E99`, `scenario-actions-match-log`,
`scenario-version:2` (`TestScenarioValidationNamesEachDefect`,
`TestLongLivedCorpusSchemaScenarioBlock/byte_census_tamper`), and the builder round-trips its own emitted bytes
through the reader so a generator that stopped declaring a valid block fails its build rather than writing it.

### 9.5 The Go and JS definitions cannot drift silently

`tools/longlived/schema-fields.mjs` prints the JS field inventories **from the same tables the validator walks**
(so a member is listed only if it is validated) plus the named-refusal vocabulary. `tests/e2e/longlived_schema_test.go`
→ `TestCorpusSchemaGoAndJSFieldInventoriesAgree` compares that with the Go inventories derived by reflection over
the schema structs, in BOTH directions, and fails named (`go-field-not-in-js:<group>.<field>`,
`js-field-not-in-go:<group>.<field>`; likewise for the refusal names). Measured on this tree: schema 12 fields,
scenario 8, recipe 10, extension/action/census/bounds 2/6/3/4, refusal names 37, verifier tree checks 5 —
all agreed. `TestFieldInventoryDiffHasTeeth` feeds synthetic one-sided inventories to the comparison itself and
requires both mismatch directions to be named, so the agreement test is not a comparator that cannot fail.

### 9.6 What this is NOT

* **No environment class other than E02 is built.** E01 and E03–E09 remain declared ids; the 120-block preset,
  the nested/recursive books and the 20 pinned extension interactions are `docs/alpha16/first-scenario-design.md`
  work (E-H6/E-H7) and are not claimed here. The browser-side E03/E04 kit is another lane's file
  (`tests/browser/extensions/e03e04-profile-kit.mjs`), not this one's.
* **The action log is a DECLARED plan, not an execution record.** It names the ordered actions and their derived
  targets; executing them through the pinned frontend, capturing provider wire and filling per-action results is
  the M2/M3 runner's job. The block claims determinism of the run *input*, and that claim is what is measured.
* **The two corpora's scenario blocks are not compared for equality.** They legitimately differ (different
  generators, sizes, seeds); `compare-corpora.mjs` reports the differing declared facts as named classes
  (`scenario:seed`, `scenario:prebootTreeSha256`, `scenario:recipe.*`) and the decision stays
  `TWO_CORPORA_SHARED_SCHEMA` with `byteIdentical: false`.
* **No real user artifact is involved** (`AGENTS` 51/56): everything here is synthetic and generated.

```text
go test ./internal/longlivedfixture -count=1
go test ./tests/e2e -run 'TestLongLivedCorpusSchemaBridge|TestLongLivedCorpusSchemaScenarioBlock|TestCorpusSchemaGoAndJSFieldInventoriesAgree|TestFieldInventoryDiffHasTeeth' -count=1 -v
node tools/longlived/schema-fields.mjs
```

