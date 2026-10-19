package server

import (
	"bytes"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const imageMetadataRequestBodyLimit = 500 << 20

func (runtime *accountRuntime) serveImageMetadataAll(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}
	prefix, bodyError, accessError := imageMetadataPrefix(request)
	if bodyError {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if accessError {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}

	index := readImageMetadataIndex(directories["root"])
	if prefix == "" {
		respondOrderedNodeJSON(w, http.StatusOK, index)
		return
	}
	images, hasImages := index.member("images")
	entries, enumerable := images.entries()
	if !hasImages || !enumerable {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}

	filteredImages := orderedNodeJSON{kind: 'o'}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.key, prefix) || entry.key == "__proto__" {
			continue
		}
		filteredImages.setMember(entry.key, entry.value)
	}
	response := orderedNodeJSON{kind: 'o'}
	if version, exists := index.member("version"); exists {
		response.setMember("version", version)
	}
	response.setMember("images", filteredImages)
	respondOrderedNodeJSON(w, http.StatusOK, response)
}

func imageMetadataPrefix(request *http.Request) (prefix string, bodyError, accessError bool) {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return "", false, true
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, imageMetadataRequestBodyLimit+1))
	if err != nil {
		return "", true, false
	}
	if len(body) > imageMetadataRequestBodyLimit {
		return "", true, false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return "", false, true
	}
	input, err := decodeOrderedNodeJSON(body)
	if err != nil || input.kind != 'o' && input.kind != 'a' {
		return "", true, false
	}
	rawPrefix, exists := input.member("prefix")
	if !exists || !rawPrefix.truthy() {
		return "", false, false
	}
	prefix, err = rawPrefix.javascriptString()
	if err != nil {
		return "", false, true
	}
	return prefix, false, false
}
