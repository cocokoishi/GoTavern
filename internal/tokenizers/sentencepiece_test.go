package tokenizers

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

// The SentencePiece engine is measured against the same pinned capture as the tiktoken
// engine. The decode cases are per-id and joined, because that is exactly what the pinned
// decode route does (ids.map(id => instance.decodeIds([id]))), and it is why a single
// separator disappears from every chunk.

const sentencePieceDataPath = "../../upstream/tokenizers"

// Explicit replay counts, so a probe that stops recording a family fails the build.
const (
	wantSentencePieceEncodeCases  = 203 // 7 models x 29 inputs
	wantSentencePieceDecodeCases  = 49  // 7 models x 7 id cases
	wantOpenAISentencePieceEncode = 40  // llama, mistral, yi, gemma, jamba x 8 inputs
	wantOpenAISentencePieceDecode = 6   // llama, gemma x 3 id cases
	wantOpenAISentencePieceCount  = 34  // llama, gemma x 17 bodies
	// Request-shape cases recorded under a tokenizer route whose body is not a text
	// request. They belong to the route layer (P4), not to the engine, and the count is
	// asserted so a new one cannot slip past this test unnoticed.
	wantSentencePieceRouteOnlyCases = 4
)

// hasTextRequest reports whether the recorded request is a text-request body.
func hasTextRequest(capture oracleCase) bool {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(capture.Request.Body, &body); err != nil {
		return false
	}
	_, ok := body["text"]
	return ok
}

var sentencePieceModels = []string{"llama", "nerdstash", "nerdstash_v2", "mistral", "yi", "gemma", "jamba"}

func openSentencePieceSet(t *testing.T) map[string]*SentencePiece {
	t.Helper()
	processors := map[string]*SentencePiece{}
	for _, name := range sentencePieceModels {
		processor, err := OpenSentencePiece(filepath.Join(filepath.Clean(sentencePieceDataPath), name+".model"))
		if err != nil {
			t.Fatal(err)
		}
		processors[name] = processor
	}
	return processors
}

// sentencePieceFamily reports the SentencePiece model that serves a query model, or "" when
// the query model belongs to another backend.
func sentencePieceFamily(queryModel string) string {
	switch GetTokenizerModel(queryModel) {
	case "llama", "nerdstash", "nerdstash_v2", "mistral", "yi", "gemma", "jamba":
		return GetTokenizerModel(queryModel)
	}
	return ""
}

func TestSentencePieceMatchesPinnedOracle(t *testing.T) {
	fixture := loadOracle(t)
	processors := openSentencePieceSet(t)

	replayed := map[string]int{}
	for name, capture := range fixture.Responses {
		switch capture.Request.Path {
		case "/api/tokenizers/llama/encode", "/api/tokenizers/nerdstash/encode", "/api/tokenizers/nerdstash_v2/encode",
			"/api/tokenizers/mistral/encode", "/api/tokenizers/yi/encode", "/api/tokenizers/gemma/encode", "/api/tokenizers/jamba/encode":
			model := routeModel(capture.Request.Path)
			if !hasTextRequest(capture) {
				replayed["route-only"]++
				continue
			}
			replayed["encode"]++
			replaySentencePieceEncode(t, name, capture, processors[model])
		case "/api/tokenizers/llama/decode", "/api/tokenizers/nerdstash/decode", "/api/tokenizers/nerdstash_v2/decode",
			"/api/tokenizers/mistral/decode", "/api/tokenizers/yi/decode", "/api/tokenizers/gemma/decode", "/api/tokenizers/jamba/decode":
			model := routeModel(capture.Request.Path)
			replayed["decode"]++
			replaySentencePieceDecode(t, name, capture, processors[model])
		case "/api/tokenizers/openai/encode":
			query := queryModel(t, name, capture.Request.Query)
			model := sentencePieceFamily(query)
			if model == "" {
				continue
			}
			replayed["openai/encode"]++
			replaySentencePieceEncode(t, name, capture, processors[model])
		case "/api/tokenizers/openai/decode":
			query := queryModel(t, name, capture.Request.Query)
			model := sentencePieceFamily(query)
			if model == "" {
				continue
			}
			replayed["openai/decode"]++
			replaySentencePieceDecode(t, name, capture, processors[model])
		case "/api/tokenizers/openai/count":
			query := queryModel(t, name, capture.Request.Query)
			model := sentencePieceFamily(query)
			if model == "" {
				continue
			}
			replayed["openai/count"]++
			replaySentencePieceCount(t, name, capture, processors[model])
		}
	}

	want := map[string]int{
		"encode":        wantSentencePieceEncodeCases,
		"decode":        wantSentencePieceDecodeCases,
		"openai/encode": wantOpenAISentencePieceEncode,
		"openai/decode": wantOpenAISentencePieceDecode,
		"openai/count":  wantOpenAISentencePieceCount,
		"route-only":    wantSentencePieceRouteOnlyCases,
	}
	for group, count := range want {
		if replayed[group] != count {
			t.Fatalf("replayed %d %s cases, want %d; the fixture or the dispatch changed", replayed[group], group, count)
		}
	}

	// Named cases that pin the quirks rather than the volume.
	for _, name := range []string{
		"llama/encode#ascii",               // the dummy prefix adds a leading separator
		"nerdstash/encode#ascii",           // no dummy prefix for this model
		"llama/encode#only_spaces",         // the normalizer does not collapse whitespace
		"llama/encode#emoji",               // byte fallback emits <0x..> pieces
		"llama/encode#lone_surrogate",      // an unpaired surrogate becomes the replacement character
		"llama/decode#roundtrip_ascii",     // per-id decode drops the separator
		"llama/decode#out_of_range",        // an unknown id decodes to an empty chunk, not an error
		"llama/decode#single_zero",         // the unknown piece emits unk_surface
		"gemma/decode#single_zero",         // a control piece emits nothing
		"llama/decode#roundtrip_emoji",     // byte pieces decode per id, not as a run
		"openai/count#llama#simple",        // the array join
		"openai/count#gemma#array_content", // JavaScript value coercion in the join
	} {
		if _, ok := fixture.Responses[name]; !ok {
			t.Fatalf("required oracle case %q is missing from the fixture", name)
		}
	}
}

func routeModel(path string) string {
	for _, model := range sentencePieceModels {
		if path == "/api/tokenizers/"+model+"/encode" || path == "/api/tokenizers/"+model+"/decode" {
			return model
		}
	}
	return ""
}

func replaySentencePieceEncode(t *testing.T, name string, capture oracleCase, processor *SentencePiece) {
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
	ids, chunks := processor.Encode(text)
	if !equalIntSlices(ids, want.IDs) {
		t.Fatalf("%s: ids = %v, pinned %v", name, ids, want.IDs)
	}
	if want.Count != len(ids) {
		t.Fatalf("%s: pinned count %d does not match %d ids", name, want.Count, len(ids))
	}
	if !equalStrings(chunks, want.Chunks) {
		t.Fatalf("%s: chunks = %q, pinned %q", name, chunks, want.Chunks)
	}
}

func replaySentencePieceDecode(t *testing.T, name string, capture oracleCase, processor *SentencePiece) {
	t.Helper()
	ids := requestIDs(t, name, capture.Request.Body)
	var want struct {
		Text   string   `json:"text"`
		Chunks []string `json:"chunks"`
	}
	if err := json.Unmarshal(capture.Body, &want); err != nil {
		t.Fatalf("%s: pinned body is not a decode response: %v", name, err)
	}
	// The pinned route decodes each id on its own and joins the results.
	chunks := make([]string, 0, len(ids))
	for _, id := range ids {
		chunks = append(chunks, processor.DecodeSingle(id))
	}
	text := ""
	for _, chunk := range chunks {
		text += chunk
	}
	if text != want.Text {
		t.Fatalf("%s: text = %q, pinned %q", name, text, want.Text)
	}
	if !equalStrings(chunks, want.Chunks) {
		t.Fatalf("%s: chunks = %q, pinned %q", name, chunks, want.Chunks)
	}
}

func replaySentencePieceCount(t *testing.T, name string, capture oracleCase, processor *SentencePiece) {
	t.Helper()
	var want struct {
		TokenCount float64 `json:"token_count"`
	}
	if err := json.Unmarshal(capture.Body, &want); err != nil {
		t.Fatalf("%s: pinned body is not a count response: %v", name, err)
	}
	messages, err := DecodeOrderedMessages(capture.Request.Body)
	if err != nil {
		// Pinned: the flatMap throws and the route's outer catch guesstimates
		// JSON.stringify(req.body), exactly as on the tiktoken path.
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

func equalIntSlices(left, right []int) bool {
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

// TestSentencePieceModelFacts pins the model properties this engine depends on, so a
// different .model file cannot silently change what is implemented.
func TestSentencePieceModelFacts(t *testing.T) {
	processors := openSentencePieceSet(t)
	wantPieces := map[string]int{
		"llama": 32000, "mistral": 32000, "yi": 64000, "nerdstash": 65535,
		"nerdstash_v2": 65535, "jamba": 65536, "gemma": 256000,
	}
	wantDummyPrefix := map[string]bool{
		"llama": true, "mistral": true, "yi": false, "nerdstash": false,
		"nerdstash_v2": false, "jamba": false, "gemma": false,
	}
	for name, processor := range processors {
		if len(processor.pieces) != wantPieces[name] {
			t.Fatalf("%s has %d pieces, want %d", name, len(processor.pieces), wantPieces[name])
		}
		if processor.addDummyPrefix != wantDummyPrefix[name] {
			t.Fatalf("%s add_dummy_prefix = %v, want %v", name, processor.addDummyPrefix, wantDummyPrefix[name])
		}
		if !processor.byteFallback || len(processor.byteToID) != 256 {
			t.Fatalf("%s byte fallback = %v with %d byte pieces", name, processor.byteFallback, len(processor.byteToID))
		}
		if processor.removeExtraWhitespaces {
			t.Fatalf("%s removes extra whitespace, which the engine does not model", name)
		}
		if processor.unkSurface != " \u2047 " {
			t.Fatalf("%s unk_surface = %q", name, processor.unkSurface)
		}
	}
}

func TestSentencePieceDecodeRules(t *testing.T) {
	processors := openSentencePieceSet(t)
	llama := processors["llama"]

	// The unknown piece emits the model's unk_surface; a control piece emits nothing.
	if got := llama.DecodeSingle(llama.unkID); got != " \u2047 " {
		t.Fatalf("unk id decodes to %q, want the unk_surface", got)
	}
	// A single byte piece is its own replacement character, while a complete run decodes.
	single := llama.DecodeSingle(llama.byteToID[0xF0])
	if single != "\uFFFD" {
		t.Fatalf("a lone 0xF0 byte piece decodes to %q", single)
	}
	emoji := []int{llama.byteToID[0xF0], llama.byteToID[0x9F], llama.byteToID[0x98], llama.byteToID[0x80]}
	text, err := llama.DecodeIDs(emoji)
	if err != nil || text != "\U0001F600" {
		t.Fatalf("a complete byte run decodes to %q (%v)", text, err)
	}
	// A truncated run replaces each byte, which is not the TextDecoder maximal-subpart rule.
	truncated, _ := llama.DecodeIDs(emoji[:2])
	if truncated != "\uFFFD\uFFFD" {
		t.Fatalf("a truncated byte run decodes to %q, want two replacements", truncated)
	}
	// An out-of-range id yields the empty string rather than an error. The route needs the
	// distinction: the pinned decode route builds one chunk per requested id, so a failing
	// call would drop the chunk list while an empty result keeps it.
	if text, err := llama.DecodeIDs([]int{999999}); err != nil || text != "" {
		t.Fatalf("out-of-range id: text = %q, err = %v; want empty text and no error", text, err)
	}
	if text, err := llama.DecodeIDs([]int{-1}); err != nil || text != "" {
		t.Fatalf("negative id: text = %q, err = %v; want empty text and no error", text, err)
	}
	if got := llama.DecodeSingle(999999); got != "" {
		t.Fatalf("an out-of-range id decodes to %q", got)
	}
	if got := llama.DecodeSingle(-1); got != "" {
		t.Fatalf("a negative id decodes to %q", got)
	}
	// The sequence decoder drops exactly one leading separator.
	space, _ := llama.DecodeIDs([]int{llama.pieceToID["\u2581a"], llama.pieceToID["\u2581b"]})
	if space != "a b" {
		t.Fatalf("sequence decode = %q, want %q", space, "a b")
	}
	emptyIDs, emptyChunks := llama.Encode("")
	if len(emptyIDs) != 0 || len(emptyChunks) != 0 {
		t.Fatalf("encoding the empty string returned %v / %q", emptyIDs, emptyChunks)
	}
}
