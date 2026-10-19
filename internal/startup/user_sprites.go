package startup

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type UserSprite struct {
	Label string `json:"label"`
	Path  string `json:"path"`
}

// UserSprites returns the pinned sprite-list response. The upstream route
// catches filesystem errors and responds with an empty array, so this helper
// deliberately does the same.
func UserSprites(dataRoot, handle, name string) []UserSprite {
	empty := []UserSprite{}
	directories, err := DirectoriesForUser(dataRoot, handle)
	if err != nil {
		return empty
	}
	spriteDirectory, ok := userSpritesDirectory(directories["characters"], name)
	if !ok {
		return empty
	}
	info, err := os.Stat(spriteDirectory)
	if err != nil || !info.IsDir() {
		return empty
	}
	directory, err := os.Open(spriteDirectory)
	if err != nil {
		return empty
	}
	entries, err := directory.ReadDir(-1)
	_ = directory.Close()
	if err != nil {
		return empty
	}
	sprites := make([]UserSprite, 0, len(entries))
	for _, entry := range entries {
		if !IsPinnedMimeImageFilename(entry.Name()) {
			continue
		}
		filePath := filepath.Join(spriteDirectory, entry.Name())
		fileInfo, err := os.Stat(filePath)
		if err != nil {
			return empty
		}
		nameWithoutExtension := userSpriteParsedName(entry.Name())
		nameWithoutExtension = strings.ToLower(nameWithoutExtension)
		label := userSpriteLabel(nameWithoutExtension)
		spritePath := "/characters/" + name + "/" + entry.Name()
		spritePath += "?t=" + fileInfo.ModTime().UTC().Format("20060102150405")
		sprites = append(sprites, UserSprite{Label: label, Path: spritePath})
	}
	return sprites
}

func userSpritesDirectory(charactersDirectory, name string) (string, bool) {
	if strings.Contains(name, "/") {
		nameParts := strings.Split(name, "/")
		if len(nameParts) < 2 {
			return "", false
		}
		characterName := SanitizeUserFilename(nameParts[0])
		subfolderName := SanitizeUserFilename(nameParts[1])
		if characterName == "" || subfolderName == "" {
			return "", false
		}
		return filepath.Join(charactersDirectory, characterName, subfolderName), true
	}
	name = SanitizeUserFilename(name)
	if name == "" {
		return "", false
	}
	return filepath.Join(charactersDirectory, name), true
}

func userSpriteParsedName(filename string) string {
	base := filepath.Base(filename)
	extension := filepath.Ext(base)
	if extension != "" && strings.HasPrefix(base, ".") && !strings.Contains(base[1:], ".") {
		extension = ""
	}
	return strings.TrimSuffix(base, extension)
}

func userSpriteLabel(filename string) string {
	for index := 1; index < len(filename); index++ {
		if filename[index] == '-' || filename[index] == '.' {
			return filename[:index]
		}
	}
	return filename
}

// DeleteUserSpriteFiles removes every directory entry whose parsed base name
// exactly matches spriteName. The upstream route treats a non-string
// spriteName as a valid request that simply cannot match a filename.
func DeleteUserSpriteFiles(dataRoot, handle, name, spriteName string, matchName bool) (bool, error) {
	directories, resolvedUserRoot, lock, err := lockUserContentRoot(dataRoot, handle)
	if err != nil {
		return false, err
	}
	defer lock.Close()
	spriteDirectory, valid := userSpritesDirectory(directories["characters"], name)
	if !valid {
		return false, nil
	}
	spriteDirectory, err = filepath.Abs(spriteDirectory)
	if err != nil {
		return false, err
	}
	if err := ensureResolvedContained(resolvedUserRoot, spriteDirectory); err != nil {
		return false, fmt.Errorf("user sprite directory escapes user root: %w", err)
	}
	info, err := os.Stat(spriteDirectory)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.IsDir() {
		return false, nil
	}
	directory, err := os.Open(spriteDirectory)
	if err != nil {
		return false, err
	}
	entries, err := directory.ReadDir(-1)
	_ = directory.Close()
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if !matchName || userSpriteParsedName(entry.Name()) != spriteName {
			continue
		}
		target := filepath.Join(spriteDirectory, entry.Name())
		info, err := os.Lstat(target)
		if err != nil {
			return false, err
		}
		if info.IsDir() {
			return false, fmt.Errorf("sprite entry %q is a directory", entry.Name())
		}
		if err := os.Remove(target); err != nil {
			return false, err
		}
	}
	return true, nil
}
