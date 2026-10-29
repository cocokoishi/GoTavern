package server

// Pinned kobold streaming and multipart routes, from src/endpoints/backends/kobold.js:
//
//	POST /generate          (11)   live generation proxy: a JSON reply or a forwarded SSE stream
//	POST /transcribe-audio  (190)  multipart upload -> base64 JSON transcription request
//
// The wire contract is the captured one in
// tests/oracle/sillytavern-1.19.0-backends-deferred.json, recorded by tools/probe-backends.mjs
// (args=deferred) from the pinned server over a RAW SOCKET, because a fetch-based capture decodes
// away exactly what these routes exist for. Where this file and that capture disagree, the capture
// wins.
//
// Four pinned properties drive the structure here and none of them is guessable from a summary:
//
//   - the settings object is a JavaScript object literal built from `request.body.*`, so a member
//     whose request value is `undefined` is OMITTED from the upstream body instead of being sent
//     as null, and `singleline` is always present because it is `!!value`;
//   - a streamed reply forwards the upstream status (401 rewritten to 400) and the upstream body
//     verbatim, and sets NO content type at all (forwardFetchResponse, src/util.js:732);
//   - a non-ok non-streamed reply is answered 400 with `{error:{message}}`, where message is
//     `errorJson?.detail?.msg || errorText` -- the JSON member when it is JS-truthy, the raw text
//     otherwise; a transport failure is answered `{error:true}` at status 200, not 502;
//   - the abort request `POST {api_server}/extra/abort` is sent from the SOCKET-CLOSE handler when
//     `can_abort` is set and the response has not ended, which is what makes a client disconnect
//     observable at the provider.
//
// Unreachable pinned branches are recorded in the fixture's derivedOnly and deliberately not
// invented here: the `if (!request.body)` 400 (body-parser always installs an object) and the
// 403/503 retry loop (node-fetch does not throw on an HTTP status). A missing or non-string
// `api_server` throws inside the pinned async handler and exits the pinned process; this answers
// 500 instead, the same documented deviation the sibling /status route carries.

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

// pinnedKoboldUploadField is the only part name the pinned global multer middleware accepts:
// `multer({ dest: uploadsPath, limits: { fieldSize: 500 * 1024 * 1024 } }).single('avatar')`
// (src/server-main.js:269). A file part with any other name never becomes `request.file`.
const pinnedKoboldUploadField = "avatar"

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerBackendsKoboldDeferredRoutes)
}

func registerBackendsKoboldDeferredRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/backends/kobold/generate", accounts.serveBackendsKoboldGenerate)
	post("/api/backends/kobold/transcribe-audio", accounts.serveBackendsKoboldTranscribeAudio)
}

// pinnedKoboldSendAbort is the pinned socket-close handler's observable effect:
//
//	request.socket.on('close', async () => {
//	    if (request.body.can_abort && !response_generate.writableEnded) {
//	        await fetch(`${request.body.api_server}/extra/abort`, { method: 'POST' });
//	    }
//	});
//
// It is evaluated INLINE, at the moment the handler observes that the client went away, rather than
// from a goroutine watching the request context. That is not a stylistic choice: a goroutine races
// with the marker the handler sets after forwarding, so "did the client leave while the response was
// still open" would be decided by scheduler luck, and an implementation that ignored `can_abort`
// passed the capture roughly half the time (measured: mutation G3, run 39718428554, survived).
// Pinned decides the same question synchronously inside the socket-close listener, so this decides
// it synchronously too.
//
// The request's own context is already cancelled here (that is how the disconnect is known), and
// pinned never ties the abort fetch to its abort controller either, so the abort request is sent on
// a fresh context. A non-ok answer is only logged upstream (`console.error`).
func pinnedKoboldSendAbort(apiServer string) {
	response, err := searchFetch(context.Background(), searchRequest{
		Method: http.MethodPost,
		URL:    apiServer + "/extra/abort",
	})
	if err != nil {
		return
	}
	if response.Stream != nil {
		_ = response.Stream.Close()
	}
}

// pinnedKoboldGenerateSettings builds the upstream body the pinned object literal builds.
func pinnedKoboldGenerateSettings(body orderedNodeJSON) orderedNodeJSON {
	settings := nodeObject()
	// JSON.stringify omits a member whose value is undefined, and every `request.body.X` for an
	// absent member is undefined.
	set := func(key string, value orderedNodeJSON) {
		if value.isUndefined() {
			return
		}
		settings.setMember(key, value)
	}
	set("prompt", sdBodyMember(body, "prompt"))
	set("use_story", nodeBool(false))
	set("use_memory", nodeBool(false))
	set("use_authors_note", nodeBool(false))
	set("use_world_info", nodeBool(false))
	set("max_context_length", sdBodyMember(body, "max_context_length"))
	set("max_length", sdBodyMember(body, "max_length"))
	if !pinnedJSTruthy(sdBodyMember(body, "gui_settings")) {
		for _, key := range []string{
			"rep_pen", "rep_pen_range", "rep_pen_slope", "temperature", "tfs", "top_a", "top_k",
			"top_p", "min_p", "typical", "sampler_order",
		} {
			set(key, sdBodyMember(body, key))
		}
		// `singleline: !!request.body.singleline` -- always present, always a boolean.
		set("singleline", nodeBool(pinnedJSTruthy(sdBodyMember(body, "singleline"))))
		for _, key := range []string{
			"use_default_badwordsids", "mirostat", "mirostat_eta", "mirostat_tau", "grammar",
			"sampler_seed",
		} {
			set(key, sdBodyMember(body, key))
		}
		if stop, exists := body.member("stop_sequence"); exists && pinnedJSTruthy(stop) {
			set("stop_sequence", stop)
		}
	}
	return settings
}

// backendsStreamingFetch is the pinned node-fetch POST whose response body stays open, so the route
// can forward it frame by frame. It reuses the shared node-fetch wire model (explicit headers
// lowercased and sorted, the same defaults, Content-Length for a body, Host, and the transport
// Connection) so a streamed request is byte-identical to a buffered one.
func backendsStreamingFetch(request *http.Request, spec searchRequest) (*outbound.Response, error) {
	current := spec
	currentURL, validURL := searchURLValue(nodeString(current.URL))
	if !validURL {
		return nil, errors.New("invalid upstream url")
	}
	for redirects := 0; ; redirects++ {
		headers := searchNodeFetchHeaders(current.Headers, current.Body)
		headers = append(headers, outbound.Header{Name: "Host", Value: sdHostHeader(currentURL)})
		if !searchHasHeader(current.Headers, "connection") {
			headers = append(headers, outbound.Header{Name: "Connection", Value: "close"})
		}
		response, sendErr := outbound.SendStreaming(request.Context(), outbound.Request{
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
		// node-fetch drains and releases the body it is abandoning before following the hop.
		_, _ = io.Copy(io.Discard, response.Stream)
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

// serveBackendsKoboldGenerate is kobold.js:11.
func (runtime *accountRuntime) serveBackendsKoboldGenerate(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	apiServerNode := sdBodyMember(body, "api_server")
	apiServer, err := pinnedJSStringValue(apiServerNode)
	if err != nil || apiServerNode.kind != 's' {
		// The pinned handler throws here and the process exits; a server must not die, so this
		// answers the route's usual failure status instead (documented deviation).
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	apiServer = backendsKoboldRewriteLocalhost(apiServer)

	payload, marshalErr := marshalOrderedNodeJSON(pinnedKoboldGenerateSettings(body))
	if marshalErr != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}

	// `headers: Object.assign({ 'Content-Type': 'application/json' }, getOverrideHeaders(host))`.
	// No api-type key header is applied here: this route calls getOverrideHeaders, not
	// setAdditionalHeaders, so a configured koboldcpp secret must NOT appear (the capture records
	// that with the secret set).
	headers := map[string]string{"content-type": "application/json"}
	// kobold.js:86-89 puts `getOverrideHeaders((new URL(request.body.api_server))?.host)` in the SAME
	// Object.assign, AFTER the Content-Type literal, so `requestOverrides` wins over it. Applied here, at the
	// point the header set is complete, which is the same assignment in the same order.
	pinnedApplyRequestOverrides(directories, apiServer, headers)

	streaming := pinnedJSTruthy(sdBodyMember(body, "streaming"))
	target := apiServer + "/v1/generate"
	if streaming {
		target = apiServer + "/extra/generate/stream"
	}

	canAbort := pinnedJSTruthy(sdBodyMember(body, "can_abort"))

	response, fetchErr := backendsStreamingFetch(request, searchRequest{
		Method:  http.MethodPost,
		URL:     target,
		Headers: headers,
		Body:    payload,
	})
	if fetchErr != nil {
		// The pinned catch inspects `error.status`; node-fetch surfaces a transport failure as a
		// TypeError with no `status` member, so it reaches `default:` and answers `{error:true}` at
		// status 200 on the first attempt.
		backendsJSON(w, pinnedChatCompletionErrorFlag())
		return
	}

	if streaming {
		// The bool is the pinned `!response_generate.writableEnded`: the client went away while the
		// response was still open, which is the only case the abort request is sent in.
		if forwardKoboldGenerateStream(w, request, response) && canAbort {
			pinnedKoboldSendAbort(apiServer)
		}
		return
	}

	defer response.Stream.Close()
	providerBody, readErr := io.ReadAll(response.Stream)
	if readErr != nil && readErr != io.EOF {
		backendsJSON(w, pinnedChatCompletionErrorFlag())
		return
	}
	if response.Status < 200 || response.Status > 299 {
		message := nodeString(string(providerBody))
		if parsed, parseErr := decodeOrderedNodeJSON(providerBody); parseErr == nil {
			// `errorJson?.detail?.msg || errorText`
			if detail := nodeGet(parsed, "detail", "msg"); pinnedJSTruthy(detail) {
				message = detail
			}
		}
		payload := nodeObject()
		errorMember := nodeObject()
		errorMember.setMember("message", message)
		payload.setMember("error", errorMember)
		backendsJSONStatus(w, http.StatusBadRequest, payload)
		return
	}
	data, parseErr := decodeOrderedNodeJSON(providerBody)
	if parseErr != nil {
		// `await response.json()` rejects and the pinned catch answers {error:true}.
		backendsJSON(w, pinnedChatCompletionErrorFlag())
		return
	}
	serveSDValue(w, data)
}

// forwardKoboldGenerateStream reproduces forwardFetchResponse (src/util.js:732) for this route.
//
// It is written here rather than reused from the chat-completions route for ONE observable reason:
// the error branch must be FLUSHED. Go's net/http buffers a small body and, when the handler
// returns without flushing, answers it with a Content-Length instead of chunked framing -- while
// the pinned `to.end(rawErrorText, 'utf-8')` is chunk-framed with the error text as one chunk and no
// content type at all. Both branches flush, so both framings are the pinned ones.
//
// It reports whether the client went away while the response was still open (the pinned close
// handler's `!response_generate.writableEnded`), which is what decides whether the abort request is
// sent.
func forwardKoboldGenerateStream(w http.ResponseWriter, request *http.Request, response *outbound.Response) bool {
	status := response.Status
	if status == http.StatusUnauthorized {
		// Pinned rewrites 401 to 400 so a streamed reply cannot reset the browser's Basic Auth
		// prompt (src/util.js:741).
		status = http.StatusBadRequest
	}
	// No Content-Type is set, so the pinned compression middleware never runs its vary step and
	// Vary keeps only the CORS entry. Marking the header present with no value stops net/http from
	// sniffing the first write and inventing a content type the pinned response does not have.
	w.Header().Set("Vary", "Origin")
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
		if flusher != nil {
			flusher.Flush()
		}
		return request.Context().Err() != nil
	}

	w.WriteHeader(status)
	if flusher != nil {
		flusher.Flush()
	}
	buffer := make([]byte, 32*1024)
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
	clientGone := request.Context().Err() != nil

	if response.Truncated {
		// A pinned pipe() does not forward a source error and never ends the Express response, so
		// the caller is left hanging. Reproduce that instead of inventing a terminal sentinel.
		<-request.Context().Done()
		clientGone = true
	}
	return clientGone
}

// pinnedKoboldUpload is the effect the pinned multer middleware has on a request before the
// handler runs: the text fields it put in `request.body` plus the staging file it wrote for the
// one file part it accepts.
type pinnedKoboldUpload struct {
	fields map[string]string
	// path is the staging file in <dataRoot>/_uploads, empty when no part named `avatar` was
	// uploaded. It is a real file because the pinned route reads it and then unlinks it, and the
	// two 400 paths never reach the unlink at all.
	path string
	// unexpectedFile records a FILE part whose name is not the accepted one; multer rejects it
	// before the route runs.
	unexpectedFile string
}

// pinnedKoboldStageUpload replays `multer({dest}).single('avatar')`: text fields become
// `request.body`, the first file part named `avatar` is staged in <dataRoot>/_uploads under a
// random name, and a file part with any other name is an error the route never sees.
func pinnedKoboldStageUpload(dataRoot string, request *http.Request) (pinnedKoboldUpload, error) {
	upload := pinnedKoboldUpload{fields: map[string]string{}}
	reader, err := request.MultipartReader()
	if err != nil {
		// Not a multipart request: multer is a no-op and `request.file` stays undefined.
		return upload, nil
	}
	for {
		part, partErr := reader.NextPart()
		if partErr == io.EOF {
			return upload, nil
		}
		if partErr != nil {
			return upload, partErr
		}
		if part.FileName() == "" {
			value, readErr := io.ReadAll(io.LimitReader(part, 500<<20))
			_ = part.Close()
			if readErr != nil {
				return upload, readErr
			}
			if _, seen := upload.fields[part.FormName()]; !seen {
				upload.fields[part.FormName()] = string(value)
			}
			continue
		}
		if part.FormName() != pinnedKoboldUploadField {
			upload.unexpectedFile = part.FormName()
			_ = part.Close()
			continue
		}
		if upload.path != "" {
			_ = part.Close()
			continue
		}
		staged, createErr := startup.CreateUploadStagingFile(dataRoot)
		if createErr != nil {
			_ = part.Close()
			return upload, createErr
		}
		if _, copyErr := io.Copy(staged, part); copyErr != nil {
			_ = staged.Close()
			_ = part.Close()
			return upload, copyErr
		}
		if closeErr := staged.Close(); closeErr != nil {
			_ = part.Close()
			return upload, closeErr
		}
		upload.path = staged.Name()
		_ = part.Close()
	}
}

// serveBackendsKoboldTranscribeAudio is kobold.js:190.
func (runtime *accountRuntime) serveBackendsKoboldTranscribeAudio(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	upload, uploadErr := pinnedKoboldStageUpload(runtime.options.DataRoot, request)
	if uploadErr != nil {
		backendsEmbedInternalError(w)
		return
	}
	if upload.unexpectedFile != "" {
		// The pinned multer middleware rejects an unexpected file field with
		// `LIMIT_UNEXPECTED_FILE` before the handler runs, and the pinned error handler answers 500
		// -- NOT the route's 400. The pinned body is a rendered development error page, which the
		// fixture classifies `shape` because it embeds a stack trace with absolute paths; this
		// answers the same status with the one line of that page that is host-independent.
		respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", "MulterError: Unexpected field")
		return
	}
	if upload.fields["server"] == "" {
		// `if (!server) return response.sendStatus(400)`. The pinned route returns BEFORE it
		// unlinks, so the staged file stays in <dataRoot>/_uploads; the capture records it.
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	if upload.path == "" {
		// `if (!request.file) return response.sendStatus(400)`, with the same leak.
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	content, readErr := os.ReadFile(upload.path)
	if readErr != nil {
		backendsEmbedInternalError(w)
		return
	}
	if removeErr := os.Remove(upload.path); removeErr != nil {
		backendsEmbedInternalError(w)
		return
	}

	headers, headerErr := backendsAdditionalHeadersForType(nodeObject(), "koboldcpp", directories)
	if headerErr != nil {
		backendsEmbedInternalError(w)
		return
	}
	// `const url = new URL(server); url.pathname = '/api/extra/transcribe';` -- the path is
	// replaced and the query string is kept.
	parsed, valid := searchURLValue(nodeString(upload.fields["server"]))
	if !valid {
		backendsEmbedInternalError(w)
		return
	}
	target := sdURLWithPath(parsed, "/api/extra/transcribe")

	payload := nodeObject()
	payload.setMember("prompt", nodeString(""))
	payload.setMember("audio_data", nodeString(base64.StdEncoding.EncodeToString(content)))
	encoded, encodeErr := marshalOrderedNodeJSON(payload)
	if encodeErr != nil {
		backendsEmbedInternalError(w)
		return
	}

	// No content-type header is set on this request: the pinned code passes only the api-type
	// headers, so the JSON body travels without one.
	//
	// kobold.js:250-251 is `const headers = {}` then `setAdditionalHeadersByType(headers, KOBOLDCPP, server,
	// ...)`, whose last act is the `requestOverrides` Object.assign -- applied here, on the raw `server` field
	// the pinned `new URL(server)` parsed.
	pinnedApplyRequestOverrides(directories, upload.fields["server"], headers)
	response, fetchErr := backendsFetch(request, searchRequest{
		Method:  http.MethodPost,
		URL:     target,
		Headers: headers,
		Body:    encoded,
	})
	if fetchErr != nil {
		backendsEmbedInternalError(w)
		return
	}
	if !sdResponseOK(response) {
		// `return response.status(500).send(text)`: the upstream text becomes the body, as text/html.
		searchUpstreamError(w, response.Body)
		return
	}
	data, parseErr := decodeOrderedNodeJSON(response.Body)
	if parseErr != nil {
		backendsEmbedInternalError(w)
		return
	}
	searchJSON(w, data)
}
