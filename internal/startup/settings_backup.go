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

	"github.com/gofrs/flock"
)

const settingsFilename = "settings.json"

type settingsBackupFile struct {
	name     string
	path     string
	sortTime time.Time
}

// BackupSettings reproduces settings.init()'s duplicate-aware startup backup
// for each supplied user. A user failure stops the remaining users, matching
// the pinned outer catch in backupSettings().
func BackupSettings(directoriesList []UserDirectories, maxBackups int) []error {
	var backupErrors []error
	for _, directories := range directoriesList {
		if err := backupUserSettings(directories, maxBackups); err != nil {
			backupErrors = append(backupErrors, err)
			break
		}
	}
	return backupErrors
}

func backupUserSettings(directories UserDirectories, maxBackups int) error {
	userRoot := directories["root"]
	if userRoot == "" {
		return errors.New("user directory set is missing root")
	}
	absoluteUserRoot, err := filepath.Abs(userRoot)
	if err != nil {
		return fmt.Errorf("resolve settings root %s: %w", userRoot, err)
	}
	if _, err := os.Stat(absoluteUserRoot); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect settings root %s: %w", absoluteUserRoot, err)
	}
	_, lock, err := lockSettingsUser(absoluteUserRoot)
	if err != nil {
		return err
	}
	defer lock.Close()
	return backupUserSettingsLocked(directories, absoluteUserRoot, float64(maxBackups))
}

// SaveSettings atomically replaces a user's settings and optionally creates
// the duplicate-aware autosave snapshot while holding the shared data-root
// lock. The caller supplies the already JavaScript-stringified settings JSON.
func SaveSettings(dataRoot, handle string, body []byte, retention float64, makeSnapshot bool) (bool, error) {
	directories, err := DirectoriesForUser(dataRoot, handle)
	if err != nil {
		return false, err
	}
	absoluteUserRoot, err := filepath.Abs(directories["root"])
	if err != nil {
		return false, fmt.Errorf("resolve settings root %s: %w", directories["root"], err)
	}
	if _, err := os.Stat(absoluteUserRoot); err != nil {
		return false, fmt.Errorf("inspect settings root %s: %w", absoluteUserRoot, err)
	}
	lockRoot, lock, err := lockSettingsUser(absoluteUserRoot)
	if err != nil {
		return false, err
	}
	defer lock.Close()
	resolvedUserRoot, err := canonicalPath(absoluteUserRoot)
	if err != nil {
		return false, fmt.Errorf("resolve settings user root: %w", err)
	}
	if err := ensureContained(lockRoot, resolvedUserRoot); err != nil {
		return false, fmt.Errorf("settings user root escapes data root: %w", err)
	}
	settingsPath := filepath.Join(absoluteUserRoot, settingsFilename)
	if err := ensureResolvedContained(absoluteUserRoot, settingsPath); err != nil {
		return false, fmt.Errorf("settings file escapes user root: %w", err)
	}
	if err := atomicReplace(settingsPath, body); err != nil {
		return false, fmt.Errorf("write settings file for %s: %w", handle, err)
	}
	if !makeSnapshot {
		return true, nil
	}
	return true, backupUserSettingsLocked(directories, absoluteUserRoot, retention)
}

// BackupUserSettings creates a duplicate-aware settings snapshot for one user.
func BackupUserSettings(dataRoot, handle string, retention float64) error {
	directories, err := DirectoriesForUser(dataRoot, handle)
	if err != nil {
		return err
	}
	absoluteUserRoot, err := filepath.Abs(directories["root"])
	if err != nil {
		return fmt.Errorf("resolve settings root %s: %w", directories["root"], err)
	}
	if _, err := os.Stat(absoluteUserRoot); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect settings root %s: %w", absoluteUserRoot, err)
	}
	lockRoot, lock, err := lockSettingsUser(absoluteUserRoot)
	if err != nil {
		return err
	}
	defer lock.Close()
	resolvedUserRoot, err := canonicalPath(absoluteUserRoot)
	if err != nil {
		return fmt.Errorf("resolve settings user root: %w", err)
	}
	if err := ensureContained(lockRoot, resolvedUserRoot); err != nil {
		return fmt.Errorf("settings user root escapes data root: %w", err)
	}
	return backupUserSettingsLocked(directories, absoluteUserRoot, retention)
}

func lockSettingsUser(absoluteUserRoot string) (string, *flock.Flock, error) {
	lockRoot, err := canonicalPath(filepath.Dir(absoluteUserRoot))
	if err != nil {
		return "", nil, fmt.Errorf("resolve settings backup lock root: %w", err)
	}
	lock, err := acquireContentLock(lockRoot)
	if err != nil {
		return "", nil, err
	}
	resolvedUserRoot, err := canonicalPath(absoluteUserRoot)
	if err != nil {
		_ = lock.Close()
		return "", nil, fmt.Errorf("resolve settings user root: %w", err)
	}
	if err := ensureContained(lockRoot, resolvedUserRoot); err != nil {
		_ = lock.Close()
		return "", nil, fmt.Errorf("settings user root escapes data root: %w", err)
	}
	return lockRoot, lock, nil
}

func backupUserSettingsLocked(directories UserDirectories, absoluteUserRoot string, retention float64) error {
	handle := filepath.Base(absoluteUserRoot)
	backupsDirectory := directories["backups"]
	if backupsDirectory == "" {
		return errors.New("user directory set is missing backups")
	}
	absoluteBackups, err := filepath.Abs(backupsDirectory)
	if err != nil {
		return fmt.Errorf("resolve settings backups directory: %w", err)
	}
	if err := ensureResolvedContained(absoluteUserRoot, absoluteBackups); err != nil {
		return fmt.Errorf("settings backups directory escapes user root: %w", err)
	}

	settingsPath := filepath.Join(absoluteUserRoot, settingsFilename)
	if err := ensureResolvedContained(absoluteUserRoot, settingsPath); err != nil {
		return fmt.Errorf("settings file escapes user root: %w", err)
	}
	prefix := settingsBackupPrefix(handle)
	latestBackup, err := latestSettingsBackup(absoluteBackups, prefix)
	if err != nil {
		return err
	}
	if latestBackup != "" {
		equal, err := settingsFilesEqual(latestBackup, settingsPath)
		if err != nil {
			return err
		}
		if equal {
			return nil
		}
	}

	settingsInfo, err := os.Stat(settingsPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect settings file for %s: %w", handle, err)
	}
	if !settingsInfo.Mode().IsRegular() {
		return fmt.Errorf("settings file for %s is not regular", handle)
	}
	if err := ensureResolvedContained(absoluteUserRoot, settingsPath); err != nil {
		return fmt.Errorf("settings file escapes user root: %w", err)
	}
	body, err := os.ReadFile(settingsPath)
	if err != nil {
		return fmt.Errorf("read settings file for %s: %w", handle, err)
	}
	timestamp := time.Now().Format("20060102-150405")
	backupPath := filepath.Join(absoluteBackups, settingsBackupPrefix(handle)+timestamp+".json")
	if err := ensureContained(absoluteUserRoot, backupPath); err != nil {
		return fmt.Errorf("invalid settings backup path for %s: %w", handle, err)
	}
	if err := ensureResolvedContained(absoluteUserRoot, backupPath); err != nil {
		return fmt.Errorf("settings backup path escapes user root: %w", err)
	}
	_, backupExistsErr := os.Stat(backupPath)
	backupExisted := backupExistsErr == nil
	if backupExistsErr != nil && !errors.Is(backupExistsErr, fs.ErrNotExist) {
		return fmt.Errorf("inspect settings backup path for %s: %w", handle, backupExistsErr)
	}
	if err := atomicReplace(backupPath, body); err != nil {
		return fmt.Errorf("write settings backup for %s: %w", handle, err)
	}
	if !backupExisted {
		if err := os.Chmod(backupPath, settingsInfo.Mode().Perm()); err != nil {
			return fmt.Errorf("set settings backup permissions for %s: %w", handle, err)
		}
	}
	if err := removeOldSettingsBackups(absoluteBackups, "settings_"+handle, retention); err != nil {
		return fmt.Errorf("remove old settings backups for %s: %w", handle, err)
	}
	return nil
}

func settingsBackupPrefix(handle string) string {
	return "settings_" + handle + "_"
}

func latestSettingsBackup(directory, prefix string) (string, error) {
	entries, err := readDirectoryInNativeOrder(directory)
	if err != nil {
		return "", fmt.Errorf("read settings backups in %s: %w", directory, err)
	}
	files := make([]settingsBackupFile, 0)
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), prefix) {
			continue
		}
		filePath := filepath.Join(directory, entry.Name())
		info, err := os.Stat(filePath)
		if err != nil {
			return "", fmt.Errorf("inspect settings backup %s: %w", entry.Name(), err)
		}
		changeTime, err := nodeChangeTime(filePath, info)
		if err != nil {
			return "", fmt.Errorf("inspect settings backup change time %s: %w", entry.Name(), err)
		}
		files = append(files, settingsBackupFile{name: entry.Name(), path: filePath, sortTime: changeTime})
	}
	sort.SliceStable(files, func(left, right int) bool { return files[left].sortTime.After(files[right].sortTime) })
	if len(files) == 0 {
		return "", nil
	}
	return files[0].path, nil
}

func settingsFilesEqual(leftPath, rightPath string) (bool, error) {
	leftInfo, leftErr := os.Stat(leftPath)
	rightInfo, rightErr := os.Stat(rightPath)
	if errors.Is(leftErr, fs.ErrNotExist) || errors.Is(rightErr, fs.ErrNotExist) {
		return false, nil
	}
	if leftErr != nil {
		return false, fmt.Errorf("inspect latest settings backup: %w", leftErr)
	}
	if rightErr != nil {
		return false, fmt.Errorf("inspect settings file: %w", rightErr)
	}
	if !leftInfo.Mode().IsRegular() || !rightInfo.Mode().IsRegular() {
		return false, errors.New("settings backup comparison requires regular files")
	}
	left, err := os.ReadFile(leftPath)
	if err != nil {
		return false, fmt.Errorf("read latest settings backup: %w", err)
	}
	right, err := os.ReadFile(rightPath)
	if err != nil {
		return false, fmt.Errorf("read settings file: %w", err)
	}
	return strings.ToValidUTF8(string(left), "\uFFFD") == strings.ToValidUTF8(string(right), "\uFFFD"), nil
}

func removeOldSettingsBackups(directory, prefix string, limit float64) error {
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
	if math.IsNaN(limit) || float64(len(files)) <= limit {
		return nil
	}
	sort.SliceStable(files, func(left, right int) bool { return files[left].sortTime.Before(files[right].sortTime) })
	for float64(len(files)) > limit {
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
