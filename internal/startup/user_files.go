package startup

import (
	"fmt"
	"os"
	"path/filepath"
)

// SaveUserFile atomically writes one file in the user's pinned files
// directory and returns its client-relative path.
func SaveUserFile(dataRoot, handle, filename string, content []byte) (string, error) {
	directories, userRoot, lock, err := lockUserContentRoot(dataRoot, handle)
	if err != nil {
		return "", err
	}
	defer lock.Close()

	filesDirectory, err := filepath.Abs(directories["files"])
	if err != nil {
		return "", fmt.Errorf("resolve user files directory: %w", err)
	}
	if err := ensureContained(userRoot, filesDirectory); err != nil {
		return "", fmt.Errorf("user files directory escapes user root: %w", err)
	}
	if err := ensureResolvedContained(userRoot, filesDirectory); err != nil {
		return "", fmt.Errorf("user files directory escapes user root: %w", err)
	}
	target := filepath.Join(filesDirectory, filename)
	if err := ensureContained(userRoot, target); err != nil {
		return "", fmt.Errorf("user file path escapes user root: %w", err)
	}
	if err := ensureResolvedContained(userRoot, target); err != nil {
		return "", fmt.Errorf("user file path escapes user root: %w", err)
	}
	writeTarget := target
	if _, err := os.Lstat(target); err == nil {
		writeTarget, err = filepath.EvalSymlinks(target)
		if err != nil {
			return "", fmt.Errorf("resolve user file target: %w", err)
		}
		if err := ensureResolvedContained(userRoot, writeTarget); err != nil {
			return "", fmt.Errorf("user file target escapes user root: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := atomicReplace(writeTarget, content); err != nil {
		return "", err
	}
	relative, err := filepath.Rel(userRoot, target)
	if err != nil {
		return "", err
	}
	return "/" + filepath.ToSlash(relative), nil
}

// DeleteUserFile removes one user-relative file path while serializing it with
// other persistent mutations for the same user.
func DeleteUserFile(dataRoot, handle, relativePath string) (bool, error) {
	_, userRoot, lock, err := lockUserContentRoot(dataRoot, handle)
	if err != nil {
		return false, err
	}
	defer lock.Close()

	target := filepath.Join(userRoot, filepath.FromSlash(relativePath))
	if err := ensureContained(userRoot, target); err != nil {
		return false, nil
	}
	if err := ensureResolvedContained(userRoot, filepath.Dir(target)); err != nil {
		return false, err
	}
	if _, err := os.Stat(target); err != nil {
		// Node's existsSync treats missing paths and filesystem errors as absent.
		return false, nil
	}
	entry, err := os.Lstat(target)
	if err != nil {
		return false, err
	}
	if entry.IsDir() {
		return false, fmt.Errorf("cannot unlink a directory")
	}
	if err := os.Remove(target); err != nil {
		return false, err
	}
	return true, nil
}
