package server

// Replay of the pinned /api/search routes. The oracle is
// tests/oracle/sillytavern-1.19.0-search.json, recorded by tools/probe-search.mjs from the pinned
// server with node-fetch replaced by a controlled peer. Each scenario is replayed against a local
// keyed recording peer, and compared on the HTTP response plus every outbound request:
//
//   - method and raw target (path + query, byte for byte);
//   - the full wire header list, reconstructed from the fixture's explicit headers plus the
//     node-fetch defaults the fixture records (accept, accept-encoding, user-agent, and
//     Content-Length for a body), with Host and the transport Connection where the route does not
//     set Connection itself;
//   - the request body.
//
// /api/search/visit is asserted to be ABSENT (final 404), because it is deliberately not
// implemented until the shared private-address transport policy exists.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

type searchFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	NodeFetchWireDefaults struct {
		Headers [][2]string `json:"headers"`
	} `json:"nodeFetchWireDefaults"`
	Inputs struct {
		CookieSecret string            `json:"cookieSecret"`
		Account      sdFixtureAccount  `json:"account"`
		SeamDefaults map[string]string `json:"seamDefaults"`
		Scenarios    map[string]struct {
			Route    string                     `json:"route"`
			Body     map[string]json.RawMessage `json:"body"`
			Seam     *string                    `json:"seam"`
			Secrets  map[string]string          `json:"secrets"`
			Upstream []searchUpstream           `json:"upstream"`
		} `json:"scenarios"`
	} `json:"inputs"`
	Observations     map[string]searchObservation `json:"observations"`
	KnownDifferences []map[string]any             `json:"knownDifferences"`
}

type searchUpstream struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

type searchOutbound struct {
	URL     string      `json:"url"`
	Method  string      `json:"method"`
	Headers [][2]string `json:"explicitHeaders"`
	Body    string      `json:"body"`
}

type searchObservation struct {
	Status        int              `json:"status"`
	ContentType   *string          `json:"contentType"`
	ContentLength *string          `json:"contentLength"`
	Etag          *string          `json:"etag"`
	Body          string           `json:"body"`
	Outbound      []searchOutbound `json:"outbound"`
	Comparison    searchComparison `json:"comparison"`
}

type searchComparison struct {
	Compared    []string          `json:"compared"`
	Shape       []string          `json:"shape"`
	ShapeReason map[string]string `json:"shapeReason"`
}

var searchObservableKeys = []string{"status", "contentType", "contentLength", "etag", "body", "outbound"}

func TestSearchSeamDefaults(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-search.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture searchFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	accessors := map[string]func() string{
		"GOTAVERN_SEARCH_SERPAPI_URL": searchSerpapiURL,
		"GOTAVERN_SEARCH_YOUTUBE_URL": searchYouTubeURL,
		"GOTAVERN_SEARCH_TAVILY_URL":  searchTavilyURL,
		"GOTAVERN_SEARCH_SERPER_URL":  searchSerperURL,
		"GOTAVERN_SEARCH_ZAI_URL":     searchZaiURL,
	}
	if len(fixture.Inputs.SeamDefaults) != len(accessors) {
		t.Fatalf("fixture records %d seam defaults, implementation has %d", len(fixture.Inputs.SeamDefaults), len(accessors))
	}
	for environmentName, defaultValue := range fixture.Inputs.SeamDefaults {
		accessor, exists := accessors[environmentName]
		if !exists {
			t.Fatalf("fixture records unknown seam %q", environmentName)
		}
		t.Setenv(environmentName, "")
		if got := accessor(); got != defaultValue {
			t.Fatalf("%s default = %q, pinned literal %q", environmentName, got, defaultValue)
		}
	}
	t.Setenv("GOTAVERN_SEARCH_SERPAPI_URL", "http://127.0.0.1:9999/")
	if got := searchSerpapiURL(); got != "http://127.0.0.1:9999" {
		t.Fatalf("seam override = %q, want the trimmed override", got)
	}
}

func TestPinnedNodeSearchRoutes(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-search.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture searchFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("search oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Inputs.Scenarios) == 0 || len(fixture.Inputs.Scenarios) != len(fixture.Observations) {
		t.Fatalf("search oracle has %d scenarios but %d observations", len(fixture.Inputs.Scenarios), len(fixture.Observations))
	}
	verifySearchClassification(t, fixture)
	if len(fixture.KnownDifferences) == 0 {
		t.Fatal("the search oracle must record that /api/search/visit is deliberately absent")
	}

	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	handler, sessionCookie, token := newSDRouteHandler(t, dataRoot, installRoot, fixture.Inputs.CookieSecret, fixture.Inputs.Account)

	peer := mockprovider.NewKeyed(nil)
	address, err := peer.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	mockOrigin := "http://" + address.String()
	mockAuthority := address.String()

	for environmentName := range fixture.Inputs.SeamDefaults {
		t.Setenv(environmentName, "")
	}

	for _, name := range sortedKeys(fixture.Inputs.Scenarios) {
		scenario := fixture.Inputs.Scenarios[name]
		observation, exists := fixture.Observations[name]
		if !exists {
			t.Fatalf("%s: no recorded observation", name)
		}
		for environmentName := range fixture.Inputs.SeamDefaults {
			t.Setenv(environmentName, "")
		}
		if scenario.Seam != nil {
			if _, known := fixture.Inputs.SeamDefaults[*scenario.Seam]; !known {
				t.Fatalf("%s: unknown seam %q", name, *scenario.Seam)
			}
			t.Setenv(*scenario.Seam, mockOrigin)
		}
		writeSDSecrets(t, dataRoot, fixture.Inputs.Account.Handle, scenario.Secrets)
		peer.Reset(searchPeerScript(scenario.Upstream, mockOrigin))

		body := searchRequestBody(t, scenario.Body, mockOrigin)
		request := httptest.NewRequest(http.MethodPost, "/api/search/"+scenario.Route, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		compareSearchResponse(t, name, observation, recorder, mockOrigin)
		compareSearchOutbound(t, name, fixture, observation, peer.Recording().Requests, mockOrigin, mockAuthority)
		if unused := peer.Unused(); len(unused) > 0 {
			t.Fatalf("%s: the peer script was not fully consumed; unused %v", name, unused)
		}
	}

	// The one deliberately absent route must stay absent rather than be faked.
	visit := httptest.NewRecorder()
	visitRequest := httptest.NewRequest(http.MethodPost, "/api/search/visit", strings.NewReader(`{"url":"https://example.com"}`))
	visitRequest.Header.Set("Content-Type", "application/json")
	visitRequest.Header.Set("Cookie", sessionCookie)
	visitRequest.Header.Set("X-CSRF-Token", token)
	handler.ServeHTTP(visit, visitRequest)
	if visit.Code != http.StatusNotFound {
		t.Fatalf("POST /api/search/visit = %d, want the final 404 while the SSRF transport policy is absent", visit.Code)
	}
}

func verifySearchClassification(t *testing.T, fixture searchFixture) {
	t.Helper()
	comparedAnywhere := map[string]bool{}
	for name, observation := range fixture.Observations {
		classified := map[string]bool{}
		for _, key := range observation.Comparison.Compared {
			classified[key] = true
			comparedAnywhere[key] = true
		}
		for _, key := range observation.Comparison.Shape {
			classified[key] = true
			if strings.TrimSpace(observation.Comparison.ShapeReason[key]) == "" {
				t.Fatalf("%s: shape field %q has no reason", name, key)
			}
		}
		for _, key := range searchObservableKeys {
			if !classified[key] {
				t.Fatalf("%s: observable %q is neither compared nor shape-classified", name, key)
			}
		}
		if !classified["status"] || !classified["outbound"] {
			t.Fatalf("%s: status and outbound must be compared for every scenario", name)
		}
	}
	for _, key := range []string{"contentType", "contentLength", "etag", "body"} {
		if !comparedAnywhere[key] {
			t.Fatalf("observable %q is never compared, so the suite cannot prove it", key)
		}
	}
}

func searchRequestBody(t *testing.T, body map[string]json.RawMessage, mockOrigin string) string {
	t.Helper()
	prepared := make(map[string]json.RawMessage, len(body))
	for key, value := range body {
		var text string
		if json.Unmarshal(value, &text) == nil {
			prepared[key] = mustMarshalRaw(t, strings.ReplaceAll(text, "<mock>", mockOrigin))
			continue
		}
		prepared[key] = value
	}
	encoded, err := marshalNodeJSON(prepared)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func searchPeerScript(upstream []searchUpstream, mockOrigin string) map[string][]mockprovider.Response {
	script := map[string][]mockprovider.Response{}
	for _, item := range upstream {
		names := make([]string, 0, len(item.Headers))
		for header := range item.Headers {
			names = append(names, header)
		}
		sort.Strings(names)
		headers := make([]mockprovider.Header, 0, len(names))
		for _, header := range names {
			headers = append(headers, mockprovider.Header{Name: header, Value: item.Headers[header]})
		}
		key := item.Method + " " + item.Path
		script[key] = append(script[key], mockprovider.Response{
			Status: item.Status, Headers: headers, Body: strings.ReplaceAll(item.Body, "<mock>", mockOrigin),
		})
	}
	return script
}

func compareSearchResponse(t *testing.T, name string, observation searchObservation, recorder *httptest.ResponseRecorder, mockOrigin string) {
	t.Helper()
	compared := map[string]bool{}
	for _, key := range observation.Comparison.Compared {
		compared[key] = true
	}
	if compared["status"] && recorder.Code != observation.Status {
		t.Fatalf("%s: status = %d, pinned Node has %d (body %q)", name, recorder.Code, observation.Status, recorder.Body.String())
	}
	if compared["contentType"] {
		compareOptionalHeader(t, name, "content-type", observation.ContentType, recorder.Header().Get("Content-Type"))
	}
	if compared["contentLength"] {
		compareOptionalHeader(t, name, "content-length", observation.ContentLength, recorder.Header().Get("Content-Length"))
	}
	if compared["etag"] {
		compareOptionalHeader(t, name, "etag", observation.Etag, recorder.Header().Get("ETag"))
	}
	if compared["body"] {
		got := strings.ReplaceAll(recorder.Body.String(), mockOrigin, "<mock>")
		if got != observation.Body {
			t.Fatalf("%s: body = %q, pinned Node has %q", name, got, observation.Body)
		}
	}
}

// compareSearchOutbound reconstructs the pinned wire header list and compares it with what the
// local peer actually received.
func compareSearchOutbound(t *testing.T, name string, fixture searchFixture, observation searchObservation, recorded []mockprovider.Request, mockOrigin, mockAuthority string) {
	t.Helper()
	if len(recorded) != len(observation.Outbound) {
		t.Fatalf("%s: peer received %d requests, pinned Node made %d", name, len(recorded), len(observation.Outbound))
	}
	for index, expected := range observation.Outbound {
		actual := recorded[index]
		if actual.Method != expected.Method {
			t.Fatalf("%s: request %d method = %s, pinned Node sent %s", name, index, actual.Method, expected.Method)
		}
		wantTarget := searchExpectedTarget(t, expected.URL)
		if actual.RawTarget != wantTarget {
			t.Fatalf("%s: request %d target = %q, pinned Node sent %q", name, index, actual.RawTarget, wantTarget)
		}
		wantHeaders := searchExpectedWireHeaders(fixture, expected, mockAuthority)
		compareSearchHeaderLines(t, name, index, wantHeaders, actual.Headers, searchExplicitlySetsConnection(expected))
		actualBody := ""
		if actual.BodyText != nil {
			actualBody = *actual.BodyText
		}
		wantBody := strings.ReplaceAll(expected.Body, "<mock>", mockOrigin)
		if actualBody != wantBody {
			t.Fatalf("%s: request %d body = %q, pinned Node sent %q", name, index, actualBody, wantBody)
		}
	}
}

func searchExpectedTarget(t *testing.T, fixtureURL string) string {
	t.Helper()
	if strings.HasPrefix(fixtureURL, "<mock>") {
		return strings.TrimPrefix(fixtureURL, "<mock>")
	}
	parsed, err := url.Parse(fixtureURL)
	if err != nil {
		t.Fatalf("fixture outbound url %q: %v", fixtureURL, err)
	}
	target := parsed.EscapedPath()
	if target == "" {
		target = "/"
	}
	if parsed.RawQuery != "" {
		target += "?" + parsed.RawQuery
	}
	return target
}

// searchExpectedWireHeaders builds the header lines node-fetch would write for one recorded
// request: lowercased names sorted, its defaults when the route did not set them, Content-Length
// for a body, then Host and — only when the route did not set Connection — the transport's
// Connection. The defaults are the fixture's recorded node-fetch values, asserted against every
// request, not re-derived from memory.
func searchExpectedWireHeaders(fixture searchFixture, expected searchOutbound, mockAuthority string) [][2]string {
	values := map[string]string{}
	for _, header := range fixture.NodeFetchWireDefaults.Headers {
		values[header[0]] = header[1]
	}
	if expected.Body != "" {
		values["content-length"] = strconv.Itoa(len(expected.Body))
	}
	for _, header := range expected.Headers {
		values[strings.ToLower(header[0])] = header[1]
	}
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	lines := make([][2]string, 0, len(names)+2)
	for _, name := range names {
		lines = append(lines, [2]string{name, values[name]})
	}
	lines = append(lines, [2]string{"Host", mockAuthority})
	return lines
}

// searchExplicitlySetsConnection reports whether the route itself set the Connection header. When
// it did, the fixture's explicit header list carries it and it is compared. When it did not, the
// transport adds one, which the fixture classifies as shape: only its presence is asserted.
func searchExplicitlySetsConnection(expected searchOutbound) bool {
	for _, header := range expected.Headers {
		if strings.EqualFold(header[0], "connection") {
			return true
		}
	}
	return false
}

func compareSearchHeaderLines(t *testing.T, name string, index int, want [][2]string, got []mockprovider.Header, explicitConnection bool) {
	t.Helper()
	if explicitConnection {
		// The route set Connection itself, so no transport Connection may be added on top.
		count := 0
		for _, header := range got {
			if strings.EqualFold(header.Name, "connection") {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("%s: request %d sent %d connection header lines, want exactly the route-set one", name, index, count)
		}
	} else {
		// The transport adds Connection; the fixture classifies it as shape, so only presence is
		// asserted and it is removed before the ordered comparison.
		filtered := make([]mockprovider.Header, 0, len(got))
		found := false
		for _, header := range got {
			if strings.EqualFold(header.Name, "connection") {
				if found {
					t.Fatalf("%s: request %d sent more than one transport connection header", name, index)
				}
				found = true
				continue
			}
			filtered = append(filtered, header)
		}
		if !found {
			t.Fatalf("%s: request %d sent no connection header", name, index)
		}
		got = filtered
	}
	if len(got) != len(want) {
		t.Fatalf("%s: request %d sent %d header lines, pinned Node sent %d: got %v want %v", name, index, len(got), len(want), got, want)
	}
	for position := range want {
		if got[position].Name != want[position][0] || got[position].Value != want[position][1] {
			t.Fatalf("%s: request %d header %d = %q: %q, pinned Node sent %q: %q",
				name, index, position, got[position].Name, got[position].Value, want[position][0], want[position][1])
		}
	}
}
