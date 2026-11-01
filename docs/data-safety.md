# Data safety, concurrency and the security baseline (alpha.10 hardening)

Lane: `beta/hardening`, base `main` `d5464eb`. This document records what was **measured**, not what
was intended: every claim below names the command or test that produced it, and the residual risks are
listed rather than implied. Hard rules 12 (sensitive writes are locked and atomic), 28 (existing user
data wins), 29/31/35 (transport and causal errors), 31-35 (reproduce before fixing, no weakened tests,
no masked races, causal/safe errors) and product contract 21-41 are the frame.

The one-line result: **three real defects were found and fixed**, the atomic-replacement mechanism the
product already used was proven against injected full-disk and killed-process faults, all sensitive
user-data writes were audited against pinned's own writers, eight fuzz targets now run in plain
`go test`, and one fuzz finding was measured and **recorded as inherited** instead of being silently
"fixed" into a divergence from pinned.

## 1. What is written where, and what protects it

`internal/startup/content.go:atomicReplace` is the single write primitive: unique temp file in the
target's directory, `chmod` to the target's mode, write, `fsync`, close, `rename` over the target
(retried on Windows sharing violations), then `fsync` the directory. `internal/startup/user_content_file.go`
wraps it in a per-user `flock` critical section (`lockUserContentRoot`), takes the existing bytes,
runs the caller's read-modify-write, and re-checks containment before writing.

| user data | writer | mechanism | crash window | pinned counterpart |
|---|---|---|---|---|
| `config.yaml` create/migrate | `internal/configinit/config.go:atomicWrite` | temp + fsync + rename under `flock` | none (old or new file) | `src/config-init.js:239` `fs.writeFileSync` — **non-atomic**; our atomic write is a recorded product decision (see `config_interrupted_test.go:20-26`) |
| `settings.json` | `startup.SaveSettings` | `flock` + `atomicReplace`; snapshot in the same critical section | none | `src/endpoints/settings.js:209` `writeFileAtomicSync` |
| chat `.jsonl` (save/rewrite) | `server.chats.go:serveChatsSave` / group save / import | `UpdateUserContentFile` (lock + `atomicReplace`) | none | `src/util.js:1517-1522` `tryWriteFileSync` -> `write-file-atomic` |
| character cards (PNG + JSON data) | `server.characters_write.go:writeCharacterCard` | `UpdateUserContentFile` | none | `src/characters.js:259`, `src/charx.js` `writeFileAtomicSync` |
| world info | `server.worldinfo.go:serveWorldInfoEdit/Import` | `UpdateUserContentFile` | none | `src/endpoints/worldinfo.js:130,154` `writeFileAtomicSync` |
| presets (openai/novel/kobold/textgen/instruct/...) | `server.presets.go:servePresetSave`, `startup.saveUserPreset` | `UpdateUserContentFile` | none | `src/endpoints/presets.js:56` `writeFileAtomicSync` |
| image metadata index | `server.backgrounds_*.go`, `image_metadata_*.go`, `sprites_upload.go`, `vector.go` | `UpdateUserContentFile[IfChanged]` | none | `src/endpoints/image-metadata.js` imports `write-file-atomic`; `writeMetadataIndex` is atomic |
| secrets | `startup/secrets_state.go` (locked handle) | `atomicReplace` under the secrets lock | none | `src/endpoints/secrets.js:129,150` `writeFileAtomicSync` |
| avatar / background / sprite uploads | `server.avatars_upload.go:110`, `startup/user_backgrounds.go`, `server/sprites_upload.go:spritesAtomicWrite` | `startup.WriteFileAtomic` / own temp+fsync+rename | none | `src/endpoints/avatars.js:58` `writeFileAtomicSync` |
| image upload (`/api/images/upload`) | `server.images.go:writeUserImageFile` | `startup.WriteFileAtomic` — **fixed in `f584570`**; was `os.WriteFile` | none after fix | `src/endpoints/images.js:72` `fs.promises.writeFile` — **pinned is non-atomic**; hardening recorded in §3 |
| stats (`stats.json`), tokenizer metadata, thumbnails, content log | `startup.WriteFileAtomic` / `atomicReplace` | temp + fsync + rename | none | mixed; derived data, not user-authored |
| chat backups (`backups/chat_*`) | **not implemented** (recorded gap in `server/chats.go:14-21`) | — | — | `src/endpoints/chats.js` throttled `backupChat` |
| access log append | `server/access_log.go:157` `O_APPEND` | append-only log line | a killed process may drop the last line | `fs.appendFile` — same class, not user data |

Verified positives (no change needed, proven by the tests in §2): settings, chats, cards, world info,
presets, index files and secrets all take the per-user lock and publish atomically; the unparseable-data
question for those paths is answered in §5.

## 2. Defects found and fixed (with reproducer and teeth)

### 2.1 P1 — a character rename could delete a chat history after an interrupted copy (`64bc56e`)

`server/characters_write.go:serveCharactersRename` copies `chats/<old>` to `chats/<new>` and then
`os.RemoveAll(oldChatsPath)`. A **direct recursive copy** publishes a partial tree when interrupted
(crash, full disk, unreadable file). The handler answers 500 and keeps the old tree — but the partial
`chats/<new>` remains, and the retry's `os.Stat(newChatsPath)` guard then **skips the copy** and
`RemoveAll`s the complete original. The user's chat history is replaced by the surviving prefix.

Fix: `copyDirectoryAtomically` — copy into a hidden sibling staging directory and publish with one
rename, so the destination is either absent or complete. Pinned has the same hazard
(`src/endpoints/characters.js:1086-1087` `fs.cpSync` + `fs.rmSync`), so this is a deliberate hardening
of a pinned weakness (§3).

Reproducer/guard: `internal/server/data_safety_copy_test.go`
* `TestCopyDirectoryAtomicallyPublishesNothingWhenTheCopyFailsMidway` — injects a failure at the
  per-file step (`copyTreeFile`) halfway through the copy; requires: error returned, **destination
  absent**, no `.gotavern-copy-*` staging leftovers, source byte-identical; then the retry copies
  again successfully.
* `TestCopyDirectoryAtomicallyRefusesAnExistingDestinationWithoutTouchingIt`.

Teeth (mutation: publish the copy directly into the destination, `-count=1`):
`an interrupted copy PUBLISHED a destination tree at .../New Card ... A partial tree here is what
makes the next rename delete the complete original.` — restored from a file copy, green.

### 2.2 P1 — an empty or whitespace-only `config.yaml` failed boot (`021173c`)

Found by the **first seed of the new `FuzzParseConfigMapping`** (`""`). Measured before the fix:
writing a 0-byte `config.yaml` and calling `Initialize` returned

```
serialize config <path>: yaml: cannot encode node with unknown kind 0
```

`parseMapping` replaced the document's *content* for an empty input but left the `yaml.Node` `Kind` at
0, which `stringifyConfig` refuses to encode; `internal/commandline/paths.go:129-132` propagates the
error, so the server does not start. That is exactly the state a full disk or a killed process leaves
behind, and pinned **repairs** it: `yaml.parse('')` is `null`, `getAllKeys(null)` is `[]`,
`_.defaultsDeep(null, defaultConfig)` is the default config, so `src/config-init.js:164-243` writes the
full default document and continues (measured with the pinned `yaml` package:
`yaml.parse("  \n\t\n\n") === null`).

Second instance of the same class, from the fuzz seed sweep: a whitespace-only document whose blank
lines contain a tab is `null` to pinned's yaml but a **lexical error** to `yaml.v3` ("found character
that cannot start any token"), so the repair path was never reached. `configHasNoYAMLContent` now
recognises a document with no nodes (every line blank or a comment) as the empty document it is.

Guard: `internal/configinit/data_safety_empty_config_test.go`
`TestEmptyOrCommentOnlyConfigIsRepairedToThePinnedDefaults` — for zero bytes, whitespace-with-tab and
comments-only: `Initialize` succeeds, reports `Updated`, writes **byte-identical** to the embedded
`generated/default-config.yaml`, a second `Initialize` is a no-op, and no temp file is left.
Teeth (mutation: revert both changes, `-count=1`):

```
zero_bytes      -> Initialize refused a zero bytes config: ... yaml: cannot encode node with unknown kind 0
whitespace_only -> Initialize refused a whitespace only config: ... yaml: line 2: found character that cannot start any token
comments_only   -> Initialize refused a comments only config: ... unknown kind 0
```

### 2.3 P2 — overwriting a user image truncated it first (`f584570`)

`POST /api/images/upload` with an existing `filename`/`ch_name` target wrote with `os.WriteFile`,
which truncates the target before writing: a full disk or a killed process **destroyed the previous
image**, and a concurrent reader could observe a truncated file. It now goes through
`startup.WriteFileAtomic` (`writeUserImageFile`), so the target is the old image or the new one.
Pinned is non-atomic here too (`src/endpoints/images.js:72` `fs.promises.writeFile`); the success-path
bytes are unchanged, so the observable difference is only in the failure window (§3).

## 3. Deliberate hardening of pinned hazards — product decisions, recorded

These are **not** parity claims. Each is a place where reproducing pinned exactly would preserve a
data-loss window, so the window was removed and the divergence is recorded here for the integrator to
accept or reject. The success path (bytes, status, headers) is unchanged in all three; only the
interrupted-write observation differs.

| behaviour | pinned | GoTavern | user-visible difference |
|---|---|---|---|
| `config.yaml` migration write | `fs.writeFileSync` (`config-init.js:239`) | temp+fsync+rename (`configinit/config.go:atomicWrite`) | a crash leaves the old config, never a truncated stub. Already recorded in `config_interrupted_test.go`; this lane found the empty-file consequence of it. |
| character rename chat-directory copy | `fs.cpSync` then `rmSync` (`characters.js:1086-1087`) | staged copy + rename (§2.1) | an interrupted rename cannot leave a tree that the retry then trades for a deletion. |
| image upload overwrite | `fs.promises.writeFile` (`images.js:72`) | temp+fsync+rename (§2.3) | an interrupted overwrite leaves the previous image. |

Everything else in §1 that is atomic **is** pinned's own behaviour (`write-file-atomic` in pinned for
settings, chats, world info, presets, secrets, cards, avatars, image metadata).

## 4. Failure injection and crash simulation (measured)

Added in `f584570`; `internal/startup/data_safety_atomic_test.go`

* `TestAtomicReplacePreservesTheOriginalWhenTheDiskFillsMidWrite` — the temp write is made to write
  half the body and then return a full-disk error (`atomicTempWrite` seam). Asserts: error returned,
  target **byte-identical**, no `.gotavern-content-log-*` scratch file survives.
* `TestAtomicReplacePreservesTheOriginalWhenTheRenameCannotHappen` — the temp file is written and
  synced, the publish step fails; existing target (including a directory tree under the name) intact,
  no scratch file.
* `TestAtomicReplaceSurvivesAProcessKilledMidWrite` — a **real second process** (the test binary,
  re-exec'd as a helper) is killed while it replaces a 128 MiB body; the target must be the complete
  old bytes or the complete new bytes, never a prefix. This half is scheduling-dependent by nature
  (measured: on this single-vCPU host one direct-write mutant finished the write before the kill
  landed), so it is a crash check, not the deterministic teeth; the deterministic teeth is the
  injected write failure, whose mutation was observed red:
  `atomicReplace reported success although the injected write failed partway`.

Covered by the same design and existing tests, not duplicated here: truncated file, malformed JSON
(§6), missing file (`UpdateUserContentFile` passes `nil` to the callback, and
`UpdateUserContentFileIfChanged` can leave a missing target absent), and unparseable existing data (§5).
**Read-only directory**: not simulated by this lane; the adversarial suite and the config tests probe
read-only trees (`internal/adversarial/config_cases_test.go:300`, `startup_cases_test.go:175`) and are
the existing evidence for that case.

## 5. Unparseable existing data: what is preserved and what is not

For read-modify-write **user data**, an existing file that cannot be parsed is never silently replaced:
the callbacks that own the format either refuse or carry the current bytes forward, and the write is
abandoned on error (the tests above assert the target's bytes). For **derived indexes** the pinned
behaviour is different and is deliberately reproduced:

* **`image-metadata.json`**: `src/endpoints/image-metadata.js:162-166` catches the parse error and
  returns the default index, and the next metadata write replaces the file. GoTavern
  (`readImageMetadataIndex`, and the `defaultImageMetadataIndex()` fallback in every metadata RMW
  callback) matches this exactly. **Hazard, reported not fixed**: a corrupted index loses the user's
  folder assignments on the next write, with no backup. Changing it (refuse the write and surface an
  error, or back up the unparseable bytes first) changes pinned's recovery behaviour and creates a new
  on-disk file, so it is a product decision for the integrator — not made here.
* **`config.yaml`** with a document that pinned also rejects: GoTavern returns a named
  `ParseError` instead of pinned's warn-and-continue, and leaves the bytes untouched
  (`config_interrupted_test.go`; recorded decision). Empty/whitespace-only documents are repaired as
  pinned does (§2.2).
* **`settings.json`** is a whole-document replacement from the client, so a malformed existing file is
  overwritten by design; the incoming body is validated (`FormatSettingsJSON`) before the write.
* **chat/save** and **group/save** are whole-file rewrites from the client, same reasoning.

## 6. Fuzzing (targets, seeds, bounded local runs)

Targets were added with seed corpora via `f.Add`, so plain `go test` runs every seed as an ordinary
case (no `-fuzz` needed for coverage); the campaign commands were
`go test <pkg> -run '^$' -fuzz '^<Target>$' -fuzztime <N> -count=1`.

| target | package | seeds | local fuzz run (measured) |
|---|---|---|---|
| `FuzzParseConfigMapping` | `internal/configinit` | pinned fresh config head, legacy keys, duplicate keys, tab indentation, truncated flow sequence, anchors/aliases, unicode, comments, `null`, top-level scalar/sequence | 90 s: PASS, 34 068 execs, 153 interesting |
| `FuzzFormatSettingsJSON` | `internal/startup` | objects/arrays, duplicate keys, `1e999`, `-0.0`, lone surrogates, truncations, scalars | 60 s: PASS, 362 600 execs, 211 interesting |
| `FuzzSanitizeUserFilename` | `internal/startup` | traversal, separators, Windows reserved names, control bytes, unicode, 400-byte name | 60 s: **FAIL -> finding §6.1**; after recording it as inherited and adding the corpus case, `go test` runs the failing input green |
| `FuzzDecodeOrderedNodeJSON` | `internal/server` | chat lines, duplicate keys, escapes/lone surrogates, huge numbers, truncations | 90 s: PASS, 49 768 execs, 166 interesting |
| `FuzzReadPngCardText` | `internal/server` | valid card PNG, truncations, bad signature/IHDR/CRC, NUL in tEXt | 90 s: PASS (346 s wall incl. build on this host) |
| `FuzzParseYamlDocument` | `internal/server` | YAML/JSON-shaped character imports, unterminated flow, multi-document, anchors | 60 s: PASS (432 s wall) |
| `FuzzParseAvatarCrop` | `internal/server` | valid/invalid crop objects, numeric edge values, non-objects, truncations | 60 s: PASS, 41 985 execs, 137 interesting |
| `FuzzPinnedPathUnderParent` | `internal/server` | `..`, separators, absolute paths, `chats/../escape`, Windows drive paths | 60 s: PASS, 7 224 execs, 53 interesting |

No panic, OOM, hang or traversal was found in the bounded runs. The findings that did occur are below;
each has a regression in the tree.

### 6.1 Fuzz finding: trailing dot/space AFTER truncation — inherited from pinned (recorded, not fixed)

`FuzzSanitizeUserFilename` found an input for which `SanitizeUserFilename` returns a name ending in a
space (failing corpus committed as `internal/startup/testdata/fuzz/FuzzSanitizeUserFilename/55b532a140fa5370`).
Cause: the sanitizer reproduces pinned's `sanitize-filename` 1.6.3 order — strip trailing dots/spaces,
**then** truncate to 255 bytes (`node_modules/sanitize-filename/index.js:48-49`; this port at
`internal/startup/user_presets.go:sanitizeUserPresetFilename`). A name longer than the limit can
therefore end in a dot or space again after the cut, and Windows silently drops those characters when
the path is opened, collapsing two distinct names onto one file.

This is **inherited from pinned**, so it is reproduced and recorded rather than silently diverged
from (AGENTS architecture boundary 5). The regression that pins the ORDER is
`TestSanitizeUserFilenameKeepsPinnedTrimThenTruncateOrder`; the fuzz invariant that matters for
containment (no separator, no NUL, not `.`/`..`, valid UTF-8, `filepath.Base(result) == result`, ≤255
bytes) is asserted strictly. Re-trimming after truncation is a candidate product decision; it changes
a user-visible name only for >255-byte names and is reported, not made.

## 7. Concurrency and the race detector

Added in `f584570`, `internal/server/data_safety_concurrency_test.go`. Every test has the same shape:
several writers hammer ONE target with distinct **complete** payloads while a reader requires every
observation to be one writer's complete document (size sample via `stat`, then a full read).

| test | writers | property |
|---|---|---|
| `TestChatSaveNeverPublishesATornJSONL` | 4 × 6 `POST /api/chats/save` | every JSONL line parses and all lines carry one writer's marker; final file complete |
| `TestSettingsSaveNeverPublishesATornJSON` | 4 × 4 `POST /api/settings/save` | every read is valid JSON with one writer's marker; final file complete |
| `TestWorldInfoEditNeverPublishesATornJSON` | 3 × 5 `POST /api/worldinfo/edit` | every read is valid JSON with `entries.0.content` present; final file complete |
| `TestPresetSaveNeverPublishesATornJSON` | 3 × 5 `POST /api/presets/save` | every read is valid JSON with one writer's marker; final file complete |
| `TestImageUploadOverwriteIsNeverObservedTorn` | 30 sequential overwrites | every observed image equals one complete payload |

Teeth (mutation: `atomicReplace` replaced by a direct `os.WriteFile`, `-count=1`): the readers observed
the truncation window and failed with named assertions —
`a concurrent reader observed a file of 0 bytes; every writer's complete payload is ... bytes. A size
in between is the truncation window a direct write exposes.` (world-info; settings/preset/image were
observed red in an earlier run of the same mutation). The chat test asserts the same property but its
window was not sampled under direct writes on this host; the shared primitive's teeth are therefore
cited from the routes that were observed.

`go test -race` **could not be run locally**: Go 1.27 on windows/arm64 answers
`-race is not supported on windows/arm64`. This is a host limitation, not a product finding. The Linux
CI gate can run the same tests with the race detector:

```
go test -race -count=1 ./internal/startup ./internal/server -run '^(TestAtomicReplace|TestChatSave|TestSettingsSave|TestWorldInfo|TestPresetSave|TestImageUpload|TestSecretValue|TestCopyDirectory)'
```

### 7.1 Windows read/write race surfaced by the Go 1.27.3 move (fixed here)

The release-blocking toolchain move (§8.2) made a real, pre-existing Windows-only defect observable:
`TestStoredAccountCacheUnderConcurrentReadersAndWriter` (existing test; readers call
`loadStoredAccount` while a writer replaces the same node-persist record) began failing on
windows/arm64. Measured, in a scratch worktree at the pre-move commit with only
`GOTOOLCHAIN=go1.27.3` forced: **2/10 runs FAILED**, 6 occurrences of

```
concurrent read: read node-persist record user:cache-concurrent: open ...\_storage\<hash>:
The process cannot access the file because it is being used by another process.
```

The same commit under Go 1.27.0 passed 10/10, so the defect was latent in the timing, not created by
the bump. Cause: the write side replaces the record with `atomicReplace` (temp file + rename) and the
rename side retried a transient Windows sharing violation (`fsretry`), but the READ side
(`loadStoredAccount`, `loadStoredAccounts`) used a bare `os.ReadFile`, so an authenticated request that
read a record while another request replaced it could fail with that error. `fsretry`'s own package
documentation names this exact scenario. Fix: `readStoredRecordFile` retries the bounded (~200 ms)
sharing violation on the read side; `isTransient` is false off Windows, so Linux behaviour is
unchanged. Measured: `-count=20` green after the fix (was 2/10 red before). No HTTP contract change;
only the transient-error path improves.

This class was then audited beyond the account-read path and extended to the two remaining bare
node-persist reads in a follow-up (`6a870f6`, §7.2). The audit also found and REPORTED (not changed) one
same-family read: `startup/user_content_file.go:51` maps ANY `os.ReadFile` error to "file absent" and
hands the RMW callback `nil`. A transient Windows sharing violation there would base a derived-index write
(the `image-metadata.json` family) on the default document; the pinned index-fallback parity makes the
CONSEQUENCE a legitimate pinned behaviour (§5), so the fix is a product decision about when to refuse,
recorded in §9 item 9. Everything else the audit sampled (`chats.go` get, `chats_search_recent.go`,
`characters_read.go`, `worldinfo.go`, `settings_get.go`, `image_metadata_index.go`, `vector.go`,
`static.go`) returns the read error to the client or a default response on a READ path, so a failed read
costs one request rather than rewriting data.

### 7.2 Windows read retry for the last two bare node-persist reads (`6a870f6`)

`startup.UpdateNodePersistRecord` read the current record with a bare `os.ReadFile` before the atomic
replace, and `NodePersistKeys` (through `readStoreEntries`) enumerated records the same way. On Windows a
DIFFERENT process replacing one of those records makes the read fail with `ERROR_ACCESS_DENIED` /
`ERROR_SHARING_VIOLATION` for the duration of the rename window — the same class §7.1 fixed on the account
read path.

Fix: `fsretry.ReadFile`, a narrow extension of the existing bounded retry (20 attempts × 10 ms, transient
sharing/replacement predicates only, `isTransient` is false off Windows, so Linux behaviour is byte-for-byte
unchanged). No route, response, file layout or timing contract changed; only the transient-error path
recovers instead of failing the request.

Evidence (Layer A, windows/arm64):
* `internal/fsretry/fsretry_read_windows_test.go` — holds a REAL exclusive handle on the record file and
  first requires plain `os.ReadFile` to FAIL with the sharing violation (the discrimination step), then
  releases it after 30 ms and requires `fsretry.ReadFile` to succeed.
* `internal/startup/storage_read_retry_windows_test.go` — the same real-exclusive-handle setup through
  `UpdateNodePersistRecord` (write-before-read, then asserts the record became `"new"`) and through
  `NodePersistKeys` (the key must appear in the listing).
* MUTATION PROOF (`-count=1`; `fsretry.ReadFile` body replaced by `return os.ReadFile(path)`, restored from
  a file copy): all three Windows tests went RED, naming the failure — `ReadFile did not absorb the sharing
  violation a concurrent replace produces: open ... The process cannot access the file because it is being
  used by another process.`, `UpdateNodePersistRecord did not absorb the transient sharing violation: read
  node-persist record user:retry-update: ...`, `NodePersistKeys did not absorb the transient sharing
  violation: read node-persist record ...`. Restored: green.

### 7.3 Chat write crash atomicity (measured; killed process at named and random points)

Row 3 of `docs/gap-sweep.md` recorded that chat JSONL atomicity was asserted per route but never at a
crash-or-kill boundary. This section closes it, and it found one REAL hole in the product.

**The hole: `/api/chats/rename` left BOTH names after a kill.** GoTavern reproduced pinned's
`fs.copyFileSync(pathToOriginalFile, pathToRenamedFile); fs.unlinkSync(pathToOriginalFile)`
(`src/endpoints/chats.js:644-645`) as an atomic write of the new name followed by a delete of the old one.
A kill between those two steps leaves `chat.jsonl` AND `chat-renamed.jsonl`, each complete: after restart
the user sees the chat twice. Fix: `startup.RenameUserContentFile` performs ONE `os.Rename` under the
shared user-content lock (`fsretry.Do` for the Windows sharing window) and then refreshes the destination
mtime, because `copyFileSync` creates a new file and `/api/chats/recent` orders by mtime; the success path,
the response and the bytes are unchanged. A crash between the rename and the mtime refresh leaves a
complete file under the new name with the source mtime — still a complete state.

**Fault models (both are needed).**
* Deterministic: a binary built with `-tags gotavern_faults` installs a named crash seam
  (`internal/faultinject`); a production build contains no hook at all. The test arms the hook only AFTER
  readiness (a marker file), so a boot-time atomic write cannot trigger it. The child exits 137 (128+SIGKILL)
  at the exact step, with no deferred cleanup, exactly like a hard kill.
* Randomised: a normal `Process.Kill` at a seeded point (seed `20261031`) once write progress is
  observable (a `.gotavern-content-log-*` scratch file appears, the target size changes, or the renamed
  destination appears), jittered 0..8 ms. Every crash state and every restart is then asserted.

**Allowed state per operation (asserted by exact bytes, and again after a restart).**

| operation | deterministic points and the state each implies | randomised kills |
|---|---|---|
| save-new-chat | — | 10 |
| append-message | `chats.save.before-write`, `atomicReplace.after-temp-write`, `atomicReplace.after-temp-sync` → OLD bytes; `atomicReplace.after-rename`, `chats.save.after-write` → NEW bytes | 20 |
| swipe | — | 10 |
| regenerate-write | — | 10 |
| branch (source chat untouched) | — | 10 |
| chat-metadata-mutation | — | 10 |
| rename-chat | `chats.rename.before-rename` → old name ONLY; `chats.rename.after-rename` → new name ONLY | 15 (the window is one syscall wide: 3 of 15 landed inside it in the final run and 12 completed before the kill; the deterministic labels carry this proof) |
| import (single file) | `chats.import.after-write` → ONE complete imported chat | 10 |
| delete | `chats.delete.after-remove` → file ABSENT | 10 |
| group-save | — | 10 |

**Final complete randomised run (`crash-random6`, 300 s, exit 0):** save-new 10/10, append 20/20, swipe
10/10, regenerate 10/10, branch 10/10, metadata 10/10, delete 10, import 10, group-save 10 all landed
inside the write; rename 3/15 landed inside its one-syscall window and 12 completed before the kill. Every
iteration asserted a complete old or new state, and every restart re-asserted it.

The progress poll reads only directory ENTRIES (names and sizes) and never file contents, because the poll
runs while the server is still writing: reading a file being renamed/deleted from the test process is a
legitimate transient Windows race, measured as `read chat file chat.jsonl: ... cannot find the file
specified` / `Access is denied`. Byte assertions run only after the process is dead. That distinction was
itself a defect the first draft of this harness had, and it is fixed in the tests that accompany this
section.
Every observation required one of the complete states above; the assertion rejects a zero-byte file, a
non-JSON line, a partial line, a chat that disappeared, a chat that appeared twice, a rename with both
names, and metadata/branch state pointing at a missing body. Restart validation additionally requires the
boot not to CHANGE the crashed bytes and `GET /api/chats/get` to answer a parseable array for the file.

**Mutation proof for the rename fix.** The pre-fix shape was reintroduced (read source → `os.WriteFile` to
the new name → `os.Remove` the source) with a label placed in the window between the write and the remove,
and a throwaway probe (not committed; mutation runs never are) crashed there. Observed:
`MUTATION REPRODUCED: a kill between copy and unlink leaves BOTH chat.jsonl and chat-renamed.jsonl`.
Restored from the file copy: the deterministic rename points are green again (28.5 s). The committed tests
cannot express that window for the FIXED code because a single `os.Rename` has no step between its two
labels — which is the property the fix buys.

**NOT DONE: chat backup.** The pinned `/api/chats/save` throttled-backup scheduler is not implemented
(recorded gap, `internal/server/chats.go:14-21`), so there is no product write to crash and the matrix
deliberately has no backup row. This is a parity gap, not a data-safety claim.

**Scope of the evidence: Layer A, windows/arm64.** The kill matrix runs against the real binary as a
subprocess (no `-race` on this host). The Linux CI gate does not run these tests; the fault seam is
tag-gated and absent from normal builds, so this remains Windows-specific crash evidence until a CI job
runs `-tags gotavern_faults` on Linux.


## 8. Security baseline (measured)

### 8.1 `go vet`

```
go vet ./...
```
exit 0, no diagnostics (`vet-exit=0`, empty log; 133 s cold incl. build).

### 8.2 `govulncheck`

Tool: installed to a scratch `GOBIN` (not the repo):
`golang.org/x/vuln/cmd/govulncheck@v1.9.0`, built with **go1.27.3**, vulnerability DB
`2026-10-27T21:16:18Z`. This section records the BEFORE measurement (the release-blocking state this
lane found) and the AFTER measurement once the toolchain/module move below was applied.

BEFORE — `go.mod go 1.23.0`, `Dockerfile golang:1.23-alpine` (scan built by the then-installed
go1.27.0): exit 3, **15 reachable vulnerabilities**:

```
govulncheck ./...
=> "Your code is affected by 15 vulnerabilities from 2 modules and the Go standard library."
```

| id | package | fixed in | reachable via |
|---|---|---|---|
| GO-2026-6809 | `crypto/x509` (stdlib go1.27) | go1.27.3 | `outbound.sendWireExactStreaming` TLS verify |
| GO-2026-6617, 6613, 6612, 6611, 6610, 6605, 6603 | `net/http` / HTTP/2 (stdlib go1.27) | go1.27.2 | server handlers, `outbound.sendProductionStreaming`, app shutdown |
| GO-2026-6608 | `mime/multipart` (stdlib go1.27) | go1.27.2 | multipart upload readers |
| GO-2026-6607 | `crypto/tls` (stdlib go1.27) | go1.27.2 | outbound TLS |
| GO-2026-6222, 5061, 5031, 4961 | `golang.org/x/image@v0.24.0` | v0.42.0 / v0.43.0 / v0.45.0 | `server.reencodeImage` -> `image.Decode` -> `webp.Decode` (`characters_write.go:93`); `generateImageMetadata` -> `webp.DecodeConfig` (`image_metadata_generate.go:40`) — user-uploaded images |
| GO-2026-5970 | `golang.org/x/text@v0.22.0` | v0.39.0 | collation/`language` package use in the images list path |

Root cause: the release/CI toolchain was **Go 1.23, which is out of support**, so no stdlib patch
release reached a shipped build; and every fixed `x/image`/`x/text` release declares
`GoVersion: 1.25.0`, so the module bump was blocked on the same toolchain move.

REMEDIATION APPLIED (the rest of this section is the post-fix record; see the commit log in §11):

* `go.mod` `go 1.23.0` -> **`go 1.27.3`** (the newest patch this DB lists with the stdlib fixes), and
  `Dockerfile` `FROM golang:1.23-alpine` -> **`FROM golang:1.27.3-alpine`**. The `1.27.3-alpine` tag
  was verified against the Docker Hub registry API (`last_updated 2026-10-27T01:23:40Z`). CI workflows
  use `go-version-file: go.mod`, so they follow the directive; none were edited.
* `golang.org/x/image v0.24.0 -> v0.45.0` (carries all four image fixes; v0.45.0 requires
  `x/text >= v0.41.0`, which is why the minimal v0.39.0 was not resolvable alongside it).
* `golang.org/x/text v0.22.0 -> v0.41.0`; `golang.org/x/sys v0.30.0 -> v0.47.0` (transitive of
  x/image).
* `golang.org/x/crypto v0.33.0 -> v0.56.0` (extra, same class: it removed 21 module-level advisories
  that govulncheck reported in required-but-uncalled packages; `accounts.go` uses only
  `scrypt`/`sha3`, whose APIs are unchanged).

```
go version                        -> go1.27.3 windows/arm64   (GOTOOLCHAIN=auto fetched it: 32 s)
go mod tidy                       -> exit 0
go build ./...                    -> exit 0 (19 s after cache warm)
go vet ./...                      -> exit 0 (18 s)
govulncheck ./...                 -> exit 0
```

AFTER — `govulncheck ./...` exit 0: **"No vulnerabilities found." "Your code is affected by 0
vulnerabilities."** 0 in imported packages, **0 reachable** (was 15), and exactly **1** advisory
remaining in a required module, non-reachable and with **no fixed version**:
`GO-2026-5932 golang.org/x/crypto/openpgp@v0.56.0` — "package unmaintained/unsafe by design, fixed
in N/A". This module does not import `openpgp` (it imports `scrypt` and `sha3` only), and the
govulncheck trace for it contains no package/symbol frames; it cannot be removed without removing
`golang.org/x/crypto`, which the password hashing path requires. Named residual, non-reachable.

Pinned-parity impact: **none expected and none observed** — a toolchain and module version move only.
No HTTP route, response body, disk layout, filename or provider-wire byte was changed; the image
affects are inside a decoder whose contract is the decoded OBSERVABLE (dimensions/MIME/decodability),
not Jimp byte equality (the recorded `/thumbnail` + avatar decisions, ARCHITECTURE §35.2). The
image/card/thumbnail/`x/text`-collation tests and the account/scrypt/sha3 tests were re-run green
(§10).


### 8.3 Path traversal

Existing route-level coverage is broad and unchanged: `internal/server/files_delete_test.go`
(outside-directory sentinel), `data_maid_test.go` (outside IGNORE path), `images_test.go` (escape file
outside the user images tree), `static_test.go`/`user_data_static_test.go` (public and user-static
containment), `chats_mutations_test.go` (avatar/chat path containment), `assets_test.go` and
`backgrounds_delete_test.go` (outside-tree payloads). This lane adds two measured probes:

* **Route probes** — `internal/server/data_safety_traversal_test.go`
  `TestTraversalNamesNeverCreateFilesOutsideTheUserTree` sends `../../escape` shaped names to
  `/api/chats/save`, `/api/worldinfo/edit`, `/api/images/upload` and `/api/files/upload` through the
  authenticated in-process handler, then walks the whole probe root and requires **no file outside the
  user data root** to carry the payload's basename. Measured: PASS (4/4 subtests); the chat route
  refuses the traversal avatar with 400 and the other three sanitize the name into the user tree.
* **Property fuzz** — `FuzzPinnedPathUnderParent`: whenever the containment predicate returns true,
  `filepath.Rel(parent, child)` must not be `..` nor start with `..<sep>`. Bounded run: PASS
  (7 224 execs, no counterexample).

### 8.4 Request body bounds

| surface | bound | source |
|---|---|---|
| JSON and urlencoded bodies (body-parser equivalents) | 500 MB (`500<<20`) | pinned `src/server-main.js:110-111` — parity; enforced in `readAccountRequestBody`, `readFilesUploadBody`, `readPinnedJSONBody`, every route's `io.LimitReader` |
| settings/save | 500 MB | `settings_save.go:12` (same bound) |
| multer field size | 500 MB | pinned `src/server-main.js:269` `limits: { fieldSize: 500 * 1024 * 1024 }`; enforced with bounded readers in `characters.go`, `avatars_upload.go`, `sprites_upload.go`, `openai_transcribe.go`, `speech.go`, `backends_kobold_deferred.go` |
| multipart FILE parts — streaming routes | no size cap (pinned parity: multer streams to disk unbounded); spooled to `<dataRoot>/_uploads`, removed on success and on every error/abort path | `characters.go`, `avatars_upload.go`, `backgrounds_upload.go`, `backends_kobold_deferred.go`, and now `sprites_upload.go` (single upload moves the staged file with one rename; upload-zip reads the archive from disk) |
| multipart FILE parts — routes that must buffer (outbound body is `[]byte`) | **100 MiB** (`maxBufferedMultipartUploadBytes`), spooled to disk first, rejected beyond the cap | `openai_transcribe.go` / `openai_chutes_transcribe.go` / `speech.go` via `internal/server/multipart_upload.go`. **RECORDED SECURITY BOUNDARY (§8.4.1):** pinned streams an arbitrary-size part from disk to the provider; GoTavern answers the route's existing error status for an upload above 100 MiB. This is a bounded, documented divergence, not an unbounded memory path. |
| sprite ZIP entries | 32 MiB per image entry and 128 MiB total extracted | `sprites_upload.go` `spritesZipImagesFromFile`. **RECORDED SECURITY BOUNDARY:** pinned buffers every image entry with no cap; a zip whose entries exceed these caps answers the route's 500 instead of running the process out of memory. |
| outbound response bodies | buffered without a cap (`outbound/transport.go`, provider handlers) | inherited from pinned's `fetch` (also buffers); residual risk, not changed. |

### 8.4.1 Multipart/upload memory: before/after measurements (measured 2026-10-31)

Method: the same 200 MiB `multipart/form-data` body posted to `POST /api/sprites/upload` (the largest
buffered parser before this change) against a fresh release-shaped tree with the HEAD binary
(`gotavern-before`, built from `6a870f6`) and the fixed binary (`gotavern-after`, this lane). Peak working
set read from the server process after the request; stored bytes compared. Layer A, windows/arm64.

| measurement | BEFORE (`6a870f6`) | AFTER (this lane) |
|---|---|---|
| upload | 200 MiB | 200 MiB |
| HTTP status | 200 | 200 |
| peak working set | **552.0 MB** | **37.7 MB** |
| wall time | 6.43 s | 2.67 s |
| stored sprite bytes | 209715200 | 209715200 |
| `_uploads` files left | 0 | 0 |

That is a **14.6×** reduction in peak RSS for the same accepted input, with byte-identical stored output.
The transcribe/speech paths are not measured end-to-end through RSS because they need a provider; the same
`readBufferedMultipartPart` helper is covered by
`TestReadBufferedMultipartPartRejectsAnOversizePartAndRemovesTheStagingFile` (4 KB part against a lowered
1 KB cap) and by the truncated-body test that asserts the staging file is removed on a malformed upload.


### 8.5 Malformed JSON and unsafe overwrite

Malformed JSON on the pinned body-parser routes answers 400 (parity) and is fuzzed by
`FuzzDecodeOrderedNodeJSON`/`FuzzFormatSettingsJSON`; unparseable stored JSON is covered in §5. The
unsafe-overwrite class is §2.1/§2.3 plus the atomic writers in §1.

### 8.6 Secret-in-logs / secret-in-response sweep

Static audit of every non-test logging site (`fmt.Print*`, `log.*`, `os.Std*`): the surfaces are the
startup trace (stage names/durations), the access log (client address, method, **no headers or
bodies**), the private-address filter (addresses), migration progress (paths/counts), content-import
refusal (host only), account recovery/reset codes (printed once by design, pinned parity), boot errors
(paths and causal errors). No statement prints a request body, an `Authorization` header or a secret
value; the outbound transport's error-string test
(`internal/outbound/transport_matrix_test.go:TestProductionTransportDoesNotLeakSecretsIntoErrors`)
covers the provider-error path.

New broad route sweep: `internal/server/data_safety_secret_leak_test.go`
`TestSecretValueIsNeverEchoedOnRouteErrorPaths` plants a distinctive secret as the **active** entry in
`secrets.json` (with a parameter guard that fails if the entry is not visible in the served state map,
so the sweep cannot pass vacuously) and drives 15 error paths across
`/api/secrets/{read,view,find,write,delete,rotate,rename,settings}` and `/api/settings/save`; the
planted value must not appear in any response body or header. Teeth (mutation: remove the
`AllowKeysExposure` gate in `serveSecretsView`, `-count=1`):
`/api/secrets/view echoed the planted secret in its response body (status 200)` — restored from a
file copy, green.

Not swept, stated: stdout/stderr log capture at route level (handler options do not expose the console
writers; the static audit above stands in), and provider error surfaces (outbound test).

### 8.7 Installer shell/PowerShell quoting review (read-only; scripts not edited)

Review of `install.sh` (sh), `install.ps1`, `start.sh`, `Start.cmd` from source:

* `install.sh` quotes every expansion that reaches a command (`"$INSTALL_DIR"`, `"$BASE_URL/..."`,
  `"$CHECKSUMS"`, `"$TMP_ROOT"`, `"$TOKENIZERS_NEW"`), uses `set -eu`, a `trap` cleanup, and an
  `mktemp -d` scratch root; `--dir`/`--version` argument arity is checked; the `--` separators are
  correct (`cd --`, `dirname --`). No `eval`, no unquoted variable in `rm`/`mv`/`cp`, no
  `curl | sh`. The `start.sh` heredoc is quoted (`<<'EOF'`), so no expansion is injected into the
  generated launcher. Checksum verification is mandatory and unconditional (mirror included).
  Observations, not defects: (a) the curl branch has no `--https-only` equivalent (the script
  documents why, and only the mirror seam may be plain http), while the wget branch uses
  `--https-only`; (b) `sha256_file()` pipes `sha256sum` into `awk`, so a `sha256sum` failure is
  reported by the comparison rather than by `pipefail` (POSIX sh has no `pipefail`); (c) the release
  archive is extracted with `tar -xzf` without an explicit member-path check — the checksum pins the
  bytes to the release, but a compromised release could write outside the extraction directory.
* `install.ps1` uses `[CmdletBinding()]`, `$ErrorActionPreference = 'Stop'`, `-LiteralPath` on every
  path-taking cmdlet (so `[`/`]` in a profile path cannot glob), quoted interpolations, a random GUID
  temp root removed in `finally`, and a checksum parser that anchors the 64-hex digest and compares the
  asset name exactly. `Start.cmd` is written ASCII with `cd /d "%~dp0"` and `"%~dp0gotavern.exe" %*`
  (the `%*` passthrough is the standard cmd idiom; cmd metacharacters in arguments are the caller's
  shell semantics, as with any launcher). It does not verify an Authenticode signature — same
  trust model as `install.sh` (same-origin checksums only); carried by the release process, not this
  lane.
* No command-injection path was found in either installer from source review.

## 9. Residual risks (explicit)

1. **FIXED in this lane (`6a870f6`, §7.2).** Multipart file parts were buffered in memory without a
   bound on `readTranscribeUpload`, `readSpeechUpload` (both `io.ReadAll`) and the sprite parser
   (`io.ReadAll` up to 500 MB) while pinned spools to disk. Now: transcribe/speech spool to
   `<dataRoot>/_uploads` and are capped at 100 MiB; the sprite single upload moves the staged file with
   one rename and upload-zip reads the archive from disk (32 MiB per entry, 128 MiB total). Measured
   before/after: **552.0 MB -> 37.7 MB peak working set** for a 200 MiB sprite upload, byte-identical
   stored output (§8.4.1). The 100 MiB buffered cap and the zip-extraction caps are **recorded security
   boundaries**: pinned accepts larger input (and streams it), so an operator above those sizes gets the
   route's error status where pinned would accept. Named user-visible effect, not a silent divergence.
2. `image-metadata.json` recovery overwrites a corrupted index (§5) — pinned parity, product decision
   needed.
3. Trailing dot/space after 255-byte truncation in sanitized filenames (§6.1) — pinned parity,
   product decision candidate.
4. `internal/migrate` destination writes are not atomic: `copyConfig` uses `os.WriteFile`
   (`migrate.go:537`) and `copyFile` opens the destination with `O_TRUNC` (`migrate.go:641`). The
   destination is a fresh tree and a re-run moves destination conflicts to a backup before recopying,
   so the window is recoverable rather than corrupting user data; not fixed in this lane.
5. Chat backups are not implemented (recorded gap in `server/chats.go:14-21`), so a chat corruption has
   no product-created rolling backup; this is why §7.3 has no backup crash row.
6. A process killed during `atomicReplace` leaves a `.gotavern-content-log-*.tmp` scratch file next to
   the target (the target itself is intact). Harmless, never read, removed on a later successful
   replace only if the name collides (it cannot: unique token); disk leak bounded by crash count.
   The crash matrix treats these scratch files as NOT state (non-dot `.jsonl` files are the assertion),
   so an orphaned temp file cannot make a crash state look new or hide a partial write.
7. `go test -race` is unavailable on windows/arm64; concurrency tests are race-detector-clean by design
   and must be run on the Linux CI gate (§7). The §7.3 crash matrix is windows-only evidence (Layer A):
   no CI job runs `-tags gotavern_faults` on Linux, so Linux crash behaviour is not measured by it.
8. **FIXED in this lane (toolchain + module move, §8.2).** The release toolchain was Go 1.23 (out of
   support) and govulncheck found 15 reachable vulnerabilities. Now: `go.mod go 1.27.3`,
   `Dockerfile golang:1.27.3-alpine`, `x/image v0.45.0`, `x/text v0.41.0`, `x/sys v0.47.0`,
   `x/crypto v0.56.0`; `govulncheck ./...` is exit 0 with **0 reachable**. The only remaining advisory
   is `GO-2026-5932` in `golang.org/x/crypto/openpgp` (no fixed version; the module is not imported —
   only `scrypt`/`sha3` are). Residual: the Docker image itself was not built locally (no
   docker/podman on this host); the tag exists and the build stage is a one-line `FROM` change, so the
   container build must be exercised by the release/docker workflow. The Go 1.27.3 toolchain was
   fetched by `GOTOOLCHAIN=auto` (32 s), so CI with `go-version-file: go.mod` will fetch the same
   version.
9. **FIXED in this lane (`6a870f6`, §7.2).** The two node-persist reads outside the account request path
   (`startup.UpdateNodePersistRecord`'s read-before-write and `startup.NodePersistKeys`) are now
   `fsretry.ReadFile` with the bounded 20 x 10 ms transient-sharing retry. Windows discrimination tests
   hold a real exclusive handle and require the bare read to fail first; the mutation (retry disabled)
   went red with the sharing-violation message, restored green.
10. **Audited, NOT changed: `startup/user_content_file.go:51` treats ANY read error as "file absent"**
    and calls the RMW callback with `nil`. On Windows a transient sharing violation there would base a
    derived-index write (the `image-metadata.json` family) on the default document, i.e. the §5
    corrupted-index consequence, triggered by a transient error rather than by malformed bytes. Pinned's
    index-fallback parity makes the consequence a legitimate pinned behaviour; refusing the write instead
    is a product decision with its own failure mode (a read error would fail a user action). Reported
    with its evidence path, not fixed.
11. The remaining bare reads on REQUEST paths (`chats.go` get, `chats_search_recent.go`,
    `characters_read.go`, `characters_write.go`, `worldinfo.go`, `settings_get.go`,
    `image_metadata_index.go`, `vector.go`, `static.go`; 95 non-test `os.ReadFile` sites in total, sampled
    in this audit) return the error to the caller or a route-specific default: a transient sharing
    violation costs one request, and none of the sampled sites bases a WRITE on the failed read. Kept as
    is; the write-side RMW paths are the ones that mattered and are covered by §7.1/§7.2.


## 10. Command log (this lane)

```
# fix + guards (all with -count=1)
go test ./internal/server -run 'TestCopyDirectoryAtomically' -count=1            ok
go test ./internal/startup -run 'TestAtomicReplace(PreservesTheOriginal|SurvivesAProcessKilledMidWrite)' -count=1  ok
go test ./internal/server -run 'Test(ChatSave|SettingsSave|WorldInfoEdit|PresetSave|ImageUpload|SecretValue|CopyDirectory)' -count=1  ok
go test ./internal/configinit -count=1                                           ok
go test ./internal/startup -run 'FuzzSanitizeUserFilename|TestSanitizeUserFilenameKeepsPinnedTrimThenTruncateOrder' -count=1  ok

# mutation runs (recorded in §2/§7/§8; each restored from a file copy, never git)
go test ./internal/server -run 'TestCopyDirectoryAtomicallyPublishesNothingWhenTheCopyFailsMidway' -count=1        FAIL (teeth)
go test ./internal/startup -run 'TestAtomicReplacePreservesTheOriginalWhenTheDiskFillsMidWrite' -count=1            FAIL (teeth)
go test ./internal/configinit -run 'TestEmptyOrCommentOnlyConfigIsRepairedToThePinnedDefaults' -count=1            FAIL (teeth)
go test ./internal/server -run 'Test(ChatSave|SettingsSave|WorldInfoEdit|PresetSave|ImageUpload)' -count=1         FAIL (torn reads, direct-write mutant)
go test ./internal/server -run 'TestSecretValueIsNeverEchoedOnRouteErrorPaths' -count=1                              FAIL (teeth)

# fuzz campaigns (bounded; wall-clock includes build/setup on this host)
go test ./internal/configinit -run '^$' -fuzz '^FuzzParseConfigMapping$' -fuzztime 90s -count=1   PASS
go test ./internal/startup    -run '^$' -fuzz '^FuzzFormatSettingsJSON$' -fuzztime 60s -count=1   PASS
go test ./internal/startup    -run '^$' -fuzz '^FuzzSanitizeUserFilename$' -fuzztime 60s -count=1 FAIL -> inherited finding §6.1 (regression added, re-run green)
go test ./internal/server     -run '^$' -fuzz '^FuzzDecodeOrderedNodeJSON$' -fuzztime 90s -count=1 PASS
# remaining server targets: see .tmp-artifacts/fuzz/*.log (scratch, not committed)

# race detector
go test -race ./internal/startup ...   -> "-race is not supported on windows/arm64" (host limitation)

# full packages touched by this lane (not only the new tests)
go test ./internal/configinit -count=1   PASS  (14.7 s)
go test ./internal/startup    -count=1   PASS  (64 s)
go test ./internal/server     -count=1   573 s: ONE failure, TestOpenAIGenerateVideoTimeoutIsAnImplementationTest
                                         ("the handler wrote \"Video generation aborted by client\" after the
                                         caller left; pinned writes nothing"). That test passes 5/5 in
                                         isolation (2.1 s); it is a cancellation-timing implementation test
                                         unrelated to this lane's files and is a load-dependent local red,
                                         not a finding here (docs/local-red-triage.md triage applied:
                                         isolated re-run discriminates a host/timing artefact from a defect).

# Windows read-side race surfaced by the 1.27.3 move (§7.1)
# pre-fix evidence: scratch worktree at 2e87cc1 (pre-move go.mod 1.23.0/old modules), GOTOOLCHAIN=go1.27.3:
go test ./internal/server -run '^TestStoredAccountCacheUnderConcurrentReadersAndWriter$' -count=10
                                         -> 2/10 FAIL, 6x "concurrent read: ... The process cannot access
                                            the file because it is being used by another process."
                                         (same commit on Go 1.27.0: 10/10 PASS)
# after the fsretry read fix:
go test ./internal/server -run '^TestStoredAccountCacheUnderConcurrentReadersAndWriter$' -count=20   PASS
go build ./...  exit 0; go vet ./internal/server exit 0; gofmt clean (LF-normalised copy)

# full suite on the new toolchain + modules + read fix (go test ./... -count=1)
full-suite-after-readfix exit=0, 331 s, every package ok (internal/server 241 s)

# security baseline
go vet ./...                                    exit 0, no diagnostics
golang.org/x/vuln/cmd/govulncheck@v1.9.0         installed to .tmp-artifacts/bin (built with go1.27.3,
                                                 DB 2026-10-27T21:16:18Z)
govulncheck ./...                               BEFORE: exit 3, 15 reachable
govulncheck ./...                               AFTER:  exit 0, "No vulnerabilities found", 0 reachable

# toolchain + module move (release-blocking follow-up; §8.2)
GOTOOLCHAIN=auto go version                     -> go1.27.3 windows/arm64 (downloaded in 32 s)
go get golang.org/x/image@v0.45.0 golang.org/x/text@v0.41.0   -> upgraded (+ x/sys v0.47.0)
go get golang.org/x/crypto@v0.56.0               -> upgraded (clears 21 non-reachable module advisories)
go mod tidy                                     exit 0
go build ./...                                  exit 0 (19 s)
go vet ./...                                    exit 0 (18 s)
go test ./internal/server -run 'Test(PinnedNodeAccounts|Accounts|Account|Login|Session|Csrf|Password|Recovery)' -count=1  exit 0 (25 s)
# affected image / card / thumbnail / x-text-collation subset + startup + configinit, on go1.27.3:
go test ./internal/server -run 'Test(Characters|PngCard|Avatar|Thumbnail|Images|ImageMetadata|Backgrounds|UserAvatar|Sprite|CharactersRead|CharactersWrite|CharactersImport|CharactersFormat|CharactersReplay|CharactersProjection)' -count=1  exit 0 (128 s)
go test ./internal/startup -count=1              exit 0 (35 s)
go test ./internal/configinit -count=1           exit 0 (11 s)
# environment note: the C: volume was down to 307 MB free and `go build ./...` first failed with
# "resize output file failed ... not enough space"; `go clean -cache` freed the 5.96 GB Go build cache
# (safe, disposable), after which the build passed. No repository file was involved.

# chat write crash atomicity (§7.3; Layer A windows/arm64; every run with -count=1)
go build ./...                                                                  exit 0
go test ./internal/startup -run '^(TestRenameUserContentFile)' -count=1          ok (2.9 s; bytes/mtime/missing-source/containment)
go test ./internal/server -run '^(TestPinnedNodeChatsMutations|TestPinnedNodeChatsSaveGet|TestPinnedNodeChatsImport|TestChatSaveNeverPublishesATornJSONL)' -count=1  ok (3.8 s; route parity after the rename change)
go test ./tests/e2e -run '^(TestChatSaveDeterministicPoints|TestChatRenameDeterministicCrashPoints|TestChatDeleteDeterministicCrashPoint|TestChatImportDeterministicCrashPoint)$' -count=1
                                          ok (84.8 s; 9 named crash points, each state asserted and re-asserted after restart)
go test ./tests/e2e -run '^(TestChatWriteCrashAtomicityRandomised|TestChatRenameRandomisedKills|TestChatDeleteRandomisedKills|TestChatImportRandomisedKills|TestChatGroupSaveCrashAtomicity)$' -count=1 -timeout 40m
                                          ok (300 s; seed 20261031; 115 iterations, every crash state old-or-new; rename 3/15 landed inside its window)
# mutation: the rename fix reverted to the pre-fix copy-then-delete shape + a label inside the window
go test ./tests/e2e -run '^TestMutationProbeRenameCopyThenDeleteLeavesBothNames$' -count=1
                                          observed: "MUTATION REPRODUCED: a kill between copy and unlink leaves BOTH
                                          chat.jsonl and chat-renamed.jsonl" (throwaway probe, not committed)
# restore from the file copy:
go test ./tests/e2e -run '^TestChatRenameDeterministicCrashPoints$' -count=1     ok (28.5 s)

# multipart/upload memory (§8.4, §8.4.1)
go test ./internal/server -run '^(TestReadBufferedMultipartPart|TestSpritesUpload|TestPinnedNodeSpritesUpload)' -count=1  ok (3.4 s)
# before/after binaries built from `6a870f6` (HEAD archive) and this change, same 200 MiB body:
#   BEFORE: status 200, peak working set 552.0 MB, 6.43 s, stored 209715200 bytes, _uploads 0
#   AFTER:  status 200, peak working set  37.7 MB, 2.67 s, stored 209715200 bytes, _uploads 0

# full suite after the lane's fixes (go test ./... -count=1 -timeout 30m), 465 s, exit 0, every package ok
# The two earlier full-suite runs are part of the evidence because each found a REAL lane defect:
#   1. the transcribe/speech handler fixtures lacked <dataRoot>/_uploads (the spooled part needs what
#      startup creates) -> three oracle suites answered 400 where pinned answers 200/500; fixed in aedbc15.
#   2. internal/fsretry/fsretry_test.go had MIXED line endings from a shell append (40 CRLF, 58 LF),
#      caught by TestCommittedGoSourcesAreWellFormedUTF8; the working file was normalised to LF.
```

| command | observed |
|---|---|
| `go vet ./...` | exit 0, no diagnostics (133 s cold; 18 s warm on go1.27.3) |
| `govulncheck ./...` BEFORE | exit 3; 15 reachable: stdlib go1.27.0 (fixed in Go 1.27.2/1.27.3) + `x/image@v0.24.0` + `x/text@v0.22.0` (§8.2) |
| `govulncheck ./...` AFTER | exit 0; "No vulnerabilities found", 0 affected, 0 reachable; 1 non-reachable module advisory (`GO-2026-5932`, `x/crypto/openpgp`, no fix, not imported) |
| `govulncheck -version` | govulncheck v1.9.0, built with go1.27.3, DB 2026-10-27T21:16:18Z |

## 11. Commits

* `64bc56e` fix(server): publish a character's copied chats directory atomically
* `f584570` fix(startup,server): survive a killed process / full disk on user-data writes, and stop tearing image overwrites
* `021173c` fix(configinit): repair an empty or whitespace-only config.yaml instead of failing boot
* `8794f42` test(hardening): fuzz targets, secret-leak sweep, traversal probes, docs/data-safety.md
* `2e87cc1` docs(data-safety): full-package runs and triage of the one local red
* `258b88d` build: move to Go 1.27.3 and patched x/image/x/text/x/crypto; govulncheck reachable 15 -> 0
* `bc092ab` fix(server): retry the Windows sharing violation when reading a node-persist record (surfaced by the 1.27.3 move, §7.1)
* `6a870f6` fix(startup,fsretry): retry the transient sharing violation on the last two bare node-persist reads (§7.2)
* `baad4d5` fix(server,startup,tests): make a killed chat write leave only a complete old or new state (§7.3)
* `db7b12c` fix(server): bound multipart upload memory on every route that buffers a file part (§8.4, §8.4.1)
* `6d0ab35` test(e2e): poll chat-write progress by directory entries, not file contents (§7.3)
* `aedbc15` test(server): give the transcribe/speech handler fixtures the `_uploads` directory a real install has (§8.4)
