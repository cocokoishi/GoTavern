package fsretry

// M3 CHAOS PROOF: DISK-FULL (ENOSPC) AND FILE-TOO-LARGE (EFBIG) ARE NOT CONFLATED BY THE RETRY
// PREDICATE. See docs/alpha16/m3-chaos-evidence.md for the mapping and the two mutations that kill this
// test.
//
// THE FINDING THIS TEST PINS, stated before the assertions so a reader does not mistake it for a
// classifier test: the persistence path has NO errno classification. `fsretry.Do` retries exactly one
// class -- a Windows sharing/lock violation (`isTransient`, fsretry_windows.go:17-41) -- and off Windows
// the predicate is documented always-false (fsretry_other.go:4-6). ENOSPC and EFBIG are therefore not
// routed to different branches anywhere in the product (grep: no ENOSPC/EFBIG reference in production
// Go). Non-conflation is a property, not a branch, and this test pins the three parts of it that could
// break silently:
//
//  1. neither errno is retried -- exactly one attempt for both, so no retry loop can turn one into the
//     other, hide it, or burn the ~200 ms tolerance on a permanent failure;
//  2. the errno IDENTITY survives `Do` unchanged and combined with `%w`/`PathError` wrapping, so a
//     caller can still tell the two apart (only the HTTP response layer flattens them to a generic 500,
//     which is pinned parity -- recorded in the evidence doc, not tested here);
//  3. the predicate is not dead: the positive control below retries the Windows sharing violation, so
//     "not retried" is a measurement on this host rather than a predicate that never returns true.
//
// WHY NOT A KERNEL-LEVEL ENOSPC: reproducing a real full filesystem needs a privileged small mount,
// which the round's rules forbid. EFBIG has a real kernel gate (tests/e2e/a15_efbig_linux_test.go); a
// kernel ENOSPC is UNPROVEN and must not be claimed by relabelling EFBIG. This unit test is the proof
// for the CODE PATHS in between, not for the kernel's errno choice.

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"testing"
)

const (
	m3DiskFullErrno     = syscall.ENOSPC
	m3FileTooLargeErrno = syscall.EFBIG
)

// TestENOSPCAndEFBIGAreNotConflatedInTheRetryPredicate is the named M3 control. Every subtest asserts
// one attempt AND correct error identity, so a mutation that retries either errno, or that rewrites the
// error so the two become indistinguishable, fails by name.
func TestENOSPCAndEFBIGAreNotConflatedInTheRetryPredicate(t *testing.T) {
	if m3DiskFullErrno == m3FileTooLargeErrno {
		t.Fatalf("syscall.ENOSPC and syscall.EFBIG are the same value on %s; the two classes cannot be distinguished at all", runtime.GOOS)
	}
	if errors.Is(m3DiskFullErrno, m3FileTooLargeErrno) || errors.Is(m3FileTooLargeErrno, m3DiskFullErrno) {
		t.Fatalf("the two errno values compare equal under errors.Is; the platform conflates them before the product sees them")
	}

	cases := []struct {
		name      string
		injected  error
		wantErrno error
		other     error
	}{
		{"raw-disk-full", m3DiskFullErrno, m3DiskFullErrno, m3FileTooLargeErrno},
		{"raw-file-too-large", m3FileTooLargeErrno, m3FileTooLargeErrno, m3DiskFullErrno},
		{"wrapped-disk-full", fmt.Errorf("atomic replace temp write: %w", m3DiskFullErrno), m3DiskFullErrno, m3FileTooLargeErrno},
		{"wrapped-file-too-large", fmt.Errorf("atomic replace temp write: %w", m3FileTooLargeErrno), m3FileTooLargeErrno, m3DiskFullErrno},
		{"path-error-disk-full", &os.PathError{Op: "write", Path: "settings.json", Err: m3DiskFullErrno}, m3DiskFullErrno, m3FileTooLargeErrno},
		{"path-error-file-too-large", &os.PathError{Op: "write", Path: "settings.json", Err: m3FileTooLargeErrno}, m3FileTooLargeErrno, m3DiskFullErrno},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			calls := 0
			err := Do(func() error {
				calls++
				return testCase.injected
			})
			if calls != 1 {
				t.Fatalf("%v was attempted %d times: disk-full and file-too-large are permanent failures and both must be reported after exactly ONE attempt (the only retryable class is a Windows sharing/lock violation)",
					testCase.wantErrno, calls)
			}
			if !errors.Is(err, testCase.wantErrno) {
				t.Fatalf("Do returned %v, which no longer carries %v: the errno identity a caller needs to tell disk-full from file-too-large was lost",
					err, testCase.wantErrno)
			}
			if errors.Is(err, testCase.other) {
				t.Fatalf("Do conflated %v with %v: the returned error matches BOTH errnos", testCase.wantErrno, testCase.other)
			}
		})
	}

	// A non-errno error must stay a non-errno error: it is not upgraded, downgraded or mapped onto
	// either class, and it is not retried either.
	t.Run("non-errno-error", func(t *testing.T) {
		sentinel := errors.New("injected ordinary write failure")
		calls := 0
		err := Do(func() error {
			calls++
			return sentinel
		})
		if calls != 1 {
			t.Fatalf("an ordinary non-errno error was attempted %d times; only a transient Windows violation may be retried", calls)
		}
		if !errors.Is(err, sentinel) {
			t.Fatalf("Do returned %v, want the injected sentinel", err)
		}
		if errors.Is(err, m3DiskFullErrno) || errors.Is(err, m3FileTooLargeErrno) {
			t.Fatalf("a non-errno error was mapped onto disk-full/file-too-large: %v", err)
		}
	})

	// THE POSITIVE CONTROL, in the same test so the exactly-one-attempt assertions above cannot pass
	// because the predicate is dead. On Windows, errno 32 (ERROR_SHARING_VIOLATION) IS the retryable
	// class and must be attempted the full bounded number of times. Off Windows the predicate is
	// documented always-false (fsretry_other.go), so the same value must NOT be retried -- asserted
	// rather than skipped, because "no retry off Windows" is the platform's contract.
	t.Run("transient-sharing-violation-control", func(t *testing.T) {
		sharingViolation := syscall.Errno(32)
		calls := 0
		err := Do(func() error {
			calls++
			return sharingViolation
		})
		if !errors.Is(err, sharingViolation) {
			t.Fatalf("the retry loop lost the errno it was given: %v", err)
		}
		if runtime.GOOS == "windows" {
			if calls != attempts {
				t.Fatalf("the Windows sharing violation was attempted %d times, want the bounded %d: the retry predicate is dead, so this test's no-retry assertions prove nothing", calls, attempts)
			}
		} else if calls != 1 {
			t.Fatalf("off Windows the retry predicate is documented always-false, so errno 32 must be attempted exactly once; it was attempted %d times", calls)
		}
	})

	// WINDOWS ERRNO VOCABULARY SEAM (recorded, not a product defect today). On Windows a real disk-full
	// is ERROR_DISK_FULL (112) or ERROR_HANDLE_DISK_FULL (39), and Go's Windows `Errno.Is` maps neither
	// to syscall.ENOSPC (GOROOT/src/syscall/syscall_windows.go:189-217 maps only ErrPermission,
	// ErrExist, ErrNotExist and ErrUnsupported). Windows also has no EFBIG write failure: RLIMIT_FSIZE
	// is POSIX-only. The product branches on neither errno today, so behaviour is the same (not
	// retried, surfaced unchanged); the point of this subtest is that a FUTURE classifier written
	// against syscall.ENOSPC would be wrong on Windows, which is the same platform seam this repository
	// already records for EADDRINUSE and ECONNREFUSED (internal/app/address_in_use_windows.go:15-35).
	t.Run("windows-real-disk-full-errno-vocabulary", func(t *testing.T) {
		if runtime.GOOS != "windows" {
			t.Skipf("the ERROR_DISK_FULL vocabulary seam only exists on Windows; on %s the POSIX errno IS the kernel value", runtime.GOOS)
		}
		realWindowsDiskFull := syscall.Errno(112) // ERROR_DISK_FULL, a real Windows API status code
		if errors.Is(realWindowsDiskFull, m3DiskFullErrno) {
			t.Fatalf("ERROR_DISK_FULL(112) compares equal to syscall.ENOSPC on Windows; if that ever changes, the platform seam this subtest records is closed and this assertion must be updated deliberately")
		}
		calls := 0
		err := Do(func() error {
			calls++
			return realWindowsDiskFull
		})
		if calls != 1 {
			t.Fatalf("a real Windows disk-full status was attempted %d times; no errno class may be retried except a sharing/lock violation", calls)
		}
		if !errors.Is(err, realWindowsDiskFull) || errors.Is(err, m3DiskFullErrno) {
			t.Fatalf("the Windows disk-full status was not preserved as itself (err=%v)", err)
		}
	})
}
