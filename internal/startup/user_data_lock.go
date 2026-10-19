package startup

import (
	"fmt"
	"path/filepath"

	"github.com/gofrs/flock"
)

// lockUserContentRoot serializes user-data file mutations with startup seeding
// and other GoTavern writes while ensuring the user root remains under the data root.
func lockUserContentRoot(dataRoot, handle string) (UserDirectories, string, *flock.Flock, error) {
	directories, err := DirectoriesForUser(dataRoot, handle)
	if err != nil {
		return nil, "", nil, err
	}
	userRoot, err := filepath.Abs(directories["root"])
	if err != nil {
		return nil, "", nil, fmt.Errorf("resolve user data root: %w", err)
	}
	lockRoot, err := canonicalPath(filepath.Dir(userRoot))
	if err != nil {
		return nil, "", nil, fmt.Errorf("resolve user data lock root: %w", err)
	}
	lock, err := acquireContentLock(lockRoot)
	if err != nil {
		return nil, "", nil, err
	}
	resolvedUserRoot, err := canonicalPath(userRoot)
	if err != nil {
		_ = lock.Close()
		return nil, "", nil, fmt.Errorf("resolve user data root: %w", err)
	}
	if err := ensureContained(lockRoot, resolvedUserRoot); err != nil {
		_ = lock.Close()
		return nil, "", nil, fmt.Errorf("user data root escapes data root: %w", err)
	}
	return directories, resolvedUserRoot, lock, nil
}
