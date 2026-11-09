# GoTavern — Real SillyTavern Drop-in Parity, Performance and Engineering

This file is the **locked goal** of the project. It is not a plan and not a roadmap: it is the
statement every lane, subagent, commit, CI gate and report must answer to. The question is always

> Does this work move us closer to the goal in this file?

`AGENTS.md` carries the verification rules. `ARCHITECTURE.md` carries the design contract.
`HANDOFF.md` carries where the work actually stands today. When they disagree with this file about
*what we are trying to achieve*, this file wins.

## 1. The goal

GoTavern has one product goal and one engineering goal, and they are pursued together — a faster,
cleaner GoTavern that is less compatible, or a compatible one that is not measurably better, is not
progress.

**1a. The product goal — a real drop-in.** Turn GoTavern from "a Go backend that implements a large
number of SillyTavern APIs" into a production-grade **drop-in replacement that can carry a long-lived
SillyTavern user directory**. A user must be able to keep their existing SillyTavern frontend,
`config.yaml`, `data/`, character cards, avatars, backgrounds, chats, world books, complex presets,
Quick Replies, Regex, STscript, variables, personas, extensions and 酒馆助手 / Tavern Helper /
JS-Slash-Runner, and simply swap the backend. For every behaviour pinned SillyTavern supports and that
is not an explicit product exclusion, GoTavern must be equivalent **on the surfaces a user actually
observes**. §14 states the strongest form of this claim as a testable bar; it is the bar, not the
current state.

**1b. The engineering goal — a better artifact, without trading 1a away.** Make GoTavern genuinely
light, fast, stable, understandable and pleasant to start:

- **light and fast**: measured, reproducible improvement in startup, steady-state and peak RSS, CPU
  time, tail latency and large-data behaviour, with the cost of every optimization stated (§15);
- **stable**: no goroutine/file-descriptor/heap drift, no cache-incoherence or lost-write class, no
  retry-masked failure, no hidden second database;
- **clear architecture**: high cohesion, explicit ownership, testable seams, no god object — and the
  discipline to leave mature, well-tested, semantically complex code alone (§15.4);
- **simple CLI**: a first-run experience a non-developer understands — product identity, real paths, a
  truthful Ready line, actionable errors, quiet by default, TTY-safe colour, no ASCII-art waste —
  while every pinned SillyTavern flag and behaviour stays discoverable and compatible (§15.5);
- **honest README and figure**: the first screen says what GoTavern is, why it is lighter and how to
  start it; every number in it is generated from a recorded artifact and gated against it (§15.6).

**1c. The release this program ships.** The current deliverable is `v0.1.0-alpha.18` as a **formal,
stable-channel release**: same-SHA gates green, release notes not ahead of evidence, published
artifacts verified after publication (§16). No tag is created and no channel is moved until §16 holds
and the evidence table names every gate run. `v0.1.0-alpha.16` and `v0.1.0-alpha.17` are already
published and their tags are immutable.

**Update, 2026-11-09: the current deliverable is `v0.1.0-alpha.19`, the real-interaction oracle release
(PUBLISHED 2026-11-09).**
alpha.19 moves the compatibility evidence from synthetic-only to a tree that was actually used through the
unmodified pinned UI: a Node-UI-Originated Complex User Corpus (30+ created cards, 8+ world books / 150+
created entries, 10 materially different presets, 50+ chats / 1,000+ persisted messages, 5+ group chats,
personas/themes/Quick Replies/Regex/STscript/variables and a pinned Tavern Helper / JS-Slash-Runner), a
five-layer live oracle (browser / HTTP / provider wire / persistence / lifecycle+combination) replayed on
both subjects in isolated copies, and a **fourteenth required release gate** that runs that oracle in CI at
the candidate SHA with a mutation-tested evidence verifier. The product fixes the oracle found
(conditional GET/304 on four JSON routes, the startup-only `config.yaml` parse, a streaming cancel-watchdog
goroutine leak) and the measured performance rows ship with it. The strong drop-in bar in §14 is still **not**
upgraded: the corpus is agent-created through the real UI, not a human's years-old private tree.

alpha.18 is a **deep product-engineering release**, and the standard it is judged by is what a user can
observe, not how much analysis was produced. It ships: (a) the completed root-cause analysis and a
same-input, paired, reproducible improvement of the 10,000-card card-list and startup hotspot (profile,
production change, ABBA measurement, regression gate), (b) the two product capability gaps alpha.17
recorded as open — a REAL CORS proxy enabled branch and the pinned chat auto-backup semantics — verified
against real local upstreams and against the pinned source/probes, (c) real-socket evidence that
streaming cancellation releases the upstream connection, goroutines and buffers, (d) a 60-minute
mixed-load soak on the final candidate with honest RSS/heap/goroutine/error/latency trends, (e) the
release-evidence rails APPLIED to the real release chain with narrowed-dispatch refusal proven by real
workflow runs, and (f) publishing with the same-SHA 13-gate wave, independent post-publication artifact
verification and release notes that list every unproven item. The strong drop-in bar in §14 is **not**
part of alpha.18's deliverable and is not claimed by it: no real long-lived user directory is present on
the qualification host, so §14 stays NOT MET. The alpha.15 engineering-audit release, the alpha.16
synthetic adversarial qualification and the alpha.17 niche/performance round remain the historical record
of their own rounds; their evidence lives in `docs/alpha15/`, `docs/alpha16/`, `docs/alpha17/` and the
published release notes, and this file does not rewrite it.

The goal is met only when all of the following are demonstrated with the shipped artifact:

1. a long-lived, actually-used SillyTavern directory runs directly under GoTavern;
2. no extension is ever updated without explicit user consent;
3. character cards and every core avatar resource display;
4. backgrounds, sprites, persona and user avatars and the other core asset surfaces display;
5. 酒馆助手 really runs — iframe, bridge, events, scripts — rather than merely loading JS;
6. a real complex preset demonstrably changes the model context under different configurations;
7. after 酒馆助手 mutates presets, variables, prompts or generation configuration, the context sent
   to the model equals pinned SillyTavern's;
8. the changes a preset causes — context, message ordering, world info, Author's Note, history
   truncation, injections, samplers, tools, reasoning — all behave identically to pinned;
9. save / reload / swipe / regenerate / continue / restart all preserve that equality;
10. data written by GoTavern can be handed back to original Node SillyTavern and keeps working;
11. only after compatibility holds, a fair paired benchmark proves the CPU/RSS/startup/long-run
    advantage;
12. the CLI, the README and the performance figure meet §15.5-§15.6, and the release meets §16.

## 2. What is forbidden as evidence

The following are **not** evidence that GoTavern is compatible, and a report that rests on them is
rejected:

- "we implement a lot of APIs";
- "route coverage is high";
- "the Go tests are green";
- "the page opens";
- "a chat message can be sent once";
- "the extension's files load";
- "`getPreset()` returns data";
- "CI is green".

The last two exist because both were true while the product was visibly broken. A green gate that
cannot express the user's complaint is decoration (`AGENTS.md` rule 7).

## 3. The one sentence that decides compatibility

> For a given character, chat, world book, preset, helper script, variable state and user input, the
> **final request that reaches the model backend** is equal between pinned Node SillyTavern and
> GoTavern — and so is the persistent and browser state afterwards.

Everything else is instrumentation around that sentence. A preset is not "compatible" because its
JSON loads; it is compatible because the context it produces is the same. An avatar is not
"available" because a file exists on disk; it is available because a browser displays it.

## 4. Primary oracle and its precedence

Pinned baseline: **SillyTavern 1.19.0**, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.

Evidence precedence, highest first:

1. an observation of pinned SillyTavern actually running;
2. the pinned source at that commit;
3. a recorded oracle (committed fixture/capture);
4. a source-derived test;
5. developer inference — last, and it must be labelled as inference.

Forbidden as a basis for behaviour: memory of SillyTavern, current upstream `master`, "that is how Go
normally does it", and a mock that defines its own correctness.

## 5. The real inputs are part of the specification

Qualification is not allowed to run only on clean fixtures. The following are inputs, not examples:

- **the long-lived SillyTavern tree** — a realistic user data root: config, users, characters and
  card PNGs, chats, groups, world info, presets of every kind, Quick Replies, Regex, personas and
  persona avatars, user avatars, backgrounds and their metadata, sprites, themes, moving UI,
  extensions including JS-Slash-Runner, extension settings, thumbnails, backups, unknown files, old
  fields and mixed legacy state;
- **the real complex preset(s)** — including at least one carrying
  `extensions.tavern_helper` (scripts + variables) and `extensions.regex_scripts`;
- **the real complex character card(s)**;
- **the pinned JS-Slash-Runner version**.

Real inputs are read-only. They are read, hashed and copied to a temporary tree. A desensitised
fixture must preserve **structure and complexity** — every field, ordering, enabled flag, depth,
role, extension subtree and size class — while replacing prose with markers. Desensitising is not
simplifying: shrinking a 500-field preset to three prompts and calling it equivalent destroys the
only property that made it an oracle.

## 6. P0 ledger

Every P0 keeps a reproducer, a gate that has been shown to fail, and a packaged-artifact check.

A P0 row is CLOSED only by evidence, and the evidence is the scorecard row that measures the same
capability: `docs/goal-scorecard.md` is the single ledger, and this table must not hold a defect as open
while that ledger holds its question as `proven` (or the reverse). The `Evidence` column below is what
makes the two files checkable against each other by a reader, and the consistency test in
`internal/fixtures/documents_test.go` refuses a scorecard row that cites a run id nothing can look up.

| Id | Defect | State | Evidence |
|---|---|---|---|
| P0-A | the real provider transport could not reach a real provider (DeepSeek) | closed | `internal/outbound/transport_matrix_test.go` exercises the production transport (proxy awareness, bounded connect/TLS/header/idle timeouts, decompression, redirect policy, keep-alive honouring `enableKeepAlive`, and the private-address dial filter) as a client SEPARATE from the byte-exact oracle client (`raw.go`); the DeepSeek canary step of `GoTavern Lane CI` and `docs/network-egress.md` carry the live half |
| P0-B | the release binary hung during initialisation in a working SillyTavern tree | closed | `GoTavern drop-in qualification` 40898261148 (success) on `a8d5945`, step `Smoke` — the packaged archive boots a stock tree inside the readiness bound |
| P0-C | extensions/plugins were updated without being asked | closed | auto-update resolves to OFF for every ambiguous input (`AGENTS.md` rule 26, `internal/commandline/autoupdate_test.go`); the long-lived leg asserts the extension tree unchanged after boot |
| P0-D | 酒馆助手 / JS-Slash-Runner does not actually work | closed | scorecard Q8 and Q9: `Browser differential` 40903953724 (RUN VERDICT CANCELLED by its own timeout budget, cited for the helper and helper-generation steps that completed inside it) where the `generateRaw` request is byte-identical on both subjects |
| P0-E | core visual assets are missing (character avatars, backgrounds, personas, sprites, thumbnails) | closed | scorecard Q3-Q7: `Browser differential` 40903953724 (RUN VERDICT CANCELLED by its own timeout budget, cited for the asset legs that completed inside it) and `tests/e2e/longlived_test.go` asserting `/characters/<card>.png` and `/thumbnail?type=avatar`; Q7's paint half remains `partial` and is named there |
| P0-F | a real complex preset cannot be shown to change the model context the way pinned does | closed | scorecard Q13-Q15: `Browser differential` 40903953724 (RUN VERDICT CANCELLED by its own timeout budget, cited for the preset steps that completed inside it) proves presets differ AND `Node(X)==Go(X)` over the real preset derivations, and opens the derived complex card on both subjects |

The rule that keeps this table honest: a row may move from open to closed ONLY in the change that adds
the gate which proves it, and that change names the run. A row that is closed without a run id is a claim,
not a result (`AGENTS.md` rule 36).


## 7. The user-facing scorecard

These are the questions the project must be able to answer with evidence. Answering them with test
counts is a failure to answer.

| # | Question |
|---|---|
| Q1 | Can a long-lived SillyTavern directory be started directly with GoTavern? |
| Q2 | Did GoTavern touch my extensions? (required answer: no, unless explicitly opted in) |
| Q3 | Are all character-list avatars correct? |
| Q4 | Is the image of an opened complex character card correct? |
| Q5 | Is the character avatar inside a chat correct? |
| Q6 | Are personas correct? |
| Q7 | Do backgrounds display exactly as in the original? |
| Q8 | Does the JS-Slash-Runner iframe really work? |
| Q9 | Do 酒馆助手's generation APIs really work? |
| Q10 | Do 酒馆助手's variables really work? |
| Q11 | Does 酒馆助手 injection really change the model context? |
| Q12 | After 酒馆助手 modifies the `'in_use'` preset, does it affect generation immediately? |
| Q13 | Does switching presets produce genuinely different context at the simulated backend? |
| Q14 | For each preset: is `Node context == Go context`? |
| Q15 | Is a complex character card's semantics inside the context the same? |
| Q16 | Is world-info activation the same? |
| Q17 | Is Author's Note depth the same? |
| Q18 | Is token truncation the same? |
| Q19 | Are streaming and helper events the same? |
| Q20 | Is it still the same after reload, swipe, regenerate, continue? |
| Q21 | Can data written by GoTavern be handed back to Node and keep running? |
| Q22 | Is CPU/RAM actually and measurably lower than Node's? |

## 8. The harness that is required

The goal cannot be reached with the harness that exists. The following are mandatory pieces, not
optional improvements.

1. **A deterministic simulated model backend.** It records every request completely (target,
   headers, raw body bytes and SHA-256, member structure, model, stream, messages/roles/content,
   system instructions, samplers, stops, tools, tool_choice, response format, reasoning,
   provider-specific members) and replies deterministically by marker (e.g. context contains
   `MARKER_A` → `ACK_A`; order `A→B→C` → `ORDER:A>B>C`). It also emits controlled SSE, controlled
   errors, mid-stream closes and delayed responses. The mock only captures and answers: it never
   defines what the correct context is. Correctness comes from the pinned capture.
2. **Preset semantic differential.** `Preset-A`, `-B`, `-C` and the real preset, each run under
   pinned Node and under GoTavern, comparing the final provider request. Two things must hold at
   once: `Node(X) == Go(X)` for every X, **and** `X != Y` within an implementation. If a harness
   produces three identical captures it fails as `HARNESS NON-DISCRIMINATING` rather than passing.
3. **Prompt provenance.** For a large preset, a difference must be locatable: which final message,
   from which source (preset prompt, world info, character field, helper injection), at which depth,
   under which lifecycle event. "bodies differ" is not a report.
4. **Browser asset differential.** Pinned Node and GoTavern loading the *same* frontend, *same*
   driver and *same* fixture, compared on network URL/status/MIME/SHA-256/length, DOM state, image
   `complete` / `naturalWidth` / `naturalHeight`, CSS background, console and screenshot. A core
   asset failing is a red gate.
5. **Browser semantics differential.** The helper's iframe path, generation, streaming, events,
   cancellation and preset mutation driven through a real browser against the unmodified frontend.
6. **Mutation evidence for every gate**, produced by a CI run with `-count=1`, naming the assertion
   that went red and the restored green.

## 9. Combination rules

- Tests that share coverage combine **only** where they have been shown to combine. `preset PASS`
  plus `helper PASS` does **not** imply `preset × helper PASS`; `asset PASS` plus `generation PASS`
  does **not** imply they are fine together. A single data-root or path bug can break an asset, an
  extension and a preset at the same time.
- The highest-priority scenario is the full real combination: `real character × real complex preset
  × 酒馆助手 × world book × existing chat history × preset/chat/character variables × regex × Quick
  Replies × STscript × prompt injection × generation × streaming`.
- A narrowed matrix is a cost control. It never supports a claim of full coverage.

## 10. Comparators

Normalisation is a named, narrow, justified exception, never a global policy. Forbidden: sorting
messages or JSON keys globally, dropping unknown fields, ignoring headers, ignoring body members,
comparing only content, collapsing duplicates, or ignoring prompt order. Anything genuinely
nondeterministic is normalised per JSON path with the reason and its evidence recorded.

## 11. Order of work: the M0–M8 engineering ladder

This is the ladder for the engineering program — architecture, performance, CLI, documentation and the
release — and it is the only statement of what comes next for that program. It does not replace the
parity ladder in §11.1: a parity milestone that regresses is a red gate at every point on this ladder.
A milestone is not a theme: each one names the capability that must be RUNNABLE and the gate that
decides it. Moving on because the previous milestone's cheap checks are green is forbidden
(`AGENTS.md` rule 23).

| Milestone | The capability that must be runnable | Closed by |
|---|---|---|
| **M0 — read-only audit** | a dependency, data-flow and performance model with confirmed issues, unverified hypotheses named, and a priority order | a dated `HANDOFF.md` checkpoint whose findings carry file:line evidence, plus this file |
| **M1 — CLI experience** | identity, a truthful Ready line, real paths, per-command help/version, unknown-flag warning, TTY-safe colour, Docker headless boot, friendly shutdown, actionable errors — with every pinned flag preserved | new CLI tests over injected streams, the three-platform boot paths, and console-output fixtures updated deliberately |
| **M2 — performance baseline** | first the evidence gate (README table, figure and provenance generated from and checked against the recorded artifact), then scale benchmarks: 100/1000/10000 cards, large JSONL chats, settings aggregation, world info, a 229-asset page load, provider assemble/marshal, concurrency; peak RSS, CPU time, GC, p99; pprof/benchstat capture | a recorded baseline naming commit, Go version, runner, data scale, rounds and raw artifact; and a gate that fails when the docs and the artifact disagree |
| **M3 — first hotspot** | ONE highest-ROI, lowest-risk hotspot fixed, with before/after on the same input and the compatibility suite green on the same commit | the same-input benchmark plus a same-SHA differential run |
| **M4 — architecture** | `orderedjson` → `httpx` → `userdata` extraction, move-only first, then an explicit route table replacing the `init()` registrars | every step guarded by an existing differential gate; no observable behaviour change |
| **M5 — big data and concurrency** | chat-summary streaming, identity-keyed settings/world-info caches, static double-resolve removal, lock scope, large-tree startup | peak-memory and latency before/after, with response bytes unchanged |
| **M6 — long-term stability** | panic boundary, cache-consistency tests (including same-size replacement), `http.Server` timeouts, provider truncation/redirect differentials, `-race` and parallel tests | each fix has a failing-then-passing reproducer |
| **M7 — README and figure** | first-screen restructure; a ~1200×675 16:9 dark+light figure generated from the artifact; unit discipline; no stale version text; accessibility/contrast checks | generator determinism, agreement with the artifact, and the docs gate |
| **M8 — acceptance and release** | the full same-SHA gate set, cross-platform, packaged artifact, public-artifact verification, and the line's release as a formal release. M8 is a RECURRING milestone, not a one-off: alpha.14 closed it once, and alpha.15 closes it again on its own commit, which is why §16 names the tag rather than the milestone | §16 |

**M4 status (recorded 2026-11-04, after `v0.1.0-alpha.14`).** The route-table step (`8eca43b`) and two
move-only extractions landed in the follow-up work: `internal/httpx` (the weak-ETag and response-writer
conventions, 902 call sites: 33 weak-ETag reads, 64 JSON-bytes writes and 805 status-text answers) and `internal/userdata` (the pinned sanitize-filename naming policy). The
`orderedjson` extraction is **REFUSED with a measurement, not skipped**: 152 files and 1,463 references
inside `internal/server` read `orderedNodeJSON`'s unexported fields (644 `.kind`, 605 `.array`, 156
`.scalar` accesses), so a move-only extraction does not exist — moving that type means exporting its
internal API and rewriting 152 files, exactly the semantics §15.4 lists as do-not-rewrite. `internal/server`
now owns less; the ordered-JSON semantics stay beside the tests that pin them. This is a recorded scope
decision, and §12.1's M4 box carries it. **Re-measured at `main@c02eed1` for alpha.17 (2026-11-07):** 115
production files in `internal/server` mention ordered-JSON, 1,290 references in total (578 `.kind`, 566
`.array`, 140 `.scalar`), with 18 internal packages and 20 first-party import edges; the refusal stands and
the current decision record is `docs/alpha17/architecture-decisions.md`.

Each milestone ends with a report in the shape of §12: what changed, before/after numbers on the same
input, the gates that ran (with run ids), what became simpler, what is still unproven, and the next
three priorities. A local run is triage; CI is the gate.

### 11.1 The parity ladder this program inherits (closed at `v0.1.0-alpha.13`; still standing gates)

The `M0`-`M5` names in the table below are the PARITY milestones and are distinct from the engineering
milestones in §11; a regression in any of them is a red gate at every point on the engineering ladder.

The order below is the milestone ladder, and it is the only statement of what comes next. A milestone is
not a theme: each one names the capability that must be RUNNABLE, and the gate that decides it. Moving to
the next milestone because the previous one's cheap checks are green is forbidden (`AGENTS.md` rule 23:
source-tree tests are necessary and insufficient).

```
long-lived tree runs
→ visual assets display
→ 酒馆助手 runs
→ preset semantic differential holds
→ the real combination holds
→ persistence holds
→ Node → Go → Node holds
→ performance
```

### The milestone ladder

The ladder exists to stop two failures this project has already paid for: claiming a later capability
because an earlier one's unit tests are green, and freezing the whole goal behind one unpassable gate.
Each milestone is CLOSED by its own gate running on a real subject, and the scorecard row in parentheses
is where its evidence is recorded — one ledger, no second copy.

| Milestone | The capability that must be runnable | Closed by | Scorecard |
|---|---|---|---|
| **M0 — baseline, privacy, ledger** | the pinned baseline is one string that every document agrees with; the originals have a channel that can execute them without transmitting them; every user question has a row with a state and an artefact | `internal/fixtures/documents_test.go` (pin consistency, document encoding, ledger structure, rule numbering) plus the manifest check, green on `main` | Q1, Q2 |
| **M1 — complex preset · card · regex · helper differential runnable** | one command class drives pinned Node and GoTavern against a deterministic simulated backend with a real complex preset DERIVATION, a card derivation, its `regex_scripts` and its `extensions.tavern_helper`, and both halves hold: `Node(X)==Go(X)` AND `X!=Y` | a browser leg that fails itself as `HARNESS NON-DISCRIMINATING` when the captures agree (`AGENTS.md` rule 50), plus the packaged-artifact run | Q3-Q6, Q8, Q13-Q15 |
| **M2 — Author's Note · truncation · streaming/cancel · regenerate/continue · persistence + Node↔Go↔Node** | each observable is driven on both subjects: Author's Note at several depths, a context pushed PAST the truncation boundary, streaming with cancellation mid-stream, regenerate and continue, and a saved tree handed BACK to pinned Node | the Q17 sweep wired into a workflow, a truncation leg, a regenerate/continue step, and a green hand-back leg — each cited by run id and step | Q7, Q9-Q12, Q16-Q21 |
| **M3 — UI / extension / migration / long-tail risk matrix** | the surfaces with no cheap differential are enumerated from the ORACLE's own lists (`router.use(...)`, mounted routers, frontend URL builders) and each row is `proven`, `partial`, `unsupported` or `inherited-pinned-behavior` with a reason | the inventory-vs-registration diff (`AGENTS.md` rule 43) and the migration/rollback legs, green on the packaged artifact | Q2 (migration half), the §13 non-claims |
| **M4 — candidate SHA + release shape full qualification with accurate boundary disclosure** | the packed archive, unpacked into a clean environment, starts against a stock tree, migration, update, rollback and Docker paths all pass, and the release notes state every boundary in §13 and §6 of the scorecard rather than implying full coverage | `GoTavern release qualification`, `GoTavern drop-in qualification` (Linux and Windows) and `GoTavern release` on one candidate SHA | all, re-read on that SHA |
| **M5 — targeted performance with no compatibility regression** | CPU/RAM/startup measured against pinned Node on the same runner, with the full differential suite green on the SAME commit so the numbers are not bought with a regression | `GoTavern smoke metrics` plus the full oracle sweep on one SHA | Q22 |

Two consequences the ladder makes explicit:

- **M0 is a prerequisite, not paperwork.** A document that disagrees with the pin, or a ledger row that
  cites a run nobody can find, invalidates every later claim that rests on it.
- **M5 is last because performance is meaningless on a product that does not work.** Measuring a fast
  server that produces a different prompt is the exact failure `GOAL.md` §3 describes.


Optimising a product that does not work is out of scope. So is claiming a later stage because an
earlier stage's cheap checks are green.

## 12. Definition of done

The core goal of a round is complete only when every line below is true.

```
[ ] the goal above is established and persisted (this file, AGENTS, ARCHITECTURE, HANDOFF)
[ ] the current HEAD has been re-audited from the tree, not from older numbers
[ ] the real long-lived SillyTavern tree has been analysed safely
[ ] the original user directories were not modified
[ ] the real complex preset has been found and characterised
[ ] the real complex character card has been found and characterised
[ ] the actually-installed JS-Slash-Runner version is pinned
[ ] no extension is ever auto-updated
[ ] character avatars pass in a browser
[ ] selected-character image passes in a browser
[ ] persona assets pass in a browser
[ ] backgrounds pass in a browser
[ ] sprites and other core assets pass in a browser
[ ] the no-broken-core-assets gate passes
[ ] the JS-Slash-Runner iframe works
[ ] helper generate works
[ ] helper generateRaw works
[ ] helper lifecycle events match
[ ] helper variables work
[ ] helper injections change the context like pinned
[ ] helper cancellation works
[ ] a deterministic provider simulator exists
[ ] presets A/B/C genuinely produce different context
[ ] Node(A) == Go(A), Node(B) == Go(B), Node(C) == Go(C)
[ ] runtime `in_use` preset semantics match
[ ] helper preset mutation matches
[ ] helper × world info matches
[ ] helper × variables × preset matches
[ ] the real complex preset differential passes
[ ] the real complex character differential passes
[ ] character × preset × helper passes as a combination
[ ] streaming passes
[ ] regenerate / swipe / continue pass
[ ] reload passes
[ ] restart passes
[ ] Node → Go → Node passes
[ ] mutation evidence exists for every new gate
[ ] the release-shaped artifact passes
[ ] the critical `main` Actions runs are green
[ ] remaining gaps are listed explicitly
[ ] the paired performance benchmark is done once compatibility is stable
```

### 12.1 The engineering program's definition of done

State as of `v0.1.0-alpha.15` (2026-11-05): everything below is met **except M4**, which is partial and
is closed by decision where it cannot be move-only (§11). alpha.15 adds no new milestone box: its own
obligation is §1c's — re-audit the gates, close the blind spots the audit finds, fix the real defects,
optimize with measurement, and re-run every gate at one candidate SHA so the release rests on that
commit rather than on alpha.14's. A ticked box names the evidence in `HANDOFF.md`'s current
checkpoint; an unticked box is an open obligation, not a style note.

**Update, 2026-11-08 (`v0.1.0-alpha.18` published).** alpha.18's obligation
is §1c's and it does not add a milestone box: close the 10,000-card hotspot with a measured paired
improvement, ship the CORS proxy enabled branch and the pinned chat auto-backup, prove streaming
cancellation resource release, run a 60-minute soak, apply the release-evidence rails, and re-run every
required gate at one candidate SHA. The boxes below are not rewritten by this note, and M4 stays unticked
by decision exactly as alpha.15 left it. (Historical note: alpha.16 closed M8
again on its own commit and added the synthetic adversarial qualification recorded in `docs/alpha16/`;
the boxes below are not rewritten by this note. alpha.17's obligation is §1c's: refresh the M0 audit at the
current tree, build and execute the niche scenario catalogue with negative controls, re-decide R1–R6 on
evidence (they remain REFUSE; `docs/alpha17/architecture-decisions.md`), measure one process-level hotspot on
the same input and report both directions, restructure the README and its performance-documentation gate, and
re-run every required gate at one candidate SHA. M4 remains **unticked by decision**, exactly as alpha.15 left
it: its written form named three extractions, two landed move-only and the third is refused with a metric, so
the unticked box is the honest label rather than an open refactor invitation.

- [x] M1: the first-run output names GoTavern, its version, its baseline, its real data/config paths
      and a Ready line printed only after the listener serves; `--help`/`version` work for every
      subcommand regardless of argument position; an unknown flag warns; colour is TTY-safe; Docker
      boots headless; shutdown is friendly; the pinned error formats are preserved
- [x] M2: the performance-evidence gate exists and has teeth, and a baseline is recorded with commit,
      Go version, runner, data scale, rounds and the raw artifact
- [x] M3: one hotspot has a same-input before/after and the same-commit compatibility gates are green
- [ ] M4: the extracted packages are move-only, `internal/server` owns less, and every step was gated
      by an existing differential. **PARTIAL, and closed by decision where it cannot be move-only:** the
      route table landed (`8eca43b`), `internal/httpx` and `internal/userdata` were extracted move-only
      afterwards, and the `orderedjson` extraction is refused with the measurement in §11 (152 files /
      1,463 references / 644 `.kind` reads against unexported fields; §15.4 forbids the redesign a move
      would require). The box stays unticked because the milestone as WRITTEN named three extractions.
- [x] M5: large-data and concurrency behaviour is measured and improved without changing response bytes
- [x] M6: the failure paths and the truncation/redirect differentials are decided with evidence
- [x] M7: README first screen, figure, provenance and the release record agree with the artifact
- [x] M8: §16 is satisfied on one commit, and the public artifacts are verified after publication

## 13. Non-claims

The following remain outside the product, and saying so is part of the contract: arbitrary Node.js
server plugins (never emulated), in-process ONNX inference, image re-encoding that depends on a
Jimp-compatible codec where byte equality is claimed, and wire formats that live inside third-party
npm packages. A row that is partial says partial with its reason; a row that is not covered says so.

**Remote embedding production is a declared exclusion (alpha.11 decision, `docs/remote-embeddings-decision.md`).**
GoTavern implements vector storage, the persisted vectra index format and the two sources whose vectors
arrive precomputed in the request body (`webllm`, `koboldcpp`). It does not call a provider to produce
embeddings: every provider-backed source (`openai`, `togetherai`, `mistral`, `electronhub`,
`openrouter`, `chutes`, `nanogpt`, `siliconflow`, `workers_ai`, `cohere`, `nomicai`, `extras`, `palm`,
`vertexai`, `ollama`, `llamacpp`, `vllm`) answers an explicit HTTP 501 naming the source and the
decision document, never a generic 500 and never a fake vector. This is a product decision for this
release and it is reversible by a user requirement (the scoped reversal plan is in the decision
document). The compatibility promise for vector storage is therefore: **storage and body-supplied
vectors are compatible; provider-produced embeddings are excluded and say so.**

## 14. The drop-in bar, and the honest answer today

The strongest form of this project's claim is the one a user makes for it:

> point GoTavern at a long-lived, actually-used SillyTavern directory and everything keeps working --
> cards, chats, groups, world books, presets, Quick Replies, personas, backgrounds, sprites, secrets,
> settings, installed extensions and 酒馆助手; no file is damaged, no unknown field is dropped, no
> extension is updated without consent; and every observable behaviour, including the final request that
> reaches the model, equals pinned Node's.

That is the bar. It is NOT the current state, and no document may present it as demonstrated until all
of the following have run on ONE commit, on ONE real tree, with the result recorded in
`docs/goal-scorecard.md`:

1. **A real tree, not a synthesis.** A directory that has actually been used -- not the Go-synthesised
   tree in `tests/e2e/longlived_test.go`, not the committed corpus, not a fresh install -- boots
   directly with its own `config.yaml`, users, cards, chats, groups, worlds, presets, Quick Replies,
   themes, assets, secrets and installed extensions. `docs/development-loop.md` §4 is the only channel
   where this can be observed, and its result is an observation, never an upload.
2. **A byte census.** Every file under the data root, the mutable install trees and the extension trees
   is hashed before the first boot and after the journey. Every difference is classified as either the
   exact mutation pinned makes from the same copy -- proven by running pinned Node on the same input --
   or a defect. "Additive, so probably fine" is not a classification.
3. **The journey equals pinned's.** The browser journey, the persisted state afterwards and the final
   provider request bytes are equal between GoTavern and pinned Node on that tree: §3's sentence, run on
   the real input instead of on a derivation.
4. **Hand-back and rollback.** The tree GoTavern wrote is handed back to pinned Node and keeps working;
   restoring the pre-boot copy yields a byte-identical tree.
5. **The failure path is safe.** A killed process, a full disk, a read-only directory, a corrupted chat
   and a concurrent writer each leave the user's data parseable and recoverable, with the bounded-lock
   and atomic-write invariants of rules 12 and 24 intact.
6. **The scope words travel with the claim.** Any README, release note, figure or report that calls the
   product "drop-in", "compatible", "safe" or "stable" must state in the same place which of 1-5 have
   run and which have not; a claim resting on a synthetic tree or a derivation says so.

**Current state, dated 2026-11-08 (`v0.1.0-alpha.18` published): NOT MET
for the strong form.** The evidence that exists covers a Go-synthesised long-lived tree
(`tests/e2e/longlived_*`), the committed synthetic browser corpus, a packaged archive over a stock tree, the
20 pinned third-party extensions and the browser/provider-wire differentials, plus alpha.16's synthetic
adversarial qualification (E03+E04 browser journey, seeded E06 state machine, evidence-rail release gates)
and alpha.17's niche scenario catalogue, native tests, refresh audit and process-level performance baseline.
alpha.18 adds product capability (a real CORS proxy, pinned chat auto-backups), a measured 10,000-card
performance improvement and a 60-minute soak, all on synthetic or generated data — which is exactly why the
bar stays unmet. No real, long-used user directory has been qualified: the local private channel of
`docs/development-loop.md` §4 was **canaried, never run against real originals**, and the disposition remains
`PRIVATE_NOT_RUN` because no authorised original is present on the qualification host.
`docs/goal-scorecard.md` §3 says the same in one line: Q1's tree is synthesised, not the user's. alpha.17
does not change this: it adds synthetic/adversarial depth and performance evidence, and it states in the
same place that §14 stays unmet.

**Update, 2026-11-09 (`v0.1.0-alpha.19` PUBLISHED).** alpha.19 changes the KIND of evidence available
without changing the verdict: the corpus it uses was created and used by an agent through the unmodified
pinned UI (real import controls, world-book editor, preset UI, chat turns, group chats, Tavern Helper state),
and the same tree is replayed on both subjects in the five-layer oracle — so §14's condition 1 has a real
`ui`-origin tree for the first time, but the tree is agent-created rather than a real person's years-old
private data, and conditions 2-5 still rest on that same corpus. The oracle also evidences restart/hand-back
(both directions) and provider-wire byte equality on the corpus path. The new fourteenth release gate
(`GoTavern real-UI oracle differential`) passed at the published candidate `bbc5615` with all five layers
`match`, 26 named normalisations, 6 not-compared surfaces and 57/57 comparator teeth; the same-SHA wave is
recorded in `docs/alpha19/same-sha-evidence.md`. §14 therefore remains **NOT MET for the strong form**; the
honest statement is "real UI usage, agent-authored corpus, five-layer equality on that corpus", with the
corpus's own limits disclosed (396 UI-turn / 772 product-save-path messages in the locally built corpus,
extension auto-enabled at load, one recorded third-party egress request, `-race` only on Linux, darwin/arm64
and windows/arm64 recorded as build-only/platform limitations).

The M0 audit of 2026-11-03 named two concrete reasons the sentence could not then be upgraded. Both
were RE-MEASURED this round rather than quoted: (1) **response compression** — no longer a reason; the
pinned compression contract is implemented (`internal/server/compression*.go`) and pinned against a
recorded oracle, with 229-request page-load wire bytes down 67.4% (`GoTavern CI` 41766644754); (2) **the
character-card disk cache pinned maintains** — still not implemented in GoTavern. That is a *derived,
rebuildable* cache pinned writes under `<dataRoot>/_cache/characters` (`SillyTavern`
`src/endpoints/characters.js:36-159`, verified at the pin), so its absence is a parity/performance gap
rather than a data-loss path: no user byte depends on it, and pinned rebuilds it from the cards. It is
recorded as `partial` and not as a defect. Neither item is on the §14 bar itself — the bar is items
1-5, and they need a real tree. This paragraph is dated: when items 1-5 are demonstrated it is
replaced, not kept, and the scorecard row carries the run.

## 15. The engineering contract

### 15.1 What every optimization must answer

Before a change is accepted it must state: which condition it speeds up; what it costs (memory,
complexity, a new cache, a new failure mode); why the observed behaviour is unchanged; how the gain
was measured; and which gate guards it. An optimization with no measurement, or one that buys a
benchmark at the expense of compatibility or data safety, is rejected.

### 15.2 Measurement discipline

Same host, same commit, same data, same parameters before and after. Every record names the commit,
Go version, OS/CPU/RAM, GOMAXPROCS, build flags, run mode, data scale, concurrency, rounds and the raw
artifact. Numbers from different hosts are never spliced into one claim. The tools are the ones the
repository already owns (`internal/server/bench_test.go`, `scripts/smoke-metrics.mjs`, `tests/perf/`,
`tools/benchmark-svg.mjs`); a competing system is not created. CPU/heap/block/mutex profiles,
`benchstat` multi-round comparison, `-race` and an execution trace are used where they answer the
question. A regression is reported as a regression.

### 15.3 Cache discipline

Every cache states its key, value, owner, lifetime, capacity, eviction rule, invalidation condition,
external-modification handling, concurrency model, rebuild path, failure fallback and measured
benefit. The identity-key model of the account cache (path + mtime + size, bounded, cloned values, no
TTL) is the reference. If invalidation cannot be guaranteed, the design is simpler, not cached. A
cache may never become an implicit second database.

### 15.4 Architecture discipline and the do-not-rewrite list

Boundaries are chosen by DATA OWNERSHIP, not by filename. Extraction is move-only first, one boundary
per step, each step shippable and revertible, each guarded by an existing differential gate. No
big-bang rewrite, no interface proliferation, no forwarding-only helper chains. Mature, well-tested,
semantics-complex code is left alone: the ordered-JSON semantics, the provider wire converters, the
tokenizer engines, the startup atomic-write/lock core, `fsretry`, `lockacquire`, the PNG/card
semantics, the pinned MIME tables, the middleware order, the chat-completion registry, the frontend
static serving, `internal/migrate`, `configinit`, and every oracle fixture.

### 15.5 CLI contract

A first run prints GoTavern's identity and baseline, the resolved data root and config path, and a
Ready line carrying the real URL — only after the listener serves. By default it is quiet (no internal
stage timings unless asked), never prints secrets, and prints no ASCII art. Errors name the cause and
the next step (config syntax, port in use, data-dir permission, missing tokenizer, TLS, corrupt data,
listener failure, browser launch failure) without changing a pinned error format that a fixture
asserts. `--help` and `version` work for every subcommand and in any argument position; an unknown flag
warns; colour is TTY-aware and honours `NO_COLOR`/`FORCE_COLOR`; Docker and the launchers boot
headless; Ctrl+C prints a correct, brief message. Every pinned SillyTavern flag and its documented
behaviour remain available.

### 15.6 README and performance-figure contract

The first screen states what GoTavern is, why it is lighter and how to start it: name and one-line
description, one real performance figure, the shortest install/start block, the compatibility state
with known limits, and links to the detail. The figure is ~1200×675 16:9, readable in dark and light
GitHub, with units on every number, computed (never hardcoded) multipliers, per-metric wording
("faster" for time, "lighter" for memory), no truncated axes, no external font/image/script/network
reference, and it is GENERATED from a recorded artifact. The generator is deterministic and refuses to
render without a run id and a commit. A gate compares the committed README table, figure and
provenance against the artifact, so a number cannot drift from the run that produced it. Regressions
are shown, not hidden.

## 16. The `v0.1.0-alpha.18` release bar

`v0.1.0-alpha.18` is the formal (stable-channel) release this program ships at the end of the deep
product-engineering round. It may be tagged only when ALL of the following hold, on ONE commit. The
checkable, machine-consumed form is `docs/release-manifest.json` plus the unified evidence emitted by
`scripts/verify-release-gates.mjs`; this section is the goal-level statement they must not contradict.
`v0.1.0-alpha.16` and `v0.1.0-alpha.17` are already published and their tags are immutable.

1. every required gate in `docs/release-manifest.json` has a completed/success `workflow_dispatch` run
   whose `head_sha` is the candidate, and the rebuilt unified evidence contract PASSES 13/13 at that one
   SHA — including the three selection proofs applied this round (CI `probes=full`, Browser
   `mode=all`, and the full-job selections of the multi-job gates), the tier markers read from embedded
   evidence, and the artifact digest/freshness/pinned-SHA rails;
2. the contract **refuses a narrowed dispatch by name**, demonstrated with REAL workflow runs: a
   `-f size=small` long-lived dispatch whose `medium-corpus` job is skipped is refused, and a narrowed
   selection/title/artifact is refused rather than silently accepted; a wrong SHA, wrong event, missing
   or expired artifact, and a skipped required job all block publication before `gh release create`;
3. the performance claim is real and current: the 10,000-card hotspot has a recorded root cause, a
   production change, and a same-host/same-input PAIRED measurement (alternating rounds, published
   medians and spread, both directions) showing a statistically discernible improvement of at least 20%
   in the key request p50 or peak RSS, with no material regression in the other key metrics; the
   release performance record still comes from the same-SHA `GoTavern smoke metrics` gate and no alpha.17
   number is spliced into alpha.18's claim;
4. the product capability gaps alpha.17 recorded are closed or explicitly still open: the CORS proxy
   enabled branch proxies real requests from a real local upstream (disabled branch byte-identical) and
   its SSRF policy/divergences are recorded; the pinned chat auto-backup semantics are implemented and
   tested (config precedence, throttle, retention, failure, restart, multi-user); the streaming/cancel
   resource-release evidence exists from real sockets; every fixed defect has a RED reproducer and a
   GREEN after-fix run, and anything unproven is labelled UNEXECUTED/UNPROVEN in the release notes;
5. a 60-minute mixed-load soak ran on the final candidate and is recorded with request counts, error
   counts, latency distribution, RSS/peak/CPU samples, restart integrity and the explicit limits of the
   measurement (a trend is not a leak proof; the leak verdict says UNPROVEN if resolution is
   insufficient);
6. `scripts/classify-version-tag.sh` classifies `v0.1.0-alpha.18` stable, its equality list gains the tag
   in the same change, and `scripts/test-classify-version-tag.sh` proves the new tag stable while every
   version-shaped neighbour (`v0.1.0-alpha.17`, `v0.1.0-alpha.180`, `v0.1.0-alpha.18-rc1`,
   `v0.1.0-alpha.17+build.1`, `v0.1.0-alpha.170`, …) stays prerelease;
7. `docs/release-notes-v0.1.0-alpha.18.md` is generated from / checked against the evidence, states every
   boundary and every unproven item (§14, §13, and the round's residual list: the still-unimplemented
   `chat_metadata.integrity` check, the group-save backup scheduling gap, no brotli decoder, macOS-arm64
   runtime UNVERIFIED, real-user directory NOT RUN), and does not claim ahead of a gate;
8. the release publishes with `draft=false`, `prerelease=false`, `latest=true`, six canonical archives
   plus `checksums.txt`, and the release body carries the same-SHA evidence table;
9. Docker `:v0.1.0-alpha.18` and `:latest` are published and resolve to the same digest, and older
   images are unchanged;
10. after publication the published bytes are verified INDEPENDENTLY: all six archives re-downloaded and
    checksummed, the published binary's own `version`, an unpacked run against a fresh directory with
    `/version`, `/` and at least one real data request plus one write/read closure, the published-release
    installer smoke and the published-extension smoke, and `releases/latest` pointing at alpha.18;
11. no force push, no tag move (the alpha.16 and alpha.17 tags are unchanged), no `--no-verify`, no
    private data in any artifact;
12. `GOAL.md` §14 remains **NOT MET** and no document upgrades it on synthetic evidence.

If any of 1-11 cannot be met, the release does not happen and the reason is recorded in
`docs/alpha18/handoff-ledger.md` as `BLOCKED` with the failing requirement and the run that showed it. A
formal release is a claim about the artifact, not about the intention.

## 16.1 The `v0.1.0-alpha.19` release bar

`v0.1.0-alpha.19` is the real-interaction oracle release. It may be tagged only when ALL of the following
hold on ONE commit (the machine-consumed form is `docs/release-manifest.json` — now **14 required gates** —
plus the unified evidence from `scripts/verify-release-gates.mjs` and the new gate's own verifier
`scripts/verify-a19-evidence.mjs`):

1. every one of the 14 required gates has a completed/success `workflow_dispatch` run whose `head_sha` is the
   candidate, and the rebuilt evidence contract PASSES **14/14** at that one SHA, with the selections the
   manifest records (CI `probes=full`, Browser `mode=all`, real-UI oracle `mode=all`, the multi-job gates'
   full job selections);
2. the fourteenth gate (`GoTavern real-UI oracle differential`, job `real-ui-oracle`, artifact
   `a19-real-ui-oracle-evidence`) uploaded a `release-evidence.json` whose `headSha` is the candidate, whose
   `pinnedCommit` is the pin, whose `corpus.origin` is `ui`, whose `corpus.manifestSha256` and
   `corpus.detail.treeSha256` are 64-hex and whose `corpus.detail.manifestVerification` is true, whose five
   layers are all `ok`/`match`, and whose normalisation list is either empty or every member carries the
   five-member evidence (reason, pinnedEvidence, field, test, negativeCase);
3. the verifier refuses a local-run or narrowed selection, a wrong candidate SHA, a wrong pinned commit, a
   missing corpus digest, a layer `ok:false`, a broad normalisation and a malformed document — its self-test
   proves each case (17/17) — and the comparator's teeth are demonstrated (mutating a leg artifact reds a
   named guard, restored green);
4. the real-UI corpus is committed as provenance only (manifest + report + `docs/alpha19/oracle/corpus.md`),
   the original corpus bytes never enter the repository or an artifact, and its limits are stated in the same
   place: created-vs-seeded counts, the UI-turn/product-save-path message split, extension auto-enable, the
   recorded third-party version-check request, and the phases that did not run;
5. the product fixes found by the oracle each have a RED reproducer and a GREEN after-fix run, and the
   performance rows ship with a same-host ABBA artifact whose own same-binary self-test passes and whose
   "not separable" rows are reported as not separable — the release performance claim still comes from the
   same-SHA Linux `GoTavern smoke metrics` gate, and peak RSS is labelled one Layer A paired row, not a gate;
6. `scripts/classify-version-tag.sh` classifies `v0.1.0-alpha.19` stable, its equality list gains the tag in
   the same change, and `scripts/test-classify-version-tag.sh` proves the new tag stable while every
   version-shaped neighbour (`v0.1.0-alpha.20`, `v0.1.0-alpha.190`, `v0.1.0-alpha.19-rc1`,
   `v0.1.0-alpha.19+build.1`, `v0.1.0-alpha.18+build.1`, …) stays prerelease (79/79 cases);
7. `docs/release-notes-v0.1.0-alpha.19.md` passes the curated-notes gate, names the tag, contains
   `## Known limitations` and `## Checksums`, carries no placeholder, and states every unproven item (§14
   status, the message split, extension coverage, Node control / 8-user / soak only to the extent they ran,
   p99 on the real corpus, darwin/arm64, `-race` only on Linux);
8. the release publishes with `draft=false`, `prerelease=false`, `latest=true`, six canonical archives plus
   `checksums.txt`, and the release body carries the same-SHA evidence table;
9. Docker `:v0.1.0-alpha.19` and `:latest` publish and resolve to the same digest while older images stay
   unchanged;
10. after publication the published bytes are verified INDEPENDENTLY (all six archives re-downloaded and
    checksummed, the published binary's `version`, an unpacked run against a fresh directory with `/version`,
    `/` and a data request plus a write/read closure, the installer smoke and the published-extension smoke,
    and `releases/latest` pointing at alpha.19);
11. no force push, no tag move (alpha.18 and older tags unchanged), no `--no-verify`, no private or corpus
    content in any artifact;
12. `GOAL.md` §14 remains **NOT MET** and no document upgrades it on an agent-created corpus.

If any of 1-11 cannot be met, the release does not happen and the reason is recorded in
`docs/alpha19/` as `BLOCKED` with the failing requirement and the run that showed it.

