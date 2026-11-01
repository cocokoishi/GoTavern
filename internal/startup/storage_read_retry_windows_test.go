//go:build windows

package startup

// THE TWO NODE-PERSIST READS THAT WERE STILL BARE os.ReadFile, AND THE DETERMINISTIC PROOF THAT THEY NOW
// SURVIVE THE WINDOWS SHARING VIOLATION A CONCURRENT REPLACE PRODUCES.
//
// docs/data-safety.md (§7.1/§9 item 9) recorded UpdateNodePersistRecord's read-before-write and
// NodePersistKeys as the remaining bare reads after the account-record read path was fixed. The failure
// class: Go's os.Open asks Windows for FILE_SHARE_READ|FILE_SHARE_WRITE but not FILE_SHARE_DELETE, so a
// read that overlaps a rename replacing the same record fails with "The process cannot access the file
// because it is being used by another process"; Node shares all three modes, so pinned never sees it.
//
// These tests hold a real exclusive handle on the record (syscall.CreateFile with a zero share mode) and
// require the product read to succeed AFTER the handle is released, within fsretry's bounded ~200 ms.
// Discrimination is asserted first: the same plain os.ReadFile must fail under the handle, else the test
// would pass for the wrong reason.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestUpdateNodePersistRecordAbsorbsATransientSharingViolation(t *testing.T) {
	dataRoot := t.TempDir()
	const key = "user:retry-update"
	if err := SetNodePersistRecord(dataRoot, key, json.RawMessage(`{"name":"old"}`)); err != nil {
		t.Fatalf("seed the record: %v", err)
	}
	target := filepath.Join(dataRoot, storageFolder, storeFilename(key))

	release := holdExclusiveTestFile(t, target)
	if _, err := os.ReadFile(target); err == nil {
		release()
		t.Fatalf("an exclusive handle did not make os.ReadFile fail, so this fixture cannot discriminate")
	}
	go func() {
		time.Sleep(30 * time.Millisecond)
		release()
	}()

	err := UpdateNodePersistRecord(dataRoot, key, func(current json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"name":"new"}`), nil
	})
	if err != nil {
		t.Fatalf("UpdateNodePersistRecord did not absorb the transient sharing violation: %v", err)
	}
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read the updated record: %v", err)
	}
	if !strings.Contains(string(body), `"new"`) {
		t.Fatalf("the record was not updated after the retry: %s", body)
	}
}

func TestNodePersistKeysAbsorbsATransientSharingViolation(t *testing.T) {
	dataRoot := t.TempDir()
	const key = "user:retry-keys"
	if err := SetNodePersistRecord(dataRoot, key, json.RawMessage(`{"name":"value"}`)); err != nil {
		t.Fatalf("seed the record: %v", err)
	}
	target := filepath.Join(dataRoot, storageFolder, storeFilename(key))

	release := holdExclusiveTestFile(t, target)
	if _, err := os.ReadFile(target); err == nil {
		release()
		t.Fatalf("an exclusive handle did not make os.ReadFile fail, so this fixture cannot discriminate")
	}
	go func() {
		time.Sleep(30 * time.Millisecond)
		release()
	}()

	keys, err := NodePersistKeys(dataRoot, "user:")
	if err != nil {
		t.Fatalf("NodePersistKeys did not absorb the transient sharing violation: %v", err)
	}
	found := false
	for _, candidate := range keys {
		if candidate == key {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("NodePersistKeys did not list %q after the retry: %v", key, keys)
	}
}

// holdExclusiveTestFile opens path with no sharing allowed and returns an idempotent release.
func holdExclusiveTestFile(t *testing.T, path string) func() {
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
