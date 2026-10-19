package startup

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/gofrs/flock"
)

const cookieSecretLockFolderName = "gotavern-cookie-secret-locks"

// CookieSecretResult describes the source of the returned secret.
type CookieSecretResult struct {
	Existing  bool
	Migrated  bool
	Generated bool
}

// InitializeCookieSecret returns the existing DATA_ROOT secret when it is
// nonempty, migrates a supplied legacy config value, or generates 64 random
// bytes encoded as base64. The file is written atomically under a process lock.
func InitializeCookieSecret(dataRoot, legacySecret string) (string, CookieSecretResult, error) {
	absoluteRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return "", CookieSecretResult{}, fmt.Errorf("resolve data root: %w", err)
	}
	secretPath := filepath.Join(absoluteRoot, "cookie-secret.txt")
	lock, err := acquireCookieSecretLock(secretPath)
	if err != nil {
		return "", CookieSecretResult{}, err
	}
	defer lock.Close()

	info, statErr := os.Stat(secretPath)
	if statErr == nil && info.Size() > 0 {
		body, err := os.ReadFile(secretPath)
		if err != nil {
			return "", CookieSecretResult{}, fmt.Errorf("read cookie secret %s: %w", secretPath, err)
		}
		return strings.ToValidUTF8(string(body), "\uFFFD"), CookieSecretResult{Existing: true}, nil
	}
	if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
		return "", CookieSecretResult{}, fmt.Errorf("inspect cookie secret %s: %w", secretPath, statErr)
	}

	if legacySecret != "" {
		if err := atomicReplace(secretPath, []byte(legacySecret)); err != nil {
			return "", CookieSecretResult{}, fmt.Errorf("migrate cookie secret to %s: %w", secretPath, err)
		}
		return legacySecret, CookieSecretResult{Migrated: true}, nil
	}

	randomSecret := make([]byte, 64)
	if _, err := rand.Read(randomSecret); err != nil {
		return "", CookieSecretResult{}, fmt.Errorf("generate cookie secret: %w", err)
	}
	secret := base64.StdEncoding.EncodeToString(randomSecret)
	if err := atomicReplace(secretPath, []byte(secret)); err != nil {
		return "", CookieSecretResult{}, fmt.Errorf("write cookie secret %s: %w", secretPath, err)
	}
	return secret, CookieSecretResult{Generated: true}, nil
}

func acquireCookieSecretLock(secretPath string) (*flock.Flock, error) {
	lockRoot := filepath.Join(os.TempDir(), cookieSecretLockFolderName)
	if err := os.MkdirAll(lockRoot, 0o700); err != nil {
		return nil, fmt.Errorf("create cookie-secret lock directory: %w", err)
	}
	key := secretPath
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	digest := sha256.Sum256([]byte(key))
	lockPath := filepath.Join(lockRoot, hex.EncodeToString(digest[:])+".lock")
	lock := flock.New(lockPath, flock.SetPermissions(0o600))
	if err := lock.Lock(); err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("lock cookie secret %s: %w", secretPath, err)
	}
	return lock, nil
}
