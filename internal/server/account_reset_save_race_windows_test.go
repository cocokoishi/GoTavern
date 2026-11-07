//go:build windows

package server

// The Windows half of the B-H4 probe's reader. Node (pinned's runtime) opens files with
// FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE, so a reader never blocks a concurrent
// rename or an os.RemoveAll. Go's os.ReadFile omits FILE_SHARE_DELETE, which makes the probe's
// OWN reader able to fail the product's os.RemoveAll with a sharing violation -- measured on
// windows/arm64: with os.ReadFile the reset answered 500 (sharing violation) until retried, and
// with this reader the same storm completes the reset on the first attempt. A probe must not
// manufacture the failure it measures (AGENTS.md verification rule 10), so the probe reads with
// the same share modes a Node reader uses.

import (
	"io"
	"os"
	"syscall"
)

func probeReadFile(path string) ([]byte, error) {
	pointer, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(pointer,
		syscall.GENERIC_READ,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.OPEN_EXISTING,
		syscall.FILE_ATTRIBUTE_NORMAL,
		0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	file := os.NewFile(uintptr(handle), path)
	if file == nil {
		_ = syscall.CloseHandle(handle)
		return nil, &os.PathError{Op: "open", Path: path, Err: os.ErrInvalid}
	}
	defer file.Close()
	return io.ReadAll(file)
}
