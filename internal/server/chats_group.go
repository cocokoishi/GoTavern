package server

// Pinned group-chat routes from src/endpoints/chats.js: /group/get, /group/info,
// /group/save, /group/delete and /group/import.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// pinnedGroupChatPath reproduces
// `path.join(directories.groupChats, sanitize(`${id}.jsonl`))`.
func pinnedGroupChatPath(input map[string]json.RawMessage, directories map[string]string) (string, bool) {
	id, ok := pinnedStringValue(input, "id")
	if !ok {
		return "", false
	}
	return filepath.Join(directories["groupChats"], startup.SanitizeUserFilename(id+".jsonl")), true
}

// pinnedGroupChatID returns the request body id and whether it is truthy, which
// is the shared guard of every /group/* route.
func pinnedGroupChatID(input map[string]json.RawMessage) (string, bool) {
	if !nodeTruthyJSON(input["id"]) {
		return "", false
	}
	id, ok := pinnedStringValue(input, "id")
	if !ok {
		return "", false
	}
	return id, true
}

func (runtime *accountRuntime) serveChatsGroupGet(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readFilesUploadBody(request)
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if _, ok := pinnedGroupChatID(input); !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.pinnedChatsDirectories(account)
	if !ok {
		respondCharacterJSON(w, http.StatusOK, nodeArray())
		return
	}
	chatFilePath, ok := pinnedGroupChatPath(input, directories)
	if !ok {
		respondCharacterJSON(w, http.StatusOK, nodeArray())
		return
	}
	respondCharacterJSON(w, http.StatusOK, nodeArray(pinnedChatData(chatFilePath)...))
}

func (runtime *accountRuntime) serveChatsGroupInfo(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readFilesUploadBody(request)
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if _, ok := pinnedGroupChatID(input); !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.pinnedChatsDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	chatFilePath, ok := pinnedGroupChatPath(input, directories)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// getChatInfo(chatFilePath) with no additional data and no metadata.
	respondCharacterJSON(w, http.StatusOK, getChatInfo(chatFilePath, false))
}

func (runtime *accountRuntime) serveChatsGroupDelete(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readFilesUploadBody(request)
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if _, ok := pinnedGroupChatID(input); !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.pinnedChatsDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	chatFilePath, ok := pinnedGroupChatPath(input, directories)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	relativePath, err := filepath.Rel(directories["root"], chatFilePath)
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
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	respondJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (runtime *accountRuntime) serveChatsGroupSave(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readFilesUploadBody(request)
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	id, ok := pinnedGroupChatID(input)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.pinnedChatsDirectories(account)
	if !ok {
		serveGroupSaveError(w, http.StatusInternalServerError)
		return
	}
	chatFilePath, ok := pinnedGroupChatPath(input, directories)
	if !ok {
		serveGroupSaveError(w, http.StatusInternalServerError)
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
			serveGroupSaveError(w, http.StatusInternalServerError)
			return
		}
		lines = append(lines, string(encoded))
	}
	// tryWriteFileSync creates the parent directory recursively before writing.
	if err := os.MkdirAll(filepath.Dir(chatFilePath), 0o777); err != nil {
		serveGroupSaveError(w, http.StatusInternalServerError)
		return
	}
	relativePath, err := filepath.Rel(directories["root"], chatFilePath)
	if err != nil {
		serveGroupSaveError(w, http.StatusInternalServerError)
		return
	}
	if err := startup.UpdateUserContentFile(runtime.options.DataRoot, account.string("handle"), relativePath, func([]byte) ([]byte, error) {
		return []byte(strings.Join(lines, "\n")), nil
	}); err != nil {
		serveGroupSaveError(w, http.StatusInternalServerError)
		return
	}
	_ = id
	respondJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func serveGroupSaveError(w http.ResponseWriter, status int) {
	respondJSON(w, status, map[string]string{"error": "An error has occurred, see the console logs for more information."})
}

func (runtime *accountRuntime) serveChatsGroupImport(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	parsed, err := parseCharactersMultipart(request, runtime.options.DataRoot)
	if err != nil {
		respondJSON(w, http.StatusOK, map[string]bool{"error": true})
		return
	}
	if parsed.stagedPath == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	defer removeStagedCharacterUpload(parsed.stagedPath)
	directories, ok := runtime.pinnedChatsDirectories(account)
	if !ok {
		respondJSON(w, http.StatusOK, map[string]bool{"error": true})
		return
	}
	body, err := os.ReadFile(parsed.stagedPath)
	if err != nil {
		respondJSON(w, http.StatusOK, map[string]bool{"error": true})
		return
	}
	chatName := humanizedDateTime(time.Now())
	target := filepath.Join(directories["groupChats"], chatName+".jsonl")
	relativePath, err := filepath.Rel(directories["root"], target)
	if err != nil {
		respondJSON(w, http.StatusOK, map[string]bool{"error": true})
		return
	}
	if err := startup.UpdateUserContentFile(runtime.options.DataRoot, account.string("handle"), relativePath, func([]byte) ([]byte, error) {
		return body, nil
	}); err != nil {
		respondJSON(w, http.StatusOK, map[string]bool{"error": true})
		return
	}
	removeStagedCharacterUpload(parsed.stagedPath)
	respondCharacterJSON(w, http.StatusOK, func() orderedNodeJSON {
		response := nodeObject()
		response.setMember("res", nodeString(chatName))
		return response
	}())
}
