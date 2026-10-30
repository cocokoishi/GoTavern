package egressguard

// PROVE THE RESOLVER PEER CAN SEE, RECORD, REFUSE AND BE MISSED.
//
// The peer is a gate component, so its own teeth are demonstrated here rather than assumed: a recording
// resolver that never records, or that answers everything whatever the allow-list says, would make the
// startup gate green while measuring nothing (AGENTS.md rule 7, differential doctrine 4).
//
// EVERY CASE USES A REAL LOOKUP. `net.DefaultResolver` is replaced with a resolver whose `Dial` reaches this
// peer, and `LookupIPAddr` is what the product's boot path calls, so the code under test is the code that
// runs. The one shape this cannot prove -- a resolver constructed by hand with its own server address -- is
// listed in resolver.go's "WHAT THIS CANNOT SEE" paragraph instead of being pretended away.

import (
	"context"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestResolverPeerRecordsAndAnswersAnAllowedName(t *testing.T) {
	peer := StartResolverPeer(t)
	peer.Allow("host.docker.internal")
	peer.MustInstall(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, "host.docker.internal")
	if err != nil {
		t.Fatalf("an ALLOWED name did not resolve through the peer: %v", err)
	}
	if len(addresses) == 0 || !addresses[0].IP.Equal(net.ParseIP("127.0.0.1")) {
		t.Fatalf("the allowed name resolved to %v, not to the answer the peer was configured with", addresses)
	}
	names := peer.ContactedNames()
	if len(names) != 1 || names[0] != "host.docker.internal" {
		t.Fatalf("the peer recorded %v; it must record the name it answered", names)
	}
	peer.AssertContactedOnly(t, "host.docker.internal")
}

func TestResolverPeerRefusesAnUndeclaredNameAndNamesIt(t *testing.T) {
	peer := StartResolverPeer(t)
	peer.MustInstall(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := net.DefaultResolver.LookupIPAddr(ctx, "telemetry.example")
	if err == nil {
		t.Fatal("a name the allow-list does not carry RESOLVED; the peer must answer NXDOMAIN for it")
	}
	if !strings.Contains(err.Error(), "telemetry.example") {
		t.Fatalf("the lookup failed but the error does not name the host: %v", err)
	}
	violations := peer.Violations()
	if len(violations) == 0 {
		t.Fatal("the refused lookup produced no Violation, so a startup escape would be invisible")
	}
	named := false
	for _, violation := range violations {
		if violation.Host == "telemetry.example" && violation.Stage == "resolver" &&
			strings.Contains(violation.Reason, "allow-list") {
			named = true
		}
	}
	if !named {
		t.Fatalf("the violation does not name the host and the reason it was refused: %+v", violations)
	}
	// AND THE GATE WOULD FAIL ON IT, which is the point: an empty allow-list plus this lookup is a red.
	problems := CompareResolverContact(nil, peer.ContactedNames())
	if len(problems) != 1 || !strings.Contains(problems[0].String(), "FORBIDDEN EGRESS") ||
		!strings.Contains(problems[0].String(), "telemetry.example") {
		t.Fatalf("the startup allow-list comparison did not report the undeclared lookup: %v", problems)
	}
}

// THE PURE COMPARISON, BOTH DIRECTIONS. These are the assertions the gate rests on, and they are tested
// without a subject because an assertion whose only caller is a live boot cannot be shown to fail.
func TestCompareResolverContactHasTeeth(t *testing.T) {
	// (a) an undeclared lookup is a named FORBIDDEN EGRESS finding.
	problems := CompareResolverContact([]string{"host.docker.internal"}, []string{"host.docker.internal", "evil.example"})
	if len(problems) != 1 || problems[0].Kind != "unexpected" || problems[0].Name != "evil.example" {
		t.Fatalf("an undeclared lookup was not reported exactly once: %v", problems)
	}
	if !strings.Contains(problems[0].String(), "FORBIDDEN EGRESS") {
		t.Fatalf("the finding does not read as forbidden egress: %s", problems[0].String())
	}

	// (b) an allowed name that never appeared is a MISSING LOOKUP, so the allowed case cannot be asserted by
	// silence. This is the difference between "the gate observed zero" and "the gate observed nothing".
	problems = CompareResolverContact([]string{"host.docker.internal"}, nil)
	if len(problems) != 1 || problems[0].Kind != "missing" || problems[0].Name != "host.docker.internal" {
		t.Fatalf("a missing allowed lookup was not reported: %v", problems)
	}
	if !strings.Contains(problems[0].String(), "MISSING LOOKUP") {
		t.Fatalf("the finding does not read as a missing observation: %s", problems[0].String())
	}

	// (c) an exact match is silent, including the empty allow-list that the zero-egress claim uses.
	if problems := CompareResolverContact([]string{"host.docker.internal"}, []string{"HOST.DOCKER.INTERNAL."}); len(problems) != 0 {
		t.Fatalf("an exact match (case and trailing dot normalised) was reported: %v", problems)
	}
	if problems := CompareResolverContact(nil, nil); len(problems) != 0 {
		t.Fatalf("an empty allow-list with no lookups was reported: %v", problems)
	}

	// (d) both families of ONE undeclared host are one escape, not two, so a reviewer reads one finding per
	// host they must justify.
	problems = CompareResolverContact(nil, []string{"evil.example", "evil.example"})
	if len(problems) != 1 {
		t.Fatalf("A and AAAA of one undeclared host were reported %d times: %v", len(problems), problems)
	}
}

func TestResolverPeerRecordsNothingWhenTheSubjectResolvesNothing(t *testing.T) {
	peer := StartResolverPeer(t)
	peer.MustInstall(t)
	if names := peer.ContactedNames(); len(names) != 0 {
		t.Fatalf("the peer recorded %v with no lookup made", names)
	}
	peer.AssertContactedOnly(t) // the zero-egress assertion itself, on a subject that did nothing
	if len(peer.Queries()) != 0 {
		t.Fatalf("the peer recorded %d queries, not zero", len(peer.Queries()))
	}
}

// A DNS SERVER THAT NEVER ANSWERS is the input the bounded-lookup contract (rule 24) needs, and this case
// proves the peer can present it: the query IS received (recorded) and the caller gives up on its own
// deadline rather than the peer's.
func TestSilentResolverPeerMakesTheLookupTimeOut(t *testing.T) {
	peer := StartResolverPeer(t)
	peer.Allow("host.docker.internal")
	peer.Silence()
	peer.MustInstall(t)

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := net.DefaultResolver.LookupIPAddr(ctx, "host.docker.internal")
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("a silent resolver answered a lookup; the bounded case cannot discriminate without a hang")
	}
	if elapsed > 3*time.Second {
		t.Fatalf("the lookup took %s against a 300ms context: the deadline did not reach the resolver", elapsed.Round(time.Millisecond))
	}
	if len(peer.Queries()) == 0 {
		t.Fatal("the silent peer received no query, so the hang this case presents never happened")
	}
}

// A RESOLVED NAME MUST NOT BE CACHED BY THE PEER, because a cached answer would let a second startup look
// like it made a lookup it did not make (the gate counts observations, so a cache would forge one).
func TestResolverPeerAnswersEveryQuery(t *testing.T) {
	peer := StartResolverPeer(t)
	peer.Allow("gateway.docker.internal")
	peer.MustInstall(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for attempt := 0; attempt < 3; attempt++ {
		if _, err := net.DefaultResolver.LookupIPAddr(ctx, "gateway.docker.internal"); err != nil {
			t.Fatalf("attempt %d failed: %v", attempt+1, err)
		}
	}
	if len(peer.Queries()) < 3 {
		t.Fatalf("three lookups produced %d query(ies); the peer must answer each time, not cache", len(peer.Queries()))
	}
}

func TestResolverPeerAnswersNodataForAFamilyWithNoAddress(t *testing.T) {
	peer := StartResolverPeer(t)
	// An IPv4 answer only, so the AAAA question must be NODATA rather than NXDOMAIN (which would say the
	// NAME does not exist).
	peer.Allow("ipv4only.example", netip.MustParseAddr("192.0.2.10"))
	peer.MustInstall(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, "ipv4only.example")
	if err != nil {
		t.Fatalf("a name with only an A answer did not resolve: %v", err)
	}
	if len(addresses) != 1 || !addresses[0].IP.Equal(net.ParseIP("192.0.2.10")) {
		t.Fatalf("resolved %v, want the configured TEST-NET answer only", addresses)
	}
}
