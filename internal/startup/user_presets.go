package startup

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/gofrs/flock"
)

// UserPresetFilename applies the pinned sanitize-filename 1.6.3 behavior to
// the JavaScript String(name) plus ".json" filename used by preset endpoints.
func UserPresetFilename(nameJSON []byte) (string, error) {
	value, err := decodeOrderedJSON(nameJSON)
	if err != nil {
		return "", err
	}
	return sanitizeUserPresetFilename(nodeString(value) + ".json"), nil
}

// SaveQuickReplyPreset atomically writes one preset while holding the shared
// data-root lock used by startup data mutations.
func SaveQuickReplyPreset(dataRoot, handle, filename string, body []byte) error {
	return saveUserPreset(dataRoot, handle, "quickreplies", filename, body)
}

// SaveThemePreset atomically writes one theme while holding the shared data-root lock.
func SaveThemePreset(dataRoot, handle, filename string, body []byte) error {
	return saveUserPreset(dataRoot, handle, "themes", filename, body)
}

func saveUserPreset(dataRoot, handle, directoryKey, filename string, body []byte) error {
	directory, lock, err := lockUserPresetDirectory(dataRoot, handle, directoryKey)
	if err != nil {
		return err
	}
	defer lock.Close()
	target := filepath.Join(directory, filename)
	if err := ensureContained(directory, target); err != nil {
		return err
	}
	return atomicReplace(target, body)
}

// DeleteQuickReplyPreset removes an existing preset. Missing presets succeed
// without mutation, matching the pinned existsSync/unlinkSync sequence.
func DeleteQuickReplyPreset(dataRoot, handle, filename string) error {
	return deleteUserPreset(dataRoot, handle, "quickreplies", filename, true)
}

// DeleteThemePreset removes one theme and reports missing files to preserve the
// pinned endpoint's 404 response.
func DeleteThemePreset(dataRoot, handle, filename string) error {
	return deleteUserPreset(dataRoot, handle, "themes", filename, false)
}

func deleteUserPreset(dataRoot, handle, directoryKey, filename string, missingOK bool) error {
	directory, lock, err := lockUserPresetDirectory(dataRoot, handle, directoryKey)
	if err != nil {
		return err
	}
	defer lock.Close()
	target := filepath.Join(directory, filename)
	if err := ensureContained(directory, target); err != nil {
		return err
	}
	if _, err := os.Stat(target); err != nil {
		if missingOK {
			return nil
		}
		return fs.ErrNotExist
	}
	entry, err := os.Lstat(target)
	if err != nil {
		return err
	}
	if entry.IsDir() {
		return fmt.Errorf("unlink user preset %s: path is a directory", filename)
	}
	return os.Remove(target)
}

func lockUserPresetDirectory(dataRoot, handle, directoryKey string) (string, *flock.Flock, error) {
	directories, err := DirectoriesForUser(dataRoot, handle)
	if err != nil {
		return "", nil, err
	}
	userRoot, err := filepath.Abs(directories["root"])
	if err != nil {
		return "", nil, fmt.Errorf("resolve user preset root: %w", err)
	}
	lockRoot, err := canonicalPath(filepath.Dir(userRoot))
	if err != nil {
		return "", nil, fmt.Errorf("resolve user preset lock root: %w", err)
	}
	lock, err := acquireContentLock(lockRoot)
	if err != nil {
		return "", nil, err
	}
	resolvedUserRoot, err := canonicalPath(userRoot)
	if err != nil {
		_ = lock.Close()
		return "", nil, fmt.Errorf("resolve user preset root: %w", err)
	}
	if err := ensureContained(lockRoot, resolvedUserRoot); err != nil {
		_ = lock.Close()
		return "", nil, fmt.Errorf("user preset root escapes data root: %w", err)
	}
	directoryPath, exists := directories[directoryKey]
	if !exists {
		_ = lock.Close()
		return "", nil, fmt.Errorf("unknown user preset directory %q", directoryKey)
	}
	directory, err := filepath.Abs(directoryPath)
	if err != nil {
		_ = lock.Close()
		return "", nil, fmt.Errorf("resolve user preset directory: %w", err)
	}
	if err := ensureResolvedContained(resolvedUserRoot, directory); err != nil {
		_ = lock.Close()
		return "", nil, fmt.Errorf("user preset directory escapes user root: %w", err)
	}
	return directory, lock, nil
}

func sanitizeUserPresetFilename(input string) string {
	var cleaned strings.Builder
	cleaned.Grow(len(input))
	for _, character := range input {
		if isUserPresetIllegal(character) || character <= 0x1f || (character >= 0x80 && character <= 0x9f) {
			continue
		}
		cleaned.WriteRune(character)
	}
	filename := cleaned.String()
	if strings.Trim(filename, ".") == "" {
		filename = ""
	}
	if isWindowsReservedUserPresetName(filename) {
		filename = ""
	}
	filename = strings.TrimRight(filename, ". ")
	return truncateUserPresetUTF8(filename, 255)
}

func isUserPresetIllegal(character rune) bool {
	switch character {
	case '/', '?', '<', '>', '\\', ':', '*', '|', '"':
		return true
	default:
		return false
	}
}

func isWindowsReservedUserPresetName(filename string) bool {
	base := filename
	if index := strings.IndexByte(base, '.'); index >= 0 {
		base = base[:index]
	}
	base = strings.ToLower(base)
	if base == "con" || base == "prn" || base == "aux" || base == "nul" {
		return true
	}
	if len(base) == 4 && (strings.HasPrefix(base, "com") || strings.HasPrefix(base, "lpt")) && base[3] >= '0' && base[3] <= '9' {
		return true
	}
	return false
}

func truncateUserPresetUTF8(input string, maxBytes int) string {
	if len(input) <= maxBytes {
		return input
	}
	length := 0
	for index, character := range input {
		width := utf8.RuneLen(character)
		if width < 0 || length+width > maxBytes {
			return input[:index]
		}
		length += width
	}
	return input
}
