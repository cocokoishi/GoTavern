# alpha.20 release evidence (published)

## The release

- URL: https://github.com/cocokoishi/GoTavern/releases/tag/v0.1.0-alpha.20
- Tag: annotated `v0.1.0-alpha.20`, tag object `f25fbb6`, peeling to the gated candidate
  `260b790` (`260b790`).
- Published by GoTavern Release run **42788799794**: all six build jobs, `execute-darwin-amd64`,
  `execute-linux-arm64`, `windows-arm64-boundary`, `darwin-arm64-recorded-downgrade`,
  `prepublish-qualification`, `publish` and `post-release-facts` completed successfully.
- API facts: `draft=false`, `prerelease=false`, `target_commitish=main`, `published_at=2026-11-10T09:15:50Z`;
  six canonical archives plus `checksums.txt`; `releases/latest` returns `v0.1.0-alpha.20`.
- Same-SHA evidence: [`same-sha-evidence.md`](same-sha-evidence.md) — verifier `PASS 14/14` at the candidate.

## Publication history that must be stated

Three freeze attempts preceded the published tag; each is recorded in `same-sha-evidence.md` and none was
tagged or published:

1. `496e5a9` — cancelled before any gate completed: the candidate's release-notes draft under-counted the fixed
   findings (seven vs nine) and the comparator-teeth evidence arrived after the commit.
2. `7a8f977` — corrected notes + teeth evidence, but the third-party gate's harness self-test refused the
   alpha.20 probe kit's bind-0-and-close port allocation (`a20-probe-kit.mjs`). Runs cancelled; only that
   self-test had reported, failing for the recorded reason.
3. `fc30e38` — the probe kit now allocates through the shared port lease; it differs from `7a8f977` only in
   `tests/browser/a20-probe-kit.mjs` (no `.go`, `cmd/` or `internal/` change). Linux CI at that SHA then
   measured two real regressions: the HEAD oracle (`TestPinnedNodeHTTPOracleHeadResponses//version`, "HEAD
   response wrote 168 body bytes") and the SD in-flight-disconnect interrupt (`TestSDA1111InterruptOnClientClose`,
   no interrupt within 5 s). Both were fixed in `260b790` — a HEAD-aware JSON writer for the conditional path,
   and a fire-once completion path in the socket-close watcher so a disconnect cannot lose the race against the
   handler returning on an already-cancelled context — with dedicated regression tests. Its other gates were
   cancelled, not cited.
4. A third-party run at `260b790` was cancelled at its 150-minute job timeout while one shard's `npm install`
   stalled on the runner; the gate was re-dispatched at the same SHA (run 42778585855) and completed all
   required jobs successfully. No code or SHA changed.

No tag was moved; alpha.19 still peels to `bbc5615` and alpha.18 to `a417721`.

## Post-publication verification (independent of the release run)

All of the following were executed against the PUBLISHED artifacts, not a local build:

| check | result |
|---|---|
| release flags / target | `draft=false`, `prerelease=false`, target `main`, published 2026-11-10T09:15:50Z |
| assets | `checksums.txt` + six archives (linux/darwin/windows × amd64/arm64) |
| checksum | downloaded `gotavern-windows-amd64.zip`; recomputed SHA-256 `02c0de7d2de5617d1471c92201e7668bb74b6d1688d8466d4c078f4938fb863c` equals the published `checksums.txt` line |
| published binary | unpacked `gotavern.exe version` → `GoTavern v0.1.0-alpha.20` / `SillyTavern baseline 1.19.0 (06bde939fb1e9c4c8d8641d810f0a916b5bce127)`; `BUILD-INFO.txt` says `GoTavern release v0.1.0-alpha.20`, target windows |
| fresh-boot closure (published binary) | `GET /version` 200 with the pinned compatibility record; `GET /` 200 (734,837 B); `POST /api/characters/all` 200 (31,262 B); `POST /api/chats/save` 200 `{"ok":true}`; `POST /api/chats/get` 200 with the saved message; process restart, then `POST /api/chats/get` 200 with the same message and `GET /version` 200 |
| installer with no version argument | `install.ps1 -InstallDir <temp>` printed "Checksum verified" and installed alpha.20; installed `gotavern.exe version` reports `GoTavern v0.1.0-alpha.20` on the pinned baseline |
| Docker | GHCR manifests for `:v0.1.0-alpha.20` and `:latest` both resolve to `sha256:5ffa859b0d25de30e9fed4ae570e2fc6f2758d3ac48ea20ff683b502d7b0b91e` (tag-triggered Docker run 42788799643 success, including its own pull-back verification) |
| `releases/latest` API | `v0.1.0-alpha.20` |
| historical tags | `v0.1.0-alpha.20` peels to `260b790`; `v0.1.0-alpha.19` still `bbc5615`; `v0.1.0-alpha.18` still `a417721` |

## The 60-minute soak (final candidate)

Run on the frozen candidate `260b790` only. Subject binary built from that exact SHA in a detached worktree
with `-buildvcs=false -trimpath -ldflags="-s -w"`: **sha256
`6A297E48C238389DA02E113EA7BFD82021C4A18ACCE35E13CBFA8E8F6CECA1EB`**, 60,915,200 B. Started 2026-11-09
21:30 local, 60 minutes, both harnesses exited normally; 55,781 mixed requests total.

- **Primary (unmodified `tools/perf/a18-soak.mjs`, rate 8, restart every 10 min):** 28,801/28,801 requests,
  **0 errors**; p50 30.65 / p95 238.16 / p99 291.76 / max 2,832.16 ms; **5/5 restarts** (boot 131-191 ms,
  downtime 1.77-1.98 s, no orphans), each with saved-chat HTTP+disk integrity passing (6/6 incl. final;
  4,519 saves); fixture chat and probe-card bytes unchanged; **59/59** external-card-mtime probes;
  **239/239** availability; `failures: []`.
- **Companion (`tools/perf/a20-soak-companion.mjs`, rate 2):** 4,477 iterations / 26,980 requests /
  **0 errors**; 4 MiB worldinfo-get p50 **5.07** / p95 14.70 / p99 23.39 ms; **59/59 reversible worldinfo
  edits restored byte-identically**; **4,477/4,477** chat save→reload→on-disk equality checks; 3 independent
  cookie-jar sessions.
- **Resources:** per-boot peak RSS **stable 116.0-119.5 MB across all six boots** (fresh ~22 MB warms to
  ~85-96 MB inside each 10-minute segment; restart resets it); CPU user 691.4 s + system 392.1 s.
- **Leak verdict: `UNPROVEN` by construction.** 60 minutes without growth is not a mathematical leak proof;
  live heap vs allocator retention is not separable, heap/goroutines/FDs are not externally observable (no
  pprof endpoint; Windows `handles=null`), and the forced Windows stop means no graceful-drain claim.
- **Generation/SSE-cancel: UNEXECUTED.** The loopback reverse-proxy probe answered 502 (the candidate refuses
  that target), so no streaming peer was attached; the reason is recorded in the companion artifact. The
  earlier candidate's soak is kept only as a banner-labelled superseded appendix and is not cited.

## What the release does not prove

`GOAL.md` §14 remains **NOT MET** / `PRIVATE_NOT_RUN` (agent-authored corpora, not a real user's years-old
directory). Not executed: provider-wire fault injection, disk-full injection, a >8-user concurrency row, the
five-layer oracle on the medium corpus, darwin/arm64 runtime and windows/arm64 runtime. The comparator
mutation set was run post-candidate (13/13 killed) and is post-candidate documentation evidence, never gate
evidence. The kept disclosed differences are Brotli codec-only negotiation, the `_cache/characters` read/write
cache, and the dominantColor ±1 normalisation, each with its recorded decision.
