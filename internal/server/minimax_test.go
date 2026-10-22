package server

// Replay of the pinned MiniMax text-to-speech route. The oracle is
// tests/oracle/sillytavern-1.19.0-minimax.json, recorded by tools/probe-minimax.mjs against the
// pinned server with node-fetch AND the global fetch replaced by a controlled peer, so the outbound
// request and the provider's answer are both captured rather than inferred.
//
// The Go side runs the REAL outbound path against a real local listener. A transport failure is
// produced through a real bound-then-closed local port, never by mocking an error.
//
// WHAT IS COMPARED, per scenario: the status, EVERY response header, the response bytes (a digest
// for audio, the exact text for JSON), and the outbound requests — method, escaped path+query,
// the full wire header list (the fixture's explicit headers plus the node-fetch defaults it
// records), and the exact body with the peer authority substituted back.
//
// WHAT IS NOT COMPARED: exactly one body, `voice.url.throws`, where the pinned branch interpolates
// the transport error's own message. That message carries the request authority on a real
// node-fetch (`request to <url> failed, reason: connect ECONNREFUSED <host>:<port>`), so the
// fixture classifies the body and its derived fields as `shape` and records no value; the 500
// status and the two outbound requests are still asserted. It is the only `shape` field here.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
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

type minimaxFixture struct {
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
		APIKey       string            `json:"apiKey"`
		AudioHex     string            `json:"audioHex"`
		AudioSHA256  string            `json:"audioSha256"`
		SeamDefaults map[string]string `json:"seamDefaults"`
		Scenarios    map[string]struct {
			Route               string                 `json:"route"`
			Body                map[string]interface{} `json:"body"`
			BodyText            string                 `json:"bodyText"`
			URLSource           string                 `json:"urlSource"`
			Overrides           []string               `json:"overrides"`
			PeerForURL          string                 `json:"peerForUrl"`
			ExpectedOutbound    int                    `json:"expectedOutbound"`
			UnreachableOutbound int                    `json:"unreachableOutbound"`
			ShapeBody           bool                   `json:"shapeBody"`
			Secrets             map[string]string      `json:"secrets"`
			Upstream            []minimaxUpstream      `json:"upstream"`
		} `json:"scenarios"`
	} `json:"inputs"`
	Observations     map[string]minimaxObservation `json:"observations"`
	KnownDifferences []map[string]any              `json:"knownDifferences"`
}

type minimaxUpstream struct {
	Match   string            `json:"match"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
	Throws  bool              `json:"throws"`
}

type minimaxOutbound struct {
	URL             string      `json:"url"`
	Method          string      `json:"method"`
	ExplicitHeaders [][2]string `json:"explicitHeaders"`
	Body            string      `json:"body"`
}

type minimaxComparison struct {
	Compared    []string          `json:"compared"`
	Shape       []string          `json:"shape"`
	ShapeReason map[string]string `json:"shapeReason"`
}

type minimaxObservation struct {
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers"`
	BodyText   *string           `json:"bodyText"`
	BodySHA256 *string           `json:"bodySha256"`
	SHA256     *string           `json:"sha256"`
	Bytes      *int              `json:"bytes"`
	Outbound   []minimaxOutbound `json:"outbound"`
	Comparison minimaxComparison `json:"comparison"`
}

// minimaxDefaultedMembers are the eight destructuring initializers of the pinned handler. Each is an
// observable, so the fixture must contain a scenario that OVERRIDES it and a scenario that omits it.
var minimaxDefaultedMembers = []string{
	"apiHost", "model", "speed", "volume", "pitch", "audioSampleRate", "bitrate", "format",
}

func loadMiniMaxOracle(t *testing.T) minimaxFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-minimax.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture minimaxFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("minimax oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Inputs.Scenarios) == 0 || len(fixture.Inputs.Scenarios) != len(fixture.Observations) {
		t.Fatalf("minimax oracle has %d scenarios but %d observations", len(fixture.Inputs.Scenarios), len(fixture.Observations))
	}
	return fixture
}

// TestMiniMaxSeamDefaults pins the seam default to the pinned literal. A seam whose default drifts
// would change production while every scenario kept passing against the mock.
func TestMiniMaxSeamDefaults(t *testing.T) {
	fixture := loadMiniMaxOracle(t)
	t.Setenv("GOTAVERN_MINIMAX_API_URL", "")
	if got := minimaxAPIHost(); got != fixture.Inputs.SeamDefaults["GOTAVERN_MINIMAX_API_URL"] {
		t.Fatalf("GOTAVERN_MINIMAX_API_URL default = %q, pinned literal %q", got, fixture.Inputs.SeamDefaults["GOTAVERN_MINIMAX_API_URL"])
	}
	if minimaxAPIHost() != "https://api.minimax.io" {
		t.Fatalf("the pinned apiHost literal moved: %q", minimaxAPIHost())
	}
}

// TestMiniMaxFixtureCoversEveryDefault refuses to run a suite that cannot fail: all eight
// initializers must appear in BOTH directions in the fixture, because "the default is used" and "the
// caller's value is used" are different observables and a fixture with only one of them is
// decoration.
func TestMiniMaxFixtureCoversEveryDefault(t *testing.T) {
	fixture := loadMiniMaxOracle(t)
	overridden := map[string]int{}
	omittedAll := 0
	for name, scenario := range fixture.Inputs.Scenarios {
		for _, member := range scenario.Overrides {
			overridden[member]++
		}
		if len(scenario.Overrides) == 0 {
			present := 0
			for _, member := range minimaxDefaultedMembers {
				if _, exists := scenario.Body[member]; exists {
					present++
				}
			}
			if present == 0 {
				omittedAll++
			}
		}
		if !strings.Contains(scenario.Route, "/api/minimax/generate-voice") {
			t.Fatalf("%s: route %q is not the minimax generate-voice route", name, scenario.Route)
		}
	}
	for _, member := range minimaxDefaultedMembers {
		if overridden[member] == 0 {
			t.Fatalf("no scenario overrides %q, so the value-present branch of that default is unproven", member)
		}
	}
	if omittedAll == 0 {
		t.Fatal("no scenario omits all eight defaulted members, so the fallback branch is unproven")
	}
}

func TestPinnedNodeMiniMaxGenerateVoice(t *testing.T) {
	fixture := loadMiniMaxOracle(t)
	verifyMiniMaxClassification(t, fixture)

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

	statuses := map[int]int{}
	binaryResponses, textResponses, zeroOutbound, twoOutbound, closedLegs := 0, 0, 0, 0, 0

	for _, name := range sortedKeys(fixture.Inputs.Scenarios) {
		scenario := fixture.Inputs.Scenarios[name]
		observation, exists := fixture.Observations[name]
		if !exists {
			t.Fatalf("%s: no recorded observation", name)
		}
		t.Run(name, func(t *testing.T) {
			// The fixture's `urlSource` must agree with the body it recorded: a scenario whose body
			// names a host cannot also be a default-host scenario, or the two branches would be
			// indistinguishable and a mutation that ignored the body would pass.
			_, bodyNamesHost := scenario.Body["apiHost"]
			wantSource := "body"
			if !bodyNamesHost {
				wantSource = "seam"
			}
			if scenario.URLSource != wantSource {
				t.Fatalf("the fixture says urlSource=%q but the recorded body %s an apiHost", scenario.URLSource, map[bool]string{true: "has", false: "lacks"}[bodyNamesHost])
			}
			closedOrigin := closedLoopbackOrigin(t)
			t.Setenv("GOTAVERN_MINIMAX_API_URL", "")
			if scenario.URLSource == "seam" {
				// The body names no host, so the DEFAULT is what the route dials. Without this the
				// request would leave for the pinned literal, which is exactly what a mutation that
				// ignored the request body would also do — so the count assertion below catches it.
				t.Setenv("GOTAVERN_MINIMAX_API_URL", mockOrigin)
			}
			writeSDSecrets(t, dataRoot, fixture.Inputs.Account.Handle, scenario.Secrets)

			// A scenario whose body names no host dials the DEFAULT, so the fixture records the
			// pinned literal and the seam stands in for it: projecting the literal onto the marker is
			// what makes the default and an explicit host distinguishable assertions.
			recorded := observation.Outbound
			if scenario.URLSource == "seam" {
				seamDefault := fixture.Inputs.SeamDefaults["GOTAVERN_MINIMAX_API_URL"]
				if seamDefault == "" {
					t.Fatal("the fixture records no seam default")
				}
				if len(recorded) == 0 || !strings.HasPrefix(recorded[0].URL, seamDefault) {
					t.Fatalf("a seam-driven scenario must record the pinned literal, recorded %+v", recorded)
				}
				projected := make([]minimaxOutbound, len(recorded))
				for index, item := range recorded {
					item.URL = strings.Replace(item.URL, seamDefault, "<mock>", 1)
					projected[index] = item
				}
				recorded = projected
			}
			script, scriptErr := minimaxPeerScript(recorded, scenario.Upstream, mockOrigin, closedOrigin)
			if scriptErr != nil {
				t.Fatal(scriptErr)
			}
			peer.Reset(script)

			body := minimaxSubstitute(scenario.BodyText, mockOrigin, closedOrigin)
			request := httptest.NewRequest(http.MethodPost, scenario.Route, strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Cookie", sessionCookie)
			request.Header.Set("X-CSRF-Token", token)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)

			statuses[recorder.Code]++
			if recorder.Code != observation.Status {
				t.Fatalf("status = %d, pinned Node has %d (body %q)", recorder.Code, observation.Status, recorder.Body.String())
			}
			// A shape-classified header records no value, so it is excluded from the set comparison
			// and asserted for PRESENCE instead.
			excluded := []string{}
			for _, key := range observation.Comparison.Shape {
				if name, isHeader := strings.CutPrefix(key, "headers."); isHeader {
					if recorder.Header().Get(name) == "" {
						t.Fatalf("the replay sent no %s although pinned Node did", name)
					}
					excluded = append(excluded, name)
				}
			}
			assertPinnedHeadersExcluding(t, recorder.Header(), observation.Headers, excluded...)
			switch {
			case observation.SHA256 != nil:
				binaryResponses++
				digest := sha256Hex(recorder.Body.Bytes())
				if digest != *observation.SHA256 {
					t.Fatalf("response digest = %s, pinned %s (the bytes differ)", digest, *observation.SHA256)
				}
				if observation.Bytes != nil && recorder.Body.Len() != *observation.Bytes {
					t.Fatalf("response length = %d, pinned %d", recorder.Body.Len(), *observation.Bytes)
				}
			case observation.BodyText != nil:
				textResponses++
				if got := recorder.Body.String(); got != *observation.BodyText {
					t.Fatalf("body = %q, pinned %q", got, *observation.BodyText)
				}
			default:
				// The one shape-classified body. It must NOT be compared, and the fixture must say why.
				if reason := strings.TrimSpace(observation.Comparison.ShapeReason["bodyText"]); reason == "" {
					t.Fatalf("the body is unrecorded with no reason, so this scenario asserts nothing about it")
				}
			}

			want, unreachable := minimaxLandedOutbound(recorded)
			closedLegs += unreachable
			if unreachable != scenario.UnreachableOutbound {
				t.Fatalf("%d recorded outbound requests cannot land, the fixture declares %d", unreachable, scenario.UnreachableOutbound)
			}
			if len(observation.Outbound) != scenario.ExpectedOutbound {
				t.Fatalf("the fixture records %d outbound requests but declares %d", len(observation.Outbound), scenario.ExpectedOutbound)
			}
			switch len(observation.Outbound) {
			case 0:
				zeroOutbound++
			case 2:
				twoOutbound++
			}
			seen := peer.Recording().Requests
			if len(seen) != len(want) {
				t.Fatalf("the peer received %d requests, the pinned route made %d that could land (recorded %d, unreachable %d)",
					len(seen), len(want), len(observation.Outbound), unreachable)
			}
			for index, expected := range want {
				actual := seen[index]
				if actual.Method != expected.Method {
					t.Fatalf("request %d method = %s, pinned %s", index, actual.Method, expected.Method)
				}
				wantTarget := minimaxTarget(expected.URL)
				if actual.RawTarget != wantTarget {
					t.Fatalf("request %d target = %q, pinned %q", index, actual.RawTarget, wantTarget)
				}
				wantHeaders := minimaxExpectedWireHeaders(fixture, expected, mockAuthority)
				minimaxCompareHeaderLines(t, index, wantHeaders, actual.Headers)
				actualBody := ""
				if actual.BodyText != nil {
					actualBody = *actual.BodyText
				}
				wantBody := minimaxSubstitute(expected.Body, mockOrigin, closedOrigin)
				if actualBody != wantBody {
					t.Fatalf("request %d body = %q, pinned %q", index, actualBody, wantBody)
				}
			}
			if unused := peer.Unused(); len(unused) > 0 {
				t.Fatalf("the peer script was not fully consumed; unused %v", unused)
			}
		})
	}

	if statuses[200] == 0 || statuses[400] == 0 || statuses[500] == 0 {
		t.Fatalf("statuses = %v; every branch must be exercised", statuses)
	}
	if binaryResponses == 0 || textResponses == 0 {
		t.Fatalf("binary=%d text=%d; both response shapes must be compared", binaryResponses, textResponses)
	}
	if zeroOutbound == 0 {
		t.Fatal("no scenario recorded ZERO outbound requests, so the validation branch is unproven")
	}
	if twoOutbound == 0 {
		t.Fatal("no scenario recorded TWO outbound requests, so the audio-URL branch is unproven")
	}
	if closedLegs == 0 {
		t.Fatal("no scenario produced a real closed-port leg")
	}
	// The pinned route derives the response from the fixture's audio payload; assert the link, so a
	// fixture whose digest silently changed cannot pass as a route comparison.
	if fixture.Inputs.AudioSHA256 == "" || fixture.Inputs.AudioHex == "" {
		t.Fatal("the fixture records no audio payload")
	}
}

func verifyMiniMaxClassification(t *testing.T, fixture minimaxFixture) {
	t.Helper()
	comparedAnywhere := map[string]bool{}
	shapeReasonSeen := false
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
			shapeReasonSeen = true
		}
		for _, key := range []string{"status", "headers", "outbound"} {
			if !classified[key] {
				t.Fatalf("%s: %q is neither compared nor shape-classified", name, key)
			}
		}
		shapeClassified := map[string]bool{}
		for _, key := range observation.Comparison.Shape {
			shapeClassified[key] = true
		}
		if observation.BodyText == nil && observation.SHA256 == nil && !shapeClassified["bodyText"] {
			t.Fatalf("%s: the body records no value while %q is not shape-classified", name, "bodyText")
		}
		// A shape-classified value must record NOTHING, and so must its derived fields: the gate
		// compares the fixture's bytes, and content-length/etag are functions of the body.
		if shapeClassified["bodyText"] && observation.BodyText != nil {
			t.Fatalf("%s: bodyText is shape-classified but records a value", name)
		}
		if shapeClassified["headers.etag"] {
			if _, recorded := observation.Headers["etag"]; recorded {
				t.Fatalf("%s: the ETag is shape-classified but records a value", name)
			}
		}
		if shapeClassified["headers.content-length"] {
			if _, recorded := observation.Headers["content-length"]; recorded {
				t.Fatalf("%s: content-length is shape-classified but records a value", name)
			}
		}
	}
	for _, key := range []string{"status", "headers", "outbound"} {
		if !comparedAnywhere[key] {
			t.Fatalf("observable %q is never compared, so the suite cannot prove it", key)
		}
	}
	if !shapeReasonSeen {
		t.Fatal("no scenario classifies a shape field; the transport-message body should be the one")
	}
}

// minimaxSubstitute restores the peer authorities the fixture records as markers.
func minimaxSubstitute(value, mockOrigin, closedOrigin string) string {
	return strings.NewReplacer("<mock>", mockOrigin, "<closed>", closedOrigin).Replace(value)
}

// minimaxPeerScript builds the replay peer's script FROM the recorded outbound requests.
//
// The producer's stub selects a rule by `href.includes(candidate.match)` and serves the FIRST
// contained match, so this consumer must resolve each recorded request the same way — a replay peer
// that served mocks by request order would hand the wrong mock to the wrong shape (AGENTS rule 20,
// the OpenAI-video defect one layer over). A `throws` rule stands for a request that never lands
// (the closed port, or a relative URL the transport refuses); those requests are not in the landed
// set and therefore need no script entry.
func minimaxPeerScript(recorded []minimaxOutbound, upstream []minimaxUpstream, mockOrigin, closedOrigin string) (map[string][]mockprovider.Response, error) {
	script := map[string][]mockprovider.Response{}
	for _, request := range recorded {
		if !strings.HasPrefix(request.URL, "<mock>") {
			continue
		}
		var chosen *minimaxUpstream
		for index := range upstream {
			if upstream[index].Throws {
				continue
			}
			if strings.Contains(request.URL, upstream[index].Match) {
				chosen = &upstream[index]
				break
			}
		}
		if chosen == nil {
			return nil, fmt.Errorf("recorded request %s %s matches no peer rule", request.Method, request.URL)
		}
		names := make([]string, 0, len(chosen.Headers))
		for header := range chosen.Headers {
			names = append(names, header)
		}
		sort.Strings(names)
		headers := make([]mockprovider.Header, 0, len(names))
		for _, header := range names {
			headers = append(headers, mockprovider.Header{Name: header, Value: chosen.Headers[header]})
		}
		key := request.Method + " " + minimaxTarget(request.URL)
		script[key] = append(script[key], mockprovider.Response{
			Status: chosen.Status, Headers: headers, Body: minimaxSubstitute(chosen.Body, mockOrigin, closedOrigin),
		})
	}
	return script, nil
}

// minimaxTarget projects a recorded outbound URL onto the raw request target the peer sees. The
// recorded value IS the target the pinned code built, so the projection only removes the marker; it
// never re-encodes the path (the decoded form has already thrown away the distinction a fixture
// exists to preserve).
func minimaxTarget(recordedURL string) string {
	remainder := strings.TrimPrefix(recordedURL, "<mock>")
	if remainder == "" {
		return "/"
	}
	return remainder
}

// minimaxLandedOutbound splits the recorded outbound requests into the ones that can reach the
// controlled peer and the ones that cannot (the <closed> port, or a relative URL the transport
// refuses). The split is a property of the recorded URL, not of a hand-written count.
func minimaxLandedOutbound(recorded []minimaxOutbound) ([]minimaxOutbound, int) {
	landed := make([]minimaxOutbound, 0, len(recorded))
	unreachable := 0
	for _, request := range recorded {
		if strings.HasPrefix(request.URL, "<mock>") {
			landed = append(landed, request)
			continue
		}
		unreachable++
	}
	return landed, unreachable
}

// minimaxExpectedWireHeaders reconstructs what node-fetch writes for one recorded request:
// lowercased names sorted, its defaults where the route sets none, Content-Length for a body, then
// Host, then the transport's Connection (the route never sets one on this route).
func minimaxExpectedWireHeaders(fixture minimaxFixture, expected minimaxOutbound, mockAuthority string) [][2]string {
	values := map[string]string{}
	for _, header := range fixture.NodeFetchWireDefaults.Headers {
		values[header[0]] = header[1]
	}
	if expected.Body != "" {
		values["content-length"] = strconv.Itoa(len(expected.Body))
	}
	for _, header := range expected.ExplicitHeaders {
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

// minimaxCompareHeaderLines compares the ordered wire header list, treating the transport's
// Connection as a presence-only assertion (the fixture classifies it as shape).
func minimaxCompareHeaderLines(t *testing.T, index int, want [][2]string, got []mockprovider.Header) {
	t.Helper()
	filtered := make([]mockprovider.Header, 0, len(got))
	foundConnection := false
	for _, header := range got {
		if strings.EqualFold(header.Name, "connection") {
			if foundConnection {
				t.Fatalf("request %d sent more than one connection header", index)
			}
			foundConnection = true
			continue
		}
		filtered = append(filtered, header)
	}
	if !foundConnection {
		t.Fatalf("request %d sent no connection header", index)
	}
	if len(filtered) != len(want) {
		t.Fatalf("request %d sent %d header lines, pinned sent %d\ngot  %v\nwant %v", index, len(filtered), len(want), filtered, want)
	}
	for position := range want {
		if filtered[position].Name != want[position][0] || filtered[position].Value != want[position][1] {
			t.Fatalf("request %d header %d = %q: %q, pinned %q: %q",
				index, position, filtered[position].Name, filtered[position].Value, want[position][0], want[position][1])
		}
	}
}

func sha256Hex(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}
