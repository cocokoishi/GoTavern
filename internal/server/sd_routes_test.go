package server

// Replay of the pinned non-generate /api/sd routes. The oracle is
// tests/oracle/sillytavern-1.19.0-sd-routes.json, recorded by tools/probe-sd-routes.mjs from the
// pinned SillyTavern server. Every routed scenario is replayed here against the same scripted
// local peer, and the response plus the exact requests the peer received are compared.
//
// The fixture classifies each observation's fields as `compared` or `shape`. This test enforces
// that classification rather than ignoring it: every observable this file reads must appear in one
// of the two lists, and a `shape` field must carry a written reason. A new observable that is added
// to the fixture without being classified therefore fails the test instead of silently passing
// uncompared.

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

type sdRoutesFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string            `json:"cookieSecret"`
		Account      sdFixtureAccount  `json:"account"`
		Secrets      map[string]string `json:"secrets"`
		Scenarios    map[string]struct {
			Route       string                      `json:"route"`
			Body        map[string]json.RawMessage  `json:"body"`
			RawBody     *string                     `json:"rawBody"`
			ContentType string                      `json:"contentType"`
			Seam        *string                     `json:"seam"`
			Unordered   bool                        `json:"unordered"`
			PeerScript  map[string][]sdPeerResponse `json:"peerScript"`
			Secrets     map[string]string           `json:"secrets"`
		} `json:"scenarios"`
	} `json:"inputs"`
	Observations     map[string]sdObservation `json:"observations"`
	KnownDifferences []map[string]any         `json:"knownDifferences"`
}

type sdFixtureAccount struct {
	Handle   string `json:"handle"`
	Name     string `json:"name"`
	Admin    bool   `json:"admin"`
	Password string `json:"password"`
}

type sdPeerResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

type sdObservation struct {
	Status        int      `json:"status"`
	ContentType   *string  `json:"contentType"`
	ContentLength *string  `json:"contentLength"`
	Etag          *string  `json:"etag"`
	Body          string   `json:"body"`
	Requests      []sdWire `json:"requests"`
	// NormalizedContentLength is a RawMessage so an ABSENT field is distinguishable from a present
	// null: the canonical length is the compared counterpart of a host-derived content-length, and the
	// fixture must carry the key (null where no canonical body exists) rather than omit it.
	NormalizedContentLength json.RawMessage `json:"normalizedContentLength"`
	Comparison              struct {
		Compared    []string          `json:"compared"`
		Shape       []string          `json:"shape"`
		ShapeReason map[string]string `json:"shapeReason"`
		HostDerived []string          `json:"hostDerived"`
	} `json:"comparison"`
}

type sdWire struct {
	Method  string `json:"method"`
	Target  string `json:"target"`
	Headers []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"headers"`
	BodyText string `json:"bodyText"`
}

// sdObservableKeys are the fields this test reads from an observation. The fixture must classify
// every one of them.
var sdObservableKeys = []string{
	"status", "contentType", "contentLength", "etag", "body",
	"requests", "requestHeaders", "requestBody",
}

// sdSeamEnvironment maps each seam to its pinned default. The defaults are asserted, because a
// seam whose default drifts changes production while the tests keep passing against the mock.
var sdSeamEnvironment = map[string]string{
	"GOTAVERN_SD_TOGETHER_URL":     sdTogetherDefaultURL,
	"GOTAVERN_SD_CHUTES_URL":       sdChutesDefaultURL,
	"GOTAVERN_SD_ELECTRONHUB_URL":  sdElectronHubDefaultURL,
	"GOTAVERN_SD_NANOGPT_URL":      sdNanoGPTDefaultURL,
	"GOTAVERN_SD_AIMLAPI_URL":      sdAimlapiDefaultURL,
	"GOTAVERN_SD_WORKERSAI_URL":    sdWorkersAIDefaultURL,
	"GOTAVERN_SD_POLLINATIONS_URL": sdPollinationsDefaultURL,
	"GOTAVERN_SD_FALAI_URL":        sdFalaiDefaultURL,
}

func TestSDSeamDefaults(t *testing.T) {
	for environmentName := range sdSeamEnvironment {
		t.Setenv(environmentName, "")
	}
	accessors := map[string]func() string{
		"GOTAVERN_SD_TOGETHER_URL":     sdTogetherURL,
		"GOTAVERN_SD_CHUTES_URL":       sdChutesURL,
		"GOTAVERN_SD_ELECTRONHUB_URL":  sdElectronHubURL,
		"GOTAVERN_SD_NANOGPT_URL":      sdNanoGPTURL,
		"GOTAVERN_SD_AIMLAPI_URL":      sdAimlapiURL,
		"GOTAVERN_SD_WORKERSAI_URL":    sdWorkersAIURL,
		"GOTAVERN_SD_POLLINATIONS_URL": sdPollinationsURL,
		"GOTAVERN_SD_FALAI_URL":        sdFalaiURL,
	}
	for environmentName, defaultValue := range sdSeamEnvironment {
		if got := accessors[environmentName](); got != defaultValue {
			t.Fatalf("%s default = %q, want the pinned %q", environmentName, got, defaultValue)
		}
	}
	// The overrides are read per request and have their trailing slash removed.
	t.Setenv("GOTAVERN_SD_TOGETHER_URL", "http://127.0.0.1:9999/")
	if got := sdTogetherURL(); got != "http://127.0.0.1:9999" {
		t.Fatalf("seam override = %q, want the trimmed override", got)
	}
}

func TestPinnedNodeSDRoutes(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-sd-routes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture sdRoutesFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("SD routes oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Observations) == 0 || len(fixture.Inputs.Scenarios) != len(fixture.Observations) {
		t.Fatalf("SD routes oracle has %d scenarios but %d observations", len(fixture.Inputs.Scenarios), len(fixture.Observations))
	}
	if len(fixture.KnownDifferences) == 0 {
		t.Fatal("SD routes oracle must record its known differences; the fixture claims one for electronhub/sizes")
	}
	verifySDClassification(t, fixture)

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
	closedOrigin := closedLoopbackOrigin(t)

	for environmentName := range sdSeamEnvironment {
		t.Setenv(environmentName, "")
	}

	names := sortedKeys(fixture.Inputs.Scenarios)
	for _, name := range names {
		scenario := fixture.Inputs.Scenarios[name]
		observation, exists := fixture.Observations[name]
		if !exists {
			t.Fatalf("%s: no recorded observation", name)
		}
		writeSDSecrets(t, dataRoot, fixture.Inputs.Account.Handle, scenario.Secrets)
		for environmentName := range sdSeamEnvironment {
			t.Setenv(environmentName, "")
		}
		if scenario.Seam != nil {
			if _, known := sdSeamEnvironment[*scenario.Seam]; !known {
				t.Fatalf("%s: unknown seam %q", name, *scenario.Seam)
			}
			t.Setenv(*scenario.Seam, mockOrigin)
		}
		peer.Reset(convertPeerScript(scenario.PeerScript))

		body := buildSDRequestBody(t, scenario.Body, scenario.RawBody, mockOrigin, closedOrigin)
		request := httptest.NewRequest(http.MethodPost, "/api/sd/"+scenario.Route, strings.NewReader(body))
		request.Header.Set("Content-Type", scenario.ContentType)
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		compareSDObservation(t, name, observation, recorder)
		compareSDWire(t, name, observation, peer.Recording().Requests, scenario.Unordered, address.String())
		if unused := peer.Unused(); len(unused) > 0 {
			t.Fatalf("%s: the peer script was not fully consumed; unused %v", name, unused)
		}
	}
}

// verifySDClassification makes the fixture's compared/shape classification load-bearing: a field
// this test reads must be classified, every scenario must compare its status, and every shape entry
// must say why it cannot be compared. A field that only ever appears as `shape` is allowed for a
// single scenario (the malformed-body error page); each observable still has to be compared
// somewhere for the suite to prove a value.
func verifySDClassification(t *testing.T, fixture sdRoutesFixture) {
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
		for _, key := range sdObservableKeys {
			if !classified[key] {
				t.Fatalf("%s: observable %q is neither compared nor shape-classified", name, key)
			}
		}
		if !classified["status"] {
			t.Fatalf("%s: status must be compared for every scenario", name)
		}
	}
	for _, key := range []string{"contentType", "contentLength", "etag", "body", "requests", "requestHeaders", "requestBody"} {
		if !comparedAnywhere[key] {
			t.Fatalf("observable %q is never compared, so this suite cannot prove it", key)
		}
	}

	// The host-derived marker is asserted, not trusted. A field whose recorded value would be this
	// host's answer must be NULL, must be classified shape, and must carry a reason; otherwise the
	// zero-diff gate can fail on a fixture that looks correctly classified.
	hostDerivedAnywhere := 0
	separatorBearingBodies := 0
	for name, observation := range fixture.Observations {
		if strings.ContainsRune(observation.Body, '\\') {
			separatorBearingBodies++
		}
		for _, key := range observation.Comparison.HostDerived {
			hostDerivedAnywhere++
			if !sdContainsString(observation.Comparison.Shape, key) {
				t.Fatalf("%s: host-derived field %q is not classified shape", name, key)
			}
			if strings.TrimSpace(observation.Comparison.ShapeReason[key]) == "" {
				t.Fatalf("%s: host-derived field %q has no reason", name, key)
			}
			switch key {
			case "contentType":
				if observation.ContentType != nil {
					t.Fatalf("%s: host-derived contentType records %q; it must be null", name, *observation.ContentType)
				}
			case "contentLength":
				if observation.ContentLength != nil {
					t.Fatalf("%s: host-derived contentLength records %q; it must be null", name, *observation.ContentLength)
				}
			case "etag":
				if observation.Etag != nil {
					t.Fatalf("%s: host-derived etag records %q; it must be null", name, *observation.Etag)
				}
			case "body":
				if observation.Body != "" {
					t.Fatalf("%s: host-derived body records %d bytes; it must be null", name, len(observation.Body))
				}
			default:
				t.Fatalf("%s: unknown host-derived field %q", name, key)
			}
		}
		if len(observation.Comparison.HostDerived) > 0 {
			if len(observation.NormalizedContentLength) == 0 {
				t.Fatalf("%s: host-derived fields must come with a normalizedContentLength key", name)
			}
			if string(observation.NormalizedContentLength) != "null" {
				t.Fatalf("%s: normalizedContentLength = %s; this probe has no canonical body to measure",
					name, string(observation.NormalizedContentLength))
			}
		}
	}

	// Evidence-based guard: the check is per-fixture, not a global boolean. The malformed-JSON branch is
	// declared host-derived by a property of the ROUTE (it renders a development error page), so the
	// marker must be present even though its body is now nulled and the separator count is therefore
	// zero. The count is printed so the next reader sees the measurement rather than assuming the check
	// is missing.
	if _, present := fixture.Observations["ping.malformedJson"]; !present {
		t.Fatal("the fixture no longer records the malformed-JSON error page, so the host-derived marker is unguarded")
	}
	if len(fixture.Observations["ping.malformedJson"].Comparison.HostDerived) == 0 {
		t.Fatal("the malformed-JSON error page must declare host-derived fields: it renders an absolute path")
	}
	if separatorBearingBodies > 0 && hostDerivedAnywhere == 0 {
		t.Fatalf("%d recorded bodies carry a backslash separator but no field is marked host-derived", separatorBearingBodies)
	}
	t.Logf("host-derived fields declared: %d; recorded bodies carrying a backslash separator: %d", hostDerivedAnywhere, separatorBearingBodies)
}

func sdContainsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func newSDRouteHandler(t *testing.T, dataRoot, installRoot, cookieSecret string, account sdFixtureAccount) (http.Handler, string, string) {
	t.Helper()
	accountJSON, err := marshalNodeJSON(map[string]any{
		"handle":   account.Handle,
		"name":     account.Name,
		"created":  1700000000000,
		"password": account.Password,
		"admin":    account.Admin,
		"enabled":  true,
		"salt":     "",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+account.Handle, accountJSON); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(cookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{account.Handle}); err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: cookieSecret, AccountsEnabled: true,
	})
	csrf := httptest.NewRecorder()
	handler.ServeHTTP(csrf, httptest.NewRequest(http.MethodGet, "/csrf-token", nil))
	if csrf.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d", csrf.Code)
	}
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrf.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	csrfCookie := joinCookies(csrf.Header().Values("Set-Cookie"))
	loginBody, err := marshalNodeJSON(map[string]string{"handle": account.Handle, "password": account.Password})
	if err != nil {
		t.Fatal(err)
	}
	login := httptest.NewRecorder()
	loginRequest := httptest.NewRequest(http.MethodPost, "/api/users/login", bytes.NewReader(loginBody))
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Header.Set("Cookie", csrfCookie)
	loginRequest.Header.Set("X-CSRF-Token", payload.Token)
	handler.ServeHTTP(login, loginRequest)
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	return handler, joinCookies(login.Header().Values("Set-Cookie")), payload.Token
}

func joinCookies(cookies []string) string {
	parts := make([]string, 0, len(cookies))
	for _, cookie := range cookies {
		parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
	}
	return strings.Join(parts, "; ")
}

func writeSDSecrets(t *testing.T, dataRoot, handle string, values map[string]string) {
	t.Helper()
	type entry struct {
		ID     string `json:"id"`
		Value  string `json:"value"`
		Label  string `json:"label"`
		Active bool   `json:"active"`
	}
	secrets := make(map[string][]entry, len(values))
	for key, value := range values {
		secrets[key] = []entry{{ID: "probe-id-" + key, Value: value, Label: key, Active: true}}
	}
	encoded, err := marshalNodeJSON(secrets)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, handle, "secrets.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}

func closedLoopbackOrigin(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return "http://" + address
}

func buildSDRequestBody(t *testing.T, body map[string]json.RawMessage, rawBody *string, mockOrigin, closedOrigin string) string {
	t.Helper()
	if rawBody != nil {
		return *rawBody
	}
	prepared := make(map[string]json.RawMessage, len(body))
	for key, value := range body {
		var text string
		if json.Unmarshal(value, &text) == nil {
			switch text {
			case "<mock>":
				prepared[key] = mustMarshalRaw(t, mockOrigin)
				continue
			case "<closed>":
				prepared[key] = mustMarshalRaw(t, closedOrigin)
				continue
			}
		}
		prepared[key] = value
	}
	encoded, err := marshalNodeJSON(prepared)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func mustMarshalRaw(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func convertPeerScript(script map[string][]sdPeerResponse) map[string][]mockprovider.Response {
	converted := make(map[string][]mockprovider.Response, len(script))
	for key, responses := range script {
		for _, response := range responses {
			headers := make([]mockprovider.Header, 0, len(response.Headers))
			names := make([]string, 0, len(response.Headers))
			for name := range response.Headers {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				headers = append(headers, mockprovider.Header{Name: name, Value: response.Headers[name]})
			}
			converted[key] = append(converted[key], mockprovider.Response{
				Status: response.Status, Headers: headers, Body: response.Body,
			})
		}
	}
	return converted
}

func compareSDObservation(t *testing.T, name string, observation sdObservation, recorder *httptest.ResponseRecorder) {
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
	if compared["body"] && recorder.Body.String() != observation.Body {
		t.Fatalf("%s: body = %q, pinned Node has %q", name, recorder.Body.String(), observation.Body)
	}
}

func compareOptionalHeader(t *testing.T, name, header string, want *string, got string) {
	t.Helper()
	wantValue := ""
	if want != nil {
		wantValue = *want
	}
	if got != wantValue {
		t.Fatalf("%s: %s = %q, pinned Node has %q", name, header, got, wantValue)
	}
}

func compareSDWire(t *testing.T, name string, observation sdObservation, recorded []mockprovider.Request, unordered bool, mockAuthority string) {
	t.Helper()
	// The fixture normalises the ephemeral mock authority to <mock>; substitute this run's peer
	// authority so the recorded Host header stays a compared value rather than a port literal.
	normalize := func(value string) string { return strings.ReplaceAll(value, "<mock>", mockAuthority) }
	want := observation.Requests
	for index := range want {
		want[index].Target = normalize(want[index].Target)
		for header := range want[index].Headers {
			want[index].Headers[header].Value = normalize(want[index].Headers[header].Value)
		}
		want[index].BodyText = normalize(want[index].BodyText)
	}
	got := make([]sdWire, 0, len(recorded))
	for _, request := range recorded {
		wire := sdWire{Method: request.Method, Target: request.RawTarget}
		for _, header := range request.Headers {
			wire.Headers = append(wire.Headers, struct {
				Name  string `json:"name"`
				Value string `json:"value"`
			}{Name: header.Name, Value: header.Value})
		}
		if request.BodyText != nil {
			wire.BodyText = *request.BodyText
		}
		got = append(got, wire)
	}
	if unordered {
		sort.SliceStable(want, func(left, right int) bool {
			return want[left].Method+" "+want[left].Target < want[right].Method+" "+want[right].Target
		})
		sort.SliceStable(got, func(left, right int) bool {
			return got[left].Method+" "+got[left].Target < got[right].Method+" "+got[right].Target
		})
	}
	if len(got) != len(want) {
		t.Fatalf("%s: peer received %d requests, pinned Node made %d", name, len(got), len(want))
	}
	for index := range want {
		if got[index].Method != want[index].Method || got[index].Target != want[index].Target {
			t.Fatalf("%s: request %d = %s %s, pinned Node made %s %s",
				name, index, got[index].Method, got[index].Target, want[index].Method, want[index].Target)
		}
		// requestBody is compared through the recorded body text.
		if got[index].BodyText != want[index].BodyText {
			t.Fatalf("%s: request %d body = %q, pinned Node sent %q", name, index, got[index].BodyText, want[index].BodyText)
		}
		compareSDHeaderLines(t, name, index, want[index].Headers, got[index].Headers)
	}
}

// compareSDHeaderLines compares the header lines in wire order, except `connection`, which the
// fixture classifies as shape (transport framing chosen by the outbound stack, not the route).
func compareSDHeaderLines(t *testing.T, name string, index int, want []struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}, got []struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}) {
	t.Helper()
	filter := func(headers []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	}) [][2]string {
		lines := make([][2]string, 0, len(headers))
		for _, header := range headers {
			if strings.EqualFold(header.Name, "connection") {
				continue
			}
			lines = append(lines, [2]string{header.Name, header.Value})
		}
		return lines
	}
	wantLines := filter(want)
	gotLines := filter(got)
	if len(gotLines) != len(wantLines) {
		t.Fatalf("%s: request %d sent headers %v, pinned Node sent %v", name, index, gotLines, wantLines)
	}
	for position := range wantLines {
		if gotLines[position] != wantLines[position] {
			t.Fatalf("%s: request %d header %d = %v, pinned Node sent %v", name, index, position, gotLines[position], wantLines[position])
		}
	}
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
