package server

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveImageMetadataFolderCreate(w http.ResponseWriter, request *http.Request) {
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
	name, hasName := input.member("name")
	if !hasName || !name.truthy() || name.kind != 's' {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": `"name" is required.`})
		return
	}
	folderName := trimECMAScriptWhitespace(name.scalar.(string))
	folderID, err := randomUUIDv4()
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}
	folder := orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{
		{key: "id", value: orderedNodeJSON{kind: 's', scalar: folderID}},
		{key: "name", value: orderedNodeJSON{kind: 's', scalar: folderName}},
		{key: "thumbnailFile", value: orderedNodeJSON{kind: 's', scalar: ""}},
	}}
	err = startup.UpdateUserContentFile(runtime.options.DataRoot, account.string("handle"), imageMetadataIndexFilename, func(current []byte) ([]byte, error) {
		index := defaultImageMetadataIndex()
		if len(current) > 0 {
			if parsed, parseErr := decodeOrderedNodeJSON(current); parseErr == nil {
				index = parsed
			}
		}
		if index.kind != 'o' {
			return nil, errors.New("image metadata index does not contain a folders array")
		}
		folders, exists := index.member("folders")
		if !exists || folders.kind != 'a' {
			return nil, errors.New("image metadata index does not contain a folders array")
		}
		folders.array = append(folders.array, folder)
		index.setMember("folders", folders)
		return marshalPrettyOrderedNodeJSON(index, 0)
	})
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}
	respondOrderedNodeJSON(w, http.StatusOK, folder)
}

func randomUUIDv4() (string, error) {
	value := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, value); err != nil {
		return "", err
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	encoded := hex.EncodeToString(value)
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}

func trimECMAScriptWhitespace(value string) string {
	return strings.TrimFunc(value, func(character rune) bool {
		switch character {
		case '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020', '\u00a0', '\u1680',
			'\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
			return true
		}
		return character >= '\u2000' && character <= '\u200a'
	})
}

func marshalPrettyOrderedNodeJSON(value orderedNodeJSON, depth int) ([]byte, error) {
	var body strings.Builder
	switch value.kind {
	case 'o':
		entries, _ := value.entries()
		if len(entries) == 0 {
			return []byte("{}"), nil
		}
		body.WriteString("{\n")
		for index, entry := range entries {
			if index > 0 {
				body.WriteString(",\n")
			}
			body.WriteString(strings.Repeat(" ", (depth+1)*4))
			key, err := marshalNodeJSONString(entry.key)
			if err != nil {
				return nil, err
			}
			body.Write(key)
			body.WriteString(": ")
			child, err := marshalPrettyOrderedNodeJSON(entry.value, depth+1)
			if err != nil {
				return nil, err
			}
			body.Write(child)
		}
		body.WriteString("\n")
		body.WriteString(strings.Repeat(" ", depth*4))
		body.WriteByte('}')
	case 'a':
		if len(value.array) == 0 {
			return []byte("[]"), nil
		}
		body.WriteString("[\n")
		for index, childValue := range value.array {
			if index > 0 {
				body.WriteString(",\n")
			}
			body.WriteString(strings.Repeat(" ", (depth+1)*4))
			child, err := marshalPrettyOrderedNodeJSON(childValue, depth+1)
			if err != nil {
				return nil, err
			}
			body.Write(child)
		}
		body.WriteString("\n")
		body.WriteString(strings.Repeat(" ", depth*4))
		body.WriteByte(']')
	default:
		return marshalOrderedNodeJSON(value)
	}
	return []byte(body.String()), nil
}
