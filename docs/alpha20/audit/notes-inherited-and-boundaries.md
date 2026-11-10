# Audit notes: boundaries, inherited properties, and the areas that came back clean

Lane A (production source audit), alpha.20. This file records what was **read and cleared** as well as
the two properties that are inherited from pinned or live outside the server, so the next reader does not
re-audit them from scratch. Findings with a fix live in the numbered `A20-*.md` files.

## 1. Inherited property, recorded not "hardened": the access-log known-IP set is unbounded

`internal/server/access_log.go:44-97` keeps `knownIPs map[string]struct{}` and adds every new client IP
for the lifetime of the process; it never evicts. Pinned does exactly the same, with a module-level
`Set` (`src/middleware/accessLogWriter.js:8`, `knownIPs`), and the middleware is only mounted when
`cliArgs.listen` is true (`src/server-main.js:152-154`). Changing it would be a visible behaviour change
(a repeated connection from a pruned IP would print "New connection from ..." again), so it is recorded
here as an inherited property rather than fixed. Operational consequence for an operator behind a
rotating-proxy front end: one map entry per distinct client or forwarded IP, ~tens of bytes each; the
pinned server has the same growth.

## 2. Boundary: world-info activation and ordering are FRONTEND code in the pinned baseline

`grep -n 'checkWorldInfo|getSortedEntries|activateWorldInfo' SillyTavern/src` is empty; the scanning,
recursion, inclusion-group, probability, sticky/cooldown and insertion-order logic all live in
`public/scripts/world-info.js` (28 matches). GoTavern serves the pinned `public/**` unchanged, so the
server has no world-info activation code that could diverge: `internal/server/worldinfo.go` is the CRUD
surface (`/list`, `/get`, `/edit`, `/delete`, `/import`), all of it fixture-pinned, and the routes reach
disk through `startup.UpdateUserContentFile` (per-user flock + atomic replace). The actor is the browser, so
`GOAL.md` Q16 ("is world-info activation the same?") is measured by the browser oracle
(`worldinfo-slots` workflow / subagent B), not by a server unit test. Server-side world-info ordering is
therefore **not a finding surface**, and a server "fix" for it would be inventing behaviour that pinned
does not have.

## 3. Audited and cleared: extension install / update / switch / move / delete

Read against the pinned source and found at parity:

| behaviour | pinned | GoTavern |
|---|---|---|
| install | `git.clone` into the FINAL path; on manifest failure removes the clone (extensions.js:92-150) | `extensions_git.go:629-719`; same clone, `removeExtensionTree(extensionPath, true)` on manifest failure |
| update | `checkIfRepoIsUpToDate` → `checkIsRepo(IS_REPO_ROOT)` → `git.pull('origin', branch)` (extensions.js:169-210) | `:383-455`; same order; a dirty worktree makes `git pull` fail, and nothing resets/forces |
| switch | origin/-prefix → checkout-or-create; local branch → 404 if absent, 204 if current, else checkout (extensions.js:266-330) | `:530-627`; same sequence |
| move | copy tree then `fs.rmSync(source)` (extensions.js:305-370) | `:239-293`; same order; a failure keeps the source |
| delete | dirty worktree refused unless forced (`git.checkIsRepo` + status/force branch) | `extensions_dirty_worktree_test.go` pins the refusal |
| git execution | simple-git with a 5-minute block timeout (extensions.js:17) | `exec.CommandContext` with the same 5-minute bound; adds `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` so a credentialed private repo fails fast instead of prompting (a hang-safety measure, not a silent behaviour change) |

No atomicity defect found: none of these pinned routes is atomic (pinned clones/checkouts in place), and
GoTavern reproduces the same failure window rather than inventing a different one.

## 4. Audited and cleared: atomic write / lock core

`startup.UpdateUserContentFile` (per-user flock from `lockacquire`, read-modify-write, `atomicReplace` with
temp file + write + fsync + rename + directory fsync, bounded Windows rename retry in `fsretry`) is the
single write path for chats, settings, world info, presets, secrets, images, sprites and metadata. Reads
that a concurrent replace can race use `fsretry.ReadFile`. A settings save has no shutdown flush, matching
pinned (only CHAT backups have the `process.on('exit')` flush, `src/endpoints/chats.js:118-122`, which
GoTavern calls from `RunningServer.Close`). The documented residual staleness windows of the identity-keyed
caches (settings aggregation, card text, account cache) are stated in their own file headers; an external
in-place rewrite that preserves size AND backdates mtime is the only way to serve a stale entry, and the
tests pin that window rather than hide it.

## 5. Audited and cleared: panic boundary, server timeouts, shutdown ordering

- `internal/server/panic_boundary.go` reproduces finalhandler's 500 page and re-panics once the head is
  out (the pinned "destroy the socket" observable); the message transform, headers and CSP are pinned.
- `internal/app/server.go` maps pinned Node's headersTimeout/keepAliveTimeout/maxHeaderSize and
  deliberately leaves WriteTimeout and ReadTimeout unset (SSE + upload bodies), with tests for both.
- `RunningServer.Close` stops the bounded heartbeat, drains the HTTP servers under the caller's context,
  closes listeners, then flushes pending chat backups; a second Close cannot repeat the flush.

## 6. Findings from this lane (all with RED/GREEN + mutation rows in their own files)

| id | severity | subject | status |
|---|---|---|---|
| A20-A | High | socket-close interrupt fired after every completed SD request | fixed; in main |
| A20-B | Medium | `sanitize-filename` two-pass replacement semantics + device #0 | fixed; in main |
| A20-C | Low | provider transport followed 19 redirects, pinned follows 20 | fixed; in main |
| A20-F | Medium | card base64 decoder rejected URL-safe/junk payloads pinned reads | fixed; in main |
| A20-G | High | character avatar mutations never invalidated the cached thumbnail | fixed on `a20/audit` |
| A20-H | Low | `/version` was the last browser-requested GET without the 304 face | fixed on `a20/audit` |
| A20-I | Low | `/api/backups/chat/download` bypassed pinned `send()` (stat ETag/Range/Last-Modified) | fixed on `a20/audit` |

## 7. Method (so the next audit can extend rather than repeat)

Every production package in the lane was read end to end where its size allowed (`httpx`, `fsretry`,
`userdata`, `startup/user_content_file.go`, `startup/user_data_lock.go`, `startup/content.go`,
`startup/user_backgrounds.go`, `startup/user_avatars.go`, `startup/secrets_state.go`, `outbound/raw.go`
+ `transport.go` + `privatefilter.go` + `dnsorder.go`, `app/heartbeat.go` + `server.go` shutdown,
`server/compression.go`, `server/http.go` middleware, `server/static.go`, `server/panic_boundary.go`,
`server/access_log.go`, `server/data_maid.go`, `server/cors_proxy*.go`, `server/extensions_*.go`,
`server/characters_card.go`, `server/characters_write.go`, `server/chat_backup.go`, `server/backups.go`,
`cmd/gotavern/browser.go`), plus targeted reads of the remaining `internal/server` route files by mutation
shape (write path, delete path, path join, stream close, redirect, cache invalidation). Production
goroutine launch sites were enumerated repo-wide (6) and each audited; `sync.Pool` use is one gzip-writer
pool with a Reset-before-Put discipline; HTTP body closure was checked at every `SendStreaming` call site
(6) and every `outbound.Send` caller (Send closes internally).
