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
