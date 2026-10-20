//go:build windows

package server

import (
	"os"
	"syscall"
	"unsafe"
)

// fileBasicInfo mirrors the Win32 FILE_BASIC_INFO structure.
type fileBasicInfo struct {
	CreationTime   int64
	LastAccessTime int64
	LastWriteTime  int64
	ChangeTime     int64
	FileAttributes uint32
}

const (
	fileBasicInfoClass = 0
	// Windows FILETIME epochs are 1601-01-01 in 100-nanosecond ticks.
	windowsEpochOffsetMilliseconds = 11644473600000
)

var (
	kernel32Library                  = syscall.NewLazyDLL("kernel32.dll")
	procGetFileInformationByHandleEx = kernel32Library.NewProc("GetFileInformationByHandleEx")
)

// nodeFileCtimeMilliseconds returns Node's `fs.Stats.ctimeMs`. libuv maps it to
// the NTFS change time on Windows, which is neither the creation time Go
// exposes through Win32FileAttributeData nor the last-write time, so the file
// is queried through GetFileInformationByHandleEx(FileBasicInfo).
func nodeFileCtimeMilliseconds(filePath string, _ os.FileInfo) float64 {
	file, err := os.Open(filePath)
	if err != nil {
		return 0
	}
	defer file.Close()
	var info fileBasicInfo
	result, _, _ := procGetFileInformationByHandleEx.Call(
		file.Fd(),
		uintptr(fileBasicInfoClass),
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	)
	if result == 0 {
		return 0
	}
	return float64(info.ChangeTime)/1e4 - windowsEpochOffsetMilliseconds
}
