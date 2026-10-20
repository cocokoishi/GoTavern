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
