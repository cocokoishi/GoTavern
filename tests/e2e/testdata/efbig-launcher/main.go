//go:build linux

// efbig-launcher execs a program under a kernel-enforced RLIMIT_FSIZE and with SIGXFSZ IGNORED, so the
// program's own writes past the limit return a REAL EFBIG from the kernel instead of the process being
// killed by the default SIGXFSZ disposition.
//
// It exists for the A15 lane-B disk-full class: the directive forbids elevation, so a small tmpfs cannot be
// mounted; RLIMIT_FSIZE is a per-process limit the unprivileged user may set on itself, and it exercises the
// SAME kernel write path a full disk takes (the write syscall fails and the partial bytes are what the
// product published). This is not a mock: no product code knows the launcher exists.
package main

import (
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"syscall"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: efbig-launcher LIMIT_BYTES PROGRAM [ARGS...]")
		os.Exit(2)
	}
	limit, err := strconv.ParseUint(os.Args[1], 10, 64)
	if err != nil {
		fmt.Fprintf(os.Stderr, "efbig-launcher: bad limit %q: %v\n", os.Args[1], err)
		os.Exit(2)
	}
	// An ignored disposition SURVIVES execve, so the subject inherits SIG_IGN for SIGXFSZ and gets an
	// EFBIG return from write(2) rather than being terminated when it crosses the limit.
	signal.Ignore(syscall.SIGXFSZ)
	previous := syscall.Rlimit{Cur: limit, Max: limit}
	if err := syscall.Setrlimit(syscall.RLIMIT_FSIZE, &previous); err != nil {
		fmt.Fprintf(os.Stderr, "efbig-launcher: setrlimit(RLIMIT_FSIZE, %d): %v\n", limit, err)
		os.Exit(2)
	}
	var applied syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_FSIZE, &applied); err != nil {
		fmt.Fprintf(os.Stderr, "efbig-launcher: getrlimit: %v\n", err)
		os.Exit(2)
	}
	// The proof the harness is wired: the subject's stderr carries this line, so a test can assert the
	// limit was actually applied rather than silently not reaching the process.
	fmt.Fprintf(os.Stderr, "efbig-launcher: RLIMIT_FSIZE=%d applied=%d SIGXFSZ=ignored exec=%s\n",
		limit, applied.Cur, os.Args[2])
	if err := syscall.Exec(os.Args[2], os.Args[2:], os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "efbig-launcher: exec %s: %v\n", os.Args[2], err)
		os.Exit(2)
	}
}
