package server

// Route-level replay of tests/oracle/sillytavern-1.19.0-speech.json, recorded by
// tools/probe-speech.mjs against the real pinned server.
//
// The Go side replays the SAME controlled peer through a real local listener (so the real outbound
// path is exercised) and produces the failure path through a CLOSED PORT. Compared per scenario: the
// status, every response header, the response BYTES (a digest for audio, the exact text for JSON), and
// the outbound method, URL, declared headers and body. A multipart body is compared as PARSED PARTS
// because the boundary is random per request; a JSON body is compared as bytes with the per-request
// Pollinations seed normalized.
//
// NOT compared, deliberately: `uploadsAfter`/`uploadsCreated`. The pinned upload arrives through the
// global `multer().single('avatar')` middleware, which writes a temp file in `_uploads`; GoTavern
// parses the upload in memory and leaves none. That is a named difference in the compat row, so the
// fixture records it for the reader and this test does not pretend to compare it.

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
)

type speechPart struct {
	Name        *string `json:"name"`
	Filename    *string `json:"filename"`
	ContentType *string `json:"contentType"`
	SHA256      string  `json:"sha256"`
	Bytes       int     `json:"bytes"`
}

type speechOutbound struct {
	URL             string            `json:"url"`
	Method          string            `json:"method"`
	Headers         map[string]string `json:"headers"`
	Body            *string           `json:"body"`
	Parts           []speechPart      `json:"parts"`
	BodyBase64Bytes int               `json:"bodyBase64Bytes"`
}

type speechScenario struct {
	Route         string `json:"route"`
	RequestBody   string `json:"requestBody"`
	RequestUpload *struct {
		Field       string `json:"field"`
		Filename    string `json:"filename"`
		ContentType string `json:"contentType"`
		Base64      string `json:"base64"`
	} `json:"requestUpload"`
	Mocks []struct {
		Match      string            `json:"match"`
		Status     int               `json:"status"`
		StatusText string            `json:"statusText"`
		Headers    map[string]string `json:"headers"`
		Body       string            `json:"body"`
		BinaryBody bool              `json:"binaryBody"`
		Throws     bool              `json:"throws"`
	} `json:"mocks"`
	Secrets  map[string][]map[string]any `json:"secrets"`
	Response struct {
		Status   int               `json:"status"`
		Headers  map[string]string `json:"headers"`
		Body     json.RawMessage   `json:"body"`
		BodyText *string           `json:"bodyText"`
		SHA256   string            `json:"sha256"`
		Bytes    int               `json:"bytes"`
	} `json:"response"`
	Outbound       []speechOutbound `json:"outbound"`
	UploadsCreated int              `json:"uploadsCreated"`
	UploadsAfter   []speechPart     `json:"uploadsAfter"`
	NotImplemented bool             `json:"notImplemented"`
}

type speechFixture struct {
	Inputs struct {
		Pollinations string `json:"pollinations"`
		ElevenLabs   string `json:"elevenlabs"`
		AudioSHA256  string `json:"audioSha256"`
		WavSHA256    string `json:"wavSha256"`
	} `json:"inputs"`
	NotImplementedRoutes []struct {
		Route  string `json:"route"`
		Reason string `json:"reason"`
	} `json:"notImplementedRoutes"`
	Scenarios map[string]speechScenario `json:"scenarios"`
}

func loadSpeechOracle(t *testing.T) speechFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-speech.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture speechFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) == 0 {
		t.Fatal("the speech oracle records no scenarios")
	}
	return fixture
}

func TestSpeechSeamDefaults(t *testing.T) {
	fixture := loadSpeechOracle(t)
	t.Setenv("GOTAVERN_POLLINATIONS_API_URL", "")
	if got := pollinationsAPIURL(); got != fixture.Inputs.Pollinations {
		t.Fatalf("Pollinations seam default = %q, pinned %q", got, fixture.Inputs.Pollinations)
	}
	t.Setenv("GOTAVERN_ELEVENLABS_API_URL", "")
	if got := elevenLabsAPIURL(); got != fixture.Inputs.ElevenLabs {
		t.Fatalf("ElevenLabs seam default = %q, pinned %q", got, fixture.Inputs.ElevenLabs)
	}
}

// speechPeer is a controlled peer that records what Go sent.
type speechPeer struct {
	server *httptest.Server
	mu     sync.Mutex
	seen   []struct {
		Method      string
		Path        string
		Header      http.Header
		Body        []byte
		ContentType string
	}
}

func newSpeechPeer(t *testing.T, mock struct {
	Match      string            `json:"match"`
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
	BinaryBody bool              `json:"binaryBody"`
	Throws     bool              `json:"throws"`
}) *speechPeer {
	t.Helper()
	peer := &speechPeer{}
	peer.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		peer.mu.Lock()
		peer.seen = append(peer.seen, struct {
			Method      string
			Path        string
			Header      http.Header
			Body        []byte
			ContentType string
		}{Method: r.Method, Path: r.URL.RequestURI(), Header: r.Header.Clone(), Body: body, ContentType: r.Header.Get("Content-Type")})
		peer.mu.Unlock()
		for name, value := range mock.Headers {
			w.Header().Set(name, value)
		}
		status := mock.Status
		if status == 0 {
			status = 200
		}
		w.WriteHeader(status)
		if mock.BinaryBody {
			decoded, err := base64.StdEncoding.DecodeString(mock.Body)
			if err != nil {
				return
			}
			_, _ = w.Write(decoded)
			return
		}
		_, _ = w.Write([]byte(mock.Body))
	}))
	t.Cleanup(peer.server.Close)
	return peer
}

var speechSeedPattern = regexp.MustCompile(`"seed":\d+`)

// speechBoundaryPattern matches a multipart boundary in a content type, which is random per request.
var speechBoundaryPattern = regexp.MustCompile(`(?i)boundary="?[^";]+"?`)

func normalizeSpeechSeed(text string) string {
	return speechSeedPattern.ReplaceAllString(text, `"seed":"<seed>"`)
}

func TestSpeechRoutesMatchPinnedOracle(t *testing.T) {
	fixture := loadSpeechOracle(t)
	if len(fixture.Scenarios) < 35 {
		t.Fatalf("the fixture records only %d scenarios; the domain pinning is incomplete", len(fixture.Scenarios))
	}
	if len(fixture.NotImplementedRoutes) != 2 {
		t.Fatalf("the fixture records %d not-implemented routes, want 2", len(fixture.NotImplementedRoutes))
	}
	counts := map[int]int{}
	binaryResponses, multipartOut, multipartIn, throwsCases := 0, 0, 0, 0
	for label, scenario := range fixture.Scenarios {
		label, scenario := label, scenario
		t.Run(label, func(t *testing.T) {
			seam := "GOTAVERN_ELEVENLABS_API_URL"
			if strings.Contains(scenario.Route, "/pollinations/") {
				seam = "GOTAVERN_POLLINATIONS_API_URL"
			}
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
			if len(scenario.Mocks) != 1 {
				t.Fatalf("%s: expected one controlled peer rule, found %d", label, len(scenario.Mocks))
			}
			mock := scenario.Mocks[0]
			var peer *speechPeer
			if mock.Throws {
				t.Setenv(seam, hordeClosedPort)
				throwsCases++
			} else {
				peer = newSpeechPeer(t, mock)
				t.Setenv(seam, peer.server.URL)
			}
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			response := postSpeechScenario(t, handler, scenario)
			counts[response.Code]++
			if scenario.RequestUpload != nil {
				multipartIn++
			}
			if response.Code != scenario.Response.Status {
				t.Fatalf("%s: status = %d, want %d (body %q)", label, response.Code, scenario.Response.Status, response.Body.String())
			}
			assertPinnedHeaders(t, response.Header(), scenario.Response.Headers)
			if scenario.Response.SHA256 != "" {
				digest := fmt.Sprintf("%x", sha256.Sum256(response.Body.Bytes()))
				if digest != scenario.Response.SHA256 {
					t.Fatalf("%s: response digest = %s, want %s (the body bytes differ)", label, digest, scenario.Response.SHA256)
				}
				if response.Body.Len() != scenario.Response.Bytes {
					t.Fatalf("%s: response length = %d, want %d", label, response.Body.Len(), scenario.Response.Bytes)
				}
				binaryResponses++
			} else {
				want := ""
				if scenario.Response.BodyText != nil {
					want = *scenario.Response.BodyText
				}
				if got := response.Body.String(); got != want {
					t.Fatalf("%s: body = %q, pinned %q", label, got, want)
				}
			}
			if mock.Throws {
				if len(scenario.Outbound) == 0 {
					t.Fatalf("%s: the pinned oracle records no outbound request, so the 500 cannot be attributed", label)
				}
				return
			}
			if len(scenario.Outbound) == 0 {
				if len(peer.seen) != 0 {
					t.Fatalf("%s: Go reached the peer, but the pinned handler never did", label)
				}
				return
			}
			if len(peer.seen) != 1 {
				t.Fatalf("%s: peer received %d requests, pinned recorded 1", label, len(peer.seen))
			}
			recorded := scenario.Outbound[len(scenario.Outbound)-1]
			seen := peer.seen[0]
			if seen.Method != recorded.Method {
				t.Fatalf("%s: method = %s, pinned %s", label, seen.Method, recorded.Method)
			}
			if wantPath := requestURIPath(t, recorded.URL); seen.Path != wantPath {
				t.Fatalf("%s: upstream target = %q, pinned %q", label, seen.Path, wantPath)
			}
			for name, value := range recorded.Headers {
				got := seen.Header.Get(name)
				// A multipart boundary is random per request, so the recorded value carries a marker
				// and the Go value is normalized the same way before the comparison.
				got = speechBoundaryPattern.ReplaceAllString(got, "boundary=<boundary>")
				if got != value {
					t.Fatalf("%s: outbound header %q = %q, pinned %q", label, name, got, value)
				}
			}
			switch {
			case recorded.Parts != nil:
				multipartOut++
				gotParts := parseSpeechMultipart(t, label, seen.ContentType, seen.Body)
				if len(gotParts) != len(recorded.Parts) {
					t.Fatalf("%s: %d multipart parts, pinned %d (%+v)", label, len(gotParts), len(recorded.Parts), gotParts)
				}
				for index, want := range recorded.Parts {
					if !speechPartMatches(gotParts[index], want) {
						t.Fatalf("%s: multipart part %d = %+v, pinned %+v", label, index, gotParts[index], want)
					}
				}
			case recorded.Body != nil:
				// The random seed exists only in the Pollinations body; normalizing every body would hide
				// a real number in another route, which is exactly what made a mutation survive once.
				got := string(seen.Body)
				if strings.Contains(recorded.URL, "/v1/chat/completions") {
					got = normalizeSpeechSeed(got)
				}
				if got != *recorded.Body {
					t.Fatalf("%s: outbound body = %q, pinned %q", label, got, *recorded.Body)
				}
			}
		})
	}
	if binaryResponses == 0 {
		t.Fatal("no scenario compares a binary response")
	}
	if multipartOut == 0 {
		t.Fatal("no scenario compares an outbound multipart body")
	}
	if multipartIn == 0 {
		t.Fatal("no scenario sends an inbound multipart upload")
	}
	if throwsCases == 0 {
		t.Fatal("no scenario exercises a rejected fetch")
	}
	for _, status := range []int{200, 400, 500} {
		if counts[status] == 0 {
			t.Fatalf("no scenario answers %d; that branch is unproven", status)
		}
	}
}

// postSpeechScenario sends the scenario request, rebuilding the recorded upload as multipart.
func postSpeechScenario(t *testing.T, handler http.Handler, scenario speechScenario) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	var body io.Reader
	contentType := "application/json"
	if scenario.RequestUpload != nil {
		var buffer bytes.Buffer
		writer := multipart.NewWriter(&buffer)
		content, err := base64.StdEncoding.DecodeString(scenario.RequestUpload.Base64)
		if err != nil {
			t.Fatal(err)
		}
		part, err := writer.CreateFormFile(scenario.RequestUpload.Field, scenario.RequestUpload.Filename)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(content); err != nil {
			t.Fatal(err)
		}
		fields := map[string]json.RawMessage{}
		if scenario.RequestBody != "" {
			if err := json.Unmarshal([]byte(scenario.RequestBody), &fields); err != nil {
				t.Fatal(err)
			}
		}
		for name, raw := range fields {
			var text string
			if err := json.Unmarshal(raw, &text); err != nil {
				text = string(raw)
			}
			if err := writer.WriteField(name, text); err != nil {
				t.Fatal(err)
			}
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(buffer.Bytes())
		contentType = writer.FormDataContentType()
	} else {
		body = strings.NewReader(scenario.RequestBody)
	}
	request := httptest.NewRequest(http.MethodPost, scenario.Route, body)
	request.Header.Set("Content-Type", contentType)
	handler.ServeHTTP(response, request)
	return response
}

func requestURIPath(t *testing.T, absolute string) string {
	t.Helper()
	index := strings.Index(absolute, "://")
	if index < 0 {
		t.Fatalf("%q is not an absolute URL", absolute)
	}
	remainder := absolute[index+3:]
	slash := strings.IndexAny(remainder, "/?#")
	if slash < 0 {
		return "/"
	}
	return remainder[slash:]
}

// parseSpeechMultipart reads the parts the peer observed.
func parseSpeechMultipart(t *testing.T, label, contentType string, body []byte) []speechPart {
	t.Helper()
	mediaType, parameters, err := mime.ParseMediaType(contentType)
	if err != nil || !strings.HasPrefix(mediaType, "multipart/") {
		t.Fatalf("%s: outbound content type %q is not multipart", label, contentType)
	}
	reader := multipart.NewReader(bytes.NewReader(body), parameters["boundary"])
	parts := make([]speechPart, 0)
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("%s: cannot read outbound multipart: %v", label, err)
		}
		content, err := io.ReadAll(part)
		if err != nil {
			t.Fatalf("%s: cannot read outbound part: %v", label, err)
		}
		name := part.FormName()
		filename := part.FileName()
		contentType := part.Header.Get("Content-Type")
		entry := speechPart{SHA256: fmt.Sprintf("%x", sha256.Sum256(content)), Bytes: len(content)}
		if name != "" {
			entry.Name = &name
		}
		if filename != "" {
			entry.Filename = &filename
		}
		if contentType != "" {
			entry.ContentType = &contentType
		}
		parts = append(parts, entry)
		_ = part.Close()
	}
	return parts
}

func speechPartMatches(got, want speechPart) bool {
	return equalOptionalString(got.Name, want.Name) &&
		equalOptionalString(got.Filename, want.Filename) &&
		equalOptionalString(got.ContentType, want.ContentType) &&
		got.SHA256 == want.SHA256 && got.Bytes == want.Bytes
}

func equalOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
