# The complex long-lived fixture: a synthetic SillyTavern instance for drop-in qualification

`GOAL.md` §14 requires the strong drop-in claim to be tested against a **real long-used user tree**, and the
repository has never been able to run that (AGENTS.md rule 56 forbids committing a user's data). This
document describes the next best input, built here rather than borrowed: a **very complex, synthetic
SillyTavern instance** that has the shape of a years-old installation, generated deterministically by
`internal/longlivedfixture` and driven by the qualification harness.

It is not a substitute for §14 and must never be described as one. It is the strongest input the project
can own and commit evidence for: everything except "a human actually used it".

## What it contains (measured on the default spec, seed `20261104`)

| part | count / size |
|---|---|
| characters | 32 PNG cards: 12 v2 (`chara` tEXt) + 20 v3 (`ccv3` tEXt), each with alternate greetings, a depth prompt, a world pin, and 8 cards carrying an embedded character book; 6 cards have sprite folders; names include non-ASCII, spaces, `•`, brackets and emoji suffixes |
| chats | 39 JSONL chats: one main chat per character (240 → 2,100 messages, year-spanning timestamps), 7 branch chats (`- branch`), swipes on every 5th assistant message, `is_system` messages, `extra.gen_started/gen_finished`, and a first-line `chat_metadata` record carrying `world_info`, `note_prompt`, `variables` and note settings; every chat also has a `backups/` copy |
| worlds | 8 world books; the largest has 400 entries with secondary keys, regex keys, selective logic 0-3, recursion flags, groups, scan depth, case-sensitivity, sticky/cooldown/delay and every display field; 7 smaller books (20-90 entries) |
| presets | 4 chat-completion presets (the first with 120 prompts, ordered `prompt_order`, sampling fields, reasoning, injection positions) + 4 text-completion presets (instruct input/output sequences, context story string) |
| groups | 3 group chats with 4 members each, `activation_strategy`, `generation_mode`, chat ids and group chat JSONL |
| assets | 5 backgrounds + `backgrounds.json` metadata, 4 personas + `User Avatars/*.png`, 3 themes, 4 quick-reply sets (5 replies each), moving-UI layout, one extension's own state directory, user files/images/assets |
| settings | `settings.json` with power-user state, personas, persona descriptions, tags, extension settings for two extensions, character aliases, current preset/theme, world-info settings; `secrets.json` with a synthetic value; 2 regex scripts; `stats/stats.json` |
| unknown files | `unknown_extension_state.json`, `data.bak`, `Thumbs.db`, a 4 KiB binary blob - files the product has no opinion about and must not rewrite |
| legacy migration input | `public/characters/Legacy_Card.png` + `.json` in the old flat layout, for the migration path |
| config | a realistic long-lived `config.yaml` (`port`, `listen`, `enableIPv4`, `browserLaunchEnabled`, `whitelistMode`) |
| totals | **169 files, 29.25 MB**, built in **2.2 s** on the development host |

The full instance is built for the harness; the same code path builds a small variant (`-small`) so a CI
smoke costs seconds.

## SFW: a hard requirement, enforced

**Every file this generator writes is strictly SFW.** No adult/NSFW text, prompt, image, tag or metadata
is generated, and none may be added: the fixture is committed as evidence and uploaded as a CI artifact.

Enforcement is a test, not a promise (`internal/longlivedfixture/sfw.go`):

- all prose comes from one fixed SFW vocabulary; names come from a fixed list; everything else is
  structural (`SYNTHETIC_*`, `FIRST_MES_*`, numbers);
- `CheckSFW` scans every generated text file for adult/hate/graphic-violence markers (word-boundary,
  case-insensitive) and for external references (URLs, `@handles`, e-mail addresses), because a synthetic
  fixture has no reason to name a real party;
- `TestSFWCheckHasTeeth` plants an adult marker and a URL into a built tree and requires the scan to
  refuse both, so a green scan cannot be vacuous.

The same rule governs the harness's own outputs: artifacts uploaded to Actions must contain only
generated, SFW content.

## Why the generator, not a committed tree

- The 20 pinned third-party extensions are checked out from `tests/browser/third-party-extensions.lock.json`
  and cannot be vendored; a committed tree would be incomplete without them.
- A default-spec tree is ~29 MB of JSONL; committing it would be a megabyte-scale review item that drifts
  from the generator the moment the format changes.
- Determinism is the pin: one seed produces byte-identical files (`TestBuildIsDeterministicForOneSeed`),
  and `Manifest.Files` records a sha256 per path, so evidence can name exactly what was built.

## How to build it

```
go run ./cmd/build-longlived <empty-directory>          # default: the very complex instance
go run ./cmd/build-longlived -small <empty-directory>   # fast smoke, same code path
```

The command prints the manifest as JSON; it refuses a non-empty directory.

## Browser and provider-wire qualification on a very complex corpus

The Go-built instance above is the **route/data-safety** fixture. The **browser + provider-wire**
qualification runs on the repository's synthetic long-lived corpus at `medium` size - a second,
independently generated years-old-shaped instance: 12 characters (CJK/emoji filenames), 6 chats each,
2,400-message long histories with branches, swipes and deleted turns, 8 world books at 300 entries,
5 presets (one byte-identical structure-preserving derivation), 3 groups, backgrounds/avatars/assets/
themes/Quick Replies and legacy carriers.

Evidence: `GoTavern long-lived corpus` run **41943468975** (`workflow_dispatch size=medium`,
`medium-corpus` job, all steps success):

- four legs all completed: Go drive, pinned drive, Go restart, pinned restart - both subjects over
  byte-identical copies of the same corpus, restart required to be a NEW process;
- comparator: **46 checks, 43 match, 0 mismatch, 0 not-observed, 0 harness-error, 3 decided
  exclusions** (`stats.json` write, build-cache backup additions, thumbnail bytes - each named in
  `docs/longlived-corpus.md`);
- guarded properties include provider request BYTES and request COUNT, roster equality, resumed-chat
  identity/length/markers, turn-one/turn-two reply text, preset/world/temperature switches;
- the judge's teeth fired: mutations of provider-body bytes, request count, roster name, chat length and
  preset switch each produced their NAMED mismatch on top of the green baseline;
- tier split, stated rather than implied: the browser driver **refuses `large` by design** (a >100 MB
  corpus with 5,000-message chats would spend an hour loading history without adding an assertion); that
  rail fired for real in run **41944602408**, which failed in ~20 s with the driver's own refusal and was
  then reverted rather than worked around. `medium` is the browser/wire tier; `large` is the
  generator + loader + Go-gate tier;
- residual risks recorded by the run itself: the provider is the recording peer (AGENTS 22), a `large`
  corpus is qualified by generator + Go gate but has no browser drive yet, and the pinned leg needs its
  checkout with `node_modules`.

**Node -> Go -> Node hand-back is green too** (`tests/browser/longlived-qualify.mjs`, hand-back legs).
After the four legs, the driver copies each subject's WRITTEN tree and runs the OTHER subject's
`--phase restart` probe against it: pinned Node reopens and continues a chat that GoTavern wrote, and
GoTavern reopens and continues a chat that pinned wrote. Evidence: `GoTavern long-lived corpus` run
**41956796610** (`workflow_dispatch size=medium`):

- verdict `ok: true` with nine legs, all exit 0: `gotavern-drive`, `pinned-drive`, `gotavern-restart`,
  `pinned-restart`, `handback-pinned`, `handback-gotavern`, `compare`, `teeth`;
- both hand-back legs resumed the other backend's chat (`resumed: true`, `failedSteps: []`), and the two
  user markers the other backend wrote were present - so this is a READ, not bytes on disk;
- comparator: **48 checks, 45 match, 0 mismatch, 0 not-observed, 0 harness-error, 3 decided
  exclusions**, with `handback-pinned-resumed-the-gotavern-tree` and
  `handback-gotavern-resumed-the-pinned-tree` both `match` and `providerContinue: true`;
- the teeth selftest now proves the new checks can fail: 14/14 mutations killed, including
  `handback-lost-markers` and `handback-no-provider-continue`.

What this does **not** cover, stated so a green is not over-read: the drive is a bounded journey
(send/regenerate/swipe/continue/group/preset/world switches), not every possible interaction; the
provider is the recording peer; and a real long-used user tree remains the GOAL §14 item.
## What the harness proves today, and what it will prove next

**Scenario 1 is green** (`tests/e2e/longlived_complex_test.go`,
`TestComplexLongLivedInstanceQualifiesAsDropIn`; `-short` runs the small variant through the same code
path): the default 169-file / 29 MB instance boots under the shipped binary and

1. every planted byte is unchanged afterwards - except **one declared startup mutation**, pinned
   SillyTavern's legacy-secrets migration (`migrateSecrets`), which rewrites `secrets.json` into the v2
   `[{id,value,label,active}]` shape and adds `_migrated`. The test allows that rewrite **only** when
   the migrated document still carries the planted value; any other rewrite fails;
2. the frontend's own routes serve the planted data: all 32 cards listed and each card's PNG served
   byte-identically, `/thumbnail` avatars and backgrounds render, a 240-message history opens (first
   swipe-bearing message, second message, late marker and swipe alternates all present), all 400 entries
   of the largest world book come back, world list / groups / backgrounds / settings carry the preset,
   theme, persona and extension state, and the files the product has no opinion about are untouched.

**Scenarios 2-4 are green too** (`tests/e2e/longlived_complex_writes_test.go`):

- **MIGRATION** (rule 14): a legacy-shaped source (`config.yaml` with a relative `dataRoot`, `data/`, a
  `public/` overlay) migrates with `--dry-run` writing nothing, the source byte-identical afterwards
  (both dry-run and real), every planted data file arriving with the same digest, the config's
  `dataRoot` rewritten while its unknown key survives, and the migrated install booting to serve the
  cards and the world book.
- **UNKNOWN-FIELD PRESERVATION ON WRITE** (rule 11): editing one world entry through
  `/api/worldinfo/edit` keeps `fixtureUnknownField` (a field this project has never parsed) on EVERY
  entry, leaves the other world book byte-identical, and reads the edit back.
- **FAILURE PATH**: a corrupt world file does not stop the boot, the roster and the healthy world still
  serve, the corrupt world is refused with a non-200, and the corrupt bytes are not rewritten.

**Scenarios 5-7: unwritable destination, read-only data root, and a recoverable rollback** (same file):

- **UNWRITABLE DESTINATION** (all hosts): the world file is replaced by a directory, so the write cannot
  happen anywhere; the route answers non-2xx with text, nothing is half-written, `settings.json` and every
  other byte are unchanged, and the roster still answers afterwards.
- **READ-ONLY DATA ROOT** (Linux; Windows skips with the reason declared): `chmod 0555` on the worlds
  directory refuses the write, the tree keeps every byte, and restoring the permission makes the same
  write succeed - the refusal was the permission, not a wedged server. This branch executes in the Linux
  CI job, which is the binding gate.
- **RECOVERABLE FORCED MIGRATION**: `migrate --force` moves the destination's previous state to
  `.migrate-backup/` byte-identically, and that backup BOOTS from a clean root with the previous
  settings served - a rollback an operator can use, not a directory of leftovers.

CI: `GoTavern long-lived corpus` run **41957672562** ran the complex gate (`go test -run '^TestComplex'`,
now seven scenarios) on Linux and passed, including the read-only data-root branch that Windows skips; run
**41955926519** ran the first four scenarios there first. One regex, so a new scenario cannot silently drop
out. Measured locally: full instance 6.1 s; small instance 5.1 s (boot); migration 4.8 s; world write 2.7 s;
corrupt-world 3.2 s; unwritable destination 3.0 s; forced-migration backup 4.3 s.

**The 20 pinned third-party extensions on the complex instance** (`TestComplexWithPinnedThirdPartyExtensions`,
`tools/longlived/install-pinned-extensions.mjs`). The extensions are third-party repositories pinned by
commit in `tests/browser/third-party-extensions.lock.json`; they are **not committed** (licences, sizes, and
rule 56's boundary around third-party payloads), so the lock file is the pin and the workflow materialises
them into a temporary data root exactly the way the pinned install route does:

- discover lists all 20 next to the planted complex data (`[{type:"local", name:"third-party/<name>"}]`);
- every extension's `manifest.json` and its declared `js` entry script is served **byte-for-byte** from
  `<dataRoot>/default-user/extensions/<name>/`;
- the complex roster, world book and the planted `extension_settings` still work with 20 extensions present;
- the only uploaded artefact is the manifest (names, pins, file counts, `manifest.json` sha256) - extension
  content never leaves the CI runner, which is the SFW boundary this document commits to.

SFW statement for this path: the fixture's own text and images stay in the generator's SFW vocabulary; the
third-party extensions are fetched at pinned commits into a temporary directory, never committed, never
uploaded, and only their identity and digests are recorded.

Still open, tracked by the goal:

- a real long-used user tree: synthetic by construction, so this stays the GOAL §14 item below.

**It will not prove §14.** The instance is synthetic: no real user's prose, no real extension
configuration, no real accident of history. What it proves is that the machinery survives a tree with the
right *shape* at the right *scale*; a real long-used tree remains the open item, and every document that
mentions this fixture says so.
