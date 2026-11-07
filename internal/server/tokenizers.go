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
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/cocokoishi/gotavern/internal/fsretry"
	"github.com/cocokoishi/gotavern/internal/httpx"
	"github.com/cocokoishi/gotavern/internal/tokenizers"
)

// tokenizerSentencePieceModels are the models served by the SentencePiece engine, in the
// pinned route order.
var tokenizerSentencePieceModels = []string{"llama", "nerdstash", "nerdstash_v2", "mistral", "yi", "gemma", "jamba"}

// tokenizerWebModels are the models served by the HuggingFace engine.
var tokenizerWebModels = []string{"claude", "llama3", "qwen2", "command-r", "command-a", "nemo", "deepseek"}

// tokenizerExternalAssetModels are the five the pinned server fetches from a mutable branch and
// GoTavern pins as vendored assets.
var tokenizerExternalAssetModels = []string{"qwen2", "command-r", "command-a", "nemo", "deepseek"}

func registerTokenizerRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	// THE FALLBACK IS ANNOUNCED ONCE, HERE, AND ON EVERY RESPONSE (see the exactness section
	// below). Construction time is where an operator's log has room for a full sentence; the
	// per-request header is what a gate can assert. Both are computed by tokenizerExactnessStatus,
	// the SAME function, so they cannot disagree about what "exact" means: the line below records
	// the state at boot, the header records the state of the request it is attached to.
	status := tokenizerExactnessStatus(options)
	if !status.Exact {
		consoleWarnf(tokenizerConsoleWriter(options), "GoTavern: %s: no tokenizer tree under %q (tried %s); /api/tokenizers answers estimated counts, so a context boundary measured against this server is not exact\n",
			tokenizerGuesstimateMarker, options.InstallRoot, strings.Join(tokenizerAssetCandidates(options), ", "))
	}
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			// Re-resolved per request, not captured from the line above: the header must describe
			// the tree THIS request will read, and openTokenizerSet resolves it per request too.
			// A boot-time copy of the status could disagree with the behaviour it describes.
			tokenizerExactnessStatus(options).annotate(w)
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
	post("/api/tokenizers/remote/kobold/count", accounts.serveRemoteKoboldCount)
	post("/api/tokenizers/remote/textgenerationwebui/encode", accounts.serveRemoteTextGenerationEncode)
}

// --- asset loading ---------------------------------------------------------------------

// tokenizerAssetCandidates lists where the tokenizer tree may be found, most specific first:
//
//	<InstallRoot>/src/tokenizers       the RELEASE layout AND the pinned SillyTavern layout, which are the
//	                                   same path on purpose (see below)
//	<InstallRoot>/tokenizers           the layout release v0.1.0-alpha.1 shipped, kept as a fallback so an
//	                                   installation made from it still tokenizes exactly
//	<InstallRoot>/upstream/tokenizers  the development layout, where the repository root holds the tree
//
// THE PINNED LOCATION IS NOT A NICETY. Upstream reads these files SERVER-SIDE by a path relative to its own
// working directory -- `new SentencePieceTokenizer('src/tokenizers/llama.model')` in
// src/endpoints/tokenizers.js:251-254, and the same shape for the HuggingFace JSONs -- so `src/tokenizers/` is
// where a real SillyTavern tree keeps them. They are NOT served over HTTP: the only static mount upstream has is
// `express.static(path.join(serverDirectory, 'public'))` (server-main.js:242), so no client can fetch
// `/src/tokenizers/...` and nothing needs to serve that path here.
//
// Without this candidate a MIGRATED installation (a SillyTavern directory GoTavern is pointed at, which has
// src/tokenizers/ and not tokenizers/) found no tree at all, and the failure was silent: the routes fall back to
// the Guesstimate path and keep answering with token counts that are simply wrong. That is the worst shape a
// tokenizer defect can take, which is why the migration layout is a candidate rather than a documented caveat.
//
// The order matters and is deliberate. `src/tokenizers` is FIRST because it is now BOTH the pinned layout and the
// release layout: the published archive ships the tree there, so that is the copy a fresh install should use, and
// a stale `tokenizers/` left behind by release v0.1.0-alpha.1 must not win over it after an upgrade in place. The
// legacy root path is second rather than deleted, because an installation made from that release must keep
// tokenizing exactly after the binary is updated without re-running the installer.
func tokenizerAssetCandidates(options HTTPHandlerOptions) []string {
	if options.InstallRoot == "" {
		return nil
	}
	return []string{
		filepath.Join(options.InstallRoot, "src", "tokenizers"),
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

// tokenizerLayout names the discovery level a resolved tree came from, derived from the resolved
// path so the label and the precedence cannot drift apart: the order lives in
// tokenizerAssetCandidates and nowhere else.
func tokenizerLayout(options HTTPHandlerOptions, assets string) string {
	if assets == "" {
		return tokenizerLayoutNone
	}
	relative, err := filepath.Rel(options.InstallRoot, assets)
	if err != nil {
		return filepath.ToSlash(assets)
	}
	return filepath.ToSlash(relative)
}

// --- exactness: an inexact count must be distinguishable from an exact one -----------------
//
// THE GAP THIS CLOSES. With no tokenizer tree the routes answer with the pinned Guesstimate
// fallback (tokenizers.Guesstimate, from src/endpoints/tokenizers.js:68-72, used at :373, :551
// and :1032), and the response carries exactly the same fields as an exact one: a `count`
// number. Nothing in the body says whether that number came from a tokenizer or from
// ceil(bytes/3.35), so a client cannot tell, and neither can a test.
//
// IT CANNOT BE CLOSED IN THE BODY. The tokenizer response body is compared key-for-key AND
// order-for-order against the pinned recording (tokenizers_test.go:192 asserts
// `ids,count,chunks`), so a body field would have to either appear on every response -- and
// diverge from every pinned capture for a fact that is true of the pinned server's own layout --
// or appear only on the guesstimate path, which is the input a client can least afford to
// special-case. The marker is therefore a response HEADER pair, which is additive for clients
// that ignore it and leaves the pinned body byte-identical:
//
//	X-GoTavern-Tokenizer-Exact:  "true" | "false"
//	X-GoTavern-Tokenizer-Layout: "src/tokenizers" | "tokenizers" | "upstream/tokenizers" | "none"
//
// Both are always present on every /api/tokenizers route, including its 400 and its GET
// fall-through, so ABSENCE IS NEVER SILENTLY EXACT: a gate that finds no header refuses rather
// than assuming. The layout value is what makes the release claim checkable from the outside --
// the archive promises src/tokenizers/, so a tree resolving from `tokenizers/` or `none` is
// visible as the packaging difference it is instead of being folded into "exact".
//
// AND ONCE IN THE LOG, with a stable marker, so an operator who is not reading HTTP headers sees
// why a context boundary on this server is not exact.

const (
	// tokenizerExactHeader reports whether this server can tokenize exactly.
	tokenizerExactHeader = "X-GoTavern-Tokenizer-Exact"
	// tokenizerLayoutHeader reports WHICH discovery level answered, or "none".
	tokenizerLayoutHeader = "X-GoTavern-Tokenizer-Layout"
	// tokenizerLayoutNone is the layout value when no tree resolved.
	tokenizerLayoutNone = "none"
	// tokenizerGuesstimateMarker is the stable substring of the operator log line, greppable and
	// asserted by tests rather than described in prose.
	tokenizerGuesstimateMarker = "tokenizer-guesstimate"
)

// tokenizerStatus is what a client, a gate or an operator needs to know about this server's
// tokenizer data: whether counts are exact, and which layout answered.
type tokenizerStatus struct {
	Exact  bool
	Layout string
}

// tokenizerExactnessStatus resolves the tree and reports it. It calls the SAME resolver the
// routes use, so "reports exact" and "reads a tree" cannot diverge.
func tokenizerExactnessStatus(options HTTPHandlerOptions) tokenizerStatus {
	assets, ok := tokenizerAssets(options)
	if !ok {
		return tokenizerStatus{Exact: false, Layout: tokenizerLayoutNone}
	}
	return tokenizerStatus{Exact: true, Layout: tokenizerLayout(options, assets)}
}

// annotate stamps the exactness observable onto a response. Called before the handler runs, so
// the headers are present whatever status the handler answers with.
func (status tokenizerStatus) annotate(w http.ResponseWriter) {
	exact := "false"
	if status.Exact {
		exact = "true"
	}
	w.Header().Set(tokenizerExactHeader, exact)
	w.Header().Set(tokenizerLayoutHeader, status.Layout)
}

// tokenizerConsoleWriter is where the guesstimate warning goes. Nil means os.Stderr, which is
// what the shipped binary uses; tests substitute a buffer so the marker's exact bytes are
// assertable rather than assumed.
func tokenizerConsoleWriter(options HTTPHandlerOptions) io.Writer {
	if options.tokenizerConsole != nil {
		return options.tokenizerConsole
	}
	return os.Stderr
}

// tokenizerCacheKey identifies one loaded set, so two handlers over the same roots share the
// engines exactly as the pinned module-level caches do.
type tokenizerCacheKey struct {
	assets         string
	cache          string
	allowDownloads bool
}

var (
	tokenizerSetMu    sync.Mutex
	tokenizerSetCache = map[tokenizerCacheKey]*tokenizerSet{}
)

// tokenizerSet is the lazily loaded engine set for one asset root. Loading is per engine on
// first use, mirroring the pinned tokenizersCache.
type tokenizerSet struct {
	assets         string
	cache          string
	allowDownloads bool

	mu             sync.Mutex
	sentencePieces map[string]*tokenizers.SentencePiece
	tiktokenSet    *tokenizers.TiktokenSet
	webTokenizers  map[string]*tokenizers.HF
}

// tokenizerDownloadsAllowed reads the pinned `enableDownloadableTokenizers` default: the
// option is nil when the key was absent, and the pinned default is true.
func tokenizerDownloadsAllowed(options HTTPHandlerOptions) bool {
	if options.EnableDownloadableTokenizers == nil {
		return true
	}
	return *options.EnableDownloadableTokenizers
}

func openTokenizerSet(options HTTPHandlerOptions) (*tokenizerSet, bool) {
	assets, ok := tokenizerAssets(options)
	if !ok {
		return nil, false
	}
	key := tokenizerCacheKey{
		assets:         assets,
		cache:          filepath.Join(options.DataRoot, "_cache"),
		allowDownloads: tokenizerDownloadsAllowed(options),
	}
	tokenizerSetMu.Lock()
	defer tokenizerSetMu.Unlock()
	if existing, ok := tokenizerSetCache[key]; ok {
		return existing, true
	}
	set := &tokenizerSet{
		assets:         assets,
		cache:          key.cache,
		allowDownloads: key.allowDownloads,
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

// tokenizerFallbackModel is the model the pinned server uses when an external tokenizer
// cannot be resolved (tokenizers.js:144-147). Every externally fetched WebTokenizer is
// declared with llama3.json as its fallback.
const tokenizerFallbackModel = "llama3"

// webBytes resolves one HuggingFace tokenizer the way the pinned getPathToTokenizer does
// (tokenizers.js:86-151): the uncompressed cache file wins; a compressed cache file left by a
// manual download is decompressed, written and removed; when downloads are allowed the file is
// obtained, which GoTavern serves from the vendored asset instead of the network; and any
// failure falls back to llama3.json, which is what the pinned capture shows for a cold cache
// with downloads disabled.
//
// CACHE-WRITE FAILURE SEMANTICS (D-H17). Pinned's cache writes are writeFileAtomicSync calls
// inside getPathToTokenizer's try block (tokenizers.js:9,116,136,140); when one throws, the
// catch logs and RETURNS THE FALLBACK MODEL (tokenizers.js:144-146), so the route answers with
// llama3's tokenization rather than the tokenizer that could not be cached. The Go side ignores
// the write error today, so it would answer with the tokenizer it failed to persist -- a
// parity difference AND a data-safety one (the cache may be a truncated file the next request
// reads as a tokenizer). This now falls back to llama3 on a cache-write failure, matching
// pinned. Deliberate residual difference: pinned logs `console.error` on the fallback and the
// Go tokenizer path is silent on every fallback (the pre-existing cold-cache fallback is silent
// too); adding a logger here would need the options writer that tokenizerSet does not carry.
func (set *tokenizerSet) webBytes(model string) ([]byte, error) {
	if !isTokenizerExternalAsset(model) {
		return os.ReadFile(filepath.Join(set.assets, model+".json"))
	}
	if set.cache != "" {
		if raw, err := os.ReadFile(filepath.Join(set.cache, model+".json")); err == nil {
			return raw, nil
		}
		if compressed, err := os.ReadFile(filepath.Join(set.cache, model+".json.gz")); err == nil {
			if raw, err := gunzipBytes(compressed); err == nil {
				if err := set.publishCacheFile(model+".json", raw); err != nil {
					return set.webBytes(tokenizerFallbackModel)
				}
				// Deliberate difference from pinned: pinned's `await fs.promises.unlink(...)`
				// (tokenizers.js:117) inside the try means an unlink failure ALSO falls back to
				// llama3. GoTavern ignores the unlink failure and uses the bytes it just cached
				// successfully -- the uncompressed cache file now exists, so the next request
				// uses it either way, and a failed cleanup is not a tokenizer resolution
				// failure. Nothing observable differs unless unlink fails, in which case the
				// pinned and Go answers diverge for one request.
				_ = os.Remove(filepath.Join(set.cache, model+".json.gz"))
				return raw, nil
			}
		}
	}
	if set.allowDownloads {
		if compressed, err := os.ReadFile(filepath.Join(set.assets, "external", model+".json.gz")); err == nil {
			if raw, err := gunzipBytes(compressed); err == nil {
				if set.cache != "" {
					if err := set.publishCacheFile(model+".json", raw); err != nil {
						return set.webBytes(tokenizerFallbackModel)
					}
				}
				return raw, nil
			}
		}
	}
	return set.webBytes(tokenizerFallbackModel)
}

// publishCacheFile materializes one decompressed tokenizer into <DataRoot>/_cache, which the
// pinned getPathToTokenizer does with `fs.mkdirSync(CACHE_PATH, {recursive:true})`
// (tokenizers.js:97-99) and then writeFileAtomicSync (tokenizers.js:9,116,136,140).
func (set *tokenizerSet) publishCacheFile(name string, body []byte) error {
	if set.cache == "" {
		return nil
	}
	if err := os.MkdirAll(set.cache, 0o755); err != nil {
		return err
	}
	return writeTokenizerCacheFile(filepath.Join(set.cache, name), body)
}

// writeTokenizerCacheFile publishes the tokenizer cache bytes so the destination is only ever
// ABSENT or COMPLETE, which is what pinned's writeFileAtomicSync guarantees for the same files
// (tokenizers.js:9,116,136,140).
//
// THE HAZARD THIS REMOVES (D-H17). The old body was a single `os.WriteFile(target, ...)`: Go
// opens the destination with O_TRUNC and writes in place, so a full disk, a killed process or a
// mid-write failure left a TRUNCATED file where the tokenizer cache used to be, and a
// concurrent reader could observe that prefix and read it as a tokenizer. Measured pre-fix with
// the failure seam below: a 4,754,645-byte payload left a 2,377,322-byte `qwen2.json`, and an
// overwrite replaced a 33-byte complete file with a 32,768-byte prefix.
//
// THE SHAPE. A unique temporary file in the SAME directory (O_CREATE|O_EXCL), write, fsync,
// close, then rename over the destination; the destination itself is never opened for
// truncation, and the temporary is removed on every error path. The rename is retried through
// internal/fsretry because Windows refuses it while a concurrent reader holds the destination
// (fsretry's package comment measures that), and the directory is fsynced so the rename is
// durable. The algorithm is the one internal/startup's atomicReplace already uses; this helper
// does not forward to startup.WriteFileAtomic because (a) the cache directory may not exist yet
// and pinned mkdirs it first, and (b) the red-first test needs the write step as a seam, and
// startup's seam is deliberately unexported in a package that is do-not-refactor.
//
// tokenizerCacheTempWrite is a variable only so a test can inject the mid-write failure, the
// same pattern as internal/startup's atomicTempWrite. Production code never replaces it.
func writeTokenizerCacheFile(target string, body []byte) error {
	directory := filepath.Dir(target)
	var temporary *os.File
	var tempName string
	for attempt := 0; attempt < 8; attempt++ {
		token := make([]byte, 16)
		if _, err := rand.Read(token); err != nil {
			return err
		}
		tempName = filepath.Join(directory, ".gotavern-tokenizer-"+hex.EncodeToString(token)+".tmp")
		file, err := os.OpenFile(tempName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return err
		}
		temporary = file
		break
	}
	if temporary == nil {
		return errors.New("could not allocate a unique tokenizer-cache temporary file")
	}
	defer os.Remove(tempName)
	if err := tokenizerCacheTempWrite(temporary, body); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := fsretry.Do(func() error { return os.Rename(tempName, target) }); err != nil {
		return err
	}
	if directoryFile, err := os.Open(directory); err == nil {
		_ = directoryFile.Sync()
		_ = directoryFile.Close()
	}
	return nil
}

var tokenizerCacheTempWrite = func(file *os.File, body []byte) error {
	_, err := file.Write(body)
	return err
}

func isTokenizerExternalAsset(model string) bool {
	for _, external := range tokenizerExternalAssetModels {
		if external == model {
			return true
		}
	}
	return false
}

func gunzipBytes(compressed []byte) ([]byte, error) {
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return io.ReadAll(reader)
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
		httpx.WriteStatusText(w, http.StatusBadRequest)
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
		httpx.WriteStatusText(w, http.StatusBadRequest)
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
		httpx.WriteStatusText(w, http.StatusBadRequest)
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
