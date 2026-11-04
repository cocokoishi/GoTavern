package server

// STREAMING CHAT SUMMARY: the ONE sequential reader behind both chat-summary call sites.
//
// WHY. pinned's getChatInfo (src/endpoints/chats.js:393) streams the file through readline and only ever uses
// four things: the stat data (size + mtime), the number of terminated lines, the LAST line, and -- when
// `withMetadata` is set -- the FIRST line's `chat_metadata` object. The Go port reproduced the OUTPUT of that
// reader but not its streaming: getChatInfo (characters_read.go) and a second copy, pinnedChatInfo
// (chats_search_recent.go), each read the whole file, converted it to a string, split every line into a
// []string through a byte-by-byte strings.Builder, and then kept only the last line. A 3.4 MB chat cost ~19.5 MB
// of transient allocation and ~28k allocations PER CHAT, and /api/characters/chats pays it once per chat file.
//
// WHAT THIS DOES. Reads the file through one fixed-size buffer, maintains a line accumulator that grows only
// when a line is longer than the buffer (so arbitrarily long lines are supported, and bufio.Scanner's token
// limit is deliberately not used), and keeps at most two line buffers: the line being accumulated and the
// candidate last line. Widening them swap instead of copying, so a 4,000-message chat costs two line buffers,
// not 4,000 line strings. No cache is introduced: every call reopens and re-reads the file.
//
// LINE SEMANTICS, pinned readline with `crlfDelay: Infinity`:
//   - '\n', '\r' and '\r\n' each terminate a line;
//   - a '\r' at the end of a read chunk is emitted immediately and, if the next byte is '\n', that '\n' is
//     swallowed -- so a CRLF split across a buffer boundary is one terminator, not two lines;
//   - a trailing terminator does not add an empty line; a file whose only content is "\n" has ONE empty line;
//   - an unterminated final line is a line. These are the same rules as splitReadlineLines (which the chat
//     EXPORT route still uses on a body it already has in memory), so both readers agree.
//
// STAT/READ ORDER, pinned:
//   - stat first (size and mtime come from it), then open; ENOENT at either point is the `chatVanished` result;
//   - a file that shrinks/grows between stat and read yields the bytes actually read plus the stat metadata, and
//     never panics or indexes past a buffer.

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// chatSummaryReadBufferSize bounds the read syscall buffer. The line accumulator is separate and grows only for
// lines longer than this. 64 KiB is large enough that a normal JSONL line never grows the accumulator, and small
// enough that the per-call allocation is negligible against the file sizes this path serves.
const chatSummaryReadBufferSize = 64 * 1024

// chatSummary is the observable result of a sequential scan. `lastLine` and `firstLine` are valid after a
// successful scan; the caller must decode them before the next call to scanChatSummary (nothing is shared).
type chatSummary struct {
	size        int64
	modTime     time.Time
	vanished    bool
	itemCounter int
	hasLastLine bool
	lastLine    []byte
	firstLine   []byte
}

// scanChatSummary performs the sequential read. `onLine`, when non-nil, is called for every terminated line with
// its zero-based index and the line's bytes (the slice is reused for the next line, so a callback that needs to
// retain the content must copy it). It exists for the /api/chats/search matcher, whose pinned semantics require
// each line's decoded `mes` to be accumulated until the matcher first returns true.
func scanChatSummary(pathToFile string, withMetadata bool, onLine func(lineIndex int, line []byte)) (chatSummary, error) {
	var summary chatSummary
	info, err := os.Stat(pathToFile)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			summary.vanished = true
			return summary, nil
		}
		return chatSummary{}, err
	}
	summary.size = info.Size()
	summary.modTime = info.ModTime()
	if info.Size() == 0 {
		// pinned returns the empty-chat object without opening the file.
		return summary, nil
	}
	file, err := os.Open(pathToFile)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			summary.vanished = true
			return summary, nil
		}
		return chatSummary{}, err
	}
	defer func() { _ = file.Close() }()
	return scanChatSummaryReader(summary, file, withMetadata, onLine)
}

// scanChatSummaryReader is the reader half of scanChatSummary, split out so the "file changes under the reader"
// cases (a reader shorter or longer than the stat size, a reader that errors mid-stream) are testable without a
// race against a real filesystem. `summary` already carries the stat-derived size and mtime.
func scanChatSummaryReader(summary chatSummary, reader io.Reader, withMetadata bool, onLine func(lineIndex int, line []byte)) (chatSummary, error) {
	buffer := make([]byte, chatSummaryReadBufferSize)
	line := make([]byte, 0, 256)
	pendingCarriageReturn := false

	emit := func() {
		summary.itemCounter++
		summary.hasLastLine = true
		// Retain the line just terminated and take the previous candidate's buffer for the next line: two
		// buffers, both bounded by the longest line, no per-line allocation and no copy.
		line, summary.lastLine = summary.lastLine, line
		line = line[:0]
		if withMetadata && summary.itemCounter == 1 {
			// The header line is decoded after the scan, and the accumulator is about to be reused.
			summary.firstLine = append(summary.firstLine, summary.lastLine...)
		}
		if onLine != nil {
			onLine(summary.itemCounter-1, summary.lastLine)
		}
	}

	for {
		read, readErr := reader.Read(buffer)
		for index := 0; index < read; index++ {
			current := buffer[index]
			if pendingCarriageReturn {
				pendingCarriageReturn = false
				if current == '\n' {
					// The previous chunk ended with '\r'; this '\n' completes the same CRLF terminator.
					continue
				}
			}
			if current != '\n' && current != '\r' {
				// Append the whole run of non-terminator bytes in ONE copy call. Byte-at-a-time append would let
				// the runtime's growth policy pick the capacity (1.25x above 256 bytes, so a 1.5 MB line churns
				// ~8 MB); appendChatLineBytes doubles explicitly, which is both cheaper and predictable.
				end := index + 1
				for end < read && buffer[end] != '\n' && buffer[end] != '\r' {
					end++
				}
				line = appendChatLineBytes(line, buffer[index:end])
				index = end - 1
				continue
			}
			if current == '\n' {
				emit()
				continue
			}
			// A lone '\r' terminates the line as surely as '\r\n' does, so the line is emitted now. The only
			// question is whether the NEXT byte is the '\n' of a CRLF; at a chunk boundary that byte is not
			// readable yet, hence pendingCarriageReturn.
			emit()
			if index == read-1 {
				pendingCarriageReturn = true
			} else if buffer[index+1] == '\n' {
				index++
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return chatSummary{}, readErr
		}
	}
	// An unterminated final line is still a line, exactly like pinned readline's close event.
	if len(line) > 0 {
		emit()
	}
	return summary, nil
}

// appendChatLineBytes appends a run of non-terminator bytes to the line accumulator, growing it with an explicit
// doubling so a many-megabyte single line allocates O(final length) rather than O(final length^1.25-ish) through
// the runtime's own growth policy. The accumulator starts small because the common line is a few hundred bytes.
func appendChatLineBytes(line, chunk []byte) []byte {
	needed := len(line) + len(chunk)
	if needed <= cap(line) {
		return append(line, chunk...)
	}
	capacity := cap(line)
	if capacity < 256 {
		capacity = 256
	}
	for capacity < needed {
		capacity *= 2
	}
	grown := make([]byte, len(line), capacity)
	copy(grown, line)
	return append(grown, chunk...)
}

// newChatSummaryData builds the pinned chatData prefix. Both call sites share this verbatim: `match` false,
// file identity, the human-readable size, the empty-chat placeholders and the numeric mtime.
func newChatSummaryData(pathToFile string, summary chatSummary) orderedNodeJSON {
	base := filepath.Base(pathToFile)
	chatData := nodeObject()
	chatData.setMember("match", nodeBool(false))
	chatData.setMember("file_id", nodeString(strings.TrimSuffix(base, nodePathExt(base))))
	chatData.setMember("file_name", nodeString(base))
	chatData.setMember("file_size", nodeString(formatBytes(summary.size)))
	chatData.setMember("chat_items", nodeNumber(0))
	chatData.setMember("mes", nodeString("[The chat is empty]"))
	chatData.setMember("last_mes", nodeNumber(float64(summary.modTime.UnixNano())/1e6))
	return chatData
}

// applyChatSummaryMetadata ports `if (withMetadata && itemCounter === 0) { tryParse(line);
// if (_.isObjectLike(jsonData.chat_metadata)) chatData.chat_metadata = ... }`: only the FIRST line is examined,
// a line that does not decode contributes nothing, and the metadata must be an object or an array.
func applyChatSummaryMetadata(chatData *orderedNodeJSON, summary chatSummary) {
	if len(summary.firstLine) == 0 {
		return
	}
	parsed, err := decodeOrderedNodeJSON(summary.firstLine)
	if err != nil {
		return
	}
	if metadata, exists := parsed.member("chat_metadata"); exists && (metadata.kind == 'o' || metadata.kind == 'a') {
		chatData.setMember("chat_metadata", metadata)
	}
}

// finishChatSummary ports the readline 'close' handler: the valid-last-line branch and the degraded/corrupt
// branch. It reports whether that handler took one of the two branches, so a caller can apply its own `match`
// rule (the characters route always reports a match there; the search/recent route reports the matcher verdict).
func finishChatSummary(chatData *orderedNodeJSON, summary chatSummary) bool {
	if !summary.hasLastLine || len(summary.lastLine) == 0 {
		// pinned's `if (lastLine)` is false for an empty last line (e.g. a file containing only "\n"): the file
		// was truncated after the stat or holds a single empty line, and the empty-chat placeholders stand.
		return false
	}
	parsed, err := decodeOrderedNodeJSON(summary.lastLine)
	valid := err == nil && jsTruthy(parsed) &&
		(jsTruthy(nodeGet(parsed, "name")) || jsTruthy(nodeGet(parsed, "character_name")) || jsTruthy(nodeGet(parsed, "chat_metadata")))
	if valid {
		chatData.setMember("chat_items", nodeNumber(float64(summary.itemCounter-1)))
		message := nodeGet(parsed, "mes")
		if !jsTruthy(message) {
			message = nodeString("[The message is empty]")
		}
		chatData.setMember("mes", message)
		sendDate := nodeGet(parsed, "send_date")
		if !jsTruthy(sendDate) {
			sendDate = nodeString(isoStringFromMilliseconds(float64(summary.modTime.UnixNano()) / 1e6))
		}
		chatData.setMember("last_mes", sendDate)
		return true
	}
	// The last line is unparseable or lacks the known fields (a truncated write or an external edit): exclude
	// both the metadata line and the unreadable trailing line, and resolve a degraded preview.
	remaining := summary.itemCounter - 2
	if remaining < 0 {
		remaining = 0
	}
	chatData.setMember("chat_items", nodeNumber(float64(remaining)))
	chatData.setMember("mes", nodeString("[The message is empty]"))
	return true
}
