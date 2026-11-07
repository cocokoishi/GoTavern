# alpha.17 — unified release evidence contract and narrowed-dispatch rails

**Status: EXECUTED (implementation + negative tests + real-wave validation).** This file records what the
same-SHA release gate now decides, what is machine-derivable from the Actions API, what is not, and the exact
manifest rows proposed for the next round. It is written against the real alpha.16 wave at `c1886d7` (the
thirteen run ids in `docs/alpha16/same-sha-evidence.md`) because a rail that has only synthetic tests is a
claim, not a measurement.

## 1. What was already there (alpha.15/16) and stayed

The existing verifier (`scripts/verify-release-gates.mjs`, decision function in
`scripts/release-governance/gates.mjs`) already refused, by name: a missing run at the candidate SHA, a wrong
event (`requiredEvent`), a skipped/absent/failed required job (`requiredJobs`), a missing or expired required
artifact (`requiredArtifact`), and an embedded evidence document with the wrong `schemaVersion`, `kind`, tier
marker, embedded head SHA, truthy member or non-64-hex digest (`requiredEvidence`); plus a newer failed run
masked by an older green one. Those rails are unchanged, and the manifest's `requiredEvent: workflow_dispatch`
on all thirteen gates is what makes a push/PR run unable to satisfy a release gate (the alpha.16 wave's own
push runs are evidence of why that matters: a push run narrows its oracle probe set).

## 2. What alpha.17 adds (declarative, optional, backward compatible)

All new rails are manifest-driven and **absent from the current manifest**, so the alpha.16 wave still passes
13/13 exactly as before. Each is unit-tested with a synthetic refusal that names itself:

| rail | what it refuses | where |
|---|---|---|
| `manifest.pinnedSha` | not a 40-hex commit; a per-gate `requiredPinnedSha` contradicting it | `validateManifest` |
| `requiredGates[].requiredPinnedSha` | an embedded evidence document that omits the pinned oracle commit or names another one (requires `requiredEvidence`) | `evaluateGates` |
| `requiredGates[].requireArtifactDigest` | an artifact whose Actions-API `digest` is absent or not `sha256:<64 hex>`; binds the gate to the exact bytes it consumed | `evaluateGates` |
| `requiredGates[].requiredArtifactFresh` | (when `true`) an artifact whose creation cannot be shown to belong to the cited run/attempt | `evaluateGates` |
| `requiredGates[].requiredSelection` | a **narrowed dispatch** where the selection cannot be proved from (a) a required job set, (b) embedded evidence members, or (c) the run's display title; an unprovable selection is named `selection-unverifiable` and refuses rather than passing silently | `evaluateGates` |
| unified emitter (`--release-evidence-out`, `--release-evidence-md-out`) | writing a PASS document when any gate failed | `scripts/release-governance/release-evidence.mjs` |

The unified document's shape (schemaVersion 1, `kind: gotavern-release-evidence`) is the machine-readable
contract: `workflow`, `headSha`, `pinnedSha`, `event`, `dispatchInputs`, `selectedTests`, `executedTests`,
`unexecutedTests`, `tier`, `seed`, `selection`, `artifactDigests`, `negativeControl`, `gates[]` and
`overall{publishable,result,passed,gates}`. A field the Actions API cannot answer is written as `null` with
`derived: false` and a reason — never invented. The committed sample is
`docs/alpha17/evidence-contract-sample.json`, produced by:

```bash
GH_TOKEN=… GITHUB_REPOSITORY=cocokoishi/GoTavern \
node scripts/verify-release-gates.mjs \
  --sha c1886d70db0342e09c6fdd3225909cae900c15c9 --manifest docs/release-manifest.json \
  --release-evidence-out /tmp/release-evidence.json --release-evidence-md-out /tmp/release-evidence.md \
  --workflow 'GoTavern Release' --event workflow_dispatch \
  --pinned-sha 06bde939fb1e9c4c8d8641d810f0a916b5bce127
```

## 3. Validation against the real alpha.16 wave (executed)

The official verifier, run against the real Actions API, prints:

```
## Same-SHA release gate for `c1886d70db0342e09c6fdd3225909cae900c15c9`
… 13 rows, every one workflow_dispatch / completed / success …
**PASS**: 13/13 required workflow(s) are green at this SHA.
```

and the emitter writes `overall {result: PASS, gates: 13, passed: 13}`. The four artifact gates show their
required job **and** the embedded evidence kind in the table (combination `tier=full`, long-lived
`size=medium`, Node stock tree, extension corpus). The sample document is committed so a reader can inspect
the attempt-level fields and the `derived:false` places without re-running anything.

Negative tests: `node --test scripts/release-governance.test.mjs` is **83/83 pass**, up from 69 at alpha.16;
every new rail above has at least one synthetic refusal case naming itself, plus the positive control. The
suite also drives the ZIP reader on stored/deflated evidence and the live query plumbing against a fake
fetch.

## 4. What the API cannot prove (stated, not invented)

- **Dispatch inputs are not exposed by the runs API.** The run object does not carry `workflow_dispatch`
  inputs, so `dispatchInputs`, `selectedTests`, `executedTests` and `unexecutedTests` are `null` with
  `derived:false` and the reason "the Actions API does not expose …". The emitter/verifier therefore proves a
  gate's full selection only from **named jobs**, **embedded evidence** and **run display titles**; a gate
  whose selection has none of those is `selection-unverifiable` and the consolidated document marks it.
- Consequently, the **per-gate test counts** the brief asks for cannot be produced from the API at publish
  time. The repository's own evidence documents (e.g. `docs/alpha17/new-test-evidence.md`,
  `docs/alpha16/same-sha-evidence.md`) are the human-readable counts, and the unified document references the
  gate's artifacts rather than inventing a number.
- A **stale but reusable artifact** is only detectable against the run identity the API exposes; an artifact
  uploaded by a *different attempt of the same run* has the run's identity and is only caught by the embedded
  head SHA/tier checks. That is a named residual, not a silent gap.

## 5. Proposed manifest rows for the 13 gates (NOT applied in alpha.17)

These are derived from the job lists of the real alpha.16 wave (captured with
`gh api repos/cocokoishi/GoTavern/actions/runs/<id>/jobs`), and they are proposals: applying them is a policy
change that must be tested against a fresh wave. A gate's `requiredJobs` must name only jobs the full
selection always runs.

| workflow | proposed `requiredJobs` (success set observed) | proposed selection rail |
|---|---|---|
| GoTavern CI | `verify`, `race`, `oracle`, `crash-gate`, `browser-evidence`, `changes` | `requiredSelection: {jobs: [...]}`; the oracle job's presence proves the full sweep job ran (the probe list is not exposed) |
| GoTavern whole-session differential | `whole-session` | job set |
| GoTavern world-info slot ordering | `worldinfo-slots` | job set |
| GoTavern drop-in qualification | `dropin-current-head`, `windows-inputs`, `dropin-windows` | job set |
| Browser differential | `differential` (note: `handback-stability` and `publish-preset` are legitimately `skipped` in a `mode=all` dispatch) | job set + display title `mode=all` |
| GoTavern release qualification | `qualify-linux-amd64`, `qualify-windows-amd64`, `qualify-dropin-linux`, `qualify-published-alpha9-upgrade`, `qualify-upgrade-rollback` | job set |
| GoTavern smoke metrics | `measure-linux-amd64`, `paired-linux-amd64` | job set |
| GoTavern Docker image | `docker` | job set |
| Helper state differential | `helper state differential (ubuntu, bounded)` | job set |
| Combination journey differential | `combination-journey` (already) | existing embedded `tier=full` + `profile=e03e04` |
| Third-party extension compatibility | `selftest`, `corpus`, `aggregate`, `overhead`, `soak`, `sentinel` is skipped by design so it is EXCLUDED | existing embedded evidence + `mode=full` in the display title |
| GoTavern long-lived corpus qualification | `medium-corpus` (already) | existing embedded `size=medium` |
| GoTavern Node stock tree round trip | `node-stock-tree` (already) | existing embedded head SHA/tree digest |

Wiring the emitter into the publish path is a one-line change in `release.yml`'s publish job (add
`--release-evidence-out release-evidence.json --release-evidence-md-out release-evidence.md --workflow "$GITHUB_WORKFLOW" --event "$GITHUB_EVENT_NAME" --pinned-sha "$PINNED_BASELINE_COMMIT"` to the existing verifier invocation and upload the file). It is **not applied** in alpha.17 because the release path must not
change between the rehearsed and published configurations; the exact patch is recorded here for the next
round. Under the current wiring the verifier still runs before `gh release create` and still fails closed.

## 6. Teeth and residual

- `node --test scripts/release-governance.test.mjs` → 83 tests, 83 pass (evidence: this round's run of that
  command; the CI `verify` job runs it too).
- The real-wave PASS above is the positive control; the synthetic refusals are the negative controls.
- Residuals: dispatch inputs/selected-test counts unprovable from the API (named above); the "selection"
  rail is declarative and unused until the next manifest revision; a per-gate test-count contract would need
  each workflow to emit a fixed-name evidence document carrying its own executed/unexecuted lists (the four
  artifact gates already do this via their embedded evidence; the other nine do not).
