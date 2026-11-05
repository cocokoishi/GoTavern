//go:build linux

package e2e

// A15 LANE B: READ-ONLY DIRECTORY (Linux only -- the case this build tag exists for).
//
// GOAL §14 item 5 names a read-only directory as one of the failure modes that must leave data parseable
// and recoverable. POSIX mode bits make that reproducible without root: chmod 0555 on the user's directory
// turns every create/rename inside it into EACCES, which is the same code path a mounted read-only volume
// or a full disk takes. On Windows the equivalent requires ACLs that the CI user does not own, so the case
// is DECLARED SKIPPED there by this build tag rather than passing silently (the Windows half is covered by
// reading the Windows-sharing retry tests and by the crash matrix).
//
// THE ASSERTION IS THE BYTES: a refused write must leave the previous settings byte-identical, must not
// create a scratch file visible as user data, and must name the failure to the caller; removing the write
// bit must not poison later writes (chmod back -> the next save succeeds and stores the new document).

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadOnlyUserDirectoryRefusesTheWriteAndThenRecovers(t *testing.T) {
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(userRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(userRoot, "settings.json")
	oldSettings := []byte(`{"marker":"READ-ONLY-OLD"}`)
	if err := os.WriteFile(settingsPath, oldSettings, 0o600); err != nil {
		t.Fatal(err)
	}

	server := bootServerIn(t, installRoot, installRoot, dataRoot, nil)
	client := openSession(t, server.origin)

	// Sanity: the same save succeeds while the directory is writable, so the refusal below is caused by the
	// mode change and not by a broken route/session.
	if status, _, body := client.postJSON(t, "/api/settings/save", `{"marker":"READ-ONLY-PRE"}`); status != 200 {
		t.Fatalf("control settings/save on the writable tree = %d: %s", status, truncateForLog(body, 300))
	}
	beforeRefusal, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}

	if err := os.Chmod(userRoot, 0o555); err != nil {
		t.Fatalf("make the user directory read-only: %v", err)
	}
	restored := false
	defer func() {
		if !restored {
			_ = os.Chmod(userRoot, 0o777)
		}
	}()

	status, _, body := client.postJSON(t, "/api/settings/save", `{"marker":"READ-ONLY-REFUSED"}`)
	if status == 200 {
		t.Fatalf("settings/save REPORTED SUCCESS while the user directory was read-only; the write cannot have "+
			"landed, so success is a lie: %s", truncateForLog(body, 300))
	}
	afterRefusal, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("read settings after the refused write: %v", err)
	}
	if string(afterRefusal) != string(beforeRefusal) {
		t.Fatalf("a REFUSED write changed settings.json.\n  before: %q\n  after:  %q",
			truncateForLog(string(beforeRefusal), 200), truncateForLog(string(afterRefusal), 200))
	}
	// A failed atomic write must not leave a scratch file that a directory listing would show as user data.
	for _, entry := range mustReadDirEntries(t, userRoot) {
		if entry.IsDir() {
			continue
		}
		if strings.HasPrefix(entry.Name(), ".gotavern-content-log-") {
			continue // dot-prefixed and clearly identified as scratch: allowed, and it cannot be a settings file
		}
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("the refused write left a NON-dot scratch file %q in the user directory", entry.Name())
		}
	}

	// RECOVERY: restoring the write bit must let the next save store the new document.
	if err := os.Chmod(userRoot, 0o777); err != nil {
		t.Fatalf("restore the user directory mode: %v", err)
	}
	restored = true
	status, _, body = client.postJSON(t, "/api/settings/save", `{"marker":"READ-ONLY-RECOVERED"}`)
	if status != 200 {
		t.Fatalf("settings/save after restoring the directory mode = %d: %s", status, truncateForLog(body, 300))
	}
	recoveredBody, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(recoveredBody), "READ-ONLY-RECOVERED") {
		t.Fatalf("the recovered write did not store the new settings: %s", truncateForLog(string(recoveredBody), 300))
	}
}
