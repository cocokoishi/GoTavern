package server

// IDENTITY-KEYED CACHES FOR THE SETTINGS AGGREGATION AND THE WORLD-INFO LISTING (GOAL 15.3; M5b).
//
// WHY THIS EXISTS. M2b measured `/api/settings/get` at 5.9 ms / 4.6 MB of allocation for 220 preset,
// theme and quick-reply documents and 30 ms / 23.6 MB for 1100 of them, and `/api/worldinfo/list` at
// 22-64 ms / 27-50 MB for 50-1000 world files (CI run 41758175427). Both routes re-read and re-parse
// every document on every call, and `/api/settings/get` is on the page-load path. The data is almost
// always unchanged between calls, so this memoises the response body and validates it against the SAME
// identity rule the stored-account cache uses (accounts.go:239-302): path + mtime + size, no TTL.
//
// §15.3 FIELDS, in the order the contract asks for them.
//
//   - key: the DATA-ROOT-AND-HANDLE pair (`<dataRoot>\x00<handle>`) plus the route name, because a
//     request is answered for exactly one user tree. The directory/file identities that decide hit vs
//     miss are hashed separately into `identity`, so the map key stays small and a per-user entry cannot
//     be confused with another user's even if two trees were hard-linked.
//   - value: the fully serialized HTTP response body (JSON), never a parsed structure. It is produced by
//     the same marshal function the uncached route used (`marshalNodeJSON` for settings/get,
//     `marshalOrderedNodeJSON` for worldinfo/list) and written by `respondJSONBytes`, whose header set is
//     byte-for-byte the one `respondJSON`/`respondOrderedNodeJSON` set. Storing the body rather than the
//     parsed value means a hit performs no unmarshal, no re-marshal, and cannot drift in key order,
//     escaping, number formatting or `json.RawMessage` compaction.
//   - owner: this package, process-local. No file, no shared memory, no cross-process state, no second
//     database: the entries are re-derivable from the user tree at any moment, and a restart starts empty.
//   - lifetime: until the inputs' identity changes (next request with a different identity) or the cache
//     is evicted. There is deliberately NO timeout: a TTL answers "did this change?" with "not recently
//     enough", which is the stale-read defect a cache must not introduce (the account cache says the same
//     thing in accounts.go:258-259).
//   - capacity: at most `userMetadataCacheEntryLimit` entries and `userMetadataCacheBytesLimit` bytes of
//     bodies, whichever is reached first. Two entries per user (settings aggregation, world listing), so
//     the entry cap bounds user trees; the byte cap bounds a tree with very large preset documents.
//   - eviction: the account cache's rule -- when a store would exceed either bound, the WHOLE map is
//     dropped and the new entry inserted. Dropping everything is correct because every entry is
//     re-derivable from its files; it costs one round of reads for the affected routes.
//   - invalidation condition: the identity digest changes. That covers (a) this server's own writes,
//     because every user-content write replaces the file through `atomicReplace` (temp file + rename), so
//     the file's mtime changes and the rename changes its size in the usual case; and (b) external
//     modification, because a writer that is not this server also changes mtime and/or size. No explicit
//     invalidation hook is needed, but a write through the product routes is covered by a test
//     (settings_cache_test.go) because that is the failure mode a cache must not introduce.
//   - external-modification handling: the identity is recomputed on EVERY request and must compare equal
//     to the stored digest before a hit is served. The digest is taken BEFORE the response is rebuilt and
//     recomputed AFTER the build; the entry is only stored when both digests agree, so a write that
//     lands during a rebuild can never be cached under a newer identity (that would serve the old body
//     under the new state). A miss is therefore always safe: it either stores a coherent body or does not
//     store at all.
//   - concurrency model: one package mutex guards the map; values are immutable byte slices once stored.
//     `loadUserMetadataCache` returns a COPY of the body so a caller cannot mutate cached state; the
//     handler only writes that copy to the response. No lock is held while files are read or a response
//     is serialized.
//   - rebuild path: a miss executes the original, uncached code path (same reads, same error handling,
//     same 500 for a missing directory) and then stores the body if the identity was stable.
//   - failure fallback: if hashing or serialization fails there is simply no store; the response is the
//     same one the uncached route produced. A body larger than the whole byte budget is never cached.
//   - measured benefit: see the M5b report; on the CI-shape workload the settings aggregation drops from
//     ~5.9 ms/4.6 MB (220 docs) and ~30 ms/23.6 MB (1100 docs) to a stat-and-hash walk plus a body copy,
//     and the world listing from ~22-64 ms/27-50 MB to the same walk. Memory cost is the retained body
//     bytes, bounded by `userMetadataCacheBytesLimit`.
//
// RESIDUAL STALENESS WINDOW, stated rather than hidden: the identity is mtime+size, so an EXTERNAL
// in-place rewrite that produces the SAME size and restores the SAME mtime is indistinguishable from no
// change and the cached body is served until a later change moves one of the two fields. This is the
// account cache's residual window too, and it requires a writer that both preserves size and backdates
// mtime. A same-size write with a normal (new) mtime is detected. `TestMetadataCacheSameIdentityWindowIsTheDocumentedResidual`
// pins this behaviour so no later reader mistakes it for a claim of perfect freshness.

import (
	"crypto/sha256"
	"encoding/binary"
	"hash"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// The bounds are variables rather than constants so the bound tests can exercise eviction on a small
// budget without allocating the production limit; production code never changes them.
var (
	userMetadataCacheEntryLimit = 64
	userMetadataCacheBytesLimit = 64 << 20
)

type userMetadataCacheEntry struct {
	identity [sha256.Size]byte
	body     []byte
}

var (
	userMetadataCacheMu        sync.Mutex
	userMetadataCache          = make(map[string]userMetadataCacheEntry)
	userMetadataCacheBodyBytes int
)

// userMetadataCacheKey builds the per-user key. The route kind keeps the two caches from sharing an
// entry; the data root and handle make another user's tree a different key even before the digest runs.
func userMetadataCacheKey(kind, dataRoot, handle string) string {
	return kind + "\x00" + dataRoot + "\x00" + handle
}

// loadUserMetadataCache returns a private copy of the cached body when the stored identity equals the
// identity computed for this request. The copy is what keeps a caller from mutating cached state.
func loadUserMetadataCache(key string, identity [sha256.Size]byte) ([]byte, bool) {
	userMetadataCacheMu.Lock()
	entry, exists := userMetadataCache[key]
	userMetadataCacheMu.Unlock()
	if !exists || entry.identity != identity {
		return nil, false
	}
	return append([]byte(nil), entry.body...), true
}

// storeUserMetadataCache inserts one body, evicting the whole map when either bound would be exceeded.
// The body slice is retained as given and is treated as immutable from here on (the handler writes it
// once and drops it); load returns copies, so no caller can mutate it afterwards.
func storeUserMetadataCache(key string, identity [sha256.Size]byte, body []byte) {
	if len(body) > userMetadataCacheBytesLimit {
		return
	}
	userMetadataCacheMu.Lock()
	defer userMetadataCacheMu.Unlock()
	if len(userMetadataCache) >= userMetadataCacheEntryLimit || userMetadataCacheBodyBytes+len(body) > userMetadataCacheBytesLimit {
		userMetadataCache = make(map[string]userMetadataCacheEntry)
		userMetadataCacheBodyBytes = 0
	}
	if existing, exists := userMetadataCache[key]; exists {
		userMetadataCacheBodyBytes -= len(existing.body)
	}
	userMetadataCache[key] = userMetadataCacheEntry{identity: identity, body: body}
	userMetadataCacheBodyBytes += len(body)
}

// metadataCacheMemoryCost reports the retained body bytes and entry count for the report and tests; it is
// not used by the routes.
func metadataCacheMemoryCost() (entries int, bodyBytes int) {
	userMetadataCacheMu.Lock()
	defer userMetadataCacheMu.Unlock()
	return len(userMetadataCache), userMetadataCacheBodyBytes
}

// resetUserMetadataCache is the test hook that starts a case from an empty cache.
func resetUserMetadataCache() {
	userMetadataCacheMu.Lock()
	defer userMetadataCacheMu.Unlock()
	userMetadataCache = make(map[string]userMetadataCacheEntry)
	userMetadataCacheBodyBytes = 0
}

// hashText feeds a length-prefixed string to a digest, so "ab"+"c" and "a"+"bc" cannot collide.
func hashText(digest hash.Hash, text string) {
	var length [4]byte
	binary.LittleEndian.PutUint32(length[:], uint32(len(text)))
	_, _ = digest.Write(length[:])
	_, _ = digest.Write([]byte(text))
}

// hashInt64 feeds one integer to a digest.
func hashInt64(digest hash.Hash, value int64) {
	var encoded [8]byte
	binary.LittleEndian.PutUint64(encoded[:], uint64(value))
	_, _ = digest.Write(encoded[:])
}

// hashFileInfo hashes the identity fields of one resolved file: type, size and mtime.
func hashFileInfo(digest hash.Hash, info os.FileInfo) {
	hashInt64(digest, int64(info.Mode().Type()))
	hashInt64(digest, info.Size())
	hashInt64(digest, info.ModTime().UnixNano())
}

// hashFileIdentity hashes one file's resolved identity: the path plus its type, size and mtime. It
// follows symlinks on purpose, because os.ReadFile (the uncached read) follows them too. A missing or
// unstatable file is hashed as a marker instead of failing the digest: the rebuild path then reproduces
// the original route's error handling (a missing settings.json is still a 500 from the read, not from
// the cache).
func hashFileIdentity(digest hash.Hash, path string) {
	info, err := os.Stat(path)
	if err != nil {
		hashText(digest, "stat-error")
		return
	}
	hashText(digest, path)
	hashFileInfo(digest, info)
}

// hashDirectoryEntryIdentity hashes one directory entry WITHOUT paying for an extra stat where the
// platform already returned the fields. For a regular entry, DirEntry.Info is the directory listing's own
// FileInfo (on Windows ReadDir already carries size and mtime from the find data; on Unix it is one lstat,
// which is what os.Stat would do anyway). A symlink is followed explicitly with os.Stat, because the
// uncached readers follow it; using the link's own lstat would miss a retarget or a target rewrite.
func hashDirectoryEntryIdentity(digest hash.Hash, entry fs.DirEntry, path string) {
	hashText(digest, path)
	if entry.Type()&os.ModeSymlink != 0 {
		info, err := os.Stat(path)
		if err != nil {
			hashText(digest, "stat-error")
			return
		}
		hashFileInfo(digest, info)
		return
	}
	info, err := entry.Info()
	if err != nil {
		hashText(digest, "info-error")
		return
	}
	hashFileInfo(digest, info)
}

// digestSettingsAggregation hashes everything `/api/settings/get` derives its body from: settings.json,
// the four preset directories, the worlds directory's NAMES (the route only lists them), and the seven
// content directories. Directory errors are hashed as a marker, not returned: the rebuild path keeps the
// route's own 500 for a missing directory, and a directory that comes back changes the digest again.
//
// The filters mirror the readers exactly. readSettingsFiles/readAndParseSettingsDirectory select entries
// whose filepath.Ext is ".json" (case-sensitive) and read them by name, so those entries' resolved
// identities are hashed. readWorldNames selects case-insensitive ".json" names and never reads content,
// so only the names are hashed there -- a world file's body edit does not change the settings body's
// world-name list and must not cause a needless rebuild.
func digestSettingsAggregation(directories startup.UserDirectories) [sha256.Size]byte {
	digest := sha256.New()
	hashText(digest, "settings-aggregation-v1")
	hashFileIdentity(digest, filepath.Join(directories["root"], "settings.json"))
	for _, key := range []string{"koboldAI_Settings", "novelAI_Settings", "openAI_Settings", "textGen_Settings"} {
		hashSettingsJSONDirectory(digest, key, directories[key])
	}
	hashWorldNameDirectory(digest, "worlds", directories["worlds"])
	for _, key := range []string{"themes", "movingUI", "quickreplies", "instruct", "context", "sysprompt", "reasoning"} {
		hashSettingsJSONDirectory(digest, key, directories[key])
	}
	var identity [sha256.Size]byte
	copy(identity[:], digest.Sum(nil))
	return identity
}

// hashSettingsJSONDirectory hashes the entries the two settings readers would open: names are counted in
// ReadDir order (which is sorted), and each selected file contributes its resolved identity.
func hashSettingsJSONDirectory(digest hash.Hash, key, directory string) {
	hashText(digest, key)
	entries, err := os.ReadDir(directory)
	if err != nil {
		hashText(digest, "readdir-error")
		return
	}
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		hashText(digest, entry.Name())
		hashDirectoryEntryIdentity(digest, entry, filepath.Join(directory, entry.Name()))
	}
}

// hashWorldNameDirectory hashes only the NAMES readWorldNames returns, because that is all it reads.
func hashWorldNameDirectory(digest hash.Hash, key, directory string) {
	hashText(digest, key)
	entries, err := os.ReadDir(directory)
	if err != nil {
		hashText(digest, "readdir-error")
		return
	}
	for _, entry := range entries {
		if strings.EqualFold(filepath.Ext(entry.Name()), ".json") {
			hashText(digest, entry.Name())
		}
	}
}

// digestWorldInfoList hashes everything `/api/worldinfo/list` derives its body from: the names of the
// regular `.json` entries (the pinned filter follows Dirent.isFile() and a case-insensitive extension)
// and each one's identity, because the listing parses each file for its `name` and `extensions`. As in
// the settings digest, a directory error is a marker and the rebuild path keeps the route's own 500.
func digestWorldInfoList(worldsDirectory string) [sha256.Size]byte {
	digest := sha256.New()
	hashText(digest, "world-info-list-v1")
	hashText(digest, worldsDirectory)
	entries, err := os.ReadDir(worldsDirectory)
	if err != nil {
		hashText(digest, "readdir-error")
	} else {
		for _, entry := range entries {
			if !strings.EqualFold(nodePathExt(entry.Name()), ".json") {
				continue
			}
			hashText(digest, entry.Name())
			if !entry.Type().IsRegular() {
				// The pinned filter excludes a non-regular entry before any read; its name still
				// occupies a position in the sorted list, so the name above is enough.
				hashText(digest, "not-regular")
				continue
			}
			hashDirectoryEntryIdentity(digest, entry, filepath.Join(worldsDirectory, entry.Name()))
		}
	}
	var identity [sha256.Size]byte
	copy(identity[:], digest.Sum(nil))
	return identity
}
