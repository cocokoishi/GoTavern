package server

// Pinned /api/chats/search and /api/chats/recent, plus the chats-local
// getChatInfo variant they need (additional data and a match function).
//
// Host-dependence notes:
//  - both routes enumerate directories with fs.readdirSync, whose order differs
//    between NTFS and ext4, so the recorded result arrays are sorted and the
//    routes' own ordering is pinned only through seeded, distinct mtimes;
//  - /recent orders by mtime, so every seeded chat file has a distinct mtime
//    and the order is a real assertion rather than a tie broken by insertion
//    order;
//  - /import names its files with humanizedDateTime(), recorded as a marker.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// pinnedChatInfo ports chats.js getChatInfo, including the additionalData spread
// and the optional match function.
//
// The pinned matcher is called with the accumulated message texts of the lines
// seen so far and stops the scan once it returns true; a line that fails to
// parse contributes nothing to the buffer but still counts towards the item
// counter.
func pinnedChatInfo(pathToFile string, additionalData *orderedNodeJSON, withMetadata bool, matcher func([]string) bool) (orderedNodeJSON, error) {
	info, err := os.Stat(pathToFile)
	if err != nil {
		if os.IsNotExist(err) {
			return chatVanishedObject(), nil
		}
		return orderedNodeJSON{}, err
	}
	base := filepath.Base(pathToFile)
	chatData := nodeObject()
	chatData.setMember("match", nodeBool(false))
	chatData.setMember("file_id", nodeString(strings.TrimSuffix(base, nodePathExt(base))))
	chatData.setMember("file_name", nodeString(base))
	chatData.setMember("file_size", nodeString(formatBytes(info.Size())))
	chatData.setMember("chat_items", nodeNumber(0))
	chatData.setMember("mes", nodeString("[The chat is empty]"))
	chatData.setMember("last_mes", nodeNumber(float64(info.ModTime().UnixNano())/1e6))
	if additionalData != nil && additionalData.kind == 'o' {
		for _, entry := range additionalData.object {
			chatData.setMember(entry.key, entry.value)
		}
	}
	if info.Size() == 0 {
		return chatData, nil
	}

	contents, err := os.ReadFile(pathToFile)
	if err != nil {
		if os.IsNotExist(err) {
			return chatVanishedObject(), nil
		}
		return orderedNodeJSON{}, err
	}
	hasMatcher := matcher != nil
	itemCounter := 0
	hasAnyMatch := false
	matchBuffer := make([]string, 0, 8)
	lastLine := ""
	hasLastLine := false
	for _, line := range splitReadlineLines(string(contents)) {
		if withMetadata && itemCounter == 0 {
			if parsed, err := decodeOrderedNodeJSON([]byte(line)); err == nil {
				if metadata, exists := parsed.member("chat_metadata"); exists && (metadata.kind == 'o' || metadata.kind == 'a') {
					chatData.setMember("chat_metadata", metadata)
				}
			}
		}
		if hasMatcher && !hasAnyMatch && itemCounter > 0 {
			if parsed, err := decodeOrderedNodeJSON([]byte(line)); err == nil {
				message, _ := nodeGet(parsed, "mes").stringValue()
				matchBuffer = append(matchBuffer, message)
				if matcher(matchBuffer) {
					hasAnyMatch = true
					matchBuffer = matchBuffer[:0]
				}
			}
		}
		itemCounter++
		lastLine = line
		hasLastLine = true
	}
	if !hasLastLine || lastLine == "" {
		return chatData, nil
	}
	parsed, err := decodeOrderedNodeJSON([]byte(lastLine))
	valid := err == nil && jsTruthy(parsed) &&
		(jsTruthy(nodeGet(parsed, "name")) || jsTruthy(nodeGet(parsed, "character_name")) || jsTruthy(nodeGet(parsed, "chat_metadata")))
	if valid {
		chatData.setMember("chat_items", nodeNumber(float64(itemCounter-1)))
		message := nodeGet(parsed, "mes")
		if !jsTruthy(message) {
			message = nodeString("[The message is empty]")
		}
		chatData.setMember("mes", message)
		sendDate := nodeGet(parsed, "send_date")
		if !jsTruthy(sendDate) {
			sendDate = nodeString(isoStringFromMilliseconds(float64(info.ModTime().UnixNano()) / 1e6))
		}
		chatData.setMember("last_mes", sendDate)
	} else {
		remaining := itemCounter - 2
		if remaining < 0 {
			remaining = 0
		}
		chatData.setMember("chat_items", nodeNumber(float64(remaining)))
		chatData.setMember("mes", nodeString("[The message is empty]"))
	}
	chatData.setMember("match", nodeBool(!hasMatcher || hasAnyMatch))
	return chatData, nil
}

// pinnedPreviewMessage ports chats.js getPreviewMessage.
func pinnedPreviewMessage(lastMessage string) string {
	const strlen = 400
	if lastMessage == "" {
		return ""
	}
	if len(lastMessage) > strlen {
		return "..." + lastMessage[len(lastMessage)-strlen:]
	}
	return lastMessage
}

// pinnedSearchMatcher ports the /search hasTextMatch closure.
func pinnedSearchMatcher(fragments []string) func([]string) bool {
	return func(texts []string) bool {
		if len(fragments) == 0 {
			return true
		}
		for _, fragment := range fragments {
			found := false
			for _, text := range texts {
				if strings.Contains(strings.ToLower(text), fragment) {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
		return true
	}
}

// pinnedSearchFragments ports `query ? query.trim().toLowerCase().split(/\s+/).filter(x => x) : []`.
func pinnedSearchFragments(query orderedNodeJSON) []string {
	if !jsTruthy(query) {
		return nil
	}
	text, err := characterString(query)
	if err != nil {
		return nil
	}
	fragments := make([]string, 0, 4)
	for _, part := range strings.Fields(strings.ToLower(strings.TrimSpace(text))) {
		if part != "" {
			fragments = append(fragments, part)
		}
	}
	return fragments
}

func (runtime *accountRuntime) serveChatsSearch(w http.ResponseWriter, request *http.Request) {
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
	directories, ok := runtime.pinnedChatsDirectories(account)
	if !ok {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Search failed"})
		return
	}
	query := orderedNodeJSON{kind: 'u'}
	if raw, exists := input["query"]; exists {
		if value, err := decodeOrderedNodeJSON(raw); err == nil {
			query = value
		}
	}
	fragments := pinnedSearchFragments(query)
	hasTextMatch := pinnedSearchMatcher(fragments)

	chatFiles := make([]string, 0, 8)
	groupID := mustDecodeMember(input, "group_id")
	if jsTruthy(groupID) {
		groupIDText, _ := characterString(groupID)
		groupFiles, err := os.ReadDir(directories["groups"])
		if err != nil {
			groupFiles = nil
		}
		found := false
		var targetGroup orderedNodeJSON
		for _, entry := range groupFiles {
			if nodePathExt(entry.Name()) != ".json" {
				continue
			}
			contents, err := os.ReadFile(filepath.Join(directories["groups"], entry.Name()))
			if err != nil {
				continue
			}
			parsed, err := decodeOrderedNodeJSON(contents)
			if err != nil {
				continue
			}
			if id, _ := nodeGet(parsed, "id").stringValue(); id == groupIDText {
				targetGroup = parsed
				found = true
				break
			}
		}
		if !found {
			respondCharacterJSON(w, http.StatusOK, nodeArray())
			return
		}
		chats := nodeGet(targetGroup, "chats")
		if chats.kind != 'a' {
			respondCharacterJSON(w, http.StatusOK, nodeArray())
			return
		}
		for _, chat := range chats.array {
			chatID, ok := chat.stringValue()
			if !ok {
				continue
			}
			candidate := filepath.Join(directories["groupChats"], chatID+".jsonl")
			if _, err := os.Stat(candidate); err == nil {
				chatFiles = append(chatFiles, candidate)
			}
		}
	} else {
		avatarURL, _ := pinnedStringValue(input, "avatar_url")
		characterName := pinnedReplaceFirst(avatarURL, ".png", "")
		directoryPath := filepath.Join(directories["chats"], characterName)
		entries, err := os.ReadDir(directoryPath)
		if err != nil {
			respondCharacterJSON(w, http.StatusOK, nodeArray())
			return
		}
		for _, entry := range entries {
			if nodePathExt(entry.Name()) != ".jsonl" {
				continue
			}
			chatFiles = append(chatFiles, filepath.Join(directoryPath, entry.Name()))
		}
	}

	results := make([]orderedNodeJSON, 0, len(chatFiles))
	for _, chatFile := range chatFiles {
		var matcher func([]string) bool
		if jsTruthy(query) {
			matcher = hasTextMatch
		}
		chatInfo, err := pinnedChatInfo(chatFile, nil, false, matcher)
		if err != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Search failed"})
			return
		}
		fileID, _ := nodeGet(chatInfo, "file_id").stringValue()
		hasMatch := jsTruthy(nodeGet(chatInfo, "match")) || hasTextMatch([]string{fileID})
		if !jsTruthy(nodeGet(chatInfo, "file_name")) {
			continue
		}
		chatItems, _ := jsNumber(nodeGet(chatInfo, "chat_items"))
		if jsTruthy(query) && chatItems == 0 && !hasMatch {
			continue
		}
		if !jsTruthy(query) || hasMatch {
			message, _ := nodeGet(chatInfo, "mes").stringValue()
			result := nodeObject()
			result.setMember("file_name", nodeString(fileID))
			result.setMember("file_size", nodeGet(chatInfo, "file_size"))
			result.setMember("message_count", nodeNumber(chatItems))
			result.setMember("last_mes", nodeGet(chatInfo, "last_mes"))
			result.setMember("preview_message", nodeString(pinnedPreviewMessage(message)))
			results = append(results, result)
		}
	}
	respondCharacterJSON(w, http.StatusOK, nodeArray(results...))
}

// mustDecodeMember decodes one request member, returning undefined when absent.
func mustDecodeMember(input map[string]json.RawMessage, key string) orderedNodeJSON {
	raw, exists := input[key]
	if !exists {
		return nodeUndefined()
	}
	value, err := decodeOrderedNodeJSON(raw)
	if err != nil {
		return nodeUndefined()
	}
	return value
}

// sortCharactersByMtimeDesc is the /recent ordering: pinned entries first, then
// newest mtime first. Pinned Node uses Array.prototype.sort, which is stable, so
// equal mtimes would keep the collectors' nondeterministic insertion order; the
// oracle seeds distinct mtimes so the order is a real assertion.
func sortRecentChats(entries []orderedNodeJSON, isPinned func(orderedNodeJSON) bool) {
	sort.SliceStable(entries, func(left, right int) bool {
		leftPinned := isPinned(entries[left])
		rightPinned := isPinned(entries[right])
		if leftPinned != rightPinned {
			return leftPinned
		}
		leftMtime, _ := jsNumber(nodeGet(entries[left], "mtime"))
		rightMtime, _ := jsNumber(nodeGet(entries[right], "mtime"))
		return leftMtime > rightMtime
	})
}

func (runtime *accountRuntime) serveChatsRecent(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readFilesUploadBody(request)
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.pinnedChatsDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	pinnedChats := nodeArray()
	if raw, exists := input["pinned"]; exists {
		if value, err := decodeOrderedNodeJSON(raw); err == nil && value.kind == 'a' {
			pinnedChats = value
		}
	}
	withMetadata := jsTruthy(mustDecodeMember(input, "metadata"))

	collected := make([]orderedNodeJSON, 0, 8)
	// getCharacterChatFiles
	if entries, err := os.ReadDir(directories["characters"]); err == nil {
		for _, entry := range entries {
			if !entry.Type().IsRegular() || nodePathExt(entry.Name()) != ".png" {
				continue
			}
			chatsDirectory := pinnedReplaceFirst(entry.Name(), ".png", "")
			pathToChats := filepath.Join(directories["chats"], chatsDirectory)
			info, err := os.Stat(pathToChats)
			if err != nil || !info.IsDir() {
				continue
			}
			chatEntries, err := os.ReadDir(pathToChats)
			if err != nil {
				continue
			}
			for _, chatEntry := range chatEntries {
				if nodePathExt(chatEntry.Name()) != ".jsonl" {
					continue
				}
				filePath := filepath.Join(pathToChats, chatEntry.Name())
				stats, err := os.Stat(filePath)
				if err != nil {
					continue
				}
				file := nodeObject()
				file.setMember("pngFile", nodeString(entry.Name()))
				file.setMember("filePath", nodeString(filePath))
				file.setMember("mtime", nodeNumber(float64(stats.ModTime().UnixNano())/1e6))
				collected = append(collected, file)
			}
		}
	}
	// getGroupChatFiles
	if entries, err := os.ReadDir(directories["groups"]); err == nil {
		for _, entry := range entries {
			if !entry.Type().IsRegular() || nodePathExt(entry.Name()) != ".json" {
				continue
			}
			contents, err := os.ReadFile(filepath.Join(directories["groups"], entry.Name()))
			if err != nil {
				continue
			}
			groupData, err := decodeOrderedNodeJSON(contents)
			if err != nil {
				continue
			}
			chats := nodeGet(groupData, "chats")
			if chats.kind != 'a' {
				continue
			}
			for _, chat := range chats.array {
				chatID, ok := chat.stringValue()
				if !ok {
					continue
				}
				filePath := filepath.Join(directories["groupChats"], chatID+".jsonl")
				stats, err := os.Stat(filePath)
				if err != nil {
					continue
				}
				file := nodeObject()
				file.setMember("groupId", nodeGet(groupData, "id"))
				file.setMember("filePath", nodeString(filePath))
				file.setMember("mtime", nodeNumber(float64(stats.ModTime().UnixNano())/1e6))
				collected = append(collected, file)
			}
		}
	}
	// getRootChatFiles
	if entries, err := os.ReadDir(directories["chats"]); err == nil {
		for _, entry := range entries {
			if !entry.Type().IsRegular() || nodePathExt(entry.Name()) != ".jsonl" {
				continue
			}
			filePath := filepath.Join(directories["chats"], entry.Name())
			stats, err := os.Stat(filePath)
			if err != nil {
				continue
			}
			file := nodeObject()
			file.setMember("filePath", nodeString(filePath))
			file.setMember("mtime", nodeNumber(float64(stats.ModTime().UnixNano())/1e6))
			collected = append(collected, file)
		}
	}

	isPinned := func(file orderedNodeJSON) bool {
		base := filepath.Base(jsTemplateString(nodeGet(file, "filePath")))
		for _, pinned := range pinnedChats.array {
			if name, _ := nodeGet(pinned, "file_name").stringValue(); name != base {
				continue
			}
			avatar := nodeGet(pinned, "avatar")
			group := nodeGet(pinned, "group")
			pngFile := nodeGet(file, "pngFile")
			groupId := nodeGet(file, "groupId")
			if jsTruthy(avatar) && jsTruthy(pngFile) && jsStrictEquals(avatar, pngFile) {
				return true
			}
			if jsTruthy(group) && jsTruthy(groupId) && jsStrictEquals(group, groupId) {
				return true
			}
		}
		return false
	}
	sortRecentChats(collected, isPinned)

	limit := float64(9007199254740991)
	if raw, exists := input["max"]; exists {
		value, err := decodeOrderedNodeJSON(raw)
		if err != nil || value.kind == 'u' || value.kind == 'n' {
			limit = 9007199254740991
		} else {
			text, err := characterString(value)
			if err != nil {
				limit = 9007199254740991
			} else {
				parsed, err := strconv.ParseFloat(strings.TrimSpace(strings.SplitN(text, ".", 2)[0]), 64)
				if err != nil || !jsTruthyNumber(parsed) {
					limit = 0
				} else {
					limit = parsed
				}
			}
		}
	}
	limit += float64(len(pinnedChats.array))
	if limit < 0 {
		limit = 0
	}
	if limit < float64(len(collected)) {
		collected = collected[:int(limit)]
	}

	results := make([]orderedNodeJSON, 0, len(collected))
	for _, file := range collected {
		additional := nodeObject()
		filePath, _ := nodeGet(file, "filePath").stringValue()
		if jsTruthy(nodeGet(file, "groupId")) {
			additional.setMember("group", nodeGet(file, "groupId"))
		} else {
			additional.setMember("avatar", nodeGet(file, "pngFile"))
		}
		chatInfo, err := pinnedChatInfo(filePath, &additional, withMetadata, nil)
		if err != nil {
			continue
		}
		if jsTruthy(nodeGet(chatInfo, "file_name")) {
			results = append(results, chatInfo)
		}
	}
	respondCharacterJSON(w, http.StatusOK, nodeArray(results...))
}

// jsStrictEquals ports JavaScript `===` for JSON-decoded values.
func jsStrictEquals(left, right orderedNodeJSON) bool {
	if left.kind != right.kind {
		return false
	}
	switch left.kind {
	case nodeUndefinedKind, 'n':
		return true
	case 's':
		leftText, leftOK := left.scalar.(string)
		rightText, rightOK := right.scalar.(string)
		return leftOK && rightOK && leftText == rightText
	case 'b':
		leftBool, leftOK := left.scalar.(bool)
		rightBool, rightOK := right.scalar.(bool)
		return leftOK && rightOK && leftBool == rightBool
	case 'v':
		leftNumber, leftOK := left.scalar.(float64)
		rightNumber, rightOK := right.scalar.(float64)
		return leftOK && rightOK && leftNumber == rightNumber
	case 'h':
		leftUnit, leftOK := left.scalar.(uint16)
		rightUnit, rightOK := right.scalar.(uint16)
		return leftOK && rightOK && leftUnit == rightUnit
	default:
		return false
	}
}

// jsTruthyNumber reports whether a parsed number survives JavaScript truthiness.
func jsTruthyNumber(value float64) bool {
	return value != 0 && value == value
}
