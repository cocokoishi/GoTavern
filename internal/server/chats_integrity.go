package server

// Pinned chat-save INTEGRITY check (chat_metadata.integrity), and the group-save
// counterpart of trySaveChat's backup scheduling.
//
// PINNED SOURCE (read before changing this file):
//
//	src/endpoints/chats.js:30       checkIntegrity = getConfigValue('backups.chat.checkIntegrity', true, 'boolean'), read at module load
//	src/endpoints/chats.js:332-369  checkChatIntegrity(filePath, integritySlug)
//	src/endpoints/chats.js:532-543  trySaveChat: jsonlData first; doIntegrityCheck = checkIntegrity && !skipIntegrityCheck;
//	                                chatIntegritySlug = chatData?.[0]?.chat_metadata?.integrity;
//	                                throw IntegrityMismatchError when the slug is truthy and checkChatIntegrity is false;
//	                                then write, then schedule the backup
//	src/endpoints/chats.js:545-570  POST /save: request.body.force is the skip flag; mismatch answers 400 {"error":"integrity"}
//	src/endpoints/chats.js:922-947  POST /group/save: the SAME trySaveChat path with cardName=String(id)
//	src/util.js:1560-1578           readFirstLine: readline, so a line ends at CR, LF or CRLF and the terminator is not returned
//	src/util.js:571-578             tryParse: JSON.parse, undefined on failure
//
// The observable contract reproduced here:
//   - a request whose first chat element carries a truthy chat_metadata.integrity must
//     match the stored file's first-line chat_metadata.integrity, unless body.force is
//     truthy in the JavaScript sense or checkIntegrity is false;
//   - a missing file, an empty file, a first line with no integrity metadata and a
//     first line whose chat_metadata is not an object all pass (legacy/corrupt cases);
//   - a non-empty file whose first line is not a JSON object FAILS (the client must
//     ask for an explicit overwrite);
//   - a JSON string BOM from an external editor is stripped before parsing;
//   - the comparison is JavaScript strict equality: different JSON types differ, and
//     two non-scalar values are different references so they never compare equal;
//   - a mismatch changes NOTHING on disk and answers 400 {"error":"integrity"}.

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"strings"
)

// pinnedChatIntegrityErrorBody is the pinned 400 body for an integrity mismatch.
const pinnedChatIntegrityErrorBody = `{"error":"integrity"}`

// pinnedSaveInternalErrorBody is the pinned 500 body of both save handlers' catch.
const pinnedSaveInternalErrorBody = `{"error":"An error has occurred, see the console logs for more information."}`

// pinnedIntegritySlug returns `chatData?.[0]?.chat_metadata?.integrity` and whether
// that value is truthy (the only case in which pinned performs the check).
func pinnedIntegritySlug(chat orderedNodeJSON) (orderedNodeJSON, bool) {
	if chat.kind != 'a' || len(chat.array) == 0 {
		return orderedNodeJSON{kind: nodeUndefinedKind}, false
	}
	first := chat.array[0]
	if first.kind != 'o' {
		return orderedNodeJSON{kind: nodeUndefinedKind}, false
	}
	metadata, ok := first.member("chat_metadata")
	if !ok || metadata.kind != 'o' {
		return orderedNodeJSON{kind: nodeUndefinedKind}, false
	}
	integrity, ok := metadata.member("integrity")
	if !ok || !integrity.truthy() {
		return orderedNodeJSON{kind: nodeUndefinedKind}, false
	}
	return integrity, true
}

// pinnedBodyForceTruthy is `Boolean(request.body.force)` from the pinned handler.
// The value is whatever JSON the client sent: "false" and [] are truthy in
// JavaScript, while false, 0, "" and null are not.
func pinnedBodyForceTruthy(input map[string]json.RawMessage) bool {
	raw, exists := input["force"]
	if !exists {
		return false
	}
	value, err := decodeOrderedNodeJSON(raw)
	if err != nil {
		return false
	}
	return value.truthy()
}

// pinnedChatIntegrityMatches ports checkChatIntegrity. It answers whether the save
// may proceed. A read error (as opposed to a missing file) is returned so the caller
// answers pinned's 500 branch.
func pinnedChatIntegrityMatches(filePath string, slug orderedNodeJSON) (bool, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return true, nil
		}
		return false, err
	}
	if info.Size() == 0 {
		// An empty file loses nothing when overwritten.
		return true, nil
	}
	firstLine, err := pinnedReadFirstLine(filePath)
	if err != nil {
		return false, err
	}
	// An external editor may have added a UTF-8 BOM; pinned strips it before parsing.
	firstLine = strings.TrimPrefix(firstLine, "\ufeff")
	parsed, err := decodeOrderedNodeJSON([]byte(firstLine))
	if err != nil {
		// JSON.parse failed -> undefined -> "not a chat header": require confirmation.
		return false, nil
	}
	if parsed.kind != 'o' {
		// typeof jsonData !== 'object' || jsonData === null || Array.isArray(jsonData)
		return false, nil
	}
	metadata, ok := parsed.member("chat_metadata")
	if !ok || metadata.kind != 'o' {
		// `jsonData?.chat_metadata?.integrity` is undefined when chat_metadata is absent,
		// null or a non-object: legacy chats pass the check.
		return true, nil
	}
	integrity, ok := metadata.member("integrity")
	if !ok || !integrity.truthy() {
		return true, nil
	}
	return pinnedNodeStrictEqual(integrity, slug), nil
}

// pinnedNodeStrictEqual is JavaScript `===` for two JSON-decoded values. Non-scalar
// values are different object references after two separate parses and therefore
// never equal; numbers compare by value; strings by UTF-8 content; booleans and null
// by kind.
func pinnedNodeStrictEqual(left, right orderedNodeJSON) bool {
	if left.kind != right.kind {
		return false
	}
	switch left.kind {
	case 'n', nodeUndefinedKind:
		return true
	case 'b':
		return left.scalar == right.scalar
	case 'v':
		return left.scalar == right.scalar
	case 's':
		return left.scalar.(string) == right.scalar.(string)
	default:
		return false
	}
}

// pinnedReadFirstLine is util.js readFirstLine: a line ends at CR, LF or CRLF and the
// terminator is not part of the returned line. It reads only as far as the first line
// so a multi-hundred-megabyte chat file costs one line, like pinned's streaming read.
func pinnedReadFirstLine(filePath string) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, 64*1024)
	var line strings.Builder
	for {
		character, err := reader.ReadByte()
		if err != nil {
			if err == io.EOF {
				// The final line is unterminated; an empty file answers "".
				return line.String(), nil
			}
			return "", err
		}
		if character == '\n' {
			return line.String(), nil
		}
		if character == '\r' {
			// CRLF: consume the LF that belongs to the same terminator.
			if next, peekErr := reader.Peek(1); peekErr == nil && len(next) == 1 && next[0] == '\n' {
				_, _ = reader.ReadByte()
			}
			return line.String(), nil
		}
		line.WriteByte(character)
	}
}
