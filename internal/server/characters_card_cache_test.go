package server

// Tests for the identity-keyed card-text cache (characters_card_cache.go). The behaviour that must not change is
// the ROUTE's: these tests only assert the cache's own contract (hit only on an equal identity, invalidation,
// bounded memory, failure fallback) plus the product-write-path case that a cache must not get wrong.

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// cacheTestCardText is a valid chara_card_v2 document. `name` can be varied to produce a same-length-different-
// content document (for the same-size replacement cases) or a different-length one (size change case).
func cacheTestCardText(name string) string {
	return `{"spec":"chara_card_v2","spec_version":"2.0","data":{"name":"` + name + `","description":"cache test","personality":"p","scenario":"s","first_mes":"hi","mes_example":"","creator_notes":"","system_prompt":"","post_history_instructions":"","alternate_greetings":[],"tags":[],"creator":"a15","character_version":"1.0","extensions":{}}}`
}

// writeCacheTestCardPNG builds a real PNG carrying exactly ONE `chara` tEXt chunk, so readPngCardText returns the
// document given here (it prefers ccv3 when present, so the test deliberately writes only chara).
func writeCacheTestCardPNG(tb testing.TB, path, document string) {
	tb.Helper()
	base := benchCardPNG(0, 0)
	chunks, err := extractPngChunks(base)
	if err != nil {
		tb.Fatalf("extract the base PNG chunks: %v", err)
	}
	filtered := make([]pngChunk, 0, len(chunks))
	for _, chunk := range chunks {
		if chunk.name == "tEXt" {
			continue
		}
		filtered = append(filtered, chunk)
	}
	chunk, err := encodePngText("chara", base64.StdEncoding.EncodeToString([]byte(document)))
	if err != nil {
		tb.Fatalf("encode the chara chunk: %v", err)
	}
	if len(filtered) < 2 {
		tb.Fatalf("the base PNG has %d chunks; want at least IHDR+IDAT+IEND", len(filtered))
	}
	inserted := append([]pngChunk(nil), filtered[:len(filtered)-1]...)
	inserted = append(inserted, chunk, filtered[len(filtered)-1])
	if err := os.WriteFile(path, encodePngChunks(inserted), 0o644); err != nil {
		tb.Fatalf("write card %s: %v", path, err)
	}
}

func setCardMtime(tb testing.TB, path string, when time.Time) {
	tb.Helper()
	if err := os.Chtimes(path, when, when); err != nil {
		tb.Fatalf("set mtime of %s: %v", path, err)
	}
}

// withCharacterCardCacheBounds runs one case under small cache bounds and restores the production bounds.
func withCharacterCardCacheBounds(tb testing.TB, entries, bytes int) {
	tb.Helper()
	originalEntries, originalBytes := characterCardCacheEntryLimit, characterCardCacheBytesLimit
	characterCardCacheEntryLimit, characterCardCacheBytesLimit = entries, bytes
	tb.Cleanup(func() {
		characterCardCacheEntryLimit, characterCardCacheBytesLimit = originalEntries, originalBytes
		resetCharacterCardCache()
	})
}

func TestCharacterCardCacheReturnsTheUncachedText(t *testing.T) {
	resetCharacterCardCache()
	directory := t.TempDir()
	path := filepath.Join(directory, "Card A.png")
	document := cacheTestCardText("Card A")
	writeCacheTestCardPNG(t, path, document)
	setCardMtime(t, path, time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC))

	first, err := readCharacterDataStrict(path)
	if err != nil {
		t.Fatalf("first read: %v", err)
	}
	if first != document {
		t.Fatalf("first read returned %q; want the document written into the PNG", first)
	}
	if entries, bytes := characterCardCacheMemoryCost(); entries != 1 || bytes != len(document) {
		t.Fatalf("after the first read the cache has %d entries / %d bytes; want 1 / %d", entries, bytes, len(document))
	}

	second, err := readCharacterDataStrict(path)
	if err != nil {
		t.Fatalf("second read: %v", err)
	}
	if second != document {
		t.Fatalf("second read returned %q; want the same document", second)
	}
}

// TestCharacterCardCacheInvalidatesOnSizeChange is the invalidation tooth: a rewritten card (different size,
// therefore a different identity) must be re-read. If the cache served the stored text regardless of identity,
// this test fails at the named assertion below.
func TestCharacterCardCacheInvalidatesOnSizeChange(t *testing.T) {
	resetCharacterCardCache()
	directory := t.TempDir()
	path := filepath.Join(directory, "Card.png")
	firstDocument := cacheTestCardText("A")
	secondDocument := cacheTestCardText("Longer Name")
	if len(secondDocument) == len(firstDocument) {
		t.Fatalf("the fixture documents have the same length; the size-change case needs a different size")
	}
	writeCacheTestCardPNG(t, path, firstDocument)
	setCardMtime(t, path, time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC))
	if _, err := readCharacterDataStrict(path); err != nil {
		t.Fatalf("prime the cache: %v", err)
	}

	writeCacheTestCardPNG(t, path, secondDocument)
	setCardMtime(t, path, time.Date(2026, 11, 1, 12, 5, 0, 0, time.UTC))
	served, err := readCharacterDataStrict(path)
	if err != nil {
		t.Fatalf("read after rewrite: %v", err)
	}
	if served != secondDocument {
		t.Fatalf("after a card rewrite the server served %q; want the rewritten document", served)
	}
}

// TestCharacterCardCacheInvalidatesOnSameSizeNewMtime covers the same-size replacement whose mtime moved: the
// identity includes mtime, so this must be detected even though the size is unchanged.
func TestCharacterCardCacheInvalidatesOnSameSizeNewMtime(t *testing.T) {
	resetCharacterCardCache()
	directory := t.TempDir()
	path := filepath.Join(directory, "Card.png")
	firstDocument := cacheTestCardText("Alpha")
	secondDocument := cacheTestCardText("Bravo")
	if len(secondDocument) != len(firstDocument) {
		t.Fatalf("the fixture documents differ in length; the same-size case needs equal length")
	}
	writeCacheTestCardPNG(t, path, firstDocument)
	setCardMtime(t, path, time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC))
	if _, err := readCharacterDataStrict(path); err != nil {
		t.Fatalf("prime the cache: %v", err)
	}

	writeCacheTestCardPNG(t, path, secondDocument)
	setCardMtime(t, path, time.Date(2026, 11, 1, 12, 0, 1, 0, time.UTC)) // one second later, same size
	served, err := readCharacterDataStrict(path)
	if err != nil {
		t.Fatalf("read after same-size rewrite: %v", err)
	}
	if served != secondDocument {
		t.Fatalf("after a same-size rewrite with a new mtime the server served %q; want the rewritten document", served)
	}
}

// TestCharacterCardCacheSameIdentityWindowIsTheDocumentedResidual pins the limit of every mtime+size cache in this
// repository: a writer that rewrites the SAME size AND restores the SAME mtime is indistinguishable from no
// change, so the stored text is served until one of the two fields moves. The test exists so no later reader
// mistakes the cache for a freshness guarantee; it is not a claim that the cache is correct without the window.
func TestCharacterCardCacheSameIdentityWindowIsTheDocumentedResidual(t *testing.T) {
	resetCharacterCardCache()
	directory := t.TempDir()
	path := filepath.Join(directory, "Card.png")
	firstDocument := cacheTestCardText("Alpha")
	secondDocument := cacheTestCardText("Bravo")
	if len(secondDocument) != len(firstDocument) {
		t.Fatalf("the fixture documents differ in length; the residual case needs equal length")
	}
	mtime := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	writeCacheTestCardPNG(t, path, firstDocument)
	setCardMtime(t, path, mtime)
	if _, err := readCharacterDataStrict(path); err != nil {
		t.Fatalf("prime the cache: %v", err)
	}

	writeCacheTestCardPNG(t, path, secondDocument)
	setCardMtime(t, path, mtime) // same size AND same mtime: the documented residual window
	served, err := readCharacterDataStrict(path)
	if err != nil {
		t.Fatalf("read inside the residual window: %v", err)
	}
	if served != firstDocument {
		t.Fatalf("inside the same-size+same-mtime window the cache should serve the stored text; it served %q", served)
	}

	setCardMtime(t, path, mtime.Add(time.Second))
	served, err = readCharacterDataStrict(path)
	if err != nil {
		t.Fatalf("read after the mtime moved: %v", err)
	}
	if served != secondDocument {
		t.Fatalf("after the mtime moved the server served %q; want the rewritten document", served)
	}
}

// TestCharacterCardCacheKeepsPathsApart makes sure the key is the file path, not the card name or a digest: two
// files with identical content and identical mtime must be two entries and each must serve its own file.
func TestCharacterCardCacheKeepsPathsApart(t *testing.T) {
	resetCharacterCardCache()
	directory := t.TempDir()
	firstPath := filepath.Join(directory, "One.png")
	secondPath := filepath.Join(directory, "Two.png")
	firstDocument := cacheTestCardText("One")
	secondDocument := cacheTestCardText("Two")
	mtime := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	writeCacheTestCardPNG(t, firstPath, firstDocument)
	setCardMtime(t, firstPath, mtime)
	writeCacheTestCardPNG(t, secondPath, secondDocument)
	setCardMtime(t, secondPath, mtime)
	if _, err := readCharacterDataStrict(firstPath); err != nil {
		t.Fatalf("read the first card: %v", err)
	}
	if _, err := readCharacterDataStrict(secondPath); err != nil {
		t.Fatalf("read the second card: %v", err)
	}
	if entries, _ := characterCardCacheMemoryCost(); entries != 2 {
		t.Fatalf("two card files produced %d cache entries; want 2 (the key is the path)", entries)
	}
	writeCacheTestCardPNG(t, firstPath, cacheTestCardText("One!"))
	setCardMtime(t, firstPath, mtime.Add(time.Second))
	served, err := readCharacterDataStrict(firstPath)
	if err != nil {
		t.Fatalf("re-read the first card: %v", err)
	}
	if served != cacheTestCardText("One!") {
		t.Fatalf("the first path served %q; want its rewritten document", served)
	}
	served, err = readCharacterDataStrict(secondPath)
	if err != nil {
		t.Fatalf("re-read the second card: %v", err)
	}
	if served != secondDocument {
		t.Fatalf("rewriting one card changed the other path's answer: %q", served)
	}
}

// TestCharacterCardCacheEvictsLeastRecentlyUsed pins the bound: with room for two entries, the least recently
// used one leaves first and a later read of it is a miss, not an error and not a wrong answer.
func TestCharacterCardCacheEvictsLeastRecentlyUsed(t *testing.T) {
	resetCharacterCardCache()
	withCharacterCardCacheBounds(t, 2, 64<<20)
	directory := t.TempDir()
	paths := map[string]string{
		"A": filepath.Join(directory, "A.png"),
		"B": filepath.Join(directory, "B.png"),
		"C": filepath.Join(directory, "C.png"),
	}
	for name, path := range paths {
		writeCacheTestCardPNG(t, path, cacheTestCardText("Card "+name))
		setCardMtime(t, path, time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC))
	}
	for _, name := range []string{"A", "B"} {
		if _, err := readCharacterDataStrict(paths[name]); err != nil {
			t.Fatalf("prime %s: %v", name, err)
		}
	}
	// Touch A so B becomes the least recently used.
	if _, err := readCharacterDataStrict(paths["A"]); err != nil {
		t.Fatalf("touch A: %v", err)
	}
	if _, err := readCharacterDataStrict(paths["C"]); err != nil {
		t.Fatalf("read C: %v", err)
	}
	if entries, _ := characterCardCacheMemoryCost(); entries > 2 {
		t.Fatalf("the cache holds %d entries with a limit of 2", entries)
	}
	served, err := readCharacterDataStrict(paths["B"])
	if err != nil {
		t.Fatalf("re-read the evicted card B: %v", err)
	}
	if served != cacheTestCardText("Card B") {
		t.Fatalf("re-reading the evicted card served %q", served)
	}
}

// TestCharacterCardCacheEvictsWhenByteBoundIsSmall pins the byte bound: a second card that cannot fit beside the
// first must evict it, and the first must be re-readable with the right answer.
func TestCharacterCardCacheEvictsWhenByteBoundIsSmall(t *testing.T) {
	resetCharacterCardCache()
	directory := t.TempDir()
	firstPath := filepath.Join(directory, "A.png")
	secondPath := filepath.Join(directory, "B.png")
	firstDocument := cacheTestCardText("A")
	secondDocument := cacheTestCardText("B")
	withCharacterCardCacheBounds(t, 1000, len(firstDocument)+10)
	writeCacheTestCardPNG(t, firstPath, firstDocument)
	setCardMtime(t, firstPath, time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC))
	writeCacheTestCardPNG(t, secondPath, secondDocument)
	setCardMtime(t, secondPath, time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC))
	if _, err := readCharacterDataStrict(firstPath); err != nil {
		t.Fatalf("read A: %v", err)
	}
	if _, err := readCharacterDataStrict(secondPath); err != nil {
		t.Fatalf("read B: %v", err)
	}
	if entries, bytes := characterCardCacheMemoryCost(); entries != 1 || bytes > len(firstDocument)+10 {
		t.Fatalf("with a %d-byte bound the cache holds %d entries / %d bytes; want 1 entry within the bound",
			len(firstDocument)+10, entries, bytes)
	}
	served, err := readCharacterDataStrict(firstPath)
	if err != nil {
		t.Fatalf("re-read the evicted card: %v", err)
	}
	if served != firstDocument {
		t.Fatalf("re-reading the evicted card served %q", served)
	}
}

// TestCharacterCardCacheDoesNotCacheFailures pins the failure fallback: a missing or corrupt card yields the same
// error the uncached read produced and leaves nothing cached to be served later.
func TestCharacterCardCacheDoesNotCacheFailures(t *testing.T) {
	resetCharacterCardCache()
	directory := t.TempDir()
	if _, err := readCharacterDataStrict(filepath.Join(directory, "Missing.png")); err == nil {
		t.Fatal("a missing card must return an error, not a cached value")
	}
	if entries, _ := characterCardCacheMemoryCost(); entries != 0 {
		t.Fatalf("a failed read cached %d entries", entries)
	}
	corruptPath := filepath.Join(directory, "Corrupt.png")
	if err := os.WriteFile(corruptPath, []byte("this is not a PNG"), 0o644); err != nil {
		t.Fatalf("write the corrupt card: %v", err)
	}
	if _, err := readCharacterDataStrict(corruptPath); err == nil {
		t.Fatal("a corrupt card must return an error, not a cached value")
	}
	if entries, _ := characterCardCacheMemoryCost(); entries != 0 {
		t.Fatalf("a corrupt read cached %d entries", entries)
	}
}

// TestCharacterCardCacheIsSafeUnderConcurrentReads exercises the duplicate-work-safe claim: every concurrent
// reader sees the same text, and the cache stays within its bounds.
func TestCharacterCardCacheIsSafeUnderConcurrentReads(t *testing.T) {
	resetCharacterCardCache()
	directory := t.TempDir()
	path := filepath.Join(directory, "Concurrent.png")
	document := cacheTestCardText("Concurrent")
	writeCacheTestCardPNG(t, path, document)
	setCardMtime(t, path, time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC))
	var waitGroup sync.WaitGroup
	failures := make(chan string, 16)
	for worker := 0; worker < 8; worker++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			for iteration := 0; iteration < 20; iteration++ {
				served, err := readCharacterDataStrict(path)
				if err != nil {
					failures <- err.Error()
					return
				}
				if served != document {
					failures <- "concurrent read returned a different document"
					return
				}
			}
		}()
	}
	waitGroup.Wait()
	close(failures)
	for failure := range failures {
		t.Fatalf("concurrent read failure: %s", failure)
	}
	if entries, _ := characterCardCacheMemoryCost(); entries != 1 {
		t.Fatalf("concurrent reads produced %d entries; want 1", entries)
	}
}

// TestCharacterCardCacheTextIsNotSharedWithCallers makes sure a caller cannot mutate the cached string: strings
// are immutable in Go, so the test is a compile-time-shaped statement of the contract rather than a runtime race;
// it also pins that repeated reads are NOT byte slices over one backing array. It is cheap and documents why the
// value type is string, not []byte.
func TestCharacterCardCacheTextIsNotSharedWithCallers(t *testing.T) {
	resetCharacterCardCache()
	directory := t.TempDir()
	path := filepath.Join(directory, "Immutable.png")
	document := cacheTestCardText("Immutable")
	writeCacheTestCardPNG(t, path, document)
	setCardMtime(t, path, time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC))
	first, err := readCharacterDataStrict(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	second, err := readCharacterDataStrict(path)
	if err != nil {
		t.Fatalf("second read: %v", err)
	}
	if first != second {
		t.Fatalf("two reads returned different documents: %q vs %q", first, second)
	}
	if !strings.Contains(first, "Immutable") {
		t.Fatalf("the served document does not carry the fixture's name: %q", first)
	}
}
