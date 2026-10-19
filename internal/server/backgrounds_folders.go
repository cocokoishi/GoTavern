package server

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const backgroundImageMetadataFile = "image-metadata.json"

type orderedNodeJSON struct {
	kind   byte
	object []orderedNodeJSONEntry
	array  []orderedNodeJSON
	scalar any
}

type orderedNodeJSONEntry struct {
	key   string
	value orderedNodeJSON
}

func (runtime *accountRuntime) serveBackgroundFolders(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}

	index := defaultBackgroundMetadataIndex()
	indexBytes, err := os.ReadFile(filepath.Join(directories["root"], backgroundImageMetadataFile))
	if err == nil {
		if parsed, parseErr := decodeOrderedNodeJSON(indexBytes); parseErr == nil {
			index = parsed
		}
	}

	if index.kind == 'n' {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}
	folders, hasFolders := index.member("folders")
	if !hasFolders || !folders.truthy() {
		folders = orderedNodeJSON{kind: 'a', array: []orderedNodeJSON{}}
	}
	images, hasImages := index.member("images")
	entries, enumerable := images.entries()
	if !hasImages || !enumerable {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}

	imageFolderMap := orderedNodeJSON{kind: 'o'}
	for _, entry := range entries {
		metadata, isObject := entry.value, entry.value.kind == 'o'
		if !isObject {
			continue
		}
		folderIDs, hasFolderIDs := metadata.member("folderIds")
		if !hasFolderIDs || folderIDs.kind != 'a' || len(folderIDs.array) == 0 {
			continue
		}
		filename := entry.key
		if slash := strings.LastIndexByte(entry.key, '/'); slash >= 0 {
			filename = entry.key[slash+1:]
			if filename == "" {
				filename = entry.key
			}
		}
		// Assignment to this property changes Object.prototype on the pinned
		// endpoint's ordinary object, so JSON.stringify does not emit it.
		if filename == "__proto__" {
			continue
		}
		imageFolderMap.setMember(filename, folderIDs)
	}

	respondOrderedNodeJSON(w, http.StatusOK, orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{
		{key: "folders", value: folders},
		{key: "imageFolderMap", value: imageFolderMap},
	}})
}

func defaultBackgroundMetadataIndex() orderedNodeJSON {
	return orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{
		{key: "version", value: orderedNodeJSON{kind: 'v', scalar: float64(1)}},
		{key: "images", value: orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{}}},
		{key: "folders", value: orderedNodeJSON{kind: 'a', array: []orderedNodeJSON{}}},
	}}
}

func decodeOrderedNodeJSON(raw []byte) (orderedNodeJSON, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	value, err := decodeOrderedNodeJSONValue(decoder)
	if err != nil {
		return orderedNodeJSON{}, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return orderedNodeJSON{}, io.ErrUnexpectedEOF
		}
		return orderedNodeJSON{}, err
	}
	return value, nil
}

func decodeOrderedNodeJSONValue(decoder *json.Decoder) (orderedNodeJSON, error) {
	token, err := decoder.Token()
	if err != nil {
		return orderedNodeJSON{}, err
	}
	switch value := token.(type) {
	case json.Delim:
		switch value {
		case '{':
			object := orderedNodeJSON{kind: 'o'}
			positions := make(map[string]int)
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return orderedNodeJSON{}, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return orderedNodeJSON{}, io.ErrUnexpectedEOF
				}
				child, err := decodeOrderedNodeJSONValue(decoder)
				if err != nil {
					return orderedNodeJSON{}, err
				}
				if index, exists := positions[key]; exists {
					object.object[index].value = child
				} else {
					positions[key] = len(object.object)
					object.object = append(object.object, orderedNodeJSONEntry{key: key, value: child})
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim('}') {
				return orderedNodeJSON{}, io.ErrUnexpectedEOF
			}
			return object, nil
		case '[':
			array := orderedNodeJSON{kind: 'a'}
			for decoder.More() {
				child, err := decodeOrderedNodeJSONValue(decoder)
				if err != nil {
					return orderedNodeJSON{}, err
				}
				array.array = append(array.array, child)
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim(']') {
				return orderedNodeJSON{}, io.ErrUnexpectedEOF
			}
			return array, nil
		}
	case nil:
		return orderedNodeJSON{kind: 'n'}, nil
	case string:
		return orderedNodeJSON{kind: 's', scalar: value}, nil
	case bool:
		return orderedNodeJSON{kind: 'b', scalar: value}, nil
	case json.Number:
		number, parseErr := strconv.ParseFloat(value.String(), 64)
		if parseErr != nil {
			if numberErr, ok := parseErr.(*strconv.NumError); !ok || numberErr.Err != strconv.ErrRange {
				return orderedNodeJSON{}, parseErr
			}
		}
		return orderedNodeJSON{kind: 'v', scalar: number}, nil
	}
	return orderedNodeJSON{}, io.ErrUnexpectedEOF
}

func (value orderedNodeJSON) member(key string) (orderedNodeJSON, bool) {
	if value.kind != 'o' {
		return orderedNodeJSON{}, false
	}
	for _, entry := range value.object {
		if entry.key == key {
			return entry.value, true
		}
	}
	return orderedNodeJSON{}, false
}

func (value *orderedNodeJSON) setMember(key string, member orderedNodeJSON) {
	for index := range value.object {
		if value.object[index].key == key {
			value.object[index].value = member
			return
		}
	}
	value.object = append(value.object, orderedNodeJSONEntry{key: key, value: member})
}

func (value orderedNodeJSON) entries() ([]orderedNodeJSONEntry, bool) {
	switch value.kind {
	case 'o':
		entries := append([]orderedNodeJSONEntry(nil), value.object...)
		sort.SliceStable(entries, func(i, j int) bool {
			iIndex, iIsIndex := nodeArrayIndex(entries[i].key)
			jIndex, jIsIndex := nodeArrayIndex(entries[j].key)
			if iIsIndex != jIsIndex {
				return iIsIndex
			}
			return iIsIndex && iIndex < jIndex
		})
		return entries, true
	case 'a':
		entries := make([]orderedNodeJSONEntry, len(value.array))
		for index, item := range value.array {
			entries[index] = orderedNodeJSONEntry{key: strconv.Itoa(index), value: item}
		}
		return entries, true
	case 'n':
		return nil, false
	case 's':
		return nil, true // String entries cannot have an array-valued folderIds property.
	default:
		return nil, true
	}
}

func nodeArrayIndex(key string) (uint64, bool) {
	if key == "" {
		return 0, false
	}
	index, err := strconv.ParseUint(key, 10, 32)
	if err != nil || index == 4294967295 || strconv.FormatUint(index, 10) != key {
		return 0, false
	}
	return index, true
}

func (value orderedNodeJSON) truthy() bool {
	switch value.kind {
	case 'n':
		return false
	case 'b':
		return value.scalar == true
	case 's':
		return value.scalar.(string) != ""
	case 'v':
		return value.scalar.(float64) != 0
	default:
		return true
	}
}

func respondOrderedNodeJSON(w http.ResponseWriter, status int, value orderedNodeJSON) {
	body, err := marshalOrderedNodeJSON(value)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("ETag", expressWeakETag(body))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func marshalOrderedNodeJSON(value orderedNodeJSON) ([]byte, error) {
	var body bytes.Buffer
	switch value.kind {
	case 'o':
		body.WriteByte('{')
		entries, _ := value.entries()
		for index, entry := range entries {
			if index > 0 {
				body.WriteByte(',')
			}
			keyBytes, err := marshalNodeJSONString(entry.key)
			if err != nil {
				return nil, err
			}
			body.Write(keyBytes)
			body.WriteByte(':')
			valueBytes, err := marshalOrderedNodeJSON(entry.value)
			if err != nil {
				return nil, err
			}
			body.Write(valueBytes)
		}
		body.WriteByte('}')
	case 'a':
		body.WriteByte('[')
		for index, item := range value.array {
			if index > 0 {
				body.WriteByte(',')
			}
			itemBytes, err := marshalOrderedNodeJSON(item)
			if err != nil {
				return nil, err
			}
			body.Write(itemBytes)
		}
		body.WriteByte(']')
	case 's':
		return marshalNodeJSONString(value.scalar.(string))
	case 'v':
		return marshalECMAScriptNumber(value.scalar.(float64))
	default:
		return marshalNodeJSON(value.scalar)
	}
	return body.Bytes(), nil
}

func marshalNodeJSONString(value string) ([]byte, error) {
	encoded, err := marshalNodeJSON(value)
	if err != nil {
		return nil, err
	}
	encoded = bytes.ReplaceAll(encoded, []byte(`\u2028`), []byte("\u2028"))
	encoded = bytes.ReplaceAll(encoded, []byte(`\u2029`), []byte("\u2029"))
	return encoded, nil
}

func marshalECMAScriptNumber(value float64) ([]byte, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return []byte("null"), nil
	}
	if value == 0 {
		return []byte("0"), nil
	}
	absolute := math.Abs(value)
	if absolute >= 1e-6 && absolute < 1e21 {
		return []byte(strconv.FormatFloat(value, 'f', -1, 64)), nil
	}
	encoded := strconv.FormatFloat(value, 'e', -1, 64)
	exponentIndex := strings.IndexByte(encoded, 'e')
	if exponentIndex < 0 {
		return []byte(encoded), nil
	}
	exponent, err := strconv.Atoi(encoded[exponentIndex+1:])
	if err != nil {
		return []byte(encoded), nil
	}
	sign := "+"
	if exponent < 0 {
		sign = "-"
		exponent = -exponent
	}
	return []byte(encoded[:exponentIndex] + "e" + sign + strconv.Itoa(exponent)), nil
}
