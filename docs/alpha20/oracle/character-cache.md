# Probe (d): the pinned `_cache/characters` character disk cache

**Status: CONFIRMED on pinned (one surprising pinned quirk included).** Evidence:
[`character-cache/evidence.json`](character-cache/evidence.json) — the record shape, the key/filename
derivation, every observation row and the verdict list are there; this document is the readable contract.

```
cd C:\Users\koishi\Desktop\GoTavern\a20-B
node tests/browser/a20-probe-character-cache.mjs
```

The probe boots the READ-ONLY pinned SillyTavern `1.19.0` at
`06bde939fb1e9c4c8d8641d810f0a916b5bce127` over a scratch data root (copied from the recorded pinned
fresh-install template), drives the real `/api/characters/*` routes with the frontend's CSRF token, and
observes `<DATA_ROOT>/_cache/characters` by byte census and by parsing what the product wrote. Corruption
and modification rows are explicit FILESYSTEM SETUPS by the probe (marked in the row), modelling an external
editor / truncated write / damaged cache — not product actions.

## The contract, measured (not inferred)

| property | measured from a real record |
|---|---|
| store | node-persist `LocalStorage` at `<DATA_ROOT>/_cache/characters`, `ttl:false, forgiveParseErrors:true, expiredInterval:0, maxFileDescriptors:100` (`src/endpoints/characters.js:100-115`) |
| key | `` `${absoluteCardPath}-${fs.statSync(path).mtimeMs}` `` (`characters.js:166-173`); the mtime is a FRACTIONAL JS number, e.g. `…/A20 Cache One.png-1794274489142.472` |
| filename | `sha256(store-key)` lowercase hex (`node_modules/node-persist/src/local-storage.js:52`) — verified on a live record: `filenameMatchesSha256OfKey:true` |
| value | the character-card JSON **text**; verified `valueMatchesResponseJsonData:true` against the `/api/characters/get` response's `json_data` (a record carried a 692-byte value; its file was 969 bytes of node-persist envelope) |
| layers | in-memory `MemoryLimitedMap` (100 MB default) first, disk store second, PNG parse last (`characters.js:181-209`) |
| create | `POST /api/characters/create` writes the card and does **not** populate the cache (no read) |
| repeat read | a second read in the same process does not rewrite the record (memory hit, no churn) |
| external modification | mtime is part of the key, so touching the PNG produces a cache MISS and a SECOND record; the old record is not removed at read time |
| disk read | proven after restart by rewriting a record's value to a marker card: the next process serves the marker, so the disk cache is consulted before the PNG |
| memory precedence | restoring the record on disk while the process lives does not evict the memory entry — the marker is still served until a restart (the cache contract, not a defect) |
| corrupt record | unparseable JSON is forgiven (`forgiveParseErrors`) → the card is served from the PNG; the read then rewrites a good record (repair on read, not at startup) |
| broken cache path | replacing `_cache/characters` with a regular file does not break character reads: the failure is caught and logged (`characters.js:193-195,204-206`) |
| `performance.useDiskCache:false` | after restart the cache directory is not created and reads write no record; reads still work |
| concurrent reads | 8 simultaneous `/api/characters/get` → 8 × 200, one name, no torn/duplicate write |
| Node → Go → Node | the pinned cache written before a GoTavern boot over the same data root is not corrupted by that boot, and a pinned boot afterwards still serves the card (the Go pruning semantics are owned by `internal/startup/character_disk_cache_test.go`) |

## The surprising finding: the startup verify does NOT prune ordinary stale records

Row `C12-restart-verify-quirk` (the probe originally expected pruning; the run disproved it):

`src/server-main.js:304` calls `diskCache.verify(directories)`. `DiskCache.verify` computes the valid hashed
filenames, then calls `cache.removeItem(key)` **with the hashed filename as the node-persist key**
(`characters.js:142-145`). node-persist hashes that key AGAIN (`getDatumPath → sha256(key)`), so the removal
targets `sha256(hashedFilename)`, which normally does not exist. Consequences, all observed in the real run:

- a deleted card's records are **still on disk after a restart** (`deletedRecordGone:false`);
- records for an external modification's old mtime **survive** the startup verify;
- only a record whose store key literally equals its own hashed filename (a misaddressed “shadow” record) is
  removed — which is exactly what the committed pinned fixture
  `tests/oracle/sillytavern-1.19.0-character-disk-cache.json` records (`jpg`/`stale` retained, `shadow`
  removed), and what `internal/startup/character_disk_cache.go` deliberately reproduces.

This is an inherited pinned behaviour, not a GoTavern invention and not a license to "fix" it: a drop-in
replacement must keep it (the Go side already does, with a test).

## What this probe does NOT claim

- It does not claim the 5-minute in-process verify interval behaves differently: only the STARTUP verify was
  reached here. The interval is source-only in this probe.
- It does not claim memory-cache eviction under the 100 MB capacity was exercised (it was not).
- It does not compare Go and pinned byte-for-byte on the cache: it proves the pinned contract and that a Go
  boot leaves the pinned records intact; the Go-vs-pinned verify comparison is a Go fixture test.
- The mtime-derived key means a copy of a data root that changes mtimes changes the cache keys. The probe
  copies with `fs.cp` and records the resulting keys in the evidence, so this is visible rather than
  assumed.
