package coral

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ChangeTime detects same-size edits even when another editor restores mtime.
func statStamp(filename string, info os.FileInfo) (fileStamp, error) {
	name, err := windows.UTF16PtrFromString(filename)
	if err != nil {
		return fileStamp{}, err
	}
	h, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return fileStamp{}, err
	}
	defer windows.CloseHandle(h)
	var basic struct {
		Creation, Access, Write, Change int64
		Attributes                      uint32
		Padding                         uint32
	}
	if err = windows.GetFileInformationByHandleEx(h, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
		return fileStamp{}, err
	}
	var identity windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(h, &identity); err != nil {
		return fileStamp{}, err
	}
	if basic.Attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fileStamp{}, fail(400, "不允许访问符号链接")
	}
	return fileStamp{Size: info.Size(), Modified: basic.Write, Changed: basic.Change, Device: uint64(identity.VolumeSerialNumber), Identity: uint64(identity.FileIndexHigh)<<32 | uint64(identity.FileIndexLow), Mode: info.Mode()}, nil
}
