package startup

import (
	"fmt"
	"os"
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
