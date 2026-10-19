package startup

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	statisticsFilename      = "stats.json"
	statisticsFirstChatTime = int64(253402300799999)
)

// StatisticsInitialization captures the values loaded or recreated by the
// pinned stats.init() startup hook. Errors stop later users, matching its
// outer catch. Periodic saving remains part of the runtime integration layer.
type StatisticsInitialization struct {
	Values map[string]json.RawMessage
	Errors []error
}

// InitializeStatistics loads valid per-user stats.json files. Missing or
// invalid files are recreated from each character's chat files.
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
	characters := make([]characterStatisticsEntry, 0)
	for _, entry := range characterEntries {
		if !strings.HasSuffix(entry.Name(), ".png") {
			continue
		}
		characterName := strings.Replace(entry.Name(), ".png", "", 1)
		chatPath := filepath.Join(chatsDirectory, characterName)
		if err := ensureResolvedContained(absoluteUserRoot, chatPath); err != nil {
			return nil, fmt.Errorf("character chat directory escapes user root: %w", err)
		}
		characterStatistics, err := calculateCharacterStatistics(chatsDirectory, entry.Name())
		if err != nil {
			return nil, fmt.Errorf("calculate statistics for %s: %w", entry.Name(), err)
		}
		characters = append(characters, characterStatisticsEntry{item: entry.Name(), stats: characterStatistics})
	}

	body, err = marshalStatistics(characters, now.UnixMilli())
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

func marshalStatistics(characters []characterStatisticsEntry, timestamp int64) ([]byte, error) {
	var body bytes.Buffer
	body.WriteByte('{')
	seen := make(map[string]int, len(characters))
	uniqueCharacters := make([]characterStatisticsEntry, 0, len(characters))
	for _, character := range characters {
		if index, exists := seen[character.item]; exists {
			uniqueCharacters[index] = character
			continue
		}
		seen[character.item] = len(uniqueCharacters)
		uniqueCharacters = append(uniqueCharacters, character)
	}
	for index, character := range uniqueCharacters {
		if index > 0 {
			body.WriteByte(',')
		}
		encodedName, err := marshalStatisticsString(character.item)
		if err != nil {
			return nil, err
		}
		body.Write(encodedName)
		stats := character.stats
		fmt.Fprintf(&body, `:{"total_gen_time":%s,"user_word_count":%d,"non_user_word_count":%d,"user_msg_count":%d,"non_user_msg_count":%d,"total_swipe_count":%d,"chat_size":%d,"date_last_chat":%d,"date_first_chat":%d}`,
			strconv.FormatFloat(stats.totalGenTime, 'f', -1, 64),
			stats.userWordCount,
			stats.nonUserWordCount,
			stats.userMessageCount,
			stats.nonUserMessageCount,
			stats.totalSwipeCount,
			stats.chatSize,
			stats.dateLastChat,
			stats.dateFirstChat,
		)
	}
	if len(uniqueCharacters) > 0 {
		body.WriteByte(',')
	}
	body.WriteString(`"timestamp":`)
	fmt.Fprintf(&body, "%d}", timestamp)
	return body.Bytes(), nil
}

func marshalStatisticsString(value string) ([]byte, error) {
	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(body.Bytes(), []byte{'\n'}), nil
}
