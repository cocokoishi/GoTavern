## Unified release evidence contract (`9b99fde0b0a9be0665cd93bc2143a3f495af31c2`)

Kind `gotavern-release-evidence` schemaVersion 1. Generated from the Actions API by `scripts/release-governance/release-evidence.mjs`; deterministic (no clock value).

**Overall: PASS** - 13/13 required gate(s) green at this SHA.

| workflow | run | event | verdict | required jobs | artifact (digest) | embedded evidence | selection |
|---|---|---|---|---|---|---|---|
| GoTavern CI | 42378580336 | workflow_dispatch | success | - | - | - | unverifiable (derived:false) |
| GoTavern whole-session differential | 42378582464 | workflow_dispatch | success | - | - | - | unverifiable (derived:false) |
| GoTavern world-info slot ordering | 42378584660 | workflow_dispatch | success | - | - | - | unverifiable (derived:false) |
| GoTavern drop-in qualification | 42378586718 | workflow_dispatch | success | - | - | - | unverifiable (derived:false) |
| Browser differential | 42378588856 | workflow_dispatch | success | - | - | - | unverifiable (derived:false) |
| GoTavern release qualification | 42378590902 | workflow_dispatch | success | - | - | - | unverifiable (derived:false) |
| GoTavern smoke metrics | 42378592778 | workflow_dispatch | success | - | - | - | unverifiable (derived:false) |
| GoTavern Docker image | 42378594562 | workflow_dispatch | success | - | - | - | unverifiable (derived:false) |
| Helper state differential | 42378596579 | workflow_dispatch | success | - | - | - | unverifiable (derived:false) |
| Combination journey differential | 42378598419 | workflow_dispatch | success | combination-journey=success | combination-journey-evidence (sha256:5e7ed9ed328f5ee8366df47dd8504346e2609a2617a913c66b27f9a93d23b9f8) | kind=combination-journey-evidence, tier=full, pinnedSha=06bde939fb1e9c4c8d8641d810f0a916b5bce127 | unverifiable (derived:false) |
| Third-party extension compatibility | 42378600244 | workflow_dispatch | success | - | extension-compat-evidence (sha256:afa7670fc7baa5c9a3e0c57939aff027a80cd069357f78e272dc53ad6a4b3aeb) | - | unverifiable (derived:false) |
| GoTavern long-lived corpus qualification | 42378602075 | workflow_dispatch | success | medium-corpus=success | longlived-medium-evidence (sha256:2742d19b4e9ccdfb464fcf7983736d0c8857391c25d6cf2c25becbb77390c8eb) | kind=gotavern-longlived-corpus-evidence, tier=medium | unverifiable (derived:false) |
| GoTavern Node stock tree round trip | 42378604204 | workflow_dispatch | success | node-stock-tree=success | node-stock-tree-evidence (sha256:4f31940087e8b1ab6d4d5e11d0fedd0f94440ec7a1baea5c87fb024aa7876376) | kind=gotavern-node-stock-tree-evidence, pinnedSha=06bde939fb1e9c4c8d8641d810f0a916b5bce127 | unverifiable (derived:false) |

### Fields the Actions API cannot answer (recorded, not invented)

- `dispatchInputs`: the Actions runs API exposes no dispatch inputs for a run: the workflow_run object has no `inputs` member (verified against GitHub API run 42340311363 on 2026-11-07) and display_title carries the workflow name, not the inputs. The dispatch selection is therefore proven from required jobs / embedded evidence where the manifest names a requiredSelection, and recorded as unverifiable otherwise -- never inferred from a title or invented
- `selectedTests`: per-gate test selection/execution counts are not exposed by the Actions API; they live in each run log, which this document does not parse. Where a gate's embedded evidence document carries a count it is recorded under gates[].tests with its source; otherwise it stays null
- `executedTests`: per-gate test selection/execution counts are not exposed by the Actions API; they live in each run log, which this document does not parse. Where a gate's embedded evidence document carries a count it is recorded under gates[].tests with its source; otherwise it stays null
- `unexecutedTests`: per-gate test selection/execution counts are not exposed by the Actions API; they live in each run log, which this document does not parse. Where a gate's embedded evidence document carries a count it is recorded under gates[].tests with its source; otherwise it stays null
- `tier`: the release has no single tier: the combination journey requires tier=full and the long-lived corpus requires medium, while other gates have none. Per-gate tiers are recorded under gates[].tier only where an embedded evidence document names them; a single release-wide value would be invented
- `negativeControl`: no gate on this wave is required to carry a negative-control/teeth member in its embedded evidence, and the Actions API does not expose one

### Selection proof

- proven from the API: none
- unverifiable (the manifest names no requiredSelection, so the dispatch inputs are not exposed): GoTavern CI, GoTavern whole-session differential, GoTavern world-info slot ordering, GoTavern drop-in qualification, Browser differential, GoTavern release qualification, GoTavern smoke metrics, GoTavern Docker image, Helper state differential, Combination journey differential, Third-party extension compatibility, GoTavern long-lived corpus qualification, GoTavern Node stock tree round trip
- narrowed (refused): none

Pinned oracle commit: `06bde939fb1e9c4c8d8641d810f0a916b5bce127` (--pinned-sha (the release baseline policy))

