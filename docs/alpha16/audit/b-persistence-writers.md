# Lane B — persistence writers, startup mutations, migration/rollback, path policy

**Status: M0 read-only audit. No product behaviour was changed.** Read at
`HEAD c256f21` on `lane/alpha16-program` (working tree clean except
untracked `docs/alpha16/`). Pinned oracle: `../SillyTavern` at
`06bde939fb1e9c4c8d8641d810f0a916b5bce127` (verified in `internal/startup/runtime_roundtrip_test.go:107`).

Method: read the shared write core (`internal/startup/user_content_file.go`, `user_data_lock.go`,
`content.go`, `storage.go`), then every startup mutation, then every mutating route via its registered
handler, and for each finding re-read the pinned function that defines the behaviour. Where a claim is a
negative ("no lock here"), the exact function was read and the lock symbol grepped, not inferred from a
bounded listing (`AGENTS.md` rule 11). Probe claims name a test function that was located with
`Select-String '^func Test'`; a test file that exists but whose function was not located is NOT counted as
a probe.

---

## 1. The write core (shared by almost every writer)

All user-tree mutations are funnelled through five primitives. Every writer row below says which one it
uses, because that decides its lock, atomicity and containment.

| Primitive | What it guarantees | Where |
|---|---|---|
| `UpdateUserContentFile` / `...IfChanged` | per-data-root `flock` held for the whole read-modify-write; relative path required; `ensureContained` + `ensureResolvedContained` (symlink-resolving) before read and again before write; write through `atomicReplace`; `IfChanged` lets the callback decline the write, preserving existence, bytes and mtime | `internal/startup/user_content_file.go:13-69` |
| `lockUserContentRoot` | resolves `<dataRoot>/<handle>`, canonicalises it, takes **one lock keyed by `<dataRoot>`** (`acquireContentLock(filepath.Dir(userRoot))`), then re-checks containment against the canonical root. The lock is therefore shared by ALL users of a data root, not per user | `internal/startup/user_data_lock.go:12-38`; key derivation `internal/startup/content.go:398-414` |
| `atomicReplace` | unique temp file in the target dir -> chmod to existing mode -> optional injected write failure -> `Sync` -> close -> `renameIntoPlace` (Windows sharing-violation retry) -> directory fsync. Target is old bytes or new bytes, never a prefix | `internal/startup/content.go:338-396`; retry `content.go:327-329`; fault points `content.go:378,383,390` |
| `atomicCreate` | temp file + `Sync` + `os.Link` to target (fails if target exists) + unlink temp + dir fsync. Used for never-overwrite creations | `internal/startup/storage.go:448-494` |
| `WriteFileAtomic` | exported alias of `atomicReplace`, for callers outside the package (images, avatars, thumbnails, stats, providers) | `internal/startup/secrets_state.go:736-740` |

Consequences that matter for every row below:

1. **Atomicity is universal for the file-replace path.** A direct `os.WriteFile` outside the core is rare
   and each instance is classified in §3 (only two are product-tree writes: `characters_write.go:1091`
   inside a staging tree, and `configinit` migration write-through which has its own atomic writer).
2. **Lock scope is the data root, not the user.** Two users saving settings serialize against each other
   (`user_data_lock.go:21-25` + `content.go:403-409`). This is a contention question (Lane C); it is a
   correctness *safety* property here: cross-user write interleaving cannot corrupt a file.
3. **Containment is checked twice and resolves symlinks.** `ensureResolvedContained`
   (`internal/startup/user_data_migration.go:189-227`) resolves the deepest existing prefix of the path
   and compares; it is called before the read and again before the replace, so a symlink swapped in
   between (TOCTOU) is still caught, and an existing symlink target that escapes the root is refused.
4. **Windows sharing violations are tolerated, not masked.** `fsretry.Do` retries 20 x 10 ms
   (`internal/fsretry/fsretry.go:24-41,51-64`) because Go opens without `FILE_SHARE_DELETE` while Node
   opens with all share modes; a stuck handle still fails after ~200 ms.
5. **Boot locks are bounded.** `lockacquire.Acquire` never calls unbounded `flock.Lock`; it uses
   `TryLockContext` with a per-lock 10 s bound inside a 30 s boot budget, and names the lock, path and
   wait in the error (`internal/lockacquire/lockacquire.go:28-36,70-135`). Four boot-path locks exist:
   config (`internal/configinit/config.go:156-166`), cookie secret (`internal/startup/secret.go:74-90`),
   user storage (`internal/startup/storage.go:430-446`), content seeding
   (`internal/startup/content.go:398-414`).

---

## 2. Writer matrix — runtime mutating surfaces

Legend: **lock** `content` = the data-root `flock` of §1; `storage` = the node-persist lock
(`storage.go:430-446`); `settingsSaveMu` = process mutex; `none` = no lock (stated only after reading the
function). **probeState** `covered` = a located test drives this surface and asserts durable bytes or the
error shape; `gap` = no probe located, with what was grepped.

### 2.1 settings, accounts, backups

| ID | Surface / route | Writer | Lock | Atomicity | Path policy | Error shape | Probe / state |
|---|---|---|---|---|---|---|---|
| W01 | `POST /api/settings/save` (`http.go:393`) | `startup.SaveSettings` -> `atomicReplace` (`internal/startup/settings_backup.go:61-99`), async snapshot via `settingsSaveMu` + `time.AfterFunc` (`internal/server/settings_save.go:50-87`) | content; `settingsSaveMu` for the throttle map only | atomicReplace; snapshot after the write | containment on user root and settings path (`settings_backup.go:85-91`) | 500 on any error (`settings_save.go:43-48`) | `TestPinnedNodeSettingsSave` (`internal/server/settings_save_test.go`), `TestSettingsSaveTrailingSnapshotUsesLatestSettings`, `TestSettingsSaveNeverPublishesATornJSON` (`data_safety_concurrency_test.go`) — covered |
| W02 | `POST /api/settings/make-snapshot` (`http.go:395`) | `startup.CreateSettingsSnapshot` (`settings_snapshots.go:90-165`) | content | atomicReplace, retention delete | resolved containment; retention refuses a directory (`settings_snapshots.go:265-271`) | 500 / 404 by route | `internal/server/settings_save_test.go`, `internal/startup/settings_backup_test.go` — covered |
| W03 | `POST /api/settings/restore-snapshot` (`http.go:396`) | `startup.RestoreSettingsSnapshot` (`settings_snapshots.go:169-214`) | content | atomicReplace of settings.json. NOTE: pinned does `rmSync` then `copyFileSync` (`src/endpoints/settings.js:366-367`), a window where settings.json does not exist; Go is atomic instead. Divergence in the safe direction, unobservable except across a crash | resolved containment (`:194-209`) | 404 missing, 500 otherwise | `TestPinnedNodeAccountResetSettingsContract` does not cover restore; `settings_save_test.go` covers snapshots. Row recorded as `verified-risk` only for the parity question — covered by snapshot tests for the write itself |
| W04 | `POST /api/users/reset-settings` (`http.go:378`) | `os.Remove` of `settings.json` then forced `settings` seeding (`internal/server/account_reset.go:51-76`) | **none for the remove**; seeding takes content | remove is atomic unlink; seed target created via `atomicCreate` | path from `DirectoriesForUser`, Lstat guard against a directory (`account_reset.go:57-61`) | 204 on success; 500 on remove/seed-dir failure (`:62-69`) | `TestPinnedNodeAccountResetSettingsContract` (`account_reset_settings_test.go`) — covered for contract; **no test for a concurrent save during the unlinked window** |
| W05 | `POST /api/users/reset-step2` (`http.go:380`) | `os.RemoveAll(<dataRoot>/<handle>)` then `EnsureDirectories` then seeding (`internal/server/account_data_reset.go:107-137`) | **none** (the seed call is the only locked step) | RemoveAll + re-create; a crash mid-remove leaves a partial user tree with no backup | `DirectoriesForUser` rejects escaping handles (`storage.go:335-349`); no backup and no containment re-check before RemoveAll | 204; 500 on failure (`:117-128`) | `TestPinnedNodeAccountDataResetContract` (`account_data_reset_test.go`) — covered for contract; **no crash/kill probe** |
| W06 | node-persist account update (`accounts.go:950,1091,1175,1285`) | `startup.UpdateNodePersistRecord` (`storage.go:167-215`) | storage | read under lock, `atomicReplace` | storage dir canonicalised; filename is `sha256(key)` so the key cannot traverse | typed error per branch (`storage.go:186-214`); routes map to 500 | `TestUpdateNodePersistRecordPreservesFieldsAndSerializesConcurrentUpdates` (`storage_test.go`) — covered |
| W07 | node-persist account insert (`account_create.go:106`) / delete (`accounts.go:1340`) | `SetNodePersistRecord` (`storage.go:221-266`) / `RemoveNodePersistRecord` (`storage.go:271-304`) | storage | `atomicCreate` when absent, `atomicReplace` when present; delete + dir fsync | as W06 | 500 | `TestSetNodePersistRecordMatchesPinnedNodePersistSetItemShape`, `TestRemoveNodePersistRecordRemovesOnlyTheSelectedKey`, `TestPinnedNodeAccountCreate...` (`account_create.go`) — covered |
| W08 | `POST /api/users/backup` (`http.go:377`) | stream a ZIP of the user root to a temp file and to the response (`internal/server/account_backup.go:52-78`) | none (read-only walk) | temp file in `os.TempDir`; nothing written into the data root | `filepath.WalkDir(root)` rooted at `<dataRoot>/<handle>`; `secrets_migration_` backups excluded (`account_backup.go:157`) | 403/400/500 JSON per pinned | no dedicated test file located (grepped `internal/server` for `user.*backup|createBackupArchive`; only `account_backup.go`) — **gap** |
| W09 | full-data-reset of user root via backup delete (`accounts.go:1345`) | `os.RemoveAll(userRoot)` after the account record is removed | storage for the record only | recursive delete, no staging | `userRoot` from `DirectoriesForUser` | 500 | no test located (grepped `RemoveAll(userRoot)`) — **gap** |
| W10 | settings backups at startup (`DataStartup` step) | `BackupSettings` -> `atomicReplace` (`settings_backup.go:28-59,152-227`) | content | atomic; duplicate-aware (compares latest backup bytes); retention via `os.Remove` with Lstat directory guard | resolved containment of backups dir, settings path and backup path | returned as a startup diagnostic, does not stop boot (`data_startup.go:135`) | `TestBackupSettingsMatchesPinnedNode`, `TestBackupSettingsStopsAfterFirstUserError` (`internal/startup/settings_backup_test.go`) — covered |

### 2.2 characters, cards, sprites

| ID | Surface / route | Writer | Lock | Atomicity | Path policy | Error shape | Probe / state |
|---|---|---|---|---|---|---|---|
| W11 | `POST /api/characters/create` (`characters.go:38`) | `writeCharacterCard` -> `UpdateUserContentFile` (`characters_write.go:171-180`), called with its error discarded at `characters_write.go:262` | content | atomicReplace of the PNG | `SanitizeUserFilename` on the name (`characters_write.go:191-198`); relative path under `characters/` | **200 with the avatar name even when the write failed.** This is pinned parity: `writeCharacterData` catches and returns `false` (`src/endpoints/characters.js:220-259`) and `/create` ignores it (`:1024-1049`). Classified `intentional-parity` | `TestPinnedNodeCharactersWrite` (`characters_write_test.go`) — covered for contract; no failing-write probe (a read-only dir test exists only at e2e level, `a15_readonly_linux_test.go`) |
| W12 | `POST /api/characters/edit`, `edit-attribute`, `merge-attributes`, `edit-avatar` (`characters.go:40-43`) | `writeCharacterCard` | content | atomicReplace | sanitized name, containment via core | 500 | `TestPinnedNodeCharactersWrite` — covered |
| W13 | `POST /api/characters/rename` (`characters.go:39`) | card write (`characters_write.go:344`) + `copyDirectoryAtomically` of `<chats>/<old>` -> `<new>` (`characters_write.go:329-342,1120-1163`) + `os.RemoveAll(oldChatsPath)` (`:337`) + `startup.DeleteUserFile` old card (`:348`) | each step takes/releases content (the directory copy is NOT under the lock) | **staged directory copy published by one rename** (`:1148-1161`); crash before the publish leaves only an unpublished `.gotavern-copy-*` staging dir, so a retry re-copies instead of trusting a partial tree | old/new names sanitized; both under the user root | 500; on a directory-copy failure the original is kept (pinned keeps it too) | `TestCopyDirectoryAtomicallyPublishesNothingWhenTheCopyFailsMidway`, `TestCopyDirectoryAtomicallyRefusesAnExistingDestinationWithoutTouchingIt` (`data_safety_copy_test.go`) — covered |
| W14 | `POST /api/characters/delete` (`characters.go:44`) | `startup.DeleteUserFile` card (`characters_write.go:865`), then when `delete_chats` is truthy `os.RemoveAll(<chats>/<name>)` (`:874-882`) | card delete holds content; **the recursive chats delete does not** (comment at `:875-876` says pinned is unlocked) | unlink; recursive delete | `SanitizeUserFilename(dirName)` before joining | 500 | `TestPinnedNodeCharactersWrite`; no crash probe of `delete_chats` (grepped `delete_chats` in `*_test.go`: only characters_write_test) — **gap for the recursive branch** |
| W15 | `POST /api/characters/import` (`characters.go:45`) | `importFromByaf`/`CharX`/`YAML` -> `writeCharacterCard`/`writeUserContentBytes` (`characters_import.go:62`, `characters_import_formats.go:249-253`) | content | atomicReplace; CharX auxiliary assets are individual atomic writes | `preservedFileName` sanitized; asset paths sanitized; symlink not followed (`:1277-1383`) | 400/500; CharX aux-asset failures are swallowed, pinned warns and continues (`characters_import_formats.go:468-506`; pinned `src/endpoints/characters.js:762-767`) — `intentional-parity` | `TestPinnedNodeCharactersImport` (`characters_import_test.go`) — covered |
| W16 | `POST /api/characters/duplicate` (`characters.go:46`) | read card, `writeCharacterCard` under the new unique name (`characters_write.go:950-980`) | content | atomicReplace | unique-name search bounded by existing files | 404 missing source / 200 `{error:true}` per pinned | `TestPinnedNodeCharactersWrite` — covered |
| W17 | `POST /api/sprites/upload`, `upload-zip`, `delete` (`sprites_upload.go:35-40`, `http.go:517`) | locked by an **anchor-file trick**: `spritesWithContentLock` calls `UpdateUserContentFileIfChanged` with a non-existent anchor path whose callback returns `shouldWrite=false`, so the lock is held while the operation runs (`sprites_upload.go:159-168`); writes are temp + `os.Rename` (`:192-211`); zip/rename use `os.Rename` under the same lock (`:351-357`) | content (via anchor) | temp+rename; zip extraction writes each file, not the whole tree atomically | `spritesResolvePath` sanitizes both segments (`:139-157`); containment checked by core | 500 | `TestPinnedNodeSpritesUpload` (`sprites_upload_test.go`); `sprites_delete_test.go` — covered |
| W18 | `POST /api/avatars/upload` (`http.go:404`) | `startup.WriteFileAtomic` directly (`internal/server/avatars_upload.go:111`) | **none** | atomicReplace | `filename` comes from `overwrite_name` or a timestamp; derived from `sanitize` upstream (pinned `avatars.js:59`); no containment check of its own, relies on `DirectoriesForUser` | 500; staged temp removed on every failure branch (`:106,112`) | `TestPersonaAvatarUploadCreatesTheFile`, `...HonoursOverwriteName`, `...AppliesCrop` (`avatars_upload_test.go`) — covered; no probe for a write failure |
| W19 | `POST /api/avatars/delete` (`http.go:403`) | `startup.DeleteUserAvatar` (`internal/startup/user_avatars.go:48-104`) | content | unlink avatar + persona thumbnail | resolved containment for avatar dir and thumbnail dir | 500 / false | `TestPinnedNodePersonaAvatarDeletion` (`avatars_delete_test.go`) — covered |

### 2.3 chats, groups, world info, presets, quick replies, themes, moving UI, files, assets, images, image metadata

| ID | Surface / route | Writer | Lock | Atomicity | Path policy | Error shape | Probe / state |
|---|---|---|---|---|---|---|---|
| W20 | `POST /api/chats/save` (`chats.go:28`) | full JSONL rewrite through `UpdateUserContentFile` (`chats.go:229-235`); parent dir `MkdirAll` (`:217`) | content | atomicReplace of the whole file (the pinned `tryWriteFileSync` truncates, `src/endpoints/chats.js:541`) | `SanitizeUserFilename(file+".jsonl")`, then `pinnedPathUnderParent` (`chats.go:189-194,73-84`) | pinned JSON error bodies, 500 (`chats.go:236-240`) | `TestPinnedNodeChatsSaveGet`, `TestChatSaveNeverPublishesATornJSONL`, e2e `chat_crash_test.go` + `a15_concurrent_writers_test.go` — covered |
| W21 | throttled chat backup + `checkChatIntegrity` after save | **not implemented**; recorded gap at `internal/server/chats.go:16-23` | — | — | — | the backup/`integrity` side effects do not happen | no probe exists because the behaviour is absent; recorded in `docs/compat-matrix.md` — **gap (known, documented)** |
| W22 | `POST /api/chats/rename` (`chats_routes.go:20`) | `startup.RenameUserContentFile` (`user_rename.go:34-78`) | content | single `os.Rename` + `Chtimes` (pinned is copy+unlink, `src/endpoints/chats.js:644-645`); crash leaves one name, never both | relative paths required, `Clean` + containment + resolved containment for both | false on missing source, 500 on other | `TestPinnedNodeChatsMutations`, `TestChatRenameDeterministicCrashPoints`, `TestChatRenameRandomisedKills` — covered |
| W23 | `POST /api/chats/delete` (`chats_routes.go:21`) | `startup.DeleteUserFile` (`chats_mutations.go:199`) | content | unlink | resolved containment of the parent | 500 | `TestChatDeleteDeterministicCrashPoint`, `...RandomisedKills` — covered |
| W24 | `POST /api/chats/import` (`chats_routes.go:23`) | `UpdateUserContentFile` (`chats_import.go:158`) | content | atomicReplace | relative path derived from sanitized file name | 500 | `TestPinnedNodeChatsImport`, `TestChatImportDeterministicCrashPoint`, `...RandomisedKills` — covered |
| W25 | `POST /api/chats/group/save` (`chats_routes.go:28`) | JSONL rewrite via `UpdateUserContentFile` (`chats_group.go:192,239`) | content | atomicReplace | sanitized chat name; parent `MkdirAll` | 500 | `TestChatGroupSaveCrashAtomicity` (e2e) — covered; no route-level oracle test file located (`chats_group_test.go` absent; grepped `chats_group`) — **gap** |
| W26 | `POST /api/chats/group/delete` (`chats_routes.go:29`) | `DeleteUserFile` (`chats_group.go:126`) | content | unlink | relative path | 500 | e2e `chat_crash_test.go` covers group save only — **gap** |
| W27 | `POST /api/groups/create`, `/edit` (`chats_routes.go:32-33`) | `UpdateUserContentFile` (`groups.go:194,275`) | content | atomicReplace; pinned `writeFileAtomicSync` (`src/endpoints/groups.js:186,199`) | sanitized group file name | 500 | `TestPinnedNodeGroups` (`groups_test.go`) — covered |
| W28 | `POST /api/groups/delete` (`chats_routes.go:34`) | per-chat `DeleteUserFile` with errors discarded (`groups.go:331`, pinned catch swallows), then group file delete (`:342`) | content per file | unlink | sanitized chat names | 200 `{ok:true}`; per-chat failures are swallowed (pinned parity) | `TestPinnedNodeGroups` — covered for the happy path; no probe for the swallowed branch |
| W29 | `POST /api/worldinfo/edit`, `/import` (`worldinfo.go:68-72`) | `UpdateUserContentFile` (`worldinfo.go:446,498`) | content | atomicReplace; pinned `writeFileAtomicSync` (`src/endpoints/worldinfo.js:130,154`) | `SanitizeUserFilename(fileName)` under `worlds/` | 500 | `TestPinnedNodeWorldInfoRoutes`, `TestWorldInfoEditNeverPublishesATornJSON` — covered |
| W30 | `POST /api/worldinfo/delete` (`worldinfo.go:70`) | `DeleteUserFile` (`worldinfo.go:376`) | content | unlink | `worlds/<sanitized>` | 500 / 404 | `TestPinnedNodeWorldInfoRoutes` — covered |
| W31 | `POST /api/presets/save`, `/delete`, `/restore` (`presets.go:49-51`) | `UpdateUserContentFile` / `DeleteUserFile` (`presets.go:225,265`; restore re-reads the pinned default and writes it) | content | atomicReplace; pinned `writeFileAtomicSync` (`src/endpoints/presets.js:56`) | folder key from `apiId` mapping, name sanitized by pinned sanitize-filename port (`presets.go:199-215,173-187`) | 500 for a non-string name (pinned throws), 400 otherwise | `TestPinnedNodePresetRoutes`, `TestPresetSaveNeverPublishesATornJSON` — covered |
| W32 | `POST /api/quick-replies/save|delete` (`http.go:397-398`) | `SaveQuickReplyPreset` / `DeleteQuickReplyPreset` (`internal/startup/user_presets.go:31-94`) | content | atomicReplace; pinned `writeFileAtomicSync` | pinned `SanitizeUserFilename` + directory containment | 500; delete of a missing preset is a no-op 200 (pinned) | `TestPinnedNodeQuickReplySaveAndDelete` — covered |
| W33 | `POST /api/themes/save|delete` (`http.go:399-400`) | `SaveThemePreset` / `DeleteThemePreset` (`user_presets.go:36-43,66-94`) | content | atomicReplace | as W32 | 500; delete returns 404 for `fs.ErrNotExist` (`themes.go:64-71`) | `TestPinnedNodeThemesSaveAndDelete` — covered |
| W34 | `POST /api/moving-ui/save` (`http.go:401`) | `SaveMovingUIPreset` (`user_presets.go:41-43`, `moving_ui.go:10-40`) | content | atomicReplace | as W32 | 500 | `TestPinnedNodeMovingUISave` — covered; no delete route (pinned has none) |
| W35 | `POST /api/files/upload` (`http.go:406`) | `startup.SaveUserFile` (`user_files.go:11-55`) | content | atomicReplace; if the target exists its **resolved** path is used, so a symlink to inside the root is written through (Node follows symlinks) and one to outside is refused (`:35-46`) | `SanitizeUserFilename` route-side; containment + resolved containment | 500 | `TestPinnedNodeFilesUpload` — covered |
| W36 | `POST /api/files/delete` (`http.go:407`) | `DeleteUserFile` (`user_files.go:59-88`) | content | unlink | containment; resolved containment of the parent; refuses a directory (`:81-83`) | 500; absent path -> false | `TestPinnedNodeFilesDelete` — covered |
| W37 | `POST /api/assets/delete` (`assets.go:41-48`) | `DeleteUserFile` (`assets.go:290`) and directory removal (`assets.go:101-106`) | content for the file delete | unlink / MkdirAll; directory delete is `os.Remove` (empty only) | `assets/<category>/<filename>` | 500 | `TestPinnedNodeAssetsRoutes` (`internal/server/assets_test.go`) — covered |
| W38 | `POST /api/assets/download` (`assets.go:41-48`) | staged download then `UpdateUserContentFileIfChanged` index write (`assets_download.go:257`), temp dir `MkdirAll` (`:81`) | content for the index write | atomic for the index; downloaded bytes go through a staged path + content write | staged path under `assets/temp`; index write relative to root | 500 | `TestPinnedNodeAssetsDownload`, `TestAssetsDownloadRemovesTheTempPath` (`assets_download_test.go`) — covered |
| W39 | `POST /api/images/upload` (`images.go:75`) | `writeUserImageFile` -> `WriteFileAtomic` (`images.go:138-149,217`) | **none** | atomicReplace (comment at `images.go:138-146` explains why not `WriteFile`) | filename `SanitizeUserFilename`-ed; `ch_name` sanitized; base dir `user/images` from the directory template | 500 with the pinned JSON error body | `TestImagesRoutesMatchPinnedOracle`, `TestImageUploadOverwriteIsNeverObservedTorn` (`data_safety_concurrency_test.go`) — covered |
| W40 | `POST /api/images/delete` (`images.go:82`) | `os.Remove` of the resolved path (`images.go:465`) | none | unlink | path validated against the images root before delete (read `images.go:440-470`) | 500 | `TestImagesRoutesMatchPinnedOracle` — covered |
| W41 | `POST /api/image-metadata` (index replace), `folders/*` | `UpdateUserContentFile` / `...IfChanged` on `imageMetadataIndexFilename` (`image_metadata_folder_create.go:45`, `...update.go:43`, `...delete.go:31`, `...assignments.go:55`, `...set_thumbnails.go:43`, `image_metadata_cleanup.go:26`, `image_metadata_generate.go:548`) | content | atomicReplace, `IfChanged` avoids rewriting when the index is unchanged | index filename is a constant; folder/file names sanitized (read `image_metadata_index.go:12667`-sized helper set) | 500 | `TestPinnedNodeImageMetadataFolderCreation/Update/Delete/Assignments/SetThumbnails`, `TestPinnedNodeImageMetadataCleanup`, `TestPinnedNodeImageMetadataIndexReadRoutes` — covered |
| W42 | `POST /api/backgrounds/upload` (`http.go:430`) | `startup.InstallUserBackgroundUpload` (`user_backgrounds.go:202-270`) | content | copy staged -> temp in background dir -> `Sync` -> `Rename`; thumbnail invalidated (`:243-269`) | staged path must be inside `<dataRoot>/_uploads` and the data root after resolution (`:213-230`); target containment + resolved containment | 500 | `TestPinnedNodeBackgroundUpload` — covered |
| W43 | `POST /api/backgrounds/rename` (`http.go:423`) | `startup.RenameUserBackground` (`user_backgrounds.go:98-157`) + index `IfChanged` (`backgrounds_rename.go:67`) | content | copy to temp + rename + remove old; thumbnail removed | containment on old/new; old must be regular (`:125-127`) | 500 / false | `TestPinnedNodeBackgroundRename` — covered |
| W44 | `POST /api/backgrounds/delete` (`http.go:416`) | `startup.DeleteUserBackground` (`user_backgrounds.go:42-94`) + index `IfChanged` (`backgrounds_delete.go:70`) | content + a second content lock for the index | unlink | containment; directory targets refused (`:65-67,87-89`) | 500 | `TestPinnedNodeBackgroundDelete` — covered |
| W45 | `POST /api/secrets/*` (`secrets.go:55-62`) | `openSecretsFile(...).save()` -> `atomicReplace` under the content lock held for the whole read-modify-write (`internal/startup/secrets_state.go:171-259,736-740`) | content | atomicReplace; pinned `_writeSecretsFile` stringify(4) (`src/endpoints/secrets.js`) | create-on-missing writes the exact `{}` bytes (`secrets_state.go:227-238`) | 500, and a malformed entry is a typed error (`:121-124`) | `TestSecretsRoutesMatchPinnedHTTPOracle`, `TestSecretsOracleFixtureIsDiscriminating`, `TestSecretValueIsNeverEchoedOnRouteErrorPaths` — covered |

### 2.4 extensions, vector, SD, providers, misc

| ID | Surface / route | Writer | Lock | Atomicity | Path policy | Error shape | Probe / state |
|---|---|---|---|---|---|---|---|
| W46 | `POST /api/extensions/install` (`extensions.go:97`) | `git clone --depth=1 [--branch] <url> <path>` (`extensions_git.go:685-706`); failed clone is removed (`:706`) | none | git's own clone into a fresh path; a killed clone leaves a partial directory that the rollback removes only on error, not on SIGKILL | clone URL parsed with `new URL` semantics (`:287-317`); target name sanitized | 500 | `TestPinnedNodeExtensionRoutes`, `TestPinnedExtensionDiscover*` (install corpus) — covered for the success and failure paths |
| W47 | `POST /api/extensions/update` (`extensions.go:98`) | `git pull origin <branch>` + `git fetch` (`extensions_git.go:413-437`) | none | git; a dirty worktree is refused by git itself | extension path sanitized; `git -C <path>` so CWD independent (`:56-73`) | 500 | `TestExtensionUpdateRefusesADirtyWorktreeAndKeepsTheUserEdits` (`extensions_dirty_worktree_test.go`), `TestPinnedNodeExtensionRoutes` — covered |
| W48 | `POST /api/extensions/switch` (`extensions.go:100`) | `git checkout` / `checkout -b` (`extensions_git.go:575-604`) | none | git checkout; branch names validated (`:530-604`) | as W47 | 500 | **gap** for switch: grepped `internal/server` and `tests` for `/api/extensions/switch` and `serveExtensionSwitch`; `extensions_test.go` covers install/move/delete/version/discover only |
| W49 | `POST /api/extensions/move` (`extensions.go:101`) | `copyExtensionTree` then `os.RemoveAll(source)` (`extensions_fs.go:282-289,352-383`) | none | **not atomic**: a crash mid-copy leaves a partial destination and the source intact; a retry answers 409 because the destination now exists. Copied from pinned `fs.cpSync` + `fs.rmSync` (`src/endpoints/extensions.js:366-367`) | source/destination locations from the client's `source`/`destination` strings resolved through the pinned location map; extension name sanitized | 409 conflict / 500 | `TestPinnedNodeExtensionRoutes` covers the route; no crash probe of the copy window (grepped `copyExtensionTree` in tests: none) — **gap** |
| W50 | `POST /api/extensions/delete` (`extensions.go:103`) | `removeExtensionTree` -> `os.RemoveAll` (`extensions.go:259-268`, `extensions_fs.go:324`) | none | recursive delete, no backup (pinned `rm` recursive) | sanitized name + global/user location; global requires admin (`extensions_fs.go:312-316`) | 404 missing / 500 / 200 text | `TestPinnedNodeExtensionRoutes` — covered |
| W51 | `POST /api/vector/insert|delete|purge*` (`vector.go:82-88`) | `UpdateUserContentFile` for the index (`vector.go:256`), `IfChanged` for deletes (`:295`), `os.RemoveAll` for a purge (`:303`) | content for index writes | atomicReplace for the index; purge is recursive delete | vector id/folder derived from pinned folder naming; `os.MkdirAll` for the folder (`:224`) | 500 | `TestPinnedNodeVectorRoutes` — covered |
| W52 | `POST /api/sd/comfy/save|save-workflow|delete|rename` (`sd_comfy.go`) | save -> `UpdateUserContentFile` (`sd_comfy.go:179`); delete -> `DeleteUserFile` (`:213`); rename -> lock held and `os.Rename` inside the `IfChanged` callback (`:263-265`) | content | atomicReplace; rename is a single `os.Rename` performed **inside the lock** by abusing `IfChanged`'s callback | workflow name sanitized (`sdUserRelativePath`) | 500 | `TestPinnedNodeSDComfyWorkflows` (`sd_workflows_test.go`), `TestSDComfyGenerateRoutesMatchPinnedOracle` — covered |
| W53 | tokenizer cache materialisation (`webBytes`) | `os.WriteFile(<cache>/<model>.json)` + `os.Remove(.gz)` (`internal/server/tokenizers.go:374-390`) | none | **not atomic**: a crash truncates a derived tokenizer cache file | cache dir is `<install>/tokenizers` (or configured); fixed model names | failures ignored (`_ =`) and retried on the next request; a corrupted cache file would be returned by `os.ReadFile` later | no test located for a corrupted-cache recovery (grepped `tokenizers` in tests: route tests only) — **gap; derived cache only, self-healing on re-materialisation is not proved** |
| W54 | access-log append | `os.OpenFile(O_APPEND|O_CREATE)` + write (`internal/server/access_log.go:154-166`) | none | append, not replace; a partial line is possible on a kill | `filepath.Join(dataRoot,"access.log")` (`startup/access_log_migration.go:26-28`) | error goes to stderr only (`access_log.go:123-126`, pinned logs the same) | no test located for the append/partial-line behaviour (grepped `access_log` in tests: migration only) — **gap** |
| W55 | thumbnail cache write `GET /thumbnail/<computed>` | `WriteFileAtomic` into `<user>/thumbnails/**` (`internal/server/thumbnails.go:324-328`) | none | atomicReplace (pinned `writeFileAtomicSync`) | cache path derived from the thumbnail type + sanitized filename | on failure falls back to serving the original / 404 | `internal/server/thumbnails_test.go` exists (grepped; function names not read) — covered for the route, cache-write failure not probed |
| W56 | `POST /api/data-maid/finalize` then `/delete` | finalize stores a token->paths map in memory; delete `os.Remove`s those paths after `isPathUnderParent` and a stat (`internal/server/data_maid.go:302-361`) | none | unlink per file | only paths captured by finalize, each re-checked under the user root (`:349-351`) | 403 token mismatch; 500 remove failure | `TestPinnedNodeDataMaidRoutes` — covered |

### 2.5 summary counts

- **Writer rows: 56** (W01-W56). This includes one surface the audit found to be *absent* (W21 chat
  backup/integrity, recorded at `internal/server/chats.go:16-23`), one startup-derived writer (W54), and
  the routes whose writers are thin calls into a verified startup helper.
- **Rows with a located probe: 46 covered, 10 gap.** Gap rows: W08 (user full-backup ZIP), W09
  (delete-user recursive removal of the user root), W14 (the `delete_chats` branch of character delete),
  W21 (absent behaviour, deliberately recorded), W25 and W26 (group-chat save/delete: no route-level
  oracle test file exists; save has an e2e crash test only), W48 (extension switch), W49 (extension-move
  copy window), W53 (tokenizer cache), W54 (access-log append). Several are "covered
  elsewhere" operationally — W21 is a documented non-implementation — but as *probes of the mutation* they
  are gaps, and they are named that way rather than counted as covered.
- **Rows whose primary write goes through the shared lock and `atomicReplace`/`atomicCreate` end to end:
  37 of 56** (W01-W03, W06-W07, W10-W13, W15-W17, W19-W20, W22-W36, W41-W45, W51-W52, W55). The other
  19 are stated per row and are: W04 (unlink outside the lock, then a locked seed), W05 (recursive reset
  outside the lock), W08 (read-only, N/A), W09 (recursive delete outside the lock), W14 (card locked,
  `delete_chats` not), W18 and W39 (atomic single-file replacement, no lock), W21 (behaviour absent),
  W37 (file delete locked, directory unlink not), W38 (index locked, download staged), W40 (unlink, no
  lock), W46-W48 (git subprocesses), W49-W50 (copy+delete and recursive delete), W53-W54 (neither atomic
  nor locked), W56 (unlink, no lock). "No lock" here is never a synonym for "not atomic": the
  atomic/unlocked and unlocked/unsafe cases are distinguished in the rows.

---

## 3. Startup mutation table

Every row is a *persistent* effect of boot. "pinned basis" is the pinned source that defines it; the
ordering below is `internal/startup/data_startup.go:61-140`, compared against pinned's promise chain
`src/server-main.js:480-489` (`initUserStorage -> ensurePublicDirectoriesExist -> migrateUserData ->
migrateSystemPrompts -> migratePublicOverrides -> verifySecuritySettings -> preSetupTasks`) and
`preSetupTasks` `src/server-main.js:296-313` (group metadata -> content -> disk cache -> flat secrets ->
uploads -> access log -> settings init -> stats init). **The order matches.**

| ID | Mutation | Implementation | Pinned basis | Idempotence / probe |
|---|---|---|---|---|
| S1 | `config.yaml` creation when absent | `configinit.Initialize` writes the pinned-generated bytes atomically (`internal/configinit/config.go:88-99,168-218`) | `src/config-init.js:168-171` | second boot leaves it alone (`config_idempotence_test.go`) |
| S2 | `config.yaml` **legacy-key migration + default insertion** | `migrateConfig` (25 migration rows, `config.go:46-72,442-471`), `mergeDefaults` recursive (`:473-510`), env-var migration (`:654-691`), rewritten only if changed (`:121-137`) | `src/config-init.js:174-239` | `config_test.go`, `config_idempotence_test.go`, `config_interrupted_test.go`, `data_safety_empty_config_test.go`, `fuzz_config_test.go` |
| S3 | `cookie-secret.txt` create or migration from legacy config value | `InitializeCookieSecret` (`internal/startup/secret.go:32-72`) | `src/users.js:589` ("Migrating cookie secret from config.yaml") and the `users.js` secret file creation | `TestInitializeCookieSecretMatchesPinnedNode`, `...SerializesConcurrentGeneration` |
| S4 | data root creation | `commandline.ResolvePaths` (`internal/commandline/paths.go:163-232`); a second creation of the runtime root in `internal/app/server.go:214-224` | `src/command-line.js:288-297` (inside `parse`, before the chdir). **Deliberate divergence** recorded at `paths.go:163-180`: Go creates only the root the runtime uses and reports the discarded rendering; pinned creates the launch-directory rendering silently. Classified `intentional-parity`/recorded divergence (AGENTS 27 outranks parity) | `TestBootCreatesTheDataDirectoryItServes`, e2e `startup_data_root_test.go` |
| S5 | `_uploads` directory | `ensureUploadsDirectory` (`data_startup.go:150-166`) | `src/server-main.js:268`, `src/users.js:200` | `TestInitializeDataStartupMatchesPinnedNodeFreshStartInventory` |
| S6 | `_storage` node-persist default user record | `InitializeUserStorage` creates `user:default-user` only when no `user:*` key exists, `atomicCreate`, refuses to replace (`storage.go:102-162`) | `src/users.js:556-...` `initUserStorage` | `TestInitializeUserStorageMatchesPinnedNodePersistRecord`, `...PreservesExistingNodeRecords`, `...DoesNotWriteAroundMalformedRecords`, `...IsProcessSafe` |
| S7 | public + per-user directory creation (`USER_DIRECTORY_TEMPLATE` 31 keys, `PUBLIC_DIRECTORIES` 5 keys) | `EnsureDirectories` (`storage.go:353-383`; template `:57-97`) | `src/users.js:113-132` `ensurePublicDirectoriesExist` | `TestEnsureDirectoriesMatchesPinnedDirectoryTemplate` |
| S8 | legacy user-data migration: copy to `<dataRoot>/<handle>/...`, copy to `<install>/backups/_migration/<date>/`, then remove the source (install-tree mutation) | `MigrateUserData` (`user_data_migration.go:23-123`), 24 rows, symlink-preserving copy (`:125-187`) | `src/users.js:232-431` `migrateUserData` (10 s warning, per-row copy + backup + `rmSync`) | `TestMigrateUserDataMatchesPinnedNode`, `...RejectsTargetSymlinkEscapeAndContinues`, e2e `TestComplexInstanceMigratesAndBoots` |
| S9 | system-prompt migration: back up each instruct template, strip `system_prompt`, write `[Migrated] <name>.json` unless it is a pinned default, then `.migrated` marker | `MigrateSystemPrompts` (`system_prompts.go:44-189`) | `src/users.js:434-...` `migrateSystemPrompts` (backup at `:466`) | `TestMigrateSystemPromptsMatchesPinnedNode` |
| S10 | public override migration: 5 rows moved from `public/error|css` to data root, source removed, dest made writable | `MigratePublicOverrides` (`public_overrides.go:17-79`) | `migratePublicOverrides` in `src/users.js` | `TestMigratePublicOverridesMatchesPinnedNode`, `...RejectsSymlinkEscapeAndContinues` |
| S11 | group metadata migration: backup group file and each affected group chat, then rewrite the chat header and strip `chat_metadata`/`past_metadata` from the group | `MigrateGroupChatsMetadataFormat` (`group_metadata.go:15-154`) | `src/endpoints/groups.js:34-...` `migrateGroupChatsMetadataFormat` | `TestMigrateGroupChatsMetadataFormatMatchesPinnedNode`, e2e `TestLegacyGroupMetadataMigrationBacksUpCorruptChatBeforeRewriting` |
| S12 | content seeding: global `content.log`, `_errors/`, `_css/`, per-user content targets, directories staged and published by one rename, `content.log` replaced atomically at the end | `SeedDefaultContent`/`seedContent` (`content.go:70-124,154-219`), `copyDirectoryAtomically` (`:255-303`) | `src/endpoints/content-manager.js:135-215` (`seedContent` pushes the log then `writeFileAtomicSync` at `:179`; per-user log `:195`, global `:205`; `checkForNewContent` `:215`) | `TestSeedDefaultContentMatchesPinnedNodeFreshStart`, `...SkipAndExistingSettings` |
| S13 | character disk-cache directory creation and stale-record removal (only when `performance.useDiskCache` is true) | `VerifyCharacterDiskCache` (`character_disk_cache.go:13-93`) | `DiskCache.verify()` (`src/endpoints/characters.js:36-159`) | `TestVerifyCharacterDiskCacheMatchesPinnedNode` |
| S14 | flat-secrets migration: back up `secrets.json`, convert string values to the pinned array shape with new UUIDs, add `_migrated` | `MigrateFlatSecrets` (`flat_secrets.go:17-150`) | `src/endpoints/secrets.js:381-410,498-502` (`migrateFlatSecrets`) | `TestMigrateFlatSecretsMatchesPinnedNode` |
| S15 | upload cleanup: unlink every entry in `_uploads`, stop at the first failure | `CleanUploads` (`upload_cleanup.go:20-68`) | `src/users.js:198-...` `cleanUploads` | `TestCleanUploadsMatchesPinnedNode` |
| S16 | access-log migration: move `<install>/access.log` to `<dataRoot>/access.log` only when the destination is absent, under both roots' locks | `MigrateAccessLog` (`access_log_migration.go:32-102`) | `migrateAccessLog` (`src/server-main.js:306` call site) | `TestMigrateAccessLogMatchesPinnedNode` |
| S17 | settings backup at startup: duplicate-aware per-user snapshot + retention | `BackupSettings` (`settings_backup.go:28-59,152-227`) | `src/endpoints/settings.js:118-...` `backupSettings`, called from `settingsInit` `:380` | `TestBackupSettingsMatchesPinnedNode` |
| S18 | statistics initialisation: valid `stats.json` kept; missing/invalid recomputed from chats and unconditionally rewritten | `InitializeStatistics` (`statistics.go:33-69,95-174`) | `statsInit` / `collectAndCreateStats` / `saveStatsToFile` (pinned `src/endpoints/stats.js`) | `TestInitializeStatisticsMatchesPinnedNode`, `TestRecreateUserStatistics*` |
| S19 | auto-update resolution: **no boot write**, and every ambiguous input resolves to OFF | the resolution itself is Lane D's; the filesystem side is that no extension/plugin git command runs at boot (`internal/adversarial/extensions_cases_test.go` case `extensions.boot-runs-no-git`) | AGENTS rule 26 (deliberate divergence from `upstream/default/config.yaml:301,396`) | adversarial case + e2e long-lived "extension tree unchanged after boot" assertion |

**Startup side effects that are NOT reproduced (recorded, not silently missing):**

- `_webpack/**`: pinned's webpack middleware cache. Excluded from the round-trip comparison by fixture
  declaration (`tests/oracle/sillytavern-1.19.0-runtime-roundtrip.json` `comparisonExclusions`).
- Character **disk-cache records**: S13 creates/verifies the cache directory but GoTavern does not write
  cache records; `GOAL.md:465-470` records this as a parity/performance gap, not data loss (derived,
  rebuildable).
- Boot console output for S1/S2 (see B-H1) and S8 (B-H2).

---

## 4. Migration / rollback and copy-source-read-only behaviour

### 4.1 `gotavern migrate` (product command, no pinned counterpart)

`internal/migrate/migrate.go` defines the contract in its package comment (`:1-15`) and
`docs/INSTALLATION.md` §6.

| Property | Evidence | Probe |
|---|---|---|
| Plan is side-effect free; `--dry-run` writes nothing | `buildPlan` (`migrate.go:319-439`) does only reads/refusals; `Run` prints the plan first (`:180-189`) | `TestDryRunWritesNothing` |
| Source is never written | every write below goes through `plan.Dest*`; overlap in **either** direction is refused (`:369-382`); symlinks in the source are refused before the copy (`:384-403`) and again at copy time (`:591-637`) | `TestSourceIsNeverModified`, `TestSymlinksAreRefusedAndNothingIsWritten` |
| Destination conflict handling | only `config.yaml` and `data` are treated as conflicts (`:432-436`); `--force` moves **only those two** into `<dest>/.migrate-backup` (`:191-209`) | `TestSecondMigrationRefusesByName`, `TestForcedSecondMigrationReproducesTheTree` |
| Copy is verified byte-for-byte before success is claimed | `verifyCopy` re-reads both trees and compares size + SHA-256, and rejects extra files (`:264-315`) | `TestCopyVerificationCatchesAShortFile` |
| Config copy edits only `dataRoot`, preserving every other byte/comment/CRLF | `rewriteDataRoot` (`:529-586`) | `TestConfigKeepsUnknownKeysAndChangesOnlyDataRoot` |
| Rollback | `<dest>/.migrate-backup/` holds the prior `config.yaml` + `data`; it is refused over an existing backup (`:196-199`) | `TestForceMigrationBackupIsABootableOldRuntime` (e2e) |
| **Gap** | `copyCerts` and the global extension overlay are copied after the conflict step with `os.OpenFile(...O_TRUNC)` (`:639-655`) and are **not** part of `Conflicts` (`:432-436`), so a destination that already has `certs/` or `public/scripts/extensions/third-party/` but no `config.yaml`/`data/` has those files overwritten with no backup. Same for a `--force` re-run: only config+data are set aside, then certs/overlay are truncated in place | no test covers certs/overlay overwrite (grepped `certs` in `migrate_test.go`: only `TestDocumentedForms`), see B-H3 |
| **Gap** | `copyConfig` writes the destination config with non-atomic `os.WriteFile` (`:541`). It is a fresh destination (or after `--force` moved the old one aside), so a crash leaves a truncated destination config that the next run refuses as a conflict; recoverable with `--force`, but not atomic | not probed; `TestInterruptedMigrationKeepsTheSourceUnmodifiedAndReruns` proves the source, not the destination config |

### 4.2 In-place migration at boot (S8) and rollback of a *boot*

`MigrateUserData` copies to the destination, copies to
`<install>/backups/_migration/<UTC date>/`, then removes the source (`user_data_migration.go:110-120`).
Ordering makes a crash after a successful destination copy but before the backup idempotent-ish: the
source survives and the next boot copies again. This is pinned's order (`src/users.js:401-418`).
The e2e suite covers the forced-migration backup and a read-only tree:
`TestComplexForcedMigrationKeepsARecoverableBackup`, `TestComplexReadOnlyDataRootRefusesWritesWithoutDamage`,
`TestInterruptedMigrationKeepsTheSourceUnmodifiedAndReruns`.

### 4.3 Copy-source-read-only (AGENTS rule 14)

Separate from boot behaviour: the *source installation* of a `gotavern migrate` is read-only by
construction (§4.1). Normal startup **does** mutate the install tree by pinned parity: S8 removes
`public/*` after copying, S10 removes `public/error/*` and `public/css/user.css`, S16 moves
`access.log` out of the install root. This is the pinned startup contract (AGENTS rule 13), and it is
listed here so the two meanings cannot be confused.

---

## 5. Node ↔ Go ↔ Node hand-back and byte-census evidence state

| Claim | What proves it today | What it does NOT prove |
|---|---|---|
| Pinned boots over a GoTavern-written tree, preserves every user-data byte, and its rewrites there equal its rewrites over an empty tree; nothing user-owned is deleted; a second boot of either subject leaves its tree alone | `tools/probe-runtime-roundtrip.mjs` records `tests/oracle/sillytavern-1.19.0-runtime-roundtrip.json` (316 KB) with steps `freshPinned, freshGotavern, gotavernUserData, pinnedOverGotavern, gotavernAgain, pinnedAgain`; the CI oracle job re-records it and requires zero diff; the fixture's own `assertionSplit` states this half is asserted at record time, not by a Go test | a Go test cannot re-check it (stated in `internal/startup/runtime_roundtrip_test.go:3-20`) — the guarantee is "CI re-record has zero diff", not "a Go assertion proves it" |
| GoTavern startup over a tree seeded with the pinned-recorded user bytes leaves every one of them byte-identical and deletes none | `TestGotavernStartupLeavesExistingUserDataAlone` (`internal/startup/runtime_roundtrip_test.go`) + `TestRuntimeRoundTripFixtureCoherence` (refuses a fixture whose normalized paths are undeclared, whose step order is wrong, or whose fresh tree disagrees with fresh-start) | only the seeded subset recorded in the fixture; not arbitrary user trees |
| The GoTavern tree is *bootable by pinned* — the actual hand-back | the same fixture's `pinnedOverGotavern`/`pinnedAgain` steps; plus the `governed node-stock-tree.yml` job writes `release-evidence.json` with `roundTripOk` and a failed-assertion count and fails if `ok !== true` (`.github/workflows/node-stock-tree.yml:145-218`) | the round-trip report's own steps; not a browser journey over the handed-back tree |
| Byte census after a journey | `internal/longlivedfixture` builds a deterministic 169-file tree and e2e `longlived_complex_test.go` / `longlived_complex_writes_test.go` assert asset serving, writes, read-only refusal and forced-migration backup; `docs/goal-scorecard.md` Q21 is the ledger row | `GOAL.md` §14 item 2 ("every file under the data root, mutable install trees and extension trees hashed before and after") is **NOT MET**: `GOAL.md:452-459` states this explicitly and the private channel is `PRIVATE_NOT_RUN`. No Go test in this lane's scope performs a before/after whole-tree census on a real tree |
| Rollback (restore the pre-boot copy yields a byte-identical tree) | only the forced-migration backup test (`TestForceMigrationBackupIsABootableOldRuntime`) and `TestInterruptedMigrationKeepsTheSourceUnmodifiedAndReruns` | no test copies a tree, boots, and re-asserts byte equality of the pre-boot copy — that is `GOAL.md` §14 item 4, still NOT MET |
| Concurrent two-process writes stay whole | `tests/e2e/a15_concurrent_writers_test.go` (`TestTwoProcessesOneDataRootSettingsWritesStayWhole`, `...ChatWritesStayWhole`) | cross-user contention is not covered (Lane C) |

**Conclusion for §5:** the *round-trip mechanics* are evidence-backed (recorded oracle + zero-diff
re-record + a Go-side idempotence replay). The *strong hand-back statement* in `GOAL.md` §14
(1: real tree, 2: full byte census, 4: rollback byte equality) is **not** met and no document may quote
a fixture or a synthetic tree as if it were.

---

## 6. Concurrency entries observed (handing detail to Lane C)

| id | kind | Source | Owner / scope | Note |
|---|---|---|---|---|
| b-content-lock | flock (advisory, cross-process) | `internal/startup/content.go:398-414`, taken by `internal/startup/user_data_lock.go:25` | one per **data root**, shared by all users and all content routes | held across disk I/O; bounded on boot by `lockacquire`, unbounded at request time except the 10 s default (`lockacquire.go:55-68`) |
| b-storage-lock | flock | `internal/startup/storage.go:430-446` | one per `_storage` dir (node-persist records) | separate from the content lock; `UpdateNodePersistRecord` takes it for the read-modify-write |
| b-config-lock | flock | `internal/configinit/config.go:156-166` via `lockPathFor` (`lockpath.go:24-31`) | one per canonical config path (lock file in `os.TempDir()`) | boot-bounded; exported `LockPath` for the P0-B reproducer |
| b-cookie-lock | flock | `internal/startup/secret.go:74-90` | one per `cookie-secret.txt` | boot-bounded |
| b-settings-save-mu | mutex + `time.AfterFunc` | `internal/server/settings_save.go:50-87` | process-global, keyed map per handle under the mutex | timer body re-takes the mutex; not cancelled on shutdown (Lane C) |
| b-extension-git | child-process | `internal/server/extensions_git.go:39-95` | one `git` per request, `context.Background()` + 5 min | no request cancellation; `git -C` so CWD independent |
| b-data-maid-token | in-memory map | `internal/server/data_maid.go` token store | per process | delete authorization |
| b-reset-limiter | in-memory limiter + map | `internal/server/account_data_reset.go:84-96,133-136` | per IP / handle | guards a destructive route |
| b-vector-index | (uses content lock) | `internal/server/vector.go:249-303` | shared data-root lock | index writes serialise with every other content write |
| b-sprites-anchor | (uses content lock via a sentinel path) | `internal/server/sprites_upload.go:159-168` | sentinel `<characters>/.gotavern-sprites-lock-anchor` never written | lock acquired with `IfChanged` returning `shouldWrite=false` |

---

## 7. Caches with a persistent or invalidation surface (Owning discipline: Lane C; listed because they
interact with writers)

| name | key | lifetime / invalidation | external-mod handling | evidence |
|---|---|---|---|---|
| settings/worldinfo response cache | `<dataRoot>\x00<handle>` + route, identity = path+mtime+size digest | no TTL; identity recomputed every request; identity taken before and after the build so a concurrent write cannot be cached under the new identity | detects a normal external rewrite; the **same-size + restored-mtime** external rewrite is served stale, documented and pinned | `internal/server/settings_cache.go:12-66`; `TestMetadataCacheSameIdentityWindowIsTheDocumentedResidual`, e2e `TestExternalPresetEditInvalidatesTheSettingsCacheUnlessIdentityIsRestored` |
| card-text cache | absolute card path, identity path+type+size+mtime | no TTL; never caches the time-dependent projection | as above | `internal/server/characters_card_cache.go:3-40` |
| thumbnail disk cache | `<user>/thumbnails/{bg,avatar,persona}/<name>` | rebuilt from the original; writer invalidates the persona/bg thumbnail on upload/delete/rename | external replacement of a thumbnail is served as-is (cache is a real file) | `internal/server/thumbnails.go:143-334`; `internal/startup/user_avatars.go:80-102`, `user_backgrounds.go:72-93,135-156,250-269` |
| tokenizer cache | `<install>/tokenizers/<model>.json` | derived; not atomic (W53) | no invalidation; a corrupt file is read as-is | `internal/server/tokenizers.go:366-395` |

---

## 8. Hypotheses

Classification vocabulary is `docs/alpha16/README.md` §1 rule 5. `strength` is README §3 (1-5).

**B-H1 — Config migration/default insertion is silent, where pinned prints what it changed.**
`verified-risk` · surface `startup-state` · impact `user-visible` · strength 3.
Evidence: `internal/configinit/config.go:77-139` returns `Result{Created,Updated}` and prints nothing;
`internal/commandline/paths.go:129-133` stores the result; the only config output anywhere in Go is the
parse-failure block (`cmd/gotavern/main.go:70-79`). Pinned prints "Warning: config.yaml not found at …
Creating a new one with default values." (`src/config-init.js:169`), "Adding missing config values to
config.yaml: [keys]" (`:232`) and "Migrating config values in config.yaml: [keys]" (`:236`), and
"Using config path:" on every boot (`:250`). Exactly the two events that rewrite a user's `config.yaml`
are the silent ones. Reproducer plan: shipped binary over a config with one legacy key and one missing
default; capture stdout for both subjects and diff. Counterargument: `GOAL.md` §15.5 wants a quiet
default and `internal/app/startup_trace.go:25-30` deliberately made stage timings opt-in; if the project
decides pinned's config messages are non-contract, the row closes as `intentional-parity` — but that is a
decision, and today the doc says "reproduce … config creation/key migration/default insertion"
(AGENTS rule 13) without naming the observable. What falsifies it: a recorded pinned/Go stdout comparison
that the owners accept as "quiet is intended".

**B-H2 — The legacy user-data migration pause is announced with one line, where pinned warns for ten
seconds and offers cancellation.** `verified-risk` · surface `startup-state` · impact `user-visible` ·
strength 3.
Evidence: `internal/startup/user_data_migration.go:37-40` calls the injected waiter (real default
`time.Sleep`) once; `internal/app/server.go:182-186` wraps it; `internal/app/startup_trace.go:112-120`
prints `gotavern: startup.legacy-wait 10s before moving legacy data (pinned behaviour)` to stderr, then the
process is silent for ten seconds. Pinned prints a five-line banner, a ten-line countdown, "The process
will start in 10 seconds. Press Ctrl+C to cancel." and "Starting migration... Do not interrupt the
process!" (`src/users.js:241-254`). A user migrating a real tree with tens of thousands of files gets no
progress and no cancel prompt from Go. Reproducer plan: run both subjects on a tree with
`public/characters/`; compare stdout during the pause. Counterargument: the adversarial case
`boot.legacy-migration-cost` deliberately corrected its invariant to "pauses exactly 10 s once, announced
before it is spent" and records that the countdown itself is not part of the measurement; one line does
satisfy "announced". The residual complaint is that "announced" became one line instead of pinned's
interactive warning, which the ratchet's own invariant does not measure.

**B-H3 — `gotavern migrate --force` backs up only `config.yaml` and `data/`; `certs/` and the global
extension overlay are truncated in place.** `verified-risk` · surface `persisted-bytes` · impact
`data-safety` · strength 3.
Evidence: conflicts are `{DestConfigName, DestDataName}` (`internal/migrate/migrate.go:432-436`);
`--force` renames only those (`:191-209`); `copyCerts`/`copyOverlay` call `copyTree` (`:221-230`) whose
`copyFile` opens with `O_TRUNC` (`:639-655`). A destination holding `certs/` or a third-party overlay but
no `config.yaml`/`data/` has those files overwritten with no `.migrate-backup` entry. Reproducer plan:
pre-create `<dest>/certs/server.pem` with different bytes, run `gotavern migrate --from … --dest …`, assert
the file's bytes unchanged (today they change), then extend `Conflicts` and the backup loop and re-run.
Counterargument: that destination shape is unusual (a real GoTavern install has config+data), and the
command is a product command, not pinned parity, so the fix is free to change behaviour. Low likelihood,
but it is a silent overwrite of user-owned bytes, which rule 28 forbids.

**B-H4 — The two recursive destructive routes run outside the shared content lock.**
`verified-risk` · surface `persisted-bytes` · impact `data-safety` · strength 3.
Evidence: `serveUserResetStep2` does `os.RemoveAll(<dataRoot>/<handle>)` with no lock and then recreates
and seeds (`internal/server/account_data_reset.go:107-137`); `serveCharactersDelete` deletes the card
under the lock and then `os.RemoveAll(<chats>/<name>)` with none (`internal/server/characters_write.go:874-882`);
`serveUserAdminDelete` removes the user root with only the storage-record lock
(`internal/server/accounts.go:1340-1345`). Every other user-tree mutation in §2 takes the data-root lock
(§1), so a concurrent chat save or settings save can interleave with a reset: a save that lands after the
`RemoveAll` but before/after `EnsureDirectories` recreates a file inside a tree the user asked to be
emptied, or fails with a 500 mid-reset. Counterargument: pinned is a single-threaded event loop but its
`fsPromises.rm`/`unlink` are async, so concurrent requests can interleave there too — the *observable*
race may be identical, and adding the lock would be "safer but different". What decides it: a probe that
fires a chat save concurrently with `reset-step2` on both subjects and compares the surviving tree; if
both trees can end up non-empty, the row is `intentional-parity` and gets recorded, not fixed. No crash or
concurrency probe exists for either route today (probes read the request contract only).
**This is the largest data-safety gap this lane found**, because it is the only case where a user-initiated
operation destroys a whole tree and no gate proves what the tree looks like afterwards.

**B-H5 — Swallowed card-write errors make `/api/characters/create` answer 200 with no card, and this is
pinned parity.** `intentional-parity` · surface `persisted-bytes` · impact `data-safety` · strength 4.
Evidence: `writeCharacterCard`'s error is discarded at `internal/server/characters_write.go:262` and the
route answers the avatar name (`:263`); pinned's `writeCharacterData` catches all errors, logs them and
returns `false` (`src/endpoints/characters.js:220-259`), and `/create` ignores the return
(`:1024-1049`) and `response.send(avatarName)`. So on a full disk or a read-only characters directory both
subjects tell the client "created" while nothing was created. Reproducer plan: read-only `characters/`
(chmod), POST create on both subjects, assert status 200 and the file absent on both; that is the
*discriminating* parity capture. Counterargument: this is inherited behaviour and changing it breaks
drop-in parity (AGENTS boundary 5). The audit value is that the failure is now recorded: a user who loses
a card this way has no error to point at, and no gate says so. Fix options are a separate, explicit
product decision.

**B-H6 — `gotavern migrate` writes the destination `config.yaml` non-atomically.**
`verified-risk` · surface `persisted-bytes` · impact `data-safety` · strength 2.
Evidence: `internal/migrate/migrate.go:541` `os.WriteFile(plan.DestConfig, rewritten, 0o644)`; no temp
file, no fsync. Interrupted run leaves a truncated config in the destination. Reproducer plan: kill
between the truncate and the write (`internal/faultinject` is not wired here; a large `--from` tree plus a
kill during `copyConfig` is the crude form), then re-run: today the next run refuses as a conflict and
requires `--force`. Counterargument: destination-only, recoverable by `--force`, and the command reports
the plan before writing. Still a `write-file-atomic`-shaped gap next to a code base that owns
`atomicReplace`.

**B-H7 — Tokenizer cache files are written non-atomically and a corrupt cache is not detected.**
`untested-hypothesis` · surface `persisted-bytes` · impact `performance` · strength 2.
Evidence: `internal/server/tokenizers.go:377,388` `os.WriteFile(<cache>/<model>.json, raw, 0o644)` and
`:378` `os.Remove(<cache>/<model>.json.gz)`; on the next request `os.ReadFile` at `:371` returns whatever
bytes are there, and only the gunzip/parse step downstream would notice. The cache is derived and
rebuildable by removing the file. What decides it: a probe that truncates a cached `<model>.json` and
requests a tokenizer route, asserting a fallback or a rebuild rather than a wrong count; and a kill during
materialisation leaving either the complete file or none. Counterargument: pinned does the same
`fs.writeFileSync` into the cache; a mismatch here would be a parity question, not a new defect.

**B-H8 — The character disk cache directory is created and verified, but cache records are never
written.** `untested-hypothesis` · surface `startup-state` · impact `performance` · strength 2.
Evidence: `internal/startup/character_disk_cache.go:13-93` creates `_cache/characters` and removes only
"misaddressed" records; `GOAL.md:465-470` records that the character-card disk cache "is still not
implemented in GoTavern" and calls it derived/rebuildable. Open question: with `performance.useDiskCache:
true`, pinned populates the directory and GoTavern leaves it empty — a user moving between the two sees an
empty-but-present cache directory. What decides it: a boot on a tree with the setting enabled, on both
subjects, comparing `_cache/characters` entry counts. Counterargument: the cache is derived, nothing user
owns depends on it, and `GOAL.md` already classifies it as a parity/performance gap rather than a defect.

**B-H9 — Image/avatar uploads take no lock, while every JSON write does.** `intentional-parity` · surface
`persisted-bytes` · impact `data-safety` · strength 2.
Evidence: `internal/server/avatars_upload.go:111` and `internal/server/images.go:217` call
`WriteFileAtomic` with no `lockUserContentRoot`; both are single-file replacements, so a concurrent
uploader cannot observe a torn file (atomicReplace) but two uploads to the same name have last-writer-wins
order that the lock does not define either. Pinned's single-threaded write path has the same outcome for
one file. Counterargument: the lock protects *read-modify-write* sequences, not single replacements; taking
it would only add contention. Recorded so a later reader does not mistake "no lock" for "not atomic".

**B-H10 — extension move is a copy-then-delete with no staging.** `intentional-parity` · surface
`persisted-bytes` · impact `data-safety` · strength 2.
Evidence: `internal/server/extensions_fs.go:282-289` copies and then removes; a kill mid-copy leaves a
partial destination and a 409 on retry (`extensions_fs.go:271-274`). Pinned does `fs.cpSync` then
`fs.rmSync` (`src/endpoints/extensions.js:366-367`); the failure mode is inherited. Counterargument: the
user's source directory is intact after the crash, so the loss is "the extension appears in both/in a
broken destination", recoverable by deleting it; matching pinned is required. No probe covers the crash
window.

---

## 9. Questions this lane could not decide

1. **Does pinned's config-init console output count as contract?** `GOAL.md` §15.5 and AGENTS rule 13 point
   in opposite directions for B-H1; the Lead/owner must decide, and if it counts, the fix is a stdout port
   with a recorded fixture.
2. **Is the pristine pre-boot copy byte-identical after a boot?** No test in the repository copies a tree,
   boots, and re-hashes the copy. `GOAL.md` §14 item 4 needs this; it is a scenario-design question for
   Lane E (the copy exists in the long-lived fixture but is not re-hashed after the journey).
3. **Does anything read `<dataRoot>/_cache/characters` in GoTavern?** The directory is created/verified
   (S13) but no Go code was found writing or reading records (grepped `_cache` in `internal/`: only
   `character_disk_cache.go`). Confirming the negative needs the source graph, not a bounded grep.
4. **`settings.json` restore semantics**: Go is atomic where pinned has a delete window. Whether that
   counts as a divergence (safer, unobservable except across a crash) is a parity-policy question, not a
   filesystem one.
5. **Cross-user contention on the single content lock** is Lane C's; this lane only records that the lock
   is data-root-scoped (`user_data_lock.go:21-25`) and that every JSON writer depends on it.

---

## 10. Coverage honesty

- `internal/startup` measured: **52 files, 31 production (5,989 lines), 21 test files**; the production
  files were read in full except `secrets_state.go` (761 lines: read the lock/read/write core, the
  mutation helpers' declared behaviour and every writer entry point) and the test files (listed/spot-read).
- `internal/server`: the 30 writer files named by the task were read at the level stated per row;
  `characters_write.go` (1,246 lines) was read at its write call sites and its directory-copy core, not
  line-by-line. The other ~150 production files were not read: they are outside this lane's assignment and
  are Lane A/C's.
- `internal/migrate`, `internal/configinit`, `internal/lockacquire`, `internal/fsretry`,
  `internal/userdata`: read in full (configinit `config.go` 777 lines read in full).
- Pinned: read the functions cited in §2/§3; not every route's pinned handler was re-read for routes whose
  Go side is a thin call into a startup helper already verified against a recorded oracle fixture.
- No `go test`, `go build`, `go vet`, server boot, browser probe or network access was performed. The only
  commands run were `git rev-parse`, `Get-ChildItem`, `Select-String`, `Get-Content`, `ConvertFrom-Json`.
