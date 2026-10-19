package startup

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/gofrs/flock"
)

// QuickReplyFilename applies the pinned sanitize-filename 1.6.3 behavior to
// `${String(name)}.json`, as used by the SillyTavern quick-reply endpoints.
func QuickReplyFilename(nameJSON []byte) (string, error) {
	value, err := decodeOrderedJSON(nameJSON)
	if err != nil {
		return "", err
	}
	return sanitizeQuickReplyFilename(nodeString(value) + ".json"), nil
}

// SaveQuickReplyPreset atomically writes one preset while holding the shared
// data-root lock used by startup data mutations.
func SaveQuickReplyPreset(dataRoot, handle, filename string, body []byte) error {
	directory, lock, err := lockQuickReplyDirectory(dataRoot, handle)
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
	directory, lock, err := lockQuickReplyDirectory(dataRoot, handle)
	if err != nil {
		return err
	}
	defer lock.Close()
	target := filepath.Join(directory, filename)
	if err := ensureContained(directory, target); err != nil {
		return err
	}
	if _, err := os.Stat(target); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return nil
	}
	entry, err := os.Lstat(target)
	if err != nil {
		return err
	}
	if entry.IsDir() {
		return fmt.Errorf("unlink quick reply preset %s: path is a directory", filename)
	}
	return os.Remove(target)
}

func lockQuickReplyDirectory(dataRoot, handle string) (string, *flock.Flock, error) {
	directories, err := DirectoriesForUser(dataRoot, handle)
	if err != nil {
		return "", nil, err
	}
	userRoot, err := filepath.Abs(directories["root"])
	if err != nil {
		return "", nil, fmt.Errorf("resolve quick-reply user root: %w", err)
	}
	lockRoot, err := canonicalPath(filepath.Dir(userRoot))
	if err != nil {
		return "", nil, fmt.Errorf("resolve quick-reply lock root: %w", err)
	}
	lock, err := acquireContentLock(lockRoot)
	if err != nil {
		return "", nil, err
	}
	resolvedUserRoot, err := canonicalPath(userRoot)
	if err != nil {
		_ = lock.Close()
		return "", nil, fmt.Errorf("resolve quick-reply user root: %w", err)
	}
	if err := ensureContained(lockRoot, resolvedUserRoot); err != nil {
		_ = lock.Close()
		return "", nil, fmt.Errorf("quick-reply user root escapes data root: %w", err)
	}
	directory, err := filepath.Abs(directories["quickreplies"])
	if err != nil {
		_ = lock.Close()
		return "", nil, fmt.Errorf("resolve quick-reply directory: %w", err)
	}
	if err := ensureResolvedContained(resolvedUserRoot, directory); err != nil {
		_ = lock.Close()
		return "", nil, fmt.Errorf("quick-reply directory escapes user root: %w", err)
	}
	return directory, lock, nil
}

func sanitizeQuickReplyFilename(input string) string {
	var cleaned strings.Builder
	cleaned.Grow(len(input))
	for _, character := range input {
		if isQuickReplyIllegal(character) || character <= 0x1f || (character >= 0x80 && character <= 0x9f) {
			continue
		}
		cleaned.WriteRune(character)
	}
	filename := cleaned.String()
	if strings.Trim(filename, ".") == "" {
		filename = ""
	}
	if isWindowsReservedQuickReplyName(filename) {
		filename = ""
	}
	filename = strings.TrimRight(filename, ". ")
	return truncateQuickReplyUTF8(filename, 255)
}

func isQuickReplyIllegal(character rune) bool {
	switch character {
	case '/', '?', '<', '>', '\\', ':', '*', '|', '"':
		return true
	default:
		return false
	}
}

func isWindowsReservedQuickReplyName(filename string) bool {
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

func truncateQuickReplyUTF8(input string, maxBytes int) string {
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
