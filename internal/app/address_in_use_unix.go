//go:build !windows

package app

import (
	"errors"
	"syscall"
)

// isAddressInUse reports whether a listener failed because the address it was
// asked for is already bound. On POSIX systems the bind conflict IS
// syscall.EADDRINUSE, so this needs no platform-specific errno. The Windows
// seam exists because its Winsock error (10048) is a different value that
// syscall.EADDRINUSE never matches -- see address_in_use_windows.go for the
// measurement.
func isAddressInUse(err error) bool {
	return errors.Is(err, syscall.EADDRINUSE)
}
