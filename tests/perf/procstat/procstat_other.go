//go:build !windows && !linux

package main

// Stub for platforms this project does not measure product CPU/RSS on. It returns a NULL sample WITH THE REASON
// instead of a zero, so an artifact can never record "0 MB" for an unmeasured platform.

import "fmt"

func readProcess(pid int) (sample, error) {
	return sample{}, fmt.Errorf("a15-procstat has no process-memory/CPU reader for this GOOS; the measurement is UNMEASURED here, not zero (pid %d)", pid)
}
