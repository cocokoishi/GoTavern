package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"path"
	"path/filepath"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveBackgroundsRename(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readAccountRequestBody(request)
	if !valid && request.ContentLength == 0 {
		input = map[string]json.RawMessage{}
		valid = true
	}
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	oldFilename, oldExists := input["old_bg"]
	newFilename, newExists := input["new_bg"]
	if !oldExists || !newExists {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	oldName, oldIsString := readBackgroundRenameString(oldFilename)
	newName, newIsString := readBackgroundRenameString(newFilename)
	if !oldIsString || !newIsString {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	sanitizedOldName := startup.SanitizeUserFilename(oldName)
	sanitizedNewName := startup.SanitizeUserFilename(newName)
	renamed, err := startup.RenameUserBackground(runtime.options.DataRoot, account.string("handle"), sanitizedOldName, sanitizedNewName)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !renamed {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	oldRelativePath := nodeImageMetadataIndexPath(filepath.Join("backgrounds", oldName))
	newRelativePath := nodeImageMetadataIndexPath(filepath.Join("backgrounds", newName))
	_ = renameBackgroundImageMetadata(runtime.options.DataRoot, account.string("handle"), oldRelativePath, newRelativePath)
	respondText(w, http.StatusOK, "text/html; charset=utf-8", "ok")
}

func readBackgroundRenameString(raw json.RawMessage) (string, bool) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	name, isString := value.(string)
	return name, isString
}

func renameBackgroundImageMetadata(dataRoot, handle, oldRelativePath, newRelativePath string) error {
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
		metadata, exists, accessError := imageMetadataAtPath(index, oldRelativePath)
		if accessError || !exists || !metadata.truthy() {
			return nil, false, errors.New("renamed image has no metadata entry")
		}
		if images.kind != 'o' {
			return nil, false, errors.New("image metadata index images collection is not an object")
		}
		images.deleteMember(oldRelativePath)
		images.setMember(newRelativePath, metadata)
		index.setMember("images", images)

		oldFilename := path.Base(oldRelativePath)
		newFilename := path.Base(newRelativePath)
		folders, hasFolders := index.member("folders")
		if oldFilename != newFilename && hasFolders && folders.kind == 'a' {
			for folderIndex, folder := range folders.array {
				if folder.kind == 'n' {
					return nil, false, errors.New("image metadata folder entry is null")
				}
				thumbnail, hasThumbnail := folder.member("thumbnailFile")
				if hasThumbnail && thumbnail.kind == 's' && thumbnail.scalar.(string) == oldFilename {
					folder.setMember("thumbnailFile", orderedNodeJSON{kind: 's', scalar: newFilename})
					folders.array[folderIndex] = folder
				}
			}
			index.setMember("folders", folders)
		}
		updated, err := marshalPrettyOrderedNodeJSON(index, 0)
		return updated, true, err
	})
}
