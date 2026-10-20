package server

// Pinned tokenizer routes, from src/endpoints/tokenizers.js.
//
// This file owns the encode routes first (tokenizers.js:739-753) because they are the ones
// the pinned capture measures most heavily, and the shared asset loader they need. The decode,
// openai/* and remote/* routes follow in later increments; until a route exists here it stays
// `not implemented` in the inventory.
//
// Two requirements from docs/tokenizer-parity-plan.md are honoured here rather than left to
// the engines:
//
//   - §6.1: the `text` field is decoded with tokenizers.UnescapeJSONString, not
//     encoding/json. Go replaces an unpaired surrogate escape with U+FFFD before any
//     tokenizer sees it, while the pinned server keeps the code unit and each backend then
//     converts it differently, so a route that used encoding/json would silently be inexact
//     on that input class and no engine test would notice.
//   - The release asset tree is read from disk, never embedded (P1 decision), because the
//     tokenizer data is large and its integrity is manifest-based.
//
// Known gap, recorded for the Lead rather than papered over: the pinned server reads
// `enableDownloadableTokenizers` and falls back to llama3.json when downloads are disabled
// and the cache is cold. That config value has no field in HTTPHandlerOptions yet, so this
// increment implements the cache-first and materialize-from-vendored paths only, and does not
// claim the disabled-downloads fallback.

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/cocokoishi/gotavern/internal/tokenizers"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerTokenizerRoutes)
}

// tokenizerSentencePieceModels are the models served by the SentencePiece engine, in the
// pinned route order.
var tokenizerSentencePieceModels = []string{"llama", "nerdstash", "nerdstash_v2", "mistral", "yi", "gemma", "jamba"}

// tokenizerWebModels are the models served by the HuggingFace engine.
var tokenizerWebModels = []string{"claude", "llama3", "qwen2", "command-r", "command-a", "nemo", "deepseek"}

// tokenizerExternalAssetModels are the five the pinned server fetches from a mutable branch and
// GoTavern pins as vendored assets.
var tokenizerExternalAssetModels = []string{"qwen2", "command-r", "command-a", "nemo", "deepseek"}

func registerTokenizerRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	for _, model := range tokenizerSentencePieceModels {
		model := model
		post("/api/tokenizers/"+model+"/encode", func(w http.ResponseWriter, r *http.Request) {
			accounts.serveSentencePieceEncode(w, r, model)
		})
		post("/api/tokenizers/"+model+"/decode", func(w http.ResponseWriter, r *http.Request) {
			accounts.serveSentencePieceDecode(w, r, model)
		})
	}
	post("/api/tokenizers/gpt2/encode", accounts.serveTiktokenEncode)
	post("/api/tokenizers/gpt2/decode", accounts.serveTiktokenDecode)
	for _, model := range tokenizerWebModels {
		model := model
		post("/api/tokenizers/"+model+"/encode", func(w http.ResponseWriter, r *http.Request) {
			accounts.serveWebTokenizerEncode(w, r, model)
		})
		post("/api/tokenizers/"+model+"/decode", func(w http.ResponseWriter, r *http.Request) {
			accounts.serveWebTokenizerDecode(w, r, model)
		})
	}
	post("/api/tokenizers/openai/encode", accounts.serveOpenAITokenizerEncode)
	post("/api/tokenizers/openai/decode", accounts.serveOpenAITokenizerDecode)
	post("/api/tokenizers/openai/count", accounts.serveOpenAITokenizerCount)
}

// --- asset loading ---------------------------------------------------------------------

// tokenizerAssetCandidates lists where the release may place the vendored tokenizer tree,
// most specific first: <InstallRoot>/tokenizers (the release layout, matching how the
// frontend tree is placed at <InstallRoot>/public) and <InstallRoot>/upstream/tokenizers
// (the development layout, where the repository root holds the vendored tree).
func tokenizerAssetCandidates(options HTTPHandlerOptions) []string {
	if options.InstallRoot == "" {
		return nil
	}
	return []string{
		filepath.Join(options.InstallRoot, "tokenizers"),
		filepath.Join(options.InstallRoot, "upstream", "tokenizers"),
	}
}

// tokenizerAssets resolves the vendored tree, or reports that none is present.
func tokenizerAssets(options HTTPHandlerOptions) (string, bool) {
	for _, candidate := range tokenizerAssetCandidates(options) {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate, true
		}
	}
	return "", false
}

// tokenizerCacheKey identifies one loaded set, so two handlers over the same roots share the
// engines exactly as the pinned module-level caches do.
type tokenizerCacheKey struct {
	assets string
	cache  string
}

var (
	tokenizerSetMu    sync.Mutex
	tokenizerSetCache = map[tokenizerCacheKey]*tokenizerSet{}
)

// tokenizerSet is the lazily loaded engine set for one asset root. Loading is per engine on
// first use, mirroring the pinned tokenizersCache.
type tokenizerSet struct {
	assets string
	cache  string

	mu             sync.Mutex
	sentencePieces map[string]*tokenizers.SentencePiece
	tiktokenSet    *tokenizers.TiktokenSet
	webTokenizers  map[string]*tokenizers.HF
}

func openTokenizerSet(options HTTPHandlerOptions) (*tokenizerSet, bool) {
	assets, ok := tokenizerAssets(options)
	if !ok {
		return nil, false
	}
	key := tokenizerCacheKey{assets: assets, cache: filepath.Join(options.DataRoot, "_cache")}
	tokenizerSetMu.Lock()
	defer tokenizerSetMu.Unlock()
	if existing, ok := tokenizerSetCache[key]; ok {
		return existing, true
	}
	set := &tokenizerSet{
		assets:         assets,
		cache:          key.cache,
		sentencePieces: map[string]*tokenizers.SentencePiece{},
		webTokenizers:  map[string]*tokenizers.HF{},
	}
	tokenizerSetCache[key] = set
	return set, true
}

func (set *tokenizerSet) sentencePiece(model string) (*tokenizers.SentencePiece, error) {
	set.mu.Lock()
	defer set.mu.Unlock()
	if cached, ok := set.sentencePieces[model]; ok {
		return cached, nil
	}
	processor, err := tokenizers.OpenSentencePiece(filepath.Join(set.assets, model+".model"))
	if err != nil {
		return nil, err
	}
	set.sentencePieces[model] = processor
	return processor, nil
}

func (set *tokenizerSet) tiktoken() (*tokenizers.TiktokenSet, error) {
	set.mu.Lock()
	defer set.mu.Unlock()
	if set.tiktokenSet != nil {
		return set.tiktokenSet, nil
	}
	loaded, err := tokenizers.OpenTiktokenSet(filepath.Join(set.assets, "tiktoken"))
	if err != nil {
		return nil, err
	}
	set.tiktokenSet = loaded
	return loaded, nil
}

// web returns the HuggingFace tokenizer for a model, following the pinned resolution order:
// an uncompressed file in <DataRoot>/_cache wins, then the vendored gzipped asset, which is
// materialized into the cache the way the pinned server materializes a manual download.
func (set *tokenizerSet) web(model string) (*tokenizers.HF, error) {
	set.mu.Lock()
	defer set.mu.Unlock()
	if cached, ok := set.webTokenizers[model]; ok {
		return cached, nil
	}
	raw, err := set.webBytes(model)
	if err != nil {
		return nil, err
	}
	processor, err := tokenizers.ParseHF(model, raw)
	if err != nil {
		return nil, err
	}
	set.webTokenizers[model] = processor
	return processor, nil
}

func (set *tokenizerSet) webBytes(model string) ([]byte, error) {
	isExternal := false
	for _, external := range tokenizerExternalAssetModels {
		if external == model {
			isExternal = true
			break
		}
	}
	if !isExternal {
		return os.ReadFile(filepath.Join(set.assets, model+".json"))
	}
	if set.cache != "" {
		if raw, err := os.ReadFile(filepath.Join(set.cache, model+".json")); err == nil {
			return raw, nil
		}
	}
	compressed, err := os.ReadFile(filepath.Join(set.assets, "external", model+".json.gz"))
	if err != nil {
		return nil, err
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	raw, err := io.ReadAll(reader)
	if err != nil {
		return nil, err
	}
	if set.cache != "" {
		if err := os.MkdirAll(set.cache, 0o755); err == nil {
			_ = os.WriteFile(filepath.Join(set.cache, model+".json"), raw, 0o644)
		}
	}
	return raw, nil
}

// --- request and response shapes -------------------------------------------------------

// tokenizerTextRequest reproduces the pinned `request.body.text || ”`, including its
// behaviour for a body that is not an object: `request.body` is an array or a scalar, the
// property is absent, and the handler proceeds with the empty string. Only a body the pinned
// body parser would reject is an error. The text value itself is decoded with
// UnescapeJSONString rather than encoding/json, for the reason in the file header.
func tokenizerTextRequest(request *http.Request) (string, bool) {
	body, err := io.ReadAll(io.LimitReader(request.Body, 500<<20))
	if err != nil {
		return "", false
	}
	if len(body) == 0 {
		return "", true
	}
	input := map[string]json.RawMessage{}
	if err := json.Unmarshal(body, &input); err != nil {
		var anyBody any
		if json.Unmarshal(body, &anyBody) != nil {
			return "", false
		}
		return "", true
	}
	raw, present := input["text"]
	if !present || len(raw) == 0 || string(raw) == "null" || raw[0] != '"' {
		// The pinned `|| ''` keeps a non-string value, and the tokenizers then coerce or
		// throw; GoTavern treats a non-string text as the empty string rather than guessing.
		return "", true
	}
	text, err := tokenizers.UnescapeJSONString(raw)
	if err != nil {
		return "", true
	}
	return text, true
}

type tokenizerEncodeResponse struct {
	IDs    []int    `json:"ids"`
	Count  int      `json:"count"`
	Chunks []string `json:"chunks"`
}

type tokenizerCountResponse struct {
	Count int `json:"token_count"`
}

func (runtime *accountRuntime) serveSentencePieceEncode(w http.ResponseWriter, request *http.Request, model string) {
	text, ok := tokenizerTextRequest(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	set, present := openTokenizerSet(runtime.options)
	if !present {
		respondJSON(w, http.StatusOK, tokenizerEncodeResponse{IDs: []int{}, Count: tokenizers.Guesstimate(text), Chunks: nil})
		return
	}
	processor, err := set.sentencePiece(model)
	if err != nil {
		respondJSON(w, http.StatusOK, tokenizerEncodeResponse{IDs: []int{}, Count: tokenizers.Guesstimate(text), Chunks: nil})
		return
	}
	ids, chunks := processor.Encode(text)
	respondJSON(w, http.StatusOK, tokenizerEncodeResponse{IDs: ids, Count: len(ids), Chunks: chunks})
}

func (runtime *accountRuntime) serveTiktokenEncode(w http.ResponseWriter, request *http.Request) {
	text, ok := tokenizerTextRequest(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	set, present := openTokenizerSet(runtime.options)
	if !present {
		respondJSON(w, http.StatusOK, tokenizerEncodeResponse{IDs: []int{}, Count: 0, Chunks: []string{}})
		return
	}
	loaded, err := set.tiktoken()
	if err != nil {
		respondJSON(w, http.StatusOK, tokenizerEncodeResponse{IDs: []int{}, Count: 0, Chunks: []string{}})
		return
	}
	encoding, err := loaded.Encoding("gpt2")
	if err != nil {
		respondJSON(w, http.StatusOK, tokenizerEncodeResponse{IDs: []int{}, Count: 0, Chunks: []string{}})
		return
	}
	ids, err := encoding.Encode(text)
	if err != nil {
		respondJSON(w, http.StatusOK, tokenizerEncodeResponse{IDs: []int{}, Count: 0, Chunks: []string{}})
		return
	}
	chunks, err := encoding.Chunks(ids)
	if err != nil {
		respondJSON(w, http.StatusOK, tokenizerEncodeResponse{IDs: []int{}, Count: 0, Chunks: []string{}})
		return
	}
	respondJSON(w, http.StatusOK, tokenizerEncodeResponse{IDs: ids, Count: len(ids), Chunks: chunks})
}

func (runtime *accountRuntime) serveWebTokenizerEncode(w http.ResponseWriter, request *http.Request, model string) {
	text, ok := tokenizerTextRequest(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	set, present := openTokenizerSet(runtime.options)
	if !present {
		respondJSON(w, http.StatusOK, tokenizerEncodeResponse{IDs: []int{}, Count: 0, Chunks: []string{}})
		return
	}
	processor, err := set.web(model)
	if err != nil {
		respondJSON(w, http.StatusOK, tokenizerEncodeResponse{IDs: []int{}, Count: 0, Chunks: []string{}})
		return
	}
	ids, err := processor.Encode(text)
	if err != nil {
		respondJSON(w, http.StatusOK, tokenizerEncodeResponse{IDs: []int{}, Count: 0, Chunks: []string{}})
		return
	}
	chunks, err := processor.Chunks(ids)
	if err != nil {
		respondJSON(w, http.StatusOK, tokenizerEncodeResponse{IDs: []int{}, Count: 0, Chunks: []string{}})
		return
	}
	respondJSON(w, http.StatusOK, tokenizerEncodeResponse{IDs: ids, Count: len(ids), Chunks: chunks})
}

// tokenizerJSONShape is used by the tests to confirm a response is the pinned object shape.
func tokenizerJSONShape(raw []byte) (map[string]json.RawMessage, error) {
	shape := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &shape); err != nil {
		return nil, fmt.Errorf("not a JSON object: %w", err)
	}
	return shape, nil
}

var _ = strings.TrimSpace
