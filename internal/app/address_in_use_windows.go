//go:build windows

package app

import (
	"errors"
	"syscall"

	"golang.org/x/sys/windows"
)

// isAddressInUse reports whether a listener failed because the address it was
// asked for is already bound.
//
// THE POSIX ERRNO IS THE WRONG TARGET ON WINDOWS, and matching only it was a
// user-visible divergence rather than a host quirk. A real bind conflict
// surfaces as Winsock's WSAEADDRINUSE (10048), while Go's syscall.EADDRINUSE is
// an APPLICATION_ERROR pseudo-errno (GOROOT/src/syscall/zerrors_windows.go:154)
// that no network error ever carries. Measured on Windows with a bound loopback
// port: the second net.Listen yields syscall.Errno(10048) and
// errors.Is(err, syscall.EADDRINUSE) is FALSE. The consequence is that an
// occupied port fell through to the generic
// "Failed to start server on IPv4 and IPv6 disabled" text instead of the pinned
// address-in-use classification (src/server-startup.js's
// #getAddressInUseMessage), so an operator could not tell a busy port from a
// permissions or config problem -- rule 35 makes that error part of the product
// contract. Linux CI cannot see it, because there the POSIX errno is correct.
//
// BOTH TARGETS ARE CHECKED: WSAEADDRINUSE is what a socket bind actually
// produces on Windows, and syscall.EADDRINUSE is kept so an error carrying the
// pseudo-errno (a non-network wrapper, or a future Go change) is still
// classified. errors.Is semantics are preserved -- the wrapped Winsock errno
// compares equal to the target Errno value.
func isAddressInUse(err error) bool {
	return errors.Is(err, windows.WSAEADDRINUSE) || errors.Is(err, syscall.EADDRINUSE)
}
