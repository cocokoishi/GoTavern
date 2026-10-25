# Drop-in qualification: the packaged artifact against a stock SillyTavern tree

This file documents the gate that `AGENTS.md` rules 23, 34 and 38 require and that nothing in this
repository executed before it: the **packaged** release, unpacked into a **stock SillyTavern tree**, started
the way a user starts it.

Measured evidence lives in the CI run named in the lane report and in `.github/workflows/
release-qualification.yml`'s `qualify-dropin-linux` job. Nothing in this file is a claim that has not run;
where a behaviour is unproven it says so.

## Why the gate exists

A user took a published release, put the binary into a working SillyTavern directory, started it, and it
hung (`P0-B`). No gate could have seen it:

| gate | what it starts | why it could not reproduce the report |
|---|---|---|
| `release-qualification.yml` `qualify-linux-amd64` | an archive it built itself, unpacked into a directory it created | no `config.yaml`, no `data/`, no `public/`, no extensions: an empty install, not a used tree |
| `release-install-smoke.yml` | the published archive, installed into an empty prefix | same emptiness, plus `install.sh` writes a fresh launcher and prefix |
| `docker.yml` | the image | a different artefact and a different filesystem root |
| startup differential (`tests/oracle/sillytavern-1.19.0-fresh-start.json`) | GoTavern over an empty runtime root | no pre-existing user data, no existing config |

`docs/startup-state-machine.md` §1 explains why the resulting hang was unreadable: `cmd/gotavern/main.go`
prints nothing between `main()` and "listener ready", so a wait anywhere in the 17-step startup chain looks
identical to a wait anywhere else, and §2 names eight unbounded `flock` acquisitions plus one unbounded
resolver call in that chain.

## The stock tree

`scripts/build-stock-tree.sh <target>` builds it. It copies only bytes that are already in this repository's
vendored pinned baseline, so the tree is derived from the pinned source rather than hand-written:

| area | contents | provenance |
|---|---|---|
| `public/**` | 592 files | `upstream/public` verbatim (a stock tree keeps the frontend on disk; the release archive does not ship it) |
| `default/**` | 200 files | `upstream/default` verbatim |
| `src/tokenizers/**` | 23 files | `upstream/tokenizers` verbatim -- a stock SillyTavern tree already keeps them at this path |
| `config.yaml` | 1 file, 16,394 bytes | `upstream/default/config.yaml` **verbatim**: this is what SillyTavern's postinstall writes, so it is a stock config. It keeps `extensions.autoUpdate: true` and `enableServerPluginsAutoUpdate: true` from the pinned defaults on purpose -- that is the state a user's tree is in, and the job asserts boot does not act on it (rule 26) |
| `data/default-user/**` | seeded from `default/content/index.json` | the pinned placement rules: `src/endpoints/content-manager.js:326-368` (`getUserTargetByType`), directory names from `src/constants.js:15-46` (`USER_DIRECTORY_TEMPLATE`), global content from `:374-386` (`getGlobalTargetByType`) |
| `data/_errors/**`, `data/_css/user.css` | 5 files | pinned global content (same rules) |
| `public/scripts/extensions/third-party/stock-example-extension/` | a **real git repository**, one commit | required so the no-mutation assertion has a repository to run `git status` against; an empty directory would make that assertion vacuous (rule 7) |
| `plugins/.gitkeep` | 1 file | stock SillyTavern ships this directory |
| `data/default-user/chats/default_Seraphina/dropin-smoke.jsonl` | 3 lines | **synthetic**, labelled `"synthetic": true` in its own header: two invented messages in the pinned JSONL shape |

The 169-entry content index is parsed by `python3` and the count is **asserted**. If a baseline bump changes
the index, the script refuses rather than quietly seeding a smaller tree (rule 11).

### What was removed, and why

- **All credentials.** `data/default-user/secrets.json` is written as the empty current-shape object `{}`.
  No API key, token or password exists anywhere in the tree.
- **User history.** No account store (`data/_storage/`), no access log, no statistics file, no settings
  backup, no uploads. None of them is needed to prove the drop-in boots, and all of them are personal data.
- **Anything that is not an installation.** No `node_modules/`, no SillyTavern `.git/`, no pinned
  `src/**` server sources: a GoTavern target has no Node (rule 5), and shipping them would make the tree a
  checkout rather than an installation.
- **No real character, chat or world info authored by a person.** The shipped character card, world info
  and presets are the pinned *defaults* that SillyTavern itself seeds; the only chat is the synthetic one
  above.

## What the job does

`.github/workflows/release-qualification.yml` job `qualify-dropin-linux` runs
`scripts/qualify-dropin.sh` twice, once per Linux layout:

1. builds the stock tree;
2. hashes `extensions/**`, every extension's `git status`, all of `data/**` and `src/tokenizers/**`;
3. unpacks the **packaged archive** and lays it over the tree root, exactly as a user copies a release into
   their directory (the script asserts the archive carries no `config.yaml`, `data/` or `extensions/`, and
   prints which of `src/tokenizers`, `public`, `default`, `config.yaml` the archive carries);
4. boots it with a hard **30 s readiness bound that polls** -- `/version` answering, or the
   `startup.ready` stage marker when it exists. It never sleeps and then assumes (rule 33);
5. on timeout, sends `SIGQUIT` for a goroutine dump, prints the whole log, and reports **whether a stage
   trace exists at all** -- at the commit this gate was written, none does, so a hang cannot yet name
   itself;
6. runs an API smoke through the browser's real CSRF handshake: `/api/settings/get`,
   `/api/characters/all`, `/api/chats/get`;
7. asserts the extension repositories and the seeded data are unchanged by boot (declared volatile paths
   excluded and printed);
8. stops it with `SIGTERM` under a bound, restarts it, and re-reads the chat.

### The four layouts and what each one claims

| layout | how it runs | what it proves |
|---|---|---|
| `cwd-root` (Linux) | CWD = the tree | the documented "put the binary in your SillyTavern directory" path: the user's own characters, chat and settings are what the API returns |
| `foreign-cwd` (Linux) | binary in the tree, CWD elsewhere | pinned resolution is CWD-relative, so this starts a fresh runtime under the foreign directory. It must still become ready, and it must NOT write into the tree it was not pointed at |
| Windows archive, CWD = root | **not implemented in this change** | -- |
| Windows archive, foreign CWD | **not implemented in this change** | -- |

The Windows halves are named as unimplemented rather than assumed: `Start.cmd`, backslash paths and a
Windows runner need a PowerShell twin of the same harness, and shipping that harness unexecuted would be a
claim without evidence (rule 36).

## What the packaged artifact does differently from a source build

The differences this job exists to observe. Each is printed by the harness from the artefact under test:

| item | source build (`go build ./cmd/gotavern`) | packaged archive |
|---|---|---|
| `public/**` | read from the install root on disk | not shipped; the runtime reads whatever `public/` is beside it, which in a stock tree is the user's own copy |
| `src/tokenizers/**` | read from `upstream/tokenizers` in a checkout | shipped inside the archive at `src/tokenizers`, the same path a stock SillyTavern tree uses |
| `default/**` | present in the checkout | not shipped; the runtime needs the tree's `default/` |
| launchers | none | `start.sh` / `Start.cmd`, which `cd` to their own directory |
| `BUILD-INFO.txt` | absent | names the tag and carries the binary's own `gotavern version` output |
| config / data / extensions | live in the checkout | deliberately absent, and asserted absent |

## Limits, stated so a green is not read as more

- Updater **egress** is sampled (two socket samples), not proven absent; the **mutation** half of the same
  requirement is proven exactly by hashes and `git status`. A network-namespace boot would close the rest.
- The artifact is the published archive when one exists for the ref, and an archive packaged in the same run
  with `release.yml`'s exact staging otherwise -- qualification runs before the release exists. The job
  **prints which one it used**. `release-install-smoke.yml` is the gate that always has the shipped bytes.
- Only the Linux archive is executed. The Windows artifact is not opened by this job.
- The tree is derived from the pinned source, not recorded from a pinned Node run: it reproduces what the
  pinned placement rules say a seeded tree looks like, which is a labelled derivation (verification rule 4).
