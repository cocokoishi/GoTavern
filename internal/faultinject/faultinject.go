// Package faultinject is the named crash seam the process-level write-atomicity tests use.
//
// WHAT IT IS FOR. A kill during a write can only be judged by where it lands, so the tests need to stop the
// process at EXACT points (after the temp file is written, after fsync, after the rename, between the two
// steps of a multi-file operation). Timing sleeps sample those points by luck; this seam samples them by
// name. See tests/e2e/chat_crash_test.go.
//
// A PRODUCTION BUILD HAS NO HOOK. hook is nil unless the binary was compiled with `-tags gotavern_faults`,
// so Hit is one nil check and no environment variable, file or signal can make a shipped binary crash.
// The tagged file (hook_faults.go) installs a hook that exits the process at a named label when the
// GOTAVERN_FAULT_AT variable names it AND the file named by GOTAVERN_FAULT_ARM exists. The arming file is
// what keeps STARTUP atomic writes from crashing the boot: the test arms the fault only after readiness.
package faultinject

var hook func(label string)

// Hit reports a named point in a write sequence to the test hook, if one is installed.
func Hit(label string) {
	if hook != nil {
		hook(label)
	}
}
