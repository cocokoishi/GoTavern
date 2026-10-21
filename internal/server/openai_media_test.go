package server

// Replay of the pinned OpenAI media routes implemented this round. The oracle is
// tests/oracle/sillytavern-1.19.0-openai-media.json recorded by tools/probe-openai-media.mjs from
// the pinned server with node-fetch replaced by a controlled peer.
//
// Binary bodies are compared as base64 + SHA-256 + byte length, never as text. Every outbound
// request is compared (method, target, wire headers, body). The single shape field is the transport
// Connection header (presence only). The one rejected-fetch scenario is replayed through a real
// closed port and asserts both the response and that the recording peer received nothing.

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
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

type openaiMediaFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	NodeFetchWireDefaults struct {
		Headers [][2]string `json:"headers"`
	} `json:"nodeFetchWireDefaults"`
	Inputs struct {
		CookieSecret string                         `json:"cookieSecret"`
		Account      sdFixtureAccount               `json:"account"`
		SeamDefaults map[string]string              `json:"seamDefaults"`
		Scenarios    map[string]openaiMediaScenario `json:"scenarios"`
	} `json:"inputs"`
	Observations     map[string]openaiMediaObservation `json:"observations"`
	KnownDifferences []map[string]any                  `json:"knownDifferences"`
}

type openaiMediaScenario struct {
	Route    string             `json:"route"`
	BodyText string             `json:"bodyText"`
	Seam     *string            `json:"seam"`
	Peer     string             `json:"peer"`
	Secrets  map[string]string  `json:"secrets"`
	Upstream []backendsUpstream `json:"upstream"`
}

type openaiMediaObservation struct {
	Status        int              `json:"status"`
	ContentType   *string          `json:"contentType"`
	ContentLength *string          `json:"contentLength"`
	Etag          *string          `json:"etag"`
	BodyBase64    string           `json:"bodyBase64"`
	BodySha256    string           `json:"bodySha256"`
	BodyLength    int              `json:"bodyLength"`
	Outbound      []searchOutbound `json:"outbound"`
	Comparison    searchComparison `json:"comparison"`
}

var openaiMediaObservableKeys = []string{"status", "contentType", "contentLength", "etag", "bodyBase64", "bodySha256", "bodyLength", "outbound"}

func TestOpenAIMediaSeamDefaults(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-openai-media.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture openaiMediaFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	accessors := map[string]func() string{
		"GOTAVERN_OPENAI_API_URL":         openaiMediaAPIURL,
		"GOTAVERN_OPENAI_ELECTRONHUB_URL": openaiMediaElectronHubURL,
		"GOTAVERN_OPENAI_CHUTES_TTS_URL":  openaiMediaChutesTTSURL,
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

func TestPinnedNodeOpenAIMediaRoutes(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-openai-media.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture openaiMediaFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("openai media oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Inputs.Scenarios) != len(fixture.Observations) || len(fixture.Inputs.Scenarios) == 0 {
		t.Fatalf("openai media oracle has %d scenarios and %d observations", len(fixture.Inputs.Scenarios), len(fixture.Observations))
	}
	verifyOpenAIMediaClassification(t, fixture)

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
		"generate-voice":             "GOTAVERN_OPENAI_API_URL",
		"generate-image":             "GOTAVERN_OPENAI_API_URL",
		"electronhub/generate-voice": "GOTAVERN_OPENAI_ELECTRONHUB_URL",
		"chutes/generate-voice":      "GOTAVERN_OPENAI_CHUTES_TTS_URL",
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
		} else if scenario.Seam != nil {
			t.Setenv(*scenario.Seam, targetOrigin)
		}
		peer.Reset(openaiMediaPeerScript(t, name, scenario, observation, mockOrigin))
		writeSDSecrets(t, dataRoot, fixture.Inputs.Account.Handle, scenario.Secrets)
		body := strings.ReplaceAll(scenario.BodyText, "<mock>", mockOrigin)
		request := httptest.NewRequest(http.MethodPost, "/api/openai/"+scenario.Route, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		compareOpenAIMediaResponse(t, name, observation, recorder)
		recorded := peer.Recording().Requests
		if scenario.Peer == "closed" {
			if len(recorded) != 0 {
				t.Fatalf("%s: closed-peer scenario reached the recording peer %d time(s)", name, len(recorded))
			}
			continue
		}
		compareOpenAIMediaOutbound(t, name, fixture, observation, recorded, mockOrigin, mockAuthority)
		if unused := peer.Unused(); len(unused) > 0 {
			t.Fatalf("%s: peer script not fully consumed; unused %v", name, unused)
		}
	}
}

func verifyOpenAIMediaClassification(t *testing.T, fixture openaiMediaFixture) {
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
		for _, key := range openaiMediaObservableKeys {
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

func openaiMediaPeerScript(t *testing.T, name string, scenario openaiMediaScenario, observation openaiMediaObservation, mockOrigin string) map[string][]mockprovider.Response {
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
		script[key] = append(script[key], mockprovider.Response{
			Status: item.Status, Headers: headers, Body: strings.ReplaceAll(item.Body, "<mock>", mockOrigin),
		})
	}
	return script
}

func compareOpenAIMediaResponse(t *testing.T, name string, observation openaiMediaObservation, recorder *httptest.ResponseRecorder) {
	t.Helper()
	compared := map[string]bool{}
	for _, key := range observation.Comparison.Compared {
		compared[key] = true
	}
	if recorder.Code != observation.Status {
		t.Fatalf("%s: status = %d, pinned Node has %d (body %q)", name, recorder.Code, observation.Status, recorder.Body.String())
	}
	compareOptionalHeader(t, name, "content-type", observation.ContentType, recorder.Header().Get("Content-Type"))
	compareOptionalHeader(t, name, "content-length", observation.ContentLength, recorder.Header().Get("Content-Length"))
	compareOptionalHeader(t, name, "etag", observation.Etag, recorder.Header().Get("ETag"))
	if compared["bodyBase64"] {
		body := recorder.Body.Bytes()
		if int64(len(body)) != int64(observation.BodyLength) {
			t.Fatalf("%s: body length = %d, pinned Node has %d", name, len(body), observation.BodyLength)
		}
		if encodeBase64ForTest(body) != observation.BodyBase64 {
			t.Fatalf("%s: body base64 differs from pinned Node", name)
		}
		if sha256ForTest(body) != observation.BodySha256 {
			t.Fatalf("%s: body SHA-256 differs from pinned Node", name)
		}
	}
}

func encodeBase64ForTest(body []byte) string {
	return base64.StdEncoding.EncodeToString(body)
}

func sha256ForTest(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func compareOpenAIMediaOutbound(t *testing.T, name string, fixture openaiMediaFixture, observation openaiMediaObservation, recorded []mockprovider.Request, mockOrigin, mockAuthority string) {
	t.Helper()
	if len(recorded) != len(observation.Outbound) {
		t.Fatalf("%s: peer received %d requests, pinned Node made %d", name, len(recorded), len(observation.Outbound))
	}
	for index, expected := range observation.Outbound {
		actual := recorded[index]
		if actual.Method != expected.Method {
			t.Fatalf("%s: request %d method = %s, pinned Node sent %s", name, index, actual.Method, expected.Method)
		}
		if actual.RawTarget != searchExpectedTarget(t, expected.URL) {
			t.Fatalf("%s: request %d target = %q, pinned Node sent %q", name, index, actual.RawTarget, searchExpectedTarget(t, expected.URL))
		}
		wantBody := strings.ReplaceAll(expected.Body, "<mock>", mockOrigin)
		actualBody := ""
		if actual.BodyText != nil {
			actualBody = *actual.BodyText
		}
		if actualBody != wantBody {
			t.Fatalf("%s: request %d body = %q, pinned Node sent %q", name, index, actualBody, wantBody)
		}
		wantHeaders := openaiMediaExpectedWireHeaders(fixture, expected, wantBody, mockAuthority)
		compareBackendsHeaderLines(t, name, index, wantHeaders, actual.Headers, backendsExplicitConnection(expected))
	}
}

func openaiMediaExpectedWireHeaders(fixture openaiMediaFixture, expected searchOutbound, materializedBody, mockAuthority string) [][2]string {
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
