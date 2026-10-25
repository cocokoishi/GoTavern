package configinit

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// LockPath returns the lock file that serializes config initialization for configPath.
//
// It is EXPORTED for two reasons, both about a hang being diagnosable rather than mysterious:
//
//   - a boot that cannot take the lock must be able to name the file that is held and pathed to it, so an
//     operator can see WHICH tree is contended instead of "initialisation stopped";
//   - a reproducer for P0-B has to hold the very same file the boot path takes. Deriving the path a second
//     time in the test would be a copy of the rule that can drift, which is exactly the class of defect
//     that produced this bug (a guard that encoded a property nobody else relied on).
func LockPath(configPath string) (string, error) {
	canonical, err := canonicalConfigPath(configPath)
	if err != nil {
		return "", err
	}
	return lockPathFor(canonical), nil
}

func lockPathFor(canonicalConfigPath string) string {
	lockRoot := filepath.Join(os.TempDir(), "gotavern-config-locks")
	key := canonicalConfigPath
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	digest := sha256.Sum256([]byte(key))
	return filepath.Join(lockRoot, hex.EncodeToString(digest[:])+".lock")
}
