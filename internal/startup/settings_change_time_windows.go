//go:build windows

package startup

import (
	"os"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// fileBasicInfo mirrors FILE_BASIC_INFO from fileapi.h. Windows exposes the
// ChangeTime through GetFileInformationByHandleEx rather than os.FileInfo.
type fileBasicInfo struct {
	CreationTime   int64
	LastAccessTime int64
	LastWriteTime  int64
	ChangeTime     int64
	FileAttributes uint32
	Padding        uint32
}

func nodeChangeTime(path string, _ os.FileInfo) (time.Time, error) {
	file, err := os.Open(path)
	if err != nil {
		return time.Time{}, err
	}
	defer file.Close()

	connection, err := file.SyscallConn()
	if err != nil {
		return time.Time{}, err
	}
	var basic fileBasicInfo
	var queryErr error
	if err := connection.Control(func(handle uintptr) {
		queryErr = windows.GetFileInformationByHandleEx(
			windows.Handle(handle),
			windows.FileBasicInfo,
			(*byte)(unsafe.Pointer(&basic)),
			uint32(unsafe.Sizeof(basic)),
		)
	}); err != nil {
		return time.Time{}, err
	}
	if queryErr != nil {
		return time.Time{}, queryErr
	}

	// FILETIME is a count of 100 ns intervals since 1601-01-01 UTC.
	seconds := basic.ChangeTime / 10_000_000
	nanoseconds := (basic.ChangeTime % 10_000_000) * 100
	return time.Unix(seconds-11_644_473_600, nanoseconds), nil
}
