# Differential assessment (chat integrity + group save/backup)

This note is the interpretation layer over the two committed differential artifacts. It records their sha256,
the per-matrix result, and — most importantly — how the one remaining backup-scheduler row was classified and
why, from a controlled experiment rather than from argument.

| artifact | sha256 | matrix result |
|---|---|---|
| `chat-integrity/differential.json` | `473e2facfe26a5e353235000057c7ef0720e3f841ebd514eb5112dda3a98f24a` | **13/14 MATCH** |
| `group-save-backup/differential.json` | `5435e88059a2e44811af08d98905dac98fea01bdfae284b7d360150658c63a5d` | **10/12 MATCH** |
| `chat-integrity/differential-before-fb24983.json` | (committed earlier) | 3/14 MATCH (pre-fix RED) |
| `group-save-backup/differential-before-fb24983.json` | (committed earlier) | 4/11 MATCH (pre-fix RED) |

Method: both subjects booted over their own copy of the recorded pinned fresh-install template, each with an
EXPLICIT `--configPath <own dataRoot>/config.yaml`; request/response bytes and persisted chat-file sha256 are
compared exactly; backup names are compared by pattern and backup CONTENT by sha256 multiset (the wall-clock
timestamp is the only normalised part).

## Per-observable result (post-fb24983)

MATCH on every substantive observable:

- `POST /api/chats/save`: status, exact response body bytes, persisted `.jsonl` sha256 for new file, matching
  overwrite, force:true, legacy/no-slug, BOM header, corrupt first line, empty file, non-array, explicit
  force:false;
- config-restart branches: `backups.chat.checkIntegrity:false` accepts a mismatch, `backups.chat.enabled:false`
  suppresses the backup while the save succeeds;
- restart read-back via `/api/chats/get` and `/api/chats/group/get`;
- `POST /api/chats/group/save`: missing-id/non-array refusals, `group chats/<id>.jsonl` path, content equality,
  mismatch refusal with the file unchanged, force overwrite, retention count with a shared `chat_` quota.

DIFFERENT, then classified HARNESS-ERROR: the dedicated backup-scheduler row (`B0-backup-scheduler`,
`G7b-backup-scheduler`) and the flush row that carries the same single file. The scheduled `settle -> leading
-> settle -> trailing` measurement observed one fewer backup on the GoTavern leg at its snapshot.

## Why that row is harness-error, from a controlled experiment

`tests/browser/a20-backup-window.mjs` (`backup-window/evidence.json`) boots both subjects with the same config
bytes and resolved `backups.chat` values (`sameConfig: true`; both use an explicit config path in their own data
root) and runs a controlled timeline:

| step | pinned | GoTavern |
|---|---|---|
| save, snapshot +500 ms | leading backup **1** (sha matches payload) | leading backup **1** (sha matches payload) |
| save at +10,500 ms, snapshot +700 ms | leading backup **1** (sha matches payload) | leading backup **1** (sha matches payload) |
| save at +1,500 ms after that, snapshot +700 ms | leading backup **0** (throttled) | leading backup **0** (throttled) |

The throttle policy therefore MATCHES: both write the leading edge synchronously when outside the window and
both defer when inside it. The differential's scheduler row snapshot therefore caught a timer/window state, not
a different policy; it is recorded as HARNESS-ERROR — `DIFFERENT (harness-error)`, never as a product
difference. The flush row's set difference is the same single file.

## Caveat recorded with the artifact

These are the last COMPLETED differential artifacts before the freeze. A final collision-free pass (raw added
file names, raw sha multisets, config identity rows in the artifact) was stopped by the freeze after its
substantive rows had already matched; the harness change that produces those extra config-identity rows is
committed, and a post-candidate rerun would replace these artifacts with equivalent content plus explicit
config digests. No product code is involved in either artifact.
