// a15-procstat: sample the RESOURCE FACTS of one running process, as JSON.
//
// WHY A HELPER AND NOT A SHELL TRICK. GOAL 15.2 requires CPU user+system time, steady RSS and PEAK RSS per subject.
// On Linux those live in /proc/<pid>/{status,stat}; on Windows they live behind GetProcessMemoryInfo and
// GetProcessTimes. PowerShell's Add-Type can call them, but spawning PowerShell per sample is tens of
// milliseconds of wrapper inside the measurement, and this lane's brief forbids measuring the measurement wrapper.
// A ~2 MB Go helper that prints one JSON line per call keeps the sample cheap and the METHOD explicit in the
// artifact: the fields are named after the Windows API fields they come from.
//
// USAGE
//
//	a15-procstat --pid <pid>            one sample: {ok, pid, rssBytes, peakRssBytes, cpuUserMs, cpuSystemMs, ...}
//	a15-procstat --pid <pid> --wait     same, but exit 3 if the process is gone (the sampler's stop condition)
//
// FIELD SEMANTICS (reported with every artifact, not implied):
//
//	rssBytes       Windows WorkingSetSize        | Linux VmRSS
//	peakRssBytes   Windows PeakWorkingSetSize    | Linux VmHWM      (peak since process start)
//	cpuUserMs      Windows GetProcessTimes UserTime  | Linux utime + cutime? NO: utime only, see below
//	cpuSystemMs    Windows GetProcessTimes KernelTime| Linux stime
//
// Linux: /proc/<pid>/stat fields 14/15 are utime/stime in clock ticks; we convert with USER_HZ (100 on every
// Linux this project measures). Child time (cutime/cstime) is deliberately EXCLUDED on both platforms: the
// subjects spawn no long-lived children during the measured window, and including them would splice another
// process's CPU into the product's number.
//
// EXIT CODES: 0 sample written; 2 usage; 3 process gone or unreadable.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
)

type sample struct {
	OK           bool   `json:"ok"`
	Method       string `json:"method"`
	PID          int    `json:"pid"`
	RSSBytes     *int64 `json:"rssBytes"`
	PeakRSSBytes *int64 `json:"peakRssBytes"`
	CPUUserMs    *int64 `json:"cpuUserMs"`
	CPUSystemMs  *int64 `json:"cpuSystemMs"`
	Error        string `json:"error,omitempty"`
	// Threads/goroutines/handles are best-effort context; null when the platform does not expose them cheaply.
	Handles *int64 `json:"handles"`
	Note    string `json:"note,omitempty"`
}

func emit(value sample) {
	encoded, err := json.Marshal(value)
	if err != nil {
		fmt.Fprintf(os.Stderr, "a15-procstat: encode: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(string(encoded))
}

func main() {
	pid := flag.Int("pid", 0, "process id to sample")
	wait := flag.Bool("wait", false, "exit 3 when the process is gone instead of printing an empty sample")
	flag.Parse()
	if *pid <= 0 {
		fmt.Fprintln(os.Stderr, "usage: a15-procstat --pid <pid> [--wait]")
		os.Exit(2)
	}
	value, err := readProcess(*pid)
	if err != nil {
		if *wait {
			emit(sample{OK: false, PID: *pid, Error: err.Error()})
			os.Exit(3)
		}
		emit(sample{OK: false, PID: *pid, Error: err.Error()})
		os.Exit(3)
	}
	emit(value)
}
