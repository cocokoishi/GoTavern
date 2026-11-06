# Lane C — concurrency, lifetime, locks, timers, child processes, cache discipline

**Lane:** C (alpha.16 M0, read-only). **Contract:** [`docs/alpha16/README.md`](../README.md).
**Tree read:** `c8472c1` (`lane/alpha16-program`, 2026-11-05).
The only delta between this commit and the program base `c256f21` is `docs/alpha16/**` and
`tools/alpha16-graph/**`; no product file differs, so every product `file:line` below is also valid at
the base. **Product code was not modified** by this lane; the only files written are this document and
[`fragments/c.json`](fragments/c.json).

**Scope of this lane.** Every mutex, package-level mutable store, goroutine, timer, child process and
cache the runtime owns: who owns it, what it guards, whether it is request-scoped or detached, what
bounds its waits, what shutdown does to it, and whether one user's work blocks another's. Cache
discipline is stated in `GOAL.md` §15.3 terms (key, value, owner, lifetime, capacity, eviction,
invalidation, external modification, concurrency, rebuild, fallback, measured benefit).

**Method.** Two passes, as README §1 rule 7 requires:

1. **Mechanical pass** over `docs/alpha16/source-graph.json` (603 files, 270 non-test production files
   under `internal/` + `cmd/`): its `globals[]` index (package-level state, with type text) and its
   `facts[]` (goroutines, timers, exec, context, sleeps, lock/atomic call sites). The graph is a
   **floor, not a census** — see §7.2 — so every number below was recomputed with the stated grep and
   reconciled against the graph.
2. **Deep pass** over the files M0 names plus every file that owns process-wide state: settings save
   and cache, accounts and its cache, card cache, cache buster, chat summary, data maid, panic boundary,
   extension Git/fs/static, backends `/process` (which is prompt post-processing, not a child process),
   the SD provider goroutines, NanoGPT's two goroutines, Horde cache, tokenizers, access log, basic
   auth, host whitelist, lock acquisition, startup settings backup / atomic replace / character disk
   cache, `internal/app` (server, heartbeat, startup trace), `cmd/gotavern/**`, `internal/outbound`,
   `internal/faultinject`, and the tests that claim this domain (`server_soak_test.go`,
   `data_safety_concurrency_test.go`, the cache tests, `settings_save_test.go`), plus the CI race job.

**Oracle use.** Where a behaviour might be a divergence, the pinned checkout `../SillyTavern` was read
at the pin. Several naive findings died against the oracle (settings-save serialization, Git timeout
kill semantics, detached poll loops); they are recorded below as `intentional-parity` with the pinned
citation, because a false finding is worse than a missing one.

---

## 1. Primitive census (computed, not prose)

Scope **R** = `git ls-files '*.go'` restricted to paths beginning `internal/` or `cmd/` and **not**
ending `_test.go` — **270 files** (`internal/server` 187, `internal/startup` 31, `internal/app` 11,
`internal/commandline` 8, `internal/tokenizers` 8, `internal/outbound` 5, `cmd/gotavern` 3, rest small).
Scope **T** = the same paths ending `_test.go` — **279 files**. (Whole tree: 603 Go files = 270 + 279 +
54 under `tests/`, `tools/`, `upstream/`; the graph's "production" count of 296 includes those 54
non-test helper files.)

Counts are **line matches** (`[regex]::Matches` per file, summed). Each row states the exact pattern;
the reproduction commands are in §8. A line that both declares and uses a primitive counts once.

| Primitive | Pattern | Scope R | Scope T |
|---|---|---|---|
| `sync.Mutex` | `\bsync\.Mutex\b` | **21 / 15 files** | 22 / 16 |
| `sync.RWMutex` | `\bsync\.RWMutex\b` | **0** | 0 |
| `sync.Once` | `\bsync\.Once\b` | **2 / 2 files** | 3 / 3 |
| `sync.WaitGroup` | `\bsync\.WaitGroup\b` | **1 / 1 file** | 15 / 6 |
| `sync.Map` | `\bsync\.Map\b` | **0** | 0 |
| `sync.Cond` | `\bsync\.Cond\b` | **0** | 0 |
| `sync.Pool` | `\bsync\.Pool\b` | **1 / 1 file** | 0 |
| `atomic.*` (code) | `atomic\.` | **9 / 7 files** (11 line matches, 2 are prose comments) | 42 / 11 |
| `go` statement | `(?m)^\s*go (func\(|[A-Za-z_])` | **12 / 10 files** | 47 / 28 |
| `time.AfterFunc` | `time\.AfterFunc\(` | **1 / 1 file** | 0 |
| `time.NewTicker` | `time\.(NewTicker|Tick)\(` | **1 / 1 file** | 0 |
| `time.NewTimer` | `time\.NewTimer\(` | **5 / 5 files** | 1 / 1 |
| `exec.Command`/`CommandContext` | `\bexec\.Command` | **3 / 2 files** | 9 / 6 |
| `context.Background()` | `context\.Background\(\)` | **20 / 12 files** | 95 / 30 |
| `signal.Notify` | `signal\.Notify\(` | **1 / 1 file** | 0 |
| package-level `sync.*` stores | graph `globals[].recv` | **8** | n/a |
| package-level `atomic.*` stores | graph `globals[].recv` | **6** | n/a |
| package-level `var` declarations | graph `globals` | **245** (of which 224 have an implicit type) | n/a |
| struct fields of a sync type | graph `facts[kind=sync-field]` | **14** (13 `Mutex`, 1 `Once`) | n/a |
| files carrying >=1 lock/goroutine/timer/child site | union of the five lock/goroutine/timer/child patterns (not the atomic/context rows) | **31** | n/a |
| child-process families | enumerated, §2.5 | **2** (Git inside the server; the browser opener in the CLI) | n/a |

Reconciliation notes (so the numbers are auditable, not just quoted):

- **21 `sync.Mutex` = 13 struct fields + 8 package-level.** The 8 package-level ones are
  `lockacquire.go:43`, `outbound/transport.go:74`, `server/accounts.go:306`,
  `server/characters_card_cache.go:110`, `server/settings_cache.go:94`, `server/pollinations_chat.go:84`,
  `server/tokenizers.go:254`, plus the `sync.Mutex` **embedded in a package-level anonymous struct** at
  `server/data_maid.go:135`. The graph's `facts` records the first seven and the 13 struct fields; it
  does not descend into a package-level var's type expression, which is why the census is recomputed.
- **9 code `atomic.*` line matches**: `lockacquire.go:41`, `outbound/dnsorder.go:50`,
  `outbound/privatefilter.go:123`, `outbound/transport.go:80`, `outbound/transport.go:445`,
  `server/console.go:57`, `server/sd_generate_comfy.go:332`, `:553`, `:555`.
- **7 timer sites** = `settings_save.go:71` (`AfterFunc`), `app/heartbeat.go:53` (`NewTicker`),
  `server/google_video.go:52`, `server/openai_generate_video.go:64`, `server/horde_generation.go:552`,
  `server/sd_webui.go:870`, `server/sd_zai.go:79` (`NewTimer`).
- **`context.Background()` is not automatically a defect.** §4.3 classifies all 20 sites: 5 boot/CLI/lock
  setup calls that each carry a timeout, 5 "the caller is already gone, send the abort/cancel on a fresh
  context" sites, 7 fetch sites whose pinned counterpart does not signal-bind either, 2 Git lifecycle
  calls (request-detached in pinned too), and 1 deliberate fresh-context abort.
- **No `RWMutex`, `Map`, or `Cond` anywhere in production.** Read-heavy maps are plain `Mutex`; the
  contention argument for widening one is measured only where a test exists (none). This is a
  deliberate simplicity choice, not an oversight: every guarded critical section below is a map/field
  lookup, not a scan.

---

## 2. Concurrency map

### 2.1 Mutexes

`Order` states the nesting observed; "leaf" means no other lock is taken while it is held.

| # | Lock | Source | Owner | Guards | Order | Held across I/O? | Cancellation / shutdown |
|---|---|---|---|---|---|---|---|
| L1 | `settingsSaveMu` | `server/accounts.go:96`, used `server/settings_save.go:51-52,78-79` | `accountRuntime` (one per HTTP handler, `server/http.go:352`) | `settingsSaves` map + the entire save/backup sequence | **`settingsSaveMu` -> cross-process content flock** (`startup/settings_backup.go:76`, `content.go:409`) | **YES**: `startup.SaveSettings` (atomic write + fsync + rename + dir fsync, `startup/content.go:338-396`) and, on the timer path, `startup.BackupUserSettings` (readdir + 2 file reads + copy + chmod + retention delete) | No request context exists on the save path; timer detached; **no shutdown hook stops it** |
| L2 | `createMu` | `server/accounts.go:91` | `accountRuntime` | account creation (`server/users_create` path) | leaf | likely (creates a storage record) | request-scoped |
| L3 | `recoveryMu` | `server/accounts.go:92` | `accountRuntime` | `recoveryCodes` map | leaf | no | request-scoped |
| L4 | `resetMu` | `server/accounts.go:94` | `accountRuntime` | `resetCodes` map | leaf | no | request-scoped |
| L5 | `memoryLoginLimiter.mu` | `server/accounts.go:116` | 3 instances (`limiter`, `recoverLimiter`, `resetLimiter`, `accounts.go:159-161`) | rate-limit windows, keyed by client IP | leaf | no | none (state lives until process exit) |
| L6 | `basicAuthRuntime.mu` | `server/basic_auth.go:21` | handler | basic-auth rate-limit windows | leaf | no | none |
| L7 | `storedAccountCacheMu` | `server/accounts.go:306` | package | account-record cache | leaf | no (stat happens before the lock, `accounts.go:393-402`) | process lifetime |
| L8 | `userMetadataCacheMu` | `server/settings_cache.go:94` | package | settings-aggregation + world-list response cache | leaf | no (digest walk and body build are outside the lock, `settings_get.go:63-84`) | process lifetime |
| L9 | `characterCardCacheMu` | `server/characters_card_cache.go:110` | package | decoded-card-text cache + LRU list | leaf | no (`os.ReadFile`/PNG decode outside, `characters_card.go:271-284`) | process lifetime |
| L10 | `tokenizerSetMu` | `server/tokenizers.go:254` | package | `tokenizerSetCache` (option-key -> engine set) | leaf | no (only builds the empty set; loading happens later) | process lifetime |
| L11 | `tokenizerSet.mu` | `server/tokenizers.go:265` | per asset-root set | per-engine maps; **held across engine file reads + parse** (`tokenizers.go:312`, `:326`, `:343`) | leaf | **YES** (disk + CPU parse on first use) | process lifetime; worst case one serialized cold load per engine |
| L12 | `hordeModelsCacheType.mu` (x2) | `server/horde.go:74`, instances `:80-81` | package | 60 s TTL body caches for `/api/horde/text-models` and `.../text-workers` | leaf | no | process lifetime |
| L13 | `cacheBuster.mu` | `server/cache_buster.go:75` | per handler (`newCacheBuster`, `accounts.go:163`) | the consumed (handle, UA-hash) key set | leaf | no | process lifetime; unbounded set (parity, §2.6) |
| L14 | `dataMaidTokens` (embedded) | `server/data_maid.go:134-137` | package | token -> (handle, sanitized path list) | leaf | no (mint builds paths before the lock, `data_maid.go:145-157`) | process lifetime; replaced per handle |
| L15 | `accessLogWriter.mu` | `server/access_log.go:45`, lock `:91-97` | per handler | `knownIPs` set | leaf | no (append happens after unlock, `:120-126`) | process lifetime |
| L16 | `hostWhitelistRuntime.mu` | `server/host_whitelist.go:16`, lock `:50-53` | per handler | warned-host set, capped at 1000 (`:12`) | leaf | no | process lifetime |
| L17 | `pollinationsSeedMutex` | `server/pollinations_chat.go:84` | package | deterministic PRNG (`rand.NewSource(1)`) | leaf | no | process lifetime |
| L18 | `heartbeatWriter.mu` | `internal/app/heartbeat.go:23`, lock `:66-67,79-82` | one writer (`app/server.go:334`) | "stopped" flag + exclusion between ticker write and stop | leaf | **YES**: `atomicWriteHeartbeat` fsyncs while holding it (`heartbeat.go:127`) | **stop waits without a bound** (§4.2 U1) |
| L19 | `startupTracer.mutex` | `internal/app/startup_trace.go:32`, lock `:70,83,116` | one tracer per `Start` | trace output interleaving | leaf | only writing to the trace writer | boot only |
| L20 | `lockacquire.diagnosticsMu` | `internal/lockacquire/lockacquire.go:43`, lock `:95-97` | package | serializes startup diagnostic lines | leaf | no | boot/request |
| L21 | `outbound.clientsMu` | `internal/outbound/transport.go:74`, lock `:118-126` | package | `clients` map (`*tls.Config` -> client) | leaf | no | process lifetime |
| L22 | `sync.Pool` gzip writers | `server/compression.go:79` | package | pooled `*gzip.Writer` | pool, not a lock | no | GC-managed |
| L23 | NanoGPT `WaitGroup` | `server/nanogpt.go:147`, `:156-181` | per request | joins two provider calls | leaf | joins network I/O | bounded by `request.Context()` + transport bounds (§4.1 W9) |

Lock order is **consistent and shallow everywhere**: the only nesting is L1 -> cross-process flock, and the
flock is acquired by startup code with no path that then takes L1 (direct query: `settingsSaveMu` appears
only in `settings_save.go`). No lock is held while another lock-free path re-enters it. **No lock-order
inversion was found.**

**Locks held across disk I/O** (the M0 distinction the brief asks for) are exactly L1 and L11 (and L18
for fsync). L1 is source-proven; what it *means* for cross-user latency is §2.6, and it is **not** a
defect against the oracle.

### 2.2 Package-level mutable state

All non-test package-level state that is mutable after init, with its protection. Everything else in
the 245 package-level var declarations is an immutable table or regexp (verified by classifying each
declaration that carries `sync.`/`atomic.`/`make(`/`&`/`rand.New`).

| Store | Source | Protection |
|---|---|---|
| `storedAccountCache` | `server/accounts.go:307` | L7; bounded 256, whole-map drop (`:294`, `:328-332`) |
| `userMetadataCache`, `...BodyBytes` | `server/settings_cache.go:95-96` | L8; bounded 64 entries / 64 MiB, whole-map drop (`:84-86`, `:120-135`) |
| `characterCardCache`, `...LRU`, `...TextBytes` | `server/characters_card_cache.go:111-113` | L9; bounded 65536 / 64 MiB, LRU (`:85-86`, `:183-194`) |
| `tokenizerSetCache` | `server/tokenizers.go:255` | L10; key space is configuration-derived, not request-derived |
| `hordeModels`, `hordeWorkers` | `server/horde.go:80-81` | L12; 60 s TTL |
| `dataMaidTokens` | `server/data_maid.go:134-137` | L14; one entry per handle |
| `pollinationsSeedSource` | `server/pollinations_chat.go:85` | L17 |
| `clients` (`*tls.Config` -> client) | `internal/outbound/transport.go:75`, `:169-177` | L21; **in production only the `nil` key exists** — the only non-nil `TLSConfig` producers are tests (`git grep 'TLSConfig:'` -> 5 lines, all in test files) |
| `productionSettingsState`, `requestProxy`, `privateAddressFilterState` | `outbound/transport.go:80`, `:445`, `outbound/privatefilter.go:123` | `atomic.Value`, written at startup (`app/server.go:230-249`) |
| `wireExactOnce`/`wireExactMode` | `outbound/transport.go:65-66` | `sync.Once` |
| `bootDeadline` | `lockacquire.go:41` | `atomic.Int64`, installed/cleared around `Start` (`app/server.go:140-141`) |
| `consoleMinLevelBits` | `server/console.go:57` | `atomic.Uint64` |
| `dnsOrderCount` | `outbound/dnsorder.go:50` | `atomic.Int64`; a test-observable counter |
| `faultinject.hook` | `internal/faultinject/faultinject.go:15` | assigned only by `hook_faults.go:19-37`, which is `//go:build gotavern_faults`; **nil in every shipped binary** |
| `runningInDocker`, `hostLookup`, `copyTreeFile`, `atomicTempWrite`, `googleVideoSleep`, `openAIVideoSleep`, `sdZaiVideoSleep` | `app/server.go:418`, `outbound/dnsorder.go:44`, `server/characters_write.go:1086`, `startup/content.go:333`, `server/google_video.go:51`, `server/openai_generate_video.go:63`, `server/sd_zai.go:78` | documented test seams ("assigned only by a test"); production reads |

**Conclusion of the mechanical state sweep:** every process-wide mutable store is either guarded by a
lock/atomic, initialised once, or a documented test seam. **No unguarded production global was found** —
with the standing caveat that this host cannot run `-race` (`windows/arm64`), so this is source
inspection plus the CI gate in `.github/workflows/ci.yml:656-683` (see H8 for the gate's package list).

### 2.3 Goroutines (12 sites in 10 files)

| # | Site | Trigger | Lifetime | Cancellation | Bounded? |
|---|---|---|---|---|---|
| G1 | `internal/app/heartbeat.go:47` `go writer.run(interval)` | boot, when `heartbeatInterval > 0` (`app/server.go:333-335`) | until `stopSignal` closes | `Close` -> `heartbeat.stop` (`app/server.go:431-433`) | **stop wait unbounded** (H6) |
| G2 | `internal/app/server.go:464` `go Serve(...)` per listener | boot | until Shutdown/listener close | `Shutdown(ctx)` (`server.go:435-439`) | 10 s ctx from `cmd/gotavern/main.go:360` / `:255` |
| G3 | `cmd/gotavern/main.go:363` `go closed <- running.Close(ctx)` | first signal | short | ctx + second-signal branch | 10 s ctx; second signal returns without waiting (`main.go:367-373`) |
| G4 | `cmd/gotavern/browser.go:63` browser-opener goroutine (launch at `:54-70`) | CLI browser launch | process launch only | none needed | launch is fire-and-forget (pinned `postSetupTasks` does the same) |
| G5 | `server/nanogpt.go:157,168` two provider calls | `/api/nanogpt/credits` | joined by `WaitGroup` at `:181` | `request.Context()` (`:159`, via `backendsGet(request,...)`) | yes: transport header timeout 120 s (`outbound/transport.go:59`) + client cancel |
| G6 | `server/sd_generate_comfy.go:335` Comfy interrupt watcher | `/api/sd/comfy/generate` | until `request.Context().Done()` or handler return (`finished`) | request ctx | yes |
| G7 | `server/sd_generate_comfy.go:558` RunPod cancel watcher | `/api/sd/comfy/runpod/generate` | same shape | request ctx | yes |
| G8 | `server/sd_generate_wave3.go:198` A1111 interrupt watcher | `/api/sd/generate` | until request ctx done | request ctx | yes (interrupt POST has an outbound timeout) |
| G9 | `server/sd_webui.go:111` two list fetches | `/api/sd/upscalers` | until both done (`:117-119`) | `request.Context()` (`:112`) | yes |
| G10 | `server/backends_textgen_generate.go:438` Kobold abort watcher | text-completion generate, `api_type == koboldcpp` | until request ctx done / handler return | request ctx / `finished` | yes |
| G11 | `internal/outbound/raw.go:172` per-connection closer | **only** when `GOTAVERN_OUTBOUND_WIRE_EXACT=1` (`transport.go:132-141`) | until `ctx.Done()` or socket close | ctx | ctx-dependent; **test/probe role only, not the production client (AGENTS rule 30)** |
| G12 | `server/sd_generate_comfy.go` handler itself polls a `for {}` loop | Comfy/RunPod generate | request handler goroutine | none (polls use `context.Background()`) | **no attempt bound — intentional parity, H9** |

No goroutine is started per request without an owner/lifetime: every watcher goroutine exits on request
cancellation or handler return, and the two that can outlive a client disconnect are provider polls whose
pinned counterpart has exactly the same property (H9). The soak gate
(`server_soak_test.go:43-210`) drives 200 real requests through the wiring and asserts the goroutine
count returns to baseline +8 and heap growth stays under 4 MiB — it is a **leak** gate, not a race gate,
and it does not cover the signal/shutdown path.

### 2.4 Timers (7 sites)

| # | Site | Kind | Purpose | Stopped? |
|---|---|---|---|---|
| T1 | `server/settings_save.go:71` | `time.AfterFunc(10 min)` | pinned autosave trailing edge (`AUTOSAVE_INTERVAL` = 10 min, pinned `src/endpoints/settings.js:23`) | **No production stop site.** Only `settings_save_test.go:231` stops one. No `accountRuntime` shutdown hook exists. |
| T2 | `internal/app/heartbeat.go:53` | `time.NewTicker(interval)` | pinned `heartbeat.json` writer | yes, `ticker.Stop()` on `stopSignal` (`:54`) |
| T3-T7 | `server/google_video.go:52`, `openai_generate_video.go:64`, `horde_generation.go:552`, `sd_webui.go:870`, `sd_zai.go:79` | `time.NewTimer(d)` | context-aware poll delays | each `defer timer.Stop()`; the delay helper returns early on `ctx.Done()` |

No `time.Tick` anywhere (it cannot be stopped). No timer outlives its owner except T1, which is the one
detached timer in the product and is analysed in H5.

### 2.5 Child processes

`git grep 'exec\.Command'` over scope R returns exactly **3 call sites in 2 files**; the whole-tree count
is 9/6 (the rest are tests and `tools/` helpers). The browser-opener `exec.Command` is in the CLI and is
fire-and-forget (`cmd/gotavern/browser.go:54`); it does not belong to the server process.

| Family | Site | Bound | Cancellation | Concurrency |
|---|---|---|---|---|
| `git -C <ext> ...` | `server/extensions_git.go:56-73` (`runPinnedGit`) | 5 min per command: `context.WithTimeout(context.Background(), pinnedGitBlockTimeout)`, `pinnedGitBlockTimeout = 5*time.Minute` (`:39-40`) | **detached from the request** — a cancelled client leaves Git running to completion or the 5 min bound | none: no per-repo queue/semaphore |
| `git <clone>` in explicit dir | `server/extensions_git.go:77-95` | same 5 min | same | same |
| browser opener | `cmd/gotavern/browser.go:54` | none (fire-and-forget) | n/a | CLI only |

The child is **killed** when the 5 min bound expires (`exec.CommandContext` semantics: `command.Run()`
waits, and the context cancellation kills the process). That is parity with the pinned client, not a
divergence: simple-git's `timeout.block` installs a timer that calls `context.kill(...)` on the spawned
child (pinned `node_modules/simple-git/dist/cjs/index.js:1585-1613`, called from
`node_modules/simple-git/dist/cjs/index.js:4809`), and pinned passes `{ timeout: { block: 5 * 60 * 1000 } }`
(pinned `src/endpoints/extensions.js:17`). The candidate hypothesis "Go kills the Git child at the
timeout while pinned does not" is **falsified by the oracle source** and is not a finding.

Call-site depth per route (all sequential, each command bounded separately at 5 min, so a route's
worst case is the sum): `/version` up to 8 Git commands (`extensions_git.go:318-372`, including the
extra `fetch` through `checkPinnedRepoIsUpToDate` at `:203-231`); `/update` up to 9 (`:383-456`);
`/branches` 6, or 7 when the repo is shallow (`:458-528`); `/switch` up to 3 (`:530-609`); `/install`
1 clone (`:629-720`). No per-repo serialization
exists in either implementation, so two concurrent updates of the same extension can collide on Git's
own `index.lock` and one answers 500 — pinned has the same property (simple-git spawns per call with no
queue), so this is `intentional-parity`, not a defect, and it is recorded rather than "fixed".

`internal/server/backends_process.go` is **not** a child-process file despite its name: it implements
`/api/backends/chat-completions/bias` and `/process` (prompt conversion). Direct query for
`exec.`/`sync.`/`go ` in it: zero matches.

Negative findings, direct queries over the whole files: `server/extensions_fs.go` and
`server/extensions_static.go` contain **no** `sync.*`, `go ` statement, timer, or `exec.` (pattern
`sync\.|go func|go [A-Za-z_]|time\.(AfterFunc|NewTicker|NewTimer)|exec\.` -> 0 in both). They are
synchronous request-scoped filesystem/static handlers with no in-process serialization; concurrent
mutation of extension trees is lane B/D territory.

### 2.6 Cross-user contention — the specific hypothesis

> **Hypothesis:** does one user's settings save block another user's?

**Source answer: yes, in GoTavern — and yes, more broadly, in pinned.** The mechanism is
`settingsSaveMu`, a single mutex on the process-wide `accountRuntime` (`server/accounts.go:96`), held for
the whole save (`server/settings_save.go:51-75`) including disk persistence and the backup copy. But the
oracle makes the comparison decisive:

- pinned's save route is **synchronous on the Node event loop**: `writeFileAtomicSync(...)`
  (pinned `src/endpoints/settings.js:206-216`) and the autosave it triggers is `backupUserSettings` with
  `fs.copyFileSync` + `readdirSync` + `statSync` + `unlinkSync` (pinned `src/endpoints/settings.js:118-157`,
  `:164-201`), so **every** concurrent request in the process — other users' saves *and* reads *and*
  provider calls — waits behind one user's save.
- GoTavern blocks **only other settings saves**; every other route runs concurrently.

Therefore "one user's save blocks another user's save" is `intentional-parity` and in fact **strictly
narrower** than pinned. The one Go-only *addition* is the cross-process content lock: `SaveSettings`
acquires a data-root-keyed flock (`startup/settings_backup.go:61-99` -> `lockSettingsUser`
`:131-150` -> `startup/content.go:398-414`), bounded at `lockacquire.DefaultPerLock = 10 s`
(`lockacquire.go:31`), *while holding* `settingsSaveMu`. In a second GoTavern process on the same data
root, every user's save can queue behind up to 10 s of lock wait. Pinned has no cross-process lock at
all (alpha.15 audit row B-07), so this latency is a **deliberate data-safety addition**, not parity:
`verified-risk` (H4), with the counterargument that B-07 chose lock + atomic replace precisely because
pinned's last-writer-wins is unsafe.

What is **not** established by source: how long a cross-user save actually waits in a real 8-user
scenario (H3). The existing tests do not cover it: `settings_save_test.go` has two tests, both single
handle (`:49`, `:202`), and `data_safety_concurrency_test.go` races writers against **one** user tree.
That is `untested-hypothesis` by the M0 rule, with the reproducer named in H3.

---

## 3. Cache discipline (`GOAL.md` §15.3)

§15.3 requires every cache to state: key, value, owner, lifetime, capacity, eviction, invalidation,
external-modification handling, concurrency model, rebuild path, failure fallback, measured benefit. The
reference design is the account cache's identity key (path + mtime + size, bounded, cloned values, no
TTL). Rows 1-7 are response/data caches; rows 8-13 are process-wide state that is not a cache and is
listed so "every cache" is not read as "only the maps called cache".

### 3.1 Caches

| # | Cache | Key | Value | Owner / lifetime | Capacity / eviction | Invalidation; external mod | Concurrency | Rebuild / fallback | Measured benefit |
|---|---|---|---|---|---|---|---|---|---|
| C1 | stored account record | record path + mtime + size + change stamp (Unix ctime; Windows boundary) `accounts.go:310-321`, `:248-294` | cloned `storedAccount` + `found` | package, process-local; until identity change, map drop, restart | 256 entries, whole-map drop (`:294,328-332`) | stat mismatch on every read; ctime catches same-size same-mtime replacement on Unix (`accounts.go:274-293`, `record_change_windows.go:39`) | mutex; clone per caller (`:350-357`, `:402,428`) | ordinary file read + bounded fsretry; errors unchanged | 40.4% cumulative CPU on the auth path was `loadStoredAccount`; measured in `accounts.go:240-246` |
| C2 | settings aggregation response | kind `settings-get` + dataRoot + handle; identity = sha256 over settings.json + 4 preset dirs + worlds names + 7 content dirs (`settings_cache.go:14-17,233-254`) | serialized HTTP body, copied on read | package, process-local; no TTL | 64 entries / 64 MiB, whole-map drop (`:30-35,84-86,120-135`) | identity re-hashed every request, **before and after** build (`settings_get.go:64,82-83`); product writes move mtime via `atomicReplace` | one mutex; no lock during read/build | original uncached route; 500 preserved | ~5.9 ms / 4.6 MB (220 docs) and ~30 ms / 23.6 MB (1100 docs) -> stat+hash+copy (comment `settings_cache.go:4-10`, CI run 41758175427) |
| C3 | world-info list response | kind `worldinfo-list` + dataRoot + handle; identity = names + identities of `*.json` (`:289-315`) | serialized listing body | as C2 | shares C2's bounds | as C2 (`worldinfo.go:230-248`) | as C2 | as C2 | ~22-64 ms / 27-50 MB (50-1000 files) -> stat+hash (same comment) |
| C4 | decoded character-card text | absolute card path; identity = type+size+mtime (`characters_card_cache.go:22-25,98-100`) | decoded `chara`/`ccv3` text as immutable string | package, process-local; until identity change / LRU eviction / restart | 65536 entries and 64 MiB, **LRU one-at-a-time** (`:37-41,85-86,183-194`) | identity re-stat every request (`characters_card.go:271`); no post-read recheck (`:47-61`) | one mutex; **one critical section** fixed after the first Linux `-race` run found the field read-after-unlock (`:129-147`); I/O outside | uncached `os.ReadFile` + PNG chunk walk; errors unchanged, nothing stored | alpha.15 F-03: 10k-card repeat -17.4% time / -20.4% B/op, large-card-text -42.3% / -71.3%, cold first request +21% (`docs/audit-v0.1.0-alpha.15.md` F-03) |
| C5 | Horde model list body | `models` (separate global) | serialized provider body | package, 60 s TTL (`horde.go:52,71-99`) | one slot; overwritten, TTL expiry only | TTL, then refetch (`:145-179`) | mutex | upstream fetch | one provider call per 60 s per route; pinned `new Cache(60*1000)` parity |
| C6 | Horde workers body | `workers` (separate global) | same | same | same | same | same | same | same (`:225-275`) |
| C7 | tokenizer engine set + per-engine maps | (asset root, cache dir, allowDownloads) (`tokenizers.go:245-256`); engines keyed by model name (`:260-269`) | loaded `SentencePiece`/`TiktokenSet`/`HF` | package, process-local; no eviction | key space is configuration-derived (normally 1); per-engine maps bounded by the model list (`tokenizers.go:45-52`) | none: the assets are vendored/immutable in a release; a changed file is picked up only by restart | two mutexes; per-engine load is serialized across all users (L11) | re-read + parse on miss; failure returns the uncached error | **not measured** (no before/after bench; comment `tokenizers.go:23-24` says the disk-cache switch is not projected) |
| C8 | character disk cache (`<dataRoot>/_cache/characters`) | pinned node-persist filenames derived from `(filePath, mtimeMs)` (`startup/character_disk_cache.go:61`) | derived records (pinned's card cache) | **verify/removal pass only** — `VerifyCharacterDiskCache` creates the dir and deletes misaddressed records (`:11-93`); **no Go store path exists** (direct query: `_cache` writes in `internal/server` -> only tokenizers) | pinned's own | pinned's own; Go reproduces the verify pass (test `character_disk_cache_test.go:43`) | boot only | not implemented (matches `GOAL.md:465-469`) | none (no consumer) |
| C9 | outbound HTTP client cache | `*tls.Config` pointer (`outbound/transport.go:68-75,169-177`) | `*http.Client` | package; rebuilt on `ConfigureProductionTransport` (`:102-126`) | production has exactly one entry (`nil` key); tests may add | config change calls `resetProductionClients`, closing idle sockets | mutex | build a client | keep-alive reuse (D5); no growth vector in production because only tests pass a TLS config |

**Residual staleness window (applies to C2, C3, C4, and C1 on Windows).** Identity is mtime+size, so an
**external** in-place rewrite that preserves size *and* backdates mtime is indistinguishable from no
change. C1 closes this on Unix with the inode change time (`accounts.go:274-293`) at no extra syscall and
has a red-then-green test (`accounts_cache_test.go:174`). C2/C3/C4 do **not** include a change stamp even
though they already stat every input, so the window is open there; both files state it as a recorded
residual and pin the behaviour with a test (`settings_cache.go:61-66`,
`characters_card_cache.go:67-73`, `settings_cache_test.go:266`, `characters_card_cache_test.go`
`...DocumentedResidual`). No in-product writer can produce the condition: every product write replaces
the file atomically, which moves mtime (and on Unix also ctime). See H11.

### 3.2 Process-wide state that is not a cache

| # | State | Source | Lifetime / bound | Invalidation | Concurrency | Classification |
|---|---|---|---|---|---|---|
| S1 | cache-buster consumed keys | `cache_buster.go:75-77,120-127` | **unbounded**, one per (handle, sha256(user-agent)) | none by design ("one attempt per key per process") | mutex | `intentional-parity`: pinned `#keys = new Set()` (`src/middleware/cacheBuster.js:13,78-82`) is unbounded identically |
| S2 | access-log known IPs | `access_log.go:46,91-97` | **unbounded**, one per client IP | none | mutex | `intentional-parity`: pinned `knownIPs = new Set()` (`src/middleware/accessLogWriter.js:8,38-40`) |
| S3 | host-whitelist warned hosts | `host_whitelist.go:12,17,52` | **bounded at 1000** | none | mutex | `intentional-parity`: pinned `maxKnownHosts = 1000` (`src/middleware/hostWhitelist.js:5-6,27`) |
| S4 | data-maid tokens | `data_maid.go:125-179` | one entry per handle, replaced on each `/report`; no TTL | replaced per handle, deleted on finalize | mutex | `intentional-parity`: pinned `static TOKENS = new Map()`, same replace/delete (`src/endpoints/data-maid.js:92-94,653-666,703-707`) |
| S5 | login/recover/reset rate windows | `accounts.go:115-120,171-200` | **unbounded per distinct key**; no sweeper | only when the same key is seen after expiry, or `clear` on success | mutex | **`verified-risk` (H1)**: pinned's `RateLimiterMemory` deletes each key with a per-key `setTimeout` (`node_modules/rate-limiter-flexible/lib/component/MemoryStorage/MemoryStorage.js:36-45`) |
| S6 | basic-auth rate windows | `basic_auth.go:20-24,57-98` | as S5 | as S5 | mutex | **`verified-risk` (H1)**, same oracle evidence (`src/middleware/basicAuth.js:18`, `node_modules/rate-limiter-flexible/.../MemoryStorage.js:36-45`) |
| S7 | recovery/reset codes | `accounts.go:93,95`, `:1415-1528` | one entry per handle (bounded by user count); expired entries deleted lazily on access | on use/expiry/access | mutex | low risk: key space is users, not attacker volume |
| S8 | settings-save throttle state | `settings_save.go:15-18`, `accounts.go:97` | one entry per handle for the 10-minute window | deleted by the trailing timer flush (`settings_save.go:86`) | mutex L1 | `intentional-parity` (pinned's lodash throttle, `src/endpoints/settings.js:36-46`) |

---

## 4. Boot -> serve -> shutdown lifecycle, every wait and its bound

### 4.1 Waits and their bounds

| # | Wait | Source | Bound | Named failure |
|---|---|---|---|---|
| W1 | boot-path flock acquisition (config -> storage -> content, nested) | `lockacquire.go:103-135`; budget installed `app/server.go:138-141` | per-lock 10 s, whole boot 30 s (`lockacquire.go:31-33`), and the budget is **shared** so nested waits cannot multiply | `*BusyError` names purpose/path/waited (`lockacquire.go:72-85`) |
| W2 | legacy user-data migration delay | `startup/user_data_migration.go:12,40` | 10 s, pinned's own wait; announced before it is spent (`app/server.go:174-186`) | n/a (pinned behaviour) |
| W3 | Docker hostname lookup | `app/server.go:372,385-397` | 2 s per name, worst case 2x (`:363-372`) | silent by design (pinned warns; recorded divergence) |
| W4 | listener bind | `app/server.go:514-540` | OS-bounded; `config.Listen` has no context (`:539`) | startup error names the family (`server.go:472-496`) |
| W5 | heartbeat first write during boot | `app/heartbeat.go:40-49` (write before goroutine) | **none** (one small atomic write; a hung filesystem stalls boot) | none |
| W6 | boot's copy/migration/write work | `startup/**` | no per-operation timeout; the boot budget W1 does not bound file I/O | errors are returned with path/context |
| W7 | HTTP request handling | `app/server.go:103-118` | `ReadHeaderTimeout` 60 s, `IdleTimeout` 5 s, `MaxHeaderBytes` 16 KiB (pinned Node defaults); **no** ReadTimeout/WriteTimeout by decision (`:93-102`) | transport errors |
| W8 | provider calls | per call site: e.g. `extensions_git.go:57,78` 5 min; `sdComfySend` `sdComfyRequestTimeout`; `searchFetch` passes `0` and relies on transport bounds (`outbound/transport.go:56-62`: connect 30 s, TLS 15 s, response header 120 s) | client cancel for most; **detached** where pinned detaches | causal transport errors named DNS/connect/TLS/timeout/status (`docs/network-egress.md`) |
| W9 | NanoGPT `WaitGroup.Wait` | `server/nanogpt.go:181` | request ctx + 120 s header bound | 500 |
| W10 | SD upscaler join `<-done` | `server/sd_webui.go:117-119` | request ctx + transport bounds | 500 |
| W11 | settings-save cross-process flock while holding L1 | `settings_save.go:51` -> `startup/settings_backup.go:76` -> `lockacquire.go:114-131` | 10 s per acquisition, `*BusyError` | `BusyError` surfaced as a 500 from the save route (`settings_save.go:43-46`) |
| W12 | Comfy/RunPod poll loop | `sd_generate_comfy.go:391-419`, `:618+` | **no attempt bound** — intentional parity with pinned `while (true)` (`src/endpoints/stable-diffusion.js:590-602`, `:710`) | none (pinned has none) |
| W13 | graceful shutdown | `app/server.go:429-446` via `cmd/gotavern/main.go:254-258,358-374` | 10 s ctx for `http.Server.Shutdown`; second signal skips the wait for `Close` but not the deferred one | `context.DeadlineExceeded` joined into `Close`'s error |
| W14 | heartbeat stop | `app/heartbeat.go:77-85` called `app/server.go:431-433` | **NONE** — see U1 | none |

### 4.2 Waits with no bound, named

- **U1 (the only unbounded wait in the normal lifecycle).** `heartbeatWriter.stop()` takes the writer
  mutex and then waits on `<-writer.done` (`internal/app/heartbeat.go:77-85`). The ticker goroutine may be
  inside `write()` -> `atomicWriteHeartbeat` -> `temporary.Sync()` (`:65-75`, `:127`, `:134-140`), which
  has no timeout. `RunningServer.Close` calls `heartbeat.stop()` **before** it uses the caller's context
  (`app/server.go:430-433`), so the 10 s ctx handed to `Close` does not bound this wait. A stalled
  filesystem therefore hangs graceful shutdown with no error and no deadline. AGENTS rule 24 ("no
  unbounded wait; every wait has a named error and a bound") is about startup, but the same invariant is
  what M0 asks to name here. Reproducer plan in H6.
- **U2 (detached, not shutdown).** The trailing settings-backup timer waits on `settingsSaveMu` with no
  timeout (`settings_save.go:77-80`). It is a timer goroutine, not a shutdown path; a save that never
  returns (e.g. blocked in fsync) leaves that goroutine parked. No data is lost by the wait itself.
- **U3 (intentional, provider-owned).** Comfy/RunPod polls (W12). The loop counts attempts with no bound;
  each poll is individually bounded by the outbound client, and the client-disconnect path only sends an
  interrupt/cancel POST, it does not stop the loop. The pinned loop is the same (H9).

### 4.3 Detached `context.Background()` sites (20 in scope R)

Classified, because "background context in a request path" is not automatically a defect:

| Class | Sites | Why |
|---|---|---|
| Boot/CLI bounded setup | `cmd/gotavern/main.go:255,360`, `app/server.go:388,539`, `lockacquire.go:121` | timeouts are attached (`10 s`, `2 s`, `Bound()`); `Listen` has no context by API |
| Caller-gone abort/cancel POSTs (pinned sends them on a fresh fetch) | `server/sd_generate_comfy.go:345,568`; `server/sd_generate_wave3.go:200`; `server/backends_textgen_generate.go:449`; `server/backends_kobold_deferred.go:86` | the request ctx is already cancelled — that is how the disconnect is known; pinned does not signal-bind these either |
| Pinned fetches are not signal-bound | `server/sd_generate_comfy.go:148` (`sdComfyDetached`), `server/google_video.go:166`, `server/openai_generate_video.go:138`, `server/sd_zai.go:136,187,292,348` | pinned checks its controller only BETWEEN attempts (`google_video.go:161-165` comment); video loops are attempt-bounded with explicit `callerGone()` checks (`google_video.go:199`, `max 30` at `:42`; OpenAI video same shape `:137-158`) |
| Git lifecycle | `server/extensions_git.go:57,78` | request-detached in pinned too (simple-git spawn is not tied to the HTTP request); bounded 5 min (H5) |
| Deliberate abort on a fresh context | `server/horde_generation.go:516` | 30 s ctx around a DELETE when the client left |

**No `context.Background()` site was found that changes a response the caller can observe compared with
pinned.** The two candidate classes are parity, and both are documented at the call site.

### 4.4 Shutdown sequence (what actually happens)

1. SIGINT/SIGTERM -> `signal.Notify` (`cmd/gotavern/main.go:333-334`) -> `shutdownAfterSignal`
   (`:358`): prints the notice, creates a **10 s** ctx (`:360`), starts `running.Close(ctx)` in a
   goroutine (`:363`), and waits for it or for a second signal (`:364-373`).
2. Second signal -> closes **listeners only** (`:369-371`) and returns `forcedShutdown` (exit 130,
   `cli.go:377-384`). This does **not** abort in-flight requests; `listener.Close()` only stops accepting
   and closes idle sockets.
3. `RunningServer.Close` (`app/server.go:429-446`): heartbeat `stop()` (**U1, unbounded**), then
   `http.Server.Shutdown(ctx)` newest-listener-first (10 s ctx), then closes listeners and joins errors.
   It may be called **twice concurrently** in the signal path: the goroutine at `:363` and the deferred
   `running.Close` at `main.go:254-258`. Both paths are safe by construction today (`Shutdown`,
   `listener.Close`, `heartbeat.stop` are idempotent) but are **not exercised by any test and not in the
   `-race` package list** (H8).
4. Not stopped/joined: the settings-backup timers (T1). No `accountRuntime` shutdown hook exists
   (`git grep 'timer.Stop()'` in production: only provider poll helpers; `settingsSaves` is touched only
   in `settings_save.go` + its test). A pending trailing backup is therefore lost on exit; pinned's
   SIGINT handler is `process.exit()` with no timer flush (`src/server-main.js:318-331`), so this is
   `intentional-parity` (H5).
5. In-flight Git children: `CommandContext` cancels only when the handler returns; if shutdown's 10 s
   expires first, the process exits and the child is orphaned — pinned's `process.exit()` orphans a
   simple-git child the same way. Parity.
6. Detached provider poll loops: `http.Server.Shutdown` waits for the *handler* (the loop runs in the
   handler), so a stuck Comfy job can consume the full 10 s shutdown budget and then be abandoned at
   process exit. Pinned's event loop has the same promise chain running; parity (H9).

---

## 5. Hypotheses (each carries one classification)

Classification vocabulary is README §1 rule 5. `strength` is README §3's 1-5.

| ID | Title | Class | Surface | Impact | Strength |
|---|---|---|---|---|---|
| C-H1 | Rate-limit windows grow without eviction; pinned deletes each key on a timeout | **verified-risk** | performance (`/api/users/login`, recovery, reset, basic auth) | resource growth under distinct-key traffic | 4 |
| C-H2 | A settings save is process-wide serialized and holds the mutex across disk I/O + backup — but pinned serializes *more* (event loop), so this is parity-or-better | **intentional-parity** | performance | concurrency | 4 |
| C-H3 | Cross-user save latency under contention is unmeasured; no test drives two handles concurrently | **untested-hypothesis** | performance | concurrency | 3 |
| C-H4 | `settingsSaveMu` is held while acquiring a data-root-wide flock bounded at 10 s, so a second process can stall every user's save | **verified-risk** | performance / data-safety trade-off | concurrency | 3 |
| C-H5 | The trailing backup timer is detached and never stopped/awaited on shutdown; a pending snapshot is lost — same as pinned's `process.exit()` | **intentional-parity** | persisted-bytes | data-safety (minor) | 3 |
| C-H6 | Graceful shutdown has an unbounded wait: `heartbeat.stop` waits on the writer mutex/`done` outside the ctx | **verified-risk** | startup-state (shutdown) | hang | 4 |
| C-H7 | Second Ctrl+C promises "in-flight requests are aborted" but only closes listeners; the deferred `Close` can still wait 10 s | **verified-risk** | CLI/startup-state | user-visible hang | 3 |
| C-H8 | The `-race` job omits `internal/app` (heartbeat + `RunningServer.Close`) and `internal/lockacquire`; the real signal path has no test | **verified-risk** | process/gate | concurrency coverage | 3 |
| C-H9 | Comfy/RunPod poll loops have no attempt bound and keep the handler goroutine after the client leaves | **intentional-parity** | provider-wire / performance | resource retention | 3 |
| C-H10 | Two unbounded process-wide sets (cache-buster keys, access-log IPs) are reproduced from pinned; host-whitelist's cap is also parity | **intentional-parity** | performance | inherited property | 3 |
| C-H11 | The same-size+same-mtime residual was closed for the account cache with ctime on Unix but left open in the two response caches, although they already stat every input | **verified-risk** | browser-wire (stale body) | staleness | 2 |
| C-H12 | `internal/outbound` wire-exact path starts one goroutine per connection released only by ctx/socket; it is a test/probe client, never the production transport | **out-of-scope** | provider-wire | test-only | 1 |

### C-H1 — Rate-limit windows are never evicted (verified-risk, strength 4)

**Evidence.** `memoryLoginLimiter` (`server/accounts.go:115-120`) stores `loginAttemptWindow` per client
IP; `consume`/`exceeded` (`:171-200`) only delete the window **when that same key is touched again after
its `resetAt`**, and `clear` (`:186-190`) deletes only the key that logged in successfully.
`basicAuthRuntime` (`server/basic_auth.go:20-24`, `:57-98`) has the identical shape (delete on success or
on re-access, never a sweep). The key is derived from the client address (`accounts.go:1529-1545`); when
`rateLimiting.preferRealIpHeader` is enabled it embeds `X-Real-IP`/`CF-Connecting-IP`/`X-Forwarded-For`
(`:1531-1543`), i.e. an attacker-controlled string, so distinct keys are cheap.

**Oracle.** Pinned uses `rate-limiter-flexible`'s `RateLimiterMemory` for all four limiters
(`src/endpoints/users-public.js:19-23`, `users-private.js:22`, `src/middleware/basicAuth.js:18`) and its
Storage deletes each key with a per-key timer: `MemoryStorage.set` does
`this._storage[key].timeoutId = setTimeout(() => delete this._storage[key], durationMs)`
(`node_modules/rate-limiter-flexible/lib/component/MemoryStorage/MemoryStorage.js:36-45`). So pinned's
state is window-bounded; GoTavern's is lifetime-bounded.

**Impact / user-visible consequence.** Memory grows with the number of distinct client keys, forever.
No measured number; the failure class is `GOAL.md` §1b "stable: no heap drift" and R5's "no unbounded
memory buffer". Authenticated success cleans one key, so the growth is driven by *failed* or
never-returning clients.

**Reproducer (cheapest failing check).** A package test: call `limiter.consume(key_i, t0)` for
10,000 distinct `key_i`, then call `limiter.exceeded(key_i, t0+window+1s)`/`consume` for **new** keys and
assert `len(runtime.entries)` returns to the number of currently active keys; today it stays 10,000.
The map is unexported, so the test lives in package `server` (already the case for these tests).
Counterargument (considered): the keys are IPs, so a real flood needs many source addresses unless
forwarded-header trust is on; and the fix is a bound/sweep, which is a behaviour change only in memory
accounting, never in the 429 shape. That is why this is a risk row, not a confirmed runtime defect.

### C-H2 — Settings-save serialization is parity-or-better (intentional-parity, strength 4)

**Evidence.** `settingsSaveMu` (`accounts.go:96`) is taken for the whole `saveSettings`
(`settings_save.go:50-75`) and the timer flush (`:77-87`); `startup.SaveSettings` writes atomically and
optionally snapshots under the same call (`startup/settings_backup.go:61-99`).

**Oracle (the part that reverses the naive finding).** Pinned's `/save` is synchronous:
`writeFileAtomicSync(...)` then `triggerAutoSave(handle)` (`src/endpoints/settings.js:206-216`), and the
autosave path is `backupUserSettings` -> `fs.copyFileSync` + `readdirSync` + `statSync` + `unlinkSync`
(`:118-157`, `:164-201`). All of that runs on the single Node event loop, so one user's save stalls
**every** request, not just saves. GoTavern's mutex narrows the stall to saves.

**Conclusion.** The cross-user blocking property is `intentional-parity` and narrower than pinned. This
is the decisive counterargument R2 (plan §6) must record before proposing a per-user coordinator: a
per-user design would be *less* serialized than the oracle, and any redesign must preserve the save ->
backup ordering, the duplicate-aware snapshot, and the trailing-edge timing.

**Falsifier.** A measurement where GoTavern's save queue produces a user-visible timeout (or a p99 worse
than pinned's block on the same host/load). No such measurement exists; H3 names it.

### C-H3 — Cross-user save latency is unmeasured (untested-hypothesis, strength 3)

**Evidence.** No test drives two different handles through `/api/settings/save` concurrently:
`settings_save_test.go` has two tests, both `default-user` (`:49`, `:202`);
`data_safety_concurrency_test.go` races writers at **one** user tree (`:323-388`). The mechanism (one
process-wide mutex + flock inside it) is source-proven; the user-visible consequence is not measured.

**Reproducer plan.** In-process: 8 synthetic users, one large settings body each (e.g. 5 MB), `N=200`
concurrent saves per user against a real handler/data root; record p50/p95/p99 per user and the max queue
depth; then run the same load against pinned Node (`../SillyTavern`) on the same host for the comparison
H2 predicts. Acceptance: Go p99 <= pinned p99 on the same input, and no request exceeds pinned's own
save block time. This is the M5/E06 concurrency leg that does not exist yet.

### C-H4 — flock wait inside the save mutex (verified-risk, strength 3)

**Evidence.** `settings_save.go:51` holds L1, `startup.SaveSettings` ->
`lockSettingsUser(absoluteUserRoot)` (`startup/settings_backup.go:76,131-150`) ->
`acquireContentLock(lockRoot)` (`startup/content.go:398-414`), which keys the lock on the **data root**
(`:403`), not the user. The acquisition is bounded but bounded at 10 s (`lockacquire.go:31,114-131`) and
on failure returns `*BusyError` (a 500 from the save route). Therefore, with a second GoTavern process on
one data root, every user's save can queue behind up to 10 s of lock wait, and the whole queue is inside
one mutex.

**Oracle / counterargument.** Pinned has no cross-process lock; two pinned processes tear each other's
settings (alpha.15 audit row B-07: "pinned has no cross-process lock; atomic writes = last writer wins").
The lock is a deliberate data-safety addition. So the finding is a **cost**, not a defect: the alternative
(pinned's last-writer-wins) is a data-safety defect. A redesign that shortens the critical section (e.g.
acquire the flock, write, release, then snapshot outside L1) would reduce the queue without weakening the
lock, and must keep the snapshot under the same lock as the write to preserve the duplicate check's
ordering.

### C-H5 — Trailing backup timer is not joined at shutdown (intentional-parity, strength 3)

**Evidence.** T1 is the only detached timer in the product (`settings_save.go:71`); its callback waits for
L1 and writes/deletes a snapshot (`:77-87`). There is no `accountRuntime.Close` and no `timer.Stop()` call
on any shutdown path (direct query: `git grep 'timer.Stop()'` -> only provider poll helpers; `git grep
'settingsSaveWait|settingsSaves'` -> `settings_save.go` + `settings_save_test.go`). A save that marks
`pending` and is followed by a graceful shutdown before the 10 min trailing edge loses that snapshot.
The settings document itself is already persisted by the request, so the loss is a backup convenience,
not the user's data.

**Oracle.** pinned's SIGINT/SIGTERM handler calls `statsOnExit` / `cleanupPlugins` / `diskCache.dispose`
and then `process.exit()` (`src/server-main.js:318-331`) without flushing the lodash throttle's trailing
call. Same loss, so `intentional-parity`.

**What would make it a defect:** if a *graceful* shutdown could leave a **torn or missing settings.json**
(no — the write happens in the request) or if a backup were required for hand-back integrity (it is not;
pinned recreates snapshots on demand and the settings file is the source of truth). A test asserting
"shutdown flushes pending snapshots" would be a *new* product guarantee, not a parity requirement.

### C-H6 — Unbounded wait in graceful shutdown (verified-risk, strength 4)

See U1. `internal/app/heartbeat.go:79-84` blocks on the writer mutex (which `write()` holds across
`temporary.Sync()`, `:127`) and then on `<-writer.done`; `app/server.go:431-433` calls it before
`Shutdown(ctx)`, so the 10 s deadline never applies. The wait has no error and no bound, which is exactly
the shape AGENTS rule 24 forbids elsewhere. **Reproducer plan:** add a write seam (the project's existing
pattern: a `var` set only by a test — `app/server.go:409-418` is the precedent), have a test hold the
heartbeat write, call `Close(ctx)` with a 100 ms ctx, and assert `Close` returns within, say, 1 s with a
named error. Today it hangs. Counterargument: a local fsync almost never stalls; but the cost of a bound
is one `select`/context, and the failure mode is a user's Ctrl+C hanging with no message.

### C-H7 — Second signal does not force-close in-flight requests (verified-risk, strength 3)

**Evidence.** `cmd/gotavern/main.go:367-373` prints "closing listeners now (in-flight requests are
aborted)" and closes **listeners only**. `net.Listener.Close` stops accepting and closes idle
connections; it does not terminate established connections or running handlers. `forcedShutdown` then
returns from `runWithStreams`, whose deferred `running.Close(new 10 s ctx)` (`:254-258`) calls
`http.Server.Shutdown` again, which waits for active connections up to the new deadline. So a second
Ctrl+C on a wedged streaming request can still appear to hang for up to 10 s while printing that requests
are aborted. **Reproducer plan:** an in-process test with a handler that blocks until released; call
`shutdownAfterSignal`, deliver a second signal, and measure the time from the second signal to `Close`
returning; assert it is <= a short bound and that the message matches what happens. Counterargument: the
message is diagnostic, the process does exit with 130, and pinned's SIGINT is an immediate
`process.exit()` with no drain at all — so pinned is "faster but less graceful". The fix is either close
connections on the second signal or change the message.

### C-H8 — `-race` gate package list omits `internal/app` and `internal/lockacquire` (verified-risk, strength 3)

**Evidence.** `.github/workflows/ci.yml:656-683` runs
`go test -race -count=1 ./internal/server ./internal/outbound ./internal/fsretry ./internal/startup ./tests/egressguard`.
The comment (`:665-669`) says these are "the packages that own shared mutable state". But
`internal/app` owns `heartbeatWriter` (mutex + Once + goroutine) and `RunningServer.Close` (called
concurrently on the signal path), and `internal/lockacquire` owns the process-wide `bootDeadline` atomic
and the diagnostics mutex. Neither is in the list. Separately, the real signal path
(`shutdownAfterSignal`) has **no test**: direct query `git grep 'shutdownAfterSignal'` returns only
`main.go` (definition and one call) — the unit test at `cmd/gotavern/cli_test.go:375` covers only the
`forcedShutdown` error type. AGENTS rule 104 says the race gate exists because the dev host cannot run
`-race`; the gate is the only detector, so its package list is load-bearing. **Reproducer plan:** add
`./internal/app ./internal/lockacquire` to the job; the concurrent-`Close` test in H7 then runs under the
detector.

### C-H9 — Unbounded provider poll loops are parity (intentional-parity, strength 3)

**Evidence.** `serveSDComfyGenerate` polls `/history/{id}` in a `for {}` with `time.Sleep(100ms)`
(`server/sd_generate_comfy.go:391-419`) and `serveSDComfyRunPodGenerate` polls `/status/{id}` the same way
(`:618+`, 500 ms at `:57`); the requests run on `sdComfyDetached(request)` = `context.Background()`
(`:147-149`), and the disconnect watcher only POSTs `/interrupt` or `/cancel/{id}` (`:335-349`,
`:558-571`). The code comment (`:416-418`) states the pinned loop is identical.
**Oracle confirmed:** pinned `comfy.post('/generate')` does `while (true) { ... await delay(100) }` with no
attempt bound (`src/endpoints/stable-diffusion.js:590-602`) and the RunPod route repeats it
(`:710`). In contrast, the Google/OpenAI video loops **are** attempt-bounded (`google_video.go:42`
`max 30`, `:199`; `openai_generate_video.go` same shape) — the difference is real and comes from pinned.
**Consequence.** A stuck job holds one Go handler goroutine (and its response writer) until the process
exits, even after the client disconnects; the same is true of pinned's promise chain. Recorded for the M5
soak rather than classified as a defect; a bound would be a deliberate divergence.

### C-H10 — Unbounded process-wide sets reproduced from pinned (intentional-parity, strength 3)

`cache_buster.go:75-77,120-127` keeps one key per (handle, sha256(User-Agent)) for the process lifetime
— client-controlled input, unbounded, no eviction; pinned does exactly the same with
`#keys = new Set()` (`src/middleware/cacheBuster.js:13,78-82`). `access_log.go:46,91-97` keeps one entry
per client IP, unbounded; pinned's `knownIPs = new Set()` (`src/middleware/accessLogWriter.js:8,38-40`) is
identical. `host_whitelist.go:12,52` caps at 1000 **because pinned caps at 1000**
(`src/middleware/hostWhitelist.js:5-6,27`). All three are inherited properties; AGENTS hard rule 5 says
reproduce inherited weaknesses and record them rather than silently fixing them. Recorded here; no
reproducer is needed to establish parity. (They are still memory-growth vectors under adversarial input;
if a later release hardens them, that is a visible product decision.)

### C-H11 — Identity-cache residual: same-size + same-mtime (verified-risk, strength 2)

**Evidence.** C1 closes the residual on Unix with the inode change time (`accounts.go:274-293`,
`record_change_windows.go:39`; red-then-green test `accounts_cache_test.go:174`). C2/C3/C4 validate on
type+size+mtime only (`settings_cache.go:188-193` via `digest.fileInfo`; `characters_card_cache.go:92-100`)
even though they already stat every input, so the same witness is available at no extra syscall on Unix.
Both state the residual openly and pin it with a test (`settings_cache.go:61-66`,
`settings_cache_test.go:266`; `characters_card_cache.go:67-73` and its `...DocumentedResidual` test).
**Impact.** A timestamp-preserving external replacement serves the old body until a later change moves
size or mtime. No product writer can do this (`atomicReplace` moves mtime; on Unix ctime too), so this is
an external-writer scenario only.
**Counterargument.** Adding the change stamp to these caches would change response bytes only in the
adversarial case and would need the Windows boundary documented again; it is a candidate improvement, not
a demonstrated user problem. Strength 2.

### C-H12 — Wire-exact goroutine (out-of-scope, strength 1)

`internal/outbound/raw.go:167-175` starts one goroutine per connection that closes the socket on
`ctx.Done()`. It is reachable only with `GOTAVERN_OUTBOUND_WIRE_EXACT=1` (`transport.go:132-141`), the
byte-exact observation client that AGENTS rule 30 says must NOT carry user traffic; production uses the
`net/http` client. If a caller passes a background context the goroutine lives until the socket closes
(tests do: `raw_test.go:168,237,330`). Recorded so the role distinction is explicit; no product exposure.

---

## 6. Re-verification of alpha.15 rows that touch this lane

README §1 rule 8: re-verify rather than quote. Each row below was re-read at this tree.

| Row | Claim re-checked | Result at this tree |
|---|---|---|
| B-07 | two processes on one data root do not tear settings; pinned has no cross-process lock | **Still true.** flock keyed on data root (`startup/content.go:398-414`), used by `SaveSettings` (`startup/settings_backup.go:76`); pinned's `/save` has no lock (`src/endpoints/settings.js:206-216`). Cost of the lock: H4. |
| B-09 | lock acquisition is bounded, `*BusyError` names purpose/path | **Still true.** `lockacquire.go:28-36,72-85,103-135`; budget installed at `app/server.go:138-141`. |
| B-10 | external preset edit invalidates the settings cache unless identity is restored | **Still true.** Digest includes every preset directory's entries (`settings_cache.go:243-254`); test `settings_cache_test.go:238`. Residual is H11. |
| B-17 | readers during a save see old XOR new | **Still true.** `atomicReplace` = temp + `Sync` + rename + dir `Sync` (`startup/content.go:338-396`). |
| C-01 | redirect protocol change strips credentials | out of this lane's surface; untouched by this audit (no concurrency change). |
| C-14 | Windows account-cache boundary | **Still true.** Documented in `accounts.go:283-293` / `record_change_windows.go:39`; same-size same-mtime is the accepted Windows boundary. |
| F-03 | identity-keyed card-text cache, bounded, invalidation on identity, read-under-lock | **Still true.** `characters_card_cache.go:126-147` (one critical section, with the `-race` history in the comment), bounds `:84-87`, tests `characters_card_cache_test.go:265,366`. |
| F-04 | compressed static-asset cache DECLINED | **Still absent** (no cache in `compression.go`; `sync.Pool` at `:79` is a writer pool, not a response cache). |
| AGENTS 104 | the `-race` job runs the packages that own shared state | **Partially stale**: `internal/app` and `internal/lockacquire` are omitted (H8). |

---

## 7. Unknowns and contract notes

### 7.1 What this lane could not decide

1. **Whether any wait in §4 actually stalls in practice** — reproducers for H6/H7 need a seam or a
   blocking filesystem; neither exists on this host and M0 may not add one.
2. **Cross-user save latency numbers** (H3) — needs the E06 multi-account leg and a pinned comparison on
   the same host; M0 is read-only and may not boot either server.
3. **Whether `internal/app`'s concurrent `Close` is race-free** — this host cannot run `-race`
   (`windows/arm64`, AGENTS rule 104); only the CI job can answer, and H8 says it does not cover the
   package.
4. **Whether the response-cache residual (H11) is worth closing** — a product/release decision (cost:
   response bytes move only in an adversarial restore; benefit: one more witness).
5. **Tokenizer cold-load serialization (L11)** — not measured. `GOAL.md` §15.3 asks every cache for its
   measured benefit; C7 has none recorded, and its comment (`tokenizers.go:23-24`) says the disk-cache
   switch is not projected. E/M5 should decide whether a bench is required before any change.

### 7.2 Contract observations about `source-graph.json` (for the Lead, not product findings)

The graph was used as the mechanical floor and its `globals[]` index is sound (it is how the 8
package-level sync stores and 6 atomic stores were enumerated). Its `facts[]` counters are **not a
census**, in two reproducible ways:

1. It does not descend into package-level `var` **initializer function literals**: `time.NewTimer` inside
   `var googleVideoSleep = func(...)`, `var openAIVideoSleep = func(...)` and `var sdZaiVideoSleep =
   func(...)` is not counted (graph runtime `timer` facts = 4 against a grep count of 7 timer sites:
   `server/google_video.go:52`, `server/openai_generate_video.go:64`, `server/sd_zai.go:79` missing).
2. It does not record a package-level var's **type expression** as a `sync-type`/`atomic` fact; those
   appear in `globals[].recv` instead (so `sync-type` runtime = 1, while scope R has 21 `sync.Mutex`
   sites). Also, `time.Time.After` style method calls can be counted as `timer`
   (`startup/settings_backup.go:254` `sortTime.After` in the all-production facts).

This does not block M0 (every primitive in this lane was enumerated from `globals` + grep and is listed
in §2), but a reader who quotes `factsByKind` as coverage would undercount. Worth a note in
`source-audit.md`'s coverage paragraph.

### 7.3 Deliberate absences recorded as such

- No `RWMutex`/`sync.Map`/`sync.Cond` in production: read-heavy maps use a plain mutex; no measurement
  justifies a change and §15.4 says leave it alone.
- No in-process job scheduler: the plan's R2 offers "a simple per-user coordinator over a generic job
  scheduler, only if red tests justify it". After this audit the red tests do not exist yet (H3), and the
  oracle comparison in H2 says the current serialization is narrower than pinned's. **Recommendation to
  the Lead: do not extract a lifecycle coordinator in alpha.16 on this evidence; require H3's measurement
  first.**
- No unbounded-memory fix inside this change: H1/H10 are recorded, not fixed (M0 rule 2).

---

## 8. Reproduction commands for every number in §1

Run from the repository root with `pwsh` (PowerShell 7). `-notmatch '_test\.go$'` is the production
filter; `^internal/|^cmd/` is scope R.

```powershell
$all = git ls-files '*.go'
$rt  = @($all | Where-Object { $_ -notmatch '_test\.go$' -and ($_ -match '^internal/' -or $_ -match '^cmd/') })
$rtT = @($all | Where-Object { $_ -match '_test\.go$' -and ($_ -match '^internal/' -or $_ -match '^cmd/') })
function C($files,$pat){ $f=0;$o=0; foreach($x in $files){ $t=[System.IO.File]::ReadAllText((Resolve-Path $x));
  $m=[regex]::Matches($t,$pat); if($m.Count -gt 0){$f++;$o+=$m.Count} }; "$f files / $o matches" }
C $rt '\bsync\.Mutex\b'        # 15 / 21
C $rt '\bsync\.RWMutex\b'       # 0 / 0
C $rt '\bsync\.Once\b'          # 2 / 2
C $rt '\bsync\.WaitGroup\b'     # 1 / 1
C $rt '\bsync\.Map\b'           # 0 / 0
C $rt '\bsync\.Cond\b'          # 0 / 0
C $rt '\bsync\.Pool\b'          # 1 / 1
C $rt 'atomic\.'                # 7 / 11 (9 code, 2 comments)
C $rt '(?m)^\s*go (func\(|[A-Za-z_])'   # 10 / 12
C $rt 'time\.AfterFunc\('       # 1 / 1
C $rt 'time\.(NewTicker|Tick)\(' # 1 / 1
C $rt 'time\.NewTimer\('        # 5 / 5
C $rt '\bexec\.Command'         # 2 / 3
C $rt 'context\.Background\(\)' # 12 / 20
C $rt 'signal\.Notify\('        # 1 / 1
# graph globals (package-level state) and facts:
$g = Get-Content docs/alpha16/source-graph.json -Raw | ConvertFrom-Json
$rp = @($g.files | Where-Object { -not $_.test -and $_.path -match '^(internal|cmd)/' })
@($rp | ForEach-Object { $_.globals } | Where-Object { $_ }).Count                       # 245
@($rp | ForEach-Object { $_.globals } | Where-Object { $_.recv -match 'sync\.' }).Count  # 8
@($rp | ForEach-Object { $_.globals } | Where-Object { $_.recv -match 'atomic\.' }).Count# 6
@($rp | ForEach-Object { $_.facts } | Where-Object { $_.kind -eq 'sync-field' }).Count   # 14
```

Direct negative queries used above (whole-tree symbol queries, not bounded reads). The `git grep` forms
are exactly the ones that were run; the two regex composites were run through the same `C` function
above because the pattern needs alternation.

```powershell
git grep -n 'settingsSaveMu' -- '*.go'                       # accounts.go + settings_save.go only
git grep -n 'timer.Stop()\|settingsSaves\[' -- '*.go'        # provider poll helpers + settings_save.go/test only
git grep -n 'shutdownAfterSignal\|forcedShutdown' -- '*.go'  # main.go + cli.go/cli_test.go only
git grep -n 'TLSConfig:' -- '*.go'                           # test files only -> clients map bounded in prod
C $rt '\bexec\.Command'                                      # 2 files / 3 matches (git + browser opener)
foreach ($f in 'internal/server/extensions_fs.go','internal/server/extensions_static.go') {
  C @($f) 'sync\.|go func|go [A-Za-z_]|time\.(AfterFunc|NewTicker|NewTimer)|exec\.' }  # 0 / 0
```

---

*End of Lane C audit. Machine-readable fragment: [`fragments/c.json`](fragments/c.json).*
