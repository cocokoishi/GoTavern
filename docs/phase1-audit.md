# Phase 1 audit — what the existing evidence can and cannot prove

This is Step 1 of Phase 1: an audit of the test system as it stands, so the Phase 1 work extends what exists
rather than building a parallel harness. It records **what each surface asserts, on what input, and what a
green means** — and, where it matters more, what a green does **not** mean.

Nothing here was inferred from a name or a directory listing. Every claim below was read from the file that
makes it.

## 1. The question Phase 1 must answer

> Under a **complex** SillyTavern workflow — character card + preset + world info + macros + extension +
> chat state — does the request that finally leaves GoTavern for the provider equal the one pinned Node
> SillyTavern produces, after an explicit canonicalisation?

The forbidden substitute is explicit and worth restating, because it is the easiest thing to mistake for
progress: **POSTing fixed messages at the Go backend and showing it echoes them proves the provider adapter
and nothing else.** It cannot speak to character, preset, lorebook, macros, extension, browser state or the
generation lifecycle, which are precisely where the request is assembled.

## 2. What exists, measured

| surface | size | what it is |
|---|---|---|
| `tests/provider-wire` | 223 files | recorded provider-wire scenarios per source |
| `tests/browser` | 673 files | the browser differential probes and comparators |
| `tests/oracle` | 124 files | pinned-Node oracle recordings |
| `internal/outbound/raw.go`, `transport.go` | — | the byte-oriented wire contract |

The comparison contract is already byte-oriented: `bodySha256` recording appears across
`compare-preset-legs.mjs`, `compare-generation-legs.mjs`, `compare-authors-note-legs.mjs`,
`compare-q20-continue-legs.mjs`, `compare-helper-*.mjs`, `compare-data-domain-legs.mjs` and
`compare-extension-legs.mjs`.

## 3. The closest existing thing to Phase 1, and why it is close

`tests/browser/real-preset-probe.mjs` (427 lines) asks the Phase 1 question for **one** dimension. Its own
header:

> *"does a USER'S OWN complex preset change the model context, and does the request it produces equal pinned
> Node's?"*

It is not a synthetic in-page preset builder. It **loads a preset as a FILE** into `OpenAI Settings/<name>.json`,
selects it through `#settings_preset_openai`, and awaits the frontend's own `getPresetApplicationPromise`
before anything touches the connection. Two properties make it trustworthy in the way Phase 1 needs:

1. **It refuses to send unless the frontend reports the fixture's own structure counts** — *"105 prompts /
   109 order rows / 66 enabled for preset A, 119 / 115 / 39 for preset B"* — with the reasoning *"a cross-leg
   green on a default preset is worthless."* That is rule 48's `X != Y` half, implemented in the driver.
2. **It records a measured ordering hazard** rather than a preference: preset application completes
   asynchronously and, with `bind_preset_to_connection`, its completion path overwrites a connection source
   set 225 ms earlier — so a leg that set the source first would capture a request from a *different provider
   path than the one it claims to measure*.

Its comparator, `tests/browser/compare-real-preset-legs.mjs` (267 lines), is already a Phase-1-grade judge:

```
legsPresent                      every leg report exists and is readable
legsDrove                        the preset loaded, a chat/completions request reached the peer,
                                 and the frontend's counts match the fixture's
structureMatchesTheOracle        the structure the frontend reports matches the fixture
presetAEqualsAcrossLegs          Node(X) == Go(X)          rule 48, first half
presetBEqualsAcrossLegs          Node(X) == Go(X)
goATavernDiffersFromGoB          X != Y within one impl    rule 48, second half
bUnreferencedPromptsAbsentOnBothLegs   marker-set comparison between legs
harnessDiscriminates             rule 50: if A and B capture identically the gate fails ITSELF
```

A missing leg is a **named failure, not a crash** — recorded because run `40257173478` died on `ENOENT` and
the run carried no usable verdict.

## 4. The gap, measured rather than assumed

Dimension coverage of `real-preset-probe.mjs`, by hits in the file:

| Phase 1 dimension | hits | status |
|---|---|---|
| preset | **73** | deeply covered — probe + comparator + structural guard |
| extension | 15 | partial |
| chat state | 15 | partial |
| character | 10 | partial |
| **world info** | **0** | **not covered** |
| **macros** | **0** | **not covered** |

**So Phase 1 does not need a new harness.** It needs two dimensions added to an existing probe and its
comparator, reusing the structural-count guard so a green still cannot come from a default preset.

**The drive sequence, read in full so the coverage is established rather than inferred.** The probe's own
`step(...)` calls are, in order:

```
step('page-loaded')             the frontend loaded
step('settings-ready')          script.js settingsReady
step('real-preset-loaded')      the preset FILE loaded through the frontend's own manager
step('real-preset-structure')   the counts the frontend reports match the fixture's
step('connection-configured')   the connection is set
step('character-open')          a character is open (chatAvailable)
step('generation-completed')    the generation finished
step('peer-reached')            at least one request reached the capturing peer
```

So the sequence is **load preset -> configure connection -> open character -> generate -> capture**, and the
dimension coverage follows from it: **preset is fully driven** (load plus the structure guard), **character and
chat are driven** (`character-open`, and 15 chat-related lines), and **world info, lorebook, macros, persona and
group are not driven at all** — zero lines each, against 10 for character and 15 for chat.

That is the measured gap, and it is narrower than it looked: the probe already drives four of the eight steps a
complex workflow needs, and what is missing is the **world-info / lorebook** dimension and the **macros**
dimension. Persona and group are absent too, but they are not named in the Phase 1 dimension list and are
recorded here as observed-absent rather than as Phase 1 obligations.

## 5. The privacy model Phase 1 must hold to

Two layers, and the boundary between them is the whole design:

**Layer A — private local evidence.** May read real presets, cards, lorebooks, chats and plugin state. Runs
**only** locally. Output is limited to `PASS`/`FAIL`, canonical-request equality, mismatch **categories**,
counts, sizes, timings and opaque fixture IDs. A detailed diff stays in the gitignored local path. Real
content never enters a commit, a CI log, an artifact, a screenshot or any remote service — and encoding,
compressing or renaming it is not sanitisation.

**Layer B — public / CI evidence.** Synthetic or fully sanitised fixtures only. Its job is not to reproduce a
user's workflow but to re-model the **structural feature or bug class** that a private fixture exposed.

`/.private-fixtures/` is gitignored and carries the constraint in the ignore file itself, because an ignore
rule says only "do not commit this" — it does not say what may be printed or uploaded.

**A structural statistic is the permitted currency** — field types, nesting, array lengths, ordering, boolean
state, enum values, length classes, token counts, role sequences, injection depths, hashes, whether two
values are equal, and the names of differing fields. The probe's own structure counts (105/109/66) are
exactly this class, which is why its design is already privacy-compliant.

**A hash is not automatically safe.** Over a small candidate space, a published SHA-256 can be recovered by
enumeration; that check has to be made per field rather than assumed.

## 6. What Phase 1 must still build

1. Read `real-preset-probe.mjs`'s drive steps in full to establish the character/extension/chat-state coverage.
2. Add **world info** and **macros** dimensions to that probe, with matching guards in its comparator —
   reusing `structureMatchesTheOracle`'s shape so the new dimensions are held to the same standard.
3. Run one complex private fixture against the parent-directory data **read-only**, and produce the first
   honest `exact / normalized-equivalent / mismatch` count.
4. For any mismatch: minimal structural cause → fully synthetic reproduction → fix → public regression test.
   Only the synthetic fixture is committed.
5. Phase 1 completion report and the `PHASE 1 COMPLETE` checkpoint.

## 7. What a green will and will not mean

When Phase 1 is done, the claim that will be supportable is narrow and worth stating exactly:

> In the covered complex character/preset/world-info/extension workflows, the final provider-bound request
> from GoTavern is equivalent to pinned SillyTavern's after canonicalisation.

The claim that will **not** be supportable, and must not be written: that every future SillyTavern behaviour
is proven identical. Where a surface cannot be observed, the row says so rather than going green by omission.


## 8. Local execution capability — measured, and a correction

Phase 1's Layer A must run **locally**, because it reads real user data and that data may never reach CI. An
earlier report in this workstream claimed the host could not run it. **That claim was wrong in every respect**,
and the measurements are recorded here so the error is not repeated.

What is actually present on this host:

```
node     v24.19.0
npm      11.17.0
go       go1.27.0 windows/arm64
python   3.15.0
harness  tests/browser/node_modules/@playwright/test 1.56.1   (pinned to the baseline's own Playwright)
oracle   ../SillyTavern  (package.json and public/ present, one level ABOVE the repository)
```

### The six errors behind the false blocker

All six are the same class — a wrong path or a failed invocation producing a **confident false negative**:

1. **`node_modules` looked for at the repository root** instead of `tests/browser/node_modules`. The
   dependencies were installed the whole time, one directory deeper.
2. **`SillyTavern` looked for inside the repository** instead of at the parent level. The oracle sat one
   directory up.
3. **`npm` invoked as `& npm --version`**, which fails in PowerShell; `npm.cmd --version` answers `11.17.0`.
4. **`go` invoked the same way**, which fails identically; `go.exe version` answers `go1.27.0`.
5. **A glob one level short** — the harness's own config sits in `.private-fixtures/`, so `../` is the
   repository, not its parent.
6. **A vacuous pass inside the harness's own gate**: *"every private source is OUTSIDE the repository"*
   reported **ok** while the config failed to parse, because the loop over the declared roots never ran. That
   check now requires a non-empty resolved set before it can pass at all.

**The lesson is the project's own, applied to a precondition gate rather than to a test**: a check that looks
in the wrong place is worse than no check, because it produces a confident negative and that negative gets
reported as a finding. Six instances in one gate is why the gate now asserts every path against a resolved
absolute value rather than composing one and trusting it.

### The probe's invocation, established

`tests/browser/real-preset-probe.mjs` requires:

```
GOTAVERN_BINARY=<path>  node tests/browser/real-preset-probe.mjs \
    --preset <preset.json> --preset-name <name> \
    --expect-prompts N --expect-rows N --expect-enabled N \
    --data-root <tree> --report <out.json>
```

`GOTAVERN_BINARY` is mandatory — the probe throws `GOTAVERN_BINARY is required for the GoTavern leg` without
it. The `--expect-*` values are the fixture's own structure counts, which is what makes a green meaningful: a
cross-leg green on a default preset is worthless.

### The one real constraint: the binary must be built

A prebuilt `gotavern.exe` sits in the repository root, **dated 2026-10-23 and reporting `0.0.0-dev` — no
commit identity at all**. It is stale: **35 runtime `.go` files have changed since that date**, the most
recent being `93dc064` on 2026-10-26.

So a Layer A run must **build a current binary first**. Using the stale one would measure an older GoTavern
and the result would say nothing about `main`. And because the prebuilt binary carries no revision, a result
produced from it could not be attributed to a commit even if it were current — which is a second reason to
build rather than reuse.

### What this changes

Steps 4 and 5 are **executable on this host**. Nothing needs provisioning, no decision is outstanding, and
the option list in the previous report is withdrawn as moot. The remaining work is to add the world-info and
macro dimensions to the probe, build a current binary, and run one complex private fixture.


## 9. Layer A, first run — a real result on real private content

Steps 4-5 have now been executed **locally**, against two real private presets, with the pinned SillyTavern
checkout as the oracle. Nothing about this run is committable: the fixture content, the leg reports and the
comparison artefact all live under the gitignored `/.private-fixtures/`. What is recorded here is the
**method** and the **structural result**, which is the part that can leave the machine.

### The method, which is the CI invocation with the fixture swapped

```
GOTAVERN_BINARY=<built binary> node tests/browser/real-preset-probe.mjs \
    --data-root <tree-gotavern> --preset <real preset> --preset-name <opaque> \
    --expect-prompts N --expect-rows N --expect-enabled N --report <leg>

node tests/browser/run-against-pinned.mjs real-preset-probe.mjs -- \
    --data-root <tree-pinned> --preset <real preset> --preset-name <opaque> \
    --expect-prompts N --expect-rows N --expect-enabled N --report <leg>

node tests/browser/compare-real-preset-legs.mjs <gv-a> <pn-a> <gv-b> <pn-b>
```

**Three requirements that are not obvious and each cost a run to find:**

1. **A separate data root per subject.** The first attempt shared one tree and the pinned leg failed at
   `generation-completed` with `peerRequests: 0` -- it was reading state the GoTavern leg had written. That is
   the ordered/shared-state hazard, and it presents as a probe-faithfulness alarm rather than as anything
   about the product. CI uses `real-preset-tree-$subject-$preset` for exactly this reason.
2. **Two presets, not one.** The comparator's usage line is
   `<gotavern-a> <pinned-a> <gotavern-b> <pinned-b>`, because rule 48's second half is that `X != Y` within
   one implementation: a comparator handed a single preset can only check `Node(X) == Go(X)`, and an
   implementation that ignored preset selection entirely would satisfy that against a weak comparator.
3. **The `--expect-*` values are the fixture's own structure counts**, derived from the preset JSON
   (`prompts.length`, and the total and enabled counts across `prompt_order[].order[]`). They matched the
   values CI passes for the committed derivations exactly.

### The result

Four legs, two fixtures, **two requests per leg** -- the comparator's own comment explains why: *"since the Q12
change each leg sends two, and the first is a minimal single-turn assembly."*

| fixture | request | bytes | messages | cross-subject |
|---|---|---|---|---|
| A | full assembly | 5,810 | 8 | **identical** |
| A | minimal single-turn | 201 | 1 | **identical** |
| B | full assembly | 9,816 | 15 | **identical** |
| B | minimal single-turn | 199 | 1 | **identical** |

**Eight requests recorded, four independent cross-subject comparisons, every one equal** on body sha256,
byte length and the message array -- and A differs from B on both assemblies, which is rule 48 in full.
`harnessDiscriminates` (rule 50) also held.

**This is the first substantial parity evidence on real private content**, and it is stronger than a
single-request run would have been, because each fixture contributes two independent comparisons.

### The one guard that cannot pass here, and why it is a fixture limitation

`aEnabledRowPointingAtDisabledPromptContributes` failed with *"no preset-A request carried a fixture marker at
all."* Its own documentation says what it wants: *"A has 46 rows that are enabled while their prompt says
`enabled:false`; at least one of their bodies must arrive on both legs."*

**It identifies a prompt's body by the `MARK_NNNNNN` marker the committed derivation substitutes for prose.**
A real preset carries prose instead, so the guard is **unsatisfiable on real content by construction**. That
is a fixture-scope limitation and not a product finding -- but it is a real Phase 1 finding: **Layer A needs a
marker-independent guard for that property**, or the comparator needs a real-preset mode. Until then the
verdict cannot reach `match` on real content even when every parity guard passes.

### What this run does not establish

- **Windows only**, against a binary built from a named commit that reports `0.0-dev` and therefore carries
  **no commit identity of its own**. A Windows result is not the Linux gate; this is Layer A evidence, which
  is precisely the kind that has no Linux gate, and it must not be presented as a CI green.
- **No world info, no macros, no extension, no character card.** The probe's drive sequence covers preset,
  character and chat; world info and macros are at zero hits and are the remaining real-content dimensions.
- **The request is compared, not the model's response**, and no real provider is contacted (rule 22 is not
  exercised here).

### The method's own hazard, recorded because it happened

**Three consecutive rounds of this work produced a reported defect that turned out to be a misreading** --
a wrong `node_modules` path, a "201 bytes" figure taken from the comparator's summary of a *different*
request than the one being described, and a "comparator discrepancy" that was the same index confusion. The
instrument was right each time. The lesson is not "trust the tooling" but the project's own rule applied to
reporting: **a derived field is not a measurement, and a reading must be checked against its source before it
is reported as a finding.**


### 9b. The guard's marker dependency, confirmed by a controlled comparison

The claim in 9 was that `aEnabledRowPointingAtDisabledPromptContributes` fails on real content because it
identifies a prompt's body by the `MARK_NNNNNN` marker the derivation substitutes for prose. **A claim about a
cause deserves a control**, so the same four-leg comparison was run a second time against the **committed
derivation** -- same probe, same runner pattern, same comparator, one variable changed.

```
COMMITTED DERIVATION (tests/browser/fixtures/real/preset-{a,b}.json)
  verdict        match
  failedGuards   []
  all ten guards ok, including aEnabledRowPointingAtDisabledPromptContributes

REAL PRIVATE PRESETS
  verdict        mismatch
  failedGuards   ["aEnabledRowPointingAtDisabledPromptContributes"]
  nine of ten guards ok; every parity guard true
```

**Two data points, one variable.** The guard passes where the markers are and fails where they are not, with
every other guard true in both cases -- so the failure is the fixture's marker dependency and not the product,
and not a defect in the guard itself.

**The derivation run is public-safe** -- its fixture is committed -- so unlike the Layer A run this result can
be stated in full: **the committed derivation reaches `verdict: match` with all ten guards green on this
host.** That is worth recording as a baseline, because it means the comparator's own happy path is confirmed
locally and the only thing standing between Layer A and a `match` verdict is the marker dependency.

**What the fix must preserve, therefore:** whatever makes the enabled-row property satisfiable on real content
must leave the derivation's `match` intact. The guard is a real assertion on the class where it works, so the
change is additive -- a second way to identify the bodies -- rather than a replacement.
