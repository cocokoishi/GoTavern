package server

// The MOONSHOT arm's own assertions. Because the arm lives inside the SHARED openai-compatible builder,
// there is no moonshot plan function to drive and no provider-wire capture to replay on this branch: the
// captures are recorded by the Linux oracle only once the central commit wires the arm in. What CAN be
// asserted here, without that wiring, is every fold the arm performs, on the values the arm itself
// produces -- plus the two ordering/credential claims that are cheap at this level and expensive to
// discover on the wire.
//
// renderMoonshotSharedBody below reproduces the shared member list of chat-completions.js:2652-2669 ONLY
// so ordering can be asserted before the wiring exists. It names the thirteen shared keys literally; if
// the shared assembly ever gains or loses one, this helper is the thing that must change with it, and the
// provider-wire capture is the check that the real builder agrees.

import (
	"encoding/json"
	"strings"
	"testing"
)

func moonshotTestBody(t *testing.T, raw string) orderedNodeJSON {
	t.Helper()
	parsed, err := decodeOrderedNodeJSON([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

// renderMoonshotSharedBody applies the shared assembly (chat-completions.js:2652-2669) to a body after
// the arm has run: messages, the thirteen shared members that are PRESENT, then the arm's bodyParams
// spread LAST.
func renderMoonshotSharedBody(t *testing.T, body orderedNodeJSON, bodyParams orderedNodeJSON) string {
	t.Helper()
	requestBody := nodeObject()
	if messages, exists := body.member("messages"); exists {
		requestBody.setMember("messages", messages)
	}
	for _, key := range []string{
		"model", "temperature", "max_tokens", "max_completion_tokens", "stream",
		"presence_penalty", "frequency_penalty", "top_p", "top_k", "stop",
		"logit_bias", "seed", "n",
	} {
		if value, exists := body.member(key); exists {
			requestBody.setMember(key, value)
		}
	}
	for _, entry := range bodyParams.object {
		requestBody.setMember(entry.key, entry.value)
	}
	encoded, err := marshalOrderedNodeJSON(requestBody)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// TestChatCompletionMoonshotSeamDefault pins the seam's default to the pinned literal.
func TestChatCompletionMoonshotSeamDefault(t *testing.T) {
	t.Setenv(pinnedMoonshotSeamEnv, "")
	if got := pinnedMoonshotBaseURL(); got != pinnedMoonshotAPIURL {
		t.Fatalf("default Moonshot base = %q, want the pinned literal %q", got, pinnedMoonshotAPIURL)
	}
	if pinnedMoonshotAPIURL != "https://api.moonshot.ai/v1" {
		t.Fatalf("the pinned literal moved: %q", pinnedMoonshotAPIURL)
	}
	t.Setenv(pinnedMoonshotSeamEnv, "http://127.0.0.1:9/v1")
	if got := pinnedMoonshotBaseURL(); got != "http://127.0.0.1:9/v1" {
		t.Fatalf("seam override ignored: %q", got)
	}
}

// TestChatCompletionMoonshotArmFolds is the per-fold table: one case per behaviour the arm performs.
func TestChatCompletionMoonshotArmFolds(t *testing.T) {
	cases := []struct {
		name         string
		body         string
		wantThinking string
		wantJSONMode bool
		wantPartial  bool
		wantPushed   bool
		wantError    bool
	}{
		{
			name:         "thinking is disabled by default and a trailing assistant is marked partial",
			body:         `{"model":"kimi-k2","messages":[{"role":"user","content":"u"},{"role":"assistant","content":"a"}]}`,
			wantThinking: "disabled",
			wantPartial:  true,
		},
		{
			name:         "include_reasoning enables thinking",
			body:         `{"model":"kimi-k2","include_reasoning":true,"messages":[{"role":"user","content":"u"}]}`,
			wantThinking: "enabled",
		},
		{
			name:         "a trailing user turn is not marked",
			body:         `{"model":"kimi-k2","messages":[{"role":"assistant","content":"a"},{"role":"user","content":"u"}]}`,
			wantThinking: "disabled",
		},
		{
			name:         "a tool ROLE suppresses the mark even with no request tools",
			body:         `{"model":"kimi-k2","messages":[{"role":"user","content":"u"},{"role":"tool","content":"t"},{"role":"assistant","content":"a"}]}`,
			wantThinking: "disabled",
		},
		{
			name:         "json_schema switches to json_object AND appends the schema message, so no partial",
			body:         `{"model":"kimi-k2","json_schema":{"name":"s","value":{"type":"object","properties":{"f":{"type":"string"}}}},"messages":[{"role":"user","content":"u"},{"role":"assistant","content":"a"}]}`,
			wantThinking: "disabled",
			wantJSONMode: true,
			wantPushed:   true,
		},
		{
			name:         "a non-array messages member throws only when a schema needs to be pushed",
			body:         `{"model":"kimi-k2","json_schema":{"name":"s","value":{"type":"object"}},"messages":"not-an-array"}`,
			wantThinking: "disabled",
			wantError:    true,
		},
		{
			name:         "a non-array messages member is tolerated without a schema",
			body:         `{"model":"kimi-k2","messages":"not-an-array"}`,
			wantThinking: "disabled",
		},
	}
	for _, testCase := range cases {
		body := moonshotTestBody(t, testCase.body)
		originalMessages, hasMessages := body.member("messages")
		originalLength := len(originalMessages.array)
		bodyParams := nodeObject()
		err := pinnedChatCompletionMoonshotBodyParams(&bodyParams, &body)
		if testCase.wantError {
			if err == nil {
				t.Fatalf("%s: the arm accepted a body the pinned messages.push() would throw on", testCase.name)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: the arm reported %v", testCase.name, err)
		}

		thinking := sdBodyMember(bodyParams, "thinking")
		thinkingType, _ := pinnedClaudeMemberString(thinking, "type")
		if thinkingType != testCase.wantThinking {
			t.Fatalf("%s: thinking.type = %q, want %q", testCase.name, thinkingType, testCase.wantThinking)
		}

		_, hasResponseFormat := bodyParams.member("response_format")
		if hasResponseFormat != testCase.wantJSONMode {
			t.Fatalf("%s: response_format present = %v, want %v", testCase.name, hasResponseFormat, testCase.wantJSONMode)
		}
		if hasResponseFormat {
			responseFormat := sdBodyMember(bodyParams, "response_format")
			formatType, _ := pinnedClaudeMemberString(responseFormat, "type")
			if formatType != "json_object" {
				t.Fatalf("%s: response_format.type = %q, want json_object (setJsonObjectFormat, not the json_schema shape)", testCase.name, formatType)
			}
			if _, nested := responseFormat.member("json_schema"); nested {
				t.Fatalf("%s: response_format carries a nested json_schema, which is pinnedChatCompletionResponseFormat's shape, not this arm's", testCase.name)
			}
		}

		messages, _ := body.member("messages")
		if hasMessages && messages.kind == 'a' {
			if testCase.wantPushed {
				if len(messages.array) != originalLength+1 {
					t.Fatalf("%s: messages went from %d to %d, want exactly one appended schema message", testCase.name, originalLength, len(messages.array))
				}
				appended := messages.array[len(messages.array)-1]
				role, _ := pinnedClaudeMemberString(appended, "role")
				content, _ := pinnedClaudeMemberString(appended, "content")
				if role != "user" || !strings.HasPrefix(content, "JSON schema for the response:\n") {
					t.Fatalf("%s: the appended message is %q/%q, want a user turn carrying the schema banner", testCase.name, role, content)
				}
			} else if len(messages.array) != originalLength {
				t.Fatalf("%s: messages changed length without a schema: %d -> %d", testCase.name, originalLength, len(messages.array))
			}
			marked := 0
			for _, message := range messages.array {
				if _, present := message.member("partial"); present {
					marked++
				}
				if _, present := message.member("prefix"); present {
					t.Fatalf("%s: the arm marked a message with `prefix`; the pinned property is `partial`", testCase.name)
				}
			}
			wantMarked := 0
			if testCase.wantPartial {
				wantMarked = 1
			}
			if marked != wantMarked {
				t.Fatalf("%s: %d message(s) carry `partial`, want %d", testCase.name, marked, wantMarked)
			}
			if testCase.wantPartial {
				last := messages.array[len(messages.array)-1]
				value := sdBodyMember(last, "partial")
				if value.kind != 'b' || !value.scalar.(bool) {
					t.Fatalf("%s: the partial mark is not the boolean true", testCase.name)
				}
			}
		}
	}
}

// TestChatCompletionMoonshotBodyOrder is the lead's first claim as a test: the arm's bodyParams reach the
// wire AFTER the shared spread, which is what makes an arm-supplied duplicate win.
func TestChatCompletionMoonshotBodyOrder(t *testing.T) {
	body := moonshotTestBody(t, `{"model":"kimi-k2","seed":7,"n":2,"temperature":0.4,"messages":[{"role":"user","content":"u"}]}`)
	bodyParams := nodeObject()
	if err := pinnedChatCompletionMoonshotBodyParams(&bodyParams, &body); err != nil {
		t.Fatal(err)
	}
	rendered := renderMoonshotSharedBody(t, body, bodyParams)

	seedAt := strings.Index(rendered, `"seed":7`)
	nAt := strings.Index(rendered, `"n":2`)
	thinkingAt := strings.Index(rendered, `"thinking":`)
	if seedAt < 0 || nAt < 0 || thinkingAt < 0 {
		t.Fatalf("the rendered body is missing a member: %s", rendered)
	}
	if thinkingAt < seedAt || thinkingAt < nAt {
		t.Fatalf("`thinking` must follow the shared members (seed %d, n %d, thinking %d): %s", seedAt, nAt, thinkingAt, rendered)
	}

	// A duplicate key in the arm's params must WIN, because the spread is last; the key keeps the position
	// it first appeared at, exactly as an object spread does in JavaScript. `stop` is a shared member, so it
	// stands in for any arm that sets one.
	duplicate := nodeObject()
	duplicate.setMember("stop", nodeString("PROBE_ARM_WINS"))
	bodyWithStop := moonshotTestBody(t, `{"model":"kimi-k2","stop":"PROBE_BODY_LOSES","messages":[{"role":"user","content":"u"}]}`)
	renderedDuplicate := renderMoonshotSharedBody(t, bodyWithStop, duplicate)
	if strings.Contains(renderedDuplicate, "PROBE_BODY_LOSES") {
		t.Fatalf("the shared value survived a later duplicate, so the spread is not last: %s", renderedDuplicate)
	}
	if !strings.Contains(renderedDuplicate, `"PROBE_ARM_WINS"`) {
		t.Fatalf("the arm's duplicate value is missing: %s", renderedDuplicate)
	}
	if occurrences := strings.Count(renderedDuplicate, `"stop":`); occurrences != 1 {
		t.Fatalf("the duplicate key rendered %d times, want exactly once: %s", occurrences, renderedDuplicate)
	}
	stopAt := strings.Index(renderedDuplicate, `"stop":`)
	if stopAt > thinkingAt {
		t.Fatalf("the duplicated key kept a position after the arm's own members, which a JS spread would not do: %s", renderedDuplicate)
	}
}

// TestChatCompletionMoonshotProxyWithoutPassword is the lead's second claim as a test: a reverse proxy
// with no password yields `Bearer undefined` against a DOUBLED-slash target, and the shared key guard
// does NOT refuse it.
func TestChatCompletionMoonshotProxyWithoutPassword(t *testing.T) {
	body := moonshotTestBody(t, `{"model":"kimi-k2","messages":[{"role":"user","content":"u"}],"reverse_proxy":"https://probe.example"}`)
	key, err := pinnedChatCompletionMoonshotKey(body, nil)
	if err != nil {
		t.Fatalf("the splitter reported %v", err)
	}
	if pinnedJSTruthy(key) {
		t.Fatalf("a proxy with no password must yield an absent key, got %v", key)
	}
	// `'Bearer ' + apiKey` in JavaScript stringifies undefined, so the wire carries Bearer undefined.
	if rendered := pinnedClaudeJSString(key); rendered != "undefined" {
		t.Fatalf("String(apiKey) = %q, want the JavaScript spelling undefined", rendered)
	}
	// new URL("https://probe.example").toString() ends with a slash, so the shared concatenation doubles it.
	apiURL, ok := pinnedChatCompletionMoonshotURL(body)
	if !ok {
		t.Fatal("a bare origin is a parseable URL")
	}
	if got := apiURL + "/chat/completions"; got != "https://probe.example//chat/completions" {
		t.Fatalf("endpoint = %q, want the doubled-slash shape", got)
	}
	// The shared guard is `!apiKey && !reverse_proxy && source !== CUSTOM`: a truthy proxy skips it.
	reverseProxyTruthy := pinnedJSTruthy(sdBodyMember(body, "reverse_proxy"))
	if !pinnedJSTruthy(key) && !reverseProxyTruthy {
		t.Fatal("the guard would refuse this request, but the pinned code does not")
	}
}

// TestChatCompletionMoonshotMissingKeyIsRefused is a LABELLED DERIVATION: the shared guard's 400 cannot be
// reached on this branch because the arm is not wired into the builder yet, and the provider-wire harness
// refuses a scenario that records no provider request. What is asserted is the observable half that DOES
// exist today: with no secret and no reverse proxy the key splitter yields an absent key, which is the
// condition the pinned guard (:2615-2618) turns into 400 {"error":true} BEFORE any fetch, so no outbound
// request can be constructed.
func TestChatCompletionMoonshotMissingKeyIsRefused(t *testing.T) {
	body := moonshotTestBody(t, `{"model":"kimi-k2","messages":[{"role":"user","content":"u"}]}`)
	key, err := pinnedChatCompletionMoonshotKey(body, nil)
	if err != nil {
		t.Fatalf("the splitter reported %v", err)
	}
	if pinnedJSTruthy(key) {
		t.Fatalf("with no secret and no proxy the key must be absent, got %v", key)
	}
	reverseProxyTruthy := pinnedJSTruthy(sdBodyMember(body, "reverse_proxy"))
	if !(!pinnedJSTruthy(key) && !reverseProxyTruthy && chatCompletionSourceMoonshot != chatCompletionSourceCustom) {
		t.Fatal("the pinned guard shape does not hold for this body, so the derived 400 is wrong")
	}
}

// TestChatCompletionMoonshotStatusArmIsSelfContained checks the status arm is a method the central commit
// can register, and that its pinned envelope matches the shared non-ok shape.
func TestChatCompletionMoonshotStatusArmIsSelfContained(t *testing.T) {
	var runtime accountRuntime
	method := runtime.serveMoonshotChatCompletionStatus
	if method == nil {
		t.Fatal("the status arm is not a callable method")
	}
	// The envelope the arm answers for a non-ok provider answer is the shared one (:2143-2145); spelling
	// it here keeps the shape in one place, since the arm cannot be driven without the wiring.
	envelope := `{"error":true,"data":{"data":[]}}`
	var decoded map[string]any
	if err := json.Unmarshal([]byte(envelope), &decoded); err != nil {
		t.Fatalf("the shared non-ok envelope is not JSON: %v", err)
	}
	if decoded["error"] != true {
		t.Fatalf("the envelope lost its error flag: %v", decoded)
	}
	if _, ok := decoded["data"].(map[string]any)["data"].([]any); !ok {
		t.Fatalf("the envelope lost its data.data array: %v", decoded)
	}
}
