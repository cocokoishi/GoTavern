# Data safety, concurrency and the security baseline (Beta 1 hardening)

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

This class is not audited beyond the account-read path in this lane; two other node-persist reads
(`startup.updateNodePersistRecord`'s read-before-write and `NodePersistKeys`) are still bare
`os.ReadFile` and could see the same window when a DIFFERENT process replaces a record — recorded as
residual risk (§9), not fixed here because they are not on the request read path this test exercises.

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
| multer field size | 500 MB | pinned `src/server-main.js:269` `limits: { fieldSize: 500 * 1024 * 1024 }`; GoTavern reads multipart fields with bounded readers in `characters.go`, `avatars_upload.go`, `sprites_upload.go` |
| multipart FILE parts | **unbounded in memory** in `readTranscribeUpload` (`openai_transcribe.go:83-103`), `readSpeechUpload` (`speech.go:646-670`) and `novelaiExtractPNG` (`novelai_generate.go:763`) | **residual risk / pinned divergence**: pinned's multer streams file parts to disk with no size limit, so an arbitrarily large upload is accepted there without unbounded RSS; GoTavern buffers it. Authenticated route, but a memory-exhaustion path. Fixing it means spooling or a cap, which changes the accepted-upload contract — reported, not made. |
| outbound response bodies | buffered without a cap (`outbound/transport.go`, provider handlers) | inherited from pinned's `fetch` (also buffers); residual risk, not changed. |

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

1. Multipart file parts are buffered in memory without a bound on three routes (§8.4) while pinned
   spools to disk — authenticated memory-exhaustion path, contract change required to fix.
2. `image-metadata.json` recovery overwrites a corrupted index (§5) — pinned parity, product decision
   needed.
3. Trailing dot/space after 255-byte truncation in sanitized filenames (§6.1) — pinned parity,
   product decision candidate.
4. `internal/migrate` destination writes are not atomic: `copyConfig` uses `os.WriteFile`
   (`migrate.go:537`) and `copyFile` opens the destination with `O_TRUNC` (`migrate.go:641`). The
   destination is a fresh tree and a re-run moves destination conflicts to a backup before recopying,
   so the window is recoverable rather than corrupting user data; not fixed in this lane.
5. Chat backups are not implemented (recorded gap in `server/chats.go:14-21`), so a chat corruption has
   no product-created rolling backup.
6. A process killed during `atomicReplace` leaves a `.gotavern-content-log-*.tmp` scratch file next to
   the target (the target itself is intact). Harmless, never read, removed on a later successful
   replace only if the name collides (it cannot: unique token); disk leak bounded by crash count.
7. `go test -race` is unavailable on windows/arm64; concurrency tests are race-detector-clean by design
   and must be run on the Linux CI gate (§7).
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
9. **Two node-persist reads outside the account request path are still bare `os.ReadFile`**
   (`startup.UpdateNodePersistRecord`'s read-before-write and `startup.NodePersistKeys`, both in
   `internal/startup/storage.go`). On Windows a DIFFERENT process replacing the same record can make
   those fail with the same sharing violation §7.1 fixed for the account read path; the rename side is
   retried, these reads are not. Not fixed here: neither is on the authenticated-request read path, and
   changing them needs its own failure reproducer.

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
