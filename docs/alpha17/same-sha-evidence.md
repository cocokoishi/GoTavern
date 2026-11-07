# alpha.17 — same-SHA release evidence

**Status: DRAFT until the 13-gate wave concludes and the official verifier reads it.** The candidate SHA is
`9b99fde0b0a9be0665cd93bc2143a3f495af31c2` (`main` HEAD when the wave was dispatched; no code commit follows
it before the tag). The thirteen required workflows were **deliberately dispatched** at that SHA with their
full selections; push runs at the same SHA are not the gate.

## 1. Dispatch record

```bash
# all at main HEAD = 9b99fde0b0a9be0665cd93bc2143a3f495af31c2
gh workflow run ci.yml                          --ref main -f probes=
gh workflow run whole-session.yml               --ref main
gh workflow run worldinfo-slots.yml             --ref main
gh workflow run dropin-qualification.yml        --ref main
gh workflow run browser-differential.yml        --ref main -f mode=all
gh workflow run release-qualification.yml       --ref main
gh workflow run smoke-metrics.yml               --ref main -f requests=50
gh workflow run docker.yml                      --ref main
gh workflow run helper-state.yml                --ref main
gh workflow run combination-journey.yml         --ref main -f profile=e03e04 -f tier=full -f extension_tier=full
gh workflow run third-party-extension-compat.yml --ref main -f mode=full
gh workflow run longlived.yml                   --ref main -f size=medium
gh workflow run node-stock-tree.yml             --ref main
# the pre-tag rehearsal (a dispatch never publishes)
gh workflow run release.yml --ref main -f ref=9b99fde0b0a9be0665cd93bc2143a3f495af31c2 \
  -f candidate_version=v0.1.0-alpha.17
```

## 2. The wave (run ids as dispatched)

| # | required workflow | run id | event | required job / artifact rail |
|---|---|---|---|---|
| 1 | GoTavern CI | 42378580336 | workflow_dispatch | (full oracle selection) |
| 2 | GoTavern whole-session differential | 42378582464 | workflow_dispatch | — |
| 3 | GoTavern world-info slot ordering | 42378584660 | workflow_dispatch | — |
| 4 | GoTavern drop-in qualification | 42378586718 | workflow_dispatch | packaged archive on Linux + Windows |
| 5 | Browser differential | 42378588856 | workflow_dispatch | `mode=all` |
| 6 | GoTavern release qualification | 42378590902 | workflow_dispatch | — |
| 7 | GoTavern smoke metrics | 42378592778 | workflow_dispatch | `requests=50` |
| 8 | GoTavern Docker image | 42378594562 | workflow_dispatch | — |
| 9 | Helper state differential | 42378596579 | workflow_dispatch | — |
| 10 | Combination journey differential | 42378598419 | workflow_dispatch | `combination-journey` + `combination-journey-evidence` (full tier) |
| 11 | Third-party extension compatibility | 42378600244 | workflow_dispatch | `mode=full` + `extension-compat-evidence` |
| 12 | GoTavern long-lived corpus qualification | 42378602075 | workflow_dispatch | `medium-corpus` + `longlived-medium-evidence` |
| 13 | GoTavern Node stock tree round trip | 42378604204 | workflow_dispatch | `node-stock-tree` + `node-stock-tree-evidence` |
| — | GoTavern Release (rehearsal) | 42378606389 | workflow_dispatch | six archives built/inspected, execution legs, prepublish qualification; publish skipped |

**Verdicts.** This table's `conclusion` column and the official verifier output are filled in §3 only after
each run reaches a terminal state and `scripts/verify-release-gates.mjs` has read them; a run that is still in
progress, cancelled, skipped or narrowed is a refusal, never a PASS. The release is not tagged while this file
says DRAFT.

## 3. Verdict — the official verifier read the wave (EXECUTED)

Command (the same one the publish job runs, with the evidence outputs added):

```bash
GH_TOKEN=… GITHUB_REPOSITORY=cocokoishi/GoTavern node scripts/verify-release-gates.mjs \
  --sha 9b99fde0b0a9be0665cd93bc2143a3f495af31c2 --manifest docs/release-manifest.json \
  --evidence-out docs/alpha17/same-sha-verifier-table.md \
  --release-evidence-out docs/alpha17/release-evidence.json \
  --release-evidence-md-out docs/alpha17/release-evidence.md \
  --workflow 'GoTavern Release' --event workflow_dispatch \
  --pinned-sha 06bde939fb1e9c4c8d8641d810f0a916b5bce127
```

Result (2026-11-07): every one of the thirteen required workflows has a **completed / success
`workflow_dispatch`** run at `9b99fde…`, and the verifier printed:

```
**PASS**: 13/13 required workflow(s) are green at this SHA.
```

The machine-readable table is `docs/alpha17/same-sha-verifier-table.md`; the unified evidence document the new
emitter produced from the same queries is `docs/alpha17/release-evidence.json` (overall `PASS`, 13/13 gates)
with its rendered table `docs/alpha17/release-evidence.md`. The four artifact gates show their required job
**and** embedded evidence kind in the table (combination `tier=full`; long-lived `size=medium`; Node stock
tree tree/manifest digests; extension corpus). Required jobs were present and not skipped; no run at another
SHA, no push run and no narrowed selection was counted.

## 4. The pre-tag rehearsal: one real refusal, and its fix

The first rehearsal (`GoTavern Release` 42378606389, dispatched at the candidate **before** the curated notes
existed on `main`) failed at the `darwin/arm64 must be executed OR recorded as a platform limitation, with the
note line published` rail: the publish job reads the curated note from the tag tree, then falls back to
`origin/main`, and at dispatch time neither carried `docs/release-notes-v0.1.0-alpha.17.md`, so the limitation
line could not be found. That is the gate doing its job (a downgrade that is not stated is refused). The
rehearsal is re-dispatched after the notes commit is pushed and its result is recorded in
`handoff-ledger.md` §5; a dispatch never publishes, so no release state was touched by the red rehearsal.

## 5. What this PASS does not claim

The gate proves that the required runs executed at the candidate SHA with their required jobs/artifacts and
that the embedded evidence is internally consistent. It does not turn any UNPROVEN row into a proof: §14 of
`GOAL.md` remains NOT MET, darwin/arm64 runtime and the macOS arm64 extension lifecycle remain UNVERIFIED,
windows/arm64 remains BUILD-ONLY, and the 8-user/soak/ENOSPC/relay/streaming-cancellation page-load rows keep
their recorded states. The release notes state the same boundaries.

