package fsretry

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// Do must be a NO-OP wrapper for everything except a transient Windows sharing violation. These two tests
// are cross-platform on purpose: they pin the property that matters on Linux (where CI runs) -- an ordinary
// error is reported after exactly one attempt, never retried and never swallowed.
func TestDoRunsTheOperationOnceWhenItSucceeds(t *testing.T) {
	calls := 0
	if err := Do(func() error {
		calls++
		return nil
	}); err != nil {
		t.Fatalf("Do returned %v for a successful operation", err)
	}
	if calls != 1 {
		t.Fatalf("the operation ran %d times, want exactly 1", calls)
	}
}

func TestDoDoesNotRetryAnOrdinaryError(t *testing.T) {
	sentinel := errors.New("disk is full")
	calls := 0
	err := Do(func() error {
		calls++
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("Do returned %v, want the sentinel error", err)
	}
	if calls != 1 {
		t.Fatalf("an ordinary error was retried %d times; only a transient sharing violation may be", calls)
	}
}

// ReadFile must be os.ReadFile on this platform: no retry, same bytes, same error identity. The
// Windows-only half (a real sharing violation) lives in fsretry_windows_test.go.
func TestReadFileReturnsTheBytesAndPreservesErrorIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "record.json")
	if err := os.WriteFile(path, []byte(`{"v":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	body, err := ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", path, err)
	}
	if string(body) != `{"v":1}` {
		t.Fatalf("ReadFile returned %q, want the file's bytes", body)
	}
	if _, err := ReadFile(filepath.Join(t.TempDir(), "missing")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("ReadFile on a missing file = %v, want an os.ErrNotExist error (a missing file is not a transient violation)", err)
	}
}
