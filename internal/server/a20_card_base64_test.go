package server

// alpha.20 source-audit reproducer: the character-card base64 decoder is stricter than the pinned one.
//
// PINNED SOURCE: src/character-card-parser.js:80-100 reads a card with
//     Buffer.from(textChunks[ccv3Index].text, 'base64').toString('utf8')
// Node's Buffer.from(..., 'base64') is LENIENT in ways Go's encoding/base64 is not:
//   - it skips EVERY character outside the base64 alphabet, not just CR/LF (Go ignores only '\r'/'\n');
//   - it accepts the URL-safe '-' and '_' as values 62/63 (a Python `base64.urlsafe_b64encode` payload);
//   - it stops at the first '=' and ignores everything after it;
//   - it drops a lone leftover character instead of reporting a length error.
// A card PNG whose `chara`/`ccv3` tEXt payload was produced by a URL-safe encoder (or that contains an
// interior space / trailing junk) is readable by pinned SillyTavern and unreadable here.
//
// ORACLE: measured with the pinned Node 24.19.0 runtime (Buffer.from(v,'base64').toString('utf8')) for the
// unit rows, and by running the pinned src/character-card-parser.js read() against the same PNG shape for
// the end-to-end row (probe output quoted in docs/alpha20/audit/A20-D.md).

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestA20CardBase64DecodeMatchesNodeBufferFrom(t *testing.T) {
	cases := []struct {
		input string
		want  string
		why   string
	}{
		{input: "eyJhIjoxfQ==", want: `{"a":1}`, why: "plain padding"},
		{input: "eyJhIjoxfQ", want: `{"a":1}`, why: "missing padding (already worked through the RawStdEncoding fallback)"},
		{input: "eyJhIjox\nfQ==", want: `{"a":1}`, why: "newline-wrapped payload (Go's decoder ignores CR/LF already)"},
		{input: "eyJh\r\nIjox\nfQ==", want: `{"a":1}`, why: "CRLF-wrapped payload"},
		{input: "eyJh IjoxfQ==", want: `{"a":1}`, why: "an interior SPACE is skipped by Node; Go's decoder rejects it"},
		{input: "e!yJh#Ijox fQ==", want: `{"a":1}`, why: "arbitrary non-alphabet characters are skipped by Node"},
		{input: "eyJhIjoxfQ==junk", want: `{"a":1}`, why: "everything after the first '=' is ignored by Node"},
		{input: "=eyJhIjoxfQ==", want: "", why: "a leading '=' terminates the payload"},
		{input: "!!!", want: "", why: "no alphabet characters decodes to empty"},
		{input: "Pz8-", want: "??>", why: "URL-safe '-' is value 62"},
		{input: "Pz8_", want: "???", why: "URL-safe '_' is value 63"},
		{input: "abcde", want: "i\uFFFD\x1d", why: "a lone leftover character is dropped; invalid UTF-8 becomes U+FFFD"},
		{input: "AAAA", want: "\x00\x00\x00", why: "ordinary quartet"},
	}
	for _, testCase := range cases {
		got, err := decodeBase64UTF8(testCase.input)
		if err != nil {
			t.Errorf("decodeBase64UTF8(%q) error: %v (%s); pinned Buffer.from(...,'base64') accepts it",
				testCase.input, err, testCase.why)
			continue
		}
		if got != testCase.want {
			t.Errorf("decodeBase64UTF8(%q) = %q, want %q (%s)", testCase.input, got, testCase.want, testCase.why)
		}
	}
}

// TestA20URLSafeBase64CardIsReadable is the end-to-end form: a card PNG whose `chara` tEXt payload is
// URL-safe base64 (the encoding Python's base64.urlsafe_b64encode produces). The pinned reader decodes
// it -- Node accepts '-'/'_' as 62/63 -- and ours must too. The card text is chosen so that its standard
// encoding contains a '+', i.e. the URL-safe form really differs byte for byte.
func TestA20URLSafeBase64CardIsReadable(t *testing.T) {
	cardJSON := `{"name":"Wrapped Card","description":"abc~","data":{"name":"Wrapped Card"}}`
	encoded := base64.StdEncoding.EncodeToString([]byte(cardJSON))
	urlSafe := strings.NewReplacer("+", "-", "/", "_").Replace(encoded)
	if urlSafe == encoded {
		t.Fatalf("the fixture does not exercise the URL-safe alphabet: %q has no '+' or '/'", encoded)
	}
	image := encodePngChunks([]pngChunk{
		{name: "IHDR", data: []byte{0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0}},
		{name: "tEXt", data: []byte("chara\x00" + urlSafe)},
		{name: "IEND"},
	})
	path := filepath.Join(t.TempDir(), "urlsafe.png")
	if err := os.WriteFile(path, image, 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	got, err := readCharacterDataStrict(path)
	if err != nil {
		t.Fatalf("a card with a URL-safe base64 payload is unreadable: %v; pinned "+
			"character-card-parser.js reads it with Buffer.from(text,'base64').toString('utf8')", err)
	}
	if got != cardJSON {
		t.Fatalf("card text = %q, want %q", got, cardJSON)
	}
}
