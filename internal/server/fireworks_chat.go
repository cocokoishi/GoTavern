package server

// FIREWORKS, chat_completion_source: 'fireworks' (src/endpoints/backends/chat-completions.js:2454).
//
// The branch is the SHARED openai-compatible path with three additions:
//
//	bodyParams.reasoning_effort = request.body.reasoning_effort            when supplied
//	bodyParams.response_format  = json_schema -> {type, json_schema:{name, description, schema, strict ?? true}}
//	headers['x-session-affinity'] = HMAC-SHA256(getAffinityKey(), chat_id).hex.slice(0,16)   when chat_id is set
//
// THE AFFINITY HEADER IS NOT RECORDED, and that is a decision with a reason rather than an omission.
// `getAffinityKey()` (chat-completions.js:119) is the install's COOKIE SECRET, so the header value is a digest
// of a per-install configuration value. The provider-wire harness redacts the credentials it knows
// (`authorization`, `x-api-key`) and compares every other header EXACTLY, so a recorded chat_id scenario would
// commit a digest of the cookie secret into the fixture. Instead:
//
//   - the captures carry a chat_id-free request, which asserts the header is ABSENT when the member is absent
//     (the control that fails an "always sends the header" implementation);
//   - a plan-level test asserts PRESENCE and SHAPE (16 lowercase hex) and that two different chat ids produce
//     two different values, computing the expected digest from the harness's own fixed cookie secret;
//   - the test sweeps the fixture to prove no `x-session-affinity` value reached it.
//
// `/status` (:1852) is a DIFFERENT literal OUTSIDE the API base:
// `https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=200`, with
// its own seam, and the reply is projected to `{data: [...]}` entries of
// {id, name, context_length, supports_tools, supports_image_input}, filtered to contextLength > 0 and
// kind !== 'EMBEDDING_MODEL', plus a duplicate entry per fast-router id whose name gains " (fast)". A non-2xx
// and a thrown fetch both answer 200 `{error:true, data:{data:[]}}`.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	pinnedFireworksAPIURL     = "https://api.fireworks.ai/inference/v1"
	pinnedFireworksStatusBase = "https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=200"
	pinnedFireworksSeamEnv    = "GOTAVERN_FIREWORKS_CHAT_URL"
	pinnedFireworksStatusEnv  = "GOTAVERN_FIREWORKS_STATUS_URL"
	pinnedFireworksSecretKey  = "api_key_fireworks"
	chatCompletionSourceFW    = "fireworks"
)

// pinnedFireworksFastRouters is the pinned fast-router table (chat-completions.js:1877-1882).
var pinnedFireworksFastRouters = [][2]string{
	{"accounts/fireworks/models/glm-5p2", "accounts/fireworks/routers/glm-5p2-fast"},
	{"accounts/fireworks/models/kimi-k2p6", "accounts/fireworks/routers/kimi-k2p6-fast"},
	{"accounts/fireworks/models/kimi-k2p7-code", "accounts/fireworks/routers/kimi-k2p7-code-fast"},
	{"accounts/fireworks/models/kimi-k3", "accounts/fireworks/routers/kimi-k3-fast"},
}

func pinnedFireworksBaseURL() string {
	return sdSeamURL(pinnedFireworksSeamEnv, pinnedFireworksAPIURL)
}

// pinnedFireworksStatusURL is the status literal, which lives OUTSIDE the API base and therefore has its own
// seam rather than being derived from pinnedFireworksBaseURL.
func pinnedFireworksStatusURL() string {
	return sdSeamURL(pinnedFireworksStatusEnv, pinnedFireworksStatusBase)
}

// pinnedFireworksAffinity reproduces `createHmac('sha256', getAffinityKey()).update(chat_id).digest('hex')
// .slice(0, 16)`.
func pinnedFireworksAffinity(affinityKey, chatID string) string {
	mac := hmac.New(sha256.New, []byte(affinityKey))
	mac.Write([]byte(chatID))
	return hex.EncodeToString(mac.Sum(nil))[:16]
}

// serveFireworksChatCompletionStatus is the FIREWORKS arm of the pinned status matrix (:1852).
func (runtime *accountRuntime) serveFireworksChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	keyNode, secretErr := pinnedReadSecret(directories, pinnedFireworksSecretKey, pinnedSecretID(body))
	if secretErr != nil {
		searchJSON(w, pinnedFireworksStatusFailure())
		return
	}
	key, keyErr := pinnedJSStringValue(keyNode)
	if keyErr != nil {
		searchJSON(w, pinnedFireworksStatusFailure())
		return
	}
	if key == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	headers := map[string]string{"authorization": "Bearer " + key}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodGet,
		URL:     pinnedFireworksStatusURL(),
		Headers: headers,
	})
	if fetchErr != nil {
		searchJSON(w, pinnedFireworksStatusFailure())
		return
	}
	if !sdResponseOK(response) {
		searchJSON(w, pinnedFireworksStatusFailure())
		return
	}
	data, parsed := sdReadJSON(response)
	if !parsed {
		searchJSON(w, pinnedFireworksStatusFailure())
		return
	}
	models := nodeArray()
	if listed, exists := data.member("models"); exists && listed.kind == 'a' {
		for _, model := range listed.array {
			if model.kind != 'o' {
				continue
			}
			contextLength, hasContext := model.member("contextLength")
			kind, hasKind := model.member("kind")
			if hasContext && !pinnedJSGreaterThanZero(contextLength) {
				continue
			}
			if hasKind {
				if text, err := pinnedJSStringValue(kind); err == nil && text == "EMBEDDING_MODEL" {
					continue
				}
			}
			projected := nodeObject()
			if name, ok := model.member("name"); ok {
				projected.setMember("id", name)
			}
			if display, ok := model.member("displayName"); ok {
				projected.setMember("name", display)
			}
			if value, ok := model.member("contextLength"); ok {
				projected.setMember("context_length", value)
			}
			if value, ok := model.member("supportsTools"); ok {
				projected.setMember("supports_tools", value)
			}
			if value, ok := model.member("supportsImageInput"); ok {
				projected.setMember("supports_image_input", value)
			}
			models.array = append(models.array, projected)
		}
	}
	for _, pair := range pinnedFireworksFastRouters {
		for _, existing := range models.array {
			id, hasID := existing.member("id")
			if !hasID {
				continue
			}
			text, err := pinnedJSStringValue(id)
			if err != nil || text != pair[0] {
				continue
			}
			duplicate := nodeObject()
			for _, entry := range existing.object {
				duplicate.setMember(entry.key, entry.value)
			}
			duplicate.setMember("id", nodeString(pair[1]))
			if name, hasName := existing.member("name"); hasName {
				if text, err := pinnedJSStringValue(name); err == nil {
					duplicate.setMember("name", nodeString(text+" (fast)"))
				}
			}
			models.array = append(models.array, duplicate)
		}
	}
	out := nodeObject()
	out.setMember("data", models)
	searchJSON(w, out)
}

// pinnedFireworksStatusFailure is `{error:true, data:{data:[]}}`, answered 200.
func pinnedFireworksStatusFailure() orderedNodeJSON {
	failure := nodeObject()
	failure.setMember("error", nodeBool(true))
	nested := nodeObject()
	nested.setMember("data", nodeArray())
	failure.setMember("data", nested)
	return failure
}
