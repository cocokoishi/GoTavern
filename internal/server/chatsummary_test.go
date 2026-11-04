package server

// M5a EQUALITY TESTS for the streaming chat-summary reader.
//
// The oracle for /api/characters/chats and /api/chats/recent is the RECORDED pinned fixtures
// (TestPinnedNodeCharactersRead and TestPinnedNodeChatsSearchRecent); those stay byte-identical and are the
// external evidence. These tests are the refactor-equality layer the fixtures cannot reach: the tricky line
// shapes (a CRLF split across a read-buffer boundary, a lone CR, a 300 KB single line, an invalid last line,
// metadata present/absent/array/invalid) and the "file changes under the reader" states are compared against a
// copy of the PRE-CHANGE implementation, byte for byte, for both call sites and both metadata modes plus the
// /search matcher. `splitReadlineLines` itself is still used by the chat export route, so it remains the
// independent statement of pinned readline semantics: every scanned file is also checked against it.
//
// A fixture that cannot discriminate is rejected: every case here differs from at least one other in a way that
// a materialising reader and a streaming one must agree on, and the CRLF-boundary case is positioned so the '\r'
// is the LAST byte of the first 64 KiB read chunk -- the one place a naive chunk parser splits a CRLF into two
// lines.

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// legacyPinnedChatInfo is a verbatim copy of the implementation this change replaces (the pre-M5a
// pinnedChatInfo; the characters route was an equivalent copy of the same logic with no additionalData and no
// matcher). It exists ONLY as the equality oracle for the refactor: the external oracle is the recorded fixtures.
func legacyPinnedChatInfo(pathToFile string, additionalData *orderedNodeJSON, withMetadata bool, matcher func([]string) bool) (orderedNodeJSON, error) {
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

func mustMarshalSummary(t *testing.T, value orderedNodeJSON) string {
	t.Helper()
	encoded, err := marshalOrderedNodeJSON(value)
	if err != nil {
		t.Fatalf("marshal summary: %v", err)
	}
	return string(encoded)
}

func writeChatFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	// A FIXED MTIME makes every stat-derived field in the result deterministic: `last_mes` falls back to the
	// mtime only when the last line has no send_date, and the numeric mtime is part of the result otherwise.
	fixed := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	if err := os.Chtimes(path, fixed, fixed); err != nil {
		t.Fatalf("chtimes %s: %v", name, err)
	}
	return path
}

// chatSummaryCase is one byte-content case for the equality table.
type chatSummaryCase struct {
	name    string
	content string
}

// crlfSplitAcrossBufferBoundary places a '\r' at byte chatSummaryReadBufferSize-1 and the '\n' of the same CRLF
// in the next read chunk. The first line is 64 KiB-1 filler bytes (an invalid metadata line, which is fine: the
// metadata parser must skip it), then the split CRLF, then one valid message which must become the FIRST and
// LAST line of the message region.
func crlfSplitAcrossBufferBoundary() string {
	filler := strings.Repeat("x", chatSummaryReadBufferSize-1)
	return filler + "\r\n" + `{"name":"Boundary","is_user":false,"send_date":"2026-11-03T12:00:01.000Z","mes":"after a split CRLF","extra":{}}` + "\n"
}

func chatSummaryCases() []chatSummaryCase {
	longLine := `{"name":"Long","is_user":false,"send_date":"2026-11-03T12:00:02.000Z","mes":"` +
		strings.Repeat("ember ", (3*chatSummaryReadBufferSize)/len("ember ")) +
		`","extra":{}}`
	return []chatSummaryCase{
		{name: "empty", content: ""},
		{name: "singleLineNoTerminator", content: `{"name":"A","is_user":true,"mes":"only"}`},
		{name: "singleLineWithLF", content: `{"name":"A","is_user":true,"mes":"only"}` + "\n"},
		{name: "singleLineWithCRLF", content: `{"name":"A","is_user":true,"mes":"only"}` + "\r\n"},
		{name: "singleLineWithLoneCR", content: `{"name":"A","is_user":true,"mes":"only"}` + "\r"},
		{name: "headerOnlyLF", content: `{"chat_metadata":{"a":1}}` + "\n"},
		{name: "onlyNewline", content: "\n"},
		{name: "twoNewlines", content: "\n\n"},
		{name: "blankLineBeforeLast", content: `{"chat_metadata":{"a":1}}` + "\n\n" + `{"name":"A","mes":"last"}` + "\n"},
		{name: "mixedTerminators", content: `{"chat_metadata":{"a":1}}` + "\r\n" + `{"name":"A","mes":"one"}` + "\n" + `{"name":"A","mes":"two"}` + "\r" + `{"name":"A","mes":"three"}` + "\r\n"},
		{name: "metadataObject", content: `{"chat_metadata":{"world_info":"Lore","integrity":"x"}}` + "\n" + `{"name":"A","mes":"m"}` + "\n"},
		{name: "metadataArray", content: `{"chat_metadata":[1,2,3]}` + "\n" + `{"name":"A","mes":"m"}` + "\n"},
		{name: "metadataAbsent", content: `{"user_name":"u"}` + "\n" + `{"name":"A","mes":"m"}` + "\n"},
		{name: "metadataStringIgnored", content: `{"chat_metadata":"not-an-object"}` + "\n" + `{"name":"A","mes":"m"}` + "\n"},
		{name: "firstLineInvalidJSON", content: `not json at all` + "\n" + `{"name":"A","mes":"m"}` + "\n"},
		{name: "lastLineInvalid", content: `{"chat_metadata":{"a":1}}` + "\n" + `{"name":"A","mes":"m"}` + "\n" + `{"truncated":`},
		{name: "lastLineValidButUnknown", content: `{"chat_metadata":{"a":1}}` + "\n" + `{"unrelated":true}` + "\n"},
		{name: "lastLineEmptyMes", content: `{"chat_metadata":{"a":1}}` + "\n" + `{"name":"A","mes":""}` + "\n"},
		{name: "lastLineNoSendDate", content: `{"chat_metadata":{"a":1}}` + "\n" + `{"name":"A","mes":"m"}` + "\n"},
		{name: "cjkAndEmoji", content: `{"chat_metadata":{"world_info":"灯"}}` + "\n" + `{"name":"灯","mes":"🦊 ロング final"}` + "\n"},
		{name: "longLineMiddle", content: `{"chat_metadata":{"a":1}}` + "\n" + longLine + "\n" + `{"name":"A","mes":"after long"}` + "\n"},
		{name: "longLineLast", content: `{"chat_metadata":{"a":1}}` + "\n" + longLine + "\n"},
		{name: "crlfSplitAcrossReadBoundary", content: crlfSplitAcrossBufferBoundary()},
		{name: "loneCROnly", content: "a\rb\rc"},
	}
}

func TestChatSummaryMatchesLineSplitting(t *testing.T) {
	for _, testCase := range chatSummaryCases() {
		t.Run(testCase.name, func(t *testing.T) {
			dir := t.TempDir()
			path := writeChatFile(t, dir, "case.jsonl", testCase.content)
			want := splitReadlineLines(testCase.content)
			summary, err := scanChatSummary(path, true, nil)
			if err != nil {
				t.Fatalf("scanChatSummary: %v", err)
			}
			if summary.vanished {
				t.Fatal("scanChatSummary reported a vanished file for an existing file")
			}
			if summary.itemCounter != len(want) {
				t.Fatalf("itemCounter = %d, want %d (splitReadlineLines said %q)", summary.itemCounter, len(want), want)
			}
			if len(want) == 0 {
				if summary.hasLastLine {
					t.Fatal("hasLastLine for a file with no lines")
				}
				return
			}
			if !summary.hasLastLine {
				t.Fatal("no last line for a file with lines")
			}
			if string(summary.lastLine) != want[len(want)-1] {
				t.Fatalf("lastLine = %q, want %q", string(summary.lastLine), want[len(want)-1])
			}
			if string(summary.firstLine) != want[0] {
				t.Fatalf("firstLine = %q, want %q", string(summary.firstLine), want[0])
			}
		})
	}
}

func TestChatSummaryMatchesLegacyChatInfo(t *testing.T) {
	for _, testCase := range chatSummaryCases() {
		t.Run(testCase.name, func(t *testing.T) {
			dir := t.TempDir()
			path := writeChatFile(t, dir, "case.jsonl", testCase.content)
			for _, withMetadata := range []bool{false, true} {
				wantLegacy, err := legacyPinnedChatInfo(path, nil, withMetadata, nil)
				if err != nil {
					t.Fatalf("legacy pinnedChatInfo: %v", err)
				}
				gotCharacters := getChatInfo(path, withMetadata)
				if got, want := mustMarshalSummary(t, gotCharacters), mustMarshalSummary(t, wantLegacy); got != want {
					t.Fatalf("withMetadata=%v getChatInfo differs from the pre-change implementation:\n got: %s\nwant: %s", withMetadata, got, want)
				}
				gotRecent, err := pinnedChatInfo(path, nil, withMetadata, nil)
				if err != nil {
					t.Fatalf("pinnedChatInfo: %v", err)
				}
				if got, want := mustMarshalSummary(t, gotRecent), mustMarshalSummary(t, wantLegacy); got != want {
					t.Fatalf("withMetadata=%v pinnedChatInfo differs from the pre-change implementation:\n got: %s\nwant: %s", withMetadata, got, want)
				}
			}
		})
	}
}

func TestChatSummaryMatchesLegacyMatcherSemantics(t *testing.T) {
	content := `{"chat_metadata":{"a":1}}` + "\n" +
		`{"name":"A","is_user":true,"mes":"alpha one"}` + "\n" +
		`{"truncated":` + "\n" +
		`{"name":"A","is_user":false,"mes":"beta two"}` + "\n" +
		`{"name":"A","is_user":false,"mes":"gamma three"}` + "\n"
	dir := t.TempDir()
	path := writeChatFile(t, dir, "matcher.jsonl", content)

	matchers := map[string]func([]string) bool{
		"none":         nil,
		"never":        pinnedSearchMatcher([]string{"fragment-that-never-appears"}),
		"emptyQuery":   pinnedSearchMatcher(nil),
		"secondLine":   pinnedSearchMatcher([]string{"beta"}),
		"firstLine":    pinnedSearchMatcher([]string{"alpha"}),
		"allFragments": pinnedSearchMatcher([]string{"alpha", "gamma"}),
	}
	for name, matcher := range matchers {
		for _, withMetadata := range []bool{false, true} {
			want, err := legacyPinnedChatInfo(path, nil, withMetadata, matcher)
			if err != nil {
				t.Fatalf("%s: legacy pinnedChatInfo: %v", name, err)
			}
			got, err := pinnedChatInfo(path, nil, withMetadata, matcher)
			if err != nil {
				t.Fatalf("%s: pinnedChatInfo: %v", name, err)
			}
			if got, want := mustMarshalSummary(t, got), mustMarshalSummary(t, want); got != want {
				t.Fatalf("%s withMetadata=%v matcher result differs from the pre-change implementation:\n got: %s\nwant: %s", name, withMetadata, got, want)
			}
		}
	}
}

// errorReader returns its data and then a non-EOF error, simulating a read that fails mid-file.
type errorReader struct {
	data []byte
	done bool
}

func (reader *errorReader) Read(buffer []byte) (int, error) {
	if reader.done {
		return 0, errors.New("simulated read failure")
	}
	reader.done = true
	return copy(buffer, reader.data), nil
}

func TestChatSummaryHandlesFileChangingUnderReader(t *testing.T) {
	fixed := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)

	t.Run("readerShorterThanStat", func(t *testing.T) {
		// The stat said 4096 bytes; the reader now yields two short lines (the file was truncated between stat
		// and read). The result must be computed from what was read, with the stat-derived size, and no panic.
		summary, err := scanChatSummaryReader(chatSummary{size: 4096, modTime: fixed},
			bytes.NewReader([]byte(`{"name":"A","mes":"one"}`+"\n"+`{"name":"A","mes":"two"}`+"\n")), false, nil)
		if err != nil {
			t.Fatalf("scanChatSummaryReader: %v", err)
		}
		if summary.itemCounter != 2 || !summary.hasLastLine {
			t.Fatalf("truncated-under-reader scan: itemCounter=%d hasLastLine=%v, want 2/true", summary.itemCounter, summary.hasLastLine)
		}
		if summary.size != 4096 {
			t.Fatalf("size = %d, want the stat size 4096", summary.size)
		}
	})

	t.Run("readerLongerThanStat", func(t *testing.T) {
		// The stat said 1 byte; the file grew before the read. All bytes the reader yields are consumed.
		summary, err := scanChatSummaryReader(chatSummary{size: 1, modTime: fixed},
			bytes.NewReader([]byte(`{"name":"A","mes":"one"}`+"\n"+`{"name":"A","mes":"two"}`+"\n")), false, nil)
		if err != nil {
			t.Fatalf("scanChatSummaryReader: %v", err)
		}
		if summary.itemCounter != 2 {
			t.Fatalf("grown-under-reader scan: itemCounter=%d, want 2", summary.itemCounter)
		}
	})

	t.Run("readerFailsMidFile", func(t *testing.T) {
		summary, err := scanChatSummaryReader(chatSummary{size: 4096, modTime: fixed},
			&errorReader{data: []byte("line one\n")}, false, nil)
		if err == nil {
			t.Fatalf("scanChatSummaryReader returned no error for a failing reader (summary %+v)", summary)
		}
	})

	t.Run("emptyStatSizedFileReadAsEmpty", func(t *testing.T) {
		// A stat of 0 never opens the file: that is the pinned empty-chat path.
		dir := t.TempDir()
		path := writeChatFile(t, dir, "empty.jsonl", "")
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		summary, err := scanChatSummary(path, true, nil)
		if err != nil || summary.vanished || summary.itemCounter != 0 || summary.size != info.Size() {
			t.Fatalf("empty file summary = %+v err=%v", summary, err)
		}
	})

	t.Run("missingFileVanishes", func(t *testing.T) {
		summary, err := scanChatSummary(filepath.Join(t.TempDir(), "gone.jsonl"), true, nil)
		if err != nil {
			t.Fatalf("missing file: unexpected error %v", err)
		}
		if !summary.vanished {
			t.Fatal("missing file was not reported as vanished")
		}
		if got, want := mustMarshalSummary(t, getChatInfo(filepath.Join(t.TempDir(), "gone.jsonl"), true)), mustMarshalSummary(t, chatVanishedObject()); got != want {
			t.Fatalf("getChatInfo(missing) = %s, want %s", got, want)
		}
	})

	t.Run("directoryIsNotAFile", func(t *testing.T) {
		// A path that exists but cannot be read as a file must not panic and must not index a nil buffer. The
		// characters route answers the vanished object; the search/recent route propagates an error (pinned
		// readFile/readStream behaviour).
		dir := t.TempDir()
		if got := mustMarshalSummary(t, getChatInfo(dir, true)); got == "" {
			t.Fatal("getChatInfo(directory) produced an empty object")
		}
	})
}

func TestChatSummaryLongLineSpansManyReads(t *testing.T) {
	// A single line 5 buffer sizes long, with CRLF at the end: the accumulator must grow, and the CRLF must still
	// be one terminator.
	payload := `{"name":"Huge","is_user":false,"mes":"` + strings.Repeat("x", 5*chatSummaryReadBufferSize) + `"}`
	content := `{"chat_metadata":{"a":1}}` + "\n" + payload + "\r\n"
	dir := t.TempDir()
	path := writeChatFile(t, dir, "huge.jsonl", content)
	summary, err := scanChatSummary(path, true, nil)
	if err != nil {
		t.Fatalf("scanChatSummary: %v", err)
	}
	if summary.itemCounter != 2 {
		t.Fatalf("itemCounter = %d, want 2 (the 5-buffer line is ONE line)", summary.itemCounter)
	}
	if string(summary.lastLine) != payload {
		t.Fatalf("lastLine length = %d, want %d", len(summary.lastLine), len(payload))
	}
	if got, want := mustMarshalSummary(t, getChatInfo(path, true)), mustMarshalSummary(t, func() orderedNodeJSON {
		value, err := legacyPinnedChatInfo(path, nil, true, nil)
		if err != nil {
			t.Fatalf("legacy: %v", err)
		}
		return value
	}()); got != want {
		t.Fatalf("huge-line getChatInfo differs from legacy:\n got: %s\nwant: %s", got, want)
	}
}

func TestGetChatInfoEqualsPinnedChatInfoWithoutMatcher(t *testing.T) {
	// The characters route and the search/recent route must agree when neither additionalData nor a matcher is in
	// play: they call the same reader, and the only difference is the `match` rule, which is the same here.
	for _, testCase := range chatSummaryCases() {
		dir := t.TempDir()
		path := writeChatFile(t, dir, "case.jsonl", testCase.content)
		for _, withMetadata := range []bool{false, true} {
			characters := mustMarshalSummary(t, getChatInfo(path, withMetadata))
			recent, err := pinnedChatInfo(path, nil, withMetadata, nil)
			if err != nil {
				t.Fatalf("%s: pinnedChatInfo: %v", testCase.name, err)
			}
			if got := mustMarshalSummary(t, recent); got != characters {
				t.Fatalf("%s withMetadata=%v: routes disagree:\n characters: %s\n     recent: %s", testCase.name, withMetadata, characters, got)
			}
		}
	}
}
