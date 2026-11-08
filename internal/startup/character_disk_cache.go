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
			// One metadata read per card, taken from the DIRECTORY LISTING. os.ReadDir already returns
			// size/type/mtime with the entry (on Windows without a syscall per file; on POSIX the listing's
			// Info is one lstat), so the separate os.Stat this loop used to perform doubled both the syscall
			// count and — measured on the 10,000-card fixture after a fresh write — the boot cost, because
			// every per-file metadata read of an unscanned file pays the host's on-access scanner. The entry is
			// checked regular first, exactly like the isFile() dirent filter in the pinned
			// DiskCache.verify (src/endpoints/characters.js:136), and for a regular file lstat and stat agree
			// on size and mtime, so the cache key is the same key the stat produced.
			entryInfo, err := file.Info()
			if err != nil {
				return []error{fmt.Errorf("inspect character card entry %s: %w", filepath.Join(characterDirectory, file.Name()), err)}
			}
			if !entryInfo.Mode().IsRegular() {
				continue
			}
			filePath := filepath.Join(characterDirectory, file.Name())
			cacheKey := filePath + "-" + javascriptNumberString(float64(entryInfo.ModTime().UnixNano())/1e6)
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
