package server

// MAKERSUITE (Google AI Studio) and VERTEXAI, both served by ONE pinned function:
// src/endpoints/backends/chat-completions.js:454 `sendMakerSuiteRequest`, dispatched twice at :2262 and
// :2263. This file is the URL and credential layer of that shared transform, which is where the two
// sources genuinely differ. The request BODY builder (:502-667) is NOT ported here; see the boundary at the
// end of this comment.
//
// WHAT IS SHARED (so a lane must not implement two independent transforms):
//   - one body builder (`getGeminiBody`), one prompt converter, one generationConfig, one tool config;
//   - two body-level differences only: VERTEX appends VERTEX_SAFETY to the safety list (:569) and clears
//     `includeThoughts` when the thinking budget is 0 (:616-619), a combination Vertex rejects.
//
// WHAT IS DIFFERENT, and it is NOT a single literal with a flag:
//
//	                          MAKERSUITE                                   VERTEXAI
//	base literal      https://generativelanguage.googleapis.com     https://us-central1-aiplatform.googleapis.com (:80, :81)
//	api version       getConfigValue('gemini.apiVersion','v1beta')   HARDCODED `v1` -- it never reads the config (:697-726)
//	path              /{version}/models/{model}:{type}               /v1/publishers/google/models/{model}:{type}
//	                                                                  (express WITH project: /v1/projects/{p}/locations/{r}/publishers/...)
//	credential        ?key=<apiKey> in the QUERY, never a header      express: ?key=;  full/proxy: Authorization header
//	stream marker     &alt=sse (after the key)                        ?alt=sse  -- there is no key to put first
//	status arm        EXISTS, and it is its OWN shape (:1908-1924)     NO ARM: it falls to the shared else at :2062-2065, 400 {error:true}
//
// Three further pinned quirks reproduced below rather than tidied:
//   - express mode WITH a project id ALWAYS uses the global host `aiplatform.googleapis.com`, even when the
//     location is regional (:696-698). Without a project id the host is built from the region.
//   - `region === 'global'` means `aiplatform.googleapis.com`; any other region prefixes the host (:693-695,
//     718-722).
//   - the makersuite status URL drops the `?key=` parameter entirely when a reverse_proxy is set and no key
//     is available (:1912-1914), while still refusing with 400 when there is neither a key nor a proxy.
//
// NOT PORTED HERE, named rather than silently missing: the body builder and its six dependencies --
// convertGooglePrompt, getPromptNames, calculateGoogleBudgetTokens, GEMINI_SAFETY, VERTEX_SAFETY and
// getVertexAIAuth (which mints service-account credentials). Until those land, neither source may be
// dispatched, because a route that answered a differently shaped body would be a fabricated success. This
// file therefore adds NO dispatch line; the Lead wires dispatch centrally once the body layer exists.

const (
	// :80 and :81 -- two DIFFERENT base literals, so two seams rather than one combined value.
	pinnedMakerSuiteAPIURL  = "https://generativelanguage.googleapis.com"
	pinnedMakerSuiteSeamEnv = "GOTAVERN_MAKERSUITE_CHAT_URL"
	pinnedVertexAIAPIURL    = "https://us-central1-aiplatform.googleapis.com"
	pinnedVertexAISeamEnv   = "GOTAVERN_VERTEXAI_CHAT_URL"

	// SECRET_KEYS.MAKERSUITE and SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT.
	pinnedMakerSuiteSecretKey    = "api_key_makersuite"
	pinnedVertexAIServiceAccount = "vertexai_service_account"

	// getConfigValue('gemini.apiVersion', 'v1beta') (:679). VERTEXAI never consults it.
	pinnedGeminiDefaultAPIVersion = "v1beta"
	// Vertex hardcodes the v1 path (:697-726); the constant exists so the difference is visible.
	pinnedVertexAIAPIVersion = "v1"

	chatCompletionSourceMakerSuite = "makersuite"
	chatCompletionSourceVertexAI   = "vertexai"
)

// pinnedMakerSuiteBaseURL and pinnedVertexAIBaseURL are the two pinned literals, each replaceable only by
// its OWN seam: a shared seam would let one source's replay point the other at the wrong host.
func pinnedMakerSuiteBaseURL() string {
	return sdSeamURL(pinnedMakerSuiteSeamEnv, pinnedMakerSuiteAPIURL)
}

func pinnedVertexAIBaseURL() string {
	return sdSeamURL(pinnedVertexAISeamEnv, pinnedVertexAIAPIURL)
}

// pinnedVertexAIHost is `region === 'global' ? 'https://aiplatform.googleapis.com'
// : 'https://' + region + '-aiplatform.googleapis.com'` (:693-695, :718-722).
func pinnedVertexAIHost(region string) string {
	if region == "global" {
		return "https://aiplatform.googleapis.com"
	}
	return "https://" + region + "-aiplatform.googleapis.com"
}

// pinnedGoogleResponseType is `stream ? 'streamGenerateContent' : 'generateContent'` (:680).
func pinnedGoogleResponseType(stream bool) string {
	if stream {
		return "streamGenerateContent"
	}
	return "generateContent"
}

// trimmedGoogleBase is `apiUrl.toString().replace(/\/$/, ”)` (:726, :730): exactly one trailing slash is
// removed, which is what a reverse_proxy entered as `https://host/` needs.
func trimmedGoogleBase(base string) string {
	if len(base) > 0 && base[len(base)-1] == '/' {
		return base[:len(base)-1]
	}
	return base
}

// pinnedMakerSuiteGenerateURL is :730:
//
//	`${apiUrl}/${apiVersion}/models/${model}:${responseType}?key=${apiKey}${stream ? '&alt=sse' : ''}`
//
// The key is a QUERY parameter and no Authorization header is attached for this source: `authHeader` is
// assigned at :484 and then never used on the makersuite path, which is easy to misread.
func pinnedMakerSuiteGenerateURL(base, apiVersion, model string, stream bool, apiKey string) string {
	url := trimmedGoogleBase(base) + "/" + apiVersion + "/models/" + model + ":" + pinnedGoogleResponseType(stream) + "?key=" + apiKey
	if stream {
		url += "&alt=sse"
	}
	return url
}

// pinnedVertexAIProxyGenerateURL is the proxy auth mode (:726): the reverse_proxy base is used verbatim and
// the credential travels in the Authorization header, so the URL carries only `?alt=sse` when streaming.
func pinnedVertexAIProxyGenerateURL(base, model string, stream bool) string {
	url := trimmedGoogleBase(base) + "/" + pinnedVertexAIAPIVersion + "/publishers/google/models/" + model + ":" + pinnedGoogleResponseType(stream)
	if stream {
		url += "?alt=sse"
	}
	return url
}

// pinnedVertexAIExpressGenerateURL is the express (API key) mode (:696-698). A project id, when present,
// selects the PROJECT path AND forces the global host even for a regional location.
func pinnedVertexAIExpressGenerateURL(model string, stream bool, apiKey, projectID, region string) string {
	url := ""
	if projectID != "" {
		url = "https://aiplatform.googleapis.com/" + pinnedVertexAIAPIVersion +
			"/projects/" + projectID + "/locations/" + region +
			"/publishers/google/models/" + model + ":" + pinnedGoogleResponseType(stream)
	} else {
		url = pinnedVertexAIHost(region) + "/" + pinnedVertexAIAPIVersion +
			"/publishers/google/models/" + model + ":" + pinnedGoogleResponseType(stream)
	}
	url += "?key=" + apiKey
	if stream {
		url += "&alt=sse"
	}
	return url
}

// pinnedVertexAIServiceAccountGenerateURL is the full (service account) mode (:716-722): the project id
// comes from the service-account JSON, the host is regional, and the credential is an Authorization header
// added by the caller, so the URL carries only `?alt=sse` when streaming.
func pinnedVertexAIServiceAccountGenerateURL(model string, stream bool, projectID, region string) string {
	url := pinnedVertexAIHost(region) + "/" + pinnedVertexAIAPIVersion +
		"/projects/" + projectID + "/locations/" + region +
		"/publishers/google/models/" + model + ":" + pinnedGoogleResponseType(stream)
	if stream {
		url += "?alt=sse"
	}
	return url
}

// pinnedMakerSuiteStatusURL is the makersuite status arm's OWN URL shape (:1912-1914):
//
//	!apiKey && reverse_proxy  ->  `${apiUrl}/${apiVersion}/models`
//	otherwise                 ->  `${apiUrl}/${apiVersion}/models?key=${apiKey}`
//
// Unlike every other source in the status matrix this arm builds its URL itself and answers `{data: models}`
// (a projection of fetchGoogleModels), not the shared `{data: {...}}` envelope.
func pinnedMakerSuiteStatusURL(base, apiVersion, apiKey string, hasReverseProxy bool) string {
	url := trimmedGoogleBase(base) + "/" + apiVersion + "/models"
	if apiKey == "" && hasReverseProxy {
		return url
	}
	return url + "?key=" + apiKey
}
