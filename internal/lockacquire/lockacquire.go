// Package lockacquire bounds every flock acquisition on the boot path.
//
// WHY THIS EXISTS (P0-B). A user put the release binary into a SillyTavern directory that starts fine with
// `node server.js`, ran it, and it hung in initialisation forever with no output. There are exactly FOUR
// acquisition functions on the boot path -- config, cookie secret, user storage and content seeding -- and
// every one of them called flock.Lock(), which has no context and therefore no bound. Two of them are taken
// while another is held (config -> storage -> content), and `acquireContentLock` is ALSO used at request
// time, so the bound has to be a process-wide boot deadline as well as a per-lock bound: four locks each
// waiting ten seconds inside a twenty-second budget is how a "bounded" boot still exceeds its bound.
//
// The two diagnostics lines are here rather than at the call sites so all four sites report identically,
// and they are emitted ONLY when a lock is actually contended -- an uncontended boot stays silent. Printing
// an "acquired" line for every acquisition would have put ~20 lines into every normal boot.
package lockacquire

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gofrs/flock"
)

const (
	// DefaultPerLock bounds ONE acquisition when no boot is in progress (request-time callers reuse the
	// same helper and must never wait forever either).
	DefaultPerLock = 10 * time.Second
	// DefaultBootBudget bounds the WHOLE startup, which is what makes nested locks safe.
	DefaultBootBudget = 30 * time.Second
	// retryDelay is how often TryLockContext retries while it waits.
	retryDelay = 25 * time.Millisecond
)

// bootDeadline is the process-wide startup deadline in unix nanoseconds; 0 means no boot is in progress.
// It is process-global BY NATURE (there is one boot per process) and the alternative -- threading a context
// through the ~20 callers of the content lock -- is a much larger change for the same meaning.
var bootDeadline atomic.Int64

var diagnosticsMu sync.Mutex

// BeginBoot installs the startup budget and returns the function that clears it.
func BeginBoot(budget time.Duration) (end func()) {
	if budget <= 0 {
		budget = DefaultBootBudget
	}
	bootDeadline.Store(time.Now().Add(budget).UnixNano())
	return func() { bootDeadline.Store(0) }
}

// Bound reports how long one acquisition may wait right now.
func Bound() time.Duration {
	deadline := bootDeadline.Load()
	if deadline == 0 {
		return DefaultPerLock
	}
	remaining := time.Until(time.Unix(0, deadline))
	if remaining <= 0 {
		return 0
	}
	if remaining < DefaultPerLock {
		return remaining
	}
	return DefaultPerLock
}

// BusyError is the named failure: WHICH lock was contended, the file, and how long it waited. A boot that
// cannot proceed has to say what it was waiting for, which is precisely what the user's report could not.
type BusyError struct {
	Purpose       string
	Path          string
	Waited        time.Duration
	BudgetExpired bool
}

func (e *BusyError) Error() string {
	waited := e.Waited.Round(100 * time.Millisecond)
	if e.BudgetExpired {
		return fmt.Sprintf("%s is locked by another GoTavern process, and the startup budget expired while waiting (waited %s, lock file %s)", e.Purpose, waited, e.Path)
	}
	return fmt.Sprintf("%s is locked by another GoTavern process (waited %s, lock file %s)", e.Purpose, waited, e.Path)
}

// IsBusy reports whether err is a bounded-acquisition failure, so a caller can tell "another process owns
// this tree" from a filesystem error.
func IsBusy(err error) bool {
	var busy *BusyError
	return errors.As(err, &busy)
}

func reportf(format string, args ...any) {
	diagnosticsMu.Lock()
	defer diagnosticsMu.Unlock()
	fmt.Fprintf(os.Stderr, "startup: "+format+"\n", args...)
}

// Acquire takes the lock at path, waiting at most Bound(). It never waits without a limit and it never
// deletes a lock file to break a deadlock: a file left behind by a crashed process is harmless, because
// flock is released when the process dies.
func Acquire(path string, purpose string) (*flock.Flock, error) {
	lock := flock.New(path, flock.SetPermissions(0o600))
	uncontended, err := lock.TryLock()
	if err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("lock %s at %s: %w", purpose, path, err)
	}
	if uncontended {
		return lock, nil
	}

	bound := Bound()
	if bound <= 0 {
		_ = lock.Close()
		return nil, &BusyError{Purpose: purpose, Path: path, BudgetExpired: true}
	}
	reportf("waiting for the %s lock at %s (up to %s)", purpose, path, bound.Round(100*time.Millisecond))
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), bound)
	defer cancel()
	acquired, waitErr := lock.TryLockContext(ctx, retryDelay)
	waited := time.Since(started)
	if waitErr != nil && !errors.Is(waitErr, context.DeadlineExceeded) && !errors.Is(waitErr, context.Canceled) {
		_ = lock.Close()
		return nil, fmt.Errorf("lock %s at %s: %w", purpose, path, waitErr)
	}
	if !acquired {
		_ = lock.Close()
		return nil, &BusyError{Purpose: purpose, Path: path, Waited: waited, BudgetExpired: budgetExpired()}
	}
	reportf("acquired the %s lock at %s after %s", purpose, path, waited.Round(100*time.Millisecond))
	return lock, nil
}

func budgetExpired() bool {
	deadline := bootDeadline.Load()
	return deadline != 0 && time.Now().UnixNano() >= deadline
}
