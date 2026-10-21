package server

// Replay of tests/oracle/sillytavern-1.19.0-openai-transcribe.json, recorded by
// tools/probe-openai-transcribe.mjs. One handler, four routes, so the replay runs every recorded scenario
// against the same implementation and asserts the four seams separately.
//
// The multipart parts are compared as parts because the boundary is random per request. The recorded part
// list is asserted NON-EMPTY first: a request the peer failed to record must not look like a request the
// server never made.

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type transcribePart struct {
	Name        string  `json:"name"`
	Filename    *string `json:"filename"`
	ContentType *string `json:"contentType"`
	SHA256      string  `json:"sha256"`
	Bytes       int     `json:"bytes"`
	Value       string  `json:"value"`
}

type transcribeOutbound struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Parts   []transcribePart  `json:"parts"`
	Body    string            `json:"body"`
}

type transcribeScenario struct {
	Route       string `json:"route"`
	RequestBody string `json:"requestBody"`
	Upload      *struct {
		Field       string `json:"field"`
		Filename    string `json:"filename"`
		ContentType string `json:"contentType"`
		Base64      string `json:"base64"`
	} `json:"upload"`
	Mocks   []googleTTSMock `json:"mocks"`
	Secrets map[string][]struct {
		Value string `json:"value"`
	} `json:"secrets"`
	Response struct {
		Status   int               `json:"status"`
		Headers  map[string]string `json:"headers"`
		Body     json.RawMessage   `json:"body"`
		BodyText string            `json:"bodyText"`
	} `json:"response"`
	Outbound []transcribeOutbound `json:"outbound"`
}

type transcribeFixture struct {
	Inputs struct {
		AudioSHA256 string `json:"audioSha256"`
		AudioBytes  int    `json:"audioBytes"`
	} `json:"inputs"`
	Scenarios map[string]transcribeScenario `json:"scenarios"`
}

func loadTranscribeOracle(t *testing.T) transcribeFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-openai-transcribe.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture transcribeFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) < 10 {
		t.Fatalf("the transcribe oracle records only %d scenarios", len(fixture.Scenarios))
	}
	return fixture
}

// transcribeUploadRequest builds the client-side multipart the probe sent: the avatar file part plus the
// scenario's body members as fields.
func transcribeUploadRequest(t *testing.T, route string, scenario transcribeScenario) *http.Request {
	t.Helper()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	if scenario.Upload != nil {
		content, err := base64.StdEncoding.DecodeString(scenario.Upload.Base64)
		if err != nil {
			t.Fatal(err)
		}
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", `form-data; name="`+scenario.Upload.Field+`"; filename="`+scenario.Upload.Filename+`"`)
		header.Set("Content-Type", scenario.Upload.ContentType)
		part, err := writer.CreatePart(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(scenario.RequestBody), &body); err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(body))
	for name := range body {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := writer.WriteField(name, strings.Trim(strings.TrimSpace(toJSONString(body[name])), `"`)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, route, bytes.NewReader(buffer.Bytes()))
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func toJSONString(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}

// transcribePeer serves the scenario's mocks in order and records each request's method, target, headers,
// body and PARSED PARTS.
type transcribePeer struct {
	server *httptest.Server
	mocks  []googleTTSMock
	seen   []transcribeOutbound
	index  int
}

func newTranscribePeer(t *testing.T, mocks []googleTTSMock) *transcribePeer {
	t.Helper()
	peer := &transcribePeer{mocks: mocks}
	peer.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		record := transcribeOutbound{
			URL:     r.URL.RequestURI(),
			Method:  r.Method,
			Headers: headerMapOf(r.Header),
			Body:    string(body),
		}
		contentType := r.Header.Get("Content-Type")
		if strings.HasPrefix(contentType, "multipart/form-data") {
			// The body was already read above, so it is parsed from the BYTES; r.MultipartReader() would
			// see a consumed stream and silently record no parts, which is the failure mode the non-empty
			// assertion exists to catch.
			_, parameters, paramErr := mime.ParseMediaType(contentType)
			if paramErr == nil {
				reader := multipart.NewReader(bytes.NewReader(body), parameters["boundary"])
				for {
					part, err := reader.NextPart()
					if err != nil {
						break
					}
					content, _ := io.ReadAll(part)
					digest := sha256.Sum256(content)
					entry := transcribePart{
						Name:   part.FormName(),
						SHA256: hex.EncodeToString(digest[:]),
						Bytes:  len(content),
					}
					if part.FileName() != "" {
						filename := part.FileName()
						partType := part.Header.Get("Content-Type")
						entry.Filename = &filename
						entry.ContentType = &partType
					} else {
						entry.Value = string(content)
					}
					record.Parts = append(record.Parts, entry)
				}
			}
		}
		peer.seen = append(peer.seen, record)
		if peer.index >= len(peer.mocks) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"gotavern test: unstubbed outbound request"}`))
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

func TestOpenAITranscribeMatchesPinnedOracle(t *testing.T) {
	fixture := loadTranscribeOracle(t)
	names := make([]string, 0, len(fixture.Scenarios))
	for name := range fixture.Scenarios {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		scenario := fixture.Scenarios[name]
		t.Run(name, func(t *testing.T) {
			peer := newTranscribePeer(t, scenario.Mocks)
			t.Setenv("GOTAVERN_OPENAI_TRANSCRIBE_URL", peer.server.URL)
			t.Setenv("GOTAVERN_GROQ_TRANSCRIBE_URL", peer.server.URL)
			t.Setenv("GOTAVERN_MISTRAL_TRANSCRIBE_URL", peer.server.URL)
			t.Setenv("GOTAVERN_ZAI_TRANSCRIBE_URL", peer.server.URL)
			dataRoot := t.TempDir()
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			writeGoogleTTSSecrets(t, dataRoot, scenario.Secrets)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, transcribeUploadRequest(t, scenario.Route, scenario))

			if recorder.Code != scenario.Response.Status {
				t.Fatalf("status = %d, pinned %d (body %q)", recorder.Code, scenario.Response.Status, recorder.Body.String())
			}
			if recorder.Body.String() != scenario.Response.BodyText {
				t.Fatalf("body = %q, pinned %q", recorder.Body.String(), scenario.Response.BodyText)
			}
			if got, want := recorder.Header().Get("Content-Type"), scenario.Response.Headers["content-type"]; got != want {
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
				parsedURL, err := url.Parse(recorded.URL)
				if err != nil {
					t.Fatal(err)
				}
				parsed := parsedURL.RequestURI()
				if actual.URL != parsed {
					t.Fatalf("request %d target = %q, pinned %q", index, actual.URL, parsed)
				}
				if got, want := actual.Headers["authorization"], recorded.Headers["authorization"]; got != want {
					t.Fatalf("request %d authorization = %q, pinned %q", index, got, want)
				}
				if len(recorded.Parts) > 0 {
					if len(actual.Parts) == 0 {
						t.Fatalf("request %d recorded NO multipart parts, so this run cannot be compared", index)
					}
					if len(actual.Parts) != len(recorded.Parts) {
						t.Fatalf("request %d parts = %d, pinned %d", index, len(actual.Parts), len(recorded.Parts))
					}
					for partIndex, part := range recorded.Parts {
						got := actual.Parts[partIndex]
						if got.Name != part.Name || got.SHA256 != part.SHA256 || got.Bytes != part.Bytes {
							t.Fatalf("request %d part %d = %+v, pinned %+v", index, partIndex, got, part)
						}
						if part.Filename != nil && (got.Filename == nil || *got.Filename != *part.Filename) {
							t.Fatalf("request %d part %d filename = %v, pinned %v", index, partIndex, got.Filename, *part.Filename)
						}
						if part.ContentType != nil && (got.ContentType == nil || *got.ContentType != *part.ContentType) {
							t.Fatalf("request %d part %d content type = %v, pinned %v", index, partIndex, got.ContentType, *part.ContentType)
						}
					}
				}
			}
		})
	}
}

// TestOpenAITranscribeSeamDefaults pins the four seams to the pinned endpoints: a drifted default would
// change production while the tests keep passing against the override.
func TestOpenAITranscribeSeamDefaults(t *testing.T) {
	// The expected defaults are written DOWN rather than derived from the value under test: comparing
	// `sdSeamURL(env, fallback)` against `fallback` asserts only that the seam returns what it was given,
	// which is true for any default and therefore cannot fail. A mutation of a default must die here.
	pinned := map[string]string{
		"GOTAVERN_OPENAI_TRANSCRIBE_URL":  "https://api.openai.com",
		"GOTAVERN_GROQ_TRANSCRIBE_URL":    "https://api.groq.com",
		"GOTAVERN_MISTRAL_TRANSCRIBE_URL": "https://api.mistral.ai",
		"GOTAVERN_ZAI_TRANSCRIBE_URL":     "https://api.z.ai",
	}
	for _, entry := range openAITranscribeProviders() {
		t.Setenv(entry.environment, "")
		expected, present := pinned[entry.environment]
		if !present {
			t.Fatalf("seam %s has no pinned expectation", entry.environment)
		}
		if entry.fallback != expected {
			t.Fatalf("%s default = %q, pinned %q", entry.environment, entry.fallback, expected)
		}
		if got := sdSeamURL(entry.environment, entry.fallback); got != expected {
			t.Fatalf("%s resolved = %q, pinned %q", entry.environment, got, expected)
		}
		if !strings.HasPrefix(entry.fallback+entry.path, "https://") {
			t.Fatalf("%s pinned URL is not absolute: %q", entry.environment, entry.fallback+entry.path)
		}
	}
	if len(pinned) != len(openAITranscribeProviders()) {
		t.Fatalf("the pinned expectation table has %d entries for %d providers", len(pinned), len(openAITranscribeProviders()))
	}
	if len(openAITranscribeProviders()) != 4 {
		t.Fatalf("the route table has %d providers, pinned 4", len(openAITranscribeProviders()))
	}
}
