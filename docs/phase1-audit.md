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
