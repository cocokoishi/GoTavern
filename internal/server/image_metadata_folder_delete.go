package server

import (
	"errors"
	"net/http"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveImageMetadataFolderDelete(w http.ResponseWriter, request *http.Request) {
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
	id, hasID := input.member("id")
	if !hasID || id.kind != 's' && id.kind != 'h' || !id.truthy() {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": `"id" is required.`})
		return
	}
	folderID, _ := id.javascriptString()
	err := startup.UpdateUserContentFile(runtime.options.DataRoot, account.string("handle"), imageMetadataIndexFilename, func(current []byte) ([]byte, error) {
		index := defaultImageMetadataIndex()
		if len(current) > 0 {
			if parsed, parseErr := decodeOrderedNodeJSON(current); parseErr == nil {
				index = parsed
			}
		}
		if index.kind == 'n' {
			return nil, errors.New("image metadata index is null")
		}
		folders, hasFolders := index.member("folders")
		if !hasFolders || folders.kind != 'a' {
			return nil, errors.New("image metadata index folders are not an array")
		}
		folderIndex := -1
		for index, folder := range folders.array {
			if folder.kind == 'n' {
				return nil, errors.New("image metadata folder entry is null")
			}
			folderValue, hasFolderID := folder.member("id")
			if hasFolderID && nodeJSONStrictEqual(folderValue, id) {
				folderIndex = index
				break
			}
		}
		if folderIndex == -1 {
			return nil, imageMetadataFolderNotFoundError{id: folderID}
		}
		folders.array = append(folders.array[:folderIndex], folders.array[folderIndex+1:]...)
		index.setMember("folders", folders)

		images, hasImages := index.member("images")
		entries, enumerable := images.entries()
		if !hasImages || !enumerable {
			return nil, errors.New("image metadata index images are not enumerable")
		}
		for entryIndex, entry := range entries {
			meta := entry.value
			if meta.kind == 'n' {
				return nil, errors.New("image metadata entry is null")
			}
			folderIDs, hasFolderIDs := meta.member("folderIds")
			if !hasFolderIDs || folderIDs.kind != 'a' {
				continue
			}
			for folderIDIndex, folderIDValue := range folderIDs.array {
				if nodeJSONStrictEqual(folderIDValue, id) {
					folderIDs.array = append(folderIDs.array[:folderIDIndex], folderIDs.array[folderIDIndex+1:]...)
					meta.setMember("folderIds", folderIDs)
					if images.kind == 'a' {
						images.array[entryIndex] = meta
					} else if images.kind == 'o' {
						images.setMember(entry.key, meta)
					}
					break
				}
			}
		}
		index.setMember("images", images)
		return marshalPrettyOrderedNodeJSON(index, 0)
	})
	if err != nil {
		var notFound imageMetadataFolderNotFoundError
		if errors.As(err, &notFound) {
			respondJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}
	respondJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
