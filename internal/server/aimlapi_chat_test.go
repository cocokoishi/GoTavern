package server

// The AIMLAPI properties the generic provider-wire replay cannot state, plus the branches that harness
// cannot capture.
//
// The provider-wire probe requires every scenario to record at least one PROVIDER request, so a branch
// that answers before the fetch never appears in it, and there is no closed-port mode, so a THROWN fetch
// cannot be produced there either. AIMLAPI has both: a missing key answers 400 {"error":true}
// (:1293-1296) and a thrown fetch answers 200 {"error":true} (:1385-1391). They are therefore LABELLED
// DERIVATIONS (AGENTS.md rule 4): the status and body come from those pinned lines, and what is asserted
// beyond them is the observable half — that no request reached the provider for the key refusal.
//
// The folded members get their own PLAN-LEVEL table (TestChatCompletionAimlapiPlanFoldedMembers): one
// case per member, asserting the plan's OWN bytes, so a member attached in the wrong position — or a
// member that must be ABSENT and is not — fails even when a whole-body digest happens to match some
// other implementation.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// aimlapiTestDirectories seeds one user tree with the aimlapi secret so the plan's key guard passes.
func aimlapiTestDirectories(t *testing.T) startup.UserDirectories {
	t.Helper()
	dataRoot := t.TempDir()
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(filepath.Join(userRoot, "backups"), 0o755); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string][]map[string]any{
		"api_key_aimlapi": {{"id": "sid-api_key_aimlapi", "value": "synthetic-aimlapi-key", "label": "api_key_aimlapi", "active": true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userRoot, "secrets.json"), payload, 0o644); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	return directories
}

// TestChatCompletionAimlapiPlanFoldedMembers is the PLAN-level table: one case per folded member, plus
// the ABSENCE of every member whose gate is available, on the plan's own bytes and header list.
func TestChatCompletionAimlapiPlanFoldedMembers(t *testing.T) {
	directories := aimlapiTestDirectories(t)
	plan := func(t *testing.T, body string) (string, []string, *pinnedChatCompletionFailure) {
		t.Helper()
		parsed, err := decodeOrderedNodeJSON([]byte(body))
		if err != nil {
			t.Fatal(err)
		}
		request, failure := pinnedAimlapiPlan(parsed, directories)
		if failure != nil {
			return "", nil, failure
		}
		names := make([]string, 0, len(request.Headers))
		for _, header := range request.Headers {
			names = append(names, header.Name+"="+header.Value)
		}
		return string(request.Body), names, nil
	}
	withMessages := func(extra string) string {
		return `{"model":"aimlapi-probe","messages":[{"role":"user","content":"probe"}],` + extra + `}`
	}

	cases := []struct {
		name   string
		body   string
		want   []string
		reject []string
		// order asserts that the members appear in this exact sequence, which is how the pinned
		// `...bodyParams` spread last is pinned.
		order []string
	}{
		{
			name:  "the fixed literal comes first and the fold follows it",
			body:  `{"messages":[{"role":"user","content":"probe"}],"model":"m","temperature":0.4,"max_tokens":96,"stream":false,"presence_penalty":0.1,"frequency_penalty":0.2,"top_p":0.8,"seed":7,"n":1,"reasoning_effort":"high"}`,
			order: []string{`"messages"`, `"model"`, `"temperature"`, `"max_tokens"`, `"stream"`, `"presence_penalty"`, `"frequency_penalty"`, `"top_p"`, `"seed"`, `"n"`, `"reasoning_effort"`},
		},
		{
			name:  "logprobs above zero sends top_logprobs then logprobs:true",
			body:  withMessages(`"logprobs":5`),
			want:  []string{`"top_logprobs":5`, `"logprobs":true`},
			order: []string{`"top_logprobs":5`, `"logprobs":true`},
		},
		{
			name:   "logprobs zero sends NEITHER member",
			body:   withMessages(`"logprobs":0`),
			reject: []string{"top_logprobs", `"logprobs":true`},
		},
		{
			name: "a numeric-string logprobs is coerced by the relational comparison",
			body: withMessages(`"logprobs":"3"`),
			want: []string{`"top_logprobs":"3"`, `"logprobs":true`},
		},
		{
			name:  "a non-empty tools array forwards tools and tool_choice",
			body:  withMessages(`"tools":[{"type":"function","function":{"name":"t","parameters":{}}}],"tool_choice":"auto"`),
			want:  []string{`"tools":[`, `"tool_choice":"auto"`},
			order: []string{`"tools":[`, `"tool_choice":"auto"`},
		},
		{
			name:   "an EMPTY tools array forwards neither member, even with tool_choice present",
			body:   withMessages(`"tools":[],"tool_choice":"auto"`),
			reject: []string{`"tools"`, `"tool_choice"`},
		},
		{
			name: "a non-empty stop array is forwarded",
			body: withMessages(`"stop":["PROBE_STOP"]`),
			want: []string{`"stop":["PROBE_STOP"]`},
		},
		{
			name:   "an EMPTY stop array is not forwarded",
			body:   withMessages(`"stop":[]`),
			reject: []string{`"stop"`},
		},
		{
			name: "reasoning_effort is forwarded when truthy",
			body: withMessages(`"reasoning_effort":"high"`),
			want: []string{`"reasoning_effort":"high"`},
		},
		{
			name:   "an EMPTY reasoning_effort is a truthiness miss and is omitted",
			body:   withMessages(`"reasoning_effort":""`),
			reject: []string{"reasoning_effort"},
		},
		{
			name: "json_schema folds name, description, schema and a defaulted strict",
			body: withMessages(`"json_schema":{"name":"s","description":"d","value":{"type":"object"}}`),
			want: []string{`"response_format":{"type":"json_schema","json_schema":{"name":"s","description":"d","schema":{"type":"object"},"strict":true}}`},
		},
		{
			name: "json_schema keeps an explicit strict:false",
			body: withMessages(`"json_schema":{"name":"s","value":{"type":"object"},"strict":false}`),
			want: []string{`"strict":false`},
		},
		{
			name: "json_schema does NOT flatten the schema, unlike groq and deepseek",
			body: withMessages(`"json_schema":{"name":"s","value":{"type":"object","properties":{"a":{"type":"string"}}}}`),
			want: []string{`"schema":{"type":"object","properties":{"a":{"type":"string"}}}`},
		},
	}
	for _, testCase := range cases {
		body, _, failure := plan(t, testCase.body)
		if failure != nil {
			t.Fatalf("%s: the plan failed (%d) instead of building a request", testCase.name, failure.status)
		}
		for _, fragment := range testCase.want {
			if !strings.Contains(body, fragment) {
				t.Fatalf("%s: body %s does not contain %q", testCase.name, body, fragment)
			}
		}
		for _, fragment := range testCase.reject {
			if strings.Contains(body, fragment) {
				t.Fatalf("%s: body %s contains %q, which the pinned fold must omit", testCase.name, body, fragment)
			}
		}
		position := -1
		for _, fragment := range testCase.order {
			index := strings.Index(body, fragment)
			if index <= position {
				t.Fatalf("%s: body %s puts %q out of order", testCase.name, body, fragment)
			}
			position = index
		}
	}
}

// TestChatCompletionAimlapiWireHeaders pins the header set AND its order: node-fetch's sorted lowercase
// defaults, the AIMLAPI_HEADERS pair inside that sort, then Host and Connection.
func TestChatCompletionAimlapiWireHeaders(t *testing.T) {
	directories := aimlapiTestDirectories(t)
	parsed, err := decodeOrderedNodeJSON([]byte(`{"model":"m","messages":[{"role":"user","content":"probe"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	request, failure := pinnedAimlapiPlan(parsed, directories)
	if failure != nil {
		t.Fatalf("the plan failed (%d) instead of building a request", failure.status)
	}
	names := make([]string, 0, len(request.Headers))
	for _, header := range request.Headers {
		names = append(names, header.Name)
	}
	want := []string{"accept", "accept-encoding", "authorization", "content-length", "content-type", "http-referer", "user-agent", "x-title", "Host", "Connection"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("header order = %v, pinned %v", names, want)
	}
	values := map[string]string{}
	for _, header := range request.Headers {
		values[header.Name] = header.Value
	}
	if values["http-referer"] != pinnedAimlapiReferer || values["x-title"] != pinnedAimlapiTitle {
		t.Fatalf("AIMLAPI_HEADERS = %q/%q, pinned %q/%q", values["http-referer"], values["x-title"], pinnedAimlapiReferer, pinnedAimlapiTitle)
	}
	if values["authorization"] != "Bearer synthetic-aimlapi-key" {
		t.Fatalf("authorization = %q, want the planted key", values["authorization"])
	}
	if !strings.HasSuffix(request.URL, "/chat/completions") {
		t.Fatalf("url = %q, want the pinned /chat/completions suffix", request.URL)
	}
}

// TestChatCompletionAimlapiSeamDefault pins the seam to the pinned literal: an override that drifts would
// silently move production while every replay (which sets the seam) stayed green.
func TestChatCompletionAimlapiSeamDefault(t *testing.T) {
	t.Setenv(pinnedAimlapiSeamEnv, "")
	if got := pinnedAimlapiBaseURL(); got != pinnedAimlapiAPIURL {
		t.Fatalf("seam default = %q, pinned %q", got, pinnedAimlapiAPIURL)
	}
	t.Setenv(pinnedAimlapiSeamEnv, "http://127.0.0.1:9999/")
	if got := pinnedAimlapiBaseURL(); got != "http://127.0.0.1:9999" {
		t.Fatalf("seam override = %q, want the trailing slash trimmed", got)
	}
}

// TestChatCompletionAimlapiMissingKeyIsRefusedBeforeTheFetch is a LABELLED DERIVATION: the provider-wire
// harness cannot capture a branch that never fetches. The status and body come from :1293-1296; the extra
// assertion is the observable half — NO request reaches the provider.
func TestChatCompletionAimlapiMissingKeyIsRefusedBeforeTheFetch(t *testing.T) {
	requests := 0
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(peer.Close)
	t.Setenv(pinnedAimlapiSeamEnv, peer.URL)

	// NO secret is seeded here: that is the whole point of the test. (An earlier version seeded one and
	// then asserted 400, which the route correctly answered with 200 because the key was present -- a test
	// defect the lane CI caught, not a product one.)
	handler := unseededAimlapiHandler(t)
	response := postSecretsRoute(t, handler, "/api/backends/chat-completions/generate",
		`{"chat_completion_source":"aimlapi","model":"m","messages":[{"role":"user","content":"probe"}]}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
	if body := strings.TrimSpace(response.Body.String()); body != `{"error":true}` {
		t.Fatalf("body = %q, want {\"error\":true}", body)
	}
	if requests != 0 {
		t.Fatalf("the refused request still reached the provider (%d request(s))", requests)
	}
	// And, unlike openai/mistral/deepseek, a reverse_proxy does NOT rescue it: the route never consults
	// that member, so the guard is `!apiKey` alone (:1293).
	withProxy := postSecretsRoute(t, handler, "/api/backends/chat-completions/generate",
		`{"chat_completion_source":"aimlapi","model":"m","messages":[{"role":"user","content":"probe"}],"reverse_proxy":"http://127.0.0.1:1","proxy_password":"x"}`)
	if withProxy.Code != http.StatusBadRequest {
		t.Fatalf("a reverse_proxy changed the aimlapi key guard: status = %d, want 400", withProxy.Code)
	}
	if requests != 0 {
		t.Fatalf("the reverse_proxy request reached the provider (%d request(s)); aimlapi always dials its literal", requests)
	}
}

// TestChatCompletionAimlapiTransportFailureAnswers200 is a LABELLED DERIVATION for the second branch the
// harness cannot capture (a thrown fetch): :1385-1391 calls `response.send({error:true})` with NO status,
// so the caller sees 200.
func TestChatCompletionAimlapiTransportFailureAnswers200(t *testing.T) {
	// Port 1 with no listener produces the transport failure deterministically.
	t.Setenv(pinnedAimlapiSeamEnv, "http://127.0.0.1:1")
	handler := aimlapiSeededHandler(t)
	response := postSecretsRoute(t, handler, "/api/backends/chat-completions/generate",
		`{"chat_completion_source":"aimlapi","model":"m","messages":[{"role":"user","content":"probe"}]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (the pinned catch sets no status)", response.Code)
	}
	if body := strings.TrimSpace(response.Body.String()); body != `{"error":true}` {
		t.Fatalf("body = %q, want {\"error\":true}", body)
	}
}

// unseededAimlapiHandler builds a handler over a fresh data root with NO aimlapi secret, so the key
// refusal is reachable.
func unseededAimlapiHandler(t *testing.T) http.Handler {
	t.Helper()
	dataRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataRoot, "default-user", "backups"), 0o755); err != nil {
		t.Fatal(err)
	}
	return NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
}

// aimlapiSeededHandler builds a handler over a fresh data root that already carries the aimlapi secret,
// so a route-level test can reach the fetch.
func aimlapiSeededHandler(t *testing.T) http.Handler {
	t.Helper()
	dataRoot := t.TempDir()
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(filepath.Join(userRoot, "backups"), 0o755); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string][]map[string]any{
		"api_key_aimlapi": {{"id": "sid-api_key_aimlapi", "value": "synthetic-aimlapi-key", "label": "api_key_aimlapi", "active": true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userRoot, "secrets.json"), payload, 0o644); err != nil {
		t.Fatal(err)
	}
	return NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
}

// TestChatCompletionAimlapiIsNot501WhileAnUnportedSourceIs asserts the dispatch itself: aimlapi leaves the
// 501 branch, and a pinned source this route still does not port stays there. Without the second half the
// first would pass on a route that answered 501 to everything.
func TestChatCompletionAimlapiIsNot501WhileAnUnportedSourceIs(t *testing.T) {
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: t.TempDir(), DataRoot: t.TempDir(), DisableCSRF: true})
	aimlapi := postSecretsRoute(t, handler, "/api/backends/chat-completions/generate",
		`{"chat_completion_source":"aimlapi","model":"m","messages":[{"role":"user","content":"probe"}]}`)
	if aimlapi.Code == http.StatusNotImplemented {
		t.Fatal("aimlapi still answers 501 on the generate route")
	}
	if aimlapi.Code != http.StatusBadRequest {
		// No key is seeded here, so the aimlapi branch must answer its own 400; anything else means the
		// request never reached the aimlapi arm.
		t.Fatalf("aimlapi status = %d, want its own 400 (a 501 means the branch is not dispatched)", aimlapi.Code)
	}
	cohere := postSecretsRoute(t, handler, "/api/backends/chat-completions/generate",
		`{"chat_completion_source":"cometapi","model":"m","messages":[{"role":"user","content":"probe"}]}`)
	if cohere.Code != http.StatusNotImplemented {
		t.Fatalf("an unported source status = %d, want 501 so the gap stays visible", cohere.Code)
	}

	// The status route: aimlapi has a pinned arm (:1832), so it must leave the 501 branch as well.
	statusAimlapi := postSecretsRoute(t, handler, "/api/backends/chat-completions/status", `{"chat_completion_source":"aimlapi"}`)
	if statusAimlapi.Code == http.StatusNotImplemented {
		t.Fatal("aimlapi still answers 501 on the status route")
	}
	if statusAimlapi.Code != http.StatusBadRequest {
		t.Fatalf("aimlapi status-route status = %d, want its own 400 without a key", statusAimlapi.Code)
	}
	statusCohere := postSecretsRoute(t, handler, "/api/backends/chat-completions/status", `{"chat_completion_source":"cohere"}`)
	if statusCohere.Code != http.StatusNotImplemented {
		t.Fatalf("an unported source status-route status = %d, want 501", statusCohere.Code)
	}
}
