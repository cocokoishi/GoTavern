//go:build linux

package main

// Linux implementation: /proc/<pid>/status for VmRSS/VmHWM and /proc/<pid>/stat for utime/stime.
// utime/stime are in USER_HZ clock ticks; USER_HZ is 100 on every Linux this project measures, and the constant is
// named here rather than hidden in a conversion at the call site.

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

const linuxUserHz = 100

func readProcess(pid int) (sample, error) {
	statusBytes, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return sample{}, fmt.Errorf("read /proc/%d/status: %w", pid, err)
	}
	var rss, peak *int64
	for _, line := range strings.Split(string(statusBytes), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "VmRSS:":
			if len(fields) >= 2 {
				if kb, convErr := strconv.ParseInt(fields[1], 10, 64); convErr == nil {
					value := kb * 1024
					rss = &value
				}
			}
		case "VmHWM:":
			if len(fields) >= 2 {
				if kb, convErr := strconv.ParseInt(fields[1], 10, 64); convErr == nil {
					value := kb * 1024
					peak = &value
				}
			}
		}
	}
	if rss == nil {
		return sample{}, fmt.Errorf("/proc/%d/status has no VmRSS", pid)
	}

	statBytes, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return sample{}, fmt.Errorf("read /proc/%d/stat: %w", pid, err)
	}
	// Field 2 (comm) can contain spaces and parentheses, so split after the LAST ')': the numeric fields follow.
	text := string(statBytes)
	close := strings.LastIndex(text, ")")
	if close < 0 || close+2 >= len(text) {
		return sample{}, fmt.Errorf("/proc/%d/stat is malformed", pid)
	}
	fields := strings.Fields(text[close+2:])
	// After comm, field 3 is state; utime is field 14 and stime field 15 -> indexes 11 and 12 in this slice.
	if len(fields) < 13 {
		return sample{}, fmt.Errorf("/proc/%d/stat has %d fields after comm", pid, len(fields))
	}
	userTicks, err := strconv.ParseInt(fields[11], 10, 64)
	if err != nil {
		return sample{}, fmt.Errorf("/proc/%d/stat utime: %w", pid, err)
	}
	systemTicks, err := strconv.ParseInt(fields[12], 10, 64)
	if err != nil {
		return sample{}, fmt.Errorf("/proc/%d/stat stime: %w", pid, err)
	}
	userMs := userTicks * 1000 / linuxUserHz
	systemMs := systemTicks * 1000 / linuxUserHz
	return sample{
		OK:           true,
		Method:       "linux:/proc/<pid>/status(VmRSS,VmHWM) + /proc/<pid>/stat(utime,stime,USER_HZ=100); child time excluded",
		PID:          pid,
		RSSBytes:     rss,
		PeakRSSBytes: peak,
		CPUUserMs:    &userMs,
		CPUSystemMs:  &systemMs,
	}, nil
}
