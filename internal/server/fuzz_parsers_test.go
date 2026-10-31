package server

// FUZZ THE USER-CONTROLLED / HISTORICAL PARSERS of the request and data surface:
//
//   - decodeOrderedNodeJSON: every JSON body and every chat .jsonl line;
//   - readPngCardText: an uploaded/historical character card's PNG text chunks;
//   - parseYamlDocument: the character-import YAML path;
//   - parseAvatarCrop: the `crop` query parameter of the avatar/character edit routes;
//   - pinnedPathUnderParent: the containment check the chat/world routes rely on.
//
// A panic in any of these is a request-triggered server crash; for the two path functions the
// assertion is the security PROPERTY (a result of "true" can never describe a path above its
// parent), not a table of expected outputs. Seeds are the shapes real data reaches: valid chat
// messages, historical cards, truncated chunks, separators and traversal components. Plain
// `go test` runs every seed as an ordinary case.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"path/filepath"
	"strings"
	"testing"
)

func FuzzDecodeOrderedNodeJSON(f *testing.F) {
	for _, seed := range []string{
		`{}`, `[]`, `null`, `1`, `"text"`, `true`,
		`{"mes":"hello","is_user":true,"name":"You"}`,
		`{"a":1,"b":[{"c":null}]}`,
		`{"dup":1,"dup":2}`,
		`{"unicode":"h\u00e9llo \u4e16\u754c"}`,
		`{"surrogate":"\ud83d\ude00"}`,
		`{"lone":"\ud800"}`,
		`{"number":1e999}`,
		`{"number":-0.0}`,
		`{"big":9007199254740993}`,
		`{`,
		`[1,2,`,
		`{"unquoted":key}`,
		"{\"control\":\"\x01\"}",
		``,
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		value, err := decodeOrderedNodeJSON(raw)
		if err != nil {
			return
		}
		encoded, err := marshalOrderedNodeJSON(value)
		if err != nil {
			t.Fatalf("a value the JSON parser accepted cannot be re-serialized (input %q): %v", raw, err)
		}
		if !json.Valid(encoded) {
			t.Fatalf("marshalOrderedNodeJSON emitted invalid JSON for input %q: %q", raw, encoded)
		}
		if _, err := decodeOrderedNodeJSON(encoded); err != nil {
			t.Fatalf("the parser rejects its own serializer's output for input %q: %v", raw, err)
		}
	})
}

func FuzzReadPngCardText(f *testing.F) {
	card := `{"name":"seed","description":"seed description"}`
	valid := seedPngCard(f, card)
	f.Add(valid)
	f.Add([]byte{})
	f.Add([]byte("\x89PNG\r\n\x1a\n"))
	f.Add([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"))
	f.Add(valid[:len(valid)/2])
	f.Add(append(append([]byte(nil), valid...), 0x00, 0x01))
	// A PNG whose tEXt payload contains a NUL and a huge declared chunk length.
	f.Add([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR" +
		"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"))
	f.Fuzz(func(t *testing.T, image []byte) {
		// The assertion is "never panic"; an error is the expected answer for malformed bytes.
		_, _ = readPngCardText(image)
	})
}

func seedPngCard(t testing.TB, card string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	source := image.NewRGBA(image.Rect(0, 0, 1, 1))
	source.Set(0, 0, color.RGBA{R: 1, G: 2, B: 3, A: 4})
	if err := png.Encode(&buffer, source); err != nil {
		t.Fatalf("encode seed png: %v", err)
	}
	encoded, err := writePngCard(buffer.Bytes(), card)
	if err != nil {
		t.Fatalf("write seed card: %v", err)
	}
	return encoded
}

func FuzzParseYamlDocument(f *testing.F) {
	for _, seed := range []string{
		"name: Alice\ndescription: hello\n",
		"{\"name\":\"json-shaped\"}\n",
		"name: [unterminated\n",
		"---\nname: Alice\n---\nname: Bob\n",
		"name: &a {x: 1}\nother: *a\n",
		"tags:\n  - a\n  - b\n",
		"",
		"42\n",
		"# only a comment\n",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, document string) {
		_, _ = parseYamlDocument(document)
	})
}

func FuzzParseAvatarCrop(f *testing.F) {
	for _, seed := range []string{
		``,
		`{"x":0,"y":0,"width":512,"height":768}`,
		`{"x":0,"y":0,"width":512,"height":768,"want_resize":true}`,
		`{"x":-1,"y":-1,"width":1e999,"height":-0.0}`,
		`{"x":"0","y":0,"width":1,"height":1}`,
		`null`, `[]`, `{}`, `{`, `{"x":null}`,
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, query string) {
		crop := parseAvatarCrop(query)
		if crop == nil {
			return
		}
		_ = base64.StdEncoding.EncodeToString([]byte(query))
	})
}

func FuzzPinnedPathUnderParent(f *testing.F) {
	for _, seed := range []string{
		"", ".", "..", "/", "\\", "a", "a/b", "../a", "/a/b", "C:\\a\\b",
		"chats", "chats/Alice", "chats/Alice/../../escape", "chats/./Alice",
	} {
		f.Add(seed, seed)
	}
	f.Add("chats", "chats/Alice/chat.jsonl")
	f.Add("chats", "chats/../escape")
	f.Add("C:\\data\\user", "C:\\data\\user\\chats\\a.jsonl")
	f.Fuzz(func(t *testing.T, parent, child string) {
		inside := pinnedPathUnderParent(parent, child)
		if !inside {
			return
		}
		relative, err := filepath.Rel(filepath.Clean(parent), filepath.Clean(child))
		if err != nil {
			t.Fatalf("pinnedPathUnderParent(%q, %q) reported true but filepath.Rel failed: %v", parent, child, err)
		}
		if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			t.Fatalf("pinnedPathUnderParent(%q, %q) reported true for a path ABOVE the parent (rel %q)",
				parent, child, relative)
		}
	})
}
