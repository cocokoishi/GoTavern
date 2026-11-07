//go:build !windows

package server

// The POSIX half of the B-H4 probe's reader. On Unix, unlink of an open file always succeeds, so
// os.ReadFile is already as tolerant of a concurrent remove/rename as Node's reader; no
// platform-specific open flags are needed.

import "os"

func probeReadFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}
