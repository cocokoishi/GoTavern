package server

// IDENTITY-KEYED CARD-TEXT CACHE (GOAL §15.3; alpha.15 lane F).
//
// WHY THIS EXISTS. `/api/characters/all` reads and decodes every character card's PNG on every request:
// processCharacter (characters_card.go) calls readCharacterDataStrict, which does os.ReadFile plus the PNG
// chunk walk plus base64 decode of the `chara`/`ccv3` tEXt document, once per card. The measured cost at
// 10,000 cards is 1,438 ms/op, 1,200 MB allocated and 7.84 M allocations for one request
// (tests/perf/bench-baseline.txt, `BenchmarkCharactersAllScale/cards_10000_4KB_image`), and in the focused
// CPU profile of this lane the decode step alone was 16.5 s of the route's 57.8 s (29 %) and 664 MB of its
// 1,903 MB (35 %). The card bytes on disk are almost always unchanged between calls, so this memoises the
// DECODED CARD TEXT and validates it against the SAME identity rule the stored-account and settings caches
// use (accounts.go / settings_cache.go): path + type + size + mtime, no TTL.
//
// WHAT IS **NOT** CACHED, deliberately: the projection. `processCharacter` still runs getCharaCardV2 /
// readFromV2 on every request, because that projection contains a time-dependent value — the default
// `chat` name is `${name} - ${humanizedDateTime(time.Now())}` (characters_format.go readFromV2) — and the
// ordered-JSON marshal still runs per request. This cache therefore cannot change one response byte, by
// construction: it only skips the disk read and the chunk/base64 decode that produce the same string.
//
// §15.3 FIELDS, in the order the contract asks for them.
//
//   - key: the card file's resolved absolute path (`filepath.Abs` + Clean), because that is the identity a
//     caller can hold; the map is keyed by it so a same-path replacement cannot leave two entries behind.
//   - value: the decoded card JSON text (the string readPngCardText returns), stored as an immutable string,
//     plus the card file's ctime in milliseconds (Node's fs.Stats.ctimeMs), which /api/characters/all reports
//     as `date_added`. The ctime is cached because on Windows reading it needs a file HANDLE, so the listing
//     path (readCharacterDataStrictWithIdentity) fetches it from the handle it already opened for the read;
//     a hit then costs no filesystem operation for that card at all. The ctime is NOT part of the identity
//     tuple, so this inherits the same residual window: an attribute-only change that leaves type, size and
//     mtime alone (e.g. a chmod) does not refresh `date_added` until one of those three moves. Content
//     changes always move mtime, and card writes here replace the file through the atomic writer.
//   - owner: this package, process-local, per data root implicitly (the absolute path is inside it). No
//     file, no shared memory, no cross-process state, no second database: every entry is re-derivable from
//     the card PNG at any moment and a restart starts empty.
//   - lifetime: until the file's identity changes (the next request recomputes it) or the entry is evicted.
//     There is deliberately NO timeout: a TTL answers "did this change?" with "not recently enough", which
//     is the stale-read defect a cache must not introduce (the account and settings caches say the same).
//   - capacity: `characterCardCacheEntryLimit` entries AND `characterCardCacheBytesLimit` bytes of card
//     text, whichever is reached first. The byte bound is the memory bound: the retained text bytes are the
//     only large field, so the worst-case extra memory is the byte limit plus the keys/entry overhead. At
//     the 10,000-card / 4 KB-card scale that is 40 MB of text, ~2 MB of keys and ~1 MB of map/list
//     overhead — under the 64 MiB text bound, so no eviction happens on that workload.
//   - eviction: LEAST-RECENTLY-USED, one entry at a time, until both bounds hold. This DIFFERS from the
//     settings cache's "drop the whole map" rule on purpose, and the reason is the shape of the key space:
//     that cache holds at most two bodies per user tree, so dropping everything costs one rebuild, while
//     this one holds one entry per card — dropping 10,000 entries because the 10,001st did not fit would
//     make every request the first request and the cache would never pay for itself.
//   - invalidation condition: the identity tuple changes. That covers (a) this server's own writes,
//     because every card write replaces the file through atomicReplace (temp file + rename), which moves
//     mtime and usually size; and (b) external modification, because a writer that is not this server also
//     moves mtime and/or size. No explicit invalidation hook is needed, and the write routes are covered by
//     the invalidation test because that is the failure mode a cache must not introduce.
//   - external-modification handling: the identity is recomputed on EVERY request with os.Stat and must
//     equal the stored tuple before a hit is served. A mismatch is a miss: the file is re-read and the entry
//     replaced. A stat failure or a read/decode failure is NOT served from the cache — the uncached error is
//     returned (a deleted or unreadable card must surface as the same error the uncached code produced), and
//     no entry is stored. The read happens outside the cache mutex, so a write that lands mid-read can only
//     produce a miss or a correct entry, never a stale hit.
//   - concurrency model: one package mutex guards the map and the LRU list; nothing else is shared. The lock
//     is held only for map/list bookkeeping, never across os.ReadFile. Duplicate work is safe by design: two
//     concurrent misses for one card may both read and decode it, and both store equivalent text; there is no
//     single-flight requirement because the duplicate work is bounded by the request count and the result is
//     deterministic.
//   - rebuild path: a miss executes the original uncached code (os.ReadFile → readPngCardText) and stores
//     the text only when the stat taken BEFORE the read succeeds; the identity is not re-checked after the
//     read because text is read from the same file content the read opened — a concurrent replacement makes
//     this a possible extra miss on the next request, never a stale hit.
//   - failure fallback: a stat/read/decode error is returned to the caller unchanged and nothing is stored;
//     a text larger than the whole byte budget is never cached (it is still returned).
//   - measured benefit: see the alpha.15 lane F report; before/after on the same 10,000-card benchmark and on
//     the route's focused profile share are recorded there. The retained memory is bounded by the byte limit.
//
// RESIDUAL STALENESS WINDOW, stated rather than hidden: the identity is type+size+mtime, so an EXTERNAL
// in-place rewrite that produces the SAME size and restores the SAME mtime is indistinguishable from no
// change and the cached text is served until a later change moves one of the two fields. This is exactly the
// account cache's and the settings cache's residual window, and it requires a writer that both preserves size
// and backdates mtime. A same-size write with a normal (new) mtime is detected.
// `TestCharacterCardCacheSameIdentityWindowIsTheDocumentedResidual` pins this so no later reader mistakes it
// for a claim of perfect freshness.

import (
	"container/list"
	"os"
	"path/filepath"
	"sync"
)

// The bounds are variables rather than constants so the eviction tests can exercise eviction on a small
// budget without allocating the production limit; production code never changes them.
var (
	characterCardCacheEntryLimit = 65536
	characterCardCacheBytesLimit = 64 << 20
)

// characterCardIdentity is the validation tuple: the same three fields settings_cache.go's
// metadataDigest.fileInfo hashes (type, size, mtime). Symlinks are followed by os.Stat, because os.ReadFile
// follows them too.
type characterCardIdentity struct {
	modeType os.FileMode
	size     int64
	mtimeNs  int64
}

func identityForCharacterCardFile(info os.FileInfo) characterCardIdentity {
	return characterCardIdentity{modeType: info.Mode().Type(), size: info.Size(), mtimeNs: info.ModTime().UnixNano()}
}

type characterCardCacheEntry struct {
	key      string
	identity characterCardIdentity
	text     string
	ctimeMs  float64
	element  *list.Element
}

var (
	characterCardCacheMu        sync.Mutex
	characterCardCache          = make(map[string]*characterCardCacheEntry)
	characterCardCacheLRU       = list.New() // front = most recently used
	characterCardCacheTextBytes int
)

// characterCardCachePath resolves the key: the absolute, cleaned path, because two callers may reach the
// same card through differently shaped relative paths and must share one entry.
func characterCardCachePath(filePath string) (string, bool) {
	absolute, err := filepath.Abs(filePath)
	if err != nil {
		return "", false
	}
	return filepath.Clean(absolute), true
}

// loadCharacterCardTextCache returns the cached text (and the cached ctime) when the stored identity equals
// the identity of the stat the caller just performed. A miss returns ok=false and the caller does the
// uncached work.
//
// ONE CRITICAL SECTION, because the entry's fields are MUTABLE: `store` replaces `identity` and `text` on a
// re-read, so reading them after dropping the lock is a data race (found by the Linux `-race` job, which this
// host cannot run -- `-race` is unsupported on windows/arm64). The lock covers only the map, the LRU list and
// three field reads: the caller's file I/O happens outside it.
func loadCharacterCardTextCache(filePath string, identity characterCardIdentity) (string, float64, bool) {
	key, ok := characterCardCachePath(filePath)
	if !ok {
		return "", 0, false
	}
	characterCardCacheMu.Lock()
	defer characterCardCacheMu.Unlock()
	entry, exists := characterCardCache[key]
	if !exists || entry.identity != identity {
		return "", 0, false
	}
	// The entry is in the list while the lock is held, so the move cannot act on an evicted element.
	characterCardCacheLRU.MoveToFront(entry.element)
	return entry.text, entry.ctimeMs, true
}

// storeCharacterCardTextCache inserts or replaces one entry and evicts least-recently-used entries until
// both bounds hold. The text is treated as immutable from here on.
func storeCharacterCardTextCache(filePath string, identity characterCardIdentity, text string, ctimeMs float64) {
	key, ok := characterCardCachePath(filePath)
	if !ok {
		return
	}
	if len(text) > characterCardCacheBytesLimit {
		// A single card larger than the whole budget is never cached; it is still returned to the caller.
		characterCardCacheMu.Lock()
		removeCharacterCardEntryLocked(key)
		characterCardCacheMu.Unlock()
		return
	}
	characterCardCacheMu.Lock()
	defer characterCardCacheMu.Unlock()
	if existing, exists := characterCardCache[key]; exists {
		characterCardCacheTextBytes -= len(existing.text)
		existing.identity = identity
		existing.text = text
		existing.ctimeMs = ctimeMs
		characterCardCacheTextBytes += len(text)
		characterCardCacheLRU.MoveToFront(existing.element)
		evictCharacterCardEntriesLocked()
		return
	}
	entry := &characterCardCacheEntry{key: key, identity: identity, text: text, ctimeMs: ctimeMs}
	entry.element = characterCardCacheLRU.PushFront(entry)
	characterCardCache[key] = entry
	characterCardCacheTextBytes += len(text)
	evictCharacterCardEntriesLocked()
}

// evictCharacterCardEntriesLocked drops least-recently-used entries until both bounds hold. The caller holds
// the mutex.
func evictCharacterCardEntriesLocked() {
	for len(characterCardCache) > characterCardCacheEntryLimit || characterCardCacheTextBytes > characterCardCacheBytesLimit {
		oldest := characterCardCacheLRU.Back()
		if oldest == nil {
			return
		}
		entry := oldest.Value.(*characterCardCacheEntry)
		characterCardCacheLRU.Remove(oldest)
		delete(characterCardCache, entry.key)
		characterCardCacheTextBytes -= len(entry.text)
	}
}

// removeCharacterCardEntryLocked drops one path's entry. The caller holds the mutex.
func removeCharacterCardEntryLocked(key string) {
	entry, exists := characterCardCache[key]
	if !exists {
		return
	}
	characterCardCacheLRU.Remove(entry.element)
	delete(characterCardCache, key)
	characterCardCacheTextBytes -= len(entry.text)
}

// characterCardCacheMemoryCost reports the retained text bytes and entry count for tests and reports; it is
// not used by the routes.
func characterCardCacheMemoryCost() (entries int, textBytes int) {
	characterCardCacheMu.Lock()
	defer characterCardCacheMu.Unlock()
	return len(characterCardCache), characterCardCacheTextBytes
}

// resetCharacterCardCache is the test/benchmark hook that starts a case from an empty cache. It reuses the
// existing map and list storage (no allocation), so the cold-first-request benchmark can drop the cache
// between iterations without the reset itself polluting the allocation columns.
func resetCharacterCardCache() {
	characterCardCacheMu.Lock()
	defer characterCardCacheMu.Unlock()
	clear(characterCardCache)
	characterCardCacheLRU.Init()
	characterCardCacheTextBytes = 0
}
