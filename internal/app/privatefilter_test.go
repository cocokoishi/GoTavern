package app

// THE PRIVATE ADDRESS FILTER, WIRED AT BOOT.
//
// internal/outbound proves the policy; internal/commandline proves the config; this file proves the JOIN
// between them, because a correct policy that boot never installs is the same silent no-op the task
// exists to remove. The observable is again a REQUEST COUNT (AGENTS.md rule 17): with the filter enabled
// by config.yaml, a local peer must receive nothing.

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/commandline"
	"github.com/cocokoishi/gotavern/internal/outbound"
)

// countingPeer counts the requests it receives. Each case uses its own peer on its own port: the
// production client pools connections per host:port, and a shared port would let a later case ride an
// already-open socket and never dial at all.
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
	}))
	t.Cleanup(peer.server.Close)
	return peer
}

func (peer *countingPeer) requests() int {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	return peer.count
}

// bootWithConfig starts a real server against a real config.yaml. It is the same shape the other app
// tests use, so the config path it exercises is the shipped one.
func bootWithConfig(t *testing.T, config string) *RunningServer {
	t.Helper()
	installRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(installRoot, "config.yaml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	running, err := Start(StartOptions{
		Args: []string{
			"--enableIPv4", "true", "--enableIPv6", "false", "--listen", "false",
			"--port", "0", "--heartbeatInterval", "0", "--browserLaunchEnabled", "false",
		},
		WorkingDirectory:         installRoot,
		InstallRoot:              installRoot,
		WaitBeforeLegacyDataMove: func(time.Duration) {},
		InterfaceAddresses:       []net.Addr{},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = running.Close(ctx)
	})
	return running
}

func sendToPeer(t *testing.T, target string) error {
	t.Helper()
	_, err := outbound.Send(context.Background(), outbound.Request{
		URL: target, Method: http.MethodPost, Body: []byte(`{}`),
	}, 5*time.Second)
	return err
}

// TestTheBootedServerEnforcesTheConfiguredPrivateAddressFilter is the end-to-end row: a config.yaml with
// the filter ON and an empty whitelist, a real boot, and a loopback peer that must receive nothing.
func TestTheBootedServerEnforcesTheConfiguredPrivateAddressFilter(t *testing.T) {
	t.Cleanup(outbound.DisablePrivateAddressFilter)
	blocked := newCountingPeer(t)

	// The whitelist is an EXPLICIT range that does not cover loopback. An empty list cannot be used for
	// this: pinned's `addMissingConfigValues` runs `_.defaultsDeep(config, defaultConfig)`
	// (src/config-init.js:219), which copies the default's array ELEMENTS into the empty array, so
	// `allowedRanges: []` comes back as the two loopback ranges. That was measured here rather than
	// assumed, and GoTavern's config initialization reproduces it (the refilled file was read back).
	// An operator who really means "allow nothing" writes a non-array value, which
	// `filterValidIpPatterns` turns into no entries at all (express-common.js:95-97).
	bootWithConfig(t, strings.Join([]string{
		"dataRoot: ./data",
		"listen: false",
		"port: 0",
		"browserLaunch:",
		"  enabled: false",
		"privateAddressWhitelist:",
		"  enabled: true",
		"  allowedRanges:",
		"    - 10.0.0.0/8",
		"",
	}, "\n"))

	err := sendToPeer(t, blocked.server.URL+"/v1/chat/completions")
	if err == nil {
		t.Fatal("a provider request to a loopback peer succeeded after booting with privateAddressWhitelist.enabled: true; boot did not install the filter")
	}
	if !strings.Contains(err.Error(), "Blocked request to private IP address: 127.0.0.1") {
		t.Fatalf("error = %q, want the pinned refusal, which is the operator's only clue about why their provider became unreachable", err)
	}
	if got := blocked.requests(); got != 0 {
		t.Fatalf("the peer received %d request(s), want 0: the configured control did not apply", got)
	}
}

// TestTheBootedServerLeavesTheFilterOffByDefault is requirement 1 at the boot level: the shipped default
// config must change nothing, so the same peer is reachable. The peer is separate from the row above so
// no pooled connection can make either case vacuous.
func TestTheBootedServerLeavesTheFilterOffByDefault(t *testing.T) {
	t.Cleanup(outbound.DisablePrivateAddressFilter)
	reachable := newCountingPeer(t)

	bootWithConfig(t, strings.Join([]string{
		"dataRoot: ./data",
		"listen: false",
		"port: 0",
		"browserLaunch:",
		"  enabled: false",
		"privateAddressWhitelist:",
		"  enabled: false",
		"",
	}, "\n"))

	if err := sendToPeer(t, reachable.server.URL+"/v1/chat/completions"); err != nil {
		t.Fatalf("a request with the filter disabled by config failed: %v", err)
	}
	if got := reachable.requests(); got != 1 {
		t.Fatalf("the peer received %d request(s), want exactly 1", got)
	}
}

// TestConfigurePrivateAddressFilterMapsEverySetting drives the mapping function directly and observes the
// two settings whose effect is visible without capturing a stream: `enabled` and `allowUnresolvedHosts`.
// `logBlocked`/`logAllowed` are a straight field copy whose gating is proven in internal/outbound.
func TestConfigurePrivateAddressFilterMapsEverySetting(t *testing.T) {
	t.Cleanup(outbound.DisablePrivateAddressFilter)

	const unresolvable = "http://no_such_host!:1/v1/chat/completions"

	// allowUnresolvedHosts FALSE: the filter refuses before the dial.
	if err := configurePrivateAddressFilter(commandline.CommandLineResult{
		PrivateAddressFilter: commandline.PrivateAddressFilterSettings{Enabled: true, AllowedRanges: []string{}},
	}); err != nil {
		t.Fatal(err)
	}
	err := sendToPeer(t, unresolvable)
	if err == nil || !strings.Contains(err.Error(), "Unable to resolve host: no_such_host!") {
		t.Fatalf("error = %v, want the filter's own unresolved-host refusal, so allowUnresolvedHosts=false did not reach the transport", err)
	}

	// allowUnresolvedHosts TRUE: the filter delegates, and the failure comes from the resolver instead.
	if err := configurePrivateAddressFilter(commandline.CommandLineResult{
		PrivateAddressFilter: commandline.PrivateAddressFilterSettings{
			Enabled: true, AllowedRanges: []string{}, AllowUnresolvedHosts: true,
		},
	}); err != nil {
		t.Fatal(err)
	}
	err = sendToPeer(t, unresolvable)
	if err == nil {
		t.Fatal("the request unexpectedly succeeded")
	}
	if strings.Contains(err.Error(), "Unable to resolve host") {
		t.Fatalf("error = %q, want the filter to DELEGATE an unresolvable host when allowUnresolvedHosts is true (src/private-request-filter.js:187-189)", err)
	}
	if !strings.Contains(err.Error(), "no such host") {
		t.Fatalf("error = %q, want the resolver's own failure, which is only reachable through delegation", err)
	}

	// A whitelist entry reaches the transport: with the loopback range allowed, a loopback peer answers.
	allowed := newCountingPeer(t)
	if err := configurePrivateAddressFilter(commandline.CommandLineResult{
		PrivateAddressFilter: commandline.PrivateAddressFilterSettings{Enabled: true, AllowedRanges: []string{"127.0.0.0/8"}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := sendToPeer(t, allowed.server.URL+"/v1/chat/completions"); err != nil {
		t.Fatalf("a whitelisted loopback peer was not reachable: %v", err)
	}
	if got := allowed.requests(); got != 1 {
		t.Fatalf("the peer received %d request(s), want exactly 1", got)
	}
}

// TestNodeTruthyOptionMatchesPinnedForListen pins the coercion used for the one option the filter reads
// from the command line: `listen`, whose only role is pinned's disabled-with-listen warning.
func TestNodeTruthyOptionMatchesPinnedForListen(t *testing.T) {
	cases := []struct {
		value any
		want  bool
		why   string
	}{
		{value: nil, want: false, why: "Boolean(undefined) === false"},
		{value: false, want: false, why: "the fresh-install value"},
		{value: true, want: true, why: "explicit"},
		{value: "true", want: true, why: "a non-empty string is truthy, which is what `!!cliArgs.listen` does"},
		{value: "false", want: true, why: "Boolean('false') === true, unlike toBoolean"},
		{value: "", want: false, why: "the empty string is falsy"},
		{value: 0, want: false, why: "Boolean(0) === false"},
		{value: 1, want: true, why: "Boolean(1) === true"},
	}
	for _, testCase := range cases {
		if got := nodeTruthyOption(testCase.value); got != testCase.want {
			t.Errorf("nodeTruthyOption(%#v) = %t, want %t (%s)", testCase.value, got, testCase.want, testCase.why)
		}
	}
}
