package startup

// THE ATOMIC REPLACEMENT MUST SURVIVE THE TWO FAILURES IT EXISTS FOR: A BOUNDED WRITE FAILURE
// (full disk / quota / injected I/O error) AND A KILLED PROCESS. IN BOTH CASES THE TARGET MUST BE
// THE COMPLETE OLD FILE OR THE COMPLETE NEW ONE, NEVER A PREFIX.
//
// Why this shape rather than a mutation-driven race: a race can only PROBABILISTICALLY observe a
// truncation window, so a green race is not proof. Here the failure is injected at the exact step
// (`atomicTempWrite`, the temporary file's write) and a real second PROCESS is killed while it is
// mid-write, which is the process-boundary simulation a crash actually is.
//
// PINNED CONTRAST, for the record: pinned SillyTavern uses `write-file-atomic` for the same class
// of writes (src/util.js tryWriteFileSync, chats.js backup/save, characters.js card images), so the
// staged write is parity for those paths. The two paths where GoTavern hardened a pinned hazard
// (pinned fs.cpSync for a chats-tree rename, pinned fs.promises.writeFile for an image upload) are
// recorded in docs/data-safety.md as deliberate product decisions with their user-visible effect.

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// atomicScratchPrefix is the temporary-file prefix atomicReplace uses; a leftover one is a partial
// write that was never published.
const atomicScratchPrefix = ".gotavern-content-log-"

// TestAtomicReplacePreservesTheOriginalWhenTheDiskFillsMidWrite injects a short write followed by
// the ENOSPC a full disk produces. The target must be BYTE-IDENTICAL to its previous content and
// the half-written scratch file must not survive: that is "no partial write visible to a crash".
func TestAtomicReplacePreservesTheOriginalWhenTheDiskFillsMidWrite(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "settings.json")
	original := []byte(`{"keep":"the previous settings"}`)
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatal(err)
	}

	restore := atomicTempWrite
	t.Cleanup(func() { atomicTempWrite = restore })
	halfWritten := false
	atomicTempWrite = func(temporary *os.File, body []byte) error {
		if len(body) > 0 {
			if _, err := temporary.Write(body[:len(body)/2]); err != nil {
				return err
			}
			halfWritten = true
		}
		return errors.New("injected disk-full: write failed partway")
	}

	err := atomicReplace(target, []byte(`{"new":"this replacement must not be published"}`))
	if err == nil {
		t.Fatal("atomicReplace reported success although the injected write failed partway")
	}
	if !halfWritten {
		t.Fatal("the test never reached the half-written state: the injection did not run")
	}
	got, readErr := os.ReadFile(target)
	if readErr != nil {
		t.Fatalf("read the target after a failed replacement: %v", readErr)
	}
	if !bytes.Equal(got, original) {
		t.Fatalf("a failed replacement changed the target.\n  want (%d bytes): %q\n  got  (%d bytes): %q",
			len(original), original, len(got), got)
	}
	assertNoAtomicScratch(t, directory)
}

// TestAtomicReplacePreservesTheOriginalWhenTheRenameCannotHappen covers the other end of the same
// window: the temporary file was written and synced, and the publish step fails. The old bytes
// must still be the target, and the scratch file must be gone.
func TestAtomicReplacePreservesTheOriginalWhenTheRenameCannotHappen(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "occupant")
	if err := os.MkdirAll(filepath.Join(target, "keep"), 0o777); err != nil {
		t.Fatal(err)
	}
	inner := filepath.Join(target, "keep", "inside.txt")
	if err := os.WriteFile(inner, []byte("must survive"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := atomicReplace(target, []byte(`{"replacement":true}`)); err == nil {
		t.Fatal("atomicReplace reported success although the target could not be replaced")
	}
	body, err := os.ReadFile(inner)
	if err != nil || string(body) != "must survive" {
		t.Fatalf("the failed replacement disturbed the existing target: %q, %v", body, err)
	}
	assertNoAtomicScratch(t, directory)
}

func assertNoAtomicScratch(t *testing.T, directory string) {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read %s: %v", directory, err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), atomicScratchPrefix) {
			t.Fatalf("a partially written scratch file survived at %s", filepath.Join(directory, entry.Name()))
		}
	}
}

// atomicCrashBodySize is large enough that a direct truncate-and-write needs several milliseconds,
// so killing the helper a fixed short time after it enters the replacement lands inside the write.
const atomicCrashBodySize = 128 << 20

const atomicCrashHelperEnv = "GOTAVERN_ATOMIC_REPLACE_CRASH_HELPER"

// TestAtomicReplaceKilledProcessHelperProcess is not a test: it is the child side of the
// killed-process simulation below. It runs only when the parent sets the environment variable.
// It signals that it is about to replace the file, then replaces it.
func TestAtomicReplaceKilledProcessHelperProcess(t *testing.T) {
	if os.Getenv(atomicCrashHelperEnv) != "1" {
		return
	}
	target := os.Getenv(atomicCrashHelperEnv + "_TARGET")
	ready := os.Getenv(atomicCrashHelperEnv + "_READY")
	if target == "" || ready == "" {
		os.Exit(2)
	}
	body := bytes.Repeat([]byte("N"), atomicCrashBodySize)
	if err := os.WriteFile(ready, []byte("ready"), 0o600); err != nil {
		os.Exit(4)
	}
	if err := atomicReplace(target, body); err != nil {
		os.Exit(3)
	}
	os.Exit(0)
}

// TestAtomicReplaceSurvivesAProcessKilledMidWrite kills a REAL second process while it replaces a
// file and requires the target to be either the complete old content or the complete new content.
// It is the process-boundary half of the crash simulation; the DETERMINISTIC half is the injected
// write failure above, because whether this kill lands inside the write depends on the host's
// scheduling (measured here: a direct-write mutant was NOT caught by this test in one run because
// the single-vCPU host let the child finish the write before the parent observed the window). The
// assertion is still the right one: a partial target under ANY kill timing is a failure.
func TestAtomicReplaceSurvivesAProcessKilledMidWrite(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "chat.jsonl")
	ready := filepath.Join(directory, "helper-ready")
	original := []byte(`{"old":"complete chat"}`)
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatal(err)
	}

	command := exec.Command(os.Args[0], "-test.run=^TestAtomicReplaceKilledProcessHelperProcess$")
	command.Env = append(os.Environ(),
		atomicCrashHelperEnv+"=1",
		atomicCrashHelperEnv+"_TARGET="+target,
		atomicCrashHelperEnv+"_READY="+ready,
	)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		t.Fatalf("start the crash helper process: %v", err)
	}
	started := false
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(ready); err == nil {
			started = true
			break
		}
		time.Sleep(200 * time.Microsecond)
	}
	if !started {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatal("the crash helper never signalled readiness")
	}
	// The helper enters the replacement immediately after writing the ready marker; this delay
	// lands inside the write for the sizes this test uses, without racing the process startup.
	time.Sleep(2 * time.Millisecond)
	killed := command.Process.Kill() == nil
	_ = command.Wait()
	if !killed {
		t.Skip("the helper finished before it could be killed; the kill window was not sampled on this host")
	}

	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read the target after the helper was killed: %v", err)
	}
	if bytes.Equal(body, original) {
		return
	}
	completeNew := len(body) == atomicCrashBodySize && bytes.Equal(body, bytes.Repeat([]byte("N"), atomicCrashBodySize))
	if !completeNew {
		t.Fatalf("a killed process left a PARTIAL target visible to a reader: %d bytes; the complete old "+
			"payload is %d bytes and the complete new one is %d bytes", len(body), len(original), atomicCrashBodySize)
	}
}
