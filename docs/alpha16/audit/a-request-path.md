# Lane A — browser→server request path, accounts/session/CSRF, settings save and the identity caches

**Status:** M0 read-only audit. **Tree read:** `c256f21` (`lane/alpha16-program`; no tracked file modified — the
only untracked paths are the M0 lanes' `docs/alpha16/` files). **Baseline oracle:** pinned SillyTavern `1.19.0` @
`06bde939fb1e9c4c8d8641d810f0a916b5bce127` in `../SillyTavern` (read-only).

**Method and its limit.** Every claim below is source-derived from the two trees named above; no server was
booted, no test/build was run, and no pinned capture was produced for a behaviour that does not already have
one (M0 hard rules, `docs/alpha16/README.md` §1.1/§1.9). Where a difference rests only on reading pinned's
source or a pinned dependency, the row says so and is classified `verified-risk` or `untested-hypothesis`,
never `confirmed-defect`. Existing gates are named where they cover a claim
(`docs/audit-v0.1.0-alpha.15.md` rows are re-verified, not re-derived, per README §1.8). The machine-readable
form of this report is [`fragments/a.json`](fragments/a.json); hypothesis ids are shared between the two files.

Legend for classifications: `confirmed-defect` | `verified-risk` | `untested-hypothesis` |
`intentional-parity` | `out-of-scope`. Surfaces: browser-wire | provider-wire | persisted-bytes |
startup-state | dom-events | performance.

---

## 1. Request path, stage by stage

The path is a single `net/http` server: one handler value, built once before any listener binds, that
composes the pinned middleware inline and then dispatches on a `http.ServeMux`. Every stage below names the
code that runs and, where the behaviour is inherited, the pinned line it is inherited from.

| # | Stage | GoTavern source | Pinned basis / note |
|---|---|---|---|
| 1 | process entry, exit mapping | `cmd/gotavern/main.go:36-60` | pinned exit statuses are reproduced per error class; config-parse failure is a pinned byte block (`main.go:70-79`) |
| 2 | reachability of help/version before dispatch | `cmd/gotavern/main.go:93-104`, `cmd/gotavern/cli.go:76-139` | yargs answers `--help`/`--version` in any position (GOAL §15.5) |
| 3 | server subcommand / bare flags | `cmd/gotavern/main.go:102-104,157-158` (`runServer`), `main.go:222-241` | `src/server.js` starts the server for the default invocation |
| 4 | working dir vs install root | `internal/app/server.go:158-173` (`process.chdir(serverDirectory)` reproduced by path selection) | pinned `src/server.js:11` |
| 5 | CLI parse → config → options | `internal/app/server.go:188-199` → `internal/commandline/options.go:203-318`; paths `internal/commandline/paths.go:61-159` | pinned `command-line.js`/`config.yaml` consumption; `options.go:223-316` maps each pinned `getConfigValue` call |
| 6 | data-root creation before use | `internal/app/server.go:200-224` | pinned resolves after its own chdir, so create/use are the same tree; divergence is recorded and fixed at this seam (`server.go:200-213`) |
| 7 | private-address filter, then provider proxy, then transport options | `internal/app/server.go:225-249` | pinned `src/server-main.js:348` then `:351`; `enableKeepAlive` `:100-101`; `dnsPreferIPv6` `:481` |
| 8 | whitelist page bytes read before the handler | `internal/app/server.go:251` | pinned reads `_errors/forbidden-by-whitelist.html` at whitelist-middleware construction `src/middleware/whitelist.js:58-60` |
| 9 | pinned data startup (config migration, users, content seeding) | `internal/app/server.go:253-272` → `internal/startup/commandline.go:14` → `internal/startup/data_startup.go:61` | pinned `src/server-startup.js` startup chain |
| 10 | protocol selection + TLS config | `internal/app/server.go:277-291`; server defaults `internal/app/server.go:77-118` | Node 20 defaults mapped field by field (`server.go:77-102`); `WriteTimeout`/`ReadTimeout` deliberately 0 |
| 11 | handler options translation | `internal/app/server.go:292-301` → `internal/server/http.go:140-240` (`HTTPHandlerOptionsFromCommandLine`) | one field per pinned `getConfigValue`/`cliArgs` read; nil-vs-false preserved with `*bool` fields (`http.go:44-136`) |
| 12 | handler construction: runtimes, middleware, mux, route table | `internal/server/http.go:314-334` (`NewHTTPHandlerWithOptions`) → `http.go:338-340` → `http.go:347-628` | middleware order `src/server-main.js:104-210`; route domains `internal/server/routes_registry.go:36-102` |
| 13 | listener bind order IPv6 then IPv4, Serve goroutines | `internal/app/server.go:310-323,448-470` | pinned boot prints/opens both families in order |
| 14 | Ready line after listeners serve | `cmd/gotavern/main.go:279-331` | pinned `Go to:` block `src/server-main.js:421-446` |
| 15 | per-request middleware chain | `internal/server/http.go:544-627` (order table in §2) | `src/server-main.js:104-248` |
| 16 | session load + account resolution + account-version invalidation | `internal/server/http.go:570-594`; `internal/server/csrf_session.go:103-131`; `internal/server/accounts.go:498-523` | pinned `cookieSession` `src/server-main.js:156-162`, `setUserData` `:164` → `src/users.js:955-1019` |
| 17 | CSRF validation (disabled-CSRF token route too) | `internal/server/http.go:598-611`; `internal/server/csrf_session.go:187-235,297-304` | pinned `csrfSync` `src/server-main.js:167-202`; token route `:192-196`; `/proxy/` skip `:186-188` |
| 18 | account-mode gate (pinned `requireLogin` + public-route set) | `internal/server/http.go:612-615`; `internal/server/accounts.go:589-611`; static publicness `internal/server/static.go:153-181`; CSS override `internal/server/frontend_assets.go:170` | pinned mount order: public users router `src/server-main.js:245` and `express.static` `:242` before `requireLogin` `:248`; 403 body `src/users.js:1027-1033` |
| 19 | index-route cache buster | `internal/server/http.go:619-625`; `internal/server/cache_buster.go:96-130` | pinned `app.get('/', cacheBuster.middleware, …)` `src/server-main.js:214` |
| 20 | route dispatch | `internal/server/http.go:362-534` + `internal/server/routes_registry.go:109-113`; catch-all `http.go:532-534` | pinned routers mounted at `src/server-startup.js:141-168` and `src/server-main.js:245-277`; redirect aliases `src/server-startup.js:66-134` |
| 21 | handler → persistence | e.g. settings `internal/server/settings_save.go:20-48` → `internal/startup/settings_backup.go:64-99`; accounts `internal/server/accounts.go:950,1057,1091,1175,1285,1340` → `internal/startup/storage.go:167,221,271` | pinned `write-file-atomic` / node-persist equivalents cited on each writer (§4) |
| 22 | handler → provider adapter | out of this lane; entry `internal/server/chat_completions.go:290-331` shows the browser→provider boundary and the streamed response path | pinned `src/util.js:732` `forwardFetchResponse` |
| 23 | response serializers | `internal/httpx/httpx.go:23-54` (`WeakETag`, `WriteJSONBytes`, `WriteStatusText`); `internal/server/accounts.go:1603-1614` (`respondJSON`); redirects `internal/server/http.go:711-738` | Express `res.json`/`res.sendStatus`/`res.redirect` byte shapes are fixture-asserted |
| 24 | response wrapping: responseTime → compression → panic boundary | `internal/server/http.go:544-545`; `internal/server/response_time.go:29-38`; `internal/server/compression.go:56-62,140-188`; `internal/server/panic_boundary.go:149-177` | pinned `helmet` `:104`, `compression` `:107`, `responseTime` `:108`; finalhandler 500 page (`panic_boundary.go:10-55`) |
| 25 | streaming response | `internal/server/chat_completions.go:299-340` (no Content-Type; `Vary: Origin`; flush loop) | pinned `forwardFetchResponse` sets no content type, which is why the compression filter never matches SSE (`compression.go:12-30`) |
| 26 | shutdown | `cmd/gotavern/main.go:333-341,358-374` → `internal/app/server.go:430-446` | pinned `exitProcess` `src/server-main.js:316-335`: stats, plugin cleanup, `process.exit()` |

**What the path deliberately does not have (each is either pinned parity, a Go safety addition, or a
hypothesis row):**

- **No global body-parser stage.** Pinned mounts `bodyParser.json` and `bodyParser.urlencoded` before CORS,
  basic auth, the whitelist and every route (`../SillyTavern/src/server-main.js:110-111`). GoTavern parses a
  body inside each handler (e.g. `internal/server/accounts.go:1442-1455`,
  `internal/server/settings_save.go:25-42`, and the per-route reproductions at `internal/server/sd.go:170-209`,
  `internal/server/worldinfo.go:77-82`, `internal/server/characters.go:157-185`). This changes both which
  requests are rejected and the order of rejection. → **A-H1**.
- **A panic boundary outside every pinned middleware.** Not a pinned middleware: it exists to reproduce
  Express `finalhandler` instead of dropping the connection (`panic_boundary.go:3-55`), and is justified.
  Its position has a compression consequence. → **A-H4**.
- **The Express automatic OPTIONS answer is gated on CORS being disabled** (`http.go:616`), while pinned's
  `cors` middleware can be mounted and still pass OPTIONS through when its `origin` option is falsy
  (`../SillyTavern/node_modules/cors/lib/index.js:209-234`). → **A-H2**.
- **`/proxy/:url(*)` is not registered.** Pinned mounts it at `src/server-main.js:257-265`; `routeDomainTable`
  (`routes_registry.go:46-101`) has no proxy row and the only production `/proxy/` literal in the tree is the
  CSRF exemption `csrf_session.go:192`. → **A-H13** (out of this lane's implementation scope).
- **Session loading is lazy** (`http.go:570-573`) instead of unconditional (`src/server-main.js:156-162`).
  Every handler that mutates the session calls `writeCookieSession` itself, so the lazy write is currently
  equivalent — except that one route can observe a nil session. → **A-H5**.

---

## 2. Middleware order, and the pinned line each position inherits

GoTavern composes the chain inline, outermost first (`internal/server/http.go:544-627`):

```text
pinnedPanicBoundary                                  http.go:544  (Go-only finalhandler reproduction)
└ pinnedCompressionMiddleware                        http.go:544  <- pinned server-main.js:107
  └ pinnedResponseTimeMiddleware                     http.go:544  <- pinned server-main.js:108
    └ setPinnedSecurityHeaders                       http.go:545  <- helmet, server-main.js:104
      setPinnedCORSBaseVary                          http.go:546
      servePinnedCORS                                http.go:547  <- cors, server-main.js:138
      basicAuth.authenticate                         http.go:550  <- server-main.js:141-143
      requestPassesWhitelist + forbidden page        http.go:553  <- server-main.js:145-148
      hostWhitelist.allow                            http.go:560  <- server-main.js:150
      accessLog.record                               http.go:566  <- server-main.js:152-154
      loadCookieSession                              http.go:570  <- server-main.js:156-162
      accounts.currentUser / version invalidation    http.go:575  <- setUserData, server-main.js:164
      session write (pre-handler)                    http.go:595
      disabled-CSRF token                           http.go:598   <- server-main.js:205-209
      CSRF validation                                http.go:604  <- server-main.js:167-202
      account-mode gate (requireLogin equivalent)    http.go:612  <- server-main.js:245-248
      Express automatic OPTIONS                      http.go:616
      index cache buster                             http.go:623  <- server-main.js:214
      mux.ServeHTTP                                  http.go:626
```

Positions that are pinned and **must not be moved** (GOAL §15.4 do-not-rewrite list names the middleware
order; the citations are what make each position checkable):

| Position | Pinned evidence | GoTavern |
|---|---|---|
| compression before responseTime before CORS | `server-main.js:107,108,138` | `http.go:544-547` |
| security headers before CORS and auth | `server-main.js:104` | `http.go:545` |
| CORS before basic auth before whitelist before host whitelist | `server-main.js:138,142,147,150` | `http.go:547-560` |
| access log only when `listen`, after the whitelists, before the session | `server-main.js:152-154` | `http.go:355-359,566`; gate test `internal/server/access_log_test.go:212` |
| session before account resolution before CSRF | `server-main.js:156,164,202` | `http.go:570-611`; contract test `internal/server/csrf_session_test.go:109-219` |
| CSRF before `requireLogin` | `server-main.js:202,248` | `http.go:604,612` |
| cache buster only on the index route, after the session | `server-main.js:214` | `http.go:619-625`; tests `internal/server/cache_buster_test.go:56,212` |
| redirect aliases after `requireLogin` (account mode) | `server-main.js:248,277` | recorded at `internal/server/redirect_aliases.go:55-59`; oracle `internal/server/redirect_aliases_test.go:82` |
| response headers (helmet set) | `server-main.js:104`; pinned fixture headers, e.g. `tests/oracle/sillytavern-1.19.0-settings-save.json` response headers | `internal/server/http.go:630-643` |

The hand-written base routes (`http.go:363-534`) are ordered for review, not dispatch: `ServeMux` selects the
most specific pattern and a duplicate registration panics at construction
(`internal/server/routes_registry.go:6-13`; teeth in `internal/server/routes_registry_test.go:346`). Domain
routes come from the explicit table (`routes_registry.go:36-102`) and are registered before the catch-all
(`http.go:529-534`).

**Ordering differences that are hypotheses, not order judgements:** A-H1 (no body-parser stage before
everything above), A-H2 (the automatic-OPTIONS gate), A-H4 (panic page outside compression).

---

## 3. `accountRuntime`: ownership, state and lifetime

`accountRuntime` is created once per handler construction
(`internal/server/http.go:352` → `internal/server/accounts.go:122-169`) and captured by the closures that make
up the handler; it is never mutated after construction except through its mutexes. Its owner is therefore the
`http.Handler` returned to `internal/app/server.go:301`, i.e. the process — there is no per-request runtime and
no `Close`.

| State | Source | Lifetime / bounds | Guard |
|---|---|---|---|
| `options` | `accounts.go:86` | immutable snapshot of startup config | none needed |
| `limiter`, `recoverLimiter`, `resetLimiter` | `accounts.go:87-89,159-161` | per-IP windows: 60 s login, 300 s recover/reset; entries removed on reset/clear | each limiter's own `sync.Mutex` (`accounts.go:115-120`) |
| `defaultUser` | `accounts.go:90,144-156` | constructed once; `created` is handler-construction time | immutable |
| `createMu` | `accounts.go:91` | held across `NodePersistKeys` + record write + directory creation + seeding (`internal/server/account_create.go:51-135`) | mutex |
| `recoveryMu`, `recoveryCodes` | `accounts.go:92-93` | map keyed by handle; 5-minute absolute expiry checked lazily (`accounts.go:877`, `1415-1427`) | mutex |
| `resetMu`, `resetCodes` | `accounts.go:94-95` | same shape; 5 minutes (`internal/server/account_data_reset.go:15,41-43,176-188`) | mutex |
| `settingsSaveMu`, `settingsSaves`, `settingsSaveWait` | `accounts.go:96-98,166-167` | throttle state per handle; 10-minute timer (§4) | mutex |
| `cacheBuster` | `accounts.go:99-102,163` | pinned singleton: pattern + consumed (handle, UA-hash) keys, process lifetime | its own mutex (`cache_buster.go:75`) |

State that is **not** on the runtime but is process-wide by design (matching pinned module singletons):
the stored-account cache (`accounts.go:305-308`), the settings/world metadata cache
(`settings_cache.go:93-97`), the data-maid token map (`data_maid.go:130-137`), the access-log known-IP set
(`access_log.go:44-60`), the host-whitelist known-host set (`host_whitelist.go:14-18`) and the gzip writer
pool (`compression.go:79-81`). Of these, only the metadata cache has a test reset hook
(`settings_cache.go:145-151`); the others rely on each test's distinct `t.TempDir()`/token for isolation.

**Lifetime end.** `app.RunningServer.Close` stops the heartbeat and shuts the HTTP servers down
(`internal/app/server.go:430-446`); `main` gives that shutdown a 10 s context (`cmd/gotavern/main.go:360-373`)
and a second signal force-closes listeners (`main.go:366-373`). `accountRuntime` has no shutdown hook, so its
timers and rate-limit state simply die with the process (§4, A-H8).

---

## 4. Settings save, backup timer, and what happens on shutdown

**Write path.** `POST /api/settings/save` (`internal/server/http.go:393`) →
`serveSettingsSave` reads a body capped at 500 MiB + 1 byte and answers 413 above the cap
(`settings_save.go:25-33`), rejects an empty/whitespace body with 400 (`:34-37`), formats the body the way
pinned `JSON.stringify(body, null, 4)` does (`:38-42` → `internal/startup/settings_json.go:7-18`), then:

- `saveSettings` takes `settingsSaveMu` (`settings_save.go:50-52`), resolves `settingsBackupRetention`
  (default 50, `:53-56`).
- **First save in a window** (no entry in `settingsSaves`): `startup.SaveSettings(..., makeSnapshot=true)`
  (`:66`), which takes the shared content lock (`internal/startup/settings_backup.go:76-80`), writes
  `settings.json` with `atomicReplace` (`:92`), then writes a duplicate-aware snapshot
  (`:95-98` → `:152-227`), then arms `time.AfterFunc(settingsSaveWait)` (`settings_save.go:71-73`).
- **Subsequent saves inside the window**: write `settings.json` only (`makeSnapshot=false`,
  `settings_save.go:57-63`) and set `pending = true` (`:59-62`).
- **Trailing edge** at 10 minutes: `flushSettingsSave` (`:77-87`) re-takes `settingsSaveMu`, verifies the map
  entry is still the same throttle object, writes the duplicate-aware snapshot if anything is pending
  (`:83-85`), and forgets the handle (`:86`).

This is the pinned `_.throttle(() => backupUserSettings(handle, true), AUTO_SAVE_INTERVAL)` shape:
`../SillyTavern/src/endpoints/settings.js:22-46` (10 min = `:23`), the save route calling it after the atomic
write (`:206-216`), and the duplicate check (`:136-156,158-170`). The save oracle
`tests/oracle/sillytavern-1.19.0-settings-save.json` replays first-save snapshot and second-save
suppression, byte-comparing `settings.json`, the snapshot names/bodies and the response
(`internal/server/settings_save_test.go:49-200`); `TestSettingsSaveTrailingSnapshotUsesLatestSettings`
(`:202-243`) is a separate unit-only test that drives the trailing edge with `settingsSaveWait = time.Hour`
and an explicit flush.

**Locks, order, and what blocks what.**
`settingsSaveMu` is held across both the file write and the content-lock acquisition, so it serializes
settings saves **across users**; the content lock is then acquired inside it
(`settings_save.go:50` → `internal/startup/settings_backup.go:76`). This is the only place `settingsSaveMu` is
taken, so there is no reverse ordering to deadlock against. Pinned's equivalent serializes *all* requests
because the write is synchronous on the event loop, so the Go serialization is not a parity regression, but
the wait is unbounded by any request context — the mutex is not `context`-aware and no handler passes
`r.Context()` into the write. That is a measurement question, not a defect: **A-H7**.

**Shutdown / cancel.** There is no cancellation path:
- the `AfterFunc` timer is not stopped anywhere outside tests (`settings_save_test.go:231` is the only `Stop`);
- `accountRuntime` exposes no `Close`, and `RunningServer.Close` (`internal/app/server.go:430-446`) does not
  know about it;
- on SIGINT/SIGTERM the process shuts the servers down inside a 10 s context (`cmd/gotavern/main.go:360-373`)
  and returns; a pending trailing snapshot is lost if it did not fire before exit.

Pinned behaves the same way: `exitProcess` awaits stats/plugin cleanup and then calls `process.exit()`
without flushing the throttle (`../SillyTavern/src/server-main.js:316-331`). So the loss is
`intentional-parity` (A-H8), not a Go defect. One nuance: the Go timer may fire *during* the 10 s drain
(because the runtime goroutine is not tied to the shutdown context), so a backup can still land after the
listeners stop — harmless, and it is not waited on.

**Snapshot create/restore/edit paths in this lane's scope.** `POST /api/settings/make-snapshot` →
`startup.CreateSettingsSnapshot` under the same content lock with an atomic write
(`internal/startup/settings_snapshots.go:90-165`); `restore-snapshot` → `startup.RestoreSettingsSnapshot`,
also atomic (`:169-214`). Pinned instead removes `settings.json` and copies the snapshot over it
(`../SillyTavern/src/endpoints/settings.js:365-367`), so GoTavern's restore is atomic where pinned has a
window in which the file does not exist; that is a recorded writer difference (§5), not a defect.
`POST /api/users/reset-settings` deletes `settings.json` (`internal/server/account_reset.go:56-69`) and
re-seeds defaults (`:70-75`), matching `../SillyTavern/src/endpoints/users-private.js:193-195`.

---

## 5. Writers owned by this lane (settings and account records; the character/chat matrix is Lane B)

| Surface / route | Writer | Lock | Atomicity | Path policy | Error shape | Probe |
|---|---|---|---|---|---|---|
| `POST /api/settings/save` | `settings_save.go:43` → `internal/startup/settings_backup.go:64-99` | `settingsSaveMu` (`settings_save.go:50`) then content lock (`settings_backup.go:76`) | `atomicReplace` (`settings_backup.go:92`); snapshot also atomic (`:215`) | `ensureContained`/`ensureResolvedContained` (`:85-91`) | 500 status text on any save failure (`settings_save.go:43-46`) | `internal/server/settings_save_test.go:49` **covered** (pinned oracle) |
| trailing settings snapshot | `settings_save.go:83-85` → `settings_backup.go:102-129` | same content lock | `atomicReplace` (`:215`) | same containment | error logged and dropped (`settings_save.go:84` discards) | `settings_save_test.go:202` **covered** (trailing edge) |
| `POST /api/settings/make-snapshot` | `settings_snapshots.go:60` → `internal/startup/settings_snapshots.go:90-165` | content lock (`:108`) | `atomicReplace` (`:156`) | containment `:117-149` | 500 (`settings_snapshots.go:60-63`) | `internal/server/settings_snapshots_test.go:69` **covered** |
| `POST /api/settings/restore-snapshot` | `settings_snapshots.go:80` → `internal/startup/settings_snapshots.go:169-214` | content lock (`:182`) | `atomicReplace` (`:210`) | containment `:191-208` | 500/404 (`settings_snapshots.go:80-89`) | `settings_snapshots_test.go:69` **covered**; pinned's rm+copy is `settings.js:365-367` (difference recorded here) |
| `POST /api/users/reset-settings` | `internal/server/account_reset.go:56-75` | none at the handler (the seed path locks internally) | `os.Remove` (`:62`) then re-seed (`:72-75`) | `DirectoriesForUser` (`:51`) | 500/403 (`:57-69`) | `internal/server/account_reset_settings_test.go:55` **covered** |
| `POST /api/users/create` | `account_create.go:106` → `internal/startup/storage.go:221-266` | `createMu` (`account_create.go:51`); storage lock (`storage.go:237`) | `atomicCreate` (`:262`) / `atomicReplace` (`:255`) | `DirectoriesForUser` (`:124`) | 500 (`account_create.go:106-109`) | `internal/server/account_create_test.go:77` **covered** |
| `POST /api/users/delete` | `accounts.go:1340,1345` | none at the handler; `RemoveNodePersistRecord` takes the storage lock (`storage.go:289`) | record `os.Remove` (`storage.go:296`) then `os.RemoveAll` (`accounts.go:1345`) with a data-root guard (`accounts.go:1329-1338`) | `DirectoriesForUser` (`:1324`), `filepath.Clean` + equality guard | 500 | `internal/server/account_admin_test.go:37` **covered** |
| `POST /api/users/{change-name,change-password,change-avatar,disable,enable,promote,demote,recover-step2}` | `accounts.go:1057,1091,1175,1285,950` | none at the handler; `UpdateNodePersistRecord`/`SetNodePersistRecord` take the storage lock (`storage.go:180,237`) | `atomicReplace` (`storage.go:211,255`), `atomicCreate` (`:262`) | handle is a node-persist key, hashed to a filename (`accounts.go:763-765`) | 500 | `account_mutations_test.go:81`, `account_private_test.go:48`, `account_recovery_test.go:111`, `account_admin_test.go:37` **covered** |
| `POST /api/users/reset-step2` (data reset) | `account_data_reset.go:116-132` | none at the handler | `os.RemoveAll` (`:116`) then `EnsureDirectories` (`:126`) and `SeedDefaultContent` (`:130`) | `DirectoriesForUser` (`:107`) | 500 | `internal/server/account_data_reset_test.go:60` **covered** |
| `POST /api/users/backup` (download) | `account_backup.go:52-77` | none | temp zip in `os.TempDir`, streamed | **no containment check**: `filepath.Join(DataRoot, FromSlash(handle))` (`:51`) | 500/403 | `internal/server/account_backup_test.go:46` **covered** |

Row that needs a recorded decision, not a fix: the `/api/users/backup` root is built by plain path join with
an admin-supplied handle (`account_backup.go:51`), exactly as pinned does (`getUserDirectories(handle)` →
`path.join(DATA_ROOT, handle)` at `../SillyTavern/src/users.js:1149`). It is an inherited weakness (AGENTS
“Architecture boundaries” 5) and should appear as a known inherited property in the compatibility matrix;
this audit records it rather than changing it (`intentional-parity`).

---

## 6. Caches and process state per GOAL.md §15.3

GOAL §15.3 requires eleven statements per cache. The two data caches are given in full; the remaining
process state is listed after them with the same fields where they apply.

### 6.1 Stored-account cache — the §15.3 reference cache

Source: `internal/server/accounts.go:239-357`, platform witness `internal/server/record_change_unix.go`,
`internal/server/record_change_windows.go`; test `internal/server/accounts_cache_test.go:1-317`.

| Field | Value |
|---|---|
| key | absolute record path + mtime + size + (Unix) inode change time; `accounts.go:311-321` |
| value | decoded account fields map + found flag; `accounts.go:296-303` |
| owner | `internal/server`, process-local; `accounts.go:305-308` |
| lifetime | until the next stat disagrees, cache eviction, or process exit; no TTL (`accounts.go:250-256`) |
| capacity | 256 entries (`accounts.go:294`) |
| eviction | whole map dropped at the limit; every entry re-derivable (`accounts.go:328-333`) |
| invalidation | any stat-field disagreement (`:315-320`); explicit forget when the record is missing (`:344-348`, called `:395,406`) |
| external modification | ordinary rewrite changes mtime/size; atomic temp+rename also moves ctime on Unix; Windows has no cheap witness — **recorded boundary** (`record_change_windows.go:5-40`) |
| concurrency | one package mutex; callers receive a clone (`accounts.go:350-357`) so a handler cannot mutate cached state; `accounts_cache_test.go:138-157` |
| rebuild | a miss is the original read path (`accounts.go:384-429`), including the bounded retry for the Windows sharing violation (`:359-382`) |
| fallback | mtime+size when the change stamp is unavailable (`accounts.go:318-320`, `record_change_*`) |
| measured benefit | `loadStoredAccount`→`os.ReadFile` was **40.4 % cumulative** of a request's CPU, `os.ReadFile` 1.95 s of 5.42 s sampled (`accounts.go:240-246`, measured 2026-10-29 with `BenchmarkManyFrontendAssets`) |

Re-verification of the alpha.15 audit's C-14 row (Windows no-witness boundary): current code matches the
recorded boundary and the test asserts the stale value there deliberately
(`accounts_cache_test.go:219-238`). No new defect.

### 6.2 Settings aggregation / world-info listing cache (identity-keyed response memo)

Source: `internal/server/settings_cache.go:1-315`; call sites `internal/server/settings_get.go:60-86`,
`internal/server/worldinfo.go:229-249`; tests `internal/server/settings_cache_test.go:174-375`.

| Field | Value |
|---|---|
| key | route kind + `\x00` + data root + `\x00` + handle (`settings_cache.go:101-103`); hit/miss is decided by a sha256 identity digest of the inputs (`:88-91,107-115`) |
| value | the fully serialized HTTP response body, never a parsed structure (`settings_cache.go:18-23`) |
| owner | `internal/server`, process-local (`:24-25`) |
| lifetime | until the identity changes or eviction; no TTL (`:26-29`) |
| capacity | 64 entries **and** 64 MiB of bodies, whichever first (`:83-86`) |
| eviction | whole map dropped when either bound would be exceeded (`:120-135`) |
| invalidation | identity digest changes: file type+size+mtime, names for the world listing (`:188-193,243-315`) |
| external modification | identity recomputed on every request, before and after the rebuild; only a stable identity is stored (`settings_get.go:64-84`, `worldinfo.go:230-249`) |
| concurrency | package mutex; hits return a copy; no lock held across file IO or serialization (`settings_cache.go:48-51,107-115`) |
| rebuild | the original uncached aggregation, same errors and 500s (`settings_get.go:88-139`) |
| fallback | no store on a hash/serialize failure or oversize body; the response is the uncached one (`settings_cache.go:54-55,120-123`) |
| measured benefit | `/api/settings/get` 5.9 ms / 4.6 MB (220 docs) and 30 ms / 23.6 MB (1100 docs); `/api/worldinfo/list` 22–64 ms / 27–50 MB (50–1000 files) → a stat/hash walk plus a body copy (`settings_cache.go:5-10,56-59`, CI run 41758175427 as quoted there) |
| residual | an external in-place rewrite that preserves both size and mtime is invisible — **documented and pinned by a test** (`settings_cache.go:61-66`; `settings_cache_test.go:266-305`) |

Note the difference from the account cache: this one hashes type+size+mtime and **not** the Unix change
stamp (`settings_cache.go:188-193`). The residual is therefore slightly wider than the account cache's on
Unix, but it is the documented model and it is pinned by a test, so this is `verified-risk`, not a new
defect: **A-H11**.

### 6.3 Remaining process state owning identity or rate data (same fields, condensed)

| State | key → value | lifetime / capacity / eviction | invalidation / external mod | concurrency | parity |
|---|---|---|---|---|---|
| cache-buster keys (`cache_buster.go:71-77,108-130`) | handle + sha256(User-Agent) → consumed marker | process lifetime; **unbounded**, matching pinned's module `Set` (`src/middleware/cacheBuster.js:13,72-85`); consumed before the pattern decision | none (not data) | mutex | intentional-parity |
| data-maid tokens (`data_maid.go:125-179`) | hex token → handle + path/hash list | until replaced by the next `/report` for that handle, used by `/finalize`, or restart; one token per handle; nothing persists | replaced per handle (`:159-164`); fixture pins that a token from a previous recording is unusable (`:130-133`) | mutex | intentional-parity |
| access-log known IPs (`access_log.go:44-60,84-101`) | IP (with forwarded suffix) → marker | process lifetime; unbounded, matching pinned `knownIPs` Set (`src/middleware/accessLogWriter.js:8,38-40`) | none | mutex | intentional-parity |
| host-whitelist known hosts (`host_whitelist.go:14-18,49-72`) | raw `Host` → marker | process lifetime; capped at 1000, matching `maxKnownHosts` (`src/middleware/hostWhitelist.js:6,27`) | none | mutex | intentional-parity |
| basic-auth attempts (`basic_auth.go:20-40`) | rate-limit key → consumed/expires | 60 s window; entry deleted on success/expiry; map bounded only by distinct keys | window reset | mutex | intentional-parity (pinned rate-limiter-flexible) |
| login/recover/reset limiters (`accounts.go:110-200`) | IP → window | 60 s / 300 s / 300 s windows; entries removed on clear or when re-observed after expiry | window reset/clear | per-limiter mutex | intentional-parity (`src/endpoints/users-public.js:18-26`, `users-private.js:22-25`) |
| recovery/reset codes (`accounts.go:92-95`, `account_data_reset.go:15,41-43,176-188`) | handle → code + expiry | 5-minute absolute TTL, checked lazily; pinned `Cache(5*60*1000)` (`src/util.js:917-967`, `users-public.js:14`, `users-private.js:17`) | expiry / successful use / overwrite | mutex | intentional-parity |
| settings-save throttles (`accounts.go:96-98`, `settings_save.go:15-18`) | handle → timer + pending flag | one per handle with a save in the last 10 min; map entry removed by the timer flush | timer/flush | `settingsSaveMu` | intentional-parity (§4) |
| gzip writer pool (`compression.go:76-81`) | pooled `*gzip.Writer` | `sync.Pool`; Reset before reuse; bounded by GC | n/a | pool | implementation detail |

---

## 7. Hypothesis rows

`strength` follows README §3: 5 = reproduced/source-proven with a user-visible consequence, 4 = source-proven
with an obvious reproducer, 3 = strong hypothesis with one unknown, 2 = plausible, needs a probe, 1 = suspicion.
No row was reproduced in M0 (no test/build may run here); the strongest rows are therefore capped at 3.

### A-H1 — there is no app-level body-parser stage, so account/settings routes accept bodies pinned ignores
- **classification:** `verified-risk` · **surface:** browser-wire · **impact:** user-visible (API/extension
  clients; not the pinned browser) · **strength:** 3
- **evidence:** `../SillyTavern/src/server-main.js:110-111` (both parsers mounted before CORS/auth/whitelist);
  `../SillyTavern/node_modules/body-parser/lib/types/json.js:108` (`req.body = req.body || {}`) and
  `:120-124` (a non-matching content type is not parsed), `:127-134` (a non-UTF charset is 415), `:142`
  (the 500 MiB limit is body-parser's); `../SillyTavern/src/endpoints/users-public.js:63,152` (handlers test
  `request.body.<field>`, which is undefined when parsing was skipped → 400); Go:
  `internal/server/http.go:544-627` has no such stage, `internal/server/accounts.go:1442-1455` and
  `:772-785` read and parse the body regardless of `Content-Type`, and
  `internal/server/settings_save.go:25-42` does the same.
- **consequence:** (a) `POST /api/users/login` with `Content-Type: text/plain` and `{"handle":"default-user"}`
  → pinned parses nothing, `request.body.handle` is undefined, **400 `Missing required fields`**; Go parses the
  body and can **log in and set a session cookie (200)**; the same class applies to every route using
  `readAccountRequestBody`, including user creation (a persistence side effect) and settings save; (b) a
  non-UTF charset is 415 on pinned and parsed by Go; (c) a body over 500 MiB is 413 on pinned and truncated
  to 400 on Go for these routes (settings save alone checks its own cap); (d) body-parser runs before the
  whitelist and basic auth, so a request that fails both gives 400/413/415 on pinned and 403 on Go.
- **reproducer:** NONE for this class on these routes (the existing settings-save oracle only sends valid JSON,
  `tests/oracle/sillytavern-1.19.0-settings-save.json`).
- **reproducerPlan:** extend the account probe with a `text/plain` login scenario and a `charset` scenario,
  record pinned once, then replay through `NewHTTPHandlerWithOptions` as the account tests already do
  (`internal/server/accounts_test.go:130-230` shows the login/session harness).
- **counterargument:** the pinned frontend always sends `application/json` and the header
  (`upstream/public/script.js:647-658`), so no in-browser journey can observe this; the project has modelled
  body-parser per route where a fixture measured it (`internal/server/sd.go:170-209`,
  `internal/server/worldinfo.go:77-82`, `internal/server/characters.go:157-185`) and some routes accept both
  media types per pinned. The gap is that the *account/settings* family models none of it.

### A-H2 — `cors.enabled: true` with a falsy `cors.origin` loses the Express automatic OPTIONS answer
- **classification:** `verified-risk` · **surface:** browser-wire · **impact:** user-visible (cross-origin
  clients) · **strength:** 3
- **evidence:** Go: `internal/server/cors.go:59-61` returns false without writing when `!enabled ||
  !corsTruthy(origin)`; the automatic-OPTIONS reproduction is guarded by `!corsSettings.enabled`
  (`internal/server/http.go:616`); with no route matching, OPTIONS reaches the catch-all
  (`http.go:532-534`) → `serveNotFound` (`internal/server/static.go:196-218`) = 404. Pinned: `cors@2.8.5`
  passes the request through when `corsOptions.origin` is falsy
  (`../SillyTavern/node_modules/cors/lib/index.js:209-234`), so Express's router answers OPTIONS with the
  methods list — the shape GoTavern already reproduces in `writePinnedExpressAutomaticOptions`
  (`internal/server/cors.go:177-190`) and in the disabled-CORS arm (`http.go:616`;
  `internal/server/cors_test.go:118-158`).
- **consequence:** `OPTIONS /api/sprites/get` with `cors.enabled: true, cors.origin: null` (YAML `origin:` with
  no value) or `false`/`""` answers 200 + `Allow: GET,HEAD` + the 12-byte body on pinned, and 404 on GoTavern.
- **reproducer:** NONE (the CORS oracle covers enabled-with-a-string-origin, disabled, and wildcard:
  `internal/server/cors_test.go:51-202`).
- **reproducerPlan:** add `cors.origin` null/false/"" scenarios to the CORS probe, record pinned, replay
  `NewHTTPHandlerWithOptions{CorsSettingsConfigured:true, CorsEnabled:&true, CorsOrigin:nil}` and assert the
  OPTIONS status/headers/body.
- **counterargument:** the shipped default `cors.origin` is the *string* `"null"` (truthy) at
  `internal/commandline/options.go:289`, so only a hand-edited config reaches this; and the Go answer could be
  argued as safer. Parity is the contract, so the divergence still needs recording.

### A-H3 — `/api/settings/save` empty-body and failure response semantics differ from pinned
- **classification:** `verified-risk` · **surface:** persisted-bytes · **impact:** data-safety ·
  **strength:** 3
- **evidence:** pinned `../SillyTavern/src/endpoints/settings.js:206-216`: writes
  `JSON.stringify(request.body, null, 4)` and, on any throw, answers **200** with `response.send(err)`
  (JSON of an `Error` is `{}`). With no body or a non-JSON content type, body-parser leaves `request.body = {}`
  (`body-parser/lib/types/json.js:108,120-124`), so pinned **overwrites `settings.json` with `{}` and answers
  200 `{result:"ok"}`**. Go: `internal/server/settings_save.go:34-37` answers 400 for an empty/whitespace body
  without writing, and `:43-46` answers 500 for any save error.
- **consequence:** two observable differences on the same route: an empty-body save wipes the file on pinned and
  is refused by Go; a write failure answers 200/`{}` on pinned and 500 on Go. The Go behaviour is safer and
  different — which AGENTS “Architecture boundaries” 5 says must be recorded, not silently kept.
- **reproducer:** NONE (the oracle only has valid-JSON `first`/`second` requests and an unauthorized case:
  `tests/oracle/sillytavern-1.19.0-settings-save.json` responses map).
- **reproducerPlan:** add `emptyBody` and `writeFailure` (fault-injected) scenarios to the settings-save probe;
  assert status/body and, for empty body, the resulting `settings.json` bytes.
- **counterargument:** no frontend code path sends an empty or non-JSON save body (`upstream/public/script.js`
  builds the settings object and `getRequestHeaders`), so this is not reachable from the pinned UI; the empty
  body case would be a data wipe, so GoTavern's refusal may deserve an explicit product decision instead.

### A-H4 — the panic-boundary 500 bypasses the pinned compression/response-time wrapper
- **classification:** `untested-hypothesis` · **surface:** browser-wire · **impact:** maintainability ·
  **strength:** 2
- **evidence:** Go mounts `pinnedPanicBoundary(pinnedCompressionMiddleware(pinnedResponseTimeMiddleware(...)))`
  (`internal/server/http.go:544-545`), so the boundary's page is written to the *outermost* writer with an
  explicit `Content-Length` (`internal/server/panic_boundary.go:185-207`). Pinned mounts `compression()` before
  its routes and its error handler (`../SillyTavern/src/server-main.js:107`), so finalhandler's `res.end(body)`
  passes through compression: a compressible page ≥1024 bytes for a gzip-accepting client is framed
  `Content-Encoding: gzip` with no `Content-Length` (`internal/server/compression.go:12-30` records the same
  filter/threshold rules from the pinned package).
- **consequence:** for a panicking route whose message is long enough, pinned's 500 is compressed and chunked;
  Go's is identity and length-delimited. The body already differs because Go deliberately does not reproduce
  the V8 stack (`panic_boundary.go:20-43`), so this is the remaining header/framing difference.
- **reproducer:** units only (`internal/server/panic_boundary_test.go:89-181`), no pinned capture.
- **reproducerPlan:** record a pinned 500 with headers only (the body embeds host paths and a V8 stack, so the
  probe must classify the body `shape`), then compare `Content-Encoding`/`Content-Length`/`Transfer-Encoding`
  for an `Accept-Encoding: gzip` request against a handler whose route panics with a >1 KiB value.
- **counterargument:** the only way to reach it is a product bug; fixing it would mean writing the finalhandler
  page *through* the compression writer, which risks a second-status-line hazard after a partial write — the
  reason the boundary is outermost at all.

### A-H5 — with CSRF disabled and accounts off, `/api/users/login` sees no session and answers 500
- **classification:** `untested-hypothesis` · **surface:** browser-wire · **impact:** user-visible ·
  **strength:** 3
- **evidence:** Go loads a session only for accounts mode, `/csrf-token`, the two auth POSTs, or a CSRF-requiring
  method (`internal/server/http.go:570-573`); `requiresCSRFSynchronization` is false for
  GET/HEAD/OPTIONS/proxy and for *everything* when `DisableCSRF` is set (`internal/server/csrf_session.go:187-193`);
  `serveUserLogin` requires a session and answers 500 without one (`internal/server/accounts.go:823-827`);
  `disableCsrfProtection` is the config key (`internal/commandline/options.go:256`). Pinned mounts
  `cookieSession` unconditionally (`../SillyTavern/src/server-main.js:156-162`) and its login route only
  requires `request.session` (`../SillyTavern/src/endpoints/users-public.js:89-92`); in single-user mode the
  default-user record exists (`../SillyTavern/src/users.js:568`) so the login succeeds.
- **consequence:** single-user install + `disableCsrfProtection: true`, `POST /api/users/login`
  `{"handle":"default-user"}` → pinned 200 `{"handle":"default-user"}` + session cookie; Go 500.
- **reproducer:** NONE.
- **reproducerPlan:** `NewHTTPHandlerWithOptions{AccountsEnabled:false, DisableCSRF:true, CookieSecret:…,
  DataRoot:…}` with the default-user record, POST the login body; record pinned with the same config.
- **counterargument:** with accounts disabled the login page redirects to `/` (`accounts.go:525-529`), so no
  browser path reaches the route; only an API client or an extension fetch would. The 500 is still observable
  and the condition is a deliberate config (CSRF must sometimes be disabled behind a proxy that terminates it).

### A-H6 — over TLS the session `Set-Cookie` attribute order differs from pinned
- **classification:** `untested-hypothesis` · **surface:** browser-wire · **impact:** maintainability ·
  **strength:** 2
- **evidence:** Go appends `; secure` after `; samesite=lax; httponly` (`internal/server/csrf_session.go:267-278`;
  the clearing variant `internal/server/accounts.go:613-621`). Pinned's `cookies@0.9.1` infers `secure` from the
  request protocol and emits it **before** `httponly`
  (`../SillyTavern/node_modules/cookies/index.js:119-131` and `:213-219`). The contract test pins the exact
  five-part plain-HTTP shape (`internal/server/csrf_session_test.go:359-376`) and the recorded fixture has no
  TLS variant (`tests/oracle/sillytavern-1.19.0-account-session.json:91-96`).
- **consequence:** under SSL/TLS the raw `Set-Cookie` byte order differs; browsers do not care, so only a
  byte-comparing differential or a harness that replays the header sees it.
- **reproducer:** NONE (no TLS fixture).
- **reproducerPlan:** replay the csrf-session probe over `httptest.NewTLSServer` and record pinned listening on
  TLS, then compare the raw `Set-Cookie` values; extend `checkPinnedSessionCookieAttributes` to six parts.
- **counterargument:** attribute order is not semantically meaningful (RFC 6265), and `secure` presence itself
  matches, so this is cosmetic unless a fixture asserts raw bytes.

### A-H7 — one global settings-save mutex is held across disk IO, so saves serialize across users
- **classification:** `untested-hypothesis` · **surface:** performance · **impact:** concurrency ·
  **strength:** 3
- **evidence:** `settingsSaveMu` is taken for the whole save (`internal/server/settings_save.go:50-52`) and the
  JSON write + snapshot copy + content lock happen inside it (`:57-75` → `internal/startup/settings_backup.go:76-98`);
  no request context reaches the write, so a client cancel cannot stop it
  (`settings_save.go:20-48` never reads `r.Context()`). Pinned serializes more, not less: the same write is
  synchronous on the event loop (`../SillyTavern/src/endpoints/settings.js:206-216`).
- **consequence:** not a parity regression; the open question the plan names as R2 is whether eight concurrent
  users (E06) produce a user-visible p95 save latency or a blocked unrelated request. A bounded content lock is
  taken inside the same critical section, so the wait also includes lock acquisition (bound is Lane C's).
- **reproducer:** NONE for contention (the trailing-edge test only serializes one handle,
  `internal/server/settings_save_test.go:202-243`).
- **reproducerPlan:** E06-style measurement, same runner and commit: 1 user vs 8 users × N saves, record
  per-save duration and p50/p95 across users, with a same-run baseline; only then decide whether a per-user
  coordinator is justified (M0 must not build it).
- **counterargument:** the critical section is small (one `settings.json` ≈ tens of KB plus at most one snapshot
  copy); pinned's equivalent is strictly worse for all requests; a per-user coordinator adds ownership and
  shutdown surface that must itself be proven.

### A-H8 — the throttled trailing settings snapshot is lost on shutdown, exactly as in pinned
- **classification:** `intentional-parity` · **surface:** persisted-bytes · **impact:** data-safety ·
  **strength:** 2
- **evidence:** the `AfterFunc` timer is never stopped outside tests (`internal/server/settings_save.go:71-73`;
  only `internal/server/settings_save_test.go:231` calls `Stop`), `accountRuntime` has no close
  (`internal/server/accounts.go:85-103`), and `RunningServer.Close` only stops the heartbeat and the HTTP
  servers (`internal/app/server.go:430-446`), after which `main` returns
  (`cmd/gotavern/main.go:333-341`). Pinned's `exitProcess` awaits stats/plugins and calls `process.exit()`
  without flushing the 10-minute throttle (`../SillyTavern/src/server-main.js:316-331`; the throttle is
  `settings.js:36-46`).
- **consequence:** a pending trailing snapshot can be lost on shutdown in both servers. A GoTavern graceful
  drain does not include the timer, and no code waits for it; a timer that happens to fire during the 10 s
  drain still writes atomically.
- **reproducer:** NONE.
- **reproducerPlan:** if a product decision later requires durability, add a shutdown step that flushes
  `settingsSaves` under the same mutex and a test that cancels a running server with a pending save; until
  then the parity statement is the contract.
- **counterargument:** a fix here would diverge from pinned by writing a backup pinned would not have written at
  that moment; it is a product decision, not a drift.

### A-H9 — the account-version hash is derived from stored JSON bytes, not from `JSON.stringify`
- **classification:** `untested-hypothesis` · **surface:** browser-wire (session validity) · **impact:**
  user-visible (forced logout on a backend swap) · **strength:** 2
- **evidence:** Go builds `[handle, password, salt]` from the record's raw `json.RawMessage` values with
  `compactJSON` (`internal/server/accounts.go:443-463,92-101`) and compares it to the value stored in the
  session (`:513-521`), answering 403 and clearing the cookie on a mismatch (`internal/server/http.go:583-587`).
  Pinned hashes `JSON.stringify([user.handle, user.password, user.salt])` with shake256/8 bytes
  (`../SillyTavern/src/users.js:943-947`) and invalidates identically (`:993-1005`).
- **consequence:** for the same logical record the two hashes are equal only when the stored encoding equals
  JavaScript stringification. A record whose `value` carries `\uXXXX` escapes for non-ASCII (a writer other
  than node-persist/`marshalNodeJSON`) yields a different version, so a browser session created by pinned Node
  is invalidated (403 + cookie clear) by GoTavern on the first request after a backend swap even though the
  account did not change.
- **reproducer:** NONE.
- **reproducerPlan:** a table test over record encodings (`"é"` vs `"\u00e9"` in handle/password/salt) asserting
  the Go version equals a pinned-captured version for both; if the pinned capture shows `JSON.stringify`
  canonicalises the escape, the Go implementation should hash the parsed-then-restringified values.
  `marshalNodeJSON` already disables HTML escaping (`accounts.go:1593-1601`).
- **counterargument:** node-persist's own writer uses `JSON.stringify`, so a real installation's records are
  already in JS form; the divergence needs a non-JS writer, and both writers here are atomic and normalising.

### A-H10 — whitelist denials and invalid whitelist entries do not print pinned's console lines
- **classification:** `untested-hypothesis` · **surface:** startup-state · **impact:** maintainability ·
  **strength:** 2
- **evidence:** pinned warns on every blocked connection except `/favicon.ico`
  (`../SillyTavern/src/middleware/whitelist.js:62-64,92-98`), warns when `whitelist.txt` is used
  (`:18-20`), and filters invalid entries with a warning (`:29`, `filterValidIpPatterns` at
  `../SillyTavern/src/express-common.js:86-105`). Go's `serveWhitelistForbidden`
  (`internal/server/whitelist.go:358-367`) writes only the page; invalid patterns are skipped silently at match
  time (`whitelist.go:86-98,100-195`); `loadWhitelistPatterns` accepts the file body with no warning
  (`internal/app/server.go:339-356`).
- **consequence:** an operator debugging "why can't I connect" gets pinned's console explanation from pinned and
  nothing from GoTavern; no browser, persisted-bytes or provider-wire observable changes.
- **reproducer:** NONE.
- **reproducerPlan:** a pinned boot probe capturing stderr/stdout for a blocked connection, a whitelist.txt boot
  and an invalid-pattern config, then the same three boots in Go.
- **counterargument:** these are `console.*` lines gated by `logging.minLogLevel`; no committed fixture compares
  startup console output for these paths, so the project may have decided the lines are not contract. If so, the
  decision should be recorded, because the current state is "silently different".

### A-H11 — the settings/world metadata memo has the documented same-size, same-mtime residual
- **classification:** `verified-risk` · **surface:** persisted-bytes · **impact:** data-safety (stale read) ·
  **strength:** 2
- **evidence:** identity is file type + size + mtime (`internal/server/settings_cache.go:188-193`), unlike the
  account cache which adds the Unix change stamp (`internal/server/accounts.go:311-321`); the residual is
  documented (`settings_cache.go:61-66`) and pinned by
  `TestMetadataCacheSameIdentityWindowIsTheDocumentedResidual` (`internal/server/settings_cache_test.go:266-305`).
- **consequence:** an external rewrite that preserves size and backdates mtime serves the cached body until a
  later change or eviction. Product writes replace atomically and change mtime, and a test proves a product
  write invalidates (`settings_cache_test.go:174-236`).
- **reproducer:** the existing residual test (green today; it pins the documented behaviour, so it is not a
  failing reproducer).
- **reproducerPlan:** if a stronger witness is wanted, hash the change stamp exactly as the account cache does;
  measure the extra cost on the 1100-document workload before adopting.
- **counterargument:** no production writer produces a same-size same-mtime replacement; adding the witness costs
  a stat per file on the page-load path this cache exists to shorten.

### A-H12 — Windows account-cache boundary (re-verification of alpha.15 C-14)
- **classification:** `intentional-parity` · **surface:** persisted-bytes · **impact:** data-safety (stale
  read) · **strength:** 2
- **evidence:** `internal/server/record_change_windows.go:5-40` (three rejected witnesses, measured 2026-11-04)
  and the test's documented-boundary branch `internal/server/accounts_cache_test.go:219-238`; Unix detection
  `internal/server/record_change_unix.go`.
- **consequence:** on Windows a same-size, mtime-restored external replacement can be served stale until a later
  identity change, eviction or restart. The alpha.15 audit row C-14 described exactly this state; the current
  tree still matches it (`docs/audit-v0.1.0-alpha.15.md:111`).
- **counterargument:** both real writers replace atomically; the remaining window needs an external
  timestamp-preserving restore. No change proposed.

### A-H13 — `/proxy/:url(*)` is in the pinned route set but not in the route-domain table
- **classification:** `out-of-scope` (implementation belongs to a provider/egress domain; recorded so the
  route census is not silently short) · **surface:** browser-wire · **impact:** user-visible (CORS-proxy users) ·
  **strength:** 3
- **evidence:** pinned mounts `app.use('/proxy/:url(*)', corsProxyMiddleware | 404 message)`
  (`../SillyTavern/src/server-main.js:257-265`); `internal/server/routes_registry.go:46-101` has no proxy row and
  the only production `/proxy/` literal in the tree is the CSRF exemption `internal/server/csrf_session.go:192`;
  the repository's own route inventory names it (`docs/api-inventory.md:413`).
- **reproducer:** NONE.
- **reproducerPlan:** decide the owning lane; if implemented, gate it with a pinned capture of the disabled
  branch (404 + message) and the enabled branch against a controlled peer.
- **counterargument:** this audit owns the dispatch composition, not provider routes; the Lead should assign it,
  and an unimplemented route must answer a distinguishable status (AGENTS rule 17).

### A-H14 — SSO auto-login is unimplemented, declared, and warned about
- **classification:** `intentional-parity` (declared gap) · **surface:** browser-wire · **impact:** user-visible
  for SSO operators · **strength:** 3
- **evidence:** pinned `tryAutoLogin` supports Authelia/Authentik (`../SillyTavern/src/users.js:751-775,799-817`);
  Go has no such path (the only `sso.` mentions are the warning rules), and `sso.autheliaAuth` /
  `sso.authentikAuth` print an explicit "does NOT implement SSO auto-login … has no effect" warning
  (`internal/commandline/unimplemented_config.go:116-124`). AGENTS rule 18 is therefore satisfied; this row
  exists so the request-path graph's browser entry points are complete.

---

## 8. Questions this lane could not decide

1. **A-H1 needs one pinned recording.** The account/settings family has no non-JSON/empty/oversize body
   fixture. Who records it (`tools/probe-*` + a fixture) and which lane owns the follow-up? The same probe
   should settle the 413/415 status bodies, which are finalhandler pages whose bodies embed a V8 stack and must
   therefore be recorded as `shape`.
2. **A-H2's configuration reachability.** Is a falsy `cors.origin` (`null`/`false`/`""`) a configuration the
   product intends to support? Pinned's default is the string `"null"`; the answer decides whether A-H2 is a
   defect or a documented non-configuration.
3. **A-H4 needs a pinned panic probe** (headers only). No packaged or unit gate boots a panic route on pinned;
   the recorded browser differentials do not exercise a 500-from-panic.
4. **A-H5's contract status.** Is `disableCsrfProtection` + single-user mode a supported combination? Pinned's
   login route works there; GoTavern's 500 is either a gap or a deliberate narrowing nobody recorded.
5. **A-H9 needs a byte-level check of the two writers' outputs** for escaped records; this audit could not
   decide whether any real writer produces a value whose bytes differ from `JSON.stringify`.
6. **Ownership of A-H13 (`/proxy`) and A-H14 (SSO)** — not this lane's implementation scope.
7. **The middleware order has no single dedicated gate.** Ordering evidence is per-feature
   (`internal/server/access_log_test.go:212` for one position; `cache_buster_test.go:212` for another). A
   table test that asserts the full chain order would make future refactors of `http.go:544-627` fail loudly;
   that gate belongs to Lane E's inventory.
8. **Nothing in this report is a run.** No `go test`, build, pinned boot or browser ran here (M0 hard rules);
   every `probe` field marked `gap` needs a Lane E/C runner, and every "measured" figure cited above is quoted
   from the source comment that recorded it (`accounts.go:240-246`, `settings_cache.go:5-10`), not re-measured.
