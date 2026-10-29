package outbound

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// THE PRIVATE ADDRESS FILTER, OBSERVED AS A REQUEST COUNT.
//
// AGENTS.md rule 17: for a refusal the assertion is the NUMBER OF OUTBOUND REQUESTS, not the status --
// a peer that answers 403 has already received the request, and "the peer received nothing" is the only
// statement that distinguishes filtering from rejecting. Every test below therefore drives the SHIPPED
// transport (`outbound.Send`) at a real local peer and counts what arrived.
//
// The peers are on loopback, which is one of pinned's eight private ranges (127.0.0.0/8), so the default
// whitelist is emptied for the blocking cases and set explicitly for the allowing ones. Each case gets its
// own peer on its own port: the production client pools connections per host:port, and reusing a port
// across a "disabled" and an "enabled" case would let the second case ride an already-open socket and
// never dial at all -- a green that proves nothing.

// countingPeer is a local peer that counts the requests it received.
type countingPeer struct {
	server *httptest.Server
	mu     sync.Mutex
	count  int
}

func newCountingPeer(t *testing.T) *countingPeer {
	t.Helper()
	peer := &countingPeer{}
	peer.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		peer.mu.Lock()
		peer.count++
		peer.mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(peer.server.Close)
	return peer
}

// newLoopbackV6Peer is a peer on ::1, a DIFFERENT private range from 127.0.0.0/8. The redirect-hop case
// needs two private addresses whose whitelist status differs, and 127.0.0.1 versus ::1 is the only pair a
// loopback-only test can build.
func newLoopbackV6Peer(t *testing.T) *countingPeer {
	t.Helper()
	listener, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Fatalf("this test needs an IPv6 loopback listener to put the redirect target on a different private range from the first hop: %v", err)
	}
	peer := &countingPeer{}
	peer.server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		peer.mu.Lock()
		peer.count++
		peer.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	peer.server.Listener = listener
	peer.server.Start()
	t.Cleanup(peer.server.Close)
	return peer
}

func (peer *countingPeer) Requests() int {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	return peer.count
}

// URL is the peer's base URL, e.g. `http://127.0.0.1:41234` or `http://[::1]:41234`.
func (peer *countingPeer) URL() string { return peer.server.URL }

// sendThroughTheShippedTransport is the subject: the production client, the filter's real entry point.
func sendThroughTheShippedTransport(t *testing.T, target string) error {
	t.Helper()
	_, err := Send(context.Background(), Request{
		URL:     target,
		Method:  http.MethodPost,
		Headers: []Header{{Name: "content-type", Value: "application/json"}},
		Body:    []byte(`{"probe":true}`),
	}, 5*time.Second)
	return err
}

// configureForTest installs a filter and guarantees the process is left with none, so a case cannot leak
// state into the next one (the filter is process-wide, like pinned's module singleton).
func configureForTest(t *testing.T, options PrivateAddressFilterOptions) {
	t.Helper()
	if options.Console == nil {
		options.Console = io.Discard
	}
	if options.Errors == nil {
		options.Errors = io.Discard
	}
	if err := ConfigurePrivateAddressFilter(options); err != nil {
		t.Fatalf("ConfigurePrivateAddressFilter: %v", err)
	}
	t.Cleanup(DisablePrivateAddressFilter)
}

// TestPrivateAddressFilterBlocksAPrivatePeerBeforeItIsReached is the case the whole task exists for: the
// operator switched the filter on, and the peer must receive NOTHING.
func TestPrivateAddressFilterBlocksAPrivatePeerBeforeItIsReached(t *testing.T) {
	peer := newCountingPeer(t)
	configureForTest(t, PrivateAddressFilterOptions{Enabled: true, LogBlocked: true})

	err := sendThroughTheShippedTransport(t, peer.URL()+"/v1/chat/completions")
	if err == nil {
		t.Fatal("the request to a loopback peer succeeded with the filter enabled; the filter did not apply")
	}
	// rule 35: the failure names the reason, not "cannot connect to server".
	if !strings.Contains(err.Error(), "Blocked request to private IP address: 127.0.0.1") {
		t.Fatalf("error = %q, want it to name the pinned refusal (src/private-request-filter.js:158)", err)
	}
	if got := peer.Requests(); got != 0 {
		t.Fatalf("the peer received %d request(s), want 0: a filtered request must never reach the peer, and a status code is not a refusal", got)
	}
}

// TestPrivateAddressFilterDisabledChangesNothing is requirement 1: the default configuration, and a
// process that never configured the filter at all, must behave exactly as they did before the filter
// existed. Each case gets its own peer so no pooled connection can make it vacuous.
func TestPrivateAddressFilterDisabledChangesNothing(t *testing.T) {
	t.Run("never configured", func(t *testing.T) {
		DisablePrivateAddressFilter()
		peer := newCountingPeer(t)
		if err := sendThroughTheShippedTransport(t, peer.URL()+"/v1/chat/completions"); err != nil {
			t.Fatalf("an unfiltered request failed: %v", err)
		}
		if got := peer.Requests(); got != 1 {
			t.Fatalf("the peer received %d request(s), want exactly 1", got)
		}
	})

	t.Run("configured disabled", func(t *testing.T) {
		peer := newCountingPeer(t)
		// A disabled filter with a whitelist that excludes the peer: if the enabled flag were ignored,
		// this case would block and the count would be 0.
		configureForTest(t, PrivateAddressFilterOptions{Enabled: false, AllowedRanges: []string{"10.0.0.0/8"}})
		if err := sendThroughTheShippedTransport(t, peer.URL()+"/v1/chat/completions"); err != nil {
			t.Fatalf("a request with the filter disabled failed: %v", err)
		}
		if got := peer.Requests(); got != 1 {
			t.Fatalf("the peer received %d request(s), want exactly 1", got)
		}
	})
}

// TestPrivateAddressFilterAllowsAWhitelistedAddress proves the filter is not "block everything": an
// allowedRanges entry that covers the target lets the request through, and log.allowedRequests gates the
// pinned info line.
func TestPrivateAddressFilterAllowsAWhitelistedAddress(t *testing.T) {
	cases := []struct {
		name    string
		pattern string
		why     string
	}{
		{name: "CIDR", pattern: "127.0.0.0/8", why: "the shipped default shape"},
		{name: "exact address", pattern: "127.0.0.1", why: "an exact IP is a /32"},
		{name: "wildcard", pattern: "127.*.*.*", why: "the ip-matching wildcard form"},
		{name: "range", pattern: "127.0.0.0-127.0.0.9", why: "the ip-matching range form"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			peer := newCountingPeer(t)
			var allowed bytes.Buffer
			configureForTest(t, PrivateAddressFilterOptions{
				Enabled: true, AllowedRanges: []string{testCase.pattern}, LogAllowed: true, Console: &allowed,
			})
			if err := sendThroughTheShippedTransport(t, peer.URL()+"/v1/chat/completions"); err != nil {
				t.Fatalf("whitelisting %q (%s) did not let the request through: %v", testCase.pattern, testCase.why, err)
			}
			if got := peer.Requests(); got != 1 {
				t.Fatalf("the peer received %d request(s), want exactly 1", got)
			}
			if !strings.Contains(allowed.String(), "[Private Request Filter] Allowed request to private IP address: 127.0.0.1") {
				t.Fatalf("console = %q, want pinned's allowed line (src/private-request-filter.js:151-153)", allowed.String())
			}
		})
	}
}

// TestPrivateAddressFilterValidatesEveryRedirectHop is requirement 3. The first hop is a private address
// the whitelist permits, so the request DOES reach it; the redirect target is a different private address
// the whitelist does not permit, so the hop must be refused -- and the second peer must receive NOTHING.
// A filter that only validated the first request would let the redirect through and the count would be 1.
func TestPrivateAddressFilterValidatesEveryRedirectHop(t *testing.T) {
	target := newLoopbackV6Peer(t)
	entry := newCountingPeer(t)
	entry.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.server.URL+"/v1/chat/completions", http.StatusFound)
	})

	configureForTest(t, PrivateAddressFilterOptions{Enabled: true, AllowedRanges: []string{"127.0.0.1"}})
	err := sendThroughTheShippedTransport(t, entry.URL()+"/v1/chat/completions")
	if err == nil {
		t.Fatal("the redirect to a private address that is not whitelisted succeeded; the hop was not validated")
	}
	if !strings.Contains(err.Error(), "Blocked request to private IP address: ::1") {
		t.Fatalf("error = %q, want it to name the blocked redirect target ::1", err)
	}
	if got := target.Requests(); got != 0 {
		t.Fatalf("the redirect target received %d request(s), want 0", got)
	}
}

// TestPrivateAddressFilterResolvesTheHostnameBeforeItDecides is requirement 2's hostname half, end to end.
//
// `localhost` is a genuine hostname (not an IP literal) that resolves WITHOUT a network query: Go reads
// the hosts file first, and the measurement is `addrs=[::1 127.0.0.1]` in 3ms. That is the documented,
// bounded substitute for a controlled resolver -- no production seam was added for it -- and the
// assertion that the error names a RESOLVED private address rather than `localhost` is what proves the
// decision was made after resolution.
func TestPrivateAddressFilterResolvesTheHostnameBeforeItDecides(t *testing.T) {
	peer := newCountingPeer(t)
	hostname := strings.Replace(peer.URL(), "127.0.0.1", "localhost", 1)

	// The control: the same hostname reaches the peer with the filter disabled. Without this row the
	// refusal below could be caused by anything at all.
	if err := sendThroughTheShippedTransport(t, hostname+"/v1/chat/completions"); err != nil {
		t.Fatalf("the control request to %s failed, so this test cannot attribute anything to the filter: %v", hostname, err)
	}
	if got := peer.Requests(); got != 1 {
		t.Fatalf("the control request reached the peer %d time(s), want 1", got)
	}

	// A fresh peer and port, so the control's pooled connection cannot be reused by this leg.
	blockedPeer := newCountingPeer(t)
	blockedHostname := strings.Replace(blockedPeer.URL(), "127.0.0.1", "localhost", 1)
	configureForTest(t, PrivateAddressFilterOptions{Enabled: true})

	err := sendThroughTheShippedTransport(t, blockedHostname+"/v1/chat/completions")
	if err == nil {
		t.Fatal("a hostname resolving into a private range was not blocked")
	}
	var blocked *BlockedPrivateAddressError
	if !errors.As(err, &blocked) {
		t.Fatalf("error = %q (%T), want a *BlockedPrivateAddressError", err, err)
	}
	if !isPrivateAddress(blocked.Address) {
		t.Fatalf("the refusal named %s, which is not in any of pinned's private ranges", blocked.Address)
	}
	if strings.Contains(err.Error(), "Blocked request to private IP address: localhost") {
		t.Fatalf("error = %q: the decision was made on the HOSTNAME, not on the resolved address", err)
	}
	if got := blockedPeer.Requests(); got != 0 {
		t.Fatalf("the peer received %d request(s) for a hostname resolving into a private range, want 0", got)
	}
}

// TestPrivateAddressFilterRefusesAnUnresolvableHostUnlessAllowed is requirement 4, both ways. The hostname
// carries a character Go's own domain-name check rejects, so the lookup fails WITHOUT a resolver query
// (measured: 0s, `no such host`, IsNotFound=true) -- this case touches no network at all.
func TestPrivateAddressFilterRefusesAnUnresolvableHostUnlessAllowed(t *testing.T) {
	const unresolvable = "no_such_host!:80"

	// A base dialer that fails immediately in its Control hook, which runs BEFORE connect(2): nothing is
	// dialled, and its error is a marker that proves the filter DELEGATED rather than decided.
	sentinel := errors.New("sentinel: the base dialer was reached")
	var baseCalls int32
	base := &net.Dialer{Control: func(_, _ string, _ syscall.RawConn) error {
		atomic.AddInt32(&baseCalls, 1)
		return sentinel
	}}

	t.Run("refused when allowUnresolvedHosts is false", func(t *testing.T) {
		var errorsOut bytes.Buffer
		configureForTest(t, PrivateAddressFilterOptions{Enabled: true, Errors: &errorsOut})
		filter := currentPrivateAddressFilter()
		_, err := filter.dial(context.Background(), base, "tcp", unresolvable)
		if err == nil {
			t.Fatal("an unresolvable host was dialled")
		}
		var unresolved *UnresolvedHostError
		if !errors.As(err, &unresolved) {
			t.Fatalf("error = %q (%T), want a *UnresolvedHostError", err, err)
		}
		if !strings.Contains(err.Error(), "Unable to resolve host: no_such_host!") ||
			!strings.Contains(err.Error(), "privateAddressWhitelist.allowUnresolvedHosts") {
			t.Fatalf("error = %q, want pinned's text (src/private-request-filter.js:190)", err)
		}
		if got := atomic.LoadInt32(&baseCalls); got != 0 {
			t.Fatalf("the base dialer was reached %d time(s) for an unresolvable host, want 0", got)
		}
		if !strings.Contains(errorsOut.String(), "Unable to resolve host: no_such_host!") {
			t.Fatalf("stderr = %q, want the refusal logged (raiseError logs unconditionally, :115-120)", errorsOut.String())
		}
	})

	t.Run("delegated when allowUnresolvedHosts is true", func(t *testing.T) {
		configureForTest(t, PrivateAddressFilterOptions{Enabled: true, AllowUnresolvedHosts: true})
		filter := currentPrivateAddressFilter()
		_, err := filter.dial(context.Background(), base, "tcp", unresolvable)
		// The delegation is observable as the error's ORIGIN: the base dialer resolves the hostname
		// itself (that is what pinned's `connect()` does at :187-189), so the failure is a DNS error from
		// the resolver rather than the filter's own refusal. Control is never reached because resolution
		// happens first, which is why the assertion is on the error type and not on the call counter.
		var unresolved *UnresolvedHostError
		if errors.As(err, &unresolved) {
			t.Fatalf("the filter refused an unresolvable host even though allowUnresolvedHosts is true: %v", err)
		}
		var dnsError *net.DNSError
		if !errors.As(err, &dnsError) {
			t.Fatalf("error = %v (%T), want the base dialer's own DNS failure: with allowUnresolvedHosts true the filter must delegate the hostname (:187-189)", err, err)
		}
		if dnsError.Name != "no_such_host!" {
			t.Fatalf("the DNS failure names %q, want the original hostname -- the filter must not have resolved it itself", dnsError.Name)
		}
	})
}

// TestPrivateAddressFilterNeverDialsAnAddressItDidNotCheck is the safety property behind decision 2: for a
// private address the base dialer is NEVER reached, and for a public address it IS. The base dialer's
// Control hook fails the dial before connect(2), so this case opens no socket.
func TestPrivateAddressFilterNeverDialsAnAddressItDidNotCheck(t *testing.T) {
	sentinel := errors.New("sentinel: the base dialer was reached")
	cases := []struct {
		name    string
		address string
		want    bool // whether the base dialer should be reached
		why     string
	}{
		{name: "private v4", address: "10.1.2.3:443", want: false, why: "10.0.0.0/8 is private"},
		{name: "loopback", address: "127.0.0.1:443", want: false, why: "127.0.0.0/8 is private"},
		{name: "private v6", address: "[fd12::1]:443", want: false, why: "fc00::/7 is private"},
		{name: "link-local v6", address: "[fe80::1]:443", want: false, why: "fe80::/10 is private"},
		{name: "public v4", address: "93.184.216.34:443", want: true, why: "a public address is not filtered"},
		{name: "public v6", address: "[2606:2800:220:1:248:1893:25c8:1946]:443", want: true, why: "a public address is not filtered"},
		{name: "v4-mapped private", address: "[::ffff:10.0.0.1]:443", want: false, why: "a v4-mapped address IS its v4 address (decision 1)"},
		{name: "v4-mapped public", address: "[::ffff:93.184.216.34]:443", want: true, why: "and a mapped public address is still public"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var baseCalls int32
			base := &net.Dialer{Control: func(_, _ string, _ syscall.RawConn) error {
				atomic.AddInt32(&baseCalls, 1)
				return sentinel
			}}
			configureForTest(t, PrivateAddressFilterOptions{Enabled: true})
			filter := currentPrivateAddressFilter()
			_, err := filter.dial(context.Background(), base, "tcp", testCase.address)

			if testCase.want {
				if !errors.Is(err, sentinel) {
					t.Fatalf("%s: error = %v, want the base dialer's error; the filter refused a public address (%s)", testCase.address, err, testCase.why)
				}
				if got := atomic.LoadInt32(&baseCalls); got != 1 {
					t.Fatalf("%s: the base dialer was reached %d time(s), want 1", testCase.address, got)
				}
				return
			}
			var blocked *BlockedPrivateAddressError
			if !errors.As(err, &blocked) {
				t.Fatalf("%s: error = %v (%T), want a *BlockedPrivateAddressError (%s)", testCase.address, err, err, testCase.why)
			}
			if got := atomic.LoadInt32(&baseCalls); got != 0 {
				t.Fatalf("%s: the base dialer was reached %d time(s) for a blocked address, want 0 -- the check must gate the dial, not follow it", testCase.address, got)
			}
		})
	}
}

// TestPrivateAddressFilterTreatsAV4MappedV6AddressAsItsV4Address is requirement 7, and it is the one place
// this implementation is deliberately STRICTER than pinned. MEASURED against the pinned package:
//
//	require('ip-matching').getMatch('10.0.0.0/8').matches('::ffff:10.0.0.1')  ->  false
//
// so pinned's filter lets a v4-mapped address walk past every IPv4 range. Closing that is a visible
// product decision (AGENTS.md boundary 5), taken here rather than inherited silently.
func TestPrivateAddressFilterTreatsAV4MappedV6AddressAsItsV4Address(t *testing.T) {
	private := []struct {
		address string
		why     string
	}{
		{address: "::ffff:10.0.0.1", why: "10.0.0.0/8"},
		{address: "::ffff:127.0.0.1", why: "127.0.0.0/8"},
		{address: "::ffff:172.16.0.1", why: "172.16.0.0/12"},
		{address: "::ffff:192.168.1.1", why: "192.168.0.0/16"},
		{address: "::ffff:169.254.1.1", why: "169.254.0.0/16"},
		{address: "10.0.0.1", why: "the plain v4 spelling, for contrast"},
	}
	for _, testCase := range private {
		address := netip.MustParseAddr(testCase.address)
		if !isPrivateAddress(address) {
			t.Errorf("isPrivateAddress(%s) = false, want true (%s); pinned's ip-matching answers false for the mapped form, which is the bypass this decision closes", testCase.address, testCase.why)
		}
	}

	public := []struct {
		address string
		why     string
	}{
		{address: "::ffff:93.184.216.34", why: "a mapped PUBLIC address is still public"},
		{address: "2606:2800:220:1:248:1893:25c8:1946", why: "a native v6 public address"},
		{address: "::1", why: "the v6 loopback is private, not public"},
	}
	for _, testCase := range public {
		address := netip.MustParseAddr(testCase.address)
		want := strings.Contains(testCase.address, "::1") && testCase.address == "::1"
		if got := isPrivateAddress(address); got != want {
			t.Errorf("isPrivateAddress(%s) = %t, want %t (%s)", testCase.address, got, want, testCase.why)
		}
	}

	// The whitelist keeps BOTH readings, so the hardening does not break an operator who whitelisted the
	// mapped range instead of the v4 one.
	cases := []struct {
		name     string
		patterns []string
		address  string
		want     bool
	}{
		{name: "a v4 range covers the mapped spelling", patterns: []string{"10.0.0.0/8"}, address: "::ffff:10.0.0.1", want: true},
		{name: "a v6 range over the mapped form still works", patterns: []string{"::ffff:0:0/96"}, address: "::ffff:10.0.0.1", want: true},
		{name: "an unrelated range does not", patterns: []string{"192.168.0.0/16"}, address: "::ffff:10.0.0.1", want: false},
		{name: "a v4 range does not cover a native v6 address", patterns: []string{"10.0.0.0/8"}, address: "fd12::1", want: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			patterns := make([]ipPattern, 0, len(testCase.patterns))
			for _, entry := range testCase.patterns {
				pattern, err := parseIPPattern(entry)
				if err != nil {
					t.Fatalf("parseIPPattern(%q) = %v", entry, err)
				}
				patterns = append(patterns, pattern)
			}
			filter := privateAddressFilter{allowed: patterns}
			if got := filter.allows(netip.MustParseAddr(testCase.address)); got != testCase.want {
				t.Fatalf("allows(%s) with %v = %t, want %t", testCase.address, testCase.patterns, got, testCase.want)
			}
		})
	}
}

// TestPrivateAddressFilterLogsAccordingToTheSwitches is requirement 6: log.blockedRequests and
// log.allowedRequests gate their lines, and the blocked line is pinned's.
func TestPrivateAddressFilterLogsAccordingToTheSwitches(t *testing.T) {
	cases := []struct {
		name         string
		logBlocked   bool
		logAllowed   bool
		address      string
		wantLogged   string
		wantSilent   bool
		whitelist    []string
		expectReason string
	}{
		{
			name: "blocked and logging on", logBlocked: true, address: "10.1.2.3",
			wantLogged: "[Private Request Filter] Blocked request to private IP address: 10.1.2.3",
		},
		{
			name: "blocked and logging off", logBlocked: false, address: "10.1.2.3",
			wantSilent: true, expectReason: "the refusal itself is never gated (raiseError throws whatever logBlocked says)",
		},
		{
			name: "allowed and logging on", logBlocked: true, logAllowed: true, address: "10.1.2.3",
			whitelist:  []string{"10.0.0.0/8"},
			wantLogged: "[Private Request Filter] Allowed request to private IP address: 10.1.2.3",
		},
		{
			name: "allowed and logging off", logBlocked: true, logAllowed: false, address: "10.1.2.3",
			whitelist: []string{"10.0.0.0/8"}, wantSilent: true,
		},
		{
			name: "a public address is never logged", logBlocked: true, logAllowed: true, address: "93.184.216.34",
			wantSilent: true, expectReason: "validateIpAddress returns before any log for a non-private address (:145-147)",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var console, errorsOut bytes.Buffer
			configureForTest(t, PrivateAddressFilterOptions{
				Enabled: true, AllowedRanges: testCase.whitelist,
				LogBlocked: testCase.logBlocked, LogAllowed: testCase.logAllowed,
				Console: &console, Errors: &errorsOut,
			})
			// The Enabled banner is written at CONFIGURATION time; this case is about what a REQUEST
			// logs, so the buffers are emptied after configuration and before the decision.
			console.Reset()
			errorsOut.Reset()

			filter := currentPrivateAddressFilter()
			_ = filter.check(netip.MustParseAddr(testCase.address))

			combined := console.String() + errorsOut.String()
			if testCase.wantSilent {
				if combined != "" {
					t.Fatalf("output = %q, want nothing (%s)", combined, testCase.expectReason)
				}
				return
			}
			if !strings.Contains(combined, testCase.wantLogged) {
				t.Fatalf("output = %q, want it to contain %q", combined, testCase.wantLogged)
			}
		})
	}
}

// TestConfigurePrivateAddressFilterDropsInvalidEntriesWithAWarning pins the pinned recovery: an invalid
// entry is DROPPED and warned about (express-common.js:99-109), never fatal, and the valid entries beside
// it keep working.
func TestConfigurePrivateAddressFilterDropsInvalidEntriesWithAWarning(t *testing.T) {
	peer := newCountingPeer(t)
	var errorsOut bytes.Buffer
	configureForTest(t, PrivateAddressFilterOptions{
		Enabled:       true,
		AllowedRanges: []string{"not-an-ip", "127.0.0.0/8", "10.0.0.0/99"},
		Errors:        &errorsOut,
	})
	if !strings.Contains(errorsOut.String(), "Warning: Ignoring invalid private whitelist entry not-an-ip") {
		t.Fatalf("stderr = %q, want pinned's invalid-entry warning (express-common.js:77)", errorsOut.String())
	}
	if !strings.Contains(errorsOut.String(), "Warning: Ignoring invalid private whitelist entry 10.0.0.0/99") {
		t.Fatalf("stderr = %q, want the second invalid entry named too", errorsOut.String())
	}
	if err := sendThroughTheShippedTransport(t, peer.URL()+"/v1/chat/completions"); err != nil {
		t.Fatalf("the valid entry beside two invalid ones stopped working: %v", err)
	}
	if got := peer.Requests(); got != 1 {
		t.Fatalf("the peer received %d request(s), want exactly 1", got)
	}
}

// TestConfigurePrivateAddressFilterPrintsThePinnedBanner covers the operator-visible confirmation that
// the control is ON, and pinned's disabled-with-listen warning (:243-249), which is now truthful because
// the filter exists.
func TestConfigurePrivateAddressFilterPrintsThePinnedBanner(t *testing.T) {
	t.Run("enabled banner", func(t *testing.T) {
		var console bytes.Buffer
		configureForTest(t, PrivateAddressFilterOptions{
			Enabled: true, AllowedRanges: []string{"127.0.0.0/8", "::1/128"}, Console: &console,
		})
		output := console.String()
		for _, want := range []string{
			"\n[Private Request Filter] Enabled\n",
			"[Private Request Filter] Allowed private addresses: 127.0.0.0/8, ::1/128\n",
		} {
			if !strings.Contains(output, want) {
				t.Fatalf("console = %q, want it to contain %q (src/private-request-filter.js:257-262)", output, want)
			}
		}
	})

	t.Run("disabled in listen mode warns", func(t *testing.T) {
		var errorsOut bytes.Buffer
		configureForTest(t, PrivateAddressFilterOptions{Enabled: false, Listen: true, Errors: &errorsOut})
		output := errorsOut.String()
		for _, want := range []string{
			"Warning: listen is enabled but private request filter is disabled. This may expose your server to SSRF attacks.",
			"To enable, provide trusted addresses in privateAddressWhitelist.allowedRanges and set privateAddressWhitelist.enabled to true in config.yaml and restart the server.",
		} {
			if !strings.Contains(output, want) {
				t.Fatalf("stderr = %q, want it to contain %q (src/private-request-filter.js:243-249)", output, want)
			}
		}
	})

	t.Run("disabled and not listening is silent", func(t *testing.T) {
		var console, errorsOut bytes.Buffer
		configureForTest(t, PrivateAddressFilterOptions{Enabled: false, Listen: false, Console: &console, Errors: &errorsOut})
		if console.Len() != 0 || errorsOut.Len() != 0 {
			t.Fatalf("console = %q, stderr = %q, want silence for the shipped default", console.String(), errorsOut.String())
		}
	})
}
