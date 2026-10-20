package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveFilesVerify(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readAccountRequestBody(request)
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	var paths []json.RawMessage
	rawPaths, exists := input["urls"]
	trimmedPaths := strings.TrimSpace(string(rawPaths))
	if !exists || trimmedPaths == "" || trimmedPaths[0] != '[' || json.Unmarshal(rawPaths, &paths) != nil {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "No URLs specified")
		return
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	filesDirectory := directories["files"]
	verified := orderedNodeJSON{kind: 'o'}
	for _, rawPath := range paths {
		var pathValue any
		if err := json.Unmarshal(rawPath, &pathValue); err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		fileURL, isString := pathValue.(string)
		if !isString {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		pathToVerify := filepath.Join(directories["root"], filepath.FromSlash(fileURL))
		// Preserve the pinned startsWith check, including its treatment of
		// sibling paths whose names begin with the files-directory path.
		if !strings.HasPrefix(pathToVerify, filesDirectory) {
			continue
		}
		_, statErr := os.Stat(pathToVerify)
		verified.setMember(fileURL, orderedNodeJSON{kind: 'b', scalar: statErr == nil})
	}
	respondOrderedNodeJSON(w, http.StatusOK, verified)
}
