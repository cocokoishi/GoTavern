//go:build windows

package server

import "os"

// storedRecordChangeStamp reports that Windows cannot supply the cache's
// replacement witness from the stat the read already performs.
//
// THE ACCEPTED BOUNDARY, MEASURED (M6, 2026-11-04). The cache's key is
// mtime+size plus a change witness (accounts.go). On Windows the three cheap
// candidates were tried and each failed:
//
//  1. mtime+size: the M6 test replaces a record with the same byte length and
//     restores mtime with os.Chtimes, which is the case the witness exists for;
//     a path+mtime+size key serves the old record.
//  2. file identity (os.SameFile): MEASURED to report "same file" after a real
//     temp+rename replacement, because NTFS reused the file record; identity is
//     not a replacement witness on this platform.
//  3. creation time (the field Win32FileAttributeData carries): MEASURED equal
//     after the same replacement, because Windows file-system TUNNELING
//     deliberately keeps the original creation timestamp when a file is deleted
//     and recreated under the same name within its 15-second window -- which is
//     exactly what a temp+rename over an existing record is.
//
// The only reliable Windows witness is the NTFS change time, and Go does not
// expose it in os.FileInfo: reading it needs GetFileInformationByHandleEx on an
// open handle (see nodeFileCtimeMilliseconds, characters_ctime_windows.go),
// i.e. an open+query+close on EVERY cache hit. That is the authenticated-request
// hot path the cache was introduced to keep cheap (the measured 40.4% read is
// in accounts.go), and an extra open per request spends a real part of that win
// to close a window that no production writer produces: both writers (this
// server, pinned Node's node-persist) replace records atomically, so the
// remaining gap is an external timestamp-preserving restore on Windows while
// the server is running, with a record of unchanged byte length.
//
// So the boundary is recorded, not silently accepted: on Windows a same-size,
// same-mtime external replacement is served stale until the next mtime/size
// change, cache eviction (storedAccountCacheLimit) or restart. On Unix it is
// closed by the inode change time, which the stat already carries. Revisit only
// with a measurement showing the open-handle query is cheaper than the margin
// it protects, and update this comment and the accounts.go cache comment in the
// same change.
func storedRecordChangeStamp(_ os.FileInfo) (int64, bool) {
	return 0, false
}
