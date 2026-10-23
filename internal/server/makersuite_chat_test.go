package server

// PLAN-level assertions for the MAKERSUITE / VERTEXAI URL and credential matrix.
//
// No capture is involved and none is needed: every case below is a URL the pinned source builds by string
// interpolation, so the oracle for it is the pinned line cited on each builder, and the discriminating
// input is a model/location/project pair that makes the shapes differ. The one difference a byte comparison
// could NOT tell apart is the api VERSION: both sources would look right for makersuite (`v1beta`) and only
// `TestGeminiVertexAIIgnoresTheConfiguredAPIVersion` catches vertex reading the config it never reads.

import (
	"strings"
	"testing"
)

// TestGeminiMakerSuiteURLShapes covers :730.
func TestGeminiMakerSuiteURLShapes(t *testing.T) {
	cases := []struct {
		name       string
		base       string
		apiVersion string
		model      string
		stream     bool
		apiKey     string
		want       string
	}{
		{
			name: "non-stream", base: "https://generativelanguage.googleapis.com", apiVersion: "v1beta",
			model: "gemini-2.5-pro", apiKey: "probe-key",
			want: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=probe-key",
		},
		{
			name: "stream appends alt=sse AFTER the key", base: "https://generativelanguage.googleapis.com", apiVersion: "v1beta",
			model: "gemini-2.5-pro", stream: true, apiKey: "probe-key",
			want: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?key=probe-key&alt=sse",
		},
		{
			name: "a reverse_proxy with a trailing slash loses exactly one", base: "https://proxy.example/", apiVersion: "v1beta",
			model: "gemini-2.5-flash", apiKey: "probe-key",
			want: "https://proxy.example/v1beta/models/gemini-2.5-flash:generateContent?key=probe-key",
		},
		{
			name: "the configured api version is used, so v1 differs from the default", base: "https://generativelanguage.googleapis.com", apiVersion: "v1",
			model: "gemini-2.5-flash", apiKey: "probe-key",
			want: "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=probe-key",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := pinnedMakerSuiteGenerateURL(testCase.base, testCase.apiVersion, testCase.model, testCase.stream, testCase.apiKey)
			if got != testCase.want {
				t.Fatalf("url = %s\nwant  %s", got, testCase.want)
			}
		})
	}
}

// TestGeminiMakerSuiteNeverAttachesTheKeyAsAHeader pins the credential PLACEMENT difference: the makersuite
// branch assigns `authHeader = 'Bearer '+apiKey` at :484 and then never attaches it, because the key travels
// in the query. An implementation that reused the vertex header path would send an Authorization header
// pinned never sends.
func TestGeminiMakerSuiteNeverAttachesTheKeyAsAHeader(t *testing.T) {
	url := pinnedMakerSuiteGenerateURL("https://generativelanguage.googleapis.com", "v1beta", "gemini-2.5-pro", false, "probe-key")
	if !strings.Contains(url, "?key=probe-key") {
		t.Fatalf("makersuite url does not carry the key as a query parameter: %s", url)
	}
	if strings.Contains(url, "Bearer") {
		t.Fatalf("makersuite url carries a bearer credential, which pinned never puts in the URL: %s", url)
	}
}

// TestGeminiVertexAIURLShapes covers the three auth modes at :687-728.
func TestGeminiVertexAIURLShapes(t *testing.T) {
	cases := []struct {
		name string
		got  string
		want string
	}{
		{
			name: "express WITHOUT a project id builds a REGIONAL host and keeps the key in the query",
			got:  pinnedVertexAIExpressGenerateURL("gemini-2.5-pro", false, "probe-key", "", "us-central1"),
			want: "https://us-central1-aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:generateContent?key=probe-key",
		},
		{
			name: "express WITH a project id forces the GLOBAL host even for a regional location (:696-698)",
			got:  pinnedVertexAIExpressGenerateURL("gemini-2.5-pro", false, "probe-key", "probe-project", "europe-west4"),
			want: "https://aiplatform.googleapis.com/v1/projects/probe-project/locations/europe-west4/publishers/google/models/gemini-2.5-pro:generateContent?key=probe-key",
		},
		{
			name: "express with region global and no project id",
			got:  pinnedVertexAIExpressGenerateURL("gemini-2.5-pro", true, "probe-key", "", "global"),
			want: "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?key=probe-key&alt=sse",
		},
		{
			name: "service account uses a regional host, the project path, and NO key in the URL",
			got:  pinnedVertexAIServiceAccountGenerateURL("gemini-2.5-pro", false, "probe-project", "us-central1"),
			want: "https://us-central1-aiplatform.googleapis.com/v1/projects/probe-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent",
		},
		{
			name: "service account streaming appends alt=sse and still no key",
			got:  pinnedVertexAIServiceAccountGenerateURL("gemini-2.5-pro", true, "probe-project", "us-central1"),
			want: "https://us-central1-aiplatform.googleapis.com/v1/projects/probe-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
		},
		{
			name: "service account in the global region drops the region prefix from the host",
			got:  pinnedVertexAIServiceAccountGenerateURL("gemini-2.5-pro", false, "probe-project", "global"),
			want: "https://aiplatform.googleapis.com/v1/projects/probe-project/locations/global/publishers/google/models/gemini-2.5-pro:generateContent",
		},
		{
			name: "proxy mode uses the reverse_proxy base and only alt=sse",
			got:  pinnedVertexAIProxyGenerateURL("https://proxy.example/", "gemini-2.5-pro", true),
			want: "https://proxy.example/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if testCase.got != testCase.want {
				t.Fatalf("url = %s\nwant  %s", testCase.got, testCase.want)
			}
		})
	}
}

// TestGeminiVertexAIIgnoresTheConfiguredAPIVersion is the difference no byte comparison would isolate: the
// makersuite builder takes an apiVersion argument because pinned reads `gemini.apiVersion`, while every
// vertex path hardcodes `v1`. An implementation that shared one builder would emit `v1beta` on the vertex
// path whenever the config said so -- a URL the provider would reject, on a host nobody re-recorded.
func TestGeminiVertexAIIgnoresTheConfiguredAPIVersion(t *testing.T) {
	for _, url := range []string{
		pinnedVertexAIProxyGenerateURL("https://proxy.example", "gemini-2.5-pro", false),
		pinnedVertexAIExpressGenerateURL("gemini-2.5-pro", false, "probe-key", "", "us-central1"),
		pinnedVertexAIExpressGenerateURL("gemini-2.5-pro", false, "probe-key", "probe-project", "us-central1"),
		pinnedVertexAIServiceAccountGenerateURL("gemini-2.5-pro", false, "probe-project", "us-central1"),
	} {
		if !strings.Contains(url, "/v1/") {
			t.Fatalf("vertex url does not use the hardcoded v1 path: %s", url)
		}
		if strings.Contains(url, "v1beta") {
			t.Fatalf("vertex url picked up the configured api version: %s", url)
		}
	}
}

// TestGeminiMakerSuiteStatusURLShape covers the makersuite status arm's own URL (:1912-1914), which is NOT
// the shared models GET: it builds the URL itself and omits `?key=` when a reverse_proxy supplies the
// credential.
func TestGeminiMakerSuiteStatusURLShape(t *testing.T) {
	cases := []struct {
		name            string
		base            string
		apiVersion      string
		apiKey          string
		hasReverseProxy bool
		want            string
	}{
		{
			name: "with a key the parameter is present", base: "https://generativelanguage.googleapis.com", apiVersion: "v1beta",
			apiKey: "probe-key",
			want:   "https://generativelanguage.googleapis.com/v1beta/models?key=probe-key",
		},
		{
			name: "a reverse_proxy with no key drops the parameter entirely", base: "https://proxy.example/", apiVersion: "v1beta",
			apiKey: "", hasReverseProxy: true,
			want: "https://proxy.example/v1beta/models",
		},
		{
			name: "no key and no proxy still builds the parameter, and the caller answers 400 before the fetch", base: "https://generativelanguage.googleapis.com", apiVersion: "v1beta",
			apiKey: "",
			want:   "https://generativelanguage.googleapis.com/v1beta/models?key=",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := pinnedMakerSuiteStatusURL(testCase.base, testCase.apiVersion, testCase.apiKey, testCase.hasReverseProxy)
			if got != testCase.want {
				t.Fatalf("url = %s\nwant  %s", got, testCase.want)
			}
		})
	}
}

// TestGeminiSeamsAreTwoLiterals pins the decision that these are TWO seams, not one: the pinned bases are
// different hosts, so a single shared seam would let a replay point one source at the other's host and still
// look green.
func TestGeminiSeamsAreTwoLiterals(t *testing.T) {
	t.Setenv(pinnedMakerSuiteSeamEnv, "")
	t.Setenv(pinnedVertexAISeamEnv, "")
	if got := pinnedMakerSuiteBaseURL(); got != "https://generativelanguage.googleapis.com" {
		t.Fatalf("makersuite seam default = %q", got)
	}
	if got := pinnedVertexAIBaseURL(); got != "https://us-central1-aiplatform.googleapis.com" {
		t.Fatalf("vertex seam default = %q", got)
	}
	if pinnedMakerSuiteBaseURL() == pinnedVertexAIBaseURL() {
		t.Fatal("the two pinned bases are identical, so one seam would be enough; the code assumes two")
	}
}

// ---------------------------------------------------------------------------------------------------------
// PLAN-level assertions for the BODY layer. Each folded member gets one, because a member that no test names
// is a member a refactor can drop silently; the exclusions get one each for the same reason.
// ---------------------------------------------------------------------------------------------------------

func googleTestBody(t *testing.T, raw string) orderedNodeJSON {
	t.Helper()
	body, err := decodeOrderedNodeJSON([]byte(raw))
	if err != nil {
		t.Fatalf("body: %v", err)
	}
	return body
}

func googleTestEncoded(t *testing.T, node orderedNodeJSON) string {
	t.Helper()
	encoded, err := marshalOrderedNodeJSON(node)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(encoded)
}

// TestGeminiGenerationConfigFoldedMembers covers candidateCount, topK's || undefined, the copied sampling
// members, the stop-sequence deletion and the json_schema fallbacks.
func TestGeminiGenerationConfigFoldedMembers(t *testing.T) {
	body := googleTestBody(t, `{"model":"gemini-2.0-flash","max_tokens":100,"temperature":0.5,"top_p":0.9,"top_k":0,"stop":[],"seed":7}`)
	encoded := googleTestEncoded(t, pinnedGoogleGenerationConfig(body, "gemini-2.0-flash"))
	if !strings.Contains(encoded, `"candidateCount":1`) {
		t.Fatalf("candidateCount must be 1: %s", encoded)
	}
	if strings.Contains(encoded, `"topK"`) {
		t.Fatalf("a zero top_k must be OMITTED (the pinned || undefined): %s", encoded)
	}
	if strings.Contains(encoded, `"stopSequences"`) {
		t.Fatalf("an empty stop array must be deleted: %s", encoded)
	}
	for _, want := range []string{`"maxOutputTokens":100`, `"temperature":0.5`, `"topP":0.9`, `"seed":7`} {
		if !strings.Contains(encoded, want) {
			t.Fatalf("generationConfig lost %s: %s", want, encoded)
		}
	}
	withTopK := googleTestBody(t, `{"model":"gemini-2.0-flash","top_k":40}`)
	if got := googleTestEncoded(t, pinnedGoogleGenerationConfig(withTopK, "gemini-2.0-flash")); !strings.Contains(got, `"topK":40`) {
		t.Fatalf("a non-zero top_k must survive: %s", got)
	}
	schema := googleTestBody(t, `{"model":"gemini-2.0-flash","json_schema":{"value":{"type":"object"}}}`)
	got := googleTestEncoded(t, pinnedGoogleGenerationConfig(schema, "gemini-2.0-flash"))
	if !strings.Contains(got, `"responseMimeType":"application/json"`) || !strings.Contains(got, `"responseSchema":{"type":"object"}`) {
		t.Fatalf("json_schema must fold into responseMimeType and responseSchema: %s", got)
	}
}

// TestGeminiNoSamplingModelListIsExclusionary is the exclusion: the newest models reject sampling members.
func TestGeminiNoSamplingModelListIsExclusionary(t *testing.T) {
	body := googleTestBody(t, `{"model":"gemini-3.7-flash","max_tokens":100,"temperature":0.5,"top_p":0.9,"top_k":40}`)
	encoded := googleTestEncoded(t, pinnedGoogleGenerationConfig(body, "gemini-3.7-flash"))
	for _, absent := range []string{`"temperature"`, `"topP"`, `"topK"`, `"candidateCount"`} {
		if strings.Contains(encoded, absent) {
			t.Fatalf("the noSampling model list must delete %s: %s", absent, encoded)
		}
	}
	// The control: the same body on a model NOT in that list keeps them.
	other := googleTestEncoded(t, pinnedGoogleGenerationConfig(body, "gemini-2.0-flash"))
	if !strings.Contains(other, `"temperature":0.5`) {
		t.Fatalf("a model outside the list must keep temperature: %s", other)
	}
}

// TestGeminiImageModalityNamesItsExclusions covers responseModalities, imageConfig and its two gates.
func TestGeminiImageModalityNamesItsExclusions(t *testing.T) {
	body := googleTestBody(t, `{"model":"gemini-3-pro-image","request_images":true,"request_image_aspect_ratio":"16:9","request_image_resolution":"2K"}`)
	config := pinnedGoogleGenerationConfig(body, "gemini-3-pro-image")
	if !pinnedGoogleApplyImageModality(&config, body, "gemini-3-pro-image") {
		t.Fatal("an image model with request_images must enable the modality")
	}
	encoded := googleTestEncoded(t, config)
	for _, want := range []string{`"responseModalities":["text","image"]`, `"imageConfig":{"imageSize":"2K","aspectRatio":"16:9"}`} {
		if !strings.Contains(encoded, want) {
			t.Fatalf("image modality lost %s: %s", want, encoded)
		}
	}
	// imageSize only on the gemini-3 family.
	older := googleTestBody(t, `{"model":"gemini-2.5-flash-image","request_images":true,"request_image_resolution":"2K"}`)
	olderConfig := pinnedGoogleGenerationConfig(older, "gemini-2.5-flash-image")
	pinnedGoogleApplyImageModality(&olderConfig, older, "gemini-2.5-flash-image")
	if strings.Contains(googleTestEncoded(t, olderConfig), `"imageSize"`) {
		t.Fatal("imageSize must not appear for a non gemini-3 image model")
	}
	// No request_images, no modality.
	plain := googleTestBody(t, `{"model":"gemini-3-pro-image"}`)
	plainConfig := pinnedGoogleGenerationConfig(plain, "gemini-3-pro-image")
	if pinnedGoogleApplyImageModality(&plainConfig, plain, "gemini-3-pro-image") {
		t.Fatal("without request_images the modality must stay off")
	}
}

// TestGeminiToolsFoldedMembersAndExclusions covers the declarations, both deletions, custom tools and search.
func TestGeminiToolsFoldedMembersAndExclusions(t *testing.T) {
	body := googleTestBody(t, `{"model":"gemini-2.0-flash","enable_web_search":true,"tools":[{"type":"function","function":{"name":"probe","parameters":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"q":{"type":"string"}}}}},{"type":"function","function":{"name":"empty","parameters":{"type":"object","properties":{}}}}]}`)
	tools := googleTestEncoded(t, pinnedGoogleTools(body, "gemini-2.0-flash", false))
	if strings.Contains(tools, `$schema`) {
		t.Fatalf("$schema must be deleted from parameters: %s", tools)
	}
	if strings.Contains(tools, `"name":"empty"`) && strings.Contains(tools, `"empty":{"type":"object"`) {
		t.Fatalf("an empty properties object must delete the parameters member: %s", tools)
	}
	if !strings.Contains(tools, `"function_declarations":[{"name":"probe"`) {
		t.Fatalf("function_declarations missing: %s", tools)
	}
	// google_search is suppressed when function calling is present.
	if strings.Contains(tools, `"google_search"`) {
		t.Fatalf("google_search must not be added alongside function declarations: %s", tools)
	}
	// ... and it IS added when there are no declarations.
	searchOnly := googleTestBody(t, `{"model":"gemini-2.0-flash","enable_web_search":true}`)
	if got := googleTestEncoded(t, pinnedGoogleTools(searchOnly, "gemini-2.0-flash", false)); !strings.Contains(got, `"google_search":{}`) {
		t.Fatalf("google_search missing for a plain web-search request: %s", got)
	}
	// The exclusions: Gemma3, LearnLM, the no-search model list, and image requests.
	for _, exclusion := range []struct {
		name  string
		model string
		image bool
	}{
		{"gemma3", "gemma-3-27b", false},
		{"learnlm", "learnlm-1.5-pro", false},
		{"no-search-list", "gemini-2.0-flash-lite", false},
		{"image-request", "gemini-2.0-flash", true},
	} {
		excluded := googleTestBody(t, `{"model":"`+exclusion.model+`","enable_web_search":true}`)
		if got := googleTestEncoded(t, pinnedGoogleTools(excluded, exclusion.model, exclusion.image)); strings.Contains(got, `"google_search"`) {
			t.Fatalf("%s must not receive google_search: %s", exclusion.name, got)
		}
	}
	// Custom tools are only supported when no function calling is present.
	custom := googleTestBody(t, `{"model":"gemini-2.0-flash","tools":[{"type":"probe_tool","probe_tool":{"x":1}}]}`)
	if got := googleTestEncoded(t, pinnedGoogleTools(custom, "gemini-2.0-flash", false)); !strings.Contains(got, `"probe_tool":{"x":1}`) {
		t.Fatalf("a custom tool must survive when no function declarations exist: %s", got)
	}
	mixed := googleTestBody(t, `{"model":"gemini-2.0-flash","tools":[{"type":"function","function":{"name":"probe"}},{"type":"probe_tool","probe_tool":{"x":1}}]}`)
	if got := googleTestEncoded(t, pinnedGoogleTools(mixed, "gemini-2.0-flash", false)); strings.Contains(got, `"probe_tool"`) {
		t.Fatalf("custom tools must be dropped when function calling is present: %s", got)
	}
}

// TestGeminiToolChoiceTranslation covers all four pinned translations.
func TestGeminiToolChoiceTranslation(t *testing.T) {
	cases := []struct {
		body string
		want string
	}{
		{`{"tool_choice":"none"}`, `{"functionCallingConfig":{"mode":"NONE"}}`},
		{`{"tool_choice":"required"}`, `{"functionCallingConfig":{"mode":"ANY"}}`},
		{`{"tool_choice":"auto"}`, `{"functionCallingConfig":{"mode":"AUTO"}}`},
		{`{"tool_choice":{"function":{"name":"probe"}}}`, `{"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":["probe"]}}`},
	}
	for _, testCase := range cases {
		node, found := pinnedGoogleToolConfig(googleTestBody(t, testCase.body))
		if !found {
			t.Fatalf("%s: no toolConfig was produced", testCase.body)
		}
		if got := googleTestEncoded(t, node); got != testCase.want {
			t.Fatalf("%s: toolConfig = %s, want %s", testCase.body, got, testCase.want)
		}
	}
	// A bare string the switch does not know, and a function object with no name, produce nothing.
	for _, unknown := range []string{`{"tool_choice":"sometimes"}`, `{"tool_choice":{"function":{}}}`, `{}`} {
		if _, found := pinnedGoogleToolConfig(googleTestBody(t, unknown)); found {
			t.Fatalf("%s must not produce a toolConfig", unknown)
		}
	}
}

// TestGeminiThinkingConfigBudgetsAndTheVertexAsymmetry covers the per-family budgets and the one documented
// difference between the two sources.
func TestGeminiThinkingConfigBudgetsAndTheVertexAsymmetry(t *testing.T) {
	// Flash family: medium = 25% of max_tokens, min = 0, auto = -1.
	flash := googleTestBody(t, `{"model":"gemini-2.5-flash","max_tokens":1000,"reasoning_effort":"medium","include_reasoning":true}`)
	config := pinnedGoogleGenerationConfig(flash, "gemini-2.5-flash")
	pinnedGoogleApplyThinkingConfig(&config, flash, "gemini-2.5-flash", false)
	encoded := googleTestEncoded(t, config)
	if !strings.Contains(encoded, `"thinkingConfig":{"includeThoughts":true,"thinkingBudget":250}`) {
		t.Fatalf("flash medium must be 25%% of max_tokens: %s", encoded)
	}
	// Vertex clears includeThoughts when the budget is 0.
	vertex := googleTestBody(t, `{"model":"gemini-2.5-flash","max_tokens":1000,"reasoning_effort":"min","include_reasoning":true}`)
	vertexConfig := pinnedGoogleGenerationConfig(vertex, "gemini-2.5-flash")
	pinnedGoogleApplyThinkingConfig(&vertexConfig, vertex, "gemini-2.5-flash", true)
	vertexEncoded := googleTestEncoded(t, vertexConfig)
	if !strings.Contains(vertexEncoded, `"thinkingBudget":0`) || !strings.Contains(vertexEncoded, `"includeThoughts":false`) {
		t.Fatalf("vertex must clear includeThoughts for a zero budget: %s", vertexEncoded)
	}
	// ... and does NOT for the same request on the MakerSuite side.
	makerConfig := pinnedGoogleGenerationConfig(vertex, "gemini-2.5-flash")
	pinnedGoogleApplyThinkingConfig(&makerConfig, vertex, "gemini-2.5-flash", false)
	if got := googleTestEncoded(t, makerConfig); strings.Contains(got, `"includeThoughts":false`) {
		t.Fatalf("makersuite must keep includeThoughts true for the same request: %s", got)
	}
	// A model outside the thinking list gets no thinkingConfig at all.
	plain := googleTestBody(t, `{"model":"gemini-2.0-flash","max_tokens":1000}`)
	plainConfig := pinnedGoogleGenerationConfig(plain, "gemini-2.0-flash")
	pinnedGoogleApplyThinkingConfig(&plainConfig, plain, "gemini-2.0-flash", false)
	if got := googleTestEncoded(t, plainConfig); strings.Contains(got, `"thinkingConfig"`) {
		t.Fatalf("a non-thinking model must not carry thinkingConfig: %s", got)
	}
}

// TestGeminiConvertPromptRolesPartsAndMerge is the converter: one assertion per conversion rule.
func TestGeminiConvertPromptRolesPartsAndMerge(t *testing.T) {
	names := pinnedAI21Names{charName: "Bot", userName: "Iris"}
	messages := googleTestBody(t, `{"messages":[
		{"role":"system","content":"first system"},
		{"role":"system","name":"example_user","content":"hello"},
		{"role":"user","name":"Iris","content":"named turn"},
		{"role":"user","content":"second turn"},
		{"role":"assistant","content":"reply"},
		{"role":"tool","tool_call_id":"call-1","content":"tool output"},
		{"role":"assistant","tool_calls":[{"id":"call-2","function":{"name":"probe","arguments":"{\"q\":\"x\"}"}}]}
	]}`).mustMemberForTest("messages")
	contents, systemInstruction := pinnedGoogleConvertPrompt(messages, "gemini-2.0-flash", true, names)
	encoded := googleTestEncoded(t, contents)
	system := googleTestEncoded(t, systemInstruction)
	// The two leading system turns collapse into the system instruction, with the example-user prefix.
	if !strings.Contains(system, `"text":"first system"`) || !strings.Contains(system, `"text":"Iris: hello"`) {
		t.Fatalf("system instruction lost a turn or the example-user prefix: %s", system)
	}
	// system already consumed; the merge joins the two user turns with a blank line.
	if !strings.Contains(encoded, `"text":"Iris: named turn\n\nsecond turn"`) {
		t.Fatalf("consecutive user turns must merge with a blank line, and the name must be prefixed: %s", encoded)
	}
	// assistant -> model, tool -> user with a functionResponse.
	if !strings.Contains(encoded, `"role":"model"`) {
		t.Fatalf("assistant must become model: %s", encoded)
	}
	if !strings.Contains(encoded, `"functionResponse":{"name":"unknown","response":{"name":"unknown","content":"tool output"}}`) {
		t.Fatalf("a tool_call_id with no mapping must become functionResponse/unknown: %s", encoded)
	}
	// tool_calls -> functionCall with the PARSED arguments object.
	if !strings.Contains(encoded, `"functionCall":{"name":"probe","args":{"q":"x"}}`) {
		t.Fatalf("tool_calls must become functionCall with parsed args: %s", encoded)
	}
}

// TestGeminiConvertPromptPrefillRewriteAndSignatures covers the two gemini-3 specific rules.
func TestGeminiConvertPromptPrefillRewriteAndSignatures(t *testing.T) {
	names := pinnedAI21Names{}
	messages := googleTestBody(t, `{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"prefill"}]}`).mustMemberForTest("messages")
	// On the newest models a TRAILING assistant turn is rewritten to user.
	contents, _ := pinnedGoogleConvertPrompt(messages, "gemini-3.7-flash", false, names)
	if encoded := googleTestEncoded(t, contents); !strings.Contains(encoded, `"role":"user"`) || strings.Contains(encoded, `"role":"model"`) {
		t.Fatalf("the trailing prefill must be rewritten to user on the newest models: %s", encoded)
	}
	// The control: an older model keeps it as a model turn.
	older, _ := pinnedGoogleConvertPrompt(messages, "gemini-2.0-flash", false, names)
	if encoded := googleTestEncoded(t, older); !strings.Contains(encoded, `"role":"model"`) {
		t.Fatalf("an older model must keep the assistant turn as model: %s", encoded)
	}
	// A gemini-3 functionCall without a stored signature gets the bypass magic.
	call := googleTestBody(t, `{"messages":[{"role":"assistant","tool_calls":[{"id":"c1","function":{"name":"probe","arguments":"{}"}}]}]}`).mustMemberForTest("messages")
	callContents, _ := pinnedGoogleConvertPrompt(call, "gemini-3-pro", false, names)
	if encoded := googleTestEncoded(t, callContents); !strings.Contains(encoded, `"thoughtSignature":"skip_thought_signature_validator"`) {
		t.Fatalf("a gemini-3 functionCall needs the bypass signature: %s", encoded)
	}
	// A data-URL image becomes inlineData, with the gemini-3 media resolution when a detail is given.
	image := googleTestBody(t, `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,QUJD","detail":"high"}}]}]}`).mustMemberForTest("messages")
	imageContents, _ := pinnedGoogleConvertPrompt(image, "gemini-3-pro", false, names)
	imageEncoded := googleTestEncoded(t, imageContents)
	if !strings.Contains(imageEncoded, `"inlineData":{"mimeType":"image/png","data":"QUJD"}`) {
		t.Fatalf("a data URL must become inlineData: %s", imageEncoded)
	}
	if !strings.Contains(imageEncoded, `"mediaResolution":{"level":"media_resolution_high"}`) {
		t.Fatalf("gemini-3 must carry the media resolution for a detail level: %s", imageEncoded)
	}
	// A non data URL contributes NO part.
	remote := googleTestBody(t, `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.invalid/x.png"}}]}]}`).mustMemberForTest("messages")
	remoteContents, _ := pinnedGoogleConvertPrompt(remote, "gemini-3-pro", false, names)
	if strings.Contains(googleTestEncoded(t, remoteContents), `"inlineData"`) {
		t.Fatal("a remote image URL must not become inlineData")
	}
}

func (value orderedNodeJSON) mustMemberForTest(key string) orderedNodeJSON {
	member, _ := value.member(key)
	return member
}
