//go:build windows

package main

// Windows implementation: GetProcessMemoryInfo (psapi.dll) for RSS/peak RSS and GetProcessTimes (kernel32.dll)
// for user/system CPU. Handles are opened with PROCESS_QUERY_LIMITED_INFORMATION, which is enough for both calls
// and does not require elevation. The dll/function names and struct layouts are recorded in the artifact's
// `method` field so a reader can check the source of every number.

import (
	"fmt"
	"syscall"
	"unsafe"
)

const processQueryLimitedInformation = 0x1000

type processMemoryCountersEx struct {
	Cb                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
	PrivateUsage               uintptr
}

var (
	psapi                = syscall.NewLazyDLL("psapi.dll")
	getProcessMemoryInfo = psapi.NewProc("GetProcessMemoryInfo")
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	getProcessTimes      = kernel32.NewProc("GetProcessTimes")
)

// filetimeToMilliseconds converts a FILETIME (100 ns units since 1601) to integer milliseconds.
func filetimeToMilliseconds(low, high uint32) int64 {
	ticks := (int64(high) << 32) | int64(low)
	return ticks / 10_000
}

func readProcess(pid int) (sample, error) {
	handle, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return sample{}, fmt.Errorf("OpenProcess(%d): %w", pid, err)
	}
	defer syscall.CloseHandle(handle)

	counters := processMemoryCountersEx{Cb: uint32(unsafe.Sizeof(processMemoryCountersEx{}))}
	ok, _, callErr := getProcessMemoryInfo.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(&counters)),
		uintptr(counters.Cb),
	)
	if ok == 0 {
		return sample{}, fmt.Errorf("GetProcessMemoryInfo(%d): %w", pid, callErr)
	}

	var creation, exit, kernelTime, userTime syscall.Filetime
	ok, _, callErr = getProcessTimes.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(&creation)),
		uintptr(unsafe.Pointer(&exit)),
		uintptr(unsafe.Pointer(&kernelTime)),
		uintptr(unsafe.Pointer(&userTime)),
	)
	if ok == 0 {
		return sample{}, fmt.Errorf("GetProcessTimes(%d): %w", pid, callErr)
	}

	rss := int64(counters.WorkingSetSize)
	peak := int64(counters.PeakWorkingSetSize)
	userMs := filetimeToMilliseconds(userTime.LowDateTime, userTime.HighDateTime)
	systemMs := filetimeToMilliseconds(kernelTime.LowDateTime, kernelTime.HighDateTime)
	return sample{
		OK:           true,
		Method:       "windows:psapi!GetProcessMemoryInfo(WorkingSetSize,PeakWorkingSetSize) + kernel32!GetProcessTimes(UserTime,KernelTime); PROCESS_QUERY_LIMITED_INFORMATION",
		PID:          pid,
		RSSBytes:     &rss,
		PeakRSSBytes: &peak,
		CPUUserMs:    &userMs,
		CPUSystemMs:  &systemMs,
		Handles:      nil,
		Note:         fmt.Sprintf("pageFaults=%d privateUsage=%d", counters.PageFaultCount, counters.PrivateUsage),
	}, nil
}
