//go:build !linux

package e2e

// A15 LANE B: the EFBIG (kernel write failure) gate is POSIX-only, and this file makes the skip DECLARED
// on every other host rather than silently absent.
//
// The Linux case (a15_efbig_linux_test.go) starts the shipped binary under a launcher that sets
// RLIMIT_FSIZE and ignores SIGXFSZ, so the product's own write crosses the limit and returns EFBIG -- the
// unprivileged stand-in for ENOSPC, which cannot be produced without mounting a tiny filesystem (elevation,
// forbidden by the user's directive). Windows has no RLIMIT_FSIZE/SIGXFSZ equivalent reachable without
// elevation, so the kernel-write-failure class is proven on Linux CI only; this skip names that reason.

import (
	"runtime"
	"testing"
)

func TestKernelFileSizeLimitRefusesTheSaveAndKeepsTheOldDocument(t *testing.T) {
	t.Skipf("the kernel-write-failure (EFBIG) class needs POSIX RLIMIT_FSIZE/SIGXFSZ, which this host (%s) cannot "+
		"set without elevation; the directive forbids elevation, so the case runs on Linux CI "+
		"(tests/e2e/a15_efbig_linux_test.go) and is a DECLARED skip here rather than a pass", runtime.GOOS)
}
