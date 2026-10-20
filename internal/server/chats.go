package server

import (
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// This file implements the pinned chat save/load routes.
//
// Known gap: the pinned /api/chats/save also schedules a throttled chat backup
// (src/endpoints/chats.js getBackupFunction -> lodash throttle(backupChat,
// backups.chat.throttleInterval) with leading and trailing edges) and runs
// checkChatIntegrity when the chat carries a chat_metadata.integrity slug. Both
// write outside the chat directory and are time-dependent, so they are not
// reproduced here. See docs/compat-matrix.md for the recorded gap.

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerChatRoutes)
}

func registerChatRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	// The pinned routes are POST-only, and Express answers any other method with
	// the final 404 rather than a 405, so dispatch manually.
	mux.HandleFunc("/api/chats/save", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveChatsSave(w, r)
	})
	mux.HandleFunc("/api/chats/get", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveChatsGet(w, r)
	})
}

// pinnedAvatarURLRejected reproduces the validateAvatarUrlMiddleware guard from
// src/middleware/validateFileName.js. The middleware runs for any avatar_url
// that is not null or undefined, because every other JSON value has a callable
// toString; a data member named toString is not callable and is therefore
// skipped. The forbidden set is the host path separator plus NUL, which is
// itself platform-dependent upstream (path.sep).
func pinnedAvatarURLRejected(value orderedNodeJSON) bool {
	switch value.kind {
	case 'n':
		// typeof null.toString throws before the check; upstream skips it.
		return false
	case 'o':
		if _, exists := value.member("toString"); exists {
			return false
		}
	}
	text, err := value.javascriptString()
	if err != nil {
		return false
	}
	// pinned source: middleware/validateFileName.js builds the pattern as
	// path.sep === '/' ? /[/\x00]/ : /[/\x00\\]/. Forward slash is therefore
	// always forbidden and the backslash is added only on Windows.
	if strings.ContainsRune(text, 0) || strings.ContainsRune(text, '/') {
		return true
	}
	return filepath.Separator != '/' && strings.ContainsRune(text, filepath.Separator)
}

// pinnedPathUnderParent ports util.js isPathUnderParent.
func pinnedPathUnderParent(parentPath, childPath string) bool {
	normalizedParent := filepath.Clean(parentPath)
	normalizedChild := filepath.Clean(childPath)
	relativePath, err := filepath.Rel(normalizedParent, normalizedChild)
	if err != nil {
		return false
	}
	return relativePath != ".." &&
		!strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) &&
		!filepath.IsAbs(relativePath)
}

// pinnedStringValue reproduces JavaScript String(value) for a body member,
// including the "undefined" text used when the member is absent.
func pinnedStringValue(input map[string]json.RawMessage, key string) (string, bool) {
	raw, exists := input[key]
	if !exists {
		return "undefined", true
	}
	value, err := decodeOrderedNodeJSON(raw)
	if err != nil {
		return "", false
	}
	text, err := value.javascriptString()
	if err != nil {
		return "", false
	}
	return text, true
}

// pinnedReplaceFirst ports String.prototype.replace with a string pattern, which
// replaces only the first occurrence.
func pinnedReplaceFirst(value, old, replacement string) string {
	index := strings.Index(value, old)
	if index < 0 {
		return value
	}
	return value[:index] + replacement + value[index+len(old):]
}

// pinnedChatData ports getChatData: every JSONL line is parsed independently and
// falsy results are dropped, so malformed lines and blank trailing lines vanish
// instead of failing the read.
func pinnedChatData(chatFilePath string) []orderedNodeJSON {
	body, err := os.ReadFile(chatFilePath)
	if err != nil || len(body) == 0 {
		return []orderedNodeJSON{}
	}
	lines := strings.Split(string(body), "\n")
	chatData := make([]orderedNodeJSON, 0, len(lines))
	for _, line := range lines {
		value, err := decodeOrderedNodeJSON([]byte(line))
		if err != nil {
			continue
		}
		if !value.nodeTruthy() {
			continue
		}
		chatData = append(chatData, value)
	}
	return chatData
}

// nodeTruthy reports JavaScript truthiness for a decoded JSON value.
func (value orderedNodeJSON) nodeTruthy() bool {
	switch value.kind {
	case 'n':
		return false
	case 'b':
		return value.scalar.(bool)
	case 's':
		return value.scalar.(string) != ""
	case 'h':
		return true
	case 'v':
		number := value.scalar.(float64)
		return number != 0 && !math.IsNaN(number)
	default:
		return true
	}
}

func (runtime *accountRuntime) serveChatsSave(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readFilesUploadBody(request)
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if rawAvatarURL, exists := input["avatar_url"]; exists {
		if value, err := decodeOrderedNodeJSON(rawAvatarURL); err == nil && pinnedAvatarURLRejected(value) {
			serveStatusText(w, http.StatusBadRequest)
			return
		}
	}
	cardName, ok := pinnedStringValue(input, "avatar_url")
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	cardName = pinnedReplaceFirst(cardName, ".png", "")
	fileName, ok := pinnedStringValue(input, "file_name")
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	chatsRoot := directories["chats"]
	chatFileName := startup.SanitizeUserFilename(fileName + ".jsonl")
	chatFilePath := filepath.Join(chatsRoot, cardName, chatFileName)
	if !pinnedPathUnderParent(chatsRoot, chatFilePath) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}

	rawChat, exists := input["chat"]
	if !exists {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "The request's body.chat is not an array."})
		return
	}
	chat, err := decodeOrderedNodeJSON(rawChat)
	if err != nil || chat.kind != 'a' {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "The request's body.chat is not an array."})
		return
	}
	lines := make([]string, 0, len(chat.array))
	for _, message := range chat.array {
		encoded, err := marshalOrderedNodeJSON(message)
		if err != nil {
			respondJSON(w, http.StatusInternalServerError,
				map[string]string{"error": "An error has occurred, see the console logs for more information."})
			return
		}
		lines = append(lines, string(encoded))
	}
	// tryWriteFileSync creates the parent directory recursively before writing.
	if err := os.MkdirAll(filepath.Dir(chatFilePath), 0o777); err != nil {
		respondJSON(w, http.StatusInternalServerError,
			map[string]string{"error": "An error has occurred, see the console logs for more information."})
		return
	}
	relativePath, err := filepath.Rel(directories["root"], chatFilePath)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError,
			map[string]string{"error": "An error has occurred, see the console logs for more information."})
		return
	}
	err = startup.UpdateUserContentFile(runtime.options.DataRoot, account.string("handle"), relativePath,
		func([]byte) ([]byte, error) {
			return []byte(strings.Join(lines, "\n")), nil
		})
	if err != nil {
		respondJSON(w, http.StatusInternalServerError,
			map[string]string{"error": "An error has occurred, see the console logs for more information."})
		return
	}
	respondJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (runtime *accountRuntime) serveChatsGet(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readFilesUploadBody(request)
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		respondOrderedNodeJSON(w, http.StatusOK, orderedNodeJSON{kind: 'o'})
		return
	}
	chatsRoot := directories["chats"]
	avatarURL, ok := pinnedStringValue(input, "avatar_url")
	if !ok {
		respondOrderedNodeJSON(w, http.StatusOK, orderedNodeJSON{kind: 'o'})
		return
	}
	directoryPath := filepath.Join(chatsRoot, pinnedReplaceFirst(avatarURL, ".png", ""))
	if !pinnedPathUnderParent(chatsRoot, directoryPath) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if _, err := os.Stat(directoryPath); err != nil {
		// The pinned route creates the per-character directory on demand and
		// answers with an empty object rather than a chat array.
		if mkdirErr := os.Mkdir(directoryPath, 0o777); mkdirErr != nil {
			respondOrderedNodeJSON(w, http.StatusOK, orderedNodeJSON{kind: 'o'})
			return
		}
		respondOrderedNodeJSON(w, http.StatusOK, orderedNodeJSON{kind: 'o'})
		return
	}
	rawFileName, exists := input["file_name"]
	if !exists || !nodeTruthyJSON(rawFileName) {
		respondOrderedNodeJSON(w, http.StatusOK, orderedNodeJSON{kind: 'o'})
		return
	}
	fileName, ok := pinnedStringValue(input, "file_name")
	if !ok {
		respondOrderedNodeJSON(w, http.StatusOK, orderedNodeJSON{kind: 'o'})
		return
	}
	chatFilePath := filepath.Join(directoryPath, startup.SanitizeUserFilename(fileName+".jsonl"))
	chatData := pinnedChatData(chatFilePath)
	respondOrderedNodeJSON(w, http.StatusOK, orderedNodeJSON{kind: 'a', array: chatData})
}
