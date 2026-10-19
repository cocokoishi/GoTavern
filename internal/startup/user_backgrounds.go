package startup

import (
	"fmt"
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
