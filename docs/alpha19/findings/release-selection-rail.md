# Finding: a selection disproof could be overridden by a later proof in the release gate

**Class:** release-governance gate defect (test infrastructure / evidence rail), found by the alpha.19 gate's own
teeth before the gate was ever dispatched. **Not a product defect.** Severity: high for evidence integrity — it
would let a green run carry an artifact that says the selection was narrowed.

## 1. How it was found

The alpha.19 real-UI oracle gate declares **two** selection proof sources in the manifest:

```json
"requiredSelection": {
  "titleIncludes": ["mode=all"],
  "evidence": [
    { "path": "selection.mode", "equals": "all" },
    { "path": "corpus.origin", "equals": "ui" }
  ]
}
```

Before the workflow existed, `scripts/release-governance.test.mjs` was extended with a positive control (a
conforming synthetic artifact must be accepted) and one mutation per rail (each must be refused by name). The
`corpus.origin = generator` mutation was **ACCEPTED**, i.e. the gate would have shipped an artifact whose own
embedded evidence says the corpus was generated, because the run's display title said `mode=all`.

Observed RED, first run of the new test:

```
AssertionError [ERR_ASSERTION]: generated corpus: a non-conforming artifact must be refused
actual: true
expected: false
```

After fixing the first-wins ordering, a second form of the same defect surfaced: an artifact that **proves** the
full selection in its evidence (mode=all, origin=ui) while the run's display title says `mode=smoke` was accepted,
because the evidence source returned before the title source was read.

```
AssertionError [ERR_ASSERTION]: narrowed display title: a broken run rail must be refused
actual: true
expected: false
```

## 2. Root cause

`checkSelectionRail` (`scripts/release-governance/gates.mjs`) documented the intended order of outcomes ("a source
PROVES it -> pass; a source DISPROVES it -> narrowed-selection") but implemented first-proof-wins: each source
returned `ok` as soon as it proved the selection, so any later source that would have **disproved** it was never
evaluated, and a failure collected earlier could be discarded by a later success.

The consequence is exactly the class this repository's rules forbid: two disagreeing observations produced a
green. A run whose artifact says "narrowed" and whose title says "full" is not evidence for either.

## 3. Fix

Every declared source that can be read is now evaluated:

- any source that **disproves** the full selection refuses by name (`narrowed-selection`) even if another source
  would prove it;
- with no disproval, at least one source must prove it, recording `provenBy`;
- unavailable sources alone remain `selection-unverifiable` (still a refusal).

The source-count contract is unchanged: a gate may still declare one source; alpha.18's gates each declare one, so
no historical gate's verdict changes. The alpha.19 gate is the first with two, which is why the defect had to be
fixed before it could ship.

## 4. Evidence

- RED: the two assertion messages above, produced by `node --test scripts/release-governance.test.mjs` against the
  unfixed `checkSelectionRail`. The cases are permanent: they are the `gate 14` test's `narrowed display title` and
  `generated corpus` mutations.
- GREEN after the fix: `node --test scripts/release-governance.test.mjs` -> **89/89 pass**, including the positive
  control (a conforming synthetic artifact is accepted) and 16 named refusals on the new gate.
- The fix also has its own regression coverage in the existing selection tests (jobs/evidence/title each prove,
  disprove and become unverifiable), all 89 green.

## 5. What this does not prove

- It does not prove the `GoTavern real-UI oracle differential` workflow runs green; that is the gate's own
  dispatch at a candidate SHA.
- It does not change the product. No Go code was touched.
- The alpha.19 verification command must still run this suite in CI (`GoTavern CI` `verify` job runs exactly
  `node --test scripts/release-governance.test.mjs`); a local green is Layer A only.

## 6. Residual risk

The generic release rail can only check boolean members; a contradictory evidence document (`layers.x.ok = true`
with `verdict = "not-observed"`) is refused by `scripts/verify-a19-evidence.mjs` (its self-test mutates exactly that
shape), which the workflow runs as a separate step. The two rails are complementary: the release manifest binds the
artifact's boolean contract and identity, the deeper verifier binds the five-layer verdicts and the corpus
provenance. Neither alone is claimed to be sufficient.
