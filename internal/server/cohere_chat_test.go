package server

// What the COHERE increment needs that the recorded differential cannot state on its own.
//
//  1. THE TWO SEAM DEFAULTS. Cohere has TWO pinned literals: the chat route reads API_COHERE_V2 (:1039) and
//     the status arm reads API_COHERE_V1 (:1806), and neither is derived from the other. Both are hardcoded
//     in pinned, so every provider request in a green replay carries a SEAM value and a default that drifted
//     away from its literal would leave the replay green and the product wrong. Each default is asserted
//     against the literal the FIXTURE recorded for that seam, not against a constant agreeing with itself.
//
//  2. THE FOLDS, ON THE PLAN. The recorded captures show the bytes pinned sent; these assertions drive
//     pinnedCoherePlan and inspect the request IT builds -- the body member ORDER, the renames
//     (top_k -> k, top_p -> p, stop -> stop_sequences), the two unconditional members (documents, tools), the
//     always-present Boolean stream, the safety_mode condition, the tool `$schema` deletion, the
//     response_format shape with the route-level flatten applied, and the message converter's name prefixes,
//     tool_calls rewrite and -- the part a tidy rewrite loses -- the forEach/splice SKIP.
//
//  3. THE SOURCE IS SERVED, NOT REFUSED. Cohere must not fall to the default 501 branch, and a source this
//     package still has no transport for (ai21) must keep answering 501, so "not implemented" never becomes
//     indistinguishable from "implemented but failing".
//
//  4. THE STATUS ARM. Cohere HAS a pinned arm, so /status must reach it, and the answer must be the SHARED
//     tail's: the provider body unchanged on 2xx (the :2112-2114 models fold happens AFTER
//     `statusResponse.send(data)` at :2110 and is therefore unobservable), 200 {error:true,data:{data:[]}} on
//     a non-2xx provider answer, and 400 {error:true} with ZERO outbound requests when no key is stored. The
//     noKey case CANNOT be recorded by tools/probe-provider-wire.mjs -- assertProviderBodyDigests refuses a
//     capture with no provider request at all -- so it is a labelled DERIVATION from :2067-2070, pinned at the
//     HTTP level with an outbound count rather than dressed up as a recording.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

type cohereWireFixture struct {
	Scenarios map[string]struct {
		GoSeam struct {
			EnvironmentVariable string `json:"environmentVariable"`
			PinnedLiteral       string `json:"pinnedLiteral"`
		} `json:"goSeam"`
	} `json:"scenarios"`
}

func loadCohereWireFixture(t *testing.T) cohereWireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture cohereWireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	// Refuse to pass vacuously: the scenarios this test reasons about must exist.
	for _, required := range []string{
		"cohere-nonstream", "cohere-stream", "cohere-stream-control-nonstream", "cohere-error-status",
		"cohere-folds", "cohere-message-names", "cohere-tool-calls", "cohere-status", "cohere-status-nonok",
	} {
		if _, exists := fixture.Scenarios[required]; !exists {
			// Expected to be RED until the Linux oracle job records the cohere scenarios and its patch is
			// applied: this lane deliberately records NO fixture (the oracle does, so the capture can only come
			// from the pinned server). Failing rather than skipping keeps a missing capture from reading green.
			t.Fatalf("the provider-wire fixture records no %q scenario yet; the Linux oracle records it and publishes the patch", required)
		}
	}
	return fixture
}

// TestChatCompletionCohereSeamDefaults pins BOTH defaults against the fixture's recorded literals.
func TestChatCompletionCohereSeamDefaults(t *testing.T) {
	fixture := loadCohereWireFixture(t)
	seen := map[string]string{}
	for name, scenario := range fixture.Scenarios {
		if !strings.HasPrefix(name, "cohere-") {
			continue
		}
		if scenario.GoSeam.EnvironmentVariable == "" {
			t.Fatalf("%s records no seam, so nothing would aim the Go leg at the recording peer", name)
		}
		seen[scenario.GoSeam.EnvironmentVariable] = scenario.GoSeam.PinnedLiteral
	}
	for _, pair := range []struct {
		environmentVariable string
		literal             string
		accessor            func() string
	}{
		{pinnedCohereSeamEnv, pinnedCohereAPIURL, pinnedCohereBaseURL},
		{pinnedCohereStatusSeamEnv, pinnedCohereStatusAPIURL, pinnedCohereStatusBaseURL},
	} {
		recorded, exists := seen[pair.environmentVariable]
		if !exists {
			t.Fatalf("no cohere scenario records the %s seam", pair.environmentVariable)
		}
		if recorded != pair.literal {
			t.Fatalf("%s: the Go literal %q and the fixture's recorded literal %q disagree",
				pair.environmentVariable, pair.literal, recorded)
		}
		t.Setenv(pair.environmentVariable, "")
		if got := pair.accessor(); got != pair.literal {
			t.Fatalf("default for %s = %q, want the pinned literal %q", pair.environmentVariable, got, pair.literal)
		}
		t.Setenv(pair.environmentVariable, "http://127.0.0.1:1")
		if got := pair.accessor(); got != "http://127.0.0.1:1" {
			t.Fatalf("the %s seam is not honoured: %q", pair.environmentVariable, got)
		}
	}
	// The two literals are DIFFERENT pinned constants; a single seam serving both would be a divergence.
	if pinnedCohereAPIURL == pinnedCohereStatusAPIURL {
		t.Fatal("the chat and status literals are the same string; the pinned source has two")
	}
}

// cohereTestDirectories is a user root whose secrets.json uses the pinned array shape.
func cohereTestDirectories(t *testing.T, key string) startup.UserDirectories {
	t.Helper()
	root := t.TempDir()
	secrets := `{"api_key_cohere":[{"id":"probe-id","value":"` + key + `","label":"probe","active":true}]}`
	if err := os.WriteFile(filepath.Join(root, "secrets.json"), []byte(secrets), 0o600); err != nil {
		t.Fatal(err)
	}
	return startup.UserDirectories{"root": root}
}

func coherePlanRequest(t *testing.T, bodyText string, directories startup.UserDirectories) *outbound.Request {
	t.Helper()
	body, decodeErr := decodeOrderedNodeJSON([]byte(bodyText))
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	request, failure := pinnedCoherePlan(body, directories)
	if failure != nil {
		t.Fatalf("the cohere plan failed with status %d", failure.status)
	}
	return request
}

func coherePlanBody(t *testing.T, request *outbound.Request) orderedNodeJSON {
	t.Helper()
	body, decodeErr := decodeOrderedNodeJSON(request.Body)
	if decodeErr != nil {
		t.Fatalf("the built cohere body is not JSON: %v", decodeErr)
	}
	return body
}

func cohereMemberText(t *testing.T, body orderedNodeJSON, key string) string {
	t.Helper()
	member, exists := body.member(key)
	if !exists {
		t.Fatalf("the built body carries no %q member", key)
	}
	encoded, encodeErr := marshalOrderedNodeJSON(member)
	if encodeErr != nil {
		t.Fatal(encodeErr)
	}
	return string(encoded)
}

func cohereHeaderValue(request *outbound.Request, name string) (string, bool) {
	for _, header := range request.Headers {
		if strings.EqualFold(header.Name, name) {
			return header.Value, true
		}
	}
	return "", false
}

// TestChatCompletionCoherePlanBuildsThePinnedBody pins the member ORDER and every renamed member.
func TestChatCompletionCoherePlanBuildsThePinnedBody(t *testing.T) {
	directories := cohereTestDirectories(t, "probe-cohere-key")
	request := coherePlanRequest(t, `{"chat_completion_source":"cohere","model":"probe-model","messages":[{"role":"user","content":"probe user marker"}],"max_tokens":8,"top_k":5,"top_p":0.5,"stop":["END"],"seed":3,"frequency_penalty":0.1,"presence_penalty":0.2,"stream":false}`, directories)

	// The pinned literal + '/chat', and the header set node-fetch actually sends.
	if request.URL != pinnedCohereAPIURL+"/chat" {
		t.Fatalf("cohere URL = %q, want %q", request.URL, pinnedCohereAPIURL+"/chat")
	}
	for _, want := range [][2]string{
		{"authorization", "Bearer probe-cohere-key"},
		{"content-type", "application/json"},
		{"accept", "*/*"},
		{"accept-encoding", "gzip, deflate, br"},
		{"user-agent", "node-fetch"},
		{"host", "api.cohere.ai"},
		{"connection", "close"},
	} {
		got, exists := cohereHeaderValue(request, want[0])
		if !exists {
			t.Fatalf("the built request carries no %s header", want[0])
		}
		if got != want[1] {
			t.Fatalf("%s header = %q, want %q", want[0], got, want[1])
		}
	}
	if got, _ := cohereHeaderValue(request, "content-length"); got != strconv.Itoa(len(request.Body)) {
		t.Fatalf("content-length = %q, want %d", got, len(request.Body))
	}

	body := coherePlanBody(t, request)
	keys := make([]string, 0, len(body.object))
	for _, entry := range body.object {
		keys = append(keys, entry.key)
	}
	wantKeys := []string{
		"stream", "model", "messages", "max_tokens",
		"k", "p", "seed", "stop_sequences", "frequency_penalty", "presence_penalty",
		"documents", "tools",
	}
	if strings.Join(keys, ",") != strings.Join(wantKeys, ",") {
		t.Fatalf("built member order = %v, want %v", keys, wantKeys)
	}
	// No member this route does not name may reach the provider: there is no spread of request.body.
	for _, forbidden := range []string{"top_k", "top_p", "stop", "chat_completion_source", "json_schema", "safety_mode"} {
		if _, exists := body.member(forbidden); exists {
			t.Fatalf("the built body carries %q, which the pinned body does not", forbidden)
		}
	}
	for _, want := range [][2]string{
		{"stream", "false"},
		{"model", `"probe-model"`},
		{"max_tokens", "8"},
		{"k", "5"},
		{"p", "0.5"},
		{"seed", "3"},
		{"stop_sequences", `["END"]`},
		{"frequency_penalty", "0.1"},
		{"presence_penalty", "0.2"},
		{"documents", "[]"},
		{"tools", "[]"},
	} {
		if got := cohereMemberText(t, body, want[0]); got != want[1] {
			t.Fatalf("%q = %s, want %s", want[0], got, want[1])
		}
	}
}

// TestChatCompletionCohereStreamIsAlwaysABoolean pins `stream: Boolean(request.body.stream)` for all three
// input shapes, including the absent member that must still emit `false`.
func TestChatCompletionCohereStreamIsAlwaysABoolean(t *testing.T) {
	directories := cohereTestDirectories(t, "probe-cohere-key")
	for _, testCase := range []struct {
		name      string
		fragment  string
		wantValue string
	}{
		{"absent", "", "false"},
		{"false", `,"stream":false`, "false"},
		{"true", `,"stream":true`, "true"},
		{"truthy non-boolean", `,"stream":1`, "true"},
		{"falsy non-boolean", `,"stream":0`, "false"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			request := coherePlanRequest(t, `{"chat_completion_source":"cohere","model":"probe-model","messages":[{"role":"user","content":"probe user marker"}]`+testCase.fragment+`}`, directories)
			body := coherePlanBody(t, request)
			if got := cohereMemberText(t, body, "stream"); got != testCase.wantValue {
				t.Fatalf("stream = %s, want %s", got, testCase.wantValue)
			}
		})
	}
}

// TestChatCompletionCohereSafetyModeIsConditional pins `String(model).endsWith('08-2024')`.
func TestChatCompletionCohereSafetyModeIsConditional(t *testing.T) {
	directories := cohereTestDirectories(t, "probe-cohere-key")
	for _, testCase := range []struct {
		name    string
		model   string
		present bool
	}{
		{"suffix match", `"command-r-plus-08-2024"`, true},
		{"no suffix", `"command-r-plus"`, false},
		// The suffix must be at the END: a model that merely CONTAINS the date does not qualify.
		{"suffix not at the end", `"command-r-08-2024-plus"`, false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			request := coherePlanRequest(t, `{"chat_completion_source":"cohere","model":`+testCase.model+`,"messages":[{"role":"user","content":"probe user marker"}]}`, directories)
			body := coherePlanBody(t, request)
			safety, exists := body.member("safety_mode")
			if exists != testCase.present {
				t.Fatalf("safety_mode present = %v, want %v", exists, testCase.present)
			}
			if testCase.present {
				if encoded, _ := marshalOrderedNodeJSON(safety); string(encoded) != `"OFF"` {
					t.Fatalf("safety_mode = %s, want \"OFF\"", encoded)
				}
				// safety_mode sits between tools and response_format in the pinned literal's order.
				if keys := cohereBodyKeysOf(t, body); keys[len(keys)-1] != "safety_mode" {
					t.Fatalf("safety_mode is not the last member: %v", keys)
				}
			}
		})
	}
}

func cohereBodyKeysOf(t *testing.T, body orderedNodeJSON) []string {
	t.Helper()
	keys := make([]string, 0, len(body.object))
	for _, entry := range body.object {
		keys = append(keys, entry.key)
	}
	return keys
}

// TestChatCompletionCohereToolsDropTheSchemaKeyword pins the one tools fold: a truthy
// `function.parameters.$schema` is DELETED and the rest of the tool survives, and tools is ALWAYS an array.
func TestChatCompletionCohereToolsDropTheSchemaKeyword(t *testing.T) {
	directories := cohereTestDirectories(t, "probe-cohere-key")
	request := coherePlanRequest(t, `{"chat_completion_source":"cohere","model":"probe-model","messages":[{"role":"user","content":"probe user marker"}],"tools":[{"type":"function","function":{"name":"probe_tool","description":"probe tool","parameters":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","required":["answer"]}}},{"type":"function","function":{"name":"no_parameters"}}]}`, directories)
	body := coherePlanBody(t, request)
	if got := cohereMemberText(t, body, "tools"); got != `[{"type":"function","function":{"name":"probe_tool","description":"probe tool","parameters":{"type":"object","required":["answer"]}}},{"type":"function","function":{"name":"no_parameters"}}]` {
		t.Fatalf("tools = %s", got)
	}
}

// TestChatCompletionCohereResponseFormatIsTheSchemaValue pins the {type, schema} shape and the
// route-level flattenSchema that has already rewritten json_schema.value before dispatch.
func TestChatCompletionCohereResponseFormatIsTheSchemaValue(t *testing.T) {
	directories := cohereTestDirectories(t, "probe-cohere-key")
	request := coherePlanRequest(t, `{"chat_completion_source":"cohere","model":"probe-model","messages":[{"role":"user","content":"probe user marker"}],"json_schema":{"name":"probe_schema","description":"probe schema","value":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"answer":{"$ref":"#/$defs/answer"}},"$defs":{"answer":{"type":"string"}}}}}`, directories)
	body := coherePlanBody(t, request)
	// The name/description envelope members the SHARED path emits are NOT part of this fold, and the
	// flattened value has lost $schema and $defs and inlined the $ref.
	want := `{"type":"json_schema","schema":{"type":"object","properties":{"answer":{"type":"string"}}}}`
	if got := cohereMemberText(t, body, "response_format"); got != want {
		t.Fatalf("response_format = %s, want %s", got, want)
	}
	if keys := cohereBodyKeysOf(t, body); keys[len(keys)-1] != "response_format" {
		t.Fatalf("response_format is not the last member when safety_mode is absent: %v", keys)
	}
}

// TestChatCompletionCohereMessageNameFolds pins convertCohereMessages' prefix rules.
func TestChatCompletionCohereMessageNameFolds(t *testing.T) {
	directories := cohereTestDirectories(t, "probe-cohere-key")
	request := coherePlanRequest(t, `{"chat_completion_source":"cohere","model":"probe-model","char_name":"Bot","user_name":"Iris","group_names":["Iris","Ren"],"messages":[`+
		`{"role":"system","name":"example_assistant","content":"probe example marker"},`+
		`{"role":"system","name":"example_assistant","content":"Ren: probe group marker"},`+
		`{"role":"system","name":"example_user","content":"probe example user marker"},`+
		`{"role":"system","name":"example_user","content":"Iris: probe already prefixed"},`+
		`{"role":"user","content":"probe user marker"},`+
		`{"role":"assistant","name":"Bot","content":"probe named assistant marker"},`+
		`{"role":"user","name":"Iris","content":"Iris: probe named user marker"}]}`, directories)
	body := coherePlanBody(t, request)
	want := `[{"role":"system","content":"Bot: probe example marker"},` +
		`{"role":"system","content":"Ren: probe group marker"},` +
		`{"role":"system","content":"Iris: probe example user marker"},` +
		`{"role":"system","content":"Iris: probe already prefixed"},` +
		`{"role":"user","content":"probe user marker"},` +
		`{"role":"assistant","content":"Bot: probe named assistant marker"},` +
		`{"role":"user","content":"Iris: probe named user marker"}]`
	if got := cohereMemberText(t, body, "messages"); got != want {
		t.Fatalf("messages = %s\nwant %s", got, want)
	}
}

// TestChatCompletionCohereToolCallsFoldsAndTheForEachSkip pins :394-401, including the element that the
// splice makes forEach skip: it keeps its `name` and its UNPREFIXED content.
func TestChatCompletionCohereToolCallsFoldsAndTheForEachSkip(t *testing.T) {
	directories := cohereTestDirectories(t, "probe-cohere-key")
	request := coherePlanRequest(t, `{"chat_completion_source":"cohere","model":"probe-model","messages":[`+
		`{"role":"user","content":"probe user marker"},`+
		`{"role":"assistant","content":"probe assistant marker"},`+
		`{"role":"user","content":"probe second user marker"},`+
		`{"role":"assistant","tool_calls":[{"id":"call_a","type":"function","function":{"name":"probe_tool","arguments":"{}"}}]},`+
		`{"role":"assistant","content":"probe third assistant marker"},`+
		`{"role":"assistant","tool_calls":[{"id":"call_b","type":"function","function":{"name":"spliced_tool","arguments":"{}"}}]},`+
		`{"role":"user","name":"Ren","content":"probe named user marker"}]}`, directories)
	body := coherePlanBody(t, request)
	want := `[` +
		`{"role":"user","content":"probe user marker"},` +
		`{"role":"assistant","content":"probe assistant marker"},` +
		`{"role":"user","content":"probe second user marker"},` +
		// The phrase branch: the preceding turn is a USER turn, so content is the literal sentence.
		`{"role":"assistant","tool_calls":[{"id":"call_a","type":"function","function":{"name":"probe_tool","arguments":"{}"}}],"content":"I'm going to call a tool for that: probe_tool"},` +
		// The assistant turn that provided the content is GONE; the tool_calls turn keeps its own members
		// first and gains `content` last, exactly as a JS assignment onto an existing object does.
		`{"role":"assistant","tool_calls":[{"id":"call_b","type":"function","function":{"name":"spliced_tool","arguments":"{}"}}],"content":"probe third assistant marker"},` +
		// The SKIPPED element: name still present, content still unprefixed.
		`{"role":"user","name":"Ren","content":"probe named user marker"}]`
	if got := cohereMemberText(t, body, "messages"); got != want {
		t.Fatalf("messages = %s\nwant %s", got, want)
	}
}

// TestChatCompletionCohereEmptyMessagesUsesThePlaceholder pins the unshift branch.
func TestChatCompletionCohereEmptyMessagesUsesThePlaceholder(t *testing.T) {
	directories := cohereTestDirectories(t, "probe-cohere-key")
	request := coherePlanRequest(t, `{"chat_completion_source":"cohere","model":"probe-model","messages":[]}`, directories)
	body := coherePlanBody(t, request)
	want := `[{"role":"user","content":"Let's get started."}]`
	if got := cohereMemberText(t, body, "messages"); got != want {
		t.Fatalf("messages = %s, want %s", got, want)
	}
}

// TestChatCompletionCohereFoldsAreAppliedToAProviderShapedBody is the end-to-end shape the recorded
// cohere-folds scenario pins: every fold at once, in the pinned member order.
func TestChatCompletionCohereFoldsAreAppliedToAProviderShapedBody(t *testing.T) {
	directories := cohereTestDirectories(t, "probe-cohere-key")
	request := coherePlanRequest(t, `{"chat_completion_source":"cohere","model":"command-r-plus-08-2024","messages":[{"role":"user","content":"probe user marker"}],"top_k":11,"top_p":0.75,"stop":["\nprobe-stop\n"],"tools":[{"type":"function","function":{"name":"probe_tool","parameters":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}}}],"json_schema":{"name":"probe_schema","description":"probe schema","value":{"type":"object","properties":{"answer":{"type":"string"}}}}}`, directories)
	body := coherePlanBody(t, request)
	// SOURCE-DERIVED MEMBER ORDER, and labelled as such: no cohere GENERATE capture exists in
	// tests/oracle (checked), so the order comes from the pinned object literal at
	// chat-completions.js:1001-1014 -- stream, model, messages, temperature, max_tokens, k, p, seed,
	// stop_sequences, frequency_penalty, presence_penalty, documents, tools -- plus the two
	// conditional members appended after it (safety_mode at :1017, response_format at :1022).
	//
	// `k` and `p` are the pinned aliases `k: request.body.top_k` and `p: request.body.top_p` (:1003-1004),
	// and THIS CASE supplies top_k/top_p, so they are present. The members absent here
	// (temperature, max_tokens, seed, frequency_penalty, presence_penalty) are the ones this body
	// leaves undefined, which JSON.stringify drops.
	want := []string{"stream", "model", "messages", "k", "p", "stop_sequences", "documents", "tools", "safety_mode", "response_format"}
	if got := cohereBodyKeysOf(t, body); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("member order = %v, want %v", got, want)
	}
}

// TestChatCompletionCohereIsNotTheDefaultRefusal proves the source reaches a served branch: the plan builds
// a request for cohere, while a source this package does not implement still answers 501.
func TestChatCompletionCohereIsNotTheDefaultRefusal(t *testing.T) {
	directories := cohereTestDirectories(t, "probe-cohere-key")
	body, decodeErr := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"cohere","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	if _, failure := pinnedChatCompletionPlan(body, directories, ""); failure != nil && failure.status == 501 {
		t.Fatal("cohere is answered by the default 501 branch; its plan case is missing")
	}
	unimplemented, unimplementedErr := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"cometapi","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if unimplementedErr != nil {
		t.Fatal(unimplementedErr)
	}
	if _, failure := pinnedChatCompletionPlan(unimplemented, directories, ""); failure == nil || failure.status != 501 {
		t.Fatalf("a source this package does not implement must answer 501, got %+v", failure)
	}
}

// TestChatCompletionCohereMissingKeyIsRefusedBeforeTheFetch pins :979 `if (!apiKey)` -- including the fact
// that a reverse_proxy does NOT stand in for the key, because this route never reads it.
func TestChatCompletionCohereMissingKeyIsRefusedBeforeTheFetch(t *testing.T) {
	empty := startup.UserDirectories{}
	for _, testCase := range []struct {
		name string
		body string
	}{
		{"no secret stored", `{"chat_completion_source":"cohere","model":"probe-model","messages":[{"role":"user","content":"x"}]}`},
		{"reverse_proxy without a key", `{"chat_completion_source":"cohere","model":"probe-model","messages":[{"role":"user","content":"x"}],"reverse_proxy":"http://127.0.0.1:1"}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			body, decodeErr := decodeOrderedNodeJSON([]byte(testCase.body))
			if decodeErr != nil {
				t.Fatal(decodeErr)
			}
			request, failure := pinnedCoherePlan(body, empty)
			if request != nil {
				t.Fatalf("a keyless cohere request built a plan for %q", request.URL)
			}
			if failure == nil || failure.status != 400 {
				t.Fatalf("failure = %+v, want status 400", failure)
			}
			if failure.payload == nil {
				t.Fatal("the pinned refusal carries a JSON body")
			}
			encoded, _ := marshalOrderedNodeJSON(*failure.payload)
			if string(encoded) != `{"error":true}` {
				t.Fatalf("refusal body = %s, want {\"error\":true}", encoded)
			}
		})
	}
}

// TestChatCompletionCohereStatusIsThePinnedTail pins the /status arm at the HTTP level against a recording
// peer, with the outbound request count asserted for each case.
//
// THIS IS A DERIVATION, NOT A RECORDING. The ok and nonOk shapes are read from :2067-2146 and are the same
// shapes the sibling deepseek arm has RECORDED in the backends oracle (status.deepseek.ok/nonOk/noKey);
// cohere's own ok/nonOk captures arrive with the provider-wire scenarios. The noKey case cannot be recorded
// at all: tools/probe-provider-wire.mjs refuses a capture with zero provider requests, so it is pinned here.
func TestChatCompletionCohereStatusIsThePinnedTail(t *testing.T) {
	const providerBody = `{"models":[{"name":"command-r","context_length":128000}]}`
	secrets := map[string]any{
		"api_key_cohere": []any{map[string]any{"id": "probe-id", "value": "synthetic-cohere-key", "label": "probe", "active": true}},
	}
	for _, testCase := range []struct {
		name           string
		secrets        map[string]any
		requestBody    string
		providerStatus int
		wantStatus     int
		wantBody       string
		wantOutbound   int
	}{
		{
			name:           "ok returns the provider body unchanged",
			secrets:        secrets,
			requestBody:    `{"chat_completion_source":"cohere"}`,
			providerStatus: 200,
			wantStatus:     200,
			// The :2112-2114 fold would add a `data` member; it runs after send() and must NOT appear.
			wantBody:     providerBody,
			wantOutbound: 1,
		},
		{
			name:           "a provider non-2xx becomes the shared envelope",
			secrets:        secrets,
			requestBody:    `{"chat_completion_source":"cohere"}`,
			providerStatus: 401,
			wantStatus:     200,
			wantBody:       `{"error":true,"data":{"data":[]}}`,
			wantOutbound:   1,
		},
		{
			name:           "no key is refused before the fetch",
			secrets:        nil,
			requestBody:    `{"chat_completion_source":"cohere"}`,
			providerStatus: 200,
			wantStatus:     400,
			wantBody:       `{"error":true}`,
			wantOutbound:   0,
		},
		{
			// :2067 consults `request.body.reverse_proxy` even though this source never reads it, so a
			// request that carries one is NOT refused and goes out with `Bearer ` and no key.
			name:           "a reverse_proxy skips the refusal and sends an empty key",
			secrets:        nil,
			requestBody:    `{"chat_completion_source":"cohere","reverse_proxy":"<peer>"}`,
			providerStatus: 200,
			wantStatus:     200,
			wantBody:       providerBody,
			wantOutbound:   1,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			peer := mockprovider.New([]mockprovider.Response{{
				Status:  testCase.providerStatus,
				Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json"}},
				Body:    providerBody,
			}})
			address, err := peer.Listen(0)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = peer.Close() })
			peerURL := "http://" + address.String()
			t.Setenv(pinnedCohereStatusSeamEnv, peerURL)

			scenario := providerWireScenario{}
			scenario.Request.Path = "/api/backends/chat-completions/status"
			scenario.Secrets = testCase.secrets
			origin, cookie, token := startChatCompletionTestServer(t, scenario)
			driverBody := strings.ReplaceAll(testCase.requestBody, "<peer>", peerURL)
			status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, driverBody)
			if status != testCase.wantStatus {
				t.Fatalf("status = %d, want %d (body %q)", status, testCase.wantStatus, text)
			}
			if text != testCase.wantBody {
				t.Fatalf("body = %q, want %q", text, testCase.wantBody)
			}
			recorded := peer.Recording().Requests
			if len(recorded) != testCase.wantOutbound {
				t.Fatalf("the peer received %d request(s), want %d", len(recorded), testCase.wantOutbound)
			}
			if testCase.wantOutbound == 0 {
				return
			}
			// The status arm reads API_COHERE_V1, so the provider request is GET /models under that base.
			if recorded[0].Method != "GET" || recorded[0].RawPath != "/models" {
				t.Fatalf("provider request = %s %s, want GET /models", recorded[0].Method, recorded[0].RawPath)
			}
			authorization := ""
			for _, header := range recorded[0].Headers {
				if strings.EqualFold(header.Name, "authorization") {
					authorization = header.Value
				}
			}
			expectedAuthorization := "Bearer "
			if testCase.secrets != nil {
				expectedAuthorization = "Bearer synthetic-cohere-key"
			}
			if authorization != expectedAuthorization {
				t.Fatalf("provider saw authorization %q, want %q", authorization, expectedAuthorization)
			}
		})
	}
}
