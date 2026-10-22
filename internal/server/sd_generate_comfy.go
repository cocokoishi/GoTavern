package server

// The two pinned ComfyUI GENERATION routes:
//
//	POST /api/sd/comfy/generate        stable-diffusion.js:562
//	POST /api/sd/comfyrunpod/generate  stable-diffusion.js:668
//
// A CORRECTION worth recording, because the lane brief asserted the opposite: the local `/generate`
// handler reads NO file and substitutes NOTHING. It POSTs `request.body.prompt` to `{url}/prompt`
// verbatim, polls `{url}/history/<prompt_id>`, walks `item.outputs`, fetches `{url}/view` and answers
// the bytes as base64. The `"%prompt%"`/`"%seed%"` replacement lives in the BROWSER
// (public/scripts/extensions/stable-diffusion/index.js:4216-4300), which is why the recorded prompt
// bodies in tests/oracle/sillytavern-1.19.0-sd-comfy-generate.json are byte-identical to the request
// member and why the workflows directory is not even seeded by the probe.
//
// Both handlers answer `res.status(500).send(error.message)` in their catch, NOT `sendStatus`: the
// message TEXT is the body, so `Url must be a string. Received undefined` and `Invalid URL` are
// response bodies and not merely log lines.
//
// Two branches answer a V8 engine message (a property-read TypeError and a JSON.parse SyntaxError).
// GoTavern cannot reproduce engine error text, so it answers a fixed message; those scenarios are
// classified `shape` in the fixture and only their status and outbound count are compared.
//
// The pinned socket-close handler is reproduced with a request-context watcher: when the caller goes
// away before the response is written and before a history item was seen, it POSTs `/interrupt`
// (local, with `getBasicAuthHeader(body.auth)`) or `/cancel/<jobId>` (runpod, with the bearer key).
// That leg is a LABELLED implementation test: the probe peer answers instantly, so there is never an
// in-flight generation whose caller can disappear, exactly like the A1111 interrupt leg.

import (
	"context"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

const (
	sdComfyErrorText        = "ComfyUI returned an error"
	sdComfyGenerationFailed = "ComfyUI generation did not succeed."
	sdComfyNoOutputsText    = "ComfyUI did not return any recognizable outputs."
	sdComfyFetchFailedText  = "fetch failed"
	sdComfyRunPodSecretKey  = "api_key_comfy_runpod"
	sdComfyTextBodyType     = "text/plain;charset=UTF-8"
	sdComfyRequestTimeout   = 120 * time.Second
)

// The poll intervals. They are SOURCE-DERIVED (stable-diffusion.js:601 `await delay(100)` and :726
// `await delay(500)`) rather than recorded: a 100ms or 500ms duration cannot be bucketed on a host
// this slow, so TestSDComfyGeneratePollIntervalsArePinned asserts the constants instead.
const (
	sdComfyLocalPollDelay  = 100 * time.Millisecond
	sdComfyRunPodPollDelay = 500 * time.Millisecond
)

// sdComfyEngineMessageText is what GoTavern answers where the pinned catch would send a V8 message:
// `JSON.parse` of a non-JSON prompt, `data.prompt_id` on a null answer, `item.status.status_str` on a
// history entry without status, and `await result.json()` on a non-JSON provider answer. The fixture
// classifies those responses `shape` and compares only the status, so this text is not a claim of
// parity â€” it is a named difference.
const sdComfyEngineMessageText = "ComfyUI returned an unparseable answer."

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerSDComfyGenerateRoutes)
}

func registerSDComfyGenerateRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/sd/comfy/generate", accounts.serveSDComfyGenerate)
	post("/api/sd/comfyrunpod/generate", accounts.serveSDComfyRunPodGenerate)
}

// sdComfyError is `res.status(500).send(error.message)`: text/html typed, with the message as the
// body, never `sendStatus`.
func sdComfyError(w http.ResponseWriter, message string) {
	respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", message)
}

// sdComfyRawURL is `request.body.url` as url-join receives it. url-join 5.0.0 throws
// `Url must be a string. Received <String(value)>` for a non-string first part, so a missing url is
// a 500 whose BODY names the problem.
//
// KNOWN DIFFERENCE, not probed: url-join wraps an ARRAY first part as its parts list and reads
// `.length` on an object, so `null` produces a V8 property-read message instead. GoTavern answers the
// same type message with JavaScript's String() form for every non-string.
func sdComfyRawURL(w http.ResponseWriter, body orderedNodeJSON) (string, bool) {
	value := sdBodyMember(body, "url")
	if value.kind == 's' {
		text, _ := value.stringValue()
		return text, true
	}
	text, err := pinnedJSStringValue(value)
	if err != nil {
		text = "undefined"
	}
	sdComfyError(w, "Url must be a string. Received "+text)
	return "", false
}

// sdComfyJoin is `new URL(urlJoin(base, component))`. A join that does not parse is `TypeError:
// Invalid URL`, whose message is what the catch sends.
func sdComfyJoin(base, component string) (string, bool) {
	parsed, ok := sdParseAbsoluteURL(sdURLJoin(base, component))
	if !ok {
		return "", false
	}
	return parsed.String(), true
}

func sdComfyJoinOrFail(w http.ResponseWriter, base, component string) (string, bool) {
	target, ok := sdComfyJoin(base, component)
	if !ok {
		sdComfyError(w, "Invalid URL")
		return "", false
	}
	return target, true
}

// sdComfySend performs one request with exactly the declared headers. The pinned hook records only
// the headers the ROUTE passes, which for every request here is none, so `extra` carries only what
// the route itself declared (the runpod bearer token).
func sdComfySend(ctx context.Context, method, target string, extra []outbound.Header, body []byte) (*outbound.Response, error) {
	headers := make([]outbound.Header, 0, len(extra)+3)
	headers = append(headers, outbound.Header{Name: "Host", Value: hostOf(target)})
	headers = append(headers, extra...)
	if body != nil {
		headers = append(headers, outbound.Header{Name: "Content-Length", Value: strconv.Itoa(len(body))})
	}
	return outbound.Send(ctx, outbound.Request{URL: target, Method: method, Headers: headers, Body: body}, sdComfyRequestTimeout)
}

// sdComfyDetached is the context the pinned fetches effectively run under: NO fetch in either handler
// takes a signal. The pinned handlers create an AbortController and never pass its signal to anything,
// which is exactly why the socket-close handler exists â€” the server keeps working after the caller
// goes away and asks ComfyUI to cancel through `/interrupt` or `/cancel/<jobId>`. Tying these calls to
// `request.Context()` would abort the first in-flight request instead, so the poll would never see the
// item the pinned loop would have seen. The inherited cost is the pinned one: an abandoned caller
// leaves the loop running.
func sdComfyDetached(*http.Request) context.Context {
	return context.Background()
}

// sdComfyPostText is a POST whose body is a JavaScript STRING, which node-fetch sends as
// `text/plain;charset=UTF-8` when the route declares no content type. That default is source-derived
// (node_modules/node-fetch/src/body.js:310 with request.js:90-93), not recorded: the hook sees no
// declared header at all. A nil body is a request with NO body, which node-fetch sends without a
// content type and without a content length.
func sdComfyPostText(ctx context.Context, target string, extra []outbound.Header, body []byte) (*outbound.Response, error) {
	if body == nil {
		return sdComfySend(ctx, http.MethodPost, target, extra, nil)
	}
	headers := append([]outbound.Header{{Name: "Content-Type", Value: sdComfyTextBodyType}}, extra...)
	return sdComfySend(ctx, http.MethodPost, target, headers, body)
}

// sdComfyMemberString is `value[key]` rendered with JavaScript ToString, where a primitive (or a
// missing member) yields undefined and therefore the text "undefined".
func sdComfyMemberString(value orderedNodeJSON, key string) string {
	member, ok := sdMemberOf(value, key)
	if !ok {
		return "undefined"
	}
	text, err := pinnedJSStringValue(member)
	if err != nil {
		return "undefined"
	}
	return text
}

// sdComfyQueryEncode reproduces the WHATWG SPECIAL-QUERY percent-encode set, which is what assigning
// `url.search = ...` applies to the interpolated values: C0 controls, space, `"`, `#`, `<`, `>`, `'`
// and every byte above 0x7E are escaped, while `&`, `=`, `/` and `%` are left alone. That asymmetry
// is the pinned behaviour and a filename containing `&` really does inject a query member.
func sdComfyQueryEncode(value string) string {
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		character := value[index]
		if character <= 0x20 || character >= 0x7f ||
			character == '"' || character == '#' || character == '<' || character == '>' || character == '\'' {
			builder.WriteByte('%')
			builder.WriteString(strings.ToUpper(strconv.FormatUint(uint64(character), 16)))
			continue
		}
		builder.WriteByte(character)
	}
	return builder.String()
}

// sdComfyWithQuery is `url.search = "?filename=â€¦"`: the query is replaced, never merged.
func sdComfyWithQuery(base, search string) (string, bool) {
	parsed, ok := sdParseAbsoluteURL(base)
	if !ok {
		return "", false
	}
	parsed.RawQuery = strings.TrimPrefix(search, "?")
	parsed.Fragment = ""
	parsed.RawFragment = ""
	return parsed.String(), true
}

// sdComfyFormat is `path.extname(filename).slice(1).toLowerCase() || 'png'`.
func sdComfyFormat(filename string) string {
	format := strings.ToLower(strings.TrimPrefix(sdNodePathExtname(filename), "."))
	if format == "" {
		return "png"
	}
	return format
}

// sdComfyElement is `entry[0]` where entry may be an ARRAY (an index) or an OBJECT (the same string
// key). `sdMemberOf` alone is wrong here: it reports an undefined member for every non-object, which
// silently skipped every `execution_error` traceback line and answered the bare first sentence.
func sdComfyElement(entry orderedNodeJSON, index int) (orderedNodeJSON, bool) {
	if entry.kind == 'a' {
		return sdIndex(entry, index)
	}
	return sdMemberOf(entry, strconv.Itoa(index))
}

// sdComfyExecutionErrors reproduces//
//
//	item.status?.messages?.filter(it => it[0] === 'execution_error').map(it => it[1])
//	    .map(it => `${it.node_type} [${it.node_id}] ${it.exception_type}: ${it.exception_message}`)
//	    .join('\n') || ''
//
// A non-array `messages` throws in the pinned handler (`.filter`), and `${it[1].node_type}` throws
// when the payload is null; both reach the catch, so this reports the engine-message branch instead
// of inventing traceback text.
func sdComfyExecutionErrors(status orderedNodeJSON) (string, bool) {
	messages, ok := sdMemberOf(status, "messages")
	if !ok {
		return "", false
	}
	if messages.isUndefined() || messages.isNull() {
		return "", true
	}
	if messages.kind != 'a' {
		return "", false
	}
	lines := make([]string, 0, len(messages.array))
	for _, entry := range messages.array {
		tag, tagOK := sdComfyElement(entry, 0)
		if !tagOK {
			return "", false
		}
		if text, isString := tag.stringValue(); !isString || text != "execution_error" {
			continue
		}
		payload, payloadOK := sdComfyElement(entry, 1)
		if !payloadOK {
			return "", false
		}
		lines = append(lines, sdComfyMemberString(payload, "node_type")+
			" ["+sdComfyMemberString(payload, "node_id")+"] "+
			sdComfyMemberString(payload, "exception_type")+": "+
			sdComfyMemberString(payload, "exception_message"))
	}
	return strings.Join(lines, "\n"), true
}

// sdComfyFlattenedFirst is `outputs.map(it => it.images).filter(Array.isArray).flat()[0]`, and the
// same expression for gifs once `images` is nullish. `usable` is false when an output value is
// nullish, because `it.images` throws there and the pinned catch answers 500.
func sdComfyFlattenedFirst(values []orderedNodeJSON, key string) (value orderedNodeJSON, found bool, usable bool) {
	for _, output := range values {
		members, ok := sdMemberOf(output, key)
		if !ok {
			return orderedNodeJSON{}, false, false
		}
		if members.kind != 'a' {
			continue
		}
		for _, candidate := range members.array {
			if candidate.kind == 'a' {
				if len(candidate.array) > 0 {
					return candidate.array[0], true, true
				}
				continue
			}
			return candidate, true, true
		}
	}
	return orderedNodeJSON{}, false, true
}

// sdComfyOutputValues is `Object.keys(item.outputs).map(it => item.outputs[it])`, including the
// integer-like key ordering Object.keys applies.
func sdComfyOutputValues(outputs orderedNodeJSON) []orderedNodeJSON {
	switch outputs.kind {
	case 'o':
		entries, _ := outputs.entries()
		values := make([]orderedNodeJSON, 0, len(entries))
		for _, entry := range entries {
			values = append(values, entry.value)
		}
		return values
	case 'a':
		return append([]orderedNodeJSON(nil), outputs.array...)
	default:
		return nil
	}
}

// serveSDComfyGenerate is stable-diffusion.js:562.
func (runtime *accountRuntime) serveSDComfyGenerate(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	base, ok := sdComfyRawURL(w, body)
	if !ok {
		return
	}
	promptURL, ok := sdComfyJoinOrFail(w, base, "/prompt")
	if !ok {
		return
	}
	// The pinned close listener is registered BEFORE the first fetch, and it is the only consumer of
	// `body.auth`: no fetch in this handler is signal-bound, so the AbortController is a no-op.
	authorization, _ := sdBasicAuthHeader(sdBodyMember(body, "auth"))
	var itemSeen atomic.Bool
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-request.Context().Done():
			if itemSeen.Load() {
				return
			}
			interruptURL, joined := sdComfyJoin(base, "/interrupt")
			if !joined {
				return
			}
			_, _ = sdComfySend(context.Background(), http.MethodPost, interruptURL,
				[]outbound.Header{{Name: "Authorization", Value: authorization}}, nil)
		case <-finished:
		}
	}()

	// `body: request.body.prompt`: a string is sent as given, an absent or null member sends nothing.
	var payload []byte
	if prompt := sdBodyMember(body, "prompt"); !prompt.isUndefined() && !prompt.isNull() {
		text, err := pinnedJSStringValue(prompt)
		if err != nil {
			sdComfyError(w, sdComfyEngineMessageText)
			return
		}
		payload = []byte(text)
	}
	promptResponse, err := sdComfyPostText(sdComfyDetached(request), promptURL, nil, payload)
	if err != nil {
		sdComfyError(w, sdComfyFetchFailedText)
		return
	}
	if !outboundOK(promptResponse) {
		// The pinned `cause` (tryParse of the provider text) is only logged; the body is the message.
		sdComfyError(w, sdComfyErrorText)
		return
	}
	promptData, ok := sdReadJSON(promptResponse)
	if !ok {
		sdComfyError(w, sdComfyEngineMessageText)
		return
	}
	id, ok := sdMemberOf(promptData, "prompt_id")
	if !ok {
		sdComfyError(w, sdComfyEngineMessageText)
		return
	}
	idText, err := pinnedJSStringValue(id)
	if err != nil {
		sdComfyError(w, sdComfyEngineMessageText)
		return
	}
	historyURL, ok := sdComfyJoinOrFail(w, base, "/history/"+idText)
	if !ok {
		return
	}
	item := nodeUndefined()
	for {
		polled, pollErr := sdComfySend(sdComfyDetached(request), http.MethodGet, historyURL, nil, nil)
		if pollErr != nil {
			sdComfyError(w, sdComfyFetchFailedText)
			return
		}
		if !outboundOK(polled) {
			sdComfyError(w, sdComfyErrorText)
			return
		}
		history, ok := sdReadJSON(polled)
		if !ok {
			sdComfyError(w, sdComfyEngineMessageText)
			return
		}
		candidate, ok := sdMemberOf(history, idText)
		if !ok {
			sdComfyError(w, sdComfyEngineMessageText)
			return
		}
		if pinnedJSTruthy(candidate) {
			item = candidate
			itemSeen.Store(true)
			break
		}
		// The pinned loop has no attempt bound and no abortable delay: an exhausted job hangs there
		// exactly as it hangs here. That inherited property is recorded rather than "fixed" with a
		// timeout the product does not have.
		time.Sleep(sdComfyLocalPollDelay)
	}

	status, ok := sdMemberOf(item, "status")
	if !ok {
		sdComfyError(w, sdComfyEngineMessageText)
		return
	}
	statusStr, ok := sdMemberOf(status, "status_str")
	if !ok {
		sdComfyError(w, sdComfyEngineMessageText)
		return
	}
	if text, isString := statusStr.stringValue(); isString && text == "error" {
		errors, errorsOK := sdComfyExecutionErrors(status)
		if !errorsOK {
			sdComfyError(w, sdComfyEngineMessageText)
			return
		}
		sdComfyError(w, strings.TrimSpace(sdComfyGenerationFailed+"\n\n"+errors))
		return
	}

	outputs, ok := sdMemberOf(item, "outputs")
	if !ok {
		sdComfyError(w, sdComfyEngineMessageText)
		return
	}
	values := sdComfyOutputValues(outputs)
	image, found, usable := sdComfyFlattenedFirst(values, "images")
	if !usable {
		sdComfyError(w, sdComfyEngineMessageText)
		return
	}
	if !found || image.isNull() || image.isUndefined() {
		// `??` is NULLISH: only `images` being absent or null falls through to gifs.
		image, found, usable = sdComfyFlattenedFirst(values, "gifs")
		if !usable {
			sdComfyError(w, sdComfyEngineMessageText)
			return
		}
	}
	if !found || !pinnedJSTruthy(image) {
		sdComfyError(w, sdComfyNoOutputsText)
		return
	}
	filename := sdComfyMemberString(image, "filename")
	viewURL, ok := sdComfyJoinOrFail(w, base, "/view")
	if !ok {
		return
	}
	search := "?filename=" + sdComfyQueryEncode(filename) +
		"&subfolder=" + sdComfyQueryEncode(sdComfyMemberString(image, "subfolder")) +
		"&type=" + sdComfyQueryEncode(sdComfyMemberString(image, "type"))
	target, ok := sdComfyWithQuery(viewURL, search)
	if !ok {
		sdComfyError(w, "Invalid URL")
		return
	}
	imageResponse, err := sdComfySend(sdComfyDetached(request), http.MethodGet, target, nil, nil)
	if err != nil {
		sdComfyError(w, sdComfyFetchFailedText)
		return
	}
	if !outboundOK(imageResponse) {
		sdComfyError(w, sdComfyErrorText)
		return
	}
	answer := nodeObject()
	answer.setMember("format", nodeString(sdComfyFormat(filename)))
	answer.setMember("data", nodeString(base64.StdEncoding.EncodeToString(imageResponse.Body)))
	respondOrderedNodeJSON(w, http.StatusOK, answer)
}

// sdComfyParseWorkflow is `JSON.parse(request.body.prompt).prompt`. A parse failure is the V8
// SyntaxError branch and a `null` parse result throws on the property read; both report false.
func sdComfyParseWorkflow(text string) (orderedNodeJSON, bool) {
	parsed, err := decodeOrderedNodeJSON([]byte(text))
	if err != nil {
		return orderedNodeJSON{}, false
	}
	return sdMemberOf(parsed, "prompt")
}

// sdComfyWrapWorkflow is `workflow?.input?.workflow ? workflow : ({ input: { workflow } })`.
// JSON.stringify DROPS an undefined member, so an absent workflow body is `{"input":{}}`, not
// `{"input":{"workflow":null}}`.
func sdComfyWrapWorkflow(workflow orderedNodeJSON) orderedNodeJSON {
	if input, ok := sdMemberOf(workflow, "input"); ok && input.kind == 'o' {
		if inner, exists := input.member("workflow"); exists && pinnedJSTruthy(inner) {
			return workflow
		}
	}
	inner := nodeObject()
	if !workflow.isUndefined() {
		inner.setMember("workflow", workflow)
	}
	outer := nodeObject()
	outer.setMember("input", inner)
	return outer
}

// serveSDComfyRunPodGenerate is stable-diffusion.js:668.
func (runtime *accountRuntime) serveSDComfyRunPodGenerate(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, sdComfyRunPodSecretKey)
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		// `console.warn('RunPod key not found.')` then sendStatus(400): a refusal with no request.
		serveSDStatus(w, http.StatusBadRequest)
		return
	}
	base, ok := sdComfyRawURL(w, body)
	if !ok {
		return
	}
	runURL, ok := sdComfyJoinOrFail(w, base, "/run")
	if !ok {
		return
	}
	authorization := []outbound.Header{{Name: "Authorization", Value: "Bearer " + key}}

	// `/cancel/${jobId}` is built by the pinned close listener, so before the create returns the job
	// id is the JavaScript value `undefined` and its string form is what lands in the path.
	var jobID atomic.Value
	jobID.Store("undefined")
	var itemSeen atomic.Bool
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-request.Context().Done():
			if itemSeen.Load() {
				return
			}
			cancelURL, joined := sdComfyJoin(base, "/cancel/"+jobID.Load().(string))
			if !joined {
				return
			}
			_, _ = sdComfySend(context.Background(), http.MethodPost, cancelURL, authorization, nil)
		case <-finished:
		}
	}()

	promptText, err := pinnedJSStringValue(sdBodyMember(body, "prompt"))
	if err != nil {
		sdComfyError(w, sdComfyEngineMessageText)
		return
	}
	workflow, ok := sdComfyParseWorkflow(promptText)
	if !ok {
		sdComfyError(w, sdComfyEngineMessageText)
		return
	}
	payload, err := marshalOrderedNodeJSON(sdComfyWrapWorkflow(workflow))
	if err != nil {
		sdComfyError(w, sdComfyEngineMessageText)
		return
	}
	runResponse, err := sdComfyPostText(sdComfyDetached(request), runURL, authorization, payload)
	if err != nil {
		sdComfyError(w, sdComfyFetchFailedText)
		return
	}
	if !outboundOK(runResponse) {
		sdComfyError(w, sdComfyErrorText)
		return
	}
	runData, ok := sdReadJSON(runResponse)
	if !ok {
		sdComfyError(w, sdComfyEngineMessageText)
		return
	}
	id, ok := sdMemberOf(runData, "id")
	if !ok {
		sdComfyError(w, sdComfyEngineMessageText)
		return
	}
	idText, err := pinnedJSStringValue(id)
	if err != nil {
		sdComfyError(w, sdComfyEngineMessageText)
		return
	}
	jobID.Store(idText)
	statusURL, ok := sdComfyJoinOrFail(w, base, "/status/"+idText)
	if !ok {
		return
	}
	item := nodeUndefined()
	for {
		polled, pollErr := sdComfySend(sdComfyDetached(request), http.MethodGet, statusURL, authorization, nil)
		if pollErr != nil {
			sdComfyError(w, sdComfyFetchFailedText)
			return
		}
		if !outboundOK(polled) {
			sdComfyError(w, sdComfyErrorText)
			return
		}
		status, ok := sdReadJSON(polled)
		if !ok {
			sdComfyError(w, sdComfyEngineMessageText)
			return
		}
		output, ok := sdMemberOf(status, "output")
		if !ok {
			sdComfyError(w, sdComfyEngineMessageText)
			return
		}
		if pinnedJSTruthy(output) {
			images, imagesOK := sdMemberOf(output, "images")
			if !imagesOK {
				sdComfyError(w, sdComfyEngineMessageText)
				return
			}
			first, firstOK := sdIndex(images, 0)
			if !firstOK {
				sdComfyError(w, sdComfyEngineMessageText)
				return
			}
			item = first
		}
		if pinnedJSTruthy(item) {
			itemSeen.Store(true)
			break
		}
		// An `output.images` that is empty keeps polling forever, exactly as pinned does.
		time.Sleep(sdComfyRunPodPollDelay)
	}

	format := sdComfyFormat(sdComfyMemberString(item, "filename"))
	answer := nodeObject()
	answer.setMember("format", nodeString(format))
	// `data: item.data` with an undefined data member is OMITTED by JSON.stringify, not sent as null.
	if data, ok := sdMemberOf(item, "data"); ok && !data.isUndefined() {
		answer.setMember("data", data)
	}
	respondOrderedNodeJSON(w, http.StatusOK, answer)
}
