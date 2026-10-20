package server

// The response-time header's VALUE is a wall-clock duration and is excluded
// centrally from fixture comparisons, so nothing else in the Go suite would
// notice if the middleware stopped stamping it. This test asserts the part that
// is a contract: presence, and the pinned format. The provider-wire
// differential's headerCoverage rule asserts the same presence from the outside.

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
)

var pinnedResponseTimePattern = regexp.MustCompile(`^\d+\.\d{3}ms$`)

func TestPinnedResponseTimeHeaderIsPresentOnEveryResponse(t *testing.T) {
	handler := NewHTTPHandler()
	for _, testCase := range []struct {
		method string
		route  string
	}{
		{http.MethodGet, "/version"},
		{http.MethodGet, "/__gotavern_missing_route__"},
		{http.MethodPost, "/api/backends/chat-completions/generate"},
	} {
		request := httptest.NewRequest(testCase.method, testCase.route, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		value := response.Header().Get("X-Response-Time")
		if !pinnedResponseTimePattern.MatchString(value) {
			t.Errorf("%s %s: X-Response-Time = %q, want the pinned <milliseconds with three decimals>ms format (status %d)",
				testCase.method, testCase.route, value, response.Code)
		}
	}
}
