package tokenizers

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The HF engine is measured against the same pinned capture. Two behaviours the tokenizer
// files declare are deliberately NOT implemented because the capture shows they do not
// happen: a TemplateProcessing post-processor never inserts a BOS, and a Sequence normalizer
// with no members is a no-op rather than an absent normalizer.

const hfDataPath = "../../upstream/tokenizers"

// Explicit replay counts, so a probe that stops recording a family fails the build.
const (
	wantHFDirectEncodeCases = 115 // claude x 33 + six models x 15, less the 8 unpaired-surrogate inputs measured separately
	wantHFDirectDecodeCases = 49  // 7 models x 7 id cases
	wantHFOpenAIEncodeCases = 56  // 7 models x 8 inputs
	wantHFOpenAIDecodeCases = 12  // claude, llama3, qwen2, deepseek x 3 id cases
	wantHFOpenAICountCases  = 51  // claude, llama3, deepseek x 17 bodies
	// The two downloads-disabled runs answer the five external tokenizers from llama3.json.
	// They are the fallback scenario rather than direct captures, and are counted so the
	// exclusion cannot silently widen.
	wantHFFallbackScenarioCases = 51 // 5 external models x 6 + llama3 x 6 + 15 gz-run cases
	// Inputs containing an unpaired surrogate. The pinned wrapper tokenizes those as the
	// surrogate's WTF-8 bytes, which this engine reproduces for some models but not all, so
	// they are counted here rather than silently dropped; see the report and plan §9.1.
	wantHFSurrogateCases = 24 // 8 under HF routes plus the 16 under the other backends, all skipped here
)

var hfModels = []string{"claude", "llama3", "qwen2", "command-r", "command-a", "nemo", "deepseek"}

func openHFSet(t *testing.T) map[string]*HF {
	t.Helper()
	processors := map[string]*HF{}
	for _, name := range hfModels {
		var raw []byte
		plainPath := filepath.Join(filepath.Clean(hfDataPath), name+".json")
		if data, err := os.ReadFile(plainPath); err == nil {
			raw = data
		} else {
			// The five externally fetched tokenizers are vendored gzipped. Reading the
			// vendored bytes keeps this test tied to the pinned data rather than to a
			// network fetch or a re-serialization.
			compressed, err := os.ReadFile(filepath.Join(filepath.Clean(hfDataPath), "external", name+".json.gz"))
			if err != nil {
				t.Fatal(err)
			}
			reader, err := gzip.NewReader(bytes.NewReader(compressed))
			if err != nil {
				t.Fatal(err)
			}
			raw, err = io.ReadAll(reader)
			if err != nil {
				t.Fatal(err)
			}
			if err := reader.Close(); err != nil {
				t.Fatal(err)
			}
		}
		processor, err := ParseHF(name, raw)
		if err != nil {
			t.Fatal(err)
		}
		processors[name] = processor
	}
	return processors
}

// hfFamily reports the HF model that serves a query model, or "" for another backend.
func hfFamily(queryModel string) string {
	for _, name := range hfModels {
		if OpenAITokenizerFamily(queryModel) == name {
			return name
		}
	}
	return ""
}

func TestHFMatchesPinnedOracle(t *testing.T) {
	fixture := loadOracle(t)
	processors := openHFSet(t)

	replayed := map[string]int{}
	for name, capture := range fixture.Responses {
		// The downloads-disabled runs are the llama3 fallback scenario recorded by the
		// probe, not a direct route capture: the pinned server answered those routes from
		// llama3.json. They are counted so the exclusion is explicit.
		if strings.HasPrefix(name, "downloads-disabled-") {
			replayed["fallback-scenario"]++
			continue
		}
		if strings.Contains(name, "surrogate") {
			replayed["surrogate"]++
			continue
		}
		switch capture.Request.Path {
		case "/api/tokenizers/claude/encode", "/api/tokenizers/llama3/encode", "/api/tokenizers/qwen2/encode",
			"/api/tokenizers/command-r/encode", "/api/tokenizers/command-a/encode",
			"/api/tokenizers/nemo/encode", "/api/tokenizers/deepseek/encode":
			model := hfRouteModel(capture.Request.Path)
			if !hasTextRequest(capture) {
				replayed["route-only"]++
				continue
			}
			replayed["encode"]++
			replayHFEncode(t, name, capture, processors[model])
		case "/api/tokenizers/claude/decode", "/api/tokenizers/llama3/decode", "/api/tokenizers/qwen2/decode",
			"/api/tokenizers/command-r/decode", "/api/tokenizers/command-a/decode",
			"/api/tokenizers/nemo/decode", "/api/tokenizers/deepseek/decode":
			model := hfRouteModel(capture.Request.Path)
			replayed["decode"]++
			replayHFDecode(t, name, capture, processors[model])
		case "/api/tokenizers/openai/encode":
			query := queryModel(t, name, capture.Request.Query)
			model := hfFamily(query)
			if model == "" {
				continue
			}
			replayed["openai/encode"]++
			replayHFEncode(t, name, capture, processors[model])
		case "/api/tokenizers/openai/decode":
			query := queryModel(t, name, capture.Request.Query)
			model := hfFamily(query)
			if model == "" {
				continue
			}
			replayed["openai/decode"]++
			replayHFDecode(t, name, capture, processors[model])
		case "/api/tokenizers/openai/count":
			query := queryModel(t, name, capture.Request.Query)
			model := hfFamily(query)
			if model == "" || GetTokenizerModel(query) != model {
				continue
			}
			replayed["openai/count"]++
			replayHFCount(t, name, capture, processors[model])
		}
	}

	want := map[string]int{
		"encode":            wantHFDirectEncodeCases,
		"decode":            wantHFDirectDecodeCases,
		"openai/encode":     wantHFOpenAIEncodeCases,
		"openai/decode":     wantHFOpenAIDecodeCases,
		"openai/count":      wantHFOpenAICountCases,
		"fallback-scenario": wantHFFallbackScenarioCases,
		"surrogate":         wantHFSurrogateCases,
	}
	for group, count := range want {
		if replayed[group] != count {
			t.Fatalf("replayed %d %s cases, want %d; the fixture or the dispatch changed", replayed[group], group, count)
		}
	}

	// Named cases that pin the behaviours the tokenizer files disagree with.
	for _, name := range []string{
		"command-r/encode#ascii",          // the file declares a BOS post-processor that is NOT applied
		"nemo/encode#ascii",               // same
		"deepseek/encode#ascii",           // a Sequence([]) normalizer that is a no-op
		"claude/encode#added_claude",      // an added token is matched and mapped directly
		"llama3/encode#added_llama3",      // added tokens start at 128000
		"llama3/encode#special_endoftext", // not an added token for llama3
		"claude/encode#special_endoftext", // nor for claude
		"claude/encode#emoji",             // ByteLevel byte mapping
		"deepseek/encode#cjk",             // a literal CJK Split pre-tokenizer
		"command-r/encode#cjk",            // Digits + ByteLevel with use_regex
		"claude/decode#single_zero",       // a special token decodes to its text, not to nothing
		"deepseek/decode#single_zero",     // an empty piece
		"claude/decode#out_of_range",      // an unknown id decodes to one empty chunk
		"claude/decode#roundtrip_emoji",   // partial-byte chunks
		"openai/count#claude#simple",      // the array join
	} {
		if _, ok := fixture.Responses[name]; !ok {
			t.Fatalf("required oracle case %q is missing from the fixture", name)
		}
	}
}

func hfRouteModel(path string) string {
	for _, model := range hfModels {
		if path == "/api/tokenizers/"+model+"/encode" || path == "/api/tokenizers/"+model+"/decode" {
			return model
		}
	}
	return ""
}

func replayHFEncode(t *testing.T, name string, capture oracleCase, processor *HF) {
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
	ids, err := processor.Encode(text)
	if err != nil {
		t.Fatalf("%s: encode: %v", name, err)
	}
	if !equalIntSlices(ids, want.IDs) {
		t.Fatalf("%s: ids = %v, pinned %v", name, ids, want.IDs)
	}
	if want.Count != len(ids) {
		t.Fatalf("%s: pinned count %d does not match %d ids", name, want.Count, len(ids))
	}
	chunks, err := processor.Chunks(ids)
	if err != nil {
		t.Fatalf("%s: chunks: %v", name, err)
	}
	if !equalStrings(chunks, want.Chunks) {
		t.Fatalf("%s: chunks = %q, pinned %q", name, chunks, want.Chunks)
	}
}

// replayHFDecode replays the HF decode route, which differs from the SentencePiece one: the
// pinned handler decodes the whole id sequence at once (`instance.decode(new Int32Array(ids))`)
// and derives chunks with the incremental algorithm, where the SentencePiece handler decodes
// each id separately and joins. A partial-byte id sequence therefore decodes as one character
// here and as replacement characters there.
func replayHFDecode(t *testing.T, name string, capture oracleCase, processor *HF) {
	t.Helper()
	ids := requestIDs(t, name, capture.Request.Body)
	var want struct {
		Text   string   `json:"text"`
		Chunks []string `json:"chunks"`
	}
	if err := json.Unmarshal(capture.Body, &want); err != nil {
		t.Fatalf("%s: pinned body is not a decode response: %v", name, err)
	}
	text, err := processor.DecodeIDs(ids)
	if err != nil {
		t.Fatalf("%s: decode: %v", name, err)
	}
	if text != want.Text {
		t.Fatalf("%s: text = %q, pinned %q", name, text, want.Text)
	}
	chunks, err := processor.Chunks(ids)
	if err != nil {
		t.Fatalf("%s: chunks: %v", name, err)
	}
	if !equalStrings(chunks, want.Chunks) {
		t.Fatalf("%s: chunks = %q, pinned %q", name, chunks, want.Chunks)
	}
}

func replayHFCount(t *testing.T, name string, capture oracleCase, processor *HF) {
	t.Helper()
	var want struct {
		TokenCount float64 `json:"token_count"`
	}
	if err := json.Unmarshal(capture.Body, &want); err != nil {
		t.Fatalf("%s: pinned body is not a count response: %v", name, err)
	}
	messages, err := DecodeOrderedMessages(capture.Request.Body)
	if err != nil {
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
	if got := processor.CountArrayTokens(messages); float64(got) != want.TokenCount {
		t.Fatalf("%s: token_count = %d, pinned %v", name, got, want.TokenCount)
	}
}

// TestHFPostProcessorIsNotApplied pins the fact the tokenizer files contradict: three of the
// seven declare a TemplateProcessing post-processor that would prepend a BOS, and the pinned
// capture shows it is never applied.
func TestHFPostProcessorIsNotApplied(t *testing.T) {
	processors := openHFSet(t)
	for _, name := range []string{"command-r", "command-a", "nemo"} {
		ids, err := processors[name].Encode("Hello, world!")
		if err != nil {
			t.Fatal(err)
		}
		if len(ids) == 0 {
			t.Fatalf("%s encoded nothing", name)
		}
		if ids[0] == 5 || ids[0] == 1 || ids[0] == 6 {
			t.Fatalf("%s prepended a post-processor token: %v", name, ids)
		}
	}
}

// TestHFNormalizerShapes pins that an absent normalizer and an empty Sequence are both
// no-ops, which is the difference between the pinned nemo and deepseek files.
func TestHFNormalizerShapes(t *testing.T) {
	processors := openHFSet(t)
	for _, name := range []string{"llama3", "nemo", "deepseek"} {
		if processors[name].applyNormalizer {
			t.Fatalf("%s has a normalizer form, want none", name)
		}
	}
	if !processors["claude"].applyNormalizer {
		t.Fatal("claude has no normalizer form, want NFKC")
	}
	if !processors["qwen2"].applyNormalizer {
		t.Fatal("qwen2 has no normalizer form, want NFC")
	}
}

// TestHFAddedTokenLongestMatch pins the added-token matcher's longest-match rule in isolation.
//
// This is WEAKER evidence than an oracle case and is labelled as such: it proves the rule as
// written. It is also the only way to pin it, because no pinned tokenizer declares one added
// token as a strict prefix of another — 0 pairs across the 2160 added tokens in the seven
// files — so no input against the pinned data can discriminate longest-match from first-match.
func TestHFAddedTokenLongestMatch(t *testing.T) {
	// The index is built SHORTEST FIRST on purpose: a matcher that simply took the first
	// candidate would then choose <A>, so this asserts the length comparison itself rather
	// than the order ParseHF happens to produce.
	tokenizer := &HF{
		addedTokens: []hfAddedToken{{Content: "<A>", ID: 7}, {Content: "<AB>", ID: 8}, {Content: "<ABC>", ID: 9}},
		addedByByte: map[byte][]hfAddedToken{},
	}
	for _, added := range tokenizer.addedTokens {
		tokenizer.addedByByte[added.Content[0]] = append(tokenizer.addedByByte[added.Content[0]], added)
	}

	segments := tokenizer.splitAddedTokens("x<ABC>y")
	if len(segments) != 3 {
		t.Fatalf("segments = %+v, want three (plain, added, plain)", segments)
	}
	if segments[1].addedID != 9 || segments[1].text != "<ABC>" {
		t.Fatalf("the added segment is %q id %d, want <ABC> id 9: the longest match must win", segments[1].text, segments[1].addedID)
	}
	if segments[0].text != "x" || segments[2].text != "y" {
		t.Fatalf("plain segments = %q and %q, want x and y", segments[0].text, segments[2].text)
	}

	// A token that matches exactly is still matched on its own.
	segments = tokenizer.splitAddedTokens("<A>")
	if len(segments) != 1 || segments[0].addedID != 7 {
		t.Fatalf("exact match segments = %+v, want <A> id 7", segments)
	}
}
