//go:build !windows

package coral

import (
	"os"
	"reflect"
)

func statStamp(_ string, info os.FileInfo) (fileStamp, error) {
	s := fileStamp{Size: info.Size(), Modified: info.ModTime().UnixNano(), Mode: info.Mode()}
	v := reflect.Indirect(reflect.ValueOf(info.Sys()))
	if v.Kind() != reflect.Struct {
		return s, nil
	}
	integer := func(v reflect.Value) uint64 {
		if v.CanUint() {
			return v.Uint()
		}
		if v.CanInt() {
			return uint64(v.Int())
		}
		return 0
	}
	s.Device, s.Identity = integer(v.FieldByName("Dev")), integer(v.FieldByName("Ino"))
	for _, name := range []string{"Ctim", "Ctimespec"} {
		if stamp := v.FieldByName(name); stamp.IsValid() {
			s.Changed = int64(integer(stamp.FieldByName("Sec")))*1e9 + int64(integer(stamp.FieldByName("Nsec")))
			break
		}
	}
	return s, nil
}
