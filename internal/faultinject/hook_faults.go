//go:build gotavern_faults

package faultinject

// The TEST-ONLY side of the crash seam. It is compiled into a binary only with `-tags gotavern_faults`;
// the production build has no hook at all (faultinject.go).
//
// GOTAVERN_FAULT_AT names the label to crash at; GOTAVERN_FAULT_ARM names a file whose existence arms the
// seam. The process exits with code 137, which is the conventional 128+SIGKILL, because that is exactly the
// state a hard kill leaves: no deferred cleanup, no flush, no lock release. (Go cannot send SIGKILL to
// itself portably; os.Exit has the same consequence for the file system: nothing in this process runs
// again.)

import (
	"os"
	"strings"
)

func init() {
	target := strings.TrimSpace(os.Getenv("GOTAVERN_FAULT_AT"))
	if target == "" {
		return
	}
	armPath := strings.TrimSpace(os.Getenv("GOTAVERN_FAULT_ARM"))
	hook = func(label string) {
		if label != target {
			return
		}
		if armPath == "" {
			return
		}
		if _, err := os.Stat(armPath); err != nil {
			return
		}
		os.Exit(137)
	}
}
