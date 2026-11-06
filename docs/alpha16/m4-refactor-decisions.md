# M4 — evidence-based refactor decisions for R1–R6

**Status: DECIDED — REFUSE all six candidates. Documentation only.** This file is the M4 decision record for
`docs/alpha16-agent-execution-plan.md` §6 (plan lines 103–117). It changes no product, test, fixture, config or
workflow file, runs no git action and dispatches no workflow. Tree read: `0b577de` (program base `c256f21`; the
M0 evidence base is `c8472c1`, the commit `ownership-map.json` names in `baseCommit`).

Readers should treat the M0 artefacts as **snapshots** and this file as the decision against them: the map's
hypothesis rows for D-H2, D-H3 and B-H3 describe the pre-fix code because they were assembled at `c8472c1`; the
minimal fixes that closed them landed afterwards and are listed in §10.

---

## 1. The rule this document applies

The plan's M4 text is a constraint, not an invitation:

- "refactor only boundaries the audit PROVES" and "the agent must decline a proposed refactor when no measurable
  risk, coupling or regression evidence supports it" (`docs/alpha16-agent-execution-plan.md:103,117`);
- "at most one architecture responsibility boundary at a time" (`:141`, §9.D);
- GOAL §15.4: "Boundaries are chosen by DATA OWNERSHIP, not by filename … No big-bang rewrite, no interface
  proliferation, no forwarding-only helper chains", and the ordered-JSON semantics, provider wire converters,
  startup atomic-write/lock core, middleware order and route table are on the do-not-rewrite list
  (`GOAL.md:500-508`); its metric for a refused extraction (152 files / 1,463 references) is at `GOAL.md:265-268`
  and `:391-392`.

A candidate is therefore **IMPLEMENT** only when all four hold:

1. a **named red test or recorded capture** demonstrates a defect (not a planned probe — an existing failure or
   an oracle mismatch);
2. the defect's **cause is the ownership boundary the candidate moves**, not a local bug that a smaller change
   fixes;
3. the move is **move-only**, shippable and revertible in one commit, and the required golden/differential
   table exists to prove behaviour unchanged;
4. it improves a **named coupling/coverage/quality metric** and does not move a pinned observable.

Otherwise **REFUSE**, and route every real defect found along the way to a **minimal fix with its own red gate**
— the pattern the program has already used six times (§10). The desired outcome the task states is REFUSE all
six; this document reaches that outcome on evidence, not on preference.

**Citation key.** `plan:` = `docs/alpha16-agent-execution-plan.md`; `a:` = `docs/alpha16/audit/a-request-path.md`;
`b:` = `docs/alpha16/audit/b-persistence-writers.md`; `c:` = `docs/alpha16/audit/c-concurrency-lifecycle.md`;
`d:` = `docs/alpha16/audit/d-providers-startup.md`; `lead.json:` = `docs/alpha16/audit/lead.json`;
`source-audit.md:` = `docs/alpha16/source-audit.md`. Bare `internal/…` and `GOAL.md:` citations are the tree
itself. `../SillyTavern/…` citations are the pinned oracle.

---

## 2. Decisions table

| id | Candidate (plan §6) | Is there a demonstrated defect a refactor would fix? | Decision | Bounded alternative (not a refactor) |
|---|---|---|---|---|
| **R1** | immutable nested configuration options replacing the flat `HTTPHandlerOptions` (`plan:105`) | **No.** D-H1 is a real confirmed defect, but its cause is the chat-config readers' candidate-derivation helper, which never receives the resolved config path (`pinned_chat_config.go:35-45`), not the option struct; D-H10 is `untested-hypothesis` and its own remedy is a default table | **REFUSE** | thread the resolved config path into the chat config readers for D-H1; fix D-H10 defaults in place if a probe makes them observable |
| **R2** | per-user runtime coordinator for settings saves/backups/timers/child Git (`plan:107`) | **No red test.** The setting-save premise is falsified as parity (C-H2), the timer loss is parity (C-H5), cross-user latency is unmeasured (C-H3); the only actionable items are bounded waits/eviction (C-H6, C-H7, C-H1, C-H8) | **REFUSE** | bound `heartbeat.stop`; bound the second-signal path; sweep rate-limit windows; add the two packages to the `-race` list |
| **R3** | route every mutating route through the shared write layer (`plan:109`) | **No.** 37/56 audited writers already use the shared flock + `atomicReplace`/`atomicCreate` end-to-end; the one data-safety defect (B-H3) was fixed minimally with three red-first tests; B-H4 has no probe and may be pinned interleaving | **REFUSE** | land the B-H4 crash/concurrency probe; only if it shows a Go-only corrupted tree, lock the two recursive routes |
| **R4** | request-scoped cancellation for extension Git and child processes (`plan:111`) | **No.** Pinned `simple-git` has the same 5-minute `timeout.block` and no abort (`../SillyTavern/src/endpoints/extensions.js:17,42`); the "Go kills the child and pinned does not" hypothesis is explicitly falsified by the oracle source (`c:217-223`) | **REFUSE** | none as parity; a request-scoped abort would be a product decision that changes the compatibility claim |
| **R5** | one cache framework for the identity-keyed caches (`plan:113`) | **No.** Three ownership units / four cache rows with different bounds and two eviction rules (whole-map drop for account+settings/world, LRU for card text); every one is tested including its documented same-size+same-mtime residual; no defect spans two caches | **REFUSE** | none required; if C-H11 is ever promoted, add the change stamp per cache, not a framework |
| **R6** | split a concrete cross-domain responsibility out of `internal/server` (`plan:115`) | **No measured seam.** M0/M0b closed the file census with 0 unnamed product-logic files and produced no coupling defect; file count is explicitly not evidence (`GOAL.md:500-508`) | **REFUSE** | none; the source graph (`source-graph.json`) is the input if a measured seam ever appears |

No candidate reaches the IMPLEMENT bar, so the IMPLEMENT deliverables (move-only design, golden table, rollback
plan, coupling metric) are **not** produced for any candidate. §13 records the template so a later proposal is
judged by the same four tests.

---

## 3. The evidence base these decisions rest on

All numbers below are computed from the M0 union, `docs/alpha16/ownership-map.json` (assembled at base commit
`c8472c1` from the five lane fragments plus the Lead fragment), and restated in
`docs/alpha16/source-audit.md`. Where a number is quoted, the source line is named.

| Evidence | Value | Source |
|---|---|---|
| Production Go files (graph) | 296 | `source-audit.md:19` |
| Deep-read by a lane | 106 | `source-audit.md:36` |
| Named by a lane (any depth) | 236 | `source-audit.md:34` |
| Unnamed after M0b | 21 = 17 OS-specific siblings + 4 developer-tooling; **0 product-logic** | `source-audit.md:38-41,43-46` |
| Packages / internal import edges | 40 / 64 | `source-audit.md:19` |
| Hypotheses in the union | 72 = 5 confirmed-defect, 37 verified-risk, 15 untested-hypothesis, 13 intentional-parity, 2 out-of-scope | `source-audit.md:24-28` |
| Writer rows | 67 rows in the union; of the 56 runtime mutating rows, 37 use the shared lock + atomic core end-to-end (46 covered / 10 gap probes) | `source-audit.md:26,76`; `b-persistence-writers.md:143-158` |
| Concurrency entries (independent census) | 66; 21 `sync.Mutex` (13 fields, 8 package-level), 0 RWMutex, 7 timers, 12 `go`, 3 `exec.Command`, 20 `context.Background()` | `source-audit.md:101-105`; `c-concurrency-lifecycle.md` |
| Cache rows | 33 total; four identity-keyed rows in three ownership units (account, settings+world, card text), all carrying the GOAL §15.3 fields | `source-audit.md:118-120`; `c:289-292,592-605` |
| Request-path stages | 45 in the union (19 of them Lane A's) | `ownership-map.json` → `requestPath`; `a-request-path.md` |
| Gate inventory | 13 required same-SHA gates; 8/13 re-demonstrate a named red every run | `source-audit.md:148-150` |
| Provider registry | 26 pinned chat sources; 24 rows + 1 route-level branch implemented; COMETAPI explicit 501 | `source-audit.md:124-125` |
| `HTTPHandlerOptions` | **63 fields**, one translation function | `source-audit.md:127`; `internal/server/http.go:44-136,140-240` |
| Route domain table | explicit; already the ownership inventory | `internal/server/routes_registry.go:36-102,109-113`; `source-audit.md:64`; `plan:21` |
| `internal/server` production files | 187 | `lead.json:140`; verified by count at `0b577de` |

Provenance rule: the map is a snapshot, not a live status board. `docs/alpha16/source-audit.md:8-11` names the
generator and base, and §10 below is the authoritative list of M0 findings that have since been fixed.

---

## 4. R1 — configuration / handler composition: **REFUSE**

**Concern.** Replace the ~60-field flat `HTTPHandlerOptions` with immutable, nested domain options, translated
once from every pinned config value, preserving nil-vs-false and JS truthiness (`plan:105`).

**Evidence for.** The struct is genuinely large and flat: 63 fields (`internal/server/http.go:44-136`), all
translated in one function (`:140-240`) with hand-encoded JS truthiness helpers
(`optionBoolean`/`optionBooleanValue`/`optionNumber`, `http.go:242-277`). Two findings touch it:

- **D-H1 (confirmed-defect, strength 4):** chat-path config readers derive `config.yaml` from the data root and
  its parent rather than from the resolved config path (`internal/server/pinned_chat_config.go:35-45`), so
  `--configPath` (and a non-adjacent `--dataRoot`) silently default every provider-visible key
  (`d-providers-startup.md:409-444`; `lead.json:144`; `lead.json:104`).
- **D-H10 (untested-hypothesis, strength 2):** nine fallback defaults differ from pinned and NaN boolean
  truthiness diverges (`d-providers-startup.md:467`; example at `:376-380`).

**Evidence against.**

- D-H1's cause is **the readers' candidate-derivation helper, which cannot see the resolved config path**, not
  the shape of the options struct. The resolved path exists and wins at boot
  (`internal/commandline/paths.go:101-115`; `internal/app/server.go:158-173`); the fix is to thread it into
  `pinnedConfigCandidates` (`pinned_chat_config.go:35-45`) — a bounded change with one call-site family.
- D-H10's own evidence says the difference is in the **default table**, whose remedy is a table (and a probe),
  not a type nesting.
- A nested-options rewrite is **not move-only**: it touches every handler construction and every field read
  across a 187-file package, and it changes no pinned observable — the plan's own condition for a golden
  behaviour table. No golden table of that breadth exists, and creating one would be the work, not the win.

**Red test status.** D-H1 has **NONE** yet (reproducer plan only: boot with `--configPath` and a requestOverrides
value, assert the peer saw it — `lead.json:111`). D-H10 has **NONE**. Neither red test implicates the options
struct: a red D-H1 test would be fixed in `pinned_chat_config.go`, not by nesting.

**Decision: REFUSE.** Keep the flat struct as a documented boundary. The bounded alternative is D-H1's threading
fix (owner: provider/config lane) plus a D-H10 probe; both are small and both are on the residual list
(`source-audit.md:228`). This matches the Lead disposition at `lead.json:135` and `source-audit.md:201`.

**Bounded alternative detail (not a refactor).** Change: pass the already-resolved config file into the chat
config readers (one field on the per-request context or an explicit argument) so `--configPath` is honoured, no
other reader changes. Gate: one new provider-wire scenario (a `--configPath` boot whose override reaches the
recorded peer) replayed on both subjects. Rollback: one commit. Metric: the number of config-value paths that
re-derive the config file from the data root falls to 0; no change to the 63-field translation function.

---

## 5. R2 — runtime lifecycle: **REFUSE**

**Concern.** Establish ownership and cancellation for throttled settings backups, caches and timed tasks; test
whether unrelated users block on one save mutex, whether backups overrun shutdown, whether Git continues after a
cancelled request; "prefer a simple per-user coordinator over a generic job scheduler, **only if red tests
justify it**" (`plan:107`).

**Evidence for.** The only product-wide save mutex is `settingsSaveMu` on `accountRuntime`
(`internal/server/accounts.go:85-103,96`), held across `saveSettings`' disk write and snapshot
(`internal/server/settings_save.go:50-75`) and the trailing flush (`:77-87`); the trailing snapshot is a detached
`time.AfterFunc` (`:71`); `accountRuntime` has no close path and `RunningServer.Close` only stops the heartbeat
and the servers (`internal/app/server.go:430-446`).

**Evidence against — the decisive part, measured from the oracle source.**

- **C-H2 (intentional-parity, strength 4):** pinned's save is synchronous on the single event loop —
  `writeFileAtomicSync` then `triggerAutoSave`, whose snapshot path is synchronous `fs` calls
  (`../SillyTavern/src/endpoints/settings.js:206-216,118-157,164-201`). Pinned stalls *every* request, not only
  saves; GoTavern's mutex **narrows** the stall to saves (`c-concurrency-lifecycle.md:454-472`). A per-user
  coordinator would be *less* serialized than the oracle.
- **C-H5 (intentional-parity, strength 3):** pinned's `exitProcess` does not flush the lodash throttle either
  (`../SillyTavern/src/server-main.js:316-331`), so the lost trailing snapshot is the same observable
  (`c:505-522`). A shutdown flush would be a new product guarantee.
- **C-H3 (untested-hypothesis, strength 3):** cross-user save latency has **no measurement** — no test drives
  two handles concurrently (`c:474-485`). A refactor cannot cite an unmeasured queue.
- **C-H4 (verified-risk, strength 3):** the flock inside the mutex is a deliberate data-safety addition with a
  bounded 10 s acquisition; pinned has no cross-process lock at all (`c:487-503`). Its cost is a known trade, not
  a defect.
- **Child processes are pinned parity:** `runPinnedGit`/`runPinnedGitIn` use
  `context.WithTimeout(context.Background(), 5*time.Minute)` (`internal/server/extensions_git.go:39-40,56-59,77-80`)
  and pinned's `simple-git` installs the same 5-minute `timeout.block`
  (`../SillyTavern/src/endpoints/extensions.js:17,42`; `c:205-232`). The hypothesis "Go kills the Git child and
  pinned does not" is **falsified by the oracle source** (`c:222-223`).

**Red test status.** NONE for the R2 refactor. The actionable pieces each have a planned (not existing) failing
check, and each is bounded:

- **C-H6 (verified-risk, strength 4):** `heartbeat.stop()` waits on the writer mutex held across `Sync` and then
  on `<-writer.done`, outside the `Close` context (`internal/app/heartbeat.go:77-85,127`;
  `internal/app/server.go:431-433`), so the 10 s deadline never applies. Measured shape: a blocking-FS seam is
  required before a test can observe it (`c:524-533`).
- **C-H7 (verified-risk, strength 3):** a second SIGINT promises "in-flight requests are aborted" but only
  closes listeners (`cmd/gotavern/main.go:367-373`; `c:535-548`).
- **C-H1 (verified-risk, strength 4):** the login/recover/reset and basic-auth rate-limit maps never evict; this
  is the one unbounded map that **diverges** from pinned, whose `RateLimiterMemory` deletes each key on a
  per-key timer (`c:424-452`). Cheapest failing test: 10,000 distinct keys, then assert the map returns to the
  active set.
- **C-H8 (verified-risk, strength 3):** the `-race` gate omits `internal/app` and `internal/lockacquire`
  (`.github/workflows/ci.yml:683`; `c:550-563`).

**Decision: REFUSE.** No red test exists that a per-user coordinator would make pass; two of the three premises
are parity-or-better against the oracle. The four bounded fixes above are the actionable residue, and none of
them needs a scheduler. This upgrades the Lead's M0 `HOLD` (`lead.json:136`, `source-audit.md:202`) to a decision
because the Lane C evidence that was pending is now in and removes the premise.

---

## 6. R3 — persistence consistency: **REFUSE**

**Concern.** Trace all mutating routes and move a behaviour into the existing shared ownership layer when there
is verified duplicated policy or a demonstrated unsafe exception; do not rewrite the atomic-write core
(`plan:109`).

**Evidence for.** The layer is already real and widely used: **37 of 56** audited writer rows use the data-root
flock plus `atomicReplace`/`atomicCreate` end-to-end; the other 19 are stated per row, and "no lock" is not
equated with "not atomic" (`b-persistence-writers.md:143-158`). Two data-safety items exist:

- **B-H3 (verified-risk, fixed — see §10):** `gotavern migrate --force` backed up only `config.yaml` and `data/`
  while truncating a pre-existing `certs/` and third-party overlay in place (`b:325-336`).
- **B-H4 (verified-risk, strength 3):** the two recursive destructive routes run outside the shared content lock
  — `serveUserResetStep2` (`internal/server/account_data_reset.go:107-137`) and the `delete_chats` branch of
  character delete (`internal/server/characters_write.go:874-882`), plus delete-user
  (`internal/server/accounts.go:1340-1345`) — so a save interleaving with a reset can recreate a file inside a
  tree the user asked to be emptied (`b:338-354`, "the largest data-safety gap this lane found").

**Evidence against.**

- B-H3 was closed by a **32-line fix in `internal/migrate/migrate.go` plus three red-first tests**
  (commit `7f91192`; §10), not by routing migrate through the runtime writer layer. A refactor would have been
  strictly larger and would have coupled a one-shot product command to the runtime's per-user lock scope.
- B-H4's counterargument is explicit in the audit: pinned's `fsPromises.rm` is async, so concurrent requests can
  interleave there too; adding the lock could be "safer but different" (`b:347-352`). **What decides it is a
  probe, not an extraction**, and no probe exists (`b:352`).
- The atomic-write core and the lock helpers are on GOAL §15.4's do-not-rewrite list (`GOAL.md:505-508`); the
  plan says not to assume a direct `os.WriteFile` is unsafe where it writes only unpublished staging trees
  (`plan:109`), and the audit confirms several such cases (staged directory copy W13,
  `b:83`; avatar/image atomic-unlocked rows).

**Red test status.** B-H3 **had** three red-first tests, all now green (`internal/migrate/migrate_test.go:645,743`;
commit message `7f91192`). B-H4 has **NONE** (no crash/concurrency probe; `b:352`). So the demonstrated defect is
already fixed by a minimal change, and the remaining gap is an unproven hypothesis.

**Decision: REFUSE.** The bounded alternatives are the B-H4 probe (owner: persistence lane) and, only if it shows
a Go-only corrupted tree, a targeted lock around the two recursive routes — a bounded change, not an extraction.
This resolves the Lead's `HOLD` (`lead.json:137`, `source-audit.md:203`).

---

## 7. R4 — extension execution and isolation: **REFUSE**

**Concern.** Audit `extensions_git.go` (background timeouts), `extensions_fs.go`, `extensions_static.go`,
content discovery and install permissions; use request-scoped cancellation "where observable behavior permits",
retain the pinned Git/user-visible contract, verify no unexpected extension modification or auto-update
(`plan:111`).

**Evidence for.** Child Git work is detached from the request and bounded only by a 5-minute wall clock
(`internal/server/extensions_git.go:39-40,56-59,77-80`); a cancelled browser action leaves Git running to
completion or the bound (`c:211-215`); routes issue up to 8–9 sequential Git commands each (`c:225-228`).

**Evidence against — parity is exact.**

- Pinned's Git client receives `{ timeout: { block: 5 * 60 * 1000 } }`
  (`../SillyTavern/src/endpoints/extensions.js:17,42`); `simple-git` installs a timer that kills the child at
  that bound (`node_modules/simple-git/dist/cjs/index.js:1585-1613`, called at `:4809`, as read in
  `c:217-223`). The candidate hypothesis "Go kills the Git child at the timeout while pinned does not" is
  **falsified by the oracle source** (`c:222-223`).
- Pinned's spawn is not tied to the HTTP request either (`c:371`), and neither implementation serializes per
  repository, so two concurrent updates can collide on Git's own `index.lock` in both (`c:229-232`).
- `extensions_fs.go` and `extensions_static.go` contain no synchronisation, goroutine, timer or `exec` at all
  (`c:238-242`), so there is no in-process isolation defect to move.
- Auto-update is already resolved OFF for every ambiguous input (AGENTS rule 26; P0-C row in `GOAL.md:155`) and
  the pinned extension lock is a page-level asset, not a plugin runtime (hard rule 16 exclusion).

**Red test status.** NONE — and the one hypothesis a refactor would target was falsified by reading the oracle,
not merely unproven.

**Decision: REFUSE as parity.** Request-scoped cancellation would be **safer but different**: it would change
what a user sees after cancelling an extension operation and therefore the compatibility claim. If the product
ever wants it, it is an explicit product decision with its own recorded divergence (AGENTS "Architecture
boundaries" 5), not an M4 refactor. Matches `lead.json:138`, `source-audit.md:204`.

---

## 8. R5 — bounded caches and concurrency: **REFUSE**

**Concern.** Audit `settings_cache.go`, the account cache, character caches and large JSONL paths for lifetime,
owner, same-size replacement, invalidation, cross-account isolation and cold path; no implicit database, no
unbounded buffer, no optimization without a same-run before/after bench and a compatible
provider/browser/disk diff (`plan:113`).

**Evidence for.** There are **three ownership units** of identity-keyed cache (four cache rows: account,
settings aggregation, world-info listing, card text), not one (`c:289-292`; `source-audit.md:118-120`;
`ownership-map.json` → `caches`):

- **account cache:** key = path+mtime+size+ctime(Unix); 256 entries; whole-map eviction
  (`internal/server/accounts.go:294-357`; `a-request-path.md` §6.1).
- **settings/world metadata cache:** key = route kind + data root + handle with a sha256 identity; 64 entries /
  64 MiB; whole-map eviction; same-size+same-mtime residual documented and pinned
  (`internal/server/settings_cache.go:83-86,120-135,188-193`; `a` §6.2).
- **card-text cache:** key = card path + identity; **65536 entries / 64 MiB**, and its eviction is
  **least-recently-used, one entry at a time** (`internal/server/characters_card_cache.go:32-37,82-86,149-184`) —
  a different rule from the other two, chosen because the workload differs.
- The residual same-size+same-mtime window is closed for the account cache with ctime on Unix and documented for
  the other three rows (settings, world-info, card), each pinned by a test (`c:289-292,592-605`; `C-H11`
  verified-risk, strength 2).
- Chat JSONL is not a cache entry at all: saves are full atomic rewrites through `UpdateUserContentFile`
  (`b-persistence-writers.md:95,100`; W20/W25).

**Evidence against.**

- A single framework would have to absorb **three different bounded-eviction rules** (whole-map drop ×2, LRU ×1)
  with different bounds and different measured reasons; the plan forbids exactly this "generic abstraction"
  (`plan:113` is a constraint list, and `GOAL.md:504-508` forbids interface proliferation).
- No defect spans two caches: the residual rows are per-cache, documented, and tested; cross-account isolation is
  keyed by data root + handle in both data caches (`a` §6).
- Merging would not improve any measured metric; the caches' measured benefits are already recorded from their
  own workloads (`accounts.go:240-246`; `settings_cache.go:5-10,56-59`; card-cache measurement in
  `characters_card_cache.go` header).

**Red test status.** NONE that a shared framework would fix. C-H11's residual is pinned by a **green** test that
documents current behaviour, and its promoted fix (add the change stamp) would be per-cache, not a framework.

**Decision: REFUSE; preserve.** Matches `lead.json:139`, `source-audit.md:205`. If C-H11 is ever promoted, the
change is one witness per cache with its own Windows boundary note — a bounded fix.

---

## 9. R6 — explicit domain ownership: **REFUSE**

**Concern.** Split "an actual cross-domain responsibility into a thin domain service behind a concrete, narrow
API"; keep the route-domain table; no new router, no exported ordered-JSON internals, no provider-registry
replacement, no big-bang rewrite; every extraction must reduce the measured dependency/coupling graph and keep a
trivial rollback (`plan:115`).

**Evidence for.** `internal/server` is large — **187 production files** at `0b577de` (`lead.json:140`; verified by
count) — and it owns several domains (HTTP, persistence, providers, extensions, accounts). The source graph
exists: 603 files, 40 packages, 64 internal import edges (`source-audit.md:19`), so a coupling claim can be
measured rather than guessed (`source-audit.md:211-239` names the graph as the input).

**Evidence against.**

- File count is explicitly **not** evidence: "Boundaries are chosen by DATA OWNERSHIP, not by filename"
  (`GOAL.md:502-503`), and the plan says the agent "must decline … when no measurable risk, coupling or
  regression evidence supports it" (`plan:117`).
- The M0b census pass closed the "unknown files" question: all 61 previously unnamed product-logic files were
  named across 22 route families, each with a status; the unnamed remainder is 17 OS-specific sibling files and
  4 tooling files (`source-audit.md:43-46`). The pass produced **no seam**, only one new hypothesis D-H18
  (`source-audit.md:224`).
- The one measured extraction precedent in the tree was **refused with a metric**: ordered-JSON,
  152 files / 1,463 references / 644 `.kind` reads (`GOAL.md:265-268,391-392`) — exactly the semantics §15.4
  protects.
- The route-domain inventory already exists and is the shipped ownership statement
  (`internal/server/routes_registry.go:36-102,109-113`; `source-audit.md:21,64`). It is the seam the would-be
  split would duplicate.

**Red test status.** NONE. No lane produced a measured coupling defect; C-H4/C-H6 (the nearest ownership-adjacent
findings) are bounded-wait issues inside their owners, not cross-domain responsibilities.

**Decision: REFUSE.** Matches `lead.json:140`, `source-audit.md:206`. The metric that would reopen it is defined
in §12 (R6 row).

---

## 10. Findings already fixed minimally in this program — minimal change, not refactor

These fixes are the precedent the decisions rest on: every demonstrated defect was closed by a small, gate-first
change, and **none** required an R1–R6 boundary move. Product fixes changed 21–35 lines in one file each; the
rest changed only tests, fixtures, docs or CI.

| Finding (M0 id) | Fix commit | Change | Red-first / gate evidence | Run id / close record |
|---|---|---|---|---|
| **D-H3** `claude.enableAdaptiveThinking` unread; shipped `false` sent adaptive payload | `60454bc` | `internal/server/claude_chat.go` 35 changed lines; new `pinnedClaudeAdaptiveThinking` (`claude_chat.go:570`) consumed only by the 4-6 clause; base adaptive/fable/claude5 stay unconditional as pinned `:260` | red-first in a detached worktree at `ef41eec`: `TestChatCompletionClaudeAdaptiveThinkingFollowsTheConfig` (`claude_chat_test.go:264`) failed 4 subtests with `thinking:{"type":"adaptive"}`, want `{"type":"enabled","budget_tokens":1024}`; operator-true control passed | recorded discriminating pair: `tests/oracle/sillytavern-1.19.0-provider-wire.json:7795,7994` (commits `dbd32aa`, `fa5385f`) |
| **D-H2** `gemini.apiVersion` unread by MakerSuite generate/status | `1a7b914` | `internal/server/google_chat.go` 21 changed lines; `pinnedGoogleAPIVersion` (`google_chat.go:75`) through the same `pinned_chat_config` path; both URL builders take it; VERTEXAI untouched | red-first at `ef41eec`: `TestGoogleChatAPIVersionFollowsTheConfig` (`google_chat_test.go:264`) failed with `/v1beta/...`, want `/v1/...`, in both generate and status, config and env cases; absent-key case passed on HEAD (default equals pinned) | recorded scenarios `tests/oracle/sillytavern-1.19.0-provider-wire.json:22219,22400`; `docs/config-parity.md` regenerated from `tools/inventories/config-parity.json` |
| **B-H3** `migrate --force` did not back up `certs/` / extension overlay | `7f91192` | `internal/migrate/migrate.go` 32 changed lines: the replaced-path set is every path the run replaces (`migrate.go:441-458`), so `--force` moves them aside; dry-run prints the same set; nested overlay rename creates parents | red-first: `TestForcedMigrationMovesDestinationCertsAndOverlayIntoTheBackup` (`migrate_test.go:645`) and `TestMigrationRefusesDestinationCertsAndOverlayWithoutForce` (`:743`) failed pre-fix with the destination bytes replaced and no `.migrate-backup`; `TestDestinationCertsAreNotAConflictWhenTheSourceHasNone` guards over-refusal; `go test ./internal/migrate -count=1` 13 PASS/1 SKIP | `docs/INSTALLATION.md` updated; commit message carries the red/green evidence |
| **L-H1** stale benchmark baseline (M2/M5 gate red on unchanged product code) | `05479fa` + `39cec62` + `ef41eec` | CI: explicit `update_baseline` dispatch input; baseline regenerated on the Linux runner with its raw run and committed (`tests/perf/bench-baseline.txt:11-12` now records `2026-11-06T04:52:04.438Z`, commit `05479fa…`) | regeneration `GoTavern bench profiles` **42164978648** (`update_baseline=true`, rounds=3); normal comparison **42165562517** at the regenerated tree: `comparison: passed`, `failures: 0`, all 31 benchmarks within −8.1 %…+1.6 % | closed in `docs/alpha16/baseline/README.md:174-196` |
| **Adversarial ratchet port race** (flake blamed the product for a harness precondition) | `98400d6` | test-only: `internal/adversarial/support_test.go:55` makes `freePort` return 0 so the kernel assigns at bind (no reservation window); `startup_cases_test.go:568` `judgeRelativeDataRootFailure` judges the data-root invariant first and classifies a listener-only precondition as not-applicable; five new tests | flake observed: `GoTavern Lane CI` **42162940621** failed `TestAdversarialInvariants` with a listener-in-use message; same code passed **42163485576**; the rework proves a genuine split under a forced collision is still a violation (`TestRelativeDataRootListenerCollisionWithASplitIsStillRed`) | `go test ./internal/adversarial -count=1` 35 cases / 29 held / 0 violated / 6 n/a, four consecutive runs green (commit message) |
| **M2 harness fixes** (E03+E04 browser journey: harness, not product) | `0b3021b`, `375dc8e`, `6332ef2`, `f22cd1b`, `5262039`, `0b577de` (+ ingredient kits `71dd7b8`) | **zero Go delta** across `0b3021b..0b577de`; each of the six commits touches only `tests/browser/**` and `.github/workflows/combination-journey.yml` (per-commit check) | each commit names a harness defect against a real dispatch: preset not applied → `42173399186`; three comparator expectation defects + save race → `42178757887`; leg abort + group-chat path → `42182251438`; prompt-replacing extension takeover + real import dialog → `42186322374`; send-blocking overlay → `42193009501`. Every one states "not a product finding" | commits + workflow runs; the gate's selftest teeth were extended in each commit (`tests/browser/combination-journey-gate-selftest.mjs`) |

**What this table establishes for §2:** the defects the audit proved were **local**: a missing reader, a hardcoded
constant, an incomplete conflict set, a stale gate input, a harness race. Each was fixed without a new package,
interface, router, database or coordinator. The architecture therefore does not stand in the way of defect fixes;
the audit has not produced the class of defect that a boundary move would remove. That is the evidence-based
reason all six candidates are refused.

**One stale-artefact caveat, stated so it is not mistaken for an open defect.** `ownership-map.json` and
`source-audit.md` rank D-H3, D-H2, B-H3, L-H1 as findings because they were assembled at `c8472c1`; the fixes
landed after. The M0 map remains the correct *evidence base* for these decisions (its counts and citations are
what was audited), but its `classification` fields are not a live bug list. The authoritative current status is:
D-H3 fixed, D-H2 fixed, B-H3 fixed, L-H1 closed; D-H1, C-H1, C-H6, C-H7, C-H8, B-H4 and the evidence gaps in
§11 remain open.

---

## 11. Residual risks and open bounded work (no refactor selected)

No M4 refactor is selected. The following real work remains and is **not** a refactor; each item names its owner
class and the evidence that keeps it open.

| Item | Status / evidence | Bounded follow-up |
|---|---|---|
| **D-H1** `--configPath` ignored by chat config readers (confirmed-defect, strength 4) | Unfixed: `pinned_chat_config.go:35-45` still derives from the data root; `lead.json:111` is the reproducer plan | thread the resolved config path (R1 bounded alternative, §4) |
| **C-H1** rate-limit maps never evict (verified-risk, strength 4) | No test; mechanism at `accounts.go:115-200`, `basic_auth.go:20-98`; pinned evicts per key (`c:424-452`) | 10k-distinct-key test, then a bounded sweep |
| **C-H6** unbounded graceful-shutdown wait (verified-risk, strength 4) | `heartbeat.go:77-85,127`; needs a blocking-FS seam (`c:524-533`) | seam + bounded `stop` |
| **C-H7** second signal does not force-close in-flight requests (verified-risk) | `cmd/gotavern/main.go:367-373` (`c:535-548`) | close connections or correct the message |
| **C-H8** `-race` list omits `internal/app`, `internal/lockacquire` (verified-risk) | `.github/workflows/ci.yml:683` (`c:550-563`) | add the packages |
| **B-H4** recursive destructive routes outside the content lock (verified-risk) | No probe (`b:338-354`) | crash/concurrency probe on both subjects; lock only if Go-only corruption is shown |
| **A-H1/A-H2/A-H3/A-H5** request-path divergences (verified-risk/untested) | Need one account/CORS probe extension (`a-request-path.md` §7; `source-audit.md:228`) | record pinned, then fix or record as product decision |
| **C-H11** cache residual (verified-risk, strength 2) | Documented + pinned by tests (`c:592-605`) | per-cache change stamp only if promoted |
| **D-H17** tokenizer cache write non-atomic (verified-risk) | `internal/server/tokenizers.go:377-390` (`b:381-382`) | atomic write; derived cache |
| **L-H4 / A-H13** `/proxy/:url(*)` unimplemented and absent from the route table (verified-risk) | `lead.json:117-132`; `source-audit.md:191,239` | assign an owning milestone; inventory must see direct `server-main.js` routes |
| Baseline scope after L-H1 closure | cold-guard row absent; 30–60 min soak CI-PENDING (`docs/alpha16/baseline/README.md:190-196`) | M5 work, not M4 |

None of these justifies an architecture boundary move: each is a bounded behaviour fix, a probe, or a gate
amendment at the site its owner already lives in.

---

## 12. What would change a decision (falsifiers, metrics, thresholds)

These are the **only** conditions under which the corresponding candidate would be reopened. They are written as
measurements so a future round cannot re-litigate the decisions with prose.

- **R1** → only if a golden behaviour table of the 63 fields shows translation defects that **cannot** be fixed
  inside `HTTPHandlerOptionsFromCommandLine` (`http.go:140-240`), or if D-H1/D-H10's fixes require touching so
  many call sites that a single translation point is cheaper. Threshold: the fix touching >1 field-translation
  site per defect is still a local fix; a nested-options proposal must show a diff smaller than the alternatives.
  Today neither defect implicates the struct.
- **R2** → only with a same-host, same-input measurement showing GoTavern's **p99 save latency exceeds pinned's
  own save block** (C-H3's acceptance: `c:481-485`), or a measured production configuration where C-H1's map
  growth is material. Even then the Lead's stated preference is a per-user map change, not a scheduler
  (`lead.json:136`).
- **R3** → only if the B-H4 probe shows a corrupted/partially-surviving tree on GoTavern that pinned does not
  produce on the same interleaving, **and** at least one more writer family shows the same unsafe pattern (so it
  is a policy, not an exception). A single route is a bounded fix.
- **R4** → never as an architecture change: request-scoped abort is a **product decision** that changes the
  observable after a cancelled extension operation and must be recorded as a deliberate divergence. The oracle
  shows no behavioural defect.
- **R5** → only if a single measured defect (stale read, memory bound, latency) spans ≥2 of the three ownership
  units and cannot be fixed per cache; any proposal must carry a same-run before/after bench per GOAL §15.2.
  Current evidence: two eviction rules with different bounds, zero shared defects.
- **R6** → only with a **measured coupling metric** from the generated graph: a named responsibility whose
  removal reduces the package import-edge set involving it (64 edges baseline, `source-audit.md:19`) or the
  change-coupling count over a stated commit window, plus a move-only diff with a trivial rollback and a golden
  table. The ordered-JSON precedent shows the bar: 152 files / 1,463 references was refused (`GOAL.md:265-268`).

---

## 13. IMPLEMENT template (unused by this round)

No candidate is selected, so no design is proposed. For consistency, a future IMPLEMENT proposal must supply all
four, in this shape:

1. **Move-only design.** Named source and destination of one responsibility, the exact symbols moved, the diff
   touched-file count, and confirmation that no pinned observable changes. No new interfaces beyond the one
   concrete seam; no router/database/job-queue additions.
2. **Green differential/golden table.** The existing gates that must stay green, plus a new golden behaviour
   table (for R1-style changes) or a recorded diff (for persistence/route changes) with a demonstrated negative
   control: the table is mutated, the named assertion goes red, the mutation is restored, the run is green. A
   gate that cannot fail is not acceptable (AGENTS verification rule 4/7).
3. **Rollback commit plan.** One commit, move-only, revertable by `git revert` with no data migration; any
   persisted-state change must be additive and hand-back safe.
4. **Coupling/coverage metric it must improve.** Stated before the change, measured after on the same runner and
   tree: import edges, file count reached by the seam, p50/p95 latency, allocations, or lock-wait — with the
   measurement plan and the acceptance direction. "The file is shorter" is not a metric.

---

## 14. Provenance and how to check this document

- This file: documentation only; no product/test/fixture/config/workflow edit, no git command, no dispatch by
  this task. The tree read is `0b577de`; the only intended write is this file.
- M0 union and counts: `docs/alpha16/ownership-map.json` (`baseCommit` `c8472c1`), regenerable with
  `node tools/alpha16-graph/assemble.mjs --out docs/alpha16/ownership-map.json`
  (`docs/alpha16/source-audit.md:242-247`).
- Per-candidate evidence lives in `docs/alpha16/source-audit.md` §8 (dispositions, lines 194-209) and the lane
  reports `docs/alpha16/audit/a-request-path.md` (§7), `b-persistence-writers.md` (§2, B-H3/B-H4, lines
  143-158,325-354), `c-concurrency-lifecycle.md` (§5, lines 424-614), `d-providers-startup.md` (§4.4/4.5,
  lines 391-467), `lead.json` (`refactorCandidates`, lines 134-141).
- The minimal fixes and their red-first evidence are the commits named in §10; the run ids are quoted from those
  commits and `docs/alpha16/baseline/README.md:174-196`.
