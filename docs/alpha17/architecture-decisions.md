# alpha.17 — architecture decisions (R1–R6 re-evaluated, all REFUSE)

**Status: DRAFT (decision record; no refactor implemented).** This file re-evaluates the six architecture
candidates R1–R6 from the alpha.16 programme against the **current tree**, using the same four-condition rule
the round inherits from `GOAL.md` §15.4 and the alpha.16 M4 record
(`docs/alpha16/m4-refactor-decisions.md`). The default is `REFUSE`: a boundary move reopens only when a
**real, replayable RED** exists whose root cause is in the proposed ownership boundary, the change is
move-only/revertible, and a named coupling/performance/resource/safety metric improves.

**The four reopening conditions (all required).**

1. A real, replayable RED exists — an executed failing test/measurement, not a suspicion.
2. The RED's root cause is inside the proposed ownership boundary (not a missing reader, a hardcoded
   constant, a stale gate input or a harness race).
3. The change is move-only, shippable and revertible, and it does not change pinned-observable behaviour.
4. A named metric improves: package import-edge set involving the boundary, change-coupling over a stated
   commit window, p50/p95/p99 or RSS/allocations on a stated input, resource bounds, or a safety invariant.

If any condition is unmet, the disposition stays `REFUSE` and any real defect found along the way goes to a
**minimal fix with its own red gate** — never a refactor.

## 0. Measurements re-taken at HEAD (`c02eed109ceba32ba710948a0420425f8ce58b1f`)

Every number in this file was re-measured on the current tree; alpha.16's numbers are quoted only where they
are the historical record the decision rests on.

| measurement | value at HEAD | command |
|---|---|---|
| internal packages | **18** | `go list ./internal/...` |
| internal package import edges (unique, first-party) | **20** | `go list -f '{{.ImportPath}} {{range .Imports}}{{.}} {{end}}' ./internal/...` then count `internal/*` edges |
| files in `internal/server` that mention ordered-JSON (`orderedNodeJSON`/`orderedJSON`) | **115** of 187 production files | `Select-String -Path <prod files> -Pattern 'orderedNodeJSON\|orderedJSON'` |
| ordered-JSON references in `internal/server` production files | **1,290** | same grep, match count |
| ordered-JSON private-member reads (`.kind` / `.array` / `.scalar`) | **578 / 566 / 140** | same grep per pattern |
| call sites of the shared atomic-write helpers across `internal/` production files | **43** in **20** files | grep for `WriteFileAtomic(`, `SaveSettings(`, `atomicReplace(`, `atomicCreate(` |
| alpha.16 historical ordered-JSON measurement (program base) | 152 files / 1,463 refs / 644 `.kind` / 605 `.array` / 156 `.scalar` | `docs/alpha16/m4-refactor-decisions.md` §11; **superseded by the HEAD row above** (the tree moved) |

The alpha.16 fixes that removed the only actionable premises of some candidates are present at HEAD and were
re-verified by reading current code, not by quoting the fix commits:

- **D-H1** `--configPath` reachable: `internal/server/pinned_chat_config.go:65-67` (`pinnedConfigCandidates`
  returns the explicit config file first) — commit `acad078`.
- **D-H2** `gemini.apiVersion` read: `internal/server/google_chat.go:75-76,211,464` — commit `1a7b914`.
- **C-H1** limiter eviction: `internal/server/accounts.go:122-160` (`memoryLoginLimiter.pruneLocked`, the
  pinned expiry FIFO) — commit `a2fc2e5`.
- **C-H6** bounded heartbeat stop: `internal/app/heartbeat.go:24,119-128` (`ErrHeartbeatStopTimeout`) —
  commit `a2fc2e5`.
- **C-H7/C-H8** corrected second-signal message and `-race` package list — commit `a2fc2e5`.
- **D-H17** atomic tokenizer cache write — commits `2b43f33`, `0e3bec1`.
- **B-H3** `migrate --force` backs up `certs/` and the extension overlay — commit `7f91192`.
- **B-H4** reset-vs-save probe: pinned-parity interleaving, **no lock added** because no Go-only corruption
  was shown (`docs/alpha16/storage-probe.md` §2); unchanged at HEAD except the Windows-only residual.
- **L-H1** benchmark baseline regenerated (`tests/perf/bench-baseline.txt`), gate green on the Linux runner.

## 1. Decision table

| id | candidate | current evidence | decision | bounded follow-up (not a refactor) |
|---|---|---|---|---|
| **R1** | immutable nested configuration options replacing the flat `HTTPHandlerOptions` | D-H1 is fixed by threading the resolved config path (`pinned_chat_config.go`), and D-H2/D-H3 by reading the two keys through the same path. The translation remains one function with tested truthiness rules. No new RED in alpha.17's audit. | **REFUSE** | none; if a new provider-visible key is unread, fix that key through `pinned_chat_config`'s existing view |
| **R2** | per-user runtime coordinator for settings saves/backups/timers/child Git | C-H1/C-H6/C-H7/C-H8 are closed by bounded fixes; the 8-user row is REPORT-ONLY because its same-code spread (1.95×/2.29× p95) tracks host storage tail, not code; no cross-user p99 RED vs pinned exists. | **REFUSE** | keep the row report-only; the named next step is a same-host paired design, not a scheduler |
| **R3** | route every mutating route through the shared write layer | The shared write layer already has **43 call sites in 20 production files**; 37/56 audited writers already use flock + `atomicReplace`/`atomicCreate` end-to-end; B-H3 fixed and B-H4 shown pinned-parity. No Go-only data-destruction RED. | **REFUSE** | the B-H4 Windows residual stays a documented boundary, not a reason to lock two routes |
| **R4** | request-scoped cancellation for extension Git and child processes | Pinned `simple-git` has the same 5-minute `timeout.block` and no abort (`../SillyTavern/src/endpoints/extensions.js:17,42`); a request-scoped abort would be **safer but different**, i.e. a product decision that changes the observable after a cancelled extension operation. No behaviour defect at the oracle. | **REFUSE as parity** | if a product decision ever wants abort, it must be recorded as a divergence and gated on both subjects |
| **R5** | one cache framework for the identity-keyed caches | Three ownership units with different bounds and two eviction rules (whole-map drop for account/settings/world; LRU for card text), each tested including its own documented same-size+same-mtime residual. No defect spans two caches. | **REFUSE** | only if one defect is shown across ≥2 caches; the bounded alternative is a per-cache change stamp, not a framework |
| **R6** | split a concrete cross-domain responsibility out of `internal/server` | No measured coupling defect: 18 internal packages / 20 first-party import edges at HEAD; the ordered-JSON coupling is **115 files / 1,290 references** and 1,284 private-member reads — a move-only extraction does not exist without exporting the semantics `GOAL.md` §15.4 marks do-not-rewrite. The file count is explicitly not evidence. | **REFUSE** | the source graph (`docs/alpha17/source-graph.json`) is the input if a measured seam ever appears |

## 2. Why "no measured seam" is the right conclusion, not a lack of imagination

The coupling metric that would reopen R6 is stated and measurable: a named responsibility whose removal
reduces the import-edge set involving `internal/server` (20 first-party edges at HEAD) or the
change-coupling count over a stated commit window, plus a move-only diff with a trivial rollback and a
golden behaviour table. Alpha.16's M0/M0b audit named every product-logic file (296 at the time) and produced
no such row; alpha.17's re-audit has not produced one either. The strongest extraction precedent in the tree —
`orderedjson` — is **refused with a metric**, and the HEAD re-measurement (115 files / 1,290 references /
1,284 private-member reads) is *not smaller* than alpha.16's, so the argument is stronger now, not weaker.

## 3. What would change a decision (falsifiers, stated as measurements)

- **R1** reopens only if a golden table of the 63 translated fields shows defects that cannot be fixed inside
  `HTTPHandlerOptionsFromCommandLine`, or if D-H1/D-H2-style fixes require touching so many call sites that
  one translation point is demonstrably cheaper (a diff smaller than the alternatives).
- **R2** reopens only with a same-host, same-input measurement where GoTavern's p99 save latency exceeds
  pinned's own save block on a host whose storage fingerprint is stable, or material rate-limiter growth.
- **R3** reopens only if a crash/concurrency probe shows a corrupted or partially surviving tree on GoTavern
  that pinned does not produce on the same interleaving, **and** at least one more writer family shows the
  same unsafe pattern (a policy, not an exception).
- **R4** never reopens as an architecture change: request-scoped abort is a product decision that changes the
  observable after cancellation and must be recorded and gated as such.
- **R5** reopens only if a single measured defect (stale read, memory bound, latency) spans ≥2 of the three
  ownership units and cannot be fixed per cache; any proposal carries a same-run before/after bench.
- **R6** reopens only with the measured coupling metric above plus a move-only diff and a golden table; the
  ordered-JSON precedent sets the bar.

## 4. Relationship to the M4 milestone box in `GOAL.md`

`GOAL.md` §12.1 keeps M4 **unticked by decision** because the milestone as written named three extractions
(`orderedjson` → `httpx` → `userdata`). Two landed move-only (`internal/httpx`, `internal/userdata`); the
third is refused with a metric and the route table landed separately (`8eca43b`). Alpha.17 does not change
that record: it re-measures the refusal and adds no new boundary move. A reader should treat M4 as
**PARTIAL, closed by decision** — the "unticked" state is the honest label for a milestone whose written form
was not fully met, not an open refactor invitation.
