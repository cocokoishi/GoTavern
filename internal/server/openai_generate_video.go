package server

// Pinned `/api/openai/generate-video` (openai.js:653).
//
// THREE request shapes, all on the FIXED host api.openai.com: create `POST /v1/videos`, poll
// `GET /v1/videos/{id}`, content `GET /v1/videos/{id}/content`. No provider-supplied host appears, which is
// why no seam beyond the base URL is needed -- the contrast to the Google video route, whose URI came from
// the provider and needed the module replacement instead.
//
// Pinned behaviours a reasonable implementation would flatten, each recorded in the oracle:
//
//   - the create body uses the OR operator, so every falsy member falls back: `model || 'sora-2'`,
//     `size || '720x1280'`, `seconds || '8'` -- and `seconds` stays a STRING;
//   - an absent `prompt` member is OMITTED by JSON.stringify rather than sent as the string "undefined";
//   - the provider-supplied job id is interpolated RAW into the poll and content paths;
//   - five failure answers: `No video job ID returned`, the provider TEXT for each of the three `!ok`
//     paths, `Video generation failed` for `status === 'failed'`, and `Video generation aborted by client`;
//   - the poll count is behaviour: thirty attempts with `delay(5000 + attempt * 1000)`.
//
// THE EXHAUSTED JOB HANGS. After thirty attempts the pinned handler falls off the end of its try block and
// Express answers NOTHING: the request stays open until the client gives up. That is reproduced here
// deliberately -- answering would change every client's behaviour, and a bare return would produce `200`
// with an empty body, which a naive client parses as a video. It is recorded as an inherited property and a
// client must impose its own timeout.
//
// The caller-disconnect decision is EXPLICIT (`callerGone`) at the loop entry, after the sleep and in both
// transport-error paths, and the outbound work gets its own context because the pinned fetches are not
// signal-bound. The Google route taught this the hard way: a decision that depended on whether a
// cancellation happened to be observed during a sleep was host-dependent, CI exposed it, and this host hid it.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	openAIVideosDefaultBase   = "https://api.openai.com"
	openAIVideoCreatePath     = "/v1/videos"
	openAIVideoMaxAttempts    = 30
	openAIVideoDefaultModel   = "sora-2"
	openAIVideoDefaultSize    = "720x1280"
	openAIVideoDefaultSeconds = "8"
	openAIVideoAborted        = "Video generation aborted by client"
	openAIVideoFailed         = "Video generation failed"
	openAIVideoNoJobID        = "No video job ID returned"
	openAIVideoContentSuffix  = "/content"
	openAIVideoCompleteStatus = "completed"
	openAIVideoFailedStatus   = "failed"
)

// openAIVideoSleep is the pinned `delay(ms)`, a variable so the labelled timeout test can drive thirty
// attempts instantly. Production always uses the real timer, and the probe does not shorten the delay,
// because that would record behaviour the product does not have.
var openAIVideoSleep = func(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func openAIVideosBaseURL() string {
	return sdSeamURL("GOTAVERN_OPENAI_VIDEOS_URL", openAIVideosDefaultBase)
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerOpenAIVideoRoutes)
}

func registerOpenAIVideoRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("/api/openai/generate-video", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveOpenAIGenerateVideo(w, r)
	})
}

// openAIOrDefaultRaw reproduces the pinned OR operator for a raw member: a TRUTHY member is forwarded AS ITS
// OWN TYPE (an array stays an array, a number stays a number) and only an absent or falsy member takes the
// fallback. Stringifying a truthy member is the divergence a mutation exposed: the pinned body carries an
// empty array for an empty-array model, not the fallback string.
func openAIOrDefaultRaw(input map[string]json.RawMessage, name, fallback string) json.RawMessage {
	if raw, present := input[name]; present && len(raw) > 0 {
		if value, err := decodeOrderedNodeJSON(raw); err == nil && jsTruthyNode(value) {
			return raw
		}
	}
	return marshalJSONString(fallback)
}

func (runtime *accountRuntime) serveOpenAIGenerateVideo(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	key, err := startup.ReadSecretString(directories, "api_key_openai")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	// The pinned create body is built with the OR operator and an ABSENT prompt is dropped by stringify.
	create := nodeObject()
	if raw, present := input["prompt"]; present && len(raw) > 0 {
		if value, err := decodeOrderedNodeJSON(raw); err == nil && !value.isUndefined() {
			setRawMember(&create, "prompt", raw)
		}
	}
	setRawMember(&create, "model", openAIOrDefaultRaw(input, "model", openAIVideoDefaultModel))
	setRawMember(&create, "size", openAIOrDefaultRaw(input, "size", openAIVideoDefaultSize))
	setRawMember(&create, "seconds", openAIOrDefaultRaw(input, "seconds", openAIVideoDefaultSeconds))
	body, err := marshalCharacterJSON(create)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	callerGone := func() bool { return request.Context().Err() != nil }
	outboundContext := context.Background()
	base := strings.TrimRight(openAIVideosBaseURL(), "/")
	headers := []outbound.Header{
		{Name: "Content-Type", Value: "application/json"},
		{Name: "Authorization", Value: "Bearer " + key},
	}

	created, err := outbound.Send(outboundContext, outbound.Request{
		URL:     base + openAIVideoCreatePath,
		Method:  http.MethodPost,
		Headers: googleRequestHeaders(base+openAIVideoCreatePath, headers, len(body)),
		Body:    body,
	}, 120*time.Second)
	if err != nil {
		if callerGone() {
			googleTextFailure(w, openAIVideoAborted)
			return
		}
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(created) {
		googleTextFailure(w, string(created.Body))
		return
	}
	createdPayload, err := decodeOrderedNodeJSON(created.Body)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	jobID := ""
	if value, present := createdPayload.member("id"); present && value.kind == 's' {
		jobID = value.scalar.(string)
	}
	if jobID == "" {
		googleTextFailure(w, openAIVideoNoJobID)
		return
	}

	pollURL := base + openAIVideoCreatePath + "/" + jobID
	for attempt := 0; attempt < openAIVideoMaxAttempts; attempt++ {
		if callerGone() {
			googleTextFailure(w, openAIVideoAborted)
			return
		}
		if !openAIVideoSleep(request.Context(), time.Duration(5000+attempt*1000)*time.Millisecond) {
			googleTextFailure(w, openAIVideoAborted)
			return
		}
		if callerGone() {
			googleTextFailure(w, openAIVideoAborted)
			return
		}

		polled, err := outbound.Send(outboundContext, outbound.Request{
			URL:     pollURL,
			Method:  http.MethodGet,
			Headers: googleRequestHeaders(pollURL, []outbound.Header{{Name: "Authorization", Value: "Bearer " + key}}, 0),
		}, 120*time.Second)
		if err != nil {
			if callerGone() {
				googleTextFailure(w, openAIVideoAborted)
				return
			}
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		if !outboundOK(polled) {
			googleTextFailure(w, string(polled.Body))
			return
		}
		pollPayload, err := decodeOrderedNodeJSON(polled.Body)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		status := ""
		if value, present := pollPayload.member("status"); present && value.kind == 's' {
			status = value.scalar.(string)
		}
		if status == openAIVideoFailedStatus {
			googleTextFailure(w, openAIVideoFailed)
			return
		}
		if status != openAIVideoCompleteStatus {
			continue
		}

		contentURL := pollURL + openAIVideoContentSuffix
		content, err := outbound.Send(outboundContext, outbound.Request{
			URL:     contentURL,
			Method:  http.MethodGet,
			Headers: googleRequestHeaders(contentURL, []outbound.Header{{Name: "Authorization", Value: "Bearer " + key}}, 0),
		}, 120*time.Second)
		if err != nil {
			if callerGone() {
				googleTextFailure(w, openAIVideoAborted)
				return
			}
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		if !outboundOK(content) {
			googleTextFailure(w, string(content.Body))
			return
		}
		answer := nodeObject()
		answer.setMember("format", nodeString("mp4"))
		answer.setMember("data", nodeString(base64.StdEncoding.EncodeToString(content.Body)))
		encoded, err := marshalCharacterJSON(answer)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		respondJSONBytes(w, http.StatusOK, encoded)
		return
	}

	// THE EXHAUSTED JOB HANGS, exactly as the pinned handler does: thirty attempts fall off the end of the
	// try, Express answers nothing, and the request stays open until the client gives up. Writing nothing
	// here is deliberate; a bare return would be `200` with an empty body, which is the one outcome that
	// actively misleads a client.
	<-request.Context().Done()
}

var _ = strconv.Itoa
