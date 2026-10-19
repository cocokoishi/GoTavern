//go:build windows

package server

import (
	"os"
	"syscall"
)

func nodeFileBirthtimeMilliseconds(_ string, fileInfo os.FileInfo) float64 {
	attributes, ok := fileInfo.Sys().(*syscall.Win32FileAttributeData)
	if !ok {
		return 0
	}
	return float64(attributes.CreationTime.Nanoseconds()) / 1e6
}
