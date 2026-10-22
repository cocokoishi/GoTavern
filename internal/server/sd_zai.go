// Wave 6 of the SD routes: the two z.ai providers. From src/endpoints/stable-diffusion.js:
//
//	POST /api/sd/zai/generate         stable-diffusion.js:1880
//	POST /api/sd/zai/generate-video   stable-diffusion.js:1957
//
// Pinned details a careful implementation would get wrong, each recorded in
// tests/oracle/sillytavern-1.19.0-sd-zai.json:
//
//   - the image route validates the provider URL with `isValidUrl` (which accepts ANY scheme) and then
//     guards the HOSTNAME with `endsWith('.z.ai') || endsWith('.ufileos.com')`. `endsWith` means the APEX
//     `z.ai` is REFUSED, `notz.ai` is refused (it ends with `tz.ai`), and a `.z.ai` label inside a longer
//     host is refused. A refused URL is never fetched, so the request COUNT is the observation;
//   - the image answer's `format` comes from `path.extname(url.pathname)` — the URL's PATH, lowercased,
//     defaulting to `png` — not from the response content type;
//   - the image fetch retries ONLY on 404, five attempts with `delay(1000)` between them;
//   - the video route polls `.../async-result/<data.id>` built from a LITERAL plus the id (no
//     provider-supplied polling URL), up to thirty times, each preceded by `delay(5000 + attempt*1000)`;
//   - the video route forwards the provider TEXT on a non-ok poll AND on a non-ok content fetch, answers
//     the literal `Video generation failed` on a FAIL status, and a bare 500 when SUCCESS carries no
//     usable URL;
//   - the video CONTENT fetch has NO hostname guard (unlike the image route), which is why its success
//     path is replayable against a local peer and the image one is not;
//   - the image route has no disconnect handling at all, while the video route aborts through
//     `request.socket.on('close')` and answers `Video generation aborted by client` at the TOP of each
//     iteration — after the poll that was already in flight.
//
// NOT covered by the fixture, and named in its `notCovered` with the reason: the image success path and
// its 404 retry (the hostname guard is evaluated by the implementation, so no local listener can answer
// to a `.z.ai` name), the video 30-attempt exhaustion and an unknown `task_status` (591 seconds of
// escalating delays), and the video disconnect. The last three are covered by LABELLED implementation
// tests; the image `path.extname` mapping is a LABELLED source-derived table test.

package server

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

const (
	sdZaiDefaultURL = "https://api.z.ai"

	sdZaiImagePath         = "/api/paas/v4/images/generations"
	sdZaiVideoPath         = "/api/paas/v4/videos/generations"
	sdZaiVideoResultPrefix = "/api/paas/v4/async-result/"

	// sdZaiRequestTimeout is the same 120s the sibling waves use for one provider request, declared here so
	// this file does not depend on an unmerged lane's symbol.
	sdZaiRequestTimeout = 120 * time.Second

	sdZaiImageMaxAttempts = 5
	sdZaiVideoMaxAttempts = 30
	sdZaiImageFormat      = "png"
	sdZaiVideoFormat      = "mp4"

	sdZaiVideoFailedMessage  = "Video generation failed"
	sdZaiVideoAbortedMessage = "Video generation aborted by client"
)

// The three cadences the pinned routes sleep at. They are variables so the route tests can collapse them,
// and separate tests assert the production values, because a cadence that silently changes is an
// observable difference no fixture can record (wall clock does not cross that boundary).
var (
	sdZaiImageRetryInterval = 1000 * time.Millisecond
	sdZaiVideoPollBase      = 5000 * time.Millisecond
	sdZaiVideoPollStep      = 1000 * time.Millisecond
)

// sdZaiVideoSleep is the delay between video polls. It checks the CALLER's context only at the top of the
// loop, which is what the pinned route does: a disconnect during a delay is noticed one poll later.
var sdZaiVideoSleep = func(ctx context.Context, duration time.Duration) {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	<-timer.C
}

// Two seams, because two routes append different paths to the same host and each must be overrideable on
// its own — the same rule the wave-2 providers follow.
func sdZaiURL() string { return sdSeamURL("GOTAVERN_SD_ZAI_URL", sdZaiDefaultURL) }

func sdZaiVideoURL() string { return sdSeamURL("GOTAVERN_SD_ZAI_VIDEO_URL", sdZaiDefaultURL) }

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerSDZaiRoutes)
}

func registerSDZaiRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/sd/zai/generate", accounts.serveSDZaiGenerate)
	post("/api/sd/zai/generate-video", accounts.serveSDZaiGenerateVideo)
}

// serveSDZaiGenerate is stable-diffusion.js:1880. The key is required (400), the answer's image URL is
// validated and then HOSTNAME-GUARDED before a bare fetch of it, the format comes from the URL's path
// extension, and only a 404 is retried.
func (runtime *accountRuntime) serveSDZaiGenerate(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_zai")
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		serveSDStatus(w, http.StatusBadRequest)
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	projection := nodeObject()
	for _, name := range []string{"prompt", "model", "quality", "size"} {
		if value := sdBodyMember(body, name); !value.isUndefined() {
			projection.setMember(name, value)
		}
	}
	payload, marshalErr := marshalOrderedNodeJSON(projection)
	if marshalErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	submitted, submitErr := sdZaiPost(context.Background(), sdZaiURL()+sdZaiImagePath, key, payload)
	if submitErr != nil || submitted == nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(submitted) {
		// The pinned branch reads the body only to log it.
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, decodeErr := decodeOrderedNodeJSON(submitted.Body)
	if decodeErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	// `String(data?.data?.[0]?.url ?? '')` — every step is optional, so a missing shape is the empty string
	// rather than a throw.
	urlValue := nodeUndefined()
	if dataMember, dataOK := sdMemberOf(data, "data"); dataOK {
		if entry, entryOK := sdIndex(dataMember, 0); entryOK {
			if urlMember, urlOK := sdMemberOf(entry, "url"); urlOK {
				urlValue = urlMember
			}
		}
	}
	urlString := ""
	if !urlValue.isUndefined() && !urlValue.isNull() {
		urlString, err = pinnedJSStringValue(urlValue)
		if err != nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
	}
	parsed, valid := sdZaiParseURL(urlString)
	if urlString == "" || !valid {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	// The pinned guard is `!url.hostname.endsWith('.z.ai') && !url.hostname.endsWith('.ufileos.com')`. The
	// WHATWG parser lowercases a hostname, so the comparison is against the lowercased form.
	hostname := strings.ToLower(parsed.Hostname())
	if !strings.HasSuffix(hostname, ".z.ai") && !strings.HasSuffix(hostname, ".ufileos.com") {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	format := sdZaiPathExtension(parsed.EscapedPath())
	target := parsed.String()
	for attempt := 0; attempt < sdZaiImageMaxAttempts; attempt++ {
		// `fetch(url)` passes no options: no headers at all.
		// `fetch(url)` passes no options at all, so it is NOT bound to the caller: the pinned route has no
		// socket-close handling, and reproducing that means the fetch completes even if the client has gone.
		fetched, fetchErr := outbound.Send(context.Background(), outbound.Request{
			URL:     target,
			Method:  http.MethodGet,
			Headers: []outbound.Header{{Name: "Host", Value: hostOf(target)}},
		}, sdZaiRequestTimeout)
		if fetchErr != nil || fetched == nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		if !outboundOK(fetched) {
			// Only a 404 is "not available YET"; every other status is final.
			if fetched.Status == http.StatusNotFound {
				time.Sleep(sdZaiImageRetryInterval)
				continue
			}
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		answer := nodeObject()
		answer.setMember("image", nodeString(base64.StdEncoding.EncodeToString(fetched.Body)))
		answer.setMember("format", nodeString(format))
		encoded, encodeErr := marshalOrderedNodeJSON(answer)
		if encodeErr != nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		respondJSONBytes(w, http.StatusOK, encoded)
		return
	}
	serveSDStatus(w, http.StatusInternalServerError)
}

// serveSDZaiGenerateVideo is stable-diffusion.js:1957: submit, then poll the LITERAL `async-result` path
// with the job id, up to thirty times, each poll preceded by an escalating delay.
func (runtime *accountRuntime) serveSDZaiGenerateVideo(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_zai")
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		serveSDStatus(w, http.StatusBadRequest)
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	projection := nodeObject()
	for _, name := range []string{"prompt", "model", "quality", "size", "aspect_ratio"} {
		if value := sdBodyMember(body, name); !value.isUndefined() {
			projection.setMember(name, value)
		}
	}
	payload, marshalErr := marshalOrderedNodeJSON(projection)
	if marshalErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	submitted, submitErr := sdZaiPost(request.Context(), sdZaiVideoURL()+sdZaiVideoPath, key, payload)
	if submitErr != nil || submitted == nil {
		// A disconnect during the submit aborts the request, and the pinned catch answers a bare 500.
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(submitted) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, decodeErr := decodeOrderedNodeJSON(submitted.Body)
	if decodeErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	// `data.id` is NOT optional: a null or undefined answer throws into the catch.
	if data.isNull() || data.isUndefined() {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	idValue, idOK := sdMemberOf(data, "id")
	if !idOK {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	id, idErr := pinnedJSStringValue(idValue)
	if idErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	pollURL := sdZaiVideoURL() + sdZaiVideoResultPrefix + id
	authorization := "Bearer " + key
	for attempt := 0; attempt < sdZaiVideoMaxAttempts; attempt++ {
		// The pinned abort check is here, at the TOP of the iteration, so a poll that was already in flight
		// still happens.
		if request.Context().Err() != nil {
			respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", sdZaiVideoAbortedMessage)
			return
		}
		sdZaiVideoSleep(request.Context(), sdZaiVideoPollBase+time.Duration(attempt)*sdZaiVideoPollStep)
		// The pinned poll fetch carries NO abort signal (only the submit does), so a disconnect during a
		// delay is noticed at the top of the NEXT iteration -- after the poll that was already in flight.
		polled, pollErr := outbound.Send(context.Background(), outbound.Request{
			URL:    pollURL,
			Method: http.MethodGet,
			Headers: []outbound.Header{
				{Name: "Host", Value: hostOf(pollURL)},
				{Name: "Authorization", Value: authorization},
			},
		}, sdZaiRequestTimeout)
		if pollErr != nil || polled == nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		if !outboundOK(polled) {
			// `response.status(500).send(text)` forwards the provider TEXT, html-typed by express.
			respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", string(polled.Body))
			return
		}
		result, resultErr := decodeOrderedNodeJSON(polled.Body)
		if resultErr != nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		statusValue := nodeUndefined()
		if result.kind == 'o' {
			if member, exists := result.member("task_status"); exists {
				statusValue = member
			}
		}
		status, _ := statusValue.stringValue()
		if statusValue.isString() && status == "FAIL" {
			respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", sdZaiVideoFailedMessage)
			return
		}
		if statusValue.isString() && status == "SUCCESS" {
			// `pollResult?.video_result?.[0]?.url`
			urlValue := nodeUndefined()
			if results, resultsOK := sdMemberOf(result, "video_result"); resultsOK {
				if entry, entryOK := sdIndex(results, 0); entryOK {
					if urlMember, urlOK := sdMemberOf(entry, "url"); urlOK {
						urlValue = urlMember
					}
				}
			}
			urlString := ""
			if !urlValue.isUndefined() && !urlValue.isNull() {
				urlString, err = pinnedJSStringValue(urlValue)
				if err != nil {
					serveSDStatus(w, http.StatusInternalServerError)
					return
				}
			}
			if _, valid := sdZaiParseURL(urlString); urlString == "" || !valid {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			// `fetch(url)` — again NO headers, and no hostname guard on this route.
			content, contentErr := outbound.Send(context.Background(), outbound.Request{
				URL:     urlString,
				Method:  http.MethodGet,
				Headers: []outbound.Header{{Name: "Host", Value: hostOf(urlString)}},
			}, sdZaiRequestTimeout)
			if contentErr != nil || content == nil {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			if !outboundOK(content) {
				respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", string(content.Body))
				return
			}
			answer := nodeObject()
			answer.setMember("format", nodeString(sdZaiVideoFormat))
			answer.setMember("video", nodeString(base64.StdEncoding.EncodeToString(content.Body)))
			encoded, encodeErr := marshalOrderedNodeJSON(answer)
			if encodeErr != nil {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			respondJSONBytes(w, http.StatusOK, encoded)
			return
		}
	}
	// After thirty attempts the pinned route answers a bare 500 (unlike the bfl/fal.ai loops, which fall off
	// the end without writing anything).
	serveSDStatus(w, http.StatusInternalServerError)
}

// sdZaiPost performs the one submit both routes share: JSON body, bearer auth, caller-bound context.
func sdZaiPost(ctx context.Context, target, key string, payload []byte) (*outbound.Response, error) {
	return outbound.Send(ctx, outbound.Request{
		URL:    target,
		Method: http.MethodPost,
		Headers: []outbound.Header{
			{Name: "Host", Value: hostOf(target)},
			{Name: "Content-Type", Value: "application/json"},
			{Name: "Authorization", Value: "Bearer " + key},
			{Name: "Content-Length", Value: strconvItoa(len(payload))},
		},
		Body: payload,
	}, sdZaiRequestTimeout)
}

// sdZaiParseURL is `new URL(text)` as `isValidUrl` performs it: ANY scheme is accepted, so the scheme is
// what decides validity here and the hostname guard decides everything else.
func sdZaiParseURL(text string) (*url.URL, bool) {
	if text == "" {
		return nil, false
	}
	parsed, err := url.Parse(text)
	if err != nil || parsed.Scheme == "" {
		return nil, false
	}
	return parsed, true
}

// sdZaiPathExtension is `path.extname(name).substring(1).toLowerCase() || 'png'`: the extension of the last
// path segment, where a leading dot is NOT an extension (`/.bashrc` has none) and no dot means the default.
func sdZaiPathExtension(name string) string {
	base := name
	if index := strings.LastIndexByte(base, '/'); index >= 0 {
		base = base[index+1:]
	}
	dot := strings.LastIndexByte(base, '.')
	if dot <= 0 {
		return sdZaiImageFormat
	}
	extension := strings.ToLower(base[dot+1:])
	if extension == "" {
		return sdZaiImageFormat
	}
	return extension
}
