package startup

// Unit contract for the crash-safe chat rename (user_rename.go). The process-level crash evidence lives in
// tests/e2e/chat_crash_test.go; this test pins the properties the fix depends on: the source disappears, the
// destination carries the SAME bytes, the destination mtime is refreshed (pinned's copyFileSync creates a
// new file, and /api/chats/recent orders by mtime), a missing source is reported as (false, nil) rather than
// an error, and a relative path cannot escape the user root.

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func seedRenameTestChat(t *testing.T, dataRoot, relative string, body []byte, mtime time.Time) string {
	t.Helper()
	target := filepath.Join(dataRoot, "default-user", filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, body, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(target, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	return target
}

func TestRenameUserContentFileMovesTheFileAndRefreshesTheMtime(t *testing.T) {
	dataRoot := t.TempDir()
	body := []byte("{\"user_name\":\"User\"}\n{\"mes\":\"kept bytes\"}")
	oldRelative := "chats/RenameCard/chat.jsonl"
	newRelative := "chats/RenameCard/chat-renamed.jsonl"
	seedRenameTestChat(t, dataRoot, oldRelative, body, time.Unix(1600000000, 0))

	renamed, err := RenameUserContentFile(dataRoot, "default-user", oldRelative, newRelative)
	if err != nil {
		t.Fatalf("RenameUserContentFile: %v", err)
	}
	if !renamed {
		t.Fatalf("RenameUserContentFile reported the source missing although it was seeded")
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "default-user", filepath.FromSlash(oldRelative))); !os.IsNotExist(err) {
		t.Fatalf("the OLD name still exists after an atomic rename (stat error: %v)", err)
	}
	newPath := filepath.Join(dataRoot, "default-user", filepath.FromSlash(newRelative))
	got, err := os.ReadFile(newPath)
	if err != nil {
		t.Fatalf("read the renamed file: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Fatalf("the renamed file did not carry the source bytes: got %q", got)
	}
	info, err := os.Stat(newPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.ModTime().Before(time.Now().Add(-2 * time.Minute)) {
		t.Fatalf("the renamed file kept the source mtime %v; pinned's copyFileSync creates a new file, and "+
			"/api/chats/recent orders by mtime, so a rename must refresh it", info.ModTime())
	}
}

func TestRenameUserContentFileReportsAMissingSourceWithoutAnError(t *testing.T) {
	dataRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataRoot, "default-user", "chats", "Card"), 0o777); err != nil {
		t.Fatal(err)
	}
	renamed, err := RenameUserContentFile(dataRoot, "default-user", "chats/Card/missing.jsonl", "chats/Card/renamed.jsonl")
	if err != nil {
		t.Fatalf("a missing source returned an error: %v", err)
	}
	if renamed {
		t.Fatalf("a missing source was reported as renamed")
	}
}

func TestRenameUserContentFileRefusesAPathOutsideTheUserRoot(t *testing.T) {
	dataRoot := t.TempDir()
	seedRenameTestChat(t, dataRoot, "chats/Card/chat.jsonl", []byte("x"), time.Now())
	for _, destination := range []string{"../escaped.jsonl", "chats/../../escaped.jsonl"} {
		if _, err := RenameUserContentFile(dataRoot, "default-user", "chats/Card/chat.jsonl", destination); err == nil {
			t.Fatalf("the destination %q was accepted outside the user root", destination)
		}
	}
	if entries, err := os.ReadDir(dataRoot); err == nil {
		for _, entry := range entries {
			if strings.Contains(entry.Name(), "escaped") {
				t.Fatalf("a refused rename created %q outside the user root", entry.Name())
			}
		}
	}
}
