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
		CorsWildcard struct {
			Enabled        bool `json:"enabled"`
			Origin         any  `json:"origin"`
			Methods        any  `json:"methods"`
			AllowedHeaders any  `json:"allowedHeaders"`
			ExposedHeaders any  `json:"exposedHeaders"`
			Credentials    bool `json:"credentials"`
			MaxAge         any  `json:"maxAge"`
		} `json:"corsWildcard"`
		AllowedHeaders map[string]string `json:"allowedHeaders"`
		DeniedHeaders  map[string]string `json:"deniedHeaders"`
	} `json:"inputs"`
	Responses map[string]struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
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
		name             string
		method           string
		route            string
		headers          map[string]string
		automaticOptions bool
	}{
		{name: "disabledPreflight", method: http.MethodOptions, route: "/api/image-metadata", headers: fixture.Inputs.AllowedHeaders, automaticOptions: true},
		{name: "disabledGetPreflight", method: http.MethodOptions, route: "/api/sprites/get", headers: fixture.Inputs.AllowedHeaders, automaticOptions: true},
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
			if probeCase.automaticOptions {
				gotHeaders = stableDisabledOptionsHeaders(response.Header())
			}
			if response.Code != want.Status {
				t.Fatalf("disabled CORS response %s status=%d want=%d", probeCase.name, response.Code, want.Status)
			}
			if !reflect.DeepEqual(gotHeaders, want.Headers) {
				t.Fatalf("disabled CORS response %s differs from pinned Node: status=%d want=%d headers=%#v want=%#v", probeCase.name, response.Code, want.Status, gotHeaders, want.Headers)
			}
			if probeCase.automaticOptions && response.Body.String() != want.Body {
				t.Fatalf("disabled CORS response %s body=%q want=%q", probeCase.name, response.Body.String(), want.Body)
			}
		})
	}
	wildcard := fixture.Inputs.CorsWildcard
	wildcardEnabled := wildcard.Enabled
	wildcardCredentials := wildcard.Credentials
	wildcardHandler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		CorsSettingsConfigured: true,
		CorsEnabled:            &wildcardEnabled,
		CorsOrigin:             wildcard.Origin,
		CorsMethods:            wildcard.Methods,
		CorsAllowedHeaders:     wildcard.AllowedHeaders,
		CorsExposedHeaders:     wildcard.ExposedHeaders,
		CorsCredentials:        &wildcardCredentials,
		CorsMaxAge:             wildcard.MaxAge,
	})
	for _, probeCase := range []struct {
		name    string
		method  string
		route   string
		headers map[string]string
	}{
		{name: "wildcardActualRequest", method: http.MethodGet, route: "/version", headers: map[string]string{"Origin": "https://any.example"}},
		{name: "wildcardWithoutOrigin", method: http.MethodGet, route: "/version"},
		{name: "wildcardPreflight", method: http.MethodOptions, route: "/api/image-metadata", headers: map[string]string{
			"Origin": "https://any.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-wildcard",
		}},
	} {
		t.Run(probeCase.name, func(t *testing.T) {
			request := httptest.NewRequest(probeCase.method, probeCase.route, nil)
			for key, value := range probeCase.headers {
				request.Header.Set(key, value)
			}
			response := httptest.NewRecorder()
			wildcardHandler.ServeHTTP(response, request)
			want, exists := fixture.Responses[probeCase.name]
			if !exists {
				t.Fatalf("CORS oracle has no response %q", probeCase.name)
			}
			gotHeaders := stableCORSHeaders(response.Header(), probeCase.method == http.MethodOptions)
			if response.Code != want.Status || !reflect.DeepEqual(gotHeaders, want.Headers) {
				t.Fatalf("CORS wildcard response %s differs from pinned Node: status=%d want=%d headers=%#v want=%#v", probeCase.name, response.Code, want.Status, gotHeaders, want.Headers)
			}
		})
	}
}

func stableDisabledOptionsHeaders(header http.Header) map[string]string {
	result := make(map[string]string)
	for name, values := range header {
		key := strings.ToLower(name)
		if key == "allow" || key == "content-length" || key == "content-type" || key == "vary" {
			result[key] = strings.Join(values, ", ")
		}
	}
	return result
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
