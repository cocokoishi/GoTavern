package server

// POST /api/backends/text-completions/generate (src/endpoints/backends/text-completions.js:272).
//
// A per-api_type proxy. The pinned handler:
//   - rewrites the FIRST `localhost` in `request.body.api_server` to `127.0.0.1` and mutates the body;
//   - appends a suffix that depends on the type, and appends NOTHING for a type the switch does not
//     know — this route has no unimplemented branch, so there is nothing here to answer 501 for;
//   - sends `JSON.stringify(request.body)` after a lodash `pickBy` allowlist per type, with three
//     types rewriting a member: generic slices `stop` to four, openrouter folds `provider` +
//     `quantizations` into a provider object, and ollama REBUILDS the body from an explicit literal;
//   - sets `{ 'Content-Type': 'application/json' }` plus the per-type secret headers
//     (`setAdditionalHeaders`, shared with the sibling textgen routes) and the two referer literals of
//     openrouter/featherless;
//   - answers a non-stream 2xx by re-sending the parsed body (INFERMATICAI remaps
//     `choices[].message.content` into `choices[].text`), a non-2xx by
//     `{ error: true, status, response: <text> }` at status 200, and a THROWN fetch by the same
//     envelope with status `"UNKNOWN"`;
//   - for `stream: true` pipes the provider reply through forwardFetchResponse (401 rewritten to 400,
//     NO content type set) or, for ollama, re-frames newline-delimited JSON as SSE and terminates with
//     `data: [DONE]`.
//
// TWO THINGS THIS FILE DOES NOT CLAIM. Non-buffering is source-derived (`from.body.pipe(to)` in
// src/util.js forwardFetchResponse) because the oracle peer answers one buffered chunk; the GO side is
// proved separately against a held-open peer. And the koboldcpp abort leg (`/api/extra/abort` on
// client close) has no recordable pinned scenario — the peer answers immediately — so it is a labelled
// implementation test, like the A1111 interrupt and the ComfyUI cancel legs.
//
// A `config.yaml` `ollama.keepAlive`/`ollama.batchSize` is read only when it is a STRING (the shared
// config reader returns strings); the fixture records the pinned defaults (-1), and a numeric override
// is a documented gap rather than a silent divergence.

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

const (
	backendsTextgenJSONType        = "application/json"
	backendsTextgenEngineMessage   = "The text-completion backend did not answer with JSON."
	backendsTextgenFetchFailedText = "fetch failed"
	backendsTextgenUnknownStatus   = "UNKNOWN"
)

// errBackendsTextgenRedirects is node-fetch's `maximum redirect reached` refusal.
var errBackendsTextgenRedirects = errors.New("maximum redirect reached")

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerBackendsTextgenGenerateRoutes)
}

func registerBackendsTextgenGenerateRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("/api/backends/text-completions/generate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveBackendsTextCompletionGenerate(w, r)
	})
}

// backendsTextgenSuffix is the pinned api_type -> path switch. An unknown type returns "" and the base
// URL is the target, which is the pinned fall-through rather than a refusal.
func backendsTextgenSuffix(apiType string) string {
	switch apiType {
	case "generic", "vllm", "featherless", "aphrodite", "ooba", "tabby", "koboldcpp", "togetherai", "infermaticai", "huggingface":
		return "/v1/completions"
	case "dreamgen":
		return "/api/openai/v1/completions"
	case "mancer":
		return "/oai/v1/completions"
	case "llamacpp":
		return "/completion"
	case "ollama":
		return "/api/generate"
	case "openrouter":
		return "/v1/chat/completions"
	default:
		return ""
	}
}

// The lodash `pickBy` allowlists, transcribed from src/constants.js.
var (
	backendsTextgenTogetherKeys    = []string{"model", "prompt", "max_tokens", "temperature", "top_p", "top_k", "repetition_penalty", "min_p", "presence_penalty", "frequency_penalty", "stream", "stop"}
	backendsTextgenInfermaticKeys  = []string{"model", "prompt", "max_tokens", "temperature", "top_p", "top_k", "repetition_penalty", "stream", "stop", "presence_penalty", "frequency_penalty", "min_p", "seed", "ignore_eos", "n", "best_of", "min_tokens", "spaces_between_special_tokens", "skip_special_tokens", "logprobs"}
	backendsTextgenFeatherlessKeys = []string{"model", "prompt", "best_of", "echo", "frequency_penalty", "logit_bias", "logprobs", "max_tokens", "n", "presence_penalty", "seed", "stop", "stream", "suffix", "temperature", "top_p", "user", "use_beam_search", "top_k", "min_p", "repetition_penalty", "length_penalty", "early_stopping", "stop_token_ids", "ignore_eos", "min_tokens", "skip_special_tokens", "spaces_between_special_tokens", "truncate_prompt_tokens", "include_stop_str_in_output", "response_format", "guided_json", "guided_regex", "guided_choice", "guided_grammar", "guided_decoding_backend", "guided_whitespace_pattern"}
	backendsTextgenGenericKeys     = []string{"model", "prompt", "stream", "temperature", "top_p", "frequency_penalty", "presence_penalty", "stop", "seed", "logit_bias", "logprobs", "max_tokens", "n", "best_of"}
	backendsTextgenOpenRouterKeys  = []string{"max_tokens", "temperature", "top_k", "top_p", "presence_penalty", "frequency_penalty", "repetition_penalty", "min_p", "top_a", "seed", "logit_bias", "model", "stream", "prompt", "stop", "provider", "include_reasoning"}
	backendsTextgenVLLMKeys        = []string{"model", "prompt", "best_of", "echo", "frequency_penalty", "logit_bias", "logprobs", "max_tokens", "n", "presence_penalty", "seed", "stop", "stream", "suffix", "temperature", "top_p", "user", "use_beam_search", "top_k", "min_p", "repetition_penalty", "length_penalty", "early_stopping", "stop_token_ids", "ignore_eos", "min_tokens", "skip_special_tokens", "spaces_between_special_tokens", "truncate_prompt_tokens", "include_stop_str_in_output", "response_format", "guided_json", "guided_regex", "guided_choice", "guided_grammar", "guided_decoding_backend", "guided_whitespace_pattern"}
	backendsTextgenOllamaKeys      = []string{"num_predict", "num_ctx", "num_batch", "stop", "temperature", "repeat_penalty", "presence_penalty", "frequency_penalty", "top_k", "top_p", "tfs_z", "typical_p", "seed", "repeat_last_n", "min_p"}
)

// backendsTextgenPick reproduces `_.pickBy(body, (_, key) => allowlist.includes(key))`: only own
// enumerable members whose key is in the list, in JavaScript's key order, which `entries()` already
// gives (integer-like keys ascending, then insertion order).
func backendsTextgenPick(body orderedNodeJSON, allowlist []string) orderedNodeJSON {
	allowed := make(map[string]bool, len(allowlist))
	for _, key := range allowlist {
		allowed[key] = true
	}
	picked := nodeObject()
	if body.kind != 'o' {
		return picked
	}
	entries, _ := body.entries()
	for _, entry := range entries {
		if allowed[entry.key] {
			picked.setMember(entry.key, entry.value)
		}
	}
	return picked
}

// backendsTextgenEnvelope is the pinned catch/error shape `{ error: true, status, response }`, sent as
// an OBJECT at status 200 (`res.send(value)`), which is why Express answers JSON.
func backendsTextgenEnvelope(w http.ResponseWriter, status orderedNodeJSON, response string) {
	payload := nodeObject()
	payload.setMember("error", nodeBool(true))
	payload.setMember("status", status)
	payload.setMember("response", nodeString(response))
	respondOrderedNodeJSON(w, http.StatusOK, payload)
}

// backendsTextgenNumberConfig is `Number(getConfigValue(key, -1, 'number'))`. The shared config reader
// resolves the dotted key and the SILLYTAVERN_<KEY> override; it only returns strings, so a numeric
// YAML value falls back here (documented gap, the pinned default is what the fixture records).
func backendsTextgenNumberConfig(options HTTPHandlerOptions, path []string, fallback float64) float64 {
	text := googleConfigValue(options, path, "")
	if text == "" {
		return fallback
	}
	number, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil {
		return fallback
	}
	return number
}

// backendsTextgenStreamHeaders is searchFetch's node-fetch header construction for one hop.
func backendsTextgenStreamHeaders(explicit map[string]string, body []byte, target *url.URL) []outbound.Header {
	headers := searchNodeFetchHeaders(explicit, body)
	headers = append(headers, outbound.Header{Name: "Host", Value: sdHostHeader(target)})
	if !searchHasHeader(explicit, "connection") {
		headers = append(headers, outbound.Header{Name: "Connection", Value: "close"})
	}
	return headers
}

// backendsTextgenStreamFetch follows redirects exactly as searchFetch does, but keeps the final body as
// a stream so this process does not buffer the reply.
func backendsTextgenStreamFetch(ctx context.Context, request searchRequest) (*outbound.Response, error) {
	current := request
	currentURL, ok := sdParseAbsoluteURL(current.URL)
	if !ok {
		return nil, errors.New("invalid upstream url")
	}
	for redirects := 0; ; redirects++ {
		response, sendErr := outbound.SendStreaming(ctx, outbound.Request{
			URL:     currentURL.String(),
			Method:  current.Method,
			Headers: backendsTextgenStreamHeaders(current.Headers, current.Body, currentURL),
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
		_ = response.Stream.Close()
		if redirects >= sdMaxRedirects {
			return nil, errBackendsTextgenRedirects
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
	}
}

// forwardBackendsTextgenStream reproduces forwardFetchResponse (src/util.js:732): the provider status is
// copied (401 becomes 400 so a streamed reply cannot reset the browser's Basic Auth prompt), NO content
// type is set, and the provider body is piped.
func forwardBackendsTextgenStream(w http.ResponseWriter, response *outbound.Response) {
	status := response.Status
	if status == http.StatusUnauthorized {
		status = http.StatusBadRequest
	}
	// No Content-Type is set, so Express's compression middleware never runs its vary step and Vary
	// keeps only the CORS Origin entry. Marking the header as present with no value stops net/http from
	// sniffing the first write and inventing a content type the pinned response does not have.
	w.Header().Set("Vary", "Origin")
	w.Header()["Content-Type"] = nil

	buffer := make([]byte, 32*1024)
	if response.Status < 200 || response.Status > 299 {
		body := make([]byte, 0, 256)
		for {
			count, err := response.Stream.Read(buffer)
			if count > 0 {
				body = append(body, buffer[:count]...)
			}
			if err != nil {
				break
			}
		}
		_ = response.Stream.Close()
		w.WriteHeader(status)
		_, _ = w.Write(body)
		return
	}

	w.WriteHeader(status)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}
	for {
		count, err := response.Stream.Read(buffer)
		if count > 0 {
			if _, writeErr := w.Write(buffer[:count]); writeErr != nil {
				break
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			break
		}
	}
	_ = response.Stream.Close()
}

// forwardBackendsTextgenOllamaStream reproduces parseOllamaStream (text-completions.js:29): buffer
// bytes, try JSON.parse of everything buffered, and on success emit one SSE frame and clear the buffer.
// A frame split across chunks therefore waits for the rest, and a TRAILING incomplete frame is dropped
// at end-of-stream, which is the pinned behaviour.
func forwardBackendsTextgenOllamaStream(w http.ResponseWriter, response *outbound.Response) {
	w.Header().Set("Vary", "Origin")
	w.Header()["Content-Type"] = nil
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}
	partial := ""
	buffer := make([]byte, 32*1024)
	for {
		count, err := response.Stream.Read(buffer)
		if count > 0 {
			partial += string(buffer[:count])
			for {
				frame, decodeErr := decodeOrderedNodeJSON([]byte(partial))
				if decodeErr != nil {
					break
				}
				text, textOK := sdMemberOf(frame, "response")
				if !textOK {
					break
				}
				thinking, thinkingOK := sdMemberOf(frame, "thinking")
				if !thinkingOK {
					break
				}
				choice := nodeObject()
				choice.setMember("text", backendsTextgenOrEmpty(text))
				choice.setMember("thinking", backendsTextgenOrEmpty(thinking))
				chunk := nodeObject()
				chunk.setMember("choices", nodeArray(choice))
				encoded, marshalErr := marshalOrderedNodeJSON(chunk)
				if marshalErr != nil {
					break
				}
				_, _ = w.Write([]byte("data: " + string(encoded) + "\n\n"))
				if flusher != nil {
					flusher.Flush()
				}
				partial = ""
			}
		}
		if err != nil {
			break
		}
	}
	_ = response.Stream.Close()
	_, _ = w.Write([]byte("data: [DONE]\n\n"))
	if flusher != nil {
		flusher.Flush()
	}
}

// backendsTextgenOrEmpty is `json.response || ”`: a truthy member is kept AS A VALUE (a non-string is
// emitted as itself) and a falsy one becomes the empty string.
func backendsTextgenOrEmpty(value orderedNodeJSON) orderedNodeJSON {
	if pinnedJSTruthy(value) {
		return value
	}
	return nodeString("")
}

// backendsTextgenNullishMember is `body.X ?? fallback`.
func backendsTextgenNullishMember(body orderedNodeJSON, key string, fallback orderedNodeJSON) orderedNodeJSON {
	value, ok := sdMemberOf(body, key)
	if !ok || value.isNull() || value.isUndefined() {
		return fallback
	}
	return value
}

// backendsTextgenInfermaticChoices is the pinned InfermaticAI remap:
// `choices.map(choice => ({ text: choice?.message?.content || choice.text, logprobs: choice?.logprobs,
// index: choice?.index }))`. `logprobs`/`index` are literal members: an absent one is `undefined` and
// JSON.stringify drops it, while an explicit null survives.
func backendsTextgenInfermaticChoices(data orderedNodeJSON) orderedNodeJSON {
	if data.kind != 'o' {
		return data
	}
	choices, exists := data.member("choices")
	if !exists {
		choices = nodeArray()
	}
	if choices.kind != 'a' {
		choices = nodeArray()
	}
	mapped := nodeArray()
	for _, choice := range choices.array {
		entry := nodeObject()
		text := nodeUndefined()
		if message, ok := sdMemberOf(choice, "message"); ok {
			if content, contentOK := sdMemberOf(message, "content"); contentOK {
				text = content
			}
		}
		if !pinnedJSTruthy(text) {
			if fallback, fallbackOK := sdMemberOf(choice, "text"); fallbackOK {
				text = fallback
			}
		}
		// `text: choice?.message?.content || choice.text` is a literal member: when BOTH sides are
		// undefined JSON.stringify DROPS the key, which is why the third recorded choice is `{"index":2}`
		// and not `{"text":null,"index":2}`.
		if !text.isUndefined() {
			entry.setMember("text", text)
		}
		if logprobs, ok := sdMemberOf(choice, "logprobs"); ok && !logprobs.isUndefined() {
			entry.setMember("logprobs", logprobs)
		}
		if index, ok := sdMemberOf(choice, "index"); ok && !index.isUndefined() {
			entry.setMember("index", index)
		}
		mapped.array = append(mapped.array, entry)
	}
	data.setMember("choices", mapped)
	return data
}

// serveBackendsTextCompletionGenerate is text-completions.js:272.
func (runtime *accountRuntime) serveBackendsTextCompletionGenerate(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	apiServerNode := sdBodyMember(body, "api_server")
	if apiServerNode.kind != 's' {
		// `request.body.api_server.indexOf` throws INSIDE the pinned try, so the catch answers its own
		// envelope. The message there is V8 text, which GoTavern does not reproduce: the oracle records
		// this branch as `shape` (status and outbound count only) and this fixed text is the difference.
		backendsTextgenEnvelope(w, nodeString(backendsTextgenUnknownStatus), backendsTextgenEngineMessage)
		return
	}
	apiServer, _ := apiServerNode.stringValue()
	// `if (request.body.api_server.indexOf('localhost') !== -1)` then `.replace('localhost', ...)`
	// replaces only the FIRST occurrence and MUTATES the body, so the outbound request and the header
	// override both see the rewritten value.
	if strings.Contains(apiServer, "localhost") {
		apiServer = strings.Replace(apiServer, "localhost", "127.0.0.1", 1)
		body.setMember("api_server", nodeString(apiServer))
	}
	apiType, _ := sdBodyMember(body, "api_type").stringValue()
	// `const baseUrl = request.body.api_server` and `let url = trimV1(baseUrl)`: the OVERRIDE lookup
	// uses the untrimmed base, the request target the trimmed one.
	baseURL := nodeString(apiServer)
	trimmedBase := searchTrimV1(baseURL)
	target := trimmedBase + backendsTextgenSuffix(apiType)

	headers, err := backendsAdditionalHeaders(body, directories)
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	headers["content-type"] = backendsTextgenJSONType
	// text-completions.js:326-334: the Content-Type literal, then `setAdditionalHeaders(request, args,
	// baseUrl)` with the UNTRIMMED base, whose last act is the `requestOverrides` Object.assign.
	pinnedApplyRequestOverrides(directories, apiServer, headers)

	// Cancellation: the pinned fetch carries `signal: controller.signal`, and a client close on a
	// koboldcpp request also POSTs `{trimV1(base)}/api/extra/abort` with the additional headers. The
	// outbound calls below run under the request context for exactly that reason.
	finished := make(chan struct{})
	defer close(finished)
	if apiType == "koboldcpp" {
		go func() {
			select {
			case <-request.Context().Done():
				abortHeaders, headerErr := backendsAdditionalHeaders(body, directories)
				if headerErr != nil {
					return
				}
				// text-completions.js:80-89: `abortKoboldCppRequest(request, trimV1(baseUrl))` runs
				// setAdditionalHeaders against the TRIMMED base, so that is the host the override matches.
				pinnedApplyRequestOverrides(directories, trimmedBase, abortHeaders)
				// A detached context on purpose: the caller is already gone, and the pinned abort POST is a fresh fetch.
				_, _ = searchFetch(context.Background(), searchRequest{Method: http.MethodPost, URL: trimmedBase + "/api/extra/abort", Headers: abortHeaders})
			case <-finished:
			}
		}()
	}

	// Per-type body rewriting, in the pinned order; `args.body` is re-serialized after each branch.
	payload := body
	switch apiType {
	case "togetherai":
		payload = backendsTextgenPick(body, backendsTextgenTogetherKeys)
	case "infermaticai":
		payload = backendsTextgenPick(body, backendsTextgenInfermaticKeys)
	case "featherless":
		payload = backendsTextgenPick(body, backendsTextgenFeatherlessKeys)
	case "generic":
		payload = backendsTextgenPick(body, backendsTextgenGenericKeys)
		if stop, exists := payload.member("stop"); exists && stop.kind == 'a' && len(stop.array) > 4 {
			payload.setMember("stop", nodeArray(stop.array[:4]...))
		}
	case "openrouter":
		payload = backendsTextgenOpenRouterBody(body)
	case "vllm":
		payload = backendsTextgenPick(body, backendsTextgenVLLMKeys)
	case "ollama":
		keepAlive := backendsTextgenNumberConfig(runtime.options, []string{"ollama", "keepAlive"}, -1)
		numBatch := backendsTextgenNumberConfig(runtime.options, []string{"ollama", "batchSize"}, -1)
		if numBatch > 0 {
			body.setMember("num_batch", nodeNumber(numBatch))
		}
		options := backendsTextgenPick(body, backendsTextgenOllamaKeys)
		rebuilt := nodeObject()
		if model, exists := body.member("model"); exists && !model.isUndefined() {
			rebuilt.setMember("model", model)
		}
		if prompt, exists := body.member("prompt"); exists && !prompt.isUndefined() {
			rebuilt.setMember("prompt", prompt)
		}
		rebuilt.setMember("stream", backendsTextgenNullishMember(body, "stream", nodeBool(false)))
		rebuilt.setMember("keep_alive", nodeNumber(keepAlive))
		rebuilt.setMember("raw", nodeBool(true))
		rebuilt.setMember("options", options)
		payload = rebuilt
	}
	encoded, marshalErr := marshalOrderedNodeJSON(payload)
	if marshalErr != nil {
		backendsTextgenEnvelope(w, nodeString(backendsTextgenUnknownStatus), backendsTextgenEngineMessage)
		return
	}

	if pinnedJSTruthy(sdBodyMember(body, "stream")) {
		response, streamErr := backendsTextgenStreamFetch(request.Context(), searchRequest{
			Method: http.MethodPost, URL: target, Headers: headers, Body: encoded,
		})
		if streamErr != nil {
			backendsTextgenEnvelope(w, nodeString(backendsTextgenUnknownStatus), backendsTextgenFetchFailedText)
			return
		}
		if apiType == "ollama" {
			forwardBackendsTextgenOllamaStream(w, response)
			return
		}
		forwardBackendsTextgenStream(w, response)
		return
	}

	response, fetchErr := backendsFetch(request, searchRequest{Method: http.MethodPost, URL: target, Headers: headers, Body: encoded})
	if fetchErr != nil {
		backendsTextgenEnvelope(w, nodeString(backendsTextgenUnknownStatus), backendsTextgenFetchFailedText)
		return
	}
	if !sdResponseOK(response) {
		backendsTextgenEnvelope(w, nodeNumber(float64(response.Status)), string(response.Body))
		return
	}
	data, parsed := sdReadJSON(response)
	if !parsed {
		backendsTextgenEnvelope(w, nodeString(backendsTextgenUnknownStatus), backendsTextgenEngineMessage)
		return
	}
	if apiType == "infermaticai" {
		data = backendsTextgenInfermaticChoices(data)
	}
	serveSDValue(w, data)
}

// backendsTextgenOpenRouterBody is the openrouter member rewriting, which happens BEFORE the allowlist:
// a non-empty `provider` array becomes `{allow_fallbacks: body.allow_fallbacks ?? true, order: [...]}`,
// an empty or absent one is deleted, a non-empty `quantizations` array is attached to the provider, and
// the result is then filtered.
func backendsTextgenOpenRouterBody(body orderedNodeJSON) orderedNodeJSON {
	reshaped := body
	provider, exists := reshaped.member("provider")
	if exists && provider.kind == 'a' && len(provider.array) > 0 {
		folded := nodeObject()
		folded.setMember("allow_fallbacks", backendsTextgenNullishMember(reshaped, "allow_fallbacks", nodeBool(true)))
		folded.setMember("order", provider)
		reshaped.setMember("provider", folded)
	} else if exists {
		reshaped.deleteMember("provider")
	}
	if quantizations, quantExists := reshaped.member("quantizations"); quantExists && quantizations.kind == 'a' && len(quantizations.array) > 0 {
		providerNode, providerExists := reshaped.member("provider")
		if !providerExists || providerNode.kind != 'o' {
			providerNode = nodeObject()
		}
		providerNode.setMember("quantizations", quantizations)
		reshaped.setMember("provider", providerNode)
	}
	return backendsTextgenPick(reshaped, backendsTextgenOpenRouterKeys)
}
