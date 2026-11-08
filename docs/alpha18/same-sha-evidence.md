# alpha.18 same-SHA evidence

**Status: PENDING — filled by the wave at the frozen candidate, then copied here by a documentation commit
that does not move the tag.** Until this file has one row per gate with a run id and the official verifier's
`PASS` line, the alpha.18 release is NOT qualified and must not be tagged.

## How the evidence is produced

1. Freeze the candidate commit (the commit containing this file and every product change) and push it to
   `main`.
2. Dispatch all thirteen required workflows **from `main` at that SHA**, with the inputs the manifest's
   selection rails require — in particular an EMPTY `probes=` for `GoTavern CI` (the run name then reads
   `probes=full`) and `-f mode=all` for `Browser differential`; the other gates use the tier inputs in
   `docs/alpha18/handoff-ledger.md` §4.
3. Run the official verifier at that same SHA:

   ```bash
   node scripts/verify-release-gates.mjs --sha "<candidate>" --manifest docs/release-manifest.json \
     --release-evidence-out /tmp/release-evidence.json \
     --release-evidence-md-out /tmp/release-evidence.md \
     --workflow 'GoTavern Release' --event workflow_dispatch
   ```

   It fails closed: a wrong SHA, a wrong event, a skipped required job, a missing/expired artifact, a
   missing or inconsistent embedded evidence field, or a selection that cannot be proved refuses the
   release.
4. Paste the per-gate table below and the verifier's final line here, then commit (tag untouched).

## Per-gate table (PENDING)

| # | required workflow | run id | event | head SHA | conclusion | required jobs | artifact digest | selection proof |
|---|---|---|---|---|---|---|---|---|
| 1 | GoTavern CI | PENDING | workflow_dispatch | candidate | PENDING | changes, browser-evidence, verify, crash-gate, race, oracle | — | title `probes=full` |
| 2 | whole-session differential | PENDING | workflow_dispatch | candidate | PENDING | PENDING | — | full job set |
| 3 | world-info slot ordering | PENDING | workflow_dispatch | candidate | PENDING | PENDING | — | full job set |
| 4 | drop-in qualification | PENDING | workflow_dispatch | candidate | PENDING | dropin-current-head, windows-inputs, dropin-windows | — | full job set |
| 5 | Browser differential | PENDING | workflow_dispatch | candidate | PENDING | differential | — | title `mode=all` |
| 6 | release qualification | PENDING | workflow_dispatch | candidate | PENDING | PENDING | — | full job set |
| 7 | smoke metrics | PENDING | workflow_dispatch | candidate | PENDING | measure-linux-amd64, paired-linux-amd64 | PENDING | full job set |
| 8 | Docker image | PENDING | workflow_dispatch | candidate | PENDING | PENDING | PENDING | full job set |
| 9 | helper state differential | PENDING | workflow_dispatch | candidate | PENDING | helper state differential (ubuntu, bounded) | — | full job set |
| 10 | combination journey | PENDING | workflow_dispatch | candidate | PENDING | combination-journey | PENDING | full tier |
| 11 | third-party extension compatibility | PENDING | workflow_dispatch | candidate | PENDING | selftest, aggregate, corpus, soak, overhead, macos-arm64-recorded-limitation | PENDING | full tier |
| 12 | long-lived corpus qualification | PENDING | workflow_dispatch | candidate | PENDING | medium-corpus | — | `medium` tier |
| 13 | Node stock tree round trip | PENDING | workflow_dispatch | candidate | PENDING | PENDING | — | full job set |

**Official verifier output at the candidate: PENDING.**

The unified evidence document (`release-evidence.json`) emitted by the same command is the machine-readable
form of this table; the publish job runs the same command inside `GoTavern Release` before `gh release
create`, so a publication cannot disagree with this record. The rails that make a narrowed dispatch fail are
proven with real runs in `docs/alpha18/evidence-contract.md` (accepted full-selection Docker run, refused
`-f size=small` long-lived run, refused pre-run-name alpha.17 titles, wrong-SHA `missing`).
