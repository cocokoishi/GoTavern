//go:build !windows

package server

import (
	"errors"
	"syscall"
)

// isConnectionRefused reports whether an outbound attempt failed because the
// peer actively refused the connection. On POSIX systems the refusal IS
// syscall.ECONNREFUSED, so this is semantically identical to the expression it
// replaces and no Linux behaviour moves. The Windows seam exists because its
// Winsock error (10061) is a different value that syscall.ECONNREFUSED never
// matches -- see connection_refused_windows.go for the measurement and the
// pinned citation.
func isConnectionRefused(err error) bool {
	return errors.Is(err, syscall.ECONNREFUSED)
}
