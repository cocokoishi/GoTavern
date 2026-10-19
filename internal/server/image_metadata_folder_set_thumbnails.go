package server

import (
	"errors"
	"net/http"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveImageMetadataFolderSetThumbnails(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
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
	updates, exists := input.member("updates")
	if !exists || updates.kind != 'a' {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": `"updates" must be an array of {id, thumbnailFile}.`})
		return
	}
	for _, update := range updates.array {
		if update.kind == 'n' {
			respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
			return
		}
		id, hasID := update.member("id")
		thumbnailFile, hasThumbnail := update.member("thumbnailFile")
		if !hasID || !id.truthy() || !hasThumbnail || thumbnailFile.kind != 's' {
			respondJSON(w, http.StatusBadRequest, map[string]string{"error": `"updates" must be an array of {id, thumbnailFile}.`})
			return
		}
	}

	err := startup.UpdateUserContentFile(runtime.options.DataRoot, account.string("handle"), imageMetadataIndexFilename, func(current []byte) ([]byte, error) {
		index := defaultImageMetadataIndex()
		if len(current) > 0 {
			if parsed, parseErr := decodeOrderedNodeJSON(current); parseErr == nil {
				index = parsed
			}
		}
		for _, update := range updates.array {
			if index.kind == 'n' {
				return nil, errors.New("image metadata index is null")
			}
			folders, hasFolders := index.member("folders")
			if !hasFolders || folders.kind != 'a' {
				return nil, errors.New("image metadata index folders are not an array")
			}
			id, _ := update.member("id")
			thumbnailFile, _ := update.member("thumbnailFile")
			for folderIndex, folder := range folders.array {
				if folder.kind == 'n' {
					return nil, errors.New("image metadata folder entry is null")
				}
				folderID, hasID := folder.member("id")
				if hasID && nodeJSONStrictEqual(folderID, id) {
					folder.setMember("thumbnailFile", thumbnailFile)
					folders.array[folderIndex] = folder
					break
				}
			}
			index.setMember("folders", folders)
		}
		return marshalPrettyOrderedNodeJSON(index, 0)
	})
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}
	respondJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func nodeJSONStrictEqual(left, right orderedNodeJSON) bool {
	if left.kind != right.kind {
		return false
	}
	switch left.kind {
	case 'n':
		return true
	case 's':
		return left.scalar.(string) == right.scalar.(string)
	case 'h':
		return left.scalar.(uint16) == right.scalar.(uint16)
	case 'b':
		return left.scalar.(bool) == right.scalar.(bool)
	case 'v':
		return left.scalar.(float64) == right.scalar.(float64)
	default:
		// Arrays and objects parsed from separate request and index JSON values
		// never share JavaScript object identity.
		return false
	}
}
