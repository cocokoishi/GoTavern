package startup

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

const userDataMigrationDelay = 10 * time.Second

type userDataMigration struct {
	sourceRelative string
	destination    string
}

// MigrateUserData moves legacy public data into the default user's data tree.
// It copies each source to its new location and backup before removing it, as
// the pinned startup migration does. waitBeforeMove receives the pinned
// ten-second warning period; nil performs the real delay.
func MigrateUserData(installRoot, dataRoot string, waitBeforeMove func(time.Duration)) ([]error, error) {
	absoluteInstallRoot, err := filepath.Abs(installRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve install root: %w", err)
	}
	absoluteDataRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve data root: %w", err)
	}
	publicRoot := filepath.Join(absoluteInstallRoot, "public")
	charactersPath := filepath.Join(publicRoot, "characters")
	if _, err := os.Stat(charactersPath); err != nil {
		return nil, nil
	}
	if waitBeforeMove == nil {
		waitBeforeMove = time.Sleep
	}
	waitBeforeMove(userDataMigrationDelay)

	userDirectories, err := DirectoriesForUser(absoluteDataRoot, defaultHandle)
	if err != nil {
		return nil, err
	}
	migrations := []userDataMigration{
		{sourceRelative: filepath.Join("public", "assets"), destination: userDirectories["assets"]},
		{sourceRelative: filepath.Join("public", "backgrounds"), destination: userDirectories["backgrounds"]},
		{sourceRelative: filepath.Join("public", "characters"), destination: userDirectories["characters"]},
		{sourceRelative: filepath.Join("public", "chats"), destination: userDirectories["chats"]},
		{sourceRelative: filepath.Join("public", "context"), destination: userDirectories["context"]},
		{sourceRelative: filepath.Join("public", "group chats"), destination: userDirectories["groupChats"]},
		{sourceRelative: filepath.Join("public", "groups"), destination: userDirectories["groups"]},
		{sourceRelative: filepath.Join("public", "instruct"), destination: userDirectories["instruct"]},
		{sourceRelative: filepath.Join("public", "KoboldAI Settings"), destination: userDirectories["koboldAI_Settings"]},
		{sourceRelative: filepath.Join("public", "movingUI"), destination: userDirectories["movingUI"]},
		{sourceRelative: filepath.Join("public", "NovelAI Settings"), destination: userDirectories["novelAI_Settings"]},
		{sourceRelative: filepath.Join("public", "OpenAI Settings"), destination: userDirectories["openAI_Settings"]},
		{sourceRelative: filepath.Join("public", "QuickReplies"), destination: userDirectories["quickreplies"]},
		{sourceRelative: filepath.Join("public", "TextGen Settings"), destination: userDirectories["textGen_Settings"]},
		{sourceRelative: filepath.Join("public", "themes"), destination: userDirectories["themes"]},
		{sourceRelative: filepath.Join("public", "user"), destination: userDirectories["user"]},
		{sourceRelative: filepath.Join("public", "User Avatars"), destination: userDirectories["avatars"]},
		{sourceRelative: filepath.Join("public", "worlds"), destination: userDirectories["worlds"]},
		{sourceRelative: filepath.Join("public", "scripts", "extensions", "third-party"), destination: userDirectories["extensions"]},
		{sourceRelative: "thumbnails", destination: userDirectories["thumbnails"]},
		{sourceRelative: "vectors", destination: userDirectories["vectors"]},
		{sourceRelative: "secrets.json", destination: filepath.Join(userDirectories["root"], "secrets.json")},
		{sourceRelative: filepath.Join("public", "settings.json"), destination: filepath.Join(userDirectories["root"], "settings.json")},
		{sourceRelative: filepath.Join("public", "stats.json"), destination: filepath.Join(userDirectories["root"], "stats.json")},
	}

	lockRoot, err := canonicalPath(absoluteDataRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve user-data migration root: %w", err)
	}
	lock, err := acquireContentLock(lockRoot)
	if err != nil {
		return nil, err
	}
	defer lock.Close()

	backupDirectory := filepath.Join(absoluteInstallRoot, "backups", "_migration", time.Now().UTC().Format("2006-01-02"))
	if err := ensureContained(absoluteInstallRoot, backupDirectory); err != nil {
		return nil, fmt.Errorf("invalid migration backup directory: %w", err)
	}
	if err := os.MkdirAll(backupDirectory, 0o777); err != nil {
		return nil, fmt.Errorf("create migration backup directory: %w", err)
	}

	var migrationErrors []error
	for _, migration := range migrations {
		source := filepath.Join(absoluteInstallRoot, migration.sourceRelative)
		if err := ensureContained(absoluteInstallRoot, source); err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("invalid legacy data path %s: %w", source, err))
			continue
		}
		if _, err := os.Stat(source); err != nil {
			continue
		}
		if err := ensureContained(userDirectories["root"], migration.destination); err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("invalid user-data destination %s: %w", migration.destination, err))
			continue
		}
		backupTarget := filepath.Join(backupDirectory, filepath.Base(migration.sourceRelative))
		if err := ensureContained(backupDirectory, backupTarget); err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("invalid migration backup target %s: %w", backupTarget, err))
			continue
		}
		if err := copyLegacyPath(source, migration.destination, userDirectories["root"]); err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("copy legacy data %s to %s: %w", source, migration.destination, err))
			continue
		}
		if err := copyLegacyPath(source, backupTarget, backupDirectory); err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("back up legacy data %s to %s: %w", source, backupTarget, err))
			continue
		}
		if err := os.RemoveAll(source); err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("remove migrated legacy data %s: %w", source, err))
		}
	}
	return migrationErrors, nil
}

func copyLegacyPath(source, destination, allowedRoot string) error {
	if err := ensureResolvedContained(allowedRoot, destination); err != nil {
		return fmt.Errorf("destination escapes its data root: %w", err)
	}
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		link, err := os.Readlink(source)
		if err != nil {
			return err
		}
		if err := os.RemoveAll(destination); err != nil {
			return err
		}
		return os.Symlink(link, destination)
	}
	if info.IsDir() {
		if targetInfo, err := os.Lstat(destination); err == nil {
			if !targetInfo.IsDir() || targetInfo.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("destination exists and is not a directory")
			}
		} else if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err := os.MkdirAll(destination, info.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(source)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := copyLegacyPath(filepath.Join(source, entry.Name()), filepath.Join(destination, entry.Name()), allowedRoot); err != nil {
				return err
			}
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("unsupported legacy file type %s", info.Mode().Type())
	}
	if targetInfo, err := os.Lstat(destination); err == nil && targetInfo.IsDir() {
		return fmt.Errorf("destination exists and is a directory")
	} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	body, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o777); err != nil {
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

func ensureResolvedContained(root, target string) error {
	resolvedRoot, err := resolveExistingPathPrefix(root)
	if err != nil {
		return err
	}
	resolvedTarget, err := resolveExistingPathPrefix(target)
	if err != nil {
		return err
	}
	return ensureContained(resolvedRoot, resolvedTarget)
}

func resolveExistingPathPrefix(value string) (string, error) {
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	current := filepath.Clean(absolute)
	for {
		if _, err := os.Lstat(current); err == nil {
			resolved, err := filepath.EvalSymlinks(current)
			if err != nil {
				return "", err
			}
			remainder, err := filepath.Rel(current, absolute)
			if err != nil {
				return "", err
			}
			return filepath.Join(resolved, remainder), nil
		} else if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return current, nil
		}
		current = parent
	}
}
