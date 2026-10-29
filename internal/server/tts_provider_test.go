package server

// Shared fixtures for the two pinned TTS provider routes added by this change
// (`internal/server/azure_tts.go` and `internal/server/volcengine.go`).
//
// WHAT THESE TESTS ARE, stated because the distinction decides how much they prove: they are
// SOURCE-DERIVED route tests. The expectation for every request byte and every literal comes from the
// pinned endpoint source, read and cited in the implementation files, NOT from a recorded Node
// capture. There is no `tests/oracle/sillytavern-1.19.0-*.json` for these two routes, so nothing here
// is a Node-to-Go differential: what it proves is that the Go route sends and answers exactly what
// the pinned source says, against a controlled LOCAL peer that records the method, the raw target,
// the header lines in wire order and the body bytes. What it does NOT prove is that a real Azure or
// Volcengine endpoint accepts those bytes -- that needs a live probe and is recorded as an open gap.
//
// The peer is never the real service: every outbound request in these files is aimed at a loopback
// listener, and the refusal branches additionally assert that the peer received ZERO requests.

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

// ttsTestAccount is the account every TTS route test authenticates as. It is passwordless, which is
// the pinned single-user auto-login path the other route harnesses in this package use.
func ttsTestAccount() sdFixtureAccount {
	return sdFixtureAccount{Handle: "tts-user", Name: "TTS User", Admin: true}
}

// newTTSRouteHandler builds the real handler over a scratch data root, logs in, and returns the
// session cookie, the CSRF token and the data root the secrets are written under.
func newTTSRouteHandler(t *testing.T) (http.Handler, string, string, string) {
	t.Helper()
	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	handler, cookie, token := newSDRouteHandler(t, dataRoot, installRoot, "tts-cookie-secret", ttsTestAccount())
	return handler, cookie, token, dataRoot
}

// startTTSPeer starts a recording peer on a loopback port and returns it with its origin (for a seam
// or a request body) and its authority (for the expected Host line).
func startTTSPeer(t *testing.T) (*mockprovider.KeyedRecorder, string, string) {
	t.Helper()
	peer := mockprovider.NewKeyed(nil)
	address, err := peer.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = peer.Close() })
	return peer, "http://" + address.String(), address.String()
}

// ttsPost sends one authenticated JSON POST through the real handler.
func ttsPost(t *testing.T, handler http.Handler, cookie, token, route, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, route, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Cookie", cookie)
	request.Header.Set("X-CSRF-Token", token)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// ttsGet sends one authenticated GET through the real handler, so a method-guard assertion reaches
// the route's own method check instead of the login middleware in front of it.
func ttsGet(t *testing.T, handler http.Handler, cookie, route string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, route, nil)
	request.Header.Set("Cookie", cookie)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// ttsHeaderLine is one expected wire header line.
type ttsHeaderLine struct {
	Name  string
	Value string
}

// ttsAssertHeaderLines compares the peer's recorded header lines, in arrival order, against the exact
// list the pinned node-fetch client writes. The list is written out literally by each caller rather
// than produced by `sdNodeFetchHeaders`, because an expectation built by the code under test can only
// ever agree with it.
func ttsAssertHeaderLines(t *testing.T, got []mockprovider.Header, want []ttsHeaderLine) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("request header line count = %d, pinned node-fetch writes %d\ngot  %v", len(got), len(want), got)
	}
	for index := range want {
		if got[index].Name != want[index].Name || got[index].Value != want[index].Value {
			t.Fatalf("request header line %d = %q: %q, pinned node-fetch writes %q: %q",
				index, got[index].Name, got[index].Value, want[index].Name, want[index].Value)
		}
	}
}

// readPinnedTTSFile reads a file from the pinned checkout when it is reachable, trying the release
// layout and a lane worktree. Its absence is reported by the caller rather than passed over.
func readPinnedTTSFile(t *testing.T, relative string) (string, bool) {
	t.Helper()
	for _, candidate := range []string{
		filepath.Join("..", "..", "..", "SillyTavern", relative),
		filepath.Join("..", "..", "SillyTavern", relative),
	} {
		body, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		return string(body), true
	}
	return "", false
}
