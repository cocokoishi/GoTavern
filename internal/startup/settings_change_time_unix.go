//go:build !windows

package startup

import (
	"os"
	"reflect"
	"time"
)

// nodeChangeTime reads the platform's change-time field used for Node's
// Stats.ctimeMs. ModTime is a fallback for filesystems whose stat structure
// does not expose that field through Go's os.FileInfo.
func nodeChangeTime(_ string, info os.FileInfo) (time.Time, error) {
	if system := reflect.ValueOf(info.Sys()); system.IsValid() {
		if system.Kind() == reflect.Pointer {
			system = system.Elem()
		}
		if system.IsValid() && system.Kind() == reflect.Struct {
			for _, name := range []string{"Ctim", "Ctimespec"} {
				field := system.FieldByName(name)
				if !field.IsValid() || field.Kind() != reflect.Struct {
					continue
				}
				seconds := field.FieldByName("Sec")
				nanoseconds := field.FieldByName("Nsec")
				if seconds.IsValid() && nanoseconds.IsValid() && seconds.CanInt() && nanoseconds.CanInt() {
					return time.Unix(seconds.Int(), nanoseconds.Int()), nil
				}
			}
		}
	}
	return info.ModTime(), nil
}
