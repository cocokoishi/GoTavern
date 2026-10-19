package startup

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// VerifyCharacterDiskCache creates the pinned node-persist character-cache
// directory and applies DiskCache.verify()'s filename-based removal pass.
func VerifyCharacterDiskCache(dataRoot string, directories []UserDirectories, enabled bool) []error {
	if !enabled {
		return nil
	}
	absoluteDataRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return []error{fmt.Errorf("resolve data root: %w", err)}
	}
	cacheDirectory := filepath.Join(absoluteDataRoot, "_cache", "characters")
	if err := ensureContained(absoluteDataRoot, cacheDirectory); err != nil {
		return []error{fmt.Errorf("invalid character-cache directory: %w", err)}
	}
	lockRoot, err := canonicalPath(absoluteDataRoot)
	if err != nil {
		return []error{fmt.Errorf("resolve character-cache lock root: %w", err)}
	}
	lock, err := acquireContentLock(lockRoot)
	if err != nil {
		return []error{err}
	}
	defer lock.Close()
	if err := os.MkdirAll(cacheDirectory, 0o777); err != nil {
		return []error{fmt.Errorf("create character disk cache: %w", err)}
	}

	validKeys := make(map[string]struct{})
	for _, userDirectories := range directories {
		characterDirectory := userDirectories["characters"]
		files, err := os.ReadDir(characterDirectory)
		if err != nil {
			return []error{fmt.Errorf("read character directory %s: %w", characterDirectory, err)}
		}
		for _, file := range files {
			if filepath.Ext(file.Name()) != ".png" {
				continue
			}
			entryInfo, err := file.Info()
			if err != nil {
				return []error{fmt.Errorf("inspect character card entry %s: %w", filepath.Join(characterDirectory, file.Name()), err)}
			}
			if !entryInfo.Mode().IsRegular() {
				continue
			}
			filePath := filepath.Join(characterDirectory, file.Name())
			info, err := os.Stat(filePath)
			if err != nil {
				return []error{fmt.Errorf("stat character card %s: %w", filePath, err)}
			}
			cacheKey := filePath + "-" + javascriptNumberString(float64(info.ModTime().UnixNano())/1e6)
			validKeys[storeFilename(cacheKey)] = struct{}{}
		}
	}

	cacheEntries, err := os.ReadDir(cacheDirectory)
	if err != nil {
		return []error{fmt.Errorf("read character disk cache: %w", err)}
	}
	for _, entry := range cacheEntries {
		if _, valid := validKeys[entry.Name()]; valid {
			continue
		}
		// Pinned DiskCache.verify passes the hashed filename back as a storage
		// key. node-persist hashes it again, leaving ordinary stale records and
		// removing only a record whose key happens to equal that filename.
		misaddressedRecord := filepath.Join(cacheDirectory, storeFilename(entry.Name()))
		info, err := os.Lstat(misaddressedRecord)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return []error{fmt.Errorf("inspect misaddressed character-cache record: %w", err)}
		}
		if info.IsDir() {
			return []error{fmt.Errorf("remove misaddressed character-cache record %s: path is a directory", misaddressedRecord)}
		}
		if err := os.Remove(misaddressedRecord); err != nil {
			return []error{fmt.Errorf("remove misaddressed character-cache record %s: %w", misaddressedRecord, err)}
		}
	}
	return nil
}
