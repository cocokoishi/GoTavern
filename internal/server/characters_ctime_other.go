//go:build !windows

package server

import (
	"os"
	"reflect"
)

// nodeFileCtimeMilliseconds returns Node's `fs.Stats.ctimeMs` for a file. On
// POSIX platforms libuv maps it to the inode change time, which Go exposes as
// the Stat_t Ctim/Ctimespec field. The field name differs between the BSD and
// Linux syscall structs, so it is located reflectively.
func nodeFileCtimeMilliseconds(_ string, fileInfo os.FileInfo) float64 {
	value := reflect.ValueOf(fileInfo.Sys())
	if value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return 0
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Struct {
		return 0
	}
	for _, name := range []string{"Ctim", "Ctimespec"} {
		field := value.FieldByName(name)
		if !field.IsValid() || field.Kind() != reflect.Struct {
			continue
		}
		seconds := field.FieldByName("Sec")
		nanoseconds := field.FieldByName("Nsec")
		if !seconds.IsValid() || !nanoseconds.IsValid() {
			continue
		}
		return reflectedSignedInteger(seconds)*1e3 + reflectedSignedInteger(nanoseconds)/1e6
	}
	return 0
}

func reflectedSignedInteger(value reflect.Value) float64 {
	switch value.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return float64(value.Int())
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return float64(value.Uint())
	default:
		return 0
	}
}
