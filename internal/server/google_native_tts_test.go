package server

// Replay of tests/oracle/sillytavern-1.19.0-google-native-tts.json, recorded by
// tools/probe-google-native-tts.mjs against the real pinned listener with the child clock frozen.
//
// The JWT is compared BYTE FOR BYTE, twice: the recorded token request body is replayed at the peer, and
// `googleServiceAccountJWT` is called directly with the same key and the frozen clock and its compact
// serialisation is compared against the assertion the pinned server actually sent. RS256 with PKCS#1 v1.5
// is deterministic, so "a token was produced" would be decoration; equality is the assertion.
//
// The reverse-proxy scenarios carry the proxy URL in the REQUEST, so the test substitutes the peer origin
// for the unreachable recorded host and compares the path the route builds on top of that base.

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

type googleTTSMock struct {
	Match      string            `json:"match"`
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
	BinaryBody bool              `json:"binaryBody"`
}

type googleTTSOutbound struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

type googleTTSScenario struct {
	Route       string          `json:"route"`
	RequestBody string          `json:"requestBody"`
	Mocks       []googleTTSMock `json:"mocks"`
	Secrets     map[string][]struct {
		Value string `json:"value"`
	} `json:"secrets"`
	Response struct {
		Status   int               `json:"status"`
		Headers  map[string]string `json:"headers"`
		Body     json.RawMessage   `json:"body"`
		BodyText string            `json:"bodyText"`
		SHA256   string            `json:"sha256"`
		Bytes    int               `json:"bytes"`
	} `json:"response"`
	Outbound []googleTTSOutbound `json:"outbound"`
}

type googleTTSFixture struct {
	Inputs struct {
		FixedEpochSeconds int64  `json:"fixedEpochSeconds"`
		AccessToken       string `json:"accessToken"`
		MakersuiteKey     string `json:"makersuiteKey"`
		VertexKey         string `json:"vertexKey"`
		ProxyPassword     string `json:"proxyPassword"`
	} `json:"inputs"`
	ImplementedRoutes []string                     `json:"implementedRoutes"`
	Scenarios         map[string]googleTTSScenario `json:"scenarios"`
}

func loadGoogleTTSOracle(t *testing.T) googleTTSFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-google-native-tts.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture googleTTSFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) < 15 {
		t.Fatalf("the native-tts oracle records only %d scenarios", len(fixture.Scenarios))
	}
	return fixture
}

// googleTTSPeer serves the scenario's mocks IN ORDER, one per outbound request, and records everything.
type googleTTSPeer struct {
	server *httptest.Server
	mocks  []googleTTSMock
	seen   []googleTTSOutbound
	index  int
}

func newGoogleTTSPeer(t *testing.T, mocks []googleTTSMock) *googleTTSPeer {
	t.Helper()
	peer := &googleTTSPeer{mocks: mocks}
	peer.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := readAllString(r)
		peer.seen = append(peer.seen, googleTTSOutbound{
			URL:     r.URL.RequestURI(),
			Method:  r.Method,
			Headers: headerMapOf(r.Header),
			Body:    body,
		})
		if peer.index >= len(peer.mocks) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"gotavern test: unstubbed outbound request"}}`))
			return
		}
		mock := peer.mocks[peer.index]
		peer.index++
		for name, value := range mock.Headers {
			w.Header().Set(name, value)
		}
		status := mock.Status
		if status == 0 {
			status = 200
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(mock.Body))
	}))
	t.Cleanup(peer.server.Close)
	return peer
}

func headerMapOf(header http.Header) map[string]string {
	result := make(map[string]string, len(header))
	for name, values := range header {
		if len(values) == 0 {
			continue
		}
		result[strings.ToLower(name)] = values[0]
	}
	return result
}

// googleTTSPath is the wire target of a recorded absolute URL: path plus query, with the URL parser's
// escaping, so a raw space interpolated into a path compares against what the transport actually sent.
func googleTTSPath(t *testing.T, recorded string) string {
	t.Helper()
	parsed, err := url.Parse(recorded)
	if err != nil {
		t.Fatalf("recorded URL %q does not parse: %v", recorded, err)
	}
	target := parsed.EscapedPath()
	if parsed.RawQuery != "" {
		target += "?" + parsed.RawQuery
	}
	return target
}

// requestBodyForPeer rewrites a request-supplied reverse_proxy to the peer, which is the only member that
// carries an absolute host into the outbound request.
func requestBodyForPeer(t *testing.T, body string, peer *googleTTSPeer) string {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("scenario request body does not parse: %v", err)
	}
	if _, present := payload["reverse_proxy"]; !present {
		return body
	}
	payload["reverse_proxy"] = peer.server.URL
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestGoogleNativeTTSMatchesPinnedOracle(t *testing.T) {
	fixture := loadGoogleTTSOracle(t)
	names := make([]string, 0, len(fixture.Scenarios))
	for name := range fixture.Scenarios {
		names = append(names, name)
	}
	sort.Strings(names)
	previousClock := googleNativeTTSNow
	googleNativeTTSNow = func() time.Time { return time.Unix(fixture.Inputs.FixedEpochSeconds, 0) }
	t.Cleanup(func() { googleNativeTTSNow = previousClock })

	for _, name := range names {
		scenario := fixture.Scenarios[name]
		t.Run(name, func(t *testing.T) {
			peer := newGoogleTTSPeer(t, scenario.Mocks)
			t.Setenv("GOTAVERN_GOOGLE_MAKERSUITE_URL", peer.server.URL)
			t.Setenv("GOTAVERN_GOOGLE_VERTEX_URL", peer.server.URL)
			t.Setenv("GOTAVERN_GOOGLE_VERTEX_GLOBAL_URL", peer.server.URL)
			t.Setenv("GOTAVERN_GOOGLE_OAUTH_URL", peer.server.URL)
			t.Setenv("GOTAVERN_GOOGLE_API_VERSION", "")
			dataRoot := t.TempDir()
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			writeGoogleTTSSecrets(t, dataRoot, scenario.Secrets)
			response := postSecretsRoute(t, handler, scenario.Route, requestBodyForPeer(t, scenario.RequestBody, peer))
			if response.Code != scenario.Response.Status {
				t.Fatalf("status = %d, pinned %d (body %q)", response.Code, scenario.Response.Status, response.Body.String())
			}
			if scenario.Response.SHA256 != "" {
				digest := sha256.Sum256(response.Body.Bytes())
				if hex.EncodeToString(digest[:]) != scenario.Response.SHA256 {
					t.Fatalf("body digest = %s, pinned %s", hex.EncodeToString(digest[:]), scenario.Response.SHA256)
				}
				if response.Body.Len() != scenario.Response.Bytes {
					t.Fatalf("body length = %d, pinned %d", response.Body.Len(), scenario.Response.Bytes)
				}
			} else if response.Body.String() != scenario.Response.BodyText {
				t.Fatalf("body = %q, pinned %q", response.Body.String(), scenario.Response.BodyText)
			}
			if got, want := response.Header().Get("Content-Type"), scenario.Response.Headers["content-type"]; got != want {
				t.Fatalf("content type = %q, pinned %q", got, want)
			}
			if len(peer.seen) != len(scenario.Outbound) {
				t.Fatalf("outbound requests = %d, pinned %d", len(peer.seen), len(scenario.Outbound))
			}
			for index, recorded := range scenario.Outbound {
				actual := peer.seen[index]
				if actual.Method != recorded.Method {
					t.Fatalf("request %d method = %s, pinned %s", index, actual.Method, recorded.Method)
				}
				if target := googleTTSPath(t, recorded.URL); actual.URL != target {
					t.Fatalf("request %d target = %q, pinned %q", index, actual.URL, target)
				}
				if actual.Body != recorded.Body {
					t.Fatalf("request %d body = %q, pinned %q", index, actual.Body, recorded.Body)
				}
				for _, header := range []string{"authorization", "x-goog-api-key", "content-type"} {
					want := recorded.Headers[header]
					got := actual.Headers[header]
					if got != want {
						t.Fatalf("request %d header %s = %q, pinned %q", index, header, got, want)
					}
				}
			}
		})
	}
}

// TestGoogleNativeTTSJWTIsByteIdenticalToPinned is the crypto assertion: the compact serialisation is
// deterministic, so it is compared against the assertion the pinned server actually put on the wire.
func TestGoogleNativeTTSJWTIsByteIdenticalToPinned(t *testing.T) {
	fixture := loadGoogleTTSOracle(t)
	scenario, present := fixture.Scenarios["vertexFullJwt"]
	if !present || len(scenario.Outbound) < 1 {
		t.Fatal("the fixture records no vertexFullJwt token exchange")
	}
	entries := scenario.Secrets["vertexai_service_account_json"]
	if len(entries) == 0 || entries[0].Value == "" {
		t.Fatal("the fixture records no service account secret")
	}
	values, err := url.ParseQuery(scenario.Outbound[0].Body)
	if err != nil {
		t.Fatal(err)
	}
	pinnedAssertion := values.Get("assertion")
	if pinnedAssertion == "" {
		t.Fatal("the pinned token request carries no assertion")
	}
	projectID, minted, err := googleServiceAccountJWT(entries[0].Value, time.Unix(fixture.Inputs.FixedEpochSeconds, 0))
	if err != nil {
		t.Fatal(err)
	}
	if projectID != "gotavern-synthetic-project" {
		t.Fatalf("project id = %q", projectID)
	}
	if minted != pinnedAssertion {
		t.Fatalf("minted JWT does not match the pinned one\n got %s\nwant %s", minted, pinnedAssertion)
	}
	// The claims are pinned explicitly as well, so a change to the clock or the lifetime is named rather
	// than hidden inside the signature comparison.
	claims, err := base64URLDecode(strings.Split(minted, ".")[1])
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(claims, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["iat"].(float64) != float64(fixture.Inputs.FixedEpochSeconds) {
		t.Fatalf("iat = %v, pinned %d", parsed["iat"], fixture.Inputs.FixedEpochSeconds)
	}
	if parsed["exp"].(float64) != float64(fixture.Inputs.FixedEpochSeconds+3600) {
		t.Fatalf("exp = %v, pinned %d", parsed["exp"], fixture.Inputs.FixedEpochSeconds+3600)
	}
}

// TestGoogleNativeTTSDoesNotCacheTokens pins the no-caching property: two consecutive calls must produce
// two token exchanges. A cached implementation would show one.
func TestGoogleNativeTTSDoesNotCacheTokens(t *testing.T) {
	fixture := loadGoogleTTSOracle(t)
	first := fixture.Scenarios["vertexFullJwt"]
	second := fixture.Scenarios["vertexFullJwtSecondRequest"]
	if len(first.Outbound) != 2 || len(second.Outbound) != 2 {
		t.Fatal("both full-branch scenarios must record a token exchange plus a model call")
	}
	if first.Outbound[0].URL != second.Outbound[0].URL {
		t.Fatalf("the two token exchanges target different URLs: %q and %q", first.Outbound[0].URL, second.Outbound[0].URL)
	}
	// With the same key and the same frozen clock the two exchanges MUST carry identical assertions, so the
	// bodies cannot discriminate caching. What does is the REQUEST COUNT: each call performs its own token
	// exchange, so a cached implementation loses the second exchange and the replay's per-scenario outbound
	// count assertion fails. That is the mechanism, stated here so the property is not merely implied.
	if first.Outbound[0].Body != second.Outbound[0].Body {
		t.Fatalf("with a frozen clock the two token bodies must be identical:\n%s\n%s", first.Outbound[0].Body, second.Outbound[0].Body)
	}
	// Each call records its OWN exchange as the first request. A cache would drop the second one, leaving a
	// single outbound request in that scenario, which the replay's count assertion rejects.
	for name, scenario := range map[string]googleTTSScenario{"vertexFullJwt": first, "vertexFullJwtSecondRequest": second} {
		if len(scenario.Outbound) != 2 {
			t.Fatalf("%s records %d requests; a full-branch call must exchange a token and then call the model", name, len(scenario.Outbound))
		}
		if !strings.HasSuffix(googleTTSPath(t, scenario.Outbound[0].URL), "/token") {
			t.Fatalf("%s: the first request is %q, not the token exchange", name, scenario.Outbound[0].URL)
		}
		if !strings.Contains(scenario.Outbound[0].Body, "assertion=") {
			t.Fatalf("%s: the first request carries no assertion", name)
		}
	}
}

func TestGoogleNativeTTSErrorShapesStayDistinct(t *testing.T) {
	fixture := loadGoogleTTSOracle(t)
	jsonError := fixture.Scenarios["aiStudioProviderErrorJson"]
	textError := fixture.Scenarios["aiStudioProviderErrorText"]
	if jsonError.Response.Status != 429 {
		t.Fatalf("a JSON provider error must propagate the provider status, got %d", jsonError.Response.Status)
	}
	if textError.Response.Status != 500 {
		t.Fatalf("a NON-JSON provider error must become 500, got %d", textError.Response.Status)
	}
	if string(jsonError.Response.Body) == string(textError.Response.Body) {
		t.Fatal("the two error shapes produced the same body; they are supposed to be distinguishable")
	}
}

// writeGoogleTTSSecrets seeds the per-user secrets.json the way a real runtime stores it: the pinned
// readSecret reads that file, so the fixture's recorded secret values are what the route actually sees.
func writeGoogleTTSSecrets(t *testing.T, dataRoot string, secrets map[string][]struct {
	Value string `json:"value"`
}) {
	t.Helper()
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(userRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if len(secrets) == 0 {
		return
	}
	payload := make(map[string]any, len(secrets))
	for name, entries := range secrets {
		list := make([]map[string]any, 0, len(entries))
		for index, entry := range entries {
			list = append(list, map[string]any{
				"id":     name + "-" + strconvItoa(index),
				"value":  entry.Value,
				"label":  name,
				"active": true,
			})
		}
		payload[name] = list
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userRoot, "secrets.json"), encoded, 0o644); err != nil {
		t.Fatal(err)
	}
}
func base64URLDecode(value string) ([]byte, error) {
	if remainder := len(value) % 4; remainder != 0 {
		value += strings.Repeat("=", 4-remainder)
	}
	return base64.URLEncoding.DecodeString(value)
}
