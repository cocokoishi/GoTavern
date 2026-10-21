package server

// Replay of the pinned NanoGPT credits route against
// tests/oracle/sillytavern-1.19.0-nanogpt.json (recorded by tools/probe-nanogpt.mjs).
//
// The route issues two concurrent provider requests (Promise.allSettled), so their recording order
// is not deterministic: the fixture classifies order as shape and both sides compare the request
// SET (method, target, wire headers, body). Every response field, including the body bytes and
// SHA-256, is compared; rejected-fetch scenarios are replayed through a real closed port and assert
// the peer received nothing.

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

type nanogptFixture struct {
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
		Scenarios    map[string]nanogptScenario `json:"scenarios"`
	} `json:"inputs"`
	Observations     map[string]nanogptObservation `json:"observations"`
	KnownDifferences []map[string]any              `json:"knownDifferences"`
}

type nanogptScenario struct {
	Route    string             `json:"route"`
	BodyText string             `json:"bodyText"`
	Peer     string             `json:"peer"`
	Secrets  map[string]string  `json:"secrets"`
	Upstream []backendsUpstream `json:"upstream"`
}

type nanogptObservation struct {
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

var nanogptObservableKeys = []string{"status", "contentType", "contentLength", "etag", "bodyBase64", "bodySha256", "bodyLength", "outbound"}

func TestNanoGPTSeamDefaults(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-nanogpt.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture nanogptFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Inputs.SeamDefaults) != 2 {
		t.Fatalf("fixture records %d seam defaults, want the two NanoGPT API seams", len(fixture.Inputs.SeamDefaults))
	}
	for environmentName, defaultValue := range fixture.Inputs.SeamDefaults {
		t.Setenv(environmentName, "")
		var got string
		switch environmentName {
		case "GOTAVERN_NANOGPT_CREDITS_URL":
			got = nanogptCreditsAPIURL()
		case "GOTAVERN_NANOGPT_PROVIDERS_URL":
			got = nanogptProvidersAPIURL()
		default:
			t.Fatalf("fixture records unknown seam %q", environmentName)
		}
		if got != defaultValue {
			t.Fatalf("%s default = %q, pinned literal %q", environmentName, got, defaultValue)
		}
	}
}

func TestPinnedNodeNanoGPTCredits(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-nanogpt.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture nanogptFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("nanogpt oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Inputs.Scenarios) != len(fixture.Observations) || len(fixture.Inputs.Scenarios) == 0 {
		t.Fatalf("nanogpt oracle has %d scenarios and %d observations", len(fixture.Inputs.Scenarios), len(fixture.Observations))
	}
	verifyNanoGPTClassification(t, fixture)
	verifyNanoGPTDiscriminating(t, fixture)

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
	// Each route has its own seam, and the seam replaces the whole pinned base including the "/api"
	// path segment; fixture targets therefore have the seam default's base path removed before
	// comparison.
	basePaths := map[string]string{}
	for _, environmentName := range []string{"GOTAVERN_NANOGPT_CREDITS_URL", "GOTAVERN_NANOGPT_PROVIDERS_URL"} {
		if parsed, err := url.Parse(fixture.Inputs.SeamDefaults[environmentName]); err == nil {
			basePaths[environmentName] = strings.TrimSuffix(parsed.Path, "/")
		}
		t.Setenv(environmentName, "")
	}
	expectedTarget := func(environmentName, rawURL string) string {
		target, err := parseExpectedTarget(rawURL)
		if err != nil {
			t.Fatalf("fixture URL %q: %v", rawURL, err)
		}
		if basePath := basePaths[environmentName]; basePath != "" && strings.HasPrefix(target, basePath) {
			target = strings.TrimPrefix(target, basePath)
			if target == "" {
				target = "/"
			}
		}
		return target
	}

	for _, name := range sortedKeys(fixture.Inputs.Scenarios) {
		scenario := fixture.Inputs.Scenarios[name]
		observation, exists := fixture.Observations[name]
		if !exists {
			t.Fatalf("%s: no recorded observation", name)
		}
		route := scenario.Route
		if route == "" {
			route = "credits"
		}
		seam := "GOTAVERN_NANOGPT_CREDITS_URL"
		if route == "models/providers" {
			seam = "GOTAVERN_NANOGPT_PROVIDERS_URL"
		} else if route != "credits" {
			t.Fatalf("%s: unknown route %q", name, route)
		}
		targetOrigin := mockOrigin
		if scenario.Peer == "closed" {
			targetOrigin = closedOrigin
		}
		t.Setenv(seam, targetOrigin)
		peer.Reset(nanogptPeerScript(t, name, scenario, observation, mockOrigin))
		writeSDSecrets(t, dataRoot, fixture.Inputs.Account.Handle, scenario.Secrets)
		request := httptest.NewRequest(http.MethodPost, "/api/nanogpt/"+route, strings.NewReader(scenario.BodyText))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		compareNanoGPTResponse(t, name, observation, recorder)
		recorded := peer.Recording().Requests
		if scenario.Peer == "closed" {
			if len(recorded) != 0 {
				t.Fatalf("%s: closed-peer scenario reached the recording peer %d time(s)", name, len(recorded))
			}
			continue
		}
		compareNanoGPTOutboundSet(t, name, fixture, observation, recorded, mockOrigin, mockAuthority, func(rawURL string) string {
			return expectedTarget(seam, rawURL)
		})
		if unused := peer.Unused(); len(unused) > 0 {
			t.Fatalf("%s: peer script not fully consumed; unused %v", name, unused)
		}
	}
}

func verifyNanoGPTClassification(t *testing.T, fixture nanogptFixture) {
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
		for _, key := range nanogptObservableKeys {
			if !classified[key] {
				t.Fatalf("%s: observable %q is neither compared nor shape-classified", name, key)
			}
		}
		if !classified["bodyBase64"] || !classified["bodySha256"] {
			t.Fatalf("%s: the body bytes must be compared", name)
		}
	}
	for _, key := range []string{"contentType", "contentLength", "etag", "bodyLength", "outbound"} {
		if !comparedAnywhere[key] {
			t.Fatalf("observable %q is never compared", key)
		}
	}
}

// verifyNanoGPTDiscriminating refuses to run unless the fixture can actually fail: it must contain
// a scenario with a non-null subscription and one with a null subscription, an upstream-failure
// status, and at least one scenario where BOTH provider requests were issued.
func verifyNanoGPTDiscriminating(t *testing.T, fixture nanogptFixture) {
	t.Helper()
	sawSubscription := false
	sawNullSubscription := false
	sawServerError := false
	sawTwoOutbound := false
	for _, observation := range fixture.Observations {
		var body struct {
			Subscription json.RawMessage `json:"subscription"`
		}
		if len(observation.BodyJSON) > 0 && json.Unmarshal(observation.BodyJSON, &body) == nil {
			if string(body.Subscription) == "null" {
				sawNullSubscription = true
			} else if len(body.Subscription) > 0 {
				sawSubscription = true
			}
		}
		if observation.Status == 500 {
			sawServerError = true
		}
		if len(observation.Outbound) == 2 {
			sawTwoOutbound = true
		}
	}
	if !sawSubscription || !sawNullSubscription || !sawServerError || !sawTwoOutbound {
		t.Fatalf("nanogpt fixture is not discriminating: subscription=%v nullSubscription=%v serverError=%v twoOutbound=%v",
			sawSubscription, sawNullSubscription, sawServerError, sawTwoOutbound)
	}
}

func nanogptPeerScript(t *testing.T, name string, scenario nanogptScenario, observation nanogptObservation, mockOrigin string) map[string][]mockprovider.Response {
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
		names := make([]string, 0, len(item.Headers))
		for header := range item.Headers {
			names = append(names, header)
		}
		sort.Strings(names)
		headers := make([]mockprovider.Header, 0, len(names))
		for _, header := range names {
			headers = append(headers, mockprovider.Header{Name: header, Value: item.Headers[header]})
		}
		key := method + " " + item.Path
		script[key] = append(script[key], mockprovider.Response{Status: item.Status, Headers: headers, Body: strings.ReplaceAll(item.Body, "<mock>", mockOrigin)})
	}
	return script
}

func compareNanoGPTResponse(t *testing.T, name string, observation nanogptObservation, recorder *httptest.ResponseRecorder) {
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

type nanogptRecordedRequest struct {
	method  string
	target  string
	headers []mockprovider.Header
	body    string
}

func nanogptExpectedWireHeaders(fixture nanogptFixture, expected searchOutbound, materializedBody, mockAuthority string) [][2]string {
	values := map[string]string{}
	for _, header := range fixture.NodeFetchWireDefaults.Headers {
		values[header[0]] = header[1]
	}
	if materializedBody != "" {
		values["content-length"] = strconv.Itoa(len(materializedBody))
	}
	for _, header := range expected.Headers {
		values[strings.ToLower(header[0])] = header[1]
	}
	names := make([]string, 0, len(values))
	for header := range values {
		names = append(names, header)
	}
	sort.Strings(names)
	lines := make([][2]string, 0, len(names)+1)
	for _, header := range names {
		lines = append(lines, [2]string{header, values[header]})
	}
	lines = append(lines, [2]string{"Host", mockAuthority})
	return lines
}

func nanogptSortedRecorded(t *testing.T, name string, requests []mockprovider.Request, mockOrigin string) []nanogptRecordedRequest {
	t.Helper()
	result := make([]nanogptRecordedRequest, 0, len(requests))
	for _, request := range requests {
		body := ""
		if request.BodyText != nil {
			body = *request.BodyText
		}
		result = append(result, nanogptRecordedRequest{method: request.Method, target: request.RawTarget, headers: request.Headers, body: body})
	}
	sort.Slice(result, func(left, right int) bool {
		return result[left].method+" "+result[left].target < result[right].method+" "+result[right].target
	})
	return result
}

func compareNanoGPTOutboundSet(t *testing.T, name string, fixture nanogptFixture, observation nanogptObservation, recorded []mockprovider.Request, mockOrigin, mockAuthority string, expectedTarget func(string) string) {
	t.Helper()
	if len(recorded) != len(observation.Outbound) {
		t.Fatalf("%s: peer received %d requests, pinned Node made %d", name, len(recorded), len(observation.Outbound))
	}
	expected := make([]searchOutbound, len(observation.Outbound))
	copy(expected, observation.Outbound)
	sort.Slice(expected, func(left, right int) bool {
		return expected[left].Method+" "+expectedTarget(expected[left].URL) < expected[right].Method+" "+expectedTarget(expected[right].URL)
	})
	actual := nanogptSortedRecorded(t, name, recorded, mockOrigin)
	for index := range expected {
		wantTarget := expectedTarget(expected[index].URL)
		if actual[index].method != expected[index].Method {
			t.Fatalf("%s: request %d method = %s, pinned Node sent %s", name, index, actual[index].method, expected[index].Method)
		}
		if actual[index].target != wantTarget {
			t.Fatalf("%s: request %d target = %q, pinned Node sent %q", name, index, actual[index].target, wantTarget)
		}
		wantBody := strings.ReplaceAll(expected[index].Body, "<mock>", mockOrigin)
		if actual[index].body != wantBody {
			t.Fatalf("%s: request %d body = %q, pinned Node sent %q", name, index, actual[index].body, wantBody)
		}
		wantHeaders := nanogptExpectedWireHeaders(fixture, expected[index], wantBody, mockAuthority)
		compareBackendsHeaderLines(t, name, index, wantHeaders, actual[index].headers, backendsExplicitConnection(expected[index]))
	}
}
