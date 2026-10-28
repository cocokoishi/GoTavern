package server

// THE RULE-14 GATE FOR ONE PROVIDER ROUTE, END TO END, AND AN HONEST STATEMENT OF WHAT IT CANNOT SEE.
//
// WHAT THE EXISTING REPLAY ALREADY PROVES. `chat_completions_oracle_test.go` compares every request the recorder
// RECEIVED against the capture and asserts the COUNT. That is the first half of AGENTS.md verification rule 14 --
// "the peer received exactly the requests the fixture claims" -- for requests that ARRIVE at the recorder.
//
// WHAT WAS MISSING, AND WHAT THIS TEST ADDS. The replay has no observation of a request that goes ANYWHERE ELSE.
// Rule 14 was written because that happened on the pinned side: the AI Horde SDK called the global `fetch` past a
// `node-fetch` replacement and recorded live third-party data into a fixture that would have been committed. On the
// Go side the equivalent escape -- the production transport reaching the real provider because the seam did not
// apply -- would leave the recorder empty and be reported as "the route sent no provider request", which reads as a
// PRODUCT defect. This test makes that specific failure a NAMED egress finding instead.
//
// THE MECHANISM IS THE SEAM PLUS AN UNDECLARED-DESTINATION CANARY, not a dial hook -- and the reason is important
// enough to record here rather than in a commit message:
//
//   `internal/outbound` exposes NO way to supply a `net.Dialer`. `buildProductionClient` constructs its own
//   (transport.go:137) and `transportFor` CACHES the client per TLS config, so there is no seam a test can attach a
//   `net.Dialer.Control` hook to without changing production code. A test that installed such a hook and reported
//   "nothing was refused" would be asserting on a dialer the route never used -- a green that cannot fail, which is
//   the exact defect class rule 7 names. So this test does NOT claim that observation. What it proves is the
//   reachability half: the shipped transport made a real request to the address the harness declared, and that
//   address is a recorder whose reply the route returned. If the seam had failed to apply, the request would have
//   gone to a real provider and the recorder would be empty -- which fails here, by name, as an egress finding.
//
// THE FULL OBSERVATION (a proxy the shipped transport reaches through `http.ProxyFromEnvironment`, which catches a
// request leaving for any destination) lives in `tests/egressguard`, in its OWN test binary, because the client
// cache and net/http's environment cache are resolved once per process: installing a proxy in this shared binary
// after another provider test has run would measure a stale client. `tests/egressguard`
// TestTheShippedTransportReachesTheInstalledProxy proves `outbound.Send` reaches an installed proxy; that is the
// assertion this file cannot make and does not pretend to.

import (
	"net/http"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

func TestProviderEgressReachesOnlyTheDeclaredPeer(t *testing.T) {
	// THE SEAM'S ENVIRONMENT IS CLEARED FIRST. A developer machine or a CI runner that exports one of these would
	// point the transport somewhere the harness did not declare, and this test would then be measuring that
	// destination while reporting on the route.
	for _, name := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"} {
		t.Setenv(name, "")
	}

	scenario := providerWireScenario{}
	scenario.Request.Path = "/api/backends/chat-completions/generate"
	scenario.Secrets = map[string]any{"api_key_openai": []any{map[string]any{
		"id": "sid-openai", "value": "sk-egress-probe", "label": "openai", "active": true,
	}}}

	// THE DECLARED PEER is the mock provider the provider-wire evidence already rests on, so "the peer received
	// this" is recorded by the same mechanism the fixtures trust.
	recorder := mockprovider.New([]mockprovider.Response{{
		Status:  http.StatusOK,
		Headers: []mockprovider.Header{{Name: "content-type", Value: "application/json"}},
		Body:    `{"choices":[{"message":{"role":"assistant","content":"pong"}}]}`,
	}})
	address, err := recorder.Listen(0)
	if err != nil {
		t.Fatalf("start the declared peer: %v", err)
	}
	t.Cleanup(func() { _ = recorder.Close() })

	// THE SEAM. `GOTAVERN_OPENAI_CHAT_URL` is the documented base-URL variable the shipped planner reads
	// (openai_chat_status.go:49), and the route appends `/chat/completions` to it -- so the value is the BASE, not
	// the full endpoint. Setting the full endpoint here would produce `/v1/chat/completions/chat/completions`, and
	// this test would then pass or fail on a path shape rather than on egress.
	t.Setenv("GOTAVERN_OPENAI_CHAT_URL", "http://"+address.String())

	origin, cookie, token := startChatCompletionTestServer(t, scenario)
	rawBody := `{"chat_completion_source":"openai","model":"egress-model","messages":[{"role":"user","content":"ping"}],"stream":false}`
	status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, rawBody)

	// 1. THE REQUEST REACHED THE DECLARED PEER, and the answer came back through the route. Both halves matter: an
	//    empty recording means the request went somewhere else, and a non-200 with an empty recording is the
	//    "seam did not apply" shape that used to read as a product defect.
	recording := waitForProviderRecordingCount(t, recorder, false, 1)
	if len(recording.Requests) == 0 {
		t.Fatalf("EGRESS FINDING: the declared peer received NO request -- the shipped transport sent the generate "+
			"request to a destination the harness did not declare (route answered %d: %q). This is the escape shape "+
			"rule 14 exists to surface, not a product defect", status, text)
	}
	if status != http.StatusOK {
		t.Fatalf("the declared peer received the request but the route answered %d with %q; the reply did not travel "+
			"back through the route, so the recording does not describe what a user would see", status, text)
	}

	// 2. EXACTLY ONE request, with the exact method and raw target the seam describes. A second request would mean
	//    the route sent something the fixture does not claim -- the escape shape arriving at the RIGHT peer.
	if len(recording.Requests) != 1 {
		t.Fatalf("the peer received %d request(s) and the claim is 1: %+v", len(recording.Requests), recording.Requests)
	}
	got := recording.Requests[0]
	if got.Method != http.MethodPost {
		t.Errorf("the peer received %s and the claim is POST", got.Method)
	}
	// THE RAW TARGET, not the decoded path: what arrived on the wire is what a fixture preserves (AGENTS.md 15).
	// The route builds `<base>/chat/completions` (chat_completions.go:634), and the base is the bare recorder
	// address, so the target the peer must have received is exactly this path.
	if got.RawTarget != "/chat/completions" {
		t.Errorf("the peer received target %q and the claim is %q", got.RawTarget, "/chat/completions")
	}
	t.Logf("egress verified for the chat-completions route: the declared peer recorded %s %s and the route returned 200",
		got.Method, got.RawTarget)
}
