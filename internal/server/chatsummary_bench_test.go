package server

// M5a BENCHMARK: chat-summary scanning on a REALISTIC LARGE chat.
//
// WHY THIS FILE EXISTS. `getChatInfo` and `pinnedChatInfo` answer /api/characters/chats and /api/chats/recent by
// reading a whole JSONL chat into memory, converting it to a string and splitting every line with a
// byte-by-byte strings.Builder, although they only need the file size, a message count, the LAST line and
// (optionally) the FIRST line's metadata. A card with several 2-10 MB chats pays that cost once per file,
// sequentially. Every small committed fixture is far below the size where this matters, which is why a fixture
// assertion could never show it -- this benchmark is the reproduction.
//
// THE FIXTURE. Built once per process into a temp directory:
//   - 4,000 messages (>=2 MB total), each ~400 bytes of prose;
//   - ONE very long single-line message (~1.5 MB) in the MIDDLE, so a reader that materialises every line pays
//     for it even though it is not the last line;
//   - a mix of `\n`, `\r\n` and lone `\r` line terminators;
//   - a UTF-8/CJK/emoji final line so the last-line decode path is exercised;
//   - a metadata header first line.
//
// WHAT IS MEASURED. ns/op, B/op, allocs/op for the two real call sites (characters/chats and chats/recent) and
// for the /api/chats/search worst case (a query that matches nothing, so the whole file is scanned and every
// line decoded). `-benchmem` is required; the numbers are recorded in the commit that adds this file (before)
// and in the commit that streams the read (after).
//
// RUN:
//   go test ./internal/server -run '^$' -bench 'BenchmarkChatSummaryLarge' -benchmem -count=5

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	benchChatMessages    = 4000
	benchChatLongLineB   = 1_500_000
	benchChatLongRepeat  = benchChatLongLineB / len("ember ")
	benchChatMessageBody = "the quick brown fox jumps over the lazy dog "
)

// buildBenchmarkChat writes the large fixture and returns its path and byte size.
func buildBenchmarkChat(tb testing.TB, dir string) (string, int64) {
	tb.Helper()
	var builder strings.Builder
	builder.Grow(4 << 20)

	// First line: the chat metadata header (the only line whose metadata is read).
	builder.WriteString(`{"user_name":"bench-user","character_name":"Bench Character","chat_metadata":{"world_info":"Bench Lore","integrity":"bench-integrity","note_prompt":"BENCHMARK_NOTE"}}`)
	builder.WriteString("\r\n")

	body := strings.Repeat(benchChatMessageBody, 8)
	for index := 0; index < benchChatMessages; index++ {
		line := fmt.Sprintf(
			`{"name":"Bench Character","is_user":%t,"is_system":false,"send_date":"2026-11-03T12:%02d:%02d.000Z","mes":"%s %d","extra":{}}`,
			index%2 == 0, index%60, index%60, body, index,
		)
		switch {
		case index%7 == 3:
			// A lone CR is a line terminator to pinned's readline (crlfDelay: Infinity).
			builder.WriteString(line)
			builder.WriteString("\r")
		case index%3 == 0:
			builder.WriteString(line)
			builder.WriteString("\r\n")
		default:
			builder.WriteString(line)
			builder.WriteString("\n")
		}

		// ONE very long single-line message, in the middle: ~1.5 MB of prose on a single line.
		if index == benchChatMessages/2 {
			builder.WriteString(`{"name":"Bench Character","is_user":false,"send_date":"2026-11-03T12:30:00.000Z","mes":"`)
			builder.WriteString(strings.Repeat("ember ", benchChatLongRepeat))
			builder.WriteString(`","extra":{"benchmark":"very-long-single-line"}}`)
			builder.WriteString("\n")
		}
	}

	// Final line: Non-ASCII (CJK + emoji) content, then a trailing terminator that must NOT create an empty line.
	builder.WriteString(`{"name":"Bench Character","is_user":true,"send_date":"2026-11-03T13:00:00.000Z","mes":"灯 🦊 ロング final line","extra":{}}`)
	builder.WriteString("\n")

	if builder.Len() < 2<<20 {
		tb.Fatalf("benchmark fixture is %d bytes, want >= 2 MiB so the measurement is about a large chat", builder.Len())
	}
	path := filepath.Join(dir, "Bench Character - 2026-11-03@13h00m00s000ms.jsonl")
	if err := os.WriteFile(path, []byte(builder.String()), 0o644); err != nil {
		tb.Fatalf("write benchmark chat: %v", err)
	}
	return path, int64(builder.Len())
}

func benchmarkChatFixture(b *testing.B) (string, int64) {
	b.Helper()
	return buildBenchmarkChat(b, b.TempDir())
}

// BenchmarkChatSummaryLargeCharactersMetadata is the /api/characters/chats path with ?metadata (the slowest and
// most common shape: GoTavern's frontend asks with metadata for the chat list).
func BenchmarkChatSummaryLargeCharactersMetadata(b *testing.B) {
	path, size := benchmarkChatFixture(b)
	b.SetBytes(size)
	b.ReportAllocs()
	b.ResetTimer()
	for iteration := 0; iteration < b.N; iteration++ {
		info := getChatInfo(path, true)
		if !jsTruthy(nodeGet(info, "file_name")) {
			b.Fatal("getChatInfo returned no file_name")
		}
	}
}

// BenchmarkChatSummaryLargeCharacters is the same call without metadata.
func BenchmarkChatSummaryLargeCharacters(b *testing.B) {
	path, size := benchmarkChatFixture(b)
	b.SetBytes(size)
	b.ReportAllocs()
	b.ResetTimer()
	for iteration := 0; iteration < b.N; iteration++ {
		info := getChatInfo(path, false)
		if !jsTruthy(nodeGet(info, "file_name")) {
			b.Fatal("getChatInfo returned no file_name")
		}
	}
}

// BenchmarkChatSummaryLargeRecent is the /api/chats/recent path (pinnedChatInfo with additionalData, no matcher).
func BenchmarkChatSummaryLargeRecent(b *testing.B) {
	path, size := benchmarkChatFixture(b)
	additional := nodeObject()
	additional.setMember("avatar", nodeString("Bench Character.png"))
	b.SetBytes(size)
	b.ReportAllocs()
	b.ResetTimer()
	for iteration := 0; iteration < b.N; iteration++ {
		info, err := pinnedChatInfo(path, &additional, true, nil)
		if err != nil || !jsTruthy(nodeGet(info, "file_name")) {
			b.Fatalf("pinnedChatInfo: %v", err)
		}
	}
}

// BenchmarkChatSummaryLargeSearch is the /api/chats/search worst case: a query that matches nothing, so every
// line is decoded and passed to the matcher.
func BenchmarkChatSummaryLargeSearch(b *testing.B) {
	path, size := benchmarkChatFixture(b)
	matcher := pinnedSearchMatcher([]string{"fragment-that-never-appears"})
	b.SetBytes(size)
	b.ReportAllocs()
	b.ResetTimer()
	for iteration := 0; iteration < b.N; iteration++ {
		info, err := pinnedChatInfo(path, nil, false, matcher)
		if err != nil || !jsTruthy(nodeGet(info, "file_name")) {
			b.Fatalf("pinnedChatInfo: %v", err)
		}
	}
}
