package startup

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// UpdateUserContentFile applies one atomic read-modify-write while holding the
// shared per-user content lock. The callback receives nil when the file could
// not be read, matching the upstream metadata-index fallback behavior.
func UpdateUserContentFile(dataRoot, handle, relativePath string, update func([]byte) ([]byte, error)) error {
	if update == nil {
		return errors.New("user content update callback is nil")
	}
	return updateUserContentFile(dataRoot, handle, relativePath, func(current []byte) ([]byte, bool, error) {
		body, err := update(current)
		return body, true, err
	})
}

// UpdateUserContentFileIfChanged applies an atomic read-modify-write while
// holding the shared per-user content lock. The callback can decline the write
// to preserve the target file's existence, bytes, and modification time.
func UpdateUserContentFileIfChanged(dataRoot, handle, relativePath string, update func([]byte) ([]byte, bool, error)) error {
	if update == nil {
		return errors.New("user content update callback is nil")
	}
	return updateUserContentFile(dataRoot, handle, relativePath, update)
}

func updateUserContentFile(dataRoot, handle, relativePath string, update func([]byte) ([]byte, bool, error)) error {
	if filepath.IsAbs(relativePath) || relativePath == "" {
		return errors.New("user content path must be relative")
	}

	_, userRoot, lock, err := lockUserContentRoot(dataRoot, handle)
	if err != nil {
		return err
	}
	defer lock.Close()

	target := filepath.Join(userRoot, filepath.Clean(relativePath))
	if err := ensureContained(userRoot, target); err != nil {
		return err
	}
	if err := ensureResolvedContained(userRoot, target); err != nil {
		return err
	}
	current, err := os.ReadFile(target)
	if err != nil {
		current = nil
	}
	body, shouldWrite, err := update(current)
	if err != nil {
		return err
	}
	if !shouldWrite {
		return nil
	}
	if err := ensureResolvedContained(userRoot, target); err != nil {
		return err
	}
	if _, err := os.Stat(target); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return atomicReplace(target, body)
}
