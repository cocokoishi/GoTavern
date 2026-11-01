//go:build windows

package fsretry

import (
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"
)

// TestReadFileRetriesARealSharingViolation proves the READ side of the tolerance with the actual Windows
// mechanism. A read-versus-read overlap is NOT a violation (both handles ask for FILE_SHARE_READ), so the
// only way to make a read fail is to hold the file with NO sharing at all: syscall.CreateFile with a zero
// share mode. That is the same shape a rename's DELETE-access handle produces for an attacker... and the
// shape a concurrent replace produces for the product, which is what this retry exists for.
//
// The fixture must be able to discriminate (AGENTS.md rule 7): the test first requires the plain
// os.ReadFile to FAIL under the exclusive handle. If it does not, the handle is not exclusive and the
// assertion below would pass for the wrong reason, so that case fails rather than skipping.
func TestReadFileRetriesARealSharingViolation(t *testing.T) {
	target := filepath.Join(t.TempDir(), "record.json")
	body := `{"ok":true}`
	if err := os.WriteFile(target, []byte(body), 0o600); err != nil {
		t.Fatalf("seed the record: %v", err)
	}
	release := holdExclusive(t, target)

	if _, err := os.ReadFile(target); err == nil {
		release()
		t.Fatalf("an exclusive handle did not make os.ReadFile fail, so this fixture cannot tell a retried " +
			"read from an ordinary one; the assertion below would be vacuous")
	}

	go func() {
		time.Sleep(30 * time.Millisecond)
		release()
	}()

	read, err := ReadFile(target)
	if err != nil {
		t.Fatalf("ReadFile did not absorb the sharing violation a concurrent replace produces: %v", err)
	}
	if string(read) != body {
		t.Fatalf("ReadFile returned %q, want %q", read, body)
	}
}

// holdExclusive opens path with no sharing allowed and returns an idempotent release. Every open of the
// file while the handle is held fails with ERROR_SHARING_VIOLATION, which is the transient class.
func holdExclusive(t *testing.T, path string) func() {
	t.Helper()
	utf16Path, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		t.Fatalf("convert %s to a Windows path: %v", path, err)
	}
	handle, err := syscall.CreateFile(
		utf16Path, syscall.GENERIC_READ, 0, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("open %s exclusively: %v", path, err)
	}
	var once sync.Once
	return func() {
		once.Do(func() { _ = syscall.CloseHandle(handle) })
	}
}
