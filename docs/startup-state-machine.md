# Startup state machine (Phase 0.1 / 0.3)

Recorded at `main` `10314c8`, read from the source. This is the answer to one question the user hit in practice:

> A stock SillyTavern directory starts fine with `node server.js`. Put the GoTavern release binary in that same
> directory, run it, and it sits in initialisation forever. **What does GoTavern actually execute between
> `main()` and "listener ready", and which of those steps can wait forever?**

## 1. The call graph, in order

```
main()                                          cmd/gotavern/main.go:30
└─ run(args)                                    :41        dispatch: (no args | flags) → runServer, else subcommands
   └─ runServer(args)                           :161
      ├─ os.Getwd()                             :162        CWD
      ├─ os.Executable() → installRoot          :166-170    install root = dir of the binary
      └─ app.Start(StartOptions{Args, CWD, InstallRoot})
         ├─ commandline.ResolveCommandLine      internal/app/server.go:107
         │  ├─ option/env/arg resolution         internal/commandline/options.go
         │  ├─ path resolution                   internal/commandline/paths.go:129
         │  │  └─ configinit.Initialize(configFile)         ← ** BLOCKING flock **, see §2
         │  │     ├─ acquireLock (flock.Lock)    internal/configinit/config.go:169
         │  │     ├─ stat/create config (atomic write if absent)   :89-97
         │  │     ├─ parse + migrateConfig + mergeDefaults         :106-123
         │  │     └─ atomicWrite config back when changed          :136
         │  └─ data root / cookie secret / log path derivation
         ├─ os.ReadFile(<dataRoot>/_errors/forbidden-by-whitelist.html)   server.go:117
         ├─ startup.InitializeDataStartupFromCommandLine                  server.go:119
         │  └─ startup.InitializeDataStartup            internal/startup/data_startup.go:61
         │     1. InitializeCookieSecret                 :67   ** flock ** (secret.go:85)
         │     2. ensureUploadsDirectory                 :73   mkdir data/_uploads
         │     3. InitializeUserStorage                  :77   ** flock ** (storage.go:440) + scans data root
         │     4. EnsureDirectories                      :83   mkdir per-user trees
         │     5. MigrateUserData                        :89   ** flock ** (user_data_lock.go:12) + time.Sleep
         │     6. MigrateSystemPrompts                   :95   copies default content
         │     7. MigratePublicOverrides                 :101  copies/overwrites public/** overrides
         │     8. readSecuritySettingsUsers              :109  ** flock ** (settings_backup.go:131)
         │     9. VerifySecuritySettings                 :114  may request exit (security gate)
         │    10. MigrateGroupChatsMetadataFormat        :119
         │    11. SeedDefaultContent                     :125  copies default/** into data/**
         │    12. VerifyCharacterDiskCache               :131
         │    13. MigrateFlatSecrets                     :132  ** flock + secrets rewrite **
         │    14. CleanUploads                           :133  deletes files
         │    15. MigrateAccessLog                       :134
         │    16. BackupSettings (zip/copy)              :135  ** flock **
         │    17. InitializeStatistics                   :137  ** flock ** (statistics.go)
         ├─ systemInterfaceAddresses()           server.go:139  enumerates NICs
         ├─ server.ResolveProtocolSelection      :141
         ├─ loadTLSConfig (only when ssl.enabled):146
         ├─ server.NewHTTPHandlerWithOptions     :166  registers ~340 routes; reads public/** from disk
         ├─ startFamily(IPv6) → net.ListenConfig.Listen   :174-180
         ├─ startFamily(IPv4) → net.ListenConfig.Listen   :181-187
         └─ startHeartbeat (goroutine, writes data/heartbeat.json)   :192
```

`app.Start` returns only after all of the above. **`cmd/gotavern/main.go` prints nothing until it returns** —
no stage, no progress, no timestamp. A hang anywhere in the chain is therefore indistinguishable from a hang
anywhere else, which is exactly the report the user filed (`P0-B`).

## 2. Every unbounded wait in that chain

| # | Site | Call | Bound today | Failure mode |
|---|---|---|---|---|
| W1 | `internal/configinit/config.go:169` | `flock.Lock()` | **none** | a second process (or a stale lock held by another user/container) blocks the entire boot before the first byte of output |
| W2 | `internal/startup/secret.go:85` | `flock.Lock()` | **none** | same, on `data/.cookie-secret.lock` |
| W3 | `internal/startup/storage.go:440` | `flock.Lock()` | **none** | same, on the data-root storage lock |
| W4 | `internal/startup/content.go:383` | `flock.Lock()` | **none** | same, content root lock |
| W5 | `internal/startup/user_data_lock.go:12` | `flock.Lock()` | **none** | same, per-user migrate lock |
| W6 | `internal/startup/settings_backup.go:131` | `flock.Lock()` | **none** | same, per-user settings lock |
| W7 | `internal/startup/secrets_state.go` | holds a `*flock.Flock` | **none** | same, secrets rewrite |
| W8 | `internal/startup/user_presets.go:96`, `statistics.go:87` | `flock.Lock()` | **none** | same |
| W9 | `internal/startup/user_data_migration.go:38` | `waitBeforeLegacyDataMove = time.Sleep` | fixed sleep, not a wait | slows boot on every legacy move; not a hang |
| W10 | `internal/app/server.go:161` | `net.LookupIP("host.docker.internal")` | **none** (no resolver context) | a hanging DNS server blocks boot when `whitelistDockerHosts` is on in Docker |
| W11 | `internal/outbound/raw.go:129` | `tls.HandshakeContext(ctx)` | caller's ctx only | request-time, not boot — but see `docs/network-egress.md` D6 |

Nothing else in the boot path can block: no git, no HTTP, no child process, no channel receive without a
producer, no goroutine join (the heartbeat goroutine is stopped by `Close`).

**W1 alone is enough to reproduce the user's report**, and W1 is the very first thing that happens after path
resolution: two GoTavern processes pointed at the same tree, or one crashed process whose lock file stayed behind
on a filesystem where `flock` is not released on process death (network shares, some container volume drivers,
Windows without `FILE_SHARE_DELETE` semantics), and the second boot waits forever with no output.

## 3. Startup disk writes (Phase 0.3)

Boot is **not** read-only today. Verified writes, in order:

| Stage | Writes | When |
|---|---|---|
| config init | atomic rewrite of `config.yaml` | when any key is missing (defaults merge) or a legacy key exists |
| cookie secret | creates/rewrites `data/.cookie-secret*` | when absent or legacy-format |
| uploads dir | `mkdir data/_uploads` | always |
| user storage | creates `data/default-user/…` skeleton, scans handles | always |
| user data migration | moves legacy trees (`time.Sleep` between steps) | when legacy layout detected |
| system prompts | copies `default/content/system-prompts/**` into data | when absent |
| public overrides | copies/overwrites `public/**` overrides | when the data root has overrides |
| seed default content | copies `default/**` into `data/**` | when absent |
| flat secrets | rewrites `secrets.json` into the split shape | when legacy flat shape found |
| upload cleanup | **deletes** stale `_uploads` entries | always |
| access log migration | moves `access.log` | when present |
| settings backup | writes `backups/settings_*.zip` | when retention allows |
| statistics | rewrites `data/_stats*.json` | always |
| heartbeat | writes `data/heartbeat.json` every interval | after ready |

The dangerous row for a drop-in user is the first: **a stock `config.yaml` that lacks any key the pinned defaults
contain is rewritten on first boot**, and the pinned defaults include `extensions.autoUpdate: true`
(`upstream/default/config.yaml:301`) and `enableServerPluginsAutoUpdate: true` (`:396`). So "I never enabled
auto-update" and "GoTavern wrote `autoUpdate: true` into my config on boot" are both true at once — the second
half of the user's `P0-C` report.

## 4. Environment dependencies (what can change behaviour silently)

| Input | Used by | Consequence |
|---|---|---|
| CWD | `runServer` → `commandline` (config path, data root, `public/` lookup) | running the binary from another directory changes which config/data tree is used |
| executable dir | `installRoot` | `public/`, `tokenizers/`, `whitelist.txt`, TLS certs, `default/**` |
| `$HOME` | global-mode data root, `migrate` | a different `$HOME` (service account, sudo, Docker) silently selects a different data root |
| `SILLYTAVERN_*` / `GOTAVERN_*` env | `commandline/options.go` | an env var wins over the config file, and an **empty** value still counts as "present" |
| `/.dockerenv`, `/proc/self/cgroup` | `runningInDocker()` | changes whitelist behaviour |

## 5. The contract this file is asking for

1. **Every wait is bounded** with a named error: "config is locked by another GoTavern process (waited 10s)".
   No `flock.Lock()` without a context/timeout path (W1-W8).
2. **Staged diagnostics**: `startup.begin`, `.resolve_paths`, `.config_lock`, `.config_parse`, `.config_migration`,
   `.data_root`, `.secrets`, `.content`, `.extensions`, `.plugins`, `.routes`, `.listeners`, `.ready`, each with
   start/end/duration/result, so a hang names its stage. Default output stays short; `--debug` adds detail.
3. **Read-only boot by default**: a config that parses is not rewritten just because defaults exist. Missing keys
   are supplied **in memory** (and reported), and any file rewrite becomes an explicit, logged, backed-up
   migration step — never a side effect of `gotavern start`.
4. **The release binary must start from a stock tree in four layouts** (CWD=root, foreign CWD, Windows artifact,
   Linux artifact), each with a hard 30 s timeout that dumps goroutines and the stage trace on failure.
5. **Readiness is observable**: a stable marker on stdout and a health endpoint, so CI never sleeps.
