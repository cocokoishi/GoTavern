package server

// Differential test for POST /api/backends/chat-completions/generate.
//
// The input comes from tests/provider-wire/scenarios/*.json and the expectation
// comes from the committed capture
// tests/oracle/sillytavern-1.19.0-provider-wire.json, so this test can fail
// when the Go route diverges. It deliberately does not transcribe the captured
// values: a hardcoded copy would keep passing after the evidence changed.
//
// The comparison is anchored on bodySha256 and bodyLength, which cover the
// exact bytes the provider received. bodyText is a readability projection and
// is never the assertion. A scenario whose capture is missing, or whose
// recording contains no provider request, fails loudly rather than passing on
// nothing.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

type providerWireScenario struct {
	Name                     string         `json:"name"`
	TargetPath               string         `json:"targetPath"`
	Secrets                  map[string]any `json:"secrets"`
	ExpectedAuthorizationKey string         `json:"expectedAuthorizationKey"`
	// A source whose credential is not a bearer token declares the header and value here instead; the
	// capability is asserted exactly as the bearer one is, and only the recorded value is redacted.
	ExpectedAPIKey *struct {
		Header string `json:"header"`
		Value  string `json:"value"`
	} `json:"expectedApiKey"`
	AbortAfterFirstEvent bool `json:"abortAfterFirstEvent"`
	// A scenario's `backendConfig` is the config.yaml the PROBE writes before it starts EACH leg. The
	// replay drives the route in-process, so without reproducing that file a config-driven scenario
	// silently runs on the defaults -- which is exactly how
	// `openrouter-reasoning-signatures-flag-off` failed: the pinned leg had `gemini.thoughtSignatures:
	// false` and the replay had no config at all, so the Go side read the default `true` and emitted a
	// detail the capture does not contain. A scenario whose observable depends on config must therefore
	// carry the same config into the replay, or the fixture is not being replayed faithfully.
	BackendConfig []string `json:"backendConfig"`
	// A source whose provider URL is a pinned LITERAL declares a SEAM here (openrouter is the first): the
	// live probe exports it for the GoTavern leg and redirects the pinned leg at the transport layer, so the
	// replay must do the same or it drives the route at the real provider instead of the recorder.
	GoSeam *struct {
		EnvironmentVariable string `json:"environmentVariable"`
		Value               string `json:"value"`
		PinnedLiteral       string `json:"pinnedLiteral"`
	} `json:"goSeam"`
	DriverTimeoutMs int `json:"driverTimeoutMs"`
	Request         struct {
		Path string `json:"path"`
	} `json:"request"`
	Mock struct {
		Responses []mockprovider.Response `json:"responses"`
	} `json:"mock"`
}

type providerWireHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type providerWireProviderRequest struct {
	Index              int                  `json:"index"`
	Method             string               `json:"method"`
	RawTarget          string               `json:"rawTarget"`
	RawPath            string               `json:"rawPath"`
	RawQuery           string               `json:"rawQuery"`
	Proto              string               `json:"proto"`
	Headers            []providerWireHeader `json:"headers"`
	BodyLength         int                  `json:"bodyLength"`
	BodySHA256         string               `json:"bodySha256"`
	Chunked            bool                 `json:"chunked"`
	ClientDisconnected bool                 `json:"clientDisconnected"`
}

type providerWireSSEEvent struct {
	Event *string `json:"event"`
	Data  string  `json:"data"`
}

type providerWireCaptureScenario struct {
	HTTP struct {
		Requests []struct {
			BodySHA256 string `json:"bodySha256"`
		} `json:"requests"`
	} `json:"http"`
	Provider struct {
		Requests []providerWireProviderRequest `json:"requests"`
	} `json:"provider"`
	ProviderResponse struct {
		Status          int                    `json:"status"`
		Headers         map[string]string      `json:"headers"`
		ContentType     *string                `json:"contentType"`
		AbortedByDriver bool                   `json:"abortedByDriver"`
		DriverTimedOut  bool                   `json:"driverTimedOut"`
		Body            json.RawMessage        `json:"body"`
		Events          []providerWireSSEEvent `json:"events"`
	} `json:"providerResponse"`
	AuthorizationKeyVerified bool `json:"authorizationKeyVerified"`
	APIKeyVerified           bool `json:"apiKeyVerified"`
}

type providerWireCapture struct {
	Scenarios map[string]providerWireCaptureScenario `json:"scenarios"`
}

func TestChatCompletionGenerateMatchesProviderWireCapture(t *testing.T) {
	repositoryRoot := filepath.Join("..", "..")
	captureBytes, err := os.ReadFile(filepath.Join(repositoryRoot, "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatalf("read provider-wire capture: %v", err)
	}
	var capture providerWireCapture
	if err := json.Unmarshal(captureBytes, &capture); err != nil {
		t.Fatalf("decode provider-wire capture: %v", err)
	}

	scenarioDirectory := filepath.Join(repositoryRoot, "tests", "provider-wire", "scenarios")
	entries, err := os.ReadDir(scenarioDirectory)
	if err != nil {
		t.Fatalf("read scenario directory: %v", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		t.Fatal("no provider-wire scenarios found")
	}

	for _, name := range names {
		name := name
		t.Run(strings.TrimSuffix(name, ".json"), func(t *testing.T) {
			rawScenario, err := os.ReadFile(filepath.Join(scenarioDirectory, name))
			if err != nil {
				t.Fatalf("read scenario: %v", err)
			}
			var scenario providerWireScenario
			if err := json.Unmarshal(rawScenario, &scenario); err != nil {
				t.Fatalf("decode scenario: %v", err)
			}
			expected, exists := capture.Scenarios[scenario.Name]
			if !exists {
				t.Fatalf("capture has no scenario %q; a missing capture must never look like a pass", scenario.Name)
			}
			if len(expected.Provider.Requests) == 0 {
				t.Fatalf("capture for %q records no provider request", scenario.Name)
			}

			ordered, err := decodeOrderedNodeJSON(rawScenario)
			if err != nil {
				t.Fatalf("decode scenario as ordered JSON: %v", err)
			}

			recorder := mockprovider.New(scenario.Mock.Responses)
			address, err := recorder.Listen(0)
			if err != nil {
				t.Fatalf("start mock provider: %v", err)
			}
			t.Cleanup(func() { _ = recorder.Close() })

			if scenario.GoSeam != nil {
				t.Setenv(scenario.GoSeam.EnvironmentVariable, strings.ReplaceAll(scenario.GoSeam.Value, "<mock>", "http://"+address.String()))
			}
			origin, cookie, token := startChatCompletionTestServer(t, scenario)
			rawBody := chatCompletionDriverBody(t, nodeGet(ordered, "request", "body"), address.String())
			status, header, text, aborted, timedOut := driveChatCompletionScenario(t, scenario, origin, cookie, token, rawBody)
			if status != expected.ProviderResponse.Status {
				t.Errorf("response status = %d, capture has %d", status, expected.ProviderResponse.Status)
			}

			expectedRequests := expected.Provider.Requests
			recording := waitForProviderRecordingCount(t, recorder, expectedRequests[0].ClientDisconnected, len(expectedRequests))
			if len(recording.Requests) == 0 {
				t.Fatal("the Go route sent no provider request; an absent capture must never pass")
			}
			// EVERY recorded request is compared and the COUNT is asserted. Comparing Requests[0] alone let
			// a capture that recorded two requests pass on the first one: azure-openai-status-ok records a
			// 0-byte `GET /openai/models` and then a 95-byte `POST /openai/deployments/.../chat/completions`,
			// and the only other consumer skips any route that does not end in /generate -- so a status route
			// that answered without the POST was green, and the captured body behind it was asserted nowhere.
			if len(recording.Requests) != len(expectedRequests) {
				t.Fatalf("provider request count = %d, capture has %d", len(recording.Requests), len(expectedRequests))
			}
			for index, want := range expectedRequests {
				recorded := recording.Requests[index]
				normalized := normalizeRecordedProviderRequest(recorded)
				if normalized.RawTarget != want.RawTarget {
					t.Errorf("provider request %d target = %q, capture has %q", index, normalized.RawTarget, want.RawTarget)
				}
				if normalized.Method != want.Method {
					t.Errorf("provider request %d method = %q, capture has %q", index, normalized.Method, want.Method)
				}
				if normalized.BodyLength != want.BodyLength || normalized.BodySHA256 != want.BodySHA256 {
					t.Errorf("provider request %d body digest = length %d sha %s, capture has length %d sha %s",
						index, normalized.BodyLength, normalized.BodySHA256, want.BodyLength, want.BodySHA256)
				}
				if normalized.Chunked != want.Chunked {
					t.Errorf("provider request %d chunked framing = %t, capture has %t", index, normalized.Chunked, want.Chunked)
				}
				if got, wantHeaders := headerLines(normalized.Headers), headerLines(want.Headers); !reflect.DeepEqual(got, wantHeaders) {
					t.Errorf("provider request %d headers differ from the capture:\n got %v\nwant %v", index, got, wantHeaders)
				}
				if recorded.ClientDisconnected != want.ClientDisconnected {
					t.Errorf("provider request %d clientDisconnected = %t, capture has %t", index, recorded.ClientDisconnected, want.ClientDisconnected)
				}
			}

			// The secret-key assertion: a route that reads secrets with the wrong
			// shape still sends a plausible-looking Authorization header, so the
			// scenario's declared key must actually reach the provider.
			if scenario.ExpectedAuthorizationKey != "" {
				if !expected.AuthorizationKeyVerified {
					t.Fatalf("capture for %q does not record authorizationKeyVerified", scenario.Name)
				}
				observed := ""
				sawKey := false
				for _, request := range recording.Requests {
					for _, entry := range request.Headers {
						if entry.Name == "authorization" {
							observed = entry.Value
							if entry.Value == "Bearer "+scenario.ExpectedAuthorizationKey {
								sawKey = true
							}
						}
					}
				}
				wantKey := "Bearer " + scenario.ExpectedAuthorizationKey
				if !sawKey {
					t.Errorf("provider saw authorization %q, the scenario declares the key must be read through the pinned settings shape (%q)", observed, wantKey)
				}
			}

			// The non-bearer credential: the declared value must have reached the provider, exactly as
			// the bearer key above must have. The capture cannot show it (it is redacted), so this is the
			// only place the value is checked.
			if scenario.ExpectedAPIKey != nil {
				if !expected.APIKeyVerified {
					t.Fatalf("capture for %q does not record apiKeyVerified", scenario.Name)
				}
				observed := ""
				sawKey := false
				for _, request := range recording.Requests {
					for _, entry := range request.Headers {
						if entry.Name == scenario.ExpectedAPIKey.Header {
							observed = entry.Value
							if entry.Value == scenario.ExpectedAPIKey.Value {
								sawKey = true
							}
						}
					}
				}
				if !sawKey {
					t.Errorf("provider saw %s %q, the scenario declares the key must be read through the pinned settings shape (%q)",
						scenario.ExpectedAPIKey.Header, observed, scenario.ExpectedAPIKey.Value)
				}
			}

			assertChatCompletionResponseMatchesCapture(t, scenario, expected, header, text, aborted, timedOut)
		})
	}
}

func mustMarshalNodeJSON(t *testing.T, value orderedNodeJSON) []byte {
	t.Helper()
	encoded, err := marshalOrderedNodeJSON(value)
	if err != nil {
		t.Fatalf("marshal ordered JSON: %v", err)
	}
	return encoded
}

// waitForProviderRecordingCount polls until the recording shows BOTH the disconnect the capture expects and
// the number of requests it recorded. The disconnect matters because cancellation is observed at the provider
// and the mock marks it when it notices the peer went away; the count matters because a route that makes two
// provider calls answers as soon as the first settles, so a shorter recording would be compared against a
// longer capture and the difference would read as a product failure -- the arrival race the doctrine names.
// The deadline is shared, and a short recording is returned as-is so the caller reports a count mismatch
// rather than a bare timeout.
func waitForProviderRecordingCount(t *testing.T, recorder *mockprovider.Recorder, wantDisconnected bool, wantCount int) mockprovider.Recording {
	t.Helper()
	if wantCount < 1 {
		wantCount = 1
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		recording := recorder.Recording()
		if len(recording.Requests) >= wantCount && recording.Requests[0].ClientDisconnected == wantDisconnected {
			return recording
		}
		if time.Now().After(deadline) {
			return recording
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// startChatCompletionTestServer builds the pinned data root the scenario needs
// and returns a live server plus an authenticated session.
func startChatCompletionTestServer(t *testing.T, scenario providerWireScenario) (string, string, string) {
	t.Helper()
	// ONE root, with the data directory beneath it, because that is the layout the probe creates
	// (`--dataRoot <runtimeRoot>/data` with `<runtimeRoot>/config.yaml`) and the layout a real install has.
	// Two independent t.TempDir() calls would put the data root somewhere with no config file above it, so
	// a config-driven scenario could not be replayed faithfully even if the file were written.
	root := t.TempDir()
	dataRoot := filepath.Join(root, "data")
	installRoot := root
	if err := os.MkdirAll(dataRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if len(scenario.BackendConfig) > 0 {
		config := strings.Join(scenario.BackendConfig, "\n") + "\n"
		if err := os.WriteFile(filepath.Join(root, "config.yaml"), []byte(config), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	accountJSON, err := marshalNodeJSON(struct {
		Handle   string         `json:"handle"`
		Name     string         `json:"name"`
		Created  int64          `json:"created"`
		Password string         `json:"password"`
		Admin    bool           `json:"admin"`
		Enabled  bool           `json:"enabled"`
		Salt     string         `json:"salt"`
		Unknown  map[string]any `json:"probeUnknownField"`
	}{"default-user", "Provider Wire", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
	if err != nil {
		t.Fatal(err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+"default-user", accountJSON); err != nil {
		t.Fatal(err)
	}
	const cookieSecret = "gotavern-go-provider-wire-cookie-secret"
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(cookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	if len(scenario.Secrets) > 0 {
		directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(scenario.Secrets)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directories["root"], "secrets.json"), encoded, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: cookieSecret, AccountsEnabled: true,
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	client := &http.Client{Timeout: 30 * time.Second}
	csrfResponse, err := client.Get(server.URL + "/csrf-token")
	if err != nil {
		t.Fatalf("GET /csrf-token: %v", err)
	}
	csrfBody, _ := io.ReadAll(csrfResponse.Body)
	csrfResponse.Body.Close()
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfBody, &csrf); err != nil {
		t.Fatalf("decode csrf token: %v", err)
	}
	csrfCookie := cookiePair(csrfResponse.Cookies())

	loginRequest, _ := http.NewRequest(http.MethodPost, server.URL+"/api/users/login", strings.NewReader(`{"handle":"default-user","password":""}`))
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Header.Set("X-CSRF-Token", csrf.Token)
	loginRequest.Header.Set("Cookie", csrfCookie)
	loginResponse, err := client.Do(loginRequest)
	if err != nil {
		t.Fatalf("POST /api/users/login: %v", err)
	}
	io.Copy(io.Discard, loginResponse.Body)
	loginResponse.Body.Close()
	if loginResponse.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d", loginResponse.StatusCode)
	}
	return server.URL, cookiePair(loginResponse.Cookies()), csrf.Token
}

func cookiePair(cookies []*http.Cookie) string {
	parts := make([]string, 0, len(cookies))
	for _, cookie := range cookies {
		parts = append(parts, cookie.Name+"="+cookie.Value)
	}
	return strings.Join(parts, "; ")
}

// chatCompletionDriverBody mirrors the probe's driver: only top-level string
// members have the <mock> placeholder replaced, and the body is serialized with
// JavaScript member order.
func chatCompletionDriverBody(t *testing.T, body orderedNodeJSON, mockAddress string) string {
	t.Helper()
	substituted := nodeObject()
	for _, entry := range body.object {
		if text, isString := entry.value.stringValue(); isString {
			substituted.setMember(entry.key, nodeString(strings.ReplaceAll(text, "<mock>", "http://"+mockAddress)))
			continue
		}
		substituted.setMember(entry.key, entry.value)
	}
	return string(mustMarshalNodeJSON(t, substituted))
}

func driveChatCompletionScenario(t *testing.T, scenario providerWireScenario, origin, cookie, token, rawBody string) (int, http.Header, string, bool, bool) {
	t.Helper()
	client := &http.Client{}
	request, err := http.NewRequest(http.MethodPost, origin+scenario.Request.Path, strings.NewReader(rawBody))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-CSRF-Token", token)
	request.Header.Set("Cookie", cookie)

	if scenario.AbortAfterFirstEvent {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		response, err := client.Do(request.WithContext(ctx))
		if err != nil {
			t.Fatalf("drive aborted request: %v", err)
		}
		defer response.Body.Close()
		text, aborted := readUntilFirstEvent(t, response.Body, cancel)
		return response.StatusCode, response.Header, text, aborted, false
	}

	if scenario.DriverTimeoutMs > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(scenario.DriverTimeoutMs)*time.Millisecond)
		defer cancel()
		response, err := client.Do(request.WithContext(ctx))
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return 0, http.Header{}, "", false, true
			}
			t.Fatalf("drive timed request: %v", err)
		}
		defer response.Body.Close()
		text, timedOut := readUntilTimeout(t, response.Body)
		return response.StatusCode, response.Header, text, false, timedOut
	}

	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("drive request: %v", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	return response.StatusCode, response.Header, string(body), false, false
}

func readUntilFirstEvent(t *testing.T, body io.Reader, cancel context.CancelFunc) (string, bool) {
	t.Helper()
	buffer := make([]byte, 0, 1024)
	chunk := make([]byte, 512)
	for {
		count, err := body.Read(chunk)
		buffer = append(buffer, chunk[:count]...)
		if strings.Contains(string(buffer), "\n\n") {
			cancel()
			return string(buffer), true
		}
		if err != nil {
			return string(buffer), false
		}
	}
}

func readUntilTimeout(t *testing.T, body io.Reader) (string, bool) {
	t.Helper()
	buffer := make([]byte, 0, 1024)
	chunk := make([]byte, 512)
	for {
		count, err := body.Read(chunk)
		buffer = append(buffer, chunk[:count]...)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "deadline exceeded") {
				return string(buffer), true
			}
			return string(buffer), false
		}
	}
}

// normalizeRecordedProviderRequest reverses the two tier-2 normalizations the
// capture declares for the provider request, so the Go recording can be
// compared with the captured one.
func normalizeRecordedProviderRequest(recorded mockprovider.Request) providerWireProviderRequest {
	headers := make([]providerWireHeader, 0, len(recorded.Headers))
	for _, header := range recorded.Headers {
		value := header.Value
		switch {
		case header.Name == "Host":
			value = "<mock-authority>"
		case header.Name == "authorization" && strings.HasPrefix(strings.ToLower(value), "bearer "):
			value = "Bearer <redacted>"
		case header.Name == "x-api-key":
			// The CLAUDE source authenticates with this header instead of Authorization, and the
			// capture records it redacted (the probe's tier-2 rule). The VALUE is still asserted
			// through the scenario's expectedApiKey, so redacting it here loses nothing.
			value = "<redacted>"
		}
		headers = append(headers, providerWireHeader{Name: header.Name, Value: value})
	}
	return providerWireProviderRequest{
		Method:     recorded.Method,
		RawTarget:  recorded.RawTarget,
		RawPath:    recorded.RawPath,
		RawQuery:   recorded.RawQuery,
		Proto:      recorded.Proto,
		Headers:    headers,
		BodyLength: recorded.BodyLength,
		BodySHA256: recorded.BodySHA256,
		Chunked:    recorded.Chunked,
	}
}

func headerLines(headers []providerWireHeader) []string {
	lines := make([]string, 0, len(headers))
	for _, header := range headers {
		lines = append(lines, header.Name+": "+header.Value)
	}
	return lines
}

func assertChatCompletionResponseMatchesCapture(t *testing.T, scenario providerWireScenario, expected providerWireCaptureScenario, header http.Header, text string, aborted, timedOut bool) {
	t.Helper()
	if aborted != expected.ProviderResponse.AbortedByDriver {
		t.Errorf("driver aborted = %t, capture has %t", aborted, expected.ProviderResponse.AbortedByDriver)
	}
	if timedOut != expected.ProviderResponse.DriverTimedOut {
		t.Errorf("driver timed out = %t, capture has %t", timedOut, expected.ProviderResponse.DriverTimedOut)
	}
	contentType := header.Get("Content-Type")
	if expected.ProviderResponse.ContentType == nil {
		if contentType != "" {
			t.Errorf("response content type = %q, the capture records none", contentType)
		}
	} else if contentType != *expected.ProviderResponse.ContentType {
		t.Errorf("response content type = %q, capture has %q", contentType, *expected.ProviderResponse.ContentType)
	}
	for name, want := range expected.ProviderResponse.Headers {
		if got := header.Get(name); got != want {
			t.Errorf("response header %s = %q, capture has %q", name, got, want)
		}
	}
	if expected.ProviderResponse.Body != nil {
		var want any
		if err := json.Unmarshal(expected.ProviderResponse.Body, &want); err != nil {
			t.Fatalf("decode captured response body: %v", err)
		}
		var got any
		if err := json.Unmarshal([]byte(text), &got); err != nil {
			t.Fatalf("decode Go response body %q: %v", text, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("response body = %v, capture has %v", got, want)
		}
	}
	if expected.ProviderResponse.Events != nil {
		if got := parsePinnedSSE(text); !reflect.DeepEqual(got, expected.ProviderResponse.Events) {
			t.Errorf("parsed SSE events = %v, capture has %v", got, expected.ProviderResponse.Events)
		}
	}
}

// parsePinnedSSE mirrors the harness parser: event names and data payloads are
// kept verbatim so an encoding or formatting difference cannot round-trip away.
func parsePinnedSSE(text string) []providerWireSSEEvent {
	events := make([]providerWireSSEEvent, 0)
	var currentEvent *string
	data := make([]string, 0)
	flush := func() {
		if len(data) > 0 || currentEvent != nil {
			events = append(events, providerWireSSEEvent{Event: currentEvent, Data: strings.Join(data, "\n")})
		}
		currentEvent = nil
		data = data[:0]
	}
	for _, rawLine := range strings.Split(text, "\n") {
		line := strings.TrimSuffix(rawLine, "\r")
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "event:") {
			value := strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			currentEvent = &value
		} else if strings.HasPrefix(line, "data:") {
			value := strings.TrimPrefix(line, "data:")
			value = strings.TrimPrefix(value, " ")
			data = append(data, value)
		}
	}
	flush()
	return events
}
