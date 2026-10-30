//go:build windows

package fsretry

import (
	"errors"
	"syscall"
)

// The three Windows status codes this failure produces. They are spelled as numbers because the syscall
// package does not export all of them; they are fixed by the Windows API and are not a guess:
//
//	5  ERROR_ACCESS_DENIED     -- what a rename gets when the destination is open without FILE_SHARE_DELETE
//	32 ERROR_SHARING_VIOLATION -- what an open or rename gets while another handle holds the file
//	33 ERROR_LOCK_VIOLATION    -- a byte-range lock held by another handle
const (
	errorAccessDenied     = syscall.Errno(5)
	errorSharingViolation = syscall.Errno(32)
	errorLockViolation    = syscall.Errno(33)
)

// isTransient reports whether err is Windows refusing an operation because another handle holds the file.
func isTransient(err error) bool {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	switch errno {
	case errorSharingViolation, errorLockViolation, errorAccessDenied:
		return true
	default:
		return false
	}
}
