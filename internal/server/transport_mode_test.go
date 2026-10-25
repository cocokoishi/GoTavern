package server

// THE TRANSPORT SEAM, for this package's tests only.
//
// Every provider request in this package's test binary must reach the recording peer in pinned's exact
// bytes, because the provider-wire replay compares bodySha256, bodyLength, the raw request target and
// the recorded header names and order. net/http cannot reproduce those bytes: it canonicalises header
// names and emits its own order, and it adds framing headers of its own. So this binary pins the
// wire-exact client, exactly as it behaved before the production transport existed.
//
// This is deliberately NOT a mutable in-process selector. The environment variable is set here, once,
// before any test runs and therefore before the first provider call reads it; nothing in `internal/**
// or `cmd/**` ever sets it, so no production request can be diverted onto the measuring instrument.
// The assertion below exists because a seam that silently fails to take effect would leave the replay
// green while measuring a different client than the one that recorded the fixture — a green that
// cannot fail (AGENTS.md rule 7).

import (
	"os"
	"testing"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

func TestMain(m *testing.M) {
	// Pinned before m.Run(), so the first provider call in this process sees it.
	if err := os.Setenv("GOTAVERN_OUTBOUND_WIRE_EXACT", "1"); err != nil {
		panic("set GOTAVERN_OUTBOUND_WIRE_EXACT: " + err.Error())
	}
	os.Exit(m.Run())
}

// TestProviderWireReplayUsesTheWireExactClient proves the seam above actually took effect. If
// `outbound.Send` were serving this binary through the production transport, every provider-wire
// scenario would still be comparing *something* -- so the mode is asserted rather than assumed.
func TestProviderWireReplayUsesTheWireExactClient(t *testing.T) {
	if mode := outbound.TransportMode(); mode != "wire-exact" {
		t.Fatalf("provider transport for this test binary = %q, want %q: the provider-wire replay would be comparing bytes from a client that cannot reproduce them", mode, "wire-exact")
	}
}
