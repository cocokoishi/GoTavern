package lockacquire

// THE BOUND IS THE PRODUCT: a second GoTavern process on one tree must fail with a NAMED, BOUNDED error
// rather than hang the boot (AGENTS rule 24), and the whole-boot budget must cap every nested acquisition
// (a "bounded" boot that takes four 10 s waits is not bounded). These tests drive a REAL flock held by a
// second flock handle, not a fake: the contention path is exactly what a second process produces.

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofrs/flock"
)

// holdLock takes a real flock on path and returns the release function. It fails the test when the lock
// cannot be taken, rather than silently testing against an unlocked file.
func holdLock(t *testing.T, path string) func() {
	t.Helper()
	held := flock.New(path)
	locked, err := held.TryLock()
	if err != nil {
		t.Fatalf("hold %s: %v", path, err)
	}
	if !locked {
		t.Fatalf("could not take %s for the contention case", path)
	}
	return func() {
		_ = held.Unlock()
		_ = held.Close()
	}
}

func TestBoundFollowsTheBootBudget(t *testing.T) {
	// Outside a boot the per-lock bound is the request-time default.
	end := BeginBoot(0) // 0 means the default whole-boot budget
	if got := Bound(); got != DefaultPerLock {
		t.Fatalf("Bound outside an ordinary boot = %s, want %s", got, DefaultPerLock)
	}
	end()

	// A SHORT boot budget caps an acquisition below the per-lock default, so the whole boot stays bounded.
	end = BeginBoot(250 * time.Millisecond)
	bounded := Bound()
	end()
	if bounded <= 0 || bounded > 250*time.Millisecond {
		t.Fatalf("Bound with a 250ms boot budget = %s, want >0 and <=250ms", bounded)
	}
	if bounded > DefaultPerLock {
		t.Fatalf("Bound with a 250ms boot budget = %s, which exceeds the per-lock default %s", bounded, DefaultPerLock)
	}

	// An expired budget must be reported as zero rather than as a wait: a caller checks Bound and fails
	// immediately instead of sleeping until the deadline it has already passed.
	end = BeginBoot(50 * time.Millisecond)
	time.Sleep(100 * time.Millisecond)
	if got := Bound(); got != 0 {
		t.Fatalf("Bound after the boot budget expired = %s, want 0", got)
	}
	end()
}

func TestAcquireRefusesAContendedLockWithinTheBootBound(t *testing.T) {
	directory := t.TempDir()
	lockPath := filepath.Join(directory, "boot.lock")
	release := holdLock(t, lockPath)
	defer release()

	// A real second handle is blocked. With the boot budget at 300ms the acquisition must give up inside
	// that budget and name the lock; a 30s wait here is the P0-B hang this package exists to prevent.
	end := BeginBoot(300 * time.Millisecond)
	defer end()
	started := time.Now()
	lock, err := Acquire(lockPath, "config")
	waited := time.Since(started)
	if err == nil {
		_ = lock.Unlock()
		_ = lock.Close()
		t.Fatalf("Acquire succeeded on a lock held by a second handle; the contention case never ran")
	}
	if !IsBusy(err) {
		t.Fatalf("Acquire error = %v, want a BusyError", err)
	}
	var busy *BusyError
	if !errors.As(err, &busy) {
		t.Fatalf("error %v is not errors.As-able as *BusyError", err)
	}
	if busy.Purpose != "config" {
		t.Errorf("BusyError.Purpose = %q, want %q", busy.Purpose, "config")
	}
	if busy.Path != lockPath {
		t.Errorf("BusyError.Path = %q, want %q", busy.Path, lockPath)
	}
	if waited > 300*time.Millisecond+750*time.Millisecond {
		t.Fatalf("Acquire waited %s for a lock with a 300ms boot budget; the bound did not reach the wait path", waited)
	}
	message := err.Error()
	for _, want := range []string{"config", lockPath, "locked by another GoTavern process"} {
		if !strings.Contains(message, want) {
			t.Errorf("BusyError message %q does not name %q", message, want)
		}
	}
}

func TestAcquireReportsTheExpiredBudgetDistinctly(t *testing.T) {
	directory := t.TempDir()
	lockPath := filepath.Join(directory, "expired.lock")
	release := holdLock(t, lockPath)
	defer release()

	end := BeginBoot(40 * time.Millisecond)
	time.Sleep(80 * time.Millisecond) // let the budget expire
	defer end()
	started := time.Now()
	_, err := Acquire(lockPath, "user storage")
	waited := time.Since(started)
	var busy *BusyError
	if !errors.As(err, &busy) {
		t.Fatalf("Acquire with an expired boot budget = %v, want a *BusyError", err)
	}
	if !busy.BudgetExpired {
		t.Errorf("BusyError.BudgetExpired = false, want true when the deadline had already passed")
	}
	if waited > 250*time.Millisecond {
		t.Errorf("Acquire waited %s with an already-expired budget, want an immediate refusal", waited)
	}
	if !strings.Contains(err.Error(), "startup budget expired") {
		t.Errorf("BusyError message %q does not name the expired startup budget", err.Error())
	}
}

func TestAcquireReleasesAndPermitsReacquisition(t *testing.T) {
	directory := t.TempDir()
	lockPath := filepath.Join(directory, "reacquire.lock")
	first, err := Acquire(lockPath, "config")
	if err != nil {
		t.Fatalf("uncontended Acquire: %v", err)
	}
	if err := first.Unlock(); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	second, err := Acquire(lockPath, "config")
	if err != nil {
		t.Fatalf("re-Acquire after release: %v", err)
	}
	_ = second.Unlock()
	_ = second.Close()
	// A lock file left behind by a dead process is not a deadlock: flock is released on process death, so
	// an existing file with no holder must lock immediately.
	if _, err := os.Stat(lockPath); err != nil {
		t.Fatalf("the lock file was removed instead of released; a leftover file must not matter: %v", err)
	}
	third, err := Acquire(lockPath, "config")
	if err != nil {
		t.Fatalf("Acquire on a leftover unlocked file: %v", err)
	}
	_ = third.Unlock()
	_ = third.Close()
}
