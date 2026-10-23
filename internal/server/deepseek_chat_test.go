package server

// The DEEPSEEK properties the generic provider-wire replay cannot state, plus the two branches that
// harness cannot capture.
//
// The provider-wire probe requires every scenario to record at least one provider request, so a branch
// that answers BEFORE the fetch never appears in it, and there is no closed-port mode, so a THROWN
// fetch cannot be produced there either. DEEPSEEK has both: a missing key answers 400 {"error":true}
// (:1075-1078) and a thrown fetch answers 200 {"error":true} (:1168-1174). They are therefore LABELLED
// DERIVATIONS (AGENTS.md rule 4): the status and body come from those pinned lines, and what is
// asserted beyond them is the observable half -- that NO request reached the provider.
//
// The folded members get their own PLAN-LEVEL table (TestChatCompletionDeepSeekPlanFoldedMembers)
// rather than only a byte comparison, so a member that is present but attached to the wrong message, or
// ordered after the member it must precede, fails even when nothing else moved. The fixture-level
// assertions separately prove the captures contain the shapes these tests describe.

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

type deepseekWireFixture struct {
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
				Headers   []struct {
					Name  string `json:"name"`
					Value string `json:"value"`
				} `json:"headers"`
			} `json:"requests"`
		} `json:"provider"`
		AuthorizationKeyVerified bool `json:"authorizationKeyVerified"`
		ProviderResponse         struct {
			Status int `json:"status"`
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

func loadDeepSeekWireFixture(t *testing.T) deepseekWireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture deepseekWireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) == 0 {
		t.Fatal("the provider-wire fixture records no scenarios")
	}
	return fixture
}

func deepSeekScenarioBody(t *testing.T, fixture deepseekWireFixture, name string) string {
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

// TestChatCompletionDeepSeekCoversItsBranches refuses to run a suite that cannot discriminate.
func TestChatCompletionDeepSeekCoversItsBranches(t *testing.T) {
	fixture := loadDeepSeekWireFixture(t)
	required := []string{
		"deepseek-nonstream",
		"deepseek-reasoning",
		"deepseek-reasoning-effort-without-include",
		"deepseek-logprobs",
		"deepseek-tools-required-empty",
		"deepseek-prefix-flag",
		"deepseek-tools-suppress-prefix",
		"deepseek-json-schema",
		"deepseek-stream",
		"deepseek-stream-control-nonstream",
		"deepseek-error-status",
		"deepseek-error-status-nonjson",
		"deepseek-reverse-proxy-no-password",
	}
	for _, name := range required {
		scenario, present := fixture.Scenarios[name]
		if !present {
			t.Fatalf("the fixture has no capture for %q, so that observable is unproven", name)
		}
		if scenario.TargetPath != chatCompletionSourceDeepSeek {
			t.Fatalf("%s: targetPath = %q, want %q", name, scenario.TargetPath, chatCompletionSourceDeepSeek)
		}
		if len(scenario.Provider.Requests) == 0 {
			t.Fatalf("%s: the capture records no provider request", name)
		}
	}
}

// TestChatCompletionDeepSeekCapturesCarryTheFoldedMembers states, on the CAPTURES, what the plan-level
// table below states on the plan. Each case names one folded member so a failure says which one moved.
func TestChatCompletionDeepSeekCapturesCarryTheFoldedMembers(t *testing.T) {
	fixture := loadDeepSeekWireFixture(t)
	cases := []struct {
		name     string
		scenario string
		want     []string
		reject   []string
	}{
		{
			name:     "thinking is present and disabled by default",
			scenario: "deepseek-nonstream",
			want:     []string{`"thinking":{"type":"disabled"}`, `"seed":7`, `"stop":["PROBE_STOP"]`},
			reject:   []string{"reasoning_effort"},
		},
		{
			name:     "the SEMI_TOOLS merge folds a repeated role and rewrites a mid system turn",
			scenario: "deepseek-nonstream",
			want:     []string{`"content":"probe first user\n\nprobe second user\n\nprobe mid system marker\n\nprobe final user"`, `"role":"system","content":"probe system marker"`},
		},
		{
			name:     "include_reasoning enables thinking and forwards the effort after it",
			scenario: "deepseek-reasoning",
			want:     []string{`"thinking":{"type":"enabled"}`, `"reasoning_effort":"high"`},
		},
		{
			name:     "the effort alone is dropped",
			scenario: "deepseek-reasoning-effort-without-include",
			want:     []string{`"thinking":{"type":"disabled"}`},
			reject:   []string{"reasoning_effort"},
		},
		{
			name:     "logprobs adds both members",
			scenario: "deepseek-logprobs",
			want:     []string{`"top_logprobs":3`, `"logprobs":true`},
		},
		{
			name:     "an empty required array is deleted while a populated one survives",
			scenario: "deepseek-tools-required-empty",
			want:     []string{`"name":"probe_empty"`, `"required":["b"]`, `"tool_choice":"auto"`},
			reject:   []string{`"required":[]`},
		},
		{
			name:     "a trailing assistant turn is marked when no tool is in play",
			scenario: "deepseek-prefix-flag",
			want:     []string{`"prefix":true`},
		},
		{
			name:     "tools suppress the mark and a tool_calls message gains reasoning_content",
			scenario: "deepseek-tools-suppress-prefix",
			want:     []string{`"reasoning_content":""`},
			reject:   []string{`"prefix":true`},
		},
		{
			name:     "json_schema adds response_format and appends the schema as a user message",
			scenario: "deepseek-json-schema",
			want:     []string{`"response_format":{"type":"json_object"}`, `JSON schema for the response:\n{\n    \"type\": \"object\"`},
		},
	}
	for _, testCase := range cases {
		body := deepSeekScenarioBody(t, fixture, testCase.scenario)
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

	// The reverse_proxy-without-a-password case asserts the VALUE through the scenario's
	// expectedAuthorizationKey (the capture only records "Bearer <redacted>"), so the flag is the
	// evidence the probe reached it.
	proxy, present := fixture.Scenarios["deepseek-reverse-proxy-no-password"]
	if !present {
		t.Fatal("the reverse_proxy capture is missing")
	}
	if !proxy.AuthorizationKeyVerified {
		t.Fatal("the reverse_proxy capture does not record authorizationKeyVerified, so Bearer undefined was never checked at the provider")
	}
	if len(proxy.Provider.Requests) == 0 {
		t.Fatal("the reverse_proxy capture recorded no provider request")
	}
	// The doubled slash is the pinned new URL(...).toString() shape, so only the path is asserted here.
	if target := proxy.Provider.Requests[0].RawTarget; target != "/chat/completions" && target != "//chat/completions" {
		t.Fatalf("the reverse_proxy capture dialled %q", target)
	}
}

// TestChatCompletionDeepSeekPlanFoldedMembers is the PLAN-level table: one case per folded member, on
// the plan's own bytes, so a member attached to the wrong message or ordered wrongly fails here even
// when the whole-body digest happens to match some other implementation.
func TestChatCompletionDeepSeekPlanFoldedMembers(t *testing.T) {
	plan := func(t *testing.T, body string) (string, map[string]string, *pinnedChatCompletionFailure) {
		t.Helper()
		parsed, err := decodeOrderedNodeJSON([]byte(body))
		if err != nil {
			t.Fatal(err)
		}
		request, failure := pinnedDeepSeekPlan(parsed, startup.UserDirectories{})
		if failure != nil {
			return "", nil, failure
		}
		headers := map[string]string{}
		for _, header := range request.Headers {
			headers[header.Name] = header.Value
		}
		return string(request.Body), headers, nil
	}
	withMessages := func(extra string) string {
		// A reverse_proxy satisfies the pinned key guard without a secret directory: the guard is
		// `!apiKey && !reverse_proxy`, so a proxy without a password is a legal request (see the test below).
		return `{"model":"deepseek-chat","messages":[{"role":"user","content":"probe"}],"reverse_proxy":"https://probe.example",` + extra + `}`
	}

	cases := []struct {
		name   string
		body   string
		want   []string
		reject []string
	}{
		{
			name: "thinking is always present",
			body: withMessages(`"max_tokens":96`),
			want: []string{`"thinking":{"type":"disabled"}`},
		},
		{
			name: "include_reasoning enables thinking and the effort follows it",
			body: withMessages(`"include_reasoning":true,"reasoning_effort":"low"`),
			want: []string{`"thinking":{"type":"enabled"}`, `"reasoning_effort":"low"`},
		},
		{
			name: "the effort is gated on include_reasoning",
			body: withMessages(`"reasoning_effort":"low"`),
			reject: []string{
				"reasoning_effort",
			},
		},
		{
			name: "logprobs pairs both members",
			body: withMessages(`"logprobs":2`),
			want: []string{`"top_logprobs":2`, `"logprobs":true`},
		},
		{
			name: "a zero logprobs adds nothing",
			body: withMessages(`"logprobs":0`),
			reject: []string{
				"top_logprobs", `"logprobs":true`,
			},
		},
		{
			name: "an empty required array is deleted, a populated one is not",
			body: withMessages(`"tools":[{"type":"function","function":{"name":"a","parameters":{"type":"object","required":[]}}},{"type":"function","function":{"name":"b","parameters":{"type":"object","required":["x"]}}}]`),
			want: []string{`"required":["x"]`},
			reject: []string{
				`"required":[]`,
			},
		},
		{
			name: "a trailing assistant turn gains the prefix mark",
			body: `{"model":"deepseek-chat","messages":[{"role":"user","content":"probe"},{"role":"assistant","content":"tail"}],"reverse_proxy":"https://probe.example"}`,
			want: []string{`"prefix":true`},
		},
		{
			name: "tools suppress the prefix mark",
			body: `{"model":"deepseek-chat","messages":[{"role":"user","content":"probe"},{"role":"assistant","content":"tail"}],"reverse_proxy":"https://probe.example","tools":[{"type":"function","function":{"name":"t","parameters":{}}}]}`,
			reject: []string{
				`"prefix":true`,
			},
		},
		{
			name: "a tool_calls message gains an empty reasoning_content",
			body: `{"model":"deepseek-chat","messages":[{"role":"user","content":"probe"},{"role":"assistant","content":"","tool_calls":[{"id":"c1","type":"function","function":{"name":"t","arguments":"{}"}}]}],"reverse_proxy":"https://probe.example","tools":[{"type":"function","function":{"name":"t","parameters":{}}}]}`,
			want: []string{`"reasoning_content":""`},
		},
		{
			name: "json_schema appends the schema message and the json_object response format",
			body: withMessages(`"json_schema":{"name":"s","value":{"type":"object","properties":{"f":{"type":"string"}}}}`),
			want: []string{`"response_format":{"type":"json_object"}`, `"content":"probe\n\nJSON schema for the response:\n{\n    \"type\": \"object\",\n    \"properties\": {\n        \"f\": {\n            \"type\": \"string\"\n        }\n    }\n}"`},
		},
		{
			name: "seed and stop are forwarded unchanged, including a -1 seed",
			body: withMessages(`"seed":-1,"stop":["A"]`),
			want: []string{`"seed":-1`, `"stop":["A"]`},
		},
	}
	for _, testCase := range cases {
		body, _, failure := plan(t, testCase.body)
		if failure != nil {
			t.Fatalf("%s: the plan refused the request (status %d)", testCase.name, failure.status)
		}
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

	// Member ORDER: reasoning_effort is spread after thinking, so it must follow it in the bytes.
	body, _, failure := plan(t, withMessages(`"include_reasoning":true,"reasoning_effort":"high"`))
	if failure != nil {
		t.Fatalf("the plan refused a valid body: %d", failure.status)
	}
	thinkingAt := strings.Index(body, `"thinking":`)
	effortAt := strings.Index(body, `"reasoning_effort":`)
	if thinkingAt < 0 || effortAt < 0 || effortAt < thinkingAt {
		t.Fatalf("reasoning_effort must follow thinking (thinking at %d, effort at %d): %s", thinkingAt, effortAt, body)
	}
}

// TestChatCompletionDeepSeekReverseProxyWithoutPasswordIsNotRefused pins the pinned guard shape on the
// PLAN: `!apiKey && !reverse_proxy`, so a proxy without a password leaves with `Bearer undefined`.
func TestChatCompletionDeepSeekReverseProxyWithoutPasswordIsNotRefused(t *testing.T) {
	parsed, err := decodeOrderedNodeJSON([]byte(`{"model":"deepseek-chat","messages":[{"role":"user","content":"probe"}],"reverse_proxy":"https://probe.example"}`))
	if err != nil {
		t.Fatal(err)
	}
	request, failure := pinnedDeepSeekPlan(parsed, startup.UserDirectories{})
	if failure != nil {
		t.Fatalf("the plan refused a reverse_proxy without a password (status %d); the pinned guard is !apiKey && !reverse_proxy", failure.status)
	}
	authorization := ""
	for _, header := range request.Headers {
		if strings.EqualFold(header.Name, "authorization") {
			authorization = header.Value
		}
	}
	if authorization != "Bearer undefined" {
		t.Fatalf("authorization = %q, want %q", authorization, "Bearer undefined")
	}
	// The doubled slash is PINNED: `new URL(origin).toString()` appends a trailing slash, so the
	// pinned concatenation yields //chat/completions (the shape MISTRAL recorded too).
	if request.URL != "https://probe.example//chat/completions" {
		t.Fatalf("url = %q, want the pinned new URL(...).toString() + /chat/completions shape", request.URL)
	}
}

// TestChatCompletionDeepSeekMissingKeyIsRefusedBeforeTheFetch is a LABELLED DERIVATION (see the header).
func TestChatCompletionDeepSeekMissingKeyIsRefusedBeforeTheFetch(t *testing.T) {
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
	t.Setenv(pinnedDeepSeekSeamEnv, "http://"+address.String())

	scenario := chatCompletionTestScenario()
	origin, cookie, token := startChatCompletionTestServer(t, scenario)
	body := `{"chat_completion_source":"deepseek","model":"deepseek-chat","messages":[{"role":"user","content":"probe"}],"max_tokens":64,"stream":false}`
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

// TestChatCompletionDeepSeekTransportFailureAnswers200 is a LABELLED DERIVATION (see the header).
func TestChatCompletionDeepSeekTransportFailureAnswers200(t *testing.T) {
	t.Setenv(pinnedDeepSeekSeamEnv, closedLoopbackOrigin(t))
	scenario := chatCompletionTestScenario()
	scenario.Secrets = map[string]any{
		"api_key_deepseek": []any{map[string]any{"id": "probe", "value": "synthetic-deepseek-key", "label": "probe", "active": true}},
	}
	origin, cookie, token := startChatCompletionTestServer(t, scenario)
	body := `{"chat_completion_source":"deepseek","model":"deepseek-chat","messages":[{"role":"user","content":"probe"}],"max_tokens":64,"stream":false}`
	status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, body)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want the pinned 200 (body %q); CLAUDE's 500 is the wrong contract here", status, text)
	}
	if text != `{"error":true}` {
		t.Fatalf("body = %q, want {error:true}", text)
	}
}

// TestChatCompletionDeepSeekSeamDefault pins the seam default to the recorded literal and the targets
// it builds.
func TestChatCompletionDeepSeekSeamDefault(t *testing.T) {
	fixture := loadDeepSeekWireFixture(t)
	recorded, present := fixture.Seams[pinnedDeepSeekSeamEnv]
	if !present {
		t.Fatalf("the fixture does not record a seam named %q", pinnedDeepSeekSeamEnv)
	}
	t.Setenv(pinnedDeepSeekSeamEnv, "")
	if got := pinnedDeepSeekBaseURL(); got != recorded.PinnedLiteral {
		t.Fatalf("default DeepSeek base = %q, the fixture recorded the pinned literal %q", got, recorded.PinnedLiteral)
	}
	if pinnedDeepSeekAPIURL != recorded.PinnedLiteral {
		t.Fatalf("the Go literal %q and the fixture's recorded literal %q disagree", pinnedDeepSeekAPIURL, recorded.PinnedLiteral)
	}
	// The status route asks for /models on the host ROOT: the pinned expression strips /beta.
	if got := pinnedDeepSeekStatusBaseURL(); got != "https://api.deepseek.com" {
		t.Fatalf("status base = %q, want the pinned literal without /beta", got)
	}
	targets := 0
	for name, scenario := range fixture.Scenarios {
		if scenario.TargetPath != chatCompletionSourceDeepSeek {
			continue
		}
		targets++
		switch target := scenario.Provider.Requests[0].RawTarget; target {
		case "/chat/completions", "//chat/completions":
		default:
			t.Fatalf("%s: provider target %q is not a path the pinned literal builds (want /chat/completions, or //chat/completions for a reverse_proxy normalized to a trailing slash)", name, target)
		}
	}
	if targets < 10 {
		t.Fatalf("only %d deepseek scenario(s) carry a provider request, so the seam claim is under-exercised", targets)
	}
}

// TestChatCompletionDeepSeekStreamHasNonStreamControl proves the pair is the same answer and that the
// terminator is DeepSeek's own [DONE].
func TestChatCompletionDeepSeekStreamHasNonStreamControl(t *testing.T) {
	fixture := loadDeepSeekWireFixture(t)
	control, hasControl := fixture.Scenarios["deepseek-stream-control-nonstream"]
	stream, hasStream := fixture.Scenarios["deepseek-stream"]
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
