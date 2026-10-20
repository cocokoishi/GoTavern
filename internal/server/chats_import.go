package server

// Pinned POST /api/chats/import from src/endpoints/chats.js.
//
// Timing note: every imported message carries `new Date().toISOString()` and the
// written file is named `${characterName} - ${humanizedDateTime()} imported.jsonl`,
// so the oracle records both as markers. A multi-file import would generate one
// name per file inside a single request, which the client cannot space; the
// probe therefore exercises the single-file shapes, and the CAI Tools format is
// deterministic anyway because its non-empty branch throws upstream (see below).

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveChatsImport(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	parsed, err := parseCharactersMultipart(request, runtime.options.DataRoot)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	defer removeStagedCharacterUpload(parsed.stagedPath)
	input := parsed.body
	if rawAvatarURL, exists := input.member("avatar_url"); exists && pinnedAvatarURLRejected(rawAvatarURL) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	// `(request.body.avatar_url).replace('.png','')` runs outside the pinned
	// try/catch in a non-async handler, so a non-string avatar_url reaches the
	// Express error handler; GoTavern answers 500 instead.
	avatar, isString := nodeGet(input, "avatar_url").stringValue()
	if !isString {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// `sanitize(request.body.character_name) || 'Character'` likewise throws for
	// a non-string and is outside the try/catch.
	characterName, ok := pinnedImportName(input, "character_name", "Character")
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	userName, ok := pinnedImportName(input, "user_name", "User")
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if parsed.stagedPath == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.pinnedChatsDirectories(account)
	if !ok {
		respondCharacterJSON(w, http.StatusOK, errorTrueObject())
		return
	}
	directoryPath := filepath.Join(directories["chats"], pinnedReplaceFirst(avatar, ".png", ""))
	if !pinnedPathUnderParent(directories["chats"], directoryPath) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	format, _ := nodeGet(input, "file_type").stringValue()
	contents, err := os.ReadFile(parsed.stagedPath)
	if err != nil {
		respondCharacterJSON(w, http.StatusOK, errorTrueObject())
		return
	}

	switch format {
	case "json":
		// The pinned branch unlinks the upload before parsing it.
		removeStagedCharacterUpload(parsed.stagedPath)
		imported, ok := pinnedImportJSON(userName, characterName, contents)
		if !ok {
			respondCharacterJSON(w, http.StatusOK, errorTrueObject())
			return
		}
		fileNames := make([]orderedNodeJSON, 0, len(imported))
		for _, chat := range imported {
			fileName := characterName + " - " + humanizedDateTime(time.Now()) + " imported.jsonl"
			fileNames = append(fileNames, nodeString(fileName))
			if err := runtime.writeImportedChat(account, directories, filepath.Join(directoryPath, fileName), []byte(chat)); err != nil {
				respondCharacterJSON(w, http.StatusOK, errorTrueObject())
				return
			}
		}
		response := nodeObject()
		response.setMember("res", nodeBool(true))
		response.setMember("fileNames", nodeArray(fileNames...))
		respondCharacterJSON(w, http.StatusOK, response)
	case "jsonl":
		imported, ok := pinnedImportJSONL(userName, characterName, contents)
		if !ok {
			respondCharacterJSON(w, http.StatusOK, errorTrueObject())
			return
		}
		fileName := characterName + " - " + humanizedDateTime(time.Now()) + " imported.jsonl"
		target := filepath.Join(directoryPath, fileName)
		if imported.flattened {
			if err := runtime.writeImportedChat(account, directories, target, []byte(imported.body)); err != nil {
				respondCharacterJSON(w, http.StatusOK, errorTrueObject())
				return
			}
		} else if err := runtime.copyImportedChat(account, directories, target, parsed.stagedPath); err != nil {
			respondCharacterJSON(w, http.StatusOK, errorTrueObject())
			return
		}
		removeStagedCharacterUpload(parsed.stagedPath)
		response := nodeObject()
		response.setMember("res", nodeBool(true))
		response.setMember("fileNames", nodeArray(nodeString(fileName)))
		respondCharacterJSON(w, http.StatusOK, response)
	default:
		// The pinned handler sends no response at all for an unknown file_type,
		// leaving the request open until the client times out. GoTavern answers
		// 400 instead; see docs/compat-matrix.md.
		serveStatusText(w, http.StatusBadRequest)
	}
}

// pinnedImportName ports `sanitize(value) || fallback`, where sanitize throws for
// anything that is not a string.
func pinnedImportName(input orderedNodeJSON, key, fallback string) (string, bool) {
	value := nodeGet(input, key)
	if value.isUndefined() {
		return "", false
	}
	text, ok := value.stringValue()
	if !ok {
		return "", false
	}
	sanitized := startup.SanitizeUserFilename(text)
	if sanitized == "" {
		return fallback, true
	}
	return sanitized, true
}

func (runtime *accountRuntime) writeImportedChat(account *storedAccount, directories map[string]string, target string, body []byte) error {
	relativePath, err := filepath.Rel(directories["root"], target)
	if err != nil {
		return err
	}
	return startup.UpdateUserContentFile(runtime.options.DataRoot, account.string("handle"), relativePath, func([]byte) ([]byte, error) {
		return body, nil
	})
}

func (runtime *accountRuntime) copyImportedChat(account *storedAccount, directories map[string]string, target, source string) error {
	body, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return runtime.writeImportedChat(account, directories, target, body)
}

// pinnedImportJSON ports the format dispatch of the pinned json branch and
// returns the chats to write, in order.
func pinnedImportJSON(userName, characterName string, contents []byte) ([]string, bool) {
	jsonData, err := decodeOrderedNodeJSON(contents)
	if err != nil {
		return nil, false
	}
	switch {
	case !nodeGet(jsonData, "savedsettings").isUndefined():
		chat, ok := importKoboldLiteChat(userName, characterName, jsonData)
		if !ok {
			return nil, false
		}
		return []string{chat}, true
	case !nodeGet(jsonData, "histories").isUndefined():
		// Pinned importCAIChat references `newChats` inside its own initializer,
		// so any non-empty history list raises a TDZ ReferenceError that the
		// route's catch turns into `{ error: true }`; an empty list maps to no
		// files and reports success.
		histories := nodeGet(jsonData, "histories", "histories")
		if histories.kind == 'a' && len(histories.array) > 0 {
			return nil, false
		}
		return nil, true
	case nodeGet(jsonData, "data_visible").kind == 'a':
		chat, ok := importOobaChat(userName, characterName, jsonData)
		if !ok {
			return nil, false
		}
		return []string{chat}, true
	case nodeGet(jsonData, "messages").kind == 'a':
		chat, ok := importAgnaiChat(userName, characterName, jsonData)
		if !ok {
			return nil, false
		}
		return []string{chat}, true
	case func() bool { text, _ := nodeGet(jsonData, "type").stringValue(); return text == "risuChat" }():
		chat, ok := importRisuChat(userName, characterName, jsonData)
		if !ok {
			return nil, false
		}
		return []string{chat}, true
	default:
		return nil, false
	}
}

// pinnedImportedChat serializes an imported chat array the way the pinned
// `chat.map(obj => JSON.stringify(obj)).join('\n')` does.
func pinnedImportedChat(messages []orderedNodeJSON) (string, bool) {
	lines := make([]string, 0, len(messages))
	for _, message := range messages {
		encoded, err := marshalCharacterJSON(message)
		if err != nil {
			return "", false
		}
		lines = append(lines, string(encoded))
	}
	return strings.Join(lines, "\n"), true
}

func pinnedImportHeader() orderedNodeJSON {
	header := nodeObject()
	header.setMember("chat_metadata", nodeObject())
	header.setMember("user_name", nodeString("unused"))
	header.setMember("character_name", nodeString("unused"))
	return header
}

func pinnedImportMessage(name string, isUser bool, mes string) orderedNodeJSON {
	message := nodeObject()
	message.setMember("name", nodeString(name))
	message.setMember("is_user", nodeBool(isUser))
	message.setMember("send_date", nodeString(time.Now().UTC().Format("2006-01-02T15:04:05.000Z")))
	message.setMember("mes", nodeString(mes))
	message.setMember("extra", nodeObject())
	return message
}

func importOobaChat(userName, characterName string, jsonData orderedNodeJSON) (string, bool) {
	messages := []orderedNodeJSON{pinnedImportHeader()}
	for _, pair := range nodeGet(jsonData, "data_visible").array {
		if pair.kind != 'a' {
			continue
		}
		if len(pair.array) > 0 && jsTruthy(pair.array[0]) {
			text, err := characterString(pair.array[0])
			if err != nil {
				return "", false
			}
			messages = append(messages, pinnedImportMessage(userName, true, text))
		}
		if len(pair.array) > 1 && jsTruthy(pair.array[1]) {
			text, err := characterString(pair.array[1])
			if err != nil {
				return "", false
			}
			messages = append(messages, pinnedImportMessage(characterName, false, text))
		}
	}
	return pinnedImportedChat(messages)
}

func importAgnaiChat(userName, characterName string, jsonData orderedNodeJSON) (string, bool) {
	messages := []orderedNodeJSON{pinnedImportHeader()}
	for _, message := range nodeGet(jsonData, "messages").array {
		isUser := jsTruthy(nodeGet(message, "userId"))
		name := characterName
		if isUser {
			name = userName
		}
		text, err := characterString(nodeGet(message, "msg"))
		if err != nil {
			return "", false
		}
		messages = append(messages, pinnedImportMessage(name, isUser, text))
	}
	return pinnedImportedChat(messages)
}

func importRisuChat(userName, characterName string, jsonData orderedNodeJSON) (string, bool) {
	messages := []orderedNodeJSON{pinnedImportHeader()}
	for _, message := range nodeGet(jsonData, "data", "message").array {
		role, _ := nodeGet(message, "role").stringValue()
		isUser := role == "user"
		name := characterName
		if isUser {
			name = userName
		}
		if explicit, ok := nodeGet(message, "name").stringValue(); ok && jsTruthy(nodeGet(message, "name")) {
			name = explicit
		}
		timeValue := nodeGet(message, "time")
		milliseconds := float64(time.Now().UnixMilli())
		if !timeValue.isUndefined() && timeValue.kind != 'n' {
			if parsed, ok := jsNumber(timeValue); ok {
				milliseconds = parsed
			}
		}
		text, err := characterString(nodeGet(message, "data"))
		if err != nil {
			return "", false
		}
		if nodeGet(message, "data").isUndefined() {
			text = ""
		}
		entry := nodeObject()
		entry.setMember("name", nodeString(name))
		entry.setMember("is_user", nodeBool(isUser))
		entry.setMember("send_date", nodeString(isoStringFromMilliseconds(milliseconds)))
		entry.setMember("mes", nodeString(text))
		entry.setMember("extra", nodeObject())
		messages = append(messages, entry)
	}
	return pinnedImportedChat(messages)
}

func importKoboldLiteChat(userName, characterName string, data orderedNodeJSON) (string, bool) {
	const inputToken = "{{[INPUT]}}"
	const outputToken = "{{[OUTPUT]}}"
	userNameValue := jsTemplateString(nodeGet(data, "savedsettings", "chatname"))
	characterNameValue := strings.Split(jsTemplateString(nodeGet(data, "savedsettings", "chatopponent")), "||$||")[0]

	process := func(message orderedNodeJSON) (orderedNodeJSON, bool) {
		text, err := characterString(message)
		if err != nil {
			return orderedNodeJSON{}, false
		}
		isUser := strings.Contains(text, inputToken)
		name := characterNameValue
		if isUser {
			name = userNameValue
		}
		cleaned := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(text, inputToken, ""), outputToken, ""))
		// The pinned Kobold Lite builder orders `mes` before `send_date`, unlike
		// the other import formats, and JSON.stringify preserves that order.
		entry := nodeObject()
		entry.setMember("name", nodeString(name))
		entry.setMember("is_user", nodeBool(isUser))
		entry.setMember("mes", nodeString(cleaned))
		entry.setMember("send_date", nodeString(time.Now().UTC().Format("2006-01-02T15:04:05.000Z")))
		entry.setMember("extra", nodeObject())
		return entry, true
	}

	messages := []orderedNodeJSON{pinnedImportHeader()}
	if prompt := nodeGet(data, "prompt"); jsTruthy(prompt) {
		entry, ok := process(prompt)
		if !ok {
			return "", false
		}
		messages = append(messages, entry)
	}
	for _, action := range nodeGet(data, "actions").array {
		entry, ok := process(action)
		if !ok {
			return "", false
		}
		messages = append(messages, entry)
	}
	return pinnedImportedChat(messages)
}

// pinnedImportJSONL ports the jsonl branch, reporting whether the Chub
// flattening changed the payload (which decides between an atomic write and a
// byte copy).
type pinnedJSONLImport struct {
	body      string
	flattened bool
}

func pinnedImportJSONL(userName, characterName string, contents []byte) (pinnedJSONLImport, bool) {
	data := string(contents)
	lines := strings.Split(data, "\n")
	header, err := decodeOrderedNodeJSON([]byte(lines[0]))
	if err != nil {
		return pinnedJSONLImport{}, false
	}
	valid := !nodeGet(header, "user_name").isUndefined() ||
		!nodeGet(header, "name").isUndefined() ||
		!nodeGet(header, "chat_metadata").isUndefined()
	if !valid {
		return pinnedJSONLImport{}, false
	}
	flattened, ok := flattenChubChat(lines)
	if !ok {
		// The pinned code logs a warning and keeps the original payload.
		return pinnedJSONLImport{body: data, flattened: false}, true
	}
	if flattened == data {
		return pinnedJSONLImport{body: data, flattened: false}, true
	}
	return pinnedJSONLImport{body: flattened, flattened: true}, true
}

// flattenChubChat ports chats.js flattenChubChat. A line that does not parse is
// returned untouched; every other line is re-serialized.
func flattenChubChat(lines []string) (string, bool) {
	converted := make([]string, 0, len(lines))
	for _, line := range lines {
		parsed, err := decodeOrderedNodeJSON([]byte(line))
		if err != nil || !jsTruthy(parsed) {
			converted = append(converted, line)
			continue
		}
		if message := nodeGet(parsed, "mes", "message"); jsTruthy(message) {
			nodeSet(&parsed, []string{"mes"}, message)
		}
		if swipes := nodeGet(parsed, "swipes"); swipes.kind == 'a' {
			flattened := make([]orderedNodeJSON, 0, len(swipes.array))
			for _, swipe := range swipes.array {
				if message := nodeGet(swipe, "message"); jsTruthy(message) {
					flattened = append(flattened, message)
				} else {
					flattened = append(flattened, swipe)
				}
			}
			nodeSet(&parsed, []string{"swipes"}, nodeArray(flattened...))
		}
		encoded, err := marshalCharacterJSON(parsed)
		if err != nil {
			return "", false
		}
		converted = append(converted, string(encoded))
	}
	return strings.Join(converted, "\n"), true
}
