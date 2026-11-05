# The Node-originated stock tree and the Node -> Go -> Node round trip

This document describes the gate that closes the INPUT half of the last P1 in
[`docs/gap-sweep.md`](gap-sweep.md) rank 1: the stock tree every packaged drop-in gate booted was **derived**
from the pinned source by [`scripts/build-stock-tree.sh`](../scripts/build-stock-tree.sh), so no gate could show
that the **original Node SillyTavern** accepts what this repository produces, or that it accepts what GoTavern
wrote.

Two new programs answer that question:

| program | what it does |
|---|---|
| [`tools/build-node-stock-tree.mjs`](../tools/build-node-stock-tree.mjs) | boots the pinned server and records a tree it WROTE through its own HTTP routes; hashes it; labels what is API-created, seeded and prepared; optional determinism self-check |
| [`tools/qualify-node-stock-tree.mjs`](../tools/qualify-node-stock-tree.mjs) | the round trip: Node writes -> GoTavern reads/mutates -> restart/mutate -> pinned Node reads and continues -> GoTavern reads the Node mutation, with whole-tree preservation assertions |
| [`scripts/qualify-node-stock-tree.sh`](../scripts/qualify-node-stock-tree.sh) | the POSIX entry point CI and a developer use; it refuses a wrong pin, a missing `node_modules` or a `--tree` without its manifest |

> **What this is not.** It does not replace `scripts/build-stock-tree.sh`, and it is not a second source of
> truth for a fresh install. The packaged gates still boot a tree built by the shell script; this gate adds a
> tree RECORDED from the pinned server and the round trip over it. `docs/dropin-qualification.md` remains the
> document for the packaged path.

## What the tree contains

The tree is a stock SillyTavern installation laid out the way the packaged gates expect: `config.yaml`,
`data/`, `public/`, `default/`, `src/tokenizers/`, `plugins/`.

### API-created (23 operations through the pinned server's own routes)

| surface | routes | contents |
|---|---|---|
| user account | `POST /api/users/create`, `/api/users/login` | a SECOND account `node-origin` (not `default-user`), created by the pinned admin API, so the tree is a multi-user tree |
| settings | `POST /api/settings/save` | the whole non-default document: personas + persona descriptions, theme, background, install/persona bindings, instruct/context/sysprompt non-defaults, the selected preset's prompts, `oai_settings` incl. a loopback-pinned provider, global regex scripts, extension state (incl. an unknown member), unknown top-level keys |
| characters (3) | `POST /api/characters/create`, `POST /api/characters/edit` | real PNG avatars, alternate greetings, character-scoped regex scripts, a depth prompt, unknown extension members, a deterministic `chat` binding and `create_date` |
| chats (2) | `POST /api/chats/save` | JSONL with multiple messages, swipes + `swipe_id` selecting a later alternative, `force_avatar`, chat variables (`chat_metadata.variables`), an unknown metadata key |
| group + group chat | `POST /api/groups/create`, `/api/groups/edit`, `/api/chats/group/save` | a three-member group and its transcript; the pinned route chooses the group id (`String(Date.now())`) |
| world book | `POST /api/worldinfo/edit` | 10 entries incl. disabled/constant/positioned ones, unknown per-entry extensions and a top-level unknown member |
| preset | `POST /api/presets/save` | a generated 40-prompt complex preset with `prompt_order`, samplers and preset-scoped regex |
| Quick Replies | `POST /api/quick-replies/save` | a two-item QR preset |
| theme | `POST /api/themes/save` | a theme document with an unknown member |
| persona avatar | `POST /api/avatars/upload` | a real PNG, re-encoded by the pinned avatar route |
| background | `POST /api/backgrounds/upload` | a real PNG; the pinned server generates its own metadata index entry |
| thumbnails | `GET /thumbnail?type=...` | requests through the logged-in browser-facing route, which makes the pinned server write its own thumbnail cache files |
| settings backup | `POST /api/settings/make-snapshot` | the pinned server's own `backups/settings_<handle>_<timestamp>.json` |

### Seeded, not API-created (each labelled with its reason in the report)

1. `public/scripts/extensions/third-party/node-origin-extension/**` — a third-party extension directory.
   Pinned installs extensions by cloning a git URL (`/api/extensions/install`), which needs outbound network.
   The directory carries **no `.git`**, so the tree hash cannot race a live repository (the packaged gate
   recorded a `maintenance.lock` flake from exactly that).
2. `data/node-origin/chats/Legacy Flat Chat - 2024-01-01.jsonl` — the pre-directory chat layout.
   `/api/chats/save` always writes under `chats/<card>/`, so the flat layout cannot be produced through the API.
3. `data/node-origin/settings.json.bak` — the older backup naming convention. The pinned snapshot route writes
   `backups/settings_<handle>_<timestamp>.json` instead.

### Prepared, not user data (also labelled)

- `public/**`, `default/**`, `src/tokenizers/**` — the pinned installation assets, copied from this repository's
  vendored pinned baseline. The release archive deliberately does not ship `public/`; a stock installation
  keeps it on disk.
- `config.yaml` — written by the generator and then **rewritten by the pinned server** at startup
  (`src/config-init.js addMissingConfigValues`), so the recorded file is the server's own output. It carries an
  unknown legacy key (`node_origin_legacy_config`) that the merge must preserve.
- `plugins/.gitkeep` — stock SillyTavern ships this directory.

The run config is a **qualification config**, not a production one: no basic auth, no whitelist, no
auto-update, extensions not loaded, no heartbeat file, and the provider pinned at a closed loopback port
(`http://127.0.0.1:9/v1`). The pinned server is bound to `127.0.0.1` by argv (`--listenAddressIPv4
127.0.0.1 --enableIPv4 true --enableIPv6 false --listen false --browserLaunchEnabled false
--whitelistMode false`).

## Hashing and normalisation

`tools/build-node-stock-tree.mjs` walks the recorded tree and writes, beside it, a manifest of **sorted
relative path + sha256 + size + mode** and two digests:

- `tree.sha256` — sha256 over every line `<sha256>  <bytes>  <mode>  <path>`. It records every byte and is
  therefore **different on every run** for the values the pinned server stamps itself.
- `tree.normalisedSha256` — the same over a listing in which every DECLARED volatile path is replaced by **one
  marker for the whole set**, so the volatile files' content, name **and count** are all left out. That last part
  is measured, not assumed: a backup file is named with `generateTimestamp()`, and two settings saves in the same
  second overwrite one another, so the pinned server's own boot can write two backups in one build and one in the
  next. The first version kept one masked line per file (preserving the count) and the first Linux CI run of the
  gate failed determinism with 12 differing paths, 0 undeclared and different normalised digests for exactly that
  reason. The raw digest still covers every byte, and `differingPaths` / `undeclaredDifferences` in the report
  still name every volatile file and still fail the check if anything outside the declared patterns moves.

The declarations are data in the report (`tree.volatilePathPatterns` + reasons), not prose:

| declared volatile path | reason (pinned source) |
|---|---|
| `data/_storage/*` | account records carry a wall-clock `created` value (`src/endpoints/users-admin.js`) |
| `data/cookie-secret.txt` | random cookie secret generated at boot (`src/users.js`) |
| `data/<handle>/groups/*.json`, `data/<handle>/group chats/*.jsonl` | a group id is `String(Date.now())` and names both files (`src/endpoints/groups.js`) |
| `data/<handle>/backups/*` | settings backups are named with `generateTimestamp()` (`src/endpoints/settings.js`) |
| `data/**/stats.json` | per-user statistics carry the wall-clock collection time |
| `data/**/image-metadata.json` | background metadata carries a wall-clock `addedTimestamp` |
| `data/_webpack/**`, `data/_cache/**`, `data/_uploads/**` | the pinned server's regenerable build/disk caches and multer's temp directory; excluded from the qualified tree and listed so the exclusion is explicit |

Everything else is deterministic: names, marker text, send dates, the chat a card is bound to, the preset
document and the PNG pixels (the deterministic encoder from `tools/longlived/corpus-lib.mjs`) are chosen by
the generator; the pinned server's own re-encodes of them are byte-stable. `--verify-deterministic` builds the
tree **twice with the same seed** and refuses unless (a) the normalised digests match and (b) every differing
path is a declared volatile one.

## The round trip, phase by phase

`tools/qualify-node-stock-tree.mjs` (driven by `scripts/qualify-node-stock-tree.sh`) copies the recorded tree
into a qualification workspace and runs:

1. **0-tree** — the tree matches its manifest (`tree.matchesItsManifest`) and the copy is byte-identical; the
   generator's claims are checked (API-created surfaces present, seeded and prepared items labelled, pinned
   checkout clean before and after).
2. **1-gotavern-reads** — GoTavern boots on the tree. For every surface it reads through its own routes and
   compares against the recorded bytes: settings (incl. unknown keys, extension state, global regex, variables),
   characters (task fields, alternate greetings, scoped regex, unknown extensions, chat binding), the chat
   (message count, swipes/swipe_id, variables, unknown metadata), the world book (entries, unknown extensions),
   the group + group chat, the preset list and preset document, and Quick Replies.
3. **2-gotavern-mutates** — GoTavern writes through its own API: appends a chat message, adds a swipe and
   selects it, saves settings (a new top-level key plus an edited NESTED unknown key), edits a character
   (description marker, preserving greetings/extensions/chat binding), and edits the world book (new entry).
   Every write is read back through GoTavern.
4. **2b-gotavern-restarts** — a second boot must read all of the above (durability across a process boundary),
   then mutates again.
5. **3-pinned-reads-go / 3b-pinned-continues** — the pinned Node server boots on the SAME tree. It reads every
   Go-written marker (chat appends, swipe, card edit, world entry, settings keys, unknown keys) and then
   **continues**: it appends a turn through its own `/api/chats/save` and saves a settings key.
6. **4-gotavern-reads-node** — a final GoTavern boot reads the pinned Node mutation.
7. **5-verdict** — the report says `match` only if every assertion passed.

Between phases the driver asserts **tree preservation**: for every file that is not a declared mutation target
or a declared runtime stamp, the bytes, size and mode are identical; nothing is deleted; every file created is
in the declared allowlist (each entry carries its reason); the extension tree is untouched; no file recorded
with bytes becomes empty; every `.json` parses and every `.jsonl` line parses. The permission lists
(`GO_BOOT_CREATED`, `PINNED_BOOT_CREATED`, `BOOT_VOLATILE_CHANGED`, `RUNTIME_CACHES`) are printed into the
report with their reasons, so a later reader can see exactly what was allowed to change.

## Reproduce

```sh
# 1. the pinned checkout must exist and have dependencies installed (read-only for this gate)
cd ../SillyTavern && npm ci && git rev-parse HEAD   # 06bde939fb1e9c4c8d8641d810f0a916b5bce127

# 2. generate the tree twice, compare the normalised digests, then run the full round trip
scripts/qualify-node-stock-tree.sh --pinned ../SillyTavern --verify-deterministic --keep

# 3. or qualify an already-generated tree (fast iteration; a tree without its manifest is refused)
node tools/build-node-stock-tree.mjs --pinned ../SillyTavern --out /tmp/tree \
  --report /tmp/tree.report.json --manifest /tmp/tree.manifest.json --verify-deterministic
scripts/qualify-node-stock-tree.sh --pinned ../SillyTavern --tree /tmp/tree --manifest /tmp/tree.manifest.json --keep
```

On Windows run the shell script from Git Bash, or call the Node driver directly (the driver is
cross-platform; only the graceful-stop claim is POSIX-only). CI runs the same script on
`ubuntu-latest` in [`.github/workflows/node-stock-tree.yml`](../.github/workflows/node-stock-tree.yml), which
uploads the tree hash report, the per-file manifest and the round-trip report.

## Measured results

Measured on the Windows development host (Layer A evidence; **the Linux CI job is the gate**):

| measurement | value |
|---|---|
| tree | 1,044 files, 95,947,096 bytes (a Linux run measured 1,045 files / 95,999,064 bytes; the pinned server's own cache/uploads area varies by host) |
| raw digest | per run (declared volatile values are real timestamps and ids) |
| normalised digest | Windows measurement after the count-masking fix: `0ae3033b124fefbd76066735401e120392cb7668708cbb78cb1408ced188ce91`; it is the determinism identity, not a committed fixture |
| determinism self-check | normalised digests identical, raw differs, 12 differing paths (all declared volatile), 0 undeclared, declared patterns matched at least one file |
| round trip | `match`, every assertion green (see the report) |
| pinned checkout | `git status --porcelain` empty before and after generation |

## Teeth: the gate can go red, and was observed doing it

A harness that cannot fail is rejected. Two product mutations were executed against the real round trip: the
product source was backed up by file copy, the mutation applied, a binary rebuilt from the mutated source, the
gate run against the recorded tree, the assertion that fired recorded, the source restored from the copy
(sha256 compared before/after) and the gate re-run green.

| # | mutation (source file) | assertion that fired | observed detail | proves |
|---|---|---|---|---|
| 1 | settings save re-serialises through a map and drops the unknown top-level key `node_origin_legacy_state` (`internal/startup/settings_json.go`) | `goWrite1.settingsNestedUnknownKeyRetained` | `null` (the key was gone from the document GoTavern read back) | unknown-key preservation is a real assertion, named, not a property of the fixture |
| 2 | chat save omits the `swipes` member of every message (`internal/server/chats.go`) | `goWrite1.chatSwipeReadBack` | `{"swipeId":null,"alternatives":null}` | the swipe/`swipe_id` round trip is asserted; a save that keeps only the visible text is caught |

After both restores the gate re-ran green: `ROUND TRIP: match -- 194 assertion(s), 0 failed`.

The exact commands, for reproduction:

```sh
# mutation 1: patch internal/startup/settings_json.go so FormatSettingsJSON deletes
# "node_origin_legacy_state" after marshalNodeJSONIndent, then:
go build -trimpath -o /tmp/gotavern-mut-a ./cmd/gotavern
scripts/qualify-node-stock-tree.sh --pinned ../SillyTavern --tree <recorded tree> \
  --manifest <recorded tree>.manifest.json --gotavern /tmp/gotavern-mut-a --work /tmp/mut-a
#   -> FAIL goWrite1.settingsNestedUnknownKeyRetained -- null
# restore the file from the copy, rebuild, re-run: match

# mutation 2: patch internal/server/chats.go so serveChatsSave calls
# message.deleteMember("swipes") for each message before marshalling, then run the same way:
#   -> FAIL goWrite1.chatSwipeReadBack -- {"swipeId":null,"alternatives":null}
```

## Limits, stated so a green is read as no more

- **The Linux CI job is the gate; this lane does not push.** The run ids cited in a release record must be
  produced by a CI run at the frozen commit. A Windows green is Layer A evidence only.
- **Graceful shutdown is POSIX-only.** Windows cannot deliver SIGTERM to a console process, so the Windows stop
  is abrupt and its restart is a crash-recovery restart. The report records which mode ran
  (`stops.*.mode`) instead of claiming a pass.
- **No provider request is made.** The tree pins its provider at a closed loopback port; "continue" means
  pinned's own chat-save route appended and persisted a turn, not that a model answered. Provider-wire
  parity is a different gate (`docs/compatibility-matrix.json` rows `providers-*`).
- **`data/_webpack`, `data/_cache` and `data/_uploads` are excluded and counted.** A pinned boot writes its own
  build/disk caches under the data root; they are regenerable, are not user data, and are named in the report
  rather than silently ignored.
- **The run config is a qualification config**, not the config a user ships: extensions are not loaded and the
  provider is pinned. The DATA is the recorded artifact; the config is a labelled input.
- **A seeded extension is not an executed extension.** The third-party directory exists so "the extension tree
  is untouched" is not vacuous; nothing claims its JavaScript ran.
- **Character variables have no pinned storage in 1.19.** Variable state is chat-scoped
  (`chat_metadata.variables`) and global (`extension_settings.variables.global`); both are API-created here.
  There is no character-scoped variable store to record, so none is seeded.
- **This gate IS a required release gate as of alpha.15** (`docs/release-manifest.json`, manifest entry
  `GoTavern Node stock tree round trip`). The entry requires a `workflow_dispatch` run at the candidate SHA, the
  `node-stock-tree` JOB completed/success, the fixed-name `node-stock-tree-evidence` artifact unexpired, and the
  `release-evidence.json` member inside it: `kind: gotavern-node-stock-tree-evidence`, the embedded head SHA equal to
  the candidate, `roundTripOk: true` and the tree/manifest SHA-256 digests. The workflow uploads that artifact on
  push runs too, which is why the manifest's required event (dispatch) is load-bearing: a push run must not be able
  to masquerade as release evidence (scripts/verify-release-gates.mjs enforces the event, job, artifact and embedded
  content rails; scripts/release-governance.test.mjs has a fabricated-API negative control for each).
