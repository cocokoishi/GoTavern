package server

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"testing"
	"time"
)

// refusedLoopbackError produces a REAL connection-refused error on loopback:
// bind an ephemeral port, learn it, close the listener, then connect. Nothing is
// mocked, which is the only way this test can fail on a host where the platform
// errno does not match -- a hand-built error would pass on every platform and
// prove nothing (AGENTS rule 15).
//
// It refuses to run rather than pass vacuously: if some other process took the
// port, or the host answers with a timeout instead of a refusal, the test fails
// naming that, because the fixture would then be unable to discriminate.
func refusedLoopbackError(t *testing.T) (string, error) {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("bind a loopback port to close again: %v", err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatalf("close the loopback listener: %v", err)
	}
	connection, err := net.DialTimeout("tcp4", address, 5*time.Second)
	if err == nil {
		_ = connection.Close()
		t.Fatalf("the closed loopback port %s accepted a connection; the fixture cannot produce a refusal", address)
	}
	if errors.Is(err, os.ErrDeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("connecting to the closed loopback port %s timed out instead of being refused; this host cannot discriminate: %v", address, err)
	}
	return address, err
}

// TestPinnedChatCompletionTransportMessageNamesARealRefusedConnection locks the
// classification that feeds the `message` member of the transport-failure body.
//
// PINNED ORACLE (read): src/endpoints/backends/chat-completions.js:2717-2721 --
//
//	const message = error.code === 'ECONNREFUSED'
//	    ? `Connection refused: ${error.message}`
//	    : error.message || 'Unknown error occurred';
//
// Node reports `code === 'ECONNREFUSED'` on Windows as well as on POSIX (libuv
// maps WSAECONNREFUSED), so the prefix is pinned's behaviour on every platform.
// GoTavern reached it through `errors.Is(err, syscall.ECONNREFUSED)`, which is
// FALSE on Windows because syscall.ECONNREFUSED is an APPLICATION_ERROR
// pseudo-errno there; this test fails on such a host unless the platform seam
// (isConnectionRefused) recognises the real Winsock value.
//
// Both shapes the product actually sees are asserted: the raw dial error, and
// the error an http.Client round trip wraps around it. The wrapped case is
// pinned's message content, which the outbound transport wraps once more.
func TestPinnedChatCompletionTransportMessageNamesARealRefusedConnection(t *testing.T) {
	address, dialErr := refusedLoopbackError(t)

	if !isConnectionRefused(dialErr) {
		t.Fatalf("isConnectionRefused(%v) = false for a real refused connection on this host; the platform errno seam is not matching", dialErr)
	}
	if want := "Connection refused: " + dialErr.Error(); pinnedChatCompletionTransportMessage(dialErr) != want {
		t.Errorf("message for a raw refused dial = %q, want the pinned shape %q", pinnedChatCompletionTransportMessage(dialErr), want)
	}

	// The outbound layer wraps the transport error before this classification sees
	// it, so errors.Is semantics (not identity) are part of the contract.
	wrapped := fmt.Errorf("request to http://%s/ failed: %w", address, dialErr)
	if want := "Connection refused: " + wrapped.Error(); pinnedChatCompletionTransportMessage(wrapped) != want {
		t.Errorf("message for a WRAPPED refused error = %q, want %q", pinnedChatCompletionTransportMessage(wrapped), want)
	}

	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 10 * time.Second}
	response, httpErr := client.Get("http://" + address + "/")
	if response != nil {
		_ = response.Body.Close()
	}
	if httpErr == nil {
		t.Fatalf("GET http://%s/ against a closed port succeeded; the fixture cannot produce a refusal", address)
	}
	if !isConnectionRefused(httpErr) {
		t.Fatalf("isConnectionRefused(%v) = false for an http.Client round trip to a closed port", httpErr)
	}
	if want := "Connection refused: " + httpErr.Error(); pinnedChatCompletionTransportMessage(httpErr) != want {
		t.Errorf("message for an http.Client refused error = %q, want %q", pinnedChatCompletionTransportMessage(httpErr), want)
	}
}

// TestPinnedChatCompletionTransportMessageLeavesOtherFailuresAlone is the
// negative half: the prefix is pinned's ECONNREFUSED branch only, so a different
// failure must reach the user as its own message (and a nil error as pinned's
// literal 'Unknown error occurred', :2721).
func TestPinnedChatCompletionTransportMessageLeavesOtherFailuresAlone(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		expected string
	}{
		{name: "nil uses pinned's literal", err: nil, expected: "Unknown error occurred"},
		{name: "a non-transport error is passed through", err: errors.New("Only absolute URLs are supported"), expected: "Only absolute URLs are supported"},
		{name: "a timeout is not a refusal", err: context.DeadlineExceeded, expected: context.DeadlineExceeded.Error()},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := pinnedChatCompletionTransportMessage(testCase.err); got != testCase.expected {
				t.Errorf("message = %q, want %q", got, testCase.expected)
			}
			if testCase.err != nil && isConnectionRefused(testCase.err) {
				t.Errorf("isConnectionRefused(%v) = true, want false", testCase.err)
			}
		})
	}
}
