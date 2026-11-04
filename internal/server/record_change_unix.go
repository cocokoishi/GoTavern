//go:build !windows

package server

import (
	"os"
	"reflect"
)

// storedRecordChangeStamp returns the inode change time of info as nanoseconds
// since the Unix epoch. It is the cache's replacement witness (accounts.go):
// the kernel moves the inode's change time on every write and metadata change,
// including the temp+rename that both writers of an account record use, and an
// unprivileged process cannot set it back (os.Chtimes sets mtime, which moves
// ctime again).
//
// It performs NO syscall: the os.Stat that produced info already carries this
// field. The field name differs between syscall structs (Linux: Ctim; the BSDs
// and darwin: Ctimespec) and both are a {Sec, Nsec} pair, so it is located
// reflectively exactly like nodeFileCtimeMilliseconds (characters_ctime_other.go)
// does for the same reason.
func storedRecordChangeStamp(info os.FileInfo) (int64, bool) {
	value := reflect.ValueOf(info.Sys())
	if value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return 0, false
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Struct {
		return 0, false
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
		sec, ok := changeStampSignedInteger(seconds)
		if !ok {
			continue
		}
		nsec, ok := changeStampSignedInteger(nanoseconds)
		if !ok {
			continue
		}
		return sec*1e9 + nsec, true
	}
	return 0, false
}

func changeStampSignedInteger(value reflect.Value) (int64, bool) {
	switch value.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return value.Int(), true
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return int64(value.Uint()), true
	default:
		return 0, false
	}
}
