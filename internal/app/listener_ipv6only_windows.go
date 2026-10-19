//go:build windows

package app

import (
	"syscall"

	"golang.org/x/sys/windows"
)

func setIPv6Only(network, _ string, connection syscall.RawConn) error {
	if network != "tcp6" {
		return nil
	}
	var optionError error
	if err := connection.Control(func(fd uintptr) {
		optionError = windows.SetsockoptInt(windows.Handle(fd), windows.IPPROTO_IPV6, windows.IPV6_V6ONLY, 1)
	}); err != nil {
		return err
	}
	return optionError
}
