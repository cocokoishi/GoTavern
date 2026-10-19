package startup

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

// MigrateGroupChatsMetadataFormat moves deprecated group-level metadata into
// each chat's JSONL header and backs up every file before rewriting it.
func MigrateGroupChatsMetadataFormat(userDirectories []UserDirectories) ([]error, error) {
	var migrationErrors []error
	for _, directories := range userDirectories {
		root := directories["root"]
		groupsDirectory := directories["groups"]
		groupChatsDirectory := directories["groupChats"]
		backupsDirectory := directories["backups"]
		if root == "" || groupsDirectory == "" || groupChatsDirectory == "" || backupsDirectory == "" {
			migrationErrors = append(migrationErrors, errors.New("user directory set is missing root, groups, groupChats, or backups"))
			continue
		}
		lockRoot, err := canonicalPath(filepath.Dir(root))
		if err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("resolve group-metadata migration root: %w", err))
			continue
		}
		lock, err := acquireContentLock(lockRoot)
		if err != nil {
			migrationErrors = append(migrationErrors, err)
			continue
		}
		userErrors := migrateGroupMetadataForUser(groupsDirectory, groupChatsDirectory, backupsDirectory)
		migrationErrors = append(migrationErrors, userErrors...)
		_ = lock.Close()
	}
	return migrationErrors, nil
}

func migrateGroupMetadataForUser(groupsDirectory, groupChatsDirectory, backupsDirectory string) []error {
	groupFiles, err := os.ReadDir(groupsDirectory)
	if err != nil {
		return []error{fmt.Errorf("read groups directory %s: %w", groupsDirectory, err)}
	}
	groupChatFiles, err := os.ReadDir(groupChatsDirectory)
	if err != nil {
		return []error{fmt.Errorf("read group chats directory %s: %w", groupChatsDirectory, err)}
	}
	groupChatFileSet := make(map[string]struct{}, len(groupChatFiles))
	for _, entry := range groupChatFiles {
		if entry.Type().IsRegular() {
			groupChatFileSet[entry.Name()] = struct{}{}
		}
	}

	backupDirectory := filepath.Join(backupsDirectory, "_group_metadata_update")
	var migrationErrors []error
	for _, groupFile := range groupFiles {
		if !groupFile.Type().IsRegular() || filepath.Ext(groupFile.Name()) != ".json" {
			continue
		}
		groupPath := filepath.Join(groupsDirectory, groupFile.Name())
		groupBytes, err := os.ReadFile(groupPath)
		if err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("read group file %s: %w", groupFile.Name(), err))
			continue
		}
		groupData, err := decodeOrderedJSONObject(groupBytes)
		if err != nil {
			// tryParse() || {} in the pinned implementation leaves invalid JSON alone.
			groupData = &orderedJSONObject{}
		}
		_, hasChatMetadata := groupData.get("chat_metadata")
		_, hasPastMetadata := groupData.get("past_metadata")
		if !hasChatMetadata && !hasPastMetadata {
			continue
		}
		if err := os.MkdirAll(backupDirectory, 0o777); err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("create group-metadata backup directory: %w", err))
			continue
		}
		if err := copyGroupMigrationBackup(groupPath, filepath.Join(backupDirectory, groupFile.Name())); err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("back up group file %s: %w", groupFile.Name(), err))
			continue
		}

		allMetadata := groupMetadataForChats(groupData)
		chatsValue, hasChats := groupData.get("chats")
		chats, chatsAreArray := chatsValue.(orderedJSONArray)
		if !hasChats || !chatsAreArray {
			continue
		}

		for _, chatID := range chats {
			chatFileName := sanitizeGroupChatFileName(nodeString(chatID) + ".jsonl")
			if chatFileName == "" {
				continue
			}
			if _, exists := groupChatFileSet[chatFileName]; !exists {
				continue
			}
			chatPath := filepath.Join(groupChatsDirectory, chatFileName)
			chatBytes, err := os.ReadFile(chatPath)
			if err != nil {
				migrationErrors = append(migrationErrors, fmt.Errorf("read group chat %s: %w", nodeString(chatID), err))
				continue
			}
			chatData := parseGroupChatJSONL(chatBytes)
			if len(chatData) > 0 && orderedObjectHasOwn(chatData[0], "chat_metadata") {
				continue
			}
			if err := copyGroupMigrationBackup(chatPath, filepath.Join(backupDirectory, chatFileName)); err != nil {
				migrationErrors = append(migrationErrors, fmt.Errorf("back up group chat %s: %w", nodeString(chatID), err))
				continue
			}
			chatKey := nodeString(chatID)
			chatMetadata, exists := allMetadata.get(chatKey)
			if !exists || !groupMetadataTruthy(chatMetadata) {
				chatMetadata = &orderedJSONObject{}
			}
			chatHeader := &orderedJSONObject{members: []orderedJSONMember{
				{key: "chat_metadata", value: chatMetadata},
				{key: "user_name", value: nodeJSONString("unused")},
				{key: "character_name", value: nodeJSONString("unused")},
			}}
			newChatData := make(orderedJSONArray, 0, len(chatData)+1)
			newChatData = append(newChatData, chatHeader)
			newChatData = append(newChatData, chatData...)
			chatBytes, err = marshalGroupChatJSONL(newChatData)
			if err != nil {
				migrationErrors = append(migrationErrors, fmt.Errorf("serialize group chat %s: %w", nodeString(chatID), err))
				continue
			}
			if err := atomicReplace(chatPath, chatBytes); err != nil {
				migrationErrors = append(migrationErrors, fmt.Errorf("write group chat %s: %w", nodeString(chatID), err))
			}
		}

		groupData.delete("chat_metadata")
		groupData.delete("past_metadata")
		migratedGroupBytes, err := marshalNodeJSONIndent(groupData)
		if err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("serialize group file %s: %w", groupFile.Name(), err))
			continue
		}
		if err := atomicReplace(groupPath, migratedGroupBytes); err != nil {
			migrationErrors = append(migrationErrors, fmt.Errorf("write group file %s: %w", groupFile.Name(), err))
		}
	}
	return migrationErrors
}

func groupMetadataForChats(groupData *orderedJSONObject) *orderedJSONObject {
	allMetadata := &orderedJSONObject{}
	if pastMetadata, exists := groupData.get("past_metadata"); exists && groupMetadataTruthy(pastMetadata) {
		switch past := pastMetadata.(type) {
		case *orderedJSONObject:
			for _, member := range past.members {
				allMetadata.set(member.key, member.value)
			}
		case orderedJSONArray:
			for index, value := range past {
				allMetadata.set(strconv.Itoa(index), value)
			}
		case nodeJSONString:
			for index, value := range []rune(string(past)) {
				allMetadata.set(strconv.Itoa(index), nodeJSONString(string(value)))
			}
		}
	}
	chatID, hasChatID := groupData.get("chat_id")
	chatKey := "undefined"
	if hasChatID {
		chatKey = nodeString(chatID)
	}
	chatMetadata, exists := groupData.get("chat_metadata")
	if !exists || !groupMetadataTruthy(chatMetadata) {
		chatMetadata = &orderedJSONObject{}
	}
	allMetadata.set(chatKey, chatMetadata)
	return allMetadata
}

func parseGroupChatJSONL(body []byte) []any {
	lines := strings.Split(string(body), "\n")
	result := make([]any, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		value, err := decodeOrderedJSON([]byte(line))
		if err != nil || !groupMetadataTruthy(value) {
			continue
		}
		result = append(result, value)
	}
	return result
}

func orderedObjectHasOwn(value any, key string) bool {
	object, ok := value.(*orderedJSONObject)
	if !ok {
		return false
	}
	_, exists := object.get(key)
	return exists
}

func marshalGroupChatJSONL(values orderedJSONArray) ([]byte, error) {
	lines := make([]string, len(values))
	for index, value := range values {
		encoded, err := marshalNodeJSONCompact(value)
		if err != nil {
			return nil, err
		}
		lines[index] = string(encoded)
	}
	return []byte(strings.Join(lines, "\n")), nil
}

func copyGroupMigrationBackup(source, destination string) error {
	body, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o777); err != nil {
		return err
	}
	return atomicReplace(destination, body)
}

func sanitizeGroupChatFileName(value string) string {
	var result strings.Builder
	for _, character := range value {
		if character < 0x20 || strings.ContainsRune(`<>:"/\\|?*`, character) {
			continue
		}
		result.WriteRune(character)
	}
	name := strings.TrimRight(result.String(), ". ")
	if name == "" || name == "." || name == ".." {
		return ""
	}
	base := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
	switch base {
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		name = "_" + name
	}
	for len(name) > 255 {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	return name
}

func groupMetadataTruthy(value any) bool {
	switch typed := value.(type) {
	case nodeJSONString:
		return typed != ""
	case nodeJSONNumber:
		number := float64(typed)
		return number != 0
	default:
		return nodeTruthy(value)
	}
}
