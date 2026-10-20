package tokenizers

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The tiktoken engine is measured against the pinned Node capture, never against a
// reading of the upstream source. Every case below replays a recorded response; a
// disagreement means the engine is wrong unless the fixture can be shown to be
// host-dependent, which TestPinnedNodeTokenizerOracleIsHostIndependent in the server
// package is responsible for.

const (
	oracleFixturePath = "../../tests/oracle/sillytavern-1.19.0-tokenizers.json"
	tiktokenDataPath  = "../../upstream/tokenizers/tiktoken"
)

// Expected replay counts. These are explicit so that a probe that silently stops
// recording a family fails here instead of shrinking the test to nothing.
const (
	wantGpt2EncodeCases        = 29
	wantGpt2DecodeCases        = 7
	wantOpenAIEncodeCases      = 48 // 6 tiktoken models x 8 inputs, including the two extra special-token inputs
	wantOpenAIDecodeCases      = 12 // 4 tiktoken models x 3 id cases
	wantOpenAICountCases       = 85 // 5 tiktoken models x 17 bodies; string_body is an error page, not a response
	wantOtherFamilyCountModels = 5  // claude, llama3, llama, gemma, deepseek
)

type oracleCase struct {
	Request struct {
		Path  string          `json:"path"`
		Query json.RawMessage `json:"query"`
		Body  json.RawMessage `json:"body"`
	} `json:"request"`
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

type oracleFixture struct {
	SchemaVersion int `json:"schemaVersion"`
	Baseline      struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Responses map[string]oracleCase `json:"responses"`
}

func loadOracle(t *testing.T) oracleFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean(oracleFixturePath))
	if err != nil {
		t.Fatal(err)
	}
	var fixture oracleFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Responses) == 0 {
		t.Fatal("oracle has no responses")
	}
	return fixture
}

func openSet(t *testing.T) *TiktokenSet {
	t.Helper()
	set, err := OpenTiktokenSet(filepath.Clean(tiktokenDataPath))
	if err != nil {
		t.Fatal(err)
	}
	return set
}

func queryModel(t *testing.T, name string, raw json.RawMessage) string {
	t.Helper()
	if len(raw) == 0 {
		t.Fatalf("%s: case has no query", name)
	}
	var query map[string]string
	if err := json.Unmarshal(raw, &query); err != nil {
		t.Fatalf("%s: query is not an object of strings: %v", name, err)
	}
	return query["model"]
}

// requestText extracts the request's text field the way the pinned pipeline does. It must
// not rely on encoding/json's own string decoding: Go replaces an unpaired surrogate escape
// with U+FFFD before the tokenizer sees it, while the pinned server keeps the code unit and
// each backend converts it differently. UnescapeJSONString preserves that distinction.
func requestText(t *testing.T, name string, raw json.RawMessage) string {
	t.Helper()
	var body map[string]json.RawMessage
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("%s: request body is not an object: %v", name, err)
	}
	textRaw, ok := body["text"]
	if !ok {
		t.Fatalf("%s: request body has no text field", name)
	}
	text, err := UnescapeJSONString(textRaw)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return text
}

func requestIDs(t *testing.T, name string, raw json.RawMessage) []int {
	t.Helper()
	var body struct {
		IDs []int `json:"ids"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("%s: request body is not {ids}: %v", name, err)
	}
	return body.IDs
}

// TestTiktokenMatchesPinnedOracle replays every tiktoken-family case in the pinned
// capture.
func TestTiktokenMatchesPinnedOracle(t *testing.T) {
	fixture := loadOracle(t)
	set := openSet(t)

	replayed := map[string]int{}
	otherCountModels := map[string]bool{}

	for name, capture := range fixture.Responses {
		switch capture.Request.Path {
		case "/api/tokenizers/gpt2/encode":
			replayed["gpt2/encode"]++
			replayEncode(t, name, capture, mustEncoding(t, set, "gpt2"))
		case "/api/tokenizers/gpt2/decode":
			replayed["gpt2/decode"]++
			replayDecode(t, name, capture, mustEncoding(t, set, "gpt2"))
		case "/api/tokenizers/openai/encode":
			model := queryModel(t, name, capture.Request.Query)
			if OpenAITokenizerFamily(model) != FamilyTiktoken {
				continue
			}
			replayed["openai/encode"]++
			replayEncode(t, name, capture, mustEncodingForModel(t, set, model))
		case "/api/tokenizers/openai/decode":
			model := queryModel(t, name, capture.Request.Query)
			if OpenAITokenizerFamily(model) != FamilyTiktoken {
				continue
			}
			replayed["openai/decode"]++
			replayDecode(t, name, capture, mustEncodingForModel(t, set, model))
		case "/api/tokenizers/openai/count":
			model := queryModel(t, name, capture.Request.Query)
			if _, ok := set.EncodingForModel(GetTokenizerModel(model)); !ok {
				otherCountModels[GetTokenizerModel(model)] = true
				continue
			}
			replayed["openai/count"]++
			replayCount(t, name, capture, set, model)
		}
	}

	want := map[string]int{
		"gpt2/encode":   wantGpt2EncodeCases,
		"gpt2/decode":   wantGpt2DecodeCases,
		"openai/encode": wantOpenAIEncodeCases,
		"openai/decode": wantOpenAIDecodeCases,
		"openai/count":  wantOpenAICountCases,
	}
	for group, count := range want {
		if replayed[group] != count {
			t.Fatalf("replayed %d %s cases, want %d; the fixture or the dispatch changed", replayed[group], group, count)
		}
	}
	if len(otherCountModels) != wantOtherFamilyCountModels {
		t.Fatalf("count models served by another backend = %v, want %d of them", otherCountModels, wantOtherFamilyCountModels)
	}
	for _, model := range []string{"claude", "llama3", "llama", "gemma", "deepseek"} {
		if !otherCountModels[model] {
			t.Fatalf("model %q was counted by the tiktoken engine but is served by another backend", model)
		}
	}

	// Named cases that pin specific semantics rather than volume.
	for _, name := range []string{
		"gpt2/encode#special_endoftext",            // a special token: the pinned route answers empty
		"gpt2/encode#special_fim",                  // not special for gpt2: ordinary text
		"gpt2/encode#special_endofprompt",          // not special for gpt2 either
		"openai/encode#gpt-4o#special_endofprompt", // special for o200k: empty
		"openai/encode#gpt-4o#special_endoftext",   // special for o200k
		"openai/encode#gpt-4#special_fim",          // special for cl100k
		"openai/encode#claude#special_endofprompt", // the same text is ordinary for another backend
		"gpt2/encode#emoji",                        // per-token chunks are replacement characters
		"openai/count#gpt-3.5-turbo-0301#simple",   // the 0301 constants
		"openai/count#gpt-4#numeric_content",       // a value that cannot be encoded
		"openai/count#gpt-4#numeric_then_name",     // the abort stops the rest of that message
		"openai/count#gpt-4#array_then_name",       // the same for a non-empty array
		"openai/count#gpt-4#special_then_name",     // and for a disallowed special token
		"openai/count#gpt-4#empty_array_then_name", // an empty array does not abort
		"openai/count#gpt-4#object_body",           // the route-level guesstimate path
		"openai/count#gpt-4#object_body_long",      // the guesstimate divisor
		"gpt2/decode#out_of_range",                 // an unknown id
	} {
		if _, ok := fixture.Responses[name]; !ok {
			t.Fatalf("required oracle case %q is missing from the fixture", name)
		}
	}
}

func mustEncoding(t *testing.T, set *TiktokenSet, name string) *Tiktoken {
	t.Helper()
	encoding, err := set.Encoding(name)
	if err != nil {
		t.Fatal(err)
	}
	return encoding
}

func mustEncodingForModel(t *testing.T, set *TiktokenSet, model string) *Tiktoken {
	t.Helper()
	encoding, err := set.ForModel(GetTokenizerModel(model))
	if err != nil {
		t.Fatal(err)
	}
	return encoding
}

func replayEncode(t *testing.T, name string, capture oracleCase, encoding *Tiktoken) {
	t.Helper()
	text := requestText(t, name, capture.Request.Body)
	var want struct {
		IDs    []int    `json:"ids"`
		Count  int      `json:"count"`
		Chunks []string `json:"chunks"`
	}
	if err := json.Unmarshal(capture.Body, &want); err != nil {
		t.Fatalf("%s: pinned body is not an encode response: %v", name, err)
	}

	ids, err := encoding.Encode(text)
	if err != nil {
		// The pinned route catches an encode failure and answers an empty result.
		if len(want.IDs) != 0 || want.Count != 0 || len(want.Chunks) != 0 {
			t.Fatalf("%s: engine failed (%v) but pinned returned %d ids", name, err, len(want.IDs))
		}
		return
	}
	if !reflect.DeepEqual(ids, want.IDs) && !(len(ids) == 0 && len(want.IDs) == 0) {
		t.Fatalf("%s: ids = %v, pinned %v", name, ids, want.IDs)
	}
	if want.Count != len(ids) {
		t.Fatalf("%s: pinned count %d does not match %d ids", name, want.Count, len(ids))
	}
	chunks, err := encoding.Chunks(ids)
	if err != nil {
		t.Fatalf("%s: chunks: %v", name, err)
	}
	if !equalStrings(chunks, want.Chunks) {
		t.Fatalf("%s: chunks = %q, pinned %q", name, chunks, want.Chunks)
	}
}

func replayDecode(t *testing.T, name string, capture oracleCase, encoding *Tiktoken) {
	t.Helper()
	ids := requestIDs(t, name, capture.Request.Body)
	var want struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(capture.Body, &want); err != nil {
		t.Fatalf("%s: pinned body is not a decode response: %v", name, err)
	}
	text, err := encoding.Decode(ids)
	if err != nil {
		// The pinned route catches an unknown id and answers {text:""}.
		if want.Text != "" {
			t.Fatalf("%s: engine failed (%v) but pinned returned %q", name, err, want.Text)
		}
		return
	}
	if text != want.Text {
		t.Fatalf("%s: text = %q, pinned %q", name, text, want.Text)
	}
}

func replayCount(t *testing.T, name string, capture oracleCase, set *TiktokenSet, model string) {
	t.Helper()
	var want struct {
		TokenCount float64 `json:"token_count"`
	}
	if err := json.Unmarshal(capture.Body, &want); err != nil {
		t.Fatalf("%s: pinned body is not a count response: %v", name, err)
	}

	messages, err := DecodeOrderedMessages(capture.Request.Body)
	if err != nil {
		// Pinned: `for (const msg of req.body)` throws, the outer catch guesstimates
		// JSON.stringify(req.body). The fixture records the parsed body, so the JSON text
		// is re-serialized here; the only case of this kind is a flat ASCII object, where
		// JavaScript and Go stringify agree.
		compact, marshalErr := json.Marshal(json.RawMessage(capture.Request.Body))
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		compact = compactJSON(t, compact)
		if got := Guesstimate(string(compact)); float64(got) != want.TokenCount {
			t.Fatalf("%s: guesstimate = %d, pinned %v", name, got, want.TokenCount)
		}
		return
	}

	got, err := set.CountOpenAIChatTokens(model, messages)
	if err != nil {
		t.Fatalf("%s: count: %v", name, err)
	}
	if float64(got) != want.TokenCount {
		t.Fatalf("%s: token_count = %d, pinned %v", name, got, want.TokenCount)
	}
}

// compactJSON re-encodes JSON text without insignificant whitespace, because the fixture
// stores parsed bodies pretty-printed.
func compactJSON(t *testing.T, raw []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	if err := json.Compact(&buffer, raw); err != nil {
		t.Fatalf("compacting %s: %v", raw, err)
	}
	return buffer.Bytes()
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func TestTiktokenModelSelection(t *testing.T) {
	set := openSet(t)

	// Exact matches only: pinned tiktoken rejects a model it does not know, and it does
	// not prefix-match.
	for model, want := range map[string]string{
		"gpt-4o":                   "o200k_base",
		"gpt-4o-mini":              "o200k_base",
		"o1":                       "o200k_base",
		"gpt-4":                    "cl100k_base",
		"gpt-3.5-turbo":            "cl100k_base",
		"gpt2":                     "gpt2",
		"text-davinci-003":         "p50k_base",
		"text-davinci-001":         "r50k_base",
		"text-davinci-edit-001":    "p50k_edit",
		"code-search-ada-code-001": "r50k_base",
	} {
		got, ok := set.EncodingForModel(model)
		if !ok || got != want {
			t.Fatalf("encoding for %q = %q (found=%v), want %q", model, got, ok, want)
		}
	}
	for _, model := range []string{"gpt-4o-2099-01-01", "gpt-5-turbo", "o1-xyz", "totally-unknown"} {
		if got, ok := set.EncodingForModel(model); ok {
			t.Fatalf("model %q resolved to %q; pinned tiktoken rejects unknown models", model, got)
		}
	}

	// The pinned dispatch order decides which family a query model reaches.
	for model, want := range map[string]string{
		"gpt-4o":        FamilyTiktoken,
		"gpt-4":         FamilyTiktoken,
		"gpt2":          FamilyTiktoken,
		"nerdstash":     FamilyTiktoken, // the openai routes have no nerdstash branch
		"unknown-model": FamilyTiktoken,
		"llama3":        FamilyLlama3,
		"llama-3-8b":    FamilyLlama3,
		"llama-2-7b":    FamilyLlama,
		"mistral-7b":    FamilyMistral,
		"yi-34b":        FamilyYi,
		"claude-3":      FamilyClaude,
		"gemini-pro":    FamilyGemma,
		"jamba-v1":      FamilyJamba,
		"qwen2-72b":     FamilyQwen2,
		"command-r":     FamilyCommandR,
		"command-a":     FamilyCommandA,
		"nemo-instruct": FamilyNemo,
		"deepseek-r1":   FamilyDeepseek,
	} {
		if got := OpenAITokenizerFamily(model); got != want {
			t.Fatalf("family for %q = %q, want %q", model, got, want)
		}
	}
	for model, want := range map[string]string{
		"gpt-4o":             "gpt-4o",
		"gpt-4.1":            "gpt-4o",
		"gpt-5":              "o1",
		"o4-mini":            "o1",
		"gpt-4-32k":          "gpt-4-32k",
		"gpt-3.5-turbo-0301": "gpt-3.5-turbo-0301",
		"gemini-1.5":         "gemma",
		"learnlm-1.5":        "gemma",
		"text-davinci-003":   "text-davinci-003",
		"anything-else":      "gpt-3.5-turbo",
	} {
		if got := GetTokenizerModel(model); got != want {
			t.Fatalf("tokenizer model for %q = %q, want %q", model, got, want)
		}
	}
}

func TestTiktokenEncodeDecodeEdges(t *testing.T) {
	set := openSet(t)
	gpt2 := mustEncoding(t, set, "gpt2")
	o200k := mustEncoding(t, set, "o200k_base")

	// A disallowed special token is an error, not ordinary text.
	if _, err := gpt2.Encode("a<|endoftext|>b"); err == nil {
		t.Fatal("gpt2 encoded a disallowed special token without an error")
	}
	// o200k has no <|fim_prefix|> special, so the same text is ordinary there.
	if _, err := o200k.Encode("a<|fim_prefix|>b"); err != nil {
		t.Fatalf("o200k treated <|fim_prefix|> as special: %v", err)
	}
	if _, err := o200k.Encode("a<|endofprompt|>b"); err == nil {
		t.Fatal("o200k encoded <|endofprompt|> without an error")
	}

	// An unknown id is an error; a special id decodes to its text.
	if _, err := gpt2.Decode([]int{999999999}); err == nil {
		t.Fatal("gpt2 decoded an unknown id without an error")
	}
	text, err := gpt2.Decode([]int{50256})
	if err != nil || text != "<|endoftext|>" {
		t.Fatalf("gpt2 decode of the special id = %q (%v)", text, err)
	}
	if _, err := gpt2.Decode([]int{-1}); err == nil {
		t.Fatal("gpt2 decoded a negative id without an error")
	}

	// Chunks decode each token on its own, so partial UTF-8 becomes one replacement each.
	ids, err := gpt2.Encode("\U0001F600")
	if err != nil {
		t.Fatal(err)
	}
	chunks, err := gpt2.Chunks(ids)
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) != len(ids) {
		t.Fatalf("chunks = %d for %d ids", len(chunks), len(ids))
	}
	for index, chunk := range chunks {
		if chunk != "\uFFFD" {
			t.Fatalf("chunk %d = %q, want a single replacement character", index, chunk)
		}
	}

	if got := Guesstimate(""); got != 0 {
		t.Fatalf("guesstimate of the empty string = %d", got)
	}
	if got := Guesstimate("Hello, world!"); got != 4 {
		t.Fatalf("guesstimate of 13 bytes = %d, want 4", got)
	}
	if got := Guesstimate(`{"not":"an array"}`); got != 6 {
		t.Fatalf("guesstimate of the object body = %d, want 6", got)
	}
}

func TestReplaceInvalidUTF8MatchesTextDecoder(t *testing.T) {
	tests := []struct {
		name string
		in   []byte
		want string
	}{
		{"valid passthrough", []byte("Hello, \u4e16\u754c \U0001F600"), "Hello, \u4e16\u754c \U0001F600"},
		{"empty", nil, ""},
		// Two lone continuation bytes are two maximal subparts, which is where
		// strings.ToValidUTF8 would collapse them into one.
		{"lone continuations", []byte{0x80, 0x80}, "\uFFFD\uFFFD"},
		{"truncated two byte", []byte{0xC3}, "\uFFFD"},
		{"truncated three byte", []byte{0xE2, 0x82}, "\uFFFD"},
		{"truncated four byte", []byte{0xF0, 0x9F, 0x98}, "\uFFFD"},
		// The expectations below are Node's TextDecoder output, not a hand derivation:
		// a truncated four-byte lead consumes its valid prefix and then reprocesses the
		// offending byte, so 0xF0 0x9F 0x41 is ONE replacement followed by "A".
		{"four byte then ascii", []byte{0xF0, 0x9F, 0x41}, "\uFFFDA"},
		{"four byte full then ascii", []byte{0xF0, 0x90, 0x80, 0x41}, "\uFFFDA"},
		{"four byte short then ascii", []byte{0xF0, 0x90, 0x41}, "\uFFFDA"},
		{"three byte then ascii", []byte{0xE2, 0x28, 0xA1}, "\uFFFD(\uFFFD"},
		{"two byte then ascii", []byte{0xC3, 0x41}, "\uFFFDA"},
		{"surrogate encoding", []byte{0xED, 0xA0, 0x80}, "\uFFFD\uFFFD\uFFFD"},
		{"overlong", []byte{0xC0, 0x80}, "\uFFFD\uFFFD"},
		{"out of range", []byte{0xF5, 0x80, 0x80, 0x80}, "\uFFFD\uFFFD\uFFFD\uFFFD"},
		{"valid around invalid", []byte("a\xFFb"), "a\uFFFDb"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ReplaceInvalidUTF8(test.in); got != test.want {
				t.Fatalf("ReplaceInvalidUTF8(%v) = %q, want %q", test.in, got, test.want)
			}
		})
	}
}

// TestTiktokenSegmentHeaderIsRequired guards the loader against a silent rank shift: a
// segment header carries the starting rank, and a table without one must be refused
// rather than loaded with every rank inferred from position.
func TestTiktokenSegmentHeaderIsRequired(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(filepath.Clean(tiktokenDataPath), "gpt2.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file map[string]any
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	ranks, _ := file["bpe_ranks"].(string)
	fields := strings.Fields(ranks)
	if len(fields) < 3 || fields[0] != tiktokenSegmentMarker || fields[1] != "0" {
		t.Fatalf("vendored segment header changed: %v", fields[:2])
	}

	dir := t.TempDir()
	file["bpe_ranks"] = strings.Join(fields[2:], " ")
	mutated, err := json.Marshal(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "gpt2.json"), mutated, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadTiktoken(dir, "gpt2"); err == nil {
		t.Fatal("loader accepted a rank table with no segment header")
	}
}

// TestTiktokenSegmentRanks pins the multi-segment layout: p50k_base and p50k_edit skip
// rank 50256 for <|endoftext|> and continue at 50257 in a second segment, so a loader
// that numbers tokens by position would be wrong for that whole family.
func TestTiktokenSegmentRanks(t *testing.T) {
	set := openSet(t)
	for _, name := range []string{"p50k_base", "p50k_edit"} {
		encoding := mustEncoding(t, set, name)
		// 50256 ranks of the first segment plus the 24 of the second.
		if len(encoding.encoder) != 50280 {
			t.Fatalf("%s has %d mergeable tokens, want 50280", name, len(encoding.encoder))
		}
		if token, ok := encoding.decoder[50256]; !ok || token != "<|endoftext|>" {
			t.Fatalf("%s rank 50256 = %q, want the <|endoftext|> special", name, token)
		}
		if token, ok := encoding.decoder[50257]; !ok || token == "<|endoftext|>" {
			t.Fatalf("%s has no mergeable token at rank 50257 (got %q)", name, token)
		}
	}
	for _, name := range []string{"gpt2", "r50k_base", "cl100k_base", "o200k_base"} {
		encoding := mustEncoding(t, set, name)
		if len(encoding.encoder) == 0 {
			t.Fatalf("%s loaded no tokens", name)
		}
	}
}
