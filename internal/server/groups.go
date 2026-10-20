package server

// Pinned groups domain from src/endpoints/groups.js.
//
// Host-dependence notes:
//  - /all reports date_added/create_date from the group file's birthtimeMs,
//    which depends on the filesystem (NTFS creation time, ext4 statx btime, 0
//    where unsupported) and cannot be seeded, so the oracle records it as a
//    marker and the Go test asserts the pinned derivation instead.
//  - /all iterates fs.readdirSync, whose order differs between NTFS and ext4, so
//    the recorded array is compared sorted.
//  - /create uses String(Date.now()) as the group id and file name, which the
//    oracle records as a marker.

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// pinnedGroupMetadataKeys are the deprecated keys warnOnGroupMetadata deletes.
var pinnedGroupMetadataKeys = []string{"chat_metadata", "past_metadata"}

// pinnedWarnOnGroupMetadata ports groups.js warnOnGroupMetadata: it removes the
// deprecated keys from the request body in place.
func pinnedWarnOnGroupMetadata(body *orderedNodeJSON) {
	if body.kind != 'o' {
		return
	}
	for _, key := range pinnedGroupMetadataKeys {
		nodeUnset(body, key)
	}
}

// pinnedGroupDirectories resolves the groups and group-chats directories.
func (runtime *accountRuntime) pinnedGroupDirectories(account *storedAccount) (map[string]string, bool) {
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		return nil, false
	}
	return directories, true
}

func (runtime *accountRuntime) serveGroupsAll(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	if _, valid := readFilesUploadBody(request); !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.pinnedGroupDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	groupsRoot := directories["groups"]
	if _, err := os.Stat(groupsRoot); err != nil {
		if err := os.Mkdir(groupsRoot, 0o777); err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
	}
	groupEntries, err := os.ReadDir(groupsRoot)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	chatEntries, err := os.ReadDir(directories["groupChats"])
	if err != nil {
		chatEntries = nil
	}
	chatNames := make([]string, 0, len(chatEntries))
	for _, entry := range chatEntries {
		if nodePathExt(entry.Name()) == ".jsonl" {
			chatNames = append(chatNames, entry.Name())
		}
	}
	sort.Slice(chatNames, func(left, right int) bool { return chatNames[left] < chatNames[right] })

	groups := make([]orderedNodeJSON, 0, len(groupEntries))
	for _, entry := range groupEntries {
		if nodePathExt(entry.Name()) != ".json" {
			continue
		}
		filePath := filepath.Join(groupsRoot, entry.Name())
		contents, err := os.ReadFile(filePath)
		if err != nil {
			continue
		}
		group, err := decodeOrderedNodeJSON(contents)
		if err != nil || group.kind != 'o' {
			continue
		}
		info, err := os.Stat(filePath)
		if err != nil {
			continue
		}
		birthtime := nodeFileBirthtimeMilliseconds(filePath, info)
		nodeSet(&group, []string{"date_added"}, nodeNumber(birthtime))
		nodeSet(&group, []string{"create_date"}, nodeString(isoStringFromMilliseconds(birthtime)))

		chatSize := 0.0
		dateLastChat := 0.0
		if chats, exists := group.member("chats"); exists && chats.kind == 'a' {
			members := make(map[string]struct{}, len(chats.array))
			for _, chat := range chats.array {
				if name, ok := chat.stringValue(); ok {
					members[name] = struct{}{}
				}
			}
			for _, chatName := range chatNames {
				if _, included := members[strings.TrimSuffix(chatName, ".jsonl")]; !included {
					continue
				}
				chatInfo, err := os.Stat(filepath.Join(directories["groupChats"], chatName))
				if err != nil {
					continue
				}
				chatSize += float64(chatInfo.Size())
				modified := float64(chatInfo.ModTime().UnixNano()) / 1e6
				if modified > dateLastChat {
					dateLastChat = modified
				}
			}
		}
		nodeSet(&group, []string{"date_last_chat"}, nodeNumber(dateLastChat))
		nodeSet(&group, []string{"chat_size"}, nodeNumber(chatSize))
		groups = append(groups, group)
	}
	respondCharacterJSON(w, http.StatusOK, nodeArray(groups...))
}

func (runtime *accountRuntime) serveGroupsCreate(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	body, ok := readOrderedRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.pinnedGroupDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	pinnedWarnOnGroupMetadata(&body)

	id := javascriptNumberString(float64(time.Now().UnixMilli()))
	groupMetadata := nodeObject()
	groupMetadata.setMember("id", nodeString(id))
	groupMetadata.setMember("name", nodeDefaulted(nodeGet(body, "name"), nodeString("New Group")))
	groupMetadata.setMember("members", nodeDefaulted(nodeGet(body, "members"), nodeArray()))
	groupMetadata.setMember("avatar_url", nodeGet(body, "avatar_url"))
	groupMetadata.setMember("allow_self_responses", nodeBool(jsTruthy(nodeGet(body, "allow_self_responses"))))
	groupMetadata.setMember("activation_strategy", nodeDefaulted(nodeGet(body, "activation_strategy"), nodeNumber(0)))
	groupMetadata.setMember("generation_mode", nodeDefaulted(nodeGet(body, "generation_mode"), nodeNumber(0)))
	groupMetadata.setMember("disabled_members", nodeDefaulted(nodeGet(body, "disabled_members"), nodeArray()))
	groupMetadata.setMember("fav", nodeGet(body, "fav"))
	groupMetadata.setMember("chat_id", nodeDefaulted(nodeGet(body, "chat_id"), nodeString(id)))
	groupMetadata.setMember("chats", nodeDefaulted(nodeGet(body, "chats"), nodeArray(nodeString(id))))
	groupMetadata.setMember("auto_mode_delay", nodeDefaulted(nodeGet(body, "auto_mode_delay"), nodeNumber(5)))
	groupMetadata.setMember("generation_mode_join_prefix", nodeDefaulted(nodeGet(body, "generation_mode_join_prefix"), nodeString("")))
	groupMetadata.setMember("generation_mode_join_suffix", nodeDefaulted(nodeGet(body, "generation_mode_join_suffix"), nodeString("")))

	groupsRoot := directories["groups"]
	if _, err := os.Stat(groupsRoot); err != nil {
		if err := os.Mkdir(groupsRoot, 0o777); err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
	}
	fileData, err := marshalCharacterJSONIndent(groupMetadata)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	pathToFile := filepath.Join(groupsRoot, startup.SanitizeUserFilename(id+".json"))
	relativePath, err := filepath.Rel(directories["root"], pathToFile)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if err := startup.UpdateUserContentFile(runtime.options.DataRoot, account.string("handle"), relativePath, func([]byte) ([]byte, error) {
		return fileData, nil
	}); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondCharacterJSON(w, http.StatusOK, groupMetadata)
}

// readOrderedRequestBody reads a JSON request body while preserving member
// order. Express parses with JSON.parse, which keeps insertion order, and
// /groups/edit writes the body back with JSON.stringify, so rebuilding it from a
// Go map would silently reorder the file it writes.
func readOrderedRequestBody(request *http.Request) (orderedNodeJSON, bool) {
	body, ok := readRawRequestBody(request)
	if !ok {
		return orderedNodeJSON{}, false
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return nodeObject(), true
	}
	parsed, err := decodeOrderedNodeJSON(body)
	if err != nil || parsed.kind != 'o' {
		return orderedNodeJSON{}, false
	}
	return parsed, true
}

func readRawRequestBody(request *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(io.LimitReader(request.Body, pinnedBodyParserLimit+1))
	if err != nil || int64(len(body)) > pinnedBodyParserLimit {
		return nil, false
	}
	return body, true
}

// nodeDefaulted ports `value ?? fallback`.
func nodeDefaulted(value, fallback orderedNodeJSON) orderedNodeJSON {
	return nodeNullish(value, fallback)
}

func (runtime *accountRuntime) serveGroupsEdit(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	body, ok := readOrderedRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	// getFileNameValidationFunction('id') rejects a forbidden path character.
	if id, exists := body.member("id"); exists && pinnedAvatarURLRejected(id) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if !jsTruthy(nodeGet(body, "id")) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.pinnedGroupDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	id, ok := nodeGet(body, "id").stringValue()
	if !ok {
		id = jsTemplateString(nodeGet(body, "id"))
	}
	pinnedWarnOnGroupMetadata(&body)
	fileData, err := marshalCharacterJSONIndent(body)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	pathToFile := filepath.Join(directories["groups"], startup.SanitizeUserFilename(id+".json"))
	relativePath, err := filepath.Rel(directories["root"], pathToFile)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if err := startup.UpdateUserContentFile(runtime.options.DataRoot, account.string("handle"), relativePath, func([]byte) ([]byte, error) {
		return fileData, nil
	}); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (runtime *accountRuntime) serveGroupsDelete(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readFilesUploadBody(request)
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if rawID, exists := input["id"]; exists {
		if value, err := decodeOrderedNodeJSON(rawID); err == nil && pinnedAvatarURLRejected(value) {
			serveStatusText(w, http.StatusBadRequest)
			return
		}
	}
	if !nodeTruthyJSON(input["id"]) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.pinnedGroupDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	id, ok := pinnedStringValue(input, "id")
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	pathToGroup := filepath.Join(directories["groups"], startup.SanitizeUserFilename(id+".json"))

	// Delete the group's chats first. A missing or unreadable group file is
	// swallowed by the pinned catch and the group file is still removed.
	if contents, err := os.ReadFile(pathToGroup); err == nil {
		if group, err := decodeOrderedNodeJSON(contents); err == nil && group.kind == 'o' {
			if chats := nodeGet(group, "chats"); chats.kind == 'a' {
				for _, chat := range chats.array {
					name, ok := chat.stringValue()
					if !ok {
						continue
					}
					chatPath := filepath.Join(directories["groupChats"], startup.SanitizeUserFilename(name+".jsonl"))
					relative, err := filepath.Rel(directories["root"], chatPath)
					if err != nil {
						continue
					}
					_, _ = startup.DeleteUserFile(runtime.options.DataRoot, account.string("handle"), relative)
				}
			}
		}
	}
	if _, err := os.Stat(pathToGroup); err == nil {
		relative, err := filepath.Rel(directories["root"], pathToGroup)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		if _, err := startup.DeleteUserFile(runtime.options.DataRoot, account.string("handle"), relative); err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
	}
	respondJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
