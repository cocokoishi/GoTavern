package server

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type imageMetadataFolderNotFoundError struct {
	id string
}

func (err imageMetadataFolderNotFoundError) Error() string {
	return fmt.Sprintf("Folder '%s' not found.", err.id)
}

func (runtime *accountRuntime) serveImageMetadataFolderUpdate(w http.ResponseWriter, request *http.Request) {
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
	name, hasName := input.member("name")
	thumbnailFile, hasThumbnailFile := input.member("thumbnailFile")
	var updatedFolder orderedNodeJSON
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
		found := false
		for folderIndex, folder := range folders.array {
			if folder.kind == 'n' {
				return nil, errors.New("image metadata folder entry is null")
			}
			folderIDValue, hasFolderID := folder.member("id")
			if hasFolderID && nodeJSONStrictEqual(folderIDValue, id) {
				if hasName {
					folder.setMember("name", name)
				}
				if hasThumbnailFile {
					folder.setMember("thumbnailFile", thumbnailFile)
				}
				folders.array[folderIndex] = folder
				updatedFolder = folder
				found = true
				break
			}
		}
		if !found {
			return nil, imageMetadataFolderNotFoundError{id: folderID}
		}
		index.setMember("folders", folders)
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
	respondOrderedNodeJSON(w, http.StatusOK, updatedFolder)
}
