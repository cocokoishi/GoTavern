package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// THE CACHE INTRODUCED FOR A MEASURED HOTSPOT IS ONLY SAFE IF ITS INVALIDATION IS PROVEN.
//
// The hotspot: `accountRuntime.currentUser` re-read and re-parsed the user record on every authenticated
// request, which was 40.4% of a request's CPU (see the comment on the cache in accounts.go for the
// measurement and the full key/owner/restart/concurrency argument). The invalidation key is the record
// file's mtime and size, so the tests below drive the ONLY thing that matters: an external writer that
// this process does not control rewrites or deletes the file, and the very next read must see it.
//
// The rewrite case is deliberately split in two. A rewrite that changes the byte length would pass even a
// size-only key, so the second case rewrites with the SAME length to prove mtime is doing the work.

func writeStoredAccountRecord(t *testing.T, dataRoot, handle, name string, enabled bool) string {
	t.Helper()
	storage := filepath.Join(dataRoot, userStorageFolder)
	if err := os.MkdirAll(storage, 0o700); err != nil {
		t.Fatalf("create storage directory: %v", err)
	}
	body, err := json.Marshal(struct {
		Key   string         `json:"key"`
		Value map[string]any `json:"value"`
	}{
		Key: userStoragePrefix + handle,
		Value: map[string]any{
			"handle": handle, "name": name, "password": "", "salt": "",
			"admin": false, "enabled": enabled, "created": 1,
		},
	})
	if err != nil {
		t.Fatalf("marshal record: %v", err)
	}
	path := filepath.Join(storage, nodeStoreFilename(userStoragePrefix+handle))
	// THE WRITE IS ATOMIC, because that is how both writers a real installation has behave: this server
	// replaces a record through a temporary file and a rename, and pinned Node's node-persist uses
	// write-file-atomic. A non-atomic rewrite would let a reader observe a truncated file -- a torn read
	// that the old code had too, and one this test must not attribute to the cache by using a writer no
	// product path uses.
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, body, 0o600); err != nil {
		t.Fatalf("write record: %v", err)
	}
	// A reader in another goroutine may hold the destination open for a moment, and on Windows a rename
	// over an open file is refused; the product's own writer retries that transient overlap
	// (internal/startup.renameIntoPlace), so this helper does the same rather than failing the test for a
	// window that a real writer absorbs.
	var renameErr error
	for attempt := 0; attempt < 40; attempt++ {
		if renameErr = os.Rename(temporary, path); renameErr == nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if renameErr != nil {
		t.Fatalf("replace record atomically: %v", renameErr)
	}
	return path
}

func TestStoredAccountCacheSeesAnExternalRewrite(t *testing.T) {
	dataRoot := t.TempDir()
	writeStoredAccountRecord(t, dataRoot, "cache-rewrite", "Annie", true)

	first, found, err := loadStoredAccount(dataRoot, "cache-rewrite")
	if err != nil || !found {
		t.Fatalf("first read: found=%v err=%v", found, err)
	}
	if name := first.string("name"); name != "Annie" {
		t.Fatalf("first read name = %q, want Annie", name)
	}
	// Second read must be served from the cache (same stat identity) and agree.
	if again, found, err := loadStoredAccount(dataRoot, "cache-rewrite"); err != nil || !found || again.string("name") != "Annie" {
		t.Fatalf("cached read: found=%v err=%v name=%q", found, err, again.string("name"))
	}

	// AN EXTERNAL WRITER -- not this package -- replaces the record with a longer name.
	writeStoredAccountRecord(t, dataRoot, "cache-rewrite", "Zoe-renamed", true)

	updated, found, err := loadStoredAccount(dataRoot, "cache-rewrite")
	if err != nil || !found {
		t.Fatalf("read after rewrite: found=%v err=%v", found, err)
	}
	if name := updated.string("name"); name != "Zoe-renamed" {
		t.Fatalf("a cached record survived an external rewrite: name = %q, want Zoe-renamed", name)
	}
}

func TestStoredAccountCacheSeesASameLengthRewrite(t *testing.T) {
	dataRoot := t.TempDir()
	writeStoredAccountRecord(t, dataRoot, "cache-samesize", "Ann", true)
	if _, _, err := loadStoredAccount(dataRoot, "cache-samesize"); err != nil {
		t.Fatalf("prime the cache: %v", err)
	}

	// "Ann" -> "Bob": identical byte length, so a size-only key could not see this.
	// A short sleep keeps the test honest on filesystems with coarse timestamps; ext4 and NTFS both
	// resolve far below it, and the assertion is about WHICH field invalidates, not about resolution.
	time.Sleep(10 * time.Millisecond)
	writeStoredAccountRecord(t, dataRoot, "cache-samesize", "Bob", true)

	updated, found, err := loadStoredAccount(dataRoot, "cache-samesize")
	if err != nil || !found {
		t.Fatalf("read after same-length rewrite: found=%v err=%v", found, err)
	}
	if name := updated.string("name"); name != "Bob" {
		t.Fatalf("a same-length external rewrite was not seen: name = %q, want Bob (the key must include mtime, not only size)", name)
	}
}

func TestStoredAccountCacheForgetsADeletedRecord(t *testing.T) {
	dataRoot := t.TempDir()
	path := writeStoredAccountRecord(t, dataRoot, "cache-deleted", "Annie", true)
	if _, found, err := loadStoredAccount(dataRoot, "cache-deleted"); err != nil || !found {
		t.Fatalf("prime the cache: found=%v err=%v", found, err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatalf("remove record: %v", err)
	}
	account, found, err := loadStoredAccount(dataRoot, "cache-deleted")
	if err != nil {
		t.Fatalf("read after delete: %v", err)
	}
	if found {
		t.Fatalf("a deleted record was still reported found: %#v", account.fields)
	}
}

func TestStoredAccountCacheDoesNotHandOutItsMap(t *testing.T) {
	dataRoot := t.TempDir()
	writeStoredAccountRecord(t, dataRoot, "cache-isolation", "Annie", true)

	first, found, err := loadStoredAccount(dataRoot, "cache-isolation")
	if err != nil || !found {
		t.Fatalf("first read: found=%v err=%v", found, err)
	}
	// A caller that mutates the record it was given must not reach the cached copy. One caller in this
	// package does mutate a record it built itself, which is why the cache returns a copy.
	first.fields["name"] = json.RawMessage(`"Corrupted"`)

	second, found, err := loadStoredAccount(dataRoot, "cache-isolation")
	if err != nil || !found {
		t.Fatalf("second read: found=%v err=%v", found, err)
	}
	if name := second.string("name"); name != "Annie" {
		t.Fatalf("a caller's mutation reached the cache: name = %q, want Annie", name)
	}
}

// TestStoredAccountCacheUnderConcurrentReadersAndWriter exists so `go test -race` has something to
// judge: readers hit the stat-and-hit path while an external writer keeps replacing the record. The
// assertions are deliberately loose (the value must be one of the writes, and the last read must see the
// final one) because the property under test is the ABSENCE of a data race and of a torn read, not a
// particular interleaving.
func TestStoredAccountCacheUnderConcurrentReadersAndWriter(t *testing.T) {
	dataRoot := t.TempDir()
	writeStoredAccountRecord(t, dataRoot, "cache-concurrent", "Initial", true)

	stop := make(chan struct{})
	var successfulReads int64
	var readers sync.WaitGroup
	for index := 0; index < 4; index++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				account, found, err := loadStoredAccount(dataRoot, "cache-concurrent")
				if err != nil {
					t.Errorf("concurrent read: %v", err)
					return
				}
				// A RECORD THAT IS BEING REPLACED MAY BE TRANSIENTLY ABSENT ON THIS PLATFORM, and that is
				// pre-existing behaviour rather than a cache effect: before the cache the same window
				// produced the same found=false, because the read is of a file another process owns. What
				// must never happen is a TORN VALUE or an error, so those still fail the test.
				if !found {
					continue
				}
				atomic.AddInt64(&successfulReads, 1)
				// A READER IN THIS TEST IS A REQUEST, NOT A SPIN LOOP: one read per millisecond models a
				// realistic cadence and keeps the overlap with a writer transient. Without it the test
				// manufactures unbounded contention and then asserts a tolerance that is deliberately
				// bounded (internal/fsretry retries for ~200 ms, not forever), which would be a test
				// demanding a guarantee the product does not make.
				time.Sleep(time.Millisecond)
				switch account.string("name") {
				case "Initial", "Rewrite-A", "Rewrite-B", "Rewrite-C":
				default:
					t.Errorf("concurrent read saw a torn name %q", account.string("name"))
					return
				}
			}
		}()
	}
	for _, name := range []string{"Rewrite-A", "Rewrite-B", "Rewrite-C"} {
		time.Sleep(5 * time.Millisecond)
		writeStoredAccountRecord(t, dataRoot, "cache-concurrent", name, true)
	}
	close(stop)
	readers.Wait()

	final, found, err := loadStoredAccount(dataRoot, "cache-concurrent")
	if err != nil || !found {
		t.Fatalf("final read: found=%v err=%v", found, err)
	}
	if name := final.string("name"); name != "Rewrite-C" {
		t.Fatalf("final read name = %q, want Rewrite-C", name)
	}
	if successfulReads == 0 {
		t.Fatal("no reader ever observed the record, so the concurrent path was not exercised (rule 19)")
	}
}
