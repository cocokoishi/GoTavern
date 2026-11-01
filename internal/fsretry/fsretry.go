// Package fsretry retries a filesystem operation that failed only because another handle or process held
// the same file for a moment.
//
// WHY THIS EXISTS. Go's `os.Open` asks Windows for FILE_SHARE_READ|FILE_SHARE_WRITE but NOT
// FILE_SHARE_DELETE, so while one goroutine (or another process) has a file open, Windows refuses to
// rename over it AND refuses to open it during that window. Node -- the runtime this project is a drop-in
// replacement for -- opens with all three share modes, so pinned Node does not have this failure mode at
// all. That makes it a REAL compatibility difference rather than a Go inconvenience: measured on
// windows/arm64 on 2026-10-29, a request that read the user record at the moment another request replaced
// it failed with "The process cannot access the file because it is being used by another process", while
// pinned would have answered normally.
//
// WHAT IT IS NOT. This is a tolerance for a millisecond-scale overlap, not a lock and not a retry-until-
// success loop: the operation is attempted a bounded number of times over ~200 ms and the last error is
// returned. A file held open for longer still fails, and that is the honest outcome -- masking it would
// turn a lock problem into a silent stall.
package fsretry

import (
	"os"
	"time"
)

const (
	// attempts and delay bound the total tolerance at about 200 ms: long enough for a reader to finish a
	// small JSON document, short enough that a genuinely stuck handle fails a request instead of hanging it.
	attempts = 20
	delay    = 10 * time.Millisecond
)

// Do runs operation, retrying only while it fails with a transient sharing/lock violation. On platforms
// where such a violation cannot occur, isTransient is always false and the operation runs exactly once, so
// Unix behaviour is byte-for-byte what it was before this package existed.
func Do(operation func() error) error {
	err := operation()
	for attempt := 1; attempt < attempts && err != nil && isTransient(err); attempt++ {
		time.Sleep(delay)
		err = operation()
	}
	return err
}

// ReadFile is os.ReadFile with the same bounded tolerance for a transient sharing/lock violation that Do
// gives a write. It exists because the READ side of a replace needs the tolerance too: the package comment
// above describes a request that read a user record at the moment another request replaced it and failed
// with "The process cannot access the file because it is being used by another process" -- the rename
// already retried, the read did not.
//
// WHERE IT MUST NOT BE USED: nowhere off Windows needs it, and it is not a replacement for the user-state
// locks. It belongs on a read of one small file that another request may be replacing atomically.
func ReadFile(path string) ([]byte, error) {
	var body []byte
	err := Do(func() error {
		read, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		body = read
		return nil
	})
	if err != nil {
		return nil, err
	}
	return body, nil
}
