package server

// A CHARACTER RENAME COPIES A CHATS DIRECTORY AND THEN DELETES THE ORIGINAL. THE COPY MUST BE
// ALL-OR-NOTHING, because the handler's retry path trusts the destination's existence.
//
// The measured hazard this file guards: the character-rename handler (characters_write.go) copies
// `chats/<old>` to `chats/<new>` and then removes the old directory. With a direct recursive copy,
// a failure halfway through (crash, full disk, unreadable file) leaves a PARTIAL `chats/<new>`.
// The handler answers 500 and keeps the old directory, but `chats/<new>` survives. On the retry
// the handler's `os.Stat(newChatsPath)` guard sees it, skips the copy, and `os.RemoveAll(oldChatsPath)`
// then deletes the complete original: the user's history is silently replaced by the partial copy.
//
// `copyDirectoryAtomically` stages the copy in a hidden sibling directory and publishes it with a
// single rename, so an interrupted copy leaves the destination ABSENT and the retry copies again.
// The injected failure is at the per-file step (`copyTreeFile`), which is the place a real crash or
// a disk-full write lands; it is not simulated with a sleep or a killed process.

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func TestCopyDirectoryAtomicallyPublishesNothingWhenTheCopyFailsMidway(t *testing.T) {
	root := t.TempDir()
	dataRoot := filepath.Join(root, "data")
	installRoot := filepath.Join(root, "install")
	directories := ensureDataSafetyUserTree(t, dataRoot, installRoot)

	source := filepath.Join(directories["chats"], "Old Card")
	destination := filepath.Join(directories["chats"], "New Card")
	writeDataSafetyFile(t, filepath.Join(source, "first.jsonl"), `{"mes":"first"}`)
	writeDataSafetyFile(t, filepath.Join(source, "second.jsonl"), `{"mes":"second"}`)
	writeDataSafetyFile(t, filepath.Join(source, "third.jsonl"), `{"mes":"third"}`)

	original := copyTreeFile
	t.Cleanup(func() { copyTreeFile = original })
	copied := 0
	copyTreeFile = func(sourcePath, destinationPath string, mode os.FileMode) error {
		copied++
		if copied == 2 {
			return errors.New("injected crash: mid-copy write failed")
		}
		return original(sourcePath, destinationPath, mode)
	}

	if err := copyDirectoryAtomically(source, destination); err == nil {
		t.Fatal("the copy reported success even though an injected mid-copy failure stopped it")
	}
	if copied < 2 {
		t.Fatalf("the injected failure fired after %d file copies, so the test did not reach the "+
			"half-written state it exists to create", copied)
	}
	if _, err := os.Stat(destination); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("an interrupted copy PUBLISHED a destination tree at %s (stat error %v). "+
			"A partial tree here is what makes the next rename delete the complete original.", destination, err)
	}
	assertNoCopyStagingDirectories(t, filepath.Dir(destination))
	assertDataSafetyDirectory(t, source, map[string]string{
		"first.jsonl":  `{"mes":"first"}`,
		"second.jsonl": `{"mes":"second"}`,
		"third.jsonl":  `{"mes":"third"}`,
	})

	copyTreeFile = original
	if err := copyDirectoryAtomically(source, destination); err != nil {
		t.Fatalf("the retry after an interrupted copy failed: %v", err)
	}
	assertDataSafetyDirectory(t, destination, map[string]string{
		"first.jsonl":  `{"mes":"first"}`,
		"second.jsonl": `{"mes":"second"}`,
		"third.jsonl":  `{"mes":"third"}`,
	})
	assertNoCopyStagingDirectories(t, filepath.Dir(destination))
}

func TestCopyDirectoryAtomicallyRefusesAnExistingDestinationWithoutTouchingIt(t *testing.T) {
	root := t.TempDir()
	directories := ensureDataSafetyUserTree(t, filepath.Join(root, "data"), filepath.Join(root, "install"))

	source := filepath.Join(directories["chats"], "Old Card")
	destination := filepath.Join(directories["chats"], "New Card")
	writeDataSafetyFile(t, filepath.Join(source, "chat.jsonl"), `{"mes":"old"}`)
	writeDataSafetyFile(t, filepath.Join(destination, "chat.jsonl"), `{"mes":"existing"}`)

	if err := copyDirectoryAtomically(source, destination); err == nil {
		t.Fatal("copyDirectoryAtomically overwrote an existing destination")
	}
	assertDataSafetyDirectory(t, destination, map[string]string{"chat.jsonl": `{"mes":"existing"}`})
}

func ensureDataSafetyUserTree(t *testing.T, dataRoot, installRoot string) map[string]string {
	t.Helper()
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	return directories
}

func writeDataSafetyFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func assertDataSafetyDirectory(t *testing.T, directory string, want map[string]string) {
	t.Helper()
	names := make([]string, 0, len(want))
	for name := range want {
		names = append(names, name)
	}
	sort.Strings(names)
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read %s: %v", directory, err)
	}
	got := make(map[string]string, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			got[entry.Name()] = "<directory>"
			continue
		}
		body, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		got[entry.Name()] = string(body)
	}
	if len(got) != len(want) {
		t.Fatalf("directory %s holds %v, want exactly %v", directory, got, want)
	}
	for name, body := range want {
		if got[name] != body {
			t.Fatalf("file %s in %s = %q, want %q", name, directory, got[name], body)
		}
	}
}

func assertNoCopyStagingDirectories(t *testing.T, parent string) {
	t.Helper()
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatalf("read %s: %v", parent, err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".gotavern-copy-") {
			t.Fatalf("a staging directory survived at %s", filepath.Join(parent, entry.Name()))
		}
	}
}
