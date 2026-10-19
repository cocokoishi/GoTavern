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

// userAvatarImageExtensions is derived from the pinned mime-db 1.54.0
// dependency used by SillyTavern's getImages helper.
const userAvatarImageExtensions = "3ds apng avci avcs avif azv b16 bmp btf btif cgm cmx dds dib djv djvu dng dpx drle dwg dxf emf exr fbs fh fh4 fh5 fh7 fhc fits fpx fst g3 gif heic heics heif heifs hej2 ico ief jaii jais jfif jhc jls jng jp2 jpe jpeg jpf jpg jpg2 jpgm jph jpm jpx jxl jxr jxra jxrs jxs jxsc jxsi jxss ktx ktx2 mdi mmr npx pbm pct pcx pgm pic png pnm ppm psd pti ras rgb rlc sgi sid sub svg svgz t38 tap tfx tga tif tiff uvg uvi uvvg uvvi vtf wbmp wdp webp wmf xbm xif xpm xwd"

var userAvatarImageExtensionSet = makeUserAvatarImageExtensionSet()

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
		extension := nodeAvatarExtension(entry.Name())
		if _, supported := userAvatarImageExtensionSet[extension]; supported {
			images = append(images, entry.Name())
		}
	}
	collator := collate.New(language.AmericanEnglish)
	sort.SliceStable(images, func(left, right int) bool {
		return collator.CompareString(images[left], images[right]) < 0
	})
	return images, nil
}

func nodeAvatarExtension(filename string) string {
	base := filepath.Base(filename)
	extension := filepath.Ext("x" + base)
	return strings.TrimPrefix(strings.ToLower(extension), ".")
}

func makeUserAvatarImageExtensionSet() map[string]struct{} {
	extensions := make(map[string]struct{})
	for _, extension := range strings.Fields(userAvatarImageExtensions) {
		extensions[extension] = struct{}{}
	}
	return extensions
}
