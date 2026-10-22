// Wave 5 of the SD generation routes: the two POLLING providers. Both submit a job, wait
// `delay(2500)` and then poll a URL the provider hands back, so the request COUNT of a scenario is
// behaviour rather than timing. From src/endpoints/stable-diffusion.js:
//
//	POST /api/sd/bfl/generate     stable-diffusion.js:1473
//	POST /api/sd/falai/generate   stable-diffusion.js:1641
//
// Pinned details a careful implementation would get wrong, each recorded in
// tests/oracle/sillytavern-1.19.0-sd-generate.json:
//
//   - bfl deletes `steps` and `guidance` for a model whose name ENDS WITH `-pro-1.1` (so the plain
//     model `flux-pro-1.1` takes that branch), and for a model ending in `-ultra` it additionally
//     deletes width/height/prompt_upsampling and APPENDS a computed `aspect_ratio`;
//   - the aspect-ratio helper recurses on `gcd(NaN, undefined)` for an ultra model with no
//     dimensions, overflows the stack and answers 500 with ZERO outbound requests; the Go side
//     refuses the same input instead of recursing, because a Go stack overflow would kill the process;
//   - the poll URL is the provider's `polling_url` when present and the template
//     `https://api.bfl.ai/v1/get_result?id=<id>` otherwise, and the poll carries `x-key` while the
//     SAMPLE fetch carries no header at all;
//   - the sample fetch has NO `ok` check, so a failing sample URL still answers 200 with that error
//     body as the image bytes;
//   - fal.ai's four requests each carry `Authorization: Key <key>` — including the media fetch on
//     another host — and the RESULT document comes from the STATUS answer's `response_url`, not from
//     the submit answer;
//   - fal.ai's catch answers `error.cause || error.message`, so an unknown status becomes a JSON body
//     (the status payload as the cause) while a transport failure becomes the html-typed text
//     "fetch failed" (node-fetch's message, which is what the pinned catch forwards).
//
// NOT reproduced as a recorded observation, and stated instead: after 100 Pending/IN_QUEUE answers the
// pinned loop ends WITHOUT responding, because there is no `return` after it. That is reproduced (the
// handler writes nothing) and asserted by a labelled implementation test, not by the fixture: 100 polls
// of 2500ms is about four minutes of wall clock, and shortening the delay in the probe would record a
// behaviour the product does not have.

package server

import (
	"encoding/base64"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

const (
	sdBFLDefaultURL        = "https://api.bfl.ai"
	sdFalaiQueueDefaultURL = "https://queue.fal.run"

	// `MAX_ATTEMPTS = 100` in BOTH pinned handlers.
	sdBFLMaxAttempts   = 100
	sdFalaiMaxAttempts = 100

	sdBFLOutputFormat       = "jpeg"
	sdBFLSafetyTolerance    = 6
	sdFalaiSafetyTolerance  = 6
	sdFalaiQueuePathPrefix  = "/fal-ai/"
	sdBFLFallbackPollSuffix = "/v1/get_result?id="

	// sdProviderRequestTimeout is the same 120s the sibling waves use for one provider request.
	sdProviderRequestTimeout = 120 * time.Second
)

// sdNodeFetchFailureMessage is node-fetch's message for a failed request. It is the body the pinned fal.ai
// catch produces for a transport failure (`error.cause || error.message` with no cause), which the fixture
// records as the text "fetch failed".
const sdNodeFetchFailureMessage = "fetch failed"

// sdBFLCheckInterval and sdFalaiCheckInterval are the pinned `delay(2500)`, and they are variables for
// the same reason hordePollCheckInterval is: a route test collapses them, and a SEPARATE test asserts the
// production value, because a poll cadence that silently changes is an observable difference no fixture
// can record (wall clock does not cross that boundary).
var (
	sdBFLPollInterval   = 2500 * time.Millisecond
	sdFalaiPollInterval = 2500 * time.Millisecond
)

// sdBFLURL and sdFalaiQueueURL are separate seams because the two routes talk to different hosts than
// their SIBLING list routes: `/api/sd/bfl/*` has no list route, and `/api/sd/falai/models` talks to
// fal.ai while `/api/sd/falai/generate` submits to queue.fal.run. Sharing sdFalaiURL would make one
// route's override silently move another route.
func sdBFLURL() string { return sdSeamURL("GOTAVERN_SD_BFL_URL", sdBFLDefaultURL) }

func sdFalaiQueueURL() string {
	return sdSeamURL("GOTAVERN_SD_FALAI_QUEUE_URL", sdFalaiQueueDefaultURL)
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerSDGenerateWave5Routes)
}

func registerSDGenerateWave5Routes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/sd/bfl/generate", accounts.serveSDBFLGenerate)
	post("/api/sd/falai/generate", accounts.serveSDFalaiGenerate)
}

// serveSDBFLGenerate is stable-diffusion.js:1473: submit, then poll after a 2500ms delay, then fetch the
// sample the provider named and answer its bytes as base64.
func (runtime *accountRuntime) serveSDBFLGenerate(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_bfl")
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
	model, stringErr := pinnedJSStringValue(sdBodyMember(body, "model"))
	if stringErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}

	// The projection is built in the pinned assignment order. `JSON.stringify` DROPS a member whose
	// value is `undefined`, so "present in the request body" is what decides whether a member exists at
	// all, while `seed: request.body.seed ?? null` always emits `seed` — as null when it was absent.
	ultra := strings.HasSuffix(model, "-ultra")
	pro := strings.HasSuffix(model, "-pro-1.1")
	projection := nodeObject()
	for _, name := range []string{"prompt", "steps", "guidance", "width", "height", "prompt_upsampling"} {
		if ultra && name != "prompt" {
			continue
		}
		if pro && (name == "steps" || name == "guidance") {
			continue
		}
		if value := sdBodyMember(body, name); !value.isUndefined() {
			projection.setMember(name, value)
		}
	}
	projection.setMember("seed", nodeNullish(sdBodyMember(body, "seed"), orderedNodeJSON{kind: 'n'}))
	projection.setMember("safety_tolerance", nodeNumber(sdBFLSafetyTolerance))
	projection.setMember("output_format", nodeString(sdBFLOutputFormat))
	if ultra {
		// `requestBody.aspect_ratio = ...` is assigned BEFORE the deletes, and a delete does not reorder
		// what remains, so appending it here produces the same member order.
		ratio, ratioOK := sdBFLClosestAspectRatio(sdBodyMember(body, "width"), sdBodyMember(body, "height"))
		if !ratioOK {
			// The pinned helper recurses forever on `gcd(NaN, undefined)` and its RangeError is caught as
			// a 500 with nothing sent. A Go recursion would take the whole process down, so the same
			// input is refused here.
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		projection.setMember("aspect_ratio", nodeString(ratio))
	}
	payload, marshalErr := marshalOrderedNodeJSON(projection)
	if marshalErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}

	// The model is interpolated into the path RAW: no encoding, which the fixture records.
	target := sdBFLURL() + "/v1/" + model
	submitted, submitErr := outbound.Send(request.Context(), outbound.Request{
		URL:    target,
		Method: http.MethodPost,
		Headers: []outbound.Header{
			{Name: "Host", Value: hostOf(target)},
			{Name: "Content-Type", Value: "application/json"},
			{Name: "x-key", Value: key},
			{Name: "Content-Length", Value: strconvItoa(len(payload))},
		},
		Body: payload,
	}, sdProviderRequestTimeout)
	if submitErr != nil || submitted == nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(submitted) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	taskData, decodeErr := decodeOrderedNodeJSON(submitted.Body)
	if decodeErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	// `const { id } = taskData` throws for null or undefined, which the pinned catch answers with 500.
	if taskData.isNull() || taskData.isUndefined() {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	idValue, idOK := sdMemberOf(taskData, "id")
	if !idOK {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	id, idErr := pinnedJSStringValue(idValue)
	if idErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	pollingValue, pollingOK := sdMemberOf(taskData, "polling_url")
	if !pollingOK {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	pollingURL := ""
	if pollingValue.isUndefined() || pollingValue.isNull() {
		pollingURL = sdBFLURL() + sdBFLFallbackPollSuffix + id
	} else {
		pollingURL, idErr = pinnedJSStringValue(pollingValue)
		if idErr != nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
	}

	for attempt := 0; attempt < sdBFLMaxAttempts; attempt++ {
		time.Sleep(sdBFLPollInterval)
		// The pinned poll passes no method, so node-fetch defaults to GET, and it carries `x-key` because
		// bfl requires authentication on the polling request as well.
		statusResponse, pollErr := outbound.Send(request.Context(), outbound.Request{
			URL:    pollingURL,
			Method: http.MethodGet,
			Headers: []outbound.Header{
				{Name: "Host", Value: hostOf(pollingURL)},
				{Name: "x-key", Value: key},
			},
		}, sdProviderRequestTimeout)
		if pollErr != nil || statusResponse == nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		if !outboundOK(statusResponse) {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		statusData, statusErr := decodeOrderedNodeJSON(statusResponse.Body)
		if statusErr != nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		// `statusData?.status === 'Pending'` is a STRICT string comparison, so only a string member can
		// match; anything else falls through to the throw at the end of the loop body.
		statusValue := nodeUndefined()
		if statusData.kind == 'o' {
			if member, exists := statusData.member("status"); exists {
				statusValue = member
			}
		}
		status, _ := statusValue.stringValue()
		if statusValue.isString() && status == "Pending" {
			continue
		}
		if statusValue.isString() && status == "Ready" {
			result, resultOK := sdMemberOf(statusData, "result")
			if !resultOK {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			sample, sampleOK := sdMemberOf(result, "sample")
			if !sampleOK {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			sampleURL, sampleErr := pinnedJSStringValue(sample)
			if sampleErr != nil {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			// `fetch(sample)` passes no options at all, so the sample fetch carries NO key — and it checks
			// nothing, so a non-2xx answer's bytes are still returned as the image.
			fetched, fetchErr := outbound.Send(request.Context(), outbound.Request{
				URL:     sampleURL,
				Method:  http.MethodGet,
				Headers: []outbound.Header{{Name: "Host", Value: hostOf(sampleURL)}},
			}, sdProviderRequestTimeout)
			if fetchErr != nil || fetched == nil {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			answer := nodeObject()
			answer.setMember("image", nodeString(base64.StdEncoding.EncodeToString(fetched.Body)))
			encoded, encodeErr := marshalOrderedNodeJSON(answer)
			if encodeErr != nil {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			respondJSONBytes(w, http.StatusOK, encoded)
			return
		}
		// `throw new Error('BFL failed to generate image.', { cause: statusData })` and BFL's catch answers
		// a bare status message: the payload never reaches the caller.
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	// No filter answered Pending or Ready within MAX_ATTEMPTS. The pinned handler falls off the end of the
	// try block WITHOUT writing a response, so the caller waits until its own timeout; that is reproduced
	// deliberately rather than "helpfully" answered, because answering would be a behaviour difference.
}

// serveSDFalaiGenerate is stable-diffusion.js:1641: submit to the queue, poll the status_url the submit
// answer named, then read the response_url from the STATUS answer, then fetch images[0].url.
func (runtime *accountRuntime) serveSDFalaiGenerate(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_falai")
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
	model, stringErr := pinnedJSStringValue(sdBodyMember(body, "model"))
	if stringErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}

	projection := nodeObject()
	if prompt := sdBodyMember(body, "prompt"); !prompt.isUndefined() {
		projection.setMember("prompt", prompt)
	}
	// `image_size: { width, height }` is ALWAYS present, and `JSON.stringify` drops an undefined member of
	// the nested object, so an absent width leaves `{"height":...}` and two absent members leave `{}`.
	imageSize := nodeObject()
	if width := sdBodyMember(body, "width"); !width.isUndefined() {
		imageSize.setMember("width", width)
	}
	if height := sdBodyMember(body, "height"); !height.isUndefined() {
		imageSize.setMember("height", height)
	}
	projection.setMember("image_size", imageSize)
	if steps := sdBodyMember(body, "steps"); !steps.isUndefined() {
		projection.setMember("num_inference_steps", steps)
	}
	projection.setMember("seed", nodeNullish(sdBodyMember(body, "seed"), orderedNodeJSON{kind: 'n'}))
	if guidance := sdBodyMember(body, "guidance"); !guidance.isUndefined() {
		projection.setMember("guidance_scale", guidance)
	}
	projection.setMember("enable_safety_checker", nodeBool(false))
	projection.setMember("safety_tolerance", nodeNumber(sdFalaiSafetyTolerance))
	payload, marshalErr := marshalOrderedNodeJSON(projection)
	if marshalErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}

	target := sdFalaiQueueURL() + sdFalaiQueuePathPrefix + model
	submitted, submitErr := outbound.Send(request.Context(), outbound.Request{
		URL:    target,
		Method: http.MethodPost,
		Headers: []outbound.Header{
			{Name: "Host", Value: hostOf(target)},
			{Name: "Content-Type", Value: "application/json"},
			{Name: "Authorization", Value: "Key " + key},
			{Name: "Content-Length", Value: strconvItoa(len(payload))},
		},
		Body: payload,
	}, sdProviderRequestTimeout)
	if submitErr != nil {
		// The pinned catch answers `error.cause || error.message`, and a transport failure has no cause, so
		// the body is node-fetch's message.
		respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", sdNodeFetchFailureMessage)
		return
	}
	if submitted == nil {
		respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", sdNodeFetchFailureMessage)
		return
	}
	if !outboundOK(submitted) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	taskData, decodeErr := decodeOrderedNodeJSON(submitted.Body)
	if decodeErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	// `const { status_url } = taskData` throws for null or undefined.
	if taskData.isNull() || taskData.isUndefined() {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	statusValue, statusOK := sdMemberOf(taskData, "status_url")
	if !statusOK {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	statusURL, statusErr := pinnedJSStringValue(statusValue)
	if statusErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}

	authorization := "Key " + key
	for attempt := 0; attempt < sdFalaiMaxAttempts; attempt++ {
		time.Sleep(sdFalaiPollInterval)
		statusResponse, pollErr := outbound.Send(request.Context(), outbound.Request{
			URL:    statusURL,
			Method: http.MethodGet,
			Headers: []outbound.Header{
				{Name: "Host", Value: hostOf(statusURL)},
				{Name: "Authorization", Value: authorization},
			},
		}, sdProviderRequestTimeout)
		if pollErr != nil {
			respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", sdNodeFetchFailureMessage)
			return
		}
		if statusResponse == nil || !outboundOK(statusResponse) {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		statusData, decodeStatusErr := decodeOrderedNodeJSON(statusResponse.Body)
		if decodeStatusErr != nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		polled := nodeUndefined()
		if statusData.kind == 'o' {
			if member, exists := statusData.member("status"); exists {
				polled = member
			}
		}
		name, _ := polled.stringValue()
		if polled.isString() && (name == "IN_QUEUE" || name == "IN_PROGRESS") {
			continue
		}
		if polled.isString() && name == "COMPLETED" {
			// `statusData?.response_url` — the RESULT document comes from the STATUS answer, not from the
			// submit answer.
			responseValue, responseOK := sdMemberOf(statusData, "response_url")
			if !responseOK {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			resultURL, resultErr := pinnedJSStringValue(responseValue)
			if resultErr != nil {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			resultResponse, fetchErr := outbound.Send(request.Context(), outbound.Request{
				URL:    resultURL,
				Method: http.MethodGet,
				Headers: []outbound.Header{
					{Name: "Host", Value: hostOf(resultURL)},
					{Name: "Authorization", Value: authorization},
				},
			}, sdProviderRequestTimeout)
			if fetchErr != nil || resultResponse == nil {
				respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", sdNodeFetchFailureMessage)
				return
			}
			// The pinned route does NOT check `ok` here: it parses the body as JSON regardless.
			resultData, resultDecodeErr := decodeOrderedNodeJSON(resultResponse.Body)
			if resultDecodeErr != nil {
				// The pinned catch would answer the V8 SyntaxError MESSAGE, which is a Node version string
				// rather than a product decision. It is NOT recordable as an oracle, and this file records
				// the gap instead of inventing the text: the answer is the generic 500.
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			if resultData.isNull() || resultData.isUndefined() {
				// `resultData.detail` throws on null/undefined.
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			if detail, exists := resultData.member("detail"); exists && !detail.isNull() && !detail.isUndefined() {
				message, messageOK := sdFalaiDetailMessage(detail)
				if !messageOK {
					serveSDStatus(w, http.StatusInternalServerError)
					return
				}
				respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", message)
				return
			}
			// `resultData?.images[0].url`
			images, imagesOK := sdMemberOf(resultData, "images")
			if !imagesOK {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			entry, entryOK := sdIndex(images, 0)
			if !entryOK {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			imageValue, imageOK := sdMemberOf(entry, "url")
			if !imageOK {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			imageURL, imageErr := pinnedJSStringValue(imageValue)
			if imageErr != nil {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			// The image fetch carries the provider key too, even though it is a different host.
			imageResponse, imageFetchErr := outbound.Send(request.Context(), outbound.Request{
				URL:    imageURL,
				Method: http.MethodGet,
				Headers: []outbound.Header{
					{Name: "Host", Value: hostOf(imageURL)},
					{Name: "Authorization", Value: authorization},
				},
			}, sdProviderRequestTimeout)
			if imageFetchErr != nil || imageResponse == nil {
				respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", sdNodeFetchFailureMessage)
				return
			}
			answer := nodeObject()
			answer.setMember("image", nodeString(base64.StdEncoding.EncodeToString(imageResponse.Body)))
			encoded, encodeErr := marshalOrderedNodeJSON(answer)
			if encodeErr != nil {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			respondJSONBytes(w, http.StatusOK, encoded)
			return
		}
		// `throw new Error('FAL.AI failed to generate image.', { cause: statusData })` and the catch sends
		// `error.cause || error.message`: an OBJECT cause is sent as JSON, a STRING cause as html text.
		respondFalaiCause(w, statusData)
		return
	}
	// Like bfl, the pinned loop has no `return` after it: exhausting MAX_ATTEMPTS answers nothing.
}

// sdBFLClosestAspectRatio reproduces `getClosestAspectRatio(width, height)`.
//
// The pinned helper is a vehicle for two surprising behaviours and both are recorded: it SIMPLIFIES the
// ratio inside the [9/21, 21/9] band, and it recurses forever when either dimension is not a number
// (`gcd(NaN, undefined)` never reaches its base case), which the pinned catch answers as a 500. The
// recursion is not reproduced — a Go stack overflow is fatal to the process — so the same input reports
// failure, which is the same observable.
func sdBFLClosestAspectRatio(widthValue, heightValue orderedNodeJSON) (string, bool) {
	width := pinnedJSToNumber(widthValue)
	height := pinnedJSToNumber(heightValue)
	if math.IsNaN(width) || math.IsNaN(height) {
		return "", false
	}
	const minAspect = 9.0 / 21.0
	const maxAspect = 21.0 / 9.0
	currentAspect := width / height
	switch {
	case currentAspect < minAspect:
		return sdBFLSimplifyRatio(width, jsRound(width/minAspect)), true
	case currentAspect > maxAspect:
		return sdBFLSimplifyRatio(jsRound(height*maxAspect), height), true
	default:
		return sdBFLSimplifyRatio(width, height), true
	}
}

// sdBFLSimplifyRatio is `simplifyRatio(w, h)` = `${w/gcd}:${h/gcd}` with JS number formatting, which is
// what turns the zero-dimension case into the literal "NaN:NaN" rather than an error.
func sdBFLSimplifyRatio(width, height float64) string {
	divisor := sdBFLGCD(width, height)
	left, leftErr := nodeNumber(width / divisor).javascriptString()
	right, rightErr := nodeNumber(height / divisor).javascriptString()
	if leftErr != nil || rightErr != nil {
		return ""
	}
	return left + ":" + right
}

// sdBFLGCD is the pinned `gcd(a, b) = b === 0 ? a : gcd(b, a % b)`, iterated rather than recursed with a
// step cap. A non-integral pair can make the float remainder approach zero without reaching it, so the cap
// reports a failure instead of spinning; no recorded scenario reaches it.
func sdBFLGCD(left, right float64) float64 {
	for step := 0; step < 256; step++ {
		if right == 0 {
			return left
		}
		left, right = right, math.Mod(left, right)
	}
	return math.NaN()
}

// jsRound is `Math.round`, which rounds a half UP rather than away from zero.
func jsRound(value float64) float64 {
	if math.IsInf(value, 0) || math.IsNaN(value) {
		return value
	}
	return math.Floor(value + 0.5)
}

// sdFalaiDetailMessage reproduces `${detail[0].loc[1]}: ${detail[0].msg}` for the result document's
// `detail` member. It reports false when the pinned property accesses would throw.
func sdFalaiDetailMessage(detail orderedNodeJSON) (string, bool) {
	entry, entryOK := sdIndex(detail, 0)
	if !entryOK {
		return "", false
	}
	location, locationOK := sdMemberOf(entry, "loc")
	if !locationOK {
		return "", false
	}
	segment, segmentOK := sdIndex(location, 1)
	if !segmentOK {
		return "", false
	}
	message, messageOK := sdMemberOf(entry, "msg")
	if !messageOK {
		return "", false
	}
	segmentText, segmentErr := pinnedJSStringValue(segment)
	messageText, messageErr := pinnedJSStringValue(message)
	if segmentErr != nil || messageErr != nil {
		return "", false
	}
	return segmentText + ": " + messageText, true
}

// respondFalaiCause is `response.status(500).send(error.cause || error.message)`: express dispatches on the
// JavaScript type, so an object cause becomes JSON and a string cause becomes html-typed text.
func respondFalaiCause(w http.ResponseWriter, cause orderedNodeJSON) {
	if cause.kind == 'o' || cause.kind == 'a' {
		encoded, err := marshalOrderedNodeJSON(cause)
		if err != nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		respondJSONBytes(w, http.StatusInternalServerError, encoded)
		return
	}
	text, err := pinnedJSStringValue(cause)
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", text)
}
