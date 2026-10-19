package startup

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// UploadCleanupResult records the pinned cleanUploads() listing count and any
// error that stopped deletion of the temporary upload entries.
type UploadCleanupResult struct {
	Count  int
	Errors []error
}

// CleanUploads removes entries directly inside DATA_ROOT/_uploads. The pinned
// cleanup unlinks entries one by one and stops when the first unlink fails.
func CleanUploads(dataRoot string) UploadCleanupResult {
	absoluteRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return UploadCleanupResult{Errors: []error{fmt.Errorf("resolve data root: %w", err)}}
	}
	uploadsPath := filepath.Join(absoluteRoot, "_uploads")
	if err := ensureContained(absoluteRoot, uploadsPath); err != nil {
		return UploadCleanupResult{Errors: []error{fmt.Errorf("invalid uploads path: %w", err)}}
	}
	if _, err := os.Stat(uploadsPath); errors.Is(err, fs.ErrNotExist) {
		return UploadCleanupResult{}
	} else if err != nil {
		return UploadCleanupResult{Errors: []error{fmt.Errorf("inspect uploads path: %w", err)}}
	}
	lockRoot, err := canonicalPath(absoluteRoot)
	if err != nil {
		return UploadCleanupResult{Errors: []error{fmt.Errorf("resolve uploads lock root: %w", err)}}
	}
	lock, err := acquireContentLock(lockRoot)
	if err != nil {
		return UploadCleanupResult{Errors: []error{err}}
	}
	defer lock.Close()
	if err := ensureResolvedContained(absoluteRoot, uploadsPath); err != nil {
		return UploadCleanupResult{Errors: []error{fmt.Errorf("uploads path escapes data root: %w", err)}}
	}
	entries, err := os.ReadDir(uploadsPath)
	if err != nil {
		return UploadCleanupResult{Errors: []error{fmt.Errorf("read uploads directory: %w", err)}}
	}
	result := UploadCleanupResult{Count: len(entries)}
	for _, entry := range entries {
		entryPath := filepath.Join(uploadsPath, entry.Name())
		info, err := os.Lstat(entryPath)
		if err != nil {
			result.Errors = append(result.Errors, fmt.Errorf("inspect upload entry %s: %w", entry.Name(), err))
			break
		}
		if info.IsDir() {
			result.Errors = append(result.Errors, fmt.Errorf("remove upload entry %s: path is a directory", entry.Name()))
			break
		}
		if err := os.Remove(entryPath); err != nil {
			result.Errors = append(result.Errors, fmt.Errorf("remove upload entry %s: %w", entry.Name(), err))
			break
		}
	}
	return result
}
