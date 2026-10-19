package server

import (
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtimeServer *accountRuntime) serveImageMetadataFolderAssign(w http.ResponseWriter, request *http.Request) {
	runtimeServer.serveImageMetadataFolderAssignment(w, request, true)
}

func (runtimeServer *accountRuntime) serveImageMetadataFolderUnassign(w http.ResponseWriter, request *http.Request) {
	runtimeServer.serveImageMetadataFolderAssignment(w, request, false)
}

func (runtimeServer *accountRuntime) serveImageMetadataFolderAssignment(w http.ResponseWriter, request *http.Request, assign bool) {
	account, ok := runtimeServer.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, bodyError, accessError := readImageMetadataRequestBody(request)
	if bodyError {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if accessError {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}
	id, hasID := input.member("id")
	if !hasID || id.kind != 's' && id.kind != 'h' || !id.truthy() {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": `"id" is required.`})
		return
	}
	paths, hasPaths := input.member("paths")
	if !hasPaths || paths.kind != 'a' {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": `"paths" array is required.`})
		return
	}
	folderID, _ := id.javascriptString()
	directories, err := startup.DirectoriesForUser(runtimeServer.options.DataRoot, account.string("handle"))
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}
	userRoot := directories["root"]
	err = startup.UpdateUserContentFile(runtimeServer.options.DataRoot, account.string("handle"), imageMetadataIndexFilename, func(current []byte) ([]byte, error) {
		index := defaultImageMetadataIndex()
		if len(current) > 0 {
			if parsed, parseErr := decodeOrderedNodeJSON(current); parseErr == nil {
				index = parsed
			}
		}
		if assign {
			if index.kind == 'n' {
				return nil, errors.New("image metadata index is null")
			}
			folders, hasFolders := index.member("folders")
			if !hasFolders || folders.kind != 'a' {
				return nil, errors.New("image metadata index folders are not an array")
			}
			found := false
			for _, folder := range folders.array {
				if folder.kind == 'n' {
					return nil, errors.New("image metadata folder entry is null")
				}
				folderValue, hasFolderID := folder.member("id")
				if hasFolderID && nodeJSONStrictEqual(folderValue, id) {
					found = true
					break
				}
			}
			if !found {
				return nil, imageMetadataFolderNotFoundError{id: folderID}
			}
		} else if index.kind == 'n' && len(paths.array) > 0 {
			return nil, errors.New("image metadata index is null")
		}

		images, hasImages := index.member("images")
		for _, rawPath := range paths.array {
			if assign {
				if rawPath.kind != 's' && rawPath.kind != 'h' {
					return nil, errors.New("image metadata path is not a string")
				}
				posixPath, conversionErr := rawPath.javascriptString()
				if conversionErr != nil {
					return nil, conversionErr
				}
				if runtime.GOOS == "windows" {
					posixPath = strings.ReplaceAll(posixPath, `\`, "/")
				}
				normalized := nodePosixNormalize(posixPath)
				if !strings.HasPrefix(normalized, "backgrounds/") || containsPathSegment(normalized, "..") {
					return nil, errors.New("invalid background path")
				}
				fullPath := filepath.Join(userRoot, filepath.FromSlash(normalized))
				if _, statErr := os.Stat(fullPath); statErr != nil {
					continue
				}
				if !hasImages || images.kind == 'n' {
					return nil, errors.New("image metadata index images are null")
				}
				if images.kind != 'o' && images.kind != 'a' {
					return nil, errors.New("image metadata images cannot be assigned")
				}
				meta, hasMeta := images.member(normalized)
				if !hasMeta || !meta.truthy() {
					meta = orderedNodeJSON{kind: 'o'}
					meta.setMember("folderIds", orderedNodeJSON{kind: 'a', array: []orderedNodeJSON{}})
					hasMeta = false
				} else if meta.kind != 'o' && meta.kind != 'a' {
					return nil, errors.New("image metadata entry cannot be updated")
				}
				folderIDs, hasFolderIDs := meta.member("folderIds")
				if !hasFolderIDs || folderIDs.kind != 'a' {
					folderIDs = orderedNodeJSON{kind: 'a', array: []orderedNodeJSON{}}
					if meta.kind == 'o' {
						meta.setMember("folderIds", folderIDs)
					}
				}
				alreadyAssigned := false
				for _, folderIDValue := range folderIDs.array {
					if nodeJSONStrictEqual(folderIDValue, id) {
						alreadyAssigned = true
						break
					}
				}
				if !alreadyAssigned {
					folderIDs.array = append(folderIDs.array, id)
					if meta.kind == 'o' {
						meta.setMember("folderIds", folderIDs)
					}
				}
				if images.kind == 'o' {
					images.setMember(normalized, meta)
				} else if hasMeta {
					// The pinned JavaScript assignment creates a named array property,
					// which JSON.stringify omits.
				}
				continue
			}

			if rawPath.kind != 's' && rawPath.kind != 'h' {
				return nil, errors.New("image metadata path is not a string")
			}
			posixPath, _ := rawPath.javascriptString()
			if runtime.GOOS == "windows" {
				posixPath = strings.ReplaceAll(posixPath, `\`, "/")
			}
			if !hasImages || images.kind == 'n' {
				return nil, errors.New("image metadata index images are null")
			}
			meta, hasMeta := images.member(posixPath)
			if !hasMeta || !meta.truthy() || meta.kind == 'n' {
				continue
			}
			if meta.kind != 'o' {
				continue
			}
			folderIDs, hasFolderIDs := meta.member("folderIds")
			if !hasFolderIDs || folderIDs.kind != 'a' {
				continue
			}
			for folderIndex, folderIDValue := range folderIDs.array {
				if nodeJSONStrictEqual(folderIDValue, id) {
					folderIDs.array = append(folderIDs.array[:folderIndex], folderIDs.array[folderIndex+1:]...)
					meta.setMember("folderIds", folderIDs)
					if images.kind == 'o' {
						images.setMember(posixPath, meta)
					}
					break
				}
			}
		}
		if hasImages {
			index.setMember("images", images)
		}
		return marshalPrettyOrderedNodeJSON(index, 0)
	})
	if err != nil {
		var notFound imageMetadataFolderNotFoundError
		if assign && errors.As(err, &notFound) {
			respondJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}
	respondJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func nodePosixNormalize(value string) string {
	if value == "" {
		return "."
	}
	absolute := strings.HasPrefix(value, "/")
	trailingSlash := strings.HasSuffix(value, "/")
	normalized := path.Clean(value)
	if normalized == "." && absolute {
		return "/"
	}
	if trailingSlash && normalized != "/" {
		normalized += "/"
	}
	return normalized
}

func containsPathSegment(value, segment string) bool {
	for _, part := range strings.Split(value, "/") {
		if part == segment {
			return true
		}
	}
	return false
}
