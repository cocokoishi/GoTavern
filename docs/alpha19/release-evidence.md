# alpha.19 release evidence (published)

## The release

- URL: https://github.com/cocokoishi/GoTavern/releases/tag/v0.1.0-alpha.19
- Tag: annotated `v0.1.0-alpha.19`, tag object `50d0c3aa`, peels to
  candidate `bbc5615`.
- Published by GoTavern Release run **42679494601** (all build jobs, `prepublish-qualification`, `publish` and
  `post-release-facts` success).
- `draft=false`, `prerelease=false`; `releases/latest` (API) returns `v0.1.0-alpha.19`; six canonical archives
  plus `checksums.txt`.
- Same-SHA evidence: [`same-sha-evidence.md`](same-sha-evidence.md) (14 gates, verifier PASS 14/14).

## Publication history that must be stated

A tag named `v0.1.0-alpha.19` was first created at candidate `0e5ea6f` and its release run 42646918062 reached
`publish`, where the darwin/arm64 platform-limitation rail **refused publication** because the curated notes did
not state that darwin/arm64 runtime execution is not qualified. **No release was ever published from that tag.**
The notes were corrected in `bbc5615` (docs-only: the limitation line now reads "darwin/arm64 runtime execution
is not qualified … NOT EXECUTED … windows/arm64 is build-only"), a full 14-gate wave was re-run at the new SHA,
the unpublished tag was deleted, and the tag was re-created at `bbc5615`. This is a re-tag of a never-published
tag, not a move of a published one; every historical tag (alpha.18 and older) is untouched (alpha.18 still peels
to `a41772152a76cd3c42c52b63f2a377e2963de6fd`).

A second publish attempt at `bbc5615` failed on an API flake while fetching the third-party gate's job list
(`missing-jobs`), with every gate green; re-running the failed jobs succeeded.

## Post-publication verification (independent of the release run)

| check | result |
|---|---|
| release flags / target | `draft=false`, `prerelease=false`, target `main` |
| assets | `checksums.txt`, `gotavern-{linux,darwin,windows}-{amd64,arm64}.(tar.gz\|zip)` (6 archives) |
| checksum | downloaded `gotavern-windows-amd64.zip`, recomputed SHA-256 = `8cc447dd8b33d7fc5d346e7f884f99bed7bb75ef9c1bd26313c4dc1f77220b2e`, equal to the published `checksums.txt` line |
| published binary | unpacked `gotavern.exe version` → `GoTavern v0.1.0-alpha.19` / `SillyTavern baseline 1.19.0 (06bde939fb1e9c4c8d8641d810f0a916b5bce127)` |
| release body | carries the `## Qualification evidence (same-SHA required gates)` table with the 14 run ids, including CI 42650085850 and the new gate 42647718786 |
| `releases/latest` | `v0.1.0-alpha.19` |
| historical tags | `v0.1.0-alpha.18` peels to `a4177215…` (unchanged) |

### Independent verification (a second lane, after publication)

A separate lane re-ran the checks from scratch: `gh release view` → `draft=false`, `prerelease=false`, target
`main`, published 2026-11-09T19:08:48Z, 7 assets; **all six archive lines in `checksums.txt` match the release
asset digests**; the downloaded windows-amd64 zip matches its checksum line and its unpacked
`gotavern.exe version` prints `GoTavern v0.1.0-alpha.19` on the pinned baseline; `releases/latest` returns
`v0.1.0-alpha.19`; the tag object `50d0c3aa…` peels to the candidate and the old unpublished tag object
(`093344c`) is gone; **no published release points at the old tag's commit `0e5ea6f`**; alpha.18 is untouched
(`bc1289be…` → `a4177215…`). Conclusion: the published artefact chain is consistent end to end.

The release workflow's own `execute-linux-amd64`, `execute-linux-arm64`, `execute-darwin-amd64` and launcher
checks executed the matching archives; darwin/arm64 and windows/arm64 are recorded as build-only/platform
limitations in the notes, not claimed as executed.

## What the release does not prove

`GOAL.md` §14 remains **NOT MET** (the UI-originated corpus is agent-authored, not a real person's years-old
directory). The new gate's own disclosed decisions and not-compared surfaces are listed in the release notes and
in `docs/alpha19/perf/summary.md`; peak-RSS is one Layer A paired row, not the release gate; the long-run memory
trend, ≥8-user concurrency and corpus p99 remain unproven.
