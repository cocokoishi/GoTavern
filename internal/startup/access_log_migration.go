package startup

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// AccessLogMigrationResult records whether the legacy server-directory log was
// moved and any error that the pinned migration catches and reports.
type AccessLogMigrationResult struct {
	Migrated bool
	Errors   []error
}

// MigrateAccessLog moves serverDirectory/access.log into DATA_ROOT only when
// the source exists and the destination does not.
func MigrateAccessLog(serverDirectory, dataRoot string) AccessLogMigrationResult {
	installRoot, err := filepath.Abs(serverDirectory)
	if err != nil {
		return AccessLogMigrationResult{Errors: []error{fmt.Errorf("resolve server directory: %w", err)}}
	}
	absoluteDataRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return AccessLogMigrationResult{Errors: []error{fmt.Errorf("resolve data root: %w", err)}}
	}
	source := filepath.Join(installRoot, "access.log")
	destination := filepath.Join(absoluteDataRoot, "access.log")
	if err := ensureContained(installRoot, source); err != nil {
		return AccessLogMigrationResult{Errors: []error{fmt.Errorf("invalid legacy access-log path: %w", err)}}
	}
	if err := ensureContained(absoluteDataRoot, destination); err != nil {
		return AccessLogMigrationResult{Errors: []error{fmt.Errorf("invalid destination access-log path: %w", err)}}
	}
	if _, err := os.Stat(source); errors.Is(err, fs.ErrNotExist) {
		return AccessLogMigrationResult{}
	} else if err != nil {
		return AccessLogMigrationResult{Errors: []error{fmt.Errorf("inspect legacy access log: %w", err)}}
	}
	if _, err := os.Stat(destination); err == nil {
		return AccessLogMigrationResult{}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return AccessLogMigrationResult{Errors: []error{fmt.Errorf("inspect destination access log: %w", err)}}
	}
	if err := ensureResolvedContained(installRoot, source); err != nil {
		return AccessLogMigrationResult{Errors: []error{fmt.Errorf("legacy access log escapes server directory: %w", err)}}
	}
	if err := ensureResolvedContained(absoluteDataRoot, destination); err != nil {
		return AccessLogMigrationResult{Errors: []error{fmt.Errorf("access-log destination escapes data root: %w", err)}}
	}
	lockRoots, err := accessLogLockRoots(installRoot, absoluteDataRoot)
	if err != nil {
		return AccessLogMigrationResult{Errors: []error{err}}
	}
	locks := make([]interface{ Close() error }, 0, len(lockRoots))
	for _, root := range lockRoots {
		lock, err := acquireContentLock(root)
		if err != nil {
			for index := len(locks) - 1; index >= 0; index-- {
				_ = locks[index].Close()
			}
			return AccessLogMigrationResult{Errors: []error{err}}
		}
		locks = append(locks, lock)
	}
	defer func() {
		for index := len(locks) - 1; index >= 0; index-- {
			_ = locks[index].Close()
		}
	}()

	// Recheck both paths after taking locks so parallel GoTavern startups cannot
	// replace a destination or move the source twice.
	if _, err := os.Stat(source); errors.Is(err, fs.ErrNotExist) {
		return AccessLogMigrationResult{}
	} else if err != nil {
		return AccessLogMigrationResult{Errors: []error{fmt.Errorf("inspect legacy access log: %w", err)}}
	}
	if _, err := os.Stat(destination); err == nil {
		return AccessLogMigrationResult{}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return AccessLogMigrationResult{Errors: []error{fmt.Errorf("inspect destination access log: %w", err)}}
	}
	if err := os.Rename(source, destination); err != nil {
		return AccessLogMigrationResult{Errors: []error{fmt.Errorf("move legacy access log: %w", err)}}
	}
	return AccessLogMigrationResult{Migrated: true}
}

func accessLogLockRoots(installRoot, dataRoot string) ([]string, error) {
	canonicalInstall, err := canonicalPath(installRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve access-log source lock root: %w", err)
	}
	canonicalData, err := canonicalPath(dataRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve access-log data lock root: %w", err)
	}
	if sameAccessLogPath(canonicalInstall, canonicalData) {
		return []string{canonicalInstall}, nil
	}
	if strings.ToLower(canonicalInstall) < strings.ToLower(canonicalData) {
		return []string{canonicalInstall, canonicalData}, nil
	}
	return []string{canonicalData, canonicalInstall}, nil
}

func sameAccessLogPath(left, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
	}
	return filepath.Clean(left) == filepath.Clean(right)
}
