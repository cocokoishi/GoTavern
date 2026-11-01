package startup

// Crash-safe rename of one file inside a user data root.

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/cocokoishi/gotavern/internal/faultinject"
	"github.com/cocokoishi/gotavern/internal/fsretry"
)

// RenameUserContentFile renames one file inside a user data root under the shared per-user content lock.
//
// WHY THIS EXISTS (crash atomicity, not style). The pinned chat-rename handler is
// `fs.copyFileSync(pathToOriginalFile, pathToRenamedFile); fs.unlinkSync(pathToOriginalFile);`
// (src/endpoints/chats.js:644-645), and GoTavern reproduced it as an atomic write of the new name followed
// by a delete of the old one. SIGKILL between those two steps leaves BOTH names present: after a restart
// the user sees the chat twice, and a "newest first" listing has two entries where the operation was
// supposed to produce one. A single rename is the crash-safe form: the tree holds the old name or the new
// name, never both and never a partial file.
//
// PINNED'S OBSERVABLE, KEPT: copyFileSync creates a NEW file, so the renamed file carries the CURRENT
// mtime -- which /api/chats/recent orders by -- while a rename preserves the source mtime. The mtime is
// therefore set after the rename so a renamed chat keeps the "newest" position pinned gives it. (A crash
// between the rename and the Chtimes leaves a complete file under the new name with the source mtime: a
// complete state, which is the invariant this function exists for.)
//
// The destination is replaced if it exists, matching copyFileSync. Callers pre-check it as pinned's handler
// does; this is the race-window behaviour, not the normal one.
func RenameUserContentFile(dataRoot, handle, oldRelative, newRelative string) (bool, error) {
	if oldRelative == "" || newRelative == "" || filepath.IsAbs(oldRelative) || filepath.IsAbs(newRelative) {
		return false, errors.New("user content paths must be relative and non-empty")
	}
	_, userRoot, lock, err := lockUserContentRoot(dataRoot, handle)
	if err != nil {
		return false, err
	}
	defer lock.Close()

	source := filepath.Join(userRoot, filepath.Clean(oldRelative))
	destination := filepath.Join(userRoot, filepath.Clean(newRelative))
	for _, target := range []string{source, destination} {
		if err := ensureContained(userRoot, target); err != nil {
			return false, err
		}
		if err := ensureResolvedContained(userRoot, target); err != nil {
			return false, err
		}
	}
	info, err := os.Lstat(source)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if info.IsDir() {
		return false, errors.New("cannot rename a directory")
	}

	faultinject.Hit("chats.rename.before-rename")
	if err := fsretry.Do(func() error { return os.Rename(source, destination) }); err != nil {
		return false, err
	}
	faultinject.Hit("chats.rename.after-rename")

	now := time.Now()
	_ = os.Chtimes(destination, now, now)
	if directoryFile, err := os.Open(filepath.Dir(destination)); err == nil {
		_ = directoryFile.Sync()
		_ = directoryFile.Close()
	}
	return true, nil
}
