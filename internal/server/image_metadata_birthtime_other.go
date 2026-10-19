//go:build !windows && !linux && !darwin && !dragonfly && !freebsd && !netbsd && !openbsd

package server

import "os"

func nodeFileBirthtimeMilliseconds(_ string, _ os.FileInfo) float64 { return 0 }
