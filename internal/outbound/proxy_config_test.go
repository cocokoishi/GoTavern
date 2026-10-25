package outbound

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// The user's configured proxy (pinned's requestProxy.enabled/url/bypass) is a USER PATH, not a nicety: it is
// the documented way for somebody behind a proxy to reach a provider. These tests pin the two decisions that
// make it safe:
//
//  1. An explicit config setting wins over the environment and the two are never merged -- a shell export
//     somebody forgot about must not override what their config says.
//  2. Enabled-with-no-usable-URL is an ERROR, not a silent direct dial, because "my provider is unreachable"
//     is exactly the symptom the user reported and a silent fallback reproduces it.
func TestConfigureRequestProxyValidatesItsInput(t *testing.T) {
	t.Cleanup(func() { _ = ConfigureRequestProxy(false, "", nil) })

	cases := []struct {
		name    string
		enabled bool
		rawURL  string
		wantErr string
	}{
		{name: "disabled without a URL is fine", enabled: false, rawURL: ""},
		{name: "disabled with a URL is fine, it is simply unused", enabled: false, rawURL: "http://proxy.example:3128"},
		{name: "enabled with a usable URL", enabled: true, rawURL: "http://proxy.example:3128"},
		{name: "enabled with socks", enabled: true, rawURL: "socks5://127.0.0.1:1080"},
		{name: "enabled with no URL is refused", enabled: true, rawURL: "", wantErr: "requestProxy.url"},
		{name: "enabled with whitespace is refused", enabled: true, rawURL: "   ", wantErr: "requestProxy.url"},
		{name: "enabled with a bare host is refused", enabled: true, rawURL: "proxy.example:3128", wantErr: "absolute"},
		{name: "enabled with junk is refused", enabled: true, rawURL: "http://", wantErr: "absolute"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			err := ConfigureRequestProxy(testCase.enabled, testCase.rawURL, nil)
			if testCase.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected an error mentioning %q, got none", testCase.wantErr)
			}
			if !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("error %q does not mention %q, so the user cannot tell which setting to fix", err, testCase.wantErr)
			}
		})
	}
}

// A request must actually be routed through the configured proxy, and a bypassed host must not be. Without
// this, ConfigureRequestProxy could store a value that no request ever consults -- the "capability that never
// reaches the behaviour" failure this project keeps finding.
func TestProviderProxyUsesTheConfiguredProxyAndHonoursBypass(t *testing.T) {
	t.Cleanup(func() { _ = ConfigureRequestProxy(false, "", nil) })

	const proxyURL = "http://proxy.example:3128"
	if err := ConfigureRequestProxy(true, proxyURL, []string{".internal.example", "localhost"}); err != nil {
		t.Fatalf("configure: %v", err)
	}

	routed := []struct {
		target string
		want   string // "" means "no proxy for this request"
	}{
		{target: "https://api.deepseek.com/v1/chat/completions", want: proxyURL},
		{target: "https://api.example.com/v1/models", want: proxyURL},
		{target: "https://service.internal.example/v1/models", want: ""},
		{target: "https://internal.example/v1/models", want: ""},
		{target: "http://localhost:8080/v1/models", want: ""},
		// A bare suffix must NOT match: "ample.com" is not "example.com".
		{target: "https://ample.com/v1/models", want: proxyURL},
	}

	for _, testCase := range routed {
		request, err := http.NewRequest(http.MethodPost, testCase.target, nil)
		if err != nil {
			t.Fatalf("build request for %s: %v", testCase.target, err)
		}
		got, err := providerProxy(request)
		if err != nil {
			t.Fatalf("%s: providerProxy: %v", testCase.target, err)
		}
		if testCase.want == "" {
			if got != nil {
				t.Fatalf("%s: expected a DIRECT connection, got proxy %s", testCase.target, got)
			}
			continue
		}
		if got == nil {
			t.Fatalf("%s: expected proxy %s, got a direct connection", testCase.target, testCase.want)
		}
		wantParsed, err := url.Parse(testCase.want)
		if err != nil {
			t.Fatal(err)
		}
		if got.String() != wantParsed.String() {
			t.Fatalf("%s: proxy = %s, want %s", testCase.target, got, wantParsed)
		}
	}
}

// Disabled means the environment applies, exactly as it did before this feature existed: a user who never
// configured requestProxy must not lose HTTPS_PROXY support.
func TestProviderProxyFallsBackToTheEnvironmentWhenDisabled(t *testing.T) {
	t.Cleanup(func() { _ = ConfigureRequestProxy(false, "", nil) })
	if err := ConfigureRequestProxy(false, "", nil); err != nil {
		t.Fatalf("configure: %v", err)
	}
	request, err := http.NewRequest(http.MethodGet, "https://api.deepseek.com/v1/models", nil)
	if err != nil {
		t.Fatal(err)
	}
	got, gotErr := providerProxy(request)
	want, wantErr := http.ProxyFromEnvironment(request)
	if (gotErr == nil) != (wantErr == nil) {
		t.Fatalf("error behaviour differs from the environment resolver: got %v, want %v", gotErr, wantErr)
	}
	if (got == nil) != (want == nil) {
		t.Fatalf("proxy decision differs from the environment resolver: got %v, want %v", got, want)
	}
	if got != nil && got.String() != want.String() {
		t.Fatalf("proxy = %s, environment resolver says %s", got, want)
	}
}
