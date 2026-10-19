package startup

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// pinnedMimeDBImageExtensions is derived from the pinned mime-db 1.54.0
// dependency used by SillyTavern's mime-types lookup.
const pinnedMimeDBImageExtensions = "3ds apng avci avcs avif azv b16 bmp btf btif cgm cmx dds dib djv djvu dng dpx drle dwg dxf emf exr fbs fh fh4 fh5 fh7 fhc fits fpx fst g3 gif heic heics heif heifs hej2 ico ief jaii jais jfif jhc jls jng jp2 jpe jpeg jpf jpg jpg2 jpgm jph jpm jpx jxl jxr jxra jxrs jxs jxsc jxsi jxss ktx ktx2 mdi mmr npx pbm pct pcx pgm pic png pnm ppm psd pti ras rgb rlc sgi sid sub svg svgz t38 tap tfx tga tif tiff uvg uvi uvvg uvvi vtf wbmp wdp webp wmf xbm xif xpm xwd"

var pinnedMimeDBImageExtensionSet = makePinnedMimeDBImageExtensionSet()

func UserAvatarImages(dataRoot, handle string) ([]string, error) {
	directories, err := DirectoriesForUser(dataRoot, handle)
	if err != nil {
		return nil, err
	}
	directory := directories["avatars"]
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("read user avatar directory: %w", err)
	}
	images := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		if IsPinnedMimeImageFilename(entry.Name()) {
			images = append(images, entry.Name())
		}
	}
	collator := collate.New(language.AmericanEnglish)
	sort.SliceStable(images, func(left, right int) bool {
		return collator.CompareString(images[left], images[right]) < 0
	})
	return images, nil
}

// DeleteUserAvatar removes an avatar and its persona thumbnail under the shared
// user-data lock. Each unlink remains an atomic filesystem operation.
func DeleteUserAvatar(dataRoot, handle, filename string) (bool, error) {
	directories, userRoot, lock, err := lockUserContentRoot(dataRoot, handle)
	if err != nil {
		return false, err
	}
	defer lock.Close()
	avatarDirectory, err := filepath.Abs(directories["avatars"])
	if err != nil {
		return false, err
	}
	if err := ensureResolvedContained(userRoot, avatarDirectory); err != nil {
		return false, fmt.Errorf("user avatar directory escapes user root: %w", err)
	}
	avatarPath := filepath.Join(avatarDirectory, filename)
	if err := ensureContained(userRoot, avatarPath); err != nil {
		return false, fmt.Errorf("user avatar path escapes user root: %w", err)
	}
	if _, err := os.Stat(avatarPath); err != nil {
		// The upstream existsSync check treats filesystem errors as absence.
		return false, nil
	}
	avatarInfo, err := os.Lstat(avatarPath)
	if err != nil {
		return false, err
	}
	if avatarInfo.IsDir() {
		return false, fmt.Errorf("avatar path %q is a directory", filename)
	}
	if err := os.Remove(avatarPath); err != nil {
		return false, err
	}

	thumbnailDirectory, err := filepath.Abs(directories["thumbnailsPersona"])
	if err != nil {
		return false, err
	}
	if err := ensureResolvedContained(userRoot, thumbnailDirectory); err != nil {
		return false, fmt.Errorf("persona thumbnail directory escapes user root: %w", err)
	}
	thumbnailPath := filepath.Join(thumbnailDirectory, filename)
	if err := ensureContained(userRoot, thumbnailPath); err != nil {
		return false, fmt.Errorf("persona thumbnail path escapes user root: %w", err)
	}
	if _, err := os.Stat(thumbnailPath); err == nil {
		thumbnailInfo, err := os.Lstat(thumbnailPath)
		if err != nil {
			return false, err
		}
		if thumbnailInfo.IsDir() {
			return false, fmt.Errorf("persona thumbnail path %q is a directory", filename)
		}
		if err := os.Remove(thumbnailPath); err != nil {
			return false, err
		}
	}
	return true, nil
}

// IsPinnedMimeImageFilename reports whether the pinned mime-types 3.0.2 /
// mime-db 1.54.0 lookup recognizes filename as an image. mime-types recognizes
// a dotfile such as .png by treating its leading dot as an extension separator.
func IsPinnedMimeImageFilename(filename string) bool {
	base := filepath.Base(filename)
	extension := filepath.Ext("x" + base)
	extension = strings.TrimPrefix(strings.ToLower(extension), ".")
	_, supported := pinnedMimeDBImageExtensionSet[extension]
	return supported
}

func makePinnedMimeDBImageExtensionSet() map[string]struct{} {
	extensions := make(map[string]struct{})
	for _, extension := range strings.Fields(pinnedMimeDBImageExtensions) {
		extensions[extension] = struct{}{}
	}
	return extensions
}
