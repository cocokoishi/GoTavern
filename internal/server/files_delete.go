package server

import (
	"net/http"
	"path/filepath"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveFilesDelete(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readFilesUploadBody(request)
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	rawPath, exists := input["path"]
	if !exists || !nodeTruthyJSON(rawPath) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "No path specified")
		return
	}
	pathValue, err := decodeOrderedNodeJSON(rawPath)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	filePath, isString := pathValue.scalar.(string)
	if pathValue.kind != 's' || !isString {
		// Node's path.join throws when request.body.path is not a string.
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	pathToDelete := filepath.Join(directories["root"], filepath.FromSlash(filePath))
	if !strings.HasPrefix(pathToDelete, directories["files"]) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Invalid path")
		return
	}
	relativePath, err := filepath.Rel(directories["root"], pathToDelete)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	deleted, err := startup.DeleteUserFile(runtime.options.DataRoot, account.string("handle"), relativePath)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !deleted {
		respondText(w, http.StatusNotFound, "text/html; charset=utf-8", "File not found")
		return
	}
	serveStatusText(w, http.StatusOK)
}
