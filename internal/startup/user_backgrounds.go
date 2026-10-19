package startup

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// UserBackgroundImages returns regular image files in a user's backgrounds
// directory, sorted with the pinned server's default English collator.
func UserBackgroundImages(dataRoot, handle string) ([]string, error) {
	directories, err := DirectoriesForUser(dataRoot, handle)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(directories["backgrounds"])
	if err != nil {
		return nil, fmt.Errorf("read user background directory: %w", err)
	}
	images := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.Type().IsRegular() && IsPinnedMimeImageFilename(entry.Name()) {
			images = append(images, entry.Name())
		}
	}
	collator := collate.New(language.AmericanEnglish)
	sort.SliceStable(images, func(left, right int) bool {
		return collator.CompareString(images[left], images[right]) < 0
	})
	return images, nil
}

// DeleteUserBackground removes a background and its cached thumbnail while
// holding the same per-user lock used by other GoTavern data mutations.
func DeleteUserBackground(dataRoot, handle, filename string) (bool, error) {
	directories, userRoot, lock, err := lockUserContentRoot(dataRoot, handle)
	if err != nil {
		return false, err
	}
	defer lock.Close()

	backgroundDirectory, err := backgroundUserDirectory(userRoot, directories["backgrounds"])
	if err != nil {
		return false, err
	}
	backgroundPath := filepath.Join(backgroundDirectory, filename)
	if err := ensureContained(userRoot, backgroundPath); err != nil {
		return false, fmt.Errorf("background path escapes user data root: %w", err)
	}
	if _, err := os.Stat(backgroundPath); err != nil {
		// Node's existsSync treats missing files and filesystem errors as absent.
		return false, nil
	}
	backgroundInfo, err := os.Lstat(backgroundPath)
	if err != nil {
		return false, err
	}
	if backgroundInfo.IsDir() {
		return false, fmt.Errorf("background path %q is a directory", filename)
	}
	if err := os.Remove(backgroundPath); err != nil {
		return false, err
	}

	thumbnailDirectory, err := backgroundUserDirectory(userRoot, directories["thumbnailsBg"])
	if err != nil {
		return true, err
	}
	thumbnailPath := filepath.Join(thumbnailDirectory, filename)
	if err := ensureContained(userRoot, thumbnailPath); err != nil {
		return true, fmt.Errorf("background thumbnail path escapes user data root: %w", err)
	}
	if _, err := os.Stat(thumbnailPath); err != nil {
		return true, nil
	}
	thumbnailInfo, err := os.Lstat(thumbnailPath)
	if err != nil {
		return true, err
	}
	if thumbnailInfo.IsDir() {
		return true, fmt.Errorf("background thumbnail path %q is a directory", filename)
	}
	if err := os.Remove(thumbnailPath); err != nil {
		return true, err
	}
	return true, nil
}

// RenameUserBackground atomically copies a background to its new name, removes
// the old file, and invalidates the old thumbnail while holding the user lock.
func RenameUserBackground(dataRoot, handle, oldFilename, newFilename string) (bool, error) {
	directories, userRoot, lock, err := lockUserContentRoot(dataRoot, handle)
	if err != nil {
		return false, err
	}
	defer lock.Close()

	backgroundDirectory, err := backgroundUserDirectory(userRoot, directories["backgrounds"])
	if err != nil {
		return false, err
	}
	oldPath := filepath.Join(backgroundDirectory, oldFilename)
	newPath := filepath.Join(backgroundDirectory, newFilename)
	if err := ensureContained(userRoot, oldPath); err != nil {
		return false, fmt.Errorf("old background path escapes user data root: %w", err)
	}
	if err := ensureContained(userRoot, newPath); err != nil {
		return false, fmt.Errorf("new background path escapes user data root: %w", err)
	}
	oldInfo, err := os.Stat(oldPath)
	if err != nil {
		// Node's existsSync treats missing files and filesystem errors as absent.
		return false, nil
	}
	if _, err := os.Stat(newPath); err == nil {
		return false, nil
	}
	if !oldInfo.Mode().IsRegular() {
		return false, fmt.Errorf("background source %q is not a regular file", oldFilename)
	}
	if err := copyBackgroundFileAtomically(oldPath, newPath); err != nil {
		return false, err
	}
	if err := os.Remove(oldPath); err != nil {
		return false, err
	}

	thumbnailDirectory, err := backgroundUserDirectory(userRoot, directories["thumbnailsBg"])
	if err != nil {
		return true, err
	}
	thumbnailPath := filepath.Join(thumbnailDirectory, oldFilename)
	if err := ensureContained(userRoot, thumbnailPath); err != nil {
		return true, fmt.Errorf("background thumbnail path escapes user data root: %w", err)
	}
	if _, err := os.Stat(thumbnailPath); err != nil {
		return true, nil
	}
	thumbnailInfo, err := os.Lstat(thumbnailPath)
	if err != nil {
		return true, err
	}
	if thumbnailInfo.IsDir() {
		return true, fmt.Errorf("background thumbnail path %q is a directory", oldFilename)
	}
	if err := os.Remove(thumbnailPath); err != nil {
		return true, err
	}
	return true, nil
}

func copyBackgroundFileAtomically(source, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()

	var temporary *os.File
	for attempt := 0; attempt < 8; attempt++ {
		token := make([]byte, 16)
		if _, err := rand.Read(token); err != nil {
			return err
		}
		name := ".gotavern-background-rename-" + hex.EncodeToString(token) + ".tmp"
		file, err := os.OpenFile(filepath.Join(filepath.Dir(target), name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		temporary = file
		break
	}
	if temporary == nil {
		return fmt.Errorf("could not allocate a background rename temporary file")
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if _, err := io.Copy(temporary, input); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, target); err != nil {
		return err
	}
	if directory, err := os.Open(filepath.Dir(target)); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

func backgroundUserDirectory(userRoot, directory string) (string, error) {
	resolved, err := filepath.Abs(directory)
	if err != nil {
		return "", err
	}
	if err := ensureResolvedContained(userRoot, resolved); err != nil {
		return "", fmt.Errorf("background directory escapes user data root: %w", err)
	}
	return resolved, nil
}
