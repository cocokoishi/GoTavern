# beta.1 round index

`v0.1.0-beta.1` is the install-first Beta: the first Beta of the 0.1.0 line and the first release published on
the **prerelease channel**. This file is the round's index; the records beside it are the evidence.

## Current stage

| field | value |
|---|---|
| stage | **PUBLISHED 2026-11-16T10:21:45Z: https://github.com/cocokoishi/GoTavern/releases/tag/v0.1.0-beta.1** |
| channel | **prerelease** (`--prerelease --latest=false`); `releases/latest` and Docker `:latest` still serve `v0.1.0-alpha.20` |
| baseline | pinned SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127` — unchanged |
| candidate / tag | candidate `d97c4d3`; annotated tag object `3fefdf3…` peels to it |
| product change | **none**. The Go sources, pinned `public/**` bytes and baseline are identical to `v0.1.0-alpha.20`; the binary differs only in its stamped version |
| gates | the same **14 required gates**; none added, removed, renamed, skipped or weakened; `PASS 14/14` at the candidate |

## Evidence index

| area | path | state |
|---|---|---|
| install verification (Layer A, local) | [`install-verification.md`](install-verification.md) | **executed** end-to-end on a stock pinned tree; two false draft claims refuted and removed |
| same-SHA wave | [`same-sha-evidence.md`](same-sha-evidence.md) | `PASS 14/14`; rehearsal + freeze record |
| published release | [`release-evidence.md`](release-evidence.md) | flags, 7 assets, checksum recompute, published binary `version`/`assets verify`, channel direction, Docker tags, post-release facts |
| release notes | [`../release-notes-v0.1.0-beta.1.md`](../release-notes-v0.1.0-beta.1.md) | curated, validator green (7,833 bytes), limits stated |
| release bar | [`../../GOAL.md` §16.3](../../GOAL.md) | frozen for this round |
| README contract | [`../../tools/check-perf-docs.mjs`](../../tools/check-perf-docs.mjs) + [`../../tests/docs/check-perf-docs.test.mjs`](../../tests/docs/check-perf-docs.test.mjs) | install-first; **20/20 negative controls**, now executed in CI's `verify` job |
| README | [`../../README.md`](../../README.md) | install-first landing page, ~9.3 KB |

## What changed in this round

| ID | change |
|---|---|
| B1-1 | `README.md` rewritten install-first: the drop-in recipe leads, then installer script, Docker and copy migration; compatibility scope and the unmet §14 claim beside the install path; figure and table below it; detail linked out. |
| B1-2 | `tools/check-perf-docs.mjs` re-wired: newest published release derived from `docs/generated/facts.json` (no hardcoded version), README-lag refusal, first-screen version-token rule, `## Install` required above the boundary, the literal drop-in pieces required, figure/alt checks follow the figure. |
| B1-3 | `tests/docs/check-perf-docs.test.mjs`: one named negative control per new refusal (20/20), wired into `ci.yml`'s `verify` job where it had never run. |
| B1-4 | `docs/INSTALLATION.md` §7.1: the drop-in recipe and the tokenizer requirement documented where the README points. |
| B1-5 | `docs/release-notes-v0.1.0-beta.1.md` + `GOAL.md` §16.3: curated notes for the prerelease channel and the round's release bar. |

## Findings that changed the README before it shipped

| # | draft claim | measured reality | disposition |
|---|---|---|---|
| 1 | "takes tokenizer data from the `src/tokenizers/` your SillyTavern install already has" | a stock `1.19.0` tree carries **9** of the **23** files the release needs; binary-only drop-in makes `assets verify` exit 2 and `gpt2/encode` silently answer `{"ids":[],"count":0,"chunks":[]}` | claim removed; the recipe copies the archive's `src/tokenizers/` and tells the user to run `assets verify` |
| 2 | `Expand-Archive … -DestinationPath .` inside an existing SillyTavern folder | fails in Windows PowerShell 5.1 (`already exists … Use the -Force parameter`); with `-Force` it overwrites the user's `LICENSE` | replaced with extract-to-temp + copy-the-two-pieces |

Both were found by the independent install lane and are recorded with their evidence in
[`install-verification.md`](install-verification.md). They are the reason the round's bar requires the install
claim to be verified before it is documented.

## Honest gaps carried into the record

- `GOAL.md` §14 stays **NOT MET** / `PRIVATE_NOT_RUN`; the release is qualified on synthetic corpora only.
- darwin/arm64 is **NOT runtime-qualified**; windows/arm64 is build-only. The Linux/macOS drop-in recipe was not
  executed on the development host (layout-verified by the release gates).
- A Beta closes no `PARTIAL` capability row; the alpha.20 disclosed differences are unchanged.
- The install verification is Layer A (Windows/arm64 host, windows/amd64 under emulation). The published-bytes
  installation claim rests on the CI gates cited in [`release-evidence.md`](release-evidence.md).
- Full-sweep CI at the post-release facts commit `53c7a6e` is `GoTavern CI` run `43848184614` (`probes=full`);
  its conclusion is the "main is green after the release" citation and is not a gate for the tag.
