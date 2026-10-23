package server

// Focused tests for the MINIMAX chat source, separate from its oracle-bound replay.
//
// Three things that the recorded scenarios cannot decide on their own, each labelled with what kind
// of evidence it is:
//
//  1. THE ENDPOINT HOSTS ARE AN ORACLE ASSERTION (TestMinimaxChatEndpointHosts). The backends replay
//     points both of this source's seams at its own recorder, so the recorded provider TARGET is the
//     same for the global and the CN scenario; what distinguishes them is the HOST in the recorded
//     outbound URL, which came from the pinned leg. This test reads that host out of the fixture, so
//     the branch is pinned by evidence rather than by a transcription of the pinned source.
//
//  2. THE BRANCH ITSELF IS A DERIVATION (TestMinimaxChatEndpointSwitch), because no capture can show
//     which seam Go looked up. The pinned comparison is `=== MINIMAX_ENDPOINT.CN` -- a strict string
//     comparison -- so 'CN', 'global', a truthy non-string and an absent member all take the GLOBAL
//     host. This is a table test against those predicates, and it is the test that stops a CN/global
//     swap before the replay could reach a real provider.
//
//  3. THE 501 DISTINCTION IS AN HTTP-LEVEL ASSERTION (TestMinimaxChatIsNotA501Gap), rule 17: MINIMAX
//     is implemented, so it must not answer 501; a source with no arm still must. The no-key branch
//     is used for MINIMAX because it refuses BEFORE the fetch, so the test needs no network.

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestMinimaxChatEndpointHosts(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-backends.json"))
	if err != nil {
		t.Fatalf("read the backends oracle: %v", err)
	}
	var fixture struct {
		Observations map[string]struct {
			Outbound []struct {
				URL string `json:"url"`
			} `json:"outbound"`
		} `json:"observations"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode the backends oracle: %v", err)
	}
	for _, testCase := range []struct {
		scenario string
		wantHost string
		wantPath string
	}{
		{scenario: "minimaxChat.nonStream", wantHost: "api.minimax.io", wantPath: "/v1/chat/completions"},
		{scenario: "minimaxChat.cnEndpoint", wantHost: "api.minimaxi.com", wantPath: "/v1/chat/completions"},
	} {
		t.Run(testCase.scenario, func(t *testing.T) {
			observation, exists := fixture.Observations[testCase.scenario]
			if !exists {
				t.Fatalf("the oracle records no scenario %q", testCase.scenario)
			}
			if len(observation.Outbound) != 1 {
				t.Fatalf("%s: recorded %d outbound requests, want the one provider call", testCase.scenario, len(observation.Outbound))
			}
			parsed, parseErr := url.Parse(observation.Outbound[0].URL)
			if parseErr != nil {
				t.Fatalf("%s: recorded outbound url %q: %v", testCase.scenario, observation.Outbound[0].URL, parseErr)
			}
			if parsed.Host != testCase.wantHost {
				t.Fatalf("%s: the pinned leg called %q, want the %q host (the endpoint switch moves the HOST, not only the path)",
					testCase.scenario, parsed.Host, testCase.wantHost)
			}
			if parsed.Path != testCase.wantPath {
				t.Fatalf("%s: the pinned leg called path %q, want %q", testCase.scenario, parsed.Path, testCase.wantPath)
			}
		})
	}
}

func TestMinimaxChatEndpointSwitch(t *testing.T) {
	const globalSentinel = "http://global.sentinel.invalid/v1"
	const cnSentinel = "http://cn.sentinel.invalid/v1"
	t.Setenv(minimaxChatSeamEnv, globalSentinel)
	t.Setenv(minimaxChatCNSeamEnv, cnSentinel)

	if got := minimaxChatGlobalBaseURL(); got != globalSentinel {
		t.Fatalf("the global seam did not take effect: %q", got)
	}
	if got := minimaxChatCNBaseURL(); got != cnSentinel {
		t.Fatalf("the CN seam did not take effect: %q", got)
	}

	for _, testCase := range []struct {
		name string
		body string
		want string
	}{
		// `request.body.minimax_endpoint === MINIMAX_ENDPOINT.CN` is a STRICT comparison.
		{name: "cn selects the CN host", body: `{"minimax_endpoint":"cn"}`, want: cnSentinel},
		{name: "uppercase is not equal", body: `{"minimax_endpoint":"CN"}`, want: globalSentinel},
		{name: "global selects the global host", body: `{"minimax_endpoint":"global"}`, want: globalSentinel},
		{name: "a truthy non-string is not equal", body: `{"minimax_endpoint":1}`, want: globalSentinel},
		{name: "an absent member selects the global host", body: `{}`, want: globalSentinel},
		{name: "null selects the global host", body: `{"minimax_endpoint":null}`, want: globalSentinel},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			body, err := decodeOrderedNodeJSON([]byte(testCase.body))
			if err != nil {
				t.Fatalf("decode %s: %v", testCase.body, err)
			}
			if got := minimaxChatBaseURL(body); got != testCase.want {
				t.Fatalf("minimaxChatBaseURL(%s) = %q, want %q", testCase.body, got, testCase.want)
			}
		})
	}
}

func TestMinimaxChatIsNotA501Gap(t *testing.T) {
	scenario := providerWireScenario{}
	scenario.Request.Path = "/api/backends/chat-completions/generate"
	origin, cookie, token := startChatCompletionTestServer(t, scenario)

	// No recorder is started: neither case may reach a provider, and the zero-outbound evidence for
	// this branch is the recorded scenario minimaxChat.noKey (outbound []), not a live measurement.
	for _, testCase := range []struct {
		name       string
		body       string
		wantStatus int
		wantBody   string
	}{
		{
			// MINIMAX is implemented: with no api_key_minimax the branch refuses BEFORE the fetch
			// (chat-completions.js:1612-1615), which is a 400 and never 501.
			name:       "minimax reaches its branch",
			body:       `{"chat_completion_source":"minimax","model":"abab6.5s-chat","messages":[],"max_tokens":16}`,
			wantStatus: http.StatusBadRequest,
			wantBody:   `{"error":true}`,
		},
		{
			// A pinned source with no transport here: the visible gap, and no request.
			name:       "a source with no arm stays a gap",
			body:       `{"chat_completion_source":"ai21","model":"probe-model","messages":[]}`,
			wantStatus: http.StatusNotImplemented,
			wantBody:   "Not Implemented",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, testCase.body)
			if status != testCase.wantStatus {
				t.Fatalf("status = %d, want %d (body %q)", status, testCase.wantStatus, text)
			}
			if text != testCase.wantBody {
				t.Fatalf("body = %q, want %q", text, testCase.wantBody)
			}
		})
	}
}
