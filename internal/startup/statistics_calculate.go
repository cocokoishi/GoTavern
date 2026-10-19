package startup

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type characterStatisticsEntry struct {
	item  string
	stats characterStatistics
}

type characterStatistics struct {
	totalGenTime        float64
	userWordCount       int64
	nonUserWordCount    int64
	userMessageCount    int64
	nonUserMessageCount int64
	totalSwipeCount     int64
	chatSize            int64
	dateLastChat        int64
	dateFirstChat       int64
}

type chatMessageStatistics struct {
	totalGenTime        float64
	userWordCount       int64
	nonUserWordCount    int64
	userMessageCount    int64
	nonUserMessageCount int64
	totalSwipeCount     int64
	firstChatTime       int64
}

var (
	statisticsWordPattern      = regexp.MustCompile(`\b\w+\b`)
	statisticsDigitPattern     = regexp.MustCompile(`^\d+$`)
	statisticsISODatePattern   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$`)
	statisticsMeridiemPattern  = regexp.MustCompile(`(?i)([a-z]+)\s(\d{1,2}),\s(\d{4})\s(\d{1,2}):(\d{1,2})(am|pm)`)
	statisticsHumanizedPattern = regexp.MustCompile(`(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s(\d{1,3})ms`)
	statisticsHumanizedShort   = regexp.MustCompile(`(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s`)
	statisticsHumanizedSpaced  = regexp.MustCompile(`(\d{4})-(\d{1,2})-(\d{1,2}) @(\d{1,2})h (\d{1,2})m (\d{1,2})s (\d{1,3})ms`)
)

var statisticsMonths = map[string]time.Month{
	"january": time.January, "february": time.February, "march": time.March,
	"april": time.April, "may": time.May, "june": time.June,
	"july": time.July, "august": time.August, "september": time.September,
	"october": time.October, "november": time.November, "december": time.December,
}

func calculateCharacterStatistics(chatsDirectory, characterItem string) (characterStatistics, error) {
	stats := characterStatistics{dateFirstChat: statisticsFirstChatTime}
	characterName := strings.Replace(characterItem, ".png", "", 1)
	chatDirectory := filepath.Join(chatsDirectory, characterName)
	chatInfo, err := os.Stat(chatDirectory)
	if errors.Is(err, fs.ErrNotExist) {
		return stats, nil
	}
	if err != nil {
		// The pinned existsSync(chatDirectory) treats inaccessible paths as absent.
		return stats, nil
	}
	if !chatInfo.IsDir() {
		return stats, fmt.Errorf("character chat path %s is not a directory", characterName)
	}
	chats, err := readDirectoryInNativeOrder(chatDirectory)
	if err != nil {
		return stats, err
	}
	uniqueMessages := make(map[[32]byte]struct{})
	for _, chat := range chats {
		chatPath := filepath.Join(chatDirectory, chat.Name())
		chatBody, readErr := os.ReadFile(chatPath)
		chatResult := chatMessageStatistics{firstChatTime: statisticsFirstChatTime}
		if readErr == nil {
			chatResult = calculateChatMessageStatistics(string(chatBody), uniqueMessages)
		}
		chatInfo, err := os.Stat(chatPath)
		if err != nil {
			return stats, fmt.Errorf("inspect chat entry %s: %w", chat.Name(), err)
		}
		if !math.IsNaN(chatResult.totalGenTime) {
			stats.totalGenTime += chatResult.totalGenTime
		}
		stats.userWordCount += chatResult.userWordCount
		stats.nonUserWordCount += chatResult.nonUserWordCount
		stats.userMessageCount += chatResult.userMessageCount
		stats.nonUserMessageCount += chatResult.nonUserMessageCount
		stats.totalSwipeCount += chatResult.totalSwipeCount
		stats.chatSize += chatInfo.Size()
		lastChat := int64(math.Floor(float64(chatInfo.ModTime().UnixNano()) / float64(time.Millisecond)))
		if lastChat > stats.dateLastChat {
			stats.dateLastChat = lastChat
		}
		if chatResult.firstChatTime < stats.dateFirstChat {
			stats.dateFirstChat = chatResult.firstChatTime
		}
	}
	return stats, nil
}

func calculateChatMessageStatistics(body string, uniqueMessages map[[32]byte]struct{}) chatMessageStatistics {
	stats := chatMessageStatistics{firstChatTime: statisticsFirstChatTime}
	for _, line := range strings.Split(body, "\n") {
		if line == "" {
			continue
		}
		var message map[string]any
		if err := json.Unmarshal([]byte(line), &message); err != nil || message == nil {
			continue
		}

		mes := message["mes"]
		if statisticsTruthy(mes) {
			text, ok := mes.(string)
			if !ok {
				// crypto.Hash.update throws for truthy non-string values; the
				// pinned line-level catch skips the rest of this message.
				continue
			}
			hash := sha256.Sum256([]byte(text))
			if _, exists := uniqueMessages[hash]; exists {
				continue
			}
			uniqueMessages[hash] = struct{}{}
		}

		isUser := statisticsTruthy(message["is_user"])
		if statisticsTruthy(message["gen_started"]) && statisticsTruthy(message["gen_finished"]) {
			genTime, valid := statisticsGenerationDuration(message["gen_started"], message["gen_finished"])
			if valid {
				stats.totalGenTime += genTime
			} else {
				stats.totalGenTime = math.NaN()
			}
			if statisticsTruthy(message["swipes"]) && !statisticsTruthy(message["swipe_info"]) {
				if swipes, ok := message["swipes"].([]any); ok {
					if valid {
						stats.totalGenTime += genTime * float64(len(swipes))
					} else {
						stats.totalGenTime = math.NaN()
					}
				} else {
					stats.totalGenTime = math.NaN()
				}
			}
		}

		if statisticsTruthy(mes) {
			text := mes.(string)
			wordCount := int64(len(statisticsWordPattern.FindAllStringIndex(text, -1)))
			if isUser {
				stats.userWordCount += wordCount
				stats.userMessageCount++
			} else {
				stats.nonUserWordCount += wordCount
				stats.nonUserMessageCount++
			}
		}

		if statisticsTruthy(message["swipes"]) {
			if swipes, ok := message["swipes"].([]any); ok && len(swipes) > 1 {
				stats.totalSwipeCount += int64(len(swipes) - 1)
				lineFailed := false
				for _, swipe := range swipes[1:] {
					text, ok := swipe.(string)
					if !ok {
						// countWordsInString throws and the line-level catch leaves
						// metrics accumulated earlier in the line intact.
						lineFailed = true
						break
					}
					wordCount := int64(len(statisticsWordPattern.FindAllStringIndex(text, -1)))
					if isUser {
						stats.userWordCount += wordCount
						stats.userMessageCount++
					} else {
						stats.nonUserWordCount += wordCount
						stats.nonUserMessageCount++
					}
				}
				if lineFailed {
					continue
				}
			}
		}

		if statisticsTruthy(message["swipe_info"]) {
			if swipes, ok := message["swipe_info"].([]any); ok && len(swipes) > 1 {
				lineFailed := false
				for _, item := range swipes[1:] {
					swipe, ok := item.(map[string]any)
					if !ok {
						lineFailed = true
						break
					}
					if statisticsTruthy(swipe["gen_started"]) && statisticsTruthy(swipe["gen_finished"]) {
						genTime, valid := statisticsGenerationDuration(swipe["gen_started"], swipe["gen_finished"])
						if valid {
							stats.totalGenTime += genTime
						} else {
							stats.totalGenTime = math.NaN()
						}
					}
				}
				if lineFailed {
					continue
				}
			}
		}

		if isUser {
			firstChatTime := statisticsParseTimestamp(message["send_date"])
			if firstChatTime < stats.firstChatTime {
				stats.firstChatTime = firstChatTime
			}
		}
	}
	return stats
}

func statisticsTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0 && !math.IsNaN(typed)
	default:
		return true
	}
}

func statisticsGenerationDuration(start, finish any) (float64, bool) {
	startMillis, startOK := statisticsDateMillis(start)
	finishMillis, finishOK := statisticsDateMillis(finish)
	if !startOK || !finishOK {
		return 0, false
	}
	return finishMillis - startMillis, true
}

func statisticsDateMillis(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if !finite(typed) || math.Abs(typed) > 8.64e15 {
			return 0, false
		}
		return math.Trunc(typed), true
	case string:
		if timestamp, ok := statisticsParseDateString(typed); ok {
			return timestamp, true
		}
	}
	return 0, false
}

func statisticsParseTimestamp(value any) int64 {
	if !statisticsTruthy(value) {
		return 0
	}
	switch typed := value.(type) {
	case float64:
		if !finite(typed) || typed < 0 || typed > 8.64e15 {
			return 0
		}
		return int64(math.Trunc(typed))
	case string:
		if statisticsDigitPattern.MatchString(typed) {
			numeric, err := strconv.ParseFloat(typed, 64)
			if err == nil && finite(numeric) && numeric >= 0 && numeric <= 8.64e15 {
				return int64(math.Trunc(numeric))
			}
			return 0
		}
		if !statisticsISODatePattern.MatchString(typed) {
			return parseStatisticsHumanDate(typed)
		}
		millis, ok := statisticsParseDateString(typed)
		if ok && millis >= 0 {
			return int64(millis)
		}
	}
	return 0
}

func statisticsParseDateString(value string) (float64, bool) {
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return float64(parsed.UnixMilli()), true
	}
	if millis := parseStatisticsHumanDate(value); millis != 0 {
		return float64(millis), true
	}
	return 0, false
}

func parseStatisticsHumanDate(value string) int64 {
	if matches := statisticsMeridiemPattern.FindStringSubmatch(value); matches != nil {
		month, exists := statisticsMonths[strings.ToLower(matches[1])]
		if !exists {
			return 0
		}
		year, _ := strconv.Atoi(matches[3])
		day, _ := strconv.Atoi(matches[2])
		hour, _ := strconv.Atoi(matches[4])
		minute, _ := strconv.Atoi(matches[5])
		if strings.EqualFold(matches[6], "pm") {
			hour = hour%12 + 12
		} else {
			hour %= 12
		}
		return time.Date(year, month, day, hour, minute, 0, 0, time.Local).UnixMilli()
	}
	for _, pattern := range []*regexp.Regexp{statisticsHumanizedPattern, statisticsHumanizedShort, statisticsHumanizedSpaced} {
		if matches := pattern.FindStringSubmatch(value); matches != nil {
			year, _ := strconv.Atoi(matches[1])
			month, _ := strconv.Atoi(matches[2])
			day, _ := strconv.Atoi(matches[3])
			hour, _ := strconv.Atoi(matches[4])
			minute, _ := strconv.Atoi(matches[5])
			second, _ := strconv.Atoi(matches[6])
			millisecond := 0
			if len(matches) > 7 {
				millisecond, _ = strconv.Atoi(matches[7])
				for len(matches[7]) < 3 {
					millisecond *= 10
					matches[7] += "0"
				}
			}
			return time.Date(year, time.Month(month), day, hour, minute, second, millisecond*int(time.Millisecond), time.UTC).UnixMilli()
		}
	}
	return 0
}

func finite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}
