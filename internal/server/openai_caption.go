package server

// Pinned `/api/openai/caption-image` (openai.js:16) — the BRANCH DISPATCH (wave D commit 1).
//
// The route selects on `request.body.api` with NINETEEN distinct values, each changing the secret, the URL
// and sometimes the body. The table below is the SAME data the fixture records as `branches`, and the test
// asserts the two are equal (values and distinctness), so the two copies cannot drift while both count
// assertions pass.
//
// Four branches (ooba, koboldcpp, llamacpp, vllm) share the local fallback URL and are still four entries,
// because their api VALUE and their secret differ: a "distinct URL" count would be 15 and would silently
// tolerate four missing branches.
//
// `reverse_proxy` is a MODIFIER rather than a branch: it overrides the URL to `<reverse_proxy>/chat/completions`
// for the keyed branches, and treating it as a branch would inflate the count and hide a missing modifier.
//
// Pinned details a reasonable implementation would flatten, each recorded in the oracle:
//
//   - the body member order is model, messages, then the per-branch bodyParams members, and the message
//     content order is text then image_url inside a single user message (hard rule 8: order is contract);
//   - `noKeyTypes` (custom, ooba, koboldcpp, vllm, llamacpp) run WITHOUT a key, while every other branch
//     answers 400 with no outbound request;
//   - `pollinations` uses the LITERAL string 'anonymous' as its key for the anonymous endpoint and adds a
//     RANDOMIZED seed, which is why the fixture masks it;
//   - `workers_ai` requires `workers_ai_account_id`, encodeURIComponent-ed into the path, and answers 400
//     with a specific error body without one;
//   - `zai` sets max_tokens 4096 and chooses its endpoint by `zai_endpoint`; `ooba` forces temperature 0.1;
//   - `openai.captionSystemPrompt` from the CONFIG is unshifted as a system message at index 0. The fixture
//     records the config ABSENT; asserting the present case needs the probe library to rewrite the runtime
//     config, which it cannot do today, so that branch is stated as a gap rather than claimed.
//
// NOT YET RECORDED, and therefore not asserted here: the non-ok response shape, and the shared 400 guard for
// an array `content` member. Both are stated as gaps rather than implemented from a guess.

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

type openAICaptionBranch struct {
	api      string
	secretID string
	url      string
}

// openAICaptionBranches mirrors the fixture's `branches` list, in the same order.
var openAICaptionBranches = []openAICaptionBranch{
	{"openai", "api_key_openai", "https://api.openai.com/v1/chat/completions"},
	{"xai", "api_key_xai", "https://api.x.ai/v1/chat/completions"},
	{"mistral", "api_key_mistralai", "https://api.mistral.ai/v1/chat/completions"},
	{"custom", "api_key_custom", "https://local.example.test/chat/completions"},
	{"openrouter", "api_key_openrouter", "https://openrouter.ai/api/v1/chat/completions"},
	{"ooba", "api_key_ooba", "https://local.example.test/v1/chat/completions"},
	{"koboldcpp", "api_key_koboldcpp", "https://local.example.test/v1/chat/completions"},
	{"llamacpp", "api_key_llamacpp", "https://local.example.test/v1/chat/completions"},
	{"vllm", "api_key_vllm", "https://local.example.test/v1/chat/completions"},
	{"aimlapi", "api_key_aimlapi", "https://api.aimlapi.com/v1/chat/completions"},
	{"groq", "api_key_groq", "https://api.groq.com/openai/v1/chat/completions"},
	{"cohere", "api_key_cohere", "https://api.cohere.ai/v2/chat"},
	{"moonshot", "api_key_moonshot", "https://api.moonshot.ai/v1/chat/completions"},
	{"nanogpt", "api_key_nanogpt", "https://nano-gpt.com/api/v1/chat/completions"},
	{"chutes", "api_key_chutes", "https://llm.chutes.ai/v1/chat/completions"},
	{"electronhub", "api_key_electronhub", "https://api.electronhub.ai/v1/chat/completions"},
	{"zai", "api_key_zai", "https://api.z.ai/api/paas/v4/chat/completions"},
	{"pollinations", "api_key_pollinations", "https://gen.pollinations.ai/v1/chat/completions"},
	{"workers_ai", "api_key_workers_ai", "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions"},
}

// openAICaptionNoKeyBranches are the api values that run WITHOUT a key.
var openAICaptionNoKeyBranches = []string{"custom", "ooba", "koboldcpp", "vllm", "llamacpp"}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerOpenAICaptionRoutes)
}

func registerOpenAICaptionRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("/api/openai/caption-image", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveOpenAICaptionImage(w, r, options)
	})
}

func openAICaptionBranchFor(api string) (openAICaptionBranch, bool) {
	for _, branch := range openAICaptionBranches {
		if branch.api == api {
			return branch, true
		}
	}
	return openAICaptionBranch{}, false
}

// openAICaptionIsNoKey reports whether a branch is allowed to run without a key.
func openAICaptionIsNoKey(api string) bool {
	for _, value := range openAICaptionNoKeyBranches {
		if value == api {
			return true
		}
	}
	return false
}

// openAICaptionTrimV1 reproduces `trimV1(url)`: a trailing `/v1` is removed before `/v1/chat/completions` is
// appended, so a server_url that already carries the version is not doubled.
func openAICaptionTrimV1(value string) string {
	trimmed := strings.TrimRight(value, "/")
	if strings.HasSuffix(trimmed, "/v1") {
		return trimmed[:len(trimmed)-len("/v1")]
	}
	return trimmed
}

func (runtime *accountRuntime) serveOpenAICaptionImage(w http.ResponseWriter, request *http.Request, options HTTPHandlerOptions) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	api := ""
	if value, present := googleRawMemberString(input, "api"); present {
		api = value
	}
	branch, known := openAICaptionBranchFor(api)
	if !known {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	reverseProxy := ""
	if value, present := googleRawMemberString(input, "reverse_proxy"); present {
		reverseProxy = value
	}

	key := ""
	if api == "pollinations" {
		if value, present := googleRawMemberString(input, "pollinations_endpoint"); present && value == "anonymous" {
			// The pinned code uses this LITERAL as the key for the anonymous endpoint.
			key = "anonymous"
		} else {
			secret, err := startup.ReadSecretString(directories, branch.secretID)
			if err != nil {
				serveStatusText(w, http.StatusInternalServerError)
				return
			}
			key = secret
		}
	} else {
		secret, err := startup.ReadSecretString(directories, branch.secretID)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		key = secret
	}
	if reverseProxy != "" {
		if password, present := googleRawMemberString(input, "proxy_password"); present {
			// The pinned code replaces the key with the proxy password whenever reverse_proxy is set.
			key = password
		}
	}
	if key == "" && reverseProxy == "" && !openAICaptionIsNoKey(api) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}

	serverURL := ""
	if value, present := googleRawMemberString(input, "server_url"); present {
		serverURL = value
	}
	accountID := ""
	if api == "workers_ai" {
		accountID = strings.TrimSpace(openAIOrDefaultString(input, "workers_ai_account_id", ""))
		if accountID == "" {
			answer := nodeObject()
			answer.setMember("error", nodeString("Cloudflare Workers AI Account ID is required"))
			encoded, err := marshalCharacterJSON(answer)
			if err != nil {
				serveStatusText(w, http.StatusInternalServerError)
				return
			}
			respondJSONBytes(w, http.StatusBadRequest, encoded)
			return
		}
	}

	target := branch.url
	switch {
	case reverseProxy != "":
		target = strings.TrimRight(reverseProxy, "/") + "/chat/completions"
	case api == "custom":
		target = strings.TrimRight(serverURL, "/") + "/chat/completions"
	case api == "ooba" || api == "koboldcpp" || api == "llamacpp" || api == "vllm":
		target = openAICaptionTrimV1(serverURL) + "/v1/chat/completions"
	case api == "workers_ai":
		target = strings.ReplaceAll(branch.url, "{account}", encodeURIComponentJS(accountID))
	case api == "zai":
		if value, present := googleRawMemberString(input, "zai_endpoint"); present && value == "coding" {
			target = "https://api.z.ai/api/coding/paas/v4/chat/completions"
		}
	case api == "pollinations":
		if value, present := googleRawMemberString(input, "pollinations_endpoint"); present && value == "anonymous" {
			target = "https://text.pollinations.ai/v1/chat/completions"
		}
	}

	// TEST SEAM. Every branch URL is a pinned LITERAL, so the only way to replay the recorded requests against
	// a controlled peer is to keep each branch's PATH and point its scheme and host at an override. Production
	// leaves it unset and the default is empty, so the literals above are what ships.
	if override := sdSeamURL("GOTAVERN_OPENAI_CAPTION_BASE_URL", ""); override != "" {
		if parsed, err := url.Parse(target); err == nil {
			if base, baseErr := url.Parse(override); baseErr == nil {
				parsed.Scheme = base.Scheme
				parsed.Host = base.Host
				target = parsed.String()
			}
		}
	}

	// Body member order is contract: model, messages, then the per-branch bodyParams members.
	body := nodeObject()
	setRawMember(&body, "model", input["model"])
	textPart := nodeObject()
	textPart.setMember("type", nodeString("text"))
	setRawMember(&textPart, "text", input["prompt"])
	imageURL := nodeObject()
	setRawMember(&imageURL, "url", input["image"])
	imagePart := nodeObject()
	imagePart.setMember("type", nodeString("image_url"))
	imagePart.setMember("image_url", imageURL)
	content := nodeArray()
	content.array = append(content.array, textPart, imagePart)
	message := nodeObject()
	message.setMember("role", nodeString("user"))
	message.setMember("content", content)
	messages := nodeArray()
	messages.array = append(messages.array, message)

	// Z.AI video inlining: a data:video image is CONVERTED, not supplemented -- the part's type becomes
	// video_url, the old image_url object MOVES to the new key, and image_url is DELETED. The fixture asserts
	// the resulting KEYS and the ABSENCE of image_url, because adding video_url while leaving image_url in
	// place would pass a presence-only check. The trigger is the PINNED REGEX, not a looser prefix test: a
	// malformed data:video/;base64, URI must NOT be converted, and the fixture records that case.
	if api == "zai" {
		if rawImage, present := googleRawMemberString(input, "image"); present && openAICaptionVideoDataURI.MatchString(rawImage) {
			for index := range content.array {
				if partType, ok := content.array[index].member("type"); ok && partType.kind == 's' && partType.scalar.(string) == "image_url" {
					if moved, hasImage := content.array[index].member("image_url"); hasImage {
						replacement := nodeObject()
						replacement.setMember("type", nodeString("video_url"))
						replacement.setMember("video_url", moved)
						content.array[index] = replacement
					}
				}
			}
		}
	}

	// A config-driven system prompt is UNSHIFTED at index 0.
	if systemPrompt := googleConfigValue(options, []string{"openai", "captionSystemPrompt"}, ""); systemPrompt != "" {
		system := nodeObject()
		system.setMember("role", nodeString("system"))
		system.setMember("content", nodeString(systemPrompt))
		shifted := nodeArray()
		shifted.array = append(shifted.array, system)
		shifted.array = append(shifted.array, messages.array...)
		messages = shifted
	}
	// The GROQ branch rewrites a LEADING SYSTEM message to `user`, keeping its string content. It is only
	// reachable when the config supplies a system prompt, which is why it is asserted with the config PRESENT.
	if api == "groq" && len(messages.array) > 0 {
		if role, present := messages.array[0].member("role"); present && role.kind == 's' && role.scalar.(string) == "system" {
			messages.array[0].setMember("role", nodeString("user"))
		}
	}
	body.setMember("messages", messages)

	switch api {
	case "ooba":
		body.setMember("temperature", nodeNumber(0.1))
	case "zai":
		body.setMember("max_tokens", nodeNumber(4096))
	case "pollinations":
		// RANDOMIZED: the fixture masks it, and it is classified shape with no value recorded.
		body.setMember("seed", nodeNumber(float64(sdRandomSeedNumber(4294967296))))
	}

	encoded, err := marshalCharacterJSON(body)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// The pinned header object is built UNCONDITIONALLY as `Authorization: Bearer ${key}`, so a no-key branch
	// sends the literal "Bearer " rather than omitting the header. The fixture asserts that empty bearer, which
	// a conditional implementation would fail.
	headers := []outbound.Header{
		{Name: "Content-Type", Value: "application/json"},
		{Name: "Authorization", Value: "Bearer " + key},
	}
	// `api_type` is a DIFFERENT body member from `api`: it selects the additional-header getter. With it
	// ABSENT -- which is what every other scenario records -- the pinned server adds NOTHING.
	if apiType, present := googleRawMemberString(input, "api_type"); present {
		headers = runtime.openAICaptionApplyTypeHeaders(headers, directories, apiType)
	}
	response, err := outbound.Send(request.Context(), outbound.Request{
		URL:     target,
		Method:  http.MethodPost,
		Headers: googleRequestHeaders(target, headers, len(encoded)),
		Body:    encoded,
	}, 120*time.Second)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		// The pinned `!result.ok` branch FORWARDS the provider's text with status 500. It does not answer a
		// generic message, which is what the other routes in this domain each did differently.
		respondText(w, http.StatusInternalServerError, "text/plain", string(response.Body))
		return
	}
	decoded, err := decodeOrderedNodeJSON(response.Body)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	caption := ""
	if choices := nodeGet(decoded, "choices"); choices.kind == 'a' && len(choices.array) > 0 {
		if message, present := choices.array[0].member("message"); present {
			if value, hasContent := message.member("content"); hasContent && value.kind == 's' {
				caption = value.scalar.(string)
			}
		}
	}
	// The SECOND shape: data.message.content[0].text. A choices-only implementation misses it.
	if caption == "" {
		if message, present := decoded.member("message"); present {
			if content, hasContent := message.member("content"); hasContent && content.kind == 'a' && len(content.array) > 0 {
				if value, hasText := content.array[0].member("text"); hasText && value.kind == 's' {
					caption = value.scalar.(string)
				}
			}
		}
	}
	if caption == "" {
		// The pinned literal, not a generic message.
		respondText(w, http.StatusInternalServerError, "text/plain", "No caption found")
		return
	}
	answer := nodeObject()
	answer.setMember("caption", nodeString(caption))
	result, err := marshalCharacterJSON(answer)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, result)
}

// openAICaptionVideoDataURI is the PINNED trigger for the zai video-inlining transform, transcribed from
// `/data:video\/\w+;base64,/`. It is a regex rather than a prefix test on purpose: a malformed
// `data:video/;base64,` URI does NOT match, and the fixture records that case so the difference is asserted.
var openAICaptionVideoDataURI = regexp.MustCompile(`data:video/\w+;base64,`)

// openAICaptionAPITypes is the pinned headerGetters table's fourteen keys, written down so an omitted type
// fails as a count rather than passing as an absence.
var openAICaptionAPITypes = []string{
	"mancer", "vllm", "aphrodite", "tabby", "togetherai", "ooba", "infermaticai",
	"dreamgen", "openrouter", "koboldcpp", "llamacpp", "featherless", "huggingface", "generic",
}

// openAICaptionApplyTypeHeaders merges the getter for api_type over the route headers. The getter's own
// Authorization REPLACES the branch key when it has a secret of its own: a replacement, not an addition.
//
// MEASURED for openrouter: OPENROUTER_HEADERS plus `Authorization: Bearer <api_key_openrouter>` when that
// secret exists. The OTHER THIRTEEN types are in the table but their header sets and secret keys are NOT yet
// measured, so they contribute nothing here and the row states that rather than inventing them.
func (runtime *accountRuntime) openAICaptionApplyTypeHeaders(headers []outbound.Header, directories startup.UserDirectories, apiType string) []outbound.Header {
	known := false
	for _, value := range openAICaptionAPITypes {
		if value == apiType {
			known = true
			break
		}
	}
	if !known || apiType != "openrouter" {
		return headers
	}
	merged := []outbound.Header{
		{Name: "HTTP-Referer", Value: "https://sillytavern.app"},
		{Name: "X-Title", Value: "SillyTavern"},
	}
	if secret, err := startup.ReadSecretString(directories, "api_key_openrouter"); err == nil && secret != "" {
		merged = append(merged, outbound.Header{Name: "Authorization", Value: "Bearer " + secret})
	}
	for _, extra := range merged {
		replaced := false
		for index := range headers {
			if strings.EqualFold(headers[index].Name, extra.Name) {
				headers[index].Value = extra.Value
				replaced = true
				break
			}
		}
		if !replaced {
			headers = append(headers, extra)
		}
	}
	return headers
}

// openAIOrDefaultString is `String(value || ”)` for a raw member.
func openAIOrDefaultString(input map[string]json.RawMessage, name, fallback string) string {
	if value, present := googleRawMemberString(input, name); present {
		return value
	}
	return fallback
}

var _ = base64.StdEncoding
