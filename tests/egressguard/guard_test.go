package egressguard

// PROVE THE GUARD CAN FAIL. AGENTS.md verification rule 7 and differential doctrine 4: a gate whose teeth have
// never been seen is decoration, and rule 14 exists because a gate that reported "no error" while a real request
// left the process was treated as evidence.
//
// EVERY CASE BELOW IS A REAL SOCKET OPERATION against a real address, not a mock of the dialer:
//
//   - a DIRECT DIAL to an address the harness did not declare must be REFUSED by the Control hook, with the
//     `*EgressDenied` error type, and must appear in `Violations()`. The address is a TEST-NET-1 address
//     (192.0.2.x, RFC 5737, guaranteed unroutable) so the case cannot reach anything even if the guard were
//     deleted -- a mutation of the guard is then the only way the assertion can go green.
//   - a request through the INSTALLED PROXY must ARRIVE at the proxy, which is what makes the proxy a real
//     assertion point rather than a decoration. `Assert` must then pass when the fixture claims it and FAIL when
//     it does not.
//   - a CONNECT tunnel (the shape a REAL provider request takes) must be refused and recorded.
//
// AND THE LAST CASE IS THE DEFECT ITSELF: a client that ignores the proxy and dials the provider directly. Under
// the old harness it would have recorded nothing and reported nothing; here it must be a FORBIDDEN EGRESS failure
// that NAMES the address, which is the rule-14 acceptance condition.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

// nowhere is RFC 5737 TEST-NET-1: unroutable by definition, so a case that "succeeds" in reaching it proves the
// test is fictional rather than that the guard failed.
const nowhere = "192.0.2.7"

func TestGuardRefusesAnUndeclaredDirectDial(t *testing.T) {
	guard := NewGuard()
	dialer := guard.DialContext(&net.Dialer{Timeout: 500 * time.Millisecond})

	conn, err := dialer.Dial("tcp", net.JoinHostPort(nowhere, "443"))
	if err == nil {
		_ = conn.Close()
		t.Fatalf("the guard PERMITTED a direct dial to %s: an undeclared address must be refused at connect time", nowhere)
	}
	var denied *EgressDenied
	if !errors.As(err, &denied) {
		t.Fatalf("the direct dial failed, but not as a FORBIDDEN EGRESS: %v -- "+
			"a plain 'connection refused' would be indistinguishable from a peer that is merely down", err)
	}
	if denied.Address != net.JoinHostPort(nowhere, "443") {
		t.Fatalf("the refusal names %q and the attempt was to %q", denied.Address, net.JoinHostPort(nowhere, "443"))
	}
	violations := guard.Violations()
	if len(violations) != 1 {
		t.Fatalf("expected exactly 1 recorded violation, got %d: %+v", len(violations), violations)
	}
	if violations[0].Stage != "dial" || violations[0].Host != nowhere {
		t.Fatalf("the violation does not name the stage and the host: %+v", violations[0])
	}
	t.Logf("refused as required: %s", violations[0])
}

func TestGuardPermitsADeclaredPeerAndTheProxy(t *testing.T) {
	guard := NewGuard()
	guard.AllowLoopback()
	proxy := NewProxy(t, guard)
	restore := proxy.MustInstall(t)
	defer restore()

	// A request to a NON-loopback provider host must reach the proxy. Loopback is used for the PEER but the
	// provider is addressed as 192.0.2.7 so that proxy resolution applies at all.
	client := &http.Client{
		Transport: &http.Transport{Proxy: http.ProxyFromEnvironment},
		Timeout:   5 * time.Second,
	}
	response, err := client.Get("http://" + net.JoinHostPort(nowhere, "8080") + "/v1/models")
	if err != nil {
		t.Fatalf("the request through the installed proxy failed before reaching it: %v", err)
	}
	_ = response.Body.Close()

	received := proxy.Received()
	if len(received) != 1 {
		t.Fatalf("the proxy received %d request(s), expected 1: %+v", len(received), received)
	}
	if received[0].Host != net.JoinHostPort(nowhere, "8080") || received[0].Path != "/v1/models" {
		t.Fatalf("the proxy recorded the wrong request: %+v", received[0])
	}
	t.Logf("the proxy received %s %s (host %s)", received[0].Method, received[0].Target, received[0].Host)
}

func TestAssertPassesOnTheClaimedSetAndFailsOnAnExtra(t *testing.T) {
	guard := NewGuard()
	guard.AllowLoopback()
	proxy := NewProxy(t, guard)
	restore := proxy.MustInstall(t)
	defer restore()

	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}, Timeout: 5 * time.Second}
	provider := "http://" + net.JoinHostPort(nowhere, "8080")
	for index := 0; index < 2; index++ {
		response, err := client.Get(provider + "/v1/chat/completions")
		if err != nil {
			t.Fatalf("request %d did not reach the proxy: %v", index, err)
		}
		_ = response.Body.Close()
	}

	// THE CLAIM: two identical polls. The multiset comparison must be satisfied by exactly two arrivals.
	Assert(t, guard, proxy, []Expectation{
		{Method: "GET", Target: "/v1/chat/completions", Host: net.JoinHostPort(nowhere, "8080")},
		{Method: "GET", Target: "/v1/chat/completions", Host: net.JoinHostPort(nowhere, "8080")},
	})

	// AND A CLAIM THAT DOES NOT MATCH IS A DIFFERENCE, so "at least one" cannot satisfy the assertion. The
	// comparison is `Compare`, the same function `Assert` reports from -- not a copy of it -- so these cases test
	// the assertion rather than a second implementation that could agree with a wrong one (doctrine 3).
	proxy.Reset()
	response, err := client.Get(provider + "/v1/chat/completions")
	if err != nil {
		t.Fatalf("the extra request did not reach the proxy: %v", err)
	}
	_ = response.Body.Close()
	received := proxy.Received()
	if len(received) != 1 {
		t.Fatalf("expected one arrival for the multiset case, got %d", len(received))
	}
	one := []Expectation{{Method: "GET", Target: "/v1/chat/completions", Host: net.JoinHostPort(nowhere, "8080")}}

	// 1. ONE ARRIVAL AGAINST A CLAIM OF TWO: the difference must be a MISSING request, so a run that dropped a
	//    request cannot pass by matching the one it did send.
	missing := Compare([]Expectation{one[0], one[0]}, received)
	if len(missing) != 1 || missing[0].Kind != "missing" {
		t.Fatalf("one arrival against a claim of two produced %+v; expected exactly one 'missing' difference", missing)
	}

	// 2. ONE ARRIVAL AGAINST A CLAIM OF NOTHING: the difference must be UNEXPECTED, so an escape that reaches the
	//    peer while the fixture claims no request is a failure rather than a silent extra.
	unexpected := Compare(nil, received)
	if len(unexpected) != 1 || unexpected[0].Kind != "unexpected" {
		t.Fatalf("one arrival against a claim of nothing produced %+v; expected exactly one 'unexpected' difference", unexpected)
	}

	// 3. THE MATCHING CASE MUST BE EMPTY, or every case above passes for a comparison that always differs.
	if differences := Compare(one, received); len(differences) != 0 {
		t.Fatalf("the exact claim produced %+v; expected no difference", differences)
	}
}

func TestProxyRefusesAndRecordsAConnectTunnel(t *testing.T) {
	guard := NewGuard()
	guard.AllowLoopback()
	proxy := NewProxy(t, guard)
	restore := proxy.MustInstall(t)
	defer restore()

	// HTTPS is the shape a REAL provider request takes: the transport opens a CONNECT tunnel. A differential peer
	// is plain HTTP, so a CONNECT can only mean a real host is being reached.
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}, Timeout: 5 * time.Second}
	response, err := client.Get("https://" + net.JoinHostPort(nowhere, "443") + "/v1/chat/completions")
	if err == nil {
		_ = response.Body.Close()
		t.Fatalf("a CONNECT tunnel to %s was permitted; it must be refused", nowhere)
	}
	if len(proxy.Unexpected()) != 1 {
		t.Fatalf("the CONNECT was not recorded as an unexpected arrival: %+v", proxy.Unexpected())
	}
	t.Logf("recorded as required: %s", proxy.Unexpected()[0])
}

// TestTheEscapeThatRule14WasWrittenFor is the defect itself: a client that ignores the configured proxy and dials
// the provider directly. Under the harness this guards (an assertion on "the peer received the expected requests"
// alone), this request would have produced NO record and NO error -- it would have looked like a pass.
func TestTheEscapeThatRule14WasWrittenFor(t *testing.T) {
	guard := NewGuard()
	guard.AllowLoopback()
	proxy := NewProxy(t, guard)
	// The proxy is installed, so a client that honours it is recorded. The escape is a client that does NOT.
	restoreProxy := proxy.MustInstall(t)
	defer restoreProxy()

	escaping := guard.DialContext(&net.Dialer{Timeout: 500 * time.Millisecond})
	conn, err := escaping.Dial("tcp", net.JoinHostPort(nowhere, "443"))
	if err == nil {
		_ = conn.Close()
		t.Fatalf("FORBIDDEN EGRESS WAS PERMITTED: a direct dial to the provider succeeded while the proxy was installed")
	}
	var denied *EgressDenied
	if !errors.As(err, &denied) {
		t.Fatalf("the escape failed for some other reason (%v); it must fail AS a forbidden egress or the assertion "+
			"cannot tell an escape from an unreachable peer", err)
	}
	if len(proxy.Received()) != 0 {
		t.Fatalf("the escape reached the proxy, so this case is not testing the direct-dial path: %+v", proxy.Received())
	}
	// THE ESCAPE MUST APPEAR AS A NAMED FAILURE, which is what the caller's Assert turns into a red test.
	if len(guard.Violations()) != 1 || guard.Violations()[0].Host != nowhere {
		t.Fatalf("the escape was not recorded as a violation naming %s: %+v", nowhere, guard.Violations())
	}
	fmt.Println("FORBIDDEN EGRESS detected as required:", guard.Violations()[0])
}

// AND THE PRODUCTION TRANSPORT MUST BE THE THING THE PROXY CARRIES, or the guard is measuring a test double.
// This case drives `outbound.Send` -- the shipped client -- at a provider addressed by a non-loopback host, and
// requires the request to ARRIVE AT THE PROXY. If the transport stopped honouring the environment, this fails,
// which is the property the whole assertion rests on.
func TestTheShippedTransportReachesTheInstalledProxy(t *testing.T) {
	guard := NewGuard()
	guard.AllowLoopback()
	proxy := NewProxy(t, guard)
	restore := proxy.MustInstall(t)
	defer restore()

	u := "http://" + net.JoinHostPort(nowhere, "8080") + "/v1/chat/completions"
	_, sendErr := outbound.Send(context.Background(), outbound.Request{
		Method:  "POST",
		URL:     u,
		Headers: []outbound.Header{{Name: "content-type", Value: "application/json"}},
		Body:    []byte(`{"model":"m","messages":[]}`),
	}, 5*time.Second)
	// The proxy answers 502 and forwards nothing, so an ERROR is expected -- what matters is that the request
	// ARRIVED. A success here would mean the proxy forwarded, which it must never do.
	received := proxy.Received()
	if len(received) != 1 {
		t.Fatalf("the shipped transport sent %d request(s) to the proxy (error: %v); expected exactly 1 -- "+
			"if this is 0, the production transport no longer honours the proxy environment and the guard would be "+
			"measuring nothing", len(received), sendErr)
	}
	if received[0].Path != "/v1/chat/completions" {
		t.Fatalf("the proxy received the wrong target: %+v", received[0])
	}
	// FROM NOW ON the production client exists in this binary, so a later Install must be REFUSED rather than
	// silently measured against a stale transport. The refusal is ASSERTED, so the guard cannot "apply" by doing
	// nothing -- the defect internal/server/transport_mode_test.go exists to catch for the wire-exact seam.
	MarkProviderClientBuilt()
	if _, installErr := proxy.Install(); !errors.Is(installErr, ErrClientAlreadyBuilt) {
		t.Fatalf("a proxy install after the transport client was built reported %v, expected ErrClientAlreadyBuilt", installErr)
	}
	t.Logf("shipped transport arrived at the proxy: %s %s (error as expected: %v)", received[0].Method, received[0].Target, sendErr)
}

func TestScrubRemovesEveryProxyVariable(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9")
	t.Setenv("no_proxy", "example.invalid")
	restore := ScrubProviderEnvironment(t)
	if value, ok := lookupAny(ProviderEnvironmentVariables); ok {
		t.Fatalf("a proxy variable survived the scrub: %s=%q", value.name, value.value)
	}
	restore()
	// The restore must put back what was there, or a test that scrubs leaks its change into every later test in
	// the same binary -- the shared-state defect AGENTS.md 16 records for fixtures, applied to the environment.
	if value := lookup("HTTPS_PROXY"); value != "http://127.0.0.1:9" {
		t.Fatalf("the restore lost HTTPS_PROXY: %q", value)
	}
	if value := lookup("no_proxy"); value != "example.invalid" {
		t.Fatalf("the restore lost no_proxy: %q", value)
	}
}

func lookup(name string) string {
	value, ok := os.LookupEnv(name)
	if !ok {
		return ""
	}
	return value
}

func lookupAny(names []string) (result struct{ name, value string }, found bool) {
	for _, name := range names {
		if value, ok := os.LookupEnv(name); ok {
			return struct{ name, value string }{name, value}, true
		}
	}
	return result, false
}
