package server

// The AZURE_OPENAI properties the generic provider-wire replay cannot state, plus the branches that
// harness cannot capture.
//
// WHAT IS A RECORDING AND WHAT IS A DERIVATION. The scenarios under tests/provider-wire/scenarios are the
// oracle for the folded members: their `rawTarget` and `bodySha256` are what the PINNED server sent. The
// default seam value, the pre-fetch 400s and the /status {data:[]} fold are DERIVATIONS (AGENTS.md rule 4):
// they answer BEFORE a provider call, and the provider-wire probe REFUSES a scenario that records no
// provider request ("capture records no provider request at all"), so no capture can exist for them. Each
// derivation cites the pinned lines it comes from and asserts the observable half it can: no request built,
// and -- where a live peer is possible -- a measured zero.
//
// THE SEAM. AZURE_OPENAI has no provider literal (chat-completions.js:1689 reads azure_base_url from the
// request body), so GOTAVERN_AZURE_OPENAI_CHAT_URL's default is the pinned FRONTEND default for that member,
// the empty string (public/scripts/openai.js:470). The scenarios therefore carry the recording peer in the
// body and do not declare a goSeam, so the fixture records no literal for this source. The default is
// asserted here as a labelled derivation, and the mirrored half -- that the recorded captures carry the
// pinned PATH and QUERY, which is what the pinned URL expression actually decides -- is asserted from the
// fixture.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

type azureWireFixture struct {
	Scenarios map[string]struct {
		TargetPath     string `json:"targetPath"`
		APIKeyVerified bool   `json:"apiKeyVerified"`
		HeaderCoverage struct {
			ComparedExactly []string `json:"comparedExactly"`
			Normalized      []string `json:"normalized"`
			Excluded        []string `json:"excluded"`
		} `json:"headerCoverage"`
		Provider struct {
			Requests []struct {
				Method     string `json:"method"`
				RawTarget  string `json:"rawTarget"`
				BodyText   string `json:"bodyText"`
				BodyLength int    `json:"bodyLength"`
				BodySHA256 string `json:"bodySha256"`
			} `json:"requests"`
		} `json:"provider"`
	} `json:"scenarios"`
}

func loadAzureWireFixture(t *testing.T) azureWireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture azureWireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func azureScenarioNames() []string {
	return []string{
		"azure-openai-nonstream",
		"azure-openai-stream",
		"azure-openai-json-schema",
		"azure-openai-logprobs",
		"azure-openai-reasoning-effort",
		"azure-openai-reasoning-fixed",
		"azure-openai-error-status",
		"azure-openai-error-status-nonjson",
		"azure-openai-deployment-escaping",
		"azure-openai-status-ok",
		"azure-openai-status-nonok",
	}
}

// TestChatCompletionAzureOpenAICoversItsBranches refuses to run a suite that cannot discriminate: every
// scenario this lane adds must be present in the recorded fixture, must target this source, and must carry
// at least one provider request.
func TestChatCompletionAzureOpenAICoversItsBranches(t *testing.T) {
	fixture := loadAzureWireFixture(t)
	for _, name := range azureScenarioNames() {
		scenario, present := fixture.Scenarios[name]
		if !present {
			t.Fatalf("the provider-wire fixture has no capture for %q yet. That is EXPECTED while this lane is unmerged: this lane deliberately adds scenarios WITHOUT recording fixtures, and the Linux oracle job records them and publishes a patch. Do not paper over it by deleting the scenario.", name)
		}
		if scenario.TargetPath != chatCompletionSourceAzure {
			t.Fatalf("%s: targetPath = %q, want %q", name, scenario.TargetPath, chatCompletionSourceAzure)
		}
		if len(scenario.Provider.Requests) == 0 {
			t.Fatalf("%s: the capture records no provider request, so it proves nothing", name)
		}
		if !scenario.APIKeyVerified {
			t.Fatalf("%s: the capture does not record apiKeyVerified, so the api-key credential was never checked", name)
		}
	}
}

// TestChatCompletionAzureOpenAICredentialShape asserts, on the CAPTURES, the header fact this whole source
// turns on: the credential is `api-key` and there is NO Authorization header, because the pinned config sets
// only Content-Type and api-key (:1741-1744). A Go implementation that reused the shared header builder
// would send `Authorization: Bearer <key>` and fail here.
func TestChatCompletionAzureOpenAICredentialShape(t *testing.T) {
	fixture := loadAzureWireFixture(t)
	checked := 0
	for _, name := range azureScenarioNames() {
		scenario, present := fixture.Scenarios[name]
		if !present {
			continue
		}
		compared := make(map[string]bool, len(scenario.HeaderCoverage.ComparedExactly))
		for _, header := range scenario.HeaderCoverage.ComparedExactly {
			compared[strings.ToLower(header)] = true
		}
		if !compared["api-key"] {
			t.Fatalf("%s: api-key is not in the exactly-compared header set (%v), so the credential value is not part of the comparison", name, scenario.HeaderCoverage.ComparedExactly)
		}
		for _, bucket := range [][]string{scenario.HeaderCoverage.ComparedExactly, scenario.HeaderCoverage.Normalized, scenario.HeaderCoverage.Excluded} {
			for _, header := range bucket {
				if strings.EqualFold(header, "authorization") {
					t.Fatalf("%s: the capture carries an authorization header; AZURE_OPENAI authenticates with api-key and must never send a Bearer token", name)
				}
			}
		}
		checked++
	}
	if checked == 0 {
		t.Fatal("no azure_openai scenario is recorded yet, so this assertion could not run")
	}
}

// TestChatCompletionAzureOpenAIPlanMatchesTheRecordedTargetAndBodyDigests drives the PLAN from each recorded
// GENERATE scenario's own request body and requires the built bytes and target to be the ones the pinned
// server sent. Nothing is transcribed: the scenario file is the input and the fixture is the expectation.
func TestChatCompletionAzureOpenAIPlanMatchesTheRecordedTargetAndBodyDigests(t *testing.T) {
	fixture := loadAzureWireFixture(t)
	directories := azureTestDirectories(t, "synthetic-azure-key")
	t.Setenv(pinnedAzureOpenAISeamEnv, "")
	checked := 0
	for _, name := range azureScenarioNames() {
		scenario, present := fixture.Scenarios[name]
		if !present {
			continue
		}
		rawScenario, err := os.ReadFile(filepath.Join("..", "..", "tests", "provider-wire", "scenarios", name+".json"))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		ordered, err := decodeOrderedNodeJSON(rawScenario)
		if err != nil {
			t.Fatalf("%s: decode scenario: %v", name, err)
		}
		routeNode, _ := sdMemberOf(sdBodyMember(ordered, "request"), "path")
		if route, isString := routeNode.stringValue(); isString && !strings.HasSuffix(route, "/generate") {
			continue
		}
		body := azureScenarioPlanBody(t, nodeGet(ordered, "request", "body"))
		plan, failure := pinnedChatCompletionPlan(body, directories, "")
		if failure != nil {
			t.Fatalf("%s: the plan refused a recorded scenario: %+v", name, failure)
		}
		if len(scenario.Provider.Requests) == 0 {
			t.Fatalf("%s: the capture records no provider request, so there is nothing to compare the plan with", name)
		}
		want := scenario.Provider.Requests[0]
		digest := sha256.Sum256(plan.Body)
		if len(plan.Body) != want.BodyLength || hex.EncodeToString(digest[:]) != want.BodySHA256 {
			t.Fatalf("%s: the plan built %d bytes sha %s, the pinned server sent %d bytes sha %s\nbuilt: %s\nrecorded: %s",
				name, len(plan.Body), hex.EncodeToString(digest[:]), want.BodyLength, want.BodySHA256, plan.Body, want.BodyText)
		}
		parsed, parseErr := url.Parse(plan.URL)
		if parseErr != nil {
			t.Fatalf("%s: %v", name, parseErr)
		}
		if got := parsed.RequestURI(); got != want.RawTarget {
			t.Fatalf("%s: the plan targets %q, the pinned server targeted %q", name, got, want.RawTarget)
		}
		checked++
	}
	if checked == 0 {
		t.Fatal("no azure_openai GENERATE scenario is recorded yet, so the plan was never compared with a capture")
	}
}

// azureScenarioPlanBody substitutes the harness placeholder the probe substitutes, with a fixed origin: the
// plan is built offline, so any absolute origin will do and only the path and digests are compared.
func azureScenarioPlanBody(t *testing.T, raw orderedNodeJSON) orderedNodeJSON {
	t.Helper()
	substituted := nodeObject()
	for _, entry := range raw.object {
		if text, isString := entry.value.stringValue(); isString {
			substituted.setMember(entry.key, nodeString(strings.ReplaceAll(text, "<mock>", "http://127.0.0.1:9")))
			continue
		}
		substituted.setMember(entry.key, entry.value)
	}
	return substituted
}

// TestChatCompletionAzureOpenAISeamDefault pins the seam: the default is the pinned FRONTEND default for
// `azure_base_url` (the empty string, public/scripts/openai.js:470) -- a DERIVATION, because there is no
// provider literal to record -- and the seam overrides the resolved base when it is set, so a test can aim
// this source at a peer without touching the request body.
func TestChatCompletionAzureOpenAISeamDefault(t *testing.T) {
	if pinnedAzureOpenAIBaseURLDefault != "" {
		t.Fatalf("the seam default is %q; the pinned frontend default for azure_base_url is the EMPTY STRING (public/scripts/openai.js:470)", pinnedAzureOpenAIBaseURLDefault)
	}
	directories := azureTestDirectories(t, "synthetic-azure-key")
	const rawBody = `{"chat_completion_source":"azure_openai","azure_base_url":"https://probe.invalid/v1/","azure_deployment_name":"probe-deployment","azure_api_version":"2024-02-15-preview","messages":[{"role":"user","content":"x"}],"stream":false}`

	t.Setenv(pinnedAzureOpenAISeamEnv, "")
	fromBody := azurePlanForTest(t, directories, rawBody)
	if !strings.HasPrefix(fromBody.URL, "https://probe.invalid/openai/deployments/probe-deployment/chat/completions?api-version=2024-02-15-preview") {
		t.Fatalf("with the seam unset the request's own azure_base_url must be used, and its /v1/ path discarded by the leading-slash resolution: %q", fromBody.URL)
	}

	t.Setenv(pinnedAzureOpenAISeamEnv, "http://127.0.0.1:9")
	fromSeam := azurePlanForTest(t, directories, rawBody)
	if !strings.HasPrefix(fromSeam.URL, "http://127.0.0.1:9/openai/deployments/probe-deployment/chat/completions?api-version=2024-02-15-preview") {
		t.Fatalf("the seam is not honoured: %q", fromSeam.URL)
	}
}

// TestChatCompletionAzureOpenAIIncompleteConfigIsPinned400 is a LABELLED DERIVATION from :1691-1697: the
// pinned guard is `!azure_base_url || !azure_deployment_name || !azure_api_version || !apiKey`, answered with
// the LONG message at 400 -- not the shared `{error:true}` -- and before any request exists. No recording can
// exist because the provider is never contacted. The zero-outbound half is structural here: a nil plan makes
// serveChatCompletionGenerate return before outbound.SendStreaming.
func TestChatCompletionAzureOpenAIIncompleteConfigIsPinned400(t *testing.T) {
	directories := azureTestDirectories(t, "synthetic-azure-key")
	t.Setenv(pinnedAzureOpenAISeamEnv, "")
	cases := []struct {
		name    string
		rawBody string
	}{
		{"no base url", `{"chat_completion_source":"azure_openai","azure_deployment_name":"dep","azure_api_version":"v","messages":[]}`},
		{"empty base url", `{"chat_completion_source":"azure_openai","azure_base_url":"","azure_deployment_name":"dep","azure_api_version":"v","messages":[]}`},
		{"no deployment", `{"chat_completion_source":"azure_openai","azure_base_url":"https://probe.invalid","azure_api_version":"v","messages":[]}`},
		{"no api version", `{"chat_completion_source":"azure_openai","azure_base_url":"https://probe.invalid","azure_deployment_name":"dep","messages":[]}`},
	}
	for _, testCase := range cases {
		body, err := decodeOrderedNodeJSON([]byte(testCase.rawBody))
		if err != nil {
			t.Fatal(err)
		}
		request, failure := pinnedChatCompletionPlan(body, directories, "")
		if failure == nil {
			t.Fatalf("%s: the plan built a request (%q); pinned answers 400 before any call", testCase.name, request.URL)
		}
		if failure.status != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", testCase.name, failure.status)
		}
		if failure.payload == nil {
			t.Fatalf("%s: a nil payload answers a plain-text status; pinned sends a JSON body", testCase.name)
		}
		encoded, err := marshalOrderedNodeJSON(*failure.payload)
		if err != nil {
			t.Fatal(err)
		}
		want := `{"error":{"message":"` + pinnedAzureOpenAIIncompleteMessage + `"}}`
		if string(encoded) != want {
			t.Fatalf("%s: body = %s, want %s", testCase.name, encoded, want)
		}
	}

	// A missing secret is the fourth operand of the same guard.
	withoutSecret := azureTestDirectories(t, "")
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"azure_openai","azure_base_url":"https://probe.invalid","azure_deployment_name":"dep","azure_api_version":"v","messages":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, failure := pinnedChatCompletionPlan(body, withoutSecret, ""); failure == nil || failure.status != http.StatusBadRequest {
		t.Fatalf("a missing api_key_azure_openai must answer the same 400, got %+v", failure)
	}
}

// TestChatCompletionAzureOpenAIPlanFoldedMembers is the PLAN-level table: each row names ONE folded member
// and inspects the body and headers the plan BUILT, so a member that is present but ordered wrongly, or
// attached with the wrong value, fails even when the recorded bytes of another scenario still match.
func TestChatCompletionAzureOpenAIPlanFoldedMembers(t *testing.T) {
	directories := azureTestDirectories(t, "synthetic-azure-key")
	t.Setenv(pinnedAzureOpenAISeamEnv, "")
	const base = `{"chat_completion_source":"azure_openai","azure_base_url":"https://probe.invalid","azure_deployment_name":"probe-deployment","azure_api_version":"2024-02-15-preview"`

	cases := []struct {
		name    string
		body    string
		want    []string
		reject  []string
		ordered [][2]string
	}{
		{
			name: "the keys list decides membership AND order, and model/top_k/user never reach the provider",
			body: base + `,"stream":false,"max_tokens":64,"messages":[{"role":"user","content":"x"}],"model":"gpt-4o","top_k":5,"user":"probe-user"}`,
			want: []string{`"messages":[{"role":"user","content":"x"}]`, `"max_tokens":64`, `"stream":false`},
			// `"user":` and not `"user"`: AZURE_OPENAI_KEYS (src/constants.js:440-457) has no
			// `model`, `top_k` or `user`, so those MEMBERS are dropped -- but the value of
			// `messages[].role` IS the string "user", and the `want` list above requires it. A
			// rejection of the bare token therefore forbade what the same case required, which is
			// not an arm defect but an over-broad assertion: it could never pass.
			reject:  []string{`"model"`, `"top_k"`, `"user":`, `"prompt"`, `"reasoning_effort"`},
			ordered: [][2]string{{`"messages"`, `"max_tokens"`}, {`"max_tokens"`, `"stream"`}},
		},
		{
			name:   "json_schema envelope: name -> strict (default true) -> schema, and no description",
			body:   base + `,"messages":[{"role":"user","content":"x"}],"json_schema":{"name":"probe_schema","description":"dropped","value":{"type":"object","properties":{"answer":{"type":"string"}}}}}`,
			want:   []string{`"response_format":{"type":"json_schema","json_schema":{"name":"probe_schema","strict":true,"schema":{"type":"object","properties":{"answer":{"type":"string"}}}}}`},
			reject: []string{`"description"`},
		},
		{
			name:   "json_schema strict false overrides the default",
			body:   base + `,"messages":[{"role":"user","content":"x"}],"json_schema":{"name":"probe_schema","strict":false,"value":{"type":"object"}}}`,
			want:   []string{`"json_schema":{"name":"probe_schema","strict":false,"schema":{"type":"object"}}`},
			reject: []string{`"strict":true`},
		},
		{
			name:    "logprobs as a NUMBER > 0 becomes top_logprobs plus logprobs:true, appended after response_format",
			body:    base + `,"messages":[{"role":"user","content":"x"}],"logprobs":5,"json_schema":{"name":"probe_schema","value":{"type":"object"}}}`,
			want:    []string{`"logprobs":true`, `"top_logprobs":5`},
			reject:  []string{`"logprobs":5`},
			ordered: [][2]string{{`"response_format"`, `"top_logprobs"`}},
		},
		{
			name:   "logprobs as a BOOLEAN is not folded (the pinned guard is typeof === number)",
			body:   base + `,"messages":[{"role":"user","content":"x"}],"logprobs":true}`,
			want:   []string{`"logprobs":true`},
			reject: []string{`"top_logprobs"`},
		},
		{
			name:   "reasoning_effort is DROPPED for a model outside OPENAI_REASONING_EFFORT_MODELS",
			body:   base + `,"messages":[{"role":"user","content":"x"}],"model":"gpt-4o","reasoning_effort":"high"}`,
			reject: []string{`"reasoning_effort"`},
		},
		{
			name:    "reasoning_effort is mapped through OPENAI_REASONING_EFFORT_MAP and keeps its keys position",
			body:    base + `,"messages":[{"role":"user","content":"x"}],"model":"gpt-5","reasoning_effort":"min","json_schema":{"name":"probe_schema","value":{"type":"object"}}}`,
			want:    []string{`"reasoning_effort":"minimal"`},
			reject:  []string{`"reasoning_effort":"min"`},
			ordered: [][2]string{{`"reasoning_effort"`, `"response_format"`}},
		},
		{
			name:    "OPENAI_FIXED_REASONING_EFFORT wins and joins at the END when the request carried none",
			body:    base + `,"messages":[{"role":"user","content":"x"}],"model":"gpt-5.3-chat-latest","json_schema":{"name":"probe_schema","value":{"type":"object"}}}`,
			want:    []string{`"reasoning_effort":"medium"`},
			ordered: [][2]string{{`"response_format"`, `"reasoning_effort"`}},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request := azurePlanForTest(t, directories, testCase.body)
			built := string(request.Body)
			for _, want := range testCase.want {
				if !strings.Contains(built, want) {
					t.Fatalf("built body does not carry %s:\n%s", want, built)
				}
			}
			for _, reject := range testCase.reject {
				if strings.Contains(built, reject) {
					t.Fatalf("built body carries %s, which this fold must not produce:\n%s", reject, built)
				}
			}
			for _, pair := range testCase.ordered {
				first := strings.Index(built, pair[0])
				second := strings.Index(built, pair[1])
				if first < 0 || second < 0 {
					t.Fatalf("cannot order %s before %s in %s", pair[0], pair[1], built)
				}
				if first > second {
					t.Fatalf("%s must precede %s in the built body:\n%s", pair[0], pair[1], built)
				}
			}

			if request.Method != http.MethodPost {
				t.Fatalf("method = %s, want POST", request.Method)
			}
			if got := azureHeaderValue(request.Headers, "api-key"); got != "synthetic-azure-key" {
				t.Fatalf("api-key = %q, want the api_key_azure_openai secret", got)
			}
			if got := azureHeaderValue(request.Headers, "authorization"); got != "" {
				t.Fatalf("authorization = %q: this source authenticates with api-key only", got)
			}
			if got := azureHeaderValue(request.Headers, "content-type"); got != "application/json" {
				t.Fatalf("content-type = %q", got)
			}
			if got := azureHeaderValue(request.Headers, "content-length"); got != strconv.Itoa(len(request.Body)) {
				t.Fatalf("content-length = %q, want %d", got, len(request.Body))
			}
		})
	}

	// The escaping row, which the body assertions cannot see: the deployment is interpolated RAW and escaped
	// by the URL parser, and the api version is serialized the way URLSearchParams does (a space becomes '+').
	escaped := azurePlanForTest(t, directories, `{"chat_completion_source":"azure_openai","azure_base_url":"https://probe.invalid","azure_deployment_name":"probe deployment","azure_api_version":"2024 02","messages":[{"role":"user","content":"x"}]}`)
	if want := "https://probe.invalid/openai/deployments/probe%20deployment/chat/completions?api-version=2024+02"; escaped.URL != want {
		t.Fatalf("URL = %q, want %q", escaped.URL, want)
	}
}

// TestChatCompletionAzureOpenAIStatusDerivations covers the two /status observables the provider-wire
// harness cannot record: the pre-fetch 400 (no provider request exists to record) and the {data:[]} answer
// when the probe body carries no `model` (that one is measured against a live peer here instead).
func TestChatCompletionAzureOpenAIStatusDerivations(t *testing.T) {
	var hits int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		atomic.AddInt64(&hits, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[],"note":"no model member"}`))
	}))
	defer provider.Close()

	// 1) DERIVATION from :1939-1942: a missing key answers 400 with the SHORT status message and makes no
	// request at all. Measured against the live peer, so an implementation that started fetching fails here.
	withoutKey := azureTestDirectories(t, "")
	statusBody := `{"chat_completion_source":"azure_openai","azure_base_url":"` + provider.URL + `","azure_deployment_name":"dep","azure_api_version":"2024-02-15-preview"}`
	body, err := decodeOrderedNodeJSON([]byte(statusBody))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(pinnedAzureOpenAISeamEnv, "")
	recorder := httptest.NewRecorder()
	(&accountRuntime{}).serveAzureOpenAIChatCompletionStatus(recorder, httptest.NewRequest(http.MethodPost, "/api/backends/chat-completions/status", nil), body, withoutKey)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if got := recorder.Body.String(); got != `{"error":true,"message":"Azure configuration is incomplete."}` {
		t.Fatalf("body = %s", got)
	}
	if got := atomic.LoadInt64(&hits); got != 0 {
		t.Fatalf("the refusal reached the provider %d time(s); pinned returns before the first fetch", got)
	}

	// 2) The probe's answer has no truthy `model`, so the arm keeps a benign success: 200 {data:[]}
	// (:1997-2003). Measured: BOTH provider calls must have happened, so a short-circuited arm fails here.
	withKey := azureTestDirectories(t, "synthetic-azure-key")
	body, err = decodeOrderedNodeJSON([]byte(statusBody))
	if err != nil {
		t.Fatal(err)
	}
	recorder = httptest.NewRecorder()
	(&accountRuntime{}).serveAzureOpenAIChatCompletionStatus(recorder, httptest.NewRequest(http.MethodPost, "/api/backends/chat-completions/status", nil), body, withKey)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if got := recorder.Body.String(); got != `{"data":[]}` {
		t.Fatalf("body = %s, want {\"data\":[]}", got)
	}
	if got := atomic.LoadInt64(&hits); got != 2 {
		t.Fatalf("the arm made %d provider request(s), want 2 (GET /openai/models then the POST probe)", got)
	}
}

// TestChatCompletionAzureOpenAIStatusMapsProviderStatus exercises the pinned message table (:1951-1973),
// which the recorded nonok scenario covers for 401 only.
func TestChatCompletionAzureOpenAIStatusMapsProviderStatus(t *testing.T) {
	cases := map[int]string{
		400: "API version may be invalid for this resource.",
		401: "Invalid API key or insufficient permissions.",
		403: "Invalid API key or insufficient permissions.",
		404: "Endpoint URL appears incorrect (404).",
		500: "Azure Models endpoint error: Internal Server Error",
	}
	for status, want := range cases {
		if got := pinnedAzureOpenAIStatusErrorMessage(status, http.StatusText(status)); got != want {
			t.Fatalf("status %d maps to %q, want %q", status, got, want)
		}
	}
}

// TestChatCompletionAzureOpenAIIsNotTheDefaultRefusal proves the source reaches a served branch while a
// source with no branch still answers 501 (AGENTS.md rule 17: "not implemented" must stay visible).
func TestChatCompletionAzureOpenAIIsNotTheDefaultRefusal(t *testing.T) {
	directories := azureTestDirectories(t, "synthetic-azure-key")
	t.Setenv(pinnedAzureOpenAISeamEnv, "")
	body, decodeErr := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"azure_openai","azure_base_url":"https://probe.invalid","azure_deployment_name":"dep","azure_api_version":"v","messages":[{"role":"user","content":"x"}],"stream":false}`))
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	request, failure := pinnedChatCompletionPlan(body, directories, "")
	if failure != nil {
		t.Fatalf("azure_openai did not reach a served branch: %+v", failure)
	}
	if request == nil || !strings.Contains(request.URL, "/openai/deployments/dep/chat/completions") {
		t.Fatalf("plan = %+v, want a request to the composed azure endpoint", request)
	}

	unimplemented, unimplementedErr := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"cometapi","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if unimplementedErr != nil {
		t.Fatal(unimplementedErr)
	}
	if _, failure := pinnedChatCompletionPlan(unimplemented, directories, ""); failure == nil || failure.status != http.StatusNotImplemented {
		t.Fatalf("a source this lane does not implement must answer 501, got %+v", failure)
	}
}

// ---- helpers -----------------------------------------------------------------------------------

func azureTestDirectories(t *testing.T, key string) startup.UserDirectories {
	t.Helper()
	installRoot := t.TempDir()
	dataRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte("gotavern-azure-test-cookie-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	secrets := `{}`
	if key != "" {
		secrets = `{"api_key_azure_openai":[{"id":"probe-id","value":"` + key + `","label":"api_key_azure_openai","active":true}]}`
	}
	if err := os.WriteFile(filepath.Join(directories["root"], "secrets.json"), []byte(secrets), 0o600); err != nil {
		t.Fatal(err)
	}
	return directories
}

func azurePlanForTest(t *testing.T, directories startup.UserDirectories, rawBody string) *outbound.Request {
	t.Helper()
	body, err := decodeOrderedNodeJSON([]byte(rawBody))
	if err != nil {
		t.Fatal(err)
	}
	request, failure := pinnedChatCompletionPlan(body, directories, "gotavern-azure-test-cookie-secret")
	if failure != nil {
		t.Fatalf("plan failed: %+v", failure)
	}
	return request
}

func azureHeaderValue(headers []outbound.Header, name string) string {
	for _, header := range headers {
		if strings.EqualFold(header.Name, name) {
			return header.Value
		}
	}
	return ""
}

// TestAzureOpenAIThrownFetchAnswers500WithTheMessage pins the PINNED CATCH (chat-completions.js:1768-1773) rather
// than leaving a read contract unasserted:
//
//	const message = error.name === 'AbortError' ? 'Request was aborted by the client.' : (error.message || '...')
//	return response.status(500).send({ error: { message, ...error } })
//
// So a thrown fetch is 500 -- NOT the generic 502 -- with a single `error` object carrying `message`. The
// `...error` spread is NOT reproduced: it contributes only ENUMERABLE own properties, and a plain Error has none
// (message and stack are non-enumerable), so the body is {error:{message}} for every case this route can reach.
func TestAzureOpenAIThrownFetchAnswers500WithTheMessage(t *testing.T) {
	failure := pinnedAzureOpenAICatch(errors.New("probe network failure"))
	if failure == nil {
		t.Fatal("a thrown fetch must produce a failure")
	}
	if failure.status != 500 {
		t.Fatalf("a thrown fetch answers %d, want 500 (the branches own catch, not the shared 502)", failure.status)
	}
	if failure.payload == nil {
		t.Fatal("the 500 must carry a body")
	}
	if len(failure.payload.object) != 1 {
		t.Fatalf("the body must carry only the error member, got %d members", len(failure.payload.object))
	}
	errorMember, exists := failure.payload.member("error")
	if !exists || errorMember.kind != 'o' {
		t.Fatalf("the body must carry an error OBJECT, got %+v", errorMember)
	}
	message, hasMessage := errorMember.member("message")
	if !hasMessage {
		t.Fatal("the error object must carry a message")
	}
	if text, err := pinnedJSStringValue(message); err != nil || text == "" {
		t.Fatalf("the message must be a non-empty string, got %+v", message)
	}
}
