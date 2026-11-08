package server

// Regression pins for the alpha.18 /api/characters/all allocation work. Both helpers replace a slower
// reference implementation, so each test compares the fast path against the reference byte-for-byte (the
// escaper) or value-for-value (the UTF-16 length) over a corpus that carries the characters which would be
// mis-encoded: every C0 control byte, quote/backslash, lone and paired invalid UTF-8 bytes, U+FFFD,
// U+2028/U+2029, astral-plane runes and a generated mixed stream. A mutation of either helper fails here
// without needing a benchmark.

import (
	"bytes"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

// characterJSONStringCorpus returns inputs whose encodings differ if any escape rule is wrong.
func characterJSONStringCorpus() []string {
	corpus := make([]string, 0, 512)
	corpus = append(corpus, "", "plain", "a\"b", "a\\b", "back\\slash\"quote", "a/b", "<&>")
	for value := 0; value < 0x100; value++ {
		corpus = append(corpus, string([]byte{byte(value)}))
	}
	corpus = append(corpus,
		"a\x00b", "a\x1fb", "a\x7fb", "tab\tnewline\ncarriage\rbackspace\bformfeed\f",
		"line\u2028separator\u2029paragraph",
		"\uFFFD", string([]byte{0xC3}), string([]byte{0xFF}), string([]byte{0xED, 0xA0, 0x80}),
		"é", "日本語", "😀", "😀😀", "a😀b\u2028c",
		"mixed \x00 \x08 \x0b \x0c \x1f \" \\ / < & > \u2028 \u2029 é 😀 "+strings.Repeat("x", 300),
	)
	// A generated stream that mixes valid text, invalid bytes and controls in every position class.
	var builder strings.Builder
	state := uint64(0x9E3779B97F4A7C15)
	for index := 0; index < 4096; index++ {
		state ^= state >> 12
		state ^= state << 25
		state ^= state >> 27
		switch state % 8 {
		case 0:
			builder.WriteByte(byte(state >> 8))
		case 1:
			builder.WriteByte('\\')
		case 2:
			builder.WriteByte('"')
		case 3:
			builder.WriteString("é")
		case 4:
			builder.WriteString("😀")
		case 5:
			builder.WriteString("\u2028")
		case 6:
			builder.WriteByte(0x00)
		default:
			builder.WriteByte(byte('a' + (state>>16)%26))
		}
	}
	corpus = append(corpus, builder.String())
	return corpus
}

func TestCharacterJSONStringEncodingMatchesReference(t *testing.T) {
	for _, input := range characterJSONStringCorpus() {
		reference, err := marshalNodeJSONString(input)
		if err != nil {
			t.Fatalf("reference encoder failed for %q: %v", input, err)
		}
		var fast bytes.Buffer
		writeCharacterJSONString(&fast, input)
		if !bytes.Equal(fast.Bytes(), reference) {
			t.Fatalf("writeCharacterJSONString(%q) = %s, reference marshalNodeJSONString = %s",
				input, fast.Bytes(), reference)
		}
	}
}

// TestCharacterJSONStringEncodingCoversStructure checks the same equality through writeCharacterJSON, so the
// object/array walk (member order, undefined omission, array null) is exercised with the fast escaper too.
func TestCharacterJSONStringEncodingCoversStructure(t *testing.T) {
	document := nodeObject()
	document.setMember("quote\"key", nodeString("value\"with\\escapes\u2028and\x00control"))
	document.setMember("emoji", nodeString("😀"))
	document.setMember("omitted", nodeUndefined())
	document.setMember("list", nodeArray(nodeString("a\x1fb"), nodeUndefined(), nodeNumber(1.5)))

	fast, err := marshalCharacterJSON(document)
	if err != nil {
		t.Fatalf("marshalCharacterJSON: %v", err)
	}
	// The reference is the same walk over a wrapper type that uses encoding/json per string. Expected bytes are
	// built from this document's known content, written independently of the helper under test.
	reference := `{"quote\"key":"value\"with\\escapes` + "\u2028" + `and\u0000control","emoji":"😀","list":["a\u001fb",null,1.5]}`
	if string(fast) != reference {
		t.Fatalf("marshalCharacterJSON = %s, want %s", fast, reference)
	}
}

// TestJavaScriptStringLengthMatchesUTF16Encode pins the allocation-free length against the reference pair it
// replaces. A code-unit count that ignored the surrogate pair (or ran over bytes instead of runes) fails on
// the astral-plane and invalid-UTF-8 rows.
func TestJavaScriptStringLengthMatchesUTF16Encode(t *testing.T) {
	inputs := append(characterJSONStringCorpus(),
		strings.Repeat("😀", 32), strings.Repeat("日", 64), strings.Repeat("a", 1024), "\uFFFD😀\uFFFD")
	for _, input := range inputs {
		want := len(utf16.Encode([]rune(input)))
		if got := javaScriptStringLength(input); got != want {
			t.Fatalf("javaScriptStringLength(%q) = %d, utf16.Encode([]rune(text)) = %d", input, got, want)
		}
	}
}

// TestCharactersAllSymlinkedCardTracksTheTargetThroughTheStatFallback pins the ONE branch
// /api/characters/all takes around the listing-supplied cache identity: a symlinked card's listing metadata
// describes the LINK, while pinned's stat and read follow it, so the listing path must fall back to the stat
// path. The discriminating half is the second listing: after the TARGET is replaced, the symlink's own mtime
// and size are unchanged, so an implementation that cached against the link identity would serve the old card
// text forever. On a host that cannot create symlinks the test skips and says so; Linux CI runs it.
func TestCharactersAllSymlinkedCardTracksTheTargetThroughTheStatFallback(t *testing.T) {
	fixture := readCharactersFixture(t, "sillytavern-1.19.0-characters-read.json")
	if len(fixture.Inputs.Cards) < 2 {
		t.Fatalf("the read fixture seeds %d cards; this test needs two", len(fixture.Inputs.Cards))
	}
	env := newCharactersOracleEnv(t, fixture.Inputs.CookieSecret)
	env.writeFixtureCards(t, fixture)
	charactersRoot := env.Directories["characters"]
	targetName := fixture.Inputs.Cards[0].File
	replacement := fixture.Inputs.Cards[1]
	const linkName = "Symlink Card.png"
	if err := os.Symlink(filepath.Join(charactersRoot, targetName), filepath.Join(charactersRoot, linkName)); err != nil {
		t.Skipf("this host cannot create a file symlink (%v); the fallback is exercised on Linux CI", err)
	}

	listJSONData := func() map[string]string {
		t.Helper()
		response := env.serve(t, http.MethodPost, "/api/characters/all", "application/json", "{}")
		if response.Code != http.StatusOK {
			t.Fatalf("POST /api/characters/all = %d: %s", response.Code, response.Body.String())
		}
		parsed, err := decodeOrderedNodeJSON(response.Body.Bytes())
		if err != nil || parsed.kind != 'a' {
			t.Fatalf("POST /api/characters/all body is not an array: %s", response.Body.String())
		}
		seen := make(map[string]string, len(parsed.array))
		for _, item := range parsed.array {
			avatar, ok := nodeGet(item, "avatar").stringValue()
			if !ok {
				continue
			}
			jsonData, _ := nodeGet(item, "json_data").stringValue()
			seen[avatar] = jsonData
		}
		return seen
	}

	before := listJSONData()
	if _, ok := before[linkName]; !ok {
		t.Fatalf("POST /api/characters/all did not list the symlinked card %s", linkName)
	}
	if before[linkName] != before[targetName] {
		t.Fatalf("the symlinked card served different card data than its target; pinned's read follows the link")
	}

	replacementBody, err := hex.DecodeString(replacement.BytesHex)
	if err != nil {
		t.Fatal(err)
	}
	writeFixtureFile(t, filepath.Join(charactersRoot, targetName), replacementBody, fixture.Inputs.FixedMtimeMS+60000)

	after := listJSONData()
	if after[linkName] == before[linkName] {
		t.Fatalf("the symlinked card still serves its target's OLD data after the target was replaced: the listing path cached against the link identity instead of falling back to the stat path")
	}
	if after[linkName] != after[targetName] {
		t.Fatalf("after the target changed, the symlinked card and its target disagree")
	}
}
