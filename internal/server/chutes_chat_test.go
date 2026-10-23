package server

// CHUTES properties the generic replay cannot state, plus the rule-17 split between an implemented
// source and a gap.
//
// The provider-wire captures live in tests/oracle/sillytavern-1.19.0-provider-wire.json and are recorded
// by the Linux oracle job from tests/provider-wire/scenarios/chutes-*.json. Until that recording lands the
// capture-level test SKIPS with a named reason rather than passing: a comparison against an absent
// capture would be decoration. Everything that can be stated without a capture is stated below at the
// PLAN level, one case per folded member, so a member that is missing, misnamed or ordered after the member
// it must follow fails even when no capture exists.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

func decodeChutesBody(t *testing.T, text string) orderedNodeJSON {
	t.Helper()
	value, err := decodeOrderedNodeJSON([]byte(text))
	if err != nil {
		t.Fatalf("decode %s: %v", text, err)
	}
	return value
}

func encodeChutesPayload(t *testing.T, body orderedNodeJSON) string {
	t.Helper()
	payload, failure := pinnedChutesPayload(body)
	if failure != nil {
		t.Fatalf("pinnedChutesPayload answered %d instead of a body", failure.status)
	}
	encoded, err := marshalOrderedNodeJSON(payload)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// TestChatCompletionChutesSeamDefaultsToPinnedLiteral pins the seam's default to API_CHUTES (:83). A seam
// whose default drifted would send real traffic to the wrong host while every replay still passed.
func TestChatCompletionChutesSeamDefaultsToPinnedLiteral(t *testing.T) {
	t.Setenv(pinnedChutesSeamEnv, "")
	if got := pinnedChutesBaseURL(); got != pinnedChutesAPIURL {
		t.Fatalf("seam default = %q, want the pinned literal %q", got, pinnedChutesAPIURL)
	}
	if got := pinnedChutesStatusURL(); got != pinnedChutesAPIURL+"/models" {
		t.Fatalf("status URL = %q, want %q", got, pinnedChutesAPIURL+"/models")
	}
}

// TestChatCompletionChutesPayloadFoldedMembers is the PLAN-level table: one case per folded member and one
// per surface that distinguishes this transform from the generic path.
func TestChatCompletionChutesPayloadFoldedMembers(t *testing.T) {
	const replyMessages = `[{"role":"user","content":"probe first user"},{"role":"user","content":"probe second user"},{"role":"system","content":"probe mid system marker"}]`
	cases := []struct {
		name string
		body string
		want string
	}{{
		name: "messages are forwarded VERBATIM: no same-role fold, no mid-system rewrite",
		body: `{"messages":` + replyMessages + `,"model":"probe-model"}`,
		want: `{"messages":` + replyMessages + `,"model":"probe-model"}`,
	}, {
		name: "the pinned literal member order is messages, model, temperature, max_tokens, stream, presence, frequency, repetition, min_p, top_p, top_k, seed, stop, reasoning_effort, logit_bias",
		body: `{"messages":[],"model":"m","temperature":0.4,"max_tokens":96,"stream":false,"presence_penalty":0.1,"frequency_penalty":0.2,"repetition_penalty":1.1,"min_p":0.05,"top_p":0.8,"top_k":40,"seed":7,"stop":["S"],"reasoning_effort":"high","logit_bias":{"50256":-100}}`,
		want: `{"messages":[],"model":"m","temperature":0.4,"max_tokens":96,"stream":false,"presence_penalty":0.1,"frequency_penalty":0.2,"repetition_penalty":1.1,"min_p":0.05,"top_p":0.8,"top_k":40,"seed":7,"stop":["S"],"reasoning_effort":"high","logit_bias":{"50256":-100}}`,
	}, {
		name: "an ARRAY tools with length>0 folds tools AND tool_choice, appended last",
		body: `{"messages":[],"model":"m","tools":[{"type":"function","function":{"name":"probe_tool"}}],"tool_choice":"auto"}`,
		want: `{"messages":[],"model":"m","tools":[{"type":"function","function":{"name":"probe_tool"}}],"tool_choice":"auto"}`,
	}, {
		name: "a NON-ARRAY truthy tools is NOT folded and neither is tool_choice (Array.isArray guard)",
		body: `{"messages":[],"model":"m","tools":{"not":"an array"},"tool_choice":"auto"}`,
		want: `{"messages":[],"model":"m"}`,
	}, {
		name: "an EMPTY tools array does not fold (length > 0)",
		body: `{"messages":[],"model":"m","tools":[],"tool_choice":"auto"}`,
		want: `{"messages":[],"model":"m"}`,
	}, {
		name: "logprobs 3 folds top_logprobs 3 and logprobs true",
		body: `{"messages":[],"model":"m","logprobs":3}`,
		want: `{"messages":[],"model":"m","top_logprobs":3,"logprobs":true}`,
	}, {
		name: "the numeric STRING \"2\" folds under JS coercion",
		body: `{"messages":[],"model":"m","logprobs":"2"}`,
		want: `{"messages":[],"model":"m","top_logprobs":"2","logprobs":true}`,
	}, {
		name: "logprobs 0 does not fold",
		body: `{"messages":[],"model":"m","logprobs":0}`,
		want: `{"messages":[],"model":"m"}`,
	}, {
		name: "a null logprobs does not fold (Number(null) is 0)",
		body: `{"messages":[],"model":"m","logprobs":null}`,
		want: `{"messages":[],"model":"m"}`,
	}, {
		name: "json_schema folds to {type:json_schema} with strict defaulting to TRUE and value renamed to schema",
		body: `{"messages":[],"model":"m","json_schema":{"name":"probe_schema","description":"probe description","value":{"type":"object"}}}`,
		want: `{"messages":[],"model":"m","response_format":{"type":"json_schema","json_schema":{"name":"probe_schema","description":"probe description","schema":{"type":"object"},"strict":true}}}`,
	}, {
		name: "an explicit strict:false survives (strict ?? true, not ||)",
		body: `{"messages":[],"model":"m","json_schema":{"name":"probe_schema","value":{"type":"object"},"strict":false}}`,
		want: `{"messages":[],"model":"m","response_format":{"type":"json_schema","json_schema":{"name":"probe_schema","schema":{"type":"object"},"strict":false}}}`,
	}, {
		name: "a null strict coalesces to TRUE",
		body: `{"messages":[],"model":"m","json_schema":{"name":"probe_schema","value":{"type":"object"},"strict":null}}`,
		want: `{"messages":[],"model":"m","response_format":{"type":"json_schema","json_schema":{"name":"probe_schema","schema":{"type":"object"},"strict":true}}}`,
	}, {
		name: "the folded members follow logit_bias, in the pinned creation order",
		body: `{"messages":[],"model":"m","logit_bias":{"1":-1},"tools":[{"a":1}],"logprobs":2,"json_schema":{"name":"s","value":{}}}`,
		want: `{"messages":[],"model":"m","logit_bias":{"1":-1},"tools":[{"a":1}],"top_logprobs":2,"logprobs":true,"response_format":{"type":"json_schema","json_schema":{"name":"s","schema":{},"strict":true}}}`,
	}}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := encodeChutesPayload(t, decodeChutesBody(t, testCase.body))
			if got != testCase.want {
				t.Fatalf("provider body = %s\nwant            %s", got, testCase.want)
			}
		})
	}
}

// TestChatCompletionChutesStatusProjection covers the chutes-only projection at :2092-2108.
func TestChatCompletionChutesStatusProjection(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{{
		name: "an entry without a truthy id is dropped and a priced entry gains input/output after its own members",
		body: `{"object":"list","data":[{"id":"model-a","pricing":{"prompt":1,"completion":2}},{"id":"","pricing":{"prompt":1,"completion":2}},{"name":"no-id"},{"id":"model-b"}]}`,
		want: `{"object":"list","data":[{"id":"model-a","pricing":{"prompt":1,"completion":2,"input":1,"output":2}},{"id":"model-b"}]}`,
	}, {
		name: "a pricing object missing one side is left untouched",
		body: `{"data":[{"id":"model-c","pricing":{"prompt":1}}]}`,
		want: `{"data":[{"id":"model-c","pricing":{"prompt":1}}]}`,
	}, {
		name: "a body whose data is absent or not an array is passed through unchanged",
		body: `{"error":true,"data":{"data":[]}}`,
		want: `{"error":true,"data":{"data":[]}}`,
	}}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			projected := pinnedChutesProjectModels(decodeChutesBody(t, testCase.body))
			encoded, err := marshalOrderedNodeJSON(projected)
			if err != nil {
				t.Fatal(err)
			}
			if string(encoded) != testCase.want {
				t.Fatalf("projected = %s\nwant       %s", encoded, testCase.want)
			}
		})
	}
}

// TestChutesStatusIsNotA501Gap is rule 17 at the HTTP level: CHUTES must not answer the status route with
// the same 501 an unported source answers. The peer is scripted with no answer, so a non-2xx provider reply
// produces the pinned envelope; reaching the provider at all is the proof the arm exists.
func TestChutesStatusIsNotA501Gap(t *testing.T) {
	scenario := providerWireScenario{}
	scenario.Request.Path = "/api/backends/chat-completions/status"
	scenario.Secrets = map[string]any{
		"api_key_chutes": []any{map[string]any{
			"id": "probe-id-api_key_chutes", "value": "synthetic-chutes-key", "label": "api_key_chutes", "active": true,
		}},
	}
	origin, cookie, token := startChatCompletionTestServer(t, scenario)

	peer := mockprovider.NewKeyed(nil)
	address, err := peer.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	// The chutes status arm uses the pinned literal, not reverse_proxy, so the peer is reached through the
	// SEAM. Setting it is what keeps this test off the live network.
	t.Setenv(pinnedChutesSeamEnv, "http://"+address.String())

	for _, testCase := range []struct {
		name         string
		body         string
		wantStatus   int
		wantOutbound int
	}{
		{name: "chutes reaches its status arm", body: `{"chat_completion_source":"chutes"}`, wantStatus: http.StatusOK, wantOutbound: 1},
		// THE DURABLE CONTROL: an UNKNOWN name. Pinned's status chain closes with
		// `else -> status(400).send({ error: true })` (:2062-2065), and `cometapi` -- the source this
		// row used to name -- is a real pinned source that can be implemented.
		{name: "an unknown source name answers the chain's 400", body: `{"chat_completion_source":"` + pinnedUnknownChatCompletionSource + `"}`, wantStatus: http.StatusBadRequest, wantOutbound: 0},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			peer.Reset(nil)
			status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, testCase.body)
			if status != testCase.wantStatus {
				t.Fatalf("status = %d, want %d (body %q)", status, testCase.wantStatus, text)
			}
			if recorded := peer.Recording().Requests; len(recorded) != testCase.wantOutbound {
				t.Fatalf("the peer received %d request(s), want %d", len(recorded), testCase.wantOutbound)
			}
		})
	}
}

// TestChatCompletionChutesWireCaptures is the capture-level half. It SKIPS with a named reason while the
// Linux oracle has not recorded the chutes scenarios, because comparing against an absent capture would be
// decoration; once recorded it asserts every scenario the row claims and the folded members inside the
// captured provider bodies.
func TestChatCompletionChutesWireCaptures(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Scenarios map[string]struct {
			TargetPath string `json:"targetPath"`
			Provider   struct {
				Requests []struct {
					BodyText string `json:"bodyText"`
				} `json:"requests"`
			} `json:"provider"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	required := map[string][]string{
		"chutes-nonstream":                {`"repetition_penalty":1.1`, `"min_p":0.05`, `"top_k":40`, `"logit_bias":{"50256":-100}`},
		"chutes-tools":                    {`"tools":[{"type":"function"`, `"tool_choice":"auto"`},
		"chutes-tools-nonarray":           {},
		"chutes-logprobs":                 {`"top_logprobs":3`, `"logprobs":true`},
		"chutes-logprobs-string":          {`"top_logprobs":"2"`, `"logprobs":true`},
		"chutes-json-schema":              {`"strict":true`, `"schema":{"type":"object"`},
		"chutes-json-schema-strict-false": {`"strict":false`},
		"chutes-stream":                   {},
		"chutes-stream-control-nonstream": {},
		"chutes-error-status":             {},
		"chutes-error-status-nonjson":     {},
		"chutes-status-listing":           {},
	}
	missing := make([]string, 0, len(required))
	for name := range required {
		if _, present := fixture.Scenarios[name]; !present {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		t.Skipf("the provider-wire fixture has no chutes captures yet (%d missing: %v); the Linux oracle job records them from tests/provider-wire/scenarios/chutes-*.json on merge. The PLAN-level tables above are the assertions in force until then.", len(missing), missing)
	}
	for name, fragments := range required {
		scenario := fixture.Scenarios[name]
		if scenario.TargetPath != chatCompletionSourceChutes {
			t.Fatalf("%s: targetPath = %q, want %q", name, scenario.TargetPath, chatCompletionSourceChutes)
		}
		if len(scenario.Provider.Requests) == 0 {
			t.Fatalf("%s: the capture records no provider request", name)
		}
		body := scenario.Provider.Requests[0].BodyText
		for _, fragment := range fragments {
			if !containsFragment(body, fragment) {
				t.Fatalf("%s: captured provider body is missing %s\nbody: %s", name, fragment, body)
			}
		}
	}
}

// containsFragment is strings.Contains under a name that says what it is for at the call site.
func containsFragment(haystack, needle string) bool {
	if len(needle) == 0 {
		return true
	}
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return true
		}
	}
	return false
}
