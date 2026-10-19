package startup

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	statisticsFilename      = "stats.json"
	statisticsFirstChatTime = int64(253402300799999)
)

// StatisticsInitialization captures the values loaded or recreated by the
// pinned stats.init() startup hook. Errors stop later users, matching its
// outer catch. Periodic saving and chat-history recalculation with entries
// are deliberately left to the runtime integration layer.
type StatisticsInitialization struct {
	Values map[string]json.RawMessage
	Errors []error
}

// InitializeStatistics loads valid per-user stats.json files. Missing or
// invalid files are recreated when each character has no chat entries.
func InitializeStatistics(directoriesList []UserDirectories, now time.Time) StatisticsInitialization {
	result := StatisticsInitialization{Values: make(map[string]json.RawMessage)}
	if now.IsZero() {
		now = time.Now()
	}
	for _, directories := range directoriesList {
		handle := filepath.Base(directories["root"])
		value, err := initializeUserStatistics(directories, now)
		if err != nil {
			result.Errors = append(result.Errors, err)
			break
		}
		result.Values[handle] = value
	}
	return result
}

func initializeUserStatistics(directories UserDirectories, now time.Time) (json.RawMessage, error) {
	userRoot := directories["root"]
	charactersDirectory := directories["characters"]
	chatsDirectory := directories["chats"]
	if userRoot == "" || charactersDirectory == "" || chatsDirectory == "" {
		return nil, errors.New("user directory set is missing root, characters, or chats")
	}
	absoluteUserRoot, err := filepath.Abs(userRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve statistics user root: %w", err)
	}
	lockRoot, err := canonicalPath(filepath.Dir(absoluteUserRoot))
	if err != nil {
		return nil, fmt.Errorf("resolve statistics lock root: %w", err)
	}
	lock, err := acquireContentLock(lockRoot)
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	resolvedUserRoot, err := canonicalPath(absoluteUserRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve statistics user root: %w", err)
	}
	if err := ensureContained(lockRoot, resolvedUserRoot); err != nil {
		return nil, fmt.Errorf("statistics user root escapes data root: %w", err)
	}

	statsPath := filepath.Join(absoluteUserRoot, statisticsFilename)
	if err := ensureResolvedContained(absoluteUserRoot, statsPath); err != nil {
		return nil, fmt.Errorf("statistics file escapes user root: %w", err)
	}
	body, readErr := os.ReadFile(statsPath)
	if readErr == nil && json.Valid(body) {
		return append(json.RawMessage(nil), body...), nil
	}
	if readErr != nil && !errors.Is(readErr, fs.ErrNotExist) {
		return nil, fmt.Errorf("read statistics file for %s: %w", filepath.Base(absoluteUserRoot), readErr)
	}

	absoluteCharactersDirectory, err := filepath.Abs(charactersDirectory)
	if err != nil {
		return nil, fmt.Errorf("resolve character directory: %w", err)
	}
	if err := ensureResolvedContained(absoluteUserRoot, absoluteCharactersDirectory); err != nil {
		return nil, fmt.Errorf("character directory escapes user root: %w", err)
	}
	characterEntries, err := readDirectoryInNativeOrder(absoluteCharactersDirectory)
	if err != nil {
		return nil, fmt.Errorf("read character directory for %s: %w", filepath.Base(absoluteUserRoot), err)
	}
	characterNames := make([]string, 0)
	for _, entry := range characterEntries {
		if !strings.HasSuffix(entry.Name(), ".png") {
			continue
		}
		characterName := strings.Replace(entry.Name(), ".png", "", 1)
		chatPath := filepath.Join(chatsDirectory, characterName)
		if err := ensureResolvedContained(absoluteUserRoot, chatPath); err != nil {
			return nil, fmt.Errorf("character chat directory escapes user root: %w", err)
		}
		chatInfo, err := os.Stat(chatPath)
		if errors.Is(err, fs.ErrNotExist) {
			characterNames = append(characterNames, entry.Name())
			continue
		}
		if err != nil {
			// The pinned existsSync(chatPath) treats inaccessible paths as absent.
			characterNames = append(characterNames, entry.Name())
			continue
		}
		if !chatInfo.IsDir() {
			return nil, fmt.Errorf("inspect character chat directory %s: not a directory", characterName)
		}
		chatEntries, err := readDirectoryInNativeOrder(chatPath)
		if err != nil {
			return nil, fmt.Errorf("read chat directory for %s: %w", characterName, err)
		}
		if len(chatEntries) > 0 {
			return nil, fmt.Errorf("recreate statistics for %s: chat-history aggregation is not implemented", characterName)
		}
		characterNames = append(characterNames, entry.Name())
	}

	body, err = emptyChatStatistics(characterNames, now.UnixMilli())
	if err != nil {
		return nil, fmt.Errorf("serialize statistics for %s: %w", filepath.Base(absoluteUserRoot), err)
	}
	if err := ensureResolvedContained(absoluteUserRoot, statsPath); err != nil {
		return nil, fmt.Errorf("statistics file escapes user root: %w", err)
	}
	if err := atomicReplace(statsPath, body); err != nil {
		return nil, fmt.Errorf("write statistics file for %s: %w", filepath.Base(absoluteUserRoot), err)
	}
	return json.RawMessage(body), nil
}

func emptyChatStatistics(characterNames []string, timestamp int64) ([]byte, error) {
	var body bytes.Buffer
	body.WriteByte('{')
	seen := make(map[string]int, len(characterNames))
	uniqueNames := make([]string, 0, len(characterNames))
	for _, name := range characterNames {
		if index, exists := seen[name]; exists {
			uniqueNames[index] = name
			continue
		}
		seen[name] = len(uniqueNames)
		uniqueNames = append(uniqueNames, name)
	}
	for index, name := range uniqueNames {
		if index > 0 {
			body.WriteByte(',')
		}
		encodedName, err := json.Marshal(name)
		if err != nil {
			return nil, err
		}
		body.Write(encodedName)
		fmt.Fprintf(&body, `:{"total_gen_time":0,"user_word_count":0,"non_user_word_count":0,"user_msg_count":0,"non_user_msg_count":0,"total_swipe_count":0,"chat_size":0,"date_last_chat":0,"date_first_chat":%d}`, statisticsFirstChatTime)
	}
	if len(uniqueNames) > 0 {
		body.WriteByte(',')
	}
	body.WriteString(`"timestamp":`)
	fmt.Fprintf(&body, "%d}", timestamp)
	return body.Bytes(), nil
}
