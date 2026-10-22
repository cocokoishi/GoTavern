package server

// Replay of the two pinned NovelAI generation routes against
// tests/oracle/sillytavern-1.19.0-novelai-generate.json (recorded by
// tools/probe-novelai-generate.mjs).
//
// What this file asserts, and why each part is here rather than in novelai_test.go:
//
//   - the response is compared through a REAL listener (httptest.NewServer), not a recorder, because
//     FRAMING is part of the contract: the forwarded SSE branch must answer chunk-framed with no
//     content-length and no content-type, while the non-stream control answers length-delimited JSON.
//     A recorder cannot express that difference, and a buffered capture would look identical.
//   - the OUTBOUND COUNT is an assertion. /api/novelai/generate-image makes a SECOND request to
//     /ai/upscale only in some branches, so a no-upscale branch that made two requests, or an upscale
//     branch that made one, has to fail here rather than pass silently.
//   - every failure that the pinned route reaches through a rejected fetch is replayed through a real
//     CLOSED PORT, and the recording peer must have seen nothing, so "refused" and "never attempted"
//     stay distinguishable.
//   - the second upscale request failing while the first succeeds is the case a naive implementation
//     gets wrong, so generate-image.upscaleRejected points only the API seam at a closed port.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

type novelaiGenerateFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	NodeFetchWireDefaults struct {
		Headers [][2]string `json:"headers"`
	} `json:"nodeFetchWireDefaults"`
	Fields []struct {
		Path       string `json:"path"`
		Comparison string `json:"comparison"`
		Reason     string `json:"reason"`
	} `json:"fields"`
	ExcludedResponseHeaders []string          `json:"excludedResponseHeaders"`
	Normalizations          []string          `json:"normalizations"`
	NotRecorded             []string          `json:"notRecorded"`
	KnownDifferences        []map[string]any  `json:"knownDifferences"`
	BootOutbound            []json.RawMessage `json:"bootOutbound"`
	Inputs                  struct {
		CookieSecret string                             `json:"cookieSecret"`
		Account      sdFixtureAccount                   `json:"account"`
		SeamDefaults map[string]string                  `json:"seamDefaults"`
		NovelKey     string                             `json:"novelKey"`
		StreamFrames string                             `json:"streamFrames"`
		Scenarios    map[string]novelaiGenerateScenario `json:"scenarios"`
	} `json:"inputs"`
}

type novelaiGenerateScenario struct {
	Route                    string                    `json:"route"`
	RequestBody              string                    `json:"requestBody"`
	Peer                     string                    `json:"peer"`
	SecondPeer               string                    `json:"secondPeer"`
	Control                  string                    `json:"control"`
	Secrets                  map[string]string         `json:"secrets"`
	Upstream                 []novelaiGenerateUpstream `json:"upstream"`
	Response                 novelaiGenerateResponse   `json:"response"`
	Outbound                 []searchOutbound          `json:"outbound"`
	OutboundAttempts         int                       `json:"outboundAttempts"`
	OutboundRejectedAttempts int                       `json:"outboundRejectedAttempts"`
}

type novelaiGenerateUpstream struct {
	Path       string            `json:"path"`
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers"`
	BodyText   *string           `json:"bodyText"`
	BodyBase64 *string           `json:"bodyBase64"`
	BodyLength int               `json:"bodyLength"`
	Throws     bool              `json:"throws"`
}

type novelaiGenerateResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Framing struct {
		TransferEncoding *string `json:"transferEncoding"`
		ContentLength    *int    `json:"contentLength"`
	} `json:"framing"`
	Terminated string  `json:"terminated"`
	BodyBase64 string  `json:"bodyBase64"`
	BodySha256 string  `json:"bodySha256"`
	BodyLength int     `json:"bodyLength"`
	BodyText   *string `json:"bodyText"`
}

const novelaiGenerateFixturePath = "sillytavern-1.19.0-novelai-generate.json"

// novelaiGenerateObservableKeys is the list the fixture's `fields` classification must cover. A new
// observable that nobody classifies is a value the replay silently ignores, which is the failure this
// guard exists to make impossible.
var novelaiGenerateObservableKeys = []string{
	"response.status", "response.headers", "response.framing", "response.body",
	"response.terminated", "outbound", "outboundAttempts", "outboundRejectedAttempts",
}

func loadNovelaiGenerateFixture(t *testing.T) novelaiGenerateFixture {
	t.Helper()
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", novelaiGenerateFixturePath))
	if err != nil {
		t.Fatal(err)
	}
	var fixture novelaiGenerateFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("novelai generate oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Inputs.Scenarios) == 0 {
		t.Fatal("novelai generate oracle records no scenarios")
	}
	if len(fixture.BootOutbound) != 0 {
		t.Fatalf("the pinned boot made %d outbound requests; the fixture must record a clean boot", len(fixture.BootOutbound))
	}
	return fixture
}

// TestNovelAIGenerateSeamDefaults asserts that each seam the fixture names still defaults to the
// pinned literal. A seam whose default drifts changes production behaviour while every replay stays
// green against a mock.
func TestNovelAIGenerateSeamDefaults(t *testing.T) {
	fixture := loadNovelaiGenerateFixture(t)
	accessors := map[string]func() string{
		"GOTAVERN_NOVELAI_API_URL":   novelaiAPIURL,
		"GOTAVERN_NOVELAI_TEXT_URL":  novelaiTextURL,
		"GOTAVERN_NOVELAI_IMAGE_URL": novelaiImageURL,
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
	t.Logf("seam defaults asserted: %v", fixture.Inputs.SeamDefaults)
}

// TestNovelAIGenerateFixtureClassification refuses a fixture whose every observable is not classified
// with a reason, whose streaming evidence has gone missing, or whose non-stream control was dropped.
// Without the control a buffered capture cannot be told apart from a streamed one, so the control is
// part of the fixture's contract rather than an extra scenario.
func TestNovelAIGenerateFixtureClassification(t *testing.T) {
	fixture := loadNovelaiGenerateFixture(t)
	classified := map[string]bool{}
	for _, field := range fixture.Fields {
		if strings.TrimSpace(field.Reason) == "" {
			t.Fatalf("field %q has no reason", field.Path)
		}
		if field.Comparison != "compared" && field.Comparison != "shape" {
			t.Fatalf("field %q has unknown comparison %q", field.Path, field.Comparison)
		}
		classified[field.Path] = true
	}
	for _, key := range novelaiGenerateObservableKeys {
		found := false
		for path := range classified {
			if strings.Contains(path, key) {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("observable %q is neither compared nor shape-classified in `fields`", key)
		}
	}
	if len(fixture.NotRecorded) == 0 {
		t.Fatal("the fixture must state what it does not record")
	}
	if len(fixture.Normalizations) == 0 {
		t.Fatal("the fixture must state its normalizations; a masked random seed is one")
	}
	if len(fixture.KnownDifferences) == 0 {
		t.Fatal("the fixture must record the named deviations from pinned")
	}

	stream, hasStream := fixture.Inputs.Scenarios["generate.stream"]
	if !hasStream {
		t.Fatal("the fixture no longer records the forwarded SSE branch")
	}
	if stream.Response.Framing.TransferEncoding == nil || *stream.Response.Framing.TransferEncoding != "chunked" {
		t.Fatal("the recorded stream is not chunk-framed, so the streaming evidence is gone")
	}
	if stream.Response.Framing.ContentLength != nil {
		t.Fatal("the recorded stream declares a content-length, so it may be a buffered capture")
	}
	if stream.Response.Headers["content-type"] != "" {
		t.Fatal("the recorded stream carries a content type, which forwardFetchResponse never sets")
	}
	if stream.Response.BodyText == nil || *stream.Response.BodyText != fixture.Inputs.StreamFrames {
		t.Fatal("the recorded stream body is not the SSE frame set")
	}
	control, hasControl := fixture.Inputs.Scenarios["generate.nonStreamControl"]
	if !hasControl {
		t.Fatal("the fixture no longer records the non-stream control")
	}
	if control.Control != "non-stream" {
		t.Fatal("the control scenario is not labelled, so a reader cannot tell the two apart")
	}
	if control.Response.Framing.ContentLength == nil || control.Response.Headers["content-type"] == "" {
		t.Fatal("the control is not length-delimited JSON, so it cannot discriminate a buffered capture")
	}
	if control.Outbound[0].Body != stream.Outbound[0].Body {
		t.Fatal("the control and the stream must send the SAME upstream body")
	}
	t.Logf("scenarios: %d; stream framing: %s; control content-length: %d",
		len(fixture.Inputs.Scenarios), *stream.Response.Framing.TransferEncoding, *control.Response.Framing.ContentLength)
}

// novelaiGeneratePeer is one recording peer bound to ONE pinned host, so that the host the route
// chose is an observation rather than something the harness erases.
//
// WHY THIS EXISTS (it is a survivor's fix, not a tidy-up): the first version of this test pointed all
// three seams at a SINGLE peer, and mutation 3 (`baseURL = novelaiTextURL()` replaced by
// novelaiAPIURL(), run 39716853167) SURVIVED. Both seams resolved to the same origin, and the request
// target is compared as path+query only, so `api.novelai.net` and `text.novelai.net` were
// indistinguishable at the peer -- rule 15's vacuous assertion, in the one place the domain has a
// model-dependent host. With one peer per host, a request to the wrong host lands on the wrong
// recorder and the routed-host assertion fails.
type novelaiGeneratePeer struct {
	host      string
	recorder  *mockprovider.KeyedRecorder
	origin    string
	authority string
}

func newNovelaiGeneratePeers(t *testing.T) map[string]*novelaiGeneratePeer {
	t.Helper()
	peers := map[string]*novelaiGeneratePeer{}
	for _, host := range []string{"api", "text", "image"} {
		recorder := mockprovider.NewKeyed(nil)
		address, err := recorder.Listen(0)
		if err != nil {
			t.Fatalf("%s peer: %v", host, err)
		}
		peers[host] = &novelaiGeneratePeer{
			host:      host,
			recorder:  recorder,
			origin:    "http://" + address.String(),
			authority: address.String(),
		}
	}
	return peers
}

// novelaiGenerateHostOf names the pinned host a recorded upstream URL was sent to. An unknown host is
// a fixture defect rather than a comparison, so it is fatal.
func novelaiGenerateHostOf(t *testing.T, name, rawURL string) string {
	t.Helper()
	switch {
	case strings.Contains(rawURL, "//api.novelai.net/"):
		return "api"
	case strings.Contains(rawURL, "//text.novelai.net/"):
		return "text"
	case strings.Contains(rawURL, "//image.novelai.net/"):
		return "image"
	}
	t.Fatalf("%s: fixture records an upstream URL on a host this replay does not know: %q", name, rawURL)
	return ""
}

// TestPinnedNodeNovelAIGenerateRoutes replays every recorded scenario.
func TestPinnedNodeNovelAIGenerateRoutes(t *testing.T) {
	fixture := loadNovelaiGenerateFixture(t)

	dataRoot := t.TempDir()
	handler, sessionCookie, token := newSDRouteHandler(t, dataRoot, t.TempDir(), fixture.Inputs.CookieSecret, fixture.Inputs.Account)
	server := httptest.NewServer(handler)
	defer server.Close()
	client := &http.Client{Timeout: 60 * time.Second}

	peers := newNovelaiGeneratePeers(t)
	defer func() {
		for _, peer := range peers {
			_ = peer.recorder.Close()
		}
	}()
	closedOrigin := closedLoopbackOrigin(t)

	seamForHost := map[string]string{
		"api":   "GOTAVERN_NOVELAI_API_URL",
		"text":  "GOTAVERN_NOVELAI_TEXT_URL",
		"image": "GOTAVERN_NOVELAI_IMAGE_URL",
	}

	for _, name := range sortedKeys(fixture.Inputs.Scenarios) {
		scenario := fixture.Inputs.Scenarios[name]
		origins := map[string]string{}
		for host, peer := range peers {
			origins[host] = peer.origin
			peer.recorder.Reset(nil)
		}
		if scenario.Peer == "closed" {
			// Every host this route could have chosen is closed, so the single request is rejected
			// whichever host it was aimed at, and no peer may record anything.
			for host := range origins {
				origins[host] = closedOrigin
			}
		}
		if scenario.SecondPeer == "closed" {
			// Only the SECOND request is rejected: the image base keeps its peer and the upscale base
			// (an api.novelai.net URL) points at a closed port.
			origins["api"] = closedOrigin
		}
		for host, seam := range seamForHost {
			t.Setenv(seam, origins[host])
		}
		novelaiGenerateScriptPeer(t, name, scenario, peers)
		writeSDSecrets(t, dataRoot, fixture.Inputs.Account.Handle, scenario.Secrets)

		request, requestErr := http.NewRequest(http.MethodPost, server.URL+scenario.Route, strings.NewReader(scenario.RequestBody))
		if requestErr != nil {
			t.Fatal(requestErr)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		response, doErr := client.Do(request)
		if doErr != nil {
			t.Fatalf("%s: request failed: %v", name, doErr)
		}
		body, readErr := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if readErr != nil {
			t.Fatalf("%s: reading the response body failed: %v", name, readErr)
		}

		compareNovelAIGenerateResponse(t, fixture, name, scenario, response, body, readErr == nil)

		expectedByHost := map[string][]searchOutbound{}
		for _, expected := range scenario.Outbound {
			host := novelaiGenerateHostOf(t, name, expected.URL)
			expectedByHost[host] = append(expectedByHost[host], expected)
		}
		total := 0
		for _, host := range sortedKeys(peers) {
			peer := peers[host]
			recorded := peer.recorder.Recording().Requests
			total += len(recorded)
			want := expectedByHost[host]
			if len(recorded) != len(want) {
				t.Fatalf("%s: the %s peer (%s) received %d request(s), the fixture records %d for %s; the route chose the wrong host or the wrong number of requests",
					name, host, peer.authority, len(recorded), len(want), host)
			}
			compareNovelAIGenerateRequests(t, fixture, name, host, want, recorded, peer.authority)
			if unused := peer.recorder.Unused(); len(unused) > 0 {
				t.Fatalf("%s: the %s peer's script was not fully consumed; unused %v", name, host, unused)
			}
		}
		compareNovelAIGenerateOutboundCount(t, name, scenario, total)
		if scenario.Peer == "closed" && total != 0 {
			t.Fatalf("%s: a closed-peer scenario reached a recording peer %d time(s)", name, total)
		}
		if scenario.SecondPeer == "closed" && total != 1 {
			t.Fatalf("%s: the SECOND request was rejected, so the peers must have seen exactly the first request; they saw %d", name, total)
		}
	}
}

// novelaiGenerateScriptPeer loads each upstream answer onto the peer that owns its HOST. The fixture
// lists `upstream` in rule order and `outbound` as the answered requests in the same order, so entry
// index i answers outbound request i; a throwing rule contributes no answer.
func novelaiGenerateScriptPeer(t *testing.T, name string, scenario novelaiGenerateScenario, peers map[string]*novelaiGeneratePeer) {
	t.Helper()
	byHost := map[string]map[string][]mockprovider.Response{}
	for index, item := range scenario.Upstream {
		if item.Throws {
			continue
		}
		if index >= len(scenario.Outbound) {
			t.Fatalf("%s: upstream answer %d has no matching recorded request", name, index)
		}
		host := novelaiGenerateHostOf(t, name, scenario.Outbound[index].URL)
		if byHost[host] == nil {
			byHost[host] = map[string][]mockprovider.Response{}
		}
		names := make([]string, 0, len(item.Headers))
		for header := range item.Headers {
			names = append(names, header)
		}
		sort.Strings(names)
		headers := make([]mockprovider.Header, 0, len(names))
		for _, header := range names {
			headers = append(headers, mockprovider.Header{Name: header, Value: item.Headers[header]})
		}
		body := ""
		if item.BodyBase64 != nil {
			decoded, decodeErr := base64.StdEncoding.DecodeString(*item.BodyBase64)
			if decodeErr != nil {
				t.Fatalf("%s: upstream body is not base64: %v", name, decodeErr)
			}
			body = string(decoded)
		} else if item.BodyText != nil {
			body = *item.BodyText
		}
		status := item.Status
		if status == 0 {
			status = http.StatusOK
		}
		key := http.MethodPost + " " + item.Path
		byHost[host][key] = append(byHost[host][key], mockprovider.Response{Status: status, Headers: headers, Body: body})
	}
	for host, script := range byHost {
		peers[host].recorder.Reset(script)
	}
}

// compareNovelAIGenerateResponse compares everything the fixture records about the response.
func compareNovelAIGenerateResponse(t *testing.T, fixture novelaiGenerateFixture, name string, scenario novelaiGenerateScenario, response *http.Response, body []byte, terminated bool) {
	t.Helper()
	observation := scenario.Response
	if response.StatusCode != observation.Status {
		t.Fatalf("%s: status = %d, pinned Node has %d (body %q)", name, response.StatusCode, observation.Status, string(body))
	}

	excluded := map[string]bool{}
	for _, header := range fixture.ExcludedResponseHeaders {
		excluded[header] = true
	}
	gotHeaders := map[string]string{}
	for headerName, values := range response.Header {
		lower := strings.ToLower(headerName)
		if excluded[lower] || lower == "content-type" && len(values) == 1 && values[0] == "" {
			continue
		}
		gotHeaders[lower] = strings.Join(values, ", ")
	}
	if len(gotHeaders) != len(observation.Headers) {
		t.Fatalf("%s: response headers = %v, pinned Node sent %v", name, sortedHeaderPairs(gotHeaders), sortedHeaderPairs(observation.Headers))
	}
	for headerName, want := range observation.Headers {
		got, present := gotHeaders[headerName]
		if !present {
			t.Fatalf("%s: response is missing header %q, pinned Node sent %q", name, headerName, want)
		}
		if got != want {
			t.Fatalf("%s: response header %q = %q, pinned Node sent %q", name, headerName, got, want)
		}
	}

	wantChunked := observation.Framing.TransferEncoding != nil
	gotChunked := len(response.TransferEncoding) == 1 && response.TransferEncoding[0] == "chunked"
	if wantChunked != gotChunked {
		t.Fatalf("%s: chunked framing = %v, pinned Node has %v (transfer-encoding %v)", name, gotChunked, wantChunked, response.TransferEncoding)
	}
	if observation.Framing.ContentLength == nil {
		if response.ContentLength != -1 {
			t.Fatalf("%s: content length = %d, pinned Node declared none", name, response.ContentLength)
		}
	} else if response.ContentLength != int64(*observation.Framing.ContentLength) {
		t.Fatalf("%s: content length = %d, pinned Node declared %d", name, response.ContentLength, *observation.Framing.ContentLength)
	}

	if !terminated {
		t.Fatalf("%s: the response body did not terminate cleanly", name)
	}
	if observation.Terminated != "end" {
		t.Fatalf("%s: fixture terminator is %q, this replay only knows a clean end", name, observation.Terminated)
	}
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

// compareNovelAIGenerateOutboundCount is the assertion the image route needs: the COUNT of outbound requests
// is a property of the branch, so it is checked before the requests themselves. It takes the TOTAL across
// every host peer, because the host is compared separately and independently of how many requests were made.
func compareNovelAIGenerateOutboundCount(t *testing.T, name string, scenario novelaiGenerateScenario, total int) {
	t.Helper()
	if total != len(scenario.Outbound) {
		t.Fatalf("%s: the peers received %d requests, the fixture records %d answered request(s) and %d rejected attempt(s)",
			name, total, len(scenario.Outbound), scenario.OutboundRejectedAttempts)
	}
	if scenario.OutboundAttempts != len(scenario.Outbound)+scenario.OutboundRejectedAttempts {
		t.Fatalf("%s: fixture attempts %d != answered %d + rejected %d",
			name, scenario.OutboundAttempts, len(scenario.Outbound), scenario.OutboundRejectedAttempts)
	}
}

// compareNovelAIGenerateRequests compares the requests ONE host peer recorded against the fixture's
// records for that host: method, raw target (path and query, undecoded), header lines in wire order,
// and the exact body. A random seed is masked on BOTH sides exactly where the fixture masks it.
func compareNovelAIGenerateRequests(t *testing.T, fixture novelaiGenerateFixture, name, host string, expected []searchOutbound, recorded []mockprovider.Request, mockAuthority string) {
	t.Helper()
	for index, want := range expected {
		actual := recorded[index]
		if actual.Method != want.Method {
			t.Fatalf("%s: %s request %d method = %s, pinned Node sent %s", name, host, index, actual.Method, want.Method)
		}
		wantTarget, parseErr := parseExpectedTarget(want.URL)
		if parseErr != nil {
			t.Fatalf("%s: fixture URL %q: %v", name, want.URL, parseErr)
		}
		if actual.RawTarget != wantTarget {
			t.Fatalf("%s: %s request %d target = %q, pinned Node sent %q", name, host, index, actual.RawTarget, wantTarget)
		}
		wantBody := want.Body
		gotBody := ""
		if actual.BodyText != nil {
			gotBody = *actual.BodyText
		}
		masked := strings.Contains(wantBody, `"seed":"<seed>"`)
		if masked {
			// The pinned route randomizes an absent seed; normalize the same way, in the same place.
			gotBody = novelaiSeedPattern.ReplaceAllString(gotBody, `"seed":"<seed>"`)
		}
		if gotBody != wantBody {
			t.Fatalf("%s: %s request %d body = %q, pinned Node sent %q", name, host, index, gotBody, wantBody)
		}
		wantHeaders := novelaiGenerateExpectedWireHeaders(fixture, want, mockAuthority)
		if masked {
			// THE MASKED BODY'S LENGTH IS NOT A REQUEST LENGTH. The marker is 15 bytes while
			// Math.floor(Math.random() * 9999999999) produces 1 to 10 digits, so no real request has
			// the recorded body's byte count and the fixture's content-length cannot be compared
			// against it (the same trap rule 18 records for a shape value that also sits inside a
			// compared field). What IS a contract is that the declared length describes the body that
			// was actually sent, so that is asserted instead, and both header lists drop the line so
			// the rest of the wire form is still compared in full.
			wantHeaders = novelaiWithoutHeader(wantHeaders, "content-length")
			compareBackendsHeaderLines(t, name, index, wantHeaders, novelaiWithoutProviderHeader(actual.Headers, "content-length"), backendsExplicitConnection(want))
			declared := novelaiProviderHeaderValue(actual.Headers, "content-length")
			if declared != strconv.Itoa(actual.BodyLength) {
				t.Fatalf("%s: %s request %d declared content-length %q but sent %d bytes", name, host, index, declared, actual.BodyLength)
			}
			continue
		}
		compareBackendsHeaderLines(t, name, index, wantHeaders, actual.Headers, backendsExplicitConnection(want))
	}
}

// novelaiWithoutHeader drops one header line from an expected wire list.
func novelaiWithoutHeader(lines [][2]string, name string) [][2]string {
	filtered := make([][2]string, 0, len(lines))
	for _, line := range lines {
		if strings.EqualFold(line[0], name) {
			continue
		}
		filtered = append(filtered, line)
	}
	return filtered
}

// novelaiWithoutProviderHeader drops one header line from a recorded request.
func novelaiWithoutProviderHeader(headers []mockprovider.Header, name string) []mockprovider.Header {
	filtered := make([]mockprovider.Header, 0, len(headers))
	for _, header := range headers {
		if strings.EqualFold(header.Name, name) {
			continue
		}
		filtered = append(filtered, header)
	}
	return filtered
}

// novelaiProviderHeaderValue returns one recorded request header's value.
func novelaiProviderHeaderValue(headers []mockprovider.Header, name string) string {
	for _, header := range headers {
		if strings.EqualFold(header.Name, name) {
			return strings.TrimSpace(header.Value)
		}
	}
	return ""
}

var novelaiSeedPattern = regexp.MustCompile(`"seed":-?\d+`)

func novelaiGenerateExpectedWireHeaders(fixture novelaiGenerateFixture, expected searchOutbound, mockAuthority string) [][2]string {
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

func sortedHeaderPairs(headers map[string]string) [][2]string {
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	pairs := make([][2]string, 0, len(names))
	for _, name := range names {
		pairs = append(pairs, [2]string{name, headers[name]})
	}
	return pairs
}

// TestNovelAIGenerateStreamsBeforeTheUpstreamEnds is a LABELLED IMPLEMENTATION TEST, not an oracle.
//
// The oracle records the framing of a COMPLETED stream (chunked, no content-length, no content-type),
// and that is what makes a buffered res.send() invalid: it would declare a length. But a hypothetical
// implementation that read the whole upstream body into memory and then wrote it with chunked framing
// would produce the same bytes as a piped one. The controlled peer cannot hold a pinned response open
// (a pinned client disconnect tears down the source stream and can kill the pinned process), so no
// fixture can express "the first frame reached the client while the upstream was still open". It is
// asserted here instead, on the Go side only, against a peer that never ends its body: a handler that
// buffered could never deliver a byte, so the read below would time out.
func TestNovelAIGenerateStreamsBeforeTheUpstreamEnds(t *testing.T) {
	fixture := loadNovelaiGenerateFixture(t)

	dataRoot := t.TempDir()
	handler, sessionCookie, token := newSDRouteHandler(t, dataRoot, t.TempDir(), fixture.Inputs.CookieSecret, fixture.Inputs.Account)
	server := httptest.NewServer(handler)
	defer server.Close()

	// The SEQUENTIAL recorder, not the keyed one: only Recorder.serveProvider marks
	// ClientDisconnected, because the keyed recorder discards that result. This test asserts the
	// disconnect, so it has to use the recorder that observes it. One scripted answer makes arrival
	// order irrelevant, which is the property the keyed recorder exists for and this test does not
	// need.
	peer := mockprovider.New([]mockprovider.Response{{
		Status:    http.StatusOK,
		Headers:   []mockprovider.Header{{Name: "content-type", Value: "text/event-stream"}},
		NeverEnds: true,
	}})
	address, err := peer.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	t.Setenv("GOTAVERN_NOVELAI_API_URL", "http://"+address.String())
	t.Setenv("GOTAVERN_NOVELAI_TEXT_URL", "")
	t.Setenv("GOTAVERN_NOVELAI_IMAGE_URL", "")
	writeSDSecrets(t, dataRoot, fixture.Inputs.Account.Handle, map[string]string{"api_key_novel": fixture.Inputs.NovelKey})

	body := `{"input":"Once upon a time","model":"clio-v1","streaming":true}`
	request, requestErr := http.NewRequest(http.MethodPost, server.URL+"/api/novelai/generate", strings.NewReader(body))
	if requestErr != nil {
		t.Fatal(requestErr)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Cookie", sessionCookie)
	request.Header.Set("X-CSRF-Token", token)
	response, doErr := (&http.Client{Timeout: 30 * time.Second}).Do(request)
	if doErr != nil {
		t.Fatal(doErr)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("streaming status = %d", response.StatusCode)
	}
	if len(response.TransferEncoding) != 1 || response.TransferEncoding[0] != "chunked" {
		t.Fatalf("streaming framing is not chunked: %v", response.TransferEncoding)
	}

	type readResult struct {
		count int
		err   error
	}
	firstBytes := make(chan readResult, 1)
	go func() {
		buffer := make([]byte, 4096)
		count, readErr := response.Body.Read(buffer)
		firstBytes <- readResult{count: count, err: readErr}
	}()
	select {
	case result := <-firstBytes:
		if result.count == 0 {
			t.Fatalf("the first read delivered no body bytes (err %v) while the upstream was still open: the handler buffered the stream", result.err)
		}
		t.Logf("first streamed read: %d bytes before the upstream ended", result.count)
	case <-time.After(10 * time.Second):
		t.Fatal("no body byte reached the client within 10s while the upstream was still open: the handler buffered the stream")
	}

	// Closing the client must tear the upstream connection down: the peer reports the disconnect.
	_ = response.Body.Close()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		recording := peer.Recording().Requests
		if len(recording) == 1 && recording[0].ClientDisconnected {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("the peer never observed the client disconnect: %v", peer.Recording().Requests)
}

// TestNovelAIGenerateRejectsAMissingModel is a LABELLED SOURCE-DERIVED TEST (no oracle can exist).
//
// `getBadWordsList(req.body.model)` runs outside the pinned try block, so a body with no model is
// `undefined.includes`, an unhandled rejection that terminates the pinned process. Recording that
// would mean killing the oracle mid-run, so the branch is derived from source: GoTavern answers 500
// and keeps serving. The assertion records the deviation next to the fixture's knownDifferences.
func TestNovelAIGenerateRejectsAMissingModel(t *testing.T) {
	fixture := loadNovelaiGenerateFixture(t)
	dataRoot := t.TempDir()
	handler, sessionCookie, token := newSDRouteHandler(t, dataRoot, t.TempDir(), fixture.Inputs.CookieSecret, fixture.Inputs.Account)
	server := httptest.NewServer(handler)
	defer server.Close()

	peer := mockprovider.NewKeyed(nil)
	address, err := peer.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	t.Setenv("GOTAVERN_NOVELAI_API_URL", "http://"+address.String())
	t.Setenv("GOTAVERN_NOVELAI_TEXT_URL", "")
	t.Setenv("GOTAVERN_NOVELAI_IMAGE_URL", "")
	writeSDSecrets(t, dataRoot, fixture.Inputs.Account.Handle, map[string]string{"api_key_novel": fixture.Inputs.NovelKey})

	for _, body := range []string{`{"input":"Once upon a time"}`, `{"input":"Once upon a time","model":7}`} {
		request, requestErr := http.NewRequest(http.MethodPost, server.URL+"/api/novelai/generate", strings.NewReader(body))
		if requestErr != nil {
			t.Fatal(requestErr)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		response, doErr := (&http.Client{Timeout: 30 * time.Second}).Do(request)
		if doErr != nil {
			t.Fatal(doErr)
		}
		payload, _ := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusInternalServerError {
			t.Fatalf("body %s: status = %d, want 500 (body %q)", body, response.StatusCode, string(payload))
		}
		if !bytes.Equal(payload, []byte(http.StatusText(http.StatusInternalServerError))) {
			t.Fatalf("body %s: body = %q, want the res.sendStatus phrase", body, string(payload))
		}
	}
	if len(peer.Recording().Requests) != 0 {
		t.Fatalf("a rejected model reached the peer %d time(s)", len(peer.Recording().Requests))
	}
}
