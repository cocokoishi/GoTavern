# Verifier audit — guards that cannot discriminate

> **THIS IS A HISTORICAL INVESTIGATION, NOT CURRENT STATUS.** Its scope was a commit that the
> repository's lineage no longer contains (the history was rewritten on 2026-10-29 to normalise commit
> identities), so every `file:line` and every "fixed and CI-green" statement below describes a tree that
> is no longer on `main`. The live per-question ledger is
> [`docs/goal-scorecard.md`](goal-scorecard.md); the current status of these findings is the table in
> §0, which was re-measured at HEAD rather than carried forward.

## 0. Current status, re-measured 2026-10-29 (the only current claim in this file)

A re-audit at HEAD asked, for every finding, not "did a run go green" but **"does the guard exist in
this tree, does it run in CI, and can it still fail"**. That distinction matters because a run citation
about an orphaned commit cannot prove anything about this code.

| Finding | Status at HEAD | Current guard |
|---|---|---|
| F1, F16 (a failed lane read as green; counters never read) | fixed, `fae8513` | `browser-differential.yml` terminal gate reads every lane's failure counter; **no teeth proof and no structural test** — the closure is unguarded against regression |
| F2 (tokenizer pairing positional) | fixed (pairing), observation still separate by decision | `compare-preset-legs.mjs` pairs by request key; `tokenizer-comparator-selftest.mjs` includes the old positional walk as a control |
| F3 (no per-subject discriminator in save/reload/swipe) | fixed (guard), **teeth owed** | `compare-q20-legs.mjs` `artefactsDifferPerSubject`; there is no comparator self-test for it |
| F4, F5, F6, F7, F8, F10, F11, F12, F13, F14 | fixed, `14d5e57` (F12 also `fae8513` lineage) | each has a named selftest case under `tests/browser/*-gate-selftest.mjs`, `verifier-guards-gate-selftest.mjs` or `streaming-framing-selftest.mjs` |
| F9 (helper-generation `driveCompleted` vacuous) | **false finding** — the `Boolean(leg) &&` guard was present before the audit was written | `compare-helper-generation.mjs`; regression case retained |
| F15 (self-tests claim more coverage than they have) | **OPEN** | measured at HEAD: two framing guards and five regex guards are named in no self-test while the footer claims "every guard … can fail" |
| F17 (a nondeterministic body classified `equal`) | **OPEN, documented decision** | `compare-startup-legs.mjs` still counts the shape-classified body into `summary.equal`; it does not record the unstable value, so no compared field carries it |
| §3 Q20 continue positional selection | fixed | `continueRequestOf` anchors on the product's own nudge marker; `q20-continue-comparator-selftest.mjs` kills all 14 required guards by name |

Two claims this document made about verifier integrity are **narrower than stated** and are corrected
here: guards are compared by NAME presence per surface, and a two-way set comparison (so a guard cannot
silently appear or disappear) exists only for the streaming-framing and chat-completion checks — not for
assets, helper or variables. And `tools/docs-check-manifest.mjs`, the only thing that can re-check a
recorded run CONCLUSION against the live API, is not invoked by any workflow.

---

## Historical audit (scope: a pre-rewrite commit, kept for the reasoning, never as current status)

Scope: every browser-differential comparator, self-test, evidence module and the workflow that runs
them, at HEAD `292905f`. Method: for each guard, answer "what input/state would make this fail?" and,
mirror-wise, "what real defect would this guard NOT catch?". A guard with no answer to the first
question is a finding. Every claim below cites `file:line`; anything I could not cite is in
§5 "Uncertain" rather than in the table.

This document is READ-ONLY evidence about the harness. It does not declare the project complete and it
does not fix anything outside its own scope.

The defect class, as briefed: (a) unsatisfiable-by-construction, (b) cannot fail (tautology,
self-comparison, absent input read as pass, subject/oracle sharing a definition), (c) a compared value
that is leg-specific by construction, (d) producer/consumer signature mismatch, (e) a step that can skip
while the run reports green, (f) a selector that picks the wrong request rather than the product's own
marker.

---

## 1. Findings, ranked by whether they can produce a FALSE GREEN

### F1 — An all-regex-legs-failed run is GREEN (class e) — worst

* `.github/workflows/browser-differential.yml:1775` records the six regex legs, writes `failures=1` on
  each failure (`:1793`) and `failures=0` first (`:1795`), then **exits 0** (`:1835`).
* `.github/workflows/browser-differential.yml:1844` (compare) and `:1874` (self-test) are both gated on
  `steps.regex.outputs.failures == '0'` — so when the counter is 1 they are **skipped**.
* `.github/workflows/browser-differential.yml:1986` (the terminal "Fail if a drive could not be
  recorded" gate) lists `record`, `preset`, `asset`, `helper`, `helper-generation`, `authors-note`,
  `ui-layout`, `helper-vars`, `framing` — **and not `steps.regex.outputs.failures`**. Verified by grep:
  `steps.regex` appears only at `:1839`, `:1844`, `:1874`, i.e. only inside the two steps the counter
  itself disables.
* `regex-comparison.json` is never staged into `$work/committed` (no `save_committed` in the regex
  steps), so the freshness loop (`:1938`) never sees it, and `tools/verify-browser-comparisons.mjs`
  does not read it (its fixed list is `:187-199` plus the catalogue loop at `:164-184`).

Consequence: a `mode=regex` (or nightly `all`) run in which **all six** regex legs die is green, the
job summary reports no regex finding, and nothing is claimed about the regex surface. This is the exact
shape the step's own comment at `:1785-1790` says it fixed ("all six legs failed ... and the job was
green and claimed nothing"): the counter was written but its consumer in the terminal gate was never
added.

Smallest fix: add `|| (steps.regex.outputs.failures != '0' && steps.regex.outputs.failures != '')` to
the `:1986` condition. Needs no re-record.

### F2 — The preset lane's tokenizer comparison pairs counts by POSITION and its conclusion is not established (classes b + f)

`tests/browser/compare-preset-legs.mjs:160-182` (`compareTokenizers`) compares
`gotavernCounts[index]` with `pinnedCounts[index]` and returns on the first mismatch with the note "the
same message counted differently by the two servers; the pinned count is the oracle" (`:176`). The call
lists are the browser's own `/api/tokenizers*` traffic (`tests/browser/generation-probe.mjs:700-708`),
so their length and order are observations, not a contract — and they differ.

Measured on the COMMITTED artefact (`tests/browser/preset-complex-comparison.json`):

| field | value |
| --- | --- |
| `tokenizer.keep.gotavernCalls` (`:596`) | 73 |
| `tokenizer.keep.pinnedCalls` (`:597`) | 67 |
| `tokenizer.keep.firstDifference.note` (`:748`) | "the same message counted differently by the two servers; the pinned count is the oracle" |
| `tokenizerCountsAgree` (`:908`) | `false` |
| `verdict` (`:500` in the comparator) | `match` |

Alignment check I ran on the committed arrays (greedy subsequence match): **all 67 pinned counts are
present in the GoTavern sequence, in the same relative order**; GoTavern's only extra entries are six
additional calls (225, 380, 589, 749, 57, 13). So the artefact's `firstDifference` is a **positional
artefact of an extra call**, not a measurement that one message was counted differently — and
`requestText` at `:175` is taken from `theirs.requestText ?? mine.requestText`, i.e. pinned's text is
printed beside GoTavern's count for a different call.

Two consequences. (i) The claim the lane rests on ("a difference names the first message whose count
disagrees", `:17-20`) is not what the code does. (ii) The real signal — the same frontend issued six
MORE tokenizer calls against GoTavern — is recorded only as a mis-diagnosed count difference, and
`tokenizerCountsAgree` is an observation, not a guard (`:492-495`), so it cannot fail the run: the
artefact is `verdict: "match"` while carrying a `false`.

This gap is already named in `docs/gate-blindspots.md:98-105` ("`tokenizerCountsAgree: false` sits
inside a `match` verdict without failing it"; remedy: "A verdict that contains a `false` in its guards
is not a `match`"). It is still live at HEAD, and the committed artefact demonstrates it.

Also relevant: `tools/generate-coverage-matrix.mjs:238-257` reads this artefact and reports
`status: 'measured'` from `verdict`/`providerRequestEqual` only — it never reads `tokenizerCountsAgree`.

Smallest fix: pair the two call lists by the message identity both legs already record
(`tokenizerCounts` records `requestText` at `:152`), report extra/missing calls as their own
classification, and make a genuine per-message count difference a guard (so the verdict cannot stay
`match`). Needs a re-record: the artefact's `tokenizer` block changes shape.

### F3 — The Q20 save/reload/swipe pair has no per-subject discriminator (rule 50) — class b

`tests/browser/compare-q20-legs.mjs` defines `legsPresent, legsDrove, peerServedTheRequestedWire,
saveWroteTheChat, reloadReadsTheChat, nodeEqualsGoAfterReload, goSwipeDiffersFromGoTurn,
nodeEqualsGoAfterSwipe` (`:123-262`) and **no guard that the two legs' inputs differ**. The probe's
markers are hard-coded (`tests/browser/q20-persistence-probe.mjs:264-267`, no `process.env` override)
and the workflow passes none (`browser-differential.yml:1419`, `:1427`), while each leg's peer counts
replies from its own `replyIndex` starting at 0 (`tests/browser/q20-leg-runtime.mjs:92`, `:134-164`).
So both subjects are fed byte-identical user turns and byte-identical peer replies, and
`nodeEqualsGoAfterReload`/`nodeEqualsGoAfterSwipe` compare requests the harness made identical in
content. The sibling lane measured exactly this and refused it: `compare-q20-regen-legs.mjs:225-237`
(`artefactsDifferPerSubject`) plus `Q20_REGEN_SECOND_MARKER` / `Q20_REPLY_PREFIX`
(`browser-differential.yml:1494`, `:1519`).

Smallest fix: give `q20-persistence-probe.mjs` a `Q20_SECOND_MARKER`/`Q20_REPLY_PREFIX` override the way
the regen probe has one, pass distinct values per subject from the workflow, and add the
`artefactsDifferPerSubject` guard. Needs a re-record of `q20-comparison.json` (not committed; produced
per run).

### F4 — `hopReleasedLessThanThePeerWrote` never compares "released" with "written" (class b)

`tests/browser/compare-streaming-framing.mjs:291-297`: the guard's name and its own comment
("the peer wrote 15 frames and the hop released 3, so 'the stream could not have finished' is a
measurement") assert an arithmetic comparison that the condition does not perform. The condition is
`framesWritten(...).every(frames => frames > 0) && bodyWriteCount > 0` on both legs — no comparison of
`releasedBytes`/relayed frames against `framesWritten` anywhere in it. The verifier's recomputation
copies the same wrong formula (`tools/browser-evidence/streaming-framing.mjs:120-123`), so its
"recompute must agree" rule cannot catch it, and `FRAMING_GUARD_NAMES.abort` requires it true (`:36`).

Indirect coverage exists (`partialTextIsAProperPrefixOfTheWholeReply`,
`compare-streaming-framing.mjs:304-310`, requires partial ≠ whole), so a hop that released everything
would not pass the surface — the guard is a mislabelled duplicate rather than an open hole. Its cost is
that the surface's stated arithmetic claim is asserted in prose in two files
(`compare-streaming-framing.mjs:293-295`, `tools/browser-evidence/streaming-framing.mjs:201-206`) and
implemented in neither.

Also: this guard is never mentioned in **either** framing self-test (measured: of the 34 comparator
guards, only `hopReleasedLessThanThePeerWrote`, `noPageErrorsThroughTheHop` and
`relayedDeliveredContentToThePage` appear in neither `streaming-framing-selftest.mjs` nor
`streaming-framing-verifier-selftest.mjs`), while `streaming-framing-selftest.mjs:348` prints
"every guard the framing comparator names can fail". That footer is an overclaim.

Smallest fix: assert `relayedFrames(hop) < framesWritten(peer)` (or `releasedBytes` < the peer's written
bytes) and add one self-test case that releases the whole body. Comparator change needs a re-record only
for the artefact's guard value if it flips; the fix itself is a re-record-free strengthening.

### F5 — The Q17 preset-identity check passes vacuously when the field is absent (class b)

`tests/browser/compare-authors-note-legs.mjs:303-307`:
`fired = atSend?.matchesCharacter === true || after?.matchesCharacter === true` then
`checks[...] = fired === false`. When a leg records **no** `presetIdentityAtSend`/`presetIdentityAfterOpen`
at all, `fired` is `false` and the check is **true** — directly contradicting the comment two lines above
(`:301-302`: "A leg that records no identity at all is NOT a pass either"). `details[...]` records the
nulls, but nothing fails. The self-test only covers the `matchesCharacter: true` case
(`tests/browser/authors-note-gate-selftest.mjs:461-464`), so the vacuous branch has never been executed,
and `tools/browser-evidence/other-surfaces.mjs:376` does not require this check by name (it is only
folded into `allLayoutAndByteChecksPassed`).

Smallest fix: `checks[...] = atSend !== null || after !== null ? fired === false : false` (or require the
field explicitly). No re-record; the committed artefact's `checks` are recomputed by the verifier.

### F6 — The cancellation prefix property is verified on the GoTavern leg twice and never on pinned (class b)

`tools/browser-evidence/invariants.mjs:280-284`:
```js
const prefix = text => text.trim().length > 0 && streamedReply.startsWith(text);
const observed = streamedReply.length > 0 && prefix(abortedText(block)) && prefix(abortedText(block));
```
`abortedText` is `block.gotavern.finalAssistantText` (`:253`), so the second conjunct is the first one
repeated and `cancellation.pinned.finalAssistantText` — which the comparator does write
(`compare-streaming-legs.mjs:116`) — is never recomputed. The recorded flag
`cancellation.checks.abortTextIsPrefixOfStreamedReply` is required true (`:203`) and could be hand-edited
true beside a pinned leg whose aborted text is unrelated to the streamed reply, with the gate reporting
nothing. (`NOT_RECOMPUTABLE` at `:250` lists this name even though the code above it does recompute it —
the two disagree about what the gate does.)

Smallest fix: `prefix(abortedText(block)) && prefix(String(block?.pinned?.finalAssistantText ?? ''))`.
No re-record (verifier-side recomputation only).

### F7 — `artifactNamesItsSource` cannot fail (class b)

`tools/browser-evidence/catalog-checks.mjs:120-127`: the function's only conditional early-returns
because `driveParametersMatchCatalog` already reported the same thing (`:123-126`), and otherwise it only
`ctx.observe`s. Its header (`:113-119`) states the invariant it exists for — "a run that compared
openrouter legs and wrote them into the groq file would pass every other check" — and that check is not
performed here. (Sources with a seam are covered by `seamEnvVar` comparison at `:74-81`; `custom`, which
has no seam and no `driveParameters`, is not covered at all.)

Smallest fix: fail when the artefact names no source at all (e.g. `custom` with no `driveParameters`),
or delete the function and its call rather than keeping a name that reads as a gate. No re-record.

### F8 — Startup final-state: absent on both legs reads as "equal" (class b)

`tests/browser/compare-startup-legs.mjs:124-135` compares a FIXED list of 15 keys with
`gotavern?.[key] ?? null` vs `pinned?.[key] ?? null`; a key the probe stopped recording is `null` on
both sides and lands in `equalFields`. Nothing requires the 15 keys to be present, and
`tools/browser-evidence/other-surfaces.mjs:127-152` (`startupSurface`) never reads `finalState`, so a
probe regression that drops `quickReplyPresent` would silently reduce coverage while the artefact
reports the field as equal. The sibling comparator does it correctly:
`compare-extension-legs.mjs:169` enumerates the UNION of both legs' keys.

Smallest fix: enumerate the union (as the extension comparator does) and report keys absent on both legs
as unmeasured rather than equal. No re-record.

### F9 — Helper-generation `driveCompleted` is vacuously true for a missing leg (class b)

`tests/browser/compare-helper-generation.mjs:61`: `Boolean(leg) && ...` is missing —
`(leg.steps ?? []).every(...)` over `[]` is `true`, so a leg that never ran reports
`driveCompleted: true` (only `legsPresent` catches it, `:99`). The render sibling has the guard
(`compare-helper-legs.mjs:84`: `Boolean(leg) && (leg.steps ?? []).every(...)`). The verifier requires
both guards true (`other-surfaces.mjs:315-325`), so this is a missing second opinion rather than a live
false green.

Smallest fix: add `Boolean(leg) &&`. No re-record.

### F10 — Self-comparison of `pinnedCommit` on the pinned subject (class b)

* `tests/browser/compare-helper-vars-generate-legs.mjs:232`:
  `surface.pinnedCommit === (on.pinned?.apiSurface?.pinnedCommit ?? null)` — for `subject === 'pinned'`
  both sides are the same expression.
* `tests/browser/compare-helper-vars-legs.mjs:295`: identical shape.

The GoTavern half is meaningful; the pinned half cannot fail. `other-surfaces.mjs:507-510` pins the
commit against a literal for the narrow vehicle, which is why this is not a live hole — but the guard as
written asserts less than its name.

Smallest fix: compare each subject's `pinnedCommit` against the pinned literal (or against the other
leg), not against itself. No re-record.

### F11 — A condition that cannot change the outcome (class b, latent)

`tools/browser-evidence/catalog-checks.mjs:101`:
`const record = surface === 'generation' ? artifact.proxyPasswordPresent : artifact.proxyPasswordPresent;`
Both branches are the same expression, so the parameter cannot influence the check. It reads the
top-level field for both surfaces (which is what the streaming comparator emits,
`compare-streaming-legs.mjs:232-235`, so it currently works); the risk is that the intended
surface-specific read was never written, and a future move of that field would produce a red with no
cause. (`proxyCredentialRow` is called without a surface from `verify-browser-comparisons.mjs:96`, so
`surface` is `undefined` there.)

Smallest fix: delete the ternary and read the field the caller actually passes, or pass the surface and
read `artifact[surface]?.proxyPasswordPresent ?? artifact.proxyPasswordPresent`. No re-record.

### F12 — The streaming comparator cannot exit non-zero, so the workflow's attribution branch is dead (class e, attribution only)

`tests/browser/compare-streaming-legs.mjs` prints its artefact (`:243`) and sets no `process.exitCode`,
so it exits 0 even when every check is false. `browser-differential.yml:446-450` is written as
`node compare-streaming-legs.mjs ... > artefact || { echo "::error::...refused"; failures=$((failures+1)); }`
— a branch that can never run. The red does surface, but one layer away, in
`tools/verify-browser-comparisons.mjs` → `streamingSurfacesProven` (`invariants.mjs:252-304`), which
requires `compatibleReady === true`; so the failure is attributed to the verifier rather than to the
comparison the workflow names.

Also in the same file: the `checks` object literal declares `finalTextNonEmpty` twice (`:85` and `:96`).
The second wins, so the `trim()`-based first definition is dead code (the two are not equivalent for a
whitespace-only reply).

Smallest fix: set `process.exitCode = 1` when any check is false (as `compare-generation-legs.mjs:455`
does), and delete the duplicate key. No re-record.

### F13 — An alias presented as a guard (class b)

`tests/browser/compare-asset-legs.mjs:143`:
`guards.stagedBackgroundPaintedOnBothLegs = guards.stagedBackgroundDrivenOnBothLegs;` — one measurement,
two names. Both names are declared unproven (`:452-453`), so both are excused and neither can fail
independently; the `unproven` list carries two entries for one cause. `other-surfaces.mjs:34-49` requires
neither of them, and `:116-122` accepts a false guard that `unproven[]` names.

Smallest fix: drop the alias (keep `stagedBackgroundDrivenOnBothLegs` and one `unproven` entry), or make
the paint guard read its own observable (`appliedBackgroundImage` naming the staged file). No re-record
beyond the artefact's guard/unproven lists.

### F14 — Tautological fallbacks inside `boundaryMatchesTheCapture` (class b)

`tests/browser/compare-preset-legs.mjs:404-407`:
`keepDrop.keep.pinnedHistoryMessages === (boundary.keepHistoryMessages ?? keepDrop.keep.pinnedHistoryMessages)`
— when the boundary file carries no `keepHistoryMessages`, this conjunct compares the observed value with
itself and is vacuously true. The same for `dropHistoryMessages` on the next line. The
`pinnedMessages === expectedMessages` conjuncts in the same guard do catch a boundary file whose totals
are missing, so this is a dead conjunct rather than an open hole.

Smallest fix: require the boundary fields to be present (or compare against a literal that must exist).
No re-record.

### F15 — Self-test coverage does not match what the self-tests claim (class b, meta)

* `tests/browser/streaming-framing-selftest.mjs:348` prints "every guard the framing comparator names can
  fail"; measured against the comparator's 34 guards, three are named in neither framing self-test
  (`hopReleasedLessThanThePeerWrote`, `noPageErrorsThroughTheHop`, `relayedDeliveredContentToThePage`),
  and F4 shows the first one cannot fail for the reason its name gives.
* `tests/browser/preset-gate-selftest.mjs` exercises four mutations and never touches
  `compareTokenizers` (`:1-19`, `:113-165`), which is where F2 lives.
* `tests/browser/regex-gate-selftest.mjs` does not exercise `legsDrove`,
  `variantsAreDistinctDeclarations`, `harnessDiscriminates`, `case5_disabledRuleIsUnchangedAndTheLegSaysWhy`
  or `case5_noMatchIsUnchangedAndSaysWhy` (measured by name-matching against the comparator's 17 guards).

Smallest fix: soften the printed claim to the guards actually exercised, or add one case per uncovered
guard. No re-record.

### F16 — Counters written but never read (class e, latent)

`browser-differential.yml:1388` (`real_preset_failures`) and `:1436` (`q20_failures`) are written to
`$GITHUB_OUTPUT` and read by nothing (verified by grep). Today the corresponding compare steps are not
gated on them (`:1391`, `:1439`), so a missing leg makes the comparator throw ENOENT and the step fails —
the run is red, not green. The hole is that the only thing making it red is the comparator crashing on an
absent file; if either comparator ever tolerates a missing leg, the counter that was written to catch it
is ignored.

Smallest fix: add both to the terminal gate at `:1986` (the same edit as F1). No re-record.

### F17 — A nondeterministic body is classified `equal` (class c boundary, documented)

`tests/browser/compare-startup-legs.mjs:221-232` classifies a row whose body differs between two runs of
the same leg as `classification: 'equal'` with `bodyComparison.shape: true`. The decision matches AGENTS
rule 18, but the row then counts in `summary.equal` (`:240-243`) and cannot be told from a compared row
without opening `bodyComparison`. `compare-extension-legs.mjs:155-161` does the same with
`body.shape: true`. This is recorded as a decision, not a defect; the risk is a reader (or a future
scorecard generator) counting `summary.equal` as "compared".

Smallest fix: keep the shape record but classify it as its own value (`equal-shape`) so the count cannot
be read as a comparison. Needs a re-record of `startup-comparison.json` (committed).

---

## 2. What I checked and found CORRECT (coverage, so the audit is auditable)

Read in full: `tests/browser/compare-q20-legs.mjs`, `compare-q20-regen-legs.mjs`,
`compare-generation-legs.mjs`, `compare-streaming-legs.mjs`, `compare-preset-legs.mjs`,
`compare-asset-legs.mjs`, `compare-ui-layout-legs.mjs`, `compare-streaming-framing.mjs`,
`compare-real-preset-legs.mjs` (`:120-329`), `compare-authors-note-legs.mjs` (`:60-504`),
`compare-data-domain-legs.mjs`, `compare-startup-legs.mjs`, `compare-extension-legs.mjs`,
`compare-helper-legs.mjs`, `compare-helper-generation.mjs`, `compare-helper-vars-generate-legs.mjs`,
`compare-helper-vars-legs.mjs` (`:80-409`), `q20-leg-runtime.mjs`, `q20-regenerate-probe.mjs`,
`url-recorder.mjs`, `run-against-pinned.mjs`, `catalog.test.mjs`, `preset-gate-selftest.mjs`,
`streaming-framing-selftest.mjs`, `streaming-framing-verifier-selftest.mjs`,
`tools/verify-browser-comparisons.mjs`, `tools/browser-evidence/{invariants,freshness,catalog-checks,
other-surfaces,source-hooks,streaming-framing,hop-log}.mjs`, `.github/workflows/browser-differential.yml`
(all 2032 lines).

Specifically verified as having teeth:

* **Bytes stay the contract.** Every provider-wire comparison is `sha256` + `bodyLength` on the raw
  body: `compare-generation-legs.mjs:122-127`, `compare-streaming-legs.mjs:44-51`,
  `compare-preset-legs.mjs:42-62`, `compare-regex-legs.mjs:73-92`, `compare-authors-note-legs.mjs:352-355`.
  Parsing is used for diagnosis only, and each file says so.
* **Absent-is-not-a-pass is handled in the Q20/regex/helper comparators.** `compare-q20-regen-legs.mjs`
  `:114`, `:118-121`; `compare-regex-legs.mjs:109-115` (`require()`), `:130`; `compare-q20-legs.mjs:151`;
  `compare-helper-vars-*.mjs` (`legsPresent` forced into `failedGuards` at
  `compare-helper-vars-legs.mjs:389-393`).
* **Rule 50 discriminators exist where the lane needs one.** `compare-regex-legs.mjs:152-168`
  (`variantsAreDistinctDeclarations`), `:202-232` (both directions of a negation),
  `compare-real-preset-legs.mjs:169-177`, `:301-309` (`harnessDiscriminates`),
  `compare-helper-legs.mjs:148` (`helperSeenOnlyWhenOn`), `compare-helper-generation.mjs:70-71`,
  `compare-q20-regen-legs.mjs:225-237`, `compare-preset-legs.mjs:390`, `:399-400` (the keep/drop pair
  must bind and differ by exactly one history turn).
* **Producer/consumer field names agree in the Q20 continue/regen pair I was told not to edit.**
  `report.preContinue.page.chatId` / `report.characterOpen.characterName` are read by
  `browser-differential.yml:1602`, `:1623` and by `compare-q20-continue-legs.mjs`; the regen leg reads
  `preRegenerate.page.chatId` (`browser-differential.yml:1508`) and
  `compare-q20-regen-legs.mjs:195`. Both match what the probes write
  (`q20-regenerate-probe.mjs:418`, `q20-continue-probe.mjs:529` for `preContinue`, `:721` for
  `nextTurnCarriesNudge`). The
  `replyText(replyIndex, replyIndex)` signature at `q20-leg-runtime.mjs:164` is called with the
  two-argument shape its consumer declares (`:151-163`) — the historical one-argument defect is fixed.
* **The catalogue's two directions are both gated.** `catalog.test.mjs:83-103` (every artefact belongs
  to exactly one source, and every on-disk artefact is claimed), `:185-191` (no committed artefact is
  gitignored), `:168-183` (the long-form variable artefact is not swallowed by the leg prefix).
  `tools/verify-browser-comparisons.mjs:268-278` re-checks the converse for chat-completion artefacts.
* **The verifier recomputes flags instead of trusting them.** `invariants.mjs:81-92`
  (`providerRequestEqual`), `:106-147` (send-window guards recomputed from the invocation trail),
  `:216-304` (`recomputeSurface`, `compatibleReady`), `streaming-framing.mjs:171-193`.
* **Host-derived values are swept.** `verify-browser-comparisons.mjs:147-155`, plus the in-comparator
  sweep at `compare-preset-legs.mjs:503-510` and the loopback normalisation at
  `compare-asset-legs.mjs:356-370`; the committed artefacts pass it today.
* **The workflow's mode gating is deliberate and mostly complete.** The `if:` expressions that combine a
  mode test with a failure counter (`:1173`, `:1532`, `:1656`, `:1844`, `:1874`) are the shape that
  prevents a skipped step's empty output from reading as `'0'`; the F1/F16 omissions are the exceptions.
* **`preset-gate-selftest.mjs:106-111`** requires the baseline to be green **and** the two context guards
  to be present, so the mutations cannot "catch" a comparator that is red for its own reason.

## 3. Findings in the two files the Lead owns (reported, not edited)

* `compare-q20-continue-legs.mjs:522-541` (`nextRequestClean`) — the byte-equality conjunct is the
  unsatisfiable-by-construction guard the Lead root-caused. My independent check agrees with the
  mechanism: `q20-leg-runtime.mjs:134-164` stamps the reply with the peer's per-process arrival ordinal,
  `q20-continue-probe.mjs:224-226` puts it into the continuation text, the text is persisted into the
  chat, and the request after the continue therefore carries `..._1` on one subject and `..._3` on the
  other. The guard's own second half (`report.nextTurnCarriesNudge !== false`, `:534-539`) is unaffected.
* The selection itself is sound and should be kept: `nextRequestOf` (`:148-154`) anchors on the product's
  own nudge marker rather than on `completions[length - 1]`, and `continueRequestOf` (`:120-125`) reports
  `multiple` rather than silently picking one.

## 4. Not findings (checked and deliberately excluded)

* `browser-differential.yml:1924` (`Freshness report`, `continue-on-error: true`) is report-only **by
  design**, stated at `:16-19`: a nightly job that is red for a known-stale artefact is a red people learn
  to ignore. It is not a skipped gate read as a pass.
* `browser-differential.yml:341`, `:495`, `:626`, `:674`, `:704`, `:740`, `:786`, `:1777` — mode gates
  that skip whole surfaces on a narrowed run. Each is paired with a step that says NOT-RECORDED rather
  than passing (`verify-browser-comparisons.mjs:212-251`), so a narrowed run cannot claim the surface.
* `tools/browser-evidence/hop-log.mjs:53-63` — `exitCode` is always 0, including in the `catch`
  (`:60`). That is the file's stated contract (`:11-12`: a diagnostic that can change a verdict is worse
  than none), so the variable is redundant rather than wrong.
* `compare-ui-layout-legs.mjs` — the `HARNESS_NOT_READY` / `HARNESS_STATE_MISMATCH` refusals (`:169-177`,
  `:251-257`), the `observed < 8` floor (`:300-303`) and the "both broken is not parity" split
  (`:224-228`) are all present and fail the run. The comparator's control loop iterates the GoTavern leg's
  keys (`:204`, `:231`); because both legs are driven by one probe with a fixed selector list the key sets
  are identical, so I did not raise it (see §5).

## 5. Uncertain (cannot be cited, therefore not findings)

* Whether a control present only on the pinned leg would be missed by
  `compare-ui-layout-legs.mjs:204`/`:231` — it depends on whether the probe's control list is
  per-leg dynamic; I did not read `ui-layout-probe.mjs`.
* Whether `hopReleasedLessThanThePeerWrote`'s `framesWritten(...).every(frames => frames > 0)` can be
  false on a faithful abort leg depends on whether any non-completion request lands in `report.recording`
  (`generation-probe.mjs:387-414` records only POSTs to the completion path, which suggests it cannot;
  the abort run's own numbers are only in uncommitted legs I must not read).
* `compare-regex-legs.mjs` was read to `:320` of 838; `compare-helper-vars-legs.mjs` to `:409` of 441;
  `compare-q20-continue-legs.mjs` to `:621` of 621 in parts; the probes other than
  `q20-regenerate-probe.mjs` were not read line by line. Findings inside those unread spans would not be
  in this document.
* `.private-fixtures/` was never enumerated, read, hashed or transmitted; no claim here depends on it.

## 6. Summary

Nine of the seventeen findings can produce a **false green** (F1-F9), of which F1 is a live, fully
workflow-level false green (six failed regex legs → green job) and F2 is a live false green in a
COMMITTED artefact (`verdict: match` beside `tokenizerCountsAgree: false`, with the recorded diagnosis
itself an artefact of positional pairing). F3 is the same rule-50 hole the regen lane already fixed
once. F6, F8, F9, F10, F11, F14 and F15 are missing second opinions or overclaims: each is currently
covered by another guard or by the verifier, and each is a place a future change can remove the last
thing that was checking.

This is an audit of the harness, not a statement about the product. Nothing here declares the project
complete, and no product behaviour was executed to produce it: every measurement above comes from
committed artefacts, committed source and the workflow file.

## 7. What has since been FIXED, and what a reader must still discount

Added 2026-10-29 by the integrating lane, so this file does not read as a list of live defects when part of it is
now history. Each entry names the fix and the evidence; anything not listed here is still open.

**F2 (the tokenizer comparison) is FIXED, and the committed artefact's diagnosis is SUPERSEDED — read that
artefact with this in mind.** The audit's claim was verified against the committed data BEFORE any code changed,
and it holds exactly: pinned's entire 67-count sequence is a **subsequence** of GoTavern's 73, matched in order,
with **six** calls on the GoTavern side that pinned never made (225, 380, 589, 749, 57 and 13, at indices 18, 20,
21, 22, 31 and 34), and every common call agreeing. So `preset-complex-comparison.json`'s recorded
`firstDifference` — `index 18: pinnedCount 275, gotavernCount 225`, noted as *"the same message counted differently
by the two servers"* — is **wrong twice over**: it describes six EXTRA calls as a per-message disagreement, and it
attaches a `requestText` from pinned's call #18 to GoTavern's call #18, which by then was a different call.

The fix pairs by what each call was ABOUT (its path plus the first message's content) and compares the counts for
one key in the order that key recurred, naming three outcomes separately — `perMessageDifferences`,
`extraOnGotavern`, `missingOnPinned` — with an empty comparison refused as `unmeasurable` rather than reported as
agreement (rule 19). The artefact now records those three arrays, which is what makes the diagnosis checkable from
the artefact alone; the old shape recorded only the counts, which is precisely why the wrong diagnosis could not
be falsified by reading it. `tests/browser/tokenizer-comparator-selftest.mjs` (19 cases, wired into `ci.yml`,
`lane.yml` and `browser-differential.yml`) runs the real exported comparison over the defect's own shape and
**controls it against the old positional walk**, so a change that reproduced the old output would fail. The verdict
stays an OBSERVATION rather than a guard, exactly as the artefact's own comment requires.

**WHAT IS STILL OPEN HERE, stated so the fix is not read as more than it is.**
1. The committed `preset-complex-comparison.json` has **not** been re-recorded, so its `firstDifference` still
   carries the wrong diagnosis; the next `preset`-mode run that commits artefacts replaces it, and until then a
   reader must discount that one field.
2. **The six extra tokenizer calls are characterised but NOT explained, and the earlier wording of this entry
   overclaimed.** It said "a real behavioural difference", which implies the product; the evidence does not support
   that yet, and the correction is recorded here rather than quietly edited away. What the committed artefact
   actually shows, aligned call by call:
   - pinned's 67 calls are matched **in order and exactly** by a subsequence of GoTavern's 73;
   - every one of the six GoTavern-only calls carries a value that **already appears in pinned's sequence**
     (225 at pinned index 6, 380 at 3, 589 at 4, 749 at 5, 57 at 10, 13 at 11 and 65) — so GoTavern's run
     **re-counted six messages pinned counted once**, rather than counting anything new;
   - the final provider request is **byte-identical on both legs** (`529fed72fc2d`, `providerRequestEqual: true`,
     `verdict: match`), so the extra counting changed no assembled context.

   Two hypotheses fit and neither is established: a **harness-side** drive divergence (the six extras cluster at
   indices 18, 20-22, 31, 34 rather than spreading uniformly, which is what a divergence partway through the drive
   looks like), or a **product-side** response difference that makes the frontend's token-count cache miss. The
   counts themselves agree everywhere they are shared, so GoTavern's tokenizer ANSWERS are numerically correct
   either way. **The next `preset`-mode run decides it**, because the corrected comparator now records the
   `requestText` of every extra and missing call — which is exactly what the old artefact could not record, and
   why this question could not be asked before. Nobody has looked yet; it is a question this lane surfaced rather
   than answered, and it must not be reported as a product defect until one of the two hypotheses is excluded.
3. F3 (the Q20 save/reload/swipe discriminator) is now recorded as an explicit limit in
   `docs/goal-scorecard.md`'s Q20 row rather than left implied; F4-F8 and F11-F15 were fixed by their own lane with
   observed reds; **F9 was found to be wrong at HEAD** (the guard already carried its `Boolean(leg) &&`) and was
   left alone, with a regression case added instead. F1/F16 are fixed and the terminal failure gate now consumes
   every recording counter.
