package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"unicode/utf16"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveBackgroundsAll(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}

	filenames, err := startup.UserBackgroundImages(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to fetch backgrounds"})
		return
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to fetch backgrounds"})
		return
	}
	config, err := backgroundThumbnailConfig(runtime.options.ImageMetadataThumbnailDimensions)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to fetch backgrounds"})
		return
	}

	relativePaths := make([]string, len(filenames))
	for index, filename := range filenames {
		relativePaths[index] = filepath.Join("backgrounds", filename)
	}
	metadataMap, err := generateImageMetadataBatch(
		runtime.options.DataRoot,
		account.string("handle"),
		directories["root"],
		relativePaths,
		orderedNodeJSON{kind: 's', scalar: "bg"},
		runtime.options.ImageMetadataThumbnailDimensions,
	)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to fetch backgrounds"})
		return
	}

	images := orderedNodeJSON{kind: 'a', array: make([]orderedNodeJSON, 0, len(filenames))}
	for index, filename := range filenames {
		isAnimated := orderedNodeJSON{kind: 'b', scalar: false}
		if metadata, exists := metadataMap[relativePaths[index]]; exists {
			if cachedValue, hasValue := metadata.member("isAnimated"); hasValue && cachedValue.kind != 'n' {
				isAnimated = cachedValue
			}
		}
		images.array = append(images.array, orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{
			{key: "filename", value: orderedNodeJSON{kind: 's', scalar: filename}},
			{key: "isAnimated", value: isAnimated},
		}})
	}

	respondOrderedNodeJSON(w, http.StatusOK, orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{
		{key: "images", value: images},
		{key: "config", value: config},
	}})
}

func generateImageMetadataBatch(dataRoot, handle, userRoot string, relativePaths []string, typeValue orderedNodeJSON, dimensions map[string]any) (map[string]orderedNodeJSON, error) {
	results := make(map[string]orderedNodeJSON, len(relativePaths))
	index := readImageMetadataIndex(userRoot)
	pending := make([]generatedImageMetadata, 0, len(relativePaths))
	pendingByPath := make(map[string]int, len(relativePaths))

	for _, relativePath := range relativePaths {
		fullPath := filepath.Join(userRoot, filepath.FromSlash(relativePath))
		fileStat, statErr := os.Stat(fullPath)
		if statErr != nil {
			continue
		}
		metadata, cached, cacheError := cachedImageMetadata(index, relativePath, fileStat.ModTime())
		if cacheError {
			return nil, errors.New("image metadata index has no usable images collection")
		}
		if cached {
			results[relativePath] = metadata
			continue
		}

		generated, unsupported, generationErr := generateImageMetadata(fullPath, typeValue, dimensions)
		if unsupported || generationErr != nil {
			// The pinned batch endpoint skips files it cannot inspect. The caller
			// returns the default false animation flag when no metadata is available.
			continue
		}
		indexPath := nodeImageMetadataIndexPath(relativePath)
		cachedEntry, hasCachedEntry, accessError := imageMetadataAtPath(index, indexPath)
		if accessError {
			return nil, errors.New("image metadata index has no usable images collection")
		}
		if hasCachedEntry {
			generated = preserveImageMetadataFolderIDs(generated, cachedEntry)
		}
		mtime := nodeStatMtimeMilliseconds(fileStat.ModTime())
		generated.setMember("mtime", orderedNodeJSON{kind: 'v', scalar: mtime})
		results[relativePath] = generated
		if pendingIndex, exists := pendingByPath[indexPath]; exists {
			pending[pendingIndex].metadata = generated
			pending[pendingIndex].mtime = mtime
			continue
		}
		pendingByPath[indexPath] = len(pending)
		pending = append(pending, generatedImageMetadata{
			path: indexPath, responsePaths: []string{relativePath}, mtime: mtime, metadata: generated,
		})
	}

	if len(pending) > 0 {
		persisted, err := persistGeneratedImageMetadata(dataRoot, handle, pending)
		if err != nil {
			return nil, err
		}
		for _, update := range pending {
			metadata, exists := persisted[update.path]
			if !exists {
				return nil, errors.New("generated image metadata was not persisted")
			}
			for _, responsePath := range update.responsePaths {
				results[responsePath] = metadata
			}
		}
	}
	return results, nil
}

func backgroundThumbnailConfig(configuredDimensions map[string]any) (orderedNodeJSON, error) {
	dimensions, exists := configuredDimensions["bg"]
	if !exists {
		dimensions = []any{float64(160), float64(90)}
	}
	if dimensions == nil {
		return orderedNodeJSON{}, errors.New("background thumbnail dimensions are null")
	}
	config := orderedNodeJSON{kind: 'o'}
	for index, key := range []string{"width", "height"} {
		value, hasValue, accessError := backgroundDimensionAt(dimensions, index)
		if accessError {
			return orderedNodeJSON{}, errors.New("background thumbnail dimensions cannot be read")
		}
		if hasValue {
			config.setMember(key, value)
		}
	}
	return config, nil
}

func backgroundDimensionAt(dimensions any, index int) (orderedNodeJSON, bool, bool) {
	switch value := dimensions.(type) {
	case []any:
		if index >= len(value) {
			return orderedNodeJSON{}, false, false
		}
		return orderedNodeJSONFromAny(value[index])
	case []string:
		if index >= len(value) {
			return orderedNodeJSON{}, false, false
		}
		return orderedNodeJSON{kind: 's', scalar: value[index]}, true, false
	case string:
		units := utf16.Encode([]rune(value))
		if index >= len(units) {
			return orderedNodeJSON{}, false, false
		}
		if units[index] >= 0xD800 && units[index] <= 0xDFFF {
			return orderedNodeJSON{kind: 'h', scalar: units[index]}, true, false
		}
		return orderedNodeJSON{kind: 's', scalar: string(rune(units[index]))}, true, false
	case map[string]any:
		item, exists := value[[]string{"0", "1"}[index]]
		if !exists {
			return orderedNodeJSON{}, false, false
		}
		return orderedNodeJSONFromAny(item)
	case json.RawMessage:
		var decoded any
		if err := json.Unmarshal(value, &decoded); err != nil {
			return orderedNodeJSON{}, false, true
		}
		return backgroundDimensionAt(decoded, index)
	case nil:
		return orderedNodeJSON{}, false, true
	default:
		// JavaScript boxes numbers and booleans for property access; these
		// indexes are undefined and JSON.stringify omits them.
		return orderedNodeJSON{}, false, false
	}
}

func orderedNodeJSONFromAny(value any) (orderedNodeJSON, bool, bool) {
	if value == nil {
		return orderedNodeJSON{kind: 'n'}, true, false
	}
	if number, ok := value.(float64); ok {
		return orderedNodeJSON{kind: 'v', scalar: number}, true, false
	}
	encoded, err := marshalNodeJSON(value)
	if err != nil {
		return orderedNodeJSON{}, false, true
	}
	decoded, err := decodeOrderedNodeJSON(encoded)
	if err != nil {
		return orderedNodeJSON{}, false, true
	}
	return decoded, true, false
}
