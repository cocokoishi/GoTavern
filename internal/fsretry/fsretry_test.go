package fsretry

import (
	"errors"
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
