package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type corsMiddlewareFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		Cors struct {
			Enabled        bool `json:"enabled"`
			Origin         any  `json:"origin"`
			Methods        any  `json:"methods"`
			AllowedHeaders any  `json:"allowedHeaders"`
			ExposedHeaders any  `json:"exposedHeaders"`
			Credentials    bool `json:"credentials"`
			MaxAge         any  `json:"maxAge"`
		} `json:"cors"`
		CorsDisabled struct {
			Enabled bool `json:"enabled"`
		} `json:"corsDisabled"`
		AllowedHeaders map[string]string `json:"allowedHeaders"`
		DeniedHeaders  map[string]string `json:"deniedHeaders"`
	} `json:"inputs"`
	Responses map[string]struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
	} `json:"responses"`
}

func TestPinnedNodeCORSMiddleware(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-cors-middleware.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture corsMiddlewareFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("CORS oracle baseline = %+v", fixture.Baseline)
	}
	enabled := fixture.Inputs.Cors.Enabled
	credentials := fixture.Inputs.Cors.Credentials
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		CorsSettingsConfigured: true,
		CorsEnabled:            &enabled,
		CorsOrigin:             fixture.Inputs.Cors.Origin,
		CorsMethods:            fixture.Inputs.Cors.Methods,
		CorsAllowedHeaders:     fixture.Inputs.Cors.AllowedHeaders,
		CorsExposedHeaders:     fixture.Inputs.Cors.ExposedHeaders,
		CorsCredentials:        &credentials,
		CorsMaxAge:             fixture.Inputs.Cors.MaxAge,
	})

	cases := []struct {
		name    string
		method  string
		route   string
		headers map[string]string
	}{
		{name: "allowedPreflight", method: http.MethodOptions, route: "/api/image-metadata", headers: fixture.Inputs.AllowedHeaders},
		{name: "deniedPreflight", method: http.MethodOptions, route: "/api/image-metadata", headers: fixture.Inputs.DeniedHeaders},
		{name: "preflightWithoutOrigin", method: http.MethodOptions, route: "/route-not-registered"},
		{name: "allowedActualRequest", method: http.MethodGet, route: "/version", headers: map[string]string{"Origin": "https://allowed.example"}},
		{name: "deniedActualRequest", method: http.MethodGet, route: "/version", headers: map[string]string{"Origin": "https://denied.example"}},
	}
	for _, probeCase := range cases {
		t.Run(probeCase.name, func(t *testing.T) {
			request := httptest.NewRequest(probeCase.method, probeCase.route, nil)
			for key, value := range probeCase.headers {
				request.Header.Set(key, value)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			want, exists := fixture.Responses[probeCase.name]
			if !exists {
				t.Fatalf("CORS oracle has no response %q", probeCase.name)
			}
			gotHeaders := stableCORSHeaders(response.Header(), probeCase.method == http.MethodOptions)
			wantHeaders := want.Headers
			if probeCase.method != http.MethodOptions {
				wantHeaders = make(map[string]string, len(want.Headers))
				for key, value := range want.Headers {
					if key != "content-length" {
						wantHeaders[key] = value
					}
				}
			}
			if response.Code != want.Status || !reflect.DeepEqual(gotHeaders, wantHeaders) {
				t.Fatalf("CORS response %s differs from pinned Node: status=%d want=%d headers=%#v want=%#v", probeCase.name, response.Code, want.Status, gotHeaders, wantHeaders)
			}
			if probeCase.method == http.MethodOptions && response.Body.Len() != 0 {
				t.Fatalf("CORS preflight %s returned a body: %q", probeCase.name, response.Body.String())
			}
		})
	}
	disabled := fixture.Inputs.CorsDisabled.Enabled
	disabledHandler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		CorsSettingsConfigured: true,
		CorsEnabled:            &disabled,
	})
	for _, probeCase := range []struct {
		name    string
		method  string
		route   string
		headers map[string]string
	}{
		{name: "disabledPreflight", method: http.MethodOptions, route: "/api/image-metadata", headers: fixture.Inputs.AllowedHeaders},
		{name: "disabledActualRequest", method: http.MethodGet, route: "/version", headers: map[string]string{"Origin": "https://allowed.example"}},
	} {
		t.Run(probeCase.name, func(t *testing.T) {
			request := httptest.NewRequest(probeCase.method, probeCase.route, nil)
			for key, value := range probeCase.headers {
				request.Header.Set(key, value)
			}
			response := httptest.NewRecorder()
			disabledHandler.ServeHTTP(response, request)
			want, exists := fixture.Responses[probeCase.name]
			if !exists {
				t.Fatalf("CORS oracle has no response %q", probeCase.name)
			}
			gotHeaders := stableCORSHeaders(response.Header(), false)
			wantHeaders := make(map[string]string, len(want.Headers))
			for key, value := range want.Headers {
				if key != "allow" {
					wantHeaders[key] = value
				}
			}
			if probeCase.name == "disabledPreflight" {
				if want.Status != http.StatusOK || response.Code != http.StatusNotFound || want.Headers["allow"] == "" {
					t.Fatalf("disabled CORS preflight divergence changed: pinned status=%d allow=%q, Go status=%d", want.Status, want.Headers["allow"], response.Code)
				}
			} else if response.Code != want.Status {
				t.Fatalf("disabled CORS response %s status=%d want=%d", probeCase.name, response.Code, want.Status)
			}
			if !reflect.DeepEqual(gotHeaders, wantHeaders) {
				t.Fatalf("disabled CORS response %s differs from pinned Node: status=%d want=%d headers=%#v want=%#v", probeCase.name, response.Code, want.Status, gotHeaders, want.Headers)
			}
		})
	}
}

func stableCORSHeaders(header http.Header, preflight bool) map[string]string {
	result := make(map[string]string)
	for name, values := range header {
		key := strings.ToLower(name)
		if strings.HasPrefix(key, "access-control-") || key == "vary" || (preflight && key == "content-length") {
			result[key] = strings.Join(values, ", ")
		}
	}
	return result
}
