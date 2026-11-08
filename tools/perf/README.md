# tools/perf

Process-level performance and stability harnesses that boot a REAL GoTavern binary against a generated data root.
They are development/qualification tools: they need Go on the machine that builds the helper binaries, and they are
never part of the shipped server.

| script | question it answers |
|---|---|
| `fingerprint.mjs` | the build/behaviour fingerprint used by the perf lane |
| `a18-soak.mjs` | **alpha.18 release qualification:** does a real binary survive an hour of mixed storage traffic with restarts, write→restart→read integrity, and an external card modification? |

## `a18-soak.mjs` — 60-minute soak

```powershell
# 1. build the candidate binary and the two helpers
go build -trimpath -ldflags="-s -w" -o "$env:TEMP\a18\gotavern.exe" ./cmd/gotavern
go build -o "$env:TEMP\a18\a15-procstat.exe" ./tests/perf/procstat
go build -o "$env:TEMP\a18\a15-fixturegen.exe" ./tests/perf/fixturegen

# 2. generate a real SillyTavern-shaped tree (1000 cards + 102 chats + 200 worlds + settings + a complex preset)
& "$env:TEMP\a18\a15-fixturegen.exe" --out "$env:TEMP\a18\tree" --scale mixed-large

# 3. the release-qualification run
node tools/perf/a18-soak.mjs `
  --binary   "$env:TEMP\a18\gotavern.exe" `
  --data-root "$env:TEMP\a18\tree\data" `
  --config   "$env:TEMP\a18\tree\config.yaml" `
  --minutes 60 --rate 8 --restart-every-minutes 10 `
  --out      "$env:TEMP\a18\a18-soak-60min.json"
```

The script boots the binary with `--dataRoot/--configPath/--port/--listenAddressIPv4 127.0.0.1` (plus
`browserLaunchEnabled=false`, `listen=false`, `enableIPv4=true`, `enableIPv6=false`, `heartbeatInterval=0`), waits
for `GET /version` 200 within a bounded deadline, performs the `/csrf-token` + cookie handshake, then drives a
weighted, request-paced mix with **one request in flight**: `/version`, `/`, `/api/characters/all`,
`/api/characters/chats`, `/api/chats/get`, `/api/settings/get`, `/api/worldinfo/list`, `/api/chats/save` (create and
overwrite the same small chat file) and `/api/chats/get` on that saved file. Names come from the supplied tree
(`/api/chats/save` and `/api/chats/get` append `.jsonl`, so the wire `file_name` is the basename without it).

Every `--restart-every-minutes` it stops the process (`taskkill /T`, then `/T /F` when Windows refuses the
non-forced stop — recorded verbatim), boots again on the SAME data root on a fresh loopback port, re-handshakes, and
re-reads the last saved chat, comparing both the HTTP content and the on-disk bytes. Every ~60 s it moves the mtime
of ONE card PNG with `fs.utimes` (bytes untouched) and asserts `POST /api/characters/all` still answers 200 with that
card's avatar and name.

Every 15 s it samples `tests/perf/procstat` (RSS, peak RSS, CPU user/system) and checks `GET /version` availability.
The artifact records `environment`, `parameters`, `samples`, `requests` (every raw latency sample, per-route
summaries, status/error classes), `restarts`, `segments`, `integrity`, `externalModification`, `availability`,
`memory`, `cpu`, `failures` and `notes`.

### Exit codes

- `0` — run completed, every assertion passed.
- `1` — completed (or aborted) with a named failure in `artifact.failures`: an unexpected HTTP status, a request
  error, an availability failure, a saved-chat integrity mismatch, an external-modification probe failure, or a
  leftover process.
- `2` — harness/setup failure (bad arguments, missing binary/tree/helper, boot failure). No artifact is written.

### What it deliberately does NOT measure

- **Handles/FDs.** `procstat` reports `handles=null` on Windows; the artifact claims no FD count.
- **Goroutines / live heap.** Not observable from outside; the binary exposes no pprof endpoint. RSS is the only
  memory observable, so a **leak verdict is `UNPROVEN`** by construction (allocator retention and live heap are not
  separable from RSS).
- **Graceful shutdown.** Windows cannot deliver SIGTERM to a console process, so the stop is forced; shutdown-flush
  paths are not exercised.
- **Provider streaming/generation.** The soak drives storage and settings routes only; no provider request is issued.
- **Same-port restart.** Each boot takes a fresh loopback port so TCP state or a pooled connection to the previous
  origin cannot manufacture a restart failure.
