# alpha.19 decision log

Decisions made during the round, with the reason and the evidence that constrains them. A decision is
**reversible only through a new entry**, never by silently editing an old one.

| id | date | decision | reason | status |
|---|---|---|---|---|
| D-01 | 2026-11-08 | Work branch is `alpha19/program`, created from `52883e8`; no pull request; merge to `main` locally when the cheap checks pass (repo working mode). | AGENTS.md "Working mode: CI-first, branch-merge, no pull requests"; user prompt §七 requires an explicit branch and a fixed commit. | applied |
| D-02 | 2026-11-08 | The pinned-oracle byte manifest covers `server.js`, `package.json`, `package-lock.json`, `public/**`, `src/**`, `default/**` (906 files, 61,049,059 bytes). It is committed as `oracle-pin.sha256` + `oracle-pin.json`. | Those are the trees a differential reads: the frontend the browser loads, the seeded defaults, and the server source. `.git`-internal objects are not evidence and are excluded. | applied |
| D-03 | 2026-11-08 | The real-UI corpus's **originals** stay outside the repository (scratch); what may be committed is a deterministic CI-tier corpus plus the generation driver, action log, wire captures and SHA256 manifest — and only after the corpus is proven to be reproducible from the driver. | AGENTS.md 51/56 (real artefacts are read-only inputs; a derivation is what may be committed) and the user prompt's requirement that the corpus be UI-originated, not generator-fabricated. The full corpus may be tens of MB; the repository is not a private-data store. | open — size/reproducibility being measured |
| D-04 | 2026-11-08 | The new real-UI oracle CI gate will be a **separate workflow** (`real-ui-oracle.yml`) wired into `docs/release-manifest.json` as a required gate, unless a measured constraint makes a required job inside `Browser differential` strictly cheaper. | The new journey boots pinned and GoTavern over a corpus and needs its own timeout/artifact; putting it in the already-150-minute differential job risks the budget defect the ledger records (Q12/Q13/Q17 runs were cancelled at 90 minutes). | decided, implementation follows |
| D-05 | 2026-11-08 | No alpha.18 optimization is repeated. alpha.18 already removed per-card startup metadata touches, added the `ReadDir`-entry cache identity, the read-handle ctime, the direct JSON escaper and the UTF-16-length fast path. | `docs/alpha18/perf/README.md` §2/§3; user prompt §4.4 says do not repeat them. | applied |
| D-06 | 2026-11-08 | The alpha.19 normalization list starts EMPTY. Any future normalisation must name: reason, pinned evidence, field path, the test that applies it, and a negative case showing the test can fail. | User prompt §3.3; AGENTS differential doctrine 2/3. A global "ignore timestamps/headers" rule is forbidden. | applied |
| D-07 | 2026-11-08 | CI evidence for the new gate is a fixed-name artifact whose embedded `headSha` must equal the candidate and whose `pinnedCommit` must equal `06bde939…`; the release verifier reads its content, not only its name. | `docs/release-manifest.json`'s `requiredArtifact`/`requiredEvidence` rails; a green run whose artifact is stale or foreign must be refused. | drafted in `evidence-contract.md` |
| D-08 | 2026-11-08 | The goal's five observable layers are compared with byte-oriented provider wire (raw body sha256/length/target/method/headers), never canonicalised JSON or a semantic re-marshal. | AGENTS differential doctrine 2; user prompt §3.2 C. | applied |

## Rejected / deferred options (recorded so they are not rediscovered)

- **Commit the full corpus and replay it in CI.** Deferred: size and the "originals are read-only inputs"
  rule; a deterministic CI tier plus the driver is the honest shape, and the full corpus is qualified
  locally with a digest (D-03).
- **Add the new journey to the existing `differential` job.** Deferred: that job already has a 150-minute
  timeout and a history of cancellation at 90 minutes (D-04).
- **Normalise chat/settings timestamps globally.** Rejected: no evidence would distinguish a real
  divergence from a clock difference, and the user prompt forbids broad ignores (D-06).
- **Use the existing synthetic long-lived corpus as the alpha.19 input.** Rejected: `docs/longlived-corpus.md`
  states it is synthetic and deterministic; the user prompt explicitly says that is not the same as real UI
  use.
