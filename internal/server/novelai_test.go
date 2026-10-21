package server

// Replay of the pinned NovelAI routes implemented this round against
// tests/oracle/sillytavern-1.19.0-novelai.json (recorded by tools/probe-novelai.mjs).
// Voice bodies are compared as base64 + SHA-256 + byte length, never as text. Rejected-fetch
// scenarios are replayed through a real closed port and assert the recording peer saw nothing.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

type novelaiFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	NodeFetchWireDefaults struct {
		Headers [][2]string `json:"headers"`
	} `json:"nodeFetchWireDefaults"`
	Inputs struct {
		CookieSecret string                     `json:"cookieSecret"`
		Account      sdFixtureAccount           `json:"account"`
		SeamDefaults map[string]string          `json:"seamDefaults"`
		Scenarios    map[string]novelaiScenario `json:"scenarios"`
	} `json:"inputs"`
	Observations     map[string]novelaiObservation `json:"observations"`
	KnownDifferences []map[string]any              `json:"knownDifferences"`
}

type novelaiScenario struct {
	Route    string             `json:"route"`
	BodyText string             `json:"bodyText"`
	Peer     string             `json:"peer"`
	Secrets  map[string]string  `json:"secrets"`
	Upstream []backendsUpstream `json:"upstream"`
}

type novelaiObservation struct {
	Status        int              `json:"status"`
	ContentType   *string          `json:"contentType"`
	ContentLength *string          `json:"contentLength"`
	Etag          *string          `json:"etag"`
	BodyBase64    string           `json:"bodyBase64"`
	BodySha256    string           `json:"bodySha256"`
	BodyLength    int              `json:"bodyLength"`
	BodyJSON      json.RawMessage  `json:"bodyJson"`
	Outbound      []searchOutbound `json:"outbound"`
	Comparison    searchComparison `json:"comparison"`
}

var novelaiObservableKeys = []string{"status", "contentType", "contentLength", "etag", "bodyBase64", "bodySha256", "bodyLength", "outbound"}

func TestNovelAISeamDefaults(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-novelai.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture novelaiFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	accessors := map[string]func() string{
		"GOTAVERN_NOVELAI_IMAGE_URL": novelaiImageURL,
		"GOTAVERN_NOVELAI_API_URL":   novelaiAPIURL,
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
}

func TestPinnedNodeNovelAIRoutes(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-novelai.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture novelaiFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("novelai oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Inputs.Scenarios) != len(fixture.Observations) || len(fixture.Inputs.Scenarios) == 0 {
		t.Fatalf("novelai oracle has %d scenarios and %d observations", len(fixture.Inputs.Scenarios), len(fixture.Observations))
	}
	verifyNovelAIClassification(t, fixture)

	dataRoot := t.TempDir()
	handler, sessionCookie, token := newSDRouteHandler(t, dataRoot, t.TempDir(), fixture.Inputs.CookieSecret, fixture.Inputs.Account)
	peer := mockprovider.NewKeyed(nil)
	address, err := peer.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	mockOrigin := "http://" + address.String()
	mockAuthority := address.String()
	closedOrigin := closedLoopbackOrigin(t)

	for environmentName := range fixture.Inputs.SeamDefaults {
		t.Setenv(environmentName, "")
	}
	seamForRoute := map[string]string{
		"status":         "GOTAVERN_NOVELAI_IMAGE_URL",
		"generate-voice": "GOTAVERN_NOVELAI_API_URL",
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
		targetOrigin := mockOrigin
		if scenario.Peer == "closed" {
			targetOrigin = closedOrigin
		}
		if seam, ok := seamForRoute[scenario.Route]; ok {
			t.Setenv(seam, targetOrigin)
		}
		peer.Reset(novelaiPeerScript(t, name, scenario, observation, mockOrigin))
		writeSDSecrets(t, dataRoot, fixture.Inputs.Account.Handle, scenario.Secrets)
		request := httptest.NewRequest(http.MethodPost, "/api/novelai/"+scenario.Route, strings.NewReader(scenario.BodyText))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		compareNovelAIResponse(t, name, observation, recorder)
		recorded := peer.Recording().Requests
		if scenario.Peer == "closed" {
			if len(recorded) != 0 {
				t.Fatalf("%s: closed-peer scenario reached the recording peer %d time(s)", name, len(recorded))
			}
			continue
		}
		compareNovelAIOutbound(t, name, fixture, observation, recorded, mockOrigin, mockAuthority)
		if unused := peer.Unused(); len(unused) > 0 {
			t.Fatalf("%s: peer script not fully consumed; unused %v", name, unused)
		}
	}
}

func verifyNovelAIClassification(t *testing.T, fixture novelaiFixture) {
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
		for _, key := range novelaiObservableKeys {
			if !classified[key] {
				t.Fatalf("%s: observable %q is neither compared nor shape-classified", name, key)
			}
		}
		if !classified["bodyBase64"] || !classified["bodySha256"] {
			t.Fatalf("%s: the binary body must be compared", name)
		}
	}
	for _, key := range []string{"contentType", "contentLength", "etag", "bodyLength", "outbound"} {
		if !comparedAnywhere[key] {
			t.Fatalf("observable %q is never compared", key)
		}
	}
}

func novelaiPeerScript(t *testing.T, name string, scenario novelaiScenario, observation novelaiObservation, mockOrigin string) map[string][]mockprovider.Response {
	t.Helper()
	if len(scenario.Upstream) == 0 {
		return map[string][]mockprovider.Response{}
	}
	if len(scenario.Upstream) != len(observation.Outbound) {
		t.Fatalf("%s: %d upstream answers but %d outbound requests", name, len(scenario.Upstream), len(observation.Outbound))
	}
	script := map[string][]mockprovider.Response{}
	for index, item := range scenario.Upstream {
		method := observation.Outbound[index].Method
		// The keyed peer matches on the request path only (not the query), so voice answers are
		// keyed by the upstream path recorded in the fixture.
		pathValue := item.Path
		names := make([]string, 0, len(item.Headers))
		for header := range item.Headers {
			names = append(names, header)
		}
		sort.Strings(names)
		headers := make([]mockprovider.Header, 0, len(names))
		for _, header := range names {
			headers = append(headers, mockprovider.Header{Name: header, Value: item.Headers[header]})
		}
		key := method + " " + pathValue
		script[key] = append(script[key], mockprovider.Response{Status: item.Status, Headers: headers, Body: strings.ReplaceAll(item.Body, "<mock>", mockOrigin)})
	}
	return script
}

func compareNovelAIResponse(t *testing.T, name string, observation novelaiObservation, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if recorder.Code != observation.Status {
		t.Fatalf("%s: status = %d, pinned Node has %d (body %q)", name, recorder.Code, observation.Status, recorder.Body.String())
	}
	compareOptionalHeader(t, name, "content-type", observation.ContentType, recorder.Header().Get("Content-Type"))
	compareOptionalHeader(t, name, "content-length", observation.ContentLength, recorder.Header().Get("Content-Length"))
	compareOptionalHeader(t, name, "etag", observation.Etag, recorder.Header().Get("ETag"))
	body := recorder.Body.Bytes()
	if len(body) != observation.BodyLength {
		t.Fatalf("%s: body length = %d, pinned Node has %d", name, len(body), observation.BodyLength)
	}
	if encodeBase64ForTest(body) != observation.BodyBase64 {
		t.Fatalf("%s: body base64 differs from pinned Node", name)
	}
	if sha256ForTest(body) != observation.BodySha256 {
		t.Fatalf("%s: body SHA-256 differs from pinned Node", name)
	}
}

func compareNovelAIOutbound(t *testing.T, name string, fixture novelaiFixture, observation novelaiObservation, recorded []mockprovider.Request, mockOrigin, mockAuthority string) {
	t.Helper()
	if len(recorded) != len(observation.Outbound) {
		t.Fatalf("%s: peer received %d requests, pinned Node made %d", name, len(recorded), len(observation.Outbound))
	}
	for index, expected := range observation.Outbound {
		actual := recorded[index]
		if actual.Method != expected.Method {
			t.Fatalf("%s: request %d method = %s, pinned Node sent %s", name, index, actual.Method, expected.Method)
		}
		parsed, parseErr := parseExpectedTarget(expected.URL)
		if parseErr != nil {
			t.Fatalf("%s: fixture URL %q: %v", name, expected.URL, parseErr)
		}
		if actual.RawTarget != parsed {
			t.Fatalf("%s: request %d target = %q, pinned Node sent %q", name, index, actual.RawTarget, parsed)
		}
		wantHeaders := novelaiExpectedWireHeaders(fixture, expected, mockAuthority)
		compareBackendsHeaderLines(t, name, index, wantHeaders, actual.Headers, backendsExplicitConnection(expected))
	}
}

// parseExpectedTarget turns the recorded absolute URL into the raw path and query the peer sees.
func parseExpectedTarget(rawURL string) (string, error) {
	index := strings.Index(rawURL, "://")
	if index < 0 {
		return rawURL, nil
	}
	rest := rawURL[index+3:]
	slash := strings.Index(rest, "/")
	if slash < 0 {
		return "/", nil
	}
	return rest[slash:], nil
}

func novelaiExpectedWireHeaders(fixture novelaiFixture, expected searchOutbound, mockAuthority string) [][2]string {
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
	lines := make([][2]string, 0, len(names)+1)
	for _, name := range names {
		lines = append(lines, [2]string{name, values[name]})
	}
	lines = append(lines, [2]string{"Host", mockAuthority})
	return lines
}
