package server

// `requestOverrides` -- the operator's per-host header overrides (src/additional-headers.js:202-210, applied at
// :251-262).
//
// THE OBSERVABLE IS THE PROVIDER-WIRE HEADER SET, so this test drives a real route against a recording peer
// and reads the headers THAT PEER received. Asserting on a header map the handler built would be the same
// defect the provider-wire doctrine forbids: it can be green while the transport drops or rewrites the value.
//
// THE FOUR THINGS IT WOULD FAIL ON IF THE BEHAVIOUR WERE REMOVED OR GOT WRONG:
//
//  1. a configured override does not reach the outbound request at all (the pre-change state);
//  2. the override does not WIN over the api-type headers: pinned assigns it LAST
//     (`Object.assign(headers, overrideHeaders)` after `getHeaders(...)`), so an overridden `Authorization`
//     must replace the secret's `Bearer ...` rather than be appended beside it;
//  3. the host match is not the pinned one: `new URL(server).host` -- lowercase, port included only when it
//     is not the scheme default -- so an entry keyed on the exact peer authority matches and an entry keyed on
//     anything else does not;
//  4. the FIRST matching entry decides: `find` stops at the entry whose hosts matched, so a second entry's
//     headers must not be consulted and must not be merged.

import (
	"net/http"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

func TestRequestOverridesReachTheProviderAndWin(t *testing.T) {
	for _, testCase := range []struct {
		name string
		// configFor builds the requestOverrides block for the peer's authority.
		configFor func(authority string) []string
		secrets   map[string]any
		// want holds the headers the PEER must have received, exactly.
		want map[string]string
		// forbidden names a header the peer must NOT have received.
		forbidden string
	}{
		{
			name: "no requestOverrides configured sends only the secret's bearer header",
			configFor: func(string) []string {
				return nil
			},
			secrets: map[string]any{
				"api_key_generic": []any{map[string]any{"id": "probe", "value": "plain-key", "label": "probe", "active": true}},
			},
			want:      map[string]string{"authorization": "Bearer plain-key"},
			forbidden: "x-probe",
		},
		{
			name: "a matching host's headers replace the secret's authorization",
			configFor: func(authority string) []string {
				return []string{
					"requestOverrides:",
					"  - hosts:",
					"      - " + authority,
					"    headers:",
					"      Authorization: Override-Token",
					"      X-Probe: overridden",
				}
			},
			secrets: map[string]any{
				"api_key_generic": []any{map[string]any{"id": "probe", "value": "plain-key", "label": "probe", "active": true}},
			},
			want: map[string]string{"authorization": "Override-Token", "x-probe": "overridden"},
		},
		{
			name: "a non-matching host is untouched",
			configFor: func(string) []string {
				return []string{
					"requestOverrides:",
					"  - hosts:",
					"      - somewhere.else.invalid",
					"    headers:",
					"      Authorization: Never-Sent",
				}
			},
			secrets: map[string]any{
				"api_key_generic": []any{map[string]any{"id": "probe", "value": "plain-key", "label": "probe", "active": true}},
			},
			want:      map[string]string{"authorization": "Bearer plain-key"},
			forbidden: "never-sent",
		},
		{
			// `find` stops at the FIRST entry whose hosts matched, so the second entry's headers are not
			// consulted even though it also names the peer.
			name: "the first matching entry decides and is not merged with a later one",
			configFor: func(authority string) []string {
				return []string{
					"requestOverrides:",
					"  - hosts:",
					"      - " + authority,
					"    headers:",
					"      X-Probe: first",
					"  - hosts:",
					"      - " + authority,
					"    headers:",
					"      X-Probe: second",
					"      X-Later: leaked",
				}
			},
			want:      map[string]string{"x-probe": "first"},
			forbidden: "x-later",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			// The props route requires `chat_template` in the reply (`props.chat_template.endsWith` throws
			// in pinned otherwise), so the body is the smallest shape that reaches a 200.
			recorder := mockprovider.New([]mockprovider.Response{{
				Status:  200,
				Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json"}},
				Body:    `{"chat_template":"{{char}}: "}`,
			}})
			address, err := recorder.Listen(0)
			if err != nil {
				t.Fatalf("start mock provider: %v", err)
			}
			t.Cleanup(func() { _ = recorder.Close() })

			scenario := providerWireScenario{}
			scenario.Request.Path = "/api/backends/text-completions/props"
			scenario.Secrets = testCase.secrets
			scenario.BackendConfig = testCase.configFor(address.String())

			origin, cookie, token := startChatCompletionTestServer(t, scenario)
			body := `{"api_server":"http://` + address.String() + `","api_type":"generic"}`
			status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, body)
			if status != http.StatusOK {
				t.Fatalf("POST %s = %d, body %q", scenario.Request.Path, status, text)
			}

			requests := recorder.Recording().Requests
			if len(requests) != 1 {
				t.Fatalf("the peer received %d requests, want 1", len(requests))
			}
			received := map[string]string{}
			for _, header := range requests[0].Headers {
				received[strings.ToLower(header.Name)] = header.Value
			}
			for name, want := range testCase.want {
				if got := received[strings.ToLower(name)]; got != want {
					t.Errorf("the peer received %s = %q, want %q (all headers %v)", name, got, want, received)
				}
			}
			if testCase.forbidden != "" {
				if got, present := received[strings.ToLower(testCase.forbidden)]; present {
					t.Errorf("the peer received %s = %q, which the pinned Object.assign must not send here (all headers %v)",
						testCase.forbidden, got, received)
				}
			}
		})
	}
}

// TestPinnedURLHostMatchesTheWhatwgSerialisation pins the MATCH KEY itself: `new URL(server).host` is the
// lowercased authority with the scheme's default port removed, which is the only thing an operator can write
// in `hosts` and have match. A derivable-looking rewrite (keeping `:80`, keeping the case, including the path)
// would fail every row here and would make the documented config format stop working.
func TestPinnedURLHostMatchesTheWhatwgSerialisation(t *testing.T) {
	for _, testCase := range []struct {
		url  string
		want string
		ok   bool
	}{
		{url: "http://example.com/v1", want: "example.com", ok: true},
		{url: "http://example.com:80/v1", want: "example.com", ok: true},
		{url: "https://example.com:443/v1", want: "example.com", ok: true},
		{url: "http://example.com:5001/v1", want: "example.com:5001", ok: true},
		{url: "HTTPS://Example.COM:8443/v1", want: "example.com:8443", ok: true},
		{url: "http://[::1]:8080/v1", want: "[::1]:8080", ok: true},
		{url: "http://[::1]:80/v1", want: "[::1]", ok: true},
		{url: "http://127.0.0.1:5001", want: "127.0.0.1:5001", ok: true},
		{url: "not a url", ok: false},
		{url: "", ok: false},
	} {
		got, ok := pinnedURLHost(testCase.url)
		if ok != testCase.ok {
			t.Errorf("pinnedURLHost(%q) ok = %t, want %t", testCase.url, ok, testCase.ok)
			continue
		}
		if ok && got != testCase.want {
			t.Errorf("pinnedURLHost(%q) = %q, want %q", testCase.url, got, testCase.want)
		}
	}
}
