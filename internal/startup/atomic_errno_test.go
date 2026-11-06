package startup

// M3 CHAOS PROOF, ATOMIC-WRITE HALF: an injected disk-full (ENOSPC) and an injected file-too-large
// (EFBIG) take the SAME safe path through the real atomic replacement, and the two are never conflated:
// the errno each one produced is still recoverable with errors.Is after the layer returns, and the
// target is byte-identical to its previous content in BOTH cases. See
// docs/alpha16/m3-chaos-evidence.md for the code-path mapping and the mutation that kills this test.
//
// WHAT IS BEING PROVEN, AND WHAT IS NOT. There is no errno classifier in the persistence path (the
// retry predicate covers only Windows sharing violations, see fsretry_errno_test.go), so the property
// is not "the two take different branches" -- it is "the layer neither rewrites, retries nor maps
// either errno, so a caller can distinguish them and the published bytes are the complete old ones".
// A real kernel ENOSPC needs a privileged mount and is UNPROVEN by policy; EFBIG has a kernel-level
// gate (tests/e2e/a15_efbig_linux_test.go) and is not relabelled as ENOSPC here. This test injects the
// errno at the exact write step the kernel would fail, which is the code path in between.
//
// The injection hook is `atomicTempWrite` (content.go:333-336), the same seam
// TestAtomicReplacePreservesTheOriginalWhenTheDiskFillsMidWrite already uses; it is installed on the
// subtest and restored by t.Cleanup, so no other test sees it.

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// TestENOSPCAndEFBIGAreNotConflatedInTheAtomicWrite is the named control for the writer layer. Each
// subtest fails by name if the errno is lost, if it is replaced by the other class, or if the failed
// replacement disturbs the previous document.
func TestENOSPCAndEFBIGAreNotConflatedInTheAtomicWrite(t *testing.T) {
	cases := []struct {
		name     string
		errno    error
		other    error
		wrapped  bool
		halfWrit bool
	}{
		{"raw-disk-full", syscall.ENOSPC, syscall.EFBIG, false, false},
		{"raw-file-too-large", syscall.EFBIG, syscall.ENOSPC, false, false},
		{"partial-write-then-disk-full", syscall.ENOSPC, syscall.EFBIG, false, true},
		{"partial-write-then-file-too-large", syscall.EFBIG, syscall.ENOSPC, false, true},
		{"wrapped-partial-write-disk-full", syscall.ENOSPC, syscall.EFBIG, true, true},
		{"wrapped-partial-write-file-too-large", syscall.EFBIG, syscall.ENOSPC, true, true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			directory := t.TempDir()
			target := filepath.Join(directory, "settings.json")
			original := []byte(`{"keep":"the previous complete settings"}`)
			if err := os.WriteFile(target, original, 0o600); err != nil {
				t.Fatal(err)
			}

			restore := atomicTempWrite
			t.Cleanup(func() { atomicTempWrite = restore })
			atomicTempWrite = func(temporary *os.File, body []byte) error {
				if testCase.halfWrit && len(body) > 0 {
					// The kernel writes the bytes it can and THEN returns the failure; the product must
					// not publish them.
					if _, err := temporary.Write(body[:len(body)/2]); err != nil {
						return err
					}
				}
				if testCase.wrapped {
					return fmt.Errorf("gotavern: write %s: %w", target, testCase.errno)
				}
				return testCase.errno
			}

			err := atomicReplace(target, []byte(`{"new":"this replacement must not be published"}`))
			if err == nil {
				t.Fatalf("atomicReplace reported success although the injected %v failed the write", testCase.errno)
			}
			if !errors.Is(err, testCase.errno) {
				t.Fatalf("the layer returned %v, which no longer carries %v: a caller can no longer tell disk-full from file-too-large (the identity must survive atomicReplace unchanged)",
					err, testCase.errno)
			}
			if errors.Is(err, testCase.other) {
				t.Fatalf("the layer conflated %v with %v: the returned error matches BOTH errnos", testCase.errno, testCase.other)
			}

			got, readErr := os.ReadFile(target)
			if readErr != nil {
				t.Fatalf("read the target after a failed replacement: %v", readErr)
			}
			if !bytes.Equal(got, original) {
				t.Fatalf("a failed replacement published partial bytes for %v.\n  want (%d bytes): %q\n  got  (%d bytes): %q",
					testCase.errno, len(original), original, len(got), got)
			}
			assertNoAtomicScratch(t, directory)
		})
	}

	// A non-errno failure keeps its own identity and is not mapped onto either class. This is the
	// negative control for the two errno subtests above: if the layer ever invented an ENOSPC/EFBIG,
	// this subtest would pass for the wrong reason, so it asserts the sentinel survives instead.
	t.Run("non-errno-error", func(t *testing.T) {
		directory := t.TempDir()
		target := filepath.Join(directory, "chat.jsonl")
		original := []byte(`{"old":"complete chat"}`)
		if err := os.WriteFile(target, original, 0o600); err != nil {
			t.Fatal(err)
		}
		sentinel := errors.New("injected ordinary write failure")
		restore := atomicTempWrite
		t.Cleanup(func() { atomicTempWrite = restore })
		atomicTempWrite = func(*os.File, []byte) error { return sentinel }

		err := atomicReplace(target, []byte(`{"new":"must not be published"}`))
		if err == nil {
			t.Fatal("atomicReplace reported success although the injected write failed")
		}
		if !errors.Is(err, sentinel) {
			t.Fatalf("the layer returned %v, want the injected sentinel", err)
		}
		if errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EFBIG) {
			t.Fatalf("a non-errno failure was mapped onto disk-full/file-too-large: %v", err)
		}
		if got, readErr := os.ReadFile(target); readErr != nil || !bytes.Equal(got, original) {
			t.Fatalf("the failed replacement disturbed the target: %q (%v)", got, readErr)
		}
		assertNoAtomicScratch(t, directory)
	})

	// The failure must not poison the next write: after the injected error is removed, the same target
	// replaces normally. This proves the failed attempt cleaned up its scratch file and left no state
	// that would make a later disk-full look like a file-too-large (or make either permanent).
	t.Run("recovers-after-the-injected-failure", func(t *testing.T) {
		directory := t.TempDir()
		target := filepath.Join(directory, "world.json")
		original := []byte(`{"old":true}`)
		if err := os.WriteFile(target, original, 0o600); err != nil {
			t.Fatal(err)
		}
		restore := atomicTempWrite
		t.Cleanup(func() { atomicTempWrite = restore })

		atomicTempWrite = func(*os.File, []byte) error { return syscall.ENOSPC }
		if err := atomicReplace(target, []byte(`{"failed":true}`)); !errors.Is(err, syscall.ENOSPC) {
			t.Fatalf("the injected disk-full did not surface as ENOSPC: %v", err)
		}
		atomicTempWrite = restore
		if err := atomicReplace(target, []byte(`{"recovered":true}`)); err != nil {
			t.Fatalf("the write after a disk-full failure did not succeed: %v", err)
		}
		got, readErr := os.ReadFile(target)
		if readErr != nil || !bytes.Equal(got, []byte(`{"recovered":true}`)) {
			t.Fatalf("the recovered write did not publish: %q (%v)", got, readErr)
		}
	})
}
