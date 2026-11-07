package server

// D-H17: THE TOKENIZER CACHE IS ONLY EVER ABSENT OR COMPLETE.
//
// Pinned SillyTavern imports `write-file-atomic` and calls `writeFileAtomicSync` for every
// tokenizer-cache write (`src/endpoints/tokenizers.js:9` import; `:116`, `:136` and `:140` the
// three write sites). write-file-atomic creates a unique temporary file in the destination
// directory, fsyncs it, closes it and renames it over the destination, so a crash, a full disk
// or a concurrent reader can never observe a partial cache file.
//
// GoTavern wrote the same cache with `_ = os.WriteFile(...)`, which truncates the destination
// first: a mid-write failure left a truncated file that the NEXT request would read as a
// tokenizer (and `write()`'s error was discarded entirely, so the tokenizer that could not be
// cached was still used -- pinned falls back to llama3 in that case).
//
// The tests below inject the mid-write failure through `tokenizerCacheTempWrite`, the named
// seam the same way internal/startup's `atomicTempWrite` is the seam for its writer. They assert
// the OBSERVABLE contract (destination absent or byte-identical to a complete payload, reader
// never sees a prefix), not that a particular helper was called.

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// tokenizerRaceTestAssets resolves the vendored tokenizer tree the same way a release install
// does, so the tests read REAL model bytes rather than a generated stub.
func tokenizerRaceTestAssets(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	assets := filepath.Join(root, "upstream", "tokenizers")
	if _, err := os.Stat(filepath.Join(assets, "llama3.json")); err != nil {
		t.Fatalf("the vendored tokenizer tree is missing llama3.json: %v", err)
	}
	return assets
}

// seedTokenizerCompressedCache puts the vendored .gz into the cache, which is the state a
// manual download leaves behind and the only state where the write path runs (an uncompressed
// cache file would be returned before any write).
func seedTokenizerCompressedCache(t *testing.T, cache, model string) []byte {
	t.Helper()
	compressed, err := os.ReadFile(filepath.Join(tokenizerRaceTestAssets(t), "external", model+".json.gz"))
	if err != nil {
		t.Fatalf("read the vendored %s cache seed: %v", model, err)
	}
	if err := os.MkdirAll(cache, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, model+".json.gz"), compressed, 0o644); err != nil {
		t.Fatal(err)
	}
	return compressed
}

// failTokenizerCacheTempWrite injects the bounded write failure a full disk or a killed process
// produces: a PREFIX of the body has reached the file and then the write fails.
func failTokenizerCacheTempWrite(t *testing.T) {
	t.Helper()
	previous := tokenizerCacheTempWrite
	tokenizerCacheTempWrite = func(file *os.File, body []byte) error {
		if _, err := file.Write(body[:len(body)/2]); err != nil {
			return err
		}
		return errors.New("simulated ENOSPC after a partial write")
	}
	t.Cleanup(func() { tokenizerCacheTempWrite = previous })
}

func assertNoTokenizerCacheScratch(t *testing.T, directory string) {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".gotavern-tokenizer-") {
			t.Errorf("a tokenizer cache write left scratch file %q behind; a crash or a later request must not find a stray partial candidate", entry.Name())
		}
	}
}

// TestTokenizerCacheWriteFailureLeavesThePreviousCacheOrNothing drives the REAL webBytes path a
// request takes: a compressed cache file, a decompression, then the materialize-into-cache
// write. The write fails halfway. Pre-fix this leaves a truncated `qwen2.json`; post-fix the
// cache file is absent and the tokenizer resolution falls back to llama3 exactly as pinned's
// `catch` does.
func TestTokenizerCacheWriteFailureLeavesThePreviousCacheOrNothing(t *testing.T) {
	const model = "qwen2"
	assets := tokenizerRaceTestAssets(t)
	cache := filepath.Join(t.TempDir(), "_cache")
	compressed := seedTokenizerCompressedCache(t, cache, model)
	expected, err := gunzipBytes(compressed)
	if err != nil {
		t.Fatalf("decompress the vendored %s cache seed: %v", model, err)
	}
	llama3, err := os.ReadFile(filepath.Join(assets, "llama3.json"))
	if err != nil {
		t.Fatal(err)
	}
	// DISCRIMINATION FIRST: if the two tokenizers were byte-identical, "fell back to llama3"
	// could not be told apart from "used the downloaded tokenizer" and the assertion below
	// would pass for the wrong reason.
	if bytes.Equal(expected, llama3) {
		t.Fatalf("the %s and llama3 tokenizer bytes are identical, so the fallback assertion cannot discriminate", model)
	}

	failTokenizerCacheTempWrite(t)
	set := &tokenizerSet{assets: assets, cache: cache}
	raw, err := set.webBytes(model)
	if err != nil {
		t.Fatalf("webBytes(%s) with a failing cache write returned an error: %v", model, err)
	}

	destination := filepath.Join(cache, model+".json")
	if body, readErr := os.ReadFile(destination); readErr == nil {
		if !bytes.Equal(body, expected) {
			t.Fatalf("a failed tokenizer cache write left a %d-byte file at %s; the complete payload is %d bytes. "+
				"The cache must be absent or complete, because the next request reads this file as a tokenizer.",
				len(body), destination, len(expected))
		}
	} else if !errors.Is(readErr, fs.ErrNotExist) {
		t.Fatalf("read the tokenizer cache destination after a failed write: %v", readErr)
	}
	assertNoTokenizerCacheScratch(t, cache)

	// Pinned failure semantics: writeFileAtomicSync throws inside getPathToTokenizer's try,
	// the catch returns the fallback model (tokenizers.js:9,116,136,144-146, with llama3.json
	// declared as the fallback for every externally fetched tokenizer at :280-284). The route
	// therefore answers with llama3's tokenization, not the tokenizer that could not be cached.
	if !bytes.Equal(raw, llama3) {
		t.Fatalf("after a failed cache write webBytes(%s) returned %d bytes of the %s tokenizer; pinned "+
			"getPathToTokenizer catches the writeFileAtomicSync throw and returns the llama3 fallback "+
			"(llama3 is %d bytes)", model, len(raw), model, len(llama3))
	}
}

// TestTokenizerCacheWriteFailurePreservesThePreviousCompleteFile covers the overwrite case a
// reader actually depends on: a complete cache file already exists and the next materialization
// fails. Pre-fix the destination is truncated to a prefix; post-fix it is the previous complete
// file.
func TestTokenizerCacheWriteFailurePreservesThePreviousCompleteFile(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "qwen2.json")
	previous := []byte(`{"previous":"complete tokenizer"}`)
	if err := os.WriteFile(target, previous, 0o644); err != nil {
		t.Fatal(err)
	}
	replacement := bytes.Repeat([]byte(`{"new":`+"\n"), 8<<10)

	failTokenizerCacheTempWrite(t)
	if err := writeTokenizerCacheFile(target, replacement); err == nil {
		t.Fatal("a partial write reported success, so the failure seam did not fire")
	}

	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("a failed tokenizer cache write destroyed the previous complete file: %v", err)
	}
	if !bytes.Equal(body, previous) {
		t.Fatalf("a failed tokenizer cache write replaced the previous complete %d-byte file with %d bytes "+
			"(a truncation window a concurrent reader would then tokenize from)",
			len(previous), len(body))
	}
	assertNoTokenizerCacheScratch(t, directory)
}

// TestTokenizerCacheReaderNeverObservesPartialBytes injects a slow, chunked writer and polls the
// destination from a reader. In-place publication (the pre-fix O_TRUNC + write) exposes the
// prefix; temp-file + rename publication exposes only the previous complete file or the new
// complete file.
func TestTokenizerCacheReaderNeverObservesPartialBytes(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "qwen2.json")
	previous := []byte(`{"previous":"complete tokenizer"}`)
	if err := os.WriteFile(target, previous, 0o644); err != nil {
		t.Fatal(err)
	}
	replacement := bytes.Repeat([]byte("n"), 512<<10)

	previousSeam := tokenizerCacheTempWrite
	tokenizerCacheTempWrite = func(file *os.File, body []byte) error {
		// Chunked and paced so the write has a measurable duration; this is the window a fast
		// reader samples. A real ENOSPC/partial write has the same shape.
		step := len(body) / 8
		for index := 0; index < 8; index++ {
			end := (index + 1) * step
			if index == 7 {
				end = len(body)
			}
			if _, err := file.Write(body[index*step : end]); err != nil {
				return err
			}
			time.Sleep(time.Millisecond)
		}
		return nil
	}
	t.Cleanup(func() { tokenizerCacheTempWrite = previousSeam })

	done := make(chan struct{})
	var reader sync.WaitGroup
	var problemMu sync.Mutex
	var problems []string
	record := func(problem string) {
		problemMu.Lock()
		problems = append(problems, problem)
		problemMu.Unlock()
	}
	reader.Add(1)
	go func() {
		defer reader.Done()
		for {
			select {
			case <-done:
				return
			default:
			}
			body, err := os.ReadFile(target)
			if err != nil {
				// Absent is an allowed state (pinned's cache can be cold); a Windows sharing
				// failure while the rename happens is also not a torn observation.
				continue
			}
			if bytes.Equal(body, previous) || bytes.Equal(body, replacement) {
				continue
			}
			record(fmt.Sprintf("a concurrent reader observed %d cache bytes that are not a complete payload", len(body)))
			return
		}
	}()

	if err := writeTokenizerCacheFile(target, replacement); err != nil {
		t.Fatalf("writeTokenizerCacheFile: %v", err)
	}
	close(done)
	reader.Wait()

	problemMu.Lock()
	observed := append([]string(nil), problems...)
	problemMu.Unlock()
	if len(observed) > 0 {
		t.Fatalf("%s (the complete payloads are %d and %d bytes); the cache must be published atomically",
			observed[0], len(previous), len(replacement))
	}
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("the completed write did not publish: %v", err)
	}
	if !bytes.Equal(body, replacement) {
		t.Fatalf("after a successful write the destination is %d bytes, not the %d-byte replacement", len(body), len(replacement))
	}
	assertNoTokenizerCacheScratch(t, directory)
}
