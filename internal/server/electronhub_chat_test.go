package server

// The ELECTRONHUB properties the generic provider-wire replay cannot state, plus the two branches that
// harness cannot capture, plus the classification test the lead asked for: ELECTRONHUB must not answer
// 501 (it is implemented) while a source that is genuinely unported still does (AGENTS.md rule 17 --
// "unimplemented" must stay distinguishable from "refused").
//
// The provider-wire probe requires every scenario to record at least one provider request, so a branch
// that answers BEFORE the fetch never appears in it, and it has no closed-port mode, so a THROWN fetch
// cannot be produced there either. ELECTRONHUB has both: a missing key answers 400 {"error":true}
// (:1398-1401) and a thrown fetch answers 200 {"error":true} (:1491-1497). They are LABELLED
// DERIVATIONS (rule 4): the status and body come from those pinned lines, and what is asserted beyond
// them is the observable half -- that NO request reached the provider.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

type electronHubWireFixture struct {
	Seams map[string]struct {
		PinnedLiteral string `json:"pinnedLiteral"`
	} `json:"seams"`
	Scenarios map[string]struct {
		TargetPath string `json:"targetPath"`
		Provider   struct {
			Requests []struct {
				Method    string `json:"method"`
				RawTarget string `json:"rawTarget"`
				BodyText  string `json:"bodyText"`
			} `json:"requests"`
		} `json:"provider"`
		ProviderResponse struct {
			Events []struct {
				Data string `json:"data"`
			} `json:"events"`
			Body struct {
				Choices []struct {
					Message struct {
						Content string `json:"content"`
					} `json:"message"`
				} `json:"choices"`
			} `json:"body"`
		} `json:"providerResponse"`
	} `json:"scenarios"`
}

func loadElectronHubWireFixture(t *testing.T) electronHubWireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture electronHubWireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) == 0 {
		t.Fatal("the provider-wire fixture records no scenarios")
	}
	return fixture
}

func electronHubScenarioBody(t *testing.T, fixture electronHubWireFixture, name string) string {
	t.Helper()
	scenario, present := fixture.Scenarios[name]
	if !present {
		t.Fatalf("the fixture has no capture for %q, so that observable is unproven", name)
	}
	if len(scenario.Provider.Requests) == 0 {
		t.Fatalf("%s: the capture records no provider request", name)
	}
	return scenario.Provider.Requests[0].BodyText
}

// TestChatCompletionElectronHubCoversItsBranches refuses to run a suite that cannot discriminate.
func TestChatCompletionElectronHubCoversItsBranches(t *testing.T) {
	fixture := loadElectronHubWireFixture(t)
	required := []string{
		"electronhub-nonstream",
		"electronhub-web-search",
		"electronhub-tools",
		"electronhub-reasoning-effort",
		"electronhub-json-schema",
		"electronhub-json-schema-nonstrict",
		"electronhub-claude-model-no-cache",
		"electronhub-stream",
		"electronhub-stream-control-nonstream",
		"electronhub-error-status",
		"electronhub-error-status-nonjson",
	}
	for _, name := range required {
		scenario, present := fixture.Scenarios[name]
		if !present {
			t.Fatalf("the fixture has no capture for %q, so that observable is unproven", name)
		}
		if scenario.TargetPath != chatCompletionSourceElectronHub {
			t.Fatalf("%s: targetPath = %q, want %q", name, scenario.TargetPath, chatCompletionSourceElectronHub)
		}
		if len(scenario.Provider.Requests) == 0 {
			t.Fatalf("%s: the capture records no provider request", name)
		}
	}
}

// TestChatCompletionElectronHubCapturesCarryTheFoldedMembers states on the CAPTURES what the plan-level
// table states on the plan, so a capture that stopped carrying a member fails even if the plan is right.
func TestChatCompletionElectronHubCapturesCarryTheFoldedMembers(t *testing.T) {
	fixture := loadElectronHubWireFixture(t)
	cases := []struct {
		name     string
		scenario string
		want     []string
		reject   []string
	}{
		{
			name:     "messages are forwarded VERBATIM, so a repeated role stays two messages",
			scenario: "electronhub-nonstream",
			want:     []string{`{"role":"user","content":"probe first user"},{"role":"user","content":"probe second user"}`, `{"role":"system","content":"probe mid system marker"}`},
			reject:   []string{"probe first user\\n\\nprobe second user"},
		},
		{
			name:     "top_k and logit_bias are copied and web_search is absent",
			scenario: "electronhub-nonstream",
			want:     []string{`"top_k":40`, `"logit_bias":{"50256":-100}`, `"seed":11`},
			reject:   []string{"web_search"},
		},
		{
			name:     "enable_web_search adds only web_search",
			scenario: "electronhub-web-search",
			want:     []string{`"web_search":true`},
		},
		{
			name:     "tools are RAW: a non-function entry survives and an empty required array is NOT cleaned",
			scenario: "electronhub-tools",
			want:     []string{`"type":"probe-not-a-function"`, `"required":[]`, `"tool_choice":"auto"`},
		},
		{
			name:     "reasoning_effort is forwarded with no include_reasoning gate",
			scenario: "electronhub-reasoning-effort",
			want:     []string{`"reasoning_effort":"high"`},
			reject:   []string{"include_reasoning"},
		},
		{
			name:     "json_schema keeps the MISTRAL shape and appends no message",
			scenario: "electronhub-json-schema",
			want:     []string{`"response_format":{"type":"json_schema","json_schema":{"name":"probe_schema","description":"probe schema description","schema":{"type":"object","properties":{"probe_field":{"type":"string"}},"required":["probe_field"]},"strict":true}}`},
			reject:   []string{"JSON schema for the response"},
		},
		{
			name:     "strict false survives",
			scenario: "electronhub-json-schema-nonstrict",
			want:     []string{`"strict":false`},
		},
		{
			name:     "a claude model injects no cache_control at the default config",
			scenario: "electronhub-claude-model-no-cache",
			reject:   []string{"cache_control"},
		},
	}
	for _, testCase := range cases {
		body := electronHubScenarioBody(t, fixture, testCase.scenario)
		for _, want := range testCase.want {
			if !strings.Contains(body, want) {
				t.Fatalf("%s: the capture does not contain %q: %s", testCase.name, want, body)
			}
		}
		for _, reject := range testCase.reject {
			if strings.Contains(body, reject) {
				t.Fatalf("%s: the capture contains %q although it must not: %s", testCase.name, reject, body)
			}
		}
	}
}

// TestChatCompletionElectronHubPlanFoldedMembers is the PLAN-level table: one case per folded member, on
// the plan's own bytes.
func TestChatCompletionElectronHubPlanFoldedMembers(t *testing.T) {
	directories := electronHubTestDirectories(t)
	plan := func(t *testing.T, body string) string {
		t.Helper()
		parsed, err := decodeOrderedNodeJSON([]byte(body))
		if err != nil {
			t.Fatal(err)
		}
		request, failure := pinnedElectronHubPlan(parsed, directories)
		if failure != nil {
			t.Fatalf("the plan refused a legal body (status %d)", failure.status)
		}
		return string(request.Body)
	}
	withMessages := func(extra string) string {
		return `{"model":"probe/model","messages":[{"role":"user","content":"probe"}],` + extra + `}`
	}

	cases := []struct {
		name   string
		body   string
		want   []string
		reject []string
	}{
		{
			name: "top_k and logit_bias are their own members",
			body: withMessages(`"top_k":40,"logit_bias":{"50256":-100}`),
			want: []string{`"top_k":40`, `"logit_bias":{"50256":-100}`},
		},
		{
			name: "web_search appears only when enable_web_search is truthy",
			body: withMessages(`"enable_web_search":true`),
			want: []string{`"web_search":true`},
		},
		{
			name:   "a falsy enable_web_search adds nothing",
			body:   withMessages(`"enable_web_search":false`),
			reject: []string{"web_search"},
		},
		{
			name: "tools and tool_choice are forwarded raw, including an empty required",
			body: withMessages(`"tools":[{"type":"function","function":{"name":"a","parameters":{"type":"object","required":[]}}}],"tool_choice":"auto"`),
			want: []string{`"required":[]`, `"tool_choice":"auto"`},
		},
		{
			name: "reasoning_effort needs no companion flag",
			body: withMessages(`"reasoning_effort":"low"`),
			want: []string{`"reasoning_effort":"low"`},
		},
		{
			name:   "an absent reasoning_effort adds nothing",
			body:   withMessages(`"max_tokens":96`),
			reject: []string{"reasoning_effort"},
		},
		{
			name: "json_schema defaults strict to true",
			body: withMessages(`"json_schema":{"name":"s","value":{"type":"object"}}`),
			want: []string{`"response_format":{"type":"json_schema","json_schema":{"name":"s","schema":{"type":"object"},"strict":true}}`},
		},
		{
			name: "json_schema honours strict false",
			body: withMessages(`"json_schema":{"name":"s","value":{"type":"object"},"strict":false}`),
			want: []string{`"strict":false`},
		},
		{
			name: "messages pass through untouched",
			body: withMessages(`"max_tokens":96`),
			want: []string{`"messages":[{"role":"user","content":"probe"}]`},
		},
	}
	for _, testCase := range cases {
		body := plan(t, testCase.body)
		for _, want := range testCase.want {
			if !strings.Contains(body, want) {
				t.Fatalf("%s: the plan does not contain %q: %s", testCase.name, want, body)
			}
		}
		for _, reject := range testCase.reject {
			if strings.Contains(body, reject) {
				t.Fatalf("%s: the plan contains %q although it must not: %s", testCase.name, reject, body)
			}
		}
	}

	// Member ORDER: the spread bodyParams follow `seed`, so web_search must come after it.
	body := plan(t, withMessages(`"seed":5,"enable_web_search":true`))
	seedAt := strings.Index(body, `"seed":5`)
	webAt := strings.Index(body, `"web_search":true`)
	if seedAt < 0 || webAt < 0 || webAt < seedAt {
		t.Fatalf("web_search must follow seed (seed at %d, web_search at %d): %s", seedAt, webAt, body)
	}
}

// electronHubTestDirectories writes a user tree whose ELECTRONHUB secret exists, so the plan-level
// table exercises the transform rather than the key guard. UserDirectories is a map keyed by directory
// NAME ("root" is what pinnedReadSecret reads), and writeSDSecrets takes plain values.
func electronHubTestDirectories(t *testing.T) startup.UserDirectories {
	t.Helper()
	root := t.TempDir()
	writeSDSecrets(t, root, "probe", map[string]string{
		"api_key_electronhub": "synthetic-electronhub-key",
	})
	return startup.UserDirectories{"root": root}
}

// TestChatCompletionElectronHubSeamDefault pins the seam default to the recorded literal and the path
// the literal builds.
func TestChatCompletionElectronHubSeamDefault(t *testing.T) {
	fixture := loadElectronHubWireFixture(t)
	recorded, present := fixture.Seams[pinnedElectronHubSeamEnv]
	if !present {
		t.Fatalf("the fixture does not record a seam named %q", pinnedElectronHubSeamEnv)
	}
	t.Setenv(pinnedElectronHubSeamEnv, "")
	if got := pinnedElectronHubBaseURL(); got != recorded.PinnedLiteral {
		t.Fatalf("default Electron Hub base = %q, the fixture recorded the pinned literal %q", got, recorded.PinnedLiteral)
	}
	if pinnedElectronHubAPIURL != recorded.PinnedLiteral {
		t.Fatalf("the Go literal %q and the fixture's recorded literal %q disagree", pinnedElectronHubAPIURL, recorded.PinnedLiteral)
	}
	targets := 0
	for name, scenario := range fixture.Scenarios {
		if scenario.TargetPath != chatCompletionSourceElectronHub {
			continue
		}
		targets++
		if target := scenario.Provider.Requests[0].RawTarget; target != "/chat/completions" {
			t.Fatalf("%s: provider target %q, want /chat/completions (this route has no reverse_proxy, so no doubled slash is possible)", name, target)
		}
	}
	if targets < 10 {
		t.Fatalf("only %d electronhub scenario(s) carry a provider request, so the seam claim is under-exercised", targets)
	}
}

// TestChatCompletionElectronHubStreamHasNonStreamControl proves the pair is the same answer and that the
// terminator is the provider's own [DONE].
func TestChatCompletionElectronHubStreamHasNonStreamControl(t *testing.T) {
	fixture := loadElectronHubWireFixture(t)
	control, hasControl := fixture.Scenarios["electronhub-stream-control-nonstream"]
	stream, hasStream := fixture.Scenarios["electronhub-stream"]
	if !hasControl || !hasStream {
		t.Fatalf("the control/stream pair is missing (control %v, stream %v)", hasControl, hasStream)
	}
	if len(control.ProviderResponse.Body.Choices) == 0 {
		t.Fatal("the control captured no message content")
	}
	controlText := control.ProviderResponse.Body.Choices[0].Message.Content
	if controlText == "" {
		t.Fatal("the control's message content is empty")
	}
	streamed := strings.Builder{}
	terminated := false
	for _, event := range stream.ProviderResponse.Events {
		if event.Data == "[DONE]" {
			terminated = true
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(event.Data), &chunk); err != nil {
			t.Fatalf("a streamed event is not JSON (%q): %v", event.Data, err)
		}
		for _, choice := range chunk.Choices {
			streamed.WriteString(choice.Delta.Content)
		}
	}
	if !terminated {
		t.Fatal("the streaming capture does not carry the provider's [DONE] terminator")
	}
	if streamed.String() != controlText {
		t.Fatalf("the streaming deltas spell %q but the non-stream control carries %q", streamed.String(), controlText)
	}
}

// TestChatCompletionElectronHubMissingKeyIsRefusedBeforeTheFetch is a LABELLED DERIVATION (see header).
func TestChatCompletionElectronHubMissingKeyIsRefusedBeforeTheFetch(t *testing.T) {
	recorder := mockprovider.New([]mockprovider.Response{{
		Status:  200,
		Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json"}},
		Body:    `{"choices":[]}`,
	}})
	address, err := recorder.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = recorder.Close() })
	t.Setenv(pinnedElectronHubSeamEnv, "http://"+address.String())

	scenario := chatCompletionTestScenario()
	origin, cookie, token := startChatCompletionTestServer(t, scenario)
	body := `{"chat_completion_source":"electronhub","model":"probe/model","messages":[{"role":"user","content":"probe"}],"max_tokens":64,"stream":false}`
	status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, body)
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want the pinned 400 (body %q)", status, text)
	}
	if text != `{"error":true}` {
		t.Fatalf("body = %q, want {error:true}", text)
	}
	if recorded := recorder.Recording(); len(recorded.Requests) != 0 {
		t.Fatalf("the provider received %d request(s) although the key check rejects the call before the fetch", len(recorded.Requests))
	}
}

// TestChatCompletionElectronHubTransportFailureAnswers200 is a LABELLED DERIVATION (see header).
func TestChatCompletionElectronHubTransportFailureAnswers200(t *testing.T) {
	t.Setenv(pinnedElectronHubSeamEnv, closedLoopbackOrigin(t))
	scenario := chatCompletionTestScenario()
	scenario.Secrets = map[string]any{
		"api_key_electronhub": []any{map[string]any{"id": "probe", "value": "synthetic-electronhub-key", "label": "probe", "active": true}},
	}
	origin, cookie, token := startChatCompletionTestServer(t, scenario)
	body := `{"chat_completion_source":"electronhub","model":"probe/model","messages":[{"role":"user","content":"probe"}],"max_tokens":64,"stream":false}`
	status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, body)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want the pinned 200 (body %q); CLAUDE's 500 is the wrong contract here", status, text)
	}
	if text != `{"error":true}` {
		t.Fatalf("body = %q, want {error:true}", text)
	}
}

// TestChatCompletionElectronHubIsNot501WhileAnUnportedSourceStillIs is the classification test: this
// lane moved ONE source out of the 501 bucket, and the bucket must still exist for the sources it did
// not touch (AGENTS.md rule 17). A 501 for both would make the refusal and the gap indistinguishable.
func TestChatCompletionElectronHubIsNot501WhileAnUnportedSourceStillIs(t *testing.T) {
	recorder := mockprovider.New([]mockprovider.Response{{
		Status:  200,
		Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json"}},
		Body:    `{"id":"probe","choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}]}`,
	}})
	address, err := recorder.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = recorder.Close() })
	t.Setenv(pinnedElectronHubSeamEnv, "http://"+address.String())

	scenario := chatCompletionTestScenario()
	scenario.Secrets = map[string]any{
		"api_key_electronhub": []any{map[string]any{"id": "probe", "value": "synthetic-electronhub-key", "label": "probe", "active": true}},
	}
	origin, cookie, token := startChatCompletionTestServer(t, scenario)

	implemented := `{"chat_completion_source":"electronhub","model":"probe/model","messages":[{"role":"user","content":"probe"}],"max_tokens":64,"stream":false}`
	status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, implemented)
	if status == http.StatusNotImplemented {
		t.Fatalf("electronhub answered 501 although this lane implements it (body %q)", text)
	}
	if status != http.StatusOK {
		t.Fatalf("electronhub answered %d (%q), want the provider's 200", status, text)
	}
	if recorded := recorder.Recording(); len(recorded.Requests) != 1 {
		t.Fatalf("the provider received %d request(s), want exactly 1", len(recorded.Requests))
	}

	// `cohere` is a PINNED source this lane did not port: it must still answer 501, and it must not
	// reach the provider at all.
	unported := `{"chat_completion_source":"cohere","model":"probe/model","messages":[{"role":"user","content":"probe"}],"max_tokens":64,"stream":false}`
	status, _, text, _, _ = driveChatCompletionScenario(t, scenario, origin, cookie, token, unported)
	if status != http.StatusNotImplemented {
		t.Fatalf("cohere answered %d (%q), want 501 so the unported bucket stays distinguishable", status, text)
	}
	if recorded := recorder.Recording(); len(recorded.Requests) != 1 {
		t.Fatalf("the unported source reached the provider (%d requests total)", len(recorded.Requests))
	}
}
