# alpha.16 — program index and M0 audit contract

**Status: M0 (read-only audit) IN PROGRESS.** Plan: [`docs/alpha16-agent-execution-plan.md`](../alpha16-agent-execution-plan.md).
Baseline: pinned SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127`; program base `main@c256f21`
(plan document merged, 2026-11-06). Working lane: `lane/alpha16-program`.

This file is the contract for the M0 audit. It exists so that every lane writes the same machine-readable
shape, a reader can tell a confirmed defect from an untested hypothesis, and the final `source-audit.md` /
`ownership-map.json` are assembled from committed fragments rather than from prose written at the end.

## 1. Hard rules for M0

1. **Read-only.** M0 may not change product behaviour, tests, fixtures, workflows or config defaults. The only
   files an M0 lane writes are its own `docs/alpha16/audit/**` files. No `git add`, no commit, no push by a lane.
2. **No "fix while reading".** A defect found in M0 gets a named hypothesis row with a file:line and a
   planned reproducer. The fix is a later, separate change with a failing-then-passing gate.
3. **Cite or it did not happen.** Every claim carries `file:line` against the current tree, or a pinned
   upstream `SillyTavern/src/...:line`. A claim without a citation is `developer inference` and must be labelled.
4. **A negative finding needs a direct query** (`AGENTS.md` rule 11): "no lock in X" is evidence only after
   grepping X for the lock symbol, not after reading the first N lines of it.
5. **Classify, do not flatten.** Every finding is exactly one of:
   `confirmed-defect`, `verified-risk`, `untested-hypothesis`, `intentional-parity`, `out-of-scope`.
   "Probably fine" is `untested-hypothesis` and says what would decide it.
6. **Distinguish surfaces.** A finding names its observer surface: browser→server wire, server→provider wire,
   streaming/cancel sequence, DOM/events, filesystem/persisted bytes, startup state, or performance.
7. **The plan's M0 words win.** "All owned Go production files" is met by mechanical coverage (every
   production file appears in `source-graph.json` with its imports/state/writes extracted) plus deep reading of
   every critical owner with citations. A file that was only mechanically covered is listed as such; claiming
   a deep read that did not happen is a report defect.
8. **The existing audit is current until proven otherwise.** `docs/audit-v0.1.0-alpha.15.md` (80 rows) audited
   this same tree at the alpha.15 release commit. M0 re-verifies rows that matter to its findings instead of
   re-deriving them, and records the re-verification (file:line) rather than quoting the old row.
9. **No live egress.** M0 reads source and runs only local, read-only analysis. No provider call, no pinned
   Node boot, no browser, no network.

## 2. Deliverables

| Artefact | Writer | Content |
|---|---|---|
| `docs/alpha16/source-audit.md` | Lead | The report: scope, coverage census, request path, write/async/dependency summaries, the five strongest reproducible defects/hypotheses with priority, refactor counterarguments, residual unknowns |
| `docs/alpha16/ownership-map.json` | Lead | Machine-readable union of the lane fragments (schema below) |
| `docs/alpha16/source-graph.json` | Lead (`tools/alpha16-graph`) | Per-file AST facts: package, imports, top-level decls, locks, goroutines, timers, writes, exec, http, atomic ops; package dependency edges |
| `docs/alpha16/audit/a-request-path.md` + `fragments/a.json` | Lane A | CLI→startup→middleware→account/session/CSRF→route→handler→response, accountRuntime/cache ownership |
| `docs/alpha16/audit/b-persistence-writers.md` + `fragments/b.json` | Lane B | Writer matrix, startup mutations, migration/rollback, path policy, atomicity, corruption probes |
| `docs/alpha16/audit/c-concurrency-lifecycle.md` + `fragments/c.json` | Lane C | Lock/goroutine/timer/child-process map, shutdown/cancellation, cache discipline |
| `docs/alpha16/audit/d-providers-startup.md` + `fragments/d.json` | Lane D | Provider wire/framing/streaming/cancel, registry, tokenizers, config→options translation |
| `docs/alpha16/audit/e-gates-harness.md` + `fragments/e.json` | Lane E | Gate inventory, harness/probe/corpus inventory, negative-control status, E03+E04 reuse plan, baseline measurement plan |
| `docs/alpha16/first-scenario-design.md` | Lead + Lane E | The first E03+E04 combined browser scenario and how existing harness is reused |
| `docs/alpha16/baseline/` | Lead | Resource baseline: commit/Go/OS/CPU/RAM provenance, cold/warm boot, RSS/heap/CPU/p50-p95-p99/allocs, pprof/trace, extension-heavy boot, provider relay |

## 3. Fragment JSON schema (all lanes)

`schemaVersion: 1`. Unknown extra keys are allowed, but a lane must not rename these.

```json
{
  "schemaVersion": 1,
  "lane": "A",
  "title": "request path and account/session layer",
  "commit": "<40-char sha the lane read>",
  "filesInspected": [
    {"path": "internal/server/http.go", "kind": "production|test|driver|workflow|pinned|doc", "depth": "deep|mechanical", "why": "HTTPHandlerOptions and mux composition"}
  ],
  "packages": [
    {"path": "internal/server", "role": "HTTP surface and persistence", "entryPoints": ["internal/server/http.go:44"],
     "stateOwners": ["accountRuntime internal/server/accounts.go:85"], "outbound": ["internal/outbound"],
     "writablePaths": ["<dataRoot>/settings.json"], "failRetry": "per-route"}
  ],
  "requestPath": [
    {"stage": "cli-parse", "source": "internal/commandline/cli.go:120", "notes": "pinned flag parsing"}
  ],
  "writers": [
    {"surface": "settings-save", "route": "POST /api/settings/save", "writer": "internal/server/settings_save.go:120",
     "lock": "settingsSaveMu internal/server/settings_save.go:50", "atomicity": "atomicReplace ...",
     "pathPolicy": "...", "errorShape": "...", "probe": "internal/server/settings_save_test.go:44", "probeState": "covered|gap"}
  ],
  "concurrency": [
    {"id": "settings-save-mu", "kind": "mutex|rwmutex|goroutine|timer|child-process|global-cache|atomic",
     "source": "internal/server/settings_save.go:50", "owner": "accountRuntime?", "lockOrder": ["..."],
     "cancellation": "context.Background at ...", "shutdown": "...", "contention": "cross-user?"}
  ],
  "caches": [
    {"name": "card-text-cache", "key": "...", "value": "...", "owner": "...", "lifetime": "...", "capacity": "...",
     "eviction": "...", "invalidation": "...", "externalMod": "...", "concurrency": "...", "rebuild": "...",
     "fallback": "...", "measuredBenefit": "docs/perf-baseline.md §10.4"}
  ],
  "hypotheses": [
    {"id": "A-H1", "title": "...", "classification": "confirmed-defect|verified-risk|untested-hypothesis|intentional-parity|out-of-scope",
     "surface": "provider-wire|persisted-bytes|startup-state|browser-wire|dom-events|performance",
     "evidence": ["internal/server/x.go:10", "internal/startup/y.go:20"],
     "impact": "user-visible|data-safety|concurrency|performance|maintainability",
     "reproducer": "existing test path, or NONE", "reproducerPlan": "the smallest failing check that would confirm it",
     "strength": 1, "counterargument": "why this might not be a defect / what would falsify it"}
  ],
  "questions": ["what the lane could not decide and who/what can"]
}
```

`strength` is 1–5: 5 = already reproduced or source-proven with a user-visible consequence; 4 = source-proven,
reproducer obvious; 3 = strong hypothesis with one unknown; 2 = plausible, needs a probe; 1 = suspicion.

## 4. Lanes, ownership and write scopes

One lane per area; write scopes are disjoint and advisory (the Lead reviews the union).

| Lane | Area | Write scope |
|---|---|---|
| Lead | program contract, AST graph, assembly, five top findings, refactor counterarguments, scenario design | `docs/alpha16/README.md`, `docs/alpha16/source-audit.md`, `docs/alpha16/ownership-map.json`, `docs/alpha16/source-graph.json`, `docs/alpha16/baseline/**`, `docs/alpha16/first-scenario-design.md`, `docs/alpha16/audit/lead.json`, `tools/alpha16-graph/**` |
| A | request path, middleware, accounts/session/CSRF, settings save/backup, caches owning identity | `docs/alpha16/audit/a-request-path.md`, `docs/alpha16/audit/fragments/a.json` |
| B | persistence/writers, startup mutations, migration/rollback, path policy | `docs/alpha16/audit/b-persistence-writers.md`, `docs/alpha16/audit/fragments/b.json` |
| C | concurrency/lifecycle, locks, timers, child processes, caches | `docs/alpha16/audit/c-concurrency-lifecycle.md`, `docs/alpha16/audit/fragments/c.json` |
| D | providers/transport/streaming, tokenizers, config→option translation | `docs/alpha16/audit/d-providers-startup.md`, `docs/alpha16/audit/fragments/d.json` |
| E | gates, workflows, probes, corpora, negative controls, baseline measurement design, E03+E04 reuse | `docs/alpha16/audit/e-gates-harness.md`, `docs/alpha16/audit/fragments/e.json` |

## 5. What "five strongest" means

The audit's headline list is not "five interesting files". A row qualifies by, in order: (a) a user-visible or
data-safety consequence; (b) a reproducer that can be made to fail for that reason; (c) a source citation that
names the owner and the wrong behaviour; (d) a counterargument that was considered. Performance-only rows
qualify only with a before/after measurement plan on the same input. Refactor proposals are not findings: they
belong in the counterargument section and must say which measured coupling or risk they would remove.

## 6. Exit criteria for M0

- `source-graph.json` covers every owned `.go` production file and every first-party script/driver group.
- Every critical mutation (writer) and every captured concurrency primitive has an owner and a source citation.
- The five-strongest list is reproducible-or-source-proven, ranked, with counterarguments.
- The first E03+E04 scenario is specified against the existing harness with named reuse points and the
  negative control that would make it fail.
- The baseline is recorded with provenance and raw artifacts (or explicitly marked `LOCAL-ONLY` / `CI-PENDING`
  with the workflow that will produce the gate run).
- A reader can answer "who owns this mutation, what protects it, and which test proves it" for every row.
