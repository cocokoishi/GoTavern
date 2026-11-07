
---

## Qualification evidence (same-SHA required gates)

Every workflow below has a completed, successful run whose `head_sha` is this release tag's target commit `9b99fde0b0a9be0665cd93bc2143a3f495af31c2`. The table is generated from the GitHub Actions API by `scripts/assemble-release-body.mjs` immediately before publication, so it is a measurement of this tag, not a hand-copied list.

| workflow | run id | event | conclusion | required jobs | artifact (evidence) |
|---|---|---|---|---|---|
| GoTavern CI | [42378580336](https://github.com/cocokoishi/GoTavern/actions/runs/42378580336) | workflow_dispatch | success | - | - |
| GoTavern whole-session differential | [42378582464](https://github.com/cocokoishi/GoTavern/actions/runs/42378582464) | workflow_dispatch | success | - | - |
| GoTavern world-info slot ordering | [42378584660](https://github.com/cocokoishi/GoTavern/actions/runs/42378584660) | workflow_dispatch | success | - | - |
| GoTavern drop-in qualification | [42378586718](https://github.com/cocokoishi/GoTavern/actions/runs/42378586718) | workflow_dispatch | success | - | - |
| Browser differential | [42378588856](https://github.com/cocokoishi/GoTavern/actions/runs/42378588856) | workflow_dispatch | success | - | - |
| GoTavern release qualification | [42378590902](https://github.com/cocokoishi/GoTavern/actions/runs/42378590902) | workflow_dispatch | success | - | - |
| GoTavern smoke metrics | [42378592778](https://github.com/cocokoishi/GoTavern/actions/runs/42378592778) | workflow_dispatch | success | - | - |
| GoTavern Docker image | [42378594562](https://github.com/cocokoishi/GoTavern/actions/runs/42378594562) | workflow_dispatch | success | - | - |
| Helper state differential | [42378596579](https://github.com/cocokoishi/GoTavern/actions/runs/42378596579) | workflow_dispatch | success | - | - |
| Combination journey differential | [42378598419](https://github.com/cocokoishi/GoTavern/actions/runs/42378598419) | workflow_dispatch | success | combination-journey | combination-journey-evidence (combination-journey-evidence) |
| Third-party extension compatibility | [42378600244](https://github.com/cocokoishi/GoTavern/actions/runs/42378600244) | workflow_dispatch | success | - | extension-compat-evidence |
| GoTavern long-lived corpus qualification | [42378602075](https://github.com/cocokoishi/GoTavern/actions/runs/42378602075) | workflow_dispatch | success | medium-corpus | longlived-medium-evidence (gotavern-longlived-corpus-evidence) |
| GoTavern Node stock tree round trip | [42378604204](https://github.com/cocokoishi/GoTavern/actions/runs/42378604204) | workflow_dispatch | success | node-stock-tree | node-stock-tree-evidence (gotavern-node-stock-tree-evidence) |

The `required jobs` column names the jobs that had to be completed/success IN the cited run, not merely present in a green workflow; the `artifact (evidence)` column names the fixed-name evidence bundle the verifier downloaded and the document kind whose embedded head SHA and tier marker it checked (`-` means the gate is judged by its own conclusion).

Target commit: `9b99fde0b0a9be0665cd93bc2143a3f495af31c2`

