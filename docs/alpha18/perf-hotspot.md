# alpha.18 hotspot record — root cause, production change, bounds

Status: **ROOT CAUSE MEASURED, PRODUCTION CHANGE LANDED, PAIRED A/B RECORDED** (LOCAL Windows arm64) and the
same-SHA CI performance gate is `GoTavern smoke metrics` in `docs/release-manifest.json`. This document is the
"why", `docs/alpha18/perf/README.md` is the "what was measured", and `docs/alpha18/perf/abba-inprocess.json`
carries the raw rows.

## 1. The symptom inherited from alpha.17

One local observation on a 10,000-card data root: boot to first `/version` 200 27,099 ms, steady RSS 925 MB,
peak 1,024 MB, `/api/characters/all` p50 5,481 ms. alpha.17 recorded it as a hypothesis at the hot path and
did not change product code.

## 2. Root cause, from profiles and controlled experiments (not from reading the code)

**Request path.** `-cpuprofile`/`-memprofile` over `BenchmarkCharactersAllScale/cards_10000_4KB_image`
(alpha.17 code, 3 iterations) showed 5,069 ms/op, 1,038.7 MB/op and 7.80 M allocs/op. Inside the route,
`processCharacter` was 17.0 s of 21.5 s and `os.Stat` 4.8 s; the allocation roots were:
`marshalNodeJSONString` (per-string `encoding/json` v2 + two `bytes.ReplaceAll` passes) 0.45 GB / 3.7 M
objects, `characterStringLength` (a `[]rune` + `[]uint16` pair per field) 0.37 GB, the per-card ordered-JSON
decode 0.36 GB, plus one `os.Stat` in `readCharacterDataStrict`, a SECOND `os.Stat` in `processCharacter`,
and on Windows a third open for the ctime.

**Startup path.** Controlled boots over identically generated 10,000-card trees (table in
`perf/README.md` §3) isolated the cost to *per-card filesystem metadata access during startup*, not to
directory enumeration and not to a wait: `DiskCache.verify` did an `Info()` + `os.Stat` per card (2 ×
10,000), and `InitializeStatistics` did a per-character `os.Stat` plus a per-character
`resolveExistingPathPrefix` (a `Lstat`/`EvalSymlinks` walk), i.e. another ~4-5 syscalls × 10,000. On a
freshly written tree each of those metadata operations makes this host's on-access scanner do kernel work
(the cold-boot system CPU was 19-20 s while user CPU stayed ~2.5 s), which is why alpha.17 saw 27 s. The
identical bytes copied to a new directory booted in 887 ms, so the algorithm was not doing 27 s of work —
it was doing 30,000 avoidable file touches.

## 3. The production change (what removes the work)

| file | change |
|---|---|
| `internal/server/characters_read.go` | `/api/characters/all` calls `processCharacterForDirEntry`: the listing entry supplies the card's pre-read identity |
| `internal/server/characters_card.go` | `readCharacterDataStrictWithIdentity` validates the cache with the listing identity and reads the ctime from the handle a miss already opens (one open instead of stat+read+stat+open); `processCharacterForDirEntry` falls back to the stat path when the entry is a symlink; `finishCharacterProjection` is shared so both paths produce the same object; `javaScriptStringLength` counts UTF-16 units without materialising arrays |
| `internal/server/characters_card_cache.go` | the cache value also carries the ctime; the contract comment records the one residual window (an attribute-only change that leaves type/size/mtime alone does not refresh `date_added` until one of them moves) |
| `internal/server/characters_ctime_*.go` | the Windows ctime can be read from an already-open handle (`nodeFileCtimeMillisecondsFromOpenFile`); POSIX keeps the `FileInfo` path |
| `internal/server/characters_json.go` | `writeCharacterJSONString` is a direct, append-based encoder that is byte-identical to the previous `marshalNodeJSONString` output, pinned by a differential test over every single byte, controls, U+2028/29, astral runes and invalid UTF-8 |
| `internal/startup/character_disk_cache.go` | the cache key mtime comes from the directory-listing entry (one metadata read instead of `Info`+`Stat`; zero extra syscalls on Windows) |
| `internal/startup/statistics.go`, `statistics_calculate.go` | one listing of the chats root replaces the per-character `os.Stat` existence probe; the symlink-resolution walk runs only for symlink entries; a non-directory entry keeps the pinned error and a listing failure is treated as an empty chats root exactly as the previous per-card `os.Stat` error did |

Compatibility: the response body is the pinned surface and is unchanged by construction (the cache only skips
I/O that produces the same text; the projection still runs per request; the escaper is differentially
pinned). The existing character differential fixtures (`sillytavern-1.19.0-characters-read.json`) and the full
`internal/server` suite were run against the change. The only new staleness is the documented cache window.

## 4. Measured effect (same host, same inputs, paired)

- 10,000-card `/api/characters/all`, hot cache: **5,734.9 → 2,295.9 ms/op (−60.0%)**, 1,038.7 → 619.9 MB/op
  (−40.3%), 7.80 → 3.19 M allocs/op (−59.0%). Every candidate observation below every baseline observation.
- 1,000 cards −33.7%, 100 cards −26.0% (no scale regresses).
- Cold-cache allocation −56.4%; cold-cache TIME is not claimed (arm noise).
- 10,000-card boot: cold 30,757 → 3,661 ms and warm 633 → 165 ms on the same generation protocol; attributed
  to per-card file access removal, with the host-scanner caveat in `perf/README.md` §3.

## 5. Cost, rollback, residual risk

- Cost: no new persistent state and no extra memory (the cache value grows by one float64 per entry; the
  direct escaper is smaller than the encoder path). The listing-identity path requires the listing entry,
  so it is used only by `/api/characters/all`; every other character route keeps the stat path unchanged.
- Rollback: one commit; no data format or migration is involved.
- Residual: (a) identity is still type+size+mtime, so an attribute-only change does not refresh `date_added`
  until one of those moves (recorded in the cache contract); (b) a symlinked card is deliberately NOT cached
  through the listing identity, so it pays the stat path (correctness over speed); (c) cold-cache request
  TIME is not provably improved on a shared host, only its allocations; (d) the measured boot numbers are
  local Layer A, not Linux CI.
- Gate: the new `BenchmarkCharactersAllCold` plus the existing four `BenchmarkCharactersAllScale` arms are in
  the committed benchmark set (`tests/perf/bench-baseline.txt`), so a regression is caught by the
  `bench-profiles` comparison gate; the differential/read fixtures catch any response-byte change.
