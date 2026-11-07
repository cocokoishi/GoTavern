# alpha.17 — M0 source, ownership and evidence audit

**Status: DRAFT (read-only audit at `main@eaf8c22`; the M0 rule forbids product changes in this document).**
Baseline: pinned SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127` in `../SillyTavern`
(read-only). The machine-readable union is `docs/alpha17/ownership-map.json`; the generated AST facts are
`docs/alpha17/source-graph.json`. Both were produced from the current tree, not copied from alpha.16: the map's
**1,007 `path:line` citations were re-validated** with `docs/alpha17/audit/refresh-ownership-map.mjs`
(0 failures, 4 named basename fixups — the alpha.16 map spelled four `image_metadata_folder_*.go` writers as
`folder_*.go`).

## 1. Method and coverage census

| measurement | value | command |
|---|---|---|
| round-start HEAD | `c02eed109ceba32ba710948a0420425f8ce58b1f` (two documentation commits after the alpha.16 release commit) | `git rev-parse HEAD` at M0 |
| source graph | 626 files, 40 packages, commit recorded in the file | `go run ./tools/alpha16-graph -root . -out docs/alpha17/source-graph.json -commit <HEAD>` |
| ownership map | 67 writers, 66 concurrency rows, 33 caches, 72 hypotheses, 6 refactor candidates | `docs/alpha17/ownership-map.json` (`refresh` block records the citation check) |
| internal packages / first-party import edges | **18 / 20** | `go list ./internal/...`; `go list -f '{{.ImportPath}} {{range .Imports}}{{.}} {{end}}' ./internal/...` |
| ordered-JSON coupling in `internal/server` production files | **115 files**, **1,290 references**, 578 `.kind` / 566 `.array` / 140 `.scalar` | `Select-String -Pattern 'orderedNodeJSON\|orderedJSON'` and per-member patterns over `git ls-files 'internal/server/*.go'` minus tests |
| shared atomic-write helper call sites in `internal/` | **43 sites in 20 files** | grep `WriteFileAtomic(`, `SaveSettings(`, `atomicReplace(`, `atomicCreate(` |
| production `internal/server` files | 187 | `git ls-files 'internal/server/*.go'` minus `_test.go` |

Coverage is mechanical for every owned Go file (all appear in `source-graph.json`) and deep for the owners
cited below. A file that was only mechanically covered is listed as such by the graph; this document does not
claim a deep read it did not perform.

## 2. Package dependency graph (recomputed)

18 packages, 20 first-party edges. The edges are acyclic at the package level and point from composition to
mechanism:

```
internal/app      -> commandline, lockacquire, outbound, server, startup
internal/server   -> commandline, faultinject, fsretry, httpx, outbound, startup, tokenizers, userdata
internal/startup  -> commandline, faultinject, fsretry, lockacquire
internal/migrate  -> commandline
internal/configinit -> lockacquire
```

`internal/server` is the only package with more than eight outgoing edges; it owns the HTTP surface, the
account/session layer and the persistence handlers by design (`ARCHITECTURE.md`). No measured coupling defect
is produced by this graph — see `architecture-decisions.md` §1 (R6 REFUSE) for the reopening metric.

## 3. Request lifecycle (file:line at HEAD)

1. **CLI** — `cmd/gotavern/main.go:36` (`main`) parses flags through `internal/commandline` (the pinned flag
   table is `options.go`; the resolved paths are `commandline.Paths`, including `ConfigFile`).
2. **Start** — `internal/app/server.go:137` (`Start`) runs startup (config init/migration, directory creation,
   locks, content seeding) and constructs the HTTP handler.
3. **Handler construction** — `internal/server/http.go:302` (`NewHTTPHandler`), `:312`
   (`NewHTTPHandlerWithDataRoot`), `:319` (`NewHTTPHandlerWithOptions`); the domain inventory is the explicit
   table at `internal/server/routes_registry.go:36` (`routeDomainTable`), pinned by
   `internal/server/routes_registry_test.go` (golden names + registrars).
4. **Middleware** — the pinned CORS → Basic Auth → session → CSRF → account order is documented at
   `internal/server/http.go:144-...`; CSRF is `internal/server/csrf_session.go:187` (`requiresCSRFSynchronization`,
   which exempts `/proxy/` when CORS proxy is enabled) and `:195` (`serveCSRFToken`).
5. **Route** — ServeMux selects the most specific pattern; a duplicate registration panics at construction and a
   test proves that (`routes_registry_test.go`).
6. **Handler** — handlers resolve the account through `accountRuntime` (`internal/server/accounts.go`), then read
   or write the user tree through `internal/startup`'s atomic seams (`fsretry`, `atomicReplace`, `atomicCreate`).
7. **Response** — `internal/httpx` carries the pinned status-text and weak-ETag conventions; compression and the
   panic boundary wrap the response (`internal/server/compression.go`, `panic_boundary.go`).

## 4. Startup lifecycle

`cmd/gotavern/main.go` → `app.Start` (`internal/app/server.go:137`): resolve paths → acquire bounded data-root
lock (`internal/lockacquire`, bounded by `AGENTS.md` rule 24) → `configinit` (parse, migrate legacy keys,
create a config only when absent) → startup directory/content seeding (`internal/startup/
{storage,content,user_presets,settings_backup,secrets_state,statistics}.go`, each taking the shared content lock
under a bound) → listen (the Ready line is printed only after the listener serves) → run the heartbeat writer
(`internal/app/heartbeat.go`; bounded stop via `ErrHeartbeatStopTimeout`, `:24`, `:119`). Startup performs no
non-essential network I/O; the only allowed lookup is the documented bounded docker-hostname resolution.

## 5. Persistence writer graph (summary of the 67 map rows)

Every audited writer maps to a route, a writer function and a lock. The dominant families:

| family | routes | writer | lock | atomicity |
|---|---|---|---|---|
| settings | `POST /api/settings/save`, `/get` | `internal/server/settings_save.go:20` (`serveSettingsSave`), `:50` (`saveSettings`) | `settingsSaveMu` | `startup.SaveSettings` → shared flock + atomic replace + throttled backup snapshot |
| chats | `/api/chats/{save,get,rename,delete,append}` | `internal/server/chats.go` | shared content lock | `startup` atomic write; JSONL append keeps prior lines |
| characters/cards | `/api/characters/*` | `internal/server/characters*.go` | shared content lock | atomic replace; PNG metadata preserved |
| world info / presets | `/api/worldinfo/*`, `/api/presets/*` | `internal/server/worldinfo.go`, `presets.go` | shared content lock | atomic replace |
| account store | `/api/users/*` | `internal/server/accounts.go` | account store lock | atomic replace; reset is `rm` + reseed (pinned parity) |
| tokenizer cache | tokenizer routes | `internal/server/tokenizers.go` | per-file | unique temp + fsync + rename + dir fsync (D-H17 fix) |
| migration | `gotavern migrate` | `internal/migrate` | bounded flock | copy to `--dest`; `--force` backs up `certs/` + overlay (B-H3 fix) |

43 call sites in 20 files route through the shared `internal/startup` seams; the writers outside them are
read-only or add-only (access log, extension static files). No route writer writes a user JSON/JSONL file in
place.

## 6. Concurrency, lifecycle and caches

The map holds 66 concurrency rows and 33 cache rows; the load-bearing ones:

- **Locks**: data-root/content flock (`internal/lockacquire`, bounded acquisition), per-account store lock,
  `settingsSaveMu`, per-cache mutexes. Lock order is content → account store; no path takes them in reverse.
- **Goroutines**: one per HTTP request (net/http), the heartbeat writer, throttled settings snapshots
  (`time.AfterFunc`), provider streaming readers. Shutdown: listeners close, in-flight requests drain up to the
  documented bound, heartbeat writer joins under the shutdown context or reports `ErrHeartbeatStopTimeout`.
- **Caches**: account cache (identity = path+mtime+size + change stamp where the platform provides one), settings
  and world-info metadata memo (same identity WITHOUT a change stamp — the documented same-size+same-mtime
  residual), card-text cache (LRU, identity-keyed), tokenizer cache (file on disk). Each has a rebuild path and a
  measured benefit in `docs/perf-baseline.md`/`docs/performance.md`.
- **Child processes**: git operations for extension install/update/version run with a bounded timeout (pinned
  parity: `simple-git`'s 5-minute `timeout.block`, no abort); no request cancellation kills a git child, which
  is parity rather than a defect (`architecture-decisions.md` R4).

## 7. Data-root ownership and provider path

The data root is owned by `internal/startup` (paths), `internal/server` (per-route user trees) and
`internal/migrate` (copy only). `--configPath`/non-adjacent `--dataRoot` are threaded through
`HTTPHandlerOptions.ConfigPath` into `pinned_chat_config.go:65` (`pinnedConfigCandidates`), so the provider-visible
config read is the startup-resolved file (D-H1 fix; `google_chat.go:75` reads `gemini.apiVersion` through the
same view, D-H2). Provider requests leave through `internal/outbound`: the production transport is separate from
the byte-exact oracle client (`raw.go`), with proxy awareness, bounded connect/TLS/header/idle timeouts,
decompression, redirect policy, keep-alive and the private-address dial filter.

## 8. Browser → server → provider observability

Pinned frontend (`upstream/public/**`, byte-identical) → browser HTTP (account/session/CSRF, data routes) →
handler → provider wire (`internal/outbound`) → stream/JSON back to the browser. Evidence classes already wired:
provider-wire captures (`tests/oracle/sillytavern-1.19.0-provider-wire.json`, 262 scenarios), browser
comparison artefacts (`tests/browser/*comparison*.json`, 40), the 20-extension corpus, the helper-state judge
and the combination journey. The nine collected guards in `docs/SEMANTIC-COMPATIBILITY.md` §1 define what a
browser observation may claim; page-init egress is the open hermeticity item (`defect-reconfirmation.md` item 4).

## 9. Five strongest CURRENT findings (ranked)

| rank | id | class | surface | finding | evidence | reproduction | worth fixing in alpha.17? |
|---|---|---|---|---|---|---|---|
| 1 | **A-H3** | verified-risk (data safety) | persisted bytes | `POST /api/settings/save` with an empty/whitespace body: pinned's body-parser yields `{}` and `writeFileAtomicSync(JSON.stringify({}))` **replaces settings.json with `{}`** answering `{result:"ok"}`; GoTavern answers 400 and leaves the file intact. On a write failure pinned answers HTTP 200 with a serialised Error (`response.send(err)`), GoTavern answers 500. | `../SillyTavern/src/endpoints/settings.js:206-215`; `internal/server/settings_save.go:34-46` | source-derived; a contract test pins Go's refusal. Not a failing product reproducer: the divergence is deliberate. | Record, do not "fix": Go's refusal is safer than pinned's wipe. The missing piece is the **recorded divergence** (added to `SEMANTIC-COMPATIBILITY.md` §18 and `decision-log.md` AL17-D004). |
| 2 | **CHAT-BACKUP** | verified-risk (data safety) | persisted bytes | Pinned's chat save schedules a throttled per-chat backup (`backups.chat.enabled` default **true**, retention and integrity check) outside the chat directory; GoTavern implements none of it. Users swapping backends lose the backup safety net they had. | `../SillyTavern/src/endpoints/chats.js:27-32,52-...`; Go's own recorded note `internal/server/chats.go:18-23` | source-derived; no failing Go test because the feature is absent. | Record as a **known partial/unsupported** capability with its scope words (alpha.17 decision) rather than claim parity; implementation is a candidate for the next round. |
| 3 | **PROXY-ROUTE** | verified-risk (surface) | browser wire | Pinned always registers `/proxy/:url(*)`: with `enableCorsProxy` it proxies, otherwise it answers **404 with the message "CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag."** GoTavern registered no `/proxy/` route at all (only the CSRF exemption mentioned it), so the disabled branch answered the server's generic 404 and the enabled branch was a generic 404 rather than a distinguishable unimplemented status. | `../SillyTavern/src/server-main.js:257-264`; `internal/server/csrf_session.go:192`; no registration in `routes_registry.go` before this round | The inventory gate cannot see direct `server-main.js` routes (known L-H4); the route-level test now does. | **FIXED in alpha.17** (commit `ab5d723`): new `internal/server/cors_proxy.go` registers the domain; disabled answers pinned's exact 404 body + `text/html; charset=utf-8`, enabled answers 501 with a named reason; `internal/server/cors_proxy_test.go` pins both, the route goldens moved 54->55, and the surface-coverage gate classifies the route as `unsupported-with-reason`. RED/GREEN: with the table row removed, `TestCorsProxyDisabledAnswersThePinnedRefusal` failed by name; restored = `ok internal/server 1.007s`. |
| 4 | **A-H2** | verified-risk | browser wire | `cors.enabled` with a **falsy** `cors.origin` (null/false/empty string) loses Express's automatic OPTIONS answer: pinned answers 200 preflight, GoTavern 404. | `internal/server/cors.go`; `../SillyTavern/node_modules/cors/lib/index.js` (configureOrigin); the default `cors.origin` is the string `"null"`, so only a hand-edited config reaches it. | source-derived; needs a pinned CORS probe to be a recorded oracle. | NO in alpha.17 (config-gated, source-derived only); recorded as a residual with the probe plan. |
| 5 | **A-H5** | untested-hypothesis | browser wire | With CSRF protection disabled **and** accounts off, `POST /api/users/login` gets a nil session and answers 500 where pinned answers 200. | `internal/server/http.go` (session middleware), `csrf_session.go:187`, `accounts.go`; pinned `src/endpoints/users-public.js:89` and `src/users.js:568`. | No probe has been recorded; the pinned source supports the hypothesis. | NO in alpha.17: needs a pinned recording first; recorded as UNPROVEN with the reproducer plan. |

**Beyond the five:** C-H11 (settings/world metadata memo same-size+same-mtime residual, pinned by a test),
page-init egress hermeticity (OPEN), D-H18 (stats rewrite order/timing, untested), A-H1 (no app-level
body-parser stage; verified-risk), A-H6 (TLS Set-Cookie attribute order; cosmetic), A-H9 (account version hash
uses stored bytes; untested), SSO auto-login (declared unimplemented with a warning), per-chat backups (see #2).

## 10. Which alpha.16 defects are fixed vs open at HEAD (verified in current code)

| id | state at HEAD | verification |
|---|---|---|
| D-H1 `--configPath` ignored by chat config readers | **FIXED** (`acad078`) | `internal/server/pinned_chat_config.go:65-67` returns the explicit config file first |
| D-H2 `gemini.apiVersion` unread | **FIXED** (`1a7b914`) | `internal/server/google_chat.go:75-76,211,464` |
| D-H3 `claude.enableAdaptiveThinking` unread | **FIXED** (`60454bc`) | `pinnedClaudeAdaptiveThinking` consumed by the 4-6 clause |
| B-H3 `migrate --force` backup incomplete | **FIXED** (`7f91192`) | `internal/migrate/migrate.go` replaced-path set + its red-first tests |
| L-H1 stale benchmark baseline | **CLOSED** (`05479fa`, `39cec62`, `ef41eec`) | `tests/perf/bench-baseline.txt` records the regenerated run |
| C-H1 rate-limit map never evicts | **FIXED** (`a2fc2e5`) | `internal/server/accounts.go:122-160` (`pruneLocked`, pinned expiry FIFO) |
| C-H6 unbounded heartbeat shutdown wait | **FIXED** (`a2fc2e5`) | `internal/app/heartbeat.go:24,119-128` (`ErrHeartbeatStopTimeout`) |
| C-H7 inaccurate second-signal message | **FIXED** (`a2fc2e5`) | `cmd/gotavern/main.go` message + the three tests |
| C-H8 `-race` list omitted two packages | **FIXED** (`a2fc2e5`) | `.github/workflows/ci.yml` race list |
| D-H17 non-atomic tokenizer cache write | **FIXED** (`2b43f33`, `0e3bec1`) | `internal/server/tokenizers.go` temp+fsync+rename |
| B-H4 destructive routes outside the content lock | **PINNED PARITY, no lock added** | `docs/alpha16/storage-probe.md` §2; Windows residual remains |
| A-H3 / A-H2 / A-H5 / L-H4 / D-H18 / A-H1 / C-H11 | **OPEN** (as classified above) | see `defect-reconfirmation.md` |

One **correction to HANDOFF's next-actions list**: the claim that `POST /api/extensions/version` issues two
`git fetch` calls "where pinned fetches once" is **false**. Pinned fetches at `src/endpoints/extensions.js:423`
**and again** inside `checkIfRepoIsUpToDate` at `:43` (`:425`), so GoTavern's two fetches
(`internal/server/extensions_git.go:362` and `:205`) are **pinned parity**, not a defect. It is recorded here so
the next reader does not "fix" parity.

## 11. Residual unknowns

`docs/alpha17/defect-reconfirmation.md` is the item-by-item ledger (16 rows). The categories: real-tree
qualification (`GOAL.md` §14, PRIVATE_NOT_RUN), kernel ENOSPC, macOS arm64 runtime + extension lifecycle,
windows/arm64 runtime, 8-user latency (report-only), soak leak (unproven), page-init egress (open), CORS/proxy
surface gaps above, and the release-evidence selection rails (`docs/alpha17/evidence-contract.md`).
