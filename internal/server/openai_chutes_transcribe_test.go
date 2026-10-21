package server

// Replay of tests/oracle/sillytavern-1.19.0-openai-chutes-transcribe.json, recorded by
// tools/probe-openai-chutes-transcribe.mjs, plus the assertion the replay CANNOT make: the host
// interpolation itself.
//
// The peer cannot own a hostile host, so the replay points the seam at the peer and compares the path,
// while `TestOpenAIChutesTranscribeHostInterpolation` calls the URL builder with the seam at its DEFAULT and
// compares the result against the URLs the pinned server actually requested -- which is where a model
// containing a dot or a slash becomes visible as a different HOST.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type chutesScenario struct {
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

type chutesFixture struct {
	Inputs struct {
		HostileModelURL string `json:"hostileModelUrl"`
		ChutesKey       string `json:"chutesKey"`
	} `json:"inputs"`
	Scenarios map[string]chutesScenario `json:"scenarios"`
}

func loadChutesOracle(t *testing.T) chutesFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-openai-chutes-transcribe.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture chutesFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	// The two whitespace scenarios are named here so that deleting either one cannot silently re-open the
	// gap the mutation loop found: `.trim()` and the per-chunk trim are only discriminated by these inputs.
	for _, required := range []string{"chutesWhitespaceChunks", "chutesInternalWhitespace"} {
		if _, present := fixture.Scenarios[required]; !present {
			t.Fatalf("the fixture no longer records %s, so the trim assertion is decoration", required)
		}
	}
	if len(fixture.Scenarios) < 6 {
		t.Fatalf("the chutes oracle records only %d scenarios", len(fixture.Scenarios))
	}
	return fixture
}

func chutesUploadRequest(t *testing.T, scenario chutesScenario) *http.Request {
	t.Helper()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	if scenario.Upload != nil {
		content, err := base64.StdEncoding.DecodeString(scenario.Upload.Base64)
		if err != nil {
			t.Fatal(err)
		}
		part, err := writer.CreateFormFile(scenario.Upload.Field, scenario.Upload.Filename)
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
	request := httptest.NewRequest(http.MethodPost, scenario.Route, bytes.NewReader(buffer.Bytes()))
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func TestOpenAIChutesTranscribeMatchesPinnedOracle(t *testing.T) {
	fixture := loadChutesOracle(t)
	names := make([]string, 0, len(fixture.Scenarios))
	for name := range fixture.Scenarios {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		scenario := fixture.Scenarios[name]
		t.Run(name, func(t *testing.T) {
			peer := newTranscribePeer(t, scenario.Mocks)
			t.Setenv("GOTAVERN_CHUTES_TRANSCRIBE_URL", peer.server.URL)
			dataRoot := t.TempDir()
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			writeGoogleTTSSecrets(t, dataRoot, scenario.Secrets)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, chutesUploadRequest(t, scenario))

			if recorder.Code != scenario.Response.Status {
				t.Fatalf("status = %d, pinned %d (body %q)", recorder.Code, scenario.Response.Status, recorder.Body.String())
			}
			if recorder.Body.String() != scenario.Response.BodyText {
				t.Fatalf("body = %q, pinned %q", recorder.Body.String(), scenario.Response.BodyText)
			}
			// THE COUNT: an escaped request leaves zero captures, which must fail here rather than pass as
			// "nothing to compare" (rule 14).
			if len(peer.seen) != len(scenario.Outbound) {
				t.Fatalf("captured requests = %d, pinned %d -- an escaped request must not look like one that was never made",
					len(peer.seen), len(scenario.Outbound))
			}
			for index, recorded := range scenario.Outbound {
				actual := peer.seen[index]
				if actual.Method != recorded.Method {
					t.Fatalf("request %d method = %s, pinned %s", index, actual.Method, recorded.Method)
				}
				// A HOSTILE host cannot be owned by the peer, so its path is not comparable here; the host
				// itself is asserted by TestOpenAIChutesTranscribeHostInterpolation against the recorded URL.
				if strings.HasSuffix(hostOf(recorded.URL), ".chutes.ai") {
					parsedURL, err := urlParse(t, recorded.URL)
					if err != nil {
						t.Fatal(err)
					}
					if actual.URL != parsedURL {
						t.Fatalf("request %d target = %q, pinned %q", index, actual.URL, parsedURL)
					}
				} else if actual.URL != "/transcribe" {
					t.Fatalf("request %d target = %q; the overridden base must still append the pinned path", index, actual.URL)
				}
				if actual.Body != recorded.Body {
					t.Fatalf("request %d body = %q, pinned %q", index, actual.Body, recorded.Body)
				}
				for _, header := range []string{"authorization", "content-type"} {
					if got, want := actual.Headers[header], recorded.Headers[header]; got != want {
						t.Fatalf("request %d header %s = %q, pinned %q", index, header, got, want)
					}
				}
			}
		})
	}
}

// TestOpenAIChutesTranscribeHostInterpolation is the assertion the replay cannot make: with the seam at its
// DEFAULT the builder must produce exactly the URLs the pinned server requested, hostile hosts included.
func TestOpenAIChutesTranscribeHostInterpolation(t *testing.T) {
	fixture := loadChutesOracle(t)
	t.Setenv("GOTAVERN_CHUTES_TRANSCRIBE_URL", "")

	pinned := map[string]string{}
	for name, scenario := range fixture.Scenarios {
		if len(scenario.Outbound) == 0 {
			continue
		}
		var body map[string]any
		if err := json.Unmarshal([]byte(scenario.RequestBody), &body); err != nil {
			t.Fatal(err)
		}
		model, _ := body["model"].(string)
		pinned[name] = scenario.Outbound[0].URL
		if got := chutesTranscribeURL(model); got != scenario.Outbound[0].URL {
			t.Fatalf("%s: chutesTranscribeURL(%q) = %q, pinned %q", name, model, got, scenario.Outbound[0].URL)
		}
	}
	if len(pinned) < 4 {
		t.Fatalf("only %d scenarios reach the provider; the host interpolation is barely asserted", len(pinned))
	}
	// The hostile case is asserted by NAME as well, so removing the scenario cannot silently drop it.
	if got := chutesTranscribeURL("evil.example.com/x"); got != fixture.Inputs.HostileModelURL {
		t.Fatalf("the hostile model produced %q, pinned %q", got, fixture.Inputs.HostileModelURL)
	}
}

func urlParse(t *testing.T, recorded string) (string, error) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, recorded, nil)
	if err != nil {
		return "", err
	}
	return request.URL.RequestURI(), nil
}

var _ = io.EOF
