package server

// Pinned NovelAI generation routes, from src/endpoints/novelai.js:
//
//	POST /api/novelai/generate        (167)  model-dependent parameter body, JSON or SSE answer
//	POST /api/novelai/generate-image  (300)  NAI Diffusion body, PNG archive, conditional upscale
//
// This file is ADDITIVE: /api/novelai/status and /api/novelai/generate-voice stay in novelai.go and
// are untouched. The only thing this file takes from that file is the two seam accessors, and the
// only thing it adds there is one more seam (TEXT_NOVELAI, novelai.js:11) because `generate` picks
// its host from the model name: kayra and erato go to https://text.novelai.net, everything else to
// https://api.novelai.net.
//
// EVIDENCE. tools/probe-novelai-generate.mjs drives the pinned server (node-fetch and the global
// fetch both replaced by a controlled peer) and records
// tests/oracle/sillytavern-1.19.0-novelai-generate.json; internal/server/novelai_generate_test.go
// replays it. Everything here was read off the pinned source or measured:
//
//   - the four model tables are transcribed MECHANICALLY from novelai.js:20-73 and verified byte for
//     byte by the fixture, because the outbound body carries them verbatim;
//   - the three table accessors apply their family tests in DIFFERENT orders (getBadWordsList ends
//     with erato, getRepPenaltyWhitelist starts with clio/kayra), so `clio-erato` gets erato bad
//     words and the CLIO whitelist. generate.mixedModel pins that;
//   - `bad_words_ids: []` is not simply dropped: novelai.js:195-199 splices the array it is
//     iterating, so copies of the same request skip entries. generate.customBadWords pins the
//     surviving empty array;
//   - an absent parameter is OMITTED (JSON.stringify drops undefined) while
//     repetition_penalty_whitelist and bad_words_ids are explicitly null;
//   - the streamed branch is forwardFetchResponse (src/util.js:732): a 401 becomes a 400, no
//     content type is set, and the body is piped rather than sent, so the answer is chunk-framed
//     with no content-length;
//   - generate-image walks the archive in order for the first `.png` outside `__MACOSX`, then makes
//     a SECOND request to /ai/upscale only when `upscale_ratio` survives `isNaN(x) || x <= 1`, and
//     falls back to the ORIGINAL base64 for every failure of that second request.

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"math"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

// novelaiTextDefaultURL is the pinned TEXT_NOVELAI literal (novelai.js:11), asserted by
// TestNovelAIGenerateSeamDefaults.
const novelaiTextDefaultURL = "https://text.novelai.net"

func novelaiTextURL() string { return sdSeamURL("GOTAVERN_NOVELAI_TEXT_URL", novelaiTextDefaultURL) }

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerNovelAIGenerateRoutes)
}

func registerNovelAIGenerateRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/novelai/generate", accounts.serveNovelAIGenerate)
	post("/api/novelai/generate-image", accounts.serveNovelAIGenerateImage)
}

// novelaiNull is the JSON null value as a node. `null` is distinguishable from `undefined`: the
// pinned body carries `repetition_penalty_whitelist: null` and `bad_words_ids: null` explicitly.
func novelaiNull() orderedNodeJSON { return orderedNodeJSON{kind: 'n'} }

// novelaiBadWord is one bad_words_ids entry. The members are float64 rather than int so the JSON
// writer emits them through the same ECMAScript number formatter JavaScript uses; a token id is
// always a small integer, but the request's own entries are echoed back untouched.
type novelaiBadWord []float64

type novelaiLogitBias struct {
	Sequence             []float64
	Bias                 float64
	EnsureSequenceFinish bool
	GenerateOnce         bool
}

// ---- pinned tables, transcribed mechanically from novelai.js:20-73 ---------------------------

// badWordsList (novelai.js:20), 20 entries: the dinkus/bracket ban plus defaults.
var novelaiClioKayraBadWords = []novelaiBadWord{[]float64{3}, []float64{49356}, []float64{1431}, []float64{31715}, []float64{34387}, []float64{20765}, []float64{30702}, []float64{10691}, []float64{49333}, []float64{1266}, []float64{19438}, []float64{43145}, []float64{26523}, []float64{41471}, []float64{2936}, []float64{85, 85}, []float64{49332}, []float64{7286}, []float64{1115}, []float64{24}}

// eratoBadWordsList (novelai.js:25), 7 entries.
var novelaiEratoBadWords = []novelaiBadWord{[]float64{16067}, []float64{933, 11144}, []float64{25106, 11144}, []float64{58, 106901, 16073, 33710, 25, 109933}, []float64{933, 58, 11144}, []float64{128030}, []float64{58, 30591, 33503, 17663, 100204, 25, 11144}}

// hypeBotBadWordsList (novelai.js:30), 150 entries.
var novelaiHypeBotBadWords = []novelaiBadWord{[]float64{58}, []float64{60}, []float64{90}, []float64{92}, []float64{685}, []float64{1391}, []float64{1782}, []float64{2361}, []float64{3693}, []float64{4083}, []float64{4357}, []float64{4895}, []float64{5512}, []float64{5974}, []float64{7131}, []float64{8183}, []float64{8351}, []float64{8762}, []float64{8964}, []float64{8973}, []float64{9063}, []float64{11208}, []float64{11709}, []float64{11907}, []float64{11919}, []float64{12878}, []float64{12962}, []float64{13018}, []float64{13412}, []float64{14631}, []float64{14692}, []float64{14980}, []float64{15090}, []float64{15437}, []float64{16151}, []float64{16410}, []float64{16589}, []float64{17241}, []float64{17414}, []float64{17635}, []float64{17816}, []float64{17912}, []float64{18083}, []float64{18161}, []float64{18477}, []float64{19629}, []float64{19779}, []float64{19953}, []float64{20520}, []float64{20598}, []float64{20662}, []float64{20740}, []float64{21476}, []float64{21737}, []float64{22133}, []float64{22241}, []float64{22345}, []float64{22935}, []float64{23330}, []float64{23785}, []float64{23834}, []float64{23884}, []float64{25295}, []float64{25597}, []float64{25719}, []float64{25787}, []float64{25915}, []float64{26076}, []float64{26358}, []float64{26398}, []float64{26894}, []float64{26933}, []float64{27007}, []float64{27422}, []float64{28013}, []float64{29164}, []float64{29225}, []float64{29342}, []float64{29565}, []float64{29795}, []float64{30072}, []float64{30109}, []float64{30138}, []float64{30866}, []float64{31161}, []float64{31478}, []float64{32092}, []float64{32239}, []float64{32509}, []float64{33116}, []float64{33250}, []float64{33761}, []float64{34171}, []float64{34758}, []float64{34949}, []float64{35944}, []float64{36338}, []float64{36463}, []float64{36563}, []float64{36786}, []float64{36796}, []float64{36937}, []float64{37250}, []float64{37913}, []float64{37981}, []float64{38165}, []float64{38362}, []float64{38381}, []float64{38430}, []float64{38892}, []float64{39850}, []float64{39893}, []float64{41832}, []float64{41888}, []float64{42535}, []float64{42669}, []float64{42785}, []float64{42924}, []float64{43839}, []float64{44438}, []float64{44587}, []float64{44926}, []float64{45144}, []float64{45297}, []float64{46110}, []float64{46570}, []float64{46581}, []float64{46956}, []float64{47175}, []float64{47182}, []float64{47527}, []float64{47715}, []float64{48600}, []float64{48683}, []float64{48688}, []float64{48874}, []float64{48999}, []float64{49074}, []float64{49082}, []float64{49146}, []float64{49946}, []float64{10221}, []float64{4841}, []float64{1427}, []float64{2602, 834}, []float64{29343}, []float64{37405}, []float64{35780}, []float64{2602}, []float64{50256}}

// repPenaltyAllowList (novelai.js:50) flattened by `repPenaltyAllowList.flat()`, 73 ids.
var novelaiClioKayraRepPenWhitelist = []float64{49256, 49264, 49231, 49230, 49287, 85, 49255, 49399, 49262, 336, 333, 432, 363, 468, 492, 745, 401, 426, 623, 794, 1096, 2919, 2072, 7379, 1259, 2110, 620, 526, 487, 16562, 603, 805, 761, 2681, 942, 8917, 653, 3513, 506, 5301, 562, 5010, 614, 10942, 539, 2976, 462, 5189, 567, 2032, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 588, 803, 1040, 49209, 4, 5, 6, 7, 8, 9, 10, 11, 12}

// eratoRepPenWhitelist (novelai.js:57), already flat: 79 ids.
var novelaiEratoRepPenWhitelist = []float64{6, 1, 11, 13, 25, 198, 12, 9, 8, 279, 264, 459, 323, 477, 539, 912, 374, 574, 1051, 1550, 1587, 4536, 5828, 15058, 3287, 3250, 1461, 1077, 813, 11074, 872, 1202, 1436, 7846, 1288, 13434, 1053, 8434, 617, 9167, 1047, 19117, 706, 12775, 649, 4250, 527, 7784, 690, 2834, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 1210, 1359, 608, 220, 596, 956, 3077, 44886, 4265, 3358, 2351, 2846, 311, 389, 315, 304, 520, 505, 430}

// logitBiasExp (novelai.js:65): the dinkus and asterism biases.
var novelaiClioKayraLogitBias = []novelaiLogitBias{{Sequence: []float64{23}, Bias: -0.08, EnsureSequenceFinish: false, GenerateOnce: false}, {Sequence: []float64{21}, Bias: -0.08, EnsureSequenceFinish: false, GenerateOnce: false}}

// eratoLogitBiasExp (novelai.js:70).
var novelaiEratoLogitBias = []novelaiLogitBias{{Sequence: []float64{12488}, Bias: -0.08, EnsureSequenceFinish: false, GenerateOnce: false}, {Sequence: []float64{128041}, Bias: -0.08, EnsureSequenceFinish: false, GenerateOnce: false}}

// novelaiBadWordsForModel is getBadWordsList (novelai.js:75). The three family tests OVERWRITE the
// list in source order, so a name containing both `hypebot` and `clio` takes the clio list and a
// name containing both `clio` and `erato` takes the ERATO list. The copy is what the pinned
// `list.slice()` returns: mutating it must not touch the table.
func novelaiBadWordsForModel(model string) []novelaiBadWord {
	list := []novelaiBadWord{}
	if strings.Contains(model, "hypebot") {
		list = novelaiHypeBotBadWords
	}
	if strings.Contains(model, "clio") || strings.Contains(model, "kayra") {
		list = novelaiClioKayraBadWords
	}
	if strings.Contains(model, "erato") {
		list = novelaiEratoBadWords
	}
	return append([]novelaiBadWord{}, list...)
}

// novelaiLogitBiasForModel is getLogitBiasList (novelai.js:94): erato first, then clio/kayra.
func novelaiLogitBiasForModel(model string) []novelaiLogitBias {
	list := []novelaiLogitBias{}
	if strings.Contains(model, "erato") {
		list = novelaiEratoLogitBias
	}
	if strings.Contains(model, "clio") || strings.Contains(model, "kayra") {
		list = novelaiClioKayraLogitBias
	}
	return append([]novelaiLogitBias{}, list...)
}

// novelaiRepPenWhitelistForModel is getRepPenaltyWhitelist (novelai.js:108). Unlike the two above it
// tests clio/kayra FIRST, so `clio-erato` gets the CLIO whitelist. The second result is false where
// the pinned function returns null, which is a value the body carries explicitly.
func novelaiRepPenWhitelistForModel(model string) ([]float64, bool) {
	if strings.Contains(model, "clio") || strings.Contains(model, "kayra") {
		return novelaiClioKayraRepPenWhitelist, true
	}
	if strings.Contains(model, "erato") {
		return novelaiEratoRepPenWhitelist, true
	}
	return nil, false
}

// novelaiIntegerList is `Array.isArray(badWord) && badWord.every(x => Number.isInteger(x))`. An
// EMPTY array passes: every() on an empty array is true. That is why the empty entries reach the
// removal loop at all.
func novelaiIntegerList(value orderedNodeJSON) (novelaiBadWord, bool) {
	if value.kind != 'a' {
		return nil, false
	}
	list := make(novelaiBadWord, 0, len(value.array))
	for _, item := range value.array {
		if item.kind != 'v' {
			return nil, false
		}
		number, _ := item.scalar.(float64)
		if math.IsNaN(number) || math.IsInf(number, 0) || number != math.Trunc(number) {
			return nil, false
		}
		list = append(list, number)
	}
	return list, true
}

func novelaiBadWordArray(list []novelaiBadWord) orderedNodeJSON {
	entries := make([]orderedNodeJSON, 0, len(list))
	for _, group := range list {
		numbers := make([]orderedNodeJSON, 0, len(group))
		for _, member := range group {
			numbers = append(numbers, nodeNumber(member))
		}
		entries = append(entries, nodeArray(numbers...))
	}
	return nodeArray(entries...)
}

func novelaiNumberArray(values []float64) orderedNodeJSON {
	numbers := make([]orderedNodeJSON, 0, len(values))
	for _, value := range values {
		numbers = append(numbers, nodeNumber(value))
	}
	return nodeArray(numbers...)
}

func novelaiLogitBiasArray(list []orderedNodeJSON) orderedNodeJSON { return nodeArray(list...) }

func novelaiLogitBiasNode(bias novelaiLogitBias) orderedNodeJSON {
	sequence := make([]orderedNodeJSON, 0, len(bias.Sequence))
	for _, id := range bias.Sequence {
		sequence = append(sequence, nodeNumber(id))
	}
	node := nodeObject()
	node.setMember("sequence", nodeArray(sequence...))
	node.setMember("bias", nodeNumber(bias.Bias))
	node.setMember("ensure_sequence_finish", nodeBool(bias.EnsureSequenceFinish))
	node.setMember("generate_once", nodeBool(bias.GenerateOnce))
	return node
}

// ---- /api/novelai/generate -------------------------------------------------------------------

// serveNovelAIGenerate is novelai.js:167.
func (runtime *accountRuntime) serveNovelAIGenerate(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_novel")
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	modelNode := sdBodyMember(body, "model")
	// `getBadWordsList(req.body.model)` runs OUTSIDE the pinned try block, so a missing or non-string
	// model is `undefined.includes is not a function`: an unhandled rejection that terminates the
	// pinned process. There is therefore no oracle for it (recorded in the fixture knownDifferences);
	// GoTavern answers 500 and keeps serving, the same deviation the electronhub/sizes route records.
	if !modelNode.isString() {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	model, _ := modelNode.stringValue()

	badWords := novelaiBadWordsForModel(model)
	if requestWords := sdBodyMember(body, "bad_words_ids"); requestWords.kind == 'a' {
		for _, candidate := range requestWords.array {
			if list, integers := novelaiIntegerList(candidate); integers {
				badWords = append(badWords, list)
			}
		}
	}
	// novelai.js:195-199 removes empty entries with a splice INSIDE a for..of over the same array,
	// so the entry that shifts into the removed index is skipped: two empty entries leave one behind.
	// Indices advance exactly as the JavaScript iterator does, which is what reproduces that skip.
	for index := 0; index < len(badWords); index++ {
		if len(badWords[index]) != 0 {
			continue
		}
		badWords = append(badWords[:index], badWords[index+1:]...)
	}

	logitBias := make([]orderedNodeJSON, 0, 3)
	for _, bias := range novelaiLogitBiasForModel(model) {
		logitBias = append(logitBias, novelaiLogitBiasNode(bias))
	}
	if requestBias := sdBodyMember(body, "logit_bias_exp"); requestBias.kind == 'a' {
		logitBias = append(logitBias, requestBias.array...)
	}

	parameters := nodeObject()
	setParameter := func(name string, value orderedNodeJSON) {
		// JSON.stringify drops an `undefined` member and keeps `null`, so only undefined is skipped.
		if value.isUndefined() {
			return
		}
		parameters.setMember(name, value)
	}
	// `req.body.use_string ?? true`: nullish, not falsy. `use_string: null` becomes true.
	useString := sdBodyMember(body, "use_string")
	if useString.isUndefined() || useString.isNull() {
		useString = nodeBool(true)
	}
	setParameter("use_string", useString)
	for _, name := range []string{
		"temperature", "max_length", "min_length", "tail_free_sampling", "repetition_penalty",
		"repetition_penalty_range", "repetition_penalty_slope", "repetition_penalty_frequency",
		"repetition_penalty_presence",
	} {
		setParameter(name, sdBodyMember(body, name))
	}
	if whitelist, present := novelaiRepPenWhitelistForModel(model); present {
		parameters.setMember("repetition_penalty_whitelist", novelaiNumberArray(whitelist))
	} else {
		parameters.setMember("repetition_penalty_whitelist", novelaiNull())
	}
	for _, name := range []string{
		"top_a", "top_p", "top_k", "typical_p", "mirostat_lr", "mirostat_tau", "phrase_rep_pen",
		"stop_sequences",
	} {
		setParameter(name, sdBodyMember(body, name))
	}
	if len(badWords) != 0 {
		parameters.setMember("bad_words_ids", novelaiBadWordArray(badWords))
	} else {
		parameters.setMember("bad_words_ids", novelaiNull())
	}
	parameters.setMember("logit_bias_exp", novelaiLogitBiasArray(logitBias))
	for _, name := range []string{
		"generate_until_sentence", "use_cache", "return_full_text", "prefix", "order",
		"num_logprobs", "min_p", "math1_temp", "math1_quad", "math1_quad_entropy_scale",
	} {
		setParameter(name, sdBodyMember(body, name))
	}
	// novelai.js:249-256: strict equality on the prefix, then a family test on the model. The
	// member is appended, so it is LAST in the serialized parameter object.
	if prefix, isPrefixString := sdBodyMember(body, "prefix").stringValue(); isPrefixString && prefix == "theme_textadventure" {
		if strings.Contains(model, "clio") || strings.Contains(model, "kayra") {
			parameters.setMember("eos_token_id", nodeNumber(49405))
		}
		if strings.Contains(model, "erato") {
			parameters.setMember("eos_token_id", nodeNumber(29))
		}
	}

	data := nodeObject()
	setParameter = func(name string, value orderedNodeJSON) {
		if value.isUndefined() {
			return
		}
		data.setMember(name, value)
	}
	setParameter("input", sdBodyMember(body, "input"))
	setParameter("model", modelNode)
	data.setMember("parameters", parameters)
	payload, marshalErr := marshalOrderedNodeJSON(data)
	if marshalErr != nil {
		novelaiErrorTrue(w)
		return
	}

	// novelai.js:266-269. The whole block is inside the pinned try, so a URL that cannot be built is
	// the same {error:true} envelope as a rejected fetch.
	baseURL := novelaiAPIURL()
	if strings.Contains(model, "kayra") || strings.Contains(model, "erato") {
		baseURL = novelaiTextURL()
	}
	streaming := pinnedJSTruthy(sdBodyMember(body, "streaming"))
	target := baseURL + "/ai/generate"
	if streaming {
		target = baseURL + "/ai/generate-stream"
	}
	headers := map[string]string{
		"content-type":  "application/json",
		"authorization": "Bearer " + key,
	}
	if streaming {
		response, fetchErr := novelaiFetchStreaming(request.Context(), searchRequest{
			Method: http.MethodPost, URL: target, Headers: headers, Body: payload,
		})
		if fetchErr != nil {
			novelaiErrorTrue(w)
			return
		}
		novelaiForwardStream(w, response)
		return
	}

	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method: http.MethodPost, URL: target, Headers: headers, Body: payload,
	})
	if fetchErr != nil {
		novelaiErrorTrue(w)
		return
	}
	if !sdResponseOK(response) {
		// novelai.js:275-288: the message is `data.message` when the error body parses as JSON and
		// the raw text otherwise. `sdMemberOf` reports false for a null/undefined body, which is the
		// TypeError the pinned inner catch swallows, leaving the raw text in place; a member that is
		// present but undefined (a JSON string, number, array or object with no message) serializes
		// away, which is why the member is only set when it is not undefined.
		message := nodeString(string(response.Body))
		if parsed, parseErr := decodeOrderedNodeJSON(response.Body); parseErr == nil {
			if member, accessed := sdMemberOf(parsed, "message"); accessed {
				message = member
			}
		}
		errorPayload := nodeObject()
		if !message.isUndefined() {
			errorPayload.setMember("message", message)
		}
		envelope := nodeObject()
		envelope.setMember("error", errorPayload)
		respondOrderedNodeJSON(w, http.StatusInternalServerError, envelope)
		return
	}
	data, parsed := sdReadJSON(response)
	if !parsed {
		// `await response.json()` rejects on a 200 that is not JSON, and the pinned catch answers
		// {error:true} at status 200.
		novelaiErrorTrue(w)
		return
	}
	// `res.send(data)` dispatches on the JavaScript type: an object or array as JSON, a string as
	// text/html, null as an empty body, a number as the deprecated res.send(status) form.
	serveSDValue(w, data)
}

// novelaiFetchStreaming is searchFetch with the body left open, for the branch that forwards SSE
// frames. It is a deliberate COPY of searchFetch's node-fetch redirect loop rather than a refactor
// of it: outbound.Send reads the whole body, and the redirect rules (303 to GET, 301/302 to GET for
// a POST, credential dropping across a host or scheme change, node-fetch's 20-hop limit) are the
// behaviour under test, so the two paths must not drift apart silently. The only difference is
// SendStreaming in place of Send, plus closing the rejected body when a hop is abandoned.
func novelaiFetchStreaming(ctx context.Context, request searchRequest) (*outbound.Response, error) {
	current := request
	currentURL, err := url.Parse(current.URL)
	if err != nil || currentURL.Host == "" {
		return nil, errors.New("invalid upstream url")
	}
	for redirects := 0; ; redirects++ {
		headers := searchNodeFetchHeaders(current.Headers, current.Body)
		headers = append(headers, outbound.Header{Name: "Host", Value: sdHostHeader(currentURL)})
		if !searchHasHeader(current.Headers, "connection") {
			headers = append(headers, outbound.Header{Name: "Connection", Value: "close"})
		}
		response, sendErr := outbound.SendStreaming(ctx, outbound.Request{
			URL:     currentURL.String(),
			Method:  current.Method,
			Headers: headers,
			Body:    current.Body,
		}, 0)
		if sendErr != nil {
			return nil, sendErr
		}
		if !sdIsRedirectStatus(response.Status) {
			return response, nil
		}
		location := response.Header("Location")
		if location == "" {
			return response, nil
		}
		nextURL, locationErr := currentURL.Parse(location)
		if locationErr != nil {
			_ = response.Stream.Close()
			return nil, locationErr
		}
		if redirects >= sdMaxRedirects {
			_ = response.Stream.Close()
			return nil, errors.New("maximum redirect reached")
		}
		_ = response.Stream.Close()
		nextHeaders := map[string]string{}
		for name, value := range current.Headers {
			nextHeaders[name] = value
		}
		if !sdDomainOrSubdomain(currentURL, nextURL) || !strings.EqualFold(currentURL.Scheme, nextURL.Scheme) {
			for _, name := range []string{"authorization", "www-authenticate", "cookie", "cookie2"} {
				delete(nextHeaders, name)
			}
		}
		method := current.Method
		body := current.Body
		if response.Status == http.StatusSeeOther ||
			((response.Status == http.StatusMovedPermanently || response.Status == http.StatusFound) && method == http.MethodPost) {
			method = http.MethodGet
			body = nil
		}
		currentURL = nextURL
		current.Method = method
		current.Body = body
		current.Headers = nextHeaders
	}
}

// novelaiForwardStream is forwardFetchResponse (src/util.js:732).
//
// Pinned sets the Express status to the upstream one (rewriting 401 to 400 so a streamed reply
// cannot reset the browser's Basic Auth prompt), sets NO content type, and PIPES the source body.
// The consequence a capture sees is framing: no content-length, no content-type, chunked encoding.
// The non-ok branch ends the response with the raw error text, which is chunk-framed for the same
// reason. Go would otherwise helpfully add a content-length for a small body, so the header is
// flushed before any body byte is written.
func novelaiForwardStream(w http.ResponseWriter, response *outbound.Response) {
	status := response.Status
	if status == http.StatusUnauthorized {
		status = http.StatusBadRequest
	}
	// Nothing sets a content type, so the pinned compression middleware never runs its vary step and
	// Vary keeps only the CORS entry.
	w.Header().Set("Vary", "Origin")
	// Mark the header as present with no value, which stops net/http sniffing the first write and
	// inventing a content type the pinned response does not have.
	w.Header()["Content-Type"] = nil
	flusher, _ := w.(http.Flusher)

	if response.Status < 200 || response.Status > 299 {
		body, _ := io.ReadAll(response.Stream)
		_ = response.Stream.Close()
		w.WriteHeader(status)
		if flusher != nil {
			flusher.Flush()
		}
		_, _ = w.Write(body)
		return
	}

	w.WriteHeader(status)
	if flusher != nil {
		flusher.Flush()
	}
	buffer := make([]byte, 32*1024)
	for {
		count, readErr := response.Stream.Read(buffer)
		if count > 0 {
			if _, writeErr := w.Write(buffer[:count]); writeErr != nil {
				break
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			break
		}
	}
	_ = response.Stream.Close()
}

// ---- /api/novelai/generate-image -------------------------------------------------------------

// serveNovelAIGenerateImage is novelai.js:300.
func (runtime *accountRuntime) serveNovelAIGenerateImage(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_novel")
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}

	// Every member below is `request.body.X ?? <pinned default>`: nullish, so `height: 0` stays 0
	// while `height: null` becomes 512, and a member that is absent is replaced by the default rather
	// than omitted.
	prompt := nodeNullish(sdBodyMember(body, "prompt"), nodeString(""))
	model := nodeNullish(sdBodyMember(body, "model"), nodeString("nai-diffusion"))
	negativePrompt := nodeNullish(sdBodyMember(body, "negative_prompt"), nodeString(""))
	height := nodeNullish(sdBodyMember(body, "height"), nodeNumber(512))
	width := nodeNullish(sdBodyMember(body, "width"), nodeNumber(512))
	scale := nodeNullish(sdBodyMember(body, "scale"), nodeNumber(9))
	sampler := nodeNullish(sdBodyMember(body, "sampler"), nodeString("k_dpmpp_2m"))
	scheduler := nodeNullish(sdBodyMember(body, "scheduler"), nodeString("karras"))
	steps := nodeNullish(sdBodyMember(body, "steps"), nodeNumber(28))
	decrisper := nodeNullish(sdBodyMember(body, "decrisper"), nodeBool(false))
	sm := nodeNullish(sdBodyMember(body, "sm"), nodeBool(false))
	smDyn := nodeNullish(sdBodyMember(body, "sm_dyn"), nodeBool(false))
	upscaleRatio := sdBodyMember(body, "upscale_ratio")

	parameters := nodeObject()
	parameters.setMember("params_version", nodeNumber(3))
	parameters.setMember("prefer_brownian", nodeBool(true))
	parameters.setMember("negative_prompt", negativePrompt)
	parameters.setMember("height", height)
	parameters.setMember("width", width)
	parameters.setMember("scale", scale)
	parameters.setMember("seed", novelaiSeed(sdBodyMember(body, "seed")))
	parameters.setMember("sampler", sampler)
	parameters.setMember("noise_schedule", scheduler)
	parameters.setMember("steps", steps)
	parameters.setMember("n_samples", nodeNumber(1))
	parameters.setMember("ucPreset", nodeNumber(0))
	parameters.setMember("qualityToggle", nodeBool(false))
	parameters.setMember("add_original_image", nodeBool(false))
	parameters.setMember("controlnet_strength", nodeNumber(1))
	parameters.setMember("deliberate_euler_ancestral_bug", nodeBool(false))
	parameters.setMember("dynamic_thresholding", decrisper)
	parameters.setMember("legacy", nodeBool(false))
	parameters.setMember("legacy_v3_extend", nodeBool(false))
	parameters.setMember("sm", sm)
	parameters.setMember("sm_dyn", smDyn)
	parameters.setMember("uncond_scale", nodeNumber(1))
	if pinnedJSTruthy(sdBodyMember(body, "variety_boost")) {
		sigma, computed := novelaiSkipCfgAboveSigma(width, height, model)
		if !computed {
			// `modelName?.includes` throws for a non-nullish non-string model, which the pinned outer
			// catch turns into sendStatus(500).
			backendsStatus(w, http.StatusInternalServerError)
			return
		}
		parameters.setMember("skip_cfg_above_sigma", nodeNumber(sigma))
	} else {
		parameters.setMember("skip_cfg_above_sigma", novelaiNull())
	}
	parameters.setMember("use_coords", nodeBool(false))
	parameters.setMember("characterPrompts", nodeArray())
	parameters.setMember("reference_image_multiple", nodeArray())
	parameters.setMember("reference_information_extracted_multiple", nodeArray())
	parameters.setMember("reference_strength_multiple", nodeArray())
	negativeCaption := nodeObject()
	negativeCaption.setMember("base_caption", negativePrompt)
	negativeCaption.setMember("char_captions", nodeArray())
	v4Negative := nodeObject()
	v4Negative.setMember("caption", negativeCaption)
	parameters.setMember("v4_negative_prompt", v4Negative)
	positiveCaption := nodeObject()
	positiveCaption.setMember("base_caption", prompt)
	positiveCaption.setMember("char_captions", nodeArray())
	v4Prompt := nodeObject()
	v4Prompt.setMember("caption", positiveCaption)
	v4Prompt.setMember("use_coords", nodeBool(false))
	v4Prompt.setMember("use_order", nodeBool(true))
	parameters.setMember("v4_prompt", v4Prompt)

	data := nodeObject()
	data.setMember("action", nodeString("generate"))
	data.setMember("input", prompt)
	data.setMember("model", model)
	data.setMember("parameters", parameters)
	payload, marshalErr := marshalOrderedNodeJSON(data)
	if marshalErr != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}

	headers := map[string]string{
		"authorization": "Bearer " + key,
		"content-type":  "application/json",
	}
	archive, fetchErr := searchFetch(request.Context(), searchRequest{
		Method: http.MethodPost, URL: novelaiImageURL() + "/ai/generate-image", Headers: headers, Body: payload,
	})
	if fetchErr != nil || !sdResponseOK(archive) {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	image, found := novelaiExtractPNG(archive.Body)
	if !found {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	original := base64.StdEncoding.EncodeToString(image)

	// novelai.js:396: `isNaN(upscale_ratio) || upscale_ratio <= 1` skips the second request. Both
	// halves are JavaScript coercions: "2" IS a number to isNaN, so a string ratio upscales, and a
	// member that cannot be coerced to a number is skipped instead of erroring.
	ratioNumber, ratioIsNumber := jsNumber(upscaleRatio)
	if !ratioIsNumber || ratioNumber <= 1 {
		// `res.send(string)` is html-typed, which is what the fixture records.
		respondText(w, http.StatusOK, "text/html; charset=utf-8", original)
		return
	}
	// novelai.js:411-412 passes `request.body.height` and `request.body.width` STRAIGHT through, not
	// the values defaulted for the generate request, so an absent size is omitted from the upscale
	// body while the generate body still carried 512. The scenario
	// generate-image.upscaleOmitsSize is what caught an implementation that forwarded the defaults.
	upscaled, upscaleOK := novelaiUpscaleImage(request.Context(), key, original,
		sdBodyMember(body, "height"), sdBodyMember(body, "width"), upscaleRatio)
	if !upscaleOK {
		// Every failure of the second request falls back to the ORIGINAL base64 at status 200.
		respondText(w, http.StatusOK, "text/html; charset=utf-8", original)
		return
	}
	respondText(w, http.StatusOK, "text/html; charset=utf-8", upscaled)
}

// novelaiSeed is `request.body.seed >= 0 ? request.body.seed : Math.floor(Math.random() * 9999999999)`.
// The comparison is JavaScript `>=`: an absent seed coerces to NaN and is replaced, `null` coerces to
// 0 and is KEPT as null, and a numeric string is kept as the string it was.
func novelaiSeed(value orderedNodeJSON) orderedNodeJSON {
	number, isNumber := jsNumber(value)
	if isNumber && number >= 0 {
		return value
	}
	return nodeNumber(float64(rand.Int64N(9999999999)))
}

// novelaiSkipCfgAboveSigma is calculateSkipCfgAboveSigma (novelai.js:120). The second result is
// false where the pinned optional chain would throw (a non-nullish non-string model name).
func novelaiSkipCfgAboveSigma(width, height, model orderedNodeJSON) (float64, bool) {
	modelName, isModelString := model.stringValue()
	if !isModelString {
		return 0, false
	}
	magicConstant := 19.0
	if strings.Contains(modelName, "nai-diffusion-4-5") {
		magicConstant = 58
	}
	widthNumber, _ := jsNumber(width)
	heightNumber, _ := jsNumber(height)
	// width * height in JavaScript: NaN propagates, and JSON.stringify(NaN) is null.
	ratio := widthNumber * heightNumber / novelaiReferencePixelCount
	return math.Pow(ratio, 0.5) * magicConstant, true
}

// novelaiReferencePixelCount is REFERENCE_PIXEL_COUNT (novelai.js:15), the 832x1216 reference image.
const novelaiReferencePixelCount = 1011712

// novelaiUpscaleImage is novelai.js:400-431: the second request. It reports false for every failure
// the pinned catch swallows (a rejected fetch, a non-ok answer, an archive that will not open, an
// archive with no PNG), all of which fall back to the original image.
func novelaiUpscaleImage(ctx context.Context, key, original string, height, width, scale orderedNodeJSON) (string, bool) {
	payload := nodeObject()
	payload.setMember("image", nodeString(original))
	// novelai.js:411-412 reads request.body.height and request.body.width DIRECTLY, not the defaults
	// used for the generate request, so an absent size is omitted from this body.
	for _, member := range []struct {
		name  string
		value orderedNodeJSON
	}{{"height", height}, {"width", width}, {"scale", scale}} {
		if member.value.isUndefined() {
			continue
		}
		payload.setMember(member.name, member.value)
	}
	encoded, marshalErr := marshalOrderedNodeJSON(payload)
	if marshalErr != nil {
		return "", false
	}
	response, fetchErr := searchFetch(ctx, searchRequest{
		Method: http.MethodPost,
		URL:    novelaiAPIURL() + "/ai/upscale",
		Headers: map[string]string{
			"authorization": "Bearer " + key,
			"content-type":  "application/json",
		},
		Body: encoded,
	})
	if fetchErr != nil || !sdResponseOK(response) {
		return "", false
	}
	image, found := novelaiExtractPNG(response.Body)
	if !found {
		return "", false
	}
	return base64.StdEncoding.EncodeToString(image), true
}

// novelaiExtractPNG is extractFileFromZipBuffer(buffer, '.png') (src/util.js:207).
//
// yauzl reports the CENTRAL DIRECTORY order, takes the first entry whose name ends with `.png` and
// does not start with `__MACOSX`, and resolves null for a zip that will not open, an entry that will
// not open and a read that fails. The first match wins, so an earlier non-PNG member is skipped and a
// later PNG is never reached.
func novelaiExtractPNG(archive []byte) ([]byte, bool) {
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return nil, false
	}
	for _, entry := range reader.File {
		if !strings.HasSuffix(entry.Name, ".png") || strings.HasPrefix(entry.Name, "__MACOSX") {
			continue
		}
		file, openErr := entry.Open()
		if openErr != nil {
			continue
		}
		data, readErr := io.ReadAll(file)
		_ = file.Close()
		if readErr != nil {
			continue
		}
		return data, true
	}
	return nil, false
}
