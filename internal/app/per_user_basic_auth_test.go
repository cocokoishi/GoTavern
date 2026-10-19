package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
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

type pinnedPerUserBasicAuthFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret         string            `json:"cookieSecret"`
		GlobalUsername       string            `json:"globalUsername"`
		GlobalPassword       string            `json:"globalPassword"`
		BasicAuthMaxAttempts int               `json:"basicAuthMaxAttempts"`
		RateLimitDuration    int               `json:"rateLimitDurationSeconds"`
		PreferRealIPHeader   bool              `json:"preferRealIPHeader"`
		Users                []json.RawMessage `json:"users"`
		Credentials          map[string]string `json:"credentials"`
	} `json:"inputs"`
	Observations map[string]struct {
		Headers        map[string]string `json:"headers"`
		Status         int               `json:"status"`
		ContentType    string            `json:"contentType"`
		Bytes          int               `json:"bytes"`
		SHA256         string            `json:"sha256"`
		Body           string            `json:"body"`
		SetCookie      []string          `json:"setCookie"`
		SessionPayload map[string]any    `json:"sessionPayload"`
	} `json:"observations"`
}

func TestStartPerUserBasicAuthMatchesPinnedNode(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-per-user-basic-auth.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture pinnedPerUserBasicAuthFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("per-user Basic Auth oracle baseline = %+v", fixture.Baseline)
	}

	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	storagePath := filepath.Join(dataRoot, "_storage")
	if err := os.MkdirAll(storagePath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, userBytes := range fixture.Inputs.Users {
		var user struct {
			Handle string `json:"handle"`
		}
		if err := json.Unmarshal(userBytes, &user); err != nil {
			t.Fatal(err)
		}
		key := "user:" + user.Handle
		record, err := json.Marshal(struct {
			Key   string          `json:"key"`
			Value json.RawMessage `json:"value"`
		}{Key: key, Value: userBytes})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(storagePath, nodeStorageFilename(key)), record, 0o600); err != nil {
			t.Fatal(err)
		}
	}
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
		"  username: " + fixture.Inputs.GlobalUsername,
		"  password: " + fixture.Inputs.GlobalPassword,
		"enableUserAccounts: true",
		"perUserBasicAuth: true",
		"rateLimiting:",
		"  basicAuthMaxAttempts: " + strconv.Itoa(fixture.Inputs.BasicAuthMaxAttempts),
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
	client := &http.Client{
		Transport: &http.Transport{Proxy: nil},
		Timeout:   20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	aliceAuthorization := basicAuthorization("alice", fixture.Inputs.Credentials["alice"])
	wrongPasswordAuthorization := basicAuthorization("alice", "wrong")
	unicodeAuthorization := basicAuthorization("unicode", fixture.Inputs.Credentials["unicodeBasicHeader"])
	disabledAuthorization := basicAuthorization("disabled", fixture.Inputs.Credentials["disabled"])
	globalAuthorization := basicAuthorization(fixture.Inputs.GlobalUsername, fixture.Inputs.GlobalPassword)
	scenarios := []struct {
		name           string
		authorization  string
		forwardedIP    string
		route          string
		useLoginCookie bool
	}{
		{name: "missingAuthorization", forwardedIP: "198.51.100.11", route: "/login"},
		{name: "wrongScheme", authorization: "Bearer dGVzdA==", forwardedIP: "198.51.100.11", route: "/login"},
		{name: "globalCredentialRejected", authorization: globalAuthorization, forwardedIP: "198.51.100.12", route: "/login"},
		{name: "wrongPassword", authorization: wrongPasswordAuthorization, forwardedIP: "198.51.100.13", route: "/login"},
		{name: "unknownUser", authorization: basicAuthorization("missing", "password"), forwardedIP: "198.51.100.14", route: "/login"},
		{name: "disabledUser", authorization: disabledAuthorization, forwardedIP: "198.51.100.15", route: "/login"},
		{name: "caseSensitiveHandle", authorization: basicAuthorization("Alice", fixture.Inputs.Credentials["alice"]), forwardedIP: "198.51.100.16", route: "/login"},
		{name: "rateLimitedFirst", authorization: wrongPasswordAuthorization, forwardedIP: "198.51.100.17", route: "/login"},
		{name: "rateLimitedSecond", authorization: wrongPasswordAuthorization, forwardedIP: "198.51.100.17", route: "/login"},
		{name: "rateLimitedThird", authorization: wrongPasswordAuthorization, forwardedIP: "198.51.100.17", route: "/login"},
		{name: "validWhileLimited", authorization: aliceAuthorization, forwardedIP: "198.51.100.17", route: "/login"},
		{name: "invalidBeforeSuccess", authorization: wrongPasswordAuthorization, forwardedIP: "198.51.100.18", route: "/login"},
		{name: "validClearsLimit", authorization: aliceAuthorization, forwardedIP: "198.51.100.18", route: "/login"},
		{name: "invalidAfterSuccess", authorization: wrongPasswordAuthorization, forwardedIP: "198.51.100.18", route: "/login"},
		{name: "unicodeNFCPassword", authorization: unicodeAuthorization, forwardedIP: "198.51.100.19", route: "/login"},
		{name: "validCredentialNoAutoLogin", authorization: aliceAuthorization, forwardedIP: "198.51.100.20", route: "/login?noauto=1"},
		{name: "autoLogin", authorization: aliceAuthorization, forwardedIP: "198.51.100.21", route: "/login"},
		{name: "versionAfterAutoLogin", authorization: aliceAuthorization, forwardedIP: "198.51.100.22", route: "/version", useLoginCookie: true},
	}
	var loginCookies []*http.Cookie
	for _, scenario := range scenarios {
		scenario := scenario
		t.Run(scenario.name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodGet, "http://"+address+scenario.route, nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("X-Real-IP", scenario.forwardedIP)
			if scenario.authorization != "" {
				request.Header.Set("Authorization", scenario.authorization)
			}
			if scenario.useLoginCookie {
				if len(loginCookies) == 0 {
					t.Fatal("prior Basic Auth auto-login did not return session cookies")
				}
				for _, cookie := range loginCookies {
					request.AddCookie(cookie)
				}
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
				t.Fatalf("per-user Basic Auth oracle is missing %q", scenario.name)
			}
			if response.StatusCode != expected.Status {
				t.Fatalf("status = %d; pinned Node has %d", response.StatusCode, expected.Status)
			}
			if !strings.EqualFold(response.Header.Get("Content-Type"), expected.ContentType) {
				t.Fatalf("Content-Type = %q; pinned Node has %q", response.Header.Get("Content-Type"), expected.ContentType)
			}
			if len(body) != expected.Bytes || sha256Hex(body) != expected.SHA256 || string(body) != expected.Body {
				t.Fatalf("response body size/hash/content = %d/%s/%q; pinned Node has %d/%s/%q", len(body), sha256Hex(body), body, expected.Bytes, expected.SHA256, expected.Body)
			}
			gotHeaders := stableResponseHeaders(response.Header)
			delete(gotHeaders, "set-cookie")
			if _, isRateLimited := expected.Headers["retry-after"]; isRateLimited {
				retryAfter, err := strconv.Atoi(response.Header.Get("Retry-After"))
				if err != nil || retryAfter < 1 || retryAfter > fixture.Inputs.RateLimitDuration {
					t.Fatalf("Retry-After = %q; pinned limiter window is 1..%d seconds", response.Header.Get("Retry-After"), fixture.Inputs.RateLimitDuration)
				}
				delete(gotHeaders, "retry-after")
			}
			wantHeaders := make(map[string]string, len(expected.Headers))
			for name, value := range expected.Headers {
				if name != "retry-after" {
					wantHeaders[name] = value
				}
			}
			if scenario.name == "validCredentialNoAutoLogin" {
				for name := range wantHeaders {
					if name != "cache-control" && name != "accept-ranges" {
						delete(wantHeaders, name)
					}
				}
				for name := range gotHeaders {
					if name != "cache-control" && name != "accept-ranges" {
						delete(gotHeaders, name)
					}
				}
			}
			if !reflect.DeepEqual(gotHeaders, wantHeaders) {
				t.Fatalf("response headers = %#v; pinned Node has %#v", gotHeaders, wantHeaders)
			}

			cookies := response.Header.Values("Set-Cookie")
			if len(expected.SetCookie) != len(cookies) {
				t.Fatalf("Set-Cookie count = %d; pinned Node has %d", len(cookies), len(expected.SetCookie))
			}
			if len(cookies) > 0 {
				cookieName, _, found := strings.Cut(cookies[0], "=")
				if !found {
					t.Fatalf("malformed session cookie %q", cookies[0])
				}
				cookieName = strings.TrimSuffix(cookieName, ".sig")
				if got := normalizePerUserBasicAuthCookies(cookies, cookieName); !reflect.DeepEqual(got, expected.SetCookie) {
					t.Fatalf("normalized session cookies = %#v; pinned Node has %#v", got, expected.SetCookie)
				}
				if scenario.name == "validClearsLimit" || scenario.name == "autoLogin" || scenario.name == "unicodeNFCPassword" {
					var gotPayload map[string]any
					for _, cookie := range cookies {
						if !strings.HasSuffix(strings.SplitN(cookie, "=", 2)[0], ".sig") {
							value := strings.SplitN(strings.SplitN(cookie, "=", 2)[1], ";", 2)[0]
							decoded, err := base64.StdEncoding.DecodeString(value)
							if err != nil || json.Unmarshal(decoded, &gotPayload) != nil {
								t.Fatalf("decode session payload: %v", err)
							}
							break
						}
					}
					if !reflect.DeepEqual(gotPayload, expected.SessionPayload) {
						t.Fatalf("session payload = %#v; pinned Node has %#v", gotPayload, expected.SessionPayload)
					}
				}
				if scenario.name == "autoLogin" {
					loginCookies = response.Cookies()
				}
			}
		})
	}
}

func basicAuthorization(username, password string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+password))
}

func normalizePerUserBasicAuthCookies(cookies []string, cookieName string) []string {
	result := make([]string, 0, len(cookies))
	for _, raw := range cookies {
		parts := strings.Split(raw, "; ")
		nameValue := strings.SplitN(parts[0], "=", 2)
		name := nameValue[0]
		if name == cookieName+".sig" {
			name = "session-<host-hash>.sig"
		} else if name == cookieName {
			name = "session-<host-hash>"
		}
		value := "<base64-session-json>"
		if strings.HasSuffix(name, ".sig") {
			value = "<signature>"
		}
		parts[0] = name + "=" + value
		for index := 1; index < len(parts); index++ {
			if strings.HasPrefix(strings.ToLower(parts[index]), "expires=") {
				parts[index] = "expires=<timestamp>"
			}
		}
		result = append(result, strings.Join(parts, "; "))
	}
	return result
}

func nodeStorageFilename(key string) string {
	digest := sha256.Sum256([]byte(key))
	return hex.EncodeToString(digest[:])
}
