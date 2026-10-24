package server

// Rule 17 at the HTTP level for the OPENAI status arm: an implemented source and an unimplemented
// one must not answer the same thing.
//
// This package answers 501 for a source it has no transport for, so a source that silently fell to
// that branch would make "not implemented" indistinguishable from "implemented but failing" -- the
// exact confusion rule 17 exists to prevent. Before this lane OPENAI answered 501 on /status while
// nine other sources did not, so every inventory row claiming the ten chat-completion sources were
// implemented was wrong for exactly that one Connect button.
//
// Both assertions are HTTP-level and need no network:
//
//   - OPENAI with a reverse_proxy pointed at the recording peer REACHES THE FETCH, so it answers the
//     pinned non-2xx envelope (200 {"error":true,"data":{"data":[]}}) and the peer receives exactly
//     one request. Reaching the provider is the proof the arm exists.
//   - an UNKNOWN source name reaches pinned's closing else and answers 400 {"error":true} while the peer
//     receives nothing, so a refusal stays distinguishable from a gap and neither makes requests. The
//     bullet used to describe AI21 answering 501; AI21 has since been fixed to answer the pinned 400 (see
//     backends_status.go's pinnedChatCompletionStatusNoArmSources), which is exactly why the control names
//     no real source: a control naming one rots the day that source lands.
//
// The key/URL/envelope details are not re-derived here -- they are the oracle's job, in
// status.openai.{ok,reverseProxy,reverseProxyNoPassword,nonOk,noKey}.

import (
	"net/http"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

func TestOpenAIStatusIsNotA501Gap(t *testing.T) {
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
	// pinned envelope's branch. The envelope's own content is also pinned by status.openai.nonOk.
	mockOrigin := "http://" + address.String()

	for _, testCase := range []struct {
		name         string
		body         string
		wantStatus   int
		wantBody     string
		wantOutbound int
	}{
		{
			name:         "openai reaches its arm",
			body:         `{"chat_completion_source":"openai","reverse_proxy":"` + mockOrigin + `"}`,
			wantStatus:   http.StatusOK,
			wantBody:     `{"error":true,"data":{"data":[]}}`,
			wantOutbound: 1,
		},
		{
			// THE DURABLE CONTROL, and it names no real source: an UNKNOWN name reaches pinned's
			// closing else and answers 400 {"error":true} (chat-completions.js:2062-2065). The
			// previous control here was `ai21`, which was unimplemented when the row was written and
			// became "assert that an implemented source is unimplemented" when it landed. The row
			// carries reverse_proxy pointing at the peer, so a refactor that let an unknown name fall
			// into a provider arm shows up as a request at the peer rather than as a plausible 400.
			name:         "an unknown source name answers the chain's 400 and reaches no provider",
			body:         `{"chat_completion_source":"` + pinnedUnknownChatCompletionSource + `","reverse_proxy":"` + mockOrigin + `"}`,
			wantStatus:   http.StatusBadRequest,
			wantBody:     `{"error":true}`,
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
