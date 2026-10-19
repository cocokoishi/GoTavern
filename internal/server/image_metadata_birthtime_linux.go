//go:build linux

package server

import (
	"os"

	"golang.org/x/sys/unix"
)

func nodeFileBirthtimeMilliseconds(filePath string, _ os.FileInfo) float64 {
	var stat unix.Statx_t
	if err := unix.Statx(unix.AT_FDCWD, filePath, 0, unix.STATX_BTIME, &stat); err != nil || stat.Mask&unix.STATX_BTIME == 0 {
		return 0
	}
	return float64(stat.Btime.Sec)*1e3 + float64(stat.Btime.Nsec)/1e6
}
