# Probe (a): `chat_metadata.integrity` and `body.force` on the pinned chat-save path

**Status: CONFIRMED (pinned-only probe).** Evidence: [`chat-integrity/evidence.json`](chat-integrity/evidence.json)
(14 rows, 6 verdicts). Produced by a real pinned server, not by reading source alone:

```
cd C:\Users\koishi\Desktop\GoTavern\a20-B
node tests/browser/a20-probe-chat-integrity.mjs
```

The probe boots pinned SillyTavern `1.19.0` at `06bde939fb1e9c4c8d8641d810f0a916b5bce127` (READ-ONLY checkout,
clean `git status`, verified by `assertPinnedClean`) over a fresh scratch data root copied from the pinned
fresh-install template, and drives it over HTTP with `GET /csrf-token` + the session cookie exactly as the
unmodified frontend does. Each step records the request, the exact status and body, and a byte digest of the
persisted `.jsonl` and of the backups directory before and after.

## What was run and what happened

| id | request (`POST /api/chats/save`) | observed | classification |
|---|---|---|---|
| A1 | new chat, header integrity `slug-alpha` | `200 {"ok":true}`; `chats/A20Probe/a20-chat-integrity.jsonl` created; backup `chat_a20probe_20261109-172333.jsonl` whose sha256 is the saved bytes | **CONFIRMED**: write then backup (source order `pinned chats.js:541` write, `:542` backup) |
| A2 | same slug, 2 messages, inside 10 s | `200 {"ok":true}`; file replaced; no new backup yet | **CONFIRMED**: the overwrite precedes the throttle |
| A3 | disk has `slug-alpha`, body has `slug-beta`, no `force` | `400 {"error":"integrity"}`; file byte-identical to before; backups unchanged | **CONFIRMED**: refuse before write |
| A4 | as A3 but `force:false` | `400 {"error":"integrity"}` | **CONFIRMED**: explicit `false` is the same branch as absent |
| A5 | wait 11 s | trailing backup `chat_a20probe_…172343.jsonl`, 352 B, sha256 `615c1e13…` | **CONFIRMED**: lodash throttle trailing invocation copies the **last** payload in the window — `615c1e13…` equals the JSONL digest of A2's payload (recomputed offline: `A2 = 352 B, sha256 615c1e13…`) |
| A6 | as A3 with `force:true` | `200 {"ok":true}`; file replaced with `slug-beta`; a new backup appears whose sha256 `d1494e9e…` equals A6's payload | **CONFIRMED**: force bypasses the check and still backs up |
| A7 | body header has **no** integrity slug, disk has `slug-beta` | `200 {"ok":true}`; file replaced | **CONFIRMED**: no slug means no check (`chats.js:362-365`, legacy chats) |
| A8 | `body.chat` is an object | `400 {"error":"The request's body.chat is not an array."}`; file unchanged | **CONFIRMED**: exact pinned literal |
| A9 | probe writes a UTF-8 BOM before the header, same slug | `200 {"ok":true}` | **CONFIRMED**: BOM stripped before parse (`chats.js:350`); this setup is a filesystem write by the probe, disclosed in the row |
| A10 | probe writes a non-JSON first line | `400 {"error":"integrity"}`; file unchanged | **CONFIRMED**: unparseable non-empty file fails the check (`chats.js:352-356`) — the anti-truncation protection |
| A11 | probe truncates the file to 0 bytes, save with a slug | `200 {"ok":true}` | **CONFIRMED**: empty file is treated as intact (`chats.js:343-346`) |
| B1 | restart with `backups.chat.checkIntegrity: false`; mismatched slug | `200 {"ok":true}`, file replaced | **CONFIRMED**: config is read at process start; only a restart observes the branch |
| C1 | restart with `backups.chat.enabled: false`; force save | `200 {"ok":true}`, file replaced, **no** backup after +11 s | **CONFIRMED**: backup suppression only; the save still succeeds (`chats.js:61`) |
| D1 | restart; `POST /api/chats/get` | `200`, 1 message read back | **CONFIRMED**: new process reads the last persisted chat |

Every save path here is the same `trySaveChat` used by `/api/chats/group/save`, so the integrity matrix is
shared; the group-specific contract (paths, backup names, retention, flush) is probe (b).

## The exact oracle a Go comparator may assert

1. `POST /api/chats/save` with a non-array `chat` → status 400, body `{"error":"The request's body.chat is not an array."}`
   and zero file writes.
2. A mismatch between `chat[0].chat_metadata.integrity` and the existing non-empty file's header slug → status 400,
   body `{"error":"integrity"}`, file byte-unchanged, no backup.
3. `force:true` on the same body → status 200, body `{"ok":true}`, file replaced, one backup produced.
4. `force:false` behaves exactly like absent.
5. A missing integrity slug, a zero-byte file, a BOM-prefixed header with a matching slug → accepted; a non-JSON
   first line → refused as in (2).
6. `backups.chat.checkIntegrity:false` / `backups.chat.enabled:false` take effect only after a restart.

## NOT compared here (deliberately)

- The **GoTavern leg** is not in this document: it is a pinned-only oracle probe. The Go behaviour is compared by
  the five-layer oracle/comparator lane against these observations, not by this file.
- No real user chat file was read or written: the probe creates its own chats in a scratch data root outside the
  repository. The pinned checkout was never modified.
- `backups.chat.throttleInterval`, `maxTotalBackups` and the flush-on-exit path belong to probe (b), which captures
  them on the shared `trySaveChat` code path.
