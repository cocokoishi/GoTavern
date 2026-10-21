package server

// Pinned `/api/google/generate-video` (google.js:498).
//
// The route creates a long-running job and then POLLS: up to thirty attempts, each preceded by
// `await delay(5000 + attempt * 1000)`. Two poll shapes exist — Vertex posts `:fetchPredictOperation`
// with `{operationName}` and reads `response.videos[0].bytesBase64Encoded`; AI Studio GETs
// `urlJoin(baseUrl, jobName)` and reads `response.generateVideoResponse.generatedSamples[0].video.uri`,
// then FETCHES that provider-supplied URI and base64-encodes the bytes.
//
// That provider URI needs no production seam: the pinned route reaches it through the same `node-fetch`
// module every other call uses, so a controlled peer captures it. (`zai` is the different case — its
// route refuses a hostname outside .zai/.ufileos.com, which is a policy in the pinned source rather than
// an unreachable transport.)
//
// Pinned details a reasonable implementation would flatten, each recorded in the oracle:
//
//   - `personGeneration` is HARDCODED to 'allow_all' here, unlike generate-image which reads
//     `gemini.image.personGeneration` from config. Unifying the two would be a compatibility break;
//   - `durationSeconds` is `clamp(Number(body.seconds || 6), isVeo3 ? 4 : 5, 8)`, so an absent member
//     becomes 6 and the bounds depend on the model family;
//   - the `seed` member exists ONLY for a veo-3 model, and is randomized when absent;
//   - `negativePrompt` defaults to the EMPTY STRING, not to an omitted member;
//   - eight distinct failures each answer 500 with their own TEXT message;
//   - the poll count is behaviour, and it is what a cache-like shortcut would change.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

const (
	googleVideoDefaultModel   = "veo-3.1-generate-preview"
	googleVideoMaxAttempts    = 30
	googleVideoDefaultSeconds = 6
)

// googleVideoSleep is the pinned `delay(ms)`. It is a variable so the timeout branch — thirty polls with
// delays summing to about ten minutes — can be exercised by a labelled implementation test without
// waiting, and so a test can prove the loop ran thirty times. Production always uses the real timer, and
// the probe deliberately does NOT shorten the delay, because that would record a behaviour the product
// does not have.
var googleVideoSleep = func(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerGoogleVideoRoutes)
}

func registerGoogleVideoRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("/api/google/generate-video", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveGoogleGenerateVideo(w, r, options)
	})
}

// googleClamp reproduces `lodash.clamp(value, lower, upper)`.
func googleClamp(value, lower, upper float64) float64 {
	if value < lower {
		return lower
	}
	if value > upper {
		return upper
	}
	return value
}

func (runtime *accountRuntime) serveGoogleGenerateVideo(w http.ResponseWriter, request *http.Request, options HTTPHandlerOptions) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	model := googleVideoDefaultModel
	if value, present := googleRawMemberString(input, "model"); present && value != "" {
		model = value
	}
	config, err := runtime.googleAPIConfigFor(request, directories, options, input, model, "predictLongRunning")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	isVertex := false
	if value, present := googleRawMemberString(input, "api"); present {
		isVertex = value == "vertexai"
	}
	isVeo3 := strings.Contains(model, "veo-3")
	lowerBound := 5.0
	if isVeo3 {
		lowerBound = 4
	}

	prompt := ""
	if value, present := googleRawMemberString(input, "prompt"); present {
		prompt = value
	}
	negativePrompt := ""
	if value, present := googleRawMemberString(input, "negative_prompt"); present {
		negativePrompt = value
	}
	seconds := float64(googleVideoDefaultSeconds)
	if raw, present := input["seconds"]; present && len(raw) > 0 {
		if value, err := decodeOrderedNodeJSON(raw); err == nil {
			seconds = javascriptToNumber(value)
			if seconds == 0 || seconds != seconds {
				seconds = googleVideoDefaultSeconds
			}
		}
	}
	aspectRatio := "16:9"
	if value, present := googleRawMemberString(input, "aspect_ratio"); present && value != "" {
		aspectRatio = value
	}

	instance := nodeObject()
	instance.setMember("prompt", nodeString(prompt))
	instances := nodeArray()
	instances.array = append(instances.array, instance)
	parameters := nodeObject()
	parameters.setMember("negativePrompt", nodeString(negativePrompt))
	parameters.setMember("durationSeconds", nodeNumber(googleClamp(seconds, lowerBound, 8)))
	parameters.setMember("aspectRatio", nodeString(aspectRatio))
	parameters.setMember("personGeneration", nodeString("allow_all"))
	if isVeo3 {
		seed := nodeNumber(float64(sdRandomSeedNumber(1000000)))
		if raw, present := input["seed"]; present && len(raw) > 0 {
			if value, err := decodeOrderedNodeJSON(raw); err == nil {
				seed = nodeNumber(javascriptToNumber(value))
			}
		}
		parameters.setMember("seed", seed)
	}
	payload := nodeObject()
	payload.setMember("instances", instances)
	payload.setMember("parameters", parameters)
	body, err := marshalCharacterJSON(payload)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	created, err := outbound.Send(request.Context(), outbound.Request{
		URL:     config.url,
		Method:  http.MethodPost,
		Headers: googleRequestHeaders(config.url, config.headers, len(body)),
		Body:    body,
	}, 120*time.Second)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(created) {
		googleTextFailure(w, "Video generation request failed")
		return
	}
	createdPayload, err := decodeOrderedNodeJSON(created.Body)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	jobName := ""
	if value, present := createdPayload.member("name"); present && value.kind == 's' {
		jobName = value.scalar.(string)
	}
	if jobName == "" {
		googleTextFailure(w, "No video job name found in response")
		return
	}

	for attempt := 0; attempt < googleVideoMaxAttempts; attempt++ {
		if request.Context().Err() != nil {
			googleTextFailure(w, "Video generation aborted by client")
			return
		}
		if !googleVideoSleep(request.Context(), time.Duration(5000+attempt*1000)*time.Millisecond) {
			googleTextFailure(w, "Video generation aborted by client")
			return
		}

		var pollURL string
		var pollHeaders []outbound.Header
		pollMethod := http.MethodPost
		pollBody := []byte(nil)
		if isVertex {
			pollConfig, err := runtime.googleAPIConfigFor(request, directories, options, input, model, "fetchPredictOperation")
			if err != nil {
				serveStatusText(w, http.StatusInternalServerError)
				return
			}
			pollURL = pollConfig.url
			pollHeaders = pollConfig.headers
			operation := nodeObject()
			operation.setMember("operationName", nodeString(jobName))
			encoded, err := marshalCharacterJSON(operation)
			if err != nil {
				serveStatusText(w, http.StatusInternalServerError)
				return
			}
			pollBody = encoded
		} else {
			pollURL = sdURLJoin(config.baseURL, jobName)
			pollMethod = http.MethodGet
			pollHeaders = config.headers
		}

		headers := googleRequestHeaders(pollURL, pollHeaders, len(pollBody))
		pollResponse, err := outbound.Send(request.Context(), outbound.Request{
			URL:     pollURL,
			Method:  pollMethod,
			Headers: headers,
			Body:    pollBody,
		}, 120*time.Second)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		if !outboundOK(pollResponse) {
			googleTextFailure(w, "Video job status request failed")
			return
		}
		pollPayload, err := decodeOrderedNodeJSON(pollResponse.Body)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		done := false
		if value, present := pollPayload.member("done"); present {
			done = jsTruthyNode(value)
		}
		if !done {
			continue
		}

		if isVertex {
			videoData := ""
			if response, present := pollPayload.member("response"); present {
				if videos, hasVideos := response.member("videos"); hasVideos && videos.kind == 'a' && len(videos.array) > 0 {
					if value, hasValue := videos.array[0].member("bytesBase64Encoded"); hasValue && value.kind == 's' {
						videoData = value.scalar.(string)
					}
				}
			}
			if videoData == "" {
				googleTextFailure(w, "No video data found in response")
				return
			}
			googleVideoAnswer(w, videoData)
			return
		}

		videoURI := ""
		if response, present := pollPayload.member("response"); present {
			if generated, hasGenerated := response.member("generateVideoResponse"); hasGenerated {
				if samples, hasSamples := generated.member("generatedSamples"); hasSamples && samples.kind == 'a' && len(samples.array) > 0 {
					if video, hasVideo := samples.array[0].member("video"); hasVideo {
						if value, hasURI := video.member("uri"); hasURI && value.kind == 's' {
							videoURI = value.scalar.(string)
						}
					}
				}
			}
		}
		if videoURI == "" {
			googleTextFailure(w, "No video URI found in response")
			return
		}
		fetched, err := outbound.Send(request.Context(), outbound.Request{
			URL:     videoURI,
			Method:  http.MethodGet,
			Headers: googleRequestHeaders(videoURI, config.headers, 0),
		}, 120*time.Second)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		if !outboundOK(fetched) {
			googleTextFailure(w, "Video fetch request failed")
			return
		}
		googleVideoAnswer(w, base64.StdEncoding.EncodeToString(fetched.Body))
		return
	}
	googleTextFailure(w, "Video generation timed out")
}

func googleVideoAnswer(w http.ResponseWriter, videoBase64 string) {
	answer := nodeObject()
	answer.setMember("video", nodeString(videoBase64))
	encoded, err := marshalCharacterJSON(answer)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, encoded)
}

var _ = json.Marshal
var _ = strconv.Itoa
