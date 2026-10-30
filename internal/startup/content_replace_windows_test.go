package startup

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// THE RETRY IN renameIntoPlace EXISTS FOR ONE PLATFORM, SO THE TEST THAT PROVES IT IS GUARDED BY THAT
// PLATFORM RATHER THAN FAKING IT. On Unix the retry is a pass-through and this scenario cannot occur, so
// the test reports itself as skipped there instead of passing vacuously (AGENTS.md rule 19).
//
// The scenario is the real one, not a simulated error: a reader holds the DESTINATION open -- which is
// what a request handler reading the same record does -- and the writer replaces it. Windows refuses the
// rename while that handle exists (Go opens with FILE_SHARE_READ|WRITE but not FILE_SHARE_DELETE). The
// assertion is split so the test proves BOTH halves:
//
//	(a) a direct os.Rename under the same handle FAILS, so the scenario is discriminating;
//	(b) atomicReplace SUCCEEDS while that handle is still open at the moment the rename is attempted and
//	    closed shortly afterwards -- the transient overlap a real reader produces, which is exactly what a
//	    bounded retry can absorb.
//
// A reader that holds the handle for LONGER than the retry window still loses, and deliberately so: the
// retry is a tolerance for a millisecond-scale overlap, not a replacement for a lock.
func TestAtomicReplaceRetriesWhileAReaderHoldsTheTarget(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the sharing violation this exercises is a Windows rename property; Unix renames succeed")
	}
	directory := t.TempDir()
	target := filepath.Join(directory, "record.json")
	if err := os.WriteFile(target, []byte(`{"value":"old"}`), 0o600); err != nil {
		t.Fatalf("seed target: %v", err)
	}

	// (a) The scenario discriminates: without the retry the replace loses.
	held, err := os.Open(target)
	if err != nil {
		t.Fatalf("open the target the way a reader does: %v", err)
	}
	temporary := filepath.Join(directory, ".probe.tmp")
	if err := os.WriteFile(temporary, []byte(`{"value":"new"}`), 0o600); err != nil {
		_ = held.Close()
		t.Fatalf("write temporary: %v", err)
	}
	if renameErr := os.Rename(temporary, target); renameErr == nil {
		_ = held.Close()
		t.Fatalf("a direct rename succeeded while the target was open, so this test does not exercise the " +
			"sharing violation it claims to (the platform or the open call changed)")
	}
	_ = held.Close()
	_ = os.Remove(temporary)

	// (b) The product's helper absorbs the transient overlap that a real reader produces.
	transient, err := os.Open(target)
	if err != nil {
		t.Fatalf("re-open the target: %v", err)
	}
	closed := make(chan struct{})
	go func() {
		time.Sleep(30 * time.Millisecond)
		_ = transient.Close()
		close(closed)
	}()
	if err := atomicReplace(target, []byte(`{"value":"new"}`)); err != nil {
		<-closed
		t.Fatalf("atomicReplace failed while a reader's handle overlapped the rename: %v", err)
	}
	<-closed
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read the replaced target: %v", err)
	}
	if !strings.Contains(string(body), `"new"`) {
		t.Fatalf("the target was not replaced: %q", string(body))
	}
}
