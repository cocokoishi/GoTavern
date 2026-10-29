//go:build windows

package server

import (
	"errors"
	"syscall"

	"golang.org/x/sys/windows"
)

// isConnectionRefused reports whether an outbound attempt failed because the
// peer actively refused the connection.
//
// THE POSIX ERRNO IS THE WRONG TARGET ON WINDOWS, and this is the second
// instance of that bug class in this tree (the first was isAddressInUse in
// internal/app). A refused connection surfaces as Winsock's WSAECONNREFUSED
// (10061), while Go's syscall.ECONNREFUSED is an APPLICATION_ERROR pseudo-errno
// (GOROOT/src/syscall/zerrors_windows.go:154) that no network error ever
// carries. Measured on Windows: dialling a closed loopback port, both directly
// and through an http.Client round trip, yields syscall.Errno(10061) and
// errors.Is(err, syscall.ECONNREFUSED) is FALSE.
//
// The pinned branch this classification feeds is
// src/endpoints/backends/chat-completions.js:2717-2721:
//
//	const message = error.code === 'ECONNREFUSED'
//	    ? `Connection refused: ${error.message}`
//	    : error.message || 'Unknown error occurred';
//
// Node maps the Winsock error to `code === 'ECONNREFUSED'` on Windows too, so
// pinned names the cause there and GoTavern did not -- a provider-facing
// divergence in the `message` member (rule 35). No CI job runs the Go suite on
// Windows, which is why it stayed invisible.
//
// BOTH TARGETS ARE CHECKED: WSAECONNREFUSED is what a socket connect actually
// produces on Windows, and syscall.ECONNREFUSED is kept so an error carrying the
// pseudo-errno (a non-network wrapper, or a future Go change) is still
// classified. errors.Is semantics are preserved.
func isConnectionRefused(err error) bool {
	return errors.Is(err, windows.WSAECONNREFUSED) || errors.Is(err, syscall.ECONNREFUSED)
}
