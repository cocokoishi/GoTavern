# Release-admissible five-layer run (local, corpus v2)

This is the record of the local release-admissible run of the real-UI oracle that preceded the CI gate
dispatch. It is **Layer A evidence**: the same-SHA authority is the `GoTavern real-UI oracle differential`
workflow run at the candidate SHA, whose artifact is verified by `scripts/verify-a19-evidence.mjs` inside
the publish job. Nothing in this file is a CI verdict.

## Identity

| field | value |
|---|---|
| run | release-admissible run 6 (the first run with all five layers `match`) |
| candidate code SHA | `dc436aa34c9f5238cda2c88f3fd74864f3d99923` (clean worktree `a19-release`, 0 dirty) |
| subject binary | `b9c240cfc6453a402a0ba4f3d812b7d0e1b5c05ead6e6ae7a849b81c7f97d060` (67 MB, `-trimpath`) |
| corpus | `a19-oracle/corpus` — 978 files / 49,898,769 B / tree `06d68e057085abad28d4e3bfc19df71cf91d9ea612ad6907bd67b38784d3a2ba` |
| corpus manifest | `corpus-manifest-v2.json`, sha256 `25caa60c871cde4348c22ed24baac18aaf6911ebc065d3e6ba74d95fcc61b1d9` |
| corpus origin / tier | `ui` / `full` |
| legs | 6/6 (`drive`/`restart`/`handback` × pinned/GoTavern), corpus re-censused unchanged |
| layers | browser `match`, http `match`, providerWire `match`, persistence `match`, lifecycle `match` |
| failed guards | **none** |
| normalisations | **26** named decisions, each with reason / pinnedEvidence / field / test / negativeCase in `out/release-evidence.json` |
| not compared | **6** surfaces: third-party egress, real provider completion, image codec bytes, wall-clock timestamps inside compared files, the raw event stream's full order/multiplicity, static frontend assets |
| comparator teeth | **51 mutations / 51 killed / 0 survived** (`out/teeth-retest2.json`, `ok:true`) |
| verifier | the local artifact is refused by `verify-a19-evidence.mjs` **by design** (`selection.dispatch:"local"`); admissible evidence exists only from the CI dispatch at the candidate SHA |

**Delta from the green run to the frozen candidate.** After run 6, the only changes to the gate's inputs were
`d63e8fe` (teeth rewrites for the real artifacts — test-side only) and `762b668` (the driver's `label` string
now distinguishes a plumbing run from a labelled release run; `releaseAdmissible` is unchanged for a release
label). `git diff dc436aa..HEAD -- tests/browser/a19-compare-live-oracle.mjs tests/browser/a19-journey-probe.mjs`
is empty, so the comparison and journey code that produced the green run is byte-identical; the label change
is metadata, not judgement. The CI gate at the frozen candidate re-runs the whole oracle and is the authority.

## What the run proved, and what it did not

Proved on this corpus: the same journey, driven on isolated copies of the same UI-originated tree, produces
the same final browser state, the same `/api` request/response surface after the named projections, the
same byte-oriented provider requests, the same persisted state (including restart reads in both
directions), and a clean lifecycle (reload, restart as a new process, chat switch, hand-back).
Not proved: a real human's long-lived directory (`GOAL.md` §14 stays NOT MET); Node control, ≥8-user
concurrency, long-run soak and p99 on the corpus (recorded separately only if they ran); real-provider
completion (the peer is deterministic, `AGENTS.md` rule 22).

## Artifacts (outside the repository)

- `a19-diff/release6/out/release-evidence.json` — the evidence document (26 normalisations, 6 notCompared)
- `a19-diff/release6/out/a19-live-oracle-comparison.json` — per-guard detail
- `a19-diff/release6/out/a19-live-oracle-teeth.json`, `teeth-retest.json`, `teeth-retest2.json` — teeth runs (final: 51/51)
- `a19-diff/release6/out/legs/*.json` — the six leg reports
- `a19-diff/release6/run-facts.txt` — SHA / binary / manifest identity as measured

The corpus originals never enter the repository; only the manifest and the provenance
([`corpus.md`](corpus.md), [`corpus-report-v2.json`](corpus-report-v2.json)) are committed.
