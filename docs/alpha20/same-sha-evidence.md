# alpha.20 same-SHA release evidence

**Candidate:** `260b790` — the annotated tag `v0.1.0-alpha.20` peels to `260b790`.
**Pinned oracle:** SillyTavern `1.19.0` at `06bde939fb1e9c4c8d8641d810f0a916b5bce127` (unchanged).
**Verifier:** `scripts/verify-release-gates.mjs --sha 260b790… --manifest docs/release-manifest.json` →
`PASS: 14/14 required workflow(s) are green at this SHA` (exit 0). The same verifier runs inside the publish
job before `gh release create`; the table below is also appended to the published release body.

## Superseded freeze attempts (never cited as evidence)

- `496e5a9`: the candidate's release-notes draft under-counted the fixed findings (seven vs nine) and the
  comparator-teeth evidence arrived after the commit. Dispatched runs cancelled before any gate completed.
- `7a8f977`: corrected notes + teeth evidence, but the third-party gate's harness self-test refused the
  alpha.20 probe kit's bind-0-and-close port allocation. Runs cancelled; only that self-test had reported.
- `fc30e38`: probe kit fixed, but Linux CI at that SHA measured two real regressions — the HEAD oracle
  (`TestPinnedNodeHTTPOracleHeadResponses//version`: "HEAD response wrote 168 body bytes") and the SD
  in-flight-disconnect interrupt (`TestSDA1111InterruptOnClientClose`: the handler's completion could beat
  the watcher goroutine when cancellation also unblocked its outbound call). Both were fixed in `260b790`
  (HEAD-aware writer; fire-once completion path in the watcher) with regression tests. Its other gates were
  cancelled, never cited. No tag was created for any superseded attempt and none was published.

---

## Qualification evidence (same-SHA required gates)

Every workflow below has a completed, successful run whose `head_sha` is this release tag's target commit `260b790`. The table is generated from the GitHub Actions API by `scripts/assemble-release-body.mjs` immediately before publication, so it is a measurement of this tag, not a hand-copied list.

| workflow | run id | event | conclusion | required jobs | selection proof | artifact (evidence) |
|---|---|---|---|---|---|---|
| GoTavern CI | [42761583757](https://github.com/cocokoishi/GoTavern/actions/runs/42761583757) | workflow_dispatch | success | changes, browser-evidence, verify, crash-gate, race, oracle | display-title | - |
| GoTavern whole-session differential | [42761587027](https://github.com/cocokoishi/GoTavern/actions/runs/42761587027) | workflow_dispatch | success | whole-session | jobs | - |
| GoTavern world-info slot ordering | [42761591443](https://github.com/cocokoishi/GoTavern/actions/runs/42761591443) | workflow_dispatch | success | worldinfo-slots | jobs | - |
| GoTavern drop-in qualification | [42761594649](https://github.com/cocokoishi/GoTavern/actions/runs/42761594649) | workflow_dispatch | success | dropin-current-head, windows-inputs, dropin-windows | jobs | - |
| Browser differential | [42761597904](https://github.com/cocokoishi/GoTavern/actions/runs/42761597904) | workflow_dispatch | success | differential | display-title | - |
| GoTavern release qualification | [42761601830](https://github.com/cocokoishi/GoTavern/actions/runs/42761601830) | workflow_dispatch | success | qualify-linux-amd64, qualify-windows-amd64, qualify-dropin-linux, qualify-published-alpha9-upgrade, qualify-upgrade-rollback | jobs | - |
| GoTavern smoke metrics | [42761605485](https://github.com/cocokoishi/GoTavern/actions/runs/42761605485) | workflow_dispatch | success | measure-linux-amd64, paired-linux-amd64 | jobs | - |
| GoTavern Docker image | [42761609423](https://github.com/cocokoishi/GoTavern/actions/runs/42761609423) | workflow_dispatch | success | docker | jobs | - |
| Helper state differential | [42761633527](https://github.com/cocokoishi/GoTavern/actions/runs/42761633527) | workflow_dispatch | success | helper state differential (ubuntu, bounded) | jobs | - |
| Combination journey differential | [42761637053](https://github.com/cocokoishi/GoTavern/actions/runs/42761637053) | workflow_dispatch | success | combination-journey | evidence | combination-journey-evidence (combination-journey-evidence) |
| Third-party extension compatibility | [42778585855](https://github.com/cocokoishi/GoTavern/actions/runs/42778585855) | workflow_dispatch | success | selftest, aggregate, corpus, soak, overhead, macos-arm64-recorded-limitation | jobs | extension-compat-evidence |
| GoTavern long-lived corpus qualification | [42761643626](https://github.com/cocokoishi/GoTavern/actions/runs/42761643626) | workflow_dispatch | success | medium-corpus | evidence | longlived-medium-evidence (gotavern-longlived-corpus-evidence) |
| GoTavern Node stock tree round trip | [42761647137](https://github.com/cocokoishi/GoTavern/actions/runs/42761647137) | workflow_dispatch | success | node-stock-tree | jobs | node-stock-tree-evidence (gotavern-node-stock-tree-evidence) |
| GoTavern real-UI oracle differential | [42761650425](https://github.com/cocokoishi/GoTavern/actions/runs/42761650425) | workflow_dispatch | success | real-ui-oracle | evidence | a19-real-ui-oracle-evidence (a19-real-ui-oracle-v1) |

The `required jobs` column names the jobs that had to be completed/success IN the cited run, not merely present in a green workflow; the `artifact (evidence)` column names the fixed-name evidence bundle the verifier downloaded and the document kind whose embedded head SHA and tier marker it checked (`-` means the gate is judged by its own conclusion).

Target commit: `260b790`

