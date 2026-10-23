package server

// Focused tests for the pinned early-return paths and for the secret shape,
// separate from the oracle-bound differential in chat_completions_oracle_test.go.
//
// The secret-shape test exists because a route that reads the secrets file with
// the wrong shape still sends an Authorization header that looks correct once
// redacted. Pinned readSecret returns '' for anything that is not an array of
// {id, value, active} records, so the header is present and empty, and the
// request reaches the provider looking plausible. Asserting the empty key is
// what makes the differential's authorizationKeyVerified meaningful.

import (
	"net/http"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

func chatCompletionTestScenario() providerWireScenario {
	scenario := providerWireScenario{}
	scenario.Request.Path = "/api/backends/chat-completions/generate"
	return scenario
}

func TestChatCompletionGenerateRejectsSourcesItCannotServe(t *testing.T) {
	scenario := chatCompletionTestScenario()
	origin, cookie, token := startChatCompletionTestServer(t, scenario)

	for _, testCase := range []struct {
		name       string
		body       string
		wantStatus int
		wantBody   string
		wantType   string
	}{
		{
			// chat-completions.js:2595-2597: the pinned handler's final else.
			name:       "unknown source",
			body:       `{"chat_completion_source":"not-a-source"}`,
			wantStatus: http.StatusBadRequest,
			wantBody:   `{"error":true}`,
			wantType:   "application/json; charset=utf-8",
		},
		{
			// An absent source never matches a case, so it reaches the same else.
			name:       "absent source",
			body:       `{}`,
			wantStatus: http.StatusBadRequest,
			wantBody:   `{"error":true}`,
			wantType:   "application/json; charset=utf-8",
		},
		{
			// chat-completions.js:2615-2618: an OpenAI source with no key and no
			// reverse proxy is rejected before any connection is made.
			name:       "openai without a key",
			body:       `{"chat_completion_source":"openai","model":"probe-model","messages":[]}`,
			wantStatus: http.StatusBadRequest,
			wantBody:   `{"error":true}`,
			wantType:   "application/json; charset=utf-8",
		},
		{
			// AN UNKNOWN SOURCE NAME answers the pinned chain's own 400 {"error":true}
			// (chat-completions.js:2594-2597), which is what makes the 501 below MEANINGFUL: the two
			// differ in status, body and content type, so a route that answered either one to
			// everything fails one of them.
			//
			// This row used to be the 501 case, first naming whichever source was unimplemented and
			// then CLAUDE, which landed and turned it into "assert that an implemented source is
			// unimplemented". A real source name can always land; an unknown one cannot.
			name:       "unknown source name",
			body:       `{"chat_completion_source":"` + pinnedUnknownChatCompletionSource + `","model":"probe-model","messages":[]}`,
			wantStatus: http.StatusBadRequest,
			wantBody:   `{"error":true}`,
			wantType:   "application/json; charset=utf-8",
		},
		{
			// A KNOWN pinned source whose transport is not implemented here. The status is
			// deliberately not the pinned provider call: a fabricated success would be worse than a
			// visible gap. This half is driven by the registry (pinnedUnportedChatCompletionSources) in
			// chat_completion_control_test.go, so it follows the list instead of naming a source here.
			name:       "known pinned source without a transport",
			body:       `{"chat_completion_source":"cometapi","model":"probe-model","messages":[]}`,
			wantStatus: http.StatusNotImplemented,
			wantBody:   "Not Implemented",
			wantType:   "text/plain; charset=utf-8",
		},
		{
			// chat-completions.js:235-238: CLAUDE checks its key BEFORE the try, so an unconfigured
			// server answers 400 {"error":true} rather than the generic provider guard's shape.
			name:       "claude without a key",
			body:       `{"chat_completion_source":"claude","model":"probe-model","messages":[]}`,
			wantStatus: http.StatusBadRequest,
			wantBody:   `{"error":true}`,
			wantType:   "application/json; charset=utf-8",
		},
		{
			// PERPLEXITY reaches the SHARED guard (:2615) because :2424 reads its secret
			// unconditionally and never assigns it from proxy_password, so an unconfigured server
			// answers 400 {"error":true} and makes NO provider request. This row is why deleting the
			// `perplexity-missing-key` scenario loses nothing: the harness refuses a capture with zero
			// provider requests, so the route observable is asserted here instead of pretending to be a
			// recording. The test server has no peer, so a route that tried to fetch would answer
			// something else and fail this row.
			name:       "perplexity without a key",
			body:       `{"chat_completion_source":"perplexity","model":"sonar","messages":[{"role":"user","content":"probe"}]}`,
			wantStatus: http.StatusBadRequest,
			wantBody:   `{"error":true}`,
			wantType:   "application/json; charset=utf-8",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			status, header, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, testCase.body)
			if status != testCase.wantStatus {
				t.Errorf("status = %d, want %d (body %q)", status, testCase.wantStatus, text)
			}
			if text != testCase.wantBody {
				t.Errorf("body = %q, want %q", text, testCase.wantBody)
			}
			if contentType := header.Get("Content-Type"); contentType != testCase.wantType {
				t.Errorf("content type = %q, want %q", contentType, testCase.wantType)
			}
		})
	}
}

func TestChatCompletionSecretMustUseThePinnedArrayShape(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		secrets     map[string]any
		wantKeyText string
	}{
		{
			name: "pinned array shape",
			secrets: map[string]any{
				"api_key_custom": []any{map[string]any{"id": "probe", "value": "shape-key", "label": "probe", "active": true}},
			},
			wantKeyText: "Bearer shape-key",
		},
		{
			// A plain string is what a hand-written or legacy file looks like.
			// Pinned readSecret returns '' for it, so the request is still sent
			// with an Authorization header that has no key in it.
			name:        "flat string shape",
			secrets:     map[string]any{"api_key_custom": "flat-string-key"},
			wantKeyText: "Bearer ",
		},
		{
			name:        "inactive record",
			secrets:     map[string]any{"api_key_custom": []any{map[string]any{"id": "probe", "value": "inactive-key", "label": "probe", "active": false}}},
			wantKeyText: "Bearer ",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := mockprovider.New([]mockprovider.Response{{
				Status:  200,
				Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json"}},
				Body:    `{"id":"mock-custom","choices":[]}`,
			}})
			address, err := recorder.Listen(0)
			if err != nil {
				t.Fatalf("start mock provider: %v", err)
			}
			t.Cleanup(func() { _ = recorder.Close() })

			scenario := chatCompletionTestScenario()
			scenario.Secrets = testCase.secrets
			origin, cookie, token := startChatCompletionTestServer(t, scenario)
			body := `{"chat_completion_source":"custom","custom_url":"http://` + address.String() + `/v1","model":"probe-model","messages":[{"role":"user","content":"probe"}],"stream":false}`
			status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, body)
			if status != http.StatusOK {
				t.Fatalf("status = %d, body %q", status, text)
			}
			recording := recorder.Recording()
			if len(recording.Requests) != 1 {
				t.Fatalf("recorded %d provider requests, want 1", len(recording.Requests))
			}
			observed := ""
			for _, header := range recording.Requests[0].Headers {
				if header.Name == "authorization" {
					observed = header.Value
				}
			}
			if observed != testCase.wantKeyText {
				t.Errorf("provider saw authorization %q, want %q", observed, testCase.wantKeyText)
			}
			if !strings.HasPrefix(observed, "Bearer ") {
				t.Errorf("the Authorization header must always be present, got %q", observed)
			}
		})
	}
}
