package outbound

// `dnsPreferIPv6` / `--dnsPreferIPv6`: the pinned call is `dns.setDefaultResultOrder('ipv6first')` when the
// flag is on and `'ipv4first'` when it is off (src/server-main.js:465-477), reached from the pinned startup
// chain (:481) with the flag resolved at src/command-line.js:309 and defaulted to FALSE at :66 /
// default/config.yaml:17-18.
//
// WHAT THIS TEST HAS TO MAKE TRUE, or it proves nothing:
//
//  1. a host that resolves to BOTH families, with the IPv6 address listed FIRST so the two flags cannot
//     agree by accident -- a host with only one family would pass whether or not the ordering existed;
//  2. BOTH families listening on the SAME port, so the only difference between the two runs is which
//     address the client chose;
//  3. the observation taken at the PEER (which listener accepted the connection), not from the client's
//     own idea of what it dialled;
//  4. the resolver is presented through the `hostLookup` seam, because this machine's DNS is not part of
//     the contract and a test that depended on it would be unverifiable on another host.

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"sync"
	"testing"
	"time"
)

// dnsOrderProbePeer is one listener per address family on a SINGLE port, each recording the family of the
// connection it accepted.
type dnsOrderProbePeer struct {
	port     int
	mu       sync.Mutex
	accepted []string
	servers  []*http.Server
}

func startDNSOrderProbePeer(t *testing.T) *dnsOrderProbePeer {
	t.Helper()
	listener4, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen on 127.0.0.1: %v", err)
	}
	port := listener4.Addr().(*net.TCPAddr).Port
	listener6, err := net.Listen("tcp6", fmt.Sprintf("[::1]:%d", port))
	if err != nil {
		_ = listener4.Close()
		t.Skipf("IPv6 loopback is unavailable on this host, so the families cannot be told apart: %v", err)
	}
	peer := &dnsOrderProbePeer{port: port}
	handler := func(w http.ResponseWriter, r *http.Request) {
		peer.record(r.RemoteAddr)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}
	for _, listener := range []net.Listener{listener4, listener6} {
		server := &http.Server{Handler: http.HandlerFunc(handler)}
		peer.servers = append(peer.servers, server)
		go func(server *http.Server, listener net.Listener) { _ = server.Serve(listener) }(server, listener)
	}
	t.Cleanup(func() {
		for _, server := range peer.servers {
			_ = server.Close()
		}
	})
	return peer
}

func (peer *dnsOrderProbePeer) record(remote string) {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	peer.mu.Lock()
	defer peer.mu.Unlock()
	peer.accepted = append(peer.accepted, host)
}

func (peer *dnsOrderProbePeer) families() []string {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	return append([]string(nil), peer.accepted...)
}

// TestProductionTransportDNSOrderPrefersTheConfiguredFamily is the test for `dnsPreferIPv6`. It fails if the
// ordering is removed, because with no ordering the client dials the first address the resolver returned --
// which is the IPv6 one in BOTH runs, so the "IPv4 first" case would reach the wrong listener.
func TestProductionTransportDNSOrderPrefersTheConfiguredFamily(t *testing.T) {
	// The state this package shares with other tests: the private filter must be off, or loopback addresses
	// would be refused before any of this is observable.
	DisablePrivateAddressFilter()
	t.Cleanup(DisablePrivateAddressFilter)

	originalLookup := hostLookup
	t.Cleanup(func() { hostLookup = originalLookup })
	t.Cleanup(func() { ConfigureProductionTransport(ProductionTransportOptions{}) })

	// IPv6 FIRST in the resolver answer, so the preference is the only thing that can move the connection.
	ipv6 := netip.MustParseAddr("::1")
	ipv4 := netip.MustParseAddr("127.0.0.1")
	lookupCalls := 0
	hostLookup = func(_ context.Context, host string) ([]netip.Addr, error) {
		if host != "dns-order-probe.invalid" {
			return nil, fmt.Errorf("unexpected host %q", host)
		}
		lookupCalls++
		return []netip.Addr{ipv6, ipv4}, nil
	}

	for _, testCase := range []struct {
		name          string
		preferIPv6    bool
		wantConnected string
	}{
		{name: "dnsPreferIPv6 false is IPv4 first, the shipped default", preferIPv6: false, wantConnected: "127.0.0.1"},
		{name: "dnsPreferIPv6 true is IPv6 first", preferIPv6: true, wantConnected: "::1"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			peer := startDNSOrderProbePeer(t)
			ConfigureProductionTransport(ProductionTransportOptions{PreferIPv6: testCase.preferIPv6})

			target := fmt.Sprintf("http://dns-order-probe.invalid:%d/v1/chat/completions", peer.port)
			response, err := Send(context.Background(), Request{Method: http.MethodPost, URL: target, Body: []byte("{}")}, 10*time.Second)
			if err != nil {
				t.Fatalf("send to %s: %v", target, err)
			}
			if response.Status != http.StatusOK {
				t.Fatalf("status = %d, want 200", response.Status)
			}

			families := peer.families()
			if len(families) != 1 {
				t.Fatalf("peer accepted %d connections (%v), want exactly 1", len(families), families)
			}
			if families[0] != testCase.wantConnected {
				t.Fatalf("the connection arrived from %s, want %s: the DNS result order is not applied (resolver listed %s first)",
					families[0], testCase.wantConnected, ipv6)
			}
		})
	}

	if lookupCalls == 0 {
		t.Fatal("the resolver seam was never consulted, so nothing above tested the ordering")
	}
}

// TestOrderAddressesIsAnOrderAndNotAFilter pins the helper's whole contract: the preferred family moves to
// the front, the resolver's order survives inside each family, and NOTHING is dropped -- a preference that
// silently discarded the other family would turn "prefer IPv4" into "IPv6 only".
func TestOrderAddressesIsAnOrderAndNotAFilter(t *testing.T) {
	ipv6First := []netip.Addr{
		netip.MustParseAddr("2001:db8::1"),
		netip.MustParseAddr("192.0.2.1"),
		netip.MustParseAddr("2001:db8::2"),
		netip.MustParseAddr("192.0.2.2"),
	}
	if got, want := orderAddresses(false, ipv6First), []netip.Addr{
		netip.MustParseAddr("192.0.2.1"),
		netip.MustParseAddr("192.0.2.2"),
		netip.MustParseAddr("2001:db8::1"),
		netip.MustParseAddr("2001:db8::2"),
	}; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("orderAddresses(false) = %v, want %v", got, want)
	}
	if got, want := orderAddresses(true, ipv6First), []netip.Addr{
		netip.MustParseAddr("2001:db8::1"),
		netip.MustParseAddr("2001:db8::2"),
		netip.MustParseAddr("192.0.2.1"),
		netip.MustParseAddr("192.0.2.2"),
	}; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("orderAddresses(true) = %v, want %v (IPv6 first, resolver order kept inside each family)", got, want)
	}
	// A v4-mapped-v6 address is an IPv4 address: it must sort with IPv4, or "prefer IPv4" would put it last.
	mapped := []netip.Addr{netip.MustParseAddr("2001:db8::1"), netip.MustParseAddr("::ffff:192.0.2.9")}
	if got := orderAddresses(false, mapped); !got[0].Is4In6() {
		t.Errorf("orderAddresses(false, %v) = %v, want the v4-mapped address first", mapped, got)
	}
}
