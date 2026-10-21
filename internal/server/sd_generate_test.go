package server

// Route-level replay of tests/oracle/sillytavern-1.19.0-sd-generate.json, recorded by
// tools/probe-sd-generate.mjs against the real pinned server.
//
// The image payload is compared through the response projection (base64 bytes) and the peer's answer is
// the synthetic image the fixture recorded. The random seed is normalized on BOTH sides (the fixture
// masks it, the implementation generates it), and the header assertion is bidirectional for the contract
// headers so an implementation cannot add an Authorization the pinned call does not send.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// parseSeenMultipart parses the multipart body a Go handler actually SENT. It exists so the replay
// compares parts rather than raw bytes, and so a zero-part read (a consumed stream) is visible.
func parseSeenMultipart(t *testing.T, label string, index int, contentType, body string) []sdOutboundPart {
	t.Helper()
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil || !strings.HasPrefix(mediaType, "multipart/") {
		t.Fatalf("%s: request %d content type = %q, want multipart", label, index, contentType)
	}
	reader := multipart.NewReader(strings.NewReader(body), params["boundary"])
	parts := make([]sdOutboundPart, 0, 4)
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("%s: request %d multipart parse: %v", label, index, err)
		}
		data, _ := io.ReadAll(part)
		parts = append(parts, sdOutboundPart{Name: part.FormName(), Value: string(data)})
	}
	return parts
}

// TestSDA1111InterruptOnClientClose is a LABELLED IMPLEMENTATION TEST, not a pinned observation.
//
// The pinned `/api/sd/generate` registers a socket-close handler that POSTs `{url}/sdapi/v1/interrupt`
// and aborts the generation. The probe peer cannot observe that: its scripted rules answer
// immediately, so there is never an in-flight generation whose caller can go away. The pinned
// scenario was therefore NOT recordable, and this test asserts the Go behaviour only — a cancelled
// caller context produces the interrupt POST — without claiming pinned parity.
func TestSDA1111InterruptOnClientClose(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	interrupted := make(chan struct{}, 1)
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path)
		mu.Unlock()
		if r.URL.Path == "/sdapi/v1/interrupt" {
			select {
			case interrupted <- struct{}{}:
			default:
			}
			w.WriteHeader(http.StatusOK)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"images":[]}`))
	}))
	defer peer.Close()

	dataRoot := t.TempDir()
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	body := fmt.Sprintf(`{"url":%q,"prompt":"a tree"}`, peer.URL)
	request := httptest.NewRequest(http.MethodPost, "/api/sd/generate", strings.NewReader(body)).WithContext(ctx)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	select {
	case <-interrupted:
	case <-time.After(5 * time.Second):
		mu.Lock()
		defer mu.Unlock()
		t.Fatalf("a cancelled caller did not produce POST {url}/sdapi/v1/interrupt; the peer saw %v", seen)
	}
}

type sdGenerateRule struct {
	Run        string            `json:"run"`
	Match      string            `json:"match"`
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
	BinaryBody bool              `json:"binaryBody"`
	Throws     bool              `json:"throws"`
	// Times is a TIMED rule: it answers at most this many times, so a poll loop's request COUNT is
	// fixture data. The probe hook uses the same field.
	Times int `json:"times"`
}

type sdGenerateScenario struct {
	Route       string                      `json:"route"`
	RequestBody string                      `json:"requestBody"`
	Mocks       []sdGenerateRule            `json:"mocks"`
	Secrets     map[string][]map[string]any `json:"secrets"`
	Response    struct {
		Status   int               `json:"status"`
		Headers  map[string]string `json:"headers"`
		Body     json.RawMessage   `json:"body"`
		BodyText string            `json:"bodyText"`
	} `json:"response"`
	Outbound []struct {
		URL     string            `json:"url"`
		Method  string            `json:"method"`
		Headers map[string]string `json:"headers"`
		Body    *string           `json:"body"`
		Parts   []sdOutboundPart  `json:"parts"`
	} `json:"outbound"`
}

// sdOutboundPart is one parsed multipart field of a recorded outbound request. The boundary is random
// per request, so the fixture records the parts and never the raw body.
type sdOutboundPart struct {
	Name        string `json:"name"`
	Value       string `json:"value"`
	Filename    string `json:"filename"`
	ContentType string `json:"contentType"`
	Bytes       int    `json:"bytes"`
	Sha256      string `json:"sha256"`
}

type sdGenerateFixture struct {
	ImplementedRoutes []string                      `json:"implementedRoutes"`
	Scenarios         map[string]sdGenerateScenario `json:"scenarios"`
}

func loadSDGenerateOracle(t *testing.T) sdGenerateFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-sd-generate.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture sdGenerateFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) == 0 {
		t.Fatal("the sd-generate oracle records no scenarios")
	}
	return fixture
}

type sdSeenRequest struct {
	Method string
	Path   string
	Header http.Header
	Body   string
}

type sdGeneratePeer struct {
	server *httptest.Server
	mu     sync.Mutex
	seen   []sdSeenRequest
}

// newSDGeneratePeer replays the scenario's rule list. A provider response that carries a fetchable URL in
// `data[0].url` gets a SECOND rule pointed at this listener, because that request leaves the provider seam
// and must still land on the controlled peer (AGENTS.md rule 14).
func newSDGeneratePeer(t *testing.T, scenario sdGenerateScenario) *sdGeneratePeer {
	t.Helper()
	peer := &sdGeneratePeer{}
	var rules []sdGenerateRule
	// usage counts TIMED rules, so a poll loop sees exactly the recorded number of empty answers
	// before the terminal one; the count is the assertion.
	usage := map[int]int{}
	peer.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := readAllString(r)
		peer.mu.Lock()
		peer.seen = append(peer.seen, sdSeenRequest{Method: r.Method, Path: r.URL.RequestURI(), Header: r.Header.Clone(), Body: body})
		peer.mu.Unlock()
		var chosen *sdGenerateRule
		for index := range rules {
			if rules[index].Times > 0 && usage[index] >= rules[index].Times {
				continue
			}
			// Match on the DECODED target as well: a pinned rule for a raw-space path (the workersai
			// model is interpolated RAW) is recorded with a literal space, while the wire target is
			// percent-encoded.
			decodedTarget, _ := url.PathUnescape(r.URL.RequestURI())
			if strings.Contains(r.URL.RequestURI(), rules[index].Match) || strings.Contains(decodedTarget, rules[index].Match) {
				chosen = &rules[index]
				if rules[index].Times > 0 {
					usage[index]++
				}
				break
			}
		}
		if chosen == nil {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"message":"gotavern test: unstubbed outbound request"}`))
			return
		}
		if chosen.Throws {
			// A rejected fetch is a transport error, which is what an aborted connection produces.
			panic(http.ErrAbortHandler)
		}
		for name, value := range chosen.Headers {
			w.Header().Set(name, value)
		}
		status := chosen.Status
		if status == 0 {
			status = 200
		}
		w.WriteHeader(status)
		if chosen.BinaryBody {
			if decoded, err := base64.StdEncoding.DecodeString(chosen.Body); err == nil {
				_, _ = w.Write(decoded)
				return
			}
		}
		_, _ = w.Write([]byte(chosen.Body))
	}))
	t.Cleanup(peer.server.Close)
	rules = append([]sdGenerateRule{}, scenario.Mocks...)
	// The listener address is known now, so repoint any provider-response URL at it and add its rule.
	fetchedBody := ""
	for index := range rules {
		var payload map[string]any
		if json.Unmarshal([]byte(rules[index].Body), &payload) != nil {
			continue
		}
		data, ok := payload["data"].([]any)
		if !ok || len(data) == 0 {
			continue
		}
		entry, ok := data[0].(map[string]any)
		if !ok {
			continue
		}
		if _, present := entry["url"]; !present {
			continue
		}
		entry["url"] = peer.server.URL + "/fetched-image.png"
		if encoded, err := json.Marshal(payload); err == nil {
			rules[index].Body = string(encoded)
		}
		// The bytes the pinned route received are the base64 in the recorded answer.
		var answer map[string]any
		if json.Unmarshal([]byte(scenario.Response.BodyText), &answer) == nil {
			if text, isString := answer["data"].(string); isString {
				fetchedBody = text
			}
		}
		break
	}
	if fetchedBody != "" {
		rules = append(rules, sdGenerateRule{
			Match:      "/fetched-image.png",
			Headers:    map[string]string{"content-type": "image/png"},
			Body:       fetchedBody,
			BinaryBody: true,
		})
	}
	return peer
}

// sdSeamPath trims the pinned provider base from a recorded URL and normalizes the remainder through the
// URL parser, so the comparison is the WIRE form: the pinned code can interpolate a raw space into a path
// (huggingface does exactly that) and the transport escapes it, so the raw string and the wire target are
// not the same text. A URL that came from a provider response is not under a seam and its host is not
// reproducible, so the observation is that the second GET happened at the rewritten path.
func sdSeamPath(recorded string) string {
	for _, base := range []string{
		sdPollinationsDefaultURL, sdTogetherDefaultURL,
		sdHuggingFaceDefaultURL, sdElectronHubDefaultURL, sdChutesImageDefaultURL,
		sdNanoGPTGenerateDefaultURL, sdXaiDefaultURL, sdAimlapiDefaultURL,
		sdStabilityDefaultURL, sdWorkersAIDefaultURL,
	} {
		if !strings.HasPrefix(recorded, base) {
			continue
		}
		remainder := strings.TrimPrefix(recorded, base)
		parsed, err := url.Parse(remainder)
		if err != nil {
			return remainder
		}
		target := parsed.EscapedPath()
		if parsed.RawQuery != "" {
			target += "?" + parsed.RawQuery
		}
		return target
	}
	if strings.Contains(recorded, "://") {
		return "/fetched-image.png"
	}
	return recorded
}

var sdUrlSeedPattern = regexp.MustCompile(`seed=\d+`)
var sdJsonSeedPattern = regexp.MustCompile(`"seed":\d+`)

func normalizeSdSeed(value string) string {
	// The fixture masks a JSON seed as the STRING "<seed>" and a URL seed as the bare marker, so both
	// sides are normalized to exactly those forms.
	value = sdJsonSeedPattern.ReplaceAllString(value, `"seed":"<seed>"`)
	return sdUrlSeedPattern.ReplaceAllString(value, "seed=<seed>")
}

func peerSummary(seen []sdSeenRequest) []string {
	result := make([]string, 0, len(seen))
	for _, entry := range seen {
		result = append(result, entry.Method+" "+entry.Path)
	}
	return result
}

// TestSDGenerateWave2SeamDefaults pins each wave-2 seam default to the pinned base. A seam whose default
// drifts silently changes production while the tests keep passing against the override.
func TestSDGenerateWave2SeamDefaults(t *testing.T) {
	for _, seam := range []struct {
		environment string
		accessor    func() string
		pinned      string
	}{
		{"GOTAVERN_SD_HUGGINGFACE_URL", sdHuggingFaceURL, sdHuggingFaceDefaultURL},
		{"GOTAVERN_SD_XAI_URL", sdXaiURL, sdXaiDefaultURL},
		{"GOTAVERN_SD_CHUTES_IMAGE_URL", sdChutesImageURL, sdChutesImageDefaultURL},
		{"GOTAVERN_SD_NANOGPT_GENERATE_URL", sdNanoGPTGenerateURL, sdNanoGPTGenerateDefaultURL},
		{"GOTAVERN_SD_ELECTRONHUB_URL", sdElectronHubURL, sdElectronHubDefaultURL},
		{"GOTAVERN_SD_AIMLAPI_URL", sdAimlapiURL, sdAimlapiDefaultURL},
	} {
		t.Setenv(seam.environment, "")
		if got := seam.accessor(); got != seam.pinned {
			t.Fatalf("%s seam default = %q, pinned %q", seam.environment, got, seam.pinned)
		}
	}
}
func TestSDGenerateRoutesMatchPinnedOracle(t *testing.T) {
	fixture := loadSDGenerateOracle(t)
	if len(fixture.Scenarios) < 10 {
		t.Fatalf("the fixture records only %d scenarios", len(fixture.Scenarios))
	}
	t.Setenv("GOTAVERN_SD_POLLINATIONS_URL", "")
	t.Setenv("GOTAVERN_SD_TOGETHER_URL", "")
	t.Setenv("GOTAVERN_SD_STABILITY_URL", "")
	t.Setenv("GOTAVERN_SD_WORKERSAI_URL", "")
	statuses := map[int]int{}
	sawFallbackFetch := 0
	for label, scenario := range fixture.Scenarios {
		label, scenario := label, scenario
		t.Run(label, func(t *testing.T) {
			dataRoot := t.TempDir()
			userRoot := filepath.Join(dataRoot, "default-user")
			if err := os.MkdirAll(filepath.Join(userRoot, "backups"), 0o755); err != nil {
				t.Fatal(err)
			}
			if scenario.Secrets != nil {
				payload, err := json.Marshal(scenario.Secrets)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(userRoot, "secrets.json"), payload, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			peer := newSDGeneratePeer(t, scenario)
			t.Setenv("GOTAVERN_SD_POLLINATIONS_URL", peer.server.URL)
			t.Setenv("GOTAVERN_SD_TOGETHER_URL", peer.server.URL)
			t.Setenv("GOTAVERN_SD_HUGGINGFACE_URL", peer.server.URL)
			t.Setenv("GOTAVERN_SD_XAI_URL", peer.server.URL)
			t.Setenv("GOTAVERN_SD_CHUTES_IMAGE_URL", peer.server.URL)
			t.Setenv("GOTAVERN_SD_NANOGPT_GENERATE_URL", peer.server.URL)
			t.Setenv("GOTAVERN_SD_ELECTRONHUB_URL", peer.server.URL)
			t.Setenv("GOTAVERN_SD_AIMLAPI_URL", peer.server.URL)
			t.Setenv("GOTAVERN_SD_STABILITY_URL", peer.server.URL)
			t.Setenv("GOTAVERN_SD_WORKERSAI_URL", peer.server.URL)
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			// A body-supplied URL is recorded as `<mock>` so the fixture is host- and port-independent;
			// the replay points it at this test's own peer listener.
			requestBody := strings.ReplaceAll(scenario.RequestBody, "<mock>", peer.server.URL)
			response := postSecretsRoute(t, handler, scenario.Route, requestBody)
			statuses[response.Code]++
			if response.Code != scenario.Response.Status {
				t.Fatalf("%s: status = %d, want %d (body %q; peer saw %v)", label, response.Code, scenario.Response.Status, response.Body.String(), peerSummary(peer.seen))
			}
			assertPinnedHeaders(t, response.Header(), scenario.Response.Headers)
			if got := normalizeSdSeed(response.Body.String()); got != normalizeSdSeed(scenario.Response.BodyText) {
				t.Fatalf("%s: body = %q, pinned %q", label, got, scenario.Response.BodyText)
			}
			if len(scenario.Outbound) == 0 {
				if len(peer.seen) != 0 {
					t.Fatalf("%s: Go reached the peer, the pinned handler did not", label)
				}
				return
			}
			if len(peer.seen) != len(scenario.Outbound) {
				t.Fatalf("%s: peer received %d requests, pinned %d", label, len(peer.seen), len(scenario.Outbound))
			}
			for index, recorded := range scenario.Outbound {
				seen := peer.seen[index]
				if seen.Method != recorded.Method {
					t.Fatalf("%s: request %d method = %s, pinned %s", label, index, seen.Method, recorded.Method)
				}
				// A body-supplied URL (`request.body.url`) is recorded as `<mock>`: the caller names
				// the server, so there is no provider seam and the comparison is the path the Go
				// handler requested on this test's own listener.
				want := ""
				if strings.HasPrefix(recorded.URL, "<mock>") {
					if parsed, err := url.Parse(strings.TrimPrefix(recorded.URL, "<mock>")); err == nil {
						want = parsed.EscapedPath()
						if parsed.RawQuery != "" {
							want += "?" + parsed.RawQuery
						}
					} else {
						want = strings.TrimPrefix(recorded.URL, "<mock>")
					}
				} else {
					want = sdSeamPath(strings.ReplaceAll(recorded.URL, "<mock>", peer.server.URL))
				}
				if normalizeSdSeed(want) != normalizeSdSeed(seen.Path) {
					t.Fatalf("%s: request %d target = %q, pinned %q", label, index, seen.Path, want)
				}
				for name, value := range recorded.Headers {
					if got := seen.Header.Get(name); got != value {
						t.Fatalf("%s: request %d header %q = %q, pinned %q", label, index, name, got, value)
					}
				}
				// A header the pinned call does NOT send must not appear either. The one exception is
				// `content-type` on a NATIVE FormData request: the boundary is generated by the HTTP
				// client, so the pinned hook cannot record it (fetch sets it internally) and the parts
				// are the assertion instead.
				for _, name := range []string{"authorization", "content-type", "x-api-key", "accept", "http-referer", "x-title"} {
					if name == "content-type" && len(recorded.Parts) > 0 {
						continue
					}
					present := len(seen.Header[http.CanonicalHeaderKey(name)]) > 0
					recordedPresent := recorded.Headers[name] != ""
					if present && !recordedPresent {
						t.Fatalf("%s: request %d sent header %q the pinned call does not send", label, index, name)
					}
				}
				if len(recorded.Parts) > 0 {
					// A native FormData body is compared as a PART LIST, never as raw bytes (the
					// boundary is random). The list must be NON-EMPTY: a peer that reads the body and
					// then calls MultipartReader() sees a consumed stream and silently records zero
					// parts, which looks exactly like "never sent" - so this refuses that shape.
					seenParts := parseSeenMultipart(t, label, index, seen.Header.Get("Content-Type"), seen.Body)
					if len(seenParts) == 0 {
						t.Fatalf("%s: request %d sent a multipart content type but the peer parsed ZERO parts", label, index)
					}
					if len(seenParts) != len(recorded.Parts) {
						t.Fatalf("%s: request %d sent %d parts, pinned %d (%v)", label, index, len(seenParts), len(recorded.Parts), seenParts)
					}
					for partIndex, want := range recorded.Parts {
						got := seenParts[partIndex]
						if got.Name != want.Name || got.Value != want.Value {
							t.Fatalf("%s: request %d part %d = %s=%q, pinned %s=%q", label, index, partIndex, got.Name, got.Value, want.Name, want.Value)
						}
					}
					continue
				}
				wantBody := ""
				if recorded.Body != nil {
					wantBody = strings.ReplaceAll(normalizeSdSeed(*recorded.Body), "<mock>", peer.server.URL)
				}
				if got := normalizeSdSeed(seen.Body); got != wantBody {
					t.Fatalf("%s: request %d body = %q, pinned %q", label, index, got, wantBody)
				}
				if index == 1 {
					sawFallbackFetch++
				}
			}
		})
	}
	if statuses[200] == 0 || statuses[400] == 0 || statuses[500] == 0 {
		t.Fatalf("the fixture does not cover the 200/400/500 branches: %+v", statuses)
	}
	if sawFallbackFetch == 0 {
		t.Fatal("no scenario exercises the URL fallback fetch")
	}
}
