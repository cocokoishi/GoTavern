package server

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtimeServer *accountRuntime) serveImageMetadataCleanup(w http.ResponseWriter, request *http.Request) {
	account, ok := runtimeServer.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	directories, err := startup.DirectoriesForUser(runtimeServer.options.DataRoot, account.string("handle"))
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}
	userRoot := directories["root"]
	removed := make([]string, 0)
	err = startup.UpdateUserContentFileIfChanged(runtimeServer.options.DataRoot, account.string("handle"), imageMetadataIndexFilename, func(current []byte) ([]byte, bool, error) {
		index := defaultImageMetadataIndex()
		if len(current) > 0 {
			if parsed, parseErr := decodeOrderedNodeJSON(current); parseErr == nil {
				index = parsed
			}
		}
		if index.kind == 'n' {
			return nil, false, errors.New("image metadata index is null")
		}
		images, hasImages := index.member("images")
		entries, enumerable := images.entries()
		if !hasImages || !enumerable {
			return nil, false, errors.New("image metadata index images are not enumerable")
		}
		changed := false
		for entryIndex, entry := range entries {
			fullPath, resolveErr := nodeResolvePath(userRoot, entry.key)
			if resolveErr != nil {
				return nil, false, resolveErr
			}
			if !nodePathUnderParent(userRoot, fullPath) {
				if images.kind == 's' {
					return nil, false, errors.New("cannot delete metadata key from string image index")
				}
				removed = append(removed, entry.key)
				deleteImageMetadataKey(&images, entry.key, entryIndex)
				changed = true
				continue
			}
			if _, statErr := os.Stat(fullPath); statErr != nil {
				if images.kind == 's' {
					return nil, false, errors.New("cannot delete metadata key from string image index")
				}
				removed = append(removed, entry.key)
				deleteImageMetadataKey(&images, entry.key, entryIndex)
				changed = true
			}
		}
		if !changed {
			return nil, false, nil
		}
		index.setMember("images", images)
		body, marshalErr := marshalPrettyOrderedNodeJSON(index, 0)
		return body, true, marshalErr
	})
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}
	respondJSON(w, http.StatusOK, struct {
		Removed []string `json:"removed"`
		Count   int      `json:"count"`
	}{removed, len(removed)})
}

func deleteImageMetadataKey(images *orderedNodeJSON, key string, entryIndex int) {
	if images.kind == 'o' {
		images.deleteMember(key)
		return
	}
	if images.kind == 'a' {
		index, err := strconv.Atoi(key)
		if err == nil && index >= 0 && index < len(images.array) && index == entryIndex {
			images.array[index] = orderedNodeJSON{kind: 'n'}
		}
	}
}

func nodeResolvePath(userRoot, relativePath string) (string, error) {
	if filepath.IsAbs(relativePath) {
		return filepath.Clean(relativePath), nil
	}
	return filepath.Abs(filepath.Join(userRoot, filepath.FromSlash(relativePath)))
}

func nodePathUnderParent(parentPath, childPath string) bool {
	normalizedParent := filepath.Clean(parentPath)
	normalizedChild := filepath.Clean(childPath)
	relativePath, err := filepath.Rel(normalizedParent, normalizedChild)
	if err != nil {
		return false
	}
	return relativePath != ".." && !strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) && !filepath.IsAbs(relativePath)
}
