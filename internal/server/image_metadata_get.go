package server

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const imageMetadataGenerationUnsupportedMessage = "Image metadata generation is not implemented for this file."

func (runtimeServer *accountRuntime) serveImageMetadataGet(w http.ResponseWriter, request *http.Request) {
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
	pathValue, hasPath := input.member("path")
	paths, hasPaths := input.member("paths")
	if (!hasPath || !pathValue.truthy()) && (!hasPaths || !paths.truthy()) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": `Either "path" or "paths" is required.`})
		return
	}
	directories, err := startup.DirectoriesForUser(runtimeServer.options.DataRoot, account.string("handle"))
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}
	userRoot := directories["root"]
	if hasPath && pathValue.truthy() && (!hasPaths || !paths.truthy()) {
		relativePath, validString := nodeMetadataPathString(pathValue)
		if !validString {
			respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
			return
		}
		fullPath := filepath.Join(userRoot, filepath.FromSlash(relativePath))
		resolvedPath, resolveErr := nodeResolvePath(userRoot, relativePath)
		if resolveErr != nil || !nodePathUnderParent(userRoot, resolvedPath) {
			respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
			return
		}
		stat, statErr := os.Stat(fullPath)
		if statErr != nil {
			respondJSON(w, http.StatusNotFound, map[string]string{"error": "File not found."})
			return
		}
		index := readImageMetadataIndex(userRoot)
		metadata, cached, cacheErr := cachedImageMetadata(index, relativePath, stat.ModTime())
		if cacheErr {
			respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
			return
		}
		if cached {
			respondOrderedNodeJSON(w, http.StatusOK, metadata)
			return
		}
		respondJSON(w, http.StatusNotImplemented, map[string]string{"error": imageMetadataGenerationUnsupportedMessage})
		return
	}
	if !hasPaths || !paths.truthy() || paths.kind != 'a' {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request format."})
		return
	}
	results := orderedNodeJSON{kind: 'o'}
	validPaths := make([]string, 0, len(paths.array))
	for _, rawPath := range paths.array {
		relativePath, validString := nodeMetadataPathString(rawPath)
		if !validString {
			results.setMember(nodeMetadataResultKey(rawPath), orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{{key: "error", value: orderedNodeJSON{kind: 's', scalar: "Path must be a string."}}}})
			continue
		}
		resolvedPath, resolveErr := nodeResolvePath(userRoot, relativePath)
		if resolveErr != nil {
			results.setMember(relativePath, imageMetadataErrorValue("Path could not be resolved."))
			continue
		}
		if !nodePathUnderParent(userRoot, resolvedPath) {
			results.setMember(relativePath, imageMetadataErrorValue(`Path "`+relativePath+`" is outside the user data directory.`))
			continue
		}
		validPaths = append(validPaths, relativePath)
	}
	index := readImageMetadataIndex(userRoot)
	for _, relativePath := range validPaths {
		fullPath := filepath.Join(userRoot, filepath.FromSlash(relativePath))
		stat, statErr := os.Stat(fullPath)
		if statErr != nil {
			results.setMember(relativePath, imageMetadataErrorValue("File not found or could not process."))
			continue
		}
		metadata, cached, cacheErr := cachedImageMetadata(index, relativePath, stat.ModTime())
		if cacheErr {
			respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
			return
		}
		if cached {
			results.setMember(relativePath, metadata)
			continue
		}
		results.setMember(relativePath, imageMetadataErrorValue(imageMetadataGenerationUnsupportedMessage))
	}
	respondOrderedNodeJSON(w, http.StatusOK, results)
}

func nodeMetadataPathString(value orderedNodeJSON) (string, bool) {
	if value.kind != 's' && value.kind != 'h' {
		return "", false
	}
	pathValue, err := value.javascriptString()
	if err != nil {
		return "", false
	}
	if runtime.GOOS == "windows" {
		pathValue = strings.ReplaceAll(pathValue, `\`, "/")
	}
	return pathValue, true
}

func nodeMetadataResultKey(value orderedNodeJSON) string {
	pathValue, err := value.javascriptString()
	if err == nil {
		return pathValue
	}
	return "[object Object]"
}

func imageMetadataErrorValue(message string) orderedNodeJSON {
	return orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{{key: "error", value: orderedNodeJSON{kind: 's', scalar: message}}}}
}

func cachedImageMetadata(index orderedNodeJSON, relativePath string, mtime time.Time) (metadata orderedNodeJSON, cached, accessError bool) {
	if index.kind == 'n' {
		return orderedNodeJSON{}, false, true
	}
	images, hasImages := index.member("images")
	if !hasImages || images.kind == 'n' {
		return orderedNodeJSON{}, false, true
	}
	posixPath := relativePath
	if runtime.GOOS == "windows" {
		posixPath = strings.ReplaceAll(posixPath, `\`, "/")
	}
	imageMetadata, exists := images.member(posixPath)
	if !exists && images.kind == 'a' {
		if arrayIndex, ok := nodeArrayIndex(posixPath); ok && arrayIndex < uint64(len(images.array)) {
			imageMetadata, exists = images.array[arrayIndex], true
		}
	}
	if !exists || !imageMetadata.truthy() {
		return orderedNodeJSON{}, false, false
	}
	storedMtime, exists := imageMetadata.member("mtime")
	if !exists || storedMtime.kind != 'v' {
		return orderedNodeJSON{}, false, false
	}
	// Node's stat.mtimeMs is composed from the seconds and nanoseconds fields.
	// Converting UnixNano to float first loses sub-millisecond precision at modern
	// epoch magnitudes and can miss an otherwise exact cache hit.
	currentMtime := float64(mtime.Unix())*1e3 + float64(mtime.Nanosecond())/1e6
	return imageMetadata, storedMtime.scalar.(float64) == currentMtime, false
}
