package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type freshStartFixture struct {
	HTTP struct {
		Responses map[string]nodeResponse `json:"responses"`
	} `json:"http"`
}

type customNotFoundFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		Content string `json:"content"`
	} `json:"inputs"`
	Response struct {
		Status        int    `json:"status"`
		ContentType   string `json:"contentType"`
		ContentLength string `json:"contentLength"`
		Bytes         int    `json:"bytes"`
		SHA256        string `json:"sha256"`
		Body          string `json:"body"`
	} `json:"response"`
}

type nodeResponse struct {
	Status        int             `json:"status"`
	ContentType   string          `json:"contentType"`
	ContentLength string          `json:"contentLength"`
	Bytes         int             `json:"bytes"`
	SHA256        string          `json:"sha256"`
	Body          json.RawMessage `json:"body"`
}

func readFreshStartFixture(t *testing.T) freshStartFixture {
	t.Helper()
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-fresh-start.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture freshStartFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestPinnedNodeHTTPOracle(t *testing.T) {
	fixture := readFreshStartFixture(t)
	handler := NewHTTPHandler()

	for _, requestPath := range []string{"/", "/lib.js", "/__gotavern_missing_route__"} {
		t.Run(requestPath, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, requestPath, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			expected := fixture.HTTP.Responses[requestPath]
			if response.Code != expected.Status {
				t.Fatalf("status: got %d, Node oracle has %d", response.Code, expected.Status)
			}
			if contentType := response.Header().Get("Content-Type"); contentType != expected.ContentType {
				t.Fatalf("Content-Type: got %q, Node oracle has %q", contentType, expected.ContentType)
			}
			body := response.Body.Bytes()
			if len(body) != expected.Bytes {
				t.Fatalf("body size: got %d bytes, Node oracle has %d", len(body), expected.Bytes)
			}
			digest := sha256.Sum256(body)
			if got := hex.EncodeToString(digest[:]); got != expected.SHA256 {
				t.Fatalf("body SHA-256: got %s, Node oracle has %s", got, expected.SHA256)
			}
		})
	}

	t.Run("/version", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/version", nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		expected := fixture.HTTP.Responses["/version"]
		if response.Code != expected.Status {
			t.Fatalf("status: got %d, Node oracle has %d", response.Code, expected.Status)
		}
		if contentType := response.Header().Get("Content-Type"); contentType != expected.ContentType {
			t.Fatalf("Content-Type: got %q, Node oracle has %q", contentType, expected.ContentType)
		}
		var expectedBody, gotBody map[string]any
		if err := json.Unmarshal(expected.Body, &expectedBody); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(response.Body.Bytes(), &gotBody); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(gotBody, expectedBody) {
			t.Fatalf("response body differs from Node oracle:\n got: %#v\nwant: %#v", gotBody, expectedBody)
		}
	})
}

func TestPinnedNodeHTTPOracleHeadResponses(t *testing.T) {
	handler := NewHTTPHandler()
	for _, requestPath := range []string{"/", "/lib.js", "/version"} {
		t.Run(requestPath, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodHead, requestPath, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status: got %d, want 200", response.Code)
			}
			if response.Body.Len() != 0 {
				t.Fatalf("HEAD response wrote %d body bytes", response.Body.Len())
			}
			if response.Header().Get("Content-Length") == "" {
				t.Fatal("HEAD response omitted Content-Length")
			}
		})
	}
}

func TestPinnedNodeHTTPOracleHeadNotFoundResponse(t *testing.T) {
	fixture := readFreshStartFixture(t)
	request := httptest.NewRequest(http.MethodHead, "/__gotavern_missing_route__", nil)
	response := httptest.NewRecorder()
	NewHTTPHandler().ServeHTTP(response, request)

	expected := fixture.HTTP.Responses["HEAD /__gotavern_missing_route__"]
	if response.Code != expected.Status {
		t.Fatalf("status: got %d, Node oracle has %d", response.Code, expected.Status)
	}
	if contentType := response.Header().Get("Content-Type"); contentType != expected.ContentType {
		t.Fatalf("Content-Type: got %q, Node oracle has %q", contentType, expected.ContentType)
	}
	if contentLength := response.Header().Get("Content-Length"); contentLength != expected.ContentLength {
		t.Fatalf("Content-Length: got %q, Node oracle has %q", contentLength, expected.ContentLength)
	}
	body := response.Body.Bytes()
	if len(body) != expected.Bytes {
		t.Fatalf("body size: got %d bytes, Node oracle has %d", len(body), expected.Bytes)
	}
	digest := sha256.Sum256(body)
	if got := hex.EncodeToString(digest[:]); got != expected.SHA256 {
		t.Fatalf("body SHA-256: got %s, Node oracle has %s", got, expected.SHA256)
	}
}

func TestPinnedNodeHTTPOracleCustomDataRootNotFoundPage(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-custom-404.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture customNotFoundFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("custom 404 oracle baseline = %+v", fixture.Baseline)
	}

	dataRoot := t.TempDir()
	errorPagePath := filepath.Join(dataRoot, "_errors", "url-not-found.html")
	if err := os.MkdirAll(filepath.Dir(errorPagePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(errorPagePath, []byte(fixture.Inputs.Content), 0o644); err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandlerWithDataRoot(dataRoot)
	if err := os.WriteFile(errorPagePath, []byte("changed after handler setup"), 0o644); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/__gotavern_missing_route__", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != fixture.Response.Status {
		t.Fatalf("status: got %d, Node oracle has %d", response.Code, fixture.Response.Status)
	}
	if contentType := response.Header().Get("Content-Type"); contentType != fixture.Response.ContentType {
		t.Fatalf("Content-Type: got %q, Node oracle has %q", contentType, fixture.Response.ContentType)
	}
	if contentLength := response.Header().Get("Content-Length"); contentLength != fixture.Response.ContentLength {
		t.Fatalf("Content-Length: got %q, Node oracle has %q", contentLength, fixture.Response.ContentLength)
	}
	body := response.Body.Bytes()
	if len(body) != fixture.Response.Bytes || string(body) != fixture.Response.Body {
		t.Fatalf("custom 404 body = %q (%d bytes), pinned Node has %q (%d bytes)", body, len(body), fixture.Response.Body, fixture.Response.Bytes)
	}
	digest := sha256.Sum256(body)
	if got := hex.EncodeToString(digest[:]); got != fixture.Response.SHA256 {
		t.Fatalf("body SHA-256: got %s, Node oracle has %s", got, fixture.Response.SHA256)
	}
}
