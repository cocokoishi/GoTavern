# alpha.19 evidence window — 2026-11-09 (post-release, machine quiet)

This window ran the two steps that were still unmeasured when v0.1.0-alpha.19 was published. Nothing else was
measured; nothing was re-run. Both artifacts were produced after the release and are **Layer A evidence**
(Windows development host, Go 1.27.3, 2 logical cores). The release claim remains the Linux
`GoTavern smoke metrics` paired gate plus the five-layer oracle; these rows describe the published candidate's
behaviour on this host and must be labelled that way.

## Subject binary

`C:\Users\koishi\Desktop\GoTavern\a19-perf\bin\gotavern-quiet.exe`, size 67,363,328 B,
**sha256 `BF7F7FD62A03C84B9D3F0D60A501EB3232246A995EDCC9E5B550A62AFAC27EE9`**.
Built from commit `a71b7bc`; `git diff a71b7bc..bbc5615 -- internal/ cmd/` contains only two `*_test.go` files
(`internal/httpx/httpx_test.go`, `internal/server/account_reset_save_race_test.go`), which are not compiled into the
binary, so its **product code is identical to the released candidate `bbc5615`**. No rebuild was needed.

## Step 4 — 8-user concurrency smoke: RAN, PASS

```
node tests/perf/m5-eight-users.mjs --binary <binary> --report docs/alpha19/perf/raw/eight-users.json \
     --users 8 --waves 3 --max-seconds 120
```
**Duration 18.6 s** (harness `wallMs` 13,150, of which 8,227 ms is one-time account provisioning). Artifact:
[`eight-users.json`](eight-users.json) (6,629 B).

- Result: `ok = true`, `failure = ""`; checks all true — `boot/auth-readiness`, `write/status` (72 requests,
  0 non-200), `isolation/disk-and-cross-user` (8 accounts, own markers present, no cross-user marker),
  `isolation/read-own` (8 accounts served their own document).
- 8 accounts × 3 waves = 72 operations in 1,240 ms = **58.065 ops/s**; errorRate 0.
- Per-route latency (ms): `settingsSave` p50 285.5 / p95 344.0 / p99 361.5 / max 361.5;
  `settingsGet` p50 187.2 / p95 231.8 / p99 237.8; `chatsSave` p50 246.6 / p95 423.0 / p99 452.5.
- `thresholds` is null: no latency threshold was asserted (the harness refuses a cross-host grading without a
  previous report; see its `unproven` list). The artifact's own unproven items stand:
  "delete/rename/import were not driven: this row is the write/load/isolation cost row, not E06 in full".

## Step 5 — 10-minute corpus soak on the COPY: RAN, PASS with the leak verdict left UNPROVEN

```
node tools/perf/a18-soak.mjs --binary <binary> \
     --data-root C:\Users\koishi\Desktop\GoTavern\a19-perf\soak-corpus \
     --config  C:\Users\koishi\Desktop\GoTavern\a19-perf\soak-corpus\config.yaml \
     --minutes 10 --rate 8 --out docs/alpha19/perf/raw/soak-10min.json
```
**Duration 606.3 s** (10.003 min measured, ended by deadline). Artifact: [`soak-10min.json`](soak-10min.json)
(746,261 B; full per-request series is in the artifact). The soak ran against the COPY only; the original
`C:\Users\koishi\Desktop\GoTavern\a19-oracle\corpus` was **never written** (see immutability proof below).

- 4,850 requests attempted, **4,850 ok, 0 errors**; 8.081 req/s achieved of 8 target; 0 resync events.
- Latency (n=4,850): p50 21.36 ms, p95 35.42 ms, p99 48.9 ms, max 224.48 ms.
- RSS: peak 29.3 MB; segment 0 25.5 MB → 26.6 MB over 42 samples, **slope −29,037 B/min** (flat/slightly down).
  **Leak verdict: UNPROVEN** — the harness states RSS alone cannot separate live heap from allocator growth from
  outside; this row supports "no visible resource growth in 10 minutes", not "no leak".
- 0 restarts (the 10-minute deadline ends before the 10-minute restart interval; the harness also records that
  Windows has no SIGTERM delivery, so no graceful-drain claim is made).
- Integrity: saved-chat check 1/1 passed (HTTP and disk sha256 equal); the corpus's fixture chat is byte-identical
  before/after (`unchanged: true`); the probe card's bytes are unchanged. External-modification probes 9/9 ok;
  availability checks 39/39 ok; no orphaned processes.
- The COPY's tree changed as expected: +52 files (the soak chat, its backups, settings), 980 files / 48,070,898 B,
  delta +2 files / −1,827,871 B (backup retention prunes while the chat grows). That is the copy, not the oracle.

**Original-corpus immutability proof:** manifest of the original (978 files; relative path + size + sha256,
sorted) was recorded BEFORE any of this lane's work and again after the soak. Both manifests hash to
`150CC68CB60E9C8AB92E8E2F8C307806C252BE2D634DB1080A5B6B595D242DA1` — identical.

## What RAN / what did NOT run

| item | state | artifact |
|---|---|---|
| ABBA same-binary self-test (quiet window) | RAN — all 8 metrics not-separable | `abba-self-test-quiet.json` |
| ABBA cumulative A/B (quiet window) | RAN — warm 10k p50 −32.7%, cold peak RSS −42.4% | `abba-cumulative.json` |
| Node control (shared window) | RAN — boot/`/version`/10-min soak; RSS null off Linux | `node-control.json` |
| 8-user smoke | **RAN in this window** | `eight-users.json` |
| 10-min corpus soak (copy) | **RAN in this window** | `soak-10min.json` |
| longer soak (60 min) | DID NOT RUN | — |
| corpus p99 journey over the real UI corpus | DID NOT RUN (owned by the oracle lane) | — |
| real-provider latency | DID NOT RUN | — |

## Honesty notes for the report

1. Everything here is Windows/Layer A. None of it is a CI verdict.
2. `q22-paired-benchmark.mjs` reports `rssBytes = null` on Windows (it reads Linux `/proc`); the soak's RSS comes
   from the harness's own Windows process-stat helper. The two must not be mixed: no memory comparison is claimed
   from the Node control, and the soak's flat RSS is not a leak proof.
3. The 8-user run asserts isolation and non-error status; it does NOT assert a latency threshold and did not drive
   delete/rename/import.
4. The soak's 0 restarts is a property of the 10-minute run, not evidence about restart behaviour.
