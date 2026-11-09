package server

// Pinned read routes: /api/characters/all, /get and /chats.

import (
	"errors"
	"github.com/cocokoishi/gotavern/internal/httpx"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// forbiddenAvatarRegExp mirrors middleware/validateFileName.js forbiddenRegExp.
func forbiddenAvatarRegExp(value string) bool {
	if strings.ContainsRune(value, '/') || strings.ContainsRune(value, 0) {
		return true
	}
	return filepath.Separator == '\\' && strings.ContainsRune(value, '\\')
}

// hasJavaScriptToString mirrors validateFileName.js hasToString for JSON values:
// every value except null and undefined inherits Object.prototype.toString.
func hasJavaScriptToString(value orderedNodeJSON) bool {
	return value.kind != 'n' && value.kind != nodeUndefinedKind
}

// validateCharactersFilenameField mirrors getFileNameValidationFunction: a
// forbidden character in the field is answered with a bare 400 before the
// handler runs.
func validateCharactersFilenameField(w http.ResponseWriter, body orderedNodeJSON, fieldName string) bool {
	value, exists := body.member(fieldName)
	if !exists || !hasJavaScriptToString(value) {
		return true
	}
	text, err := characterString(value)
	if err != nil {
		httpx.WriteStatusText(w, http.StatusInternalServerError)
		return false
	}
	if forbiddenAvatarRegExp(text) {
		httpx.WriteStatusText(w, http.StatusBadRequest)
		return false
	}
	return true
}

func errorTrueObject() orderedNodeJSON {
	result := nodeObject()
	result.setMember("error", nodeBool(true))
	return result
}

func (runtime *accountRuntime) serveCharactersAll(w http.ResponseWriter, request *http.Request, lazyLoadCharacters bool) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	directories, ok := runtime.charactersDirectories(account)
	if !ok {
		serveCharactersOverflow(w, false)
		return
	}
	entries, err := os.ReadDir(directories["characters"])
	if err != nil {
		serveCharactersOverflow(w, false)
		return
	}
	characters := make([]orderedNodeJSON, 0, len(entries))
	// The response repeats each card's text as `json_data` and again as the projected fields, so the card text
	// length is a direct lower bound on that card's contribution. Measured bodies: 10,000 cards / 2 KB text =
	// 58,887,196 B (2.88x the text), 1,000 cards / 8 KB text = 23,296,711 B (2.84x), 100 cards / 8 KB text =
	// 2,329,662 B (2.84x). `3*len + 512` therefore reserves ~5-8% above the measured bodies, which removes
	// bytes.Buffer's geometric growth (the largest single allocation line in the warm profile) without a
	// pathological over-reserve; a card whose text escapes more than 3x still grows correctly (the estimate is
	// a capacity hint only and CANNOT change emitted bytes).
	estimatedBodyBytes := 0
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".png") {
			continue
		}
		character := processCharacterForDirEntry(entry, directories, lazyLoadCharacters)
		if jsTruthy(nodeGet(character, "name")) {
			characters = append(characters, character)
			cardTextBytes := 0
			if cardText, isString := nodeGet(character, "json_data").stringValue(); isString {
				cardTextBytes = len(cardText)
			}
			estimatedBodyBytes += 3*cardTextBytes + 512
		}
	}
	body, err := marshalCharacterJSONPreallocated(nodeArray(characters...), estimatedBodyBytes)
	if err != nil {
		serveCharactersOverflow(w, errors.Is(err, errJavaScriptRange))
		return
	}
	if len(body) > maxJavaScriptStringLength {
		serveCharactersOverflow(w, true)
		return
	}
	writeCharacterJSONBody(w, http.StatusOK, body)
}

func (runtime *accountRuntime) serveCharactersGet(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	parsed, err := runtime.readCharactersRequest(request)
	if err != nil {
		httpx.WriteStatusText(w, http.StatusBadRequest)
		return
	}
	body := parsed.body
	if !validateCharactersFilenameField(w, body, "avatar_url") {
		return
	}
	directories, ok := runtime.charactersDirectories(account)
	if !ok {
		httpx.WriteStatusText(w, http.StatusInternalServerError)
		return
	}
	item, isString := nodeGet(body, "avatar_url").stringValue()
	if !isString {
		// path.join throws when the avatar is not a string.
		httpx.WriteStatusText(w, http.StatusInternalServerError)
		return
	}
	filePath := filepath.Join(directories["characters"], item)
	if _, err := os.Stat(filePath); err != nil {
		httpx.WriteStatusText(w, http.StatusNotFound)
		return
	}
	respondCharacterJSON(w, http.StatusOK, processCharacter(item, directories, false))
}

func (runtime *accountRuntime) serveCharactersChats(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	parsed, err := runtime.readCharactersRequest(request)
	if err != nil {
		httpx.WriteStatusText(w, http.StatusBadRequest)
		return
	}
	body := parsed.body
	if !validateCharactersFilenameField(w, body, "avatar_url") {
		return
	}
	directories, ok := runtime.charactersDirectories(account)
	if !ok {
		respondCharacterJSON(w, http.StatusOK, errorTrueObject())
		return
	}
	avatar, isString := nodeGet(body, "avatar_url").stringValue()
	if !isString {
		// String.prototype.replace throws for a non-string avatar.
		respondCharacterJSON(w, http.StatusOK, errorTrueObject())
		return
	}
	characterDirectory := strings.Replace(avatar, ".png", "", 1)
	chatsDirectory := filepath.Join(directories["chats"], characterDirectory)
	if _, err := os.Stat(chatsDirectory); err != nil {
		respondCharacterJSON(w, http.StatusOK, errorTrueObject())
		return
	}
	entries, err := os.ReadDir(chatsDirectory)
	if err != nil {
		respondCharacterJSON(w, http.StatusOK, errorTrueObject())
		return
	}
	jsonFiles := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		if nodePathExt(entry.Name()) != ".jsonl" {
			continue
		}
		jsonFiles = append(jsonFiles, entry.Name())
	}
	if len(jsonFiles) == 0 {
		respondCharacterJSON(w, http.StatusOK, nodeArray())
		return
	}
	if jsTruthy(nodeGet(body, "simple")) {
		items := make([]orderedNodeJSON, 0, len(jsonFiles))
		for _, file := range jsonFiles {
			item := nodeObject()
			item.setMember("file_name", nodeString(file))
			item.setMember("file_id", nodeString(strings.TrimSuffix(file, nodePathExt(file))))
			items = append(items, item)
		}
		respondCharacterJSON(w, http.StatusOK, nodeArray(items...))
		return
	}
	withMetadata := jsTruthy(nodeGet(body, "metadata"))
	items := make([]orderedNodeJSON, 0, len(jsonFiles))
	for _, file := range jsonFiles {
		info := getChatInfo(filepath.Join(chatsDirectory, file), withMetadata)
		if jsTruthy(nodeGet(info, "file_name")) {
			items = append(items, info)
		}
	}
	respondCharacterJSON(w, http.StatusOK, nodeArray(items...))
}

func chatVanishedObject() orderedNodeJSON {
	result := nodeObject()
	result.setMember("match", nodeBool(false))
	return result
}

// getChatInfo mirrors pinned endpoints/chats.js getChatInfo.
//
// The file is read SEQUENTIALLY by scanChatSummary (chatsummary.go), which is the one shared implementation of
// pinned's readline semantics; this function only assembles the pinned result object. It used to os.ReadFile the
// whole chat and split it into a []string to look at the last line -- ~19.5 MB of transient allocation and ~28k
// allocations for a 3.4 MB chat (internal/server/chatsummary_bench_test.go records the before/after).
func getChatInfo(pathToFile string, withMetadata bool) orderedNodeJSON {
	summary, err := scanChatSummary(pathToFile, withMetadata, nil)
	if err != nil || summary.vanished {
		// pinned's stat/read ENOENT is `chatVanished`; any other read error propagates as an error there, but this
		// route has always answered the vanished object for every error and that answer is what the oracle fixes.
		return chatVanishedObject()
	}
	chatData := newChatSummaryData(pathToFile, summary)
	if summary.size == 0 {
		return chatData
	}
	applyChatSummaryMetadata(&chatData, summary)
	if finishChatSummary(&chatData, summary) {
		// pinned: `chatData.match = hasMatcher ? hasAnyMatch : true`; this route passes no matcher.
		chatData.setMember("match", nodeBool(true))
	}
	return chatData
}

// splitReadlineLines mirrors Node's readline line splitting: \n, \r and \r\n
// terminate a line, and a trailing terminator does not produce an empty line.
func splitReadlineLines(contents string) []string {
	lines := make([]string, 0, 8)
	var current strings.Builder
	for index := 0; index < len(contents); index++ {
		switch contents[index] {
		case '\n':
			lines = append(lines, current.String())
			current.Reset()
		case '\r':
			lines = append(lines, current.String())
			current.Reset()
			if index+1 < len(contents) && contents[index+1] == '\n' {
				index++
			}
		default:
			current.WriteByte(contents[index])
		}
	}
	if current.Len() > 0 {
		lines = append(lines, current.String())
	}
	return lines
}

// formatBytes mirrors the pinned `bytes` package default formatting.
func formatBytes(numBytes int64) string {
	magnitude := math.Abs(float64(numBytes))
	units := []struct {
		threshold float64
		divisor   float64
		label     string
	}{
		{math.Pow(1024, 5), math.Pow(1024, 5), "PB"},
		{math.Pow(1024, 4), math.Pow(1024, 4), "TB"},
		{math.Pow(1024, 3), math.Pow(1024, 3), "GB"},
		{1024 * 1024, 1024 * 1024, "MB"},
		{1024, 1024, "KB"},
	}
	divisor := 1.0
	label := "B"
	for _, unit := range units {
		if magnitude >= unit.threshold {
			divisor = unit.divisor
			label = unit.label
			break
		}
	}
	value := strconv.FormatFloat(float64(numBytes)/divisor, 'f', 2, 64)
	if dot := strings.IndexByte(value, '.'); dot >= 0 {
		decimals := value[dot+1:]
		if strings.Trim(decimals, "0") == "" {
			value = value[:dot]
		} else {
			value = value[:dot+1] + strings.TrimRight(decimals, "0")
		}
	}
	return value + label
}

// nodePathExt mirrors Node's path.extname: a leading dot on the basename does
// not start an extension.
func nodePathExt(name string) string {
	index := strings.LastIndexByte(name, '.')
	if index <= 0 {
		return ""
	}
	return name[index:]
}
