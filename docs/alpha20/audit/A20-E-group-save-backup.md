# A20-E: group save never scheduled the pinned chat backup

- **Severity:** High for user safety expectations of the backup feature (a group conversation was saved but
  never backed up by the auto-backup contract; the 1:1 path was backed up, so the gap was invisible until a
  user lost a group chat).
- **State:** FIXED (`fb24983`), test `TestA20GroupSaveChecksIntegrityAndSchedulesThePinnedBackup`.
- **Source:** pinned `src/endpoints/chats.js:922-947` calls the same
  `trySaveChat(chatData, filePath, request.body.force, handle, String(id), request.user.directories.backups)`
  as `/api/chats/save`, so the group route schedules the throttled backup; `backupChat` `:52-78` names the file
  `chat_<getBackupKey(name)>_<YYYYMMDD-HHmmss>.jsonl` and retention is the shared per-user `chat_` quota.
- **Root cause:** the group-save handler in `internal/server/chats_group.go` built and wrote the JSONL itself
  and never reached the backup manager (`_ = id` marked the gap in the code). The backup manager was also
  constructed inside `registerChatRoutes`, so no second route could share it.
- **Fix:** the manager is now created once per handler in the account runtime constructor (pinned reads the
  config at module load) and shared by both save routes; the group handler performs the same integrity check
  and records `backups.record(handle, id, backupsDir, jsonlData)` after a successful write.
- **RED/GREEN:** with the record call removed, the test failed `group save produced 0 backup file(s), want
  exactly one: []`; restored → `ok`. The same mutation run also demonstrated that a disabled integrity guard
  answers 200 where the test demands 400.
- **Regression guard:** `TestA20GroupSaveChecksIntegrityAndSchedulesThePinnedBackup` asserts the refused save
  changes nothing and writes no backup; a matching save writes the exact JSONL and produces exactly one
  `chat_alpha20group_<timestamp>.jsonl` whose body equals the written bytes; `force:true` bypasses the check.
- **Oracle cross-check:** the oracle lane reproduced the pinned behaviour with real pinned runs
  (`docs/alpha20/oracle/group-save-backup/`): leading backup immediately, one trailing after the throttle,
  graceful-exit flush of one pending trailing backup, shared per-user quota (a character-chat save evicted a
  group backup with `maxTotalBackups=2`), broken backups dir leaves the save 200 and the chat persisted, no
  invented `.bak` file. Per-user isolation is source-evident but was UNPROVEN in that single-user probe.
