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

type nodeResponse struct {
	Status      int             `json:"status"`
	ContentType string          `json:"contentType"`
	Bytes       int             `json:"bytes"`
	SHA256      string          `json:"sha256"`
	Body        json.RawMessage `json:"body"`
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

	for _, requestPath := range []string{"/", "/lib.js"} {
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
