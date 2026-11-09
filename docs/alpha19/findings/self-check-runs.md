# Live-UI-oracle self-check runs: what each run taught, and the rules that came out

The synthetic self-check journey uses the pipeline against a stand-in corpus. It is **never release evidence**
(`kind:"harness-self-check"`, `releaseAdmissible:false`), but it is the only cheap way to prove the pipeline detects
what it claims. Runs are kept in `a19-diff/selfcheck/runN/` on the operator host; this document records the
findings and the harness rules they produced.

## Contamination rule (run7 → run8)

Run7 was executed with a binary built from the SHARED working tree, so it carried another lane's in-flight product
edits. Its 110 `/api/tokenizers/openai/count` findings and its `x-gotavern-tokenizer-*` header deltas are therefore
NOT evidence about the candidate commit. **Rule: every release-admissible run builds from an isolated
`git worktree` at the candidate SHA (`git status` must be clean), records the SHA and the binary's sha256, and says
in the run log why.** Runs 8+ follow it.

## Per-run ledger

| run | binary | failedGuards | cause / action |
|---|---|---|---|
| 3 | shared tree | `wire-headers-equal`, `browser-event-order-equal`, `http-bodies-equal` | wire header comparison emitted an object whose key order made identical SETS differ → sorted pairs; event-order claim was raw stream → replaced with core-set + causal invariants (and the invariant itself had `message_sent`/`generation_started` swapped — a HARNESS bug, measured on both subjects); static assets were compared despite the recorded validator divergence → layer B scoped to `/api` |
| 4 | shared tree | `browser-event-order-equal`, `http-bodies-equal` | settings/get `enable_extensions_auto_update` is the RECORDED auto-update product decision (AGENTS 26) → named projection; HTTP header values needed the per-leg loopback origin, session csrf, content-encoding value decisions |
| 5 | shared tree | `browser-event-order-equal`, `http-bodies-equal` | the causal invariant was wrong (GENERATION_STARTED precedes MESSAGE_SENT on BOTH subjects) → corrected; `/api/horde/*` bodies are live third-party data (AGENTS 14) → named decision; body-derived ETag compared only when raw bodies are equal; **PRODUCT FINDING: `/api/extensions/discover` answered 200 where pinned answers 304** → fixed (`5488f9a`, `24b96a1`) |
| 6 | shared tree, conditional-GET fix in | `http-request-set-equal`, `http-bodies-equal` | autosave request bodies carry intermediate async state (persona init) while final settings match; run-created chat names and mtime/run clock list fields; one llama/encode tokenizer request in 67 (load race). **The discover product fix is confirmed: browser layer MATCH.** |
| 7 | shared tree (CONTAMINATED with another lane's in-flight edits) | `http-bodies-equal` (125 problems) | 110 tokenizer problems = other lane's in-flight tokenizer work, not the candidate; 1 = the GENERAL conditional-GET gap now observable on `GET /api/sprites/get` (pinned 304 vs GoTavern 200) → extended the fix to sprites/get, users/me and data-maid/view; remainder = run clocks not yet named (groups/all date_added) |
| 8 | clean worktree `6ccc6b9`, binary `B8A5958…` | legs-drove | first boot of the clean binary timed the page load out (30 s); 5/6 legs drove fine — rerun |
| 9 | clean worktree `6ccc6b9`, binary `B8A5958…` | `http-bodies-equal` (71 problems) | 66 were an index-pairing artefact (SAME 20 unique tokenizer request bodies, different arrival order/multiplicity; 21/21 identity-paired responses were IDENTICAL); groups/all `date_added` is a run clock (591 ms apart); `/api/ping` empty-body digest recording; the generate proxy's streamed text was not captured → four harness fixes (`1d52f06`) |

## What "green except named decisions" means here

A green self-check requires every layer's verdict to be `match`. Named decisions are individually recorded with
reason + pinnedEvidence + field + test + negativeCase and are exercised by teeth (each decision's negative case is a
mutation that must red, plus survivors that prove the decision is NOT wider than stated). The synthetic run is
therefore a coverage proof for the pipeline, not a product claim; the product claim is only the release-admissible
run over the real `origin:"ui"` corpus, verified by `scripts/verify-a19-evidence.mjs`.
