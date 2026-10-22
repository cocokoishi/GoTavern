package server

// Replay of the pinned `POST /api/anthropic/caption-image` route against
// tests/oracle/sillytavern-1.19.0-anthropic-caption.json (recorded by tools/probe-anthropic-caption.mjs).
//
// THE FIXTURE DECIDES WHAT IS COMPARED, and that is deliberate: every observation carries a `comparison`
// block naming what is COMPARED and what is `shape` with a reason, and this test refuses to run when a
// classification has a hole. Two scenarios cannot be compared the usual way and say so in the fixture:
//
//   - `body.malformedJson` never reaches the handler (express.json rejects it), and the pinned answer is
//     Node's DEVELOPMENT error page, whose bytes embed the checkout path and a stack trace. Its body,
//     content-length and ETag are host-derived and are recorded as null; only the STATUS and the zero
//     outbound count are claimed.
//   - the two transport-failure scenarios reach the route's `catch` through a REJECTED fetch. The pinned
//     attempt is recorded from the probe's stub, which logs before it throws; the Go replay has no stub, so
//     it points the seam at a genuinely CLOSED loopback port and asserts that no peer received anything.
//     Only the response is comparable there, and the request SHAPE of the same route is pinned by the
//     sibling proxy scenarios.
//
// The seam is a host rewrite (`searchFetch`'s `GOTAVERN_ANTHROPIC_CAPTION_BASE_URL`), so each scenario's
// PATH is what the replay compares -- that is the part the route's string concatenation decides, and it is
// why `proxy.trailingSlash` can assert `/v1//messages` without asserting a port.

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
)

type anthropicCaptionFixture struct {
	SchemaVersion int `json:"schemaVersion"`
	Baseline      struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Oracle struct {
		File           string `json:"file"`
		Route          string `json:"route"`
		SecretKey      string `json:"secretKey"`
		DefaultBaseURL string `json:"defaultBaseUrl"`
		Concatenation  string `json:"concatenation"`
	} `json:"oracle"`
	NodeFetchWireDefaults struct {
		Headers    [][2]string `json:"headers"`
		MeasuredBy string      `json:"measuredBy"`
	} `json:"nodeFetchWireDefaults"`
	Inputs struct {
		CookieSecret string            `json:"cookieSecret"`
		Account      sdFixtureAccount  `json:"account"`
		SeamDefaults map[string]string `json:"seamDefaults"`
		Caption      string            `json:"caption"`
	} `json:"inputs"`
	Scenarios        map[string]anthropicCaptionScenario `json:"scenarios"`
	KnownDifferences []map[string]any                    `json:"knownDifferences"`
}

type anthropicCaptionScenario struct {
	Route             string                     `json:"route"`
	Note              string                     `json:"note"`
	RequestBody       string                     `json:"requestBody"`
	Mocks             []googleTTSMock            `json:"mocks"`
	Secrets           map[string]string          `json:"secrets"`
	Response          anthropicCaptionResponse   `json:"response"`
	OutboundRecording string                     `json:"outboundRecording"`
	TransportFailure  bool                       `json:"transportFailure"`
	OutboundCount     int                        `json:"outboundCount"`
	Outbound          []anthropicCaptionOutbound `json:"outbound"`
	Comparison        searchComparison           `json:"comparison"`
	ClosedPortRefusal string                     `json:"closedPortRefusal"`
}

type anthropicCaptionResponse struct {
	Status   int               `json:"status"`
	Headers  map[string]string `json:"headers"`
	Body     json.RawMessage   `json:"body"`
	BodyText *string           `json:"bodyText"`
}

type anthropicCaptionOutbound struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
	Target  string            `json:"target"`
}

const (
	anthropicCaptionFixtureName = "sillytavern-1.19.0-anthropic-caption.json"
	anthropicCaptionWireMarker  = "<wire>"
	anthropicCaptionClosedMark  = "<closed>"
	anthropicCaptionHostMarker  = "<wire-host>"
)

var anthropicCaptionObservableKeys = []string{"status", "contentType", "contentLength", "etag", "bodyText", "outboundCount", "outbound"}

func loadAnthropicCaptionOracle(t *testing.T) anthropicCaptionFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", anthropicCaptionFixtureName))
	if err != nil {
		t.Fatal(err)
	}
	var fixture anthropicCaptionFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

// TestAnthropicCaptionSeamDefaults asserts the Go literal EQUALS the fixture's recorded default, so a
// mutation of either side fails: the default is the URL a real install would use, and the replay would
// otherwise compare a request whose base nobody checked.
func TestAnthropicCaptionSeamDefaults(t *testing.T) {
	fixture := loadAnthropicCaptionOracle(t)
	if len(fixture.Inputs.SeamDefaults) != 1 {
		t.Fatalf("fixture records %d seam defaults, want the one anthropic base", len(fixture.Inputs.SeamDefaults))
	}
	want, present := fixture.Inputs.SeamDefaults[anthropicCaptionSeamEnv]
	if !present {
		t.Fatalf("fixture does not record %s", anthropicCaptionSeamEnv)
	}
	t.Setenv(anthropicCaptionSeamEnv, "")
	if got := sdSeamURL(anthropicCaptionSeamEnv, anthropicCaptionDefaultBaseURL); got != want {
		t.Fatalf("default anthropic base = %q, pinned literal %q", got, want)
	}
	if want != anthropicCaptionDefaultBaseURL {
		t.Fatalf("the Go literal and the fixture disagree: %q vs %q", anthropicCaptionDefaultBaseURL, want)
	}
	// The temp pointer used by the pinned comment: `${baseUrl}/messages`, not a url join. Asserted here so a
	// reader sees the concatenation is the pinned shape and not a normalisation this repo invented.
	if !strings.Contains(fixture.Oracle.Concatenation, "${baseUrl}/messages") {
		t.Fatalf("the fixture no longer records the pinned concatenation: %q", fixture.Oracle.Concatenation)
	}
}

func TestPinnedNodeAnthropicCaption(t *testing.T) {
	fixture := loadAnthropicCaptionOracle(t)
	if fixture.SchemaVersion != 1 {
		t.Fatalf("fixture schemaVersion = %d", fixture.SchemaVersion)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("anthropic caption oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Oracle.SecretKey != anthropicCaptionSecretKey {
		t.Fatalf("fixture secret key = %q, Go reads %q", fixture.Oracle.SecretKey, anthropicCaptionSecretKey)
	}
	verifyAnthropicCaptionClassification(t, fixture)
	verifyAnthropicCaptionDiscriminating(t, fixture)

	dataRoot := t.TempDir()
	handler, sessionCookie, token := newSDRouteHandler(t, dataRoot, t.TempDir(), fixture.Inputs.CookieSecret, fixture.Inputs.Account)

	for _, name := range sortedKeys(fixture.Scenarios) {
		scenario := fixture.Scenarios[name]
		t.Run(name, func(t *testing.T) {
			// The recorded mock rules are matched by a SUBSTRING of the request target, and the probe wrote
			// them against the pinned HOST (api.anthropic.com, proxy.example.test ...) because that is what
			// the pinned stub matched on. The replay's peer only sees the PATH the route built, so a rule
			// keyed on a host could never match and the peer would answer its 500 -- a harness artefact
			// dressed as a product failure. Each scenario has one rule for one request, so the rule is
			// re-anchored on that request's target, which is the part the route decides.
			if len(scenario.Mocks) == 1 && len(scenario.Outbound) == 1 {
				scenario.Mocks[0].Match = anthropicCaptionExpectedTarget(t, scenario.Outbound[0])
			} else if len(scenario.Mocks) != len(scenario.Outbound) {
				t.Fatalf("%s: %d mock rule(s) for %d recorded request(s)", name, len(scenario.Mocks), len(scenario.Outbound))
			}
			peer := newOpenAIVideoPeer(t, scenario.Mocks)
			closedOrigin := closedLoopbackOrigin(t)
			body := scenario.RequestBody
			switch {
			case strings.Contains(body, anthropicCaptionClosedMark):
				// transport.closedPort: the body itself names the destination, so the seam must stay UNSET and
				// the route must reach the closed port it was given.
				t.Setenv(anthropicCaptionSeamEnv, "")
				body = strings.ReplaceAll(body, anthropicCaptionClosedMark, closedOrigin)
			case scenario.TransportFailure:
				// transport.stubRejects: the pinned leg reached the catch through a stub that threw. The Go
				// leg reaches it through a real refusal, which is the same branch and a stronger probe.
				t.Setenv(anthropicCaptionSeamEnv, closedOrigin)
			default:
				t.Setenv(anthropicCaptionSeamEnv, peer.server.URL)
				body = strings.ReplaceAll(body, anthropicCaptionWireMarker, peer.server.URL)
			}
			writeSDSecrets(t, dataRoot, fixture.Inputs.Account.Handle, scenario.Secrets)

			request := httptest.NewRequest(http.MethodPost, scenario.Route, strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Cookie", sessionCookie)
			request.Header.Set("X-CSRF-Token", token)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)

			compareAnthropicCaptionResponse(t, name, scenario, recorder)
			compareAnthropicCaptionOutbound(t, name, fixture, scenario, peer)
		})
	}
}

// verifyAnthropicCaptionClassification refuses a fixture whose observables are not all classified, whose
// shape fields lack reasons, or which has stopped comparing the body and the outbound request anywhere.
func verifyAnthropicCaptionClassification(t *testing.T, fixture anthropicCaptionFixture) {
	t.Helper()
	if len(fixture.Scenarios) < 20 {
		t.Fatalf("the anthropic caption oracle records only %d scenarios", len(fixture.Scenarios))
	}
	comparedSomewhere := map[string]bool{}
	for name, scenario := range fixture.Scenarios {
		classified := map[string]bool{}
		for _, key := range scenario.Comparison.Compared {
			classified[key] = true
			comparedSomewhere[key] = true
		}
		for _, key := range scenario.Comparison.Shape {
			classified[key] = true
			if strings.TrimSpace(scenario.Comparison.ShapeReason[key]) == "" {
				t.Fatalf("%s: shape field %q has no reason", name, key)
			}
		}
		covers := func(name string) bool {
			if classified[name] {
				return true
			}
			for key := range classified {
				if strings.HasPrefix(key, name+"[") || strings.HasPrefix(key, name+".") {
					return true
				}
			}
			return false
		}
		for _, key := range anthropicCaptionObservableKeys {
			if !covers(key) {
				t.Fatalf("%s: observable %q is neither compared nor shape-classified", name, key)
			}
		}
	}
	for _, key := range []string{"status", "contentType", "contentLength", "etag", "bodyText", "outboundCount", "outbound[].url", "outbound[].method", "outbound[].body", "outbound[].headers"} {
		if !comparedSomewhere[key] {
			t.Fatalf("no scenario compares %q, so that observable is unasserted", key)
		}
	}
}

// verifyAnthropicCaptionDiscriminating refuses to run unless the fixture still holds the pairs that make the
// implementation falsifiable: the two DIFFERENT 500 branches, a non-2xx status that is not 500, both data-URI
// omission directions, both concatenation shapes, a real refusal, and a non-string caption.
func verifyAnthropicCaptionDiscriminating(t *testing.T, fixture anthropicCaptionFixture) {
	t.Helper()
	bodyOf := func(name string) string {
		scenario, present := fixture.Scenarios[name]
		if !present {
			t.Fatalf("the fixture no longer records scenario %q", name)
		}
		if scenario.Response.BodyText == nil {
			return ""
		}
		return *scenario.Response.BodyText
	}
	catchBranch := bodyOf("ok.contentAbsent")
	falsyBranch := bodyOf("ok.textEmptyString")
	if catchBranch == falsyBranch {
		t.Fatalf("the catch branch and the falsy-caption branch read the same (%q), so the fixture cannot tell them apart", catchBranch)
	}
	if catchBranch != "Internal server error" || falsyBranch != "No caption found" {
		t.Fatalf("branch bodies moved: catch %q, falsy %q", catchBranch, falsyBranch)
	}
	if status := fixture.Scenarios["upstream.jsonError"].Response.Status; status == 500 {
		t.Fatalf("upstream.jsonError records status %d, so the forwarded-status assertion proves nothing", status)
	}
	if bodyOf("upstream.jsonError") != `{"error":true}` || bodyOf("upstream.textError") != `{"error":true}` {
		t.Fatalf("a non-2xx upstream must flatten to {error:true} for a JSON and a text body alike")
	}
	noComma := fixture.Scenarios["image.noComma"].Outbound
	noColon := fixture.Scenarios["image.noColon"].Outbound
	if len(noComma) != 1 || len(noColon) != 1 {
		t.Fatalf("the data-URI omission scenarios must each record exactly one outbound request")
	}
	if !strings.Contains(noComma[0].Body, `"media_type":"image/png"`) || strings.Contains(noComma[0].Body, `"data"`) {
		t.Fatalf("image.noComma must record media_type WITHOUT data: %s", noComma[0].Body)
	}
	if !strings.Contains(noColon[0].Body, `"data":"AAAA"`) || strings.Contains(noColon[0].Body, `"media_type"`) {
		t.Fatalf("image.noColon must record data WITHOUT media_type: %s", noColon[0].Body)
	}
	single := fixture.Scenarios["proxy.noTrailingSlash"].Outbound
	double := fixture.Scenarios["proxy.trailingSlash"].Outbound
	if len(single) != 1 || len(double) != 1 {
		t.Fatalf("the concatenation scenarios must each record exactly one outbound request")
	}
	if !strings.HasSuffix(single[0].URL, "/v1/messages") || !strings.HasSuffix(double[0].URL, "/v1//messages") {
		t.Fatalf("the concatenation scenarios no longer record /v1/messages and /v1//messages: %q %q", single[0].URL, double[0].URL)
	}
	if fixture.Scenarios["transport.closedPort"].ClosedPortRefusal == "" {
		t.Fatalf("transport.closedPort records no refusal, so it may not have been a closed port at all")
	}
	if got := bodyOf("ok.textNumber"); got != `{"caption":42}` {
		t.Fatalf("ok.textNumber records %q, so the raw-value forwarding is not pinned", got)
	}
}

func compareAnthropicCaptionResponse(t *testing.T, name string, scenario anthropicCaptionScenario, recorder *httptest.ResponseRecorder) {
	t.Helper()
	compared := map[string]bool{}
	for _, key := range scenario.Comparison.Compared {
		compared[key] = true
	}
	shape := map[string]bool{}
	for _, key := range scenario.Comparison.Shape {
		shape[key] = true
	}
	if compared["status"] {
		if recorder.Code != scenario.Response.Status {
			t.Fatalf("%s: status = %d, pinned %d (body %q)", name, recorder.Code, scenario.Response.Status, recorder.Body.String())
		}
	} else if !shape["status"] {
		t.Fatalf("%s: status is neither compared nor shape", name)
	}
	if shape["contentType"] && compared["contentType"] {
		t.Fatalf("%s: contentType is both compared and shape", name)
	}
	if compared["contentType"] {
		compareOptionalHeader(t, name, "content-type", optionalHeader(scenario.Response.Headers, "content-type"), recorder.Header().Get("Content-Type"))
	}
	if compared["contentLength"] {
		compareOptionalHeader(t, name, "content-length", optionalHeader(scenario.Response.Headers, "content-length"), recorder.Header().Get("Content-Length"))
	}
	if compared["etag"] {
		compareOptionalHeader(t, name, "etag", optionalHeader(scenario.Response.Headers, "etag"), recorder.Header().Get("ETag"))
	}
	if compared["bodyText"] {
		if scenario.Response.BodyText == nil {
			t.Fatalf("%s: bodyText is compared but the fixture records null", name)
		}
		if recorder.Body.String() != *scenario.Response.BodyText {
			t.Fatalf("%s: body = %q, pinned %q", name, recorder.Body.String(), *scenario.Response.BodyText)
		}
	}
}

func optionalHeader(headers map[string]string, name string) *string {
	value, present := headers[name]
	if !present {
		return nil
	}
	return &value
}

func compareAnthropicCaptionOutbound(t *testing.T, name string, fixture anthropicCaptionFixture, scenario anthropicCaptionScenario, peer *openAIVideoPeer) {
	t.Helper()
	compared := map[string]bool{}
	for _, key := range scenario.Comparison.Compared {
		compared[key] = true
	}
	if compared["outboundCount"] {
		if len(peer.seen) != scenario.OutboundCount {
			t.Fatalf("%s: peer received %d request(s), pinned made %d", name, len(peer.seen), scenario.OutboundCount)
		}
	}
	if scenario.TransportFailure && len(peer.seen) != 0 {
		t.Fatalf("%s: a rejected fetch must reach NO peer, but %d request(s) arrived", name, len(peer.seen))
	}
	if len(peer.seen) == 0 {
		return
	}
	recorded := scenario.Outbound[0]
	actual := peer.seen[0]
	if compared["outbound[].method"] && actual.Method != recorded.Method {
		t.Fatalf("%s: method = %s, pinned %s", name, actual.Method, recorded.Method)
	}
	if compared["outbound[].url"] {
		want := anthropicCaptionExpectedTarget(t, recorded)
		if actual.URL != want {
			t.Fatalf("%s: target = %q, pinned %q", name, actual.URL, want)
		}
	}
	if compared["outbound[].body"] && actual.Body != recorded.Body {
		t.Fatalf("%s: outbound body = %q, pinned %q", name, actual.Body, recorded.Body)
	}
	if compared["outbound[].headers"] {
		want := anthropicCaptionExpectedHeaders(fixture, scenario, recorded)
		// The fixture classifies three header names as SHAPE (`outbound[].headers.connection`,
		// `.content-length`, `.host`) with reasons: the transport supplies two of them and the body -- which
		// is compared byte for byte -- supplies the third. They are read from the FIXTURE rather than
		// hardcoded here, so the fixture stays the single statement of what is claimed.
		skipped := map[string]bool{}
		for _, key := range scenario.Comparison.Shape {
			if rest, found := strings.CutPrefix(key, "outbound[].headers."); found {
				skipped[strings.ToLower(rest)] = true
			}
		}
		names := make([]string, 0, len(want))
		for header := range want {
			names = append(names, header)
		}
		sort.Strings(names)
		for _, header := range names {
			if skipped[header] {
				continue
			}
			if got := headerValue(actual.Headers, header); got != want[header] {
				t.Fatalf("%s: outbound header %q = %q, pinned %q", name, header, got, want[header])
			}
		}
		for header := range actual.Headers {
			lower := strings.ToLower(header)
			if _, expected := want[lower]; expected || skipped[lower] {
				continue
			}
			t.Fatalf("%s: outbound carries an unexpected header %q = %q", name, header, headerValue(actual.Headers, header))
		}
		// A shape classification must not be able to hide a MISSING header: the route's own three and the
		// request defaults the fixture measured must each be present on the request the peer received.
		for _, header := range []string{"content-type", "anthropic-version", "x-api-key", "accept", "accept-encoding", "user-agent"} {
			if _, expected := want[header]; !expected {
				continue
			}
			if _, received := actual.Headers[header]; !received {
				t.Fatalf("%s: the outbound request is missing the %q header entirely", name, header)
			}
		}
	}
}

// anthropicCaptionExpectedTarget is the request target the peer must see: the recorded `target` when the
// fixture has one (a WIRE recording), otherwise the recorded URL's path and query. The `url` in a wire
// recording carries the `<wire>` marker instead of an authority, which is why the target is recorded
// separately rather than re-derived.
func anthropicCaptionExpectedTarget(t *testing.T, recorded anthropicCaptionOutbound) string {
	t.Helper()
	if recorded.Target != "" {
		return recorded.Target
	}
	return recordedURLPath(t, recorded.URL)
}

// anthropicCaptionExpectedHeaders materialises the wire headers the pinned node-fetch sends, from the
// fixture's MEASURED defaults plus the route's own headers. A WIRE recording already carries the whole set,
// so the defaults are used only for the stub recordings, whose header object is the route's raw object.
func anthropicCaptionExpectedHeaders(fixture anthropicCaptionFixture, scenario anthropicCaptionScenario, recorded anthropicCaptionOutbound) map[string]string {
	values := map[string]string{}
	if scenario.OutboundRecording == "wire" {
		for header, value := range recorded.Headers {
			if strings.ToLower(header) == "host" {
				continue
			}
			values[strings.ToLower(header)] = value
		}
		return values
	}
	for _, header := range fixture.NodeFetchWireDefaults.Headers {
		values[header[0]] = header[1]
	}
	values["content-length"] = strconv.Itoa(len(recorded.Body))
	for header, value := range recorded.Headers {
		values[strings.ToLower(header)] = value
	}
	return values
}

func headerValue(headers map[string]string, name string) string {
	for header, value := range headers {
		if strings.EqualFold(header, name) {
			return value
		}
	}
	return ""
}
