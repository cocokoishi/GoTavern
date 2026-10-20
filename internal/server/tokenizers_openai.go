package server

// Pinned tokenizer decode, openai/* and count routes, from src/endpoints/tokenizers.js:754-1000.
//
// The three decode handlers do not share a shape, which is why they are separate:
//
//	SentencePiece (tokenizers.js:592) decodes each id on its own and joins: ids.map(id => decodeIds([id]))
//	Tiktoken     (tokenizers.js:652) decodes the whole id sequence and returns {text} with no chunks
//	HuggingFace  (tokenizers.js:711) decodes the whole sequence and derives chunks incrementally
//
// The openai/* routes dispatch on the query model before falling through to tiktoken, using the
// pinned substring chain (tokenizers.OpenAITokenizerFamily) and the pinned model mapping
// (tokenizers.GetTokenizerModel). The count route reproduces the pinned arithmetic, including
// its catch path, which guesstimates JSON.stringify(request.body).

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/cocokoishi/gotavern/internal/tokenizers"
)

type tokenizerDecodeResponse struct {
	Text   string   `json:"text"`
	Chunks []string `json:"chunks"`
}

type tokenizerTiktokenDecodeResponse struct {
	Text string `json:"text"`
}

// tokenizerRawBody reads the request body, reporting whether the pinned strict parser would
// have accepted it.
func tokenizerRawBody(request *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(io.LimitReader(request.Body, 500<<20))
	if err != nil {
		return nil, false
	}
	if len(body) == 0 {
		return nil, true
	}
	var probe any
	if err := json.Unmarshal(body, &probe); err != nil {
		return nil, false
	}
	return body, true
}

// tokenizerIDs reproduces `request.body.ids || []`. bodyOK is false when the pinned parser
// would reject the body; idsInvalid is true when the body is valid but `ids` is not an array
// of numbers, which the pinned handler turns into its caught error shape.
func tokenizerIDs(body []byte) (ids []int, idsInvalid bool) {
	if len(body) == 0 {
		return []int{}, false
	}
	var parsed any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, true
	}
	object, isObject := parsed.(map[string]any)
	if !isObject {
		return []int{}, false
	}
	raw, present := object["ids"]
	if !present || raw == nil {
		return []int{}, false
	}
	list, isList := raw.([]any)
	if !isList {
		return nil, true
	}
	ids = make([]int, 0, len(list))
	for _, item := range list {
		number, isNumber := item.(float64)
		if !isNumber {
			return nil, true
		}
		ids = append(ids, int(number))
	}
	return ids, false
}

func (runtime *accountRuntime) serveSentencePieceDecode(w http.ResponseWriter, request *http.Request, model string) {
	body, bodyOK := tokenizerRawBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	ids, idsInvalid := tokenizerIDs(body)
	if idsInvalid {
		respondJSON(w, http.StatusOK, tokenizerDecodeResponse{Text: "", Chunks: []string{}})
		return
	}
	set, present := openTokenizerSet(runtime.options)
	if !present {
		respondJSON(w, http.StatusOK, tokenizerDecodeResponse{Text: "", Chunks: []string{}})
		return
	}
	processor, err := set.sentencePiece(model)
	if err != nil {
		respondJSON(w, http.StatusOK, tokenizerDecodeResponse{Text: "", Chunks: []string{}})
		return
	}
	chunks := make([]string, 0, len(ids))
	for _, id := range ids {
		chunks = append(chunks, processor.DecodeSingle(id))
	}
	respondJSON(w, http.StatusOK, tokenizerDecodeResponse{Text: strings.Join(chunks, ""), Chunks: chunks})
}

func (runtime *accountRuntime) serveTiktokenDecode(w http.ResponseWriter, request *http.Request) {
	body, bodyOK := tokenizerRawBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	ids, idsInvalid := tokenizerIDs(body)
	if idsInvalid {
		respondJSON(w, http.StatusOK, tokenizerTiktokenDecodeResponse{Text: ""})
		return
	}
	set, present := openTokenizerSet(runtime.options)
	if present {
		if loaded, err := set.tiktoken(); err == nil {
			if encoding, err := loaded.Encoding("gpt2"); err == nil {
				if text, err := encoding.Decode(ids); err == nil {
					respondJSON(w, http.StatusOK, tokenizerTiktokenDecodeResponse{Text: text})
					return
				}
			}
		}
	}
	respondJSON(w, http.StatusOK, tokenizerTiktokenDecodeResponse{Text: ""})
}

func (runtime *accountRuntime) serveWebTokenizerDecode(w http.ResponseWriter, request *http.Request, model string) {
	body, bodyOK := tokenizerRawBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	ids, idsInvalid := tokenizerIDs(body)
	if idsInvalid {
		respondJSON(w, http.StatusOK, tokenizerDecodeResponse{Text: "", Chunks: []string{}})
		return
	}
	text, chunks, ok := runtime.webTokenizerDecode(model, ids)
	if !ok {
		respondJSON(w, http.StatusOK, tokenizerDecodeResponse{Text: "", Chunks: []string{}})
		return
	}
	respondJSON(w, http.StatusOK, tokenizerDecodeResponse{Text: text, Chunks: chunks})
}

// webTokenizerDecode runs the pinned HuggingFace decode handler's work for one model.
func (runtime *accountRuntime) webTokenizerDecode(model string, ids []int) (string, []string, bool) {
	set, present := openTokenizerSet(runtime.options)
	if !present {
		return "", nil, false
	}
	processor, err := set.web(model)
	if err != nil {
		return "", nil, false
	}
	text, err := processor.DecodeIDs(ids)
	if err != nil {
		return "", nil, false
	}
	chunks, err := processor.Chunks(ids)
	if err != nil {
		return "", nil, false
	}
	return text, chunks, true
}

// --- openai/* dispatch ------------------------------------------------------------------

func (runtime *accountRuntime) serveOpenAITokenizerEncode(w http.ResponseWriter, request *http.Request) {
	text, ok := tokenizerTextRequest(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	family := tokenizers.OpenAITokenizerFamily(request.URL.Query().Get("model"))
	respondJSON(w, http.StatusOK, runtime.encodeForFamily(family, text, request.URL.Query().Get("model")))
}

func (runtime *accountRuntime) serveOpenAITokenizerDecode(w http.ResponseWriter, request *http.Request) {
	body, bodyOK := tokenizerRawBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	ids, idsInvalid := tokenizerIDs(body)
	queryModel := request.URL.Query().Get("model")
	family := tokenizers.OpenAITokenizerFamily(queryModel)
	if idsInvalid {
		if family == tokenizers.FamilyTiktoken {
			respondJSON(w, http.StatusOK, tokenizerTiktokenDecodeResponse{Text: ""})
			return
		}
		respondJSON(w, http.StatusOK, tokenizerDecodeResponse{Text: "", Chunks: []string{}})
		return
	}
	if family == tokenizers.FamilyTiktoken {
		set, present := openTokenizerSet(runtime.options)
		if present {
			if loaded, err := set.tiktoken(); err == nil {
				if encoding, err := loaded.ForModel(tokenizers.GetTokenizerModel(queryModel)); err == nil {
					if text, err := encoding.Decode(ids); err == nil {
						respondJSON(w, http.StatusOK, tokenizerTiktokenDecodeResponse{Text: text})
						return
					}
				}
			}
		}
		respondJSON(w, http.StatusOK, tokenizerTiktokenDecodeResponse{Text: ""})
		return
	}
	text, chunks, ok := runtime.decodeForFamily(family, ids)
	if !ok {
		respondJSON(w, http.StatusOK, tokenizerDecodeResponse{Text: "", Chunks: []string{}})
		return
	}
	respondJSON(w, http.StatusOK, tokenizerDecodeResponse{Text: text, Chunks: chunks})
}

// encodeForFamily runs the encode work for one family, returning the pinned response shape.
func (runtime *accountRuntime) encodeForFamily(family string, text string, queryModel string) tokenizerEncodeResponse {
	empty := tokenizerEncodeResponse{IDs: []int{}, Count: 0, Chunks: []string{}}
	set, present := openTokenizerSet(runtime.options)
	if !present {
		return empty
	}
	if family == tokenizers.FamilyTiktoken {
		loaded, err := set.tiktoken()
		if err != nil {
			return empty
		}
		encoding, err := loaded.ForModel(tokenizers.GetTokenizerModel(queryModel))
		if err != nil {
			return empty
		}
		ids, err := encoding.Encode(text)
		if err != nil {
			return empty
		}
		chunks, err := encoding.Chunks(ids)
		if err != nil {
			return empty
		}
		return tokenizerEncodeResponse{IDs: ids, Count: len(ids), Chunks: chunks}
	}
	if model, ok := sentencePieceFamilyModel(family); ok {
		processor, err := set.sentencePiece(model)
		if err != nil {
			return tokenizerEncodeResponse{IDs: []int{}, Count: tokenizers.Guesstimate(text), Chunks: nil}
		}
		ids, chunks := processor.Encode(text)
		return tokenizerEncodeResponse{IDs: ids, Count: len(ids), Chunks: chunks}
	}
	processor, err := set.web(family)
	if err != nil {
		return empty
	}
	ids, err := processor.Encode(text)
	if err != nil {
		return empty
	}
	chunks, err := processor.Chunks(ids)
	if err != nil {
		return empty
	}
	return tokenizerEncodeResponse{IDs: ids, Count: len(ids), Chunks: chunks}
}

func sentencePieceFamilyModel(family string) (string, bool) {
	switch family {
	case tokenizers.FamilyLlama, tokenizers.FamilyNerdstash, tokenizers.FamilyNerdstashV2,
		tokenizers.FamilyMistral, tokenizers.FamilyYi, tokenizers.FamilyGemma, tokenizers.FamilyJamba:
		return family, true
	}
	return "", false
}

func (runtime *accountRuntime) decodeForFamily(family string, ids []int) (string, []string, bool) {
	if model, ok := sentencePieceFamilyModel(family); ok {
		set, present := openTokenizerSet(runtime.options)
		if !present {
			return "", nil, false
		}
		processor, err := set.sentencePiece(model)
		if err != nil {
			return "", nil, false
		}
		chunks := make([]string, 0, len(ids))
		for _, id := range ids {
			chunks = append(chunks, processor.DecodeSingle(id))
		}
		return strings.Join(chunks, ""), chunks, true
	}
	return runtime.webTokenizerDecode(family, ids)
}

// --- openai/count -----------------------------------------------------------------------

func (runtime *accountRuntime) serveOpenAITokenizerCount(w http.ResponseWriter, request *http.Request) {
	body, bodyOK := tokenizerRawBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	queryModel := request.URL.Query().Get("model")
	count, err := runtime.countForModel(queryModel, body)
	if err != nil {
		// The pinned outer catch answers guesstimate(JSON.stringify(request.body)).
		count = tokenizers.Guesstimate(compactJSONText(body))
	}
	respondJSON(w, http.StatusOK, tokenizerCountResponse{Count: count})
}

func (runtime *accountRuntime) countForModel(queryModel string, body []byte) (int, error) {
	messages, err := tokenizers.DecodeOrderedMessages(body)
	if err != nil {
		return 0, err
	}
	tokenizerModel := tokenizers.GetTokenizerModel(queryModel)
	set, present := openTokenizerSet(runtime.options)
	if !present {
		return 0, errNoTokenizerAssets
	}
	if tokenizerModel == tokenizers.FamilyClaude {
		processor, err := set.web(tokenizerModel)
		if err != nil {
			return 0, err
		}
		return processor.CountArrayTokens(messages), nil
	}
	if model, ok := sentencePieceFamilyModel(tokenizerModel); ok {
		processor, err := set.sentencePiece(model)
		if err != nil {
			return 0, err
		}
		return processor.CountArrayTokens(messages), nil
	}
	if isWebTokenizerModel(tokenizerModel) {
		processor, err := set.web(tokenizerModel)
		if err != nil {
			return 0, err
		}
		return processor.CountArrayTokens(messages), nil
	}
	loaded, err := set.tiktoken()
	if err != nil {
		return 0, err
	}
	return loaded.CountOpenAIChatTokens(queryModel, messages)
}

func isWebTokenizerModel(model string) bool {
	for _, candidate := range tokenizerWebModels {
		if candidate == model {
			return true
		}
	}
	return false
}

// compactJSONText re-serializes a body the way JavaScript's JSON.stringify would for the
// values the pinned count path sees. Key order is preserved because the bodies are compacted
// rather than re-marshalled through a Go map.
func compactJSONText(body []byte) string {
	if len(body) == 0 {
		return "null"
	}
	var buffer bytes.Buffer
	if err := json.Compact(&buffer, body); err != nil {
		return string(body)
	}
	return buffer.String()
}

var errNoTokenizerAssets = errString("tokenizers: no release assets available")

type errString string

func (e errString) Error() string { return string(e) }
