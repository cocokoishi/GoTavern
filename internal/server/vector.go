package server

// Pinned /api/vector/* routes, from src/endpoints/vectors.js (mounted at /api/vector by
// src/server-startup.js:171):
//
//	POST /api/vector/query        vectors.js:472
//	POST /api/vector/query-multi  vectors.js:492
//	POST /api/vector/insert       vectors.js:512
//	POST /api/vector/list         vectors.js:530
//	POST /api/vector/delete       vectors.js:547
//	POST /api/vector/purge-all    vectors.js:565
//	POST /api/vector/purge        vectors.js:583
//
// The persisted format is vectra's LocalIndex: `<vectors>/<sanitize(source)>/<sanitize(collectionId)>/
// <sanitize(model)>/index.json`, a compact JSON object
// `{"version":1,"metadata_config":{},"items":[{"id":uuid,"metadata":{...},"vector":[...],"norm":n}]}`.
// That file is canonical SillyTavern data, so this implementation reads unknown fields as an
// ordered JSON document and writes it back through the shared locked/atomic primitives
// (startup.UpdateUserContentFile); it does not introduce a second index format.
//
// SOURCE COVERAGE. Only the two sources whose vectors arrive precomputed in the request body are
// implemented for vector PRODUCTION (`webllm`, `koboldcpp`, `sourceSettings.embeddings[text]`).
// Every route's filesystem/scoring behaviour is implemented and differential-tested for those
// sources; the model scope (and therefore the on-disk path) is computed for every source name
// exactly as pinned getSourceSettings does, so list/delete/purge work for provider sources too.
// Provider EMBEDDING calls are not implemented: source `transformers` (local ONNX pipeline),
// `openai`/`togetherai`/`mistral`/`electronhub`/`openrouter`/`chutes`/`nanogpt`/`siliconflow`/
// `workers_ai` (OpenAI-compatible `/embeddings`), `cohere`, `nomicai`, `extras`, `palm`,
// `vertexai`, `ollama`, `llamacpp`, `vllm` all answer the same 500 a failed provider call would,
// and the fixture's knownDifferences says so. No fake success.
//
// Evidence: tools/probe-vector.mjs drives the pinned server, records
// tests/oracle/sillytavern-1.19.0-vector.json (33 steps with a full UUID-normalised filesystem
// snapshot after each), and internal/server/vector_test.go replays it.
//
// One pinned quirk is reproduced deliberately: `String(req.body.source) || 'transformers'` turns
// an ABSENT source into the literal string "undefined" (String(undefined) is truthy), which two
// recorded scenarios pin.

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io/fs"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// vectorSources is the pinned SOURCES array (vectors.js:22), in order. purge/purge-all iterate it.
var vectorSources = []string{
	"transformers", "mistral", "openai", "extras", "palm", "togetherai", "nomicai", "cohere",
	"ollama", "llamacpp", "vllm", "webllm", "koboldcpp", "vertexai", "electronhub", "openrouter",
	"chutes", "nanogpt", "siliconflow", "workers_ai",
}

const vectorBatchSize = 10

// errVectorCorruptIndex marks a JSON.parse failure of index.json, which the pinned catch treats as
// a SyntaxError and repairs by deleting the index and answering a 307 redirect.
var errVectorCorruptIndex = errors.New("vector index is corrupt")

// errVectorUnsupportedSource is a deliberate gap: a provider-backed source whose embedding call
// is not implemented. It maps to the same 500 a failed provider call produces.
var errVectorUnsupportedSource = errors.New("vector source is not implemented")

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerVectorRoutes)
}

func registerVectorRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/vector/query", accounts.serveVectorQuery)
	post("/api/vector/query-multi", accounts.serveVectorQueryMulti)
	post("/api/vector/insert", accounts.serveVectorInsert)
	post("/api/vector/list", accounts.serveVectorList)
	post("/api/vector/delete", accounts.serveVectorDelete)
	post("/api/vector/purge-all", accounts.serveVectorPurgeAll)
	post("/api/vector/purge", accounts.serveVectorPurge)
}

// ---- source settings ----------------------------------------------------------------------

// vectorSourceSettings mirrors getSourceSettings (vectors.js:185) for the fields that affect the
// on-disk path or the vector lookup.
type vectorSourceSettings struct {
	model      string
	embeddings orderedNodeJSON
}

// vectorSourceName is `String(req.body.source) || 'transformers'`. An absent member stringifies
// to "undefined", which is truthy — that is pinned behaviour, not a mistake here.
func vectorSourceName(body orderedNodeJSON) string {
	source, err := pinnedJSStringValue(sdBodyMember(body, "source"))
	if err != nil || source == "" {
		if err != nil {
			return "transformers"
		}
		return "transformers"
	}
	return source
}

// vectorMemberOr returns `String(value || fallback)`: a falsy member yields the fallback, then the
// result is stringified.
func vectorStringOr(value orderedNodeJSON, fallback string) string {
	if pinnedJSTruthy(value) {
		text, err := pinnedJSStringValue(value)
		if err != nil {
			return ""
		}
		return text
	}
	return fallback
}

// vectorStringMember is `String(value)`.
func vectorStringMember(value orderedNodeJSON) string {
	text, err := pinnedJSStringValue(value)
	if err != nil {
		return ""
	}
	return text
}

// vectorSettingsFor reproduces getSourceSettings for the model scope, and captures the
// precomputed embeddings for the two sources that use them.
func vectorSettingsFor(body orderedNodeJSON, source string) vectorSourceSettings {
	settings := vectorSourceSettings{embeddings: nodeObject()}
	model := sdBodyMember(body, "model")
	switch source {
	case "togetherai", "openai":
		settings.model = vectorStringMember(model)
	case "electronhub":
		settings.model = vectorStringOr(model, "text-embedding-3-small")
	case "openrouter":
		settings.model = vectorStringMember(model)
		if settings.model == "" {
			settings.model = "openai/text-embedding-3-large"
		}
	case "cohere":
		settings.model = vectorStringMember(model)
	case "vllm", "ollama":
		settings.model = vectorStringMember(model)
	case "palm", "vertexai":
		settings.model = vectorStringOr(model, "text-embedding-005")
	case "mistral":
		settings.model = "mistral-embed"
	case "nomicai":
		settings.model = "nomic-embed-text-v1.5"
	case "webllm", "koboldcpp":
		settings.model = vectorStringMember(model)
		embeddings := sdBodyMember(body, "embeddings")
		if !embeddings.isNull() && !embeddings.isUndefined() {
			settings.embeddings = embeddings
		}
	case "chutes":
		settings.model = vectorStringOr(model, "chutes-qwen-qwen3-embedding-8b")
	case "nanogpt":
		settings.model = vectorStringOr(model, "text-embedding-3-small")
	case "siliconflow":
		settings.model = vectorStringOr(model, "Qwen/Qwen3-Embedding-0.6B")
	case "workers_ai":
		settings.model = vectorStringOr(model, "@cf/baai/bge-m3")
	default:
		// transformers uses the config value `extensions.models.embedding` (default ''); the
		// config projection is not implemented here, so the default value is used. llamacpp,
		// extras and unknown sources have no model scope.
		settings.model = ""
	}
	return settings
}

// vectorIndexFolder is the pinned LocalIndex path.
func vectorIndexFolder(directories startup.UserDirectories, source, collectionID, model string) string {
	return filepath.Join(
		directories["vectors"],
		startup.SanitizeUserFilename(source),
		startup.SanitizeUserFilename(collectionID),
		startup.SanitizeUserFilename(model),
	)
}

// ---- index document primitives ------------------------------------------------------------

// vectorSession is one open LocalIndex operation.
type vectorSession struct {
	runtime     *accountRuntime
	account     *storedAccount
	directories startup.UserDirectories
	folder      string
	doc         orderedNodeJSON
}

// vectorInitialIndex is the pinned createIndex content.
func vectorInitialIndex() orderedNodeJSON {
	doc := nodeObject()
	doc.setMember("version", nodeNumber(1))
	doc.setMember("metadata_config", nodeObject())
	doc.setMember("items", nodeArray())
	return doc
}

// vectorOpenIndex reproduces getIndex: create the index when it does not exist, then load it. A
// JSON parse failure returns errVectorCorruptIndex so the route can repair it (SyntaxError path).
func (runtime *accountRuntime) vectorOpenIndex(account *storedAccount, directories startup.UserDirectories, source, collectionID string, settings vectorSourceSettings) (*vectorSession, error) {
	folder := vectorIndexFolder(directories, source, collectionID, settings.model)
	session := &vectorSession{runtime: runtime, account: account, directories: directories, folder: folder}
	indexPath := filepath.Join(folder, "index.json")
	raw, err := os.ReadFile(indexPath)
	if errors.Is(err, fs.ErrNotExist) {
		// The pinned createIndex does fs.mkdir(recursive) before writing; do it inside the same
		// content lock the atomic write below uses.
		if mkdirErr := runtime.vectorWithContentLock(account, directories, func() error {
			return os.MkdirAll(folder, 0o777)
		}); mkdirErr != nil {
			return nil, mkdirErr
		}
		session.doc = vectorInitialIndex()
		encoded, marshalErr := marshalOrderedNodeJSON(session.doc)
		if marshalErr != nil {
			return nil, marshalErr
		}
		if writeErr := runtime.vectorWriteIndex(session, encoded); writeErr != nil {
			return nil, writeErr
		}
		return session, nil
	}
	if err != nil {
		return nil, err
	}
	doc, decodeErr := decodeOrderedNodeJSON(raw)
	if decodeErr != nil {
		return nil, errVectorCorruptIndex
	}
	session.doc = doc
	return session, nil
}

// vectorWriteIndex writes the index through the shared per-user content lock and atomicReplace,
// which is the project's single write path for user data.
func (runtime *accountRuntime) vectorWriteIndex(session *vectorSession, body []byte) error {
	relative, ok := sdUserRelativePath(session.directories, filepath.Join(session.folder, "index.json"))
	if !ok {
		return errors.New("vector index path escapes the user root")
	}
	return startup.UpdateUserContentFile(runtime.options.DataRoot, session.account.string("handle"), relative, func([]byte) ([]byte, error) {
		return body, nil
	})
}

// vectorSave serializes the whole index document exactly as JSON.stringify would and writes it.
func (runtime *accountRuntime) vectorSave(session *vectorSession) error {
	encoded, err := marshalOrderedNodeJSON(session.doc)
	if err != nil {
		return err
	}
	return runtime.vectorWriteIndex(session, encoded)
}

// vectorItems returns the index's items array. A missing or non-array items member would throw in
// vectra when it calls array methods, so it is an error here too.
func (session *vectorSession) vectorItems() (orderedNodeJSON, error) {
	items, exists := session.doc.member("items")
	if !exists || items.kind != 'a' {
		return orderedNodeJSON{}, errors.New("vector index has no items array")
	}
	return items, nil
}

// vectorSetItems replaces the items array in place, preserving the document's key order and every
// unknown top-level field the pinned JSON.parse/JSON.stringify round trip preserves.
func (session *vectorSession) vectorSetItems(items orderedNodeJSON) {
	session.doc.setMember("items", items)
}

// vectorWithContentLock runs a filesystem mutation inside the shared per-user content lock. The
// primitive is used for its critical section; the callback declines the write because a recursive
// delete has no atomic replace form.
func (runtime *accountRuntime) vectorWithContentLock(account *storedAccount, directories startup.UserDirectories, operation func() error) error {
	anchor := filepath.Join(directories["vectors"], ".gotavern-lock-anchor")
	relative, ok := sdUserRelativePath(directories, anchor)
	if !ok {
		return errors.New("vector lock anchor escapes the user root")
	}
	return startup.UpdateUserContentFileIfChanged(runtime.options.DataRoot, account.string("handle"), relative, func([]byte) ([]byte, bool, error) {
		return nil, false, operation()
	})
}

// vectorRemoveDirectory removes one index/source directory inside the content lock.
func (runtime *accountRuntime) vectorRemoveDirectory(account *storedAccount, directories startup.UserDirectories, target string) error {
	return runtime.vectorWithContentLock(account, directories, func() error {
		return os.RemoveAll(target)
	})
}

// ---- JavaScript helpers -------------------------------------------------------------------

// vectorNumber is `Number(value)` with JavaScript's ToNumber coercion.
func vectorNumber(value orderedNodeJSON) float64 { return pinnedJSToNumber(value) }

// vectorTopK is `Number(req.body.topK) || 10`.
func vectorTopK(body orderedNodeJSON) float64 {
	number := vectorNumber(sdBodyMember(body, "topK"))
	if number == 0 || math.IsNaN(number) {
		return 10
	}
	return number
}

// vectorThreshold is `Number(req.body.threshold) || 0.0`.
func vectorThreshold(body orderedNodeJSON) float64 {
	number := vectorNumber(sdBodyMember(body, "threshold"))
	if number == 0 || math.IsNaN(number) {
		return 0
	}
	return number
}

// vectorRoundedProduct forces each product to be rounded to float64 before the addition. Go may
// contract `sum += a * b` into a fused multiply-add, which rounds once and changes the result;
// JavaScript never fuses, and the pinned norms and cosine scores depend on that rounding. An
// explicit conversion to the same type is the spec-defined barrier.
func vectorRoundedProduct(left, right float64) float64 { return float64(left * right) }

// vectorNormalize is ItemSelector.normalize: the square root of the sum of squares. A non-array
// value has no length in this loop, so it yields 0 like the JavaScript version.
func vectorNormalize(value orderedNodeJSON) float64 {
	if value.kind != 'a' {
		return 0
	}
	sum := 0.0
	for _, item := range value.array {
		number := vectorNumber(item)
		sum += vectorRoundedProduct(number, number)
	}
	return math.Sqrt(sum)
}

// vectorDotProduct is ItemSelector.dotProduct.
func vectorDotProduct(left, right orderedNodeJSON) float64 {
	if left.kind != 'a' {
		return 0
	}
	sum := 0.0
	for index := range left.array {
		rightItem := nodeUndefined()
		if right.kind == 'a' && index < len(right.array) {
			rightItem = right.array[index]
		}
		sum += vectorRoundedProduct(vectorNumber(left.array[index]), vectorNumber(rightItem))
	}
	return sum
}

// vectorSliceTopK is `array.slice(0, topK)` with JavaScript's ToIntegerOrInfinity semantics for a
// fractional topK and its negative-index rule.
func vectorSliceTopK(items []orderedNodeJSON, topK float64) []orderedNodeJSON {
	if math.IsNaN(topK) {
		return items[:0]
	}
	integer := math.Trunc(topK)
	if math.IsInf(integer, 1) {
		return items
	}
	if math.IsInf(integer, -1) {
		return items[:0]
	}
	count := int(integer)
	if count < 0 {
		count = len(items) + count
		if count < 0 {
			count = 0
		}
	}
	if count > len(items) {
		count = len(items)
	}
	return items[:count]
}

// vectorSliceTopKIndexes is array.slice(0, topK) for an index list.
func vectorSliceTopKIndexes(items []int, topK float64) []int {
	if math.IsNaN(topK) {
		return items[:0]
	}
	integer := math.Trunc(topK)
	if math.IsInf(integer, 1) {
		return items
	}
	if math.IsInf(integer, -1) {
		return items[:0]
	}
	count := int(integer)
	if count < 0 {
		count = len(items) + count
		if count < 0 {
			count = 0
		}
	}
	if count > len(items) {
		count = len(items)
	}
	return items[:count]
}

// vectorStableDescendingSort sorts by descending score with V8's stable sort semantics: a NaN
// comparison result is treated as zero, so original order is preserved.
func vectorStableDescendingSort(scores []float64, indexes []int) {
	sort.SliceStable(indexes, func(left, right int) bool {
		leftScore := scores[indexes[left]]
		rightScore := scores[indexes[right]]
		if math.IsNaN(leftScore) || math.IsNaN(rightScore) {
			return false
		}
		return leftScore > rightScore
	})
}

// ---- upstream vector production -----------------------------------------------------------

// vectorEmbeddingFor is `sourceSettings.embeddings[text]`.
func vectorEmbeddingFor(settings vectorSourceSettings, text orderedNodeJSON) orderedNodeJSON {
	key, err := pinnedJSStringValue(text)
	if err != nil {
		return nodeUndefined()
	}
	if settings.embeddings.kind != 'o' {
		return nodeUndefined()
	}
	if value, exists := settings.embeddings.member(key); exists {
		return value
	}
	return nodeUndefined()
}

// vectorGetVectors reproduces getBatchVector for the sources this implementation supports. The
// pinned webllm/koboldcpp branch maps the FULL texts array inside every batch (vectors.js:154),
// which duplicates vectors once there is more than one batch; that is reproduced, not fixed,
// because it changes which vector each item receives.
func vectorGetVectors(source string, settings vectorSourceSettings, texts []orderedNodeJSON) ([]orderedNodeJSON, error) {
	if source != "webllm" && source != "koboldcpp" {
		return nil, errVectorUnsupportedSource
	}
	if len(texts) == 0 {
		return nil, nil
	}
	batches := (len(texts) + vectorBatchSize - 1) / vectorBatchSize
	results := make([]orderedNodeJSON, 0, len(texts)*batches)
	for batch := 0; batch < batches; batch++ {
		for _, text := range texts {
			results = append(results, vectorEmbeddingFor(settings, text))
		}
	}
	return results, nil
}

// vectorGetQueryVector reproduces `getVector(source, settings, searchText, true, directories)` for
// one text.
func vectorGetQueryVector(source string, settings vectorSourceSettings, text orderedNodeJSON) (orderedNodeJSON, error) {
	vectors, err := vectorGetVectors(source, settings, []orderedNodeJSON{text})
	if err != nil {
		return orderedNodeJSON{}, err
	}
	if len(vectors) == 0 {
		return nodeUndefined(), nil
	}
	return vectors[0], nil
}

// ---- uuid ---------------------------------------------------------------------------------

// vectorUUID is a uuid v4 in the pinned library's format (lowercase, version 4, RFC 4122 variant).
func vectorUUID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	encoded := make([]byte, 36)
	hex.Encode(encoded[0:8], raw[0:4])
	encoded[8] = '-'
	hex.Encode(encoded[9:13], raw[4:6])
	encoded[13] = '-'
	hex.Encode(encoded[14:18], raw[6:8])
	encoded[18] = '-'
	hex.Encode(encoded[19:23], raw[8:10])
	encoded[23] = '-'
	hex.Encode(encoded[24:36], raw[10:16])
	return string(encoded), nil
}

// ---- index item helpers -------------------------------------------------------------------

// vectorQueryItem is one scored index item.
type vectorQueryItem struct {
	item     orderedNodeJSON
	metadata orderedNodeJSON
	score    float64
}

// vectorItemMetadata is `item.metadata`, loading a metadataFile when the index uses one. The
// pinned queryItems reloads external metadata for the top results only.
func (session *vectorSession) vectorItemMetadata(item orderedNodeJSON) (orderedNodeJSON, error) {
	metadata, exists := item.member("metadata")
	if !exists {
		return nodeObject(), nil
	}
	metadataFile, hasFile := item.member("metadataFile")
	if !hasFile {
		return metadata, nil
	}
	name, isString := metadataFile.stringValue()
	if !isString {
		return metadata, nil
	}
	body, err := os.ReadFile(filepath.Join(session.folder, name))
	if err != nil {
		return orderedNodeJSON{}, err
	}
	parsed, decodeErr := decodeOrderedNodeJSON(body)
	if decodeErr != nil {
		return orderedNodeJSON{}, decodeErr
	}
	return parsed, nil
}

// vectorTopItems reproduces `store.queryItems(vector, topK)` for this index: cosine similarity
// against every item, stable descending sort, then the first topK entries with external metadata
// loaded for the selected items only.
func (session *vectorSession) vectorTopItems(queryVector orderedNodeJSON, topK float64) ([]vectorQueryItem, error) {
	items, err := session.vectorItems()
	if err != nil {
		return nil, err
	}
	queryNorm := vectorNormalize(queryVector)
	scores := make([]float64, len(items.array))
	indexes := make([]int, len(items.array))
	for index, item := range items.array {
		itemVector, exists := item.member("vector")
		itemNorm := 0.0
		if norm, hasNorm := item.member("norm"); hasNorm {
			itemNorm = vectorNumber(norm)
		}
		if !exists {
			scores[index] = 0
		} else {
			scores[index] = vectorDotProduct(queryVector, itemVector) / (queryNorm * itemNorm)
		}
		indexes[index] = index
	}
	vectorStableDescendingSort(scores, indexes)
	selected := vectorSliceTopKIndexes(indexes, topK)
	items, err = session.vectorItems()
	if err != nil {
		return nil, err
	}
	result := make([]vectorQueryItem, 0, len(selected))
	for _, index := range selected {
		item := items.array[index]
		metadata, metadataErr := session.vectorItemMetadata(item)
		if metadataErr != nil {
			return nil, metadataErr
		}
		result = append(result, vectorQueryItem{item: item, metadata: metadata, score: scores[index]})
	}
	return result, nil
}

// vectorMetadataHash is `Number(metadata.hash)`.
func vectorMetadataHash(metadata orderedNodeJSON) orderedNodeJSON {
	hash, ok := sdMemberOf(metadata, "hash")
	if !ok {
		return nodeNumber(math.NaN())
	}
	return nodeNumber(vectorNumber(hash))
}

// ---- response helpers ---------------------------------------------------------------------

// vectorRespond is `res.json(value)`.
func vectorRespond(w http.ResponseWriter, value orderedNodeJSON) {
	respondOrderedNodeJSON(w, http.StatusOK, value)
}

// vectorStatus is Express sendStatus.
func vectorStatus(w http.ResponseWriter, status int) { serveSDStatus(w, status) }

// vectorRedirect is `res.redirect(307, location)`: the Location header, a text/plain body naming
// the destination, and no ETag (res.redirect writes the body directly).
func vectorRedirect(w http.ResponseWriter, status int, location, body string) {
	encoded := []byte(body)
	w.Header().Set("Location", location)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(encoded)))
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}

// vectorRequestCollectionID is `String(req.body.collectionId)`.
func vectorRequestCollectionID(body orderedNodeJSON) string {
	return vectorStringMember(sdBodyMember(body, "collectionId"))
}

// vectorRequestSearchText is `String(req.body.searchText)`.
func vectorRequestSearchText(body orderedNodeJSON) string {
	return vectorStringMember(sdBodyMember(body, "searchText"))
}

// vectorRegeneratedQuery is `req.query.regenerated` truthiness: Express query values arrive as
// strings, and any non-empty string is truthy.
func vectorRegeneratedQuery(request *http.Request) bool {
	return request.URL.Query().Get("regenerated") != ""
}

// vectorHandleError is the shared catch: a corrupt-index JSON parse triggers the pinned repair
// redirect (delete the index, 307 to the same URL with ?regenerated=true), everything else is a
// plain 500, and a request that already carries ?regenerated=true never recurses.
func (runtime *accountRuntime) vectorHandleError(w http.ResponseWriter, request *http.Request, account *storedAccount, directories startup.UserDirectories, body orderedNodeJSON, err error) {
	if errors.Is(err, errVectorCorruptIndex) && !vectorRegeneratedQuery(request) {
		collectionID := vectorRequestCollectionID(body)
		if collectionID != "" {
			source := vectorSourceName(body)
			settings := vectorSettingsFor(body, source)
			folder := vectorIndexFolder(directories, source, collectionID, settings.model)
			if _, statErr := os.Stat(filepath.Join(folder, "index.json")); statErr == nil {
				if removeErr := runtime.vectorRemoveDirectory(account, directories, folder); removeErr == nil {
					location := request.URL.RequestURI() + "?regenerated=true"
					vectorRedirect(w, http.StatusTemporaryRedirect, location, "Temporary Redirect. Redirecting to "+location)
					return
				}
			}
		}
	}
	if err != nil && !errors.Is(err, errVectorCorruptIndex) && !errors.Is(err, errVectorUnsupportedSource) {
		// Every other failure is the pinned catch's plain 500 as well; the distinction is kept
		// only so the code above reads clearly.
		_ = err
	}
	vectorStatus(w, http.StatusInternalServerError)
}
