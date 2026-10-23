package server

// What the XAI increment needs that the recorded differential cannot state on its own.
//
//  1. THE SEAM DEFAULT. API_XAI is a pinned LITERAL used by BOTH the generate route (:1184) and the
//     status arm (:1827), and the replay points the Go leg at the recording peer through
//     GOTAVERN_XAI_CHAT_URL. Every provider request in a green replay therefore carries the SEAM value,
//     never the default, so a default that drifted away from the pinned literal would leave the replay
//     green and the product wrong. It is asserted here against the literal the FIXTURE recorded.
//
//  2. THE FOLDED MEMBERS, ONE PLAN-LEVEL CASE EACH. The differential compares whole-body digests, so a
//     member attached to the wrong message, mirrored by a compensating mistake, or emitted where pinned
//     omits it entirely can still round-trip. Each case below drives pinnedXAIPlan and inspects the
//     body and headers IT BUILT: the reasoning_effort MAP (medium -> low), the stop non-empty rule, the
//     logprobs pair, tools/tool_choice, the json_schema fold's member order and `strict ?? true`
//     default, and the convertXAIMessages shaping -- including the two guards that look like bugs and
//     are not: an UNMATCHED named message loses its name anyway, and a named USER message keeps it.
//
//  3. THE TWO BRANCHES THE PROBE CANNOT RECORD. It requires every scenario to record at least one
//     provider request, so a pre-fetch refusal (missing key, :1187) and a thrown fetch (:1274-1281)
//     cannot appear in it. Both are LABELLED DERIVATIONS (AGENTS.md rule 4): the status and body come
//     from those pinned lines, and what is asserted beyond them is the observable half -- the exact
//     response and, for the refusal, that the peer received NOTHING.
//
// The /status arm exists pinned (:1826-1829), so it also gets a rule-17 HTTP test: xai must reach its
// arm while a source with no arm (ai21) still answers 501 with zero outbound.

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

type xaiWireFixture struct {
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
			// The raw response body, kept undecoded so a non-stream answer and an error answer can both
			// be asserted on their own bytes: an error body carries no `choices`, so decoding it into a
			// completion shape would silently assert nothing.
			Body json.RawMessage `json:"body"`
		} `json:"providerResponse"`
	} `json:"scenarios"`
}

func loadXAIWireFixture(t *testing.T) xaiWireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture xaiWireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) == 0 {
		t.Fatal("the provider-wire fixture records no scenarios")
	}
	return fixture
}

func xaiScenarioBody(t *testing.T, fixture xaiWireFixture, name string) string {
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

// TestChatCompletionXAICoversItsBranches refuses to run a suite that cannot discriminate.
func TestChatCompletionXAICoversItsBranches(t *testing.T) {
	fixture := loadXAIWireFixture(t)
	required := []string{
		"xai-nonstream",
		"xai-stream",
		"xai-stream-control-nonstream",
		"xai-json-schema",
		"xai-reasoning-effort-mapped",
		"xai-error-status",
		"xai-error-status-nonjson",
		"xai-status",
		"xai-status-nonok",
	}
	for _, name := range required {
		scenario, present := fixture.Scenarios[name]
		if !present {
			t.Fatalf("the fixture has no capture for %q, so that observable is unproven", name)
		}
		if scenario.TargetPath != chatCompletionSourceXAI {
			t.Fatalf("%s: targetPath = %q, want %q", name, scenario.TargetPath, chatCompletionSourceXAI)
		}
		if len(scenario.Provider.Requests) == 0 {
			t.Fatalf("%s: the capture records no provider request", name)
		}
	}
}

// TestChatCompletionXAICapturesCarryTheFoldedMembers states, on the CAPTURES, what the plan-level
// table below states on the plan. Each case names one folded member so a failure says which one moved.
func TestChatCompletionXAICapturesCarryTheFoldedMembers(t *testing.T) {
	fixture := loadXAIWireFixture(t)
	cases := []struct {
		name     string
		scenario string
		want     []string
		reject   []string
	}{
		{
			name:     "the message converter prefixes assistant and example turns and drops their names",
			scenario: "xai-nonstream",
			want:     []string{`"role":"assistant","content":"Probe Char: probe assistant marker"`, `"role":"system","content":"Probe Char: probe example assistant marker"`, `"role":"system","content":"Probe User: probe example user marker"`},
			reject:   []string{"example_assistant", "example_user"},
		},
		{
			name:     "a named USER turn keeps its name while an unmatched named system turn loses it",
			scenario: "xai-nonstream",
			want:     []string{`"role":"user","name":"Probe User","content":"probe user marker"`, `"role":"system","content":"Probe Group: probe group marker"`},
		},
		{
			name:     "the base members follow `messages` and include max_completion_tokens and n",
			scenario: "xai-nonstream",
			want:     []string{`{"messages":[`, `"max_completion_tokens":96`, `"n":2`, `"stop":["PROBE_STOP"]`, `"seed":7`},
		},
		{
			name:     "logprobs pairs top_logprobs with logprobs, tools carry tool_choice, and the schema folds",
			scenario: "xai-json-schema",
			want: []string{
				`"top_logprobs":3`,
				`"logprobs":true`,
				`"tool_choice":"auto"`,
				`"reasoning_effort":"high"`,
				`"response_format":{"type":"json_schema","json_schema":{"name":"probe_schema","strict":true,"schema":{"type":"object","properties":{"answer":{"type":"string"}}}}}`,
			},
			reject: []string{"description"},
		},
		{
			name:     "reasoning_effort is MAPPED, not copied: medium becomes low",
			scenario: "xai-reasoning-effort-mapped",
			want:     []string{`"reasoning_effort":"low"`},
			reject:   []string{`"reasoning_effort":"medium"`, `"stop":[]`, `"tools":`, `"tool_choice":`},
		},
	}
	for _, testCase := range cases {
		body := xaiScenarioBody(t, fixture, testCase.scenario)
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

	// The provider-side error observables are the RESPONSE, not the request: xAI answers 500 with the
	// PARSED provider body, falling back to {error:true} only when that body is not JSON. Asserting on
	// the response bytes is what separates xAI's branch from the shared path's 200
	// {error:{message},quota_error} envelope, which would carry neither the provider's own members nor
	// a 500.
	for _, testCase := range []struct {
		name     string
		scenario string
		want     string
	}{
		{
			name:     "a JSON provider error is passed through at 500",
			scenario: "xai-error-status",
			want:     `{"error":{"message":"probe rate limited","type":"rate_limit_error"}}`,
		},
		{
			name:     "a NON-JSON provider error falls back to {error:true} at 500",
			scenario: "xai-error-status-nonjson",
			want:     `{"error":true}`,
		},
	} {
		scenario, present := fixture.Scenarios[testCase.scenario]
		if !present {
			t.Fatalf("the fixture has no capture for %q", testCase.scenario)
		}
		if scenario.ProviderResponse.Status != http.StatusInternalServerError {
			t.Fatalf("%s: the captured response status is %d, want the pinned 500", testCase.name, scenario.ProviderResponse.Status)
		}
		if got := string(scenario.ProviderResponse.Body); got != testCase.want {
			t.Fatalf("%s: the captured response body is %q, want %q", testCase.name, got, testCase.want)
		}
	}

	// The status arm's own observable: a provider non-2xx stays a 200 envelope.
	if scenario, present := fixture.Scenarios["xai-status-nonok"]; present {
		if scenario.ProviderResponse.Status != http.StatusOK {
			t.Fatalf("xai-status-nonok: the captured response status is %d, want the shared 200", scenario.ProviderResponse.Status)
		}
		if got := string(scenario.ProviderResponse.Body); got != `{"error":true,"data":{"data":[]}}` {
			t.Fatalf("xai-status-nonok: the captured response body is %q, want the shared envelope", got)
		}
	} else {
		t.Fatal("the fixture has no capture for xai-status-nonok")
	}

	// The secret NAME is verified at record time (the fixture does not store the planted key), so the
	// flag is the evidence it happened. A future re-record that plants the key under a name the code
	// does not read fails here instead of silently recording an unauthenticated capture.
	for _, name := range []string{"xai-nonstream", "xai-status"} {
		scenario, present := fixture.Scenarios[name]
		if !present {
			t.Fatalf("the fixture has no capture for %q", name)
		}
		if !scenario.AuthorizationKeyVerified {
			t.Fatalf("%s: the capture does not record authorizationKeyVerified, so api_key_xai was never checked at the provider", name)
		}
	}
}

// TestChatCompletionXAIPlanFoldedMembers is the PLAN-level table: one case per folded member, on the
// plan's own bytes and headers, so a member attached to the wrong message or ordered wrongly fails here
// even when the whole-body digest happens to match some other implementation.
func TestChatCompletionXAIPlanFoldedMembers(t *testing.T) {
	plan := func(t *testing.T, body string) (string, map[string]string, *pinnedChatCompletionFailure) {
		t.Helper()
		parsed, err := decodeOrderedNodeJSON([]byte(body))
		if err != nil {
			t.Fatal(err)
		}
		request, failure := pinnedXAIPlan(parsed, startup.UserDirectories{})
		if failure != nil {
			return "", nil, failure
		}
		headers := map[string]string{}
		for _, header := range request.Headers {
			headers[header.Name] = header.Value
		}
		return string(request.Body), headers, nil
	}
	// A reverse_proxy satisfies the pinned key guard without a secret directory: the guard is
	// `!apiKey && !reverse_proxy`, so a proxy without a password is a legal request.
	withMessages := func(extra string) string {
		return `{"model":"grok-probe","messages":[{"role":"user","content":"probe"}],"reverse_proxy":"https://probe.example",` + extra + `}`
	}

	cases := []struct {
		name   string
		body   string
		want   []string
		reject []string
	}{
		{
			name: "the body starts with messages and carries the xai-only sampling members",
			body: withMessages(`"max_tokens":64,"max_completion_tokens":96,"temperature":0.5,"presence_penalty":0.1,"frequency_penalty":0.2,"top_p":0.9,"seed":7,"n":2`),
			want: []string{`{"messages":[{"role":"user","content":"probe"}],"model":"grok-probe","temperature":0.5,"max_tokens":64,"max_completion_tokens":96,"presence_penalty":0.1,"frequency_penalty":0.2,"top_p":0.9,"seed":7,"n":2}`},
		},
		{
			name: "a member the xai base list does not name is NOT forwarded",
			body: withMessages(`"top_k":40,"logit_bias":{"1":2}`),
			reject: []string{
				`"top_k"`, `"logit_bias"`,
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
			name: "stop is forwarded only when the array is non-empty",
			body: withMessages(`"stop":["A","B"]`),
			want: []string{`"stop":["A","B"]`},
		},
		{
			name: "an empty stop array is dropped, not forwarded as []",
			body: withMessages(`"stop":[]`),
			reject: []string{
				`"stop"`,
			},
		},
		{
			name: "reasoning_effort high survives the map",
			body: withMessages(`"reasoning_effort":"high"`),
			want: []string{`"reasoning_effort":"high"`},
		},
		{
			name: "reasoning_effort is MAPPED: medium becomes low",
			body: withMessages(`"reasoning_effort":"medium"`),
			want: []string{`"reasoning_effort":"low"`},
			reject: []string{
				`"reasoning_effort":"medium"`,
			},
		},
		{
			name: "a falsy reasoning_effort adds nothing",
			body: withMessages(`"reasoning_effort":false,"stream":false`),
			reject: []string{
				"reasoning_effort",
			},
		},
		{
			name: "tools are raw and tool_choice rides beside them",
			body: withMessages(`"tools":[{"type":"function","function":{"name":"t","parameters":{}}}],"tool_choice":"required"`),
			want: []string{`"tools":[{"type":"function","function":{"name":"t","parameters":{}}}],"tool_choice":"required"`},
		},
		{
			name: "tools without a tool_choice omit the member entirely rather than sending a null",
			body: withMessages(`"tools":[{"type":"function","function":{"name":"t","parameters":{}}}]`),
			want: []string{
				`"tools":[`,
			},
			reject: []string{
				"tool_choice",
			},
		},
		{
			name: "an empty tools array adds neither member",
			body: withMessages(`"tools":[]`),
			reject: []string{
				`"tools"`, "tool_choice",
			},
		},
		{
			name: "json_schema folds with xai's own member order and strict defaulting to true",
			body: withMessages(`"json_schema":{"name":"s","value":{"type":"object","properties":{"f":{"type":"string"}}}}`),
			want: []string{`"response_format":{"type":"json_schema","json_schema":{"name":"s","strict":true,"schema":{"type":"object","properties":{"f":{"type":"string"}}}}}`},
		},
		{
			name: "json_schema honours an explicit strict:false and never adds a description",
			body: withMessages(`"json_schema":{"name":"s","strict":false,"description":"probe","value":{"type":"object"}}`),
			want: []string{`"response_format":{"type":"json_schema","json_schema":{"name":"s","strict":false,"schema":{"type":"object"}}}`},
			reject: []string{
				"description",
			},
		},
		{
			name: "a named assistant turn gains the character prefix and loses its name",
			body: `{"model":"grok-probe","char_name":"Char","messages":[{"role":"assistant","name":"Char","content":"tail"}],"reverse_proxy":"https://probe.example"}`,
			want: []string{`"messages":[{"role":"assistant","content":"Char: tail"}]`},
		},
		{
			name: "an assistant turn already carrying the prefix is not prefixed twice",
			body: `{"model":"grok-probe","char_name":"Char","messages":[{"role":"assistant","name":"Char","content":"Char: tail"}],"reverse_proxy":"https://probe.example"}`,
			want: []string{`"content":"Char: tail"`},
			reject: []string{
				"Char: Char: tail",
			},
		},
		{
			name: "a group-name prefix suppresses the character prefix",
			body: `{"model":"grok-probe","char_name":"Char","group_names":["Group"],"messages":[{"role":"assistant","name":"Char","content":"Group: tail"}],"reverse_proxy":"https://probe.example"}`,
			want: []string{`"content":"Group: tail"`},
			reject: []string{
				"Char: Group: tail",
			},
		},
		{
			name: "example_user takes the USER name, example_assistant the character name",
			body: `{"model":"grok-probe","char_name":"Char","user_name":"User","messages":[{"role":"system","name":"example_user","content":"u"},{"role":"system","name":"example_assistant","content":"a"}],"reverse_proxy":"https://probe.example"}`,
			want: []string{`{"role":"system","content":"User: u"}`, `{"role":"system","content":"Char: a"}`},
			reject: []string{
				"example_user", "example_assistant",
			},
		},
		{
			name: "a named USER turn KEEPS its name: the converter returns before delete msg.name",
			body: `{"model":"grok-probe","char_name":"Char","user_name":"User","messages":[{"role":"user","name":"User","content":"hello"}],"reverse_proxy":"https://probe.example"}`,
			want: []string{`"messages":[{"role":"user","name":"User","content":"hello"}]`},
		},
		{
			name: "an unmatched named turn loses its name anyway and keeps its content",
			body: `{"model":"grok-probe","char_name":"Char","user_name":"User","messages":[{"role":"tool","name":"Peer","content":"result"}],"reverse_proxy":"https://probe.example"}`,
			want: []string{`"messages":[{"role":"tool","content":"result"}]`},
		},
		{
			name: "an unnamed turn is untouched, tool_calls included: there is no merge, no re-role, no prefix flag",
			body: `{"model":"grok-probe","char_name":"Char","user_name":"User","messages":[{"role":"user","content":"a"},{"role":"user","content":"b"},{"role":"assistant","content":"","tool_calls":[{"id":"c1","type":"function","function":{"name":"t","arguments":"{}"}}]}],"reverse_proxy":"https://probe.example"}`,
			want: []string{`{"role":"user","content":"a"},{"role":"user","content":"b"}`, `"tool_calls":[{"id":"c1","type":"function","function":{"name":"t","arguments":"{}"}}]`},
			reject: []string{
				`"prefix":true`, "reasoning_content",
			},
		},
		{
			name: "a non-array messages member becomes an empty array",
			body: `{"model":"grok-probe","messages":"probe","reverse_proxy":"https://probe.example"}`,
			want: []string{`"messages":[]`},
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

	// Member ORDER: bodyParams is spread LAST, so every folded member follows `n` in the bytes.
	body, _, failure := plan(t, withMessages(`"n":2,"logprobs":1,"stop":["A"],"reasoning_effort":"high","tools":[{"type":"function","function":{"name":"t"}}],"json_schema":{"name":"s","value":{}}`))
	if failure != nil {
		t.Fatalf("the plan refused a valid body: %d", failure.status)
	}
	lastBaseAt := strings.Index(body, `"n":2`)
	if lastBaseAt < 0 {
		t.Fatalf("the plan does not carry n: %s", body)
	}
	for _, folded := range []string{`"top_logprobs":`, `"logprobs":`, `"tools":`, `"stop":`, `"reasoning_effort":`, `"response_format":`} {
		at := strings.Index(body, folded)
		if at < 0 {
			t.Fatalf("the plan does not carry %s: %s", folded, body)
		}
		if at < lastBaseAt {
			t.Fatalf("%s must follow the base members (base ends at %d, member at %d): %s", folded, lastBaseAt, at, body)
		}
	}
	if messagesAt := strings.Index(body, `"messages":`); messagesAt != 1 {
		t.Fatalf("messages must be the FIRST member (at %d): %s", messagesAt, body)
	}

	// The header set the plan builds: node-fetch's own defaults plus the pinned config headers.
	_, headers, failure := plan(t, withMessages(`"stream":false`))
	if failure != nil {
		t.Fatalf("the plan refused a valid body: %d", failure.status)
	}
	for name, want := range map[string]string{
		"content-type":    "application/json",
		"authorization":   "Bearer undefined",
		"accept":          "*/*",
		"accept-encoding": "gzip, deflate, br",
		"user-agent":      "node-fetch",
	} {
		if headers[name] != want {
			t.Fatalf("header %s = %q, want %q", name, headers[name], want)
		}
	}
	if headers["content-length"] == "" {
		t.Fatal("the plan does not set content-length")
	}
	if _, present := headers["x-api-key"]; present {
		t.Fatal("xai authenticates with Authorization, never x-api-key (that is CLAUDE)")
	}
}

// TestChatCompletionXAIReverseProxyWithoutPasswordIsNotRefused pins the pinned guard shape on the PLAN:
// `!apiKey && !reverse_proxy`, so a proxy without a password leaves with `Bearer undefined`.
func TestChatCompletionXAIReverseProxyWithoutPasswordIsNotRefused(t *testing.T) {
	parsed, err := decodeOrderedNodeJSON([]byte(`{"model":"grok-probe","messages":[{"role":"user","content":"probe"}],"reverse_proxy":"https://probe.example"}`))
	if err != nil {
		t.Fatal(err)
	}
	request, failure := pinnedXAIPlan(parsed, startup.UserDirectories{})
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
	// The doubled slash is PINNED: `new URL(origin).toString()` appends a trailing slash, so the pinned
	// concatenation yields //chat/completions.
	if request.URL != "https://probe.example//chat/completions" {
		t.Fatalf("url = %q, want the pinned new URL(...).toString() + /chat/completions shape", request.URL)
	}
}

// TestChatCompletionXAISeamDefault pins the seam default to the recorded literal and the targets it
// builds, for BOTH routes that read it (generate and /status).
func TestChatCompletionXAISeamDefault(t *testing.T) {
	fixture := loadXAIWireFixture(t)
	recorded, present := fixture.Seams[pinnedXAISeamEnv]
	if !present {
		t.Fatalf("the fixture does not record a seam named %q", pinnedXAISeamEnv)
	}
	t.Setenv(pinnedXAISeamEnv, "")
	if got := pinnedXAIBaseURL(); got != recorded.PinnedLiteral {
		t.Fatalf("default xAI base = %q, the fixture recorded the pinned literal %q", got, recorded.PinnedLiteral)
	}
	if pinnedXAIAPIURL != recorded.PinnedLiteral {
		t.Fatalf("the Go literal %q and the fixture's recorded literal %q disagree", pinnedXAIAPIURL, recorded.PinnedLiteral)
	}
	t.Setenv(pinnedXAISeamEnv, "http://127.0.0.1:1")
	if got := pinnedXAIBaseURL(); got != "http://127.0.0.1:1" {
		t.Fatalf("the seam is not honoured: %q", got)
	}
	t.Setenv(pinnedXAISeamEnv, "")

	generateTargets, statusTargets := 0, 0
	for name, scenario := range fixture.Scenarios {
		if scenario.TargetPath != chatCompletionSourceXAI {
			continue
		}
		if len(scenario.Provider.Requests) == 0 {
			t.Fatalf("%s: the capture records no provider request", name)
		}
		switch scenario.Provider.Requests[0].Method {
		case http.MethodPost:
			generateTargets++
			switch target := scenario.Provider.Requests[0].RawTarget; target {
			case "/chat/completions", "//chat/completions":
			default:
				t.Fatalf("%s: provider target %q is not a path the pinned literal builds", name, target)
			}
		case http.MethodGet:
			statusTargets++
			if target := scenario.Provider.Requests[0].RawTarget; target != "/models" {
				t.Fatalf("%s: status target %q, want the pinned urlJoin(apiUrl, '/models') path", name, target)
			}
		default:
			t.Fatalf("%s: unexpected provider method %q", name, scenario.Provider.Requests[0].Method)
		}
	}
	if generateTargets < 5 {
		t.Fatalf("only %d xai generate scenario(s) carry a provider request, so the seam claim is under-exercised", generateTargets)
	}
	// The status arm reads the SAME literal with no transformation, so its scenarios must exist too:
	// unlike DEEPSEEK there is no /beta to strip and no second seam.
	if statusTargets < 2 {
		t.Fatalf("only %d xai /status scenario(s) carry a provider request, want the ok and provider-non-2xx pair", statusTargets)
	}
}

// TestChatCompletionXAIStreamHasNonStreamControl proves the pair is the same answer and that the
// terminator is the provider's own [DONE].
func TestChatCompletionXAIStreamHasNonStreamControl(t *testing.T) {
	fixture := loadXAIWireFixture(t)
	control, hasControl := fixture.Scenarios["xai-stream-control-nonstream"]
	stream, hasStream := fixture.Scenarios["xai-stream"]
	if !hasControl || !hasStream {
		t.Fatalf("the control/stream pair is missing (control %v, stream %v)", hasControl, hasStream)
	}
	if len(control.ProviderResponse.Body) == 0 {
		t.Fatal("the control captured no response body")
	}
	var controlBody struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(control.ProviderResponse.Body, &controlBody); err != nil {
		t.Fatalf("the control's response body is not a completion (%q): %v", control.ProviderResponse.Body, err)
	}
	if len(controlBody.Choices) == 0 {
		t.Fatal("the control captured no message content")
	}
	controlText := controlBody.Choices[0].Message.Content
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

// TestChatCompletionXAIIsNotTheDefaultRefusal proves the source reaches a served branch: the plan builds
// a request for xai, while a source this lane does not implement still answers 501.
func TestChatCompletionXAIIsNotTheDefaultRefusal(t *testing.T) {
	directories := startup.UserDirectories{}
	body, decodeErr := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"xai","model":"grok-probe","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	if _, failure := pinnedChatCompletionPlan(body, directories, ""); failure != nil && failure.status == http.StatusNotImplemented {
		t.Fatal("xai is answered by the default 501 branch; its plan case is missing")
	}
	unimplemented, unimplementedErr := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"ai21","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if unimplementedErr != nil {
		t.Fatal(unimplementedErr)
	}
	if _, failure := pinnedChatCompletionPlan(unimplemented, directories, ""); failure == nil || failure.status != http.StatusNotImplemented {
		t.Fatalf("a source this lane does not implement must answer 501, got %+v", failure)
	}
}

// TestChatCompletionXAIStatusIsNotA501Gap is rule 17 at the HTTP level for the /status arm: an
// implemented source and an unimplemented one must not answer the same thing. Both assertions are
// HTTP-level and need no network beyond the loopback peer.
func TestChatCompletionXAIStatusIsNotA501Gap(t *testing.T) {
	scenario := providerWireScenario{}
	scenario.Request.Path = "/api/backends/chat-completions/status"
	origin, cookie, token := startChatCompletionTestServer(t, scenario)

	peer := mockprovider.NewKeyed(nil)
	address, err := peer.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	// No scripted answer: the peer replies 500, which is a NON-2xx provider answer and therefore the
	// shared envelope's branch. The envelope's own content is pinned by xai-status-nonok.
	mockOrigin := "http://" + address.String()

	for _, testCase := range []struct {
		name         string
		body         string
		wantStatus   int
		wantBody     string
		wantOutbound int
	}{
		{
			name:         "xai reaches its arm",
			body:         `{"chat_completion_source":"xai","reverse_proxy":"` + mockOrigin + `"}`,
			wantStatus:   http.StatusOK,
			wantBody:     `{"error":true,"data":{"data":[]}}`,
			wantOutbound: 1,
		},
		{
			name:         "a source with no arm stays a gap",
			body:         `{"chat_completion_source":"ai21"}`,
			wantStatus:   http.StatusNotImplemented,
			wantBody:     "Not Implemented",
			wantOutbound: 0,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			peer.Reset(nil)
			status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, testCase.body)
			if status != testCase.wantStatus {
				t.Fatalf("status = %d, want %d (body %q)", status, testCase.wantStatus, text)
			}
			if text != testCase.wantBody {
				t.Fatalf("body = %q, want %q", text, testCase.wantBody)
			}
			if recorded := peer.Recording().Requests; len(recorded) != testCase.wantOutbound {
				t.Fatalf("the peer received %d request(s), want %d", len(recorded), testCase.wantOutbound)
			}
		})
	}
}

// TestChatCompletionXAIMissingKeyIsRefusedBeforeTheFetch is a LABELLED DERIVATION (see the header):
// the pinned route answers 400 {"error":true} at :1187 before the fetch, so no scenario can record it
// (the provider-wire probe refuses a capture with zero provider requests). The observable asserted
// beyond the pinned status/body is the zero-request half.
func TestChatCompletionXAIMissingKeyIsRefusedBeforeTheFetch(t *testing.T) {
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
	t.Setenv(pinnedXAISeamEnv, "http://"+address.String())

	scenario := chatCompletionTestScenario()
	origin, cookie, token := startChatCompletionTestServer(t, scenario)
	body := `{"chat_completion_source":"xai","model":"grok-probe","messages":[{"role":"user","content":"probe"}],"max_tokens":64,"stream":false}`
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

// TestChatCompletionXAIStatusNoKeyIsRefusedBeforeTheFetch is a LABELLED DERIVATION: /status answers 400
// {"error":true} at :2067-2070 when the key is missing and no reverse_proxy is supplied, so it cannot be
// recorded either. The xai-status scenario covers the arm PRESENT; this covers its refusal shape.
func TestChatCompletionXAIStatusNoKeyIsRefusedBeforeTheFetch(t *testing.T) {
	scenario := chatCompletionTestScenario()
	scenario.Request.Path = "/api/backends/chat-completions/status"
	recorder := mockprovider.New([]mockprovider.Response{{
		Status:  200,
		Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json"}},
		Body:    `{"data":[]}`,
	}})
	address, err := recorder.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = recorder.Close() })
	t.Setenv(pinnedXAISeamEnv, "http://"+address.String())

	origin, cookie, token := startChatCompletionTestServer(t, scenario)
	status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, `{"chat_completion_source":"xai"}`)
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want the pinned 400 (body %q)", status, text)
	}
	if text != `{"error":true}` {
		t.Fatalf("body = %q, want {error:true}", text)
	}
	if recorded := recorder.Recording(); len(recorded.Requests) != 0 {
		t.Fatalf("the provider received %d request(s) although the key check rejects the status call before the fetch", len(recorded.Requests))
	}
}

// TestChatCompletionXAITransportFailureAnswers200 is a LABELLED DERIVATION (see the header).
func TestChatCompletionXAITransportFailureAnswers200(t *testing.T) {
	t.Setenv(pinnedXAISeamEnv, closedLoopbackOrigin(t))
	scenario := chatCompletionTestScenario()
	scenario.Secrets = map[string]any{
		"api_key_xai": []any{map[string]any{"id": "probe", "value": "synthetic-xai-key", "label": "probe", "active": true}},
	}
	origin, cookie, token := startChatCompletionTestServer(t, scenario)
	body := `{"chat_completion_source":"xai","model":"grok-probe","messages":[{"role":"user","content":"probe"}],"max_tokens":64,"stream":false}`
	status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, body)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want the pinned 200 (body %q); CLAUDE's 500 is the wrong contract here", status, text)
	}
	if text != `{"error":true}` {
		t.Fatalf("body = %q, want {error:true}", text)
	}
}
