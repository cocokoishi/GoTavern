package server

// Pinned chat rename, delete and export routes from src/endpoints/chats.js.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// pinnedStrictSanitize reproduces `sanitize(value)` for a body member:
// sanitize-filename throws `Input must be string` for anything that is not a
// string, which the pinned handlers' catch turns into a 500.
func pinnedStrictSanitize(input map[string]json.RawMessage, key string) (string, bool) {
	raw, exists := input[key]
	if !exists {
		return "", false
	}
	value, err := decodeOrderedNodeJSON(raw)
	if err != nil || value.kind != 's' {
		return "", false
	}
	text, _ := value.scalar.(string)
	return startup.SanitizeUserFilename(text), true
}

// pinnedChatsDirectories resolves the pinned chats and group-chats directories.
func (runtime *accountRuntime) pinnedChatsDirectories(account *storedAccount) (map[string]string, bool) {
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		return nil, false
	}
	return directories, true
}

// pinnedChatFolder reproduces the shared folder selection of /rename and
// /export: the group-chats directory when is_group is truthy, otherwise the
// per-character chats directory named by String(avatar_url).replace('.png',”).
func pinnedChatFolder(input map[string]json.RawMessage, directories map[string]string) (string, bool, bool) {
	isGroup := false
	if raw, exists := input["is_group"]; exists {
		if value, err := decodeOrderedNodeJSON(raw); err == nil && value.nodeTruthy() {
			isGroup = true
		}
	}
	if isGroup {
		return directories["groupChats"], true, true
	}
	avatar, ok := pinnedStringValue(input, "avatar_url")
	if !ok {
		return "", false, false
	}
	return filepath.Join(directories["chats"], pinnedReplaceFirst(avatar, ".png", "")), false, true
}

func (runtime *accountRuntime) serveChatsRename(w http.ResponseWriter, request *http.Request) {
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
	if !nodeTruthyJSON(input["original_file"]) || !nodeTruthyJSON(input["renamed_file"]) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.pinnedChatsDirectories(account)
	if !ok {
		respondJSON(w, http.StatusInternalServerError, map[string]bool{"error": true})
		return
	}
	folder, isGroup, ok := pinnedChatFolder(input, directories)
	if !ok {
		respondJSON(w, http.StatusInternalServerError, map[string]bool{"error": true})
		return
	}
	if !isGroup && !pinnedPathUnderParent(directories["chats"], folder) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	originalName, ok := pinnedStrictSanitize(input, "original_file")
	if !ok {
		respondJSON(w, http.StatusInternalServerError, map[string]bool{"error": true})
		return
	}
	renamedName, ok := pinnedStrictSanitize(input, "renamed_file")
	if !ok {
		respondJSON(w, http.StatusInternalServerError, map[string]bool{"error": true})
		return
	}
	pathToOriginalFile := filepath.Join(folder, originalName)
	pathToRenamedFile := filepath.Join(folder, renamedName)
	sanitizedFileName := strings.TrimSuffix(filepath.Base(pathToRenamedFile), nodePathExt(filepath.Base(pathToRenamedFile)))

	if _, err := os.Stat(pathToOriginalFile); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]bool{"error": true})
		return
	}
	if _, err := os.Stat(pathToRenamedFile); err == nil {
		respondJSON(w, http.StatusBadRequest, map[string]bool{"error": true})
		return
	}

	body, err := os.ReadFile(pathToOriginalFile)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]bool{"error": true})
		return
	}
	relativePath, err := filepath.Rel(directories["root"], pathToRenamedFile)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]bool{"error": true})
		return
	}
	if err := startup.UpdateUserContentFile(runtime.options.DataRoot, account.string("handle"), relativePath, func([]byte) ([]byte, error) {
		return body, nil
	}); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]bool{"error": true})
		return
	}
	originalRelative, err := filepath.Rel(directories["root"], pathToOriginalFile)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]bool{"error": true})
		return
	}
	if _, err := startup.DeleteUserFile(runtime.options.DataRoot, account.string("handle"), originalRelative); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]bool{"error": true})
		return
	}
	response := nodeObject()
	response.setMember("ok", nodeBool(true))
	response.setMember("sanitizedFileName", nodeString(sanitizedFileName))
	respondCharacterJSON(w, http.StatusOK, response)
}

func (runtime *accountRuntime) serveChatsDelete(w http.ResponseWriter, request *http.Request) {
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
	// `if (!path.extname(request.body.chatfile)) request.body.chatfile += '.jsonl';`
	// path.extname throws for a non-string, and the pinned handler is not async,
	// so its catch turns that into a 500.
	rawChatFile, exists := input["chatfile"]
	if !exists {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	chatFileValue, err := decodeOrderedNodeJSON(rawChatFile)
	if err != nil || chatFileValue.kind != 's' {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	chatFile, _ := chatFileValue.scalar.(string)
	if nodePathExt(chatFile) == "" {
		chatFile += ".jsonl"
	}
	directories, ok := runtime.pinnedChatsDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	avatar, ok := pinnedStringValue(input, "avatar_url")
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	chatFilePath := filepath.Join(directories["chats"], pinnedReplaceFirst(avatar, ".png", ""), startup.SanitizeUserFilename(chatFile))
	if !pinnedPathUnderParent(directories["chats"], chatFilePath) {
		serveStatusText(w, http.StatusBadRequest)
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

func (runtime *accountRuntime) serveChatsExport(w http.ResponseWriter, request *http.Request) {
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
	// `!request.body.file || (!request.body.avatar_url && request.body.is_group === false)`
	isGroupFalse := false
	if raw, exists := input["is_group"]; exists {
		if value, err := decodeOrderedNodeJSON(raw); err == nil && value.kind == 'b' && value.scalar == false {
			isGroupFalse = true
		}
	}
	if !nodeTruthyJSON(input["file"]) || (!nodeTruthyJSON(input["avatar_url"]) && isGroupFalse) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.pinnedChatsDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	folder, isGroup, ok := pinnedChatFolder(input, directories)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	fileName, ok := pinnedStrictSanitize(input, "file")
	if !ok {
		// sanitize() runs outside the pinned try/catch and the handler is async,
		// so a non-string file rejects the handler and terminates the process.
		// GoTavern answers 500 instead of crashing; see docs/compat-matrix.md.
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	filename := filepath.Join(folder, fileName)
	if !isGroup && !pinnedPathUnderParent(directories["chats"], filename) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	exportFileName, ok := pinnedStringValue(input, "exportfilename")
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if _, err := os.Stat(filename); err != nil {
		respondJSON(w, http.StatusNotFound, map[string]string{
			"message": "Could not find JSONL file to export. Source chat file: " + filename + ".",
		})
		return
	}

	format, _ := pinnedStringValue(input, "format")
	if format == "jsonl" {
		rawFile, err := os.ReadFile(filename)
		if err != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]string{
				"message": "Could not read JSONL file to export. Source chat file: " + filename + ".",
			})
			return
		}
		respondCharacterJSON(w, http.StatusOK, exportMessage(exportFileName, string(rawFile)))
		return
	}

	body, err := os.ReadFile(filename)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	var buffer strings.Builder
	for _, line := range splitReadlineLines(string(body)) {
		parsed, err := decodeOrderedNodeJSON([]byte(line))
		if err != nil {
			// Pinned Node parses inside a readline 'line' listener, so a
			// malformed line escapes the route's try/catch and terminates the
			// process. GoTavern answers 500 instead of crashing.
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		if jsTruthy(nodeGet(parsed, "is_system")) {
			continue
		}
		message := nodeGet(parsed, "mes")
		if !jsTruthy(message) {
			continue
		}
		name := jsTemplateString(nodeGet(parsed, "name"))
		display := nodeGet(parsed, "extra", "display_text")
		text := message
		if jsTruthy(display) {
			text = display
		}
		textValue, err := characterString(text)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		buffer.WriteString(name + ": " + replaceCarriageReturns(textValue) + "\n\n")
	}
	respondCharacterJSON(w, http.StatusOK, exportMessage(exportFileName, buffer.String()))
}

func exportMessage(exportFileName, result string) orderedNodeJSON {
	response := nodeObject()
	response.setMember("message", nodeString("Chat saved to "+exportFileName))
	response.setMember("result", nodeString(result))
	return response
}

// replaceCarriageReturns ports `.replace(/\r?\n/g, '\n')`: a CRLF pair becomes a
// single LF and a lone carriage return is left untouched.
func replaceCarriageReturns(value string) string {
	return strings.ReplaceAll(value, "\r\n", "\n")
}
