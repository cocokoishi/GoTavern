# alpha.16 — Adversarial multi-environment qualification and evidence-driven architecture program

> **Status: PROPOSED AGENT EXECUTION PLAN, NOT AN IMPLEMENTED FIX OR A RELEASE.** Prepared against main at 8f529cda4192acda680000f8c5fb4a025e27bfcc (2026-11-06). This document is a work order. It is deliberately separate from GOAL.md, the released alpha.15 tag and the current release manifest. All implementation decisions require the full M0 audit, executable red/green evidence and the pinned oracle.
>
> **Owner instruction:** The coding agent should undertake the entire program rather than merely generate a large static fixture. Its objective is to create self-built, highly interactive, long-running SillyTavern installations, use those installations to discover real GoTavern failures, and refactor only the ownership boundaries supported by that evidence. No arbitrary mass rewrite and no self-reported “passed” without replayable artifacts.

## 0. Invariants — do not compromise

1. SillyTavern 1.19.0 at 06bde939fb1e9c4c8d8641d810f0a916b5bce127 remains the normative oracle. Read GOAL.md, AGENTS.md, ARCHITECTURE.md, HANDOFF.md and the live scorecard first. Prefer observed pinned Node behavior over assumptions.
2. Keep the **unmodified** pinned frontend, same config.yaml and data/ layout, unknown-field preservation, migration/rollback, Node → Go → Node hand-back, same provider-wire request, streaming/cancellation and visible frontend behavior. The normal product must remain a prebuilt single Go executable, without Node/npm/Python requirements.
3. Treat arbitrary Node server plugins as an explicit exclusion, not an opportunity to fake a working endpoint. Client extensions run their actual pinned JS code, never a harness reimplementation.
4. Use synthetic, SFW data only. Do not import private user content, live secrets or untrusted external downloads at test runtime. Pin all client extensions by commit/hash; use local mirrors and a local mock/recording provider.
5. Preserve alpha.15 tags, artifacts and existing gates. Do not silently change a passing comparator, remove a negative control, normalize away duplicate messages or update oracle snapshots to make a regression disappear.
6. Follow AGENTS.md CI-first, branch-merge, no-PR workflow. Each coherent behavioral change gets its own reproducible failing test, focused code diff, Linux CI and run IDs. Do not publish alpha.16 until release qualification is finished.

## 1. The repository actually has mature machinery — extend it

The current relevant topology, inspected at the planning commit:

- internal/server is 376 files and roughly 4.7 MB of source, with route-specific behavior and a large accountRuntime; do **not** assume splitting by filenames or adding interfaces improves it.
- internal/server/http.go has HTTPHandlerOptions with configuration values and test injection hooks; accounts.go:85-103 holds accountRuntime with authentication, recovery, settings-save and cachebuster state; routes_registry.go already contains an **explicit** route domain table. Do **not** repeat the completed init-registrar migration.
- internal/startup/user_content_file.go supplies a per-user locked, containment-checked atomic update; internal/startup/user_data_lock.go owns lock scope; characters_write.go:1120-1163 already stages directory copies. Prove gaps before changing these safety-critical pieces.
- internal/server/settings_save.go:50-87 holds settingsSaveMu while calling disk persistence and manages a time.AfterFunc backup timer; extensions_git.go:54-94 executes Git with a context.Background-based timeout. These are **audit candidates**, not proven defects: test cross-user contention, shutdown/cancellation and actual upstream semantics before redesign.
- internal/server/chats.go:16-23 explicitly records missing chat-backup throttle and integrity side effects. Investigate whether the multi-environment journey makes these gaps product-visible.
- internal/server/settings_cache.go owns identity-keyed caches; preserve exact byte responses and investigate external replacement / stale identity as a measured hypothesis.
- internal/server/chat_completions.go and the registry plus internal/outbound own tested provider semantics. Preserve full request/response framing, redirect credential-stripping and 20-hop behavior from alpha.15.
- internal/longlivedfixture/longlivedfixture.go already builds a deterministic 169-file, 29.29 MB complex tree; tools/build-longlived-corpus.mjs builds the separate browser corpus. corpus_schema.go and tools/longlived/compare-corpora.mjs document **two corpora sharing one schema**, not byte equality.
- tests/browser/combination-journey-probe.mjs already combines card, preset, world book, helper, Quick Reply, regex, streaming, reload, restart, group and hand-back. tests/browser/third-party-extensions-run.mjs and extension-corpus-probe.mjs already exercise 20 genuine pinned client extensions. **Reuse these, add one orchestrator and one scenario contract; avoid a third incompatible fixture/test framework.**
- HANDOFF.md identifies the browser conversation-editing race, Moving UI/image-editor probe gap, uncontrolled page-init egress, F17 comparator classification, macOS ARM64 runner blocker and the private-real-tree boundary. Keep their states truthful.

These entries are navigation and refactor hypotheses, **not** a claim that a whole-repository deep source audit has been completed.

## 2. M0 — mandatory full-code and behavior audit BEFORE product refactoring

M0 is read-only and may not “fix while reading”. Inspect **all owned Go production files, first-party build/CI scripts, browser/e2e test drivers, config/startup/migration code and their applicable tests**. Inventory the pinned upstream files that define each behavior. Binary assets, generated bundles, copied upstream vendor libraries and large frozen JSON fixtures are to be hash/inventory-checked and read only where they govern a tested contract.

Produce docs/alpha16/source-audit.md and a machine-readable docs/alpha16/ownership-map.json with:

- Each package/domain; its entry points, imports, state owner, initialization/shutdown lifetime, outbound calls, writable data paths and fail/retry rules.
- The entire request path: CLI parse → startup/config → middleware and route dispatch → account/session/CSRF → persistence or provider adapter → response/stream → browser or extension.
- A writer matrix covering settings, character PNG/v2/v3, JSONL chat, group chat, world info, personas, Quick Replies, presets, secrets, plugin trees, caches and migration. For every writer: expected behavior, lock, atomicity, path traversal/symlink policy, observable errors, corruption/rollback probe.
- A concurrent-state map: every mutex/global cache/timer/goroutine/child process, lock order, its owner, cancellation on request and shutdown, and inter-user contention. Include known exceptions and unsupported semantics.
- The dependency and data-flow graph (Go AST or equivalent, no hand-waved counts), source file:line for each issue, and a classification: confirmed defect / verified risk / untested hypothesis / intentional parity / out of scope.
- Before/after baseline for RSS, peak heap, CPU, p50/p95/p99, allocations, lock/block profiles, goroutine/process counts, cold boot, extension-heavy boot and real provider relay; keep raw pprof/trace and env provenance.
- A counterargument for every proposed extraction: why does it clarify data ownership, remove duplicated policy or improve verified isolation, rather than add indirection? Explicitly respect GOAL.md §15.4’s do-not-rewrite list, especially ordered JSON, tokenizers, provider codecs, atomic-write/lock core, migration and fixed frontend.

**M0 exit:** a reviewer can locate the exact owner and tests for every critical mutation and every proposed seam; no code changes occur merely because a file is long or a struct has many fields.

## 3. M1 — agent-built scenario factory, not one oversized static snapshot

Build a deterministic, hermetic scenario recipe system **on top of** the existing two corpora and their shared schema. Each scenario declares seed, environment class, user accounts, cards, chats, prompts, books, extensions (name + pinned SHA), actions, faults, target observables and resource bounds. Store the recipe and manifest, not megabytes of duplicated generated data.

Required generator behavior:

- Generate varied **realistic** PNG metadata cards (v2/v3), alternative greetings, nested/embedded character books, depth prompts, avatars/sprites, character-scoped regex, unknown extension fields, Unicode/emoji/long filenames and negative malformed inputs as separate declared cases.
- Build truly complex chat-completion and text-completion presets: Prompt Manager ordering/enabled flags, 120+ prompt blocks in the stress profile, role boundaries, custom samplers, reasoning, tool/schema options, instruct/context templates, stop strings, token-limit boundaries and nested prompt injection positions. Produce positive **and** deliberate exclusion/control examples.
- Construct multiple interacting world books: global+character+group, recursive triggers, secondary keys, regex keys, sticky/cooldown/delay, random probability with determinism where possible, scan-depth collisions and boundary cases. Do not claim a seeded file was exercised unless its marker reaches a final provider request.
- Generate chat histories with years of JSONL, branches, swipes, edits, deletes, rollbacks, streaming truncation, metadata, global/local/character variables, multiple personae and group turns. Include unrelated files whose hashes must never change.
- Install the actual pinned Tavern Helper/JS-Slash-Runner and LittleWhiteBox canaries plus genuine SFW third-party client extensions selected by capability. The first-party harness **must not substitute** fake plugin APIs for their real runtime JS.
- Every scenario requires seeded deterministic manifests, canonical SHA-256 of its preboot tree, action log, byte census and a replay command. Run the same recipe on **independent copies** for pinned Node and GoTavern; never boot the golden tree in place.
- Extend the existing gotavern-corpus-schema conservatively (add versioned optional scenario/interaction coverage fields, with a verifier and backward-compatible v1 read path). Keep the Go and JS corpora separate where their observed coverage differs; do not claim byte identity.

### Mandatory environment matrix

| ID | Profile | Required stress |
| --- | --- | --- |
| E01 | Fresh install | Pinned defaults, boot, import, first generation, restart |
| E02 | Long-lived normal | 3–5 years of synthetic history; 100+ cards, deep chats, groups, books, presets, mixed migration residue |
| E03 | Complex prompt laboratory | Nested role/prompt orders, world recursion, token-boundary truncation, 120+ prompts, reasoning/tool/schema and custom headers |
| E04 | Extension collision laboratory | All 20 locked client extensions coexist; helper+QR+regex+variables+group state; capability-pairwise cluster runs |
| E05 | Dirty / legacy | Prior-format cards, unusual filenames, unknown fields, partial/corrupt inputs, old backup layouts, symlinks and permission cases where supported |
| E06 | Multi-account concurrency | At least 8 synthetic users; overlapping save/load/delete/rename/import, concurrent provider streaming, settings writes and cross-user isolation |
| E07 | Network & proxy | Local TLS/http peer, redirects, streaming chunks, delays, cancellation, error codes, malformed responses and provider credential boundary |
| E08 | Crash / recover / hand-back | Kill at selected persistence stages, kernel write failure without privilege, restart, Node → Go → Node, source-copy rollback |
| E09 | Operational matrix | Linux native / container, Windows and macOS representative runners; install, startup, browser, proxy and portable asset paths |

Sizes above are **stress tiers**, not minimum costs for every pull request. Fast tier uses small representative scenarios; full tier exercises listed limits and multiple recorded seeds. Pairwise capability coverage is preferable to an infeasible 2^20 plugin powerset. The plan must report unexecuted combinations rather than treating them as green.

## 4. M2 — causal, multi-plugin **interaction**, not just installation success

Provide a scripted journey where one real browser session follows this sequence, with every action attributable to a UI event or an installed extension's documented API:

1. Open a v3 character with an embedded world book and a complex preset; switch persona; assert actual prompt/order visible at the recording provider.
2. Execute a nested Quick Reply / STscript that writes a variable; Tavern Helper reads/writes related variables; a character regex transforms a later utterance; world-book recursive/secondary triggers insert distinct marked text. Assert **all markers and their order** in the exact provider request, not merely in fixture files.
3. Stream a response, cancel mid-chunk, continue, regenerate and swipe; edit one prior message; switch to a 4-member group; restart process and reload the chat. Assert real browser state, ordered message IDs, provider wire, network and durable JSONL.
4. Disable/re-enable an extension, alter its own setting, restart, and verify setting persistence and absence of silently updated remote refs; exercise one cross-extension event chain and record which extension actually fired.
5. Run parallel sessions in separate accounts; a forbidden cross-user read or write must fail, with no leaked settings, secrets, provider key or chats.
6. Hand GoTavern-written data to pinned Node, continue the same chat, and compare the byte census; independently hand Node-written data to Go. Finally restore the pristine tree and prove byte equality.

Every action emits: step ID, scenario ID/seed, source UI/extension, before/after browser snapshot, browser HTTP, provider request/response digests plus lossless confidential-free captures, ordered message IDs, disk mutations, elapsed times, memory/process stats and a causal failure reason.

**Harness rules:** wait for stable state with bounded event-driven readiness. Never solve the known frontend race by silently deduplicating persisted data or ignoring a persistent duplicate DOM node. Every tolerance/normalization is narrowly scoped and separately evidenced. A harness that cannot drive a requested control returns UNPROVEN/HARNESS_FAILURE, not PASS. In particular resolve the conversation-editing race, Moving UI and card-image fidelity before using their lanes as a gate.

## 5. M3 — differential, mutation and chaos proofs

- Compare at least five independent observable classes: browser-to-server wire, server-to-provider wire, streaming/cancel sequence, frontend DOM/events and persisted filesystem bytes. Preserve message ordering, unknown keys and credentials handling.
- Add negative controls for missing extension action, missing marker, swapped message order, omitted world book, redirected bearer leak, stale settings, incorrect backup, wrong account, duplicated persistent message, wrong process PID on restart, partial atomic replace and wrong binary/HEAD SHA.
- Plant each control against the PRE-FIX harness; demonstrate its named assertion fails, then restore and re-run. A surviving mutation is a harness defect or unresolved coverage gap, never a pass.
- Use existing internal/faultinject and adversarial tests. Include kill-before/after rename, external writer, cross-process lock, exhausted file size via EFBIG, streaming cutoff, slow reads/writes and cancellation. ENOSPC remains UNPROVEN if the environment forbids a disposable mounted filesystem; do not label EFBIG as ENOSPC.
- No live external provider or unrecorded page-init network. Capture any inherited live egress and fail hermetic qualification unless explicitly isolated with a validated mock/local seam. Do not blanket abort and accidentally change browser behavior.
- Artifacts must be versioned and fail-closed: kind, schemaVersion, headSha, pinnedSha, generator digest, seed, tier, platform, complete scenario IDs, code/fixture hashes, exact pass/fail/blocked states, and run/workflow identity. Judge **embedded evidence**, not just artifact names or a green job.

## 6. M4 — refactor only boundaries the audit PROVES

**Candidate R1: configuration/handler composition.** Inspect internal/server/http.go:44-136, HTTPHandlerOptionsFromCommandLine and app.Start. Consider immutable, nested domain options with explicit translation from all pinned config values and preservation of nil-vs-false and JS truthiness. First move-only with a golden configuration behavior table. Do not rewrite HTTP middleware order or route semantics.

**Candidate R2: runtime lifecycle.** Inspect accountRuntime in accounts.go:85-103, settings_save.go:50-87 and the shutdown path in internal/app/server.go. Establish ownership and cancellation for throttled settings backups, child Git processes, caches and timed tasks. Test whether unrelated users block on a single settings-save mutex, whether backups survive/overrun shutdown and whether Git continues after canceled requests. Any redesign must preserve pinned save/backup timing, interprocess coordination and durable bytes. Prefer a simple per-user coordinator over a generic job scheduler, **only if red tests justify it**.

**Candidate R3: persistence consistency.** Trace all mutating API routes and compare their actual use of startup.UpdateUserContentFile, lockacquire, fsretry, atomicReplace, staged character directory copy and cache invalidation. Move a behavior to the existing shared ownership layer when there is verified duplicated policy or a demonstrated unsafe exception. Do not rewrite the existing atomic-write core or assume that any direct os.WriteFile is unsafe (some write only unpublished staging trees).

**Candidate R4: extension execution and isolation.** Audit extensions_git.go (background timeouts), extensions_fs.go, extensions_static.go, content discovery and installation permissions. Use request-scoped cancellation where observable behavior permits, enforce bounded subprocess/stdout/stderr/network work, retain the pinned Git/user-visible contract, and verify no unexpected extension modification or auto-update.

**Candidate R5: bounded caches and concurrency.** Audit settings_cache.go, account cache, character caches and large JSONL paths for lifetime, owner, same-size replacement, invalidation, cross-account isolation and cold path. No implicit new database, no unbounded memory buffer, no CPU/RSS “optimization” without a same-run before/after bench and a compatible provider/browser/disk diff.

**Candidate R6: explicit domain ownership.** Only after the source graph exists, split an actual cross-domain responsibility into a thin domain service behind a concrete, narrow API. Keep the routeDomainTable as it is; do not invent a new router, export orderedNodeJSON internals, replace the provider registry, introduce dozens of trivial interfaces or do a big-bang “clean architecture” rewrite. Every extraction must reduce the measured dependency/coupling graph and keep a trivial rollback commit.

The objective is **reliable behavior and maintainable ownership**, not abstract architectural novelty. The agent must decline a proposed refactor when no measurable risk, coupling or regression evidence supports it.

## 7. M5 — performance and long-run reliability, both directions

Run same-input before/after metrics on the same runner and revision family: cold+warm boot, 100/1000/10000 cards, large JSONL, 20-extension page load, 8-user concurrent writes, complex provider assembly, streaming cancellation and 30–60 min soak. Capture p50/p95/p99, CPU, allocations, heap/RSS, GC, file descriptors/handles, goroutine/process lifetime, lock contention and full-page bytes.

Report **both** improvements and regressions (alpha.15 repeat card cache improved but cold request +21%). No performance work is complete when it improves a synthetic headline but degrades a common user journey or changes the model-facing bytes. Derive candidate numerical thresholds from alpha.15 baselines and run-to-run noise; record and justify thresholds before optimization, not after.

## 8. M6 — CI, evidence and release bar

- Preserve all 13 alpha.15 same-SHA gates. Add a bounded **multi-environment interacting-scenario gate** only after its oracle leg, comparator and negative controls are independently proven. Use a fast PR/branch tier, medium same-SHA qualification tier, and a full scheduled stress/soak tier; document the narrower coverage of each.
- No test may pass solely because it created files, installed an extension, hit an endpoint, or saw a 200. Evidence must show that actual extension code executed, actual prompt markers reached provider wire and the intended persistent mutation occurred.
- Test cross-platform process and file semantics. Resolve or transparently downgrade the unavailable macOS ARM64 runner requirement without a continue-on-error loophole. Apply release governance to the embedded evidence schema, required artifact, required jobs and exact candidate SHA.
- After code-complete: full same-SHA required workflows; fail-closed release verifier; release assets, checksums and container pulled back from the public endpoint; TLS installer smoke; published-extension complex journey; Node ↔ Go hand-back; no tag move. Release notes must state every skipped or UNPROVEN scenario.
- **Do not redefine GOAL.md §14:** synthetic agent-built environments raise owned coverage but do not establish the stronger “actually-used real private tree” claim. That claim remains NOT MET until a separately authorized real-tree qualification runs. The alpha.16 release can legitimately claim a new *synthetic adversarial qualification* with precise scope, not universal drop-in proof.

## 9. Agent operating order and acceptance

A. Produce M0 static inventory, risk map and baseline **before** selecting refactor files. Stop and name inaccessible source or unexecutable oracle evidence; never claim the full audit was done without it.

B. Extend the existing corpus schema and scenario driver in a small commit; prove deterministic construction/verification and one real Node-vs-Go interactive case; plant at least one failed assertion before green.

C. Grow environments and plugin interactions incrementally, including failure paths and hand-back. Any discovered product difference gets a minimal reproducer and separate fix commit. Do not mask a red by adding a comparator exception without independent oracle proof.

D. Use the evidence to select at most one architecture responsibility boundary at a time; gate each extraction with existing and newly affected tests. Merge coherent work into main only under AGENTS.md’s branch-merge process.

E. Deliver an alpha.16 handoff ledger containing, for each changed area: original file:line, observed red, root cause, exact patch, green run ID, parity impact, data-safety result, benchmark both directions and residual limits.

**Acceptance for “finished”**: source audit complete; multiple independent synthetic environments actually executed; real pinned client extensions interact in a single complex workflow; provider-wire + UI + persistence + restart + both hand-back directions match for supported cases; all newly introduced assertions have demonstrated negative controls; no unclassified corruption, credential leak, resource leak or cross-user isolation failure; same-SHA required gates pass; and public release smoke passes. Until then the status is IN PROGRESS, not SHIPPED.

### Immediate first task for the coding agent

“Read the entire owned source and the existing gates first. Generate M0’s ownership/route/write/async-state graphs with source references, identify the **five strongest reproducible** reliability or architecture defects/hypotheses, and propose the minimal refactor boundaries. In the same M0 report design the first E03+E04 combined browser scenario that makes real Tavern Helper, Quick Replies, Regex, nested world books and a complex preset alter the **same provider request**. Show exactly how the current combination-journey and 20-extension harness can be reused. Do not change production behavior or call a test green until the oracle and negative controls have run.”
