//go:build windows

package fsretry

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestDoRetriesARealSharingViolation uses the actual Windows mechanism rather than a fabricated error: a
// reader holds the destination open, and the operation that must replace it -- os.Rename, which is what
// internal/startup.renameIntoPlace performs -- is retried until the handle closes.
//
// THE OPERATION HAS TO BE THE RENAME, and that was measured rather than assumed: a read-vs-read overlap is
// NOT a violation on Windows (both handles ask for FILE_SHARE_READ), so an os.Open in this test would
// succeed first time and prove nothing. The write-vs-read conflict is the one that exists.
func TestDoRetriesARealSharingViolation(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "record.json")
	if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
		t.Fatalf("seed target: %v", err)
	}
	temporary := filepath.Join(directory, ".replacement.tmp")
	if err := os.WriteFile(temporary, []byte("new"), 0o600); err != nil {
		t.Fatalf("seed replacement: %v", err)
	}
	held, err := os.Open(target)
	if err != nil {
		t.Fatalf("hold the target: %v", err)
	}
	go func() {
		time.Sleep(30 * time.Millisecond)
		_ = held.Close()
	}()

	attempts := 0
	if err := Do(func() error {
		attempts++
		return os.Rename(temporary, target)
	}); err != nil {
		t.Fatalf("Do did not absorb the sharing violation: %v", err)
	}
	if attempts < 2 {
		t.Fatalf("the operation ran %d time(s); a held destination should have forced at least one retry", attempts)
	}
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read the replaced target: %v", err)
	}
	if string(body) != "new" {
		t.Fatalf("the target holds %q, want the replacement body", string(body))
	}
}
