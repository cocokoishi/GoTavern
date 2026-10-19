package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

type pinnedBasicAuthFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Observations map[string]struct {
		Headers     map[string]string `json:"headers"`
		Status      int               `json:"status"`
		ContentType string            `json:"contentType"`
		Bytes       int               `json:"bytes"`
		SHA256      string            `json:"sha256"`
		Body        string            `json:"body"`
	} `json:"observations"`
}

func TestStartGlobalBasicAuthMatchesPinnedNodeResponses(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-basic-auth.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture pinnedBasicAuthFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("Basic Auth oracle baseline = %+v", fixture.Baseline)
	}

	installRoot := t.TempDir()
	port := availableIPv4Port(t)
	config := strings.Join([]string{
		"listen: true",
		"listenAddress:",
		"  ipv4: 127.0.0.1",
		"protocol:",
		"  ipv4: true",
		"  ipv6: false",
		"port: " + strconv.Itoa(port),
		"whitelistMode: false",
		"basicAuthMode: true",
		"basicAuthUser:",
		"  username: probe-user",
		"  password: \"secret:with:colon\"",
		"enableUserAccounts: false",
		"perUserBasicAuth: false",
		"rateLimiting:",
		"  basicAuthMaxAttempts: 2",
		"  preferRealIpHeader: true",
		"forwardedHeaders:",
		"  xRealIp: true",
		"  xForwardedFor: false",
		"  cfConnectingIp: false",
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(installRoot, "config.yaml"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}

	running, err := Start(StartOptions{
		Args: []string{
			"--enableIPv4", "true", "--enableIPv6", "false", "--listen", "true",
			"--listenAddressIPv4", "127.0.0.1", "--port", strconv.Itoa(port),
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
	if !running.StartedIPv4 || running.StartedIPv6 || len(running.ListenerFailures) != 0 {
		t.Fatalf("listener result = IPv4 %t, IPv6 %t, failures %+v", running.StartedIPv4, running.StartedIPv6, running.ListenerFailures)
	}

	address := running.Listeners()[0].Addr().String()
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 20 * time.Second}
	validAuthorization := "Basic " + base64.StdEncoding.EncodeToString([]byte("probe-user:secret:with:colon"))
	invalidAuthorization := "Basic " + base64.StdEncoding.EncodeToString([]byte("probe-user:wrong"))
	scenarios := []struct {
		name          string
		authorization string
		forwardedIP   string
	}{
		{name: "missingAuthorization", forwardedIP: "198.51.100.11"},
		{name: "wrongScheme", authorization: "Bearer dGVzdA==", forwardedIP: "198.51.100.11"},
		{name: "invalidCredentialFirst", authorization: invalidAuthorization, forwardedIP: "198.51.100.12"},
		{name: "invalidCredentialSecond", authorization: invalidAuthorization, forwardedIP: "198.51.100.12"},
		{name: "invalidCredentialLimit", authorization: invalidAuthorization, forwardedIP: "198.51.100.12"},
		{name: "validCredentialWhileLimited", authorization: validAuthorization, forwardedIP: "198.51.100.12"},
		{name: "invalidCredentialBeforeSuccess", authorization: invalidAuthorization, forwardedIP: "198.51.100.13"},
		{name: "validCredentialClearsLimit", authorization: validAuthorization, forwardedIP: "198.51.100.13"},
		{name: "invalidCredentialAfterSuccess", authorization: invalidAuthorization, forwardedIP: "198.51.100.13"},
	}
	for _, scenario := range scenarios {
		t.Run(scenario.name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodGet, "http://"+address+"/version", nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("X-Real-IP", scenario.forwardedIP)
			if scenario.authorization != "" {
				request.Header.Set("Authorization", scenario.authorization)
			}
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			expected, exists := fixture.Observations[scenario.name]
			if !exists {
				t.Fatalf("Basic Auth oracle is missing %q", scenario.name)
			}
			if response.StatusCode != expected.Status {
				t.Fatalf("status = %d; pinned Node has %d", response.StatusCode, expected.Status)
			}
			if contentType := response.Header.Get("Content-Type"); contentType != expected.ContentType {
				t.Fatalf("Content-Type = %q; pinned Node has %q", contentType, expected.ContentType)
			}
			if len(body) != expected.Bytes || sha256Hex(body) != expected.SHA256 || string(body) != expected.Body {
				t.Fatalf("response body size/hash/content = %d/%s/%q; pinned Node has %d/%s/%q", len(body), sha256Hex(body), body, expected.Bytes, expected.SHA256, expected.Body)
			}
			gotHeaders := stableResponseHeaders(response.Header)
			if _, isRateLimited := expected.Headers["retry-after"]; isRateLimited {
				retryAfter, err := strconv.Atoi(response.Header.Get("Retry-After"))
				if err != nil || retryAfter < 1 || retryAfter > 60 {
					t.Fatalf("Retry-After = %q; pinned limiter window is 1..60 seconds", response.Header.Get("Retry-After"))
				}
				delete(gotHeaders, "retry-after")
			}
			wantHeaders := make(map[string]string, len(expected.Headers))
			for name, value := range expected.Headers {
				if name != "retry-after" {
					wantHeaders[name] = value
				}
			}
			if !reflect.DeepEqual(gotHeaders, wantHeaders) {
				t.Fatalf("response headers = %#v; pinned Node has %#v", gotHeaders, wantHeaders)
			}
		})
	}
}
