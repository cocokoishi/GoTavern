package server

import (
	"encoding/json"
	"strings"
	"testing"
)

// isTransportFailureBody asserts the SUPERSET this project sends where pinned sends a bare `{"error":true}`.
//
// Pinned's catch for these sources drops the thrown fetch error before building the body
// (chat-completions.js:1168-1174), so a real DNS/TLS/proxy/timeout failure reached the user as "cannot connect"
// with nothing else -- the report P0-A started from, and what AGENTS.md rule 35 forbids. The product decision of
// 2026-10-25 keeps `error` byte-identical (the frontend reads that flag) and ADDS `message` carrying the
// transport's own stage. It is a divergence, so it is recorded in docs/network-egress.md 4 and asserted here
// rather than tolerated.
//
// The members are constrained BY NAME, not by count: `error` must be exactly boolean true, `message` may carry a
// cause, and any OTHER member fails -- so a body cannot quietly grow a field nobody decided on. A missing or
// stage-less cause also fails, because a message a user cannot act on is the pinned behaviour we are deliberately
// not reproducing.
func isTransportFailureBody(body string) bool {
	var decoded map[string]any
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		return false
	}
	for member := range decoded {
		if member != "error" && member != "message" {
			return false
		}
	}
	flag, isBool := decoded["error"].(bool)
	if !isBool || !flag {
		return false
	}
	cause, isString := decoded["message"].(string)
	if !isString || strings.TrimSpace(cause) == "" {
		return false
	}
	return namesTransportStage(cause)
}

// namesTransportStage reports whether a cause names a stage a user can act on. The vocabulary is the transport's
// own taxonomy (docs/network-egress.md 3); matching is case-insensitive because the message is composed from
// wrapped errors whose casing is not contract.
func namesTransportStage(cause string) bool {
	lowered := strings.ToLower(cause)
	for _, stage := range []string{
		"dns", "no such host", "connect", "dial", "tls", "certificate", "handshake",
		"proxy", "timeout", "deadline", "cancel", "closed", "refused", "reset", "eof",
		"status", "http ",
	} {
		if strings.Contains(lowered, stage) {
			return true
		}
	}
	return false
}

// TestTransportFailureBodyAcceptsTheSupersetAndRejectsTheRest pins the assertion above, so a later edit cannot
// widen it into "any body with error:true passes".
func TestTransportFailureBodyAcceptsTheSupersetAndRejectsTheRest(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{name: "pinned flag plus a connect cause", body: `{"error":true,"message":"connect to provider api.deepseek.com failed: connection refused"}`, want: true},
		{name: "pinned flag plus a dns cause", body: `{"error":true,"message":"dns lookup for api.deepseek.com failed: no such host"}`, want: true},
		{name: "pinned flag plus a timeout cause", body: `{"error":true,"message":"timeout waiting for api.deepseek.com"}`, want: true},
		{name: "the old bare flag is no longer accepted", body: `{"error":true}`, want: false},
		{name: "an empty cause is refused", body: `{"error":true,"message":"   "}`, want: false},
		{name: "a stage-less cause is refused", body: `{"error":true,"message":"something went wrong"}`, want: false},
		{name: "a false flag is refused", body: `{"error":false,"message":"connect failed"}`, want: false},
		{name: "an extra member is refused", body: `{"error":true,"message":"connect failed","detail":"x"}`, want: false},
		{name: "a non-boolean error is refused", body: `{"error":"true","message":"connect failed"}`, want: false},
		{name: "not json at all", body: `<html>502</html>`, want: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := isTransportFailureBody(testCase.body); got != testCase.want {
				t.Fatalf("isTransportFailureBody(%q) = %v, want %v", testCase.body, got, testCase.want)
			}
		})
	}
}
