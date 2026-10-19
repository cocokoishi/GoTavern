package startup

import (
	"fmt"
	"os"
	"path/filepath"
)

type publicOverrideMigration struct {
	oldRelative string
	newRelative string
}

// MigratePublicOverrides moves pinned error-page and user-CSS overrides into
// the data root. Existing data-root files take precedence and retain the
// corresponding legacy source file.
func MigratePublicOverrides(installRoot, dataRoot string) ([]error, error) {
	absoluteInstallRoot, err := filepath.Abs(installRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve install root: %w", err)
	}
	absoluteDataRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve data root: %w", err)
	}
	lockRoot, err := canonicalPath(absoluteDataRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve public-overrides migration root: %w", err)
	}
	lock, err := acquireContentLock(lockRoot)
	if err != nil {
		return nil, err
	}
	defer lock.Close()

	migrations := []publicOverrideMigration{
		{oldRelative: filepath.Join("public", "error", "forbidden-by-whitelist.html"), newRelative: filepath.Join("_errors", "forbidden-by-whitelist.html")},
		{oldRelative: filepath.Join("public", "error", "host-not-allowed.html"), newRelative: filepath.Join("_errors", "host-not-allowed.html")},
		{oldRelative: filepath.Join("public", "error", "unauthorized.html"), newRelative: filepath.Join("_errors", "unauthorized.html")},
		{oldRelative: filepath.Join("public", "error", "url-not-found.html"), newRelative: filepath.Join("_errors", "url-not-found.html")},
		{oldRelative: filepath.Join("public", "css", "user.css"), newRelative: filepath.Join("_css", "user.css")},
	}

	var migrationErrors []error
	for _, migration := range migrations {
		oldPath := filepath.Join(absoluteInstallRoot, migration.oldRelative)
		newPath := filepath.Join(absoluteDataRoot, migration.newRelative)
		if err := ensureContained(absoluteInstallRoot, oldPath); err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("invalid public override source %s: %w", oldPath, err))
			continue
		}
		if err := ensureContained(absoluteDataRoot, newPath); err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("invalid public override destination %s: %w", newPath, err))
			continue
		}
		if _, err := os.Stat(newPath); err == nil {
			continue
		}
		if _, err := os.Stat(oldPath); err != nil {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(newPath), 0o777); err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("create public override destination directory: %w", err))
			continue
		}
		if err := copyPublicOverride(oldPath, newPath, absoluteDataRoot); err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("copy public override %s to %s: %w", oldPath, newPath, err))
			continue
		}
		if err := os.Remove(oldPath); err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("remove migrated public override %s: %w", oldPath, err))
			continue
		}
		if err := makePublicOverrideWritable(newPath); err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("set public override permissions for %s: %w", newPath, err))
		}
	}
	return migrationErrors, nil
}

func copyPublicOverride(source, destination, allowedRoot string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("unsupported public override type %s", info.Mode().Type())
	}
	if err := ensureResolvedContained(allowedRoot, destination); err != nil {
		return fmt.Errorf("destination escapes the data root: %w", err)
	}
	body, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if err := atomicReplace(destination, body); err != nil {
		return err
	}
	if err := os.Chmod(destination, info.Mode().Perm()); err != nil {
		return err
	}
	return nil
}

func makePublicOverrideWritable(target string) error {
	info, err := os.Stat(target)
	if err != nil {
		return err
	}
	if info.IsDir() {
		if err := os.Chmod(target, info.Mode().Perm()|0o200); err != nil {
			return err
		}
		entries, err := os.ReadDir(target)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := makePublicOverrideWritable(filepath.Join(target, entry.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	if info.Mode().Perm()&0o200 == 0 {
		return os.Chmod(target, info.Mode().Perm()|0o200)
	}
	return nil
}
