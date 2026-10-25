# Drop-in qualification: the packaged artifact against a stock SillyTavern tree

This file documents the gate that `AGENTS.md` rules 23, 34 and 38 require and that nothing in this
repository executed before it: the **packaged** release, unpacked into a **stock SillyTavern tree**, started
the way a user starts it.

Two gates run `scripts/qualify-dropin.sh`:

| gate | when it runs | what its artifact is |
|---|---|---|
| `.github/workflows/release-qualification.yml` job `qualify-dropin-linux` | a `v*` tag or a manual dispatch | the published archive when one exists for the ref, otherwise an archive packaged in that same run |
| `.github/workflows/dropin-qualification.yml` job `dropin-current-head` | **every push to `main`** (and to `lane/**`, so a lane can produce the red runs that prove it can fail), plus a dispatch | an archive assembled in that run **from the pushed commit**, with `release.yml`'s staging -- see "Packaging fidelity" below for exactly what that does and does not reproduce |

The first gate answers "may this release ship". The second answers "does the binary this commit builds
still boot in a stock tree", which is the question nobody could answer before it existed: the only recorded
drop-in run (40153128342) measured an archive built from a commit that three P0 fixes (P0-A provider
transport, P0-B unbounded startup waits, P0-C ambiguous auto-update) have since replaced.

Nothing in this file is a claim that has not run; where a behaviour is unproven it says so, and every
measurement below names the run id it came from.

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
`scripts/qualify-dropin.sh` three times (both Linux layouts, plus `cwd-root` with a used config);
`.github/workflows/dropin-qualification.yml` job `dropin-current-head` runs it **four** times on every push,
once per layout × config-mode combination. Each run:

1. builds the stock tree;
2. hashes `extensions/**`, every extension's `git status`, all of `data/**` and `src/tokenizers/**`;
3. unpacks the **packaged archive** and lays it over the tree root, exactly as a user copies a release into
   their directory (the script asserts the archive carries no `config.yaml`, `data/` or `extensions/`, and
   prints which of `src/tokenizers`, `public`, `default`, `config.yaml` the archive carries);
4. boots it with a hard **30 s readiness bound that polls** -- `/version` answering, or the
   `startup.ready` stage marker when it exists. It never sleeps and then assumes (rule 33);
5. on timeout, sends `SIGQUIT` for a goroutine dump, prints the whole log, and reports **the startup stage
   lines the boot printed**. Red run 40174700084 shows the dump working: `goroutine 1 ... [sleep]` with
   `time.Sleep` -> `main.runServer` -> `main.main`, then `--- the dump above names the blocked frames ---`.
   The stage trace landed on `main` while this lane ran (`ae12200`, `internal/app/startup_trace.go`); the
   harness now requests it explicitly with `GOTAVERN_STARTUP_TRACE=1`, because the tracer is **quiet by
   default** (it prints a stage only when that stage took 200 ms or more), and it counts **both** the
   tracer's format (`gotavern: startup stage <name> took ...`) and the `startup.begin`/`startup.ready`
   spelling that `docs/startup-state-machine.md` section 5.2 proposed, so neither format can leave the tally
   at zero while a trace is present. Every run prints
   `startup stage lines in the boot-1 log: N` -- reported, not asserted: the drop-in contract is that a stock
   tree boots and serves, not that the binary narrates its startup;
6. runs an API smoke through the browser's real CSRF handshake: `/api/settings/get`,
   `/api/characters/all`, `/api/chats/get`;
7. asserts the extension repositories and the seeded data are unchanged by boot (declared volatile paths
   excluded and printed);
8. stops it with `SIGTERM` under a bound, restarts it, and re-reads the chat.

### What the per-push gate (`.github/workflows/dropin-qualification.yml`) adds

The harness is the same file, so the two gates cannot drift in what they assert. Four things are different:

1. **The artifact is built from the pushed commit, in the run.** `go build -trimpath -ldflags="-s -w -X
   main.version=dropin-<commit>"`, then `release.yml`'s own staging steps, then `release.yml`'s own packer
   (`tar -czf ... -C stage .`). The version string names the COMMIT rather than a tag, so `BUILD-INFO.txt`
   and `gotavern version` name the tree that was measured. The file is called
   `gotavern-linux-amd64-dropin.tar.gz` so it cannot be mistaken for the shipped asset.
2. **The archive's layout is asserted before anything boots**: the top level must be exactly
   `BUILD-INFO.txt LICENSE THIRD_PARTY_NOTICES.txt gotavern src start.sh`, `gotavern` and `start.sh` must be
   executable, and `src/tokenizers` must carry as many files as `upstream/tokenizers` does (counted, not
   typed). The expected list is a **transcription** of `release.yml`'s staging and that is the one drift
   surface this step has: if `release.yml` starts staging something else, this gate is measuring a layout
   that no longer ships, and the failure message names both lists.
3. **All four combinations run**, not three: `cwd-root` and `foreign-cwd`, each with `--config full` and
   `--config minimal`. `--config minimal` is the only input that makes startup merge the pinned defaults
   back into a used config, which is P0-C's mechanism.
4. **It has its own budget.** Separate concurrency group (superseded pushes are cancelled) and its own
   `timeout-minutes: 15`, sized from the measured run: **49 s door to door** (40173675219) -- checkout +
   toolchain 14 s, archive build 17 s, the four scenarios 4 s, 3 s, 3 s, 2 s. It is a separate workflow
   rather than a job in `ci.yml` because `ci.yml` triggers on `main` only, so a gate inside it could never
   be shown RED before it judged anything, and because `verify` measures itself at 3.6 min inside a
   30-minute bound that four stock-tree builds and eight boots should not share.

### The four layouts and what each one claims

| layout | how it runs | what it proves |
|---|---|---|
| `cwd-root` (Linux) | CWD = the tree | the documented "put the binary in your SillyTavern directory" path: the user's own characters, chat and settings are what the API returns |
| `foreign-cwd` (Linux) | binary in the tree, CWD elsewhere | **measured**, not derived: the runtime root FOLLOWED THE TREE, so this layout proves a user who launches from another directory still gets their own config/data -- and it does not modify any pre-existing file while doing it. See the note below, because this contradicts `docs/startup-state-machine.md` section 4 |
| Windows archive, CWD = root | **not implemented in this change** | -- |
| Windows archive, foreign CWD | **not implemented in this change** | -- |

**Measured divergence from `docs/startup-state-machine.md` section 4.** That table lists `CWD` as the
input that selects "which config/data tree is used". On the shipped layout it does not: under a foreign
CWD the API returned the tree's seeded character (`Seraphina`) and its 3-line chat, and the boot created
`_storage/<hash>`, `content.log`, `cookie-secret.txt` and a settings backup **inside the tree**. The
runtime root followed the install root. That is the better behaviour for a drop-in user and it is what the
gate now asserts; the document's claim is what needs correcting, and it is reported rather than silently
edited here.

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
| `BUILD-INFO.txt` | absent | names the tag in a published archive (and the COMMIT in the per-push gate's archive) and carries the binary's own `gotavern version` output |
| config / data / extensions | live in the checkout | deliberately absent, and asserted absent |

## Packaging fidelity: what the per-push gate's artifact is, and what it is not

The gate must run on a commit, and no release archive exists for a commit. So it assembles one, and the
point of this table is that "assembled the way a release does" is a claim about **steps**, not about
authorship: `release.yml` remains the only producer of shipped bytes.

| `release.yml` step | reproduced by `dropin-current-head`? |
|---|---|
| `go build -trimpath -ldflags="-s -w -X main.version=<tag>"` | **yes**, with `main.version=dropin-<commit>` instead of the tag, so the measured binary names its commit |
| staging: `LICENSE`, `THIRD_PARTY_NOTICES.txt`, the launcher, `src/tokenizers`, `BUILD-INFO.txt` | **yes**, same file set, asserted by name |
| `tar -czf "${ARCHIVE}" .` from the stage directory | **yes**, the same invocation |
| `checksums.txt` (`sha256sum *.tar.gz *.zip`) | **no** -- the sha256 is printed into the run log, but no checksums file is produced, uploaded or consumed |
| six-platform matrix (linux arm64, darwin amd64/arm64, windows amd64/arm64 `.zip`) | **no** -- only the linux/amd64 asset is built and opened |
| `actions/upload-artifact` + `publish` (`gh release create`, prerelease channel classification) | **no** -- nothing is uploaded to a release or published |
| `install.sh` / `install.ps1` | **no** -- `release-qualification.yml` runs both against a loopback mirror; running them per push would pay for the same claim twice |
| the Windows archive and `Start.cmd` at runtime | **no** -- the harness is a POSIX shell script, and the Windows twin does not exist |

So a green run of this gate is evidence about the **archive layout plus the binary** in a stock tree. It is
not evidence about the release pipeline, and no run of it is described here as "the release archive".

## Measured results

### The per-push gate, against the binary built from `main`

Run **40173675219** (`GoTavern drop-in qualification`, commit `eb6a674`, green) ran all four combinations
against an archive assembled from that commit (60,357,274 bytes, sha256 `563b22bf…`, top level
`BUILD-INFO.txt LICENSE THIRD_PARTY_NOTICES.txt gotavern src start.sh`, 23 tokenizer files = the vendored
baseline):

| scenario | checks | notable measurements |
|---|---|---|
| `cwd-root` / `full` | 13 passed | ready via the `/version` poll in well under a second; settings 21 keys; 1 character (`Seraphina`); chat 3 lines; every extension repository's `git status` unchanged; no non-loopback socket; graceful stop in 0 s; restart; chat persisted; **0 pre-existing files modified or deleted**, 7 created (all on the declared list); **config.yaml NOT rewritten**; `extensions/**` byte-identical |
| `cwd-root` / `minimal` | 13 passed | the boot **rewrote config.yaml, +158 lines** (the declared `mergeDefaults` behaviour) and the rewritten file still had **`extensions.autoUpdate: false`**: the user's explicit value survived the merge, so the P0-C mechanism does not flip it on this path |
| `foreign-cwd` / `full` | 12 passed | the tree was the runtime root (the API returned the tree's character and its chat), and no pre-existing file was modified or deleted |
| `foreign-cwd` / `minimal` | 12 passed | the same, with a used/trimmed config under a foreign CWD |

**The current tree PASSES the drop-in qualification.** That is the answer this gate was built to produce,
and the specific lines that show it are, in `cwd-root/full`: `ok: became ready within 30s via /version
answered`, `ok: character list readable (1 character(s): Seraphina)`, `ok: chat readable (3 lines, the
seeded synthetic chat)`, `ok: no pre-existing user file was modified or deleted by two boots and a restart`,
`ok: config.yaml was NOT rewritten by two boots`, `=== layout cwd-root: 13 checks passed ===`; and the same
shape for the other three combinations.

### The release-tag gate, historically

Run **40153128342** (`GoTavern Lane CI`, `lane/release-dropin`, green) executed three scenarios against an
archive packaged with `release.yml`'s staging:

| scenario | checks | notable measurements |
|---|---|---|
| `cwd-root`, pristine pinned config | 13 passed | ready via the `/version` poll inside the bound; settings 21 keys; 1 character (`Seraphina`); chat 3 lines; every extension repository's `git status` unchanged; no non-loopback socket; graceful stop; restart; chat persisted; **0 pre-existing files modified or deleted**, 7 created (all on the declared list); **config.yaml NOT rewritten** |
| `foreign-cwd` | 12 passed | the tree was the runtime root (API returned the tree's character and chat); only creations, no pre-existing file changed |
| `cwd-root`, used/trimmed config | 13 passed | the boot **rewrote config.yaml, +158 lines** (section 3's declared `mergeDefaults` behaviour) and the rewritten file still had **`extensions.autoUpdate: false`** -- the user's explicit value survived the merge, so the P0-C mechanism did not flip it on this path |

### Can this gate fail? Two red runs, recorded

A gate that cannot fail is decoration, so the readiness assertion was mutated twice on this lane branch.
Both mutations are reverted; the final tree carries neither.

| # | run id | what was mutated | the assertion that went red | what it proves |
|---|---|---|---|---|
| 1 | **40173962429** (commit `2d0a297`, red; Lane CI 40173962403 on the same commit stayed GREEN) | harness-side: `wait_ready()` returns 2 immediately, so the poll never observes a signal from a server that was in fact ready | `FAIL: the drop-in binary did NOT become ready within 30s (layout cwd-root). Not retried with a longer bound: rule 33.` | the readiness assertion and its hard bound are real, and the failure carries the log and the stage-trace finding instead of an exit status |
| 2 | **40174700084** (commit `af6f2bb`, red) | product-side: `time.Sleep(45 * time.Second)` in `cmd/gotavern/main.go` before `app.Start`, so the BINARY itself never reaches "listener ready" inside the bound | the same `FAIL: ... did NOT become ready within 30s ...`, with the bound actually elapsed (30.85 s of polling) | the gate catches the P0-B shape on the real path, and the diagnosis works: `SIGQUIT` produced a dump whose `goroutine 1 ... [sleep]` frames name `time.Sleep` -> `main.runServer` at `cmd/gotavern/main.go:177` -> `main.run` -> `main.main`, followed by `--- the dump above names the blocked frames ---` |

### Green on the tree that will land

Both red runs were produced on the lane's own commits. After them, the lane merged the `main` it had
branched from -- twice: origin/main `b00bd31` (whose `cd2ce1c` changes the boot path the `foreign-cwd`
layout exercises) and origin/main `ae12200` (the startup stage trace) -- and re-ran everything on each
merged tree, because a green measured on a pre-merge snapshot is not a green for the commit that lands:

- **run 40175106642** (commit `5143151`, green): all four combinations on the first merged tree, same
  results as 40173675219 -- 13 / 13 / 12 / 12 checks, scenarios 2 s, 3 s, 2 s, 3 s, `user data: 198 files
  before, 205 after (0 modified, 0 deleted, 7 created)`.
- **run 40175731050** (commit `21e529b`, green): all four combinations on the tree that also carries the
  startup stage trace, with 13 / 13 / 12 / 12 checks again, and the new measurement on every scenario:
  `startup stage lines in the boot-1 log: 5 (requested with GOTAVERN_STARTUP_TRACE=1; ...)`. Five, not
  seventeen: the tracer prints the stages it instruments, and this is what it printed on a green boot.
- **run 40175731068** (`GoTavern Lane CI`, same commit, green): the Go suite and the lane's other checks on
  the same tree.

The run that follows this document's last edit differs from 40175731050 only in this file; its id is in the
lane report, because a commit cannot name the run it triggers.

**What run 1 taught, and why a third run was needed.** Run 40173962429 also printed `(SIGQUIT produced no
goroutine dump in the log)`, which looked like a harness defect: a hang that cannot name its frames. It was
not. Because the mutation returns from `wait_ready` immediately after `start_server`, the harness signalled a
process 50 ms old (that diagnosis group lived 0.25 s and the server log was **empty**), and no real hang
looks like that -- `wait_ready` polls for the full bound first. An interim commit (`e664c81`) changed
`diagnose_hang` to fall back from SIGQUIT to SIGABRT on that evidence; it was **reverted** in `af6f2bb` and
run 2 then showed the original SIGQUIT path producing a complete dump. A driver that reports the absence of
an outcome while driving the subject in a state a real caller cannot reach is a probe defect until proven
otherwise (verification rule 10), and this is that rule paying for itself.

Two things the green run did **not** find, stated because a gate's silence is only meaningful when it is
specific: the artifact did **not** hang against a stock tree built from the pinned defaults (in every scenario
the boot answered `/version` on the first polls, never approaching the bound), and the boot did **not**
modify or delete a single pre-existing user file. So the reported P0-B hang is **not** reproduced by this
fixture. The states this fixture does not yet model, in the order they are worth testing next, are: a stock
tree whose `config.yaml` has been run through the rewrite path *and* whose `data/` is large (scaling
`InitializeUserStorage`), a tree with a stale lock file from a crashed process (W1-W9, the only unbounded
waits in the chain), and a Windows tree, where file-locking semantics differ.

## Limits, stated so a green is not read as more

- The per-push gate's artifact is assembled in the run from `release.yml`'s **steps**; it is not the release
  workflow's output. The rows of "Packaging fidelity" above are the whole list of what it skips.
- Its archive-layout assertion compares against a **transcription** of `release.yml`'s staging. A change
  there must update both, and the failure message says so.
- Updater **egress** is sampled (two socket samples), not proven absent; the **mutation** half of the same
  requirement is proven exactly by hashes and `git status`. A network-namespace boot would close the rest.
- The tag-time job's artifact is the published archive when one exists for the ref, and an archive packaged
  in the same run with `release.yml`'s exact staging otherwise -- qualification runs before the release
  exists. The job **prints which one it used**. `release-install-smoke.yml` is the gate that always has the
  shipped bytes.
- Only the Linux archive is executed, by either gate. The Windows artifact is never opened.
- The tree is derived from the pinned source, not recorded from a pinned Node run: it reproduces what the
  pinned placement rules say a seeded tree looks like, which is a labelled derivation (verification rule 4).
- A hang is reported by the harness's own `SIGQUIT` dump, and now also by the binary's stage trace, which
  the harness requests (`GOTAVERN_STARTUP_TRACE=1`). What is still true: the tracer's output is a
  **slow-stage** report, so a stalled stage names itself only once another stage completes or the tracer's
  `Close` prints the open stage -- the harness reads whatever the binary prints and has no way to make it
  print more.
