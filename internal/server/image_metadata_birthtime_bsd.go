//go:build darwin || dragonfly || freebsd || netbsd || openbsd

package server

import (
	"os"
	"reflect"
)

func nodeFileBirthtimeMilliseconds(_ string, fileInfo os.FileInfo) float64 {
	value := reflect.ValueOf(fileInfo.Sys())
	if value.Kind() == reflect.Pointer {
		value = value.Elem()
	}
	if value.Kind() != reflect.Struct {
		return 0
	}
	for _, name := range []string{"Birthtimespec", "Birthtime"} {
		birthtime := value.FieldByName(name)
		if !birthtime.IsValid() {
			continue
		}
		if birthtime.Type().PkgPath() == "time" && birthtime.MethodByName("UnixMilli").IsValid() {
			return float64(birthtime.MethodByName("UnixMilli").Call(nil)[0].Int())
		}
		if birthtime.Kind() == reflect.Struct {
			seconds := birthtime.FieldByName("Sec")
			nanoseconds := birthtime.FieldByName("Nsec")
			if !seconds.IsValid() {
				seconds = birthtime.FieldByName("Tv_sec")
			}
			if !nanoseconds.IsValid() {
				nanoseconds = birthtime.FieldByName("Tv_nsec")
			}
			if seconds.IsValid() && nanoseconds.IsValid() {
				return reflectedInteger(seconds)*1e3 + reflectedInteger(nanoseconds)/1e6
			}
		}
	}
	return 0
}

func reflectedInteger(value reflect.Value) float64 {
	switch value.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return float64(value.Int())
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return float64(value.Uint())
	default:
		return 0
	}
}
