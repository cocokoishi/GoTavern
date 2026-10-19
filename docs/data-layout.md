# Pinned persistent data layout inventory

Baseline: SillyTavern `1.19.0`, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.

The canonical persistent format is the upstream directory/file layout. GoTavern does not introduce a database or conversion schema. This document records path templates and source-owned asset trees; file-level mutation semantics still need Node-to-Go-to-Node round-trip coverage.

## Per-user paths

At startup `getUserDirectories(handle)` joins each template path to `DATA_ROOT/<handle>/`. User records live in the `_storage` key/value store at the data root; `cookie-secret.txt` also lives at the data root. Each user root can contain `secrets.json`; startup converts legacy flat string entries to the current array format and backs up the source file.

`settings.init()` writes `backups/settings_<handle>_<YYYYMMDD-HHmmss>.json` when `settings.json` exists and differs from the latest backup. It suppresses equal snapshots, retains the configured number by oldest modification time, and catches the first error across the user loop. The latest-backup choice uses filesystem change time, matching pinned Node behavior on the supported release targets.

| Directory key | Relative path under `DATA_ROOT/<handle>/` | Source |
|---|---|---|
| root | `.` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| thumbnails | `thumbnails` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| thumbnailsBg | `thumbnails/bg` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| thumbnailsAvatar | `thumbnails/avatar` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| thumbnailsPersona | `thumbnails/persona` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| worlds | `worlds` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| user | `user` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| avatars | `User Avatars` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| userImages | `user/images` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| groups | `groups` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| groupChats | `group chats` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| chats | `chats` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| characters | `characters` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| backgrounds | `backgrounds` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| novelAI_Settings | `NovelAI Settings` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| koboldAI_Settings | `KoboldAI Settings` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| openAI_Settings | `OpenAI Settings` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| textGen_Settings | `TextGen Settings` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| themes | `themes` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| movingUI | `movingUI` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| extensions | `extensions` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| instruct | `instruct` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| context | `context` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| quickreplies | `QuickReplies` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| assets | `assets` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| comfyWorkflows | `user/workflows` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| files | `user/files` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| vectors | `vectors` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| backups | `backups` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| sysprompt | `sysprompt` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |
| reasoning | `reasoning` | [src/constants.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/constants.js) |

## Global paths and startup state

| Path | Meaning / startup handling |
|---|---|
| `DATA_ROOT/_storage/` | User and account key/value state; creates `default-user` as admin when no handles exist. |
| `DATA_ROOT/cookie-secret.txt` | Session signing secret; generated when missing or migrated from legacy `cookieSecret` config. |
| `DATA_ROOT/_cache/characters/` | node-persist records used by the pinned character image disk cache; created when `performance.useDiskCache` is enabled. |
| `DATA_ROOT/access.log` | Incoming-connection log; receives `serverDirectory/access.log` at startup only when the data-root copy is absent. |
| `DATA_ROOT/<handle>/...` | Per-user directory template above; directories created for every user at startup. `backups/settings_<handle>_<timestamp>.json` holds startup and user-requested settings snapshots. `sysprompt/.migrated` records completion of the legacy instruct system-prompt migration; originals are backed up under `backups/_sysprompt/`. |
| `DATA_ROOT/_uploads/` | Temporary multipart uploads; files are cleaned during pre-listen startup. |
| `DATA_ROOT/_errors/` | User error-page overrides; `url-not-found.html` also supplies the final 404 body. |
| `DATA_ROOT/_css/user.css` | User CSS override migrated from `public/css/user.css` when absent. |
| `DATA_ROOT/heartbeat.json` | Written immediately and periodically when heartbeat is enabled. |
| `serverDirectory/backups/` | Default-content and legacy user-data migration backups under `_migration/<date>`; other upstream backup paths also live here, outside `DATA_ROOT`. |
| `serverDirectory/public/scripts/extensions/third-party/` | Global frontend extension overlay, separate from per-user `DATA_ROOT/<handle>/extensions/`. |

Global public directories are declared in `src/constants.js`: `public/img/`, `backups/`, `public/sounds`, `public/scripts/extensions`, and `public/scripts/extensions/third-party`.

## Embedded compatibility assets

`upstream/default/**` is copied from the pinned commit and includes `default/config.yaml`, `default/content/**`, `default/scaffold/**`, indexes, and any other baseline default files. `upstream/public/**` is copied from the same commit without modification. Per-file SHA-256 manifests cover both complete trees. These trees are compatibility inputs, not a complete GoTavern startup implementation.

## Still unverified

`internal/startup` currently implements the pinned `_storage` default-user record, public/per-user directory template, fresh-install default content/log seeding, cookie-secret file behavior, legacy public-data migration, legacy instruct system-prompt migration, public error/CSS override migration, group-chat metadata migration, character disk-cache verification, legacy flat-secret migration, `_uploads` cleanup, access-log migration, and settings backup creation/deduplication/retention. These behaviors are covered by Node fixtures, but the CLI does not yet invoke them; full startup behavior remains partial.

- Full file-format inventory and round-trip corpus for cards, chats, settings, worlds, secrets, themes, presets, user accounts, and extension state.
- Content-log skip/force/update cases, settings aggregation, malformed settings-byte comparison, settings-backup failure and unusual timestamp cases, character-cache error cases and node-persist write behavior, secret backup/write-failure handling, upload symlink and partial-deletion failure cases, access-log write-failure behavior, remaining migration behavior, and unknown-field preservation.
- Node-written → Go-read/write → Node-read round trips for every persistent mutation family.
