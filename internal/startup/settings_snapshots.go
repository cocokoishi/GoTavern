package startup

import (
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// SettingsSnapshot describes one file returned by the pinned settings snapshot
// listing endpoint.
type SettingsSnapshot struct {
	Date float64 `json:"date"`
	Name string  `json:"name"`
	Size int64   `json:"size"`
}

// SettingsSnapshotPrefix returns the pinned per-user settings backup prefix.
func SettingsSnapshotPrefix(handle string) string {
	return "settings_" + handle + "_"
}

// ListSettingsSnapshots returns the user-owned backup entries in native
// directory order, including matching non-regular entries like Node's
// readdirSync/statSync path does.
func ListSettingsSnapshots(dataRoot, handle string) ([]SettingsSnapshot, error) {
	directories, err := DirectoriesForUser(dataRoot, handle)
	if err != nil {
		return nil, err
	}
	backupsDirectory := directories["backups"]
	entries, err := readDirectoryInNativeOrder(backupsDirectory)
	if err != nil {
		return nil, err
	}
	prefix := SettingsSnapshotPrefix(handle)
	snapshots := make([]SettingsSnapshot, 0)
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), prefix) {
			continue
		}
		filePath := filepath.Join(backupsDirectory, entry.Name())
		info, err := os.Stat(filePath)
		if err != nil {
			return nil, err
		}
		changeTime, err := nodeChangeTime(filePath, info)
		if err != nil {
			return nil, err
		}
		snapshots = append(snapshots, SettingsSnapshot{
			Date: float64(changeTime.UnixNano()) / float64(time.Millisecond),
			Name: entry.Name(),
			Size: info.Size(),
		})
	}
	return snapshots, nil
}

// ReadSettingsSnapshot reads a named snapshot. Missing files return found=false
// without an error, matching existsSync() followed by readFileSync().
func ReadSettingsSnapshot(dataRoot, handle, name string) ([]byte, bool, error) {
	backupPath, userRoot, err := settingsSnapshotPath(dataRoot, handle, name)
	if err != nil {
		return nil, false, err
	}
	if err := ensureResolvedContained(userRoot, backupPath); err != nil {
		return nil, false, err
	}
	if _, err := os.Stat(backupPath); errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	} else if err != nil {
		return nil, false, err
	}
	body, err := os.ReadFile(backupPath)
	if err != nil {
		return nil, false, err
	}
	return body, true, nil
}

// CreateSettingsSnapshot creates a timestamped settings copy and applies the
// configured retention limit. The settings file and backup are protected by
// the shared data-root lock; the backup is atomically replaced.
func CreateSettingsSnapshot(dataRoot, handle string, retention float64) error {
	directories, err := DirectoriesForUser(dataRoot, handle)
	if err != nil {
		return err
	}
	userRoot, err := filepath.Abs(directories["root"])
	if err != nil {
		return err
	}
	if _, err := os.Stat(userRoot); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	lockRoot, err := canonicalPath(filepath.Dir(userRoot))
	if err != nil {
		return err
	}
	lock, err := acquireContentLock(lockRoot)
	if err != nil {
		return err
	}
	defer lock.Close()
	resolvedUserRoot, err := canonicalPath(userRoot)
	if err != nil {
		return err
	}
	if err := ensureContained(lockRoot, resolvedUserRoot); err != nil {
		return err
	}
	backupsDirectory, err := filepath.Abs(directories["backups"])
	if err != nil {
		return err
	}
	if err := ensureResolvedContained(userRoot, backupsDirectory); err != nil {
		return err
	}
	settingsPath := filepath.Join(userRoot, settingsFilename)
	if err := ensureResolvedContained(userRoot, settingsPath); err != nil {
		return err
	}
	settingsInfo, err := os.Stat(settingsPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !settingsInfo.Mode().IsRegular() {
		return fmt.Errorf("settings file for %s is not regular", handle)
	}
	body, err := os.ReadFile(settingsPath)
	if err != nil {
		return err
	}
	timestamp := time.Now().Format("20060102-150405")
	backupPath := filepath.Join(backupsDirectory, SettingsSnapshotPrefix(handle)+timestamp+".json")
	if err := ensureResolvedContained(userRoot, backupPath); err != nil {
		return err
	}
	backupExisted := false
	if _, err := os.Stat(backupPath); err == nil {
		backupExisted = true
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := atomicReplace(backupPath, body); err != nil {
		return err
	}
	if !backupExisted {
		if err := os.Chmod(backupPath, settingsInfo.Mode().Perm()); err != nil {
			return err
		}
	}
	return removeSettingsSnapshotsOverLimit(backupsDirectory, "settings_"+handle, retention)
}

// RestoreSettingsSnapshot atomically replaces the user's settings file with a
// snapshot, holding the same lock used by settings writes and backups.
func RestoreSettingsSnapshot(dataRoot, handle, name string) (bool, error) {
	backupPath, userRoot, err := settingsSnapshotPath(dataRoot, handle, name)
	if err != nil {
		return false, err
	}
	userRoot, err = filepath.Abs(userRoot)
	if err != nil {
		return false, err
	}
	lockRoot, err := canonicalPath(filepath.Dir(userRoot))
	if err != nil {
		return false, err
	}
	lock, err := acquireContentLock(lockRoot)
	if err != nil {
		return false, err
	}
	defer lock.Close()
	resolvedUserRoot, err := canonicalPath(userRoot)
	if err != nil {
		return false, err
	}
	if err := ensureContained(lockRoot, resolvedUserRoot); err != nil {
		return false, err
	}
	if err := ensureResolvedContained(userRoot, backupPath); err != nil {
		return false, err
	}
	if _, err := os.Stat(backupPath); errors.Is(err, fs.ErrNotExist) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	body, err := os.ReadFile(backupPath)
	if err != nil {
		return false, err
	}
	settingsPath := filepath.Join(userRoot, settingsFilename)
	if err := ensureResolvedContained(userRoot, settingsPath); err != nil {
		return false, err
	}
	if err := atomicReplace(settingsPath, body); err != nil {
		return false, err
	}
	return true, nil
}

func settingsSnapshotPath(dataRoot, handle, name string) (string, string, error) {
	directories, err := DirectoriesForUser(dataRoot, handle)
	if err != nil {
		return "", "", err
	}
	userRoot, err := filepath.Abs(directories["root"])
	if err != nil {
		return "", "", err
	}
	backupsDirectory, err := filepath.Abs(directories["backups"])
	if err != nil {
		return "", "", err
	}
	if err := ensureContained(userRoot, backupsDirectory); err != nil {
		return "", "", err
	}
	backupPath := filepath.Join(backupsDirectory, name)
	if err := ensureContained(backupsDirectory, backupPath); err != nil {
		return "", "", err
	}
	return backupPath, userRoot, nil
}

func removeSettingsSnapshotsOverLimit(directory, prefix string, retention float64) error {
	entries, err := readDirectoryInNativeOrder(directory)
	if err != nil {
		return err
	}
	files := make([]settingsBackupFile, 0)
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), prefix) {
			continue
		}
		filePath := filepath.Join(directory, entry.Name())
		info, err := os.Stat(filePath)
		if err != nil {
			return err
		}
		files = append(files, settingsBackupFile{name: entry.Name(), path: filePath, sortTime: info.ModTime()})
	}
	if math.IsNaN(retention) || float64(len(files)) <= retention {
		return nil
	}
	sort.SliceStable(files, func(left, right int) bool { return files[left].sortTime.Before(files[right].sortTime) })
	for float64(len(files)) > retention {
		if len(files) == 0 {
			break
		}
		oldest := files[0]
		info, err := os.Lstat(oldest.path)
		if err != nil {
			return err
		}
		if info.IsDir() {
			return fmt.Errorf("remove settings backup %s: path is a directory", oldest.name)
		}
		if err := os.Remove(oldest.path); err != nil {
			return err
		}
		files = files[1:]
	}
	return nil
}
