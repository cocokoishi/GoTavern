package startup

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// MigrateFlatSecrets converts legacy string-valued per-user secrets to the
// pinned array format, writing a copy of the original file before replacement.
func MigrateFlatSecrets(directoriesList []UserDirectories) []error {
	var migrationErrors []error
	for _, directories := range directoriesList {
		if err := migrateFlatSecretsForUser(directories); err != nil {
			migrationErrors = append(migrationErrors, err)
		}
	}
	return migrationErrors
}

func migrateFlatSecretsForUser(directories UserDirectories) error {
	root := directories["root"]
	if root == "" {
		return errors.New("user directory set is missing root")
	}
	userRoot, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("resolve secrets root %s: %w", root, err)
	}
	lockRoot, err := canonicalPath(filepath.Dir(userRoot))
	if err != nil {
		return fmt.Errorf("resolve secrets migration lock root: %w", err)
	}
	lock, err := acquireContentLock(lockRoot)
	if err != nil {
		return err
	}
	defer lock.Close()

	secretsPath := filepath.Join(userRoot, "secrets.json")
	info, err := os.Stat(secretsPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect secrets file for %s: %w", userRoot, err)
	}
	resolvedUserRoot, err := canonicalPath(userRoot)
	if err != nil {
		return fmt.Errorf("resolve secrets user root: %w", err)
	}
	if err := ensureContained(lockRoot, resolvedUserRoot); err != nil {
		return fmt.Errorf("secrets user root escapes data root: %w", err)
	}
	if err := ensureResolvedContained(userRoot, secretsPath); err != nil {
		return fmt.Errorf("secrets file escapes user root %s: %w", userRoot, err)
	}
	original, err := os.ReadFile(secretsPath)
	if err != nil {
		return fmt.Errorf("read secrets file for %s: %w", userRoot, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("secrets file for %s is not a regular file", userRoot)
	}

	secrets, err := decodeOrderedJSON(original)
	if err != nil {
		return fmt.Errorf("parse secrets file for %s: %w", userRoot, err)
	}
	values, err := flatSecretObjectValues(secrets)
	if err != nil {
		return fmt.Errorf("read flat secrets for %s: %w", userRoot, err)
	}
	if flatSecretMigratedMarker(secrets) || len(values) == 0 {
		return nil
	}
	for _, value := range values {
		if _, isArray := value.(orderedJSONArray); isArray {
			return nil
		}
	}

	entries, err := flatSecretObjectEntries(secrets)
	if err != nil {
		return fmt.Errorf("enumerate flat secrets for %s: %w", userRoot, err)
	}
	migrated := &orderedJSONObject{}
	for _, entry := range entries {
		value, isString := entry.value.(nodeJSONString)
		if !isString || strings.TrimFunc(string(value), isJavaScriptTrimSpace) == "" {
			continue
		}
		// Assignment to this key on the upstream plain object changes its
		// prototype instead of creating an enumerable property.
		if entry.key == "__proto__" {
			continue
		}
		id, err := newSecretUUID()
		if err != nil {
			return fmt.Errorf("generate migrated secret ID for %s: %w", userRoot, err)
		}
		secret := &orderedJSONObject{members: []orderedJSONMember{
			{key: "id", value: nodeJSONString(id)},
			{key: "value", value: value},
			{key: "label", value: nodeJSONString(entry.key)},
			{key: "active", value: true},
		}}
		migrated.set(entry.key, orderedJSONArray{secret})
	}
	migrated.set("_migrated", orderedJSONArray{})
	updated, err := marshalNodeJSONIndent(migrated)
	if err != nil {
		return fmt.Errorf("serialize migrated secrets for %s: %w", userRoot, err)
	}

	backupsDirectory := directories["backups"]
	if backupsDirectory == "" {
		return errors.New("user directory set is missing backups")
	}
	absoluteBackups, err := filepath.Abs(backupsDirectory)
	if err != nil {
		return fmt.Errorf("resolve secrets backup directory %s: %w", backupsDirectory, err)
	}
	if err := ensureContained(userRoot, absoluteBackups); err != nil {
		return fmt.Errorf("secrets backup directory escapes user root %s: %w", userRoot, err)
	}
	if err := ensureResolvedContained(userRoot, absoluteBackups); err != nil {
		return fmt.Errorf("secrets backup directory escapes user root %s: %w", userRoot, err)
	}
	backupPath := filepath.Join(absoluteBackups, fmt.Sprintf("secrets_migration_%d.json", time.Now().UnixMilli()))
	if err := ensureContained(userRoot, backupPath); err != nil {
		return fmt.Errorf("invalid secrets backup path for %s: %w", userRoot, err)
	}
	if err := ensureResolvedContained(userRoot, backupPath); err != nil {
		return fmt.Errorf("secrets backup path escapes user root %s: %w", userRoot, err)
	}
	if err := atomicSecretBackup(backupPath, original, info.Mode().Perm()); err != nil {
		return fmt.Errorf("back up secrets file for %s: %w", userRoot, err)
	}
	if err := atomicReplace(secretsPath, updated); err != nil {
		return fmt.Errorf("write migrated secrets for %s: %w", userRoot, err)
	}
	return nil
}

func flatSecretObjectValues(value any) ([]any, error) {
	entries, err := flatSecretObjectEntries(value)
	if err != nil {
		return nil, err
	}
	values := make([]any, len(entries))
	for index, entry := range entries {
		values[index] = entry.value
	}
	return values, nil
}

func flatSecretObjectEntries(value any) ([]orderedJSONMember, error) {
	switch typed := value.(type) {
	case *orderedJSONObject:
		return javascriptOrderedMembers(typed.members), nil
	case orderedJSONArray:
		entries := make([]orderedJSONMember, len(typed))
		for index, item := range typed {
			entries[index] = orderedJSONMember{key: fmt.Sprint(index), value: item}
		}
		return entries, nil
	case nodeJSONString:
		entries := make([]orderedJSONMember, 0, len(typed))
		for index, character := range []rune(string(typed)) {
			entries = append(entries, orderedJSONMember{key: fmt.Sprint(index), value: nodeJSONString(string(character))})
		}
		return entries, nil
	case nil:
		return nil, errors.New("Cannot convert undefined or null to object")
	default:
		return nil, nil
	}
}

func flatSecretMigratedMarker(value any) bool {
	object, ok := value.(*orderedJSONObject)
	if !ok {
		return false
	}
	marker, exists := object.get("_migrated")
	return exists && flatSecretTruthy(marker)
}

func flatSecretTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case nodeJSONString:
		return typed != ""
	case nodeJSONNumber:
		return typed != 0
	default:
		return nodeTruthy(value)
	}
}

func isJavaScriptTrimSpace(character rune) bool {
	return character == '\u0009' || character == '\u000a' || character == '\u000b' || character == '\u000c' || character == '\u000d' ||
		character == '\u0020' || character == '\u00a0' || character == '\u1680' ||
		(character >= '\u2000' && character <= '\u200a') || character == '\u2028' || character == '\u2029' ||
		character == '\u202f' || character == '\u205f' || character == '\u3000' || character == '\ufeff'
}

func newSecretUUID() (string, error) {
	var identifier [16]byte
	if _, err := rand.Read(identifier[:]); err != nil {
		return "", err
	}
	identifier[6] = (identifier[6] & 0x0f) | 0x40
	identifier[8] = (identifier[8] & 0x3f) | 0x80
	encoded := make([]byte, 32)
	hex.Encode(encoded, identifier[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", encoded[0:8], encoded[8:12], encoded[12:16], encoded[16:20], encoded[20:32]), nil
}

func atomicSecretBackup(destination string, body []byte, mode os.FileMode) error {
	if err := atomicReplace(destination, body); err != nil {
		return err
	}
	return os.Chmod(destination, mode)
}
