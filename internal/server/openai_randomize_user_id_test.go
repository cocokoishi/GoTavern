package server

// `openai.randomizeUserId` -- chat-completions.js:2296-2298:
//
//	if (getConfigValue('openai.randomizeUserId', false, 'boolean')) {
//	    bodyParams['user'] = uuidv4();
//	}
//
// It is inside the `CHAT_COMPLETION_SOURCES.OPENAI` arm only, the config default is FALSE
// (default/config.yaml:326-327), and the member is spread from `...bodyParams` at the END of the request body
// (chat-completions.js:2652-2669). A capture cannot record the value -- it is random by design -- so this test
// asserts what a user can actually observe:
//
//   - OFF (the shipped default): the body has NO top-level `user` member;
//   - ON: the body has a top-level `user` member holding a lowercase RFC 4122 v4 UUID, it is the LAST member
//     (which is where the pinned spread puts it), and two requests do not repeat a value;
//   - another source (`custom`) with the flag ON does NOT send it, because the assignment is not in its arm --
//     the assertion that separates "read the key" from "read the key in the right place".
//
// The route is driven end to end against a recording peer, so the observed bytes are the bytes that would
// reach a provider, not a struct the planner built twice.

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

// pinnedUUIDv4Pattern is the RFC 4122 version-4 layout `uuid`'s v4() produces: lowercase hex, version nibble 4
// and variant nibble 8/9/a/b.
var pinnedUUIDv4Pattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestOpenAIRandomizeUserIdSendsAPinnedUUIDv4Member(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		config    []string
		source    string
		wantUser  bool
		wantCount int
	}{
		{
			name:      "the shipped default sends no user member",
			config:    nil,
			source:    "openai",
			wantUser:  false,
			wantCount: 1,
		},
		{
			name:      "an explicit false sends no user member",
			config:    []string{"openai:", "  randomizeUserId: false"},
			source:    "openai",
			wantUser:  false,
			wantCount: 1,
		},
		{
			name:      "enabled sends a fresh v4 uuid per request",
			config:    []string{"openai:", "  randomizeUserId: true"},
			source:    "openai",
			wantUser:  true,
			wantCount: 2,
		},
		{
			// THE PLACEMENT ASSERTION: the assignment lives in the OPENAI arm, so a server with the key
			// enabled must still not put a `user` member on another source's request.
			name:      "another source never carries the member, even with the key enabled",
			config:    []string{"openai:", "  randomizeUserId: true"},
			source:    "custom",
			wantUser:  false,
			wantCount: 1,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := mockprovider.New([]mockprovider.Response{
				{Status: 200, Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json"}}, Body: `{"id":"mock-openai","choices":[]}`},
				{Status: 200, Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json"}}, Body: `{"id":"mock-openai","choices":[]}`},
			})
			address, err := recorder.Listen(0)
			if err != nil {
				t.Fatalf("start mock provider: %v", err)
			}
			t.Cleanup(func() { _ = recorder.Close() })

			scenario := chatCompletionTestScenario()
			scenario.BackendConfig = testCase.config
			origin, cookie, token := startChatCompletionTestServer(t, scenario)

			var body string
			switch testCase.source {
			case "openai":
				// The OPENAI arm's base URL is `request.body.reverse_proxy` when one is present, which is the
				// only way to aim it at a recorder without a seam (chat-completions.js:2282).
				body = `{"chat_completion_source":"openai","reverse_proxy":"http://` + address.String() +
					`","proxy_password":"probe-key","model":"probe-model","messages":[{"role":"user","content":"probe"}],"stream":false}`
			default:
				body = `{"chat_completion_source":"custom","custom_url":"http://` + address.String() +
					`/v1","model":"probe-model","messages":[{"role":"user","content":"probe"}],"stream":false}`
			}

			seen := make([]string, 0, testCase.wantCount)
			for attempt := 0; attempt < testCase.wantCount; attempt++ {
				status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, body)
				if status != http.StatusOK {
					t.Fatalf("request %d: status = %d, body %q", attempt, status, text)
				}
			}
			requests := recorder.Recording().Requests
			if len(requests) != testCase.wantCount {
				t.Fatalf("recorded %d provider requests, want %d", len(requests), testCase.wantCount)
			}
			for index, request := range requests {
				if request.BodyText == nil {
					t.Fatalf("request %d recorded no body text", index)
				}
				raw := *request.BodyText
				var decoded map[string]json.RawMessage
				if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
					t.Fatalf("request %d body is not a JSON object: %v (%q)", index, err, raw)
				}
				value, present := decoded["user"]
				if present != testCase.wantUser {
					t.Fatalf("request %d has a top-level `user` member = %t, want %t (body %q)", index, present, testCase.wantUser, raw)
				}
				if !present {
					continue
				}
				var userID string
				if err := json.Unmarshal(value, &userID); err != nil {
					t.Fatalf("request %d `user` is not a string: %v (%s)", index, err, string(value))
				}
				if !pinnedUUIDv4Pattern.MatchString(userID) {
					t.Errorf("request %d user = %q, want a lowercase RFC 4122 v4 UUID", index, userID)
				}
				// POSITION: `...bodyParams` is the last spread, so the member closes the object.
				if !strings.HasSuffix(raw, `"user":"`+userID+`"}`) {
					t.Errorf("request %d body = %q, want `user` to be the LAST member (pinned spreads bodyParams last)", index, raw)
				}
				seen = append(seen, userID)
			}
			if len(seen) > 1 && seen[0] == seen[1] {
				t.Errorf("two requests carried the same user id %q; a fresh uuidv4 is generated per request", seen[0])
			}
		})
	}
}
