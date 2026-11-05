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

## What the harness will prove (and what it will not)

Planned, tracked by `GOAL.md` §14 and the qualification workflow:

1. the tree boots under GoTavern with every pre-existing byte unchanged (the `Manifest.Files` digests are
   the assertion), and the frontend reaches its cards, chats, worlds, presets and settings through the
   routes it uses;
2. a browser-driven differential against pinned Node on the same tree: send, regenerate, swipe, continue,
   group turn, world-info trigger, preset switch, settings save - with the provider-wire bodies compared
   byte-for-byte;
3. Node → Go → Node hand-back on this tree after Go writes (chat, swipe, settings, character/world edits);
4. migration from the legacy flat layout and rollback of a failed update;
5. failure paths: corrupt JSON, read-only data root, interrupted write - each refuses without damaging
   the tree.

**It will not prove §14.** The instance is synthetic: no real user's prose, no real extension
configuration, no real accident of history. What it proves is that the machinery survives a tree with the
right *shape* at the right *scale*; a real long-used tree remains the open item, and every document that
mentions this fixture says so.
