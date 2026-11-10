> **SUPERSEDED — DO NOT CITE FOR THE RELEASE.** This 60-minute soak ran on the subject built from
> `7a8f9776455dca7ef9eb42f6337e4e2846ddf828` (Go source then proven identical to `fc30e38`). After that run, the
> final candidate changed to **`260b7900d4bd2385a321ef859c7f998b8e28e02c`**: Linux CI at `fc30e38` found two real
> regressions (HEAD `/version` wrote a body where pinned writes none; the SD in-flight-disconnect interrupt could
> lose a race against the handler returning on an already-cancelled context), and both fixes changed Go code. The
> required soak on `260b790` is the separate, current record in `soak-60min.md`; this file is kept only as a
> clearly-labelled appendix (it also documents the harness and the hash-equivalence method). Nothing here is
> evidence for `260b790`.
>
> Subject of this superseded run: `7a8f977` binary sha256
> `62542625E17F89C9DF70F8335E8F674AC9F1BE4541DD04A0D02C3B4BB1FCB77C`; VCS-free rebuild of both `7a8f977` and
> `fc30e38`: `6C00D8D23A86359ADA8515AC44A508A3655226FD35555744BA12383CD36FFFC0`.
# alpha.20 60-minute mixed-load soak — frozen candidate `fc30e38`

Status: **COMPLETE, Layer A (Windows arm64 development host). Not a CI verdict.** This is post-candidate
evidence for the frozen candidate `fc30e38e667dc2373a672da0582bbf51665b7974`; the subject was built from
`7a8f9776455dca7ef9eb42f6337e4e2846ddf828`, whose Go source and VCS-free binary are **provably identical** to
`fc30e38` (§0). The Lead's frozen SHA is the release record; this document records what was run and what it can
and cannot prove.

Raw artifacts: [`raw/soak-60min/`](raw/soak-60min/) (`soak-primary.json`, `soak-companion.json`,
`soak-run.json`, `candidate-hashes.txt`, `subject.txt`, the harness logs, the provider probe and the mock-provider
script). The subject binary itself is NOT committed (60.9 MB); its sha256 is recorded here and in
`candidate-hashes.txt`.

## 0. Candidate identity: the hash question, answered with a byte-identical rebuild

The original freeze `7a8f977` and the corrected freeze `fc30e38` differ only in
`tests/browser/a20-probe-kit.mjs` (test tooling): `git diff 7a8f977 fc30e38 -- '*.go' cmd internal` is **empty**.

| build | sha256 | note |
|---|---|---|
| soak subject, built from `7a8f977` (`-trimpath -ldflags="-s -w"`) | `62542625E17F89C9DF70F8335E8F674AC9F1BE4541DD04A0D02C3B4BB1FCB77C` | the binary that actually ran |
| same source built from `fc30e38` (identical flags) | `941496B6678D586886F0E8F4975DA84F05FF4A6445B167D6CC9243171E9CA130` | differs only by Go's embedded VCS stamp |
| both SHAs rebuilt with **`-buildvcs=false`** (identical flags otherwise) | **`6C00D8D23A86359ADA8515AC44A508A3655226FD35555744BA12383CD36FFFC0`** (both) | **byte-identical** |

`go version -m` on the two with-VCS binaries differs only in `vcs.revision`, `vcs.time` and the module
pseudo-version derived from them — i.e. the difference is the embedded commit stamp, not code. The VCS-free
rebuild is the proof: the soak subject is the same machine code as `fc30e38`. **Acceptance of this as
`fc30e38`'s soak is the Lead's release decision; both hashes and this proof travel with the evidence.**

## 1. Protocol

- Host: Windows arm64 development host, `virt-7.2`, 2 logical cores; host dedicated by the Lead for the run
  (no other lane's heavy work during it; the earlier `/version`-style load questions from the quiet window do not
  apply to this dedicated hour).
- Subject: `gotavern.exe` built from a detached worktree at `7a8f977` (the frozen candidate's source), with
  `tests/perf/fixturegen` and `tests/perf/procstat` built from the same tree.
- Data: one `mixed-large` fixture tree (1,001 cards / 2,410 files / 48,675,577 B per the primary harness's own
  header), generated once and **copied per harness** so the primary's restarts cannot disturb the companion.
- Two harnesses ran **concurrently against two separate processes of the same binary**:
  - primary: `tools/perf/a18-soak.mjs` (UNMODIFIED) — `--minutes 60 --rate 8 --restart-every-minutes 10`;
    weighted storage routes (`/version`, `/`, `/api/characters/all`, `/api/characters/chats`,
    `/api/settings/get`, `/api/worldinfo/list`, `/api/chats/save`, `/api/chats/get` saved and real), saved-chat
    integrity across every restart, external card-mtime probes, availability checks, RSS/CPU sampling every 15 s;
  - companion: `tools/perf/a20-soak-companion.mjs` — `--minutes 60 --rate 2`; 4 MiB `/api/worldinfo/get` plus a
    reversible `/api/worldinfo/edit` cycle once per minute, 3 independent cookie-jar sessions, chat
    save→reload→on-disk equality, and (only if a loopback provider peer had attached) a streaming generate
    cancelled mid-SSE once per minute.
- Started 2026-11-09T20:13:22 local, ended after 60 min; primary exit 0, companion exit 0, neither process
  exited mid-run. Total mixed load: **21,946 + 18,498 = 40,444 requests**.

## 2. Primary harness (storage / restart / integrity / availability)

| row | result |
|---|---|
| requests | **21,946 attempted / 21,946 succeeded / 0 errors** (`errorClasses {}`, `statusClasses {}`) |
| latency (all routes, loopback, shared host — NOT an SLO) | p50 **46.33 ms**, p95 **557.79 ms**, p99 **707.78 ms**, max 2,230.71 ms |
| restarts | **5/5** at the 10-minute marks; boot 247-288 ms, downtime 2,348-2,483 ms; `orphanAfterStop: false` on every restart; Windows stop is `taskkill /T /F` after `/T` refused (recorded per restart, no graceful-drain claim) |
| saved-chat integrity | 6/6 checks pass (after each restart + final): HTTP read-back matches the saved sequence and the on-disk sha256; 3,392 saves recorded |
| fixture chat untouched | sha256 `ac19a794…` before and after — unchanged |
| external card modification | **59/59 probes pass** (`fs.utimes` on one card PNG, bytes untouched; `/api/characters/all` still 200 with the card present); probe card bytes sha256 unchanged |
| availability | **239/239** `/version` checks answered 200 |
| harness assertions | `failures: []` |

Per-route percentiles (ms, sample count in parentheses): `/version` 16.16 / 25.44 / 34.81 p50/p95/p99 (2,628);
`/` 47.66 / 123.47 / 161.31 (1,707); `/api/characters/all` 511.54 / 732.16 / 1,207.44 (2,664);
`/api/characters/chats` 196.67 / 327.86 / 482.46 (2,117); `/api/settings/get` 202.42 / 322.57 / 462.65 (2,175);
`/api/worldinfo/list` 18.94 / 32.36 / 47.23 (2,131); `/api/chats/save` 37.38 / 64.36 / 81.04 (3,392);
`/api/chats/get` (saved) 16.99 / 27.54 / 37.40 (2,637); `/api/chats/get` (real) 102.40 / 199.29 / 281.46 (2,194).

## 3. Companion harness (the mixed-load components a18-soak omits)

| row | result |
|---|---|
| iterations / requests / errors | 3,063 / 18,498 / **0** |
| `/api/worldinfo/get` 4 MiB | p50 **10.50 ms**, p95 32.46, p99 49.75, max 292.68 (3,063 samples) |
| reversible `/api/worldinfo/edit` | **60/60 cycles**: edit 200, marker present on re-read, then original bytes restored and **byte-identical** (`restoredByteIdentical: true`, final check true) |
| chat save → reload → disk equality | **3,063/3,063 checks, 0 failures** |
| characters-all | p50 377.49 / p95 515.12 / p99 811.83 (3,063) |
| settings-get | p50 139.87 / p95 195.74 / p99 256.01 (3,063) |
| chats-get | p50 71.52 / p95 132.00 / p99 173.63 (3,063) |
| chat-save | p50 36.58 / p95 66.24 / p99 83.67 (3,063) |
| multi-session switching | 3 independent cookie-jar sessions on one default-user process, each driving its own requests; multi-**account** isolation is NOT this row (it is `tests/perf/m5-eight-users.mjs`, 8 accounts, 144 requests, 0 non-200 — separate evidence) |
| generation + SSE cancel | **UNEXECUTED, recorded not faked**: the loopback `reverse_proxy` probe answered **502** (the candidate refuses a loopback reverse-proxy target), so no provider peer was attached and the companion ran without `--provider-base`; the artifact says so in `provider.reason` |

## 4. Resource trends and the leak verdict

Per-boot segments (RSS in decimal MB; each restart starts a new process with an empty heap, so first/last/trend
are reported per segment and **never pooled**):

| segment | boot | RSS at segment start | RSS at segment end | peak RSS | slope |
|---|---:|---:|---:|---:|---:|
| 0 (cold) | 579 ms | 72.76 | 88.38 | 109.45 | +0.91 MB/min |
| 1 | 280 ms | 22.02 | 85.54 | 104.91 | +2.22 MB/min |
| 2 | 288 ms | 22.31 | 98.34 | 104.39 | +2.23 MB/min |
| 3 | 260 ms | 22.44 | 97.47 | 106.05 | +1.73 MB/min |
| 4 | 247 ms | 22.31 | 93.68 | **111.87** | +1.82 MB/min |
| 5 | 277 ms | 22.33 | 94.99 | 107.25 | +1.26 MB/min |

CPU over the hour: **user 559.0 s + system 293.4 s** (procstat per-segment deltas).

Interpretation, stated so it cannot be read as more than it is: each segment shows a rise from a fresh ~22 MB
process to a ~85-98 MB working set, and the per-segment peak is stable at 104.4-111.9 MB across all six boots.
That pattern is consistent with per-boot warm-up (card-text cache, buffers, GC arenas) rather than unbounded
growth, and the restart resets it — but **a 60-minute RSS trend is not a leak proof**:
`leakVerdict: UNPROVEN` (the harness's own verdict, reproduced here). Heap, goroutines and file descriptors are
**not observable** from outside this binary: it exposes no pprof endpoint, Windows `procstat` reports
`handles=null`, and goroutine count has no external source. Graceful-shutdown flush and same-port restarts are
also not measured (Windows has no SIGTERM delivery to a console process; every boot takes a fresh port).

## 5. Mixed-workload coverage, one row per requirement

| required component | driven? | evidence |
|---|---|---|
| read cards | YES | primary `/api/characters/all` 2,664 + probe rows; companion 3,063 |
| edit / save / reload chats | YES | primary 3,392 saves + 6 cross-restart integrity checks; companion 3,063 save→reload→disk checks, 0 failures |
| world info | YES | primary list 2,131; companion 4 MiB get 3,063 + **60 reversible edit cycles, all byte-restored** |
| complex generation | **NO — UNEXECUTED** | loopback reverse-proxy probe answered 502; no controlled peer attached (reason recorded, no fabricated success) |
| SSE cancel | **NO — UNEXECUTED** | same reason; not claimed |
| multi-session switching | YES | 3 independent cookie-jar sessions, 18,498 requests, 0 errors |
| restarts | YES | 5/5 with saved-chat integrity and no orphans |
| long-run resource trend | YES, bounded | §4; leak **UNPROVEN** by construction |

## 6. Honest limits of this soak

- **No leak proof.** 60 minutes is a trend, not a proof; the verdict is UNPROVEN and stays UNPROVEN.
- **No heap/goroutine/FD census.** Not observable without an in-process hook (which would change the binary).
- **No graceful-shutdown claim.** Forced Windows stop; the flush path is not exercised.
- **Generation/SSE-cancel unexecuted** for the recorded 502 reason. A provider soak needs a permitted controlled
  peer; the CORS-proxy/local-upstream tests cover real sockets, but not a 60-minute relay.
- **Latency rows are loopback and host-shared**, with companion load on the same 2 cores; the sample counts are
  printed beside every percentile and none of them is an SLO.
- **One host, one platform.** Linux/macOS/arm64-Linux rows do not exist here (CI gates, not this document).
- This run is on the **source-identical** candidate described in §0; if the Lead does not accept that
  equivalence, the soak would have to be re-run on a `fc30e38` binary — the VCS-free rebuild is the evidence
  that it would be the same machine code.
