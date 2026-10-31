package app

// THE OTHER HALF OF THE BASIC-AUTH CONTRACT: a configuration that did NOT enable HTTP Basic Auth must serve
// anonymously.
//
// This test exists because a user asked, in effect, "is the password prompt a SillyTavern feature or a GoTavern
// addition?" It is a SillyTavern feature (upstream `default/config.yaml` line 70: `basicAuthMode: false`), and the
// pinned server gates the middleware on TWO flags -- `src/server-main.js:141-142`:
//
//     if (cliArgs.listen && cliArgs.basicAuthMode) {
//         app.use(basicAuthMiddleware);
//     }
//
// GoTavern's `internal/server/http.go:152` reproduces exactly that conjunction: `BasicAuthEnabled: listen &&
// basicAuthMode`. The existing pinned-response test (`TestStartGlobalBasicAuthMatchesPinnedNodeResponses`) covers the
// ON direction with recorded upstream responses; nothing executed the OFF direction, so a regression that dropped the
// `listen` half (or defaulted `basicAuthMode` to true) would have been caught by no named test -- it would have
// appeared to the user as a password prompt on a configuration that never asked for one.
//
// The expectations are SOURCE-DERIVED from the pinned lines above, and labelled as such: a pinned oracle capture for
// these two configurations does not exist, and constructing one would be a probe change rather than a test change.
// What is executable here is GoTavern's own served status for the two configurations a user can have.

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// basicAuthOffConfig writes a config with the given two flags and starts the server over it, returning the base URL of
// the IPv4 listener.
func startWithBasicAuthFlags(t *testing.T, listen, basicAuthMode bool) string {
	t.Helper()
	installRoot := t.TempDir()
	port := availableIPv4Port(t)
	config := strings.Join([]string{
		"listen: " + strconv.FormatBool(listen),
		"listenAddress:",
		"  ipv4: 127.0.0.1",
		"protocol:",
		"  ipv4: true",
		"  ipv6: false",
		"port: " + strconv.Itoa(port),
		"whitelistMode: false",
		"basicAuthMode: " + strconv.FormatBool(basicAuthMode),
		"basicAuthUser:",
		"  username: probe-user",
		"  password: probe-password",
		"enableUserAccounts: false",
		"perUserBasicAuth: false",
		// THE BASIC-AUTH GATE IS ISOLATED FROM THE UNRELATED SSRF GATE. Pinned's startup security check ALSO refuses
		// to boot on listen-with-no-access-control and no private-address filter; that is a different contract with its
		// own gate, and it would mask the question here. `securityOverride` is pinned's own switch for exactly this,
		// so the only behaviour under test is whether Basic Auth adds a password demand.
		"securityOverride: true",
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(installRoot, "config.yaml"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	running, err := Start(StartOptions{
		Args: []string{
			"--enableIPv4", "true", "--enableIPv6", "false",
			"--listen", strconv.FormatBool(listen), "--listenAddressIPv4", "127.0.0.1", "--port", strconv.Itoa(port),
			"--basicAuthMode", strconv.FormatBool(basicAuthMode),
			"--heartbeatInterval", "0", "--browserLaunchEnabled", "false",
		},
		WorkingDirectory:         installRoot,
		InstallRoot:              installRoot,
		Now:                      time.UnixMilli(1735689600000),
		WaitBeforeLegacyDataMove: func(time.Duration) {},
		InterfaceAddresses:       []net.Addr{},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := running.Close(ctx); err != nil {
			t.Errorf("close GoTavern server: %v", err)
		}
	})
	if !running.StartedIPv4 || running.StartedIPv6 {
		t.Fatalf("listener result = IPv4 %t, IPv6 %t", running.StartedIPv4, running.StartedIPv6)
	}
	return "http://" + running.Listeners()[0].Addr().String()
}

func TestBasicAuthIsOffWhenTheConfigurationDidNotEnableIt(t *testing.T) {
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 20 * time.Second}
	cases := []struct {
		name           string
		listen         bool
		basicAuthMode  bool
		description    string
	}{
		{
			name:          "default-config-no-basic-auth",
			listen:        true,
			basicAuthMode: false,
			description:   "upstream default/config.yaml ships basicAuthMode false; a default config must never ask for a password",
		},
		{
			name:          "basic-auth-flag-without-listen",
			listen:        false,
			basicAuthMode: true,
			description:   "pinned's gate is listen && basicAuthMode (src/server-main.js:141-142); basicAuthMode alone must not add the middleware",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			baseURL := startWithBasicAuthFlags(t, testCase.listen, testCase.basicAuthMode)
			for _, path := range []string{"/version", "/", "/csrf-token"} {
				request, err := http.NewRequest(http.MethodGet, baseURL+path, nil)
				if err != nil {
					t.Fatal(err)
				}
				response, err := client.Do(request)
				if err != nil {
					t.Fatalf("%s: GET %s failed: %v", testCase.description, path, err)
				}
				body, _ := io.ReadAll(response.Body)
				response.Body.Close()
				if response.StatusCode == http.StatusUnauthorized {
					t.Fatalf("%s: GET %s answered 401 without an Authorization header -- a configuration that did not enable basic auth is demanding a password (pinned would serve it: src/server-main.js:141-142)", testCase.description, path)
				}
				if response.StatusCode != http.StatusOK {
					t.Fatalf("%s: GET %s = %d (body %q), want 200", testCase.description, path, response.StatusCode, string(body[:min(len(body), 120)]))
				}
			}
		})
	}
}

// The ON direction is already covered against recorded pinned responses by
// TestStartGlobalBasicAuthMatchesPinnedNodeResponses. This test states the OFF direction, which no recorded fixture
// covers, so that the pair is complete in one place.
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
