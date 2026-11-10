# Probe (b): pinned group-chat save / backup semantics

**Status: CONFIRMED (pinned-only probe).** Evidence: [`group-save-backup/evidence.json`](group-save-backup/evidence.json)
(13 rows, 7 verdicts). Produced by a real pinned server:

```
cd C:\Users\koishi\Desktop\GoTavern\a20-B
node tests/browser/a20-probe-group-backup.mjs
```

Same method as probe (a): READ-ONLY pinned `1.19.0` at `06bde939fb1e9c4c8d8641d810f0a916b5bce127` over a
scratch data root copied from the pinned fresh-install template, driven over HTTP with the frontend's
`GET /csrf-token` + session cookie; every on-disk observation is a byte census. **No `.bak` behaviour is
assumed or invented: every backup filename below was produced by the pinned server and is quoted verbatim.**

## What was run and what happened

| id | request | observed | classification |
|---|---|---|---|
| G1 | `POST /api/chats/group/save` with no `id` | `400`, empty body | **CONFIRMED**: refused before any directory/file work (`chats.js:924-926`) |
| G2 | `chat` is an object | `400 {"error":"The request's body.chat is not an array."}` | **CONFIRMED**: shared literal with the character-chat route |
| G3 | new group chat, id `A20 Group Chat 1` | `200 {"ok":true}`; only file written is `default-user/group chats/A20 Group Chat 1.jsonl` (240 B); the file content equals the serialized request chat; backup `chat_a20_group_chat_1_<YYYYMMDD-HHMMSS>.jsonl` appears | **CONFIRMED**: path `group chats/<id>.jsonl`; backup name = `chat_` + `getBackupKey(id)`; **no `.bak`** |
| G4 | matching save 10 s window | `200`; file replaced; no new backup yet | **CONFIRMED**: overwrite precedes the throttled backup |
| G5 | mismatched `chat_metadata.integrity`, no `force` | `400 {"error":"integrity"}`; file byte-unchanged | **CONFIRMED**: same `trySaveChat` branch as character chats |
| G6 | same with `force:true` | `200 {"ok":true}`; file replaced; backup written | **CONFIRMED** |
| G7 | wait 11 s | trailing backup materialises; it copies the **last** payload of the window | **CONFIRMED**: lodash throttle trailing semantics |
| G8 | non-ASCII id `群聊 測試` | `200`; backup `chat_______c0288919_<ts>.jsonl` (sanitized name + `sha256(name)[:8]`) | **CONFIRMED from the real name**: `getBackupKey`'s hash suffix (`chats.js:42-49`) prevents CJK names collapsing to one key |
| G9 | two forced saves, then graceful stop | **1** leading backup before the stop, **1** pending trailing backup flushed **across** the exit; the flushed bytes equal the last save payload (`sha256 28026c29…`) | **CONFIRMED**, asserted against the STOP BOUNDARY: `process.on('exit')` flushes every throttled backup function (`chats.js:118-122`). The pinned process handles SIGTERM via `process.exit()` (`server-main.js:330-331`), which is why the flush runs; a SIGKILL would lose it |
| G10 | restart, `POST /api/chats/group/get {id}` | `200`, last message read back | **CONFIRMED**: new process reads the persisted group chat |
| G11 | restart with `backups.chat.maxTotalBackups:2`, `throttleInterval:1500`, 4 saves alternating group/character | after every save at most **2** `chat_*` backups remain; the 4th (a character-chat save) evicts the older group-chat backup | **CONFIRMED**: retention is a **per-user directory quota over the shared `chat_` prefix**, not a per-chat quota. Group and character chats compete for it |
| G12 | backups directory replaced by a regular file, forced save | `200 {"ok":true}`, chat file replaced, backup write error logged | **CONFIRMED**: `backupChat` catches and logs (`chats.js:75-77`); a backup failure never becomes a save failure (inherited pinned behaviour) |
| G13 | restore the directory, save again | a later backup is produced | **CONFIRMED**: the failure is transient, not a wedged writer |

## The contract, quoted from the pinned source the run exercises

```
chats/group.save: handle = request.user.profile.handle; chatFilePath = groupChats/<sanitize(id)>.jsonl
trySaveChat(chatData, chatFilePath, request.body.force, handle, String(id), request.user.directories.backups)
backupChat: backups/chat_<getBackupKey(name)>_<YYYYMMDD-HHMMSS>.jsonl
getBackupKey(name) = lowercase(sanitize(name) with non-alphanumerics -> "_") + (non-ASCII ? "_" + sha256(name)[:8] : "")
throttle: _.throttle(backupChat, backups.chat.throttleInterval (default 10000), {leading:true, trailing:true}), keyed "<handle> <name>"
retention: removeOldBackups(dir, "chat_"+key) per chat, then removeOldBackups(dir, "chat_", backups.chat.maxTotalBackups) globally
flush: process.on('exit') -> every throttled backup function .flush()
```

## What a Go comparator may assert

1. Missing `id` → 400 (body empty); non-array `chat` → 400 with the pinned literal.
2. Write path `group chats/<id>.jsonl`; body content equals the request chat's JSONL serialization.
3. Mismatched integrity → 400 `{"error":"integrity"}` and the original file byte-unchanged.
4. `force:true` → 200 and a backup whose bytes equal the saved payload.
5. Backups are `chat_<sanitized-lowercased-key>[_<hash8>]_<timestamp>.jsonl`; the timestamp is local
   `YYYYMMDD-HHMMSS`.
6. Retention counts every `chat_*` backup in the user's backups directory (group and character together).
7. A graceful exit flushes the pending trailing backup.

## Explicitly NOT observed / not claimed

- **Per-user isolation** is source-evident (`backupFunctions` key is `"<handle> <name>"`, and the target
  directory is `request.user.directories.backups`) but this probe ran with one user; it is marked `UNPROVEN`
  in the evidence rather than asserted from source alone.
- A SIGKILL losing the pending trailing backup is reasoned from `process.on('exit')` but not separately
  probed; the graceful-exit path is what G9 measured.
- Failures injected in G12 are probe filesystem setups (labelled in the row), not product actions.
