# Release-admissible five-layer run (local, corpus v2)

This is the record of the authoritative local release-admissible run of the real-UI oracle that preceded the CI
gate dispatch. It is **Layer A evidence**: the same-SHA authority is the `GoTavern real-UI oracle differential`
workflow run at the candidate SHA, whose artifact is verified by `scripts/verify-a19-evidence.mjs` inside the
publish job. Nothing in this file is a CI verdict.

## Identity (run 8, the authoritative artifact)

| field | value |
|---|---|
| run | release-admissible run 8 (`a19-diff/release8`) |
| run tree SHA (short) | `762b668` — clean worktree `a19-release`, 0 dirty; the full SHA and binary hash are in `a19-diff/release8/run-facts.txt`. The frozen candidate's gate code is byte-identical: `git diff 762b668..bfe6e80 -- tests/browser scripts` is empty (the only delta was this docs file) |
| subject binary | `e671d114a5cc426250b50efb902338d9e7d32977205674e837ed449f525b702c` (67 MB, `-trimpath`) |
| corpus | `a19-oracle/corpus` — 978 files / 49,898,769 B / tree `06d68e057085abad28d4e3bfc19df71cf91d9ea612ad6907bd67b38784d3a2ba` |
| corpus manifest | `corpus-manifest-v2.json`, sha256 `25caa60c871cde4348c22ed24baac18aaf6911ebc065d3e6ba74d95fcc61b1d9` |
| corpus origin / tier | `ui` / `full` |
| legs | 6/6 (`drive`/`restart`/`handback` × pinned/GoTavern), corpus re-censused unchanged |
| layers | browser `match`, http `match`, providerWire `match`, persistence `match`, lifecycle `match` |
| failed guards | **none** |
| evidence flags | `ok:true`, `releaseAdmissible:true`, `verdict:"match"` |
| normalisations | **23** named decisions, each with reason / pinnedEvidence / field / test / negativeCase in `out/release-evidence.json` |
| not compared | **6** surfaces: third-party egress, real provider completion, image codec bytes, wall-clock timestamps inside compared files, the raw event stream's full order/multiplicity, static frontend assets |
| comparator teeth | **51 mutations / 51 killed / 0 survived** (`ok:true`, in-run) |
| verifier | self-test 17/17; the local artifact is refused **by design** (`selection.dispatch:"local"` must be `workflow_dispatch`); admissible evidence exists only from the CI dispatch at the candidate SHA |

**Why 23 and not 26.** Run 6 carried 26 applied decisions because three request-scheduling decisions fired
there (a GET multiplicity, a named read-only multiplicity, and tokenizer request-set membership). In run 8
those schedules did not occur, so the decisions are present in the comparator but did not fire; the count is
data-dependent and every applied one is listed in the artifact. The release6 documents are kept on disk as
`a19-diff/release6/` but are **NOT admissible**: that run's embedded teeth were 43/51 (eight mutations were
fixture-only and therefore not teeth on the real artifacts; fixed in `d63e8fe`) and its driver label still said
"PLUMBING RUN" (fixed in `762b668`).

## What the run proved, and what it did not

Proved on this corpus: the same journey, driven on isolated copies of the same UI-originated tree, produces
the same final browser state, the same `/api` request/response surface after the named projections, the same
byte-oriented provider requests, the same persisted state (including restart reads in both directions), and a
clean lifecycle (reload, restart as a new process, chat switch, hand-back).
Not proved: a real human's long-lived directory (`GOAL.md` §14 stays NOT MET); Node control, ≥8-user
concurrency, long-run soak and p99 on the corpus (recorded separately only if they ran); real-provider
completion (the peer is deterministic, `AGENTS.md` rule 22).

## Artifacts (outside the repository)

- `a19-diff/release8/out/release-evidence.json` — the evidence document (23 normalisations, 6 notCompared)
- `a19-diff/release8/out/a19-live-oracle-comparison.json` — per-guard detail
- `a19-diff/release8/out/a19-live-oracle-teeth.json` — teeth (51/51, in-run)
- `a19-diff/release8/out/legs/*.json` — the six leg reports
- `a19-diff/release8/run-facts.txt` — SHA / binary / manifest identity as measured
- legacy (not admissible): `a19-diff/release6/` — superseded, see "Why 23 and not 26"

The corpus originals never enter the repository; only the manifest and the provenance
([`corpus.md`](corpus.md), [`corpus-report-v2.json`](corpus-report-v2.json)) are committed.
