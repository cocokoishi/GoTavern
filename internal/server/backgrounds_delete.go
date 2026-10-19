package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"path"
	"path/filepath"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveBackgroundsDelete(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readAccountRequestBody(request)
	if !valid && request.ContentLength == 0 {
		// The pinned parser exposes an empty body as an empty object for this
		// route, so the missing `bg` reaches sanitize-filename and becomes 500.
		input = map[string]json.RawMessage{}
		valid = true
	}
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	rawFilename, exists := input["bg"]
	if !exists {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if filenameFieldHasForbiddenPathCharacter(rawFilename) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	var value any
	if err := json.Unmarshal(rawFilename, &value); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	filename, isString := value.(string)
	if !isString {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	sanitizedFilename := startup.SanitizeUserFilename(filename)
	if filename != sanitizedFilename {
		serveStatusText(w, http.StatusForbidden)
		return
	}

	deleted, err := startup.DeleteUserBackground(runtime.options.DataRoot, account.string("handle"), sanitizedFilename)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !deleted {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	relativePath := nodeImageMetadataIndexPath(filepath.Join("backgrounds", filename))
	_ = removeBackgroundImageMetadata(runtime.options.DataRoot, account.string("handle"), relativePath)
	respondText(w, http.StatusOK, "text/html; charset=utf-8", "ok")
}

func removeBackgroundImageMetadata(dataRoot, handle, relativePath string) error {
	return startup.UpdateUserContentFileIfChanged(dataRoot, handle, imageMetadataIndexFilename, func(current []byte) ([]byte, bool, error) {
		index := defaultImageMetadataIndex()
		if len(current) > 0 {
			if parsed, parseErr := decodeOrderedNodeJSON(current); parseErr == nil {
				index = parsed
			}
		}
		if index.kind != 'o' {
			return nil, false, errors.New("image metadata index is not an object")
		}
		images, hasImages := index.member("images")
		if !hasImages || images.kind == 'n' {
			return nil, false, errors.New("image metadata index has no usable images collection")
		}
		metadata, exists, accessError := imageMetadataAtPath(index, relativePath)
		if accessError {
			return nil, false, errors.New("image metadata index has no usable images collection")
		}
		if !exists || !metadata.truthy() {
			return nil, false, nil
		}
		if images.kind != 'o' {
			return nil, false, errors.New("image metadata index images collection is not an object")
		}
		images.deleteMember(relativePath)
		index.setMember("images", images)

		folders, hasFolders := index.member("folders")
		if hasFolders && folders.kind == 'a' {
			deletedFilename := path.Base(relativePath)
			for folderIndex, folder := range folders.array {
				if folder.kind == 'n' {
					return nil, false, errors.New("image metadata folder entry is null")
				}
				thumbnail, hasThumbnail := folder.member("thumbnailFile")
				if hasThumbnail && thumbnail.kind == 's' && thumbnail.scalar.(string) == deletedFilename {
					folder.setMember("thumbnailFile", orderedNodeJSON{kind: 's', scalar: ""})
					folders.array[folderIndex] = folder
				}
			}
			index.setMember("folders", folders)
		}
		updated, err := marshalPrettyOrderedNodeJSON(index, 0)
		return updated, true, err
	})
}
